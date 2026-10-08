/**
 * Reuniones y salas persistentes (contrato §4.4). Cada reunión tiene su conversación `meeting`;
 * el documento se escribe con compare-and-swap sobre `v` y su invitación `.ics` lleva un UID
 * estable con `SEQUENCE` que sube en cada cambio.
 */
import { build_access, request_is_https } from './auth.ts';
import { take_meeting_code_ip, take_meeting_guest_ip } from './auth-rate-limit.ts';
import {
	admitted_guest,
	admitted_person,
	attendance_count,
	attendance_exit,
	attendance_outcome,
	attendance_recording_notice,
	attendance_waited,
	flush_attendance,
	flush_transcript,
	on_meeting_call_closed,
	open_meeting_room,
	room_exists,
	room_state,
	run_room_command,
	type BreakoutRoom,
	type CommandKind,
	type HostCommand,
	type RoomErrorCode,
	type RoomPerson,
	type RoomResult,
	type RoomState,
} from './call-room.ts';
import type { CallDoc, CallMedia, RoomRole } from './call-state.ts';
import {
	call_from_row,
	end_call_for_all,
	grow_meeting_call,
	guest_claims,
	guest_not_admitted,
	guest_token_invalid,
	impose_on_sfu,
	leg_of,
	media_of,
	meeting_principal,
	not_member,
	open_meeting_call,
	record_call,
	view_of,
	type CallPrincipal,
	type SfuCommand,
} from './calls-flow.ts';
import { assert_chat_member, ChatError, find_chat_conversation, type GuestReader } from './chat-access.ts';
import {
	guest_message_page,
	join_meeting_conversation,
	leave_meeting_conversation,
	open_meeting_conversation,
	post_guest_message,
	post_meeting_notice,
	post_recording_message,
	remove_unused_files,
	upload_info,
	sync_meeting_conversation,
	type ChatCtx,
	type ChatGuest,
} from './chat-flow.ts';
import { chat_settings } from './chat-settings.ts';
import {
	actor_id,
	calls_enabled_settings,
	CHAT_ID,
	decode_cursor,
	defined,
	encode_cursor,
	invalid,
	new_id,
	quoted_csv_cell,
	str,
} from './chat-shared.ts';
import { print_console_log } from './debug-request-log.ts';
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { outside_history_context } from './history.ts';
import { build_ics, next_occurrence, WEEKDAYS, type Recurrence } from './ics.ts';
import type { SfuSource } from './media-credentials.ts';
import { insert_notification } from './notifications.ts';
import { rate_limited_response, take_token } from './rate-bucket.ts';
import { sign_realtime_token, SOCKET_TICKET_TTL_S } from './realtime-tokens.ts';
import { emit_to_guest, emit_to_room, emit_to_users, leave_room_server } from './socket-stub.ts';
import { is_unique_violation, type ImperiumStore, type MeetingScope } from './store.ts';
import {
	append_recording_part,
	discard_recording_part,
	discard_stale_recording_parts,
	finish_recording_part,
	FILE_READINESS_USABLE,
	is_upload,
	start_recording_part,
} from './uploads.ts';

export type MeetingCtx = ChatCtx;

export type MeetingSettings = {
	guests_allowed: boolean;
	lobby: 'all' | 'guests' | 'none';
	wait_for_host: boolean;
	mute_on_entry: boolean;
	cams_off_on_entry: boolean;
	allow_unmute: boolean;
	screen_share: 'hosts' | 'all';
	whiteboard: 'hosts' | 'all';
	private_chat: boolean;
	qa_moderated: boolean;
	recording_allowed: boolean;
	captions: boolean;
	save_transcript: boolean;
};

export type MeetingProfile = 'reunion' | 'clase';

export type MeetingDoc = {
	_id: string;
	state: 'scheduled' | 'live' | 'cancelled';
	v: number;
	title: string;
	description: string;
	code: string;
	host_id: string;
	cohost_ids: string[];
	invitee_ids: string[];
	member_ids: string[];
	profile: MeetingProfile;
	persistent: boolean;
	start_at?: string;
	duration_min?: number;
	timezone: string;
	recurrence?: Recurrence;
	next_start_at?: string;
	reminded_for?: string;
	settings: MeetingSettings;
	conversation_id: string;
	ics_uid: string;
	ics_sequence: number;
	active_call_id?: string;
	created_at: string;
	/** `u:<id>` o `g:<id>` de quien se expulsó con bloqueo; no viaja en la vista. */
	blocked_keys: string[];
};

type MeetingInput = {
	title?: string;
	description?: string;
	profile?: MeetingProfile;
	persistent?: boolean;
	start_at?: string;
	duration_min?: number;
	timezone?: string;
	/** `null` quita la recurrencia. */
	recurrence?: Recurrence | null;
	invitee_ids?: string[];
	cohost_ids?: string[];
	settings?: Partial<MeetingSettings>;
};

// Sin 0/o, 1/i/l: el código se dicta y se copia a mano.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_ATTEMPTS = 5;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const DURATION = { fallback: 60, min: 5, max: 24 * 60 };
const RECURRENCE_LIMITS = { interval: 99, count: 365 };
const CAS_RETRIES = 3;
const CREATE_RATE = { capacity: 20, refill_per_s: 20 / 3600 };
const PAGE_LIMIT = { fallback: 20, max: 50 };
const UPCOMING_GRACE_MS = 30 * 60_000;
const REMINDER_LEAD_MS = 10 * 60_000;
const JOB_BATCH = 100;
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Mexico_City';

const SETTINGS_KEYS: Record<keyof MeetingSettings, 'boolean' | readonly string[]> = {
	guests_allowed: 'boolean',
	lobby: ['all', 'guests', 'none'],
	wait_for_host: 'boolean',
	mute_on_entry: 'boolean',
	cams_off_on_entry: 'boolean',
	allow_unmute: 'boolean',
	screen_share: ['hosts', 'all'],
	whiteboard: ['hosts', 'all'],
	private_chat: 'boolean',
	qa_moderated: 'boolean',
	recording_allowed: 'boolean',
	captions: 'boolean',
	save_transcript: 'boolean',
};

/** En clase quien organiza presenta y modera; nunca hay chat privado entre alumnos (contrato §9). */
const PROFILE_SETTINGS: Record<MeetingProfile, MeetingSettings> = {
	reunion: {
		guests_allowed: false,
		lobby: 'guests',
		wait_for_host: false,
		mute_on_entry: false,
		cams_off_on_entry: false,
		allow_unmute: true,
		screen_share: 'all',
		whiteboard: 'all',
		private_chat: true,
		qa_moderated: false,
		recording_allowed: true,
		captions: true,
		save_transcript: false,
	},
	clase: {
		guests_allowed: false,
		lobby: 'all',
		wait_for_host: true,
		mute_on_entry: true,
		cams_off_on_entry: false,
		allow_unmute: true,
		screen_share: 'hosts',
		whiteboard: 'hosts',
		private_chat: false,
		qa_moderated: true,
		recording_allowed: true,
		captions: true,
		save_transcript: false,
	},
};

function report(err: unknown): void {
	print_console_log('error', `Reuniones: ${err instanceof Error ? err.message : String(err)}`);
}

export function meeting_not_found(): ChatError {
	return new ChatError(404, 'meeting_not_found', 'No encontramos esa reunión. Revisa el código.');
}

function not_host(): ChatError {
	return new ChatError(403, 'not_host', 'Solo el anfitrión puede hacer esto.');
}

/** `xxx-xxxx-xxx` sin sesgo: se descartan los bytes que no caben enteros en el alfabeto. */
export function new_meeting_code(): string {
	const limit = 256 - (256 % CODE_ALPHABET.length);
	const chars: string[] = [];
	while (chars.length < 10) {
		for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
			if (byte < limit && chars.length < 10) chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!);
		}
	}
	return `${chars.slice(0, 3).join('')}-${chars.slice(3, 7).join('')}-${chars.slice(7).join('')}`;
}

export const MEETING_CODE = new RegExp(`^[${CODE_ALPHABET}]{3}-[${CODE_ALPHABET}]{4}-[${CODE_ALPHABET}]{3}$`);

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function settings_from(raw: unknown, profile: MeetingProfile): MeetingSettings {
	const stored = as_object(raw);
	const out = { ...PROFILE_SETTINGS[profile] } as Record<string, unknown>;
	for (const key of Object.keys(SETTINGS_KEYS)) if (stored[camel(key)] !== undefined) out[key] = stored[camel(key)];
	return out as MeetingSettings;
}

function settings_payload(settings: MeetingSettings): ImperiumDoc {
	return Object.fromEntries(Object.entries(settings).map(([key, value]) => [camel(key), value]));
}

function recurrence_from(raw: unknown): Recurrence | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const rule = as_object(raw);
	return defined({
		freq: str(rule.freq) as Recurrence['freq'],
		interval: rule.interval == null ? undefined : Number(rule.interval),
		by_day: rule.byDay == null ? undefined : as_array(rule.byDay).map(String),
		count: rule.count == null ? undefined : Number(rule.count),
		until: str(rule.until) || undefined,
	});
}

/** El payload se guarda en camelCase (contrato §0.1); el flujo trabaja con `MeetingDoc`. */
export function meeting_from_row(row: ImperiumDoc): MeetingDoc {
	const profile: MeetingProfile = row.profile === 'clase' ? 'clase' : 'reunion';
	return defined({
		_id: str(row._id),
		state: (str(row.state) || 'scheduled') as MeetingDoc['state'],
		v: Number(row.v) || 0,
		title: str(row.name),
		description: str(row.description),
		code: str(row.code),
		host_id: str(row.host_id),
		cohost_ids: as_array(row.cohostIds).map(String),
		invitee_ids: as_array(row.inviteeIds).map(String),
		member_ids: as_array(row.memberIds).map(String),
		profile,
		persistent: row.persistent === true,
		start_at: str(row.startAt) || undefined,
		duration_min: row.durationMin == null ? undefined : Number(row.durationMin),
		timezone: str(row.timezone) || APP_TIMEZONE,
		recurrence: recurrence_from(row.recurrence),
		next_start_at: str(row.next_start_at) || undefined,
		reminded_for: str(row.remindedFor) || undefined,
		settings: settings_from(row.settings, profile),
		conversation_id: str(row.conversationId),
		ics_uid: str(row.icsUid),
		ics_sequence: Number(row.icsSequence) || 0,
		active_call_id: str(row.activeCallId) || undefined,
		created_at: str(row.created_at),
		blocked_keys: as_array(row.blockedKeys).map(String),
	});
}

/**
 * `remindedFor` no viaja: lo reclama el barrido y una edición solo lo borra al mover el inicio.
 * `blockedKeys` tampoco: crece con su propia sentencia y nunca se reescribe.
 */
function meeting_write(doc: MeetingDoc) {
	return {
		state: doc.state,
		columns: {
			name: doc.title,
			description: doc.description,
			code: doc.code,
			host_id: doc.host_id,
			next_start_at: doc.next_start_at ?? null,
		},
		payload: {
			cohostIds: doc.cohost_ids,
			inviteeIds: doc.invitee_ids,
			memberIds: doc.member_ids,
			profile: doc.profile,
			persistent: doc.persistent,
			startAt: doc.start_at ?? null,
			durationMin: doc.duration_min ?? null,
			timezone: doc.timezone,
			recurrence: doc.recurrence
				? defined({
						freq: doc.recurrence.freq,
						interval: doc.recurrence.interval,
						byDay: doc.recurrence.by_day,
						count: doc.recurrence.count,
						until: doc.recurrence.until,
					})
				: null,
			settings: settings_payload(doc.settings),
			conversationId: doc.conversation_id,
			icsUid: doc.ics_uid,
			icsSequence: doc.ics_sequence,
			activeCallId: doc.active_call_id ?? null,
		} as ImperiumDoc,
	};
}

export type MeetingRole = 'host' | 'cohost' | 'participant';

function meeting_role(doc: MeetingDoc, user_id: string): MeetingRole {
	if (doc.host_id === user_id) return 'host';
	return doc.cohost_ids.includes(user_id) ? 'cohost' : 'participant';
}

type UserBrief = { _id: string; name: string; email?: string; img?: string };

/** `MeetingView` (contrato §3.6) para quien la mira. */
function meeting_view(doc: MeetingDoc, viewer_id: string, host: UserBrief | undefined): ImperiumDoc {
	const { created_at: _created, blocked_keys: _blocked, ...rest } = doc;
	return {
		...rest,
		host: host ?? { _id: doc.host_id, name: '' },
		my_role: meeting_role(doc, viewer_id),
		join_url: `/reunion/${doc.code}`,
	};
}

async function host_brief(store: ImperiumStore, host_id: string): Promise<UserBrief | undefined> {
	const [user] = await store.chat_users_brief([host_id]);
	return user ? defined({ _id: user._id, name: user.name, email: user.email, img: user.img }) : undefined;
}

/**
 * `meeting_update` (contrato §5.4) a cada miembro con su propio `my_role`. En `meeting:<id>` solo
 * hay sesiones de invitados: les llega el cambio sin la vista, que trae invitados y correos.
 */
export async function publish_meeting(
	store: ImperiumStore,
	doc: MeetingDoc,
	change: 'created' | 'updated' | 'cancelled' | 'live' | 'ended' | 'reminder',
	also: string[] = [],
): Promise<void> {
	const host = await host_brief(store, doc.host_id);
	for (const user_id of new Set([...doc.member_ids, ...also])) {
		emit_to_users([user_id], 'update', {
			action: 'meeting_update',
			data: [{ meeting_id: doc._id, change, meeting: meeting_view(doc, user_id, host) }],
		});
	}
	emit_to_room(`meeting:${doc._id}`, 'update', { action: 'meeting_update', data: [{ meeting_id: doc._id, change }] });
}

async function load_meeting(store: ImperiumStore, id: string): Promise<MeetingDoc> {
	const row = CHAT_ID.test(id) ? await store.find_id('chat-meetings', id) : null;
	if (!row || row.is_active === false) throw meeting_not_found();
	return meeting_from_row(row);
}

async function meeting_by_code(store: ImperiumStore, code: string): Promise<MeetingDoc> {
	const normalized = str(code).toLowerCase();
	if (!MEETING_CODE.test(normalized)) throw meeting_not_found();
	const { rows } = await store.find_many('chat-meetings', {
		where: { code: normalized },
		take: 1,
		populate: false,
		skip_total: true,
	});
	if (!rows[0] || rows[0].is_active === false) throw meeting_not_found();
	return meeting_from_row(rows[0]);
}

/**
 * Lee, cambia y escribe con CAS; si alguien escribió entre medias (otra edición, el barrido),
 * vuelve a leer y a aplicar el cambio, hasta 3 reintentos.
 */
async function update_meeting_doc(
	store: ImperiumStore,
	id: string,
	change: (doc: MeetingDoc) => MeetingDoc | null,
	extra: ImperiumDoc = {},
): Promise<{ before: MeetingDoc; after: MeetingDoc }> {
	for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
		const before = await load_meeting(store, id);
		const after = change(before);
		if (!after) return { before, after: before };
		const write = meeting_write(after);
		const row = await store.update_versioned(
			'chat-meetings',
			id,
			before.v,
			{ ...write, payload: { ...write.payload, ...extra } },
			new Date().toISOString(),
		);
		if (row) return { before, after: meeting_from_row(row) };
	}
	throw new ChatError(429, 'rate_limited', 'Demasiadas solicitudes; intenta de nuevo en 1 s.', { retry_after_s: 1 });
}

function bool_field(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw invalid(`«${field}» debe ser sí o no.`);
	return value;
}

function id_list(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && CHAT_ID.test(id))) {
		throw invalid(`«${field}» debe ser una lista de personas.`);
	}
	return [...new Set(value as string[])];
}

function iso_field(value: unknown, field: string): string {
	const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(ms)) throw invalid(`«${field}» debe ser una fecha válida.`);
	return new Date(ms).toISOString();
}

function recurrence_field(value: unknown): Recurrence | null {
	if (value === null) return null;
	const rule = as_object(value);
	if (!['daily', 'weekly', 'monthly'].includes(str(rule.freq))) throw invalid('Elige repetir cada día, semana o mes.');
	const whole = (raw: unknown, max: number, field: string) => {
		if (raw == null) return undefined;
		if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > max) throw invalid(`«${field}» va de 1 a ${max}.`);
		return raw as number;
	};
	const by_day = rule.by_day == null ? undefined : rule.by_day;
	if (by_day !== undefined) {
		if (
			rule.freq !== 'weekly' ||
			!Array.isArray(by_day) ||
			!by_day.length ||
			!by_day.every((day) => WEEKDAYS.includes(day as (typeof WEEKDAYS)[number]))
		) {
			throw invalid('Los días solo aplican a la repetición semanal (MO, TU, WE, TH, FR, SA, SU).');
		}
	}
	if (rule.count != null && rule.until != null) throw invalid('Termina por número de veces o por fecha, no por las dos.');
	return defined({
		freq: rule.freq as Recurrence['freq'],
		interval: whole(rule.interval, RECURRENCE_LIMITS.interval, 'interval'),
		by_day: by_day ? [...new Set(by_day as string[])] : undefined,
		count: whole(rule.count, RECURRENCE_LIMITS.count, 'count'),
		until: rule.until == null ? undefined : iso_field(rule.until, 'until'),
	});
}

function settings_field(value: unknown): Partial<MeetingSettings> {
	const input = as_object(value);
	const out: Record<string, unknown> = {};
	for (const [key, kind] of Object.entries(SETTINGS_KEYS)) {
		const raw = input[key];
		if (raw === undefined) continue;
		if (kind === 'boolean' ? typeof raw !== 'boolean' : !kind.includes(raw as string)) throw invalid(`El ajuste «${key}» no es válido.`);
		out[key] = raw;
	}
	return out as Partial<MeetingSettings>;
}

/** `MeetingInput` (contrato §3.6), solo con lo que vino. */
function parse_input(body: Record<string, unknown>): MeetingInput {
	const input: MeetingInput = {};
	if (body.title !== undefined) {
		const title = str(body.title);
		if (!title || title.length > TITLE_MAX) throw invalid(`Ponle un título de hasta ${TITLE_MAX} caracteres.`);
		input.title = title;
	}
	if (body.description !== undefined) {
		const description = str(body.description);
		if (description.length > DESCRIPTION_MAX) throw invalid(`La descripción admite hasta ${DESCRIPTION_MAX} caracteres.`);
		input.description = description;
	}
	if (body.profile !== undefined) {
		if (body.profile !== 'reunion' && body.profile !== 'clase') throw invalid('El perfil es reunión o clase.');
		input.profile = body.profile;
	}
	if (body.persistent !== undefined) input.persistent = bool_field(body.persistent, 'persistent');
	if (body.start_at !== undefined && body.start_at !== null) input.start_at = iso_field(body.start_at, 'start_at');
	if (body.duration_min !== undefined) {
		const minutes = body.duration_min;
		if (!Number.isInteger(minutes) || (minutes as number) < DURATION.min || (minutes as number) > DURATION.max) {
			throw invalid(`La duración va de ${DURATION.min} a ${DURATION.max} minutos.`);
		}
		input.duration_min = minutes as number;
	}
	if (body.timezone !== undefined) {
		const timezone = str(body.timezone);
		try {
			new Intl.DateTimeFormat('es-MX', { timeZone: timezone });
		} catch {
			throw invalid('La zona horaria no es válida.');
		}
		input.timezone = timezone;
	}
	if (body.recurrence !== undefined) input.recurrence = recurrence_field(body.recurrence);
	if (body.invitee_ids !== undefined) input.invitee_ids = id_list(body.invitee_ids, 'invitee_ids');
	if (body.cohost_ids !== undefined) input.cohost_ids = id_list(body.cohost_ids, 'cohost_ids');
	if (body.settings !== undefined) input.settings = settings_field(body.settings);
	return input;
}

/**
 * El inicio vigente: la ocurrencia que aún no termina. Una serie terminada o una reunión pasada
 * conservan el último inicio para ordenarse en «Pasadas».
 */
function next_start_of(doc: MeetingDoc, now: number): string | undefined {
	if (doc.persistent || !doc.start_at) return undefined;
	const after = now - (doc.duration_min ?? DURATION.fallback) * 60_000;
	return next_occurrence(doc.start_at, doc.recurrence, after, doc.timezone) ?? doc.next_start_at ?? doc.start_at;
}

/** La reunión con lo pedido encima: valida la combinación y recalcula miembros e inicio. */
function apply_input(doc: MeetingDoc, input: MeetingInput, now: number): MeetingDoc {
	const profile = input.profile ?? doc.profile;
	const next: MeetingDoc = {
		...doc,
		title: input.title ?? doc.title,
		description: input.description ?? doc.description,
		profile,
		persistent: input.persistent ?? doc.persistent,
		start_at: input.start_at ?? doc.start_at,
		duration_min: input.duration_min ?? doc.duration_min,
		timezone: input.timezone ?? doc.timezone,
		recurrence: input.recurrence === null ? undefined : (input.recurrence ?? doc.recurrence),
		invitee_ids: (input.invitee_ids ?? doc.invitee_ids).filter((id) => id !== doc.host_id),
		cohost_ids: (input.cohost_ids ?? doc.cohost_ids).filter((id) => id !== doc.host_id),
		settings: { ...(input.profile && input.profile !== doc.profile ? PROFILE_SETTINGS[profile] : doc.settings), ...input.settings },
	};
	if (profile === 'clase') next.settings.private_chat = false;
	if (next.persistent) {
		if (next.recurrence) throw invalid('Una sala permanente no se repite: siempre está abierta.');
	} else if (!next.start_at) {
		// Sin fecha ni sala permanente es una reunión inmediata: empieza ahora.
		next.start_at = new Date(now).toISOString();
	}
	if (next.recurrence?.until && next.start_at && next.recurrence.until <= next.start_at) {
		throw invalid('La repetición tiene que terminar después del inicio.');
	}
	if (!next.persistent) next.duration_min ??= DURATION.fallback;
	next.member_ids = [...new Set([next.host_id, ...next.cohost_ids, ...next.invitee_ids])];
	next.next_start_at = next_start_of(next, now);
	return next;
}

async function assert_people(store: ImperiumStore, ids: string[]): Promise<void> {
	const users = await store.chat_users_brief(ids);
	if (users.length !== ids.length) throw new ChatError(404, 'user_not_found', 'No encontramos a esa persona.');
	if (users.some((user) => !user.is_active)) throw new ChatError(403, 'user_inactive', 'Esa persona ya no está activa.');
}

function public_host(req: Request): string {
	return req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || new URL(req.url).host;
}

function origin_of(req: Request): string {
	return `${request_is_https(req) ? 'https' : 'http'}://${public_host(req)}`;
}

function when_text(doc: MeetingDoc): string {
	if (!doc.next_start_at) return '';
	return new Date(doc.next_start_at).toLocaleString('es-MX', {
		dateStyle: 'long',
		timeStyle: 'short',
		hourCycle: 'h23',
		timeZone: doc.timezone,
	});
}

async function notify_invited(ctx: MeetingCtx, doc: MeetingDoc, user_ids: string[]): Promise<void> {
	const host = str(ctx.actor?.name ?? ctx.actor?.email) || 'Alguien';
	const when = when_text(doc);
	for (const user_id of user_ids) {
		await insert_notification(ctx.store, {
			recipientId: user_id,
			type: 'meeting-invite',
			title: doc.persistent ? 'Te agregaron a una sala' : 'Te invitaron a una reunión',
			message: `${host} te invitó a «${doc.title}»${when ? ` el ${when}` : ''}.`,
			isRead: false,
			source: { kind: 'meeting', action: 'invite', meetingId: doc._id, route: '/internal/reuniones' },
			payload: { meeting_id: doc._id, code: doc.code },
		});
	}
}

/** Un código que choca con otro (único en Postgres) se vuelve a sortear. */
async function insert_with_code(store: ImperiumStore, draft: MeetingDoc, uid: string): Promise<ImperiumDoc> {
	for (let attempt = 1; ; attempt++) {
		const write = meeting_write({ ...draft, code: new_meeting_code() });
		try {
			return await store.insert('chat-meetings', {
				_id: draft._id,
				state: write.state,
				created_by: uid,
				...write.columns,
				...write.payload,
				v: 0,
			});
		} catch (err) {
			if (!is_unique_violation(err) || attempt >= CODE_ATTEMPTS) throw err;
		}
	}
}

export async function create_meeting(ctx: MeetingCtx): Promise<unknown> {
	await calls_enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const input = parse_input(ctx.body);
	if (!input.title) throw invalid(`Ponle un título de hasta ${TITLE_MAX} caracteres.`);
	if (input.recurrence === null) delete input.recurrence;
	const now = Date.now();
	const id = new_id();
	const profile = input.profile ?? 'reunion';
	const draft = apply_input(
		{
			_id: id,
			state: 'scheduled',
			v: 0,
			title: '',
			description: '',
			code: '',
			host_id: uid,
			cohost_ids: [],
			invitee_ids: [],
			member_ids: [],
			profile,
			persistent: false,
			timezone: APP_TIMEZONE,
			settings: { ...PROFILE_SETTINGS[profile] },
			conversation_id: '',
			ics_uid: `${id}@${public_host(ctx.req).toLowerCase().replace(/:\d+$/, '').replace(/[^a-z0-9.-]/g, '') || 'imperium'}`,
			ics_sequence: 0,
			created_at: new Date(now).toISOString(),
			blocked_keys: [],
		},
		input,
		now,
	);
	await assert_people(ctx.store, draft.member_ids.filter((member) => member !== uid));
	const allowed = take_token(`meeting-create:${uid}`, CREATE_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const conversation = await open_meeting_conversation(ctx, {
		meeting_id: id,
		title: draft.title,
		description: draft.description,
		people: { cohost_ids: draft.cohost_ids, invitee_ids: draft.invitee_ids },
		now: draft.created_at,
	});
	draft.conversation_id = str(conversation._id);
	const doc = meeting_from_row(await insert_with_code(ctx.store, draft, uid));
	await post_meeting_notice(ctx, doc.conversation_id, 'meeting_scheduled', defined({
		meetingId: doc._id,
		title: doc.title,
		startAt: doc.next_start_at,
		persistent: doc.persistent || undefined,
	})).catch(report);
	await notify_invited(ctx, doc, doc.member_ids.filter((member) => member !== uid)).catch(report);
	await publish_meeting(ctx.store, doc, 'created');
	return ok([meeting_view(doc, uid, await host_brief(ctx.store, doc.host_id))], 'Reunión creada.');
}

/** Solo sus miembros la leen o la descargan. */
async function member_meeting(ctx: MeetingCtx): Promise<MeetingDoc> {
	await calls_enabled_settings(ctx.store);
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	if (!doc.member_ids.includes(actor_id(ctx))) throw not_member();
	return doc;
}

export async function read_meeting(ctx: MeetingCtx): Promise<unknown> {
	const doc = await member_meeting(ctx);
	return ok([meeting_view(doc, actor_id(ctx), await host_brief(ctx.store, doc.host_id))], 'Reunión.');
}

/** Anfitrión o coanfitrión; nombrar coanfitriones es solo del anfitrión (contrato §9). */
export async function update_meeting(ctx: MeetingCtx): Promise<unknown> {
	await calls_enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const input = parse_input(ctx.body);
	const now = Date.now();
	const current = await load_meeting(ctx.store, str(ctx.params.id));
	const wanted = [...(input.invitee_ids ?? []), ...(input.cohost_ids ?? [])];
	await assert_people(ctx.store, [...new Set(wanted.filter((id) => !current.member_ids.includes(id)))]);
	const moves_start = input.start_at !== undefined || input.recurrence !== undefined || input.duration_min !== undefined;
	const { before, after } = await update_meeting_doc(
		ctx.store,
		current._id,
		(doc) => {
			const role = meeting_role(doc, uid);
			if (role === 'participant') throw doc.member_ids.includes(uid) ? not_host() : not_member();
			const same_cohosts =
				!input.cohost_ids ||
				(input.cohost_ids.length === doc.cohost_ids.length && input.cohost_ids.every((id) => doc.cohost_ids.includes(id)));
			if (role !== 'host' && !same_cohosts) throw not_host();
			if (doc.state === 'cancelled') throw new ChatError(409, 'meeting_cancelled', 'La reunión se canceló.');
			return { ...apply_input(doc, input, now), ics_sequence: doc.ics_sequence + 1 };
		},
		moves_start ? { remindedFor: null } : {},
	);
	const added = after.member_ids.filter((id) => !before.member_ids.includes(id));
	const removed = before.member_ids.filter((id) => !after.member_ids.includes(id));
	await sync_meeting_conversation(ctx, after.conversation_id, {
		title: after.title,
		description: after.description,
		people: { cohost_ids: after.cohost_ids, invitee_ids: after.invitee_ids },
		removed_ids: removed,
	}).catch(report);
	await post_meeting_notice(ctx, after.conversation_id, 'meeting_updated', defined({
		meetingId: after._id,
		title: after.title,
		startAt: after.next_start_at,
	})).catch(report);
	await notify_invited(ctx, after, added).catch(report);
	await publish_meeting(ctx.store, after, 'updated', removed);
	await sync_live_cohosts(ctx.store, before, after);
	return ok([meeting_view(after, uid, await host_brief(ctx.store, after.host_id))], 'Reunión actualizada.');
}

/**
 * Quien la edición nombra o deja de nombrar coanfitrión toma o deja ese rol también en la sala viva
 * y en sus salas pequeñas: si no, un coanfitrión retirado seguiría moderando hasta que la llamada acabe.
 */
async function sync_live_cohosts(store: ImperiumStore, before: MeetingDoc, after: MeetingDoc): Promise<void> {
	const call_id = after.active_call_id;
	if (!call_id || !room_exists(call_id)) return;
	const changes: Array<[string, 'cohost' | 'participant']> = [
		...after.cohost_ids.filter((id) => !before.cohost_ids.includes(id)).map((id): [string, 'cohost'] => [id, 'cohost']),
		...before.cohost_ids.filter((id) => !after.cohost_ids.includes(id)).map((id): [string, 'participant'] => [id, 'participant']),
	];
	const host = { member_key: `u:${after.host_id}`, role: 'host' as const };
	for (const room_id of [call_id, ...(breakout_children.get(call_id) ?? [])]) {
		for (const [id, role] of changes) {
			if (!admitted_person(room_id, `u:${id}`)) continue;
			await run_host_command(store, room_id, host, { type: 'set_role', member_key: `u:${id}`, role }).catch(report);
		}
	}
}

export async function cancel_meeting(ctx: MeetingCtx): Promise<unknown> {
	await calls_enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { before, after } = await update_meeting_doc(ctx.store, str(ctx.params.id), (doc) => {
		if (doc.host_id !== uid) throw doc.member_ids.includes(uid) ? not_host() : not_member();
		if (doc.state === 'cancelled') return null;
		return { ...doc, state: 'cancelled', ics_sequence: doc.ics_sequence + 1 };
	});
	if (before.state !== 'cancelled') {
		await post_meeting_notice(ctx, after.conversation_id, 'meeting_cancelled', { meetingId: after._id, title: after.title }).catch(report);
		for (const user_id of after.member_ids.filter((id) => id !== uid)) {
			await insert_notification(ctx.store, {
				recipientId: user_id,
				type: 'meeting-cancelled',
				title: 'Se canceló una reunión',
				message: `«${after.title}» se canceló.`,
				isRead: false,
				source: { kind: 'meeting', action: 'cancelled', meetingId: after._id, route: '/internal/reuniones' },
				payload: { meeting_id: after._id },
			}).catch(report);
		}
		await publish_meeting(ctx.store, after, 'cancelled');
		if (after.active_call_id) await end_call_for_all(ctx.store, after.active_call_id, uid, true).catch(report);
	}
	return ok([meeting_view(after, uid, await host_brief(ctx.store, after.host_id))], 'Reunión cancelada.');
}

/** `text/calendar` con UID estable: el calendario reemplaza la invitación anterior por `SEQUENCE`. */
export async function meeting_ics(ctx: MeetingCtx): Promise<Response> {
	const doc = await member_meeting(ctx);
	const asked = str(ctx.url.searchParams.get('method')).toLowerCase();
	if (asked && asked !== 'request' && asked !== 'cancel') throw invalid('El método es request o cancel.');
	const method = asked === 'cancel' || (!asked && doc.state === 'cancelled') ? 'CANCEL' : 'REQUEST';
	const people = new Map((await ctx.store.chat_users_brief(doc.member_ids)).map((user) => [user._id, user]));
	const host = people.get(doc.host_id);
	const person = (id: string) => {
		const user = people.get(id);
		return user?.email ? [{ name: user.name || user.email, email: user.email }] : [];
	};
	const body = build_ics({
		method,
		uid: doc.ics_uid,
		sequence: doc.ics_sequence,
		start_at: doc.next_start_at ?? doc.start_at ?? doc.created_at,
		duration_min: doc.duration_min ?? DURATION.fallback,
		timezone: doc.timezone,
		title: doc.title,
		description: doc.description,
		url: `${origin_of(ctx.req)}/reunion/${doc.code}`,
		code: doc.code,
		// Una serie se describe desde su primer inicio, no desde la ocurrencia vigente.
		...(doc.recurrence && doc.start_at ? { recurrence: doc.recurrence, start_at: doc.start_at } : {}),
		organizer: host?.email ? { name: host.name || host.email, email: host.email } : undefined,
		attendees: doc.member_ids.filter((id) => id !== doc.host_id).flatMap(person),
		now: Date.now(),
	});
	return new Response(body, {
		headers: {
			'content-type': `text/calendar; charset=utf-8; method=${method}`,
			'content-disposition': `attachment; filename="reunion-${doc.code}.ics"`,
			'cache-control': 'no-store',
		},
	});
}

const SCOPES = new Set<MeetingScope>(['proximas', 'salas', 'pasadas']);

/** Mis reuniones por pestaña, con keyset; una que empezó hace poco sigue en «Próximas». */
export async function read_my_meetings(ctx: MeetingCtx): Promise<unknown> {
	await calls_enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const scope = (str(ctx.url.searchParams.get('scope')) || 'proximas') as MeetingScope;
	if (!SCOPES.has(scope)) throw invalid('La pestaña es proximas, salas o pasadas.');
	const raw = str(ctx.url.searchParams.get('cursor'));
	const asked = Number(ctx.url.searchParams.get('limit'));
	const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, PAGE_LIMIT.max) : PAGE_LIMIT.fallback;
	const now = Date.now();
	const rows = await ctx.store.meetings_page_for_member({
		user_id: uid,
		scope,
		since: new Date(now - UPCOMING_GRACE_MS).toISOString(),
		cursor: raw ? decode_cursor(raw) : undefined,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	const docs = page.map(meeting_from_row);
	const hosts = new Map(
		(await ctx.store.chat_users_brief([...new Set(docs.map((doc) => doc.host_id))])).map((user) => [
			user._id,
			defined({ _id: user._id, name: user.name, email: user.email, img: user.img }),
		]),
	);
	const last = page.at(-1);
	return {
		...ok(docs.map((doc) => meeting_view(doc, uid, hosts.get(doc.host_id))), 'Reuniones.'),
		next_cursor: rows.length > limit && last ? encode_cursor(str(last.page_key), str(last._id)) : null,
		server_time: new Date(now).toISOString(),
	};
}

/**
 * Recordatorio a 10 minutos del inicio para cada miembro: el reclamo marca `remindedFor` con ese
 * inicio, así que una ocurrencia se avisa una vez aunque haya dos pasadas a la vez.
 */
export async function remind_due_meetings(store: ImperiumStore, now: Date): Promise<number> {
	const claimed = await store.meetings_claim_reminders({
		now: now.toISOString(),
		until: new Date(now.getTime() + REMINDER_LEAD_MS).toISOString(),
		limit: JOB_BATCH,
	});
	for (const row of claimed) {
		const doc = meeting_from_row(row);
		for (const user_id of doc.member_ids) {
			await insert_notification(store, {
				recipientId: user_id,
				type: 'meeting-reminder',
				title: 'Tu reunión empieza pronto',
				message: `«${doc.title}» empieza ${when_text(doc) ? `el ${when_text(doc)}` : 'en unos minutos'}.`,
				isRead: false,
				source: { kind: 'meeting', action: 'reminder', meetingId: doc._id, route: `/reunion/${doc.code}` },
				payload: { meeting_id: doc._id, code: doc.code },
			}).catch(report);
		}
		await publish_meeting(store, doc, 'reminder');
	}
	return claimed.length;
}

/** Las series cuya ocurrencia terminó pasan a la siguiente; la que ya no tiene otra queda cerrada. */
export async function advance_recurring_meetings(store: ImperiumStore, now: Date): Promise<number> {
	const due = await store.meetings_due_to_advance({ now: now.toISOString(), limit: JOB_BATCH });
	for (const row of due) {
		const doc = meeting_from_row(row);
		if (!doc.recurrence || !doc.start_at || !doc.next_start_at) continue;
		const ended_at = doc.next_start_at;
		const next = next_occurrence(doc.start_at, doc.recurrence, Date.parse(ended_at) + 1, doc.timezone);
		try {
			const { after } = await update_meeting_doc(
				store,
				doc._id,
				(current) => (current.next_start_at === ended_at ? { ...current, next_start_at: next ?? ended_at } : null),
				next ? { remindedFor: null } : { recurrenceDone: true },
			);
			if (next && after.next_start_at === next) await publish_meeting(store, after, 'updated');
		} catch (err) {
			report(err);
		}
	}
	return due.length;
}

const GUEST_NAME = { min: 2, max: 60 };
const GUEST_TICKET_RATE = { capacity: 30, refill_per_s: 30 / 60 };
const GUEST_TAIL_S = 3600;
const GUEST_OPEN_ENDED_S = 12 * 3600;
const STAFF = new Set<RoomRole>(['host', 'cohost']);

function assert_not_cancelled(doc: MeetingDoc): void {
	if (doc.state === 'cancelled') throw new ChatError(409, 'meeting_cancelled', 'La reunión se canceló.');
}

function guests_disabled(): ChatError {
	return new ChatError(403, 'guests_disabled', 'Esta reunión no admite invitados sin cuenta.');
}

function expelled(): ChatError {
	return new ChatError(403, 'expelled', 'El anfitrión te retiró de esta reunión.');
}

function feature_disabled(): ChatError {
	return new ChatError(403, 'feature_disabled', 'Tu organización desactivó esta función.');
}

function meeting_locked(): ChatError {
	return new ChatError(403, 'meeting_locked', 'La reunión está bloqueada.');
}

function room_error(code: RoomErrorCode): ChatError {
	if (code === 'not_host') return not_host();
	if (code === 'invalid_request') return invalid();
	if (code === 'board_full') return invalid('La pizarra está llena; límpiala para seguir dibujando.');
	return new ChatError(403, 'forbidden', 'No tienes permiso para hacer esto.');
}

function live_room(doc: MeetingDoc): RoomState | null {
	return doc.active_call_id ? room_state(doc.active_call_id, doc._id) : null;
}

/** Contrato §4.4: lo mínimo para la pantalla previa, sin sesión; con tope por IP. */
export async function public_summary(ctx: MeetingCtx): Promise<unknown> {
	const allowed = take_meeting_code_ip(ctx.req);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const settings = await calls_enabled_settings(ctx.store);
	const doc = await meeting_by_code(ctx.store, str(ctx.params.code));
	const host = await host_brief(ctx.store, doc.host_id);
	return ok(
		[
			defined({
				title: doc.title,
				host_name: host?.name ?? '',
				start_at: doc.next_start_at ?? doc.start_at,
				guests_allowed: settings.guests_enabled && doc.settings.guests_allowed,
				recording_active: Boolean(live_room(doc)?.policy.recording),
				profile: doc.profile,
				state: doc.state,
			}),
		],
		'Reunión.',
	);
}

/** El nombre visible del invitado: sin controles ni espacios de más. */
function display_name(value: unknown): string {
	const name = (typeof value === 'string' ? value : '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
	if (name.length < GUEST_NAME.min || name.length > GUEST_NAME.max) {
		throw invalid(`Escribe un nombre de ${GUEST_NAME.min} a ${GUEST_NAME.max} caracteres.`);
	}
	return name;
}

/**
 * Hasta el fin programado más una hora, pero nunca más que la duración de la reunión desde que se
 * emite: una reunión agendada para dentro de meses no da una cookie de meses. Sin fin (sala o
 * inmediata), 12 h más una hora (contrato §2).
 */
function guest_expiry_s(doc: MeetingDoc, now: number): number {
	const start = Date.parse(doc.next_start_at ?? '');
	const scheduled = Number.isFinite(start) && !doc.persistent;
	const span = scheduled ? (doc.duration_min ?? DURATION.fallback) * 60_000 : GUEST_OPEN_ENDED_S * 1000;
	const end = scheduled ? Math.min(Math.max(start + span, now), now + span) : now + span;
	return Math.floor(end / 1000) + GUEST_TAIL_S;
}

function socket_ticket(guest_id: string, meeting_id: string, name: string, now: number): string {
	return sign_realtime_token({
		t: 'socket',
		gid: guest_id,
		mid: meeting_id,
		name,
		n: crypto.randomUUID(),
		exp: Math.floor(now / 1000) + SOCKET_TICKET_TTL_S,
	});
}

/**
 * Contrato §6.5: el alta del invitado crea su principal, la cookie `imperium_invitado`, y el
 * primer ticket del socket. Quien vuelve con su cookie conserva su id: un bloqueo lo alcanza.
 */
export async function guest_join(ctx: MeetingCtx): Promise<unknown> {
	const allowed = take_meeting_guest_ip(ctx.req);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const settings = await calls_enabled_settings(ctx.store);
	const doc = await meeting_by_code(ctx.store, str(ctx.params.code));
	assert_not_cancelled(doc);
	if (!settings.guests_enabled || !doc.settings.guests_allowed) throw guests_disabled();
	const name = display_name(ctx.body.display_name);
	const previous = guest_claims(ctx.req);
	const guest_id = previous?.mid === doc._id ? previous.gid : new_id();
	const room = live_room(doc);
	if (doc.blocked_keys.includes(`g:${guest_id}`) || room?.blocked.includes(`g:${guest_id}`)) throw expelled();
	if (room?.policy.locked) throw meeting_locked();
	const now = Date.now();
	const exp = guest_expiry_s(doc, now);
	const token = sign_realtime_token({ t: 'guest', gid: guest_id, mid: doc._id, name, exp });
	const secure = request_is_https(ctx.req) ? '; Secure' : '';
	const cookie = `imperium_invitado=${encodeURIComponent(token)}; HttpOnly; Path=/api; SameSite=Lax; Max-Age=${exp - Math.floor(now / 1000)}${secure}`;
	return Response.json(ok([{ guest_id, name, socket_ticket: socket_ticket(guest_id, doc._id, name, now) }], 'Invitado listo.'), {
		headers: { 'set-cookie': cookie },
	});
}

/** Un ticket de un uso por cada (re)conexión del socket del invitado. */
export async function guest_ticket(ctx: MeetingCtx): Promise<unknown> {
	const principal = meeting_principal({ actor: null, req: ctx.req }, guest_claims(ctx.req)?.mid ?? '');
	if (principal.kind !== 'guest') throw guest_token_invalid();
	await calls_enabled_settings(ctx.store);
	const allowed = take_token(`meeting-guest-ticket:${principal.guest_id}`, GUEST_TICKET_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	return ok([{ socket_ticket: socket_ticket(principal.guest_id, principal.meeting_id, principal.name, Date.now()) }], 'Ticket listo.');
}

/** Una sola apertura de llamada por reunión a la vez: hay una sola réplica del núcleo (contrato §5.1). */
const opening = new Map<string, Promise<CallDoc>>();

/** La llamada viva de la reunión, o una nueva que la deja «en vivo». */
async function meeting_call(store: ImperiumStore, meeting_id: string, media: CallMedia): Promise<CallDoc> {
	const pending = opening.get(meeting_id);
	if (pending) return pending;
	const task = (async () => {
		const doc = await load_meeting(store, meeting_id);
		const current = doc.active_call_id ? await store.find_id('chat-calls', doc.active_call_id) : null;
		if (current && current.is_active !== false && (current.state === 'active' || current.state === 'ringing')) {
			return call_from_row(current);
		}
		const conversation = await store.find_id('chat-conversations', doc.conversation_id);
		const call = await open_meeting_call(store, {
			meeting_id,
			conversation_id: doc.conversation_id,
			conversation_key: str(conversation?.conversation_key) || `conv:${doc.conversation_id}`,
			host_id: doc.host_id,
			media,
		});
		const { after } = await update_meeting_doc(store, meeting_id, (latest) =>
			latest.state === 'cancelled' ? null : { ...latest, state: 'live', active_call_id: call._id },
		);
		if (after.active_call_id === call._id) await publish_meeting(store, after, 'live');
		return call;
	})().finally(() => opening.delete(meeting_id));
	opening.set(meeting_id, task);
	return task;
}

function open_room(call: CallDoc, doc: MeetingDoc): RoomState {
	return open_meeting_room({
		call_id: call._id,
		meeting_id: doc._id,
		conversation_id: doc.conversation_id,
		policy: {
			allow_unmute: doc.settings.allow_unmute,
			screen_share: doc.settings.screen_share,
			whiteboard: doc.settings.whiteboard,
			private_chat: doc.profile === 'clase' ? false : doc.settings.private_chat,
		},
		entry: { muted: doc.settings.mute_on_entry, cams_off: doc.settings.cams_off_on_entry },
		blocked: doc.blocked_keys,
		...(doc.settings.captions && doc.settings.save_transcript ? { transcript: { started_at: Date.parse(call.started_at) || Date.now() } } : {}),
	});
}

/** Quienes se ven en la sala: las personas con alguna pata adjunta. */
function present_count(room: RoomState): number {
	return new Set(room.members.map((member) => member.member_key)).size;
}

async function conversation_seq(store: ImperiumStore, conversation_id: string): Promise<number> {
	return Number((await store.find_id('chat-conversations', conversation_id))?.last_seq) || 0;
}

function staff_user_ids(doc: MeetingDoc, room: RoomState): string[] {
	const keys = room.admitted.filter((person) => STAFF.has(person.role)).map((person) => person.member_key);
	return [...new Set([doc.host_id, ...doc.cohost_ids, ...keys.filter((key) => key.startsWith('u:')).map((key) => key.slice(2))])];
}

/** `meeting:lobby` a quienes admiten (contrato §5.4). */
function publish_lobby(doc: MeetingDoc, room: RoomState): void {
	emit_to_users(staff_user_ids(doc, room), 'meeting:lobby', {
		call_id: room.call_id,
		entries: room.lobby.map((entry) => ({
			member_key: entry.member_key,
			name: entry.name,
			guest: entry.guest === true,
			waiting_since: new Date(entry.waiting_since).toISOString(),
		})),
	});
}

/** `meeting:command` a las sesiones de esa persona, adjuntas a la sala o esperando. */
function send_command(call_id: string, member_key: string, type: CommandKind, data: ImperiumDoc = {}): void {
	const payload = { call_id, type, data };
	if (member_key.startsWith('u:')) emit_to_users([member_key.slice(2)], 'meeting:command', payload);
	else emit_to_guest(member_key.slice(2), 'meeting:command', payload);
}

const SFU_BY_COMMAND: Partial<Record<CommandKind, SfuCommand['type']>> = {
	muted: 'mute',
	cams_off: 'mute',
	floor_granted: 'grants',
	floor_revoked: 'grants',
	role: 'grants',
};

/**
 * Lo que cada evento de la sala arrastra fuera de ella: avisos a cada quien, la asistencia, el
 * chat de quien entra sin invitación (y que deja al ser expulsado), el bloqueo que se guarda y la moderación en el servidor de
 * medios (solo en `sfu`; en malla y estrella es cooperativa).
 */
async function after_room_events(
	store: ImperiumStore,
	call: CallDoc,
	doc: MeetingDoc,
	result: Extract<RoomResult, { ok: true }>,
	opts: { block?: string; actor_user_id?: string } = {},
): Promise<void> {
	const { room, events } = result;
	for (const event of events) {
		switch (event.type) {
			case 'lobby':
				publish_lobby(doc, room);
				break;
			case 'command': {
				send_command(call._id, event.member_key, event.kind, event.data);
				const sfu = SFU_BY_COMMAND[event.kind];
				if (sfu === 'mute') {
					const sources: SfuSource[] = event.kind === 'muted' ? ['microphone'] : ['camera'];
					await impose_on_sfu(store, call, { type: 'mute', member_key: event.member_key, sources }).catch(report);
				}
				if (sfu) await impose_on_sfu(store, call, { type: 'grants', member_key: event.member_key }).catch(report);
				break;
			}
			case 'policy':
				for (const key of new Set(room.members.map((member) => member.member_key))) {
					await impose_on_sfu(store, call, { type: 'grants', member_key: key }).catch(report);
				}
				break;
			case 'admitted':
				attendance_waited(call._id, event.person, event.waited_ms);
				if (event.person.member_key.startsWith('u:') && !doc.member_ids.includes(event.person.member_key.slice(2))) {
					await join_meeting_conversation(store, doc.conversation_id, event.person.member_key.slice(2)).catch(report);
				}
				break;
			case 'removed': {
				const person = event.person ?? {
					member_key: event.member_key,
					name: event.legs[0]?.name ?? '',
					role: event.member_key.startsWith('g:') ? ('guest' as const) : ('participant' as const),
				};
				attendance_outcome(call._id, person, event.outcome);
				const now = Date.now();
				for (const leg of event.legs) {
					leave_room_server(leg.session_id, `call:${call._id}`);
					leave_room_server(leg.session_id, `meeting:${doc._id}`);
					attendance_exit(call._id, leg.member_key, leg.leg_id, now);
				}
				if (event.outcome === 'expelled') {
					// La sala ya no tiene sus patas: sin `leg_id`, impose_on_sfu no encontraría a quién sacar.
					for (const leg of event.legs) {
						await impose_on_sfu(store, call, { type: 'remove', member_key: event.member_key, leg_id: leg.leg_id }).catch(report);
					}
					const user_id = event.member_key.startsWith('u:') ? event.member_key.slice(2) : '';
					if (user_id && !doc.member_ids.includes(user_id)) await leave_meeting_conversation(store, doc.conversation_id, user_id).catch(report);
				}
				await flush_attendance(store, call, { member_key: event.member_key }).catch(report);
				break;
			}
			case 'end':
				await end_call_for_all(store, call._id, opts.actor_user_id ?? doc.host_id, true);
				break;
			case 'breakouts_opened':
				await open_breakout_calls(store, call, doc, room, event.rooms);
				break;
			case 'breakouts_closed':
				await close_breakout_calls(store, call._id, event.call_ids, doc.host_id);
				break;
			case 'roster':
			case 'hands':
			case 'hand_raised':
			case 'board':
			case 'breakouts':
				break;
		}
	}
	if (opts.block) {
		await store.payload_set_toggle('chat-meetings', doc._id, { field: 'blockedKeys', value: opts.block, on: true }, new Date().toISOString());
	}
}

/**
 * Contrato §4.4 y §6.5: entra a la sala de la reunión, o a la espera si el lobby aplica o si
 * quien organiza aún no llega. Abre la llamada si no hay una viva. Sin sesión, la cuota por IP
 * del código va antes de buscarlo: 404 contra 401 diría qué códigos existen.
 */
export async function join_meeting(ctx: MeetingCtx): Promise<unknown> {
	if (!ctx.actor) {
		const allowed = take_meeting_code_ip(ctx.req);
		if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	}
	const settings = await calls_enabled_settings(ctx.store);
	const found = await meeting_by_code(ctx.store, str(ctx.params.code));
	const principal = meeting_principal(ctx, found._id);
	const leg_id = leg_of(ctx.body.leg_id);
	const media = media_of(ctx.body.media);
	assert_not_cancelled(found);
	const guest = principal.kind === 'guest';
	if (guest && (!settings.guests_enabled || !found.settings.guests_allowed)) throw guests_disabled();
	if (found.blocked_keys.includes(principal.member_key)) throw expelled();
	const role: RoomRole = principal.kind === 'guest' ? 'guest' : meeting_role(found, principal.user_id);
	const invited = principal.kind === 'user' && found.member_ids.includes(principal.user_id);
	const staff = STAFF.has(role);
	if (!guest && !invited && found.settings.lobby === 'none') {
		throw new ChatError(403, 'not_invited', 'Esta reunión es solo para personas invitadas.');
	}
	const call = await meeting_call(ctx.store, found._id, media);
	const doc = await load_meeting(ctx.store, found._id);
	const room = open_room(call, doc);
	if (room.blocked.includes(principal.member_key)) throw expelled();
	if (room.policy.locked && !staff) throw meeting_locked();
	const person: RoomPerson = {
		member_key: principal.member_key,
		name: principal.name,
		role,
		...(guest ? { guest: true as const } : {}),
	};
	const admitted = room.admitted.some((item) => item.member_key === person.member_key);
	const needs_approval = !staff && (guest ? doc.settings.lobby !== 'none' : !invited || doc.settings.lobby === 'all');
	const host_away = !staff && doc.settings.wait_for_host && !room.admitted.some((item) => STAFF.has(item.role));
	let state: 'joined' | 'lobby' = 'joined';
	let current = call;
	if (!admitted && (needs_approval || host_away)) {
		const result = run_room_command(call._id, { type: 'wait', person, reason: needs_approval ? 'approval' : 'host', now: Date.now() });
		if (!result.ok) throw expelled();
		await after_room_events(ctx.store, call, doc, result);
		state = 'lobby';
	} else if (!admitted) {
		current = await grow_meeting_call(ctx.store, call._id, present_count(room) + 1);
		const visible = guest ? { visible_from_seq: await conversation_seq(ctx.store, doc.conversation_id) } : {};
		const result = run_room_command(call._id, { type: 'admit_direct', person: { ...person, ...visible } });
		if (!result.ok) throw expelled();
		await after_room_events(ctx.store, call, doc, { ...result, events: [...result.events, { type: 'admitted', person, waited_ms: 0 }] });
		if (staff) await admit_waiting_for_host(ctx.store, current._id, principal.member_key);
	}
	return ok(
		[
			{
				call: view_of(current),
				state,
				role,
				member_key: principal.member_key,
				topology: current.topology,
				policy: room_state(call._id).policy,
			},
		],
		state === 'lobby' ? 'Esperando a que te admitan.' : 'Entraste a la reunión.',
	);
}

/** Llegó quien organiza: entran quienes solo esperaban por eso. */
async function admit_waiting_for_host(store: ImperiumStore, call_id: string, actor_key: string): Promise<void> {
	for (const entry of room_state(call_id).lobby.filter((item) => item.reason === 'host')) {
		await run_host_command(store, call_id, { member_key: actor_key, role: 'host' }, { type: 'admit', member_key: entry.member_key }).catch(
			report,
		);
	}
}

/**
 * `meeting:host` (contrato §5.5): el comando se autoriza en la sala (`apply_room_command`) y aquí
 * se cumple lo que arrastra. Admitir cuenta contra el tope de la sala.
 */
export async function run_host_command(
	store: ImperiumStore,
	call_id: string,
	actor: { member_key: string; role: RoomRole },
	command: HostCommand,
): Promise<void> {
	const call = await live_meeting_call(store, call_id);
	const doc = await load_meeting(store, call.meeting_id);
	const room = room_state(call_id, doc._id);
	const admitting = command.type === 'admit' ? 1 : command.type === 'admit_all' ? room.lobby.length : 0;
	if (admitting && STAFF.has(actor.role)) await grow_meeting_call(store, call_id, present_count(room) + admitting);
	if (command.type === 'captions' && command.on && !doc.settings.captions) throw feature_disabled();
	const order = command.type === 'breakouts_open' && command.assign === 'random' ? { ...command, rooms: deal_rooms(room, command.rooms) } : command;
	const result = run_room_command(call_id, {
		type: 'host',
		actor,
		command: order,
		now: Date.now(),
		...(admitting ? { visible_from_seq: await conversation_seq(store, doc.conversation_id) } : {}),
		...(order.type === 'breakouts_open' ? { breakout_ids: order.rooms.map(() => new_id()) } : {}),
	});
	if (!result.ok) throw room_error(result.code);
	await after_room_events(store, call, doc, result, {
		block: command.type === 'kick' && command.block ? command.member_key : undefined,
		actor_user_id: actor.member_key.startsWith('u:') ? actor.member_key.slice(2) : undefined,
	});
	if (command.type === 'kick') await expel_from_other_rooms(store, doc, call_id, command);
	if (command.type.startsWith('breakouts_')) schedule_breakouts(store, call_id);
}

/**
 * Expulsar vale para toda la reunión: quien sale de una sala sale también de la principal y de las
 * pequeñas. Si no, seguiría con medios en otra sala, leyendo el chat por la admisión que conserva, y
 * al cerrarse las salas pequeñas volvería a la principal.
 */
async function expel_from_other_rooms(store: ImperiumStore, doc: MeetingDoc, from_call_id: string, order: Extract<HostCommand, { type: 'kick' }>): Promise<void> {
	const main = room_state(from_call_id).parent_call_id ?? from_call_id;
	for (const call_id of [main, ...(breakout_children.get(main) ?? [])]) {
		if (call_id === from_call_id || !room_exists(call_id)) continue;
		const result = run_room_command(call_id, { type: 'expel', member_key: order.member_key, block: order.block });
		if (!result.ok || !result.events.length) continue;
		const call = await live_meeting_call(store, call_id).catch(() => null);
		if (call) await after_room_events(store, call, doc, result).catch(report);
	}
}

async function live_meeting_call(store: ImperiumStore, call_id: string): Promise<CallDoc & { meeting_id: string }> {
	const row = await store.find_id('chat-calls', call_id);
	if (!row || row.is_active === false) throw new ChatError(404, 'call_not_found', 'No encontramos esa llamada.');
	const call = call_from_row(row);
	if (call.state === 'ended') throw new ChatError(409, 'call_ended', 'La llamada terminó.');
	const { meeting_id } = call;
	if (!meeting_id) throw invalid('Los comandos de anfitrión son de las reuniones.');
	return { ...call, meeting_id };
}

/** Reparto al azar: quienes no moderan, barajados y repartidos por igual entre las salas. */
function deal_rooms(room: RoomState, rooms: Array<{ name: string; member_keys: string[] }>): Array<{ name: string; member_keys: string[] }> {
	const people = room.admitted.filter((person) => !STAFF.has(person.role)).map((person) => person.member_key);
	for (let i = people.length - 1; i > 0; i--) {
		const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
		[people[i], people[j]] = [people[j]!, people[i]!];
	}
	return rooms.map((item, index) => ({ name: item.name, member_keys: people.filter((_, at) => at % rooms.length === index) }));
}

/** Las salas pequeñas abiertas de cada sala principal, para terminarlas con ella. */
const breakout_children = new Map<string, string[]>();
const breakout_timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Cada sala pequeña es una llamada hija (contrato §3.6, `parent_call_id`) con su propia sala: hereda
 * la política de la principal y deja entrar a los suyos y, de visita, a quienes moderan.
 */
async function open_breakout_calls(store: ImperiumStore, parent: CallDoc, doc: MeetingDoc, room: RoomState, rooms: BreakoutRoom[]): Promise<void> {
	const opened: string[] = [];
	breakout_children.set(parent._id, opened);
	const { spotlight: _spot, floor: _floor, recording: _recording, ...policy } = room.policy;
	try {
		for (const item of rooms) {
			await open_meeting_call(store, {
				id: item.call_id,
				parent_call_id: parent._id,
				meeting_id: doc._id,
				conversation_id: parent.conversation_id,
				conversation_key: parent.conversation_key,
				host_id: doc.host_id,
				media: parent.media,
			});
			opened.push(item.call_id);
			open_meeting_room({
				call_id: item.call_id,
				meeting_id: doc._id,
				conversation_id: doc.conversation_id,
				policy: { ...policy, locked: false },
				entry: room.entry,
				blocked: room.blocked,
				parent_call_id: parent._id,
				...(room.transcript ? { transcript: { started_at: Date.now() } } : {}),
			});
			if (item.member_keys.length) await grow_meeting_call(store, item.call_id, item.member_keys.length);
			for (const person of room.admitted.filter((candidate) => item.member_keys.includes(candidate.member_key) || STAFF.has(candidate.role))) {
				run_room_command(item.call_id, { type: 'admit_direct', person });
			}
		}
	} catch (err) {
		// Nadie se movió todavía: basta con cerrarlas y avisar a la sala principal.
		run_room_command(parent._id, { type: 'breakouts_end' });
		await close_breakout_calls(store, parent._id, opened, doc.host_id);
		throw err;
	}
}

async function close_breakout_calls(store: ImperiumStore, parent_id: string, call_ids: string[], host_id: string): Promise<void> {
	breakout_children.delete(parent_id);
	const timer = breakout_timers.get(parent_id);
	if (timer) clearTimeout(timer);
	breakout_timers.delete(parent_id);
	for (const call_id of call_ids) await end_call_for_all(store, call_id, host_id, true).catch(report);
}

/** El temporizador de las salas pequeñas: al vencer empieza la cuenta regresiva de 60 s y luego se cierran. */
function schedule_breakouts(store: ImperiumStore, call_id: string): void {
	const previous = breakout_timers.get(call_id);
	if (previous) clearTimeout(previous);
	breakout_timers.delete(call_id);
	const open = room_exists(call_id) ? room_state(call_id).breakouts : undefined;
	if (!open) return;
	const timer = setTimeout(
		() => {
			breakout_timers.delete(call_id);
			void breakouts_tick(store, call_id).catch(report);
		},
		Math.max(0, (open.closing_at ?? open.ends_at) - Date.now()),
	);
	timer.unref?.();
	breakout_timers.set(call_id, timer);
}

export async function breakouts_tick(store: ImperiumStore, call_id: string, now = Date.now()): Promise<void> {
	if (!room_exists(call_id)) return;
	const result = run_room_command(call_id, { type: 'breakouts_tick', now });
	if (result.ok && result.events.length) {
		const call = await live_meeting_call(store, call_id);
		await after_room_events(store, call, await load_meeting(store, call.meeting_id), result);
	}
	schedule_breakouts(store, call_id);
}

/** El invitado admitido de esa reunión y su conversación, o 403 (contrato §6.5). */
async function guest_chat(store: ImperiumStore, doc: MeetingDoc, principal: CallPrincipal): Promise<{ guest: ChatGuest; conversation: ImperiumDoc }> {
	const admitted = principal.kind === 'guest' ? admitted_guest(doc._id, principal.guest_id) : null;
	if (principal.kind !== 'guest' || !admitted) throw guest_not_admitted();
	const settings = await chat_settings(store);
	if (!settings.messaging_enabled) throw new ChatError(403, 'messaging_disabled', 'El chat está desactivado en esta organización.');
	return {
		guest: { guest_id: principal.guest_id, name: admitted.person.name, visible_from_seq: admitted.person.visible_from_seq ?? 0 },
		conversation: await find_chat_conversation(store, doc.conversation_id),
	};
}

export async function guest_read_chat(ctx: MeetingCtx): Promise<unknown> {
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const { guest, conversation } = await guest_chat(ctx.store, doc, meeting_principal(ctx, doc._id));
	return guest_message_page(ctx.store, conversation, guest, ctx.url);
}

export async function guest_chat_message(ctx: MeetingCtx): Promise<unknown> {
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const { guest, conversation } = await guest_chat(ctx.store, doc, meeting_principal(ctx, doc._id));
	return post_guest_message(ctx.store, conversation, guest, ctx.body);
}

const QUESTION_TEXT_MAX = 500;
const QUESTIONS_MAX = 500;
const QUESTION_RATE = { capacity: 10, refill_per_s: 10 / 60 };
const QUESTION_STATUSES = ['visible', 'answered', 'hidden'] as const;
type QuestionStatus = 'pending' | (typeof QUESTION_STATUSES)[number];

function question_not_found(): ChatError {
	return new ChatError(404, 'question_not_found', 'No encontramos esa pregunta.');
}

/** La llamada de esa reunión (o una de sus salas pequeñas). */
async function meeting_call_of(store: ImperiumStore, doc: MeetingDoc, call_id: string): Promise<CallDoc> {
	const row = CHAT_ID.test(call_id) ? await store.find_id('chat-calls', call_id) : null;
	if (!row || row.is_active === false || str(row.meeting_id) !== doc._id) {
		throw new ChatError(404, 'call_not_found', 'No encontramos esa llamada.');
	}
	return call_from_row(row);
}

type Asker = { principal: CallPrincipal; call: CallDoc; staff: boolean; admitted: boolean };

/**
 * Quién pregunta o vota en la sala: la persona admitida en esa llamada. Quien organiza o modera
 * la reunión también lee después de que termina, y ve lo que aún no se publica.
 */
async function asker(store: ImperiumStore, doc: MeetingDoc, principal: CallPrincipal, call_id: string): Promise<Asker> {
	await calls_enabled_settings(store);
	const call = await meeting_call_of(store, doc, call_id);
	const person = admitted_person(call._id, principal.member_key);
	const role = principal.kind === 'user' && doc.member_ids.includes(principal.user_id) ? meeting_role(doc, principal.user_id) : null;
	return {
		principal,
		call,
		staff: STAFF.has(person?.role ?? 'participant') || role === 'host' || role === 'cohost',
		admitted: Boolean(person),
	};
}

function not_admitted(principal: CallPrincipal): ChatError {
	return principal.kind === 'guest' ? guest_not_admitted() : not_member();
}

/** `QuestionView` (contrato §3.6): el autor de una anónima solo lo ve quien modera; `mine` es la propia y `voted`, la que votó. */
function question_view(row: ImperiumDoc, viewer: { member_key: string; staff: boolean }): ImperiumDoc {
	const anonymous = row.anonymous === true;
	return defined({
		_id: str(row._id),
		call_id: str(row.call_id),
		text: str(row.text),
		anonymous,
		author_name: anonymous && !viewer.staff ? undefined : str(row.authorName) || undefined,
		votes: Number(row.votes) || 0,
		mine: str(row.authorKey) === viewer.member_key,
		voted: Array.isArray(row.voterKeys) && row.voterKeys.includes(viewer.member_key),
		status: (str(row.state) || 'visible') as QuestionStatus,
		created_at: str(row.created_at),
	});
}

/** `meeting_question` (contrato §5.4) a la sala: sin texto ni autor, solo lo que cambió. */
function publish_question(row: ImperiumDoc): void {
	emit_to_room(`call:${str(row.call_id)}`, 'update', {
		action: 'meeting_question',
		data: [{ meeting_id: str(row.meeting_id), call_id: str(row.call_id), question_id: str(row._id), status: str(row.state), votes: Number(row.votes) || 0 }],
	});
}

/** Por votos; las pendientes y ocultas solo para quien modera, y cada quien ve las suyas. */
export async function read_questions(ctx: MeetingCtx): Promise<unknown> {
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const who = await asker(ctx.store, doc, meeting_principal(ctx, doc._id), str(ctx.url.searchParams.get('call_id')));
	const reads_after = who.principal.kind === 'user' && doc.member_ids.includes(who.principal.user_id);
	if (!who.admitted && !who.staff && !reads_after) throw not_admitted(who.principal);
	const rows = await ctx.store.meeting_questions({
		call_id: who.call._id,
		states: who.staff ? ['pending', ...QUESTION_STATUSES] : ['visible', 'answered'],
		author_key: who.principal.member_key,
		limit: QUESTIONS_MAX,
	});
	const viewer = { member_key: who.principal.member_key, staff: who.staff };
	return ok(rows.map((row) => question_view(row, viewer)), 'Preguntas.');
}

function question_text(value: unknown): string {
	const text = (typeof value === 'string' ? value : '').replace(/[^\P{Cc}\n]/gu, '').trim();
	if (!text) throw invalid('Escribe tu pregunta.');
	if (text.length > QUESTION_TEXT_MAX) {
		throw new ChatError(422, 'text_too_long', `El mensaje supera los ${QUESTION_TEXT_MAX} caracteres.`);
	}
	return text;
}

/** Con moderación previa la pregunta espera a que alguien la publique. */
export async function create_question(ctx: MeetingCtx): Promise<unknown> {
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const who = await asker(ctx.store, doc, meeting_principal(ctx, doc._id), str(ctx.body.call_id));
	if (!who.admitted || who.call.state === 'ended') throw not_admitted(who.principal);
	const text = question_text(ctx.body.text);
	const anonymous = ctx.body.anonymous === undefined ? false : bool_field(ctx.body.anonymous, 'anonymous');
	const allowed = take_token(`meeting-question:${who.principal.member_key}`, QUESTION_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const row = await ctx.store.insert('chat-meeting-questions', {
		name: '',
		state: doc.settings.qa_moderated ? 'pending' : 'visible',
		call_id: who.call._id,
		meeting_id: doc._id,
		authorKey: who.principal.member_key,
		authorName: who.principal.name,
		anonymous,
		text,
		voterKeys: [],
		votes: 0,
	});
	attendance_count(who.call._id, who.principal.member_key, 'questions');
	publish_question(row);
	return ok([question_view(row, { member_key: who.principal.member_key, staff: who.staff })], 'Pregunta enviada.');
}

async function load_question(store: ImperiumStore, doc: MeetingDoc, qid: string): Promise<ImperiumDoc> {
	const row = CHAT_ID.test(qid) ? await store.find_id('chat-meeting-questions', qid) : null;
	if (!row || row.is_active === false || str(row.meeting_id) !== doc._id) throw question_not_found();
	return row;
}

/** Conmuta el voto en una sentencia: dos votos a la vez no se pisan. */
export async function vote_question(ctx: MeetingCtx): Promise<unknown> {
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const principal = meeting_principal(ctx, doc._id);
	const question = await load_question(ctx.store, doc, str(ctx.params.qid));
	const who = await asker(ctx.store, doc, principal, str(question.call_id));
	if (!who.admitted || who.call.state === 'ended') throw not_admitted(who.principal);
	const published = question.state === 'visible' || question.state === 'answered';
	if (!published && !who.staff) throw question_not_found();
	const toggled = await ctx.store.payload_set_toggle(
		'chat-meeting-questions',
		str(question._id),
		{ field: 'voterKeys', value: who.principal.member_key, count_field: 'votes' },
		new Date().toISOString(),
	);
	if (!toggled) throw question_not_found();
	publish_question(toggled.doc);
	return ok([question_view(toggled.doc, { member_key: who.principal.member_key, staff: who.staff })], 'Voto registrado.');
}

/** Publicar, marcar respondida u ocultar: quien organiza o modera la reunión. */
export async function moderate_question(ctx: MeetingCtx): Promise<unknown> {
	await calls_enabled_settings(ctx.store);
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const uid = actor_id(ctx);
	const question = await load_question(ctx.store, doc, str(ctx.params.qid));
	const room_role = admitted_person(str(question.call_id), `u:${uid}`)?.role;
	const role = doc.member_ids.includes(uid) ? meeting_role(doc, uid) : null;
	if (role !== 'host' && role !== 'cohost' && !STAFF.has(room_role ?? 'participant')) {
		throw doc.member_ids.includes(uid) ? not_host() : not_member();
	}
	const status = QUESTION_STATUSES.find((item) => item === ctx.body.status);
	if (!status) throw invalid('El estado es visible, answered o hidden.');
	for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
		const current = await load_question(ctx.store, doc, str(question._id));
		if (current.state === status) return ok([question_view(current, { member_key: `u:${uid}`, staff: true })], 'Pregunta.');
		const row = await ctx.store.update_versioned(
			'chat-meeting-questions',
			str(current._id),
			Number(current.v) || 0,
			{ state: status, payload: {} },
			new Date().toISOString(),
		);
		if (!row) continue;
		publish_question(row);
		return ok([question_view(row, { member_key: `u:${uid}`, staff: true })], 'Pregunta actualizada.');
	}
	throw new ChatError(429, 'rate_limited', 'Demasiadas solicitudes; intenta de nuevo en 1 s.', { retry_after_s: 1 });
}

const RECORDING_CHUNK_MAX = 8 * 1024 * 1024;
const RECORDING_CHUNK_RATE = { capacity: 120, refill_per_s: 2 };
const RECORDING_STALE_MS = 24 * 3600_000;
/** La última parte que el navegador entrega al cortar la llamada todavía entra. */
const RECORDING_TAIL_MS = 60_000;
const MB = 1024 * 1024;

function max_bytes(name: string, fallback_mb: number): number {
	const mb = Number(process.env[name]);
	return (Number.isFinite(mb) && mb > 0 ? mb : fallback_mb) * MB;
}

const recording_max_bytes = () => max_bytes('IMPERIUM_RECORDING_MAX_MB', 2048);
const meeting_recordings_max_bytes = () => max_bytes('IMPERIUM_MEETING_RECORDINGS_MAX_MB', 10240);

function recording_too_large(): ChatError {
	return new ChatError(413, 'recording_too_large', 'La grabación alcanzó el tamaño máximo.');
}

type Recording = {
	call_id: string;
	meeting_id: string;
	by: string;
	started_at: number;
	next_seq: number;
	bytes: number;
	/** Lo que la reunión ya tenía grabado al empezar esta: cuenta para su tope total. */
	meeting_bytes: number;
};

/** Grabaciones en curso; un reinicio las pierde y sus partes se borran a las 24 h. */
const recordings = new Map<string, Recording>();

function recording_seq(expected_seq: number): ChatError {
	return new ChatError(409, 'recording_seq', 'Se perdió una parte de la grabación; reintentando.', { expected_seq });
}

/** La grabación de esta reunión que empezó quien la pide. */
function own_recording(ctx: MeetingCtx, doc: MeetingDoc): { id: string; recording: Recording } {
	const id = str(ctx.params.rid);
	const recording = recordings.get(id);
	if (!recording || recording.meeting_id !== doc._id) throw new ChatError(404, 'upload_not_found', 'No encontramos ese archivo subido.');
	if (recording.by !== actor_id(ctx)) throw not_host();
	return { id, recording };
}

/** Pone el aviso de grabación de la sala al día con la llamada. */
function announce_recording(call_id: string, value: NonNullable<RoomState['policy']['recording']> | null): void {
	if (!room_exists(call_id)) return;
	run_room_command(call_id, { type: 'recording', recording: value });
	if (value) attendance_recording_notice(call_id, Date.now());
}

/**
 * Contrato §4.4 y §6.6: solo quien organiza graba, si la organización y la reunión lo permiten. El
 * aviso sale en `meeting:policy` y queda en la asistencia de quien ya estaba adentro.
 */
export async function start_recording(ctx: MeetingCtx): Promise<unknown> {
	const settings = await calls_enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	if (doc.host_id !== uid) throw doc.member_ids.includes(uid) ? not_host() : not_member();
	if (!settings.recording_enabled || !doc.settings.recording_allowed) throw feature_disabled();
	const call = await meeting_call_of(ctx.store, doc, str(ctx.body.call_id));
	if (call.state === 'ended') throw new ChatError(409, 'call_ended', 'La llamada terminó.');
	if (call.parent_call_id) throw invalid('Se graba la sala principal, no una sala pequeña.');
	const current = call.recording ? recordings.get(call.recording.recording_id) : undefined;
	if (call.recording && current?.by === uid) return ok([{ recording_id: call.recording.recording_id }], 'Grabando.');
	const meeting_bytes = await ctx.store.meeting_recorded_bytes({ meeting_id: doc._id, conversation_id: doc.conversation_id });
	if (meeting_bytes >= meeting_recordings_max_bytes()) throw recording_too_large();
	const recording_id = new_id();
	start_recording_part(recording_id);
	const now = Date.now();
	recordings.set(recording_id, { call_id: call._id, meeting_id: doc._id, by: uid, started_at: now, next_seq: 0, bytes: 0, meeting_bytes });
	try {
		await record_call(ctx.store, call._id, { user_id: uid, is_host: true, recording_id });
	} catch (err) {
		recordings.delete(recording_id);
		discard_recording_part(recording_id);
		throw err;
	}
	announce_recording(call._id, { by_name: str(ctx.actor?.name ?? ctx.actor?.email), started_at: new Date(now).toISOString() });
	return ok([{ recording_id }], 'Grabando.');
}

/**
 * Partes de hasta 8 MB, en orden (`seq` 0, 1, 2…), hasta el tope de la grabación y el de la
 * reunión, y solo mientras la llamada sigue (o acaba de cortarse) y las llamadas están encendidas.
 */
export async function recording_chunk(ctx: MeetingCtx): Promise<unknown> {
	await calls_enabled_settings(ctx.store);
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const { id, recording } = own_recording(ctx, doc);
	const row = await ctx.store.find_id('chat-calls', recording.call_id);
	const call = row ? call_from_row(row) : null;
	const ended_at = call?.state === 'ended' ? Date.parse(call.ended_at ?? '') || 0 : null;
	if (!call || (ended_at !== null && Date.now() - ended_at > RECORDING_TAIL_MS)) {
		throw new ChatError(409, 'call_ended', 'La llamada terminó.');
	}
	const chunk = ctx.body.chunk;
	const seq = Number(ctx.body.seq);
	if (!is_upload(chunk) || !Number.isInteger(seq) || seq < 0) throw invalid('Manda la parte en «chunk» con su número en «seq».');
	if (chunk.size > RECORDING_CHUNK_MAX) throw new ChatError(413, 'upload_too_large', 'El archivo supera el máximo de 8 MB.');
	if (seq !== recording.next_seq) throw recording_seq(recording.next_seq);
	const allowed = take_token(`meeting-recording:${id}`, RECORDING_CHUNK_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const bytes = new Uint8Array(await chunk.arrayBuffer());
	// Otra parte pudo llegar mientras se leía esta: se vuelve a revisar sin soltar el hilo.
	if (seq !== recording.next_seq) throw recording_seq(recording.next_seq);
	const total = recording.bytes + bytes.length;
	if (total > recording_max_bytes() || recording.meeting_bytes + total > meeting_recordings_max_bytes()) throw recording_too_large();
	append_recording_part(id, bytes);
	recording.next_seq++;
	recording.bytes += bytes.length;
	return ok([{ received_seq: seq, total_mb: Math.round((recording.bytes / MB) * 100) / 100 }], 'Parte recibida.');
}

function stamp(ms: number, timezone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(ms));
	const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
	return `${part('year')}${part('month')}${part('day')}-${part('hour')}${part('minute')}`;
}

/**
 * El archivo pasa a la carpeta de subidas, su fila apunta al mensaje de sistema `recording` de la
 * conversación de la reunión y la sala deja de avisar que se graba.
 */
export async function finish_recording(ctx: MeetingCtx): Promise<unknown> {
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	const { id, recording } = own_recording(ctx, doc);
	if (!recording.next_seq) throw recording_seq(0);
	recordings.delete(id);
	const uid = actor_id(ctx);
	const now = Date.now();
	const file = finish_recording_part(id);
	const message_id = new_id();
	const duration_s = Math.round((now - recording.started_at) / 1000);
	let row: ImperiumDoc | null = null;
	try {
		row = await outside_history_context(() =>
			ctx.store.insert('attachment-management', {
				name: `grabacion-${doc.code}-${stamp(recording.started_at, doc.timezone)}`,
				name_stored: file.name_stored,
				mimetype: 'video/webm',
				file_ext: 'webm',
				size_in_kb: file.bytes / 1024,
				file_readiness: FILE_READINESS_USABLE,
				created_by_id: uid,
				related_model: 'Message',
				related_record_id: message_id,
				field: 'attachments',
				index_if_is_array: 0,
				inside_array: true,
				is_active: true,
				chatUpload: {
					ownerUserId: uid,
					conversationId: doc.conversation_id,
					kind: 'video',
					meetingId: doc._id,
					durationMs: duration_s * 1000,
					boundAt: new Date(now).toISOString(),
				},
			}),
		);
		const view = await post_recording_message(ctx.store, {
			conversation_id: doc.conversation_id,
			message_id,
			actor: { _id: uid, name: str(ctx.actor?.name ?? ctx.actor?.email) },
			attachment: upload_info(row),
			data: { meetingId: doc._id, title: doc.title, callId: recording.call_id, recordingId: id, durationS: duration_s },
		});
		await stop_recording(ctx.store, recording.call_id, id, uid);
		return ok([view], 'Grabación guardada.');
	} catch (err) {
		if (row) await outside_history_context(() => ctx.store.remove('attachment-management', str(row!._id))).catch(report);
		await remove_unused_files(ctx.store, [file.name_stored]).catch(report);
		throw err;
	}
}

/** Si la llamada sigue grabando esta grabación, deja de hacerlo. */
async function stop_recording(store: ImperiumStore, call_id: string, recording_id: string, uid: string): Promise<void> {
	const row = await store.find_id('chat-calls', call_id);
	const call = row ? call_from_row(row) : null;
	if (!call || call.state === 'ended' || call.recording?.recording_id !== recording_id) return;
	await record_call(store, call_id, { user_id: uid, is_host: true, recording_id: null }).catch(report);
	announce_recording(call_id, null);
}

/** Las partes que ninguna grabación en curso reclama y que llevan 24 h sin tocarse. */
export function discard_stale_recordings(now: Date): number {
	return discard_stale_recording_parts(now.getTime() - RECORDING_STALE_MS, new Set(recordings.keys()));
}

const ATTENDANCE_BATCH = 500;
const BREAKOUTS_MAX = 500;

/** Quien organiza o modera la reunión, quien modera la sala viva o quien administra todo. */
async function assert_attendance_reader(ctx: MeetingCtx, doc: MeetingDoc): Promise<void> {
	const uid = actor_id(ctx);
	const role = doc.member_ids.includes(uid) ? meeting_role(doc, uid) : null;
	if (role === 'host' || role === 'cohost') return;
	if (doc.active_call_id && STAFF.has(admitted_person(doc.active_call_id, `u:${uid}`)?.role ?? 'participant')) return;
	if (ctx.actor && (await build_access(ctx.store, ctx.actor)).has_full_access) return;
	throw doc.member_ids.includes(uid) ? not_host() : not_member();
}

/**
 * La asistencia de una llamada con sus salas pequeñas o, sin `call_id`, de toda la reunión. Lo que
 * sigue en memoria de las llamadas vivas se escribe antes de leer.
 */
async function attendance_rows(ctx: MeetingCtx, doc: MeetingDoc): Promise<ImperiumDoc[]> {
	const asked = str(ctx.url.searchParams.get('call_id'));
	let call_ids: string[] | null = null;
	if (asked) {
		const call = await meeting_call_of(ctx.store, doc, asked);
		call_ids = [call._id, ...(await ctx.store.meeting_breakout_call_ids({ meeting_id: doc._id, parent_call_id: call._id, limit: BREAKOUTS_MAX }))];
	}
	const live = doc.active_call_id ? [doc.active_call_id, ...(breakout_children.get(doc.active_call_id) ?? [])] : [];
	for (const call_id of live.filter((id) => !call_ids || call_ids.includes(id))) {
		await flush_attendance(ctx.store, { _id: call_id, meeting_id: doc._id });
	}
	const rows: ImperiumDoc[] = [];
	for (let after_id = ''; ; ) {
		const page = await ctx.store.meeting_attendance_page({ meeting_id: doc._id, call_ids, after_id, limit: ATTENDANCE_BATCH });
		rows.push(...page);
		if (page.length < ATTENDANCE_BATCH) return rows;
		after_id = str(page.at(-1)!._id);
	}
}

type Interval = { in: string; out?: string; reason?: string };

function attendance_view(row: ImperiumDoc, email?: string): ImperiumDoc {
	const num = (value: unknown) => Number(value) || 0;
	return defined({
		call_id: str(row.call_id),
		meeting_id: str(row.meeting_id),
		participant_key: str(row.participant_key),
		user_id: str(row.userId) || undefined,
		guest_id: str(row.guestId) || undefined,
		display_name: str(row.displayName),
		email,
		role: str(row.role) || 'participant',
		intervals: as_array(row.intervals) as Interval[],
		total_s: num(row.totalS),
		waited_s: num(row.waitedS),
		reconnections: num(row.reconnections),
		hands: num(row.hands),
		reactions: num(row.reactions),
		questions: num(row.questions),
		camera_s: num(row.cameraS),
		recording_notice_at: str(row.recordingNoticeAt) || undefined,
		outcome: (str(row.outcome) || undefined) as 'expelled' | 'denied' | undefined,
	});
}

async function emails_of(store: ImperiumStore, rows: ImperiumDoc[], extra: string[]): Promise<Map<string, UserBrief>> {
	const ids = [...new Set([...rows.map((row) => str(row.userId)).filter(Boolean), ...extra])];
	return new Map((await store.chat_users_brief(ids)).map((user) => [user._id, user]));
}

/** Contrato §4.4: `AttendanceDoc[]` por llamada, para quien organiza o modera. */
export async function read_attendance(ctx: MeetingCtx): Promise<unknown> {
	await calls_enabled_settings(ctx.store);
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	await assert_attendance_reader(ctx, doc);
	const rows = await attendance_rows(ctx, doc);
	const users = await emails_of(ctx.store, rows, []);
	return ok(rows.map((row) => attendance_view(row, users.get(str(row.userId))?.email)), 'Asistencia.');
}

const ROLE_LABELS: Record<string, string> = {
	host: 'Anfitrión',
	cohost: 'Coanfitrión',
	presenter: 'Presentador',
	participant: 'Participante',
	guest: 'Invitado',
};
const ROLE_RANK = ['guest', 'participant', 'presenter', 'cohost', 'host'];
const OUTCOME_LABELS: Record<string, string> = { expelled: 'Expulsado', denied: 'Rechazado' };

/** Una persona en el reporte: sus filas de cada llamada (la principal y las salas pequeñas) sumadas. */
type AttendanceLine = {
	name: string;
	email: string;
	guest: boolean;
	role: string;
	status: string;
	first_in?: string;
	last_out?: string;
	total_s: number;
	waited_s: number;
	reconnections: number;
	hands: number;
	reactions: number;
	questions: number;
	camera_s: number;
	notice?: string;
};

function merge_attendance(rows: ImperiumDoc[], users: Map<string, UserBrief>): Map<string, AttendanceLine> {
	const lines = new Map<string, AttendanceLine>();
	for (const row of rows) {
		const view = attendance_view(row);
		const key = str(view.participant_key);
		const intervals = view.intervals as Interval[];
		const line = lines.get(key) ?? {
			name: str(view.display_name),
			email: users.get(str(view.user_id))?.email ?? '',
			guest: key.startsWith('g:'),
			role: str(view.role),
			status: 'Asistió',
			total_s: 0,
			waited_s: 0,
			reconnections: 0,
			hands: 0,
			reactions: 0,
			questions: 0,
			camera_s: 0,
		};
		if (ROLE_RANK.indexOf(str(view.role)) > ROLE_RANK.indexOf(line.role)) line.role = str(view.role);
		for (const field of ['total_s', 'waited_s', 'reconnections', 'hands', 'reactions', 'questions', 'camera_s'] as const) {
			line[field] += Number(view[field]) || 0;
		}
		const ins = intervals.map((item) => item.in).filter(Boolean).sort();
		const outs = intervals.map((item) => item.out ?? '').filter(Boolean).sort();
		if (ins[0] && (!line.first_in || ins[0] < line.first_in)) line.first_in = ins[0];
		if (outs.at(-1) && (!line.last_out || outs.at(-1)! > line.last_out)) line.last_out = outs.at(-1);
		const notice = str(view.recording_notice_at);
		if (notice && (!line.notice || notice < line.notice)) line.notice = notice;
		if (view.outcome) line.status = OUTCOME_LABELS[str(view.outcome)] ?? line.status;
		lines.set(key, line);
	}
	return lines;
}

function local_time(iso: string | undefined, timezone: string): string {
	if (!iso) return '';
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(iso));
	const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

const minutes_of = (seconds: number) => (Math.round((seconds / 60) * 10) / 10).toFixed(1);

/**
 * Contrato §4.4: una línea por persona (UTF-8 con BOM, para que la hoja de cálculo respete los
 * acentos) y, al final, quienes estaban en la lista y no entraron, como ausentes.
 */
export async function attendance_csv(ctx: MeetingCtx): Promise<Response> {
	await calls_enabled_settings(ctx.store);
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	await assert_attendance_reader(ctx, doc);
	const rows = await attendance_rows(ctx, doc);
	const users = await emails_of(ctx.store, rows, doc.member_ids);
	const lines = merge_attendance(rows, users);
	const present = [...lines.values()].sort((a, b) => (a.first_in ?? '').localeCompare(b.first_in ?? '') || a.name.localeCompare(b.name));
	const absent = doc.member_ids
		.filter((id) => !lines.has(`u:${id}`))
		.map((id): AttendanceLine => {
			const user = users.get(id);
			return {
				name: user?.name ?? '',
				email: user?.email ?? '',
				guest: false,
				role: meeting_role(doc, id),
				status: 'Ausente',
				total_s: 0,
				waited_s: 0,
				reconnections: 0,
				hands: 0,
				reactions: 0,
				questions: 0,
				camera_s: 0,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
	const header = [
		'Nombre',
		'Correo',
		'Tipo',
		'Rol',
		'Asistencia',
		'Primera entrada',
		'Última salida',
		'Minutos conectado',
		'Minutos en espera',
		'Reconexiones',
		'Manos levantadas',
		'Reacciones',
		'Preguntas',
		'Minutos con cámara',
		'Aviso de grabación',
	];
	const body = [...present, ...absent].map((line) =>
		[
			line.name,
			line.email,
			line.guest ? 'Invitado sin cuenta' : 'Usuario',
			ROLE_LABELS[line.role] ?? line.role,
			line.status,
			local_time(line.first_in, doc.timezone),
			local_time(line.last_out, doc.timezone),
			minutes_of(line.total_s),
			minutes_of(line.waited_s),
			line.reconnections,
			line.hands,
			line.reactions,
			line.questions,
			minutes_of(line.camera_s),
			local_time(line.notice, doc.timezone),
		]
			.map(quoted_csv_cell)
			.join(','),
	);
	return new Response(`\uFEFF${[header.map(quoted_csv_cell).join(','), ...body].join('\r\n')}\r\n`, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="asistencia-${doc.code}.csv"`,
			'cache-control': 'no-store',
		},
	});
}

const TRANSCRIPT_BATCH = 100;

function vtt_time(ms: number): string {
	const total = Math.max(0, Math.round(ms));
	const h = Math.floor(total / 3_600_000);
	const m = Math.floor((total % 3_600_000) / 60_000);
	const sec = Math.floor((total % 60_000) / 1000);
	const pad = (value: number, size = 2) => String(value).padStart(size, '0');
	return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(total % 1000, 3)}`;
}

/** Texto de un cue: sin `&`, `<` ni `>` crudos (así tampoco cabe un `-->`) y en una sola línea. */
function vtt_text(value: string): string {
	return value.replace(/\s+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

/** Contrato §4.4: la transcripción guardada de una llamada, con `<v Nombre>` por quien habló. */
export async function transcript_vtt(ctx: MeetingCtx): Promise<Response> {
	await calls_enabled_settings(ctx.store);
	const doc = await load_meeting(ctx.store, str(ctx.params.id));
	await assert_chat_member(ctx.store, await find_chat_conversation(ctx.store, doc.conversation_id), actor_id(ctx));
	const call = await meeting_call_of(ctx.store, doc, str(ctx.url.searchParams.get('call_id')));
	await flush_transcript(ctx.store, call._id);
	const blocks: string[] = [];
	for (let after = -1; ; ) {
		const rows = await ctx.store.meeting_transcript_page({ call_id: call._id, after_seq: after, limit: TRANSCRIPT_BATCH });
		for (const row of rows) {
			for (const raw of as_array(row.cues)) {
				const cue = as_object(raw);
				const text = vtt_text(str(cue.text));
				if (!text) continue;
				const voice = vtt_text(str(cue.speakerName)) || 'Participante';
				blocks.push(`${blocks.length + 1}\n${vtt_time(Number(cue.startMs))} --> ${vtt_time(Math.max(Number(cue.endMs), Number(cue.startMs)))}\n<v ${voice}>${text}`);
			}
		}
		if (rows.length < TRANSCRIPT_BATCH) break;
		after = Number(rows.at(-1)!.seq);
	}
	if (!blocks.length) throw new ChatError(404, 'transcript_not_found', 'Esta reunión no tiene transcripción guardada.');
	return new Response(`WEBVTT\n\n${blocks.join('\n\n')}\n`, {
		headers: {
			'content-type': 'text/vtt; charset=utf-8',
			'content-disposition': `attachment; filename="transcripcion-${doc.code}.vtt"`,
			'cache-control': 'no-store',
		},
	});
}

/** `/api/media` sin sesión: el invitado admitido lee los adjuntos del chat de su reunión. */
export function guest_media_reader(req: Request): GuestReader | null {
	const claims = guest_claims(req);
	const admitted = claims ? admitted_guest(claims.mid, claims.gid) : null;
	const conversation_id = admitted ? room_state(admitted.call_id).conversation_id : undefined;
	if (!admitted || !conversation_id) return null;
	return { conversation_id, visible_from_seq: admitted.person.visible_from_seq ?? 0 };
}

/** La reunión deja de estar en vivo cuando su llamada termina. */
on_meeting_call_closed(async (store, call) => {
	if (!call.meeting_id) return;
	await flush_transcript(store, call._id, { final: true }).catch(report);
	const children = breakout_children.get(call._id);
	if (children) await close_breakout_calls(store, call._id, children, call.initiator_id);
	if (call.parent_call_id) return;
	const { before, after } = await update_meeting_doc(store, call.meeting_id, (doc) =>
		doc.active_call_id === call._id
			? { ...doc, state: doc.state === 'live' ? 'scheduled' : doc.state, active_call_id: undefined }
			: null,
	);
	if (before.active_call_id === call._id) await publish_meeting(store, after, 'ended');
});
