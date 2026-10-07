/**
 * Lo efímero del chat (contrato §5.4 y §5.5): escritura, entregado y presencia. Vive en la memoria
 * de la única réplica del núcleo; lo único que llega a Postgres es la marca de entregado.
 * Escritura, acuses y última vez son recíprocos: quien no comparte, no ve.
 */
import { ChatError, find_chat_conversation } from './chat-access.ts';
import { chat_settings } from './chat-settings.ts';
import { print_console_log } from './debug-request-log.ts';
import { as_object } from './envelope.ts';
import { take_token } from './rate-bucket.ts';
import {
	emit_to_session,
	emit_to_users,
	on_realtime_tick,
	on_socket_close,
	on_socket_connect,
	on_socket_event,
	type SocketEventContext,
	type SocketIdentity,
} from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

type RealtimeStore = Pick<
	ImperiumStore,
	| 'has'
	| 'find_id'
	| 'find_many'
	| 'chat_member_ids'
	| 'chat_users_brief'
	| 'chat_privacy_many'
	| 'chat_mark_delivered_up_to'
	| 'chat_contact_owners'
>;

type ManualState = 'available' | 'busy' | 'dnd' | 'invisible';
type PresenceState = 'available' | 'away' | 'busy' | 'dnd' | 'offline';

const CACHE_MS = 60_000;
const TYPING_TTL_MS = 6_000;
const TYPING_RESEND_MS = 2_000;
const DELIVERED_EVERY_MS = 2_000;
const AWAY_AFTER_MS = 10 * 60_000;
const OFFLINE_GRACE_MS = 30_000;
const SUBSCRIBE_MAX = 200;
const ACTIVITY_RATE = { capacity: 1, refill_per_s: 1 / 10 };
const DAY_MS = 86_400_000;
const CHAT_ID = /^[a-f0-9]{24}$/i;
const TYPING_STATES = new Set(['typing', 'paused', 'stopped']);
const MANUAL_STATES = new Set<string>(['available', 'busy', 'dnd', 'invisible']);

let store: RealtimeStore;

/** Miembros activos y si la conversación tiene funciones en vivo; el contrato admite 60 s de caché. */
type Room = { member_ids: string[]; live: boolean; at: number };
const rooms = new Map<string, Room>();

type Person = { name: string; typing: boolean; last_seen: string; presence_status: string; at: number };
const people = new Map<string, Person>();

type Typing = {
	conversation_id: string;
	user_id: string;
	name: string;
	state: string;
	session_id: string;
	receivers: string[];
	sent_at: number;
	expires_at: number;
};
/** `conversation_id:user_id` → lo último que se avisó. */
const typing = new Map<string, Typing>();

type Delivered = { conversation_id: string; user_id: string; seq: number; flushed_at: number; pending: boolean };
const delivered = new Map<string, Delivered>();

/** Los plazos (ausente, gracia) los decide solo el latido y quedan fijos hasta el siguiente evento. */
type Presence = {
	/** Sesión → si su cliente avisó que está inactivo. */
	sessions: Map<string, boolean>;
	manual: ManualState | null;
	/** Hasta leer `presence_status` se ve desconectado: así un invisible no se asoma al conectar. */
	ready: boolean;
	active_at: number;
	inactive: boolean;
	/** Cerró su última sesión y aún corre la gracia. */
	gone_at: number | null;
	seen_at: number | null;
	shown: PresenceState;
};
const presence = new Map<string, Presence>();
/** Sesión → usuarios que sigue y si puede ver su última vez. */
const watching = new Map<string, Map<string, boolean>>();
const watchers = new Map<string, Set<string>>();

function invalid(): ChatError {
	return new ChatError(422, 'invalid_request', 'La petición no es válida.');
}

function report(err: unknown): void {
	print_console_log('error', `Tiempo real del chat: ${err instanceof Error ? err.message : String(err)}`);
}

function user_of(identity: SocketIdentity | null): string {
	return identity?.kind === 'user' ? identity.user_id : '';
}

async function load_room(conversation_id: string, now: number): Promise<Room> {
	const cached = rooms.get(conversation_id);
	if (cached && now - cached.at < CACHE_MS) return cached;
	const conversation = await find_chat_conversation(store, conversation_id);
	const settings = await chat_settings(store);
	const room = {
		member_ids: await store.chat_member_ids(conversation_id),
		live: (Number(conversation.memberCount) || 0) <= settings.live_features_max_members,
		at: now,
	};
	rooms.set(conversation_id, room);
	return room;
}

async function member_room(conversation_id: string, user_id: string, now: number): Promise<Room> {
	const room = await load_room(conversation_id, now);
	if (!room.member_ids.includes(user_id)) {
		throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
	}
	return room;
}

/** Nombre y privacidad de cada persona, en una consulta por lote de las que no están en caché. */
async function people_of(ids: string[], now: number): Promise<Map<string, Person>> {
	const missing = [...new Set(ids)].filter((id) => {
		const hit = people.get(id);
		return !hit || now - hit.at >= CACHE_MS;
	});
	if (missing.length) {
		const [briefs, settings] = await Promise.all([store.chat_users_brief(missing), store.chat_privacy_many(missing)]);
		const names = new Map(briefs.map((user) => [user._id, user.name]));
		for (const id of missing) {
			const row = settings.get(id);
			const privacy = row?.privacy ?? {};
			people.set(id, {
				name: names.get(id) ?? '',
				typing: privacy.typing !== false,
				last_seen: typeof privacy.last_seen === 'string' ? privacy.last_seen : 'everyone',
				presence_status: row?.presence_status ?? '',
				at: now,
			});
		}
	}
	return new Map(ids.flatMap((id) => (people.has(id) ? [[id, people.get(id)!] as const] : [])));
}

function emit_typing(entry: Typing, state: string): void {
	if (!entry.receivers.length) return;
	emit_to_users(entry.receivers, 'update', {
		action: 'chat_typing',
		data: [{ conversation_id: entry.conversation_id, user_id: entry.user_id, name: entry.name, state }],
	});
}

/** Contrato §5.5: lo mismo dentro de 2 s solo renueva la caducidad; un cambio de estado sale siempre. */
async function on_typing(ctx: SocketEventContext, data: unknown): Promise<object> {
	const uid = user_of(ctx.identity);
	const input = as_object(data);
	const conversation_id = String(input.conversation_id ?? '');
	const state = String(input.state ?? '');
	if (!TYPING_STATES.has(state)) throw invalid();
	const now = Date.now();
	const room = await member_room(conversation_id, uid, now);
	const key = `${conversation_id}:${uid}`;
	const current = typing.get(key);
	if (state === 'stopped') {
		if (current) {
			typing.delete(key);
			emit_typing(current, 'stopped');
		}
		return {};
	}
	if (current && current.state === state && now - current.sent_at < TYPING_RESEND_MS) {
		current.expires_at = now + TYPING_TTL_MS;
		current.session_id = ctx.session_id;
		return {};
	}
	const others = room.member_ids.filter((id) => id !== uid);
	const known = await people_of([uid, ...others], now);
	const me = known.get(uid);
	if (!room.live || me?.typing === false) return {};
	const entry: Typing = {
		conversation_id,
		user_id: uid,
		name: me?.name ?? '',
		state,
		session_id: ctx.session_id,
		receivers: others.filter((id) => known.get(id)?.typing !== false),
		sent_at: now,
		expires_at: now + TYPING_TTL_MS,
	};
	typing.set(key, entry);
	emit_typing(entry, state);
	return {};
}

async function flush_delivered(entry: Delivered, now: number): Promise<void> {
	entry.pending = false;
	entry.flushed_at = now;
	const seq = await store.chat_mark_delivered_up_to(entry.conversation_id, entry.user_id, entry.seq);
	if (seq === null) return;
	const room = await load_room(entry.conversation_id, now);
	if (!room.live) return;
	emit_to_users(room.member_ids, 'update', {
		action: 'chat_delta',
		data: [{ conversation_id: entry.conversation_id, op: 'delivered', user_id: entry.user_id, seq }],
	});
}

/** Contrato §5.5: una escritura cada 2 s por conversación; lo que llega antes se agrupa y vale el mayor. */
async function on_delivered(ctx: SocketEventContext, data: unknown): Promise<object> {
	const uid = user_of(ctx.identity);
	const input = as_object(data);
	const conversation_id = String(input.conversation_id ?? '');
	const seq = Number(input.seq);
	if (!Number.isSafeInteger(seq) || seq < 0) throw invalid();
	const now = Date.now();
	await member_room(conversation_id, uid, now);
	const key = `${conversation_id}:${uid}`;
	const entry = delivered.get(key) ?? { conversation_id, user_id: uid, seq: 0, flushed_at: 0, pending: false };
	entry.seq = Math.max(entry.seq, seq);
	delivered.set(key, entry);
	if (now - entry.flushed_at < DELIVERED_EVERY_MS) {
		entry.pending = true;
		return {};
	}
	await flush_delivered(entry, now);
	return {};
}

function seen_bucket(seen_at: number, now: number): string {
	const ago = now - seen_at;
	if (ago < 3 * DAY_MS) return 'recently';
	if (ago < 7 * DAY_MS) return 'this_week';
	if (ago < 30 * DAY_MS) return 'this_month';
	return 'long_ago';
}

/** `invisible` se ve como desconectado; tras cerrar la última sesión queda conectado la gracia. */
function state_of(p: Presence | undefined): PresenceState {
	if (!p?.ready || p.manual === 'invisible') return 'offline';
	if (!p.sessions.size && p.gone_at === null) return 'offline';
	if (p.manual === 'busy' || p.manual === 'dnd') return p.manual;
	const idle = p.sessions.size > 0 && [...p.sessions.values()].every(Boolean);
	return idle || p.inactive ? 'away' : 'available';
}

function presence_entry(user_id: string, sees_last_seen: boolean, now: number): Record<string, string> {
	const p = presence.get(user_id);
	const state = state_of(p);
	if (state !== 'offline' || !sees_last_seen || p?.seen_at == null) return { user_id, state };
	return { user_id, state, last_seen_bucket: seen_bucket(p.seen_at, now) };
}

function publish(user_id: string, now: number): void {
	const p = presence.get(user_id);
	if (!p) return;
	const state = state_of(p);
	if (state === p.shown) return;
	// Se volvió invisible con la sesión abierta: desde aquí cuenta su última vez.
	if (state === 'offline' && p.sessions.size) p.seen_at = now;
	p.shown = state;
	for (const session_id of watchers.get(user_id) ?? []) {
		emit_to_session(session_id, 'update', {
			action: 'presence',
			data: [presence_entry(user_id, watching.get(session_id)?.get(user_id) === true, now)],
		});
	}
}

async function load_manual(user_id: string, p: Presence): Promise<void> {
	try {
		const status = (await people_of([user_id], Date.now())).get(user_id)?.presence_status ?? '';
		if (p.manual === null && MANUAL_STATES.has(status)) p.manual = status as ManualState;
	} catch (err) {
		report(err);
	}
	p.ready = true;
	publish(user_id, Date.now());
}

function on_connect(ctx: SocketEventContext): void {
	const uid = user_of(ctx.identity);
	if (!uid) return;
	const now = Date.now();
	let p = presence.get(uid);
	if (!p) {
		p = {
			sessions: new Map(),
			manual: null,
			ready: false,
			active_at: now,
			inactive: false,
			gone_at: null,
			seen_at: null,
			shown: 'offline',
		};
		presence.set(uid, p);
		void load_manual(uid, p);
	}
	p.sessions.set(ctx.session_id, false);
	p.gone_at = null;
	p.active_at = now;
	p.inactive = false;
	publish(uid, now);
}

function unwatch(session_id: string): void {
	for (const user_id of watching.get(session_id)?.keys() ?? []) {
		const sessions = watchers.get(user_id);
		sessions?.delete(session_id);
		if (!sessions?.size) watchers.delete(user_id);
	}
	watching.delete(session_id);
}

function on_close(ctx: { session_id: string; identity: SocketIdentity | null }): void {
	for (const [key, entry] of typing) {
		if (entry.session_id !== ctx.session_id) continue;
		typing.delete(key);
		emit_typing(entry, 'stopped');
	}
	unwatch(ctx.session_id);
	const uid = user_of(ctx.identity);
	const p = presence.get(uid);
	if (!p) return;
	const now = Date.now();
	p.sessions.delete(ctx.session_id);
	if (!p.sessions.size) p.gone_at = now;
	publish(uid, now);
}

/**
 * Reemplaza lo que sigue la sesión. La última vez se ve solo si quien la pide también comparte la
 * suya y si su dueño la comparte con todos, o con sus contactos y quien la pide es uno.
 */
async function on_subscribe(ctx: SocketEventContext, data: unknown): Promise<object> {
	const uid = user_of(ctx.identity);
	const ids = as_object(data).user_ids;
	if (
		!Array.isArray(ids) ||
		ids.length > SUBSCRIBE_MAX ||
		!ids.every((id): id is string => typeof id === 'string' && CHAT_ID.test(id))
	) {
		throw invalid();
	}
	const targets = [...new Set(ids)];
	const now = Date.now();
	const known = await people_of([uid, ...targets], now);
	const shares = known.get(uid)?.last_seen !== 'nobody';
	const rule = (id: string) => known.get(id)?.last_seen ?? 'everyone';
	const contacts = shares
		? new Set(await store.chat_contact_owners(uid, targets.filter((id) => rule(id) === 'contacts')))
		: new Set<string>();
	unwatch(ctx.session_id);
	const sees = new Map(
		targets.map((id) => [id, shares && (rule(id) === 'everyone' || (rule(id) === 'contacts' && contacts.has(id)))]),
	);
	watching.set(ctx.session_id, sees);
	for (const id of targets) {
		const sessions = watchers.get(id) ?? new Set<string>();
		sessions.add(ctx.session_id);
		watchers.set(id, sessions);
	}
	return { data: targets.map((id) => presence_entry(id, sees.get(id) === true, now)) };
}

function on_set(ctx: SocketEventContext, data: unknown): object {
	const state = String(as_object(data).state ?? '');
	if (!MANUAL_STATES.has(state)) throw invalid();
	const uid = user_of(ctx.identity);
	const p = presence.get(uid);
	if (!p) return {};
	p.manual = state as ManualState;
	p.ready = true;
	publish(uid, Date.now());
	return {};
}

function on_activity(ctx: SocketEventContext, data: unknown): object {
	const idle = as_object(data).idle;
	if (typeof idle !== 'boolean') throw invalid();
	if (!take_token(`socket:${ctx.session_id}:presence:activity`, ACTIVITY_RATE).ok) {
		throw new ChatError(429, 'socket_rate_limited', 'Vas demasiado rápido.');
	}
	const uid = user_of(ctx.identity);
	const p = presence.get(uid);
	if (!p) return {};
	const now = Date.now();
	p.sessions.set(ctx.session_id, idle);
	if (!idle) {
		p.active_at = now;
		p.inactive = false;
	}
	publish(uid, now);
	return {};
}

/** Caducidad de la escritura, entregados agrupados, ausente, gracia y limpieza de cachés. `now` es inyectable. */
export function chat_realtime_tick(now = Date.now()): void {
	for (const [key, entry] of typing) {
		if (entry.expires_at > now) continue;
		typing.delete(key);
		emit_typing(entry, 'stopped');
	}
	for (const [key, entry] of delivered) {
		if (now - entry.flushed_at < DELIVERED_EVERY_MS) continue;
		if (entry.pending) void flush_delivered(entry, now).catch(report);
		else delivered.delete(key);
	}
	for (const [user_id, p] of presence) {
		if (p.sessions.size && now - p.active_at >= AWAY_AFTER_MS) p.inactive = true;
		if (p.gone_at !== null && now - p.gone_at >= OFFLINE_GRACE_MS) {
			// Un invisible conserva la última vez de cuando dejó de verse.
			if (p.shown !== 'offline') p.seen_at = p.gone_at;
			p.gone_at = null;
		}
		publish(user_id, now);
	}
	for (const [id, room] of rooms) if (now - room.at >= CACHE_MS) rooms.delete(id);
	for (const [id, person] of people) if (now - person.at >= CACHE_MS) people.delete(id);
}

let started = false;

export function start_chat_realtime(chat_store: RealtimeStore): void {
	store = chat_store;
	if (started) return;
	started = true;
	on_socket_event('chat:typing', on_typing);
	on_socket_event('chat:delivered', on_delivered);
	on_socket_event('presence:subscribe', on_subscribe, { per_second: 1 });
	on_socket_event('presence:set', on_set, { per_second: 1 });
	on_socket_event('presence:activity', on_activity);
	on_socket_connect(on_connect);
	on_socket_close(on_close);
	on_realtime_tick(chat_realtime_tick);
}
