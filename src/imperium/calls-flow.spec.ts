/**
 * Llamadas por las rutas. Los ajustes y el ICE con un almacén falso de parámetros; el flujo de
 * llamadas contra Postgres real (`DATABASE_URL`), con ids aleatorios y limpieza al final.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { handle_action } from './actions.ts';
import { run_room_command } from './call-room.ts';
import type { RoomRole } from './call-state.ts';
import { call_from_row, impose_on_sfu, mark_leg_attached, mark_leg_detached, record_call, sweep_calls } from './calls-flow.ts';
import type { ImperiumDoc } from './envelope.ts';
import { sign_realtime_token } from './realtime-tokens.ts';
import { run_host_command } from './meetings-flow.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const store = sql ? new ImperiumStore(sql, load_catalog_path()) : null;
const created: Record<string, string[]> = {};

function track(resource: string, id: string): string {
	(created[resource] ??= []).push(id);
	return id;
}

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

type Reply = { status: number; body: { data: ImperiumDoc[]; code?: string } & Record<string, unknown> };

async function call(
	st: ImperiumStore,
	actor: ImperiumDoc | null,
	action: string,
	path: string,
	init: {
		method?: string;
		params?: Record<string, string>;
		json?: unknown;
		cookie?: string;
		resource?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<Reply> {
	const resource = init.resource ?? 'chat-calls';
	const url = new URL(`http://core/api/${resource}${path}`);
	const headers: Record<string, string> = { ...init.headers };
	if (init.json !== undefined) headers['content-type'] ??= 'application/json';
	if (init.cookie) headers.cookie = init.cookie;
	const req = new Request(url, {
		method: init.method ?? 'GET',
		headers,
		body: init.json === undefined ? undefined : JSON.stringify(init.json),
	});
	try {
		const res = await handle_action(st, {} as Bun.SQL, req, url, resource, action, init.params ?? {}, actor);
		return { status: res.status, body: (await res.json()) as Reply['body'] };
	} catch (err) {
		const e = err as { status?: number; code?: string; message: string; details?: unknown };
		return { status: e.status ?? 500, body: { data: [], code: e.code, message: e.message, details: e.details } };
	}
}

/** Solo los parámetros: lo que leen los ajustes y el ICE. */
function params_store(values: Record<string, unknown>): ImperiumStore {
	return {
		has: (resource: string) => resource === 'configuration',
		find_many: async () => ({
			rows: Object.entries(values).map(([_ref, value]) => ({ _ref, value })),
			total: 0,
		}),
	} as unknown as ImperiumStore;
}

const SECRETS = {
	IMPERIUM_TURN_URLS: 'turn:turn.empresa.test:3478',
	IMPERIUM_TURN_SECRET: 'secreto-turn-que-no-sale',
	IMPERIUM_SFU_URL: 'wss://sfu.empresa.test',
	IMPERIUM_SFU_API_KEY: 'clave',
	IMPERIUM_SFU_API_SECRET: 'secreto-sfu-que-no-sale',
};
const saved_env = Object.fromEntries(Object.keys(SECRETS).map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const [key, value] of Object.entries(saved_env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe('ajustes e ICE', () => {
	const ana = { _id: hex_id(), name: 'Ana' };

	test('los ajustes dicen qué hay sin un solo secreto', async () => {
		Object.assign(process.env, SECRETS);
		const reply = await call(
			params_store({ 'configuration-calls-mesh-max-participants': 9, 'configuration-meetings-guests-enabled': true }),
			ana,
			'read_settings',
			'/settings',
		);
		expect(reply.status).toBe(200);
		expect(reply.body.data).toEqual([
			{
				enabled: true,
				mesh_max: 6,
				class_max: 20,
				ring_timeout_seconds: 45,
				sfu_available: true,
				turn_configured: true,
				guests_enabled: true,
				recording_enabled: true,
				captions_cloud_allowed: false,
			},
		]);
		const text = JSON.stringify(reply.body);
		for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
	});

	test('ICE: STUN del parámetro y TURN efímero de la persona, sin filtrar el secreto', async () => {
		Object.assign(process.env, SECRETS);
		const reply = await call(
			params_store({ 'configuration-calls-stun-urls': 'stun:uno.test:3478, stun:dos.test:3478' }),
			ana,
			'ice_servers',
			'/ice-servers',
		);
		expect(reply.status).toBe(200);
		const [view] = reply.body.data as Array<{ ice_servers: Array<Record<string, unknown>>; ttl_s: number }>;
		expect(view!.ttl_s).toBe(3600);
		expect(view!.ice_servers[0]).toEqual({ urls: ['stun:uno.test:3478', 'stun:dos.test:3478'] });
		expect(view!.ice_servers[1]).toMatchObject({ urls: ['turn:turn.empresa.test:3478'] });
		expect(String(view!.ice_servers[1]!.username)).toMatch(new RegExp(`^\\d+:u:${ana._id}$`));
		expect(JSON.stringify(reply.body)).not.toContain(SECRETS.IMPERIUM_TURN_SECRET);
	});

	test('ICE es para una sesión o un invitado admitido de esa reunión; nada más', async () => {
		const st = params_store({});
		expect((await call(st, null, 'ice_servers', '/ice-servers')).body.code).toBe('unauthenticated');
		const meeting_id = hex_id();
		const guest = sign_realtime_token({
			t: 'guest',
			gid: hex_id(),
			mid: meeting_id,
			name: 'Invitada',
			exp: Math.floor(Date.now() / 1000) + 600,
		});
		const cookie = `connect.sid=x; imperium_invitado=${encodeURIComponent(guest)}`;
		const other = await call(st, null, 'ice_servers', `/ice-servers?meeting_id=${hex_id()}`, { cookie });
		expect([other.status, other.body.code]).toEqual([401, 'guest_token_invalid']);
		const forged = await call(st, null, 'ice_servers', `/ice-servers?meeting_id=${meeting_id}`, {
			cookie: `imperium_invitado=${guest.slice(0, -2)}xx`,
		});
		expect([forged.status, forged.body.code]).toEqual([401, 'guest_token_invalid']);
		const waiting = await call(st, null, 'ice_servers', `/ice-servers?meeting_id=${meeting_id}`, { cookie });
		expect([waiting.status, waiting.body.code]).toEqual([403, 'guest_not_admitted']);
	});

	test('con las llamadas apagadas no hay ICE, pero los ajustes lo dicen', async () => {
		const off = params_store({ 'configuration-calls-enabled': false });
		const ana_off = { _id: hex_id(), name: 'Ana' };
		const ice = await call(off, ana_off, 'ice_servers', '/ice-servers');
		expect([ice.status, ice.body.code]).toEqual([403, 'calls_disabled']);
		for (const [action, path] of [
			['read_active_calls', '/active'],
			['read_my_calls', '/mine'],
		]) {
			const reply = await call(off, ana_off, action!, path!);
			expect([action, reply.status, reply.body.code]).toEqual([action, 403, 'calls_disabled']);
		}
		const settings = await call(params_store({ 'configuration-calls-enabled': false }), ana_off, 'read_settings', '/settings');
		expect(settings.body.data[0]).toMatchObject({ enabled: false });
	});
});

afterAll(async () => {
	if (!sql || !store) return;
	for (const [resource, ids] of Object.entries(created)) {
		await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [ids]);
	}
	await sql.close();
}, 120_000);

describe.skipIf(!sql)('llamadas en Postgres', () => {
	const db = sql!;
	const st = store!;
	const people: ImperiumDoc[] = ['Ana', 'Beto', 'Carla', 'Darío', 'Eva'].map((name) => ({ _id: hex_id(), name: `${name} Llamada` }));
	const [ana, beto, carla, dario, eva] = people as [ImperiumDoc, ImperiumDoc, ImperiumDoc, ImperiumDoc, ImperiumDoc];
	let direct = '';
	let group = '';

	const post = (actor: ImperiumDoc | null, action: string, path: string, json: unknown = {}, id?: string) =>
		call(st, actor, action, path, { method: 'POST', json, params: id ? { id } : {} });
	const start = (actor: ImperiumDoc, conversation_id: string, extra: ImperiumDoc = {}) =>
		post(actor, 'create_call', '/', { conversation_id, media: 'audio', leg_id: `leg-${actor._id}`, ...extra });
	const answer = (actor: ImperiumDoc, id: string, leg_id = `leg-${actor._id}`) =>
		post(actor, 'accept_call', `/${id}/accept`, { leg_id, media: 'audio' }, id);
	const leave = (actor: ImperiumDoc, id: string, leg_id = `leg-${actor._id}`) =>
		post(actor, 'leave_call', `/${id}/leave`, { leg_id }, id);
	const call_id = (reply: Reply) => {
		expect(reply.status).toBe(200);
		return String(reply.body.data[0]!._id);
	};
	const row_of = async (id: string) => (await st.find_id('chat-calls', id))!;
	const unread = async (user: ImperiumDoc, conversation_id: string) => {
		const [row] = (await db.unsafe(
			`SELECT c.last_seq - COALESCE(m.last_read_seq, 0) AS unread FROM ${st.qt('chat-members')} m
			 JOIN ${st.qt('chat-conversations')} c ON c.id = m.conversation_id
			 WHERE m.conversation_id = $1 AND m.user_id = $2`,
			[conversation_id, user._id],
		)) as Array<{ unread: number }>;
		return Number(row?.unread);
	};
	const call_messages = async (conversation_id: string) =>
		(await db.unsafe(
			`SELECT id, seq, kind, payload FROM ${st.qt('messages')} WHERE conversation_id = $1 ORDER BY seq`,
			[conversation_id],
		)) as Array<{ id: string; seq: number; kind: string; payload: ImperiumDoc }>;

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
		const opened = await call(st, ana, 'open_direct_conversation', '/direct', {
			method: 'POST',
			json: { user_id: beto._id },
			resource: 'chat-conversations',
		});
		direct = track('chat-conversations', String(opened.body.data[0]!._id));
		const made = await call(st, ana, 'create_group_conversation', '/group', {
			method: 'POST',
			json: { title: 'Equipo de llamadas', kind: 'group', member_ids: [beto._id, carla._id, dario._id], settings: { members_can_call: true } },
			resource: 'chat-conversations',
		});
		group = track('chat-conversations', String(made.body.data[0]!._id));
	}, 120_000);

	afterAll(async () => {
		const collect = async (resource: string, where: string, value: string) => {
			const rows = (await db.unsafe(`SELECT id FROM ${st.qt(resource)} WHERE ${where}`, [value])) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		};
		for (const id of [...(created['chat-conversations'] ?? [])]) {
			for (const resource of ['messages', 'chat-members', 'chat-calls']) await collect(resource, 'conversation_id = $1', id);
		}
		for (const id of created['chat-calls'] ?? []) await collect('chat-meeting-attendance', 'call_id = $1', id);
		for (const user of people) {
			await collect('mentions', `payload ->> 'mentionedUserId' = $1`, String(user._id));
			await collect('notifications', `payload ->> 'recipientId' = $1`, String(user._id));
		}
	}, 120_000);

	test('solo un miembro llama, contesta o entra', async () => {
		const outsider = await start(carla, direct);
		expect([outsider.status, outsider.body.code]).toEqual([403, 'not_member']);
		const id = call_id(await start(ana, direct));
		expect((await answer(carla, id)).body.code).toBe('not_member');
		expect((await post(carla, 'join_call', `/${id}/join`, { leg_id: 'x', media: 'audio' }, id)).body.code).toBe('not_member');
		expect((await post(ana, 'cancel_call', `/${id}/cancel`, {}, id)).status).toBe(200);
	});

	test('1:1 completa: una sola llamada por conversación, gana el primer dispositivo y queda el mensaje leído', async () => {
		const [conversation] = (await db.unsafe(`SELECT last_seq FROM ${st.qt('chat-conversations')} WHERE id = $1`, [direct])) as Array<{
			last_seq: number;
		}>;
		await call(st, beto, 'mark_conversation_read', `/${direct}/read`, {
			method: 'POST',
			params: { id: direct },
			json: { seq: Number(conversation!.last_seq) },
			resource: 'chat-conversations',
		});
		const first = await start(ana, direct);
		const id = call_id(first);
		expect(first.body.data[0]).toMatchObject({ state: 'ringing', kind: 'direct', joined_count: 1, callee_online: false });
		expect(first.body.data[0]).not.toHaveProperty('participant_ids');
		const glare = await start(beto, direct);
		expect([glare.status, glare.body.code]).toEqual([409, 'call_in_progress']);
		expect((glare.body.details as ImperiumDoc).call).toMatchObject({ _id: id, state: 'ringing' });
		const summary = await call(st, beto, 'read_conversation_summary', `/${direct}`, { params: { id: direct }, resource: 'chat-conversations' });
		expect(summary.body.data[0]!.active_call).toEqual({ call_id: id, media: 'audio', participant_count: 1 });
		const [tel, pc] = await Promise.all([answer(beto, id, 'tel'), answer(beto, id, 'pc')]);
		expect([tel.status, pc.status].sort()).toEqual([200, 409]);
		expect([tel, pc].find((reply) => reply.status === 409)!.body.code).toBe('answered_elsewhere');
		const winner = tel.status === 200 ? 'tel' : 'pc';
		expect(await row_of(id)).toMatchObject({ state: 'active', v: 1 });
		const ended = await leave(beto, id, winner);
		expect(ended.body.data[0]).toMatchObject({ state: 'ended', end_reason: 'completed' });
		const [message] = (await call_messages(direct)).filter((row) => row.payload.call && (row.payload.call as ImperiumDoc).callId === id);
		expect(message).toMatchObject({ kind: 'call', payload: { call: { outcome: 'completed', initiatorId: ana._id, media: 'audio' } } });
		expect(await unread(beto, direct)).toBe(0);
		expect(await unread(ana, direct)).toBe(0);
		const attendance = (await db.unsafe(
			`SELECT participant_key, payload FROM ${st.qt('chat-meeting-attendance')} WHERE call_id = $1 ORDER BY participant_key`,
			[id],
		)) as Array<{ participant_key: string; payload: ImperiumDoc }>;
		expect(attendance.map((row) => row.participant_key).sort()).toEqual([`u:${ana._id}`, `u:${beto._id}`].sort());
		expect(attendance.every((row) => (row.payload.intervals as unknown[]).length === 1)).toBe(true);
		const after = await call(st, beto, 'read_conversation_summary', `/${direct}`, { params: { id: direct }, resource: 'chat-conversations' });
		expect(after.body.data[0]!.active_call).toBeUndefined();
		expect((await leave(beto, id, winner)).status).toBe(200);
	});

	test('rechazar con un mensaje rápido: llamada declinada y el texto en la conversación', async () => {
		const id = call_id(await start(ana, direct));
		const reply = await post(beto, 'decline_call', `/${id}/decline`, { leg_id: 'tel', message: 'Ahora no puedo, te marco' }, id);
		expect(reply.body.data[0]).toMatchObject({ state: 'ended', end_reason: 'declined' });
		const rows = await call_messages(direct);
		const tail = rows.slice(-2).map((row) => [row.kind, (row.payload.call as ImperiumDoc | undefined)?.outcome ?? row.payload.message]);
		expect(tail).toEqual([
			['call', 'declined'],
			['text', 'Ahora no puedo, te marco'],
		]);
		expect((await post(beto, 'decline_call', `/${id}/decline`, { leg_id: 'tel' }, id)).body.code).toBe('not_ringing');
	});

	test('perdida: el barrido la cierra al vencer el timbre; sin leer, con actividad y notificación', async () => {
		const id = call_id(await start(ana, direct));
		const before = await unread(beto, direct);
		const started = Date.parse(String((await row_of(id)).started_at));
		await sweep_calls(st, started + 46_000);
		expect(await row_of(id)).toMatchObject({ state: 'ended', endReason: 'no_answer' });
		expect(await unread(beto, direct)).toBe(before + 1);
		expect(await unread(ana, direct)).toBe(0);
		const [message] = (await call_messages(direct)).filter((row) => (row.payload.call as ImperiumDoc | undefined)?.callId === id);
		const activity = (await db.unsafe(
			`SELECT payload FROM ${st.qt('mentions')} WHERE payload ->> 'messageId' = $1`,
			[message!.id],
		)) as Array<{ payload: ImperiumDoc }>;
		expect(activity.map((row) => [row.payload.mentionedUserId, row.payload.contextType])).toEqual([[beto._id, 'chat-missed-call']]);
		const notes = (await db.unsafe(
			`SELECT payload FROM ${st.qt('notifications')} WHERE payload ->> 'recipientId' = $1 AND payload ->> 'type' = 'call-missed'`,
			[beto._id],
		)) as Array<{ payload: ImperiumDoc }>;
		expect(notes.some((row) => row.payload.call_id === id)).toBe(true);
	});

	test('ocupado: quien ya está en otra llamada suena en espera; quien llama no puede estar en dos', async () => {
		const busy_call = call_id(await start(carla, group, { invitee_ids: [dario._id] }));
		expect((await answer(dario, busy_call)).status).toBe(200);
		const dario_direct = (
			await call(st, ana, 'open_direct_conversation', '/direct', { method: 'POST', json: { user_id: dario._id }, resource: 'chat-conversations' })
		).body.data[0]!._id as string;
		track('chat-conversations', dario_direct);
		const twice = await start(dario, dario_direct);
		expect([twice.status, twice.body.code]).toEqual([409, 'already_in_call']);
		const waiting = await start(ana, dario_direct);
		const waiting_id = call_id(waiting);
		expect((waiting.body.data[0]!.legs as ImperiumDoc[]).find((leg) => leg.user_id === dario._id)).toMatchObject({ busy: true });
		expect((await answer(dario, waiting_id, 'otra')).status).toBe(200);
		const left_behind = (await row_of(busy_call)).legs as ImperiumDoc[];
		expect(left_behind.find((leg) => leg.userId === dario._id)).toMatchObject({ state: 'left' });
		expect((await leave(carla, busy_call)).body.data[0]).toMatchObject({ state: 'ended' });
		await leave(ana, waiting_id);
	});

	test('grupal: un miembro sin timbre la ve en /active y entra; terminar para todos solo el iniciador', async () => {
		const id = call_id(await start(ana, group, { invitee_ids: [beto._id] }));
		const active = await call(st, carla, 'read_active_calls', '/active');
		expect(active.body.data.map((row) => row._id)).toContain(id);
		expect((await call(st, eva, 'read_active_calls', '/active')).body.data.map((row) => row._id)).not.toContain(id);
		const joined = await post(carla, 'join_call', `/${id}/join`, { leg_id: 'c1', media: 'audio' }, id);
		expect(joined.body.data[0]).toMatchObject({ state: 'active', joined_count: 2 });
		expect((await post(carla, 'end_call', `/${id}/end`, {}, id)).body.code).toBe('not_host');
		const ended = await post(ana, 'end_call', `/${id}/end`, {}, id);
		expect(ended.body.data[0]).toMatchObject({ state: 'ended', end_reason: 'ended_by_host' });
		const [message] = (await call_messages(group)).filter((row) => (row.payload.call as ImperiumDoc | undefined)?.callId === id);
		expect(message!.payload.call).toMatchObject({ kind: 'group', outcome: 'completed' });
		expect(await unread(beto, group)).toBeGreaterThan(0);
	});

	test('el barrido saca a quien lleva 30 s sin adjuntarse a la sala y cierra la llamada interrumpida', async () => {
		const id = call_id(await start(ana, direct));
		expect((await answer(beto, id, 'tel')).status).toBe(200);
		mark_leg_attached(id, String(ana._id), `leg-${ana._id}`);
		const t0 = Date.now() + 60_000;
		await sweep_calls(st, t0);
		expect((await row_of(id)).state).toBe('active');
		mark_leg_detached(id, String(ana._id), `leg-${ana._id}`, t0);
		await sweep_calls(st, t0 + 29_000);
		expect((await row_of(id)).state).toBe('active');
		await sweep_calls(st, t0 + 31_000);
		expect(await row_of(id)).toMatchObject({ state: 'ended', endReason: 'interrupted' });
	});

	test('el historial pagina por keyset con las llamadas propias', async () => {
		const first = await call(st, beto, 'read_my_calls', '/mine?limit=2');
		expect(first.body.data).toHaveLength(2);
		expect(typeof first.body.next_cursor).toBe('string');
		const rest = await call(st, beto, 'read_my_calls', `/mine?limit=50&cursor=${first.body.next_cursor}`);
		const ids = [...first.body.data, ...rest.body.data].map((row) => row._id);
		expect(new Set(ids).size).toBe(ids.length);
		const mine = (await db.unsafe(
			`SELECT id FROM ${st.qt('chat-calls')} WHERE (payload -> 'participantIds') @> jsonb_build_array($1::text) ORDER BY created_at DESC, id DESC`,
			[beto._id],
		)) as Array<{ id: string }>;
		expect(ids).toEqual(mine.map((row) => row.id));
		expect((await call(st, beto, 'read_my_calls', '/mine?cursor=basura')).body.code).toBe('invalid_cursor');
		expect((await call(st, eva, 'read_my_calls', '/mine')).body.data).toEqual([]);
	});

	/** Un servidor de medios falso que guarda cada llamada a su API de administración. */
	function fake_sfu() {
		const seen: Array<{ method: string; body: ImperiumDoc; claims: ImperiumDoc }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const method = new URL(req.url).pathname.split('/').at(-1)!;
				const token = String(req.headers.get('authorization')).replace('Bearer ', '');
				const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as ImperiumDoc;
				seen.push({ method, body: (await req.json()) as ImperiumDoc, claims });
				if (method === 'GetParticipant') {
					return Response.json({ tracks: [{ sid: 'TR_mic', source: 'MICROPHONE' }, { sid: 'TR_cam', source: 'CAMERA' }] });
				}
				return Response.json({});
			},
		});
		Object.assign(process.env, SECRETS, { IMPERIUM_SFU_URL: `ws://127.0.0.1:${server.port}` });
		const until = async (method: string) => {
			for (let i = 0; i < 100 && !seen.some((item) => item.method === method); i++) await Bun.sleep(20);
			return seen.filter((item) => item.method === method);
		};
		return { seen, until, stop: () => server.stop(true) };
	}
	const claims_of = (token: unknown) => JSON.parse(Buffer.from(String(token).split('.')[1]!, 'base64url').toString());

	test('sin SFU: malla hasta el tope, luego modo clase en estrella y después room_full', async () => {
		for (const key of ['IMPERIUM_SFU_URL', 'IMPERIUM_SFU_API_KEY', 'IMPERIUM_SFU_API_SECRET']) delete process.env[key];
		const limited = Object.create(st) as ImperiumStore;
		limited.find_many = (async (resource: string, query: Parameters<ImperiumStore['find_many']>[1]) =>
			resource === 'configuration'
				? {
						rows: [
							{ _ref: 'configuration-calls-mesh-max-participants', value: 2 },
							{ _ref: 'configuration-calls-class-max-participants', value: 3 },
						],
						total: 2,
					}
				: st.find_many(resource, query)) as ImperiumStore['find_many'];
		const send = (actor: ImperiumDoc, action: string, path: string, json: unknown, id?: string) =>
			call(limited, actor, action, path, { method: 'POST', json, params: id ? { id } : {} });
		const started = await send(carla, 'create_call', '/', { conversation_id: group, media: 'video', leg_id: `leg-${carla._id}`, invitee_ids: [dario._id] });
		const id = call_id(started);
		const accepted = await send(dario, 'accept_call', `/${id}/accept`, { leg_id: `leg-${dario._id}`, media: 'video' }, id);
		expect(accepted.body.data[0]).toMatchObject({ topology: 'mesh', joined_count: 2 });
		const star = await send(beto, 'join_call', `/${id}/join`, { leg_id: `leg-${beto._id}`, media: 'video' }, id);
		expect(star.body.data[0]).toMatchObject({ topology: 'star', joined_count: 3 });
		const full = await send(ana, 'join_call', `/${id}/join`, { leg_id: `leg-${ana._id}`, media: 'video' }, id);
		expect([full.status, full.body.code, full.body.message]).toEqual([
			409,
			'room_full',
			'Para más participantes se necesita el servidor de medios.',
		]);
		expect(await row_of(id)).toMatchObject({ topology: 'star' });
		expect((await send(carla, 'end_call', `/${id}/end`, {}, id)).body.data[0]).toMatchObject({ state: 'ended' });
	});

	test('con SFU: el tercero migra a sfu, nunca vuelve a malla, quien sale deja el SFU y el final borra la sala', async () => {
		const sfu = fake_sfu();
		try {
			const id = call_id(await start(dario, group, { invitee_ids: [beto._id, carla._id] }));
			expect((await answer(beto, id)).body.data[0]).toMatchObject({ topology: 'mesh' });
			const third = await answer(carla, id);
			expect(third.body.data[0]).toMatchObject({ topology: 'sfu', joined_count: 3 });
			expect(await row_of(id)).toMatchObject({ topology: 'sfu' });
			const issued = await post(carla, 'sfu_token', `/${id}/sfu-token`, { leg_id: `leg-${carla._id}` }, id);
			expect(claims_of(issued.body.data[0]!.token)).toMatchObject({
				iss: SECRETS.IMPERIUM_SFU_API_KEY,
				sub: `u:${carla._id}:leg-${carla._id}`,
				video: {
					room: `imperium-${id}`,
					roomJoin: true,
					canPublish: true,
					canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio'],
					roomAdmin: false,
				},
				metadata: '{"role":"participant"}',
			});
			expect((await leave(carla, id)).body.data[0]).toMatchObject({ state: 'active', topology: 'sfu', joined_count: 2 });
			const [removed] = await sfu.until('RemoveParticipant');
			expect(removed).toMatchObject({
				body: { room: `imperium-${id}`, identity: `u:${carla._id}:leg-${carla._id}` },
				claims: { video: { room: `imperium-${id}`, roomAdmin: true } },
			});
			expect(Number(removed!.claims.exp) - Number(removed!.claims.nbf)).toBe(60);
			expect((await post(dario, 'end_call', `/${id}/end`, {}, id)).body.data[0]).toMatchObject({ state: 'ended', topology: 'sfu' });
			const [closed] = await sfu.until('DeleteRoom');
			expect(closed).toMatchObject({ body: { room: `imperium-${id}` }, claims: { video: { roomCreate: true } } });
		} finally {
			sfu.stop();
		}
	});

	test('con SFU, grabar migra a sfu y la grabación se guarda y se borra de la llamada', async () => {
		Object.assign(process.env, SECRETS);
		const id = call_id(await start(beto, group, { invitee_ids: [dario._id] }));
		await answer(dario, id);
		expect(await row_of(id)).toMatchObject({ topology: 'mesh' });
		const recording = await record_call(st, id, { user_id: String(beto._id), is_host: false, recording_id: 'grab-1' });
		expect(recording).toMatchObject({ topology: 'sfu', recording: { by: beto._id, recording_id: 'grab-1' } });
		expect((await row_of(id)).recording).toMatchObject({ by: beto._id, recordingId: 'grab-1' });
		const stopped = await record_call(st, id, { user_id: String(beto._id), is_host: false, recording_id: null });
		expect(stopped.topology).toBe('sfu');
		expect(stopped.recording).toBeUndefined();
		expect((await row_of(id)).recording).toBeNull();
		delete process.env.IMPERIUM_SFU_URL;
		expect((await post(beto, 'end_call', `/${id}/end`, {}, id)).body.data[0]).toMatchObject({ state: 'ended' });
	});

	test('reunión en clase con SFU: el token y la moderación se recortan por rol de la sala', async () => {
		const sfu = fake_sfu();
		try {
			const meeting_id = track('chat-meetings', hex_id());
			await st.insert('chat-meetings', {
				_id: meeting_id,
				name: 'Clase de llamadas',
				state: 'live',
				code: `abc-${hex_id().slice(0, 4)}-xyz`,
				host_id: ana._id,
				profile: 'clase',
				v: 0,
			});
			const id = track('chat-calls', hex_id());
			const row = await st.insert('chat-calls', {
				_id: id,
				name: '',
				state: 'active',
				conversation_id: group,
				meeting_id,
				kind: 'meeting',
				started_at: new Date().toISOString(),
				media: 'video',
				topology: 'sfu',
				initiatorId: ana._id,
				participantIds: [],
				legs: [],
				v: 0,
			});
			const meeting_call = call_from_row(row);
			const attach = (user: ImperiumDoc, role: RoomRole) =>
				run_room_command(
					id,
					{
						type: 'attach',
						member: {
							member_key: `u:${user._id}`,
							leg_id: `leg-${user._id}`,
							name: String(user.name),
							role,
							media: { mic: false, cam: false, screen: false, audio_only: false },
							hard_muted: false,
							speaker: false,
							session_id: `s-${user._id}`,
						},
					},
					{ meeting_id },
				);
			attach(ana, 'host');
			attach(beto, 'participant');
			const token = async (user: ImperiumDoc) =>
				post(user, 'sfu_token', `/${id}/sfu-token`, { leg_id: `leg-${user._id}` }, id);
			const host = claims_of((await token(ana)).body.data[0]!.token);
			expect(host.video).toMatchObject({ canPublish: true, canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio'] });
			expect(host.metadata).toBe('{"role":"host"}');
			const student = claims_of((await token(beto)).body.data[0]!.token);
			expect(student.video).toMatchObject({ canPublish: false, canPublishSources: [] });
			const outsider = await token(carla);
			expect([outsider.status, outsider.body.code]).toEqual([403, 'not_member']);
			await impose_on_sfu(st, meeting_call, { type: 'mute', member_key: `u:${beto._id}`, sources: ['microphone'] });
			await impose_on_sfu(st, meeting_call, { type: 'grants', member_key: `u:${beto._id}` });
			await impose_on_sfu(st, meeting_call, { type: 'remove', member_key: `u:${beto._id}` });
			expect(sfu.seen.map((item) => [item.method, item.body.identity, item.body.track_sid])).toEqual([
				['GetParticipant', `u:${beto._id}:leg-${beto._id}`, undefined],
				['MutePublishedTrack', `u:${beto._id}:leg-${beto._id}`, 'TR_mic'],
				['UpdateParticipant', `u:${beto._id}:leg-${beto._id}`, undefined],
				['RemoveParticipant', `u:${beto._id}:leg-${beto._id}`, undefined],
			]);
			expect(sfu.seen[2]!.body.permission).toEqual({ can_subscribe: true, can_publish: false, can_publish_data: true, can_publish_sources: [] });
			await impose_on_sfu(st, { ...meeting_call, topology: 'mesh' }, { type: 'remove', member_key: `u:${ana._id}` });
			expect(sfu.seen).toHaveLength(4);
			run_room_command(id, { type: 'detach', leg_id: `leg-${ana._id}` });
			run_room_command(id, { type: 'detach', leg_id: `leg-${beto._id}` });
		} finally {
			sfu.stop();
		}
	});

	test('con SFU, expulsar desde la reunión saca del servidor de medios cada pata de quien sale', async () => {
		const sfu = fake_sfu();
		try {
			const meeting_id = track('chat-meetings', hex_id());
			await st.insert('chat-meetings', {
				_id: meeting_id,
				name: 'Con expulsión en SFU',
				state: 'live',
				code: `exp-${hex_id().slice(0, 4)}-sfu`,
				host_id: ana._id,
				v: 0,
			});
			const id = track('chat-calls', hex_id());
			await st.insert('chat-calls', {
				_id: id,
				name: '',
				state: 'active',
				conversation_id: group,
				meeting_id,
				kind: 'meeting',
				started_at: new Date().toISOString(),
				media: 'video',
				topology: 'sfu',
				initiatorId: ana._id,
				participantIds: [],
				legs: [],
				v: 0,
			});
			const attach = (user: ImperiumDoc, leg_id: string, role: RoomRole) =>
				run_room_command(
					id,
					{
						type: 'attach',
						member: {
							member_key: `u:${user._id}`,
							leg_id,
							name: String(user.name),
							role,
							media: { mic: false, cam: false, screen: false, audio_only: false },
							hard_muted: false,
							speaker: false,
							session_id: `s-${leg_id}`,
						},
					},
					{ meeting_id },
				);
			attach(ana, `leg-${ana._id}`, 'host');
			attach(beto, 'beto-1', 'participant');
			attach(beto, 'beto-2', 'participant');
			await run_host_command(st, id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'kick', member_key: `u:${beto._id}`, block: false });
			await sfu.until('RemoveParticipant');
			expect(sfu.seen.filter((item) => item.method === 'RemoveParticipant').map((item) => item.body)).toEqual([
				{ room: `imperium-${id}`, identity: `u:${beto._id}:beto-1` },
				{ room: `imperium-${id}`, identity: `u:${beto._id}:beto-2` },
			]);
			run_room_command(id, { type: 'detach', leg_id: `leg-${ana._id}` });
		} finally {
			sfu.stop();
		}
	});

	test('el token del SFU es para la pata unida de esa llamada', async () => {
		Object.assign(process.env, SECRETS);
		const id = call_id(await start(ana, direct));
		const other = await post(ana, 'sfu_token', `/${id}/sfu-token`, { leg_id: 'otra' }, id);
		expect([other.status, other.body.code]).toEqual([403, 'not_member']);
		const issued = await post(ana, 'sfu_token', `/${id}/sfu-token`, { leg_id: `leg-${ana._id}` }, id);
		expect(issued.body.data[0]).toMatchObject({ url: SECRETS.IMPERIUM_SFU_URL });
		const claims = JSON.parse(Buffer.from(String(issued.body.data[0]!.token).split('.')[1]!, 'base64url').toString());
		expect(claims).toMatchObject({ sub: `u:${ana._id}:leg-${ana._id}`, video: { room: `imperium-${id}` } });
		delete process.env.IMPERIUM_SFU_URL;
		const missing = await post(ana, 'sfu_token', `/${id}/sfu-token`, { leg_id: `leg-${ana._id}` }, id);
		expect([missing.status, missing.body.code]).toEqual([503, 'sfu_unavailable']);
		expect((await post(ana, 'cancel_call', `/${id}/cancel`, {}, id)).status).toBe(200);
	});

	test('webhook del SFU: solo con su firma, y saca a quien entra sin una pata viva en la sala', async () => {
		const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
		const signed = (payload: ImperiumDoc, secret = SECRETS.IMPERIUM_SFU_API_SECRET) => {
			const now = Math.floor(Date.now() / 1000);
			const claims = { iss: SECRETS.IMPERIUM_SFU_API_KEY, nbf: now, exp: now + 300, sha256: createHash('sha256').update(JSON.stringify(payload)).digest('base64') };
			const head = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
			return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
		};
		const webhook = (payload: ImperiumDoc, authorization = signed(payload)) =>
			call(st, null, 'sfu_webhook', '/sfu-webhook', {
				method: 'POST',
				json: payload,
				headers: { authorization, 'content-type': 'application/webhook+json' },
			});
		const meeting_id = track('chat-meetings', hex_id());
		await st.insert('chat-meetings', { _id: meeting_id, name: 'Reunión del webhook', state: 'live', code: `whk-${hex_id().slice(0, 4)}-xyz`, host_id: ana._id, v: 0 });
		const id = track('chat-calls', hex_id());
		await st.insert('chat-calls', {
			_id: id,
			name: '',
			state: 'active',
			conversation_id: group,
			meeting_id,
			kind: 'meeting',
			started_at: new Date().toISOString(),
			media: 'video',
			topology: 'sfu',
			initiatorId: ana._id,
			participantIds: [],
			legs: [],
			v: 0,
		});
		for (const [user, role] of [
			[ana, 'host'],
			[beto, 'participant'],
		] as const) {
			run_room_command(
				id,
				{
					type: 'attach',
					member: {
						member_key: `u:${user._id}`,
						leg_id: `leg-${user._id}`,
						name: String(user.name),
						role,
						media: { mic: false, cam: false, screen: false, audio_only: false },
						hard_muted: false,
						speaker: false,
						session_id: `s-${user._id}`,
					},
				},
				{ meeting_id },
			);
		}
		const joined = (user: ImperiumDoc) => ({
			event: 'participant_joined',
			room: { sid: 'RM_x', name: `imperium-${id}` },
			participant: { sid: 'PA_x', identity: `u:${user._id}:leg-${user._id}` },
			id: 'EV_x',
		});
		for (const key of ['IMPERIUM_SFU_URL', 'IMPERIUM_SFU_API_KEY', 'IMPERIUM_SFU_API_SECRET']) delete process.env[key];
		expect((await webhook(joined(beto))).status).toBe(404);
		const sfu = fake_sfu();
		try {
			const forged = await webhook(joined(beto), signed(joined(beto), 'otro-secreto'));
			expect([forged.status, forged.body.code]).toEqual([401, 'invalid_signature']);
			const altered = await webhook(joined(eva), signed(joined(beto)));
			expect([altered.status, altered.body.code]).toEqual([401, 'invalid_signature']);
			expect((await webhook(joined(beto))).status).toBe(200);
			expect(sfu.seen).toEqual([]);
			run_room_command(id, { type: 'expel', member_key: `u:${beto._id}`, block: true }, { meeting_id });
			expect((await webhook(joined(beto))).status).toBe(200);
			expect(sfu.seen.map((item) => [item.method, item.body])).toEqual([
				['RemoveParticipant', { room: `imperium-${id}`, identity: `u:${beto._id}:leg-${beto._id}` }],
			]);
			run_room_command(id, { type: 'detach', leg_id: `leg-${ana._id}` });
		} finally {
			sfu.stop();
		}
	});
});
