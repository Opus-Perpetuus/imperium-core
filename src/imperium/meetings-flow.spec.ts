/**
 * Reuniones por las rutas: el código y los ajustes con un almacén falso de parámetros; el resto
 * contra Postgres real (`DATABASE_URL`), con ids aleatorios y limpieza al final.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as path_join } from 'node:path';
import { handle_action } from './actions.ts';
import { admitted_person, attendance_enter, room_state, run_room_command, save_caption, TRANSCRIPT_FLUSH } from './call-room.ts';
import { call_from_row, sweep_calls } from './calls-flow.ts';
import { assert_attachment_access } from './chat-access.ts';
import type { ImperiumDoc } from './envelope.ts';
import {
	advance_recurring_meetings,
	breakouts_tick,
	discard_stale_recordings,
	guest_media_reader,
	MEETING_CODE,
	new_meeting_code,
	remind_due_meetings,
	run_host_command,
} from './meetings-flow.ts';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { sign_realtime_token, verify_realtime_token } from './realtime-tokens.ts';
import { bind_socket_identity_resolver, handle_socket_io } from './socket-stub.ts';
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
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

type Reply = { status: number; body: { data: ImperiumDoc[]; code?: string } & Record<string, unknown>; text?: string; headers?: Headers };

async function call(
	st: ImperiumStore,
	actor: ImperiumDoc | null,
	action: string,
	path: string,
	init: {
		method?: string;
		params?: Record<string, string>;
		json?: unknown;
		form?: FormData;
		resource?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<Reply> {
	const resource = init.resource ?? 'chat-meetings';
	const url = new URL(`http://core/api/${resource}${path}`);
	const headers: Record<string, string> = { ...init.headers };
	if (init.json !== undefined) headers['content-type'] = 'application/json';
	const req = new Request(url, {
		method: init.method ?? 'GET',
		headers,
		body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
	});
	try {
		const res = await handle_action(st, {} as Bun.SQL, req, url, resource, action, init.params ?? {}, actor);
		const text = await res.text();
		const json = res.headers.get('content-type')?.includes('json') ? (JSON.parse(text) as Reply['body']) : { data: [] };
		return { status: res.status, body: json, text, headers: res.headers };
	} catch (err) {
		const e = err as { status?: number; code?: string; message: string; details?: unknown };
		return { status: e.status ?? 500, body: { data: [], code: e.code, message: e.message, details: e.details } };
	}
}

function params_store(values: Record<string, unknown>): ImperiumStore {
	return {
		has: (resource: string) => resource === 'configuration',
		find_many: async () => ({ rows: Object.entries(values).map(([_ref, value]) => ({ _ref, value })), total: 0 }),
	} as unknown as ImperiumStore;
}

describe('código de la reunión', () => {
	test('xxx-xxxx-xxx sin caracteres que se confunden al dictarlo', () => {
		for (let i = 0; i < 500; i++) {
			const code = new_meeting_code();
			expect(code).toMatch(MEETING_CODE);
			expect(code).not.toMatch(/[01oil]/);
		}
	});

	test('con las llamadas apagadas no se crea ni se lista ninguna reunión', async () => {
		const off = params_store({ 'configuration-calls-enabled': false });
		const ana = { _id: hex_id(), name: 'Ana' };
		const made = await call(off, ana, 'create_meeting', '/', { method: 'POST', json: { title: 'Plan' } });
		expect([made.status, made.body.code]).toEqual([403, 'calls_disabled']);
		const mine = await call(off, ana, 'read_my_meetings', '/mine');
		expect([mine.status, mine.body.code]).toEqual([403, 'calls_disabled']);
		const guest = sign_realtime_token({ t: 'guest', gid: hex_id(), mid: hex_id(), name: 'Invitada', exp: Math.floor(Date.now() / 1000) + 600 });
		const ticket = await call(off, null, 'guest_ticket', '/guest/ticket', {
			method: 'POST',
			headers: { cookie: `imperium_invitado=${encodeURIComponent(guest)}` },
		});
		expect([ticket.status, ticket.body.code]).toEqual([403, 'calls_disabled']);
	});
});

afterAll(async () => {
	if (!sql || !store) return;
	for (const [resource, ids] of Object.entries(created)) {
		await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [ids]);
	}
	await sql.close();
}, 120_000);

describe.skipIf(!sql)('reuniones en Postgres', () => {
	const db = sql!;
	const st = store!;
	const people: ImperiumDoc[] = ['Ana', 'Beto', 'Carla', 'Darío', 'Eva'].map((name) => ({ _id: hex_id(), name: `${name} Reunión` }));
	const [ana, beto, carla, dario, eva] = people as [ImperiumDoc, ImperiumDoc, ImperiumDoc, ImperiumDoc, ImperiumDoc];

	const create = (actor: ImperiumDoc, json: ImperiumDoc) => call(st, actor, 'create_meeting', '/', { method: 'POST', json });
	const made = (reply: Reply) => {
		expect(reply.status).toBe(200);
		const view = reply.body.data[0]!;
		track('chat-meetings', String(view._id));
		track('chat-conversations', String(view.conversation_id));
		return view;
	};
	const update = (actor: ImperiumDoc, id: string, json: ImperiumDoc) =>
		call(st, actor, 'update_meeting', `/${id}`, { method: 'PUT', json, params: { id } });
	const read = (actor: ImperiumDoc, id: string) => call(st, actor, 'read_meeting', `/${id}`, { params: { id } });
	const members = async (conversation_id: string) =>
		Object.fromEntries(
			((await db.unsafe(
				`SELECT user_id, role FROM ${st.qt('chat-members')} WHERE conversation_id = $1 AND state = 'active'`,
				[conversation_id],
			)) as Array<{ user_id: string; role: string }>).map((row) => [row.user_id, row.role]),
		);
	const systems = async (conversation_id: string) =>
		((await db.unsafe(
			`SELECT payload FROM ${st.qt('messages')} WHERE conversation_id = $1 AND kind = 'system' ORDER BY seq`,
			[conversation_id],
		)) as Array<{ payload: ImperiumDoc }>).map((row) => String((row.payload.system as ImperiumDoc).type));
	const notes = async (user: ImperiumDoc, type: string, meeting_id: string) =>
		((await db.unsafe(
			`SELECT payload FROM ${st.qt('notifications')} WHERE payload ->> 'recipientId' = $1 AND payload ->> 'type' = $2
			   AND payload ->> 'meeting_id' = $3`,
			[user._id, type, meeting_id],
		)) as unknown[]).length;

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
	}, 120_000);

	afterAll(async () => {
		const collect = async (resource: string, where: string, value: string) => {
			const rows = (await db.unsafe(`SELECT id FROM ${st.qt(resource)} WHERE ${where}`, [value])) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		};
		for (const id of [...(created['chat-conversations'] ?? [])]) {
			for (const resource of ['messages', 'chat-members']) await collect(resource, 'conversation_id = $1', id);
		}
		for (const user of people) await collect('notifications', `payload ->> 'recipientId' = $1`, String(user._id));
	}, 120_000);

	test('crear: la conversación con sus roles, el aviso en ella y la invitación a cada invitado', async () => {
		const start = minutes(24 * 60);
		const view = made(
			await create(ana, {
				title: 'Clase de álgebra',
				description: 'Unidad 3',
				profile: 'clase',
				start_at: start,
				duration_min: 50,
				invitee_ids: [beto._id],
				cohost_ids: [carla._id],
				settings: { private_chat: true, guests_allowed: true },
			}),
		);
		expect(view).toMatchObject({
			state: 'scheduled',
			title: 'Clase de álgebra',
			host_id: ana._id,
			host: { _id: ana._id, name: ana.name },
			my_role: 'host',
			profile: 'clase',
			persistent: false,
			start_at: start,
			next_start_at: start,
			duration_min: 50,
			ics_sequence: 0,
			cohost_ids: [carla._id],
			invitee_ids: [beto._id],
		});
		expect(view.join_url).toBe(`/reunion/${view.code}`);
		expect(String(view.code)).toMatch(MEETING_CODE);
		expect(String(view.ics_uid)).toBe(`${view._id}@core`);
		expect([...(view.member_ids as string[])].sort()).toEqual([ana._id, beto._id, carla._id].sort() as string[]);
		// En clase nunca hay chat privado, aunque se pida.
		expect(view.settings).toMatchObject({ private_chat: false, guests_allowed: true, screen_share: 'hosts', wait_for_host: true });
		const conversation = (await st.find_id('chat-conversations', String(view.conversation_id)))!;
		expect(conversation).toMatchObject({ kind: 'meeting', name: 'Clase de álgebra', meetingId: view._id });
		expect(conversation.conversation_key).toBe(`conv:${view.conversation_id}`);
		expect(await members(String(view.conversation_id))).toEqual({
			[String(ana._id)]: 'owner',
			[String(carla._id)]: 'admin',
			[String(beto._id)]: 'member',
		});
		expect(await systems(String(view.conversation_id))).toEqual(['meeting_scheduled']);
		expect(await notes(beto, 'meeting-invite', String(view._id))).toBe(1);
		expect(await notes(carla, 'meeting-invite', String(view._id))).toBe(1);
		expect(await notes(ana, 'meeting-invite', String(view._id))).toBe(0);
		const stored = (await st.find_id('chat-meetings', String(view._id)))!;
		expect(stored).toMatchObject({ v: 0, memberIds: view.member_ids, settings: { privateChat: false } });
	});

	test('lo que no cuadra se rechaza con su código', async () => {
		expect((await create(ana, { description: 'sin título' })).body.code).toBe('invalid_request');
		expect((await create(ana, { title: 'x', recurrence: { freq: 'daily', by_day: ['MO'] } })).body.code).toBe('invalid_request');
		expect((await create(ana, { title: 'x', persistent: true, recurrence: { freq: 'weekly' } })).body.code).toBe('invalid_request');
		expect((await create(ana, { title: 'x', recurrence: { freq: 'weekly', count: 3, until: minutes(9000) } })).body.code).toBe(
			'invalid_request',
		);
		expect((await create(ana, { title: 'x', settings: { lobby: 'todos' } })).body.code).toBe('invalid_request');
		const ghost = await create(ana, { title: 'x', invitee_ids: [hex_id()] });
		expect([ghost.status, ghost.body.code]).toEqual([404, 'user_not_found']);
	});

	test('leer: solo los miembros; un id que no existe es meeting_not_found', async () => {
		const view = made(await create(ana, { title: 'Privada', start_at: minutes(120), invitee_ids: [beto._id] }));
		const id = String(view._id);
		expect((await read(beto, id)).body.data[0]).toMatchObject({ _id: id, my_role: 'participant' });
		expect((await read(dario, id)).body.code).toBe('not_member');
		expect((await read(beto, hex_id())).body.code).toBe('meeting_not_found');
	});

	test('editar: el coanfitrión cambia lo de la reunión pero no nombra coanfitriones; sube SEQUENCE y entra el nuevo invitado', async () => {
		const view = made(
			await create(ana, { title: 'Comité', start_at: minutes(300), invitee_ids: [beto._id], cohost_ids: [carla._id] }),
		);
		const id = String(view._id);
		expect((await update(beto, id, { title: 'Otro' })).body.code).toBe('not_host');
		expect((await update(dario, id, { title: 'Otro' })).body.code).toBe('not_member');
		expect((await update(carla, id, { cohost_ids: [beto._id] })).body.code).toBe('not_host');
		await db.unsafe(
			`UPDATE ${st.qt('chat-meetings')} SET payload = payload || jsonb_build_object('remindedFor', next_start_at) WHERE id = $1`,
			[id],
		);
		const moved = minutes(600);
		const edited = await update(carla, id, { title: 'Comité de obra', start_at: moved, invitee_ids: [beto._id, dario._id] });
		expect(edited.status).toBe(200);
		expect(edited.body.data[0]).toMatchObject({ title: 'Comité de obra', next_start_at: moved, ics_sequence: 1, my_role: 'cohost' });
		expect((await st.find_id('chat-meetings', id))!.remindedFor).toBeNull();
		const conversation = String(view.conversation_id);
		expect((await members(conversation))[String(dario._id)]).toBe('member');
		expect((await st.find_id('chat-conversations', conversation))!.name).toBe('Comité de obra');
		expect(await notes(dario, 'meeting-invite', id)).toBe(1);
		expect(await systems(conversation)).toEqual(['meeting_scheduled', 'meeting_updated']);
		const dropped = await update(ana, id, { invitee_ids: [dario._id], cohost_ids: [] });
		expect(dropped.body.data[0]).toMatchObject({ ics_sequence: 2, cohost_ids: [] });
		expect(await members(conversation)).toEqual({ [String(ana._id)]: 'owner', [String(dario._id)]: 'member' });
	});

	test('cancelar: solo el anfitrión; queda el aviso y la invitación pasa a CANCEL', async () => {
		const view = made(await create(ana, { title: 'Se cae', start_at: minutes(200), cohost_ids: [carla._id] }));
		const id = String(view._id);
		const cancel = (actor: ImperiumDoc) => call(st, actor, 'cancel_meeting', `/${id}/cancel`, { method: 'POST', params: { id } });
		expect((await cancel(carla)).body.code).toBe('not_host');
		const done = await cancel(ana);
		expect(done.body.data[0]).toMatchObject({ state: 'cancelled', ics_sequence: 1 });
		expect((await cancel(ana)).body.data[0]).toMatchObject({ state: 'cancelled', ics_sequence: 1 });
		expect(await systems(String(view.conversation_id))).toEqual(['meeting_scheduled', 'meeting_cancelled']);
		expect(await notes(carla, 'meeting-cancelled', id)).toBe(1);
		expect((await update(ana, id, { title: 'Revive' })).body.code).toBe('meeting_cancelled');
		const ics = await call(st, carla, 'meeting_ics', `/${id}/invite.ics`, { params: { id } });
		expect(ics.text).toContain('METHOD:CANCEL');
		expect(ics.text).toContain('SEQUENCE:1');
	});

	test('editar con recurrence null quita la repetición: no queda en la reunión ni en el .ics', async () => {
		const start = minutes(60);
		const view = made(await create(ana, { title: 'Diaria que se acaba', start_at: start, recurrence: { freq: 'daily', count: 5 } }));
		const id = String(view._id);
		expect(view.recurrence).toEqual({ freq: 'daily', count: 5 });
		await db.unsafe(`UPDATE ${st.qt('chat-meetings')} SET payload = payload || '{"remindedFor": "x"}'::jsonb WHERE id = $1`, [id]);
		const plain = await update(ana, id, { recurrence: null });
		expect(plain.status).toBe(200);
		expect(plain.body.data[0]!.recurrence).toBeUndefined();
		expect(plain.body.data[0]).toMatchObject({ start_at: start, next_start_at: start, ics_sequence: 1 });
		expect((await st.find_id('chat-meetings', id))!).toMatchObject({ recurrence: null, remindedFor: null });
		expect((await update(ana, id, { title: 'Ya no se repite' })).body.data[0]!.recurrence).toBeUndefined();
		const ics = await call(st, ana, 'meeting_ics', `/${id}/invite.ics`, { params: { id } });
		expect(ics.text).not.toContain('RRULE');
	});

	test('invitación .ics: UID estable, SEQUENCE, recurrencia, enlace absoluto y solo para miembros', async () => {
		const view = made(
			await create(ana, {
				title: 'Seguimiento',
				start_at: '2030-03-04T16:00:00.000Z',
				duration_min: 30,
				recurrence: { freq: 'weekly', by_day: ['MO', 'WE'], count: 8 },
				invitee_ids: [beto._id],
			}),
		);
		const id = String(view._id);
		const ics = await call(st, beto, 'meeting_ics', `/${id}/invite.ics`, {
			params: { id },
			headers: { host: 'empresa.test', 'x-forwarded-proto': 'https' },
		});
		expect(ics.status).toBe(200);
		expect(ics.headers!.get('content-type')).toContain('text/calendar');
		expect(ics.headers!.get('content-disposition')).toBe(`attachment; filename="reunion-${view.code}.ics"`);
		const lines = ics.text!.replace(/\r\n /g, '').split('\r\n');
		expect(lines).toContain('METHOD:REQUEST');
		expect(lines).toContain(`UID:${view.ics_uid}`);
		expect(lines).toContain('SEQUENCE:0');
		expect(lines).toContain('DTSTART:20300304T160000Z');
		expect(lines).toContain('DTEND:20300304T163000Z');
		expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=8');
		expect(lines).toContain(`URL:https://empresa.test/reunion/${view.code}`);
		expect(lines).toContain(`ORGANIZER;CN=${ana.name}:mailto:${ana._id}@empresa.com`);
		expect(lines.some((line) => line.startsWith('ATTENDEE;') && line.endsWith(`mailto:${beto._id}@empresa.com`))).toBe(true);
		expect((await call(st, dario, 'meeting_ics', `/${id}/invite.ics`, { params: { id } })).body.code).toBe('not_member');
	});

	test('mis reuniones por pestaña, con cursor; la inmediata empieza ahora y la sala permanente va en Salas', async () => {
		const soon = made(await create(eva, { title: 'Pronto', start_at: minutes(60) }));
		const later = made(await create(eva, { title: 'Después', start_at: minutes(180) }));
		const now_view = made(await create(eva, { title: 'Ya' }));
		const room = made(await create(eva, { title: 'Sala de guardia', persistent: true }));
		const past = made(await create(eva, { title: 'Ayer', start_at: minutes(-24 * 60) }));
		expect(Math.abs(Date.parse(String(now_view.start_at)) - Date.now())).toBeLessThan(60_000);
		expect(room.next_start_at).toBeUndefined();
		const mine = (scope: string, cursor = '', limit = 50) =>
			call(st, eva, 'read_my_meetings', `/mine?scope=${scope}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
		const proximas = await mine('proximas');
		expect(proximas.body.data.map((row) => row._id)).toEqual([now_view._id, soon._id, later._id]);
		const first = await mine('proximas', '', 1);
		expect(first.body.data.map((row) => row._id)).toEqual([now_view._id]);
		const second = await mine('proximas', String(first.body.next_cursor), 1);
		expect(second.body.data.map((row) => row._id)).toEqual([soon._id]);
		expect((await mine('salas')).body.data.map((row) => row._id)).toEqual([room._id]);
		expect((await mine('pasadas')).body.data.map((row) => row._id)).toEqual([past._id]);
		expect((await mine('todas')).body.code).toBe('invalid_request');
		expect((await mine('proximas', 'basura')).body.code).toBe('invalid_cursor');
	});

	test('recordatorio a 10 minutos: una vez por ocurrencia, a cada miembro', async () => {
		const view = made(await create(ana, { title: 'En un rato', start_at: minutes(8), invitee_ids: [beto._id] }));
		const id = String(view._id);
		await remind_due_meetings(st, new Date());
		await remind_due_meetings(st, new Date());
		expect(await notes(beto, 'meeting-reminder', id)).toBe(1);
		expect(await notes(ana, 'meeting-reminder', id)).toBe(1);
		expect((await st.find_id('chat-meetings', id))!.remindedFor).toBe(view.next_start_at);
	});

	test('una serie pasa a su siguiente ocurrencia al terminar la vigente y se cierra al acabarse', async () => {
		const start = new Date(Date.now() - 15 * 24 * 3600_000);
		start.setUTCSeconds(0, 0);
		const view = made(
			await create(ana, { title: 'Diaria', start_at: start.toISOString(), duration_min: 30, recurrence: { freq: 'daily', count: 30 } }),
		);
		const id = String(view._id);
		// La ocurrencia vigente ya cuenta desde hoy: se fuerza la primera para ver el salto.
		await db.unsafe(`UPDATE ${st.qt('chat-meetings')} SET next_start_at = $2 WHERE id = $1`, [id, start.toISOString()]);
		await advance_recurring_meetings(st, new Date());
		const next = String((await st.find_id('chat-meetings', id))!.next_start_at);
		expect(Date.parse(next) - start.getTime()).toBe(24 * 3600_000);
		const last = new Date(start.getTime() + 29 * 24 * 3600_000).toISOString();
		await db.unsafe(`UPDATE ${st.qt('chat-meetings')} SET next_start_at = $2 WHERE id = $1`, [id, last]);
		await advance_recurring_meetings(st, new Date(Date.parse(last) + 3600_000));
		expect((await st.find_id('chat-meetings', id))!).toMatchObject({ next_start_at: last, recurrenceDone: true });
	});
});

/** El almacén real con algunos parámetros encima: los demás procesos no ven el cambio. */
function with_params(st: ImperiumStore, values: Record<string, unknown>): ImperiumStore {
	return new Proxy(st, {
		get(target, prop) {
			if (prop === 'find_many') {
				return async (resource: string, opts: Parameters<ImperiumStore['find_many']>[1]) =>
					resource === 'configuration'
						? { rows: Object.entries(values).map(([_ref, value]) => ({ _ref, value })), total: 0 }
						: target.find_many(resource, opts);
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

describe.skipIf(!sql)('invitados, sala de espera y anfitrión en Postgres', () => {
	const db = sql!;
	const people: ImperiumDoc[] = ['Ana', 'Beto', 'Darío'].map((name) => ({ _id: hex_id(), name: `${name} Sala` }));
	const [ana, beto, dario] = people as [ImperiumDoc, ImperiumDoc, ImperiumDoc];
	const eva_outsider: ImperiumDoc = { _id: hex_id(), name: 'Eva Fuera' };
	const st = sql ? with_params(store!, { 'configuration-meetings-guests-enabled': true }) : store!;
	const off = sql ? with_params(store!, {}) : store!;

	const create = (json: ImperiumDoc) => call(st, ana, 'create_meeting', '/', { method: 'POST', json });
	const meeting = async (json: ImperiumDoc) => {
		const reply = await create(json);
		expect(reply.status).toBe(200);
		const view = reply.body.data[0]!;
		track('chat-meetings', String(view._id));
		track('chat-conversations', String(view.conversation_id));
		return view;
	};
	const as_guest = (cookie: string, extra: Record<string, string> = {}) => ({ cookie, ...extra });
	const guest_join = (code: string, name: string, headers: Record<string, string> = {}) =>
		call(st, null, 'guest_join', `/code/${code}/guest`, { method: 'POST', json: { display_name: name }, params: { code }, headers });
	const join = (actor: ImperiumDoc | null, code: string, leg_id: string, headers: Record<string, string> = {}) =>
		call(st, actor, 'join_meeting', `/code/${code}/join`, { method: 'POST', json: { leg_id, media: 'video' }, params: { code }, headers });
	const cookie_of = (reply: Reply) => String(reply.headers!.get('set-cookie')).split(';')[0]!;
	const live = async (meeting_id: string) => (await store!.find_id('chat-meetings', meeting_id))!;
	/** Lo que haría `call:attach`: la pata entra a la sala y empieza su asistencia. */
	const attach = (call_id: string, member_key: string, leg_id: string, role: 'host' | 'participant' | 'guest' = 'participant') => {
		const name = room_state(call_id).admitted.find((item) => item.member_key === member_key)?.name ?? member_key;
		run_room_command(call_id, {
			type: 'attach',
			member: {
				member_key,
				leg_id,
				name,
				role,
				media: { mic: true, cam: false, screen: false, audio_only: false },
				hard_muted: false,
				speaker: false,
				session_id: `s-${leg_id}`,
				...(role === 'guest' ? { guest: true as const } : {}),
			},
		});
		attendance_enter(call_id, { member_key, name, role }, leg_id, Date.now(), false);
	};

	beforeAll(async () => {
		const now = new Date().toISOString();
		for (const user of people) {
			await db.unsafe(
				`INSERT INTO ${store!.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
				 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
				[track('user', String(user._id)), user.name, `${user._id}@empresa.com`, now],
			);
		}
	}, 120_000);

	afterAll(async () => {
		const collect = async (resource: string, where: string, value: string) => {
			const rows = (await db.unsafe(`SELECT id FROM ${store!.qt(resource)} WHERE ${where}`, [value])) as Array<{ id: string }>;
			for (const row of rows) track(resource, row.id);
		};
		for (const id of [...(created['chat-meetings'] ?? [])]) {
			await collect('chat-calls', 'meeting_id = $1', id);
			await collect('chat-meeting-attendance', 'meeting_id = $1', id);
			await collect('chat-meeting-questions', 'meeting_id = $1', id);
			await collect('chat-meeting-transcripts', 'meeting_id = $1', id);
		}
		for (const id of [...(created['chat-conversations'] ?? [])]) {
			for (const resource of ['messages', 'chat-members']) await collect(resource, 'conversation_id = $1', id);
		}
		for (const user of people) await collect('notifications', `payload ->> 'recipientId' = $1`, String(user._id));
	}, 120_000);

	test('invitados apagados en la organización o en la reunión: no hay alta ni entrada', async () => {
		const view = await meeting({ title: 'Sin invitados', start_at: minutes(60), settings: { guests_allowed: true } });
		const code = String(view.code);
		const org_off = await call(off, null, 'guest_join', `/code/${code}/guest`, { method: 'POST', json: { display_name: 'Ivo' }, params: { code } });
		expect([org_off.status, org_off.body.code]).toEqual([403, 'guests_disabled']);
		const closed = await meeting({ title: 'Cerrada', start_at: minutes(60) });
		expect((await guest_join(String(closed.code), 'Ivo')).body.code).toBe('guests_disabled');
		expect((await call(st, null, 'public_summary', '/code/zzz-zzzz-zzz', { params: { code: 'zzz-zzzz-zzz' } })).body.code).toBe(
			'meeting_not_found',
		);
		expect((await join(null, code, 'leg-x')).body.code).toBe('unauthenticated');
		expect((await join({ ...dario, type: 'external' }, code, 'leg-x')).body.code).toBe('unauthenticated');
	});

	test('del enlace a la sala: resumen, alta con cookie, espera, admisión, chat desde la admisión y adjuntos solo de su reunión', async () => {
		const view = await meeting({ title: 'Asamblea', start_at: minutes(30), invitee_ids: [beto._id], settings: { guests_allowed: true } });
		const id = String(view._id);
		const code = String(view.code);
		const summary = await call(st, null, 'public_summary', `/code/${code}`, { params: { code } });
		expect(summary.body.data[0]).toEqual({
			title: 'Asamblea',
			host_name: ana.name,
			start_at: view.next_start_at,
			guests_allowed: true,
			recording_active: false,
			profile: 'reunion',
			state: 'scheduled',
		});
		const joined = await guest_join(code, '  Ivo\u0007  Pérez ', { 'x-forwarded-proto': 'https' });
		expect(joined.status).toBe(200);
		const guest = joined.body.data[0]!;
		expect(guest.name).toBe('Ivo Pérez');
		const set_cookie = String(joined.headers!.get('set-cookie'));
		expect(set_cookie).toMatch(/^imperium_invitado=[^;]+; HttpOnly; Path=\/api; SameSite=Lax; Max-Age=\d+; Secure$/);
		expect(verify_realtime_token(String(guest.socket_ticket), 'socket')).toMatchObject({ gid: guest.guest_id, mid: id });
		const cookie = cookie_of(joined);
		expect((await guest_join(code, 'I')).body.code).toBe('invalid_request');
		const ticket = await call(st, null, 'guest_ticket', '/guest/ticket', { method: 'POST', headers: as_guest(cookie) });
		expect(verify_realtime_token(String(ticket.body.data[0]!.socket_ticket), 'socket')).toMatchObject({ gid: guest.guest_id });

		const waiting = await join(null, code, 'g-leg', as_guest(cookie));
		expect(waiting.body.data[0]).toMatchObject({ state: 'lobby', role: 'guest', member_key: `g:${guest.guest_id}`, topology: 'mesh' });
		const call_id = String((waiting.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		expect(await live(id)).toMatchObject({ state: 'live', activeCallId: call_id });
		expect((await call(st, null, 'guest_read_chat', `/${id}/chat`, { params: { id }, headers: as_guest(cookie) })).body.code).toBe(
			'guest_not_admitted',
		);
		const host = await join(ana, code, 'ana-leg');
		expect(host.body.data[0]).toMatchObject({ state: 'joined', role: 'host', call: { _id: call_id, kind: 'meeting' } });
		const invited = await join(beto, code, 'beto-leg');
		expect(invited.body.data[0]).toMatchObject({ state: 'joined', role: 'participant' });
		attach(call_id, `u:${ana._id}`, 'ana-leg', 'host');
		attach(call_id, `u:${beto._id}`, 'beto-leg');

		const before = await call(st, beto, 'create_chat_message', '/chat', {
			method: 'POST',
			json: { conversation_id: view.conversation_id, client_id: crypto.randomUUID(), text: 'Antes de que entrara' },
			resource: 'messages',
		});
		expect(before.status).toBe(200);
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'admit', member_key: `g:${guest.guest_id}` });
		expect(room_state(call_id).admitted.find((item) => item.member_key === `g:${guest.guest_id}`)!.visible_from_seq).toBe(
			Number(before.body.data[0]!.seq),
		);
		attach(call_id, `g:${guest.guest_id}`, 'g-leg', 'guest');

		const hidden_reply = await call(st, null, 'guest_chat_message', `/${id}/chat`, {
			method: 'POST',
			json: { client_id: crypto.randomUUID(), text: 'Respondo', reply_to_message_id: before.body.data[0]!._id },
			params: { id },
			headers: as_guest(cookie),
		});
		expect([hidden_reply.status, hidden_reply.body.code]).toEqual([422, 'invalid_request']);
		const client_id = crypto.randomUUID();
		const sent = await call(st, null, 'guest_chat_message', `/${id}/chat`, {
			method: 'POST',
			json: { client_id, text: 'Hola, soy Ivo' },
			params: { id },
			headers: as_guest(cookie),
		});
		expect(sent.status).toBe(200);
		expect(sent.body.data[0]).toMatchObject({
			kind: 'text',
			text: 'Hola, soy Ivo',
			sender: { guest: true, participant_key: `g:${guest.guest_id}`, name: 'Ivo Pérez' },
		});
		const again = await call(st, null, 'guest_chat_message', `/${id}/chat`, {
			method: 'POST',
			json: { client_id, text: 'Hola, soy Ivo' },
			params: { id },
			headers: as_guest(cookie),
		});
		expect(again.body.data[0]!._id).toBe(sent.body.data[0]!._id);
		const read = await call(st, null, 'guest_read_chat', `/${id}/chat`, { params: { id }, headers: as_guest(cookie) });
		expect(read.body.data.map((row) => row.text)).toEqual(['Hola, soy Ivo']);
		expect(read.body).toMatchObject({ has_more_before: false });
		const no_files = await call(st, null, 'guest_chat_message', `/${id}/chat`, {
			method: 'POST',
			json: { client_id: crypto.randomUUID(), text: 'x', attachment_ids: [hex_id()] },
			params: { id },
			headers: as_guest(cookie),
		});
		expect(no_files.body.code).toBe('chat_send_denied');
		expect((await call(st, beto, 'guest_read_chat', `/${id}/chat`, { params: { id } })).body.code).toBe('guest_not_admitted');

		const req = new Request('http://core/api/media/x', { headers: { cookie } });
		const reader = guest_media_reader(req);
		expect(reader).toEqual({ conversation_id: String(view.conversation_id), visible_from_seq: Number(before.body.data[0]!.seq) });
		const after_id = String(sent.body.data[0]!._id);
		await assert_attachment_access(store!, null, { related_model: 'Message', related_record_id: after_id }, { guest: reader });
		await expect(
			assert_attachment_access(store!, null, { related_model: 'Message', related_record_id: String(before.body.data[0]!._id) }, { guest: reader }),
		).rejects.toMatchObject({ code: 'attachment_forbidden' });
		await expect(assert_attachment_access(store!, null, { related_model: 'Product', related_record_id: hex_id() }, { guest: reader })).rejects.toMatchObject({
			code: 'attachment_forbidden',
		});
		expect(guest_media_reader(new Request('http://core/api/media/x'))).toBeNull();

		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'kick', member_key: `g:${guest.guest_id}`, block: true });
		expect((await live(id)).blockedKeys).toEqual([`g:${guest.guest_id}`]);
		expect((await join(null, code, 'g-leg', as_guest(cookie))).body.code).toBe('expelled');
		expect((await guest_join(code, 'Ivo de nuevo', as_guest(cookie))).body.code).toBe('expelled');
		expect(guest_media_reader(req)).toBeNull();
		const attendance = (await db.unsafe(
			`SELECT participant_key, payload FROM ${store!.qt('chat-meeting-attendance')} WHERE call_id = $1`,
			[call_id],
		)) as Array<{ participant_key: string; payload: ImperiumDoc }>;
		expect(attendance.find((row) => row.participant_key === `g:${guest.guest_id}`)!.payload).toMatchObject({
			guestId: guest.guest_id,
			displayName: 'Ivo Pérez',
			role: 'guest',
			outcome: 'expelled',
			visibleFromSeq: Number(before.body.data[0]!.seq),
		});

		await expect(
			run_host_command(store!, call_id, { member_key: `u:${beto._id}`, role: 'participant' }, { type: 'end' }),
		).rejects.toMatchObject({ code: 'not_host' });
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
		expect(call_from_row((await store!.find_id('chat-calls', call_id))!)).toMatchObject({ state: 'ended', end_reason: 'ended_by_host' });
		const ended = await live(id);
		expect(ended.state).toBe('scheduled');
		expect(ended.activeCallId).toBeNull();
		const rows = (await db.unsafe(
			`SELECT participant_key, payload FROM ${store!.qt('chat-meeting-attendance')} WHERE call_id = $1 ORDER BY participant_key`,
			[call_id],
		)) as Array<{ participant_key: string; payload: ImperiumDoc }>;
		expect(rows.map((row) => row.participant_key).sort()).toEqual([`g:${guest.guest_id}`, `u:${ana._id}`, `u:${beto._id}`].sort());
		expect(rows.find((row) => row.participant_key === `u:${ana._id}`)!.payload).toMatchObject({ role: 'host', userId: ana._id });
		expect((rows.find((row) => row.participant_key === `u:${ana._id}`)!.payload.intervals as unknown[]).length).toBe(1);
	});

	test('quien no está invitado espera y al entrar queda en el chat; sin sala de espera no entra', async () => {
		const open = await meeting({ title: 'Abierta', start_at: minutes(30), settings: { lobby: 'guests' } });
		const code = String(open.code);
		const waiting = await join(dario, code, 'dario-leg');
		expect(waiting.body.data[0]).toMatchObject({ state: 'lobby', role: 'participant' });
		const call_id = String((waiting.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		await join(ana, code, 'ana-leg');
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'admit', member_key: `u:${dario._id}` });
		const [member] = (await db.unsafe(
			`SELECT role, state FROM ${store!.qt('chat-members')} WHERE conversation_id = $1 AND user_id = $2`,
			[open.conversation_id, dario._id],
		)) as Array<{ role: string; state: string }>;
		expect(member).toEqual({ role: 'member', state: 'active' });
		const id = String(open._id);
		await call(st, ana, 'update_meeting', `/${id}`, { method: 'PUT', json: { title: 'Abierta 2' }, params: { id } });
		const [kept] = (await db.unsafe(
			`SELECT role, state FROM ${store!.qt('chat-members')} WHERE conversation_id = $1 AND user_id = $2`,
			[open.conversation_id, dario._id],
		)) as Array<{ role: string; state: string }>;
		expect(kept).toEqual({ role: 'member', state: 'active' });
		expect((await join(dario, code, 'dario-leg')).body.data[0]).toMatchObject({ state: 'joined' });
		const strict = await meeting({ title: 'Solo invitados', start_at: minutes(30), settings: { lobby: 'none' } });
		expect((await join(dario, String(strict.code), 'dario-leg')).body.code).toBe('not_invited');
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
	});

	test('expulsar a quien entró por el código lo saca del chat de la reunión y de su transcripción; a un invitado no', async () => {
		const view = await meeting({
			title: 'Con expulsión',
			start_at: minutes(30),
			invitee_ids: [beto._id],
			settings: { lobby: 'guests', captions: true, save_transcript: true },
		});
		const id = String(view._id);
		const code = String(view.code);
		const conversation_id = String(view.conversation_id);
		const call_id = String(((await join(ana, code, 'ana-leg')).body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		const host = { member_key: `u:${ana._id}`, role: 'host' as const };
		expect((await join(beto, code, 'beto-leg')).body.data[0]).toMatchObject({ state: 'joined' });
		expect((await join(dario, code, 'dario-leg')).body.data[0]).toMatchObject({ state: 'lobby' });
		await run_host_command(store!, call_id, host, { type: 'admit', member_key: `u:${dario._id}` });
		const state_of = async (user: ImperiumDoc) =>
			((await db.unsafe(`SELECT state FROM ${store!.qt('chat-members')} WHERE conversation_id = $1 AND user_id = $2`, [
				conversation_id,
				user._id,
			])) as Array<{ state: string }>)[0]?.state;
		expect(await state_of(dario)).toBe('active');
		save_caption(store!, call_id, id, { start_ms: 0, end_ms: 900, speaker_key: host.member_key, speaker_name: 'Ana', text: 'dato confidencial', lang: 'es' });

		await run_host_command(store!, call_id, host, { type: 'kick', member_key: `u:${dario._id}`, block: true });
		await run_host_command(store!, call_id, host, { type: 'kick', member_key: `u:${beto._id}`, block: true });
		expect([await state_of(dario), await state_of(beto)]).toEqual(['removed', 'active']);
		expect(await store!.chat_member_ids(conversation_id)).not.toContain(dario._id);
		const vtt = (actor: ImperiumDoc) => call(st, actor, 'transcript_vtt', `/${id}/transcript.vtt?call_id=${call_id}`, { params: { id } });
		const denied = await vtt(dario);
		expect([denied.status, denied.body.code]).toEqual([403, 'not_member']);
		expect((await vtt(ana)).text).toContain('dato confidencial');
		await run_host_command(store!, call_id, host, { type: 'end' });
	});

	test('entrar por código sin sesión gasta la cuota por IP antes de decir si el código existe', async () => {
		// La crea Beto: la cuota de creación de Ana es de todo este bloque.
		const view = (await call(st, beto, 'create_meeting', '/', { method: 'POST', json: { title: 'Código real', start_at: minutes(30) } })).body.data[0]!;
		track('chat-meetings', String(view._id));
		track('chat-conversations', String(view.conversation_id));
		const real = String(view.code);
		const from_ip = (actor: ImperiumDoc | null, code: string) => {
			const url = new URL(`http://core/api/chat-meetings/code/${code}/join`);
			const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ leg_id: 'leg-ip', media: 'audio' }) });
			remember_socket_ip(req, '198.51.100.23');
			return handle_action(st, {} as Bun.SQL, req, url, 'chat-meetings', 'join_meeting', { code }, actor).then(
				(res) => res.status,
				(err: { status?: number }) => err.status ?? 500,
			);
		};
		const statuses: number[] = [];
		for (let i = 0; i < 30; i++) statuses.push(await from_ip(null, i % 2 ? real : 'zzz-zzzz-zzz'));
		expect(new Set(statuses)).toEqual(new Set([404, 401]));
		expect([await from_ip(null, 'zzz-zzzz-zzz'), await from_ip(null, real)]).toEqual([429, 429]);
		expect(await from_ip(dario, 'zzz-zzzz-zzz')).toBe(404);
	});

	test('cambiar coanfitriones en la reunión cambia el rol en la sala viva', async () => {
		const view = (await call(st, beto, 'create_meeting', '/', {
			method: 'POST',
			json: { title: 'Roles vivos', start_at: minutes(30), invitee_ids: [dario._id] },
		})).body.data[0]!;
		track('chat-meetings', String(view._id));
		track('chat-conversations', String(view.conversation_id));
		const id = String(view._id);
		const code = String(view.code);
		const call_id = String(((await join(beto, code, 'beto-leg')).body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		expect((await join(dario, code, 'dario-leg')).body.data[0]).toMatchObject({ state: 'joined', role: 'participant' });
		const edit = (cohost_ids: string[]) => call(st, beto, 'update_meeting', `/${id}`, { method: 'PUT', json: { cohost_ids }, params: { id } });
		expect((await edit([String(dario._id)])).status).toBe(200);
		expect(admitted_person(call_id, `u:${dario._id}`)?.role).toBe('cohost');
		expect((await edit([])).status).toBe(200);
		expect(admitted_person(call_id, `u:${dario._id}`)?.role).toBe('participant');
		await run_host_command(store!, call_id, { member_key: `u:${beto._id}`, role: 'host' }, { type: 'end' });
	});

	test('la cookie de invitado de una reunión lejana dura lo que la reunión más una hora, no hasta su fecha', async () => {
		const view = (await call(st, beto, 'create_meeting', '/', {
			method: 'POST',
			json: { title: 'En tres meses', start_at: minutes(90 * 24 * 60), duration_min: 45, settings: { guests_allowed: true } },
		})).body.data[0]!;
		track('chat-meetings', String(view._id));
		track('chat-conversations', String(view.conversation_id));
		const code = String(view.code);
		const url = new URL(`http://core/api/chat-meetings/code/${code}/guest`);
		const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'Lejana' }) });
		remember_socket_ip(req, '198.51.100.24');
		const res = await handle_action(st, {} as Bun.SQL, req, url, 'chat-meetings', 'guest_join', { code }, null);
		expect(res.status).toBe(200);
		const max_age = Number(/Max-Age=(\d+)/.exec(String(res.headers.get('set-cookie')))![1]);
		expect(max_age).toBeGreaterThan(45 * 60);
		expect(max_age).toBeLessThanOrEqual(45 * 60 + 3600);
		const token = decodeURIComponent(String(res.headers.get('set-cookie')).split(';')[0]!.split('=')[1]!);
		const claims = verify_realtime_token(token, 'guest') as { exp: number };
		expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(45 * 60 + 3600);
	});

	test('quien espera en la sala de espera recibe el cierre de la reunión: al terminarla y en el barrido', async () => {
		const POLLING = 'http://imperium.test/api/socket.io/?EIO=4&transport=polling';
		const cookies: Record<string, string> = {};
		bind_socket_identity_resolver(async (session_id) => cookies[session_id] ?? null);
		const socket = async (who: { user_id: string } | { ticket: string }) => {
			const cookie = `espera-${hex_id()}`;
			if ('user_id' in who) cookies[cookie] = who.user_id;
			const req = new Request(POLLING, { headers: { cookie: `connect.sid=${cookie}` } });
			remember_socket_ip(req, '203.0.113.77');
			const sid = (JSON.parse((await (handle_socket_io(req) as Response).text()).slice(1)) as { sid: string }).sid;
			const connect = 'ticket' in who ? `40${JSON.stringify({ ticket: who.ticket })}` : '40';
			await handle_socket_io(new Request(`${POLLING}&sid=${sid}`, { method: 'POST', body: connect }));
			return sid;
		};
		// Sin `guest_join`: su cuota por IP es de todo este archivo.
		const as_new_guest = (meeting_id: unknown, name: string) => {
			const claims = { gid: hex_id(), mid: String(meeting_id), name, exp: Math.floor(Date.now() / 1000) + 3600 };
			return {
				cookie: `imperium_invitado=${encodeURIComponent(sign_realtime_token({ t: 'guest', ...claims }))}`,
				ticket: sign_realtime_token({ t: 'socket', ...claims, n: crypto.randomUUID() }),
			};
		};
		const ended_for = async (sid: string, call_id: string) => {
			const body = await ((await handle_socket_io(new Request(`${POLLING}&sid=${sid}`))) as Response).text();
			return body
				.split('\x1e')
				.filter((packet) => packet.startsWith('42'))
				.map((packet) => JSON.parse(packet.slice(2)) as [string, { action: string; data: ImperiumDoc[] }])
				.some(([event, payload]) => event === 'update' && payload.action === 'call_update' && payload.data[0]?.call_id === call_id && payload.data[0]?.state === 'ended');
		};

		const view = await meeting({ title: 'Con espera', start_at: minutes(30), settings: { guests_allowed: true, lobby: 'guests' } });
		const code = String(view.code);
		const host = await join(ana, code, 'ana-leg');
		const call_id = String((host.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		attach(call_id, `u:${ana._id}`, 'ana-leg', 'host');
		const guest = as_new_guest(view._id, 'Ivo Espera');
		const guest_sid = await socket({ ticket: guest.ticket });
		expect((await join(null, code, 'g-leg', as_guest(guest.cookie))).body.data[0]).toMatchObject({ state: 'lobby' });
		const dario_sid = await socket({ user_id: String(dario._id) });
		expect((await join(dario, code, 'dario-leg')).body.data[0]).toMatchObject({ state: 'lobby' });
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
		expect(await ended_for(guest_sid, call_id)).toBe(true);
		expect(await ended_for(dario_sid, call_id)).toBe(true);

		const hall = await meeting({ title: 'Sala con espera', persistent: true, settings: { guests_allowed: true } });
		const hall_code = String(hall.code);
		const visitor = as_new_guest(hall._id, 'Eva Espera');
		const visitor_sid = await socket({ ticket: visitor.ticket });
		const waiting = await join(null, hall_code, 'e-leg', as_guest(visitor.cookie));
		expect(waiting.body.data[0]).toMatchObject({ state: 'lobby' });
		const hall_call = String((waiting.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', hall_call);
		const later = Date.now() + 11 * 60_000;
		await sweep_calls(store!, later);
		await sweep_calls(store!, later + 31_000);
		expect(call_from_row((await store!.find_id('chat-calls', hall_call))!).state).toBe('ended');
		expect(await ended_for(visitor_sid, hall_call)).toBe(true);
	}, 60_000);

	test('bloqueada no entra nadie más; con «esperar al anfitrión», quien llega antes entra cuando llega', async () => {
		const view = await meeting({ title: 'Clase', start_at: minutes(30), invitee_ids: [beto._id, dario._id], settings: { wait_for_host: true, lobby: 'guests' } });
		const code = String(view.code);
		const early = await join(beto, code, 'beto-leg');
		expect(early.body.data[0]).toMatchObject({ state: 'lobby' });
		const call_id = String((early.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		expect(room_state(call_id).lobby).toMatchObject([{ member_key: `u:${beto._id}`, reason: 'host' }]);
		expect((await join(ana, code, 'ana-leg')).body.data[0]).toMatchObject({ state: 'joined', role: 'host' });
		expect(room_state(call_id).lobby).toEqual([]);
		expect((await join(beto, code, 'beto-leg')).body.data[0]).toMatchObject({ state: 'joined' });
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'lock', locked: true });
		expect((await join(dario, code, 'dario-leg')).body.code).toBe('meeting_locked');
		const cancelled = await call(st, ana, 'cancel_meeting', `/${view._id}/cancel`, { method: 'POST', params: { id: String(view._id) } });
		expect(cancelled.body.data[0]).toMatchObject({ state: 'cancelled' });
		expect(call_from_row((await store!.find_id('chat-calls', call_id))!).state).toBe('ended');
		expect((await join(beto, code, 'beto-leg')).body.code).toBe('meeting_cancelled');
	});

	test('el barrido no cierra una reunión con gente adentro; vacía, la cierra pasada la gracia', async () => {
		const view = await meeting({ title: 'Guardia', persistent: true });
		const code = String(view.code);
		const host = await join(ana, code, 'ana-leg');
		const call_id = String((host.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		attach(call_id, `u:${ana._id}`, 'ana-leg', 'host');
		const now = Date.now();
		await sweep_calls(store!, now);
		await sweep_calls(store!, now + 60_000);
		expect(call_from_row((await store!.find_id('chat-calls', call_id))!).state).toBe('active');
		run_room_command(call_id, { type: 'detach', leg_id: 'ana-leg' });
		await sweep_calls(store!, now + 61_000);
		expect(call_from_row((await store!.find_id('chat-calls', call_id))!).state).toBe('active');
		await sweep_calls(store!, now + 92_000);
		expect(call_from_row((await store!.find_id('chat-calls', call_id))!)).toMatchObject({ state: 'ended', end_reason: 'interrupted' });
		expect((await live(String(view._id))).state).toBe('scheduled');
	});

	/** Una reunión en vivo con Ana anfitriona y Beto adentro, y un invitado admitido. */
	const room_with_guest = async (json: ImperiumDoc) => {
		const view = await meeting({ start_at: minutes(30), invitee_ids: [beto._id], ...json, settings: { guests_allowed: true, ...(json.settings as ImperiumDoc) } });
		const code = String(view.code);
		const host = await join(ana, code, 'ana-leg');
		const call_id = String((host.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		await join(beto, code, 'beto-leg');
		attach(call_id, `u:${ana._id}`, 'ana-leg', 'host');
		attach(call_id, `u:${beto._id}`, 'beto-leg');
		const joined = await guest_join(code, 'Ivo Preguntón');
		const cookie = cookie_of(joined);
		const guest_key = `g:${String(joined.body.data[0]!.guest_id)}`;
		await join(null, code, 'g-leg', as_guest(cookie));
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'admit', member_key: guest_key });
		attach(call_id, guest_key, 'g-leg', 'guest');
		return { view, id: String(view._id), code, call_id, cookie, guest_key };
	};

	test('preguntas: anónimas para quien no modera, votos atómicos que conmutan, orden por votos y respondida', async () => {
		const { id, call_id, cookie, guest_key } = await room_with_guest({ title: 'Foro' });
		const ask = (actor: ImperiumDoc | null, json: ImperiumDoc, headers: Record<string, string> = {}) =>
			call(st, actor, 'create_question', `/${id}/questions`, { method: 'POST', json: { call_id, ...json }, params: { id }, headers });
		const list = (actor: ImperiumDoc | null, headers: Record<string, string> = {}) =>
			call(st, actor, 'read_questions', `/${id}/questions?call_id=${call_id}`, { params: { id }, headers });
		const vote = (actor: ImperiumDoc | null, qid: string, headers: Record<string, string> = {}) =>
			call(st, actor, 'vote_question', `/${id}/questions/${qid}/vote`, { method: 'POST', params: { id, qid }, headers });

		const anon = await ask(null, { text: '  ¿Habrá   grabación?\u0000 ', anonymous: true }, as_guest(cookie));
		expect(anon.status).toBe(200);
		expect(anon.body.data[0]).toMatchObject({ call_id, text: '¿Habrá   grabación?', anonymous: true, votes: 0, mine: true, voted: false, status: 'visible' });
		expect(anon.body.data[0]!.author_name).toBeUndefined();
		const plain = await ask(beto, { text: '¿A qué hora termina?' });
		const anon_id = String(anon.body.data[0]!._id);
		const plain_id = String(plain.body.data[0]!._id);
		expect(plain.body.data[0]).toMatchObject({ author_name: beto.name, anonymous: false });

		const both = await Promise.all([vote(beto, plain_id), vote(null, plain_id, as_guest(cookie)), vote(ana, plain_id)]);
		expect(both.map((reply) => reply.status)).toEqual([200, 200, 200]);
		const [row] = (await db.unsafe(`SELECT payload FROM ${store!.qt('chat-meeting-questions')} WHERE id = $1`, [plain_id])) as Array<{ payload: ImperiumDoc }>;
		expect(row!.payload.votes).toBe(3);
		expect([...(row!.payload.voterKeys as string[])].sort()).toEqual([`u:${ana._id}`, `u:${beto._id}`, guest_key].sort());
		expect(both[2]!.body.data[0]).toMatchObject({ mine: false, voted: true });
		const undone = await vote(ana, plain_id);
		expect(undone.body.data[0]).toMatchObject({ votes: 2, mine: false, voted: false });

		const seen_by_beto = (await list(beto)).body.data;
		expect(seen_by_beto.map((item) => [item._id, item.votes])).toEqual([
			[plain_id, 2],
			[anon_id, 0],
		]);
		expect(seen_by_beto.find((item) => item._id === anon_id)!.author_name).toBeUndefined();
		expect(seen_by_beto.find((item) => item._id === plain_id)).toMatchObject({ mine: true, voted: true });
		expect(seen_by_beto.find((item) => item._id === anon_id)).toMatchObject({ mine: false, voted: false });
		expect((await list(ana)).body.data.find((item) => item._id === anon_id)!.author_name).toBe('Ivo Preguntón');

		const answered = await call(st, ana, 'moderate_question', `/${id}/questions/${plain_id}`, {
			method: 'PATCH',
			json: { status: 'answered' },
			params: { id, qid: plain_id },
		});
		expect(answered.body.data[0]).toMatchObject({ status: 'answered', votes: 2 });
		expect((await vote(beto, plain_id)).body.data[0]).toMatchObject({ status: 'answered', votes: 1 });
		const by_beto = await call(st, beto, 'moderate_question', `/${id}/questions/${plain_id}`, {
			method: 'PATCH',
			json: { status: 'hidden' },
			params: { id, qid: plain_id },
		});
		expect([by_beto.status, by_beto.body.code]).toEqual([403, 'not_host']);
		const bad = await call(st, ana, 'moderate_question', `/${id}/questions/${plain_id}`, { method: 'PATCH', json: { status: 'pending' }, params: { id, qid: plain_id } });
		expect(bad.body.code).toBe('invalid_request');
		expect((await ask(beto, { text: 'x'.repeat(501) })).body.code).toBe('text_too_long');
		expect((await ask(beto, { text: '   ' })).body.code).toBe('invalid_request');
		expect((await ask(dario, { text: '¿Puedo?' })).body.code).toBe('not_member');
		expect((await list(dario)).body.code).toBe('not_member');
		expect((await ask(null, { text: '¿Y yo?' })).body.code).toBe('unauthenticated');
		expect((await vote(beto, hex_id())).body.code).toBe('question_not_found');

		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
		const attendance = (await db.unsafe(
			`SELECT participant_key, payload FROM ${store!.qt('chat-meeting-attendance')} WHERE call_id = $1`,
			[call_id],
		)) as Array<{ participant_key: string; payload: ImperiumDoc }>;
		expect(attendance.find((item) => item.participant_key === guest_key)!.payload).toMatchObject({ questions: 1 });
		expect((await list(beto)).body.data).toHaveLength(2);
		expect((await ask(beto, { text: '¿Sigue?' })).body.code).toBe('not_member');
	});

	test('con moderación previa la pregunta espera: solo quien modera y su autor la ven; nadie más vota hasta publicarla; oculta, ni su autor', async () => {
		const { id, call_id, cookie } = await room_with_guest({ title: 'Clase moderada', settings: { qa_moderated: true } });
		const asked = await call(st, null, 'create_question', `/${id}/questions`, {
			method: 'POST',
			json: { call_id, text: '¿Entra en el examen?', anonymous: false },
			params: { id },
			headers: as_guest(cookie),
		});
		const qid = String(asked.body.data[0]!._id);
		expect(asked.body.data[0]).toMatchObject({ status: 'pending', author_name: 'Ivo Preguntón' });
		const read = (actor: ImperiumDoc | null, headers: Record<string, string> = {}) =>
			call(st, actor, 'read_questions', `/${id}/questions?call_id=${call_id}`, { params: { id }, headers });
		expect((await read(beto)).body.data).toEqual([]);
		expect((await read(null, as_guest(cookie))).body.data.map((item) => item._id)).toEqual([qid]);
		expect((await read(ana)).body.data.map((item) => [item._id, item.status])).toEqual([[qid, 'pending']]);
		const early = await call(st, beto, 'vote_question', `/${id}/questions/${qid}/vote`, { method: 'POST', params: { id, qid } });
		expect(early.body.code).toBe('question_not_found');
		await call(st, ana, 'moderate_question', `/${id}/questions/${qid}`, { method: 'PATCH', json: { status: 'visible' }, params: { id, qid } });
		expect((await read(beto)).body.data.map((item) => [item._id, item.status])).toEqual([[qid, 'visible']]);
		await call(st, ana, 'moderate_question', `/${id}/questions/${qid}`, { method: 'PATCH', json: { status: 'hidden' }, params: { id, qid } });
		expect((await read(null, as_guest(cookie))).body.data).toEqual([]);
		expect((await read(ana)).body.data.map((item) => [item._id, item.status])).toEqual([[qid, 'hidden']]);
		const other = await meeting({ title: 'Otra', start_at: minutes(60) });
		const foreign = await call(st, ana, 'moderate_question', `/${other._id}/questions/${qid}`, {
			method: 'PATCH',
			json: { status: 'hidden' },
			params: { id: String(other._id), qid },
		});
		expect(foreign.body.code).toBe('question_not_found');
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
	});

	test('salas pequeñas: llamadas hijas con su gente y quien modera de visita, sin tocar la llamada de la conversación; se cierran a la cuenta', async () => {
		const { view, call_id, guest_key } = await room_with_guest({ title: 'Taller' });
		const host = { member_key: `u:${ana._id}`, role: 'host' as const };
		await expect(
			run_host_command(store!, call_id, { member_key: `u:${beto._id}`, role: 'participant' }, { type: 'breakouts_open', rooms: [{ name: 'A', member_keys: [] }], minutes: 5 }),
		).rejects.toMatchObject({ code: 'not_host' });
		await run_host_command(store!, call_id, host, {
			type: 'breakouts_open',
			rooms: [
				{ name: 'Mesa 1', member_keys: [`u:${beto._id}`] },
				{ name: 'Mesa 2', member_keys: [guest_key] },
			],
			minutes: 5,
		});
		const rooms = room_state(call_id).breakouts!.rooms;
		expect(rooms.map((item) => [item.name, item.member_keys])).toEqual([
			['Mesa 1', [`u:${beto._id}`]],
			['Mesa 2', [guest_key]],
		]);
		for (const item of rooms) {
			track('chat-calls', item.call_id);
			expect(call_from_row((await store!.find_id('chat-calls', item.call_id))!)).toMatchObject({
				state: 'active',
				kind: 'meeting',
				meeting_id: view._id,
				parent_call_id: call_id,
				conversation_id: view.conversation_id,
			});
		}
		expect(room_state(rooms[0]!.call_id).admitted.map((item) => item.member_key).sort()).toEqual([`u:${ana._id}`, `u:${beto._id}`].sort());
		expect(room_state(rooms[1]!.call_id).admitted.map((item) => item.member_key)).toContain(guest_key);
		expect(room_state(rooms[1]!.call_id).admitted.map((item) => item.member_key)).not.toContain(`u:${beto._id}`);
		const conversation = async () => (await store!.find_id('chat-conversations', String(view.conversation_id)))!;
		expect((await conversation()).activeCall).toMatchObject({ callId: call_id });
		const active = await call(st, beto, 'read_active_calls', '/active', { resource: 'chat-calls' });
		expect(active.body.data.filter((item) => item.meeting_id === view._id).map((item) => item._id)).toEqual([call_id]);
		const joined = await call(st, beto, 'join_call', `/${call_id}/join`, {
			method: 'POST',
			json: { leg_id: 'beto-leg', media: 'video' },
			params: { id: call_id },
			resource: 'chat-calls',
		});
		expect([joined.status, joined.body.code]).toEqual([422, 'invalid_request']);
		expect(call_from_row((await store!.find_id('chat-calls', call_id))!)).toMatchObject({ legs: [], participant_ids: [] });

		await run_host_command(store!, call_id, host, { type: 'breakouts_broadcast', text: 'Vuelvan en 1 minuto' });
		expect(room_state(call_id).breakouts!.broadcast).toMatchObject({ text: 'Vuelvan en 1 minuto', by_name: ana.name });
		await run_host_command(store!, call_id, host, { type: 'breakouts_close' });
		const closing_at = room_state(call_id).breakouts!.closing_at!;
		await breakouts_tick(store!, call_id, closing_at - 1);
		expect(call_from_row((await store!.find_id('chat-calls', rooms[0]!.call_id))!).state).toBe('active');
		await breakouts_tick(store!, call_id, closing_at);
		expect(room_state(call_id).breakouts).toBeUndefined();
		for (const item of rooms) {
			expect(call_from_row((await store!.find_id('chat-calls', item.call_id))!)).toMatchObject({ state: 'ended', end_reason: 'ended_by_host' });
		}
		expect((await conversation()).activeCall).toMatchObject({ callId: call_id });
		expect(call_from_row((await store!.find_id('chat-calls', call_id))!).state).toBe('active');
		const call_messages = async () =>
			((await db.unsafe(`SELECT id FROM ${store!.qt('messages')} WHERE conversation_id = $1 AND kind = 'call'`, [view.conversation_id])) as unknown[]).length;
		expect(await call_messages()).toBe(0);

		await run_host_command(store!, call_id, host, {
			type: 'breakouts_open',
			rooms: [
				{ name: 'Azar 1', member_keys: [] },
				{ name: 'Azar 2', member_keys: [] },
			],
			minutes: 5,
			assign: 'random',
		});
		const dealt = room_state(call_id).breakouts!.rooms;
		for (const item of dealt) track('chat-calls', item.call_id);
		expect(dealt.map((item) => item.member_keys.length)).toEqual([1, 1]);
		expect(dealt.flatMap((item) => item.member_keys).sort()).toEqual([`u:${beto._id}`, guest_key].sort());
		await run_host_command(store!, call_id, host, { type: 'end' });
		for (const item of dealt) expect(call_from_row((await store!.find_id('chat-calls', item.call_id))!).state).toBe('ended');
		expect((await conversation()).activeCall).toBeUndefined();
		expect(await call_messages()).toBe(1);
	});

	test('expulsar y bloquear, desde la sala principal o desde una pequeña, saca a la persona de todas las salas de la reunión', async () => {
		const { id, call_id, cookie, guest_key } = await room_with_guest({ title: 'Expulsión en salas pequeñas' });
		const host = { member_key: `u:${ana._id}`, role: 'host' as const };
		const beto_key = `u:${beto._id}`;
		await run_host_command(store!, call_id, host, {
			type: 'breakouts_open',
			rooms: [
				{ name: 'Mesa 1', member_keys: [guest_key] },
				{ name: 'Mesa 2', member_keys: [beto_key] },
			],
			minutes: 5,
		});
		const [guest_room, beto_room] = room_state(call_id).breakouts!.rooms.map((item) => track('chat-calls', item.call_id)) as [string, string];
		run_room_command(call_id, { type: 'leave', member_key: guest_key });
		run_room_command(call_id, { type: 'leave', member_key: beto_key });
		attach(guest_room, guest_key, 'g-child', 'guest');
		attach(beto_room, beto_key, 'beto-child');
		attach(beto_room, host.member_key, 'ana-child', 'host');
		const media_reader = () => guest_media_reader(new Request('http://core/api/media/x', { headers: { cookie } }));
		expect(media_reader()).not.toBeNull();

		// Desde la principal, al invitado que está en su sala pequeña; desde la sala pequeña, a Beto.
		await run_host_command(store!, call_id, host, { type: 'kick', member_key: guest_key, block: true });
		await run_host_command(store!, beto_room, host, { type: 'kick', member_key: beto_key, block: true });
		expect([...((await live(id)).blockedKeys as string[])].sort()).toEqual([guest_key, beto_key].sort());
		const rows = (await db.unsafe(
			`SELECT call_id, participant_key, payload FROM ${store!.qt('chat-meeting-attendance')} WHERE call_id IN ($1, $2, $3)`,
			[call_id, guest_room, beto_room],
		)) as Array<{ call_id: string; participant_key: string; payload: ImperiumDoc }>;
		const names = rows
			.filter((row) => [guest_key, beto_key].includes(row.participant_key))
			.map((row) => [row.call_id === call_id ? 'principal' : 'pequeña', row.participant_key, row.payload.displayName, row.payload.outcome]);
		expect(names.sort()).toEqual(
			[
				['principal', guest_key, 'Ivo Preguntón', 'expelled'],
				['pequeña', guest_key, 'Ivo Preguntón', 'expelled'],
				['principal', beto_key, beto.name, 'expelled'],
				['pequeña', beto_key, beto.name, 'expelled'],
			].sort(),
		);
		for (const key of [guest_key, beto_key]) {
			for (const room of [call_id, guest_room, beto_room]) {
				expect({
					key,
					room,
					admitted: admitted_person(room, key) !== undefined,
					attached: room_state(room).members.some((item) => item.member_key === key),
					blocked: room_state(room).blocked.includes(key),
				}).toEqual({ key, room, admitted: false, attached: false, blocked: true });
			}
		}
		expect(room_state(call_id).breakouts!.rooms.map((item) => item.member_keys)).toEqual([[], []]);
		expect(media_reader()).toBeNull();
		expect((await call(st, null, 'guest_read_chat', `/${id}/chat`, { params: { id }, headers: as_guest(cookie) })).body.code).toBe('guest_not_admitted');
		const post = await call(st, null, 'guest_chat_message', `/${id}/chat`, {
			method: 'POST',
			json: { client_id: crypto.randomUUID(), text: 'sigo aquí' },
			params: { id },
			headers: as_guest(cookie),
		});
		expect(post.body.code).toBe('guest_not_admitted');
		const back = run_room_command(beto_room, {
			type: 'attach',
			member: {
				member_key: beto_key,
				leg_id: 'beto-otra',
				name: String(beto.name),
				role: 'participant',
				media: { mic: false, cam: false, screen: false, audio_only: false },
				hard_muted: false,
				speaker: false,
				session_id: 's-beto-otra',
			},
		});
		expect(back.ok).toBe(false);

		await run_host_command(store!, call_id, host, { type: 'breakouts_close' });
		await breakouts_tick(store!, call_id, room_state(call_id).breakouts!.closing_at!);
		expect([admitted_person(call_id, guest_key), admitted_person(call_id, beto_key)]).toEqual([undefined, undefined]);
		await run_host_command(store!, call_id, host, { type: 'end' });
	});

	test('transcripción .vtt: con <v Nombre>, escapada y en orden; solo miembros; sin transcripción, 404', async () => {
		const view = await meeting({ title: 'Con actas', start_at: minutes(30), invitee_ids: [beto._id], settings: { captions: true, save_transcript: true } });
		const id = String(view._id);
		const host = await join(ana, String(view.code), 'ana-leg');
		const call_id = String((host.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		expect(room_state(call_id).transcript).toBeDefined();
		const cue = (i: number, extra: Partial<Parameters<typeof save_caption>[3]> = {}) => ({
			start_ms: 1_000 * i,
			end_ms: 1_000 * i + 500,
			speaker_key: `u:${ana._id}`,
			speaker_name: 'Ana',
			text: `Frase ${i}`,
			lang: 'es-MX',
			...extra,
		});
		save_caption(store!, call_id, id, cue(0, { speaker_name: 'Ana <3 & Co', text: 'a < b --> c & <i>d</i>' }));
		for (let i = 1; i < TRANSCRIPT_FLUSH.cues + 2; i++) save_caption(store!, call_id, id, cue(i, { start_ms: 3_600_000 + i * 1000, end_ms: 3_600_000 + i * 1000 + 250 }));
		const vtt = await call(st, beto, 'transcript_vtt', `/${id}/transcript.vtt?call_id=${call_id}`, { params: { id } });
		expect(vtt.status).toBe(200);
		expect(vtt.headers!.get('content-type')).toBe('text/vtt; charset=utf-8');
		const text = vtt.text!;
		expect(text.startsWith('WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.500\n<v Ana &lt;3 &amp; Co>a &lt; b --&gt; c &amp; &lt;i&gt;d&lt;/i&gt;\n\n2\n01:00:01.000 --> 01:00:01.250\n<v Ana>Frase 1')).toBe(true);
		expect(text.trimEnd().endsWith(`${TRANSCRIPT_FLUSH.cues + 2}\n01:03:21.000 --> 01:03:21.250\n<v Ana>Frase ${TRANSCRIPT_FLUSH.cues + 1}`)).toBe(true);
		const blocks = (await db.unsafe(`SELECT seq FROM ${store!.qt('chat-meeting-transcripts')} WHERE call_id = $1 ORDER BY seq`, [call_id])) as Array<{ seq: number }>;
		expect(blocks.map((row) => Number(row.seq))).toEqual([0, 1]);
		expect(await store!.meeting_transcript_next_seq(call_id)).toBe(2);
		expect((await call(st, dario, 'transcript_vtt', `/${id}/transcript.vtt?call_id=${call_id}`, { params: { id } })).body.code).toBe('not_member');
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });

		const plain = await meeting({ title: 'Sin actas', start_at: minutes(30), settings: { captions: false } });
		const plain_call = await join(ana, String(plain.code), 'ana-leg');
		const plain_id = String((plain_call.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', plain_id);
		expect(room_state(plain_id).transcript).toBeUndefined();
		await expect(run_host_command(store!, plain_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'captions', on: true })).rejects.toMatchObject({
			code: 'feature_disabled',
		});
		const none = await call(st, ana, 'transcript_vtt', `/${plain._id}/transcript.vtt?call_id=${plain_id}`, { params: { id: String(plain._id) } });
		expect([none.status, none.body.code]).toEqual([404, 'transcript_not_found']);
		const foreign = await call(st, ana, 'transcript_vtt', `/${plain._id}/transcript.vtt?call_id=${call_id}`, { params: { id: String(plain._id) } });
		expect(foreign.body.code).toBe('call_not_found');
		await run_host_command(store!, plain_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
	});

	test('grabación: solo quien organiza, partes en orden hasta el tope y un mensaje de sistema con el adjunto ligado', async () => {
		const folder = mkdtempSync(path_join(tmpdir(), 'grabacion-'));
		const previous = { folder: process.env.MULTER_UPLOAD_FOLDER, max: process.env.IMPERIUM_RECORDING_MAX_MB };
		process.env.MULTER_UPLOAD_FOLDER = folder;
		try {
			const view = await meeting({ title: 'Grabada', start_at: minutes(30), invitee_ids: [beto._id] });
			const id = String(view._id);
			const code = String(view.code);
			const host = await join(ana, code, 'ana-leg');
			const call_id = String((host.body.data[0]!.call as ImperiumDoc)._id);
			track('chat-calls', call_id);
			await join(beto, code, 'beto-leg');
			attach(call_id, `u:${ana._id}`, 'ana-leg', 'host');
			attach(call_id, `u:${beto._id}`, 'beto-leg');
			const start = (actor: ImperiumDoc, target = st) =>
				call(target, actor, 'start_recording', `/${id}/recordings`, { method: 'POST', json: { call_id }, params: { id } });
			const chunk = (actor: ImperiumDoc, rid: string, seq: number, text: string) => {
				const form = new FormData();
				form.append('chunk', new Blob([text], { type: 'video/webm' }), 'parte.webm');
				form.append('seq', String(seq));
				return call(st, actor, 'recording_chunk', `/${id}/recordings/${rid}/chunk`, { method: 'POST', form, params: { id, rid } });
			};
			const finish = (actor: ImperiumDoc, rid: string) =>
				call(st, actor, 'finish_recording', `/${id}/recordings/${rid}/finish`, { method: 'POST', params: { id, rid } });

			expect((await start(beto)).body.code).toBe('not_host');
			expect((await start(ana, with_params(store!, { 'configuration-meetings-recording-enabled': false }))).body.code).toBe('feature_disabled');
			const started = await start(ana);
			expect(started.status).toBe(200);
			const rid = String(started.body.data[0]!.recording_id);
			expect((await start(ana)).body.data[0]).toEqual({ recording_id: rid });
			expect(room_state(call_id).policy.recording).toMatchObject({ by_name: ana.name });
			expect(call_from_row((await store!.find_id('chat-calls', call_id))!).recording).toMatchObject({ by: ana._id, recording_id: rid });
			expect((await call(st, null, 'public_summary', `/code/${code}`, { params: { code } })).body.data[0]).toMatchObject({ recording_active: true });

			const early = await chunk(ana, rid, 1, 'BB');
			expect([early.status, early.body.code, early.body.details]).toEqual([409, 'recording_seq', { expected_seq: 0 }]);
			expect((await chunk(beto, rid, 0, 'AA')).body.code).toBe('not_host');
			expect((await chunk(ana, hex_id(), 0, 'AA')).body.code).toBe('upload_not_found');
			expect((await chunk(ana, rid, 0, 'AAAA')).body.data[0]).toEqual({ received_seq: 0, total_mb: 0 });
			expect((await chunk(ana, rid, 0, 'AAAA')).body.details).toEqual({ expected_seq: 1 });
			expect((await chunk(ana, rid, 1, 'BBBB')).body.data[0]).toMatchObject({ received_seq: 1 });
			process.env.IMPERIUM_RECORDING_MAX_MB = String(10 / (1024 * 1024));
			const over = await chunk(ana, rid, 2, 'CCCC');
			expect([over.status, over.body.code]).toEqual([413, 'recording_too_large']);
			process.env.IMPERIUM_RECORDING_MAX_MB = previous.max ?? '';

			expect((await finish(beto, rid)).body.code).toBe('not_host');
			const done = await finish(ana, rid);
			expect(done.status).toBe(200);
			const message = done.body.data[0]!;
			track('messages', String(message._id));
			expect(message).toMatchObject({ kind: 'system', conversation_id: view.conversation_id });
			expect(message.system).toMatchObject({ type: 'recording', actor_id: ana._id, data: { recording_id: rid, call_id, meeting_id: id, title: 'Grabada' } });
			const attachment = (message.attachments as ImperiumDoc[])[0]!;
			expect(attachment).toMatchObject({ mimetype: 'video/webm', kind: 'video', url: `/api/media/${attachment.attachment_id}` });
			const row = (await store!.find_id('attachment-management', String(attachment.attachment_id)))!;
			track('attachment-management', String(row._id));
			expect(row).toMatchObject({ related_model: 'Message', related_record_id: message._id, created_by_id: ana._id });
			expect(readFileSync(path_join(folder, String(row.name_stored)), 'utf8')).toBe('AAAABBBB');
			expect(existsSync(path_join(folder, 'recordings', `${rid}.part`))).toBe(false);
			await assert_attachment_access(store!, beto, row);
			await expect(assert_attachment_access(store!, dario, row)).rejects.toMatchObject({ code: 'attachment_forbidden' });
			expect(room_state(call_id).policy.recording).toBeUndefined();
			expect(call_from_row((await store!.find_id('chat-calls', call_id))!).recording).toBeUndefined();
			expect((await finish(ana, rid)).body.code).toBe('upload_not_found');

			const empty = String((await start(ana)).body.data[0]!.recording_id);
			expect(empty).not.toBe(rid);
			expect((await finish(ana, empty)).body.details).toEqual({ expected_seq: 0 });
			const stale = hex_id();
			const day_ago = new Date(Date.now() - 25 * 3600_000);
			writeFileSync(path_join(folder, 'recordings', `${stale}.part`), 'viejo');
			for (const part of [stale, empty]) utimesSync(path_join(folder, 'recordings', `${part}.part`), day_ago, day_ago);
			expect(discard_stale_recordings(new Date())).toBe(1);
			expect(existsSync(path_join(folder, 'recordings', `${stale}.part`))).toBe(false);
			expect(existsSync(path_join(folder, 'recordings', `${empty}.part`))).toBe(true);
			await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
			const rows = (await db.unsafe(
				`SELECT participant_key, payload FROM ${store!.qt('chat-meeting-attendance')} WHERE call_id = $1`,
				[call_id],
			)) as Array<{ participant_key: string; payload: ImperiumDoc }>;
			expect(rows.find((item) => item.participant_key === `u:${beto._id}`)!.payload.recordingNoticeAt).toBeString();
			const closed = await meeting({ title: 'Sin grabar', start_at: minutes(30), settings: { recording_allowed: false } });
			const closed_call = await join(ana, String(closed.code), 'ana-leg');
			const closed_id = String((closed_call.body.data[0]!.call as ImperiumDoc)._id);
			track('chat-calls', closed_id);
			const refused = await call(st, ana, 'start_recording', `/${closed._id}/recordings`, {
				method: 'POST',
				json: { call_id: closed_id },
				params: { id: String(closed._id) },
			});
			expect(refused.body.code).toBe('feature_disabled');
			await run_host_command(store!, closed_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });
		} finally {
			if (previous.folder === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
			else process.env.MULTER_UPLOAD_FOLDER = previous.folder;
			if (previous.max === undefined) delete process.env.IMPERIUM_RECORDING_MAX_MB;
			else process.env.IMPERIUM_RECORDING_MAX_MB = previous.max;
			rmSync(folder, { recursive: true, force: true });
		}
	});
	test('partes de grabación: la llamada sigue viva y las llamadas encendidas; la reunión tiene un tope total', async () => {
		const folder = mkdtempSync(path_join(tmpdir(), 'grabacion-'));
		const previous = { folder: process.env.MULTER_UPLOAD_FOLDER, total: process.env.IMPERIUM_MEETING_RECORDINGS_MAX_MB };
		process.env.MULTER_UPLOAD_FOLDER = folder;
		try {
			const view = (await call(st, beto, 'create_meeting', '/', { method: 'POST', json: { title: 'Tope total', start_at: minutes(30) } })).body.data[0]!;
			track('chat-meetings', String(view._id));
			track('chat-conversations', String(view.conversation_id));
			const id = String(view._id);
			const call_id = String(((await join(beto, String(view.code), 'beto-leg')).body.data[0]!.call as ImperiumDoc)._id);
			track('chat-calls', call_id);
			attach(call_id, `u:${beto._id}`, 'beto-leg', 'host');
			const start = () => call(st, beto, 'start_recording', `/${id}/recordings`, { method: 'POST', json: { call_id }, params: { id } });
			const chunk = (rid: string, seq: number, text: string, target = st) => {
				const form = new FormData();
				form.append('chunk', new Blob([text], { type: 'video/webm' }), 'parte.webm');
				form.append('seq', String(seq));
				return call(target, beto, 'recording_chunk', `/${id}/recordings/${rid}/chunk`, { method: 'POST', form, params: { id, rid } });
			};
			const finish = async (rid: string) => {
				const done = await call(st, beto, 'finish_recording', `/${id}/recordings/${rid}/finish`, { method: 'POST', params: { id, rid } });
				expect(done.status).toBe(200);
				track('attachment-management', String(((done.body.data[0]!.attachments as ImperiumDoc[])[0]!).attachment_id));
			};
			const rid_of = (reply: Reply) => String(reply.body.data[0]!.recording_id);

			const first = rid_of(await start());
			expect((await chunk(first, 0, 'AAAA')).status).toBe(200);
			const off_calls = with_params(store!, { 'configuration-calls-enabled': false });
			expect((await chunk(first, 1, 'BBBB', off_calls)).body.code).toBe('calls_disabled');
			await finish(first);

			// 6 bytes por reunión: ya hay 4 guardados.
			process.env.IMPERIUM_MEETING_RECORDINGS_MAX_MB = String(6 / (1024 * 1024));
			const second = rid_of(await start());
			const over = await chunk(second, 0, 'CCCC');
			expect([over.status, over.body.code]).toEqual([413, 'recording_too_large']);
			expect((await chunk(second, 0, 'CC')).status).toBe(200);
			await finish(second);
			const full = await start();
			expect([full.status, full.body.code]).toEqual([413, 'recording_too_large']);
			delete process.env.IMPERIUM_MEETING_RECORDINGS_MAX_MB;

			const third = rid_of(await start());
			await run_host_command(store!, call_id, { member_key: `u:${beto._id}`, role: 'host' }, { type: 'end' });
			// La última parte que el navegador entrega al cortar todavía entra.
			expect((await chunk(third, 0, 'DD')).status).toBe(200);
			await db.unsafe(`UPDATE ${store!.qt('chat-calls')} SET ended_at = $2 WHERE id = $1`, [call_id, new Date(Date.now() - 120_000).toISOString()]);
			const late = await chunk(third, 1, 'EE');
			expect([late.status, late.body.code]).toEqual([409, 'call_ended']);
			await finish(third);
		} finally {
			if (previous.folder === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
			else process.env.MULTER_UPLOAD_FOLDER = previous.folder;
			if (previous.total === undefined) delete process.env.IMPERIUM_MEETING_RECORDINGS_MAX_MB;
			else process.env.IMPERIUM_MEETING_RECORDINGS_MAX_MB = previous.total;
			rmSync(folder, { recursive: true, force: true });
		}
	});

	test('asistencia: JSON y CSV por persona con BOM, celdas que no se evalúan, salas pequeñas sumadas y ausentes de la lista', async () => {
		const view = await meeting({ title: 'Pase de lista', start_at: minutes(30), invitee_ids: [beto._id, dario._id], settings: { guests_allowed: true } });
		const id = String(view._id);
		const code = String(view.code);
		const host = await join(ana, code, 'ana-leg');
		const call_id = String((host.body.data[0]!.call as ImperiumDoc)._id);
		track('chat-calls', call_id);
		await join(beto, code, 'beto-leg');
		attach(call_id, `u:${ana._id}`, 'ana-leg', 'host');
		attach(call_id, `u:${beto._id}`, 'beto-leg');
		const joined = await guest_join(code, '=HYPERLINK("x") "Ivo"');
		const guest_key = `g:${String(joined.body.data[0]!.guest_id)}`;
		await join(null, code, 'g-leg', as_guest(cookie_of(joined)));
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'admit', member_key: guest_key });
		attach(call_id, guest_key, 'g-leg', 'guest');
		run_room_command(call_id, { type: 'hand', leg_id: 'beto-leg', up: true, now: Date.now() });
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, {
			type: 'breakouts_open',
			rooms: [{ name: 'Equipo', member_keys: [`u:${beto._id}`] }],
			minutes: 5,
		});
		const child = room_state(call_id).breakouts!.rooms[0]!.call_id;
		track('chat-calls', child);
		attach(child, `u:${beto._id}`, 'beto-child');
		run_room_command(child, { type: 'hand', leg_id: 'beto-child', up: true, now: Date.now() });

		const live = await call(st, ana, 'read_attendance', `/${id}/attendance?call_id=${call_id}`, { params: { id } });
		expect(live.status).toBe(200);
		expect(live.body.data.find((row) => row.participant_key === `u:${beto._id}` && row.call_id === call_id)).toMatchObject({
			hands: 1,
			email: `${beto._id}@empresa.com`,
		});
		await run_host_command(store!, call_id, { member_key: `u:${ana._id}`, role: 'host' }, { type: 'end' });

		const rows = await call(st, ana, 'read_attendance', `/${id}/attendance`, { params: { id } });
		expect(rows.body.data.map((row) => `${row.participant_key}@${row.call_id}`).sort()).toEqual(
			[`u:${ana._id}@${call_id}`, `u:${beto._id}@${call_id}`, `${guest_key}@${call_id}`, `u:${beto._id}@${child}`].sort(),
		);
		const guest_row = rows.body.data.find((row) => row.participant_key === guest_key)!;
		expect(guest_row).toMatchObject({ display_name: '=HYPERLINK("x") "Ivo"', role: 'guest', meeting_id: id });
		expect(guest_row.user_id).toBeUndefined();

		const csv = await call(st, ana, 'attendance_csv', `/${id}/attendance.csv?call_id=${call_id}`, { params: { id } });
		expect(csv.status).toBe(200);
		expect(csv.headers!.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(csv.headers!.get('content-disposition')).toBe(`attachment; filename="asistencia-${code}.csv"`);
		const text = csv.text!;
		expect(text.charCodeAt(0)).toBe(0xfeff);
		const lines = text.slice(1).split('\r\n');
		expect(lines.at(-1)).toBe('');
		expect(lines[0]).toStartWith('"Nombre","Correo","Tipo","Rol","Asistencia","Primera entrada"');
		const line_of = (needle: string) => lines.find((line) => line.includes(needle))!;
		expect(line_of('HYPERLINK')).toStartWith(`"'=HYPERLINK(""x"") ""Ivo""","","Invitado sin cuenta","Invitado","Asistió"`);
		const beto_line = line_of(String(beto.name)).split('","');
		expect(beto_line.slice(1, 5)).toEqual([`${beto._id}@empresa.com`, 'Usuario', 'Participante', 'Asistió']);
		expect(beto_line[10]).toBe('2');
		expect(line_of(String(dario.name))).toBe(
			`"${dario.name}","${dario._id}@empresa.com","Usuario","Participante","Ausente","","","0.0","0.0","0","0","0","0","0.0",""`,
		);
		expect(lines.filter((line) => line.includes(String(ana.name)))).toHaveLength(1);
		expect(lines.indexOf(line_of(String(dario.name)))).toBe(lines.length - 2);

		expect((await call(st, beto, 'attendance_csv', `/${id}/attendance.csv`, { params: { id } })).body.code).toBe('not_host');
		expect((await call(st, eva_outsider, 'read_attendance', `/${id}/attendance`, { params: { id } })).body.code).toBe('not_member');
		const admin = { ...eva_outsider, _ref: 'user-menu-management-0' };
		expect((await call(st, admin, 'read_attendance', `/${id}/attendance`, { params: { id } })).status).toBe(200);
	});
});
