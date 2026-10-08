/**
 * Llamadas del chat (contrato §4.3 y §6). Cada cambio lee la llamada, aplica `transition`
 * (`call-state.ts`), la escribe con compare-and-swap sobre `v` y solo entonces ejecuta los
 * efectos: avisos, mensaje de la llamada, actividad, asistencia y temporizadores. Los
 * temporizadores viven en memoria; el barrido de cada 10 s cubre lo que un reinicio dejó a medias.
 */
import { can_enter_internal } from '@opus-perpetuus/imperium-core-kit';
import {
	call_update,
	call_view,
	transition,
	type CallDoc,
	type CallEffect,
	type CallErrorCode,
	type CallEvent,
	type CallLeg,
	type CallMedia,
	type CallOutcome,
	type RoomRole,
	type TopologyLimits,
} from './call-state.ts';
import {
	attendance_exit,
	flush_attendance,
	guest_admitted,
	meeting_call_closed,
	meeting_room_idle,
	room_member,
	room_state,
	run_room_command,
	sync_room_with_call,
} from './call-room.ts';
import { assert_chat_member, chat_can, chat_role, ChatError, find_chat_conversation } from './chat-access.ts';
import { raw_json_body } from './body.ts';
import { create_chat_message, post_call_message } from './chat-flow.ts';
import { chat_settings, type ChatSettings } from './chat-settings.ts';
import { print_console_log } from './debug-request-log.ts';
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import {
	ice_servers as ice_servers_for,
	sfu_admin,
	sfu_available,
	sfu_grants,
	sfu_room,
	sfu_token as sign_sfu_token,
	sfu_webhook_event,
	turn_configured,
	type SfuSource,
} from './media-credentials.ts';
import { insert_notification, register_chat_activity } from './notifications.ts';
import { rate_limited_response, take_token } from './rate-bucket.ts';
import { verify_realtime_token } from './realtime-tokens.ts';
import { emit_to_guest, emit_to_room, emit_to_users, leave_room_server, online_user_ids } from './socket-stub.ts';
import { is_missing_relation, is_unique_violation, type ImperiumStore } from './store.ts';

export type CallCtx = {
	store: ImperiumStore;
	req: Request;
	url: URL;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
};

export type CallPrincipal =
	| { kind: 'user'; user_id: string; member_key: `u:${string}`; name: string }
	| { kind: 'guest'; guest_id: string; meeting_id: string; member_key: `g:${string}`; name: string };

const GUEST_COOKIE = /(?:^|;\s*)imperium_invitado=([^;]+)/;
const CHAT_ID = /^[a-f0-9]{24}$/i;
const LEG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SFU_ROOM = /^imperium-([a-f0-9]{24})$/i;
/** `<member_key>:<leg_id>`, la identidad que firma `sfu_token`. */
const SFU_IDENTITY = /^([ug]:[^:]+):([A-Za-z0-9_-]{1,64})$/;
const CAS_RETRIES = 3;
const START_RATE = { capacity: 10, refill_per_s: 10 / 60 };
const HISTORY_LIMIT = { fallback: 20, max: 50 };
const LIVE_BATCH = 200;
const GRACE_S = 30;
const SWEEP_MS = 10_000;
const FIRST_SWEEP_MS = 5_000;
/** Quien espera en la sala de una reunión la mantiene viva este tiempo aunque nadie esté adentro. */
const LOBBY_WAIT_MS = 10 * 60_000;

const CALL_ERRORS: Record<CallErrorCode, [status: number, message: string]> = {
	not_ringing: [409, 'La llamada ya no está sonando.'],
	answered_elsewhere: [409, 'Contestaste en otro dispositivo.'],
	not_initiator: [403, 'Solo quien inició la llamada puede cancelarla.'],
	not_host: [403, 'Solo el anfitrión puede hacer esto.'],
	call_ended: [409, 'La llamada terminó.'],
	room_full: [409, 'Para más participantes se necesita el servidor de medios.'],
	invalid_request: [422, 'A una reunión se entra con su código.'],
};

function str(value: unknown): string {
	return value == null ? '' : String(value).trim();
}

function strip<T extends Record<string, unknown>>(rec: T): T {
	for (const key of Object.keys(rec)) if (rec[key] === undefined) delete rec[key];
	return rec;
}

function report(err: unknown): void {
	print_console_log('error', `Llamadas: ${err instanceof Error ? err.message : String(err)}`);
}

function invalid(message = 'La petición no es válida.'): ChatError {
	return new ChatError(422, 'invalid_request', message);
}

function call_not_found(): ChatError {
	return new ChatError(404, 'call_not_found', 'No encontramos esa llamada.');
}

function call_error(code: CallErrorCode): ChatError {
	const [status, message] = CALL_ERRORS[code];
	return new ChatError(status, code, message);
}

async function enabled_settings(store: ImperiumStore): Promise<ChatSettings> {
	const settings = await chat_settings(store);
	if (!settings.calls_enabled) {
		throw new ChatError(403, 'calls_disabled', 'Las llamadas están desactivadas en esta organización.');
	}
	return settings;
}

function limits(settings: ChatSettings): TopologyLimits {
	return { sfu: sfu_available(), mesh_max: settings.mesh_max, class_max: settings.class_max };
}

export function guest_token_invalid(): ChatError {
	return new ChatError(401, 'guest_token_invalid', 'Tu acceso como invitado venció; vuelve a entrar con el enlace.');
}

export function guest_not_admitted(): ChatError {
	return new ChatError(403, 'guest_not_admitted', 'Espera a que el anfitrión te admita.');
}

/**
 * Quién pide una ruta **P** (contrato §0.4): la sesión interna o la cookie `imperium_invitado`
 * firmada para esa reunión. Todo lo demás se rechaza; una sesión del portal cuenta como nadie.
 */
export function meeting_principal(ctx: Pick<CallCtx, 'actor' | 'req'>, meeting_id: string): CallPrincipal {
	const user_id = str(ctx.actor?._id);
	if (user_id && ctx.actor && can_enter_internal(ctx.actor)) {
		return { kind: 'user', user_id, member_key: `u:${user_id}`, name: str(ctx.actor.name ?? ctx.actor.email) };
	}
	const token = guest_cookie(ctx.req);
	if (token === null) throw new ChatError(401, 'unauthenticated', 'Inicia sesión para continuar.');
	const claims = token ? verify_realtime_token(token, 'guest') : null;
	if (!claims || !meeting_id || claims.mid !== meeting_id) throw guest_token_invalid();
	return { kind: 'guest', guest_id: claims.gid, meeting_id: claims.mid, member_key: `g:${claims.gid}`, name: claims.name };
}

/** `null` sin cookie de invitado; vacía si no se puede leer. */
function guest_cookie(req: Request): string | null {
	const raw = req.headers.get('cookie')?.match(GUEST_COOKIE)?.[1];
	if (!raw) return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return '';
	}
}

/** La cookie de invitado vigente, de la reunión que sea; `null` si no hay o no vale. */
export function guest_claims(req: Request): { gid: string; mid: string; name: string; exp: number } | null {
	const token = guest_cookie(req);
	return token ? verify_realtime_token(token, 'guest') : null;
}

function leg_from(raw: unknown): CallLeg {
	const leg = as_object(raw);
	return strip({
		user_id: str(leg.userId),
		state: str(leg.state) as CallLeg['state'],
		device: str(leg.device) || undefined,
		busy: leg.busy === true ? true : undefined,
		invited_at: str(leg.invitedAt),
		joined_at: str(leg.joinedAt) || undefined,
		left_at: str(leg.leftAt) || undefined,
		reason: (str(leg.reason) || undefined) as CallLeg['reason'],
	});
}

function leg_payload(leg: CallLeg): ImperiumDoc {
	return strip({
		userId: leg.user_id,
		state: leg.state,
		device: leg.device,
		busy: leg.busy,
		invitedAt: leg.invited_at,
		joinedAt: leg.joined_at,
		leftAt: leg.left_at,
		reason: leg.reason,
	});
}

/** El payload se guarda en camelCase (contrato §0.1); la máquina trabaja con `CallDoc`. */
export function call_from_row(row: ImperiumDoc): CallDoc {
	const recording = row.recording ? as_object(row.recording) : null;
	return strip({
		_id: str(row._id),
		state: str(row.state) as CallDoc['state'],
		v: Number(row.v) || 0,
		kind: str(row.kind) as CallDoc['kind'],
		media: str(row.media) as CallMedia,
		topology: (str(row.topology) || 'mesh') as CallDoc['topology'],
		conversation_id: str(row.conversation_id),
		conversation_key: str(row.conversationKey),
		meeting_id: str(row.meeting_id) || undefined,
		parent_call_id: str(row.parentCallId) || undefined,
		initiator_id: str(row.initiatorId),
		participant_ids: as_array(row.participantIds).map(String),
		legs: as_array(row.legs).map(leg_from),
		started_at: str(row.started_at),
		answered_at: str(row.answeredAt) || undefined,
		ended_at: str(row.ended_at) || undefined,
		duration_s: row.durationS == null ? undefined : Number(row.durationS),
		end_reason: (str(row.endReason) || undefined) as CallDoc['end_reason'],
		recording: recording
			? { by: str(recording.by), started_at: str(recording.startedAt), recording_id: str(recording.recordingId) }
			: undefined,
	});
}

function call_write(call: CallDoc) {
	return {
		state: call.state,
		columns: {
			conversation_id: call.conversation_id,
			meeting_id: call.meeting_id ?? null,
			kind: call.kind,
			started_at: call.started_at,
			ended_at: call.ended_at ?? null,
		},
		payload: strip({
			media: call.media,
			topology: call.topology,
			conversationKey: call.conversation_key,
			parentCallId: call.parent_call_id,
			initiatorId: call.initiator_id,
			participantIds: call.participant_ids,
			legs: call.legs.map(leg_payload),
			answeredAt: call.answered_at,
			durationS: call.duration_s,
			endReason: call.end_reason,
			// `null` y no `undefined`: el payload se mezcla y la grabación terminada debe borrarse.
			recording: call.recording
				? { by: call.recording.by, startedAt: call.recording.started_at, recordingId: call.recording.recording_id }
				: null,
		}),
	};
}

async function load_call(store: ImperiumStore, call_id: string): Promise<CallDoc> {
	const row = CHAT_ID.test(call_id) ? await store.find_id('chat-calls', call_id) : null;
	if (!row || row.is_active === false) throw call_not_found();
	return call_from_row(row);
}

/**
 * Lee, aplica la transición y escribe con CAS; si alguien escribió entre medias (otro
 * dispositivo, el barrido, un temporizador), vuelve a leer y a decidir, hasta 3 reintentos.
 */
async function apply_event(store: ImperiumStore, call_id: string, event: CallEvent, now = Date.now()): Promise<CallDoc> {
	for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
		const call = await load_call(store, call_id);
		const result = transition(call, event, now);
		if (!result.ok) throw call_error(result.code);
		if (!result.changed) {
			await run_effects(store, call, result.effects);
			return call;
		}
		const row = await store.update_versioned('chat-calls', call_id, call.v, call_write(result.call), new Date(now).toISOString());
		if (!row) continue;
		const next = call_from_row(row);
		await run_effects(store, next, result.effects);
		if (next.state === 'ended' && next.kind === 'meeting') await close_meeting_call(store, next);
		return next;
	}
	throw new ChatError(429, 'rate_limited', 'Demasiadas solicitudes; intenta de nuevo en 1 s.', { retry_after_s: 1 });
}

const ring_timers = new Map<string, ReturnType<typeof setTimeout>>();
const grace_timers = new Map<string, ReturnType<typeof setTimeout>>();

function disarm(timers: Map<string, ReturnType<typeof setTimeout>>, key: string): void {
	const timer = timers.get(key);
	if (timer) clearTimeout(timer);
	timers.delete(key);
}

function arm(timers: Map<string, ReturnType<typeof setTimeout>>, key: string, ms: number, fire: () => Promise<unknown>): void {
	disarm(timers, key);
	const timer = setTimeout(() => {
		timers.delete(key);
		void fire().catch(report);
	}, ms);
	timer.unref?.();
	timers.set(key, timer);
}

async function ring_out(store: ImperiumStore, call_id: string): Promise<void> {
	const settings = await chat_settings(store);
	await apply_event(store, call_id, { type: 'ring_timeout', ring_timeout_s: settings.ring_timeout_seconds });
}

function duration_text(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h) return `${h} h ${m} min`;
	return m ? `${m} min ${s} s` : `${s} s`;
}

/** La vista previa de la bandeja; el mensaje lleva el resultado estructurado. */
function call_text(call: CallDoc, outcome: CallOutcome, duration_s?: number): string {
	const name = call.media === 'video' ? 'Videollamada' : 'Llamada de voz';
	switch (outcome) {
		case 'completed':
			return duration_s ? `${name} · ${duration_text(duration_s)}` : name;
		case 'missed':
			return `${name} perdida`;
		case 'declined':
			return `${name} rechazada`;
		case 'cancelled':
			return `${name} cancelada`;
		case 'busy':
			return `${name} sin respuesta: ocupado`;
		case 'failed':
			return `${name} interrumpida`;
	}
}

/** En una reunión cuenta la sala; en una llamada de chat, las patas unidas. */
export function joined_count(call: CallDoc): number | undefined {
	if (call.kind !== 'meeting') return undefined;
	return new Set(room_state(call._id).members.map((member) => member.member_key)).size;
}

export function view_of(call: CallDoc): ReturnType<typeof call_view> {
	return call_view(call, { joined_count: joined_count(call) });
}

async function publish_update(store: ImperiumStore, call: CallDoc): Promise<void> {
	const update = call_update(call, joined_count(call));
	const members = await store.chat_member_ids(call.conversation_id);
	// En un grupo todos los miembros ven el aviso «Unirse»; una reunión se avisa en su sala.
	const targets = new Set([...call.legs.map((leg) => leg.user_id), ...(call.kind === 'group' ? members : [])]);
	emit_to_users(targets, 'update', { action: 'call_update', data: [update] });
	if (call.kind === 'meeting') emit_to_room(`call:${call._id}`, 'update', { action: 'call_update', data: [update] });
	// Quien espera no está en la sala `call:<id>`, y al cerrarla la sala de espera se pierde.
	if (call.kind === 'meeting' && call.state === 'ended') {
		for (const { member_key } of room_state(call._id).lobby) {
			if (member_key.startsWith('u:')) emit_to_users([member_key.slice(2)], 'update', { action: 'call_update', data: [update] });
			else emit_to_guest(member_key.slice(2), 'update', { action: 'call_update', data: [update] });
		}
	}
	sync_room_with_call(call);
	// La conversación anuncia la sala principal, nunca una sala pequeña.
	if (call.parent_call_id) return;
	const live = call.state !== 'ended';
	const changed = await store.chat_set_active_call({
		conversation_id: call.conversation_id,
		call_id: call._id,
		value: live ? { callId: call._id, media: call.media, participantCount: update.joined_count } : null,
		now: new Date().toISOString(),
	});
	if (!changed) return;
	const active_call = live ? { call_id: call._id, media: call.media, participant_count: update.joined_count } : null;
	emit_to_users(members, 'update', {
		action: 'chat_delta',
		data: [{ conversation_id: call.conversation_id, op: 'conversation', patch: { active_call } }],
	});
}

async function notify_missed(store: ImperiumStore, call: CallDoc, user_ids: string[], message: ImperiumDoc): Promise<void> {
	const [caller] = await store.chat_users_brief([call.initiator_id]);
	const title = call.media === 'video' ? 'Videollamada perdida' : 'Llamada perdida';
	const message_id = str(message._id);
	const route = `/mensajes?chat_conversation_id=${call.conversation_id}&chat_message_id=${message_id}`;
	await register_chat_activity(
		store,
		{ _id: call.initiator_id, name: caller?.name, email: caller?.email },
		user_ids.map((user_id) => ({
			user_id,
			context_type: 'chat-missed-call' as const,
			conversation_id: call.conversation_id,
			message_id,
			excerpt: title,
		})),
	);
	for (const user_id of user_ids) {
		await insert_notification(store, {
			recipientId: user_id,
			type: 'call-missed',
			title,
			message: `${caller?.name || 'Alguien'} te llamó.`,
			isRead: false,
			source: {
				kind: 'chat',
				action: 'missed_call',
				conversationId: call.conversation_id,
				messageId: message_id,
				route,
			},
			payload: { call_id: call._id },
		});
	}
}

/** Un intervalo por salida; la fila de cada persona los acumula. */
async function save_attendance(store: ImperiumStore, call: CallDoc, user_ids: string[]): Promise<void> {
	const names = new Map((await store.chat_users_brief(user_ids)).map((user) => [user._id, user.name]));
	const now = new Date().toISOString();
	for (const user_id of user_ids) {
		const leg = call.legs.find((item) => item.user_id === user_id);
		if (!leg?.joined_at) continue;
		const out = leg.left_at ?? call.ended_at ?? now;
		const network = leg.reason === 'network';
		await store.upsert_call_attendance({
			call_id: call._id,
			meeting_id: call.meeting_id ?? null,
			participant_key: `u:${user_id}`,
			name: names.get(user_id) ?? '',
			payload: {
				userId: user_id,
				displayName: names.get(user_id) ?? '',
				role: user_id === call.initiator_id ? 'host' : 'participant',
				intervals: [strip({ in: leg.joined_at, out, reason: network ? 'network' : undefined })],
				totalS: Math.max(0, Math.round((Date.parse(out) - Date.parse(leg.joined_at)) / 1000)),
				waitedS: 0,
				reconnections: network ? 1 : 0,
				hands: 0,
				reactions: 0,
				questions: 0,
				cameraS: 0,
			},
			now,
		});
	}
}

/** Contestó estando en otra llamada (pata en espera): sale de la anterior. */
async function leave_other_calls(store: ImperiumStore, call: CallDoc, user_id: string): Promise<void> {
	for (const row of await store.live_calls_with([user_id])) {
		const other = call_from_row(row);
		const leg = other.legs.find((item) => item.user_id === user_id && item.state === 'joined');
		if (other._id === call._id || !leg?.device) continue;
		await apply_event(store, other._id, { type: 'leave', user_id, leg_id: leg.device });
	}
}

/** Después de escribir en Postgres. Un efecto que falla no deshace la llamada ni los demás. */
async function run_effects(store: ImperiumStore, call: CallDoc, effects: CallEffect[]): Promise<void> {
	let message: ImperiumDoc | null = null;
	for (const effect of effects) {
		try {
			switch (effect.type) {
				case 'emit_update':
					await publish_update(store, call);
					break;
				case 'start_ring_timer':
					arm(ring_timers, call._id, effect.ms, () => ring_out(store, call._id));
					break;
				case 'clear_ring_timer':
					disarm(ring_timers, call._id);
					break;
				case 'start_grace_timer':
					arm(grace_timers, `${call._id}:${effect.user_id}`, effect.ms, () =>
						apply_event(store, call._id, { type: 'leave', user_id: effect.user_id, leg_id: effect.leg_id, reason: 'network' }),
					);
					break;
				case 'clear_grace_timer':
					disarm(grace_timers, `${call._id}:${effect.user_id}`);
					break;
				case 'leave_other_calls':
					await leave_other_calls(store, call, effect.user_id);
					break;
				case 'call_message':
					message = await post_call_message(store, {
						conversation_id: call.conversation_id,
						call: strip({
							callId: call._id,
							kind: call.kind,
							media: call.media,
							outcome: effect.outcome,
							durationS: effect.duration_s,
							initiatorId: call.initiator_id,
						}),
						text_preview: call_text(call, effect.outcome, effect.duration_s),
						read_by: call.participant_ids.filter((user_id) => !effect.unread_user_ids.includes(user_id)),
					});
					break;
				case 'notify_missed':
					// Sin mensaje nuevo, el aviso ya salió con el que existía.
					if (message) await notify_missed(store, call, effect.user_ids, message);
					break;
				case 'attendance':
					await save_attendance(store, call, effect.user_ids);
					break;
				// El servidor de medios no frena la llamada: si tarda o falla, queda en el registro.
				case 'sfu_remove':
					void impose_on_sfu(store, call, { type: 'remove', member_key: effect.member_key, leg_id: effect.leg_id }).catch(report);
					break;
				case 'sfu_close':
					void sfu_admin()?.delete_room(sfu_room(call._id)).catch(report);
					break;
			}
		} catch (err) {
			report(err);
		}
	}
}

function actor_id(ctx: CallCtx): string {
	return str(ctx.actor?._id);
}

export function media_of(value: unknown): CallMedia {
	if (value !== 'audio' && value !== 'video') throw invalid('Elige llamada de voz o videollamada.');
	return value;
}

export function leg_of(value: unknown): string {
	const leg_id = str(value);
	if (!LEG_ID.test(leg_id)) throw invalid('Falta el identificador de esta pestaña (leg_id).');
	return leg_id;
}

function new_id(): string {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

/** Solo un miembro activo de la conversación toca la llamada. */
async function assert_call_member(store: ImperiumStore, call: CallDoc, user_id: string): Promise<void> {
	await assert_chat_member(store, await find_chat_conversation(store, call.conversation_id), user_id);
}

function in_progress(call: CallDoc): ChatError {
	return new ChatError(409, 'call_in_progress', 'Ya hay una llamada en curso en esta conversación.', {
		call: call_view(call),
	});
}

function joined_elsewhere(calls: CallDoc[], user_id: string): boolean {
	return calls.some((call) => call.legs.some((leg) => leg.user_id === user_id && leg.state === 'joined'));
}

function invitees(body: Record<string, unknown>, members: string[]): string[] {
	if (body.invitee_ids == null) return members;
	const ids = body.invitee_ids;
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw invalid();
	return [...new Set(ids as string[])].filter((id) => members.includes(id));
}

export async function create_call(ctx: CallCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.body.conversation_id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	const kind = str(conversation.kind);
	if (kind !== 'direct' && kind !== 'group' && kind !== 'channel') throw invalid('Esta conversación no admite llamadas.');
	if (!chat_can(chat_role(member.role), as_object(conversation.settings), 'call')) {
		throw new ChatError(403, 'role_required', 'Tu rol en esta conversación no permite esta acción.');
	}
	const media = media_of(ctx.body.media);
	const leg_id = leg_of(ctx.body.leg_id);
	const conversation_id = str(conversation._id);
	const members = (await ctx.store.chat_member_ids(conversation_id)).filter((id) => id !== uid);
	const wanted = invitees(ctx.body, members);
	if (!wanted.length) throw invalid('No hay a quién llamar en esta conversación.');
	const existing = await ctx.store.live_call_for_conversation(conversation_id);
	if (existing) throw in_progress(call_from_row(existing));
	const live = (await ctx.store.live_calls_with([uid, ...wanted])).map(call_from_row);
	if (joined_elsewhere(live, uid)) throw new ChatError(409, 'already_in_call', 'Ya estás en otra llamada.');
	const allowed = take_token(`call-start:${uid}`, START_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const result = transition(
		null,
		{
			type: 'create',
			id: new_id(),
			kind: kind === 'direct' ? 'direct' : 'group',
			media,
			conversation_id,
			conversation_key: str(conversation.conversation_key),
			initiator_id: uid,
			leg_id,
			invitee_ids: wanted,
			busy_ids: wanted.filter((id) => joined_elsewhere(live, id)),
			ring_timeout_s: settings.ring_timeout_seconds,
		},
		Date.now(),
	);
	if (!result.ok) throw call_error(result.code);
	const write = call_write(result.call);
	let row: ImperiumDoc;
	try {
		row = await ctx.store.insert('chat-calls', {
			_id: result.call._id,
			name: '',
			state: write.state,
			...write.columns,
			...write.payload,
			v: 0,
		});
	} catch (err) {
		if (!is_unique_violation(err)) throw err;
		const winner = await ctx.store.live_call_for_conversation(conversation_id);
		if (!winner) throw err;
		throw in_progress(call_from_row(winner));
	}
	const call = call_from_row(row);
	await run_effects(ctx.store, call, result.effects);
	const online = online_user_ids();
	return ok([call_view(call, { callee_online: wanted.some((id) => online.has(id)) })], 'Llamada iniciada.');
}

/**
 * La llamada de una reunión: activa desde que se abre, sin patas, con quien organiza al frente.
 * Una sala pequeña lleva el id que ya le dio su sala principal.
 */
export async function open_meeting_call(
	store: ImperiumStore,
	input: {
		meeting_id: string;
		conversation_id: string;
		conversation_key: string;
		host_id: string;
		media: CallMedia;
		id?: string;
		parent_call_id?: string;
	},
): Promise<CallDoc> {
	const result = transition(null, { type: 'open_meeting', ...input, id: input.id ?? new_id() }, Date.now());
	if (!result.ok) throw call_error(result.code);
	const write = call_write(result.call);
	const row = await store.insert('chat-calls', {
		_id: result.call._id,
		name: '',
		state: write.state,
		...write.columns,
		...write.payload,
		v: 0,
	});
	const call = call_from_row(row);
	await run_effects(store, call, result.effects);
	return call;
}

/** Una persona más admitida: la topología sube si hace falta, o la sala ya no cabe. */
export async function grow_meeting_call(store: ImperiumStore, call_id: string, joined_next: number): Promise<CallDoc> {
	const settings = await chat_settings(store);
	return apply_event(store, call_id, { type: 'grow', joined_next, limits: limits(settings) });
}

/** Terminar para todos: el iniciador de un grupo o quien organiza la reunión. */
export async function end_call_for_all(store: ImperiumStore, call_id: string, user_id: string, is_host: boolean): Promise<CallDoc> {
	return apply_event(store, call_id, { type: 'end', user_id, is_host });
}

async function close_meeting_call(store: ImperiumStore, call: CallDoc): Promise<void> {
	idle_since.delete(call._id);
	await flush_attendance(store, call, { final: true, now: Date.parse(call.ended_at ?? '') || Date.now() }).catch(report);
	await meeting_call_closed(store, call).catch(report);
}

export async function accept_call(ctx: CallCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const call = await load_call(ctx.store, str(ctx.params.id));
	await assert_call_member(ctx.store, call, uid);
	const leg_id = leg_of(ctx.body.leg_id);
	const next = await apply_event(ctx.store, call._id, { type: 'accept', user_id: uid, leg_id, limits: limits(settings) });
	return ok([call_view(next)], 'Llamada contestada.');
}

/** El mensaje rápido sale como mensaje de quien rechaza, con las reglas de cualquier envío. */
export async function decline_call(ctx: CallCtx): Promise<unknown> {
	const uid = actor_id(ctx);
	const call = await load_call(ctx.store, str(ctx.params.id));
	const leg_id = leg_of(ctx.body.leg_id);
	const text = typeof ctx.body.message === 'string' ? ctx.body.message.trim() : '';
	const next = await apply_event(ctx.store, call._id, { type: 'decline', user_id: uid, leg_id });
	if (text) {
		await create_chat_message({
			...ctx,
			params: {},
			body: { conversation_id: call.conversation_id, client_id: crypto.randomUUID(), text },
		}).catch(report);
	}
	return ok([call_view(next)], 'Llamada rechazada.');
}

export async function cancel_call(ctx: CallCtx): Promise<unknown> {
	const call = await load_call(ctx.store, str(ctx.params.id));
	const next = await apply_event(ctx.store, call._id, { type: 'cancel', user_id: actor_id(ctx) });
	return ok([call_view(next)], 'Llamada cancelada.');
}

export async function join_call(ctx: CallCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const call = await load_call(ctx.store, str(ctx.params.id));
	await assert_call_member(ctx.store, call, uid);
	const leg_id = leg_of(ctx.body.leg_id);
	const next = await apply_event(ctx.store, call._id, { type: 'join', user_id: uid, leg_id, limits: limits(settings) });
	return ok([call_view(next)], 'Entraste a la llamada.');
}

export async function leave_call(ctx: CallCtx): Promise<unknown> {
	const call = await load_call(ctx.store, str(ctx.params.id));
	const principal = meeting_principal(ctx, call.meeting_id ?? '');
	const leg_id = leg_of(ctx.body.leg_id);
	if (principal.kind === 'guest' || call.kind === 'meeting') {
		// En una reunión nadie tiene pata en la llamada: se sale de su sala, o de la espera.
		const member = room_member(call._id, { leg_id });
		const waiting = room_state(call._id).lobby.some((entry) => entry.member_key === principal.member_key);
		if (member?.member_key !== principal.member_key && !waiting) {
			throw principal.kind === 'guest' ? guest_not_admitted() : not_member();
		}
		if (member) {
			leave_room_server(member.session_id, `call:${call._id}`);
			if (call.meeting_id) leave_room_server(member.session_id, `meeting:${call.meeting_id}`);
			run_room_command(call._id, { type: 'detach', leg_id });
			attendance_exit(call._id, principal.member_key, leg_id, Date.now());
			void impose_on_sfu(ctx.store, call, { type: 'remove', member_key: principal.member_key, leg_id }).catch(report);
		} else run_room_command(call._id, { type: 'leave', member_key: principal.member_key });
		await flush_attendance(ctx.store, call, { member_key: principal.member_key }).catch(report);
		return ok([view_of(call)], 'Saliste de la llamada.');
	}
	const reason = ctx.body.reason === 'network' ? 'network' : undefined;
	const next = await apply_event(ctx.store, call._id, { type: 'leave', user_id: principal.user_id, leg_id, reason });
	return ok([call_view(next)], 'Saliste de la llamada.');
}

export async function end_call(ctx: CallCtx): Promise<unknown> {
	const call = await load_call(ctx.store, str(ctx.params.id));
	const next = await apply_event(ctx.store, call._id, { type: 'end', user_id: actor_id(ctx), is_host: false });
	return ok([view_of(next)], 'Llamada terminada para todos.');
}

/** Para resincronizar: lo vivo donde el actor tiene pata o, en grupos, donde es miembro. */
export async function read_active_calls(ctx: CallCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const mine: CallDoc[] = [];
	const by_conversation = new Map<string, CallDoc[]>();
	for (let after_id = ''; ; ) {
		const batch = await ctx.store.live_calls({ after_id, limit: LIVE_BATCH });
		for (const row of batch) {
			const call = call_from_row(row);
			if (call.participant_ids.includes(uid)) mine.push(call);
			else if (call.kind === 'group' || (call.kind === 'meeting' && !call.parent_call_id)) {
				by_conversation.set(call.conversation_id, [...(by_conversation.get(call.conversation_id) ?? []), call]);
			}
		}
		if (batch.length < LIVE_BATCH) break;
		after_id = str(batch.at(-1)!._id);
	}
	if (by_conversation.size) {
		const { rows } = await ctx.store.find_many('chat-members', {
			where: { user_id: uid, state: 'active', conversation_id: { in: [...by_conversation.keys()] } },
			take: by_conversation.size,
			populate: false,
			skip_total: true,
		});
		for (const row of rows) mine.push(...(by_conversation.get(str(row.conversation_id)) ?? []));
	}
	return ok(mine.map(view_of), 'Llamadas en curso.');
}

function encode_cursor(row: ImperiumDoc): string {
	return Buffer.from(JSON.stringify({ at: str(row.created_at), id: str(row._id) })).toString('base64url');
}

function decode_cursor(raw: string): { at: string; id: string } {
	try {
		const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
		if (typeof value.at === 'string' && typeof value.id === 'string') return { at: value.at, id: value.id };
	} catch {
		/* cae al error de abajo */
	}
	throw new ChatError(400, 'invalid_cursor', 'La página solicitada ya no es válida; recarga la lista.');
}

/** Historial por keyset `(created_at, id)`, del más nuevo al más viejo. */
export async function read_my_calls(ctx: CallCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const raw = str(ctx.url.searchParams.get('cursor'));
	const asked = Number(ctx.url.searchParams.get('limit'));
	const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, HISTORY_LIMIT.max) : HISTORY_LIMIT.fallback;
	const rows = await ctx.store.calls_page_for_user({
		user_id: actor_id(ctx),
		cursor: raw ? decode_cursor(raw) : undefined,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	return {
		...ok(page.map((row) => call_view(call_from_row(row))), 'Historial de llamadas.'),
		next_cursor: rows.length > limit ? encode_cursor(page.at(-1)!) : null,
		server_time: new Date().toISOString(),
	};
}

export async function read_settings(ctx: CallCtx): Promise<unknown> {
	const settings = await chat_settings(ctx.store);
	return ok(
		[
			{
				enabled: settings.calls_enabled,
				mesh_max: settings.mesh_max,
				class_max: settings.class_max,
				ring_timeout_seconds: settings.ring_timeout_seconds,
				sfu_available: sfu_available(),
				turn_configured: turn_configured(),
				guests_enabled: settings.guests_enabled,
				recording_enabled: settings.recording_enabled,
				captions_cloud_allowed: settings.captions_cloud_allowed,
			},
		],
		'Ajustes de llamadas.',
	);
}

/** STUN del parámetro y TURN efímero; el cliente renueva a `ttl_s / 2`. */
export async function ice_servers(ctx: CallCtx): Promise<unknown> {
	const principal = meeting_principal(ctx, str(ctx.url.searchParams.get('meeting_id')));
	if (principal.kind === 'guest' && !guest_admitted(principal.meeting_id, principal.guest_id)) throw guest_not_admitted();
	const settings = await enabled_settings(ctx.store);
	return ok(
		[ice_servers_for({ stun_urls: settings.stun_urls, member_key: principal.member_key, now: Date.now() })],
		'Servidores ICE.',
	);
}

export function not_member(): ChatError {
	return new ChatError(403, 'not_member', 'No participas en esta conversación.');
}

/** El perfil clase es de la reunión; una llamada de chat nunca lo tiene. */
async function class_profile(store: ImperiumStore, call: CallDoc): Promise<boolean> {
	if (!call.meeting_id) return false;
	const meeting = await store.find_id('chat-meetings', call.meeting_id);
	return str(meeting?.profile) === 'clase';
}

/** Lo que esa pata puede publicar con el rol, la palabra y la política vigentes de la sala. */
async function grants_for(store: ImperiumStore, call: CallDoc, member_key: string, leg_id: string, role: RoomRole) {
	const room = room_state(call._id, call.meeting_id);
	const member = room.members.find((item) => item.leg_id === leg_id);
	return sfu_grants({
		role,
		class_profile: await class_profile(store, call),
		has_floor: room.policy.floor === member_key,
		hard_muted: member?.hard_muted ?? false,
		cams_allowed: room.policy.cams_allowed,
		screen_share: room.policy.screen_share,
	});
}

/**
 * Esa pata sigue en la llamada: en una reunión (o si es invitado) cuenta la sala, que ya no la tiene
 * si la expulsaron, la bloquearon o la movieron; en una llamada de chat, la pata unida.
 */
function live_leg(call: CallDoc, member_key: string, leg_id: string): boolean {
	if (call.state === 'ended') return false;
	if (member_key.startsWith('g:') || call.kind === 'meeting') return room_member(call._id, { leg_id })?.member_key === member_key;
	const leg = call.legs.find((item) => `u:${item.user_id}` === member_key);
	return leg?.state === 'joined' && leg.device === leg_id;
}

/** Token de 60 s para la pata viva (`live_leg`) que entra al servidor de medios. */
export async function sfu_token(ctx: CallCtx): Promise<unknown> {
	const call = await load_call(ctx.store, str(ctx.params.id));
	const principal = meeting_principal(ctx, call.meeting_id ?? '');
	await enabled_settings(ctx.store);
	if (call.state === 'ended') throw call_error('call_ended');
	const leg_id = leg_of(ctx.body.leg_id);
	if (!live_leg(call, principal.member_key, leg_id)) throw principal.kind === 'guest' ? guest_not_admitted() : not_member();
	const member = room_member(call._id, { leg_id });
	const role: RoomRole =
		member?.role ?? (principal.kind === 'guest' ? 'guest' : principal.user_id === call.initiator_id ? 'host' : 'participant');
	const token = sign_sfu_token({
		call_id: call._id,
		leg_key: `${principal.member_key}:${leg_id}`,
		name: principal.name,
		role,
		...(await grants_for(ctx.store, call, principal.member_key, leg_id, role)),
		now: Date.now(),
	});
	if (!token) throw new ChatError(503, 'sfu_unavailable', 'El servidor de medios no está disponible.');
	return ok([token], 'Token del servidor de medios.');
}

/**
 * Webhook del servidor de medios (contrato §6.4). El token de refresco que el SFU da a cada
 * conectado no pasa por `sfu_token`: quien entra a una sala sin una pata viva en esa llamada sale
 * por la API de administración. Sin SFU la ruta no existe.
 */
export async function sfu_webhook(ctx: CallCtx): Promise<unknown> {
	const admin = sfu_admin();
	if (!admin) return Response.json({ message: 'not found', error: 'not found' }, { status: 404 });
	const event = sfu_webhook_event({ body: raw_json_body(ctx.req), authorization: ctx.req.headers.get('authorization'), now: Date.now() });
	if (!event) throw new ChatError(401, 'invalid_signature', 'La firma del servidor de medios no es válida.');
	const room = SFU_ROOM.exec(str(as_object(event.room).name));
	const identity = str(as_object(event.participant).identity);
	const leg = SFU_IDENTITY.exec(identity);
	if (event.event !== 'participant_joined' || !room || !leg) return ok([], 'Aviso recibido.');
	const row = await ctx.store.find_id('chat-calls', room[1]!);
	if (!row || !live_leg(call_from_row(row), leg[1]!, leg[2]!)) await admin.remove_participant(sfu_room(room[1]!), identity);
	return ok([], 'Aviso recibido.');
}

export type SfuCommand =
	/** Silencia lo que ya publica; que no vuelva a publicarlo lo decide `grants`. */
	| { type: 'mute'; member_key: string; sources: SfuSource[] }
	/** Sin `leg_id`, todas las patas de esa persona en la sala. */
	| { type: 'remove'; member_key: string; leg_id?: string }
	/** Vuelve a calcular qué publica tras un cambio de rol, de palabra o de política. */
	| { type: 'grants'; member_key: string };

/**
 * Moderación impuesta por la API de administración del servidor de medios. Solo en `sfu`: en
 * malla y estrella es cooperativa (contrato §6.4) y esto no hace nada.
 */
export async function impose_on_sfu(store: ImperiumStore, call: CallDoc, command: SfuCommand): Promise<void> {
	const admin = call.topology === 'sfu' ? sfu_admin() : null;
	if (!admin) return;
	const room = sfu_room(call._id);
	const members = room_state(call._id, call.meeting_id).members.filter((item) => item.member_key === command.member_key);
	if (command.type === 'remove') {
		const legs = command.leg_id ? [command.leg_id] : members.map((item) => item.leg_id);
		for (const leg_id of legs) await admin.remove_participant(room, `${command.member_key}:${leg_id}`);
		return;
	}
	for (const member of members) {
		const identity = `${member.member_key}:${member.leg_id}`;
		if (command.type === 'grants') {
			const grants = await grants_for(store, call, member.member_key, member.leg_id, member.role);
			await admin.update_participant(room, identity, grants, { role: member.role });
			continue;
		}
		for (const track of (await admin.tracks(room, identity)) ?? []) {
			if (track.source && command.sources.includes(track.source)) await admin.mute_track(room, identity, track.sid);
		}
	}
}

/** Empieza (`recording_id`) o termina (`null`) la grabación; con SFU, grabar migra la llamada a él. */
export async function record_call(
	store: ImperiumStore,
	call_id: string,
	input: { user_id: string; is_host: boolean; recording_id: string | null },
): Promise<CallDoc> {
	const settings = await chat_settings(store);
	const now = Date.now();
	return apply_event(
		store,
		call_id,
		{
			type: 'recording',
			user_id: input.user_id,
			is_host: input.is_host,
			recording: input.recording_id
				? { by: input.user_id, started_at: new Date(now).toISOString(), recording_id: input.recording_id }
				: null,
			limits: limits(settings),
		},
		now,
	);
}

/** Desde cuándo la sala de cada reunión viva está vacía, para la gracia del barrido. */
const idle_since = new Map<string, number>();

function meeting_idle(call: CallDoc, now: number): boolean {
	if (!meeting_room_idle(call._id, now, LOBBY_WAIT_MS)) {
		idle_since.delete(call._id);
		return false;
	}
	const since = idle_since.get(call._id) ?? now;
	idle_since.set(call._id, since);
	return now - since >= GRACE_S * 1000;
}

/**
 * `call_id:user_id` → si su pata está adjunta a la sala y, si no, desde cuándo. Lo escribe la
 * señalización y lo lee el barrido; tras un reinicio está vacío y la gracia corre desde la primera
 * pasada.
 */
const leg_presence = new Map<string, { leg_id: string; attached: boolean; since: number }>();

export function mark_leg_attached(call_id: string, user_id: string, leg_id: string): void {
	leg_presence.set(`${call_id}:${user_id}`, { leg_id, attached: true, since: Date.now() });
	disarm(grace_timers, `${call_id}:${user_id}`);
}

export function mark_leg_detached(call_id: string, user_id: string, leg_id: string, now = Date.now()): void {
	const key = `${call_id}:${user_id}`;
	if (leg_presence.get(key)?.leg_id !== leg_id) return;
	leg_presence.set(key, { leg_id, attached: false, since: now });
}

/** El socket de una pata unida se cayó: arranca la gracia de red. */
export async function note_network_lost(store: ImperiumStore, call_id: string, user_id: string, leg_id: string): Promise<void> {
	await apply_event(store, call_id, { type: 'network_lost', user_id, leg_id, grace_s: GRACE_S });
}

function leg_stale(call: CallDoc, leg: CallLeg, now: number): boolean {
	const key = `${call._id}:${leg.user_id}`;
	const seen = leg_presence.get(key);
	if (!seen || seen.leg_id !== leg.device) {
		leg_presence.set(key, { leg_id: leg.device ?? '', attached: false, since: now });
		return false;
	}
	return !seen.attached && now - seen.since >= GRACE_S * 1000;
}

/**
 * Una pasada del barrido: timbres vencidos, patas unidas sin adjuntarse a su sala desde hace más
 * de la gracia y llamadas sin nadie unido. Tras un reinicio no hay temporizadores ni salas: esto
 * las cierra.
 */
export async function sweep_calls(store: ImperiumStore, now = Date.now()): Promise<void> {
	const settings = await chat_settings(store);
	const seen = new Set<string>();
	const meetings = new Set<string>();
	for (let after_id = ''; ; ) {
		const batch = await store.live_calls({ after_id, limit: LIVE_BATCH });
		for (const row of batch) {
			const call = call_from_row(row);
			const joined = call.legs.filter((leg) => leg.state === 'joined');
			for (const leg of joined) seen.add(`${call._id}:${leg.user_id}`);
			const stale = joined.filter((leg) => leg_stale(call, leg, now)).map((leg) => leg.user_id);
			if (call.kind === 'meeting') meetings.add(call._id);
			await apply_event(
				store,
				call._id,
				{
					type: 'sweep',
					ring_timeout_s: settings.ring_timeout_seconds,
					stale_user_ids: stale,
					...(call.kind === 'meeting' ? { idle: meeting_idle(call, now) } : {}),
				},
				now,
			).catch(report);
		}
		if (batch.length < LIVE_BATCH) break;
		after_id = str(batch.at(-1)!._id);
	}
	for (const key of leg_presence.keys()) if (!seen.has(key)) leg_presence.delete(key);
	for (const key of idle_since.keys()) if (!meetings.has(key)) idle_since.delete(key);
}

let sweeper: ReturnType<typeof setInterval> | null = null;

export function start_call_sweeper(store: ImperiumStore): void {
	if (sweeper) return;
	let running = false;
	const pass = async () => {
		if (running) return;
		running = true;
		try {
			await sweep_calls(store);
		} catch (err) {
			// Antes de que el arranque cree las tablas del chat no hay nada que barrer.
			if (!is_missing_relation(err)) report(err);
		} finally {
			running = false;
		}
	};
	sweeper = setInterval(() => void pass(), SWEEP_MS);
	sweeper.unref?.();
	setTimeout(() => void pass(), FIRST_SWEEP_MS).unref?.();
}
