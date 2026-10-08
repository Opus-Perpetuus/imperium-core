/**
 * Señalización WebRTC por sala de llamada (contrato §5.5 y §6.3). El servidor nunca guarda la
 * señal: comprueba que emisor y destino sean patas adjuntas a la misma llamada y la reenvía con
 * `from_leg` atestado. Solo el servidor une una sesión a `call:<id>` (y a un invitado admitido, a
 * `meeting:<id>`). Los comandos de anfitrión llegan por aquí y los cumple `meetings-flow.ts`.
 */
import type { RoomRole } from './call-state.ts';
import {
	admitted_person,
	attendance_camera,
	attendance_count,
	breakouts_view,
	attendance_enter,
	attendance_exit,
	flush_attendance,
	room_member,
	room_state,
	rooms_of_session,
	run_room_command,
	roster_entry,
	save_caption,
	type BoardInput,
	type HostCommand,
	type RoomMedia,
	type RoomPerson,
	type RoomSignal,
} from './call-room.ts';
import { call_from_row, mark_leg_attached, mark_leg_detached, note_network_lost } from './calls-flow.ts';
import { ChatError } from './chat-access.ts';
import { print_console_log } from './debug-request-log.ts';
import { as_object } from './envelope.ts';
import { run_host_command } from './meetings-flow.ts';
import {
	emit_to_room,
	emit_to_session,
	join_room_server,
	on_socket_close,
	on_socket_event,
	type SocketEventContext,
} from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

const CHAT_ID = /^[a-f0-9]{24}$/i;
const LEG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SIGNAL_MAX_BYTES = 64 * 1024;

let store: ImperiumStore;

function invalid(): ChatError {
	return new ChatError(422, 'invalid_request', 'La petición no es válida.');
}

function forbidden(): ChatError {
	return new ChatError(403, 'forbidden', 'No tienes permiso para hacer esto.');
}

function report(err: unknown): void {
	print_console_log('error', `Señalización de llamadas: ${err instanceof Error ? err.message : String(err)}`);
}

function call_id_of(data: Record<string, unknown>): string {
	const id = String(data.call_id ?? '');
	if (!CHAT_ID.test(id)) throw invalid();
	return id;
}

function leg_of(value: unknown): string {
	const leg_id = String(value ?? '');
	if (!LEG_ID.test(leg_id)) throw invalid();
	return leg_id;
}

/** La pata de esta sesión en esa llamada; sin ella no se habla en la sala. */
function sender(ctx: SocketEventContext, call_id: string) {
	const member = room_member(call_id, { session_id: ctx.session_id });
	if (!member) throw forbidden();
	return member;
}

/**
 * La pata es propia y está unida (o, si es invitado, admitida en su reunión). Une la sesión a
 * `call:<id>` y responde con lo que el cliente necesita para conectarse; se repite al reconectar.
 */
async function on_attach(ctx: SocketEventContext, raw: unknown): Promise<Record<string, unknown>> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const leg_id = leg_of(data.leg_id);
	const row = await store.find_id('chat-calls', call_id);
	if (!row || row.is_active === false) throw new ChatError(404, 'call_not_found', 'No encontramos esa llamada.');
	const call = call_from_row(row);
	if (call.state === 'ended') throw new ChatError(409, 'call_ended', 'La llamada terminó.');
	let member_key: string;
	let name: string;
	let role: RoomRole;
	let admitted: RoomPerson | undefined;
	const room = room_state(call_id, call.meeting_id);
	if (ctx.identity.kind === 'guest' || call.kind === 'meeting') {
		// En una reunión entra quien la sala admitió; un invitado, solo a la de su reunión.
		const key = ctx.identity.kind === 'guest' ? `g:${ctx.identity.guest_id}` : `u:${ctx.identity.user_id}`;
		const person = ctx.identity.kind === 'guest' && call.meeting_id !== ctx.identity.meeting_id ? undefined : admitted_person(call_id, key);
		if (!person) throw new ChatError(403, 'guest_not_admitted', 'Espera a que el anfitrión te admita.');
		admitted = person;
		member_key = key;
		name = person.name;
		role = person.role;
	} else {
		const user_id = ctx.identity.user_id;
		const leg = call.legs.find((item) => item.user_id === user_id);
		if (leg?.state !== 'joined' || leg.device !== leg_id) {
			throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
		}
		member_key = `u:${user_id}`;
		const [user] = await store.chat_users_brief([user_id]);
		name = user?.name ?? '';
		role = user_id === call.initiator_id ? 'host' : 'participant';
	}
	const previous = room_member(call_id, { leg_id });
	if (previous && previous.member_key !== member_key) throw forbidden();
	join_room_server(ctx.session_id, `call:${call_id}`);
	if (ctx.identity.kind === 'guest') join_room_server(ctx.session_id, `meeting:${ctx.identity.meeting_id}`);
	const result = run_room_command(
		call_id,
		{
			type: 'attach',
			member: {
				member_key,
				leg_id,
				name,
				role,
				...(member_key.startsWith('g:') ? { guest: true as const } : {}),
				media: {
					mic: !room.entry.muted,
					cam: call.media === 'video' && !room.entry.cams_off,
					screen: false,
					audio_only: false,
				},
				hard_muted: false,
				speaker: false,
				session_id: ctx.session_id,
			},
		},
		{ meeting_id: call.meeting_id, except: ctx.session_id },
	);
	if (!result.ok) throw forbidden();
	if (admitted) {
		const attached = result.room.members.find((item) => item.leg_id === leg_id);
		attendance_enter(call_id, admitted, leg_id, Date.now(), Boolean(result.room.policy.recording));
		if (attached?.media.cam) attendance_camera(call_id, member_key, true, Date.now());
	} else if (ctx.identity.kind === 'user') mark_leg_attached(call_id, ctx.identity.user_id, leg_id);
	const parent = result.room.parent_call_id ? room_state(result.room.parent_call_id) : result.room;
	return {
		roster: result.room.members.map(roster_entry),
		policy: result.room.policy,
		topology: call.topology,
		hands: result.room.hands,
		member_key,
		...(result.room.board?.ops.length ? { board: { seq: result.room.board.seq, ops: result.room.board.ops } } : {}),
		...(parent.breakouts ? { breakouts: breakouts_view(parent, parent.breakouts.rooms) } : {}),
	};
}

function on_signal(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = sender(ctx, call_id);
	const to_leg = leg_of(data.to_leg);
	const target = room_member(call_id, { leg_id: to_leg });
	if (!target || target.leg_id === from.leg_id) throw forbidden();
	const seq = Number(data.seq);
	if (!Number.isFinite(seq)) throw invalid();
	const description = data.description == null ? undefined : as_object(data.description);
	const candidate = data.candidate == null ? undefined : as_object(data.candidate);
	if (description && (typeof description.type !== 'string' || typeof (description.sdp ?? '') !== 'string')) throw invalid();
	emit_to_session(target.session_id, 'rtc:signal', {
		call_id,
		from_leg: from.leg_id,
		seq,
		...(description ? { description: { type: description.type, sdp: description.sdp } } : {}),
		...(candidate ? { candidate } : {}),
		...(data.restart === true ? { restart: true } : {}),
	});
	return {};
}

function on_media(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = sender(ctx, call_id);
	const media: RoomMedia = {
		mic: data.mic === true,
		cam: data.cam === true,
		screen: data.screen === true,
		audio_only: data.audio_only === true,
	};
	const stream = (value: unknown) => (typeof value === 'string' && value.length <= 128 ? value : undefined);
	const result = run_room_command(call_id, {
		type: 'media',
		leg_id: from.leg_id,
		media,
		cam_stream_id: stream(data.cam_stream_id),
		screen_stream_id: stream(data.screen_stream_id),
	});
	if (!result.ok) throw forbidden();
	if (result.room.meeting_id && from.media.cam !== media.cam) attendance_camera(call_id, from.member_key, media.cam, Date.now());
	return {};
}

const MEMBER_KEY = /^[ug]:[A-Za-z0-9_-]{1,64}$/;
const ROOM_ROLES = ['cohost', 'presenter', 'participant'] as const;

/** `HostCommand` (contrato §3.6) de lo que mandó el cliente; lo demás es `invalid_request`. */
function host_command_of(raw: unknown): HostCommand {
	const data = as_object(raw);
	const key = () => {
		const value = String(data.member_key ?? '');
		if (!MEMBER_KEY.test(value)) throw invalid();
		return value;
	};
	const flag = (field: string) => {
		const value = data[field];
		if (typeof value !== 'boolean') throw invalid();
		return value;
	};
	switch (data.type) {
		case 'admit':
		case 'deny':
			return { type: data.type, member_key: key() };
		case 'grant_floor':
		case 'revoke_floor':
		case 'lower_hand':
			return { type: data.type, member_key: key() };
		case 'lower_all_hands':
			return { type: 'lower_all_hands' };
		case 'spotlight': {
			const keys = data.member_keys;
			if (!Array.isArray(keys) || !keys.every((value) => typeof value === 'string' && MEMBER_KEY.test(value))) throw invalid();
			return { type: 'spotlight', member_keys: keys as string[] };
		}
		case 'mute':
			return { type: 'mute', member_key: key() };
		case 'admit_all':
		case 'allow_unmute':
		case 'end':
			return { type: data.type };
		case 'cams_off':
			return data.member_key == null ? { type: 'cams_off' } : { type: 'cams_off', member_key: key() };
		case 'kick':
			return { type: 'kick', member_key: key(), block: flag('block') };
		case 'mute_all':
			return { type: 'mute_all', allow_unmute: flag('allow_unmute') };
		case 'lock':
			return { type: 'lock', locked: flag('locked') };
		case 'set_role': {
			const role = ROOM_ROLES.find((item) => item === data.role);
			if (!role) throw invalid();
			return { type: 'set_role', member_key: key(), role };
		}
		case 'breakouts_open': {
			const assign = data.assign == null ? 'manual' : data.assign;
			if ((assign !== 'manual' && assign !== 'random') || !Array.isArray(data.rooms) || typeof data.minutes !== 'number') throw invalid();
			const rooms = data.rooms.map((raw) => {
				const room = as_object(raw);
				const keys = room.member_keys ?? [];
				if (typeof room.name !== 'string' || !Array.isArray(keys) || !keys.every((value) => typeof value === 'string' && MEMBER_KEY.test(value))) {
					throw invalid();
				}
				return { name: room.name, member_keys: keys as string[] };
			});
			return { type: 'breakouts_open', rooms, minutes: data.minutes, assign };
		}
		case 'breakouts_broadcast':
			if (typeof data.text !== 'string') throw invalid();
			return { type: 'breakouts_broadcast', text: data.text };
		case 'breakouts_close':
			return { type: 'breakouts_close' };
		case 'captions':
			return { type: 'captions', on: flag('on') };
		default:
			throw invalid();
	}
}

/** Anfitrión o coanfitrión adjunto a la sala; `end` y nombrar coanfitrión, solo el anfitrión. */
async function on_host(ctx: SocketEventContext, raw: unknown): Promise<Record<string, unknown>> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = sender(ctx, call_id);
	const command = host_command_of(data.command);
	if (!room_state(call_id).meeting_id) {
		// En una llamada de grupo quien la inició (rol host en la sala) solo destaca para todos.
		if (command.type !== 'spotlight') throw invalid();
		const result = run_room_command(call_id, { type: 'host', actor: { member_key: from.member_key, role: from.role }, command, now: Date.now() });
		if (!result.ok) {
			if (result.code === 'not_host') throw new ChatError(403, 'not_host', 'Solo quien inició la llamada puede destacar para todos.');
			throw invalid();
		}
		return {};
	}
	await run_host_command(store, call_id, { member_key: from.member_key, role: from.role }, command);
	return {};
}

/** Los eventos `meeting:*` son de la sala de una reunión. */
function meeting_sender(ctx: SocketEventContext, call_id: string) {
	const member = sender(ctx, call_id);
	if (!room_state(call_id).meeting_id) throw invalid();
	return member;
}

function on_hand(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = meeting_sender(ctx, call_id);
	if (typeof data.up !== 'boolean') throw invalid();
	if (!run_room_command(call_id, { type: 'hand', leg_id: from.leg_id, up: data.up, now: Date.now() }).ok) throw forbidden();
	return {};
}

/** Las 8 reacciones de la sala; no se guardan, solo cuentan en la asistencia. */
const ROOM_REACTIONS = ['👍', '👏', '❤️', '😂', '😮', '🎉', '🙌', '🤔'] as const;

function on_react(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = meeting_sender(ctx, call_id);
	const emoji = ROOM_REACTIONS.find((item) => item === data.emoji);
	if (!emoji) throw new ChatError(422, 'invalid_emoji', 'Esa reacción no es válida.');
	emit_to_room(`call:${call_id}`, 'meeting:reaction', { call_id, from_key: from.member_key, emoji });
	attendance_count(call_id, from.member_key, 'reactions');
	return {};
}

const ROOM_SIGNALS: RoomSignal[] = ['si', 'no', 'despacio', 'vuelvo'];

function on_room_signal(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = meeting_sender(ctx, call_id);
	const signal = data.signal === null ? null : ROOM_SIGNALS.find((item) => item === data.signal);
	if (signal === undefined) throw invalid();
	if (!run_room_command(call_id, { type: 'signal', leg_id: from.leg_id, signal }).ok) throw forbidden();
	return {};
}

const BOARD_OP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD_POINTS_MAX = 2000;

/** `meeting:board` (contrato §5.5): coordenadas 0..1 redondeadas, color 0..7 y grosor 1..5. */
function board_op_of(raw: unknown): BoardInput {
	const op = as_object(raw);
	const id = String(op.id ?? '');
	if (!BOARD_OP_ID.test(id)) throw invalid();
	if (op.kind === 'limpiar') return { id, kind: 'limpiar' };
	if (op.kind === 'deshacer') return { id, kind: 'deshacer' };
	if (op.kind !== 'trazo' && op.kind !== 'borrar') throw invalid();
	const whole = (value: unknown, min: number, max: number) => {
		if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw invalid();
		return value as number;
	};
	if (!Array.isArray(op.points) || !op.points.length || op.points.length > BOARD_POINTS_MAX) throw invalid();
	const points = op.points.map((point): [number, number] => {
		if (!Array.isArray(point) || point.length !== 2) throw invalid();
		const [x, y] = point.map((value) => {
			if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw invalid();
			return Math.round(value * 10_000) / 10_000;
		}) as [number, number];
		return [x, y];
	});
	return { id, kind: op.kind, points, color: whole(op.color, 0, 7), width: whole(op.width, 1, 5) };
}

function on_board(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = meeting_sender(ctx, call_id);
	const result = run_room_command(call_id, { type: 'board', leg_id: from.leg_id, op: board_op_of(data.op) }, { except: ctx.session_id });
	if (!result.ok) {
		if (result.code === 'not_host') throw new ChatError(403, 'not_host', 'Solo el anfitrión puede hacer esto.');
		if (result.code === 'board_full') throw new ChatError(422, 'invalid_request', 'La pizarra está llena; límpiala para seguir dibujando.');
		throw result.code === 'invalid_request' ? invalid() : forbidden();
	}
	return { seq: result.room.board?.seq ?? 0 };
}

const CAPTION_TEXT_MAX = 300;
const CAPTION_LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const CAPTION_SPAN_MAX_MS = 60_000;

/**
 * `meeting:caption` (contrato §5.5): texto plano a la sala, nunca HTML; el cliente lo pinta como
 * texto. Si la reunión guarda la transcripción, el subtítulo final se fecha con el reloj del
 * servidor (termina ahora y dura lo que midió quien habla) y entra al búfer.
 */
function on_caption(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = meeting_sender(ctx, call_id);
	const room = room_state(call_id);
	if (!room.policy.captions_on) throw forbidden();
	const text = (typeof data.text === 'string' ? data.text : '').replace(/\p{Cc}+/gu, ' ').trim();
	const lang = typeof data.lang === 'string' ? data.lang : '';
	const span = Number(data.t1_ms) - Number(data.t0_ms);
	if (!text || text.length > CAPTION_TEXT_MAX || typeof data.final !== 'boolean' || !CAPTION_LANG.test(lang) || !Number.isFinite(span)) {
		throw invalid();
	}
	emit_to_room(
		`call:${call_id}`,
		'meeting:caption',
		{ call_id, speaker_key: from.member_key, speaker_name: from.name, text, final: data.final, lang },
		ctx.session_id,
	);
	if (data.final && room.transcript && room.meeting_id) {
		const end_ms = Math.max(0, Date.now() - room.transcript.started_at);
		const start_ms = Math.max(0, end_ms - Math.min(Math.max(span, 0), CAPTION_SPAN_MAX_MS));
		save_caption(store, call_id, room.meeting_id, { start_ms, end_ms, speaker_key: from.member_key, speaker_name: from.name, text, lang });
	}
	return {};
}

function on_prefs(ctx: SocketEventContext, raw: unknown): Record<string, unknown> {
	const data = as_object(raw);
	const call_id = call_id_of(data);
	const from = sender(ctx, call_id);
	if (typeof data.receive_video !== 'boolean') throw invalid();
	emit_to_room(`call:${call_id}`, 'call:prefs', { call_id, from_leg: from.leg_id, receive_video: data.receive_video }, ctx.session_id);
	return {};
}

/**
 * Se cayó el socket: la pata sale de la sala y empieza la gracia de red de 30 s. En una reunión
 * su asistencia cierra el intervalo por red; si vuelve, cuenta como reconexión.
 */
function on_close(ctx: { session_id: string }): void {
	for (const { call_id, member } of rooms_of_session(ctx.session_id)) {
		const detached = run_room_command(call_id, { type: 'detach', leg_id: member.leg_id });
		const meeting_id = detached.ok ? detached.room.meeting_id : undefined;
		if (meeting_id) {
			attendance_exit(call_id, member.member_key, member.leg_id, Date.now(), 'network');
			void flush_attendance(store, { _id: call_id, meeting_id }, { member_key: member.member_key }).catch(report);
			continue;
		}
		if (!member.member_key.startsWith('u:')) continue;
		const user_id = member.member_key.slice(2);
		mark_leg_detached(call_id, user_id, member.leg_id);
		void note_network_lost(store, call_id, user_id, member.leg_id).catch(report);
	}
}

let started = false;

export function register_call_socket_handlers(call_store: ImperiumStore): void {
	store = call_store;
	if (started) return;
	started = true;
	on_socket_event('call:attach', on_attach, { allow_guest: true, per_second: 5 });
	on_socket_event('rtc:signal', on_signal, { allow_guest: true, per_second: 60, max_bytes: SIGNAL_MAX_BYTES });
	on_socket_event('call:media', on_media, { allow_guest: true, per_second: 5 });
	on_socket_event('call:prefs', on_prefs, { allow_guest: true, per_second: 2 });
	on_socket_event('meeting:host', on_host, { per_second: 10 });
	on_socket_event('meeting:hand', on_hand, { allow_guest: true, per_second: 2 });
	on_socket_event('meeting:react', on_react, { allow_guest: true, per_second: 1 });
	on_socket_event('meeting:signal', on_room_signal, { allow_guest: true, per_second: 2 });
	on_socket_event('meeting:board', on_board, { allow_guest: true, per_second: 30 });
	on_socket_event('meeting:caption', on_caption, { allow_guest: true, per_second: 5 });
	on_socket_close(on_close);
}
