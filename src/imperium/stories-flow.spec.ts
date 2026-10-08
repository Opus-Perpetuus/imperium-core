/**
 * Historias por las rutas, contra Postgres real (`DATABASE_URL`): la audiencia se resuelve en SQL.
 * Ids aleatorios y limpieza al final.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle_action } from './actions.ts';
import { purge_expired_stories } from './chat-jobs.ts';
import type { ImperiumDoc } from './envelope.ts';
import { serve_media } from './media.ts';
import { chat_contact_owners_sql, ImperiumStore, load_catalog_path } from './store.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const store = sql ? new ImperiumStore(sql, load_catalog_path()) : null;

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const created: Record<string, string[]> = {};

function track(resource: string, id: string): string {
	(created[resource] ??= []).push(id);
	return id;
}

type Reply = { status: number; body: { data: ImperiumDoc[]; code?: string } & Record<string, unknown> };

async function call(
	st: ImperiumStore,
	actor: ImperiumDoc,
	action: string,
	path: string,
	init: { method?: string; params?: Record<string, string>; json?: unknown; form?: FormData; resource?: string } = {},
): Promise<Reply> {
	const resource = init.resource ?? 'chat-stories';
	const url = new URL(`http://core/api/${resource}${path}`);
	const req = new Request(url, {
		method: init.method ?? 'GET',
		headers: init.json === undefined ? undefined : { 'content-type': 'application/json' },
		body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
	});
	try {
		const res = await handle_action(st, {} as Bun.SQL, req, url, resource, action, init.params ?? {}, actor);
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

test('el interruptor de la organización apaga todas las rutas', async () => {
	const off = {
		has: (resource: string) => resource === 'configuration',
		find_many: async () => ({ rows: [{ _ref: 'configuration-chat-stories-enabled', value: false }], total: 1 }),
	};
	const reply = await call(off as unknown as ImperiumStore, { _id: hex_id() }, 'read_story_feed', '/feed');
	expect([reply.status, reply.body.code]).toEqual([403, 'feature_disabled']);
});

let folder = '';
let previous_folder: string | undefined;

beforeAll(() => {
	folder = mkdtempSync(join(tmpdir(), 'imperium-stories-'));
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

describe.skipIf(!sql)('historias en Postgres', () => {
	const db = sql!;
	const st = store!;
	const people: ImperiumDoc[] = ['Ana', 'Beto', 'Carla', 'Darío', 'Eva', 'Fran', 'Gabi'].map((name) => ({
		_id: hex_id(),
		name: `${name} Historia`,
	}));
	const [ana, beto, carla, dario, eva, fran, gabi] = people as [
		ImperiumDoc,
		ImperiumDoc,
		ImperiumDoc,
		ImperiumDoc,
		ImperiumDoc,
		ImperiumDoc,
		ImperiumDoc,
	];
	const direct = [String(ana._id), String(beto._id)].sort().join('::');

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
		const now = new Date().toISOString();
		for (const user of people) {
			await db.unsafe(
				`INSERT INTO ${st.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
				 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
				[track('user', String(user._id)), user.name, `${user._id}@empresa.com`, now],
			);
		}
		const direct_id = track('chat-conversations', hex_id());
		await db.unsafe(
			`INSERT INTO ${st.qt('chat-conversations')} (id, name, is_active, kind, conversation_key, last_seq, payload, created_at, updated_at)
			 VALUES ($1, '', true, 'direct', $2, 1, '{"memberCount": 2}'::jsonb, $3, $3)`,
			[direct_id, direct, now],
		);
		await db.unsafe(
			`INSERT INTO ${st.qt('messages')} (id, name, is_active, conversation_id, seq, sender_user_id, kind, payload, created_at, updated_at)
			 VALUES ($1, '', true, $2, 1, $3, 'text', '{"message": "Hola"}'::jsonb, $4, $4)`,
			[track('messages', hex_id()), direct_id, ana._id, now],
		);
	}, 120_000);

	afterAll(async () => {
		const collect = async (resource: string, where: string, value: string) => {
			const rows = (await db.unsafe(`SELECT id FROM ${st.qt(resource)} WHERE ${where}`, [value])) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		};
		const [conversation] = (await db.unsafe(`SELECT id FROM ${st.qt('chat-conversations')} WHERE conversation_key = $1`, [
			direct,
		])) as Array<{ id: string }>;
		if (conversation) {
			for (const resource of ['messages', 'chat-members']) await collect(resource, 'conversation_id = $1', conversation.id);
		}
		for (const user of people) {
			const id = String(user._id);
			await collect('chat-stories', 'author_id = $1', id);
			await collect('chat-story-views', 'viewer_id = $1', id);
			await collect('attachment-management', 'created_by_id = $1', id);
			await collect('user-settings', `payload ->> 'user_id' = $1`, id);
		}
	}, 120_000);

	const clip = () => new File([new Uint8Array(64)], 'clip.mp4', { type: 'video/mp4' });

	function post(actor: ImperiumDoc, fields: Record<string, unknown>, file?: File) {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
		if (file) form.append('file', file);
		return call(st, actor, 'create_story', '/mine', { method: 'POST', form });
	}

	const feed = (actor: ImperiumDoc, query = '') => call(st, actor, 'read_story_feed', `/feed${query}`);
	const view = (actor: ImperiumDoc, id: unknown, json: ImperiumDoc = {}) =>
		call(st, actor, 'view_story', `/${id}/view`, { method: 'POST', params: { id: String(id) }, json });
	const viewers = (actor: ImperiumDoc, id: unknown) => call(st, actor, 'read_story_viewers', `/${id}/viewers`, { params: { id: String(id) } });

	/** Por autor, las historias que el feed le muestra a `actor`. */
	async function seen_by(actor: ImperiumDoc): Promise<Record<string, unknown[]>> {
		const reply = await feed(actor, '?limit=50');
		return Object.fromEntries(
			reply.body.data.map((entry) => [
				String((entry.author as ImperiumDoc)._id),
				(entry.stories as ImperiumDoc[]).map((story) => story._id),
			]),
		);
	}

	async function settings_for(user: ImperiumDoc, chat_preferences: ImperiumDoc): Promise<void> {
		await db.unsafe(
			`INSERT INTO ${st.qt('user-settings')} (id, name, is_active, payload, created_at, updated_at)
			 VALUES ($1, 'user-settings', true, $2::jsonb, $3, $3)`,
			[track('user-settings', hex_id()), { user_id: user._id, chat_preferences }, new Date().toISOString()],
		);
	}

	let organization = '';
	let contacts = '';
	let chosen = '';
	let expired = '';

	test('publicar: texto con un fondo del tema, o una imagen o un video con su archivo; lo inválido no entra', async () => {
		const text = await post(gabi, { kind: 'text', text: 'Hoy hay pozole', background: 'lavanda', audience: { kind: 'organization', exclude_ids: [eva._id] } });
		const story = text.body.data[0]!;
		expect(story).toMatchObject({
			kind: 'text',
			text: 'Hoy hay pozole',
			background: 'lavanda',
			viewed: true,
			view_count: 0,
			author: { _id: gabi._id, name: 'Gabi Historia' },
			audience: { kind: 'organization', user_ids: [], exclude_ids: [eva._id] },
		});
		expect(Date.parse(String(story.expires_at)) - Date.parse(String(story.created_at))).toBeGreaterThanOrEqual(24 * 3600_000 - 5000);
		const video = (await post(gabi, { kind: 'video', caption: 'Mira', audience: { kind: 'contacts' } }, clip())).body.data[0]!;
		expect(video).toMatchObject({ kind: 'video', caption: 'Mira', attachment: { kind: 'video', mimetype: 'video/mp4' } });
		const svg = new File(['<svg/>'], 'dibujo.svg', { type: 'image/svg+xml' });
		expect(await outcome(post(gabi, { kind: 'image' }, svg))).toEqual([415, 'upload_type_not_allowed']);
		for (const [fields, file] of [
			[{ kind: 'text', text: 'Hola', background: '#ff00aa' }],
			[{ kind: 'image' }],
			[{ kind: 'text', text: 'Con archivo' }, clip()],
			[{ kind: 'text', text: 'Sin a quién', audience: { kind: 'users' } }],
			[{ kind: 'gif', text: 'No existe' }],
		] as Array<[Record<string, unknown>, File?]>) {
			expect(await outcome(post(gabi, fields, file))).toEqual([422, 'invalid_request']);
		}
	}, 60_000);

	test('el feed resuelve la audiencia en SQL: organización, contactos por directo, personas elegidas y excluidas; lo vencido no sale', async () => {
		organization = String((await post(ana, { kind: 'text', text: 'Para todos', audience: { kind: 'organization', exclude_ids: [eva._id] } })).body.data[0]!._id);
		contacts = String((await post(ana, { kind: 'text', text: 'Para mis contactos', audience: { kind: 'contacts' } })).body.data[0]!._id);
		chosen = String((await post(ana, { kind: 'text', text: 'Para Darío', audience: { kind: 'users', user_ids: [dario._id] } })).body.data[0]!._id);
		expired = String((await post(ana, { kind: 'text', text: 'Ya pasó' })).body.data[0]!._id);
		await db.unsafe(`UPDATE ${st.qt('chat-stories')} SET expires_at = $2 WHERE id = $1`, [expired, '2001-01-01T00:00:00.000Z']);
		const of_ana = async (actor: ImperiumDoc) => (await seen_by(actor))[String(ana._id)];
		expect(await of_ana(beto)).toEqual([organization, contacts]);
		expect(await of_ana(carla)).toEqual([organization]);
		expect(await of_ana(dario)).toEqual([organization, chosen]);
		expect(await of_ana(eva)).toBeUndefined();
		const own = (await feed(ana)).body.data[0]!;
		expect(own).toMatchObject({ author: { _id: ana._id }, has_unseen: false });
		expect((own.stories as ImperiumDoc[]).map((story) => [story._id, (story.audience as ImperiumDoc).kind])).toEqual([
			[organization, 'organization'],
			[contacts, 'contacts'],
			[chosen, 'users'],
		]);
		const by_author = await call(st, dario, 'read_author_stories', `/author/${ana._id}`, { params: { userId: String(ana._id) } });
		expect(by_author.body.data.map((story) => story._id)).toEqual([organization, chosen]);
		expect(by_author.body.data[0]!.audience).toBeUndefined();
		expect(await outcome(call(st, eva, 'read_author_stories', `/author/${ana._id}`, { params: { userId: String(ana._id) } }))).toEqual([
			404,
			'story_not_found',
		]);
	}, 60_000);

	test('contactos: abrir un directo con quien publica no basta; cuenta que ella haya escrito por él', async () => {
		const opened = await call(st, carla, 'open_direct_conversation', '/direct', {
			method: 'POST',
			resource: 'chat-conversations',
			json: { user_id: ana._id },
		});
		expect(opened.status).toBe(200);
		const id = track('chat-conversations', String(opened.body.data[0]!._id));
		const rows = (await db.unsafe(`SELECT id FROM ${st.qt('chat-members')} WHERE conversation_id = $1`, [id])) as Array<{ id: string }>;
		for (const row of rows) track('chat-members', row.id);
		expect((await seen_by(carla))[String(ana._id)]).toEqual([organization]);
		const media = await st.chat_contact_owners(String(carla._id), [String(ana._id)]);
		expect(media).toEqual([]);
		expect(await st.chat_contact_owners(String(beto._id), [String(ana._id)])).toEqual([String(ana._id)]);
		expect(await st.chat_contact_owners(String(ana._id), [String(beto._id)])).toEqual([]);
	}, 60_000);

	/**
	 * El peor caso de `contact_sql`: quien publica escribió miles de mensajes fuera del directo y el
	 * lector miles dentro. Sin el índice de (remitente, conversación) saber si ella le escribió
	 * cruza unos con otros; con él es una sola búsqueda. Todo se revierte.
	 */
	test('saber si quien publica escribió por el directo es una búsqueda por índice, no un recorrido de mensajes', async () => {
		const rollback = new Error('rollback');
		let plan = '';
		await db
			.begin(async (tx) => {
				const now = new Date().toISOString();
				const [direct_row] = (await tx.unsafe(`SELECT id FROM ${st.qt('chat-conversations')} WHERE conversation_key = $1`, [
					direct,
				])) as Array<{ id: string }>;
				const insert = (conversation_id: string, sender: unknown) =>
					tx.unsafe(
						`INSERT INTO ${st.qt('messages')} (id, name, is_active, conversation_id, seq, sender_user_id, client_id, kind, payload, created_at, updated_at)
						 SELECT left(md5($1 || g::text), 24), '', true, $2, 1000 + g, $3, md5($1 || g::text), 'text', '{}'::jsonb, $4, $4
						 FROM generate_series(1, 5000) AS g`,
						[hex_id(), conversation_id, sender, now],
					);
				await insert(direct_row!.id, beto._id);
				await insert(hex_id(), ana._id);
				const tables = { conversations: st.qt('chat-conversations'), messages: st.qt('messages') };
				const rows = (await tx.unsafe(`EXPLAIN ${chat_contact_owners_sql(tables)}`, [
					String(beto._id),
					[String(ana._id)],
				])) as Array<{ 'QUERY PLAN': string }>;
				plan = rows.map((row) => row['QUERY PLAN']).join('\n');
				throw rollback;
			})
			.catch((err) => {
				if (err !== rollback) throw err;
			});
		expect(plan).toContain('ix_messages_sender_conversation');
	}, 60_000);

	test('los silenciados van al final y el feed pagina por keyset', async () => {
		await post(fran, { kind: 'text', text: 'Lo último' });
		const first = await feed(beto);
		const order = first.body.data.map((entry) => (entry.author as ImperiumDoc)._id);
		expect(order.indexOf(fran._id)).toBeLessThan(order.indexOf(ana._id));
		await settings_for(beto, { stories_muted_author_ids: [fran._id] });
		const muted = (await feed(beto)).body.data.map((entry) => (entry.author as ImperiumDoc)._id);
		expect(muted.indexOf(fran._id)).toBeGreaterThan(muted.indexOf(ana._id));
		const pages: unknown[] = [];
		let cursor: unknown = '';
		do {
			const page = await feed(beto, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
			pages.push(...page.body.data.map((entry) => (entry.author as ImperiumDoc)._id));
			cursor = page.body.next_cursor;
		} while (cursor);
		expect(pages).toEqual(muted);
		expect(await outcome(feed(beto, '?cursor=basura'))).toEqual([400, 'invalid_cursor']);
	}, 60_000);

	test('ver: una vez por persona, con su reacción; quién vio, solo para el autor y si comparte las suyas', async () => {
		expect((await view(beto, organization, { reaction: '🔥' })).body.data).toEqual([{ viewed: true }]);
		const story_of = async (actor: ImperiumDoc, id: string) =>
			((await feed(actor, '?limit=50')).body.data.flatMap((entry) => entry.stories as ImperiumDoc[])).find((story) => story._id === id);
		expect(await story_of(beto, organization)).toMatchObject({ viewed: true, my_reaction: '🔥' });
		const entry_of_ana = async (actor: ImperiumDoc) =>
			(await feed(actor, '?limit=50')).body.data.find((entry) => (entry.author as ImperiumDoc)._id === ana._id);
		expect(await entry_of_ana(beto)).toMatchObject({ has_unseen: true });
		await view(beto, contacts);
		expect(await entry_of_ana(beto)).toMatchObject({ has_unseen: false });
		await settings_for(carla, { privacy: { story_view_receipts: false } });
		await view(carla, organization);
		expect(await outcome(view(eva, organization))).toEqual([404, 'story_not_found']);
		expect(await outcome(view(beto, expired))).toEqual([410, 'story_expired']);
		const seen = await viewers(ana, organization);
		expect(seen.body.data).toEqual([{ viewer: expect.objectContaining({ _id: beto._id }), viewed_at: expect.any(String), reaction: '🔥' }]);
		expect(seen.body.anonymous_count).toBe(1);
		const own = (await feed(ana)).body.data[0]!.stories as ImperiumDoc[];
		expect(own.find((story) => story._id === organization)).toMatchObject({ view_count: 2 });
		expect(await outcome(viewers(beto, organization))).toEqual([403, 'not_author']);
		await settings_for(ana, { privacy: { story_view_receipts: false } });
		expect(await outcome(viewers(ana, organization))).toEqual([403, 'receipts_off']);
	}, 60_000);

	test('responder: llega al directo con su autor como story-reply; la propia no se responde y lo vencido tampoco', async () => {
		const reply = (actor: ImperiumDoc, id: string, json: ImperiumDoc) =>
			call(st, actor, 'reply_to_story', `/${id}/reply`, { method: 'POST', params: { id }, json });
		const client_id = crypto.randomUUID();
		const sent = (await reply(beto, organization, { client_id, text: '¡Se me antojó!' })).body.data[0]!;
		expect(sent).toMatchObject({
			kind: 'story-reply',
			conversation_key: direct,
			text: '¡Se me antojó!',
			story_ref: { story_id: organization, kind: 'text', text_preview: 'Para todos', available: true },
		});
		expect((await reply(beto, organization, { client_id, text: '¡Se me antojó!' })).body.data[0]!._id).toBe(sent._id);
		expect(await outcome(reply(ana, organization, { client_id: crypto.randomUUID(), text: 'Yo misma' }))).toEqual([422, 'invalid_request']);
		expect(await outcome(reply(beto, expired, { client_id: crypto.randomUUID(), text: 'Tarde' }))).toEqual([410, 'story_expired']);
	}, 60_000);

	test('borrar la propia y caducar: sale del feed con sus vistas y su archivo, que solo veía su audiencia', async () => {
		const own = (await post(fran, { kind: 'video', audience: { kind: 'users', user_ids: [beto._id] } }, clip())).body.data[0]!;
		const attachment_id = String((own.attachment as ImperiumDoc).attachment_id);
		const media = async (actor: ImperiumDoc) => (await serve_media(st, attachment_id, { actor })).status;
		expect(await media(beto)).toBe(200);
		expect(await media(carla)).toBe(403);
		const tokens = async (actor: ImperiumDoc) =>
			(
				await call(st, actor, 'issue_media_tokens', '/media-tokens', {
					method: 'POST',
					resource: 'messages',
					json: { attachment_ids: [attachment_id] },
				})
			).body.data.map((row) => row.attachment_id);
		expect(await tokens(beto)).toEqual([attachment_id]);
		expect(await tokens(carla)).toEqual([]);
		const [file] = (await db.unsafe(`SELECT name_stored FROM ${st.qt('attachment-management')} WHERE id = $1`, [attachment_id])) as Array<{
			name_stored: string;
		}>;
		const path = join(folder, file!.name_stored);
		expect(existsSync(path)).toBe(true);
		await view(beto, own._id);
		const remove = (actor: ImperiumDoc) =>
			call(st, actor, 'delete_story', `/mine/${own._id}`, { method: 'DELETE', params: { id: String(own._id) } });
		expect(await outcome(remove(beto))).toEqual([404, 'story_not_found']);
		expect((await remove(fran)).status).toBe(200);
		expect(await outcome(remove(fran))).toEqual([404, 'story_not_found']);
		expect(((await seen_by(beto))[String(fran._id)] ?? []).includes(own._id)).toBe(false);
		expect(await db.unsafe(`SELECT id FROM ${st.qt('chat-story-views')} WHERE story_id = $1`, [own._id])).toHaveLength(0);
		expect(existsSync(path)).toBe(false);

		const lapsing = (await post(ana, { kind: 'video', audience: { kind: 'contacts' } }, clip())).body.data[0]!;
		const lapsing_file = String((lapsing.attachment as ImperiumDoc).attachment_id);
		expect(await media(beto)).toBe(410);
		expect((await serve_media(st, lapsing_file, { actor: beto })).status).toBe(200);
		expect((await serve_media(st, lapsing_file, { actor: carla })).status).toBe(403);
		await view(beto, lapsing._id);
		await db.unsafe(`UPDATE ${st.qt('chat-stories')} SET expires_at = $2 WHERE id = $1`, [lapsing._id, '2001-01-01T00:00:00.000Z']);
		expect(await purge_expired_stories(st, new Date())).toBeGreaterThanOrEqual(1);
		const [row] = (await db.unsafe(`SELECT is_active, state, payload FROM ${st.qt('chat-stories')} WHERE id = $1`, [lapsing._id])) as ImperiumDoc[];
		expect(row).toMatchObject({ is_active: false, state: 'expired' });
		expect(await db.unsafe(`SELECT id FROM ${st.qt('chat-story-views')} WHERE story_id = $1`, [lapsing._id])).toHaveLength(0);
		expect((await serve_media(st, lapsing_file, { actor: beto })).status).toBe(410);
	}, 60_000);
});
