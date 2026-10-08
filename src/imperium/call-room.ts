/**
 * Salas de llamada en memoria (contrato §5.4 y §6.3): quién está adjunto, con qué medios, la
 * política, la cola de manos y, en una reunión, la sala de espera, quién fue admitido y a quién se
 * bloqueó. Nada de esto toca Postgres y un reinicio lo pierde: el cliente repite `call:attach` al
 * reconectar y el invitado vuelve a entrar por el código. `apply_room_command` es pura y en ella
 * vive la autorización de los comandos de anfitrión; el resto guarda el estado de la única réplica
 * y avisa a la sala `call:<id>`.
 */
import type { CallDoc, RoomRole } from './call-state.ts';
import { print_console_log } from './debug-request-log.ts';
import type { ImperiumDoc } from './envelope.ts';
import { emit_to_room, leave_room_server } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

export type RoomMedia = { mic: boolean; cam: boolean; screen: boolean; audio_only: boolean };

export type RosterEntry = {
	member_key: string;
	leg_id: string;
	name: string;
	role: RoomRole;
	guest?: true;
	media: RoomMedia;
	cam_stream_id?: string;
	screen_stream_id?: string;
	hard_muted: boolean;
	speaker: boolean;
	hand_at?: number;
	signal?: 'si' | 'no' | 'despacio' | 'vuelvo';
};

/** Lo que el roster no enseña: la sesión a la que se reenvía la señal. */
export type RoomMember = RosterEntry & { session_id: string };

export type RoomPolicy = {
	locked: boolean;
	allow_unmute: boolean;
	cams_allowed: boolean;
	screen_share: 'hosts' | 'all';
	whiteboard: 'hosts' | 'all';
	private_chat: boolean;
	captions_on: boolean;
	spotlight: string[];
	floor?: string;
	recording?: { by_name: string; started_at: string };
};

export type HandEntry = { member_key: string; name: string; at: number };

/** Alguien de la reunión, adjunto o no: su rol en la sala y, si es invitado, desde dónde lee el chat. */
export type RoomPerson = {
	member_key: string;
	name: string;
	role: RoomRole;
	guest?: true;
	/** El `seq` de la conversación al admitirlo por primera vez; solo invitados. */
	visible_from_seq?: number;
};

/** `host`: espera a que llegue quien organiza; `approval`: a que lo admitan. */
export type LobbyEntry = RoomPerson & { waiting_since: number; reason: 'host' | 'approval' };

export type RoomState = {
	call_id: string;
	meeting_id?: string;
	conversation_id?: string;
	members: RoomMember[];
	policy: RoomPolicy;
	hands: HandEntry[];
	admitted: RoomPerson[];
	lobby: LobbyEntry[];
	blocked: string[];
	/** Cómo entra cada quien: sin micrófono o sin cámara si la reunión lo pide. */
	entry: { muted: boolean; cams_off: boolean };
	/** Bitácora de la pizarra; sin ella, la pizarra está en blanco. */
	board?: BoardLog;
	/** En la sala principal: las salas pequeñas abiertas. */
	breakouts?: Breakouts;
	/** En una sala pequeña: la llamada de la sala principal. */
	parent_call_id?: string;
	/** La reunión guarda la transcripción: los subtítulos finales se fechan desde aquí. */
	transcript?: { started_at: number };
};

/** Coordenadas normalizadas 0..1; el color es el índice de un token de la paleta (0..7). */
export type BoardInput =
	| { id: string; kind: 'trazo' | 'borrar'; points: Array<[number, number]>; color: number; width: number }
	| { id: string; kind: 'limpiar' }
	/** `id`: el trazo que se deshace. */
	| { id: string; kind: 'deshacer' };

/** Lo que se reenvía: la operación con quién la hizo y su lugar en la bitácora. */
export type BoardOp = BoardInput & { by: string; seq: number };

export type BoardLog = { seq: number; ops: Array<Extract<BoardOp, { kind: 'trazo' | 'borrar' }>>; bytes: number };

export type BreakoutRoom = { call_id: string; name: string; member_keys: string[] };

export type Breakouts = {
	rooms: BreakoutRoom[];
	ends_at: number;
	/** Cuenta regresiva de cierre: a esta hora todos vuelven a la sala principal. */
	closing_at?: number;
	broadcast?: { text: string; by_name: string; at: number };
};

export type HostCommand =
	| { type: 'admit' | 'deny'; member_key: string }
	| { type: 'admit_all' }
	| { type: 'mute'; member_key: string }
	| { type: 'mute_all'; allow_unmute: boolean }
	| { type: 'allow_unmute' }
	| { type: 'cams_off'; member_key?: string }
	| { type: 'kick'; member_key: string; block: boolean }
	| { type: 'lock'; locked: boolean }
	| { type: 'grant_floor' | 'revoke_floor'; member_key: string }
	| { type: 'lower_hand'; member_key: string }
	| { type: 'lower_all_hands' }
	| { type: 'spotlight'; member_keys: string[] }
	| { type: 'set_role'; member_key: string; role: 'cohost' | 'presenter' | 'participant' }
	/** `assign: 'random'`: el servidor reparte al azar a quienes no moderan; `member_keys` no cuenta. */
	| { type: 'breakouts_open'; rooms: Array<{ name: string; member_keys: string[] }>; minutes: number; assign?: 'manual' | 'random' }
	| { type: 'breakouts_broadcast'; text: string }
	| { type: 'breakouts_close' }
	| { type: 'captions'; on: boolean }
	| { type: 'end' };

export type RoomSignal = NonNullable<RosterEntry['signal']>;

export type RoomCommand =
	| { type: 'attach'; member: RoomMember }
	| { type: 'detach'; leg_id: string }
	| {
			type: 'media';
			leg_id: string;
			media: RoomMedia;
			cam_stream_id?: string;
			screen_stream_id?: string;
	  }
	/** Entra a la espera, o directo si ya estaba admitido. */
	| { type: 'wait'; person: RoomPerson; reason: LobbyEntry['reason']; now: number }
	/** Pasa sin espera: anfitriones, invitados con sala abierta y quien llega con la sala sin espera. */
	| { type: 'admit_direct'; person: RoomPerson }
	/** Salió por su cuenta: deja la espera o la sala, pero sigue admitido. */
	| { type: 'leave'; member_key: string }
	/** Levanta o baja la mano; la hora la pone el servidor y ordena la cola. */
	| { type: 'hand'; leg_id: string; up: boolean; now: number }
	/** Sí, no, más despacio o vuelvo enseguida: se queda hasta que la cambie o la quite (`null`). */
	| { type: 'signal'; leg_id: string; signal: RoomSignal | null }
	| { type: 'board'; leg_id: string; op: BoardInput }
	/**
	 * Un comando del anfitrión o un coanfitrión. `visible_from_seq`: el `seq` de la conversación
	 * ahora, para los invitados que se admitan; `breakout_ids`: las llamadas de las salas pequeñas
	 * que se abren, una por sala.
	 */
	| {
			type: 'host';
			actor: { member_key: string; role: RoomRole };
			command: HostCommand;
			now: number;
			visible_from_seq?: number;
			breakout_ids?: string[];
	  }
	/**
	 * La expulsión que el anfitrión ordenó en otra sala de la misma reunión: ya está autorizada y
	 * vale para todas sus salas.
	 */
	| { type: 'expel'; member_key: string; block: boolean }
	/** Vence el tiempo de las salas pequeñas: empieza la cuenta regresiva y, al acabar, se cierran. */
	| { type: 'breakouts_tick'; now: number }
	/** Se cierran ya, sin cuenta regresiva: no se pudieron abrir. */
	| { type: 'breakouts_end' }
	/** Empieza (con quién graba) o termina (`null`) la grabación: el aviso viaja en la política. */
	| { type: 'recording'; recording: NonNullable<RoomPolicy['recording']> | null };

export type CommandKind = 'admitted' | 'denied' | 'muted' | 'cams_off' | 'expelled' | 'floor_granted' | 'floor_revoked' | 'role' | 'moved';

export type RoomEvent =
	| { type: 'roster'; upsert?: RosterEntry[]; remove?: string[] }
	| { type: 'policy' }
	| { type: 'hands' }
	/** Levantó la mano (no cuenta bajarla): suma a su asistencia. */
	| { type: 'hand_raised'; member_key: string }
	| { type: 'lobby' }
	/** `meeting:command` a las sesiones de esa persona. */
	| { type: 'command'; member_key: string; kind: CommandKind; data?: ImperiumDoc }
	| { type: 'admitted'; person: RoomPerson; waited_ms: number }
	/**
	 * Sale de la espera o de la sala por el anfitrión: su asistencia lleva el resultado. `person`, quien
	 * era antes de salir, para que su fila conserve el nombre aunque ya no tuviera patas.
	 */
	| { type: 'removed'; member_key: string; outcome: 'expelled' | 'denied'; legs: RoomMember[]; person?: RoomPerson }
	| { type: 'board'; op: BoardOp }
	/** `meeting:breakouts` a la sala principal y a cada sala pequeña. */
	| { type: 'breakouts'; rooms: BreakoutRoom[]; closed?: true }
	/** Se abrieron las salas pequeñas: hay que crear sus llamadas. */
	| { type: 'breakouts_opened'; rooms: BreakoutRoom[] }
	/** Se cerraron: hay que terminar sus llamadas. */
	| { type: 'breakouts_closed'; call_ids: string[] }
	| { type: 'end' };

export type RoomErrorCode = 'forbidden' | 'not_host' | 'invalid_request' | 'board_full';

export type RoomResult = { ok: true; room: RoomState; events: RoomEvent[] } | { ok: false; code: RoomErrorCode };

export const DEFAULT_POLICY: RoomPolicy = {
	locked: false,
	allow_unmute: true,
	cams_allowed: true,
	screen_share: 'all',
	whiteboard: 'all',
	private_chat: true,
	captions_on: false,
	spotlight: [],
};

const PRESENTING = new Set<RoomRole>(['host', 'cohost', 'presenter']);
const STAFF = new Set<RoomRole>(['host', 'cohost']);
const SPOTLIGHT_MAX = 9;
export const BOARD_LIMITS = { ops: 5000, bytes: 1_000_000 };
const BREAKOUT_LIMITS = { rooms: 20, name: 60, minutes: 240, text: 500 };
const BREAKOUT_CLOSING_MS = 60_000;

export function roster_entry(member: RoomMember): RosterEntry {
	const { session_id: _session, ...entry } = member;
	return entry;
}

function upsert(room: RoomState, member: RoomMember): RoomResult {
	const members = [...room.members.filter((item) => item.leg_id !== member.leg_id), member];
	return { ok: true, room: { ...room, members }, events: [{ type: 'roster', upsert: [roster_entry(member)] }] };
}

function fail(code: RoomErrorCode): RoomResult {
	return { ok: false, code };
}

function admit_person(room: RoomState, person: RoomPerson): RoomState {
	const before = room.admitted.find((item) => item.member_key === person.member_key);
	const kept = before?.visible_from_seq === undefined ? person : { ...person, visible_from_seq: before.visible_from_seq };
	return {
		...room,
		admitted: [...room.admitted.filter((item) => item.member_key !== person.member_key), kept],
		lobby: room.lobby.filter((item) => item.member_key !== person.member_key),
	};
}

function lobby_person(entry: LobbyEntry): RoomPerson {
	const { waiting_since: _since, reason: _reason, ...person } = entry;
	return person;
}

/** Admite desde la espera: avisa a esa persona y deja el dato de cuánto esperó. */
function admit_from_lobby(room: RoomState, entries: LobbyEntry[], now: number, visible_from_seq?: number): RoomResult {
	let next = room;
	const events: RoomEvent[] = [];
	for (const entry of entries) {
		const { waiting_since, reason: _reason, ...person } = entry;
		const admitted = person.guest && visible_from_seq !== undefined ? { ...person, visible_from_seq } : person;
		next = admit_person(next, admitted);
		const kept = next.admitted.find((item) => item.member_key === person.member_key) ?? admitted;
		events.push(
			{ type: 'admitted', person: kept, waited_ms: Math.max(0, now - waiting_since) },
			{ type: 'command', member_key: person.member_key, kind: 'admitted', data: { role: person.role } },
		);
	}
	return { ok: true, room: next, events: entries.length ? [...events, { type: 'lobby' }] : [] };
}

/** `member_key` nulo: todas las patas de la sala. */
function with_members(room: RoomState, member_key: string | null, patch: (member: RoomMember) => RoomMember): { room: RoomState; changed: RoomMember[] } {
	const changed: RoomMember[] = [];
	const members = room.members.map((member) => {
		if (member_key !== null && member.member_key !== member_key) return member;
		const next = patch(member);
		if (next !== member) changed.push(next);
		return next;
	});
	return { room: { ...room, members }, changed };
}

function roster_of(changed: RoomMember[]): RoomEvent[] {
	return changed.length ? [{ type: 'roster', upsert: changed.map(roster_entry) }] : [];
}

/** Baja la mano de esas personas: salen de la cola y de su entrada en el roster. */
function lower_hands(room: RoomState, member_keys: Set<string>): { room: RoomState; events: RoomEvent[] } {
	if (!room.hands.some((item) => member_keys.has(item.member_key))) return { room, events: [] };
	const hands = room.hands.filter((item) => !member_keys.has(item.member_key));
	const changed: RoomMember[] = [];
	const members = room.members.map((member) => {
		if (!member_keys.has(member.member_key) || member.hand_at === undefined) return member;
		const { hand_at: _hand, ...rest } = member;
		changed.push(rest);
		return rest;
	});
	return { room: { ...room, hands, members }, events: [{ type: 'hands' }, ...roster_of(changed)] };
}

function raise_hand(room: RoomState, member: RoomMember, now: number): { room: RoomState; events: RoomEvent[] } {
	if (room.hands.some((item) => item.member_key === member.member_key)) return { room, events: [] };
	const hands = [...room.hands, { member_key: member.member_key, name: member.name, at: now }].sort((a, b) => a.at - b.at);
	const { room: next, changed } = with_members({ ...room, hands }, member.member_key, (item) => ({ ...item, hand_at: now }));
	return { room: next, events: [{ type: 'hands' }, ...roster_of(changed), { type: 'hand_raised', member_key: member.member_key }] };
}

const EMPTY_BOARD: BoardLog = { seq: 0, ops: [], bytes: 0 };

/**
 * Pizarra (contrato §5.5): dibujar según la política, limpiar solo quien modera y deshacer el
 * trazo propio. La bitácora se compacta (lo deshecho y lo limpiado salen) para que quien llega
 * tarde reciba solo lo que se ve; su tope por sala es de 5 000 trazos o 1 MB.
 */
function draw(room: RoomState, command: Extract<RoomCommand, { type: 'board' }>): RoomResult {
	const member = room.members.find((item) => item.leg_id === command.leg_id);
	if (!member) return fail('forbidden');
	const log = room.board ?? EMPTY_BOARD;
	const { op } = command;
	const by = member.member_key;
	const seq = log.seq + 1;
	if (op.kind === 'limpiar') {
		if (!STAFF.has(member.role)) return fail('not_host');
		return { ok: true, room: { ...room, board: { seq, ops: [], bytes: 0 } }, events: [{ type: 'board', op: { ...op, by, seq } }] };
	}
	const existing = log.ops.find((item) => item.id === op.id);
	if (op.kind === 'deshacer') {
		if (!existing) return { ok: true, room, events: [] };
		if (existing.by !== by && !STAFF.has(member.role)) return fail('forbidden');
		const board = { seq, ops: log.ops.filter((item) => item !== existing), bytes: log.bytes - op_bytes(existing) };
		return { ok: true, room: { ...room, board }, events: [{ type: 'board', op: { ...op, by, seq } }] };
	}
	if (room.policy.whiteboard === 'hosts' && !PRESENTING.has(member.role)) return fail('forbidden');
	if (existing) return existing.by === by ? { ok: true, room, events: [] } : fail('invalid_request');
	const stored = { ...op, by, seq };
	const bytes = op_bytes(stored);
	if (log.ops.length >= BOARD_LIMITS.ops || log.bytes + bytes > BOARD_LIMITS.bytes) return fail('board_full');
	return { ok: true, room: { ...room, board: { seq, ops: [...log.ops, stored], bytes: log.bytes + bytes } }, events: [{ type: 'board', op: stored }] };
}

function op_bytes(op: BoardOp): number {
	return Buffer.byteLength(JSON.stringify(op));
}

function open_breakouts(room: RoomState, command: Extract<RoomCommand, { type: 'host' }>, order: Extract<HostCommand, { type: 'breakouts_open' }>): RoomResult {
	const ids = command.breakout_ids ?? [];
	if (room.parent_call_id || room.breakouts || !order.rooms.length || order.rooms.length > BREAKOUT_LIMITS.rooms) return fail('invalid_request');
	if (ids.length !== order.rooms.length || !Number.isInteger(order.minutes) || order.minutes < 1 || order.minutes > BREAKOUT_LIMITS.minutes) {
		return fail('invalid_request');
	}
	const placed = new Set<string>();
	const rooms: BreakoutRoom[] = [];
	for (const [index, item] of order.rooms.entries()) {
		const name = item.name.trim();
		if (!name || name.length > BREAKOUT_LIMITS.name) return fail('invalid_request');
		const member_keys = [...new Set(item.member_keys)];
		for (const key of member_keys) {
			const person = room.admitted.find((candidate) => candidate.member_key === key);
			if (placed.has(key) || !person) return fail('invalid_request');
			// Mover es actuar sobre alguien: la misma regla que el resto de los comandos.
			if (key !== command.actor.member_key && (person.role === 'host' || (command.actor.role === 'cohost' && person.role === 'cohost'))) {
				return fail('not_host');
			}
			placed.add(key);
		}
		rooms.push({ call_id: ids[index]!, name, member_keys });
	}
	return {
		ok: true,
		room: { ...room, breakouts: { rooms, ends_at: command.now + order.minutes * 60_000 } },
		events: [
			{ type: 'breakouts_opened', rooms },
			{ type: 'breakouts', rooms },
			...rooms.flatMap((item) =>
				item.member_keys.map((member_key): RoomEvent => ({ type: 'command', member_key, kind: 'moved', data: { call_id: item.call_id, name: item.name } })),
			),
		],
	};
}

/** Todos vuelven a la sala principal y las llamadas de las salas pequeñas se terminan. */
function end_breakouts(room: RoomState): RoomResult {
	const open = room.breakouts;
	if (!open) return { ok: true, room, events: [] };
	const { breakouts: _closed, ...rest } = room;
	return {
		ok: true,
		room: rest,
		events: [
			{ type: 'breakouts', rooms: open.rooms, closed: true },
			...[...new Set(open.rooms.flatMap((item) => item.member_keys))]
				.filter((member_key) => room.admitted.some((person) => person.member_key === member_key))
				.map((member_key): RoomEvent => ({ type: 'command', member_key, kind: 'moved', data: { call_id: room.call_id } })),
			{ type: 'breakouts_closed', call_ids: open.rooms.map((item) => item.call_id) },
		],
	};
}

function closing(room: RoomState, breakouts: Breakouts, now: number): RoomResult {
	if (breakouts.closing_at !== undefined) return { ok: true, room, events: [] };
	return {
		ok: true,
		room: { ...room, breakouts: { ...breakouts, closing_at: now + BREAKOUT_CLOSING_MS } },
		events: [{ type: 'breakouts', rooms: breakouts.rooms }],
	};
}

/**
 * Saca a alguien de la sala: sus patas, su admisión, su espera, su mano, la palabra y el destacado;
 * en la sala principal, también de su sala pequeña. Con `block` no vuelve a entrar. Si en esta sala
 * no estaba, solo queda el bloqueo, sin avisos.
 */
function expel(room: RoomState, member_key: string, block: boolean): RoomResult {
	const legs = room.members.filter((item) => item.member_key === member_key);
	const waiting = room.lobby.find((item) => item.member_key === member_key);
	const person = room.admitted.find((item) => item.member_key === member_key) ?? (waiting && lobby_person(waiting));
	const known = legs.length > 0 || person !== undefined;
	const placed = room.breakouts?.rooms.some((item) => item.member_keys.includes(member_key)) ? room.breakouts : undefined;
	const breakouts = placed && {
		...placed,
		rooms: placed.rooms.map((item) => ({ ...item, member_keys: item.member_keys.filter((key) => key !== member_key) })),
	};
	const regrouped: RoomEvent[] = breakouts ? [{ type: 'breakouts', rooms: breakouts.rooms }] : [];
	const base: RoomState = {
		...room,
		blocked: block && !room.blocked.includes(member_key) ? [...room.blocked, member_key] : room.blocked,
		...(breakouts ? { breakouts } : {}),
	};
	if (!known) return { ok: true, room: base, events: regrouped };
	const had_hand = room.hands.some((item) => item.member_key === member_key);
	const had_policy = room.policy.floor === member_key || room.policy.spotlight.includes(member_key);
	const next: RoomState = {
		...base,
		members: room.members.filter((item) => item.member_key !== member_key),
		admitted: room.admitted.filter((item) => item.member_key !== member_key),
		lobby: room.lobby.filter((item) => item.member_key !== member_key),
		hands: room.hands.filter((item) => item.member_key !== member_key),
		policy: {
			...room.policy,
			floor: room.policy.floor === member_key ? undefined : room.policy.floor,
			spotlight: room.policy.spotlight.filter((key) => key !== member_key),
		},
	};
	return {
		ok: true,
		room: next,
		events: [
			{ type: 'command', member_key, kind: 'expelled', data: { blocked: block } },
			{ type: 'removed', member_key, outcome: 'expelled', legs, ...(person ? { person } : {}) },
			...(legs.length ? [{ type: 'roster' as const, remove: legs.map((leg) => leg.leg_id) }] : []),
			...(had_hand ? [{ type: 'hands' as const }] : []),
			...(had_policy ? [{ type: 'policy' as const }] : []),
			...regrouped,
			{ type: 'lobby' },
		],
	};
}

function host_command(room: RoomState, command: Extract<RoomCommand, { type: 'host' }>): RoomResult {
	const { actor, command: order, now } = command;
	if (!STAFF.has(actor.role)) return fail('not_host');
	const target_key = 'member_key' in order ? order.member_key : undefined;
	const target = room.admitted.find((item) => item.member_key === target_key);
	// Nadie actúa sobre el anfitrión, ni un coanfitrión sobre otro.
	if (target && target_key !== actor.member_key && (target.role === 'host' || (actor.role === 'cohost' && target.role === 'cohost'))) {
		return fail('not_host');
	}
	switch (order.type) {
		case 'admit':
		case 'deny': {
			const entry = room.lobby.find((item) => item.member_key === order.member_key);
			if (!entry) return fail('invalid_request');
			if (order.type === 'admit') return admit_from_lobby(room, [entry], now, command.visible_from_seq);
			return {
				ok: true,
				room: { ...room, lobby: room.lobby.filter((item) => item !== entry) },
				events: [
					{ type: 'command', member_key: entry.member_key, kind: 'denied' },
					{ type: 'removed', member_key: entry.member_key, outcome: 'denied', legs: [], person: lobby_person(entry) },
					{ type: 'lobby' },
				],
			};
		}
		case 'admit_all':
			return admit_from_lobby(room, room.lobby, now, command.visible_from_seq);
		case 'mute': {
			const muted = room.members.find((item) => item.member_key === order.member_key);
			if (!muted) return fail('invalid_request');
			// Quien modera puede volver a permitir el micrófono: imponérselo no lo detendría.
			const hard = !room.policy.allow_unmute && !STAFF.has(muted.role);
			const { room: next, changed } = with_members(room, order.member_key, (member) => ({
				...member,
				media: { ...member.media, mic: false },
				hard_muted: hard,
			}));
			return {
				ok: true,
				room: next,
				events: [...roster_of(changed), { type: 'command', member_key: order.member_key, kind: 'muted', data: { hard_muted: hard } }],
			};
		}
		case 'mute_all': {
			const policy = { ...room.policy, allow_unmute: order.allow_unmute };
			const keys = new Set<string>();
			const { room: next, changed } = with_members({ ...room, policy }, null, (member) => {
				if (STAFF.has(member.role)) return member;
				keys.add(member.member_key);
				return { ...member, media: { ...member.media, mic: false }, hard_muted: !order.allow_unmute };
			});
			return {
				ok: true,
				room: next,
				events: [
					{ type: 'policy' },
					...roster_of(changed),
					...[...keys].map(
						(member_key): RoomEvent => ({ type: 'command', member_key, kind: 'muted', data: { hard_muted: !order.allow_unmute } }),
					),
				],
			};
		}
		case 'allow_unmute': {
			const { room: next, changed } = with_members({ ...room, policy: { ...room.policy, allow_unmute: true } }, null, (member) =>
				member.hard_muted ? { ...member, hard_muted: false } : member,
			);
			return { ok: true, room: next, events: [{ type: 'policy' }, ...roster_of(changed)] };
		}
		case 'cams_off': {
			if (order.member_key !== undefined && !room.members.some((item) => item.member_key === order.member_key)) {
				return fail('invalid_request');
			}
			const keys = new Set<string>();
			const { room: next, changed } = with_members(room, order.member_key ?? null, (member) => {
				if (order.member_key === undefined && STAFF.has(member.role)) return member;
				keys.add(member.member_key);
				const { cam_stream_id: _cam, ...rest } = member;
				return member.media.cam ? { ...rest, media: { ...member.media, cam: false } } : member;
			});
			return {
				ok: true,
				room: next,
				events: [...roster_of(changed), ...[...keys].map((member_key): RoomEvent => ({ type: 'command', member_key, kind: 'cams_off' }))],
			};
		}
		case 'kick': {
			if (order.member_key === actor.member_key) return fail('invalid_request');
			const present = room.members.some((item) => item.member_key === order.member_key) || room.lobby.some((item) => item.member_key === order.member_key);
			if (!present && !target) return fail('invalid_request');
			return expel(room, order.member_key, order.block);
		}
		case 'lock':
			return { ok: true, room: { ...room, policy: { ...room.policy, locked: order.locked } }, events: [{ type: 'policy' }] };
		case 'grant_floor':
		case 'revoke_floor': {
			if (!room.admitted.some((item) => item.member_key === order.member_key)) return fail('invalid_request');
			const granting = order.type === 'grant_floor';
			if (!granting && room.policy.floor !== order.member_key) return { ok: true, room, events: [] };
			const previous = room.policy.floor;
			const policy = { ...room.policy, floor: granting ? order.member_key : undefined };
			const events: RoomEvent[] = [{ type: 'policy' }];
			if (granting && previous && previous !== order.member_key) {
				events.push({ type: 'command', member_key: previous, kind: 'floor_revoked' });
			}
			events.push({ type: 'command', member_key: order.member_key, kind: granting ? 'floor_granted' : 'floor_revoked' });
			// Quien pidió la palabra con la mano ya la tiene: sale de la cola.
			const lowered = granting ? lower_hands({ ...room, policy }, new Set([order.member_key])) : { room: { ...room, policy }, events: [] };
			return { ok: true, room: lowered.room, events: [...events, ...lowered.events] };
		}
		case 'lower_hand':
		case 'lower_all_hands': {
			const keys = new Set(order.type === 'lower_hand' ? [order.member_key] : room.hands.map((item) => item.member_key));
			const lowered = lower_hands(room, keys);
			return { ok: true, room: lowered.room, events: lowered.events };
		}
		case 'spotlight': {
			const keys = [...new Set(order.member_keys)];
			// Una llamada de grupo no admite a nadie: cuenta quien tiene una pata en la sala.
			const present: readonly { member_key: string }[] = room.meeting_id ? room.admitted : room.members;
			if (keys.length > SPOTLIGHT_MAX || keys.some((key) => !present.some((item) => item.member_key === key))) {
				return fail('invalid_request');
			}
			return { ok: true, room: { ...room, policy: { ...room.policy, spotlight: keys } }, events: [{ type: 'policy' }] };
		}
		case 'set_role': {
			const person = room.admitted.find((item) => item.member_key === order.member_key);
			if (!person || person.role === 'host') return fail('invalid_request');
			if (order.role === 'cohost' && (actor.role !== 'host' || person.guest)) return fail(person.guest ? 'invalid_request' : 'not_host');
			if (person.role === 'cohost' && actor.role !== 'host') return fail('not_host');
			const role: RoomRole = order.role === 'participant' && person.guest ? 'guest' : order.role;
			const next = admit_person(room, { ...person, role });
			const { room: with_role, changed } = with_members(next, order.member_key, (member) => ({ ...member, role }));
			return {
				ok: true,
				room: with_role,
				events: [...roster_of(changed), { type: 'command', member_key: order.member_key, kind: 'role', data: { role } }],
			};
		}
		case 'breakouts_open':
			return open_breakouts(room, command, order);
		case 'breakouts_broadcast': {
			const text = order.text.trim();
			if (!room.breakouts || !text || text.length > BREAKOUT_LIMITS.text) return fail('invalid_request');
			const by_name = room.admitted.find((item) => item.member_key === actor.member_key)?.name ?? '';
			return {
				ok: true,
				room: { ...room, breakouts: { ...room.breakouts, broadcast: { text, by_name, at: now } } },
				events: [{ type: 'breakouts', rooms: room.breakouts.rooms }],
			};
		}
		case 'breakouts_close':
			return room.breakouts ? closing(room, room.breakouts, now) : fail('invalid_request');
		case 'captions':
			if (room.policy.captions_on === order.on) return { ok: true, room, events: [] };
			return { ok: true, room: { ...room, policy: { ...room.policy, captions_on: order.on } }, events: [{ type: 'policy' }] };
		case 'end':
			return actor.role === 'host' ? { ok: true, room, events: [{ type: 'end' }] } : fail('not_host');
	}
}

export function apply_room_command(room: RoomState, command: RoomCommand): RoomResult {
	switch (command.type) {
		case 'attach': {
			if (room.blocked.includes(command.member.member_key)) return fail('forbidden');
			const before = room.members.find((item) => item.leg_id === command.member.leg_id);
			const hand = room.hands.find((item) => item.member_key === command.member.member_key);
			if (before) return upsert(room, { ...before, session_id: command.member.session_id });
			// Sin permiso de reactivar, quien no modera entra silenciado: así ni volver a conectarse ni
			// otra pestaña quitan el silencio que impuso el anfitrión.
			const hard = command.member.hard_muted || (!room.policy.allow_unmute && !STAFF.has(command.member.role));
			const fresh = hard ? { ...command.member, hard_muted: true, media: { ...command.member.media, mic: false } } : command.member;
			return upsert(room, { ...fresh, ...(hand ? { hand_at: hand.at } : {}) });
		}
		case 'detach': {
			const leaving = room.members.find((item) => item.leg_id === command.leg_id);
			if (!leaving) return { ok: true, room, events: [] };
			const members = room.members.filter((item) => item.leg_id !== command.leg_id);
			// Sin otra pata en la sala ya no está para tomar la palabra.
			const gone = !members.some((item) => item.member_key === leaving.member_key);
			const lowered = gone ? lower_hands({ ...room, members }, new Set([leaving.member_key])) : { room: { ...room, members }, events: [] };
			// En una reunión sigue admitida y conserva el destacado; en una llamada de grupo, salir es irse.
			const unspot = gone && !room.meeting_id && room.policy.spotlight.includes(leaving.member_key);
			return {
				ok: true,
				room: unspot
					? { ...lowered.room, policy: { ...lowered.room.policy, spotlight: room.policy.spotlight.filter((key) => key !== leaving.member_key) } }
					: lowered.room,
				events: [
					{ type: 'roster', remove: [command.leg_id] },
					...lowered.events.filter((event) => event.type === 'hands'),
					...(unspot ? [{ type: 'policy' as const }] : []),
				],
			};
		}
		case 'media': {
			const member = room.members.find((item) => item.leg_id === command.leg_id);
			if (!member) return fail('forbidden');
			const { media } = command;
			const presents = PRESENTING.has(member.role);
			if ((media.mic && member.hard_muted) || (media.cam && !room.policy.cams_allowed)) return fail('forbidden');
			if (media.screen && room.policy.screen_share === 'hosts' && !presents) return fail('forbidden');
			const { cam_stream_id: _cam, screen_stream_id: _screen, ...rest } = member;
			return upsert(room, {
				...rest,
				media,
				...(media.cam && command.cam_stream_id ? { cam_stream_id: command.cam_stream_id } : {}),
				...(media.screen && command.screen_stream_id ? { screen_stream_id: command.screen_stream_id } : {}),
			});
		}
		case 'wait': {
			if (room.blocked.includes(command.person.member_key)) return fail('forbidden');
			if (room.admitted.some((item) => item.member_key === command.person.member_key)) {
				return { ok: true, room, events: [] };
			}
			const waiting = room.lobby.find((item) => item.member_key === command.person.member_key);
			const entry: LobbyEntry = { ...command.person, waiting_since: waiting?.waiting_since ?? command.now, reason: command.reason };
			return {
				ok: true,
				room: { ...room, lobby: [...room.lobby.filter((item) => item !== waiting), entry] },
				events: [{ type: 'lobby' }],
			};
		}
		case 'admit_direct':
			if (room.blocked.includes(command.person.member_key)) return fail('forbidden');
			return {
				ok: true,
				room: admit_person(room, command.person),
				events: room.lobby.some((item) => item.member_key === command.person.member_key) ? [{ type: 'lobby' }] : [],
			};
		case 'leave': {
			const legs = room.members.filter((item) => item.member_key === command.member_key);
			const waiting = room.lobby.some((item) => item.member_key === command.member_key);
			if (!legs.length && !waiting) return { ok: true, room, events: [] };
			const had_hand = room.hands.some((item) => item.member_key === command.member_key);
			return {
				ok: true,
				room: {
					...room,
					members: room.members.filter((item) => item.member_key !== command.member_key),
					lobby: room.lobby.filter((item) => item.member_key !== command.member_key),
					hands: room.hands.filter((item) => item.member_key !== command.member_key),
				},
				events: [
					...(legs.length ? [{ type: 'roster' as const, remove: legs.map((leg) => leg.leg_id) }] : []),
					...(had_hand ? [{ type: 'hands' as const }] : []),
					...(waiting ? [{ type: 'lobby' as const }] : []),
				],
			};
		}
		case 'hand': {
			const member = room.members.find((item) => item.leg_id === command.leg_id);
			if (!member) return fail('forbidden');
			const changed = command.up ? raise_hand(room, member, command.now) : lower_hands(room, new Set([member.member_key]));
			return { ok: true, room: changed.room, events: changed.events };
		}
		case 'signal': {
			const member = room.members.find((item) => item.leg_id === command.leg_id);
			if (!member) return fail('forbidden');
			const { room: next, changed } = with_members(room, member.member_key, (item) => {
				if ((item.signal ?? null) === command.signal) return item;
				const { signal: _previous, ...rest } = item;
				return command.signal ? { ...rest, signal: command.signal } : rest;
			});
			return { ok: true, room: next, events: roster_of(changed) };
		}
		case 'board':
			return draw(room, command);
		case 'host':
			return host_command(room, command);
		case 'expel':
			return expel(room, command.member_key, command.block);
		case 'breakouts_end':
			return end_breakouts(room);
		case 'recording': {
			const { recording: _previous, ...policy } = room.policy;
			return { ok: true, room: { ...room, policy: command.recording ? { ...policy, recording: command.recording } : policy }, events: [{ type: 'policy' }] };
		}
		case 'breakouts_tick': {
			const open = room.breakouts;
			if (!open) return { ok: true, room, events: [] };
			if (open.closing_at === undefined) return command.now >= open.ends_at ? closing(room, open, command.now) : { ok: true, room, events: [] };
			return command.now >= open.closing_at ? end_breakouts(room) : { ok: true, room, events: [] };
		}
	}
}

const rooms = new Map<string, RoomState>();

function new_room(call_id: string, meeting_id?: string): RoomState {
	return {
		call_id,
		...(meeting_id ? { meeting_id } : {}),
		members: [],
		policy: { ...DEFAULT_POLICY, spotlight: [] },
		hands: [],
		admitted: [],
		lobby: [],
		blocked: [],
		entry: { muted: false, cams_off: false },
	};
}

export function room_state(call_id: string, meeting_id?: string): RoomState {
	return rooms.get(call_id) ?? new_room(call_id, meeting_id);
}

/**
 * La sala de la llamada de una reunión, con la política y la entrada que pide la reunión y los
 * bloqueos que ya trae. Si ya existe no la toca.
 */
export function open_meeting_room(input: {
	call_id: string;
	meeting_id: string;
	conversation_id: string;
	policy: Partial<RoomPolicy>;
	entry: RoomState['entry'];
	blocked: string[];
	parent_call_id?: string;
	transcript?: RoomState['transcript'];
}): RoomState {
	const current = rooms.get(input.call_id);
	if (current) return current;
	const room: RoomState = {
		...new_room(input.call_id, input.meeting_id),
		conversation_id: input.conversation_id,
		policy: { ...DEFAULT_POLICY, spotlight: [], ...input.policy },
		entry: input.entry,
		blocked: [...input.blocked],
		...(input.parent_call_id ? { parent_call_id: input.parent_call_id } : {}),
		...(input.transcript ? { transcript: input.transcript } : {}),
	};
	rooms.set(input.call_id, room);
	return room;
}

export function room_exists(call_id: string): boolean {
	return rooms.has(call_id);
}

export function room_member(call_id: string, by: { session_id?: string; leg_id?: string }): RoomMember | undefined {
	return rooms
		.get(call_id)
		?.members.find((item) => (by.session_id ? item.session_id === by.session_id : item.leg_id === by.leg_id));
}

export function admitted_person(call_id: string, member_key: string): RoomPerson | undefined {
	return rooms.get(call_id)?.admitted.find((item) => item.member_key === member_key);
}

/** Las salas en las que una sesión tiene una pata adjunta. */
export function rooms_of_session(session_id: string): Array<{ call_id: string; member: RoomMember }> {
	const out: Array<{ call_id: string; member: RoomMember }> = [];
	for (const room of rooms.values()) {
		for (const member of room.members) if (member.session_id === session_id) out.push({ call_id: room.call_id, member });
	}
	return out;
}

/** El invitado admitido en alguna sala viva de esa reunión, con desde dónde lee su chat. */
export function admitted_guest(meeting_id: string, guest_id: string): { call_id: string; person: RoomPerson } | null {
	for (const room of rooms.values()) {
		if (room.meeting_id !== meeting_id) continue;
		const person = room.admitted.find((item) => item.member_key === `g:${guest_id}`);
		if (person) return { call_id: room.call_id, person };
	}
	return null;
}

export function guest_admitted(meeting_id: string, guest_id: string): boolean {
	return admitted_guest(meeting_id, guest_id) !== null;
}

/** Las sesiones de invitados adjuntos a las salas de esa conversación y desde qué `seq` leen. */
export function guest_sessions_of_conversation(conversation_id: string): Array<{ session_id: string; visible_from_seq: number }> {
	const out: Array<{ session_id: string; visible_from_seq: number }> = [];
	for (const room of rooms.values()) {
		if (room.conversation_id !== conversation_id) continue;
		for (const member of room.members) {
			if (!member.guest) continue;
			const person = room.admitted.find((item) => item.member_key === member.member_key);
			if (person) out.push({ session_id: member.session_id, visible_from_seq: person.visible_from_seq ?? 0 });
		}
	}
	return out;
}

function publish(room: RoomState, events: RoomEvent[], except?: string): void {
	for (const event of events) {
		if (event.type === 'roster') {
			emit_to_room(`call:${room.call_id}`, 'call:roster', { call_id: room.call_id, upsert: event.upsert, remove: event.remove }, except);
		} else if (event.type === 'policy') {
			emit_to_room(`call:${room.call_id}`, 'meeting:policy', { call_id: room.call_id, policy: room.policy });
		} else if (event.type === 'hands') {
			emit_to_room(`call:${room.call_id}`, 'meeting:hands', { call_id: room.call_id, queue: room.hands });
		} else if (event.type === 'hand_raised') {
			attendance_count(room.call_id, event.member_key, 'hands');
		} else if (event.type === 'board') {
			emit_to_room(`call:${room.call_id}`, 'meeting:board', { call_id: room.call_id, seq: event.op.seq, op: event.op }, except);
		} else if (event.type === 'breakouts') {
			const data = breakouts_view(room, event.rooms, event.closed === true);
			for (const call_id of [room.call_id, ...event.rooms.map((item) => item.call_id)]) {
				emit_to_room(`call:${call_id}`, 'meeting:breakouts', data);
			}
		}
	}
}

/** `meeting:breakouts` (contrato §5.4); al cerrarse, sin salas. */
export function breakouts_view(room: RoomState, rooms: BreakoutRoom[], closed = false, now = Date.now()): ImperiumDoc {
	const open = room.breakouts;
	return {
		call_id: room.call_id,
		rooms: closed ? [] : rooms,
		ends_at: new Date(open?.ends_at ?? now).toISOString(),
		...(open?.closing_at !== undefined ? { closing_in_s: Math.max(0, Math.ceil((open.closing_at - now) / 1000)) } : {}),
		...(open?.broadcast ? { broadcast: { ...open.broadcast, at: new Date(open.broadcast.at).toISOString() } } : {}),
	};
}

/**
 * Aplica el comando a la sala guardada y avisa a la sala del roster, la política y la cola de
 * manos; `except` no recibe el aviso del roster. Los demás eventos los atiende quien llama.
 */
export function run_room_command(call_id: string, command: RoomCommand, opts: { meeting_id?: string; except?: string } = {}): RoomResult {
	const result = apply_room_command(room_state(call_id, opts.meeting_id), command);
	if (!result.ok) return result;
	rooms.set(call_id, result.room);
	publish(result.room, result.events, opts.except);
	return result;
}

/**
 * Pone la sala al día con la llamada escrita: una terminada cierra la sala y su asistencia; en una
 * llamada de chat, quien ya no tiene su pata unida con ese dispositivo sale y deja de recibir señal.
 * En una reunión no hay patas: la sala es quien manda.
 */
export function sync_room_with_call(call: {
	_id: string;
	state: string;
	kind?: string;
	ended_at?: string;
	legs: Array<{ user_id: string; state: string; device?: string }>;
}): void {
	const room = rooms.get(call._id);
	if (!room) return;
	if (call.state === 'ended') {
		const at = Date.parse(call.ended_at ?? '') || Date.now();
		for (const member of room.members) {
			leave_room_server(member.session_id, `call:${call._id}`);
			if (room.meeting_id) leave_room_server(member.session_id, `meeting:${room.meeting_id}`);
			attendance_exit(call._id, member.member_key, member.leg_id, at);
		}
		rooms.delete(call._id);
		return;
	}
	if (call.kind === 'meeting') return;
	const live = new Set(call.legs.filter((leg) => leg.state === 'joined').map((leg) => `u:${leg.user_id}|${leg.device}`));
	for (const member of room.members) {
		if (member.guest || live.has(`${member.member_key}|${member.leg_id}`)) continue;
		leave_room_server(member.session_id, `call:${call._id}`);
		run_room_command(call._id, { type: 'detach', leg_id: member.leg_id });
	}
}

type MeetingCallClosed = (store: ImperiumStore, call: CallDoc) => Promise<void>;
const closed_handlers: MeetingCallClosed[] = [];

/**
 * Lo registra `meetings-flow.ts` para dejar la reunión fuera de «en vivo». Vive aquí y no en
 * `calls-flow.ts`, que está en un ciclo de imports con `actions.ts`.
 */
export function on_meeting_call_closed(handler: MeetingCallClosed): void {
	closed_handlers.push(handler);
}

export async function meeting_call_closed(store: ImperiumStore, call: CallDoc): Promise<void> {
	for (const handler of closed_handlers) await handler(store, call);
}

/** Una sala de reunión sin nadie adjunto ni nadie esperando desde hace poco. */
export function meeting_room_idle(call_id: string, now: number, lobby_ttl_ms: number): boolean {
	const room = rooms.get(call_id);
	if (!room) return true;
	// Una sala pequeña abierta espera a los suyos aunque aún no llegue nadie.
	if (room.parent_call_id && rooms.get(room.parent_call_id)?.breakouts?.rooms.some((item) => item.call_id === call_id)) return false;
	return !room.members.length && !room.lobby.some((item) => now - item.waiting_since < lobby_ttl_ms);
}

/**
 * Asistencia por persona (contrato §6.6), acumulada en memoria y escrita como diferencias en cada
 * salida y al terminar: la fila suma intervalos, tiempos y contadores.
 */
type Attendance = {
	person: RoomPerson;
	open_legs: Set<string>;
	open_in?: number;
	closed: Array<{ in: string; out: string; reason?: string }>;
	left_by_network: boolean;
	waited_ms: number;
	reconnections: number;
	hands: number;
	reactions: number;
	questions: number;
	camera_ms: number;
	cam_since?: number;
	recording_notice_at?: string;
	outcome?: 'expelled' | 'denied';
};

const attendance = new Map<string, Map<string, Attendance>>();

function attendance_of(call_id: string, person: RoomPerson): Attendance {
	const by_key = attendance.get(call_id) ?? new Map<string, Attendance>();
	attendance.set(call_id, by_key);
	const current = by_key.get(person.member_key);
	if (current) {
		current.person = { ...current.person, ...person };
		return current;
	}
	const fresh: Attendance = {
		person,
		open_legs: new Set(),
		closed: [],
		left_by_network: false,
		waited_ms: 0,
		reconnections: 0,
		hands: 0,
		reactions: 0,
		questions: 0,
		camera_ms: 0,
	};
	by_key.set(person.member_key, fresh);
	return fresh;
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

export function attendance_enter(call_id: string, person: RoomPerson, leg_id: string, now: number, recording_notice: boolean): void {
	const acc = attendance_of(call_id, person);
	if (!acc.open_legs.size) {
		acc.open_in = now;
		if (acc.left_by_network) acc.reconnections++;
		acc.left_by_network = false;
	}
	acc.open_legs.add(leg_id);
	if (recording_notice) acc.recording_notice_at ??= iso(now);
}

export function attendance_exit(call_id: string, member_key: string, leg_id: string | null, now: number, reason?: 'network'): void {
	const acc = attendance.get(call_id)?.get(member_key);
	if (!acc) return;
	if (leg_id === null) acc.open_legs.clear();
	else acc.open_legs.delete(leg_id);
	if (acc.open_legs.size || acc.open_in === undefined) return;
	acc.closed.push({ in: iso(acc.open_in), out: iso(now), ...(reason ? { reason } : {}) });
	acc.open_in = undefined;
	acc.left_by_network = reason === 'network';
	if (acc.cam_since !== undefined) {
		acc.camera_ms += now - acc.cam_since;
		acc.cam_since = undefined;
	}
}

export function attendance_waited(call_id: string, person: RoomPerson, waited_ms: number): void {
	attendance_of(call_id, person).waited_ms += waited_ms;
}

export function attendance_outcome(call_id: string, person: RoomPerson, outcome: 'expelled' | 'denied'): void {
	attendance_of(call_id, person).outcome = outcome;
}

export function attendance_camera(call_id: string, member_key: string, on: boolean, now: number): void {
	const acc = attendance.get(call_id)?.get(member_key);
	if (!acc) return;
	if (on && acc.cam_since === undefined) acc.cam_since = now;
	if (!on && acc.cam_since !== undefined) {
		acc.camera_ms += now - acc.cam_since;
		acc.cam_since = undefined;
	}
}

/** Empezó a grabarse: quien ya está adentro recibe el aviso ahora (contrato §6.6). */
export function attendance_recording_notice(call_id: string, now: number): void {
	for (const acc of attendance.get(call_id)?.values() ?? []) {
		if (acc.open_legs.size) acc.recording_notice_at ??= iso(now);
	}
}

export function attendance_count(call_id: string, member_key: string, field: 'hands' | 'reactions' | 'questions'): void {
	const acc = attendance.get(call_id)?.get(member_key);
	if (acc) acc[field]++;
}

type AttendanceDelta = Pick<Attendance, 'closed' | 'waited_ms' | 'reconnections' | 'hands' | 'reactions' | 'questions' | 'camera_ms'>;

/** Saca lo pendiente de la memoria antes de escribirlo: lo que llegue durante la escritura queda para la siguiente. */
function take_delta(acc: Attendance): AttendanceDelta {
	const { closed, waited_ms, reconnections, hands, reactions, questions, camera_ms } = acc;
	Object.assign(acc, { closed: [], waited_ms: 0, reconnections: 0, hands: 0, reactions: 0, questions: 0, camera_ms: 0 });
	return { closed, waited_ms, reconnections, hands, reactions, questions, camera_ms };
}

function give_back(acc: Attendance, delta: AttendanceDelta): void {
	acc.closed = [...delta.closed, ...acc.closed];
	acc.waited_ms += delta.waited_ms;
	acc.reconnections += delta.reconnections;
	acc.hands += delta.hands;
	acc.reactions += delta.reactions;
	acc.questions += delta.questions;
	acc.camera_ms += delta.camera_ms;
}

/**
 * Escribe lo pendiente de una persona (o de todas) y lo descuenta de la memoria. Al terminar la
 * llamada (`final`) cierra lo abierto y suelta la llamada. La fila suma lo que recibe, así que
 * dos escrituras a la vez (una salida y la lectura del reporte) nunca llevan la misma diferencia.
 */
export async function flush_attendance(
	store: Pick<ImperiumStore, 'upsert_call_attendance'>,
	call: { _id: string; meeting_id?: string },
	opts: { member_key?: string; final?: boolean; now?: number } = {},
): Promise<void> {
	const by_key = attendance.get(call._id);
	if (!by_key) return;
	const now = opts.now ?? Date.now();
	for (const [member_key, acc] of by_key) {
		if (opts.member_key && member_key !== opts.member_key) continue;
		if (opts.final) attendance_exit(call._id, member_key, null, now);
		const pending = acc.closed.length || acc.waited_ms || acc.reconnections || acc.hands || acc.reactions || acc.questions || acc.camera_ms;
		if (!pending && !acc.outcome && !acc.recording_notice_at && !opts.final) continue;
		const delta = take_delta(acc);
		const total_ms = delta.closed.reduce((sum, item) => sum + (Date.parse(item.out) - Date.parse(item.in)), 0);
		const { person } = acc;
		try {
			await store.upsert_call_attendance({
				call_id: call._id,
				meeting_id: call.meeting_id ?? null,
				participant_key: member_key,
				name: person.name,
				payload: {
					...(member_key.startsWith('u:') ? { userId: member_key.slice(2) } : { guestId: member_key.slice(2) }),
					displayName: person.name,
					role: person.role,
					intervals: delta.closed,
					totalS: Math.round(total_ms / 1000),
					waitedS: Math.round(delta.waited_ms / 1000),
					reconnections: delta.reconnections,
					hands: delta.hands,
					reactions: delta.reactions,
					questions: delta.questions,
					cameraS: Math.round(delta.camera_ms / 1000),
					...(acc.recording_notice_at ? { recordingNoticeAt: acc.recording_notice_at } : {}),
					...(acc.outcome ? { outcome: acc.outcome } : {}),
					...(person.visible_from_seq !== undefined ? { visibleFromSeq: person.visible_from_seq } : {}),
				},
				now: iso(now),
			});
		} catch (err) {
			give_back(acc, delta);
			throw err;
		}
	}
	if (opts.final) attendance.delete(call._id);
}

export type CaptionCue = { start_ms: number; end_ms: number; speaker_key: string; speaker_name: string; text: string; lang: string };

/** Contrato §6.6: los subtítulos finales se vuelcan cada 30 s o cada 200, lo que llegue antes. */
export const TRANSCRIPT_FLUSH = { cues: 200, ms: 30_000 };

type TranscriptBuffer = {
	meeting_id: string;
	/** Sin leer aún: tras un reinicio la llamada puede tener bloques guardados. */
	seq?: number;
	cues: CaptionCue[];
	timer?: ReturnType<typeof setTimeout>;
	/** Las escrituras van en fila: quien descarga la transcripción espera también las que siguen en vuelo. */
	writing: Promise<void>;
};

const transcripts = new Map<string, TranscriptBuffer>();

type TranscriptStore = Pick<ImperiumStore, 'insert' | 'meeting_transcript_next_seq'>;

function report_transcript(err: unknown): void {
	print_console_log('error', `Transcripción: ${err instanceof Error ? err.message : String(err)}`);
}

export function save_caption(store: TranscriptStore, call_id: string, meeting_id: string, cue: CaptionCue): void {
	const buffer = transcripts.get(call_id) ?? { meeting_id, cues: [], writing: Promise.resolve() };
	transcripts.set(call_id, buffer);
	buffer.cues.push(cue);
	if (buffer.cues.length >= TRANSCRIPT_FLUSH.cues) {
		void flush_transcript(store, call_id).catch(report_transcript);
		return;
	}
	if (buffer.timer) return;
	buffer.timer = setTimeout(() => void flush_transcript(store, call_id).catch(report_transcript), TRANSCRIPT_FLUSH.ms);
	buffer.timer.unref?.();
}

/** Escribe lo pendiente como un bloque con su `seq`; al terminar la llamada (`final`) suelta el búfer. */
export async function flush_transcript(store: TranscriptStore, call_id: string, opts: { final?: boolean } = {}): Promise<void> {
	const buffer = transcripts.get(call_id);
	if (!buffer) return;
	if (buffer.timer) clearTimeout(buffer.timer);
	buffer.timer = undefined;
	if (opts.final) transcripts.delete(call_id);
	if (buffer.cues.length) {
		const cues = buffer.cues;
		buffer.cues = [];
		const write = async () => {
			buffer.seq ??= await store.meeting_transcript_next_seq(call_id);
			const seq = buffer.seq++;
			await store.insert('chat-meeting-transcripts', {
				name: '',
				call_id,
				meeting_id: buffer.meeting_id,
				seq,
				cues: cues.map((cue) => ({
					startMs: cue.start_ms,
					endMs: cue.end_ms,
					speakerKey: cue.speaker_key,
					speakerName: cue.speaker_name,
					text: cue.text,
					lang: cue.lang,
				})),
			});
		};
		buffer.writing = buffer.writing.catch(() => undefined).then(write).then(() => undefined);
	}
	await buffer.writing;
}
