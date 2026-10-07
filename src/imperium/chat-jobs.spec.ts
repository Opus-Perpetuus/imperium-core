/**
 * Trabajos del chat contra Postgres real (`DATABASE_URL`). Todo lo que vence está en 2001, así la
 * hora inyectada solo alcanza lo de estas pruebas. Ids aleatorios y limpieza al final.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle_action } from './actions.ts';
import { close_pending_jobs, discard_orphan_uploads, expire_due_messages, remind_due_saved, send_due_scheduled } from './chat-jobs.ts';
import { as_object, type ImperiumDoc } from './envelope.ts';
import { chat_claim_due_sql, ImperiumStore, load_catalog_path } from './store.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const store = sql ? new ImperiumStore(sql, load_catalog_path()) : null;

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const created: Record<string, string[]> = {};

function track(resource: string, id: string): string {
	(created[resource] ??= []).push(id);
	return id;
}

let folder = '';
let previous_folder: string | undefined;

beforeAll(() => {
	folder = mkdtempSync(join(tmpdir(), 'imperium-chat-jobs-'));
	previous_folder = process.env.MULTER_UPLOAD_FOLDER;
	process.env.MULTER_UPLOAD_FOLDER = folder;
});

afterAll(async () => {
	if (previous_folder === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
	else process.env.MULTER_UPLOAD_FOLDER = previous_folder;
	if (!sql || !store) return;
	for (const [resource, ids] of Object.entries(created)) {
		await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [ids]);
	}
	await sql.close();
}, 120_000);

test('el reclamo de lo vencido salta lo que otra pasada tiene tomado', () => {
	expect(chat_claim_due_sql('"m"', 'expire')).toContain(
		`WHERE expires_at IS NOT NULL AND expires_at <= $1 AND state IS NULL AND is_active IS DISTINCT FROM false
			ORDER BY expires_at, id
			LIMIT $2
			FOR UPDATE SKIP LOCKED`,
	);
});

describe.skipIf(!sql)('trabajos del chat en Postgres', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto] = [hex_id(), hex_id()];
	const at = (time: string) => `2001-01-01T${time}.000Z`;

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	async function conversation(last_message_id?: string): Promise<string> {
		const id = track('chat-conversations', hex_id());
		const payload = { memberCount: 2, ...(last_message_id ? { lastMessage: { messageId: last_message_id, textPreview: 'secreto', attachmentKind: 'file' } } : {}) };
		await db.unsafe(
			`INSERT INTO ${st.qt('chat-conversations')} (id, name, is_active, kind, conversation_key, last_seq, payload, created_at, updated_at)
			 VALUES ($1, 'Grupo', true, 'group', $2, 9, $3::jsonb, $4, $4)`,
			[id, `conv:${id}`, payload, at('00:00:00')],
		);
		for (const user_id of [ana, beto]) {
			await db.unsafe(
				`INSERT INTO ${st.qt('chat-members')} (id, name, is_active, state, conversation_id, user_id, role, last_read_seq, public_read_seq, delivered_seq, payload, created_at, updated_at)
				 VALUES ($1, '', true, 'active', $2, $3, 'member', 0, 0, 0, '{}'::jsonb, $4, $4)`,
				[track('chat-members', hex_id()), id, user_id, at('00:00:00')],
			);
		}
		return id;
	}

	async function message(
		conversation_id: string,
		seq: number,
		fields: { id?: string; expires_at?: string | null; text?: string; payload?: ImperiumDoc } = {},
	): Promise<string> {
		const id = track('messages', fields.id ?? hex_id());
		const text = fields.text ?? `m${seq}`;
		await db.unsafe(
			`INSERT INTO ${st.qt('messages')} (id, name, is_active, conversation_id, seq, sender_user_id, kind, search_field, expires_at, payload, created_at, updated_at)
			 VALUES ($1, '', true, $2, $3, $4, 'text', $5, $6, $7::jsonb, $8, $8)`,
			[id, conversation_id, seq, ana, text, fields.expires_at ?? null, { message: text, rev: 0, ...fields.payload }, at('00:00:00')],
		);
		return id;
	}

	/** Una fila de adjunto del chat y, si no se da `name_stored`, su archivo nuevo en disco. */
	async function attachment(fields: { name_stored?: string; related_record_id?: string; created_at?: string; chat_upload?: ImperiumDoc }) {
		const name_stored = fields.name_stored ?? crypto.randomUUID();
		if (!fields.name_stored) writeFileSync(join(folder, name_stored), 'contenido');
		const id = track('attachment-management', hex_id());
		await db.unsafe(
			`INSERT INTO ${st.qt('attachment-management')} (id, name, is_active, name_stored, mimetype, file_ext, created_by_id, related_model, related_record_id, payload, created_at, updated_at)
			 VALUES ($1, 'archivo', true, $2, 'text/plain', 'txt', $3, 'Message', $4, $5::jsonb, $6, $6)`,
			[id, name_stored, ana, fields.related_record_id ?? '', { chatUpload: fields.chat_upload ?? { ownerUserId: ana } }, fields.created_at ?? at('00:00:00')],
		);
		return { id, name_stored, path: join(folder, name_stored) };
	}

	async function row(resource: string, id: string): Promise<ImperiumDoc> {
		const [found] = (await db.unsafe(`SELECT * FROM ${st.qt(resource)} WHERE id = $1`, [id])) as ImperiumDoc[];
		return found!;
	}

	test('el reclamo de temporales e historias va por un índice que no guarda lo ya caducado', async () => {
		for (const [resource, index] of [
			['messages', 'ix_messages_expire_due'],
			['chat-stories', 'ix_chat_stories_expire_due'],
		] as const) {
			const job = resource === 'messages' ? 'expire' : 'story';
			const plan = (await db.begin(async (tx) => {
				await tx.unsafe('SET LOCAL enable_seqscan = off');
				return tx.unsafe(`EXPLAIN ${chat_claim_due_sql(st.qt(resource), job)}`, [at('00:00:00'), 10]);
			})) as Array<{ 'QUERY PLAN': string }>;
			expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(index);
		}
	}, 60_000);

	test('dos reclamos en paralelo nunca toman lo mismo; al arrancar, lo reclamado vuelve a pendiente', async () => {
		const id = await conversation();
		const ids: string[] = [];
		for (let seq = 1; seq <= 6; seq++) ids.push(await message(id, seq, { expires_at: at(`23:59:5${seq}`) }));
		const due = at('23:59:59');
		const [one, two] = await Promise.all([st.chat_claim_due('expire', due, 4), st.chat_claim_due('expire', due, 4)]);
		const taken = [...one, ...two].map((doc) => String(doc._id));
		expect(new Set(taken).size).toBe(taken.length);
		expect(taken.sort()).toEqual([...ids].sort());
		expect(await st.chat_claim_due('expire', due, 10)).toEqual([]);
		await close_pending_jobs(st);
		expect((await st.chat_claim_due('expire', due, 10)).map((doc) => String(doc._id)).sort()).toEqual([...ids].sort());
		expect(await st.chat_release_claims('expire', ids)).toBe(6);
	}, 60_000);

	test('sin retención legal: sin contenido, fuera de las páginas, citas y vista previa sin texto; el archivo se borra cuando nadie lo usa', async () => {
		const expiring = hex_id();
		const first = await conversation(expiring);
		const second = await conversation();
		const original = await attachment({ related_record_id: expiring });
		await message(first, 1, {
			id: expiring,
			text: 'secreto',
			expires_at: at('00:00:01'),
			payload: { attachments: [{ attachmentId: original.id, name: 'archivo' }], links: ['https://ejemplo.com'] },
		});
		const reply = await message(first, 2, {
			payload: { replyToMessageId: expiring, replyPreview: { messageId: expiring, textPreview: 'secreto', attachmentKind: 'file' } },
		});
		const forwarded = hex_id();
		const copy = await attachment({ name_stored: original.name_stored, related_record_id: forwarded });
		await message(second, 1, { id: forwarded, text: 'reenviado', expires_at: at('12:00:00'), payload: { attachments: [{ attachmentId: copy.id }] } });
		await db.unsafe(
			`INSERT INTO ${st.qt('chat-reactions')} (id, name, is_active, message_id, conversation_id, user_id, kind, value, payload, created_at, updated_at)
			 VALUES ($1, '', true, $2, $3, $4, 'emoji', '👍', '{}'::jsonb, $5, $5)`,
			[track('chat-reactions', hex_id()), expiring, first, beto, at('00:00:00')],
		);
		const activity = track('mentions', hex_id());
		await db.unsafe(
			`INSERT INTO ${st.qt('mentions')} (id, name, is_active, payload, created_at, updated_at) VALUES ($1, '', true, $2::jsonb, $3, $3)`,
			[activity, { mentionedUserId: beto, messageId: expiring, contextType: 'chat-message', excerpt: 'secreto' }, at('00:00:00')],
		);
		const saved = await st.chat_save_message({
			id: track('chat-saved', hex_id()),
			user_id: beto,
			message_id: expiring,
			remind_at: null,
			payload: { conversationId: first, preview: { senderName: 'Ana', textPreview: 'secreto', kind: 'text' } },
			now: at('00:00:00'),
		});

		await db.unsafe(
			`UPDATE ${st.qt('chat-members')} SET payload = payload || '{"mentionSeqs": [1, 2]}'::jsonb WHERE conversation_id = $1 AND user_id = $2`,
			[first, beto],
		);

		expect(await expire_due_messages(st, new Date(at('06:00:00')), false)).toBe(1);
		expect((await row('chat-saved', String(saved._id))).payload).toMatchObject({ preview: { senderName: 'Ana', textPreview: '' } });
		const [mentioned] = (await db.unsafe(
			`SELECT payload -> 'mentionSeqs' AS seqs FROM ${st.qt('chat-members')} WHERE conversation_id = $1 AND user_id = $2`,
			[first, beto],
		)) as Array<{ seqs: number[] }>;
		expect(mentioned!.seqs).toEqual([2]);
		const gone = await row('messages', expiring);
		expect(gone).toMatchObject({ is_active: false, state: 'expired', search_field: null });
		expect(gone.payload).toEqual({ message: '', rev: 1 });
		expect((await row('messages', reply)).payload).toMatchObject({
			rev: 1,
			replyPreview: { messageId: expiring, textPreview: null, deleted: true },
		});
		expect(((await row('chat-conversations', first)).payload as ImperiumDoc).lastMessage).toEqual({
			messageId: expiring,
			textPreview: '',
			deleted: true,
		});
		expect(await db.unsafe(`SELECT id FROM ${st.qt('chat-reactions')} WHERE message_id = $1`, [expiring])).toHaveLength(0);
		expect((await row('mentions', activity)).is_active).toBe(false);
		expect(await db.unsafe(`SELECT id FROM ${st.qt('chat-audit')} WHERE message_id = $1`, [expiring])).toHaveLength(0);
		expect((await row('attachment-management', original.id)).is_active).toBe(false);
		expect(existsSync(original.path)).toBe(true);
		const page = await st.chat_message_page({ conversation_id: first, visible_from: 0, viewer_id: beto, limit: 10, direction: 'tail' });
		expect(page.rows.map((doc) => doc._id)).toEqual([reply]);

		expect(await expire_due_messages(st, new Date(at('23:00:00')), false)).toBe(1);
		expect((await row('attachment-management', copy.id)).is_active).toBe(false);
		expect(existsSync(original.path)).toBe(false);
	}, 60_000);

	test('con retención legal: el contenido queda en chat-audit y los archivos se quedan', async () => {
		const id = hex_id();
		const conversation_id = await conversation();
		const file = await attachment({ related_record_id: id });
		await message(conversation_id, 1, {
			id,
			text: 'contrato',
			expires_at: at('00:00:01'),
			payload: { attachments: [{ attachmentId: file.id, name: 'archivo' }] },
		});
		expect(await expire_due_messages(st, new Date(at('06:00:00')), true)).toBe(1);
		const audits = (await db.unsafe(
			`SELECT id, conversation_id, action, actor_id, payload FROM ${st.qt('chat-audit')} WHERE message_id = $1`,
			[id],
		)) as ImperiumDoc[];
		for (const audit of audits) track('chat-audit', String(audit.id));
		expect(audits.map(({ id: _, ...audit }) => audit)).toEqual([
			{
				conversation_id,
				action: 'expired',
				actor_id: null,
				payload: {
					before: { kind: 'text', text: 'contrato', attachments: [{ attachmentId: file.id, name: 'archivo' }] },
					targetUserId: ana,
				},
			},
		]);
		expect(await row('messages', id)).toMatchObject({ is_active: false, search_field: null });
		expect((await row('attachment-management', file.id)).is_active).toBe(true);
		expect(existsSync(file.path)).toBe(true);
	}, 60_000);

	test('las subidas sin ligar de más de 24 h salen con su archivo; las recientes y las ligadas se quedan', async () => {
		const old = await attachment({ created_at: at('00:00:00') });
		const recent = await attachment({ created_at: at('23:00:00') });
		const bound = await attachment({ created_at: at('00:00:00'), related_record_id: hex_id() });
		expect(await discard_orphan_uploads(st, new Date('2001-01-02T00:30:00.000Z'))).toBe(1);
		expect((await row('attachment-management', old.id)).is_active).toBe(false);
		expect(existsSync(old.path)).toBe(false);
		for (const kept of [recent, bound]) {
			expect((await row('attachment-management', kept.id)).is_active).toBe(true);
			expect(existsSync(kept.path)).toBe(true);
		}
	}, 60_000);
});

describe.skipIf(!sql)('programados y guardados por las rutas', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto, carla, dario] = ['Ana', 'Beto', 'Carla', 'Darío'].map((name) => ({ _id: hex_id(), name: `${name} Programa` }));
	const people = [ana!, beto!, carla!, dario!];
	const groups: string[] = [];
	const in_minutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
		for (const user of people) {
			await db.unsafe(
				`INSERT INTO ${st.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
				 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
				[track('user', user._id), user.name, `${user._id}@empresa.com`, new Date().toISOString()],
			);
		}
	}, 120_000);

	afterAll(async () => {
		const collect = async (resource: string, where: string, value: string) => {
			const rows = (await db.unsafe(`SELECT id FROM ${st.qt(resource)} WHERE ${where}`, [value])) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		};
		for (const id of groups) {
			for (const resource of ['messages', 'chat-members', 'chat-scheduled']) await collect(resource, 'conversation_id = $1', id);
		}
		for (const user of people) {
			await collect('chat-saved', 'user_id = $1', user._id);
			await collect('attachment-management', 'created_by_id = $1', user._id);
			await collect('notifications', `payload ->> 'recipientId' = $1`, user._id);
		}
	}, 120_000);

	async function group(settings: ImperiumDoc = {}): Promise<string> {
		const id = track('chat-conversations', hex_id());
		groups.push(id);
		const now = new Date().toISOString();
		await db.unsafe(
			`INSERT INTO ${st.qt('chat-conversations')} (id, name, is_active, kind, conversation_key, last_seq, payload, created_at, updated_at)
			 VALUES ($1, 'Programas', true, 'group', $2, 0, $3::jsonb, $4, $4)`,
			[id, `conv:${id}`, { memberCount: 3, settings }, now],
		);
		for (const user of [ana!, beto!, carla!]) {
			await db.unsafe(
				`INSERT INTO ${st.qt('chat-members')} (id, name, is_active, state, conversation_id, user_id, role, last_read_seq, public_read_seq, delivered_seq, payload, created_at, updated_at)
				 VALUES ($1, '', true, 'active', $2, $3, 'member', 0, 0, 0, '{"visibleFromSeq": 0}'::jsonb, $4, $4)`,
				[hex_id(), id, user._id, now],
			);
		}
		return id;
	}

	type Reply = { status: number; body: { data: ImperiumDoc[]; code?: string } & Record<string, unknown> };

	async function call(
		actor: ImperiumDoc,
		resource: string,
		action: string,
		path: string,
		init: { method?: string; params?: Record<string, string>; json?: unknown; form?: FormData } = {},
	): Promise<Reply> {
		const url = new URL(`http://core/api/${resource}${path}`);
		const req = new Request(url, {
			method: init.method ?? 'GET',
			headers: init.json === undefined ? undefined : { 'content-type': 'application/json' },
			body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
		});
		try {
			const res = await handle_action(st, db, req, url, resource, action, init.params ?? {}, actor);
			return { status: res.status, body: (await res.json()) as Reply['body'] };
		} catch (err) {
			const e = err as { status?: number; code?: string; message: string };
			return { status: e.status ?? 500, body: { data: [], code: e.code, message: e.message } };
		}
	}

	const outcome = async (reply: Promise<Reply>) => {
		const { status, body } = await reply;
		return [status, body.code];
	};

	async function upload(actor: ImperiumDoc, conversation_id: string): Promise<string> {
		const form = new FormData();
		form.append('conversation_id', conversation_id);
		form.append('client_upload_id', crypto.randomUUID());
		form.append('file', new File(['acta'], 'acta.txt', { type: 'text/plain' }));
		const reply = await call(actor, 'messages', 'create_chat_upload', '/uploads', { method: 'POST', form });
		expect(reply.status).toBe(200);
		return String(reply.body.data[0]!.attachment_id);
	}

	const schedule = (actor: ImperiumDoc, id: string, json: ImperiumDoc) =>
		call(actor, 'chat-conversations', 'create_scheduled_message', `/${id}/scheduled`, { method: 'POST', params: { id }, json });

	async function stored(resource: string, id: unknown): Promise<ImperiumDoc> {
		const [found] = (await db.unsafe(`SELECT * FROM ${st.qt(resource)} WHERE id = $1`, [String(id)])) as ImperiumDoc[];
		return found!;
	}

	async function notices(user: ImperiumDoc): Promise<ImperiumDoc[]> {
		const rows = (await db.unsafe(`SELECT payload FROM ${st.qt('notifications')} WHERE payload ->> 'recipientId' = $1`, [
			user._id,
		])) as Array<{ payload: ImperiumDoc }>;
		return rows.map((row) => row.payload);
	}

	test('programar se valida como un envío y, mientras está pendiente, se lista, se edita y se cancela', async () => {
		const id = await group();
		const request = (extra: ImperiumDoc = {}) => ({ client_id: crypto.randomUUID(), text: 'Recuerden la junta', send_at: in_minutes(10), ...extra });
		expect(await outcome(schedule(dario!, id, request()))).toEqual([403, 'not_member']);
		expect(await outcome(schedule(ana!, id, request({ send_at: in_minutes(0.5) })))).toEqual([422, 'invalid_send_at']);
		expect(await outcome(schedule(ana!, id, request({ send_at: in_minutes(60 * 24 * 400) })))).toEqual([422, 'invalid_send_at']);
		expect(await outcome(schedule(ana!, id, request({ view_once: true })))).toEqual([422, 'invalid_request']);
		const upload_id = await upload(ana!, id);
		const view = (await schedule(ana!, id, request({ attachment_ids: [upload_id] }))).body.data[0]!;
		expect(view).toMatchObject({ conversation_id: id, state: 'pending', text: 'Recuerden la junta', attachments: [{ attachment_id: upload_id }] });
		expect(await stored('attachment-management', upload_id)).toMatchObject({ related_model: 'ChatScheduled', related_record_id: view._id });
		const tokens = async (actor: ImperiumDoc) =>
			(await call(actor, 'messages', 'issue_media_tokens', '/media-tokens', { method: 'POST', json: { attachment_ids: [upload_id] } }))
				.body.data.map((row) => row.attachment_id);
		expect(await tokens(ana!)).toEqual([upload_id]);
		expect(await tokens(beto!)).toEqual([]);
		const list = (actor: ImperiumDoc) => call(actor, 'chat-conversations', 'read_scheduled_messages', `/${id}/scheduled`, { params: { id } });
		expect((await list(ana!)).body.data.map((row) => row._id)).toEqual([view._id]);
		expect((await list(beto!)).body.data).toEqual([]);
		const scheduled_id = String(view._id);
		const edit = (actor: ImperiumDoc, json: ImperiumDoc) =>
			call(actor, 'chat-conversations', 'update_scheduled_message', `/scheduled/${scheduled_id}`, { method: 'PATCH', params: { id: scheduled_id }, json });
		const later = in_minutes(20);
		expect((await edit(ana!, { text: 'Junta a las 5', send_at: later })).body.data[0]).toMatchObject({ text: 'Junta a las 5', send_at: later });
		expect(await outcome(edit(beto!, { text: 'Otra cosa' }))).toEqual([404, 'message_not_found']);
		const cancel = () =>
			call(ana!, 'chat-conversations', 'cancel_scheduled_message', `/scheduled/${scheduled_id}`, { method: 'DELETE', params: { id: scheduled_id } });
		expect((await cancel()).body.data[0]).toMatchObject({ state: 'cancelled', attachments: [] });
		expect((await stored('attachment-management', upload_id)).is_active).toBe(false);
		expect(await outcome(cancel())).toEqual([409, 'scheduled_not_pending']);
		expect(await outcome(edit(ana!, { text: 'Tarde' }))).toEqual([409, 'scheduled_not_pending']);
	}, 60_000);

	test('al vencer sale por el flujo normal, marcado como programado y con sus subidas; repetir el envío no lo duplica', async () => {
		const id = await group();
		const upload_id = await upload(ana!, id);
		const client_id = crypto.randomUUID();
		const view = (await schedule(ana!, id, { client_id, text: 'Sale solo', send_at: in_minutes(2), attachment_ids: [upload_id] })).body.data[0]!;
		await send_due_scheduled(st, new Date(Date.now() + 3 * 60_000));
		const sent = await stored('chat-scheduled', view._id);
		expect(sent.state).toBe('sent');
		const message_id = String((sent.payload as ImperiumDoc).messageId);
		const message = await stored('messages', message_id);
		expect(message).toMatchObject({ conversation_id: id, sender_user_id: ana!._id, client_id, kind: 'media' });
		expect(message.payload).toMatchObject({ message: 'Sale solo', scheduled: true, attachments: [{ attachmentId: upload_id }] });
		expect(await stored('attachment-management', upload_id)).toMatchObject({ related_model: 'Message', related_record_id: message_id });
		const history = await call(beto!, 'messages', 'read_message_page', `/history/${id}`, { params: { conversationId: id } });
		expect(history.body.data.at(-1)).toMatchObject({ _id: message_id, scheduled: true, attachments: [{ attachment_id: upload_id }] });
		await db.unsafe(`UPDATE ${st.qt('chat-scheduled')} SET state = 'sending' WHERE id = $1`, [view._id]);
		await close_pending_jobs(st);
		expect((await stored('chat-scheduled', view._id)).state).toBe('pending');
		await send_due_scheduled(st, new Date(Date.now() + 3 * 60_000));
		expect(await stored('chat-scheduled', view._id)).toMatchObject({ state: 'sent', payload: expect.objectContaining({ messageId: message_id, attempts: 2 }) });
		const copies = await db.unsafe(`SELECT id FROM ${st.qt('messages')} WHERE sender_user_id = $1 AND client_id = $2`, [ana!._id, client_id]);
		expect(copies).toHaveLength(1);
	}, 60_000);

	test('si el envío se niega queda failed y avisa a su autor; con 429 espera lo que pide el servidor antes de reintentar', async () => {
		const id = await group({ slowModeSeconds: 3600 });
		const denied = (await schedule(beto!, id, { client_id: crypto.randomUUID(), text: 'No saldrá', send_at: in_minutes(10) })).body.data[0]!;
		const slow = (await schedule(carla!, id, { client_id: crypto.randomUUID(), text: 'Espera tu turno', send_at: in_minutes(10) })).body.data[0]!;
		const now = await call(carla!, 'messages', 'create_chat_message', '/chat', {
			method: 'POST',
			json: { conversation_id: id, client_id: crypto.randomUUID(), text: 'Ya escribí' },
		});
		expect(now.status).toBe(200);
		await db.unsafe(`UPDATE ${st.qt('chat-members')} SET state = 'removed' WHERE conversation_id = $1 AND user_id = $2`, [id, beto!._id]);
		await send_due_scheduled(st, new Date(Date.now() + 11 * 60_000));
		const message = 'No participas en esta conversación.';
		expect(await stored('chat-scheduled', denied._id)).toMatchObject({
			state: 'failed',
			payload: expect.objectContaining({ error: message, attempts: 1 }),
		});
		expect(await notices(beto!)).toEqual([
			expect.objectContaining({
				type: 'chat-scheduled-failed',
				message,
				source: expect.objectContaining({ route: `/mensajes?chat_conversation_id=${id}` }),
			}),
		]);
		const waiting = await stored('chat-scheduled', slow._id);
		expect(waiting).toMatchObject({ state: 'pending', payload: expect.objectContaining({ attempts: 1 }) });
		expect(Date.parse(String(waiting.send_at))).toBeGreaterThan(Date.now() + 30 * 60_000);
		await send_due_scheduled(st, new Date(Date.now() + 11 * 60_000));
		expect(await stored('chat-scheduled', slow._id)).toMatchObject({ state: 'pending', payload: expect.objectContaining({ attempts: 1 }) });
	}, 60_000);

	test('guardar: uno por persona y mensaje, con su mensaje mientras se vea; el recordatorio llega como notificación', async () => {
		const id = await group();
		const said = async (text: string) =>
			String(
				(await call(ana!, 'messages', 'create_chat_message', '/chat', { method: 'POST', json: { conversation_id: id, client_id: crypto.randomUUID(), text } }))
					.body.data[0]!._id,
			);
		const message_id = await said('Guárdenlo');
		const save = (actor: ImperiumDoc, target: string, json: ImperiumDoc = {}) =>
			call(actor, 'messages', 'save_chat_message', `/message/${target}/save`, { method: 'POST', params: { id: target }, json });
		const first = (await save(beto!, message_id, { note: 'para el lunes' })).body.data[0]!;
		expect(first).toMatchObject({
			conversation_id: id,
			note: 'para el lunes',
			state: 'pending',
			message: { _id: message_id, text: 'Guárdenlo' },
			preview: { sender_name: 'Ana Programa', text_preview: 'Guárdenlo', kind: 'text' },
		});
		const remind_at = in_minutes(30);
		expect((await save(beto!, message_id, { remind_at })).body.data[0]).toMatchObject({ _id: first._id, note: 'para el lunes', remind_at });
		expect(await outcome(save(dario!, message_id))).toEqual([403, 'not_member']);
		const second = (await save(beto!, await said('Y este'))).body.data[0]!;
		const page = (query = '') => call(beto!, 'messages', 'read_saved_messages', `/saved${query}`);
		const one = await page('?limit=1');
		expect(one.body.data.map((row) => row._id)).toEqual([second._id]);
		expect((await page(`?limit=1&cursor=${one.body.next_cursor}`)).body.data.map((row) => row._id)).toEqual([first._id]);
		await remind_due_saved(st, new Date(Date.now() + 60 * 60_000));
		expect((await stored('chat-saved', first._id)).state).toBe('notified');
		expect((await notices(beto!)).filter((notice) => notice.type === 'chat-reminder')).toEqual([
			expect.objectContaining({
				type: 'chat-reminder',
				message: 'para el lunes',
				source: expect.objectContaining({ route: `/mensajes?chat_conversation_id=${id}&chat_message_id=${message_id}` }),
			}),
		]);
		const saved_id = String(first._id);
		const update = (actor: ImperiumDoc, json: ImperiumDoc) =>
			call(actor, 'messages', 'update_saved_message', `/saved/${saved_id}`, { method: 'PATCH', params: { id: saved_id }, json });
		const done = (await update(beto!, { state: 'done', note: null })).body.data[0]!;
		expect(done).toMatchObject({ state: 'done' });
		expect(done.note).toBeUndefined();
		expect(await outcome(update(ana!, { state: 'done' }))).toEqual([404, 'saved_not_found']);
		await db.unsafe(`UPDATE ${st.qt('chat-members')} SET state = 'left' WHERE conversation_id = $1 AND user_id = $2`, [id, beto!._id]);
		expect((await page('?state=done')).body.data).toEqual([
			expect.objectContaining({ _id: saved_id, message: null, preview: expect.objectContaining({ text_preview: 'Guárdenlo' }) }),
		]);
		const remove = (actor: ImperiumDoc) =>
			call(actor, 'messages', 'delete_saved_message', `/saved/${saved_id}`, { method: 'DELETE', params: { id: saved_id } });
		expect(await outcome(remove(ana!))).toEqual([404, 'saved_not_found']);
		expect((await remove(beto!)).status).toBe(200);
		expect(await outcome(remove(beto!))).toEqual([404, 'saved_not_found']);
	}, 60_000);

	test('lo borrado para todos pierde el texto en lo guardado; el recordatorio no avisa lo que ya no se ve', async () => {
		const id = await group();
		const said = async (text: string) =>
			String(
				(await call(ana!, 'messages', 'create_chat_message', '/chat', { method: 'POST', json: { conversation_id: id, client_id: crypto.randomUUID(), text } }))
					.body.data[0]!._id,
			);
		const save = (actor: ImperiumDoc, target: string) =>
			call(actor, 'messages', 'save_chat_message', `/message/${target}/save`, {
				method: 'POST',
				params: { id: target },
				json: { remind_at: in_minutes(30) },
			});
		const erased = await said('BORRAME contenido sensible');
		const kept = await said('sigue aquí');
		const by_beto = (await save(beto!, erased)).body.data[0]!;
		await save(carla!, kept);
		const deleted = await call(ana!, 'messages', 'delete_chat_message', `/message/${erased}?scope=all`, {
			method: 'DELETE',
			params: { id: erased },
		});
		expect(deleted.status).toBe(200);
		const listed = (await call(beto!, 'messages', 'read_saved_messages', '/saved')).body.data.find((row) => row._id === by_beto._id);
		expect(listed).toMatchObject({ message: null, preview: { text_preview: '' } });
		await db.unsafe(`UPDATE ${st.qt('chat-members')} SET state = 'removed' WHERE conversation_id = $1 AND user_id = $2`, [id, carla!._id]);
		await remind_due_saved(st, new Date(Date.now() + 60 * 60_000));
		const reminded = async (user: ImperiumDoc, message_id: string) =>
			(await notices(user)).filter(
				(notice) => notice.type === 'chat-reminder' && as_object(notice.source).messageId === message_id,
			);
		expect(await reminded(beto!, erased)).toEqual([]);
		expect(await reminded(carla!, kept)).toEqual([]);
	}, 60_000);
});
