/**
 * Señalización de llamadas por un socket real, con un almacén falso que solo sabe leer llamadas.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { flush_transcript, open_meeting_room, room_state, run_room_command } from './call-room.ts';
import { mark_leg_attached } from './calls-flow.ts';
import { meeting_from_row, publish_meeting } from './meetings-flow.ts';
import { register_call_socket_handlers } from './calls-realtime.ts';
import type { ImperiumDoc } from './envelope.ts';
import { sign_realtime_token } from './realtime-tokens.ts';
import { bind_socket_identity_resolver, handle_socket_io, socket_websocket_handler, upgrade_socket_io } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

const calls = new Map<string, ImperiumDoc>();
const meetings = new Map<string, ImperiumDoc>();
const names = new Map<string, string>();
const attendance: ImperiumDoc[] = [];
const inserted: ImperiumDoc[] = [];

const store = {
	has: () => true,
	async find_id(resource: string, id: string) {
		if (resource === 'chat-meetings') return meetings.get(id) ?? null;
		return resource === 'chat-calls' ? (calls.get(id) ?? null) : null;
	},
	async chat_users_brief(ids: string[]) {
		return ids.flatMap((id) => (names.has(id) ? [{ _id: id, name: names.get(id)!, is_active: true }] : []));
	},
	async upsert_call_attendance(input: ImperiumDoc) {
		attendance.push(input);
		return input;
	},
	async payload_set_toggle() {
		return null;
	},
	async insert(resource: string, doc: ImperiumDoc) {
		inserted.push({ resource, ...doc });
		return doc;
	},
	async meeting_transcript_next_seq() {
		return 0;
	},
};

register_call_socket_handlers(store as unknown as ImperiumStore);

const sessions = new Map<string, string>();
bind_socket_identity_resolver(async (session_id) => sessions.get(session_id) ?? null);

const server = Bun.serve({
	port: 0,
	websocket: socket_websocket_handler,
	fetch(req, srv) {
		remember_socket_ip(req, srv.requestIP(req)?.address ?? null);
		const upgraded = upgrade_socket_io(req, srv);
		if (upgraded === 'upgraded') return undefined;
		if (upgraded) return upgraded;
		return handle_socket_io(req) ?? new Response('no', { status: 404 });
	},
});

afterAll(() => {
	void server.stop(true);
});

type Client = {
	ws: WebSocket;
	emit: (event: string, data: unknown) => Promise<Record<string, unknown>>;
	/** El siguiente evento propio con ese nombre. */
	next: (event: string) => Promise<ImperiumDoc>;
	/** Los eventos de ese nombre que llegaron y nadie leyó. */
	pending: (event: string) => ImperiumDoc[];
	closed: Promise<void>;
};

let ack_ids = 0;

async function connect(who: { user_id: string } | { ticket: string }): Promise<Client> {
	const cookie = `llamada-${hex_id()}`;
	if ('user_id' in who) sessions.set(cookie, who.user_id);
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/socket.io/?EIO=4&transport=websocket`, {
		headers: 'user_id' in who ? { cookie: `connect.sid=${cookie}` } : {},
	} as unknown as string[]);
	const inbox: string[] = [];
	let wake = () => {};
	ws.onmessage = (ev) => {
		const packet = String(ev.data);
		if (packet === '2') ws.send('3');
		else inbox.push(packet);
		wake();
	};
	const take = async (match: (packet: string) => boolean): Promise<string> => {
		const deadline = Date.now() + 5000;
		for (;;) {
			const at = inbox.findIndex(match);
			if (at >= 0) return inbox.splice(at, 1)[0]!;
			if (Date.now() > deadline) throw new Error('sin paquete del servidor');
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, 50);
			});
		}
	};
	const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error('no abrió el WebSocket'));
	});
	await take((packet) => packet.startsWith('0'));
	ws.send('ticket' in who ? `40${JSON.stringify({ ticket: who.ticket })}` : '40');
	await take((packet) => packet.startsWith('40'));
	const of = (event: string) => (packet: string) => packet.startsWith(`42["${event}"`);
	const body = (packet: string) => (JSON.parse(packet.slice(2)) as [string, ImperiumDoc])[1];
	return {
		ws,
		closed,
		async emit(event, data) {
			const id = ++ack_ids;
			ws.send(`42${id}${JSON.stringify([event, data])}`);
			const packet = await take((candidate) => candidate.startsWith(`43${id}[`));
			return (JSON.parse(packet.slice(`43${id}`.length)) as Record<string, unknown>[])[0]!;
		},
		next: async (event) => body(await take(of(event))),
		pending: (event) => inbox.filter(of(event)).map(body),
	};
}

function person(name: string): string {
	const id = hex_id();
	names.set(id, name);
	return id;
}

/** Una llamada 1:1 ya contestada: `ana` con la pata `ana-leg` y `beto` con `beto-leg`. */
function active_call(ana: string, beto: string, extra: ImperiumDoc = {}): string {
	const id = hex_id();
	calls.set(id, {
		_id: id,
		state: 'active',
		v: 1,
		kind: 'direct',
		media: 'video',
		topology: 'mesh',
		conversation_id: hex_id(),
		conversationKey: [ana, beto].sort().join('::'),
		initiatorId: ana,
		participantIds: [ana, beto],
		started_at: new Date().toISOString(),
		legs: [
			{ userId: ana, state: 'joined', device: 'ana-leg', invitedAt: '' },
			{ userId: beto, state: 'joined', device: 'beto-leg', invitedAt: '' },
		],
		...extra,
	});
	return id;
}

async function close_all(...clients: Client[]): Promise<void> {
	for (const client of clients) client.ws.close();
	await Promise.all(clients.map((client) => client.closed));
	await Bun.sleep(100);
}

describe('call:attach', () => {
	test('la pata propia y unida entra a la sala; recibe roster, política y topología, y los demás la ven', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const call_id = active_call(ana, beto);
		const [a, b] = await Promise.all([connect({ user_id: ana }), connect({ user_id: beto })]);
		const first = await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		expect(first).toMatchObject({
			ok: true,
			topology: 'mesh',
			hands: [],
			member_key: `u:${ana}`,
			policy: { locked: false, allow_unmute: true, cams_allowed: true },
			roster: [
				{
					member_key: `u:${ana}`,
					leg_id: 'ana-leg',
					name: 'Ana',
					role: 'host',
					media: { mic: true, cam: true, screen: false, audio_only: false },
					hard_muted: false,
				},
			],
		});
		expect(JSON.stringify(first)).not.toContain('session_id');
		const second = await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		expect((second.roster as ImperiumDoc[]).map((entry) => entry.leg_id).sort()).toEqual(['ana-leg', 'beto-leg']);
		expect(await a.next('call:roster')).toMatchObject({ call_id, upsert: [{ leg_id: 'beto-leg', role: 'participant', name: 'Beto' }] });
		expect(b.pending('call:roster')).toEqual([]);
		await close_all(a, b);
		for (const user_id of [ana, beto]) mark_leg_attached(call_id, user_id, `${user_id === ana ? 'ana' : 'beto'}-leg`);
	}, 30_000);

	test('otra pata, otra persona, una llamada terminada o un invitado sin admitir no entran', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const carla = person('Carla');
		const call_id = active_call(ana, beto);
		const ended = active_call(ana, beto, { state: 'ended' });
		const [a, c] = await Promise.all([connect({ user_id: ana }), connect({ user_id: carla })]);
		expect(await a.emit('call:attach', { call_id, leg_id: 'otra-pestana' })).toMatchObject({ ok: false, code: 'not_member' });
		expect(await c.emit('call:attach', { call_id, leg_id: 'beto-leg' })).toMatchObject({ ok: false, code: 'not_member' });
		expect(await a.emit('call:attach', { call_id: ended, leg_id: 'ana-leg' })).toMatchObject({ ok: false, code: 'call_ended' });
		expect(await a.emit('call:attach', { call_id: hex_id(), leg_id: 'ana-leg' })).toMatchObject({ ok: false, code: 'call_not_found' });
		expect(await a.emit('call:attach', { call_id: 'nada', leg_id: 'ana-leg' })).toMatchObject({ ok: false, code: 'invalid_request' });
		const ticket = sign_realtime_token({
			t: 'socket',
			gid: hex_id(),
			mid: hex_id(),
			name: 'Invitada',
			n: hex_id(),
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const guest = await connect({ ticket });
		expect(await guest.emit('call:attach', { call_id, leg_id: 'g-leg' })).toMatchObject({ ok: false, code: 'guest_not_admitted' });
		expect(room_state(call_id).members).toEqual([]);
		await close_all(a, c, guest);
	}, 30_000);
});

describe('rtc:signal, call:media y call:prefs', () => {
	test('la señal va de pata a pata con from_leg del servidor; sin pata en la sala no se habla', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const carla = person('Carla');
		const call_id = active_call(ana, beto);
		const [a, b, c] = await Promise.all([connect({ user_id: ana }), connect({ user_id: beto }), connect({ user_id: carla })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		const offer = { type: 'offer', sdp: 'v=0' };
		expect(
			await a.emit('rtc:signal', { call_id, to_leg: 'beto-leg', from_leg: 'mentira', seq: 1, description: offer, extra: 'x' }),
		).toEqual({ ok: true });
		expect(await b.next('rtc:signal')).toEqual({ call_id, from_leg: 'ana-leg', seq: 1, description: offer });
		const candidate = { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };
		await b.emit('rtc:signal', { call_id, to_leg: 'ana-leg', seq: 2, candidate, restart: true });
		expect(await a.next('rtc:signal')).toEqual({ call_id, from_leg: 'beto-leg', seq: 2, candidate, restart: true });
		expect(await a.emit('rtc:signal', { call_id, to_leg: 'nadie', seq: 3 })).toMatchObject({ ok: false, code: 'forbidden' });
		expect(await a.emit('rtc:signal', { call_id, to_leg: 'ana-leg', seq: 3 })).toMatchObject({ ok: false, code: 'forbidden' });
		expect(await c.emit('rtc:signal', { call_id, to_leg: 'ana-leg', seq: 1 })).toMatchObject({ ok: false, code: 'forbidden' });
		const huge = { call_id, to_leg: 'beto-leg', seq: 4, description: { type: 'offer', sdp: 'x'.repeat(70_000) } };
		expect(await a.emit('rtc:signal', huge)).toMatchObject({ ok: false, code: 'event_too_large' });
		await close_all(a, b, c);
		mark_leg_attached(call_id, ana, 'ana-leg');
		mark_leg_attached(call_id, beto, 'beto-leg');
	}, 30_000);

	test('los medios se reflejan en el roster de todos; las preferencias van a los pares', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const call_id = active_call(ana, beto);
		const [a, b] = await Promise.all([connect({ user_id: ana }), connect({ user_id: beto })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		await a.next('call:roster');
		expect(
			await b.emit('call:media', { call_id, mic: false, cam: true, screen: false, audio_only: false, cam_stream_id: 'cam-b' }),
		).toEqual({ ok: true });
		for (const client of [a, b]) {
			expect(await client.next('call:roster')).toMatchObject({
				call_id,
				upsert: [{ leg_id: 'beto-leg', media: { mic: false, cam: true }, cam_stream_id: 'cam-b' }],
			});
		}
		expect(await a.emit('call:prefs', { call_id, receive_video: false })).toEqual({ ok: true });
		expect(await b.next('call:prefs')).toEqual({ call_id, from_leg: 'ana-leg', receive_video: false });
		expect(a.pending('call:prefs')).toEqual([]);
		expect(await a.emit('call:prefs', { call_id, receive_video: 'no' })).toMatchObject({ ok: false, code: 'invalid_request' });
		await close_all(a, b);
		mark_leg_attached(call_id, ana, 'ana-leg');
		mark_leg_attached(call_id, beto, 'beto-leg');
	}, 30_000);

	test('en una llamada de grupo quien la inició destaca para todos y nada más', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const call_id = active_call(ana, beto, { kind: 'group', conversationKey: '' });
		const [a, b] = await Promise.all([connect({ user_id: ana }), connect({ user_id: beto })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		await a.next('call:roster');
		expect(await a.emit('meeting:host', { call_id, command: { type: 'spotlight', member_keys: [`u:${beto}`] } })).toEqual({ ok: true });
		for (const client of [a, b]) {
			expect(await client.next('meeting:policy')).toMatchObject({ call_id, policy: { spotlight: [`u:${beto}`] } });
		}
		expect(await b.emit('meeting:host', { call_id, command: { type: 'spotlight', member_keys: [] } })).toMatchObject({
			ok: false,
			code: 'not_host',
		});
		expect(await a.emit('meeting:host', { call_id, command: { type: 'lock', locked: true } })).toMatchObject({
			ok: false,
			code: 'invalid_request',
		});
		await close_all(a, b);
		mark_leg_attached(call_id, ana, 'ana-leg');
		mark_leg_attached(call_id, beto, 'beto-leg');
	}, 30_000);
});

describe('red', () => {
	test('al caerse el socket la pata sale de la sala y deja de recibir señal; al volver, entra de nuevo', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const call_id = active_call(ana, beto);
		const [a, b] = await Promise.all([connect({ user_id: ana }), connect({ user_id: beto })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		await a.next('call:roster');
		await close_all(b);
		expect(await a.next('call:roster')).toEqual({ call_id, remove: ['beto-leg'] });
		expect(await a.emit('rtc:signal', { call_id, to_leg: 'beto-leg', seq: 1 })).toMatchObject({ ok: false, code: 'forbidden' });
		const again = await connect({ user_id: beto });
		const ack = await again.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		expect((ack.roster as ImperiumDoc[]).map((entry) => entry.leg_id).sort()).toEqual(['ana-leg', 'beto-leg']);
		expect(await a.next('call:roster')).toMatchObject({ upsert: [{ leg_id: 'beto-leg' }] });
		await close_all(a, again);
		mark_leg_attached(call_id, ana, 'ana-leg');
		mark_leg_attached(call_id, beto, 'beto-leg');
	}, 30_000);
});

/** Una reunión en vivo: `ana` la organiza, `beto` participa y la invitada `gid` ya fue admitida. */
function live_meeting(ana: string, beto: string, gid: string, room: { transcript?: { started_at: number } } = {}): { call_id: string; meeting_id: string } {
	const call_id = hex_id();
	const meeting_id = hex_id();
	meetings.set(meeting_id, {
		_id: meeting_id,
		name: 'Junta',
		state: 'live',
		code: 'abc-defg-hjk',
		host_id: ana,
		memberIds: [ana, beto],
		conversationId: 'conv-junta',
		activeCallId: call_id,
	});
	calls.set(call_id, {
		_id: call_id,
		state: 'active',
		v: 0,
		kind: 'meeting',
		media: 'video',
		topology: 'mesh',
		conversation_id: 'conv-junta',
		meeting_id,
		initiatorId: ana,
		participantIds: [],
		legs: [],
		started_at: new Date().toISOString(),
	});
	open_meeting_room({ call_id, meeting_id, conversation_id: 'conv-junta', policy: {}, entry: { muted: true, cams_off: true }, blocked: [], ...room });
	for (const person of [
		{ member_key: `u:${ana}`, name: 'Ana', role: 'host' as const },
		{ member_key: `u:${beto}`, name: 'Beto', role: 'participant' as const },
		{ member_key: `g:${gid}`, name: 'Invitada', role: 'guest' as const, guest: true as const, visible_from_seq: 4 },
	]) {
		run_room_command(call_id, { type: 'admit_direct', person });
	}
	return { call_id, meeting_id };
}

function guest_ticket(gid: string, meeting_id: string): string {
	return sign_realtime_token({ t: 'socket', gid, mid: meeting_id, name: 'Invitada', n: hex_id(), exp: Math.floor(Date.now() / 1000) + 60 });
}

describe('reuniones por el socket', () => {
	test('entra quien la sala admitió, con su rol y la entrada que pide la reunión; nadie más', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const dario = person('Darío');
		const gid = hex_id();
		const { call_id, meeting_id } = live_meeting(ana, beto, gid);
		const [a, d, g, other] = await Promise.all([
			connect({ user_id: ana }),
			connect({ user_id: dario }),
			connect({ ticket: guest_ticket(gid, meeting_id) }),
			connect({ ticket: guest_ticket(gid, hex_id()) }),
		]);
		expect(await a.emit('call:attach', { call_id, leg_id: 'ana-leg' })).toMatchObject({
			ok: true,
			member_key: `u:${ana}`,
			roster: [{ member_key: `u:${ana}`, name: 'Ana', role: 'host', media: { mic: false, cam: false } }],
		});
		expect(await d.emit('call:attach', { call_id, leg_id: 'dario-leg' })).toMatchObject({ ok: false, code: 'guest_not_admitted' });
		expect(await other.emit('call:attach', { call_id, leg_id: 'g-leg' })).toMatchObject({ ok: false, code: 'guest_not_admitted' });
		const joined = await g.emit('call:attach', { call_id, leg_id: 'g-leg' });
		expect(joined).toMatchObject({ ok: true, member_key: `g:${gid}` });
		expect((joined.roster as ImperiumDoc[]).find((entry) => entry.leg_id === 'g-leg')).toMatchObject({ name: 'Invitada', role: 'guest', guest: true });
		await close_all(a, d, g, other);
		expect(attendance.filter((row) => row.call_id === call_id).map((row) => [row.participant_key, (row.payload as ImperiumDoc).intervals]).length).toBe(2);
		expect(attendance.find((row) => row.participant_key === `g:${gid}`)!.payload).toMatchObject({
			intervals: [expect.objectContaining({ reason: 'network' })],
			visibleFromSeq: 4,
		});
	}, 30_000);

	test('meeting:host: solo quien modera; silenciar y expulsar llegan a la persona y la expulsada ya no habla en la sala', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const gid = hex_id();
		const { call_id, meeting_id } = live_meeting(ana, beto, gid);
		const [a, b, g] = await Promise.all([
			connect({ user_id: ana }),
			connect({ user_id: beto }),
			connect({ ticket: guest_ticket(gid, meeting_id) }),
		]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		await g.emit('call:attach', { call_id, leg_id: 'g-leg' });
		expect(await b.emit('meeting:host', { call_id, command: { type: 'mute', member_key: `u:${ana}` } })).toMatchObject({
			ok: false,
			code: 'not_host',
		});
		expect(await g.emit('meeting:host', { call_id, command: { type: 'lock', locked: true } })).toMatchObject({ ok: false, code: 'forbidden' });
		expect(await a.emit('meeting:host', { call_id, command: { type: 'shout' } })).toMatchObject({ ok: false, code: 'invalid_request' });
		expect(await a.emit('meeting:host', { call_id, command: { type: 'mute', member_key: `u:${beto}` } })).toEqual({ ok: true });
		expect(await b.next('meeting:command')).toEqual({ call_id, type: 'muted', data: { hard_muted: false } });
		expect(await a.emit('meeting:host', { call_id, command: { type: 'lock', locked: true } })).toEqual({ ok: true });
		expect(await b.next('meeting:policy')).toMatchObject({ call_id, policy: { locked: true } });
		expect(await a.emit('meeting:host', { call_id, command: { type: 'kick', member_key: `g:${gid}`, block: true } })).toEqual({ ok: true });
		expect(await g.next('meeting:command')).toEqual({ call_id, type: 'expelled', data: { blocked: true } });
		expect(await g.emit('rtc:signal', { call_id, to_leg: 'ana-leg', seq: 1 })).toMatchObject({ ok: false, code: 'forbidden' });
		expect(room_state(call_id).blocked).toEqual([`g:${gid}`]);
		const second = hex_id();
		run_room_command(call_id, { type: 'admit_direct', person: { member_key: `g:${second}`, name: 'Otra', role: 'guest', guest: true } });
		const other = await connect({ ticket: guest_ticket(second, meeting_id) });
		await other.emit('call:attach', { call_id, leg_id: 'g2-leg' });
		await publish_meeting(store as unknown as ImperiumStore, meeting_from_row(meetings.get(meeting_id)!), 'ended');
		// Al invitado le llega el cambio sin la vista: no ve invitados, correos ni ajustes.
		expect(await other.next('update')).toEqual({ action: 'meeting_update', data: [{ meeting_id, change: 'ended' }] });
		expect(await a.next('update')).toMatchObject({ action: 'meeting_update', data: [{ meeting_id, change: 'ended', meeting: { _id: meeting_id } }] });
		await close_all(other);
		expect(attendance.find((row) => row.call_id === call_id && row.participant_key === `g:${gid}`)!.payload).toMatchObject({ outcome: 'expelled' });
		await close_all(a, b, g);
	}, 30_000);
});

describe('manos, reacciones y señales de la sala', () => {
	test('la cola sale a toda la sala en orden de llegada al servidor; quien modera la baja; un invitado también levanta la mano', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const gid = hex_id();
		const { call_id, meeting_id } = live_meeting(ana, beto, gid);
		const [a, b, g] = await Promise.all([connect({ user_id: ana }), connect({ user_id: beto }), connect({ ticket: guest_ticket(gid, meeting_id) })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		await g.emit('call:attach', { call_id, leg_id: 'g-leg' });
		expect(await g.emit('meeting:hand', { call_id, up: true })).toEqual({ ok: true });
		const first = await a.next('meeting:hands');
		expect(first).toMatchObject({ call_id, queue: [{ member_key: `g:${gid}`, name: 'Invitada' }] });
		expect(await b.emit('meeting:hand', { call_id, up: true, at: 1 })).toEqual({ ok: true });
		const second = await a.next('meeting:hands');
		const queue = second.queue as Array<{ member_key: string; at: number }>;
		expect(queue.map((item) => item.member_key)).toEqual([`g:${gid}`, `u:${beto}`]);
		expect(queue[1]!.at).toBeGreaterThanOrEqual(queue[0]!.at);
		expect(queue[1]!.at).toBeGreaterThan(1);
		expect(await b.emit('meeting:hand', { call_id, up: 'sí' })).toMatchObject({ ok: false, code: 'invalid_request' });
		expect(await b.emit('meeting:host', { call_id, command: { type: 'lower_all_hands' } })).toMatchObject({ ok: false, code: 'not_host' });
		await g.next('meeting:hands');
		await g.next('meeting:hands');
		expect(await a.emit('meeting:host', { call_id, command: { type: 'lower_hand', member_key: `g:${gid}` } })).toEqual({ ok: true });
		expect((await g.next('meeting:hands')).queue).toEqual([expect.objectContaining({ member_key: `u:${beto}` })]);
		expect(await a.emit('meeting:host', { call_id, command: { type: 'lower_all_hands' } })).toEqual({ ok: true });
		expect(await g.next('meeting:hands')).toEqual({ call_id, queue: [] });
		await close_all(a, b, g);
		expect(attendance.find((row) => row.call_id === call_id && row.participant_key === `u:${beto}`)!.payload).toMatchObject({ hands: 1 });
	}, 30_000);

	test('reacciones de la lista blanca a toda la sala, con cuota; señales en el roster; nada de esto fuera de una reunión', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const gid = hex_id();
		const { call_id, meeting_id } = live_meeting(ana, beto, gid);
		const [a, g] = await Promise.all([connect({ user_id: ana }), connect({ ticket: guest_ticket(gid, meeting_id) })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await g.emit('call:attach', { call_id, leg_id: 'g-leg' });
		await a.next('call:roster');
		expect(await g.emit('meeting:react', { call_id, emoji: '👏' })).toEqual({ ok: true });
		expect(await a.next('meeting:reaction')).toEqual({ call_id, from_key: `g:${gid}`, emoji: '👏' });
		expect(await g.emit('meeting:react', { call_id, emoji: '👍' })).toMatchObject({ ok: false, code: 'socket_rate_limited' });
		await Bun.sleep(1_050);
		expect(await g.emit('meeting:react', { call_id, emoji: '💩' })).toMatchObject({ ok: false, code: 'invalid_emoji' });
		expect(await g.emit('meeting:signal', { call_id, signal: 'despacio' })).toEqual({ ok: true });
		expect(await a.next('call:roster')).toMatchObject({ call_id, upsert: [{ member_key: `g:${gid}`, signal: 'despacio' }] });
		expect(await g.emit('meeting:signal', { call_id, signal: null })).toEqual({ ok: true });
		expect(((await a.next('call:roster')).upsert as ImperiumDoc[])[0]!.signal).toBeUndefined();
		await Bun.sleep(1_050);
		expect(await g.emit('meeting:signal', { call_id, signal: 'quizá' })).toMatchObject({ ok: false, code: 'invalid_request' });
		const carla = person('Carla');
		const direct = active_call(ana, carla);
		const c = await connect({ user_id: carla });
		await c.emit('call:attach', { call_id: direct, leg_id: 'beto-leg' });
		expect(await c.emit('meeting:hand', { call_id: direct, up: true })).toMatchObject({ ok: false, code: 'invalid_request' });
		await close_all(a, g, c);
		expect(attendance.find((row) => row.call_id === call_id && row.participant_key === `g:${gid}`)!.payload).toMatchObject({ reactions: 1 });
	}, 30_000);
});

describe('pizarra por el socket', () => {
	test('el trazo llega a los demás con su lugar en la bitácora; quien llega tarde la recibe al adjuntarse', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const gid = hex_id();
		const { call_id, meeting_id } = live_meeting(ana, beto, gid);
		const [a, g] = await Promise.all([connect({ user_id: ana }), connect({ ticket: guest_ticket(gid, meeting_id) })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await g.emit('call:attach', { call_id, leg_id: 'g-leg' });
		const op = { id: 'trazo-1', kind: 'trazo', points: [[0.123456, 1], [0, 0.5]], color: 7, width: 5 };
		expect(await g.emit('meeting:board', { call_id, op })).toEqual({ ok: true, seq: 1 });
		const stored = { ...op, points: [[0.1235, 1], [0, 0.5]], by: `g:${gid}`, seq: 1 };
		expect(await a.next('meeting:board')).toEqual({ call_id, seq: 1, op: stored });
		expect(g.pending('meeting:board')).toEqual([]);
		for (const bad of [
			{ ...op, points: [[1.2, 0]] },
			{ ...op, color: 8 },
			{ ...op, width: 0 },
			{ ...op, points: [] },
			{ ...op, kind: 'pintar' },
			{ ...op, id: 'con espacio' },
		]) {
			expect(await g.emit('meeting:board', { call_id, op: bad })).toMatchObject({ ok: false, code: 'invalid_request' });
		}
		expect(await g.emit('meeting:board', { call_id, op: { id: 'c', kind: 'limpiar' } })).toMatchObject({ ok: false, code: 'not_host' });
		const b = await connect({ user_id: beto });
		const late = await b.emit('call:attach', { call_id, leg_id: 'beto-leg' });
		expect(late.board).toEqual({ seq: 1, ops: [stored] });
		expect(await a.emit('meeting:board', { call_id, op: { id: 'c', kind: 'limpiar' } })).toEqual({ ok: true, seq: 2 });
		expect(await b.next('meeting:board')).toEqual({ call_id, seq: 2, op: { id: 'c', kind: 'limpiar', by: `u:${ana}`, seq: 2 } });
		await close_all(a, g, b);
	}, 30_000);
});

describe('subtítulos por el socket', () => {
	test('solo con los subtítulos encendidos; van a los demás como texto con quien habla puesto por el servidor; los finales se guardan', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const gid = hex_id();
		const { call_id, meeting_id } = live_meeting(ana, beto, gid, { transcript: { started_at: Date.now() - 10_000 } });
		const [a, g] = await Promise.all([connect({ user_id: ana }), connect({ ticket: guest_ticket(gid, meeting_id) })]);
		await a.emit('call:attach', { call_id, leg_id: 'ana-leg' });
		await g.emit('call:attach', { call_id, leg_id: 'g-leg' });
		const caption = { call_id, text: '<b>Hola</b>\nclase', final: true, lang: 'es-MX', t0_ms: 0, t1_ms: 2_000, speaker_key: 'u:otro' };
		expect(await g.emit('meeting:caption', caption)).toMatchObject({ ok: false, code: 'forbidden' });
		expect(await g.emit('meeting:host', { call_id, command: { type: 'captions', on: true } })).toMatchObject({ ok: false, code: 'forbidden' });
		expect(await a.emit('meeting:host', { call_id, command: { type: 'captions', on: true } })).toEqual({ ok: true });
		expect(await g.next('meeting:policy')).toMatchObject({ policy: { captions_on: true } });
		expect(await g.emit('meeting:caption', caption)).toEqual({ ok: true });
		expect(await a.next('meeting:caption')).toEqual({
			call_id,
			speaker_key: `g:${gid}`,
			speaker_name: 'Invitada',
			text: '<b>Hola</b> clase',
			final: true,
			lang: 'es-MX',
		});
		expect(g.pending('meeting:caption')).toEqual([]);
		expect(await g.emit('meeting:caption', { ...caption, final: false, text: 'Ho' })).toEqual({ ok: true });
		await Bun.sleep(1_050);
		for (const bad of [{ ...caption, text: 'x'.repeat(301) }, { ...caption, text: '  ' }, { ...caption, lang: 'español' }, { ...caption, final: 'sí' }]) {
			expect(await g.emit('meeting:caption', bad)).toMatchObject({ ok: false, code: 'invalid_request' });
		}
		await flush_transcript(store as unknown as ImperiumStore, call_id, { final: true });
		const block = inserted.find((row) => row.call_id === call_id)!;
		expect(block).toMatchObject({ resource: 'chat-meeting-transcripts', meeting_id, seq: 0 });
		const cues = block.cues as ImperiumDoc[];
		expect(cues).toHaveLength(1);
		expect(cues[0]).toMatchObject({ speakerKey: `g:${gid}`, speakerName: 'Invitada', text: '<b>Hola</b> clase', lang: 'es-MX' });
		const end = Number(cues[0]!.endMs);
		expect(end).toBeGreaterThanOrEqual(10_000);
		expect(end - Number(cues[0]!.startMs)).toBe(2_000);
		await close_all(a, g);
	}, 30_000);
});
