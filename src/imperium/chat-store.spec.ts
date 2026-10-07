/**
 * Modelo del chat contra Postgres real (`DATABASE_URL`). Ids aleatorios y limpieza al
 * final: corre sobre una copia con datos y no debe dejar rastro.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import { register_chat_activity } from './notifications.ts';
import { chat_backfill_sqls, chat_media_page_sql, ImperiumStore, is_unique_violation, load_catalog_path } from './store.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const store = sql ? new ImperiumStore(sql, load_catalog_path()) : null;

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const created: Record<string, string[]> = {};

function track(resource: string, id: string): string {
	(created[resource] ??= []).push(id);
	return id;
}

afterAll(async () => {
	if (!sql || !store) return;
	for (const [resource, ids] of Object.entries(created)) {
		await sql.unsafe(
			`DELETE FROM ${store.qt(resource)} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[ids],
		);
	}
	await sql.close();
});

describe.skipIf(!sql)('modelo del chat en Postgres', () => {
	const db = sql!;
	const st = store!;

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	test('ensure_defaults crea las tablas, luego los índices y después respalda los 1:1', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async ensure_defaults(');
		const body = src.slice(start, src.indexOf('async seed_default_employee(', start));
		const order = ['this.ensure_orphan_tables()', 'this.ensure_unique_indexes()', 'this.chat_backfill_direct()'];
		const at = order.map((call) => body.indexOf(call));
		expect(at.every((i) => i > -1)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});

	test('las tablas del chat existen con sus columnas físicas', async () => {
		const expected: Record<string, Record<string, string>> = {
			messages: {
				conversation_id: 'text',
				seq: 'double precision',
				sender_user_id: 'text',
				client_id: 'text',
				kind: 'text',
				expires_at: 'text',
			},
			chat_conversations: {
				kind: 'text',
				conversation_key: 'text',
				last_seq: 'double precision',
				last_message_at: 'text',
				join_code: 'text',
			},
			chat_members: {
				conversation_id: 'text',
				user_id: 'text',
				role: 'text',
				state: 'text',
				last_read_seq: 'double precision',
				public_read_seq: 'double precision',
				delivered_seq: 'double precision',
			},
			chat_reactions: { message_id: 'text', conversation_id: 'text', user_id: 'text', kind: 'text', value: 'text' },
			chat_audit: { conversation_id: 'text', message_id: 'text', actor_id: 'text', action: 'text' },
			chat_scheduled: { conversation_id: 'text', sender_user_id: 'text', send_at: 'text', state: 'text' },
			chat_saved: { user_id: 'text', message_id: 'text', remind_at: 'text', state: 'text' },
			chat_stories: { author_id: 'text', expires_at: 'text' },
			chat_story_views: { story_id: 'text', viewer_id: 'text', viewed_at: 'text' },
		};
		const rows = (await db.unsafe(
			`SELECT table_name, column_name, data_type FROM information_schema.columns
			 WHERE table_schema = 'subject_configuracion' AND table_name IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[Object.keys(expected)],
		)) as Array<{ table_name: string; column_name: string; data_type: string }>;
		for (const [table, columns] of Object.entries(expected)) {
			const found = Object.fromEntries(
				rows.filter((row) => row.table_name === table).map((row) => [row.column_name, row.data_type]),
			);
			expect({ table, ...found }).toMatchObject({ table, ...columns, payload: 'jsonb', created_at: 'text' });
		}
	});

	test('los únicos y los índices de las páginas están creados', async () => {
		const rows = (await db.unsafe(
			`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'subject_configuracion'`,
		)) as Array<{ indexname: string; indexdef: string }>;
		const unique = new Set(rows.filter((row) => row.indexdef.startsWith('CREATE UNIQUE')).map((row) => row.indexname));
		for (const name of [
			'uq_messages_sender_user_id_client_id',
			'uq_messages_conversation_id_seq',
			'uq_messages_guest_client',
			'uq_chat_conversations_conversation_key',
			'uq_chat_conversations_join_code',
			'uq_chat_members_conversation_id_user_id',
			'uq_chat_reactions_message_id_user_id_kind_value',
			'uq_chat_saved_user_id_message_id',
			'uq_chat_story_views_story_id_viewer_id',
		]) {
			expect({ name, unique: unique.has(name) }).toEqual({ name, unique: true });
		}
		const names = new Set(rows.map((row) => row.indexname));
		for (const name of [
			'ix_messages_conversation_updated',
			'ix_messages_expires',
			'ix_messages_conversationKey',
			'ix_chat_conversations_inbox',
			'ix_chat_members_user_state',
			'ix_chat_audit_conversation_created',
			'ix_chat_stories_author_expires',
			'ix_notifications_recipient_created',
		]) {
			expect({ name, exists: names.has(name) }).toEqual({ name, exists: true });
		}
	});

	test('la privacidad y los silenciados se leen por el único parcial de user-settings', async () => {
		const seen: Array<[string, unknown[]]> = [];
		const spy = new Proxy(db, {
			get(target, key) {
				if (key === 'unsafe') {
					return (query: string, params: unknown[]) => {
						seen.push([query, params]);
						return target.unsafe(query, params);
					};
				}
				const value = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const probe = new ImperiumStore(spy, load_catalog_path());
		await probe.chat_privacy(hex_id());
		await probe.chat_privacy_many([hex_id()]);
		await probe.chat_receipts_off([hex_id()]);
		await probe.chat_muted_story_authors(hex_id());
		const reads = seen.filter(([query]) => query.includes(st.qt('user-settings')));
		expect(reads).toHaveLength(4);
		for (const [query, params] of reads) {
			const plan = (await db.begin(async (tx) => {
				await tx.unsafe('SET LOCAL enable_seqscan = off');
				return tx.unsafe(`EXPLAIN ${query}`, params);
			})) as Array<{ 'QUERY PLAN': string }>;
			expect({ query, uses: plan.map((row) => row['QUERY PLAN']).join('\n').includes('uq_user_settings_user_id') }).toEqual({
				query,
				uses: true,
			});
		}
	});

	test('la Actividad de un @todos entra en una sola sentencia, una fila por persona', async () => {
		const inserts: string[] = [];
		const spy = new Proxy(db, {
			get(target, key) {
				if (key === 'unsafe') {
					return (query: string, params: unknown[]) => {
						if (/^\s*INSERT INTO/i.test(query) && query.includes(st.qt('mentions'))) inserts.push(query);
						return target.unsafe(query, params);
					};
				}
				const value = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const probe = new ImperiumStore(spy, load_catalog_path());
		const [actor, conversation_id, message_id] = [hex_id(), hex_id(), hex_id()];
		const people = Array.from({ length: 6 }, hex_id);
		await register_chat_activity(
			probe,
			{ _id: actor, name: 'Ana' },
			people.map((user_id) => ({ user_id, context_type: 'chat-message', conversation_id, message_id, excerpt: '@todos hola' })),
		);
		const rows = (await db.unsafe(
			`SELECT id, name, is_active, payload FROM ${st.qt('mentions')} WHERE payload ->> 'messageId' = $1`,
			[message_id],
		)) as Array<{ id: string; name: string; is_active: boolean; payload: ImperiumDoc }>;
		for (const row of rows) track('mentions', row.id);
		expect(inserts).toHaveLength(1);
		expect(rows.map((row) => row.payload.mentionedUserId).sort()).toEqual([...people].sort());
		expect(rows[0]).toMatchObject({
			name: 'mención',
			is_active: true,
			payload: { actorId: actor, contextType: 'chat-message', conversationId: conversation_id, isRead: false, excerpt: '@todos hola' },
		});
	});

	async function insert_message(fields: Record<string, unknown>): Promise<void> {
		const id = track('messages', hex_id());
		const now = new Date().toISOString();
		await db.unsafe(
			`INSERT INTO ${st.qt('messages')} (id, name, is_active, conversation_id, seq, sender_user_id, client_id, payload, created_at, updated_at)
			 VALUES ($1, '', true, $2, $3, $4, $5, '{}'::jsonb, $6, $6)`,
			[id, fields.conversation_id, fields.seq ?? null, fields.sender_user_id ?? null, fields.client_id ?? null, now],
		);
	}

	async function rejects_duplicate(fields: Record<string, unknown>): Promise<boolean> {
		try {
			await insert_message(fields);
			return false;
		} catch (err) {
			return is_unique_violation(err);
		}
	}

	test('seq es único por conversación', async () => {
		const conversation_id = hex_id();
		await insert_message({ conversation_id, seq: 1 });
		await insert_message({ conversation_id: hex_id(), seq: 1 });
		expect(await rejects_duplicate({ conversation_id, seq: 1 })).toBe(true);
	});

	test('client_id es único por remitente y, sin remitente (invitados), por conversación', async () => {
		const conversation_id = hex_id();
		const client_id = crypto.randomUUID();
		await insert_message({ conversation_id, sender_user_id: 'ana', client_id });
		await insert_message({ conversation_id, sender_user_id: 'beto', client_id });
		expect(await rejects_duplicate({ conversation_id: hex_id(), sender_user_id: 'ana', client_id })).toBe(true);
		await insert_message({ conversation_id, client_id });
		await insert_message({ conversation_id: hex_id(), client_id });
		expect(await rejects_duplicate({ conversation_id, client_id })).toBe(true);
	});

	test('la página de un hilo usa el único (conversation_id, seq)', async () => {
		const plan = await db.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off');
			return (await tx.unsafe(
				`EXPLAIN SELECT id FROM ${st.qt('messages')}
				 WHERE conversation_id = '${hex_id()}' AND seq < 100 ORDER BY seq DESC LIMIT 50`,
			)) as Array<Record<string, string>>;
		});
		expect(plan.map((row) => Object.values(row)[0]).join('\n')).toContain('uq_messages_conversation_id_seq');
	});

	test('find_many pagina del más nuevo al más viejo con before_created', async () => {
		const conversation_id = hex_id();
		const times = ['2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:03.000Z'];
		const rows: ImperiumDoc[] = [];
		for (const created_at of times) {
			const row = await st.insert('chat-audit', { conversation_id, action: 'edit', created_at });
			track('chat-audit', String(row._id));
			rows.push(row);
		}
		const newest_first = rows
			.map((row) => ({ id: String(row._id), at: String(row.created_at) }))
			.sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
		const page = (before?: { at: string; id: string }) =>
			st.find_many('chat-audit', {
				where: { conversation_id },
				sort: 'created_at:desc',
				before_created: before,
				take: 2,
				populate: false,
				skip_total: true,
			});
		const first = (await page()).rows.map((row) => ({ id: String(row._id), at: String(row.created_at) }));
		const second = (await page(first[1])).rows.map((row) => ({ id: String(row._id), at: String(row.created_at) }));
		expect([...first, ...second]).toEqual(newest_first);
		expect((await page(second[1])).rows).toEqual([]);
	});
});

describe.skipIf(!sql)('envío con secuencia por conversación', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto] = [hex_id(), hex_id()].sort() as [string, string];
	const now = () => new Date().toISOString();

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	async function open_direct(): Promise<ImperiumDoc> {
		const conversation = await st.chat_open_direct({
			conversation_key: `${ana}::${beto}`,
			user_ids: [ana, beto],
			created_by: ana,
			now: now(),
		});
		track('chat-conversations', String(conversation._id));
		return conversation;
	}

	async function marks(conversation_id: string) {
		const rows = (await db.unsafe(
			`SELECT id, user_id, last_read_seq, public_read_seq, delivered_seq FROM ${st.qt('chat-members')}
			 WHERE conversation_id = $1 ORDER BY user_id`,
			[conversation_id],
		)) as ImperiumDoc[];
		for (const row of rows) track('chat-members', String(row.id));
		return Object.fromEntries(rows.map((row) => [String(row.user_id), row]));
	}

	async function last_seq(conversation_id: string): Promise<number> {
		const [row] = (await db.unsafe(`SELECT last_seq FROM ${st.qt('chat-conversations')} WHERE id = $1`, [
			conversation_id,
		])) as Array<{ last_seq: number }>;
		return Number(row?.last_seq);
	}

	function send(conversation_id: string, fields: Partial<Parameters<typeof st.chat_insert_message>[0]> = {}) {
		const id = track('messages', hex_id());
		return st.chat_insert_message({
			id,
			conversation_id,
			sender_user_id: ana,
			client_id: crypto.randomUUID(),
			kind: 'text',
			name: 'Beto',
			search_field: 'hola',
			payload: { message: 'Hola', senderUserId: ana, sourceType: 'chat', conversationId: conversation_id, rev: 0 },
			preview: { messageId: id, senderId: ana, senderName: 'Ana', kind: 'text', textPreview: 'Hola', at: now() },
			expires_at: null,
			share_read: true,
			attachment_ids: [],
			now: now(),
			...fields,
		});
	}

	test('abrir el directo dos veces da la misma conversación con sus dos miembros', async () => {
		const first = await open_direct();
		const again = await open_direct();
		expect(again._id).toBe(first._id);
		expect(first).toMatchObject({
			kind: 'direct',
			conversation_key: `${ana}::${beto}`,
			last_seq: 0,
			memberCount: 2,
			participantUserIds: [ana, beto],
			settings: { announcementOnly: false, membersCanPin: true },
		});
		const members = await marks(String(first._id));
		expect(Object.keys(members)).toEqual([ana, beto]);
		expect(members[beto]).toMatchObject({ last_read_seq: 0, delivered_seq: 0 });
	});

	test('20 envíos concurrentes quedan con seq 1..20, sin huecos, y el remitente los leyó', async () => {
		const conversation_id = String((await open_direct())._id);
		const before = await last_seq(conversation_id);
		const sent = await Promise.all(Array.from({ length: 20 }, () => send(conversation_id)));
		const seqs = sent.map((row) => Number(row?.message.seq)).sort((a, b) => a - b);
		expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => before + i + 1));
		expect(sent.every((row) => row?.duplicate === false)).toBe(true);
		expect(await last_seq(conversation_id)).toBe(before + 20);
		const members = await marks(conversation_id);
		expect(members[ana]).toMatchObject({
			last_read_seq: before + 20,
			public_read_seq: before + 20,
			delivered_seq: before + 20,
		});
		expect(members[beto]).toMatchObject({ last_read_seq: 0 });
	});

	test('reintentar con el mismo client_id devuelve el mismo mensaje y no gasta un seq', async () => {
		const conversation_id = String((await open_direct())._id);
		const client_id = crypto.randomUUID();
		const first = await send(conversation_id, { client_id });
		const seq = await last_seq(conversation_id);
		const retry = await send(conversation_id, { client_id });
		expect(retry).toEqual({ message: first!.message, duplicate: true });
		expect(await last_seq(conversation_id)).toBe(seq);
		expect(await st.chat_message_by_client_id(ana, client_id)).toEqual(first!.message);
	});

	test('el mensaje guarda sus columnas y la conversación su último mensaje', async () => {
		const conversation_id = String((await open_direct())._id);
		const sent = await send(conversation_id, { kind: 'media', search_field: 'plano.pdf' });
		const message = sent!.message;
		expect(message).toMatchObject({
			conversation_id,
			sender_user_id: ana,
			created_by: ana,
			kind: 'media',
			search_field: 'plano.pdf',
			message: 'Hola',
			rev: 0,
		});
		const [conversation] = (await db.unsafe(
			`SELECT last_message_at, payload FROM ${st.qt('chat-conversations')} WHERE id = $1`,
			[conversation_id],
		)) as ImperiumDoc[];
		expect(String(conversation?.last_message_at) >= String(message.created_at)).toBe(true);
		expect((conversation?.payload as ImperiumDoc).lastMessage).toMatchObject({
			messageId: message._id,
			seq: message.seq,
		});
	});

	test('sin compartir acuses, la marca pública del remitente no se mueve', async () => {
		const conversation_id = String((await open_direct())._id);
		const before = (await marks(conversation_id))[ana];
		const sent = await send(conversation_id, { share_read: false });
		const after = (await marks(conversation_id))[ana];
		expect(after).toMatchObject({ last_read_seq: sent!.message.seq, public_read_seq: before?.public_read_seq });
	});

	test('una conversación inactiva no recibe mensajes', async () => {
		const conversation_id = track('chat-conversations', hex_id());
		await db.unsafe(
			`INSERT INTO ${st.qt('chat-conversations')} (id, name, is_active, kind, conversation_key, last_seq, payload, created_at, updated_at)
			 VALUES ($1, 'Archivo', false, 'group', $2, 4, '{}'::jsonb, $3, $3)`,
			[conversation_id, `conv:${conversation_id}`, now()],
		);
		expect(await send(conversation_id)).toBeNull();
		expect(await last_seq(conversation_id)).toBe(4);
	});

	test('liga en orden las subidas propias sin ligar y deja las ajenas', async () => {
		const conversation_id = String((await open_direct())._id);
		const upload = async (owner: string, client_upload_id: string) => {
			const id = track('attachment-management', hex_id());
			await db.unsafe(
				`INSERT INTO ${st.qt('attachment-management')} (id, name, is_active, name_stored, created_by_id, related_model, related_record_id, payload, created_at, updated_at)
				 VALUES ($1, 'archivo', true, $2, $3, 'Message', '', $4::jsonb, $5, $5)`,
				[id, crypto.randomUUID(), owner, { chatUpload: { ownerUserId: owner, conversationId: conversation_id, clientUploadId: client_upload_id, kind: 'file' } }, now()],
			);
			return id;
		};
		const [first, second, foreign] = [
			await upload(ana, crypto.randomUUID()),
			await upload(ana, crypto.randomUUID()),
			await upload(beto, crypto.randomUUID()),
		];
		const sent = await send(conversation_id, { attachment_ids: [second, first, foreign] });
		const rows = (await db.unsafe(
			`SELECT id, related_record_id, field, index_if_is_array, inside_array, payload FROM ${st.qt('attachment-management')}
			 WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[[first, second, foreign]],
		)) as ImperiumDoc[];
		const by_id = Object.fromEntries(rows.map((row) => [String(row.id), row]));
		expect(by_id[second]).toMatchObject({
			related_record_id: sent!.message._id,
			field: 'attachments',
			index_if_is_array: '0',
			inside_array: 'true',
		});
		expect(by_id[first]).toMatchObject({ related_record_id: sent!.message._id, index_if_is_array: '1' });
		expect((by_id[first]?.payload as ImperiumDoc).chatUpload).toMatchObject({
			ownerUserId: ana,
			boundAt: sent!.message.created_at,
		});
		expect(by_id[foreign]?.related_record_id).toBe('');
	});

	test('una subida se encuentra por su client_upload_id y no se repite', async () => {
		const client_upload_id = crypto.randomUUID();
		const insert = () => {
			const id = track('attachment-management', hex_id());
			return db.unsafe(
				`INSERT INTO ${st.qt('attachment-management')} (id, name, is_active, name_stored, created_by_id, related_model, payload, created_at, updated_at)
				 VALUES ($1, 'archivo', true, $2, $3, 'Message', $4::jsonb, $5, $5)`,
				[id, crypto.randomUUID(), ana, { chatUpload: { ownerUserId: ana, clientUploadId: client_upload_id } }, now()],
			);
		};
		await insert();
		let rejected = false;
		try {
			await insert();
		} catch (err) {
			rejected = is_unique_violation(err);
		}
		expect(rejected).toBe(true);
		expect(await st.chat_upload_by_client_id(ana, client_upload_id)).toMatchObject({
			created_by_id: ana,
			chatUpload: { clientUploadId: client_upload_id },
		});
		expect(await st.chat_upload_by_client_id(beto, client_upload_id)).toBeNull();
	});

	test('la marca de entregado solo avanza y dice a quién le avanzó', async () => {
		const conversation_id = String((await open_direct())._id);
		const seq = Number((await send(conversation_id))!.message.seq);
		expect(await st.chat_mark_delivered(conversation_id, [ana, beto], seq)).toEqual([beto]);
		expect(await st.chat_mark_delivered(conversation_id, [beto], seq)).toEqual([]);
		expect((await marks(conversation_id))[beto]).toMatchObject({ delivered_seq: seq, last_read_seq: 0 });
		expect((await st.chat_member_ids(conversation_id)).sort()).toEqual([ana, beto]);
	});

	test('chat_users_brief trae lo mínimo de cada persona', async () => {
		const id = track('user', hex_id());
		await db.unsafe(
			`INSERT INTO ${st.qt('user')} (id, name, is_active, email, img, password, payload, created_at, updated_at)
			 VALUES ($1, 'Carla', false, 'carla@empresa.com', '', 'secreto', '{}'::jsonb, $2, $2)`,
			[id, now()],
		);
		expect(await st.chat_users_brief([id, id, hex_id()])).toEqual([
			{ _id: id, name: 'Carla', email: 'carla@empresa.com', is_active: false },
		]);
	});
});

describe.skipIf(!sql)('páginas, bandeja y marcas de agua', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto, carla] = [hex_id(), hex_id(), hex_id()].sort() as [string, string, string];
	const at = (minute: number) => `2026-04-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	async function conversation(fields: { kind?: string; key?: string; last_seq?: number; last_message_at?: string | null; created_at?: string; members: Record<string, Record<string, unknown>> }) {
		const id = track('chat-conversations', hex_id());
		await db.unsafe(
			`INSERT INTO ${st.qt('chat-conversations')} (id, name, is_active, kind, conversation_key, last_seq, last_message_at, payload, created_at, updated_at)
			 VALUES ($1, 'Grupo', true, $2, $3, $4, $5, $6::jsonb, $7, $7)`,
			[id, fields.kind ?? 'group', fields.key ?? `conv:${id}`, fields.last_seq ?? 0, fields.last_message_at ?? null, { memberCount: Object.keys(fields.members).length }, fields.created_at ?? at(0)],
		);
		for (const [user_id, member] of Object.entries(fields.members)) {
			const { last_read_seq = 0, public_read_seq = 0, delivered_seq = 0, state = 'active', updated_at = at(0), ...payload } = member;
			await db.unsafe(
				`INSERT INTO ${st.qt('chat-members')} (id, name, is_active, state, conversation_id, user_id, role, last_read_seq, public_read_seq, delivered_seq, payload, created_at, updated_at)
				 VALUES ($1, '', true, $2, $3, $4, 'member', $5, $6, $7, $8::jsonb, $9, $10)`,
				[track('chat-members', hex_id()), state, id, user_id, last_read_seq, public_read_seq, delivered_seq, payload, at(0), updated_at],
			);
		}
		return id;
	}

	async function messages(conversation_id: string, count: number) {
		for (let seq = 1; seq <= count; seq++) {
			await db.unsafe(
				`INSERT INTO ${st.qt('messages')} (id, name, is_active, conversation_id, seq, sender_user_id, kind, payload, created_at, updated_at)
				 VALUES ($1, '', true, $2, $3, $4, 'text', $5::jsonb, $6, $6)`,
				[track('messages', hex_id()), conversation_id, seq, ana, { message: `m${seq}` }, at(seq)],
			);
		}
	}

	const seqs = (rows: ImperiumDoc[]) => rows.map((row) => Number(row.seq));

	test('el hilo pagina por seq: cola, antes, después y desde, sin lo anterior a visibleFromSeq', async () => {
		const id = await conversation({ last_seq: 7, members: { [ana]: {} } });
		await messages(id, 7);
		const page = (direction: 'tail' | 'before' | 'after' | 'from', seq?: number, limit = 3) =>
			st.chat_message_page({ conversation_id: id, visible_from: 2, viewer_id: ana, limit, direction, seq });
		expect(await page('tail').then((p) => [seqs(p.rows), p.more])).toEqual([[5, 6, 7], true]);
		expect(await page('before', 5).then((p) => [seqs(p.rows), p.more])).toEqual([[3, 4], false]);
		expect(await page('after', 4).then((p) => [seqs(p.rows), p.more])).toEqual([[5, 6, 7], false]);
		expect(await page('from', 4, 2).then((p) => [seqs(p.rows), p.more])).toEqual([[4, 5], true]);
		expect((await page('tail', undefined, 10)).rows[0]).toMatchObject({ conversation_id: id, seq: 3, message: 'm3' });
	});

	test('sin los tipos del servidor: la cola heredada y el último mensaje de una persona por conversación', async () => {
		const id = await conversation({ last_seq: 4, members: { [ana]: {} } });
		const quiet = await conversation({ last_seq: 1, members: { [ana]: {} } });
		await messages(id, 4);
		await messages(quiet, 1);
		await db.unsafe(`UPDATE ${st.qt('messages')} SET kind = 'system', sender_user_id = NULL WHERE conversation_id = $1 AND seq IN (2, 4)`, [id]);
		const tail = await st.chat_message_page({ conversation_id: id, visible_from: 0, viewer_id: ana, limit: 2, direction: 'tail', user_only: true });
		expect(seqs(tail.rows)).toEqual([1, 3]);
		const latest = await st.chat_latest_user_messages([id, quiet]);
		expect(latest.map((row) => [row.conversation_id, Number(row.seq), row.message]).sort()).toEqual(
			[
				[id, 3, 'm3'],
				[quiet, 1, 'm1'],
			].sort(),
		);
	});

	test('sync: lo ya cargado que cambió después de la marca', async () => {
		const id = await conversation({ last_seq: 3, members: { [ana]: {} } });
		await messages(id, 3);
		await db.unsafe(`UPDATE ${st.qt('messages')} SET updated_at = $2 WHERE conversation_id = $1 AND seq = 2`, [id, at(30)]);
		const changed = await st.chat_changed_messages({ conversation_id: id, visible_from: 0, viewer_id: ana, up_to_seq: 3, since: at(10), limit: 5 });
		expect([seqs(changed.rows), changed.more]).toEqual([[2], false]);
	});

	test('las reacciones de una página se resumen por emoji, con las propias y una muestra', async () => {
		const message_id = hex_id();
		for (const [user_id, value, minute] of [[ana, '👍', 1], [beto, '👍', 2], [carla, '🎉', 3], [carla, '👍', 4]] as const) {
			await db.unsafe(
				`INSERT INTO ${st.qt('chat-reactions')} (id, name, is_active, message_id, conversation_id, user_id, kind, value, payload, created_at, updated_at)
				 VALUES ($1, '', true, $2, 'c', $3, 'emoji', $4, '{}'::jsonb, $5, $5)`,
				[track('chat-reactions', hex_id()), message_id, user_id, value, at(minute)],
			);
		}
		const summary = await st.chat_reaction_summary([message_id], beto);
		expect(summary.get(message_id)).toEqual([
			{ emoji: '👍', count: 3, mine: true, sample_user_ids: [ana, beto, carla] },
			{ emoji: '🎉', count: 1, mine: false, sample_user_ids: [carla] },
		]);
	});

	test('la bandeja calcula no leídos y menciones en SQL, filtra y pagina por actividad', async () => {
		const quiet = await conversation({ last_seq: 2, last_message_at: at(5), members: { [beto]: { last_read_seq: 2 } } });
		const busy = await conversation({ last_seq: 9, last_message_at: at(20), members: { [beto]: { last_read_seq: 4, mentionSeqs: [3, 6, 8] } } });
		const archived = await conversation({ last_seq: 1, last_message_at: at(25), members: { [beto]: { archived: true } } });
		const pinned = await conversation({ last_seq: 1, last_message_at: at(1), members: { [beto]: { last_read_seq: 1, pinnedOrder: 1, markedUnread: true } } });
		const empty = await conversation({ kind: 'direct', key: `${beto}::${carla}`, created_at: at(15), members: { [beto]: {} } });
		await conversation({ last_seq: 5, last_message_at: at(30), members: { [beto]: { state: 'left' } } });
		const page = (query: Partial<Parameters<typeof st.chat_conversation_page>[0]> = {}) =>
			st.chat_conversation_page({ user_id: beto, limit: 10, ...query });
		const ids = (rows: Awaited<ReturnType<typeof page>>) => rows.map((row) => String(row.conversation._id));
		const all = await page({ filter: 'all' });
		expect(ids(all)).toEqual([busy, empty, quiet, pinned]);
		expect(all[0]).toMatchObject({ unread_count: 5, unread_mention_seqs: [6, 8], member: { last_read_seq: 4 } });
		expect(all.find((row) => row.conversation._id === quiet)?.unread_count).toBe(0);
		expect(ids(await page({ filter: 'unread' }))).toEqual([busy, pinned]);
		expect(ids(await page({ filter: 'mentions' }))).toEqual([busy]);
		expect(ids(await page({ filter: 'archived' }))).toEqual([archived]);
		expect(ids(await page({ filter: 'direct' }))).toEqual([empty]);
		expect(ids(await page({ filter: 'all', pinned: true }))).toEqual([pinned]);
		expect(ids(await page({ filter: 'all', pinned: false }))).toEqual([busy, empty, quiet]);
		expect(ids(await page()).length).toBe(5);
		const first = await page({ filter: 'all', limit: 2 });
		const last = first.at(-1)!;
		const next = await page({ filter: 'all', limit: 2, cursor: { at: last.activity_at, id: String(last.conversation._id) } });
		expect([...ids(first), ...ids(next)]).toEqual([busy, empty, quiet, pinned]);
		expect(await st.chat_inbox_counts(beto, at(40))).toEqual({
			all: 4,
			unread: 2,
			mentions: 1,
			direct: 1,
			groups: 3,
			archived: 1,
			unread_messages_total: 5,
			activity_unread: 0,
		});
	});

	test('con changed_since salen las bajas y se ignoran los filtros', async () => {
		const left = await conversation({ last_seq: 3, members: { [carla]: { state: 'left', updated_at: at(50) } } });
		const stale = await conversation({ last_seq: 3, members: { [carla]: { updated_at: at(1) } } });
		const rows = await st.chat_conversation_page({ user_id: carla, limit: 10, filter: 'unread', changed_since: at(40) });
		expect(rows.map((row) => [row.conversation._id, row.member.state])).toEqual([[left, 'left']]);
		expect(rows.some((row) => row.conversation._id === stale)).toBe(false);
	});

	test('un envío que confirma tarde no fecha la conversación hacia atrás: changed_since lo ve', async () => {
		const id = await conversation({ last_seq: 0, members: { [ana]: {}, [beto]: {} } });
		const insert = (now: string) => {
			const message_id = track('messages', hex_id());
			return st.chat_insert_message({
				id: message_id,
				conversation_id: id,
				sender_user_id: ana,
				client_id: crypto.randomUUID(),
				kind: 'text',
				name: '',
				search_field: 'hola',
				payload: { message: 'Hola', rev: 0 },
				preview: { messageId: message_id, senderId: ana, kind: 'text', textPreview: 'Hola', at: now },
				expires_at: null,
				share_read: true,
				attachment_ids: [],
				now,
			});
		};
		await insert(at(30));
		// La petición de este envío empezó antes (subía archivos) y confirma después.
		await insert(at(20));
		const [row] = await st.chat_conversation_page({ user_id: beto, limit: 1, conversation_ids: [id], changed_since: at(25) });
		expect(row?.conversation).toMatchObject({ _id: id, last_seq: 2 });
		expect(String(row!.conversation.last_message_at) >= at(30)).toBe(true);
	});

	test('marcar leído es monótono, se acota a last_seq, poda menciones y respeta los acuses', async () => {
		const id = await conversation({ last_seq: 6, members: { [ana]: { last_read_seq: 2, public_read_seq: 2, mentionSeqs: [3, 5], markedUnread: true } } });
		const mark = (seq: number, share_read = true) =>
			st.chat_mark_read({ conversation_id: id, user_id: ana, seq, share_read, now: at(59) });
		expect(await mark(4, false)).toEqual({ last_read_seq: 4, public_read_seq: 2, delivered_seq: 4, last_seq: 6, mention_seqs: [5] });
		expect(await mark(3)).toMatchObject({ last_read_seq: 4, public_read_seq: 4 });
		expect(await mark(99)).toEqual({ last_read_seq: 6, public_read_seq: 6, delivered_seq: 6, last_seq: 6, mention_seqs: [] });
		const [member] = (await db.unsafe(`SELECT payload FROM ${st.qt('chat-members')} WHERE conversation_id = $1`, [id])) as Array<{ payload: ImperiumDoc }>;
		expect(member?.payload).toMatchObject({ markedUnread: false, mentionSeqs: [] });
		expect(await st.chat_mark_read({ conversation_id: id, user_id: beto, seq: 1, share_read: true, now: at(59) })).toBeNull();
	});

	test('«no leído» se marca solo en miembros activos y enviar lo quita junto con las menciones', async () => {
		const id = await conversation({ last_seq: 2, members: { [ana]: { last_read_seq: 1, mentionSeqs: [2] }, [beto]: { state: 'left' } } });
		expect(await st.chat_mark_unread(id, ana, at(40))).toBe(true);
		expect(await st.chat_mark_unread(id, beto, at(40))).toBe(false);
		const payload = async () =>
			((await db.unsafe(`SELECT payload FROM ${st.qt('chat-members')} WHERE conversation_id = $1 AND user_id = $2`, [id, ana])) as Array<{ payload: ImperiumDoc }>)[0]?.payload;
		expect(await payload()).toMatchObject({ markedUnread: true, mentionSeqs: [2] });
		const message_id = track('messages', hex_id());
		await st.chat_insert_message({
			id: message_id,
			conversation_id: id,
			sender_user_id: ana,
			client_id: crypto.randomUUID(),
			kind: 'text',
			name: '',
			search_field: 'ya',
			payload: { message: 'Ya' },
			preview: { messageId: message_id },
			expires_at: null,
			share_read: true,
			attachment_ids: [],
			now: at(41),
		});
		expect(await payload()).toMatchObject({ markedUnread: false, mentionSeqs: [] });
	});

	test('chat_receipts_off encuentra a quien no comparte acuses', async () => {
		const [quiet, open] = [track('user-settings', hex_id()), track('user-settings', hex_id())];
		for (const [id, user_id, read_receipts] of [[quiet, carla, false], [open, beto, true]] as const) {
			await db.unsafe(
				`INSERT INTO ${st.qt('user-settings')} (id, name, is_active, payload, created_at, updated_at)
				 VALUES ($1, 'user-settings', true, $2::jsonb, $3, $3)`,
				[id, { user_id, chat_preferences: { privacy: { read_receipts } } }, at(0)],
			);
		}
		expect([...(await st.chat_receipts_off([ana, beto, carla]))]).toEqual([carla]);
	});

	test('listar entrega en lote y dice a quién avisar', async () => {
		const id = await conversation({ last_seq: 4, members: { [ana]: { delivered_seq: 4 }, [beto]: { delivered_seq: 1 }, [carla]: { delivered_seq: 4 } } });
		const moved = await st.chat_mark_inbox_delivered(beto, [id]);
		expect(moved.map((row) => ({ ...row, member_ids: row.member_ids.sort() }))).toEqual([
			{ conversation_id: id, seq: 4, member_ids: [ana, beto, carla] },
		]);
		expect(await st.chat_mark_inbox_delivered(beto, [id])).toEqual([]);
		expect((await st.chat_read_marks(id)).map((mark) => [mark.user_id, mark.delivered_seq])).toEqual([
			[ana, 4],
			[beto, 4],
			[carla, 4],
		]);
	});

	test('entregado por el socket: avanza hasta lo pedido, nunca pasa de last_seq ni retrocede', async () => {
		const id = await conversation({ last_seq: 6, members: { [ana]: {}, [beto]: { delivered_seq: 2 }, [carla]: { state: 'left' } } });
		expect(await st.chat_mark_delivered_up_to(id, beto, 4)).toBe(4);
		expect(await st.chat_mark_delivered_up_to(id, beto, 3)).toBeNull();
		expect(await st.chat_mark_delivered_up_to(id, beto, 1_000_000)).toBe(6);
		expect(await st.chat_mark_delivered_up_to(id, carla, 5)).toBeNull();
		expect((await st.chat_read_marks(id)).find((mark) => mark.user_id === beto)?.delivered_seq).toBe(6);
	});

	test('chat_privacy_many lee la privacidad y el estado guardado de varias personas en una consulta', async () => {
		const [dario, eva] = [hex_id(), hex_id()];
		for (const [user_id, chat_preferences] of [
			[dario, { privacy: { typing: false, last_seen: 'contacts' }, presence_status: 'dnd' }],
			[eva, {}],
		] as const) {
			await db.unsafe(
				`INSERT INTO ${st.qt('user-settings')} (id, name, is_active, payload, created_at, updated_at)
				 VALUES ($1, 'user-settings', true, $2::jsonb, $3, $3)`,
				[track('user-settings', hex_id()), { user_id, chat_preferences }, at(0)],
			);
		}
		expect(Object.fromEntries(await st.chat_privacy_many([dario, eva, hex_id()]))).toEqual({
			[dario]: { privacy: { typing: false, last_seen: 'contacts' }, presence_status: 'dnd' },
			[eva]: { privacy: {}, presence_status: '' },
		});
	});
});

describe.skipIf(!sql)('respaldo de los 1:1 legados', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto] = [hex_id(), hex_id()].sort() as [string, string];
	const direct_key = `${ana}::${beto}`;
	const self_key = ana;
	const keys = [direct_key, self_key];
	const at = (second: number) => `2026-03-01T10:00:0${second}.000Z`;
	const mine: string[] = [];
	const [m1, s1, off, internal, unkeyed, m4] = Array.from({ length: 6 }, hex_id);
	// m2 y m3 empatan en created_at: el orden lo decide el id.
	const [m2, m3] = [hex_id(), hex_id()].sort() as [string, string];

	test('cada lote toma sus llaves del índice de lo pendiente, sin recorrer messages', async () => {
		const { pending_keys } = chat_backfill_sqls({
			messages: st.qt('messages'),
			conversations: st.qt('chat-conversations'),
			members: st.qt('chat-members'),
		});
		const plan = (await db.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off');
			return tx.unsafe(`EXPLAIN ${pending_keys}`, [500]);
		})) as Array<{ 'QUERY PLAN': string }>;
		expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('ix_messages_backfill_pending');
	});

	async function legacy(id: string, payload: Record<string, unknown>, created_at: string, is_active = true) {
		mine.push(track('messages', id));
		await db.unsafe(
			`INSERT INTO ${st.qt('messages')} (id, name, is_active, payload, created_at, updated_at)
			 VALUES ($1, '', $2, $3::jsonb, $4, $4)`,
			[id, is_active, payload, created_at],
		);
	}

	const chat = (key: string, sender: string, message: string, read: string[], extra: Record<string, unknown> = {}) => ({
		sourceType: 'chat',
		conversationKey: key,
		senderUserId: sender,
		senderName: sender === ana ? 'Ana' : 'Beto',
		message,
		readByUserIds: read,
		participantUserIds: key.split('::'),
		...extra,
	});

	async function state() {
		const conversations = (await db.unsafe(
			`SELECT id, kind, conversation_key, last_seq, last_message_at, created_at, payload FROM ${st.qt('chat-conversations')}
			 WHERE conversation_key IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY conversation_key`,
			[keys],
		)) as ImperiumDoc[];
		const members = (await db.unsafe(
			`SELECT id, conversation_id, user_id, role, state, last_read_seq, public_read_seq, delivered_seq, payload
			 FROM ${st.qt('chat-members')}
			 WHERE conversation_id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY conversation_id, user_id`,
			[conversations.map((row) => row.id)],
		)) as ImperiumDoc[];
		const messages = (await db.unsafe(
			`SELECT id, conversation_id, seq, sender_user_id, kind, search_field, payload FROM ${st.qt('messages')}
			 WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[mine],
		)) as ImperiumDoc[];
		const by_id = Object.fromEntries(messages.map((row) => [String(row.id), row]));
		const direct = conversations.find((row) => row.conversation_key === direct_key);
		const self = conversations.find((row) => row.conversation_key === self_key);
		const read = (conversation: ImperiumDoc | undefined, user: string) =>
			members.find((row) => row.conversation_id === conversation?.id && row.user_id === user);
		return { conversations, members, by_id, direct, self, read };
	}

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
		await legacy(m1, chat(direct_key, ana, 'Acción rápida', [ana, beto]), at(1));
		await legacy(m2, chat(direct_key, beto, 'Ñandú visto', [beto, ana]), at(2));
		await legacy(
			m3,
			chat(direct_key, ana, '', [ana], {
				attachments: [{ attachmentId: 'adjunto', name: 'Plano Técnico.pdf', mimetype: 'application/pdf', isImage: false }],
			}),
			at(2),
		);
		await legacy(s1, chat(self_key, ana, 'Nota para mí', [ana]), at(1));
		await legacy(off, chat(direct_key, ana, 'envío fallido', [ana]), at(4), false);
		await legacy(internal, { sourceType: 'internal', conversationKey: direct_key, message: 'aviso', senderUserId: ana }, at(5));
		await legacy(unkeyed, { sourceType: 'chat', message: 'sin llave', participantUserIds: [ana, beto] }, at(6));
	}, 120_000);

	afterAll(async () => {
		const { conversations, members } = await state();
		for (const row of conversations) track('chat-conversations', String(row.id));
		for (const row of members) track('chat-members', String(row.id));
	});

	test('crea el directo y el self con sus miembros y numera los mensajes por (created_at, id)', async () => {
		const done = await st.chat_backfill_direct(1);
		expect(done.conversations).toBeGreaterThanOrEqual(2);
		expect(done.members).toBeGreaterThanOrEqual(3);
		expect(done.messages).toBeGreaterThanOrEqual(4);
		const { direct, self, read, by_id, members } = await state();
		expect(direct).toMatchObject({ kind: 'direct', last_seq: 3, last_message_at: at(2), created_at: at(1) });
		expect(self).toMatchObject({ kind: 'self', last_seq: 1, last_message_at: at(1) });
		expect(direct?.payload).toEqual({
			createdById: ana,
			memberCount: 2,
			participantUserIds: [ana, beto],
			settings: {
				announcementOnly: false,
				slowModeSeconds: 0,
				membersCanInvite: false,
				membersCanPin: true,
				membersCanEditInfo: false,
				membersCanCall: true,
				membersCanMentionAll: false,
				ephemeralSeconds: 0,
				historyVisibleToNewMembers: true,
			},
			pins: [],
			invites: [],
			lastMessage: {
				messageId: m3,
				seq: 3,
				senderId: ana,
				senderName: 'Ana',
				kind: 'media',
				textPreview: '',
				at: at(2),
				attachmentKind: 'file',
			},
		});
		expect(members).toHaveLength(3);
		expect(read(direct, ana)).toMatchObject({
			role: 'member',
			state: 'active',
			last_read_seq: 3,
			public_read_seq: 3,
			delivered_seq: 3,
		});
		expect(read(direct, beto)).toMatchObject({ last_read_seq: 2, public_read_seq: 2, delivered_seq: 2 });
		expect(read(self, ana)).toMatchObject({ last_read_seq: 1 });
		expect(read(direct, beto)?.payload).toEqual({
			joinedAt: at(1),
			visibleFromSeq: 0,
			mentionSeqs: [],
			markedUnread: false,
			archived: false,
			notifyLevel: 'default',
		});
		const row = (id: string) => {
			const { conversation_id, seq, sender_user_id, kind, search_field } = by_id[id] ?? {};
			return { conversation_id, seq, sender_user_id, kind, search_field };
		};
		expect([m1, m2, m3].map(row)).toEqual([
			{ conversation_id: direct?.id, seq: 1, sender_user_id: ana, kind: 'text', search_field: 'accion rapida' },
			{ conversation_id: direct?.id, seq: 2, sender_user_id: beto, kind: 'text', search_field: 'nandu visto' },
			{ conversation_id: direct?.id, seq: 3, sender_user_id: ana, kind: 'media', search_field: 'plano tecnico.pdf' },
		]);
		expect(row(s1)).toMatchObject({ conversation_id: self?.id, seq: 1, search_field: 'nota para mi' });
		expect(by_id[m2]?.payload).toEqual({
			...chat(direct_key, beto, 'Ñandú visto', [beto, ana]),
			conversationId: direct?.id,
		});
	});

	test('la lectura legada (store.update de readByUserIds) conserva la secuencia del mensaje', async () => {
		await st.update('messages', m3, { readByUserIds: [ana, beto] });
		const { direct, by_id } = await state();
		expect(by_id[m3]).toMatchObject({ conversation_id: direct?.id, seq: 3, sender_user_id: ana, kind: 'media' });
		expect(by_id[m3]?.payload).toMatchObject({ readByUserIds: [ana, beto], conversationId: direct?.id });
	});

	test('deja fuera los inactivos, lo que no es chat y lo que no trae llave', async () => {
		const { by_id } = await state();
		for (const id of [off, internal, unkeyed]) {
			expect({ id, conversation_id: by_id[id]?.conversation_id, seq: by_id[id]?.seq }).toEqual({
				id,
				conversation_id: null,
				seq: null,
			});
		}
	});

	test('una segunda corrida no encuentra nada y deja los mismos conteos', async () => {
		const before = await state();
		expect(await st.chat_backfill_direct()).toEqual({ conversations: 0, members: 0, messages: 0 });
		const after = await state();
		expect(after.conversations).toEqual(before.conversations);
		expect(after.members).toEqual(before.members);
		expect(after.by_id).toEqual(before.by_id);
	});

	test('un mensaje legado nuevo continúa la secuencia y mueve las marcas', async () => {
		await legacy(m4, chat(direct_key, beto, 'Otra vez', [beto]), at(7));
		expect(await st.chat_backfill_direct()).toEqual({ conversations: 0, members: 0, messages: 1 });
		const { direct, read, by_id } = await state();
		expect(by_id[m4]).toMatchObject({ conversation_id: direct?.id, seq: 4 });
		expect(direct).toMatchObject({ last_seq: 4, last_message_at: at(7) });
		expect(direct?.payload).toMatchObject({
			lastMessage: { messageId: m4, seq: 4, kind: 'text', textPreview: 'Otra vez' },
		});
		expect(read(direct, beto)).toMatchObject({ last_read_seq: 4 });
		expect(read(direct, ana)).toMatchObject({ last_read_seq: 3 });
	});
});

describe.skipIf(!sql)('respaldo de un 1:1 que recibe un envío nuevo antes del arranque', () => {
	const db = sql!;
	const st = store!;
	const at = (day: number) => `2026-01-0${day}T10:00:00.000Z`;

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	async function legacy(key: string, sender: string, message: string, read: string[], created_at: string): Promise<string> {
		const id = track('messages', hex_id());
		const payload = {
			sourceType: 'chat',
			conversationKey: key,
			senderUserId: sender,
			senderName: 'Legado',
			message,
			readByUserIds: read,
			participantUserIds: key.split('::'),
		};
		await db.unsafe(
			`INSERT INTO ${st.qt('messages')} (id, name, is_active, payload, created_at, updated_at)
			 VALUES ($1, '', true, $2::jsonb, $3, $3)`,
			[id, payload, created_at],
		);
		return id;
	}

	async function open(user_ids: string[]): Promise<string> {
		const conversation = await st.chat_open_direct({
			conversation_key: user_ids.join('::'),
			user_ids,
			created_by: user_ids[0]!,
			now: new Date().toISOString(),
		});
		const id = track('chat-conversations', String(conversation._id));
		const members = (await db.unsafe(`SELECT id FROM ${st.qt('chat-members')} WHERE conversation_id = $1`, [id])) as Array<{
			id: string;
		}>;
		for (const row of members) track('chat-members', row.id);
		return id;
	}

	async function live(conversation_id: string, sender: string, text: string): Promise<ImperiumDoc> {
		const id = track('messages', hex_id());
		const now = new Date().toISOString();
		const sent = await st.chat_insert_message({
			id,
			conversation_id,
			sender_user_id: sender,
			client_id: crypto.randomUUID(),
			kind: 'text',
			name: '',
			search_field: text,
			payload: { message: text, senderUserId: sender, sourceType: 'chat', conversationId: conversation_id, rev: 0 },
			preview: { messageId: id, senderId: sender, senderName: 'Vivo', kind: 'text', textPreview: text, at: now },
			expires_at: null,
			share_read: true,
			attachment_ids: [],
			now,
		});
		return sent!.message;
	}

	async function seqs(ids: string[]): Promise<number[]> {
		const rows = (await db.unsafe(
			`SELECT id, seq FROM ${st.qt('messages')} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[ids],
		)) as Array<{ id: string; seq: number | null }>;
		return ids.map((id) => Number(rows.find((row) => row.id === id)?.seq));
	}

	async function marks(conversation_id: string): Promise<Record<string, number>> {
		const rows = await st.chat_read_marks(conversation_id);
		return Object.fromEntries(rows.map((row) => [row.user_id, row.last_read_seq]));
	}

	test('lo legado toma los primeros seq; el envío queda como último mensaje y sin leer para quien lo recibe', async () => {
		const [ana, beto] = [hex_id(), hex_id()].sort() as [string, string];
		const key = `${ana}::${beto}`;
		const old = [
			await legacy(key, ana, 'viejo 1', [ana, beto], at(1)),
			await legacy(key, ana, 'viejo 2', [ana, beto], at(2)),
		];
		const conversation_id = await open([ana, beto]);
		const sent = await live(conversation_id, ana, 'nuevo en vivo');
		await st.chat_backfill_direct();
		expect(await seqs([...old, String(sent._id)])).toEqual([1, 2, 3]);
		const conversation = await st.find_id('chat-conversations', conversation_id);
		expect(conversation).toMatchObject({ last_seq: 3, lastMessage: { messageId: sent._id, seq: 3 } });
		expect(String(conversation!.last_message_at) >= String(sent.created_at)).toBe(true);
		expect(await marks(conversation_id)).toEqual({ [ana]: 3, [beto]: 2 });
	});

	test('una fila legada que aparece después no marca leído lo nuevo que quedó antes', async () => {
		const [carla, dora] = [hex_id(), hex_id()].sort() as [string, string];
		const key = `${carla}::${dora}`;
		const conversation_id = await open([carla, dora]);
		const sent = await live(conversation_id, carla, 'nuevo sin leer');
		const late = await legacy(key, carla, 'legado tardío', [carla, dora], new Date(Date.now() + 1000).toISOString());
		await st.chat_backfill_direct();
		expect(await seqs([String(sent._id), late])).toEqual([1, 2]);
		expect(await marks(conversation_id)).toEqual({ [carla]: 2, [dora]: 0 });
	});
});

describe.skipIf(!sql)('rutas del chat sobre Postgres', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto] = [
		{ _id: hex_id(), name: 'Ana Ruta' },
		{ _id: hex_id(), name: 'Beto Ruta' },
	];

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
		for (const user of [ana, beto]) {
			track('user', user._id);
			await db.unsafe(
				`INSERT INTO ${st.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
				 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
				[user._id, user.name, `${user._id}@empresa.com`, new Date().toISOString()],
			);
		}
	}, 120_000);

	afterAll(async () => {
		const key = [ana._id, beto._id].sort().join('::');
		const conversations = (await db.unsafe(
			`SELECT id FROM ${st.qt('chat-conversations')} WHERE conversation_key = $1`,
			[key],
		)) as Array<{ id: string }>;
		for (const { id } of conversations) {
			track('chat-conversations', id);
			for (const resource of ['messages', 'chat-members'] as const) {
				const rows = (await db.unsafe(`SELECT id FROM ${st.qt(resource)} WHERE conversation_id = $1`, [id])) as Array<{ id: string }>;
				for (const row of rows) track(resource, row.id);
			}
		}
	});

	async function call(actor: ImperiumDoc, resource: string, action: string, path: string, init: { params?: Record<string, string>; json?: unknown } = {}) {
		const url = new URL(`http://core/api/${resource}${path}`);
		const req = new Request(url, {
			method: init.json === undefined ? 'GET' : 'POST',
			headers: init.json === undefined ? undefined : { 'content-type': 'application/json' },
			body: init.json === undefined ? undefined : JSON.stringify(init.json),
		});
		const res = await handle_action(st, db, req, url, resource, action, init.params ?? {}, actor);
		return (await res.json()) as { data: ImperiumDoc[] } & Record<string, unknown>;
	}

	test('el hilo heredado devuelve los más recientes en orden ascendente', async () => {
		for (const text of ['uno', 'dos', 'tres']) {
			await call(ana, 'messages', 'create_chat_message', '/chat', { json: { recipient_user_id: beto._id, message: text } });
		}
		const thread = await call(beto, 'messages', 'read_conversation', `/conversation/${ana._id}?size=2`, {
			params: { participantId: ana._id },
		});
		expect(thread.data.map((row) => row.message)).toEqual(['dos', 'tres']);
		const conversation = await st.find_where('chat-conversations', { conversation_key: [ana._id, beto._id].sort().join('::') });
		const marks = await st.chat_read_marks(String(conversation?._id));
		expect(marks.find((mark) => mark.user_id === beto._id)?.last_read_seq).toBe(3);
	});

	test('historial, bandeja y lista heredada leen las marcas de agua en SQL', async () => {
		await call(ana, 'messages', 'create_chat_message', '/chat', { json: { recipient_user_id: beto._id, message: 'cuatro' } });
		const key = [ana._id, beto._id].sort().join('::');
		const id = String((await st.find_where('chat-conversations', { conversation_key: key }))?._id);
		const history = await call(beto, 'messages', 'read_message_page', `/history/${id}?limit=2`, {
			params: { conversationId: id },
		});
		expect(history.data.map((row) => row.seq)).toEqual([3, 4]);
		expect(history).toMatchObject({ has_more_before: true, has_more_after: false, read_state: { my_last_read_seq: 3 } });
		const inbox = await call(beto, 'chat-conversations', 'list_my_conversations', '/mine');
		expect(inbox.data).toEqual([
			expect.objectContaining({ _id: id, title: 'Ana Ruta', unread_count: 1, last_message: expect.objectContaining({ seq: 4 }) }),
		]);
		expect(inbox.counts).toMatchObject({ all: 1, unread: 1, direct: 1, unread_messages_total: 1 });
		const legacy = await call(beto, 'messages', 'read_my_conversations', '/conversations');
		expect(legacy.data).toEqual([
			expect.objectContaining({
				conversation_key: key,
				other_participant: { _id: ana._id, name: 'Ana Ruta' },
				unread_count: 1,
				latest_message: expect.objectContaining({ message: 'cuatro', seq: 4 }),
			}),
		]);
	});

	test('leer el historial no cambia last_read_seq; POST read sí', async () => {
		const id = String((await st.find_where('chat-conversations', { conversation_key: [ana._id, beto._id].sort().join('::') }))?._id);
		const mark = async () => (await st.chat_read_marks(id)).find((row) => row.user_id === beto._id)?.last_read_seq;
		expect(await mark()).toBe(3);
		await call(beto, 'messages', 'read_message_page', `/history/${id}`, { params: { conversationId: id } });
		await call(beto, 'messages', 'read_message_sync', `/sync/${id}?after_seq=0`, { params: { conversationId: id } });
		await call(beto, 'chat-conversations', 'read_conversation_detail', `/${id}/detail`, { params: { id } });
		expect(await mark()).toBe(3);
		const read = await call(beto, 'chat-conversations', 'mark_conversation_read', `/${id}/read`, {
			params: { id },
			json: { seq: 4 },
		});
		expect(read.data).toEqual([{ last_read_seq: 4, public_read_seq: 4, unread_count: 0, unread_mentions: 0 }]);
		expect(await mark()).toBe(4);
	});
});

describe.skipIf(!sql)('editar, borrar y ocultar mensajes', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto] = [hex_id(), hex_id()].sort() as [string, string];
	const now = () => new Date().toISOString();

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	/** Un grupo nuevo por prueba: cada una ve solo sus mensajes. */
	async function open_group(): Promise<string> {
		const id = track('chat-conversations', hex_id());
		await db.unsafe(
			`INSERT INTO ${st.qt('chat-conversations')} (id, name, is_active, kind, conversation_key, last_seq, payload, created_at, updated_at)
			 VALUES ($1, 'Grupo', true, 'group', $2, 0, '{"memberCount": 2}'::jsonb, $3, $3)`,
			[id, `conv:${id}`, now()],
		);
		for (const user_id of [ana, beto]) {
			await db.unsafe(
				`INSERT INTO ${st.qt('chat-members')} (id, name, is_active, state, conversation_id, user_id, role, last_read_seq, public_read_seq, delivered_seq, payload, created_at, updated_at)
				 VALUES ($1, '', true, 'active', $2, $3, 'member', 0, 0, 0, '{}'::jsonb, $4, $4)`,
				[track('chat-members', hex_id()), id, user_id, now()],
			);
		}
		return id;
	}

	async function send(conversation_id: string, payload: Record<string, unknown> = {}, sender = ana) {
		const id = track('messages', hex_id());
		const sent = await st.chat_insert_message({
			id,
			conversation_id,
			sender_user_id: sender,
			client_id: crypto.randomUUID(),
			kind: 'text',
			name: '',
			search_field: 'hola',
			payload: { message: 'Hola', senderName: 'Ana', conversationId: conversation_id, rev: 0, ...payload },
			preview: { messageId: id, senderId: sender, senderName: 'Ana', kind: 'text', textPreview: 'Hola', at: now() },
			expires_at: null,
			share_read: true,
			attachment_ids: [],
			now: now(),
		});
		return sent!.message;
	}

	async function row(id: string) {
		const [found] = (await db.unsafe(`SELECT search_field, updated_at, payload FROM ${st.qt('messages')} WHERE id = $1`, [id])) as ImperiumDoc[];
		return found!;
	}

	async function last_message(conversation_id: string) {
		const [found] = (await db.unsafe(`SELECT payload -> 'lastMessage' AS last FROM ${st.qt('chat-conversations')} WHERE id = $1`, [conversation_id])) as Array<{ last: ImperiumDoc }>;
		return found?.last;
	}

	async function audit(audit_id: string) {
		track('chat-audit', audit_id);
		const [found] = (await db.unsafe(
			`SELECT conversation_id, message_id, actor_id, action, created_by, payload FROM ${st.qt('chat-audit')} WHERE id = $1`,
			[audit_id],
		)) as ImperiumDoc[];
		return found;
	}

	test('editar cambia el texto, sube rev y editCount, audita el antes y renueva la vista previa', async () => {
		const conversation_id = await open_group();
		const message = await send(conversation_id);
		const edit = (text: string, audit_id = hex_id()) =>
			st.chat_edit_message({
				id: String(message._id),
				text,
				search_field: text.toLowerCase(),
				merge: { mentions: { userIds: [], all: false, here: false } },
				audit_id,
				actor_id: ana,
				preview: text,
				now: now(),
			});
		const first_audit = hex_id();
		const first = await edit('Hola, corregido', first_audit);
		expect(first?.message).toMatchObject({ message: 'Hola, corregido', editCount: 1, rev: 1, search_field: 'hola, corregido' });
		expect(first?.message.editedAt).toBe(first?.message.updated_at);
		expect(first?.last_message).toMatchObject({ messageId: message._id, textPreview: 'Hola, corregido' });
		expect(await last_message(conversation_id)).toMatchObject({ textPreview: 'Hola, corregido' });
		expect(await audit(first_audit)).toMatchObject({
			conversation_id,
			message_id: message._id,
			actor_id: ana,
			created_by: ana,
			action: 'edit',
			payload: { before: { text: 'Hola' }, after: { text: 'Hola, corregido' } },
		});
		const second = await edit('Otra vez');
		expect(second?.message).toMatchObject({ editCount: 2, rev: 2 });
		await send(conversation_id);
		const older = await edit('Ya no es el último');
		expect(older?.last_message).toBeNull();
		expect(await last_message(conversation_id)).toMatchObject({ textPreview: 'Hola' });
	});

	test('borrar deja lápida, audita el contenido, limpia las citas y la vista previa; no se borra dos veces', async () => {
		const conversation_id = await open_group();
		const original = await send(conversation_id, {
			message: 'Secreto',
			attachments: [{ attachmentId: 'adjunto', name: 'plano' }],
			mentions: { userIds: [beto], all: false, here: false },
		});
		const reply = await send(
			conversation_id,
			{
				message: 'Respuesta',
				replyToMessageId: original._id,
				replyPreview: { messageId: original._id, senderName: 'Ana', textPreview: 'Secreto', kind: 'media', attachmentKind: 'file' },
			},
			beto,
		);
		const latest = await send(conversation_id, { message: 'Último' });
		await db.unsafe(`UPDATE ${st.qt('chat-members')} SET payload = payload || jsonb_build_object('mentionSeqs', $3::jsonb) WHERE conversation_id = $1 AND user_id = $2`, [
			conversation_id,
			beto,
			[Number(original.seq), Number(latest.seq)],
		]);
		const pending = async () =>
			(
				(await db.unsafe(`SELECT payload -> 'mentionSeqs' AS seqs FROM ${st.qt('chat-members')} WHERE conversation_id = $1 AND user_id = $2`, [
					conversation_id,
					beto,
				])) as Array<{ seqs: number[] }>
			)[0]!.seqs;
		expect(await pending()).toEqual([Number(original.seq), Number(latest.seq)]);
		const remove = (id: string, audit_id = hex_id()) =>
			st.chat_delete_message({
				id,
				deleted: { at: now(), byUserId: beto, byRole: 'moderator' },
				audit_id,
				actor_id: beto,
				action: 'delete_moderator',
				target_user_id: ana,
				now: now(),
			});
		const audit_id = hex_id();
		const removed = await remove(String(original._id), audit_id);
		expect(await pending()).toEqual([Number(latest.seq)]);
		await st.chat_drop_mention_seq(conversation_id, Number(latest.seq), [beto]);
		expect(await pending()).toEqual([Number(latest.seq)]);
		await st.chat_drop_mention_seq(conversation_id, Number(latest.seq), []);
		expect(await pending()).toEqual([]);
		expect(removed?.message).toMatchObject({ message: '', rev: 1, deleted: { byUserId: beto, byRole: 'moderator' } });
		expect(removed?.message.attachments).toBeUndefined();
		expect(removed?.message.mentions).toBeUndefined();
		expect((await row(String(original._id))).search_field).toBeNull();
		expect(removed?.last_message).toBeNull();
		expect(removed?.quoting).toEqual([
			{
				id: String(reply._id),
				seq: Number(reply.seq),
				rev: 1,
				reply_preview: { messageId: original._id, senderName: 'Ana', textPreview: null, kind: 'media', deleted: true },
				updated_at: String(removed?.message.updated_at),
			},
		]);
		expect((await row(String(reply._id))).payload).toMatchObject({ message: 'Respuesta', rev: 1, replyPreview: { deleted: true, textPreview: null } });
		expect(await audit(audit_id)).toMatchObject({
			action: 'delete_moderator',
			actor_id: beto,
			payload: {
				before: { kind: 'text', text: 'Secreto', attachments: [{ attachmentId: 'adjunto' }], mentions: { userIds: [beto] } },
				targetUserId: ana,
			},
		});
		expect(await remove(String(original._id))).toBeNull();
		const last = await remove(String(latest._id));
		expect(last?.last_message).toMatchObject({ messageId: latest._id, textPreview: '', deleted: true });
		expect(await last_message(conversation_id)).toMatchObject({ messageId: latest._id, deleted: true, textPreview: '' });
		expect(
			await st.chat_edit_message({ id: String(latest._id), text: 'x', search_field: 'x', merge: {}, audit_id: hex_id(), actor_id: ana, preview: 'x', now: now() }),
		).toBeNull();
	});

	test('las citas de un mensaje se buscan por el índice parcial de replyToMessageId', async () => {
		const plan = await db.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off');
			return (await tx.unsafe(
				`EXPLAIN SELECT id FROM ${st.qt('messages')} WHERE payload ->> 'replyToMessageId' = '${hex_id()}'`,
			)) as Array<Record<string, string>>;
		});
		expect(plan.map((line) => Object.values(line)[0]).join('\n')).toContain('ix_messages_reply_to');
	});

	test('ocultar para mí: el lector deja de verlo, los demás no, y no cambia rev ni updated_at', async () => {
		const conversation_id = await open_group();
		const message = await send(conversation_id);
		const before = await row(String(message._id));
		expect(await st.chat_hide_message(String(message._id), beto)).toBe(true);
		expect(await st.chat_hide_message(String(message._id), beto)).toBe(false);
		const after = await row(String(message._id));
		expect(after.updated_at).toBe(before.updated_at);
		expect(after.payload).toMatchObject({ rev: 0, hiddenForUserIds: [beto] });
		const page = (viewer_id: string) =>
			st.chat_message_page({ conversation_id, visible_from: 0, viewer_id, limit: 10, direction: 'tail' });
		expect((await page(beto)).rows).toEqual([]);
		expect((await page(ana)).rows.map((doc) => doc._id)).toEqual([message._id]);
		const since = '2000-01-01T00:00:00.000Z';
		const changed = (viewer_id: string) =>
			st.chat_changed_messages({ conversation_id, visible_from: 0, viewer_id, up_to_seq: 10, since, limit: 10 });
		expect((await changed(beto)).rows).toEqual([]);
		expect((await changed(ana)).rows).toHaveLength(1);
	});

	test('ver una vez: cada persona lo abre una sola vez, aunque lo pida en paralelo, y sube rev', async () => {
		const conversation_id = await open_group();
		const once = await send(conversation_id, { viewOnce: { openedByUserIds: [] } });
		const plain = await send(conversation_id);
		const id = String(once._id);
		const opens = await Promise.all([1, 2, 3].map(() => st.chat_open_view_once(id, beto, now())));
		expect(opens.filter(Boolean)).toHaveLength(1);
		expect((await row(id)).payload).toMatchObject({ rev: 1, viewOnce: { openedByUserIds: [beto] } });
		expect(await st.chat_open_view_once(id, ana, now())).toMatchObject({ viewOnce: { openedByUserIds: [beto, ana] }, rev: 2 });
		expect(await st.chat_open_view_once(String(plain._id), beto, now())).toBeNull();
	});

	test('leído y entregado salen de las marcas de agua, sin contar al remitente', async () => {
		const conversation_id = await open_group();
		const message = await send(conversation_id);
		const seq = Number(message.seq);
		expect(await st.chat_message_receipts(conversation_id, seq, ana)).toEqual({
			member_count: 1,
			read_count: 0,
			delivered_count: 0,
			read_ids: [],
			delivered_ids: [],
		});
		await st.chat_mark_delivered(conversation_id, [beto], seq);
		expect(await st.chat_message_receipts(conversation_id, seq, ana)).toMatchObject({ delivered_count: 1, delivered_ids: [beto] });
		await st.chat_mark_read({ conversation_id, user_id: beto, seq, share_read: true, now: now() });
		expect(await st.chat_message_receipts(conversation_id, seq, ana)).toMatchObject({ read_count: 1, read_ids: [beto] });
		expect(await st.chat_message_receipts(conversation_id, seq, null)).toMatchObject({ member_count: 2, read_count: 2 });
	});
});

describe.skipIf(!sql)('reacciones y encuestas sin duplicados', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto, carla] = [hex_id(), hex_id(), hex_id()].sort() as [string, string, string];
	const now = () => new Date().toISOString();
	const mine: string[] = [];

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	afterAll(async () => {
		const rows = (await db.unsafe(
			`SELECT id FROM ${st.qt('chat-reactions')} WHERE message_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[mine],
		)) as Array<{ id: string }>;
		for (const row of rows) track('chat-reactions', row.id);
	});

	async function message(payload: Record<string, unknown> = {}): Promise<string> {
		const id = track('messages', hex_id());
		mine.push(id);
		await db.unsafe(
			`INSERT INTO ${st.qt('messages')} (id, name, is_active, conversation_id, seq, sender_user_id, kind, payload, created_at, updated_at)
			 VALUES ($1, '', true, $2, 1, $3, 'poll', $4::jsonb, $5, $5)`,
			[id, hex_id(), ana, { message: '', rev: 0, ...payload }, now()],
		);
		return id;
	}

	const poll = { poll: { question: '¿Cuándo?', options: [{ id: 'o1', text: 'Hoy' }, { id: 'o2', text: 'Mañana' }], multiple: true } };

	async function chosen(message_id: string, user_id: string, kind: 'emoji' | 'vote') {
		const rows = (await db.unsafe(
			`SELECT value FROM ${st.qt('chat-reactions')} WHERE message_id = $1 AND user_id = $2 AND kind = $3 ORDER BY value`,
			[message_id, user_id, kind],
		)) as Array<{ value: string }>;
		return rows.map((row) => row.value);
	}

	async function rev(message_id: string): Promise<number> {
		const [row] = (await db.unsafe(`SELECT payload ->> 'rev' AS rev FROM ${st.qt('messages')} WHERE id = $1`, [message_id])) as Array<{ rev: string }>;
		return Number(row?.rev);
	}

	test('reaccionar conmuta, respeta el único y el tope por persona, y sube rev solo si cambia', async () => {
		const id = await message();
		const react = (user_id: string, emoji: string, on?: boolean, limit = 20) =>
			st.chat_toggle_reaction({ message_id: id, user_id, emoji, on, limit, now: now() });
		expect(await react(ana, '👍')).toMatchObject({ limited: false, changed: true, mine: true, count: 1, rev: 1 });
		expect(await react(beto, '👍', true)).toMatchObject({ changed: true, mine: true, count: 2, rev: 2 });
		expect(await react(beto, '👍', true)).toMatchObject({ changed: false, mine: true, count: 2, rev: 2 });
		expect(await react(ana, '👍')).toMatchObject({ changed: true, mine: false, count: 1, rev: 3 });
		expect(await react(ana, '🎉', false)).toMatchObject({ changed: false, mine: false, count: 0, rev: 3 });
		expect(await rev(id)).toBe(3);
		let rejected = false;
		try {
			await db.unsafe(
				`INSERT INTO ${st.qt('chat-reactions')} (id, name, is_active, message_id, conversation_id, user_id, kind, value, payload, created_at, updated_at)
				 VALUES ($1, '', true, $2, 'c', $3, 'emoji', '👍', '{}'::jsonb, $4, $4)`,
				[track('chat-reactions', hex_id()), id, beto, now()],
			);
		} catch (err) {
			rejected = is_unique_violation(err);
		}
		expect(rejected).toBe(true);
		for (const emoji of ['😀', '😁']) await react(carla, emoji, true, 2);
		expect(await react(carla, '😂', true, 2)).toEqual({ limited: true });
		expect(await chosen(id, carla, 'emoji')).toEqual(['😀', '😁']);
		expect((await st.chat_reaction_summary([id], beto)).get(id)).toEqual([
			{ emoji: '👍', count: 1, mine: true, sample_user_ids: [beto] },
			{ emoji: '😀', count: 1, mine: false, sample_user_ids: [carla] },
			{ emoji: '😁', count: 1, mine: false, sample_user_ids: [carla] },
		]);
		await db.unsafe(`UPDATE ${st.qt('messages')} SET payload = payload || '{"deleted": {}}'::jsonb WHERE id = $1`, [id]);
		expect(await react(ana, '👍')).toBeNull();
	});

	test('votar reemplaza el anterior: la misma opción dos veces deja una fila, [] retira y en paralelo queda uno', async () => {
		const id = await message(poll);
		const vote = (user_id: string, option_ids: string[], final = false) =>
			st.chat_replace_votes({ message_id: id, user_id, option_ids, final, now: now() });
		expect(await vote(ana, ['o1'])).toMatchObject({ already_voted: false, changed: true, rev: 1 });
		expect(await vote(ana, ['o1'])).toMatchObject({ changed: false, rev: 1 });
		expect(await chosen(id, ana, 'vote')).toEqual(['o1']);
		await vote(ana, ['o2']);
		expect(await chosen(id, ana, 'vote')).toEqual(['o2']);
		await vote(ana, ['o1', 'o2']);
		expect(await chosen(id, ana, 'vote')).toEqual(['o1', 'o2']);
		expect(await vote(ana, [])).toMatchObject({ changed: true });
		expect(await chosen(id, ana, 'vote')).toEqual([]);
		await Promise.all(Array.from({ length: 8 }, (_, i) => vote(beto, [i % 2 ? 'o1' : 'o2'])));
		expect(await chosen(id, beto, 'vote')).toHaveLength(1);
		expect(await chosen(id, beto, 'emoji')).toEqual([]);
	});

	test('un cuestionario no cambia de respuesta; cerrar fija closedAt una vez y ya no admite votos', async () => {
		const id = await message({ poll: { ...poll.poll, multiple: false, quiz: { correctOptionId: 'o2' } } });
		const vote = (option_ids: string[]) =>
			st.chat_replace_votes({ message_id: id, user_id: ana, option_ids, final: true, now: now() });
		expect(await vote(['o1'])).toMatchObject({ already_voted: false, changed: true });
		expect(await vote(['o1'])).toMatchObject({ already_voted: false, changed: false });
		expect(await vote(['o2'])).toEqual({ already_voted: true });
		const at = now();
		const closed = await st.chat_close_poll(id, at);
		expect(closed).toMatchObject({ _id: id, rev: 2, updated_at: at, poll: { closedAt: at, question: '¿Cuándo?' } });
		expect(await st.chat_close_poll(id, now())).toBeNull();
		expect(await st.chat_replace_votes({ message_id: id, user_id: beto, option_ids: ['o1'], final: true, now: now() })).toBeNull();
		expect(await st.chat_close_poll(await message(), now())).toBeNull();
	});

	test('el conteo de una página: votos por opción, propios, votantes en orden y personas distintas', async () => {
		const [first, second, empty] = [await message(poll), await message(poll), await message(poll)];
		for (const [id, user_id, option_ids] of [
			[first, ana, ['o1', 'o2']],
			[first, beto, ['o1']],
			[second, carla, ['o2']],
		] as const) {
			await st.chat_replace_votes({ message_id: id, user_id, option_ids: [...option_ids], final: false, now: now() });
		}
		const tally = await st.chat_poll_tally([first, second, empty], beto);
		expect(tally.get(first)).toEqual({
			total_voters: 2,
			options: new Map([
				['o1', { votes: 2, mine: true, voter_ids: [ana, beto] }],
				['o2', { votes: 1, mine: false, voter_ids: [ana] }],
			]),
		});
		expect(tally.get(second)).toEqual({ total_voters: 1, options: new Map([['o2', { votes: 1, mine: false, voter_ids: [carla] }]]) });
		expect(tally.has(empty)).toBe(false);
	});
});

describe.skipIf(!sql)('menciones pendientes y bandeja de Actividad', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto, carla] = [hex_id(), hex_id(), hex_id()].sort() as [string, string, string];
	const at = (minute: number) => `2026-05-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
	}, 120_000);

	test('mentionSeqs: suma el seq a quien sigue activo y no lo leyó, y guarda los 20 más nuevos', async () => {
		const conversation_id = track('chat-conversations', hex_id());
		const member = async (user_id: string, state: string, last_read_seq: number, mentionSeqs: number[]) => {
			await db.unsafe(
				`INSERT INTO ${st.qt('chat-members')} (id, name, is_active, state, conversation_id, user_id, role, last_read_seq, payload, created_at, updated_at)
				 VALUES ($1, '', true, $2, $3, $4, 'member', $5, $6::jsonb, $7, $7)`,
				[track('chat-members', hex_id()), state, conversation_id, user_id, last_read_seq, { mentionSeqs }, at(0)],
			);
		};
		await member(ana, 'active', 0, Array.from({ length: 20 }, (_, i) => i + 1));
		await member(beto, 'active', 30, []);
		await member(carla, 'left', 0, []);
		expect(await st.chat_add_mention_seqs(conversation_id, [ana, beto, carla], 25, at(5))).toEqual([ana]);
		const rows = (await db.unsafe(
			`SELECT user_id, updated_at, payload -> 'mentionSeqs' AS seqs FROM ${st.qt('chat-members')} WHERE conversation_id = $1 ORDER BY user_id`,
			[conversation_id],
		)) as Array<{ user_id: string; updated_at: string; seqs: number[] }>;
		expect(rows.map((row) => [row.seqs, row.updated_at])).toEqual([
			[[...Array.from({ length: 19 }, (_, i) => i + 2), 25], at(5)],
			[[], at(0)],
			[[], at(0)],
		]);
		expect(await st.chat_add_mention_seqs(conversation_id, [], 26, at(6))).toEqual([]);
	});

	test('la bandeja pagina por (created_at, id), filtra, cuenta las no leídas y marca leída también su notificación', async () => {
		const notification = await st.insert('notifications', { recipientId: beto, title: 'Aviso', isRead: false });
		track('notifications', String(notification._id));
		const add = async (doc: Record<string, unknown>) =>
			track('mentions', String((await st.insert('mentions', { name: 'mención', isRead: false, ...doc }))._id));
		const message_id = hex_id();
		const chat = await add({ mentionedUserId: beto, contextType: 'chat-message', messageId: message_id, created_at: at(1) });
		const reaction = await add({ mentionedUserId: beto, contextType: 'chat-reaction', messageId: message_id, actorId: ana, reaction: '👍', created_at: at(2) });
		const history = await add({ mentionedUserId: beto, contextType: 'history-comment', notificationId: String(notification._id), created_at: at(3) });
		const reply = await add({ mentionedUserId: beto, contextType: 'chat-reply', created_at: at(3) });
		await add({ mentionedUserId: ana, contextType: 'chat-message', created_at: at(4) });
		await add({ mentionedUserId: beto, contextType: 'chat-message', created_at: at(5), is_active: false });
		const newest = [history, reply].sort().reverse();
		const page = (query: Partial<Parameters<typeof st.chat_activity_page>[0]> = {}) =>
			st.chat_activity_page({ user_id: beto, limit: 10, ...query }).then((rows) => rows.map((row) => String(row._id)));
		expect(await page()).toEqual([...newest, reaction, chat]);
		const first = await st.chat_activity_page({ user_id: beto, limit: 2 });
		const last = first.at(-1)!;
		expect(await page({ before: { at: String(last.created_at), id: String(last._id) } })).toEqual([reaction, chat]);
		expect(await page({ context_types: ['chat-reaction'] })).toEqual([reaction]);
		expect(await st.chat_activity_counts(beto)).toEqual({ all: 4, chat: 3, history: 1, reactions: 1 });
		expect(await st.chat_mark_activity_read({ user_id: beto, ids: [history, chat], now: at(9) })).toEqual({
			ids: expect.arrayContaining([history, chat]),
			notification_ids: [String(notification._id)],
		});
		expect((await st.find_id('notifications', String(notification._id)))?.isRead).toBe(true);
		expect(await page({ unread: true })).toEqual([...newest.filter((id) => id !== history), reaction]);
		expect(await st.chat_mark_activity_read({ user_id: beto, context_types: ['chat-reply'], now: at(9) })).toEqual({
			ids: [reply],
			notification_ids: [],
		});
		expect(await st.chat_activity_counts(beto)).toEqual({ all: 1, chat: 1, history: 0, reactions: 1 });
		expect(await st.chat_mark_activity_read({ user_id: ana, ids: [reaction], now: at(9) })).toEqual({ ids: [], notification_ids: [] });
		expect(await st.chat_retire_activity({ message_id, context_type: 'chat-reaction', actor_id: beto, now: at(9) })).toEqual([]);
		expect(await st.chat_retire_activity({ message_id, context_type: 'chat-reaction', actor_id: ana, reaction: '👍', now: at(9) })).toEqual([
			{ id: reaction, user_id: beto },
		]);
		expect(await st.chat_retire_activity({ message_id, now: at(9) })).toEqual([{ id: chat, user_id: beto }]);
		expect(await page()).toEqual(newest);
	});

	test('la bandeja de cada persona y el retiro por mensaje usan sus índices', async () => {
		const plan = async (where: string) =>
			(
				(await db.begin(async (tx) => {
					await tx.unsafe('SET LOCAL enable_seqscan = off');
					return tx.unsafe(`EXPLAIN SELECT id FROM ${st.qt('mentions')} WHERE ${where}`);
				})) as Array<Record<string, string>>
			)
				.map((line) => Object.values(line)[0])
				.join('\n');
		expect(
			await plan(`payload ->> 'mentionedUserId' = '${beto}' AND is_active IS DISTINCT FROM false ORDER BY created_at DESC, id DESC LIMIT 26`),
		).toContain('ix_mentions_recipient_created');
		expect(await plan(`payload ->> 'messageId' = '${hex_id()}'`)).toContain('ix_mentions_message');
	});
});

describe.skipIf(!sql)('responder comentarios del historial', () => {
	const db = sql!;
	const st = store!;
	const ADMIN_REF = 'user-menu-management-0';
	const rita = { _id: hex_id(), _ref: ADMIN_REF, name: 'Rita Autora', email: 'rita@empresa.com' };
	const raul = { _id: hex_id(), _ref: ADMIN_REF, name: 'Raúl Responde', email: 'raul@empresa.com' };
	const [document_id, other_document] = [hex_id(), hex_id()];

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
		for (const user of [rita, raul]) {
			track('user', user._id);
			await db.unsafe(
				`INSERT INTO ${st.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
				 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
				[user._id, user.name, `${user._id}@empresa.com`, new Date().toISOString()],
			);
		}
	}, 120_000);

	afterAll(async () => {
		for (const [resource, where, value] of [
			['document-change-history', `payload ->> 'documentId' IN ($1, $2)`, [document_id, other_document]],
			['notifications', `payload ->> 'recipientId' = $1`, [rita._id]],
			['mentions', `payload ->> 'mentionedUserId' = $1`, [rita._id]],
		] as const) {
			const rows = (await db.unsafe(`SELECT id FROM ${st.qt(resource)} WHERE ${where}`, [...value])) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		}
	});

	async function act(actor: ImperiumDoc, resource: string, action: string, init: { method?: string; path?: string; json?: unknown } = {}) {
		const url = new URL(`http://core/api/${resource}${init.path ?? ''}`);
		const req = new Request(url, {
			method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
			headers: init.json === undefined ? undefined : { 'content-type': 'application/json' },
			body: init.json === undefined ? undefined : JSON.stringify(init.json),
		});
		try {
			const res = await handle_action(st, db, req, url, resource, action, {}, actor);
			return { status: res.status, body: (await res.json()) as { data: ImperiumDoc[] } & Record<string, unknown> };
		} catch (err) {
			const e = err as { status?: number; code?: string };
			return { status: e.status ?? 500, body: { data: [], code: e.code } as { data: ImperiumDoc[] } & Record<string, unknown> };
		}
	}

	const comment = (actor: ImperiumDoc, text: string, extra: Record<string, unknown> = {}) =>
		act(actor, 'document-change-history', 'create_comment', {
			path: '/comment',
			json: { document_id, collection_name: 'products', model_name: 'products', comment_text: text, ...extra },
		});

	test('responder exige un comentario del mismo registro y avisa a su autor con notificación y Actividad', async () => {
		const parent = (await comment(rita, 'Revisen el costo')).body.data[0]!;
		const reply = await comment(raul, 'Ya lo revisé', { reply_to_history_id: parent._id, source_route: '/productos' });
		expect(reply.status).toBe(200);
		expect(reply.body.data[0]).toMatchObject({ replyToHistoryId: parent._id, documentId: document_id });
		const notifications = (await db.unsafe(
			`SELECT id, payload FROM ${st.qt('notifications')} WHERE payload ->> 'recipientId' = $1`,
			[rita._id],
		)) as Array<{ id: string; payload: ImperiumDoc }>;
		expect(notifications).toEqual([
			{
				id: expect.any(String),
				payload: expect.objectContaining({
					type: 'history-comment-reply',
					message: 'Ya lo revisé',
					source: expect.objectContaining({ documentId: document_id, historyId: reply.body.data[0]!._id }),
				}),
			},
		]);
		const inbox = await act(rita, 'notifications', 'read_my_mentions', { path: '/my-mentions?context=history' });
		expect(inbox.body.data).toEqual([
			expect.objectContaining({
				kind: 'reply',
				actor: expect.objectContaining({ _id: raul._id, name: 'Raúl Responde' }),
				excerpt: 'Ya lo revisé',
				record: {
					model_name: 'products',
					collection_name: 'products',
					document_id,
					history_id: reply.body.data[0]!._id,
					route: '/productos',
					entity_label: '',
				},
			}),
		]);
		const marked = await act(rita, 'notifications', 'mark_mentions_read', {
			method: 'PATCH',
			path: '/my-mentions/read',
			json: { all: true },
		});
		expect(marked.body.data).toEqual([{ updated: 1 }]);
		expect((await st.find_id('notifications', notifications[0]!.id))?.isRead).toBe(true);
		const elsewhere = (
			await act(rita, 'document-change-history', 'create_comment', {
				path: '/comment',
				json: { document_id: other_document, collection_name: 'products', comment_text: 'Otro registro' },
			})
		).body.data[0]!;
		for (const target of [elsewhere._id, hex_id()]) {
			const invalid = await comment(raul, 'No aplica', { reply_to_history_id: target });
			expect([invalid.status, invalid.body.code]).toEqual([422, 'reply_target_invalid']);
		}
		const own = await comment(rita, 'Me respondo', { reply_to_history_id: parent._id });
		expect(own.status).toBe(200);
		expect(((await db.unsafe(`SELECT count(*)::int AS n FROM ${st.qt('notifications')} WHERE payload ->> 'recipientId' = $1`, [rita._id])) as Array<{ n: number }>)[0]?.n).toBe(1);
	});
});

describe.skipIf(!sql)('grupos: membresía, roles y preferencias', () => {
	const db = sql!;
	const st = store!;
	const conversations: string[] = [];
	const at = (minute: number) => `2026-05-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
	const users = ['Ana Grupo', 'Beto Grupo', 'Carla Grupo'].map((name) => ({ _id: hex_id(), name }));
	const [ana, beto, carla] = users.map((user) => user._id) as [string, string, string];

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
		for (const user of users) {
			await db.unsafe(
				`INSERT INTO ${st.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
				 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
				[track('user', user._id), user.name, `${user._id}@empresa.com`, at(0)],
			);
		}
	}, 120_000);

	afterAll(async () => {
		for (const resource of ['messages', 'chat-members'] as const) {
			const rows = (await db.unsafe(
				`SELECT id FROM ${st.qt(resource)} WHERE conversation_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				[conversations],
			)) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		}
		for (const id of conversations) track('chat-conversations', id);
	});

	async function group(
		members: Array<[string, string]>,
		settings: Record<string, unknown> = { historyVisibleToNewMembers: true },
	): Promise<ImperiumDoc> {
		const id = hex_id();
		conversations.push(id);
		return st.chat_create_group({
			id,
			kind: 'group',
			title: 'Compras',
			description: '',
			created_by: members[0]![0],
			payload: { createdById: members[0]![0], settings, pins: [], invites: [] },
			members: members.map(([user_id, role]) => ({ user_id, role })),
			now: at(1),
		});
	}

	async function member(conversation_id: string, user_id: string): Promise<ImperiumDoc> {
		const { rows } = await st.find_many('chat-members', { where: { conversation_id, user_id }, take: 1, populate: false, skip_total: true });
		return rows[0]!;
	}

	function post(conversation_id: string, fields: Partial<Parameters<typeof st.chat_insert_message>[0]> = {}) {
		const id = hex_id();
		return st.chat_insert_message({
			id,
			conversation_id,
			sender_user_id: ana,
			client_id: crypto.randomUUID(),
			kind: 'text',
			name: 'Compras',
			search_field: 'hola',
			payload: { message: 'Hola', sourceType: 'chat', conversationId: conversation_id, rev: 0 },
			preview: { messageId: id, senderId: ana, senderName: 'Ana', kind: 'text', textPreview: 'Hola', at: at(2) },
			expires_at: null,
			share_read: true,
			attachment_ids: [],
			now: at(2),
			...fields,
		});
	}

	const counted = async (id: string) => Number((await st.find_id('chat-conversations', id))?.memberCount);

	test('crear un grupo deja a su dueño y sus miembros, con su llave y el total de activos', async () => {
		const created = await group([
			[ana, 'owner'],
			[beto, 'member'],
		]);
		expect(created).toMatchObject({ kind: 'group', conversation_key: `conv:${created._id}`, last_seq: 0, memberCount: 2, name: 'Compras' });
		expect(await member(String(created._id), ana)).toMatchObject({ role: 'owner', state: 'active', visibleFromSeq: 0, archived: false });
		expect(await member(String(created._id), beto)).toMatchObject({ role: 'member', state: 'active', notifyLevel: 'default' });
	});

	test('un mensaje de sistema no tiene remitente y lo lee quien lo causó', async () => {
		const id = String((await group([[ana, 'owner'], [beto, 'member']]))._id);
		const sent = await post(id, { sender_user_id: null, reader_user_id: ana, client_id: null, kind: 'system' });
		expect(sent?.message).toMatchObject({ sender_user_id: null, created_by: null, seq: 1, kind: 'system' });
		expect(await member(id, ana)).toMatchObject({ last_read_seq: 1 });
		expect(await member(id, beto)).toMatchObject({ last_read_seq: 0 });
	});

	test('quien vuelve conserva sus preferencias y empieza sin no leídos; un baneado frena a todos; sin cupo no entra nadie', async () => {
		const id = String((await group([[ana, 'owner'], [beto, 'member']]))._id);
		await post(id);
		await post(id);
		await st.chat_update_prefs({ conversation_id: id, user_id: beto, merge: { archived: true }, max_pinned: 100, now: at(3) });
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: beto, now: at(4) })).toMatchObject({ status: 'ok', closed: false });
		const back = await st.chat_join_members({ conversation_id: id, user_ids: [beto, carla], state: 'active', invited_by: ana, max_members: 10, now: at(5) });
		expect(back).toMatchObject({ status: 'ok', previous: { [beto]: 'left' } });
		expect(back.status === 'ok' && back.joined.map((row) => row.user_id).sort()).toEqual([beto, carla].sort());
		expect(await member(id, beto)).toMatchObject({
			state: 'active',
			role: 'member',
			archived: true,
			joinedAt: at(5),
			last_read_seq: 2,
			visibleFromSeq: 0,
			invitedById: ana,
		});
		expect((await member(id, beto)).leftAt).toBeUndefined();
		expect(await counted(id)).toBe(3);
		await st.chat_remove_member({ conversation_id: id, user_id: carla, expected_role: 'member', state: 'banned', now: at(6) });
		const dario = hex_id();
		expect(
			await st.chat_join_members({ conversation_id: id, user_ids: [dario, carla], state: 'active', max_members: 10, now: at(7) }),
		).toEqual({ status: 'banned', user_ids: [carla] });
		expect(await st.chat_join_members({ conversation_id: id, user_ids: [dario], state: 'active', max_members: 2, now: at(7) })).toEqual({
			status: 'full',
		});
		expect(await counted(id)).toBe(2);
	});

	test('sin historial compartido, quien entra lo ve desde su llegada', async () => {
		const id = String((await group([[ana, 'owner']], { historyVisibleToNewMembers: false }))._id);
		await post(id);
		await st.chat_join_members({ conversation_id: id, user_ids: [beto], state: 'active', max_members: 10, now: at(3) });
		expect(await member(id, beto)).toMatchObject({ visibleFromSeq: 1, last_read_seq: 1, delivered_seq: 1 });
		const visibility = await st.chat_member_visibility(id);
		expect(visibility.sort((a, b) => a.visible_from - b.visible_from)).toEqual([
			{ user_id: ana, visible_from: 0 },
			{ user_id: beto, visible_from: 1 },
		]);
	});

	test('en paralelo no se pasa del máximo', async () => {
		const id = String((await group([[ana, 'owner']]))._id);
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				st.chat_join_members({ conversation_id: id, user_ids: [hex_id()], state: 'active', max_members: 3, now: at(3) }),
			),
		);
		expect(results.map((result) => result.status).sort()).toEqual(['full', 'full', 'full', 'ok', 'ok']);
		expect(await counted(id)).toBe(3);
	});

	test('pedir entrar no cuenta como miembro; aprobar solo a quien lo pidió', async () => {
		const id = String((await group([[ana, 'owner']]))._id);
		await post(id);
		const asked = await st.chat_join_members({ conversation_id: id, user_ids: [beto], state: 'requested', max_members: 10, now: at(3) });
		expect(asked).toMatchObject({ status: 'ok' });
		expect(await member(id, beto)).toMatchObject({ state: 'requested', requestedAt: at(3), last_read_seq: 0 });
		expect(await counted(id)).toBe(1);
		expect(
			await st.chat_join_members({ conversation_id: id, user_ids: [carla], state: 'active', only_requested: true, max_members: 10, now: at(4) }),
		).toEqual({ status: 'not_requested' });
		await st.chat_join_members({ conversation_id: id, user_ids: [beto], state: 'active', only_requested: true, max_members: 10, now: at(4) });
		const approved = await member(id, beto);
		expect(approved).toMatchObject({ state: 'active', joinedAt: at(4), last_read_seq: 1 });
		expect(approved.requestedAt).toBeUndefined();
		expect(await counted(id)).toBe(2);
	});

	test('quitar exige el rol con el que se autorizó; banear a quien ya salió también vale', async () => {
		const id = String((await group([[ana, 'owner'], [beto, 'moderator'], [carla, 'member']]))._id);
		expect(await st.chat_remove_member({ conversation_id: id, user_id: beto, expected_role: 'member', state: 'removed', now: at(3) })).toBeNull();
		const removed = await st.chat_remove_member({ conversation_id: id, user_id: beto, expected_role: 'moderator', state: 'removed', now: at(3) });
		expect(removed).toMatchObject({ previous_state: 'active', member: { state: 'removed', leftAt: at(3) }, conversation: { memberCount: 2 } });
		await st.chat_leave_conversation({ conversation_id: id, user_id: carla, now: at(4) });
		expect(await st.chat_remove_member({ conversation_id: id, user_id: carla, expected_role: 'member', state: 'removed', now: at(5) })).toBeNull();
		expect(await st.chat_remove_member({ conversation_id: id, user_id: carla, expected_role: 'member', state: 'banned', now: at(5) })).toMatchObject({
			previous_state: 'left',
			member: { state: 'banned' },
		});
	});

	test('si sale el dueño lo hereda el administrador más antiguo, si no el miembro más antiguo; el último la da de baja', async () => {
		const [dario, eva] = [hex_id(), hex_id()];
		const id = String((await group([[ana, 'owner'], [beto, 'member']]))._id);
		await st.chat_join_members({ conversation_id: id, user_ids: [carla], state: 'active', max_members: 10, now: at(3) });
		await st.chat_join_members({ conversation_id: id, user_ids: [dario], state: 'active', max_members: 10, now: at(2) });
		await st.chat_join_members({ conversation_id: id, user_ids: [eva], state: 'active', max_members: 10, now: at(4) });
		for (const user_id of [carla, dario]) {
			await st.chat_update_member({ conversation_id: id, user_id, expected_role: 'member', role: 'admin', now: at(5) });
		}
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: ana, transfer_to: hex_id(), now: at(6) })).toEqual({
			status: 'not_member_target',
		});
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: ana, now: at(6) })).toMatchObject({ successor_id: dario });
		expect(await member(id, ana)).toMatchObject({ state: 'left', role: 'member' });
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: dario, now: at(7) })).toMatchObject({ successor_id: carla });
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: carla, now: at(8) })).toMatchObject({ successor_id: beto });
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: beto, transfer_to: eva, now: at(9) })).toMatchObject({
			successor_id: eva,
			closed: false,
		});
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: eva, now: at(10) })).toMatchObject({
			status: 'ok',
			successor_id: null,
			closed: true,
			conversation: { is_active: false, memberCount: 0 },
		});
		expect(await st.chat_leave_conversation({ conversation_id: id, user_id: eva, now: at(11) })).toEqual({ status: 'not_member' });
	});

	test('transferir: el dueño pasa a administrador y el otro a dueño', async () => {
		const id = String((await group([[ana, 'owner'], [beto, 'member']]))._id);
		expect(await st.chat_transfer_owner({ conversation_id: id, from: beto, to: ana, now: at(3) })).toEqual({ status: 'not_owner' });
		expect(await st.chat_transfer_owner({ conversation_id: id, from: ana, to: carla, now: at(3) })).toEqual({ status: 'not_member_target' });
		const done = await st.chat_transfer_owner({ conversation_id: id, from: ana, to: beto, now: at(3) });
		expect(done).toMatchObject({ status: 'ok', owner: { user_id: beto, role: 'owner' }, previous: { user_id: ana, role: 'admin' } });
	});

	test('rol y restricción solo cambian si el miembro conserva el rol esperado', async () => {
		const id = String((await group([[ana, 'owner'], [beto, 'member']]))._id);
		expect(await st.chat_update_member({ conversation_id: id, user_id: beto, expected_role: 'admin', role: 'moderator', now: at(3) })).toBeNull();
		const until = '2026-05-02T00:00:00.000Z';
		expect(
			await st.chat_update_member({ conversation_id: id, user_id: beto, expected_role: 'member', role: 'moderator', restricted_until: until, now: at(3) }),
		).toMatchObject({ role: 'moderator', restrictedUntil: until, updated_at: at(3) });
		const lifted = await st.chat_update_member({ conversation_id: id, user_id: beto, expected_role: 'moderator', restricted_until: null, now: at(4) });
		expect(lifted?.role).toBe('moderator');
		expect(lifted?.restrictedUntil).toBeUndefined();
	});

	test('título, ajustes e imagen en una sentencia, con el antes', async () => {
		const id = String((await group([[ana, 'owner']], { historyVisibleToNewMembers: true, membersCanPin: true }))._id);
		await st.chat_update_conversation({ id, merge: { avatarAttachmentId: 'imagen-1' }, unset: [], now: at(3) });
		const change = await st.chat_update_conversation({
			id,
			title: 'Compras 2026',
			settings: { membersCanPin: false, slowModeSeconds: 30 },
			merge: {},
			unset: ['avatarAttachmentId'],
			now: at(4),
		});
		expect(change?.conversation).toMatchObject({
			name: 'Compras 2026',
			description: '',
			settings: { historyVisibleToNewMembers: true, membersCanPin: false, slowModeSeconds: 30 },
			updated_at: at(4),
		});
		expect(change?.conversation.avatarAttachmentId).toBeUndefined();
		expect(change?.before).toMatchObject({ name: 'Compras', avatarAttachmentId: 'imagen-1', settings: { membersCanPin: true } });
		await st.chat_leave_conversation({ conversation_id: id, user_id: ana, now: at(5) });
		expect(await st.chat_update_conversation({ id, merge: {}, unset: [], now: at(6) })).toBeNull();
	});

	test('preferencias: fijar va al final de las propias, desfijar las quita y hay tope', async () => {
		const [first, second, third] = [
			String((await group([[ana, 'owner']]))._id),
			String((await group([[ana, 'owner']]))._id),
			String((await group([[ana, 'owner']]))._id),
		];
		const pin = (conversation_id: string, pinned: boolean, max_pinned = 100) =>
			st.chat_update_prefs({ conversation_id, user_id: ana, merge: {}, pinned, max_pinned, now: at(3) });
		const before = (
			(await db.unsafe(
				`SELECT COALESCE(max((payload ->> 'pinnedOrder')::numeric), 0)::int AS n FROM ${st.qt('chat-members')}
				 WHERE user_id = $1 AND jsonb_typeof(payload -> 'pinnedOrder') = 'number'`,
				[ana],
			)) as Array<{ n: number }>
		)[0]!.n;
		expect((await pin(first, true))?.pinnedOrder).toBe(before + 1);
		expect((await pin(second, true))?.pinnedOrder).toBe(before + 2);
		expect((await pin(first, true))?.pinnedOrder).toBe(before + 1);
		expect(await pin(third, true, 2)).toBeNull();
		expect((await pin(first, false))?.pinnedOrder).toBeNull();
		const muted = await st.chat_update_prefs({
			conversation_id: second,
			user_id: ana,
			merge: { mutedUntil: '2026-06-01T00:00:00.000Z', draft: null },
			max_pinned: 100,
			now: at(4),
		});
		expect(muted).toMatchObject({ mutedUntil: '2026-06-01T00:00:00.000Z', draft: null, pinnedOrder: before + 2, updated_at: at(4) });
	});

	test('la lista de miembros pagina por keyset y filtra por nombre, estado y rol', async () => {
		const id = String((await group([[ana, 'owner'], [beto, 'member'], [carla, 'member']]))._id);
		for (const [user_id, minute] of [[ana, 1], [beto, 2], [carla, 3]] as const) {
			await db.unsafe(`UPDATE ${st.qt('chat-members')} SET created_at = $3 WHERE conversation_id = $1 AND user_id = $2`, [id, user_id, at(minute)]);
		}
		await st.chat_leave_conversation({ conversation_id: id, user_id: carla, now: at(4) });
		const page = (query: Partial<Parameters<typeof st.chat_member_page>[0]>) =>
			st.chat_member_page({ conversation_id: id, states: ['active'], limit: 10, ...query });
		const first = await page({ limit: 1 });
		expect(first).toEqual([
			{
				member: expect.objectContaining({ user_id: ana, role: 'owner' }),
				user: { _id: ana, name: 'Ana Grupo', email: `${ana}@empresa.com`, is_active: true },
			},
		]);
		const cursor = { at: String(first[0]!.member.created_at), id: String(first[0]!.member._id) };
		expect((await page({ cursor })).map((row) => row.member.user_id)).toEqual([beto]);
		expect((await page({ q: 'beto' })).map((row) => row.member.user_id)).toEqual([beto]);
		expect((await page({ q: '100%_' })).length).toBe(0);
		expect((await page({ role: 'owner' })).map((row) => row.member.user_id)).toEqual([ana]);
		expect((await page({ states: ['left'] })).map((row) => row.member.user_id)).toEqual([carla]);
	});

	const invite = (fields: Record<string, unknown> = {}) => ({
		id: hex_id(),
		secret: hex_id(),
		createdById: ana,
		createdAt: at(1),
		uses: 0,
		...fields,
	});

	test('los enlaces cambian con la conversación bloqueada y el prefijo se fija la primera vez', async () => {
		const id = String((await group([[ana, 'owner']]))._id);
		const code = hex_id().slice(0, 16);
		const first = invite();
		const added = await st.chat_update_invites({ conversation_id: id, join_code: code, now: at(2), update: (invites) => [...invites, first] });
		expect(added).toMatchObject({ status: 'ok', conversation: { join_code: code, invites: [first], updated_at: at(2) } });
		const kept = await st.chat_update_invites({
			conversation_id: id,
			join_code: hex_id().slice(0, 16),
			now: at(3),
			update: (invites) => invites.map((item) => ({ ...item, revokedAt: at(3) })),
		});
		expect(kept).toMatchObject({ status: 'ok', conversation: { join_code: code, invites: [{ id: first.id, revokedAt: at(3) }] } });
		expect(await st.chat_update_invites({ conversation_id: id, join_code: null, now: at(4), update: () => null })).toEqual({
			status: 'rejected',
		});
		expect((await st.find_where('chat-conversations', { join_code: code }))?._id).toBe(id);
	});

	test('unirse por enlace gasta un uso solo si alguien entra y en paralelo no pasa de max_uses', async () => {
		const id = String((await group([[ana, 'owner']]))._id);
		const limited = invite({ maxUses: 2 });
		await st.chat_update_invites({ conversation_id: id, join_code: hex_id().slice(0, 16), now: at(2), update: () => [limited] });
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				st.chat_join_members({ conversation_id: id, user_ids: [hex_id()], state: 'active', invite_id: limited.id, max_members: 10, now: at(3) }),
			),
		);
		expect(results.map((result) => result.status).sort()).toEqual(['invite_exhausted', 'invite_exhausted', 'ok', 'ok']);
		const uses = async () => ((await st.find_id('chat-conversations', id))?.invites as ImperiumDoc[])[0]!.uses;
		expect(await uses()).toBe(2);
		const open = invite();
		await st.chat_update_invites({ conversation_id: id, join_code: null, now: at(4), update: (invites) => [...invites, open] });
		const again = await st.chat_join_members({ conversation_id: id, user_ids: [ana], state: 'active', invite_id: open.id, max_members: 10, now: at(5) });
		expect(again).toMatchObject({ status: 'ok', joined: [] });
		expect(((await st.find_id('chat-conversations', id))?.invites as ImperiumDoc[])[1]!.uses).toBe(0);
		const asked = await st.chat_join_members({ conversation_id: id, user_ids: [beto], state: 'requested', invite_id: open.id, max_members: 10, now: at(5) });
		expect(asked).toMatchObject({ status: 'ok', joined: [{ user_id: beto, state: 'requested' }] });
		expect(((await st.find_id('chat-conversations', id))?.invites as ImperiumDoc[])[1]!.uses).toBe(1);
	});

	test('un enlace revocado, caducado o inexistente no deja entrar', async () => {
		const id = String((await group([[ana, 'owner']]))._id);
		const revoked = invite({ revokedAt: at(2) });
		const expired = invite({ expiresAt: at(2) });
		await st.chat_update_invites({ conversation_id: id, join_code: hex_id().slice(0, 16), now: at(2), update: () => [revoked, expired] });
		const join = (invite_id: string) =>
			st.chat_join_members({ conversation_id: id, user_ids: [beto], state: 'active', invite_id, max_members: 10, now: at(3) });
		expect(await join(revoked.id)).toEqual({ status: 'invite_not_found' });
		expect(await join(expired.id)).toEqual({ status: 'invite_expired' });
		expect(await join(hex_id())).toEqual({ status: 'invite_not_found' });
		expect(await counted(id)).toBe(1);
	});

	test('rechazar una solicitud la da de baja; sin solicitud no hay nada que rechazar', async () => {
		const id = String((await group([[ana, 'owner']]))._id);
		await st.chat_join_members({ conversation_id: id, user_ids: [beto], state: 'requested', max_members: 10, now: at(2) });
		expect(await st.chat_deny_request(id, ana, at(3))).toBeNull();
		expect(await st.chat_deny_request(id, beto, at(3))).toMatchObject({ state: 'removed', leftAt: at(3), updated_at: at(3) });
		expect(await st.chat_deny_request(id, beto, at(4))).toBeNull();
	});

	test('los fijados cambian con la conversación bloqueada', async () => {
		const id = String((await group([[ana, 'owner']]))._id);
		const pin = { messageId: hex_id(), seq: 1, pinnedById: ana, pinnedAt: at(2), expiresAt: null };
		expect(await st.chat_update_pins({ conversation_id: id, now: at(2), update: (pins) => [...pins, pin] })).toMatchObject({
			status: 'ok',
			conversation: { pins: [pin], updated_at: at(2) },
		});
		expect(await st.chat_update_pins({ conversation_id: id, now: at(3), update: () => null })).toEqual({ status: 'rejected' });
		expect((await st.find_id('chat-conversations', id))?.pins).toEqual([pin]);
	});

	test('la galería trae un tipo por seq, deduce el tipo de los adjuntos legados y deja fuera lo oculto y lo borrado', async () => {
		const id = String((await group([[ana, 'owner'], [beto, 'member']]))._id);
		const rows: Array<[number, Record<string, unknown>]> = [
			[1, { attachments: [{ attachmentId: 'a1', isImage: true, mimetype: 'image/png' }] }],
			[2, { attachments: [{ attachmentId: 'a2', mimetype: 'application/pdf' }, { attachmentId: 'a3', mimetype: 'image/jpeg' }] }],
			[3, { attachments: [{ attachmentId: 'a4', kind: 'voice', mimetype: 'video/webm' }] }],
			[4, { links: ['https://ejemplo.com'] }],
			[5, { attachments: [{ attachmentId: 'a5', mimetype: 'image/png' }], hiddenForUserIds: [ana] }],
			[6, { message: '', deleted: { at: at(6), byRole: 'sender' } }],
			[7, { attachments: [{ attachmentId: 'a6', kind: 'image', mimetype: 'image/webp' }] }],
		];
		for (const [seq, payload] of rows) {
			await db.unsafe(
				`INSERT INTO ${st.qt('messages')} (id, name, is_active, conversation_id, seq, sender_user_id, kind, payload, created_at, updated_at)
				 VALUES ($1, '', true, $2, $3, $4, 'media', $5::jsonb, $6, $6)`,
				[track('messages', hex_id()), id, seq, beto, payload, at(seq)],
			);
		}
		const page = (input: Partial<Parameters<typeof st.chat_media_page>[0]>) =>
			st.chat_media_page({ conversation_id: id, visible_from: 0, viewer_id: ana, type: 'image', limit: 10, ...input });
		const seqs = async (input: Partial<Parameters<typeof st.chat_media_page>[0]>) => (await page(input)).rows.map((row) => row.seq);
		expect(await seqs({})).toEqual([7, 2, 1]);
		expect(await seqs({ viewer_id: beto })).toEqual([7, 5, 2, 1]);
		expect(await page({ limit: 1 })).toMatchObject({ rows: [{ seq: 7 }], more: true });
		expect(await seqs({ before_seq: 7, limit: 1 })).toEqual([2]);
		expect(await seqs({ visible_from: 1 })).toEqual([7, 2]);
		expect(await seqs({ type: 'file' })).toEqual([2]);
		expect(await seqs({ type: 'voice' })).toEqual([3]);
		expect(await seqs({ type: 'video' })).toEqual([]);
		expect(await seqs({ type: 'link' })).toEqual([4]);
		const plan = await db.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off');
			const sql = chat_media_page_sql(st.qt('messages'), true).replace(/\$(\d)/g, (_, n) =>
				["'x'", '0', "'u'", "'image'", '30', '100'][Number(n) - 1]!,
			);
			return (await tx.unsafe(`EXPLAIN ${sql}`)) as Array<Record<string, string>>;
		});
		expect(plan.map((row) => Object.values(row)[0]).join('\n')).toContain('uq_messages_conversation_id_seq');
	});
});

describe.skipIf(!sql)('búsqueda del chat en Postgres', () => {
	const db = sql!;
	const st = store!;
	const [ana, beto, carla] = ['Ana Busca', 'Beto Busca', 'Carla Busca'].map((name) => ({ _id: hex_id(), name }));
	const conversations: string[] = [];

	beforeAll(async () => {
		await st.ensure_orphan_tables();
		await st.ensure_unique_indexes();
		for (const user of [ana!, beto!, carla!]) {
			await db.unsafe(
				`INSERT INTO ${st.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
				 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
				[track('user', user._id), user.name, `${user._id}@empresa.com`, new Date().toISOString()],
			);
		}
	}, 120_000);

	afterAll(async () => {
		for (const resource of ['messages', 'chat-members'] as const) {
			const rows = (await db.unsafe(
				`SELECT id FROM ${st.qt(resource)} WHERE conversation_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				[conversations],
			)) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		}
		for (const id of conversations) track('chat-conversations', id);
	});

	async function act(actor: ImperiumDoc, action: string, path: string, json?: unknown) {
		const url = new URL(`http://core/api/messages${path}`);
		const req = new Request(url, {
			method: json === undefined ? 'GET' : 'POST',
			headers: json === undefined ? undefined : { 'content-type': 'application/json' },
			body: json === undefined ? undefined : JSON.stringify(json),
		});
		const res = await handle_action(st, db, req, url, 'messages', action, {}, actor);
		return (await res.json()) as { data: ImperiumDoc[]; next_cursor?: string | null; code?: string };
	}

	async function group(members: ImperiumDoc[]): Promise<string> {
		const id = hex_id();
		conversations.push(id);
		await st.chat_create_group({
			id,
			kind: 'group',
			title: 'Búsqueda',
			description: '',
			created_by: String(members[0]!._id),
			payload: { createdById: members[0]!._id, settings: {}, pins: [], invites: [] },
			members: members.map((user, index) => ({ user_id: String(user._id), role: index ? 'member' : 'owner' })),
			now: new Date().toISOString(),
		});
		return id;
	}

	const write = (actor: ImperiumDoc, conversation_id: string, text: string) =>
		act(actor, 'create_chat_message', '/chat', { conversation_id, client_id: crypto.randomUUID(), text });

	test('«acción» encuentra «accion» y al revés; quien no es miembro no encuentra nada', async () => {
		const id = await group([ana!, beto!]);
		await write(ana!, id, 'La acción del día');
		await Bun.sleep(2);
		await write(beto!, id, 'Otra ACCION sin acento, ver https://ejemplo.com/accion');
		await Bun.sleep(2);
		await write(beto!, id, 'El 100% listo_ya');
		const texts = async (actor: ImperiumDoc, query: string) =>
			(await act(actor, 'search_chat_messages', `/search${query}`)).data.map((row) => (row.message as ImperiumDoc).text);
		expect(await texts(ana!, '?q=accion')).toEqual(['Otra ACCION sin acento, ver https://ejemplo.com/accion', 'La acción del día']);
		expect(await texts(ana!, `?q=${encodeURIComponent('ACCIÓN')}`)).toHaveLength(2);
		expect(await texts(ana!, '?q=accion&has=link')).toEqual(['Otra ACCION sin acento, ver https://ejemplo.com/accion']);
		expect(await texts(ana!, `?q=accion&from=${ana!._id}`)).toEqual(['La acción del día']);
		expect(await texts(ana!, `?q=${encodeURIComponent('00%')}`)).toEqual(['El 100% listo_ya']);
		expect(await texts(ana!, `?q=${encodeURIComponent('o_y')}`)).toEqual(['El 100% listo_ya']);
		expect(await texts(ana!, `?q=${encodeURIComponent('o%y')}`)).toEqual([]);
		expect(await texts(carla!, '?q=accion')).toEqual([]);
		expect(await st.chat_search({ user_id: String(carla!._id), needle: 'accion', limit: 10 })).toEqual([]);
		const first = await act(ana!, 'search_chat_messages', '/search?q=accion&limit=1');
		const rest = await act(ana!, 'search_chat_messages', `/search?q=accion&limit=1&cursor=${first.next_cursor}`);
		expect(rest.data.map((row) => (row.message as ImperiumDoc).text)).toEqual(['La acción del día']);
		expect(rest.next_cursor).toBeNull();
	});

	test('quien sale deja de encontrar; quien entra ve desde donde el grupo se lo permite', async () => {
		const id = await group([ana!, beto!]);
		await write(ana!, id, 'Presupuesto inicial');
		await db.unsafe(
			`UPDATE ${st.qt('chat-conversations')} SET payload = jsonb_set(payload, '{settings,historyVisibleToNewMembers}', 'false') WHERE id = $1`,
			[id],
		);
		await st.chat_join_members({ conversation_id: id, user_ids: [String(carla!._id)], state: 'active', max_members: 10, now: new Date().toISOString() });
		await write(ana!, id, 'Presupuesto final');
		const texts = async (actor: ImperiumDoc) =>
			(await act(actor, 'search_chat_messages', '/search?q=presupuesto')).data.map((row) => (row.message as ImperiumDoc).text);
		expect(await texts(carla!)).toEqual(['Presupuesto final']);
		expect(await texts(beto!)).toHaveLength(2);
		await st.chat_leave_conversation({ conversation_id: id, user_id: String(beto!._id), now: new Date().toISOString() });
		expect(await texts(beto!)).toEqual([]);
	});
});
