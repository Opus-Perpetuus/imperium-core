/**
 * Mensajería del chat (contrato §4.1, §4.2 y §8): envío idempotente por conversación, subidas,
 * hilos por cursor, bandeja y deltas en tiempo real. Toda acción valida membresía y rol en el
 * servidor (`chat-access.ts`); el SQL vive en el store.
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { assert_target_record_read, HttpAccessDeniedError } from './auth.ts';
import { guest_sessions_of_conversation } from './call-room.ts';
import {
	assert_attachment_access,
	assert_can_send,
	assert_chat_member,
	CHAT_ATTACHMENT_MODELS,
	chat_can,
	chat_role,
	ChatError,
	DIRECT_CONVERSATION_SETTINGS,
	find_chat_conversation,
	invite_state,
	is_chat_row,
	type ChatRole,
} from './chat-access.ts';
import { chat_settings, type ChatSettings } from './chat-settings.ts';
import {
	actor_id,
	CHAT_ID,
	csv_cell,
	decode_cursor,
	defined,
	encode_cursor,
	invalid,
	invalid_cursor,
	json_field,
	new_id,
	str,
} from './chat-shared.ts';
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { outside_history_context } from './history.ts';
import { internal_route } from './internal-route.ts';
import { sfu_available, turn_configured } from './media-credentials.ts';
import { insert_notification, register_chat_activity, retire_chat_activity } from './notifications.ts';
import { rate_limited_response, take_token } from './rate-bucket.ts';
import { RecordRuleDeniedError } from './record-rules.ts';
import { sign_realtime_token } from './realtime-tokens.ts';
import { emit_messages_refresh, emit_to_session, emit_to_users, online_user_ids } from './socket-stub.ts';
import {
	CHAT_SERVER_KINDS,
	is_unique_violation,
	type ChatInboxFilter,
	type ChatInboxRow,
	type ChatMessageChange,
	type ChatPollTally,
	type ChatPurge,
	type ChatReadMarks,
	type ChatReadResult,
	type ChatSavedPatch,
	type ChatUserBrief,
	type ImperiumStore,
} from './store.ts';
import {
	is_upload,
	persist_upload_as_attachment,
	resolve_upload_folders,
	upload_file_path,
} from './uploads.ts';

export type ChatCtx = {
	store: ImperiumStore;
	req: Request;
	url: URL;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
	/** Solo lo pone el envío de un programado; nunca viene de la petición. */
	scheduled_id?: string;
	/** Solo lo pone la respuesta a una historia: el mensaje sale como `story-reply`. */
	story_ref?: ImperiumDoc;
};

type ChatAttachmentKind = 'image' | 'video' | 'audio' | 'voice' | 'file';
type UserBrief = { _id: string; name: string; img?: string };
type AttachmentMeta = { alt?: string; decorative?: boolean; caption?: string };

const TEXT_MAX_CHARS = 10_000;
const MAX_ATTACHMENTS = 10;
const META_MAX_CHARS = 1000;
const PEAKS_MAX = 64;
const VOICE_MAX_SECONDS = 900;
const SEND_RATE = { capacity: 20, refill_per_s: 2 };
const UPLOAD_RATE = { capacity: 30, refill_per_s: 30 / 60 };
const READ_RATE = { capacity: 120, refill_per_s: 120 / 60 };
const DIRECT_KINDS = new Set(['direct', 'self']);
const ATTACHMENT_KINDS = new Set<string>(['image', 'video', 'audio', 'voice', 'file']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENT = 'Mensaje del chat enviado correctamente.';

function assert_text_length(text: string): void {
	if (text.length > TEXT_MAX_CHARS) {
		throw new ChatError(422, 'text_too_long', `El mensaje supera los ${TEXT_MAX_CHARS} caracteres.`);
	}
}

function actor_name(ctx: ChatCtx): string {
	return str(ctx.actor?.name ?? ctx.actor?.email);
}

function actor_brief(ctx: ChatCtx): UserBrief {
	return defined({ _id: actor_id(ctx), name: actor_name(ctx), img: str(ctx.actor?.img) || undefined });
}

async function enabled_settings(store: ImperiumStore): Promise<ChatSettings> {
	const settings = await chat_settings(store);
	if (!settings.messaging_enabled) {
		throw new ChatError(403, 'messaging_disabled', 'El chat está desactivado en esta organización.');
	}
	return settings;
}

function id_list(value: unknown): string[] {
	if (value == null || value === '') return [];
	const list = json_field(value);
	if (!Array.isArray(list) || !list.every((id) => typeof id === 'string' && id.trim())) throw invalid();
	return [...new Set(list.map((id: string) => id.trim()))];
}

function meta_text(value: unknown): string | undefined {
	if (value == null || value === '') return undefined;
	if (typeof value !== 'string' || value.length > META_MAX_CHARS) throw invalid();
	return value.trim() || undefined;
}

function flag(value: unknown): boolean | undefined {
	if (value == null || value === '') return undefined;
	if (value === true || value === 'true') return true;
	if (value === false || value === 'false') return false;
	throw invalid();
}

function whole(value: unknown): number | undefined {
	if (value == null || value === '') return undefined;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < 0) throw invalid();
	return n;
}

/** Hasta 64 enteros 0..255: la forma de onda de una nota de voz o un audio. */
function peaks(value: unknown): number[] | undefined {
	if (value == null || value === '') return undefined;
	const list = json_field(value);
	if (
		!Array.isArray(list) ||
		list.length > PEAKS_MAX ||
		!list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
	) {
		throw invalid();
	}
	return list as number[];
}

function attachments_meta(value: unknown): Map<string, AttachmentMeta> {
	const out = new Map<string, AttachmentMeta>();
	if (value == null || value === '') return out;
	const list = json_field(value);
	if (!Array.isArray(list)) throw invalid();
	for (const item of list) {
		const rec = as_object(item);
		const id = str(rec.attachment_id);
		if (!id) throw invalid();
		out.set(id, defined({ alt: meta_text(rec.alt), decorative: flag(rec.decorative), caption: meta_text(rec.caption) }));
	}
	return out;
}

function take_attachment_files(body: Record<string, unknown>): Blob[] {
	const attachments = body.attachments;
	delete body.attachments;
	if (Array.isArray(attachments)) return attachments.filter(is_upload);
	return is_upload(attachments) ? [attachments] : [];
}

type RecordRef = { model_name: string; document_id: string; route: string };

type SendRequest = {
	legacy: boolean;
	conversation_id: string;
	recipient_user_id: string;
	client_id: string | null;
	text: string;
	reply_to_message_id: string;
	attachment_ids: string[];
	meta: Map<string, AttachmentMeta>;
	files: Blob[];
	/** La encuesta como se guarda (camelCase), ya validada. */
	poll?: ImperiumDoc;
	record_ref?: RecordRef;
	view_once: boolean;
	confirm_mass_mention: boolean;
};

/** Contrato §8: con `conversation_id` o `client_id` es la forma nueva; si no, la heredada. */
function send_request(body: Record<string, unknown>): SendRequest {
	const files = take_attachment_files(body);
	if (!str(body.conversation_id) && !str(body.client_id)) {
		return {
			legacy: true,
			conversation_id: '',
			recipient_user_id: str(body.recipient_user_id ?? body.recipientUserId ?? body.recipient_id),
			client_id: null,
			text: str(body.message),
			reply_to_message_id: str(body.reply_to_message_id ?? body.replyToMessageId),
			attachment_ids: [],
			meta: new Map(),
			files,
			view_once: false,
			confirm_mass_mention: false,
		};
	}
	const client_id = str(body.client_id);
	if (!UUID.test(client_id)) throw invalid('Falta el identificador del envío (client_id).');
	if (body.text != null && typeof body.text !== 'string') throw invalid();
	return {
		legacy: false,
		conversation_id: str(body.conversation_id),
		recipient_user_id: str(body.recipient_user_id),
		client_id,
		text: str(body.text),
		reply_to_message_id: str(body.reply_to_message_id),
		attachment_ids: id_list(body.attachment_ids),
		meta: attachments_meta(body.attachments_meta),
		files,
		poll: poll_request(body.poll),
		record_ref: record_ref(body.record_ref),
		view_once: flag(body.view_once) === true,
		confirm_mass_mention: flag(body.confirm_mass_mention) === true,
	};
}

const ROUTE_MAX = 500;
const LABEL_MAX = 160;
const LINKS_MAX = 20;
const LINK = /https?:\/\/[^\s<>()[\]{}"'`]+/gi;

/** `record_ref` de la petición; la ruta es una pantalla interna, como la de un pin del inicio. */
function record_ref(value: unknown): RecordRef | undefined {
	if (value == null || value === '') return undefined;
	const ref = as_object(json_field(value));
	const model_name = str(ref.model_name);
	const document_id = str(ref.document_id);
	const route = internal_route(ref.route, ROUTE_MAX);
	if (!model_name || !CHAT_ID.test(document_id) || !route) {
		throw invalid('La tarjeta del registro necesita el modelo, el documento y una ruta de esta aplicación.');
	}
	return { model_name, document_id, route };
}

/** La tarjeta de un registro que quien la envía puede leer; el nombre y el estado los pone el servidor. */
async function record_card(ctx: ChatCtx, ref: RecordRef): Promise<ImperiumDoc> {
	let resource: string | null;
	try {
		resource = await assert_target_record_read(ctx.store, ctx.actor, ref.model_name, ref.document_id);
	} catch (err) {
		if (err instanceof HttpAccessDeniedError) throw new ChatError(403, 'forbidden', 'No tienes permiso para hacer esto.');
		// Fuera de sus reglas responde igual que si no existiera: un 403 confirmaría que el id existe.
		if (err instanceof RecordRuleDeniedError) throw invalid('Ese registro ya no existe.');
		throw err;
	}
	const doc = resource ? await ctx.store.find_id(resource, ref.document_id) : null;
	// Los adjuntos y el historial del chat comparten tabla con lo demás y son privados aun para el administrador.
	if (!resource || !doc || doc.is_active === false || is_chat_row(resource, doc)) throw invalid('Ese registro ya no existe.');
	return defined({
		modelName: ref.model_name,
		documentId: ref.document_id,
		label: (str(doc.name) || ref.document_id).slice(0, LABEL_MAX),
		route: ref.route,
		status: str(doc.state) || str(doc.status) || undefined,
	});
}

/** Los enlaces del texto, para la galería, sin la puntuación con la que suele cerrar una frase. */
function text_links(text: string): string[] {
	return [...new Set((text.match(LINK) ?? []).map((link) => link.replace(/[.,;:!?]+$/, '')))].slice(0, LINKS_MAX);
}

function file_type(file: Blob): string {
	return (file.type || 'application/octet-stream').toLowerCase();
}

function mime_kind(mime: string): ChatAttachmentKind {
	if (mime.startsWith('image/')) return 'image';
	if (mime.startsWith('video/')) return 'video';
	if (mime.startsWith('audio/')) return 'audio';
	return 'file';
}

/**
 * `file` se manda tal cual; una imagen tiene que serlo. Bun deduce el tipo por la extensión
 * (`nota.webm` llega como `video/webm`, sin extensión no hay tipo), así que audio, voz y video
 * aceptan cualquier contenedor de audio o video o un tipo desconocido.
 */
function upload_kind(declared: unknown, mime: string): ChatAttachmentKind {
	const natural = mime_kind(mime);
	const kind = str(declared);
	if (!kind) return natural;
	if (!ATTACHMENT_KINDS.has(kind)) throw invalid();
	const media = natural === 'audio' || natural === 'video' || mime === 'application/octet-stream';
	if (kind === 'file' || (kind === 'image' ? natural === 'image' : media)) return kind as ChatAttachmentKind;
	throw new ChatError(415, 'upload_type_not_allowed', 'Ese tipo de archivo no se puede enviar.');
}

function assert_upload_size(file: Blob, settings: ChatSettings): void {
	if (file.size > settings.max_upload_mb * 1024 * 1024) {
		throw new ChatError(413, 'upload_too_large', `El archivo supera el máximo de ${settings.max_upload_mb} MB.`);
	}
}

/** Lo que el mensaje guarda de una subida (payload en camelCase). */
export function upload_info(row: ImperiumDoc, meta: AttachmentMeta = {}): ImperiumDoc {
	const upload = as_object(row.chatUpload);
	const mimetype = str(row.mimetype);
	return defined({
		attachmentId: str(row._id),
		name: str(row.name),
		fileExt: str(row.file_ext),
		mimetype,
		sizeInKb: Number(row.size_in_kb) || 0,
		isImage: mimetype.startsWith('image/'),
		kind: str(upload.kind) || mime_kind(mimetype),
		alt: meta.alt ?? upload.alt,
		decorative: meta.decorative ?? upload.decorative,
		caption: meta.caption,
		width: upload.width,
		height: upload.height,
		durationMs: upload.durationMs,
		peaks: upload.peaks,
	});
}

/** Sin `with_url`, el adjunto de "ver una vez": se abre con `POST /message/:id/open`. */
export function attachment_view(info: unknown, with_url = true): ImperiumDoc {
	const a = as_object(info);
	const id = str(a.attachmentId);
	const mimetype = str(a.mimetype);
	return defined({
		attachment_id: id,
		url: with_url ? `/api/media/${id}` : undefined,
		name: str(a.name),
		file_ext: str(a.fileExt),
		mimetype,
		size_kb: Number(a.sizeInKb) || 0,
		kind: str(a.kind) || (a.isImage === true ? 'image' : mime_kind(mimetype)),
		alt: a.alt,
		decorative: a.decorative,
		caption: a.caption,
		width: a.width,
		height: a.height,
		duration_ms: a.durationMs,
		peaks: a.peaks,
	});
}

function mentions_view(doc: ImperiumDoc): ImperiumDoc | undefined {
	const mentions = as_object(doc.mentions);
	const user_ids = as_array(mentions.userIds).map(String);
	if (!user_ids.length && mentions.all !== true && mentions.here !== true) return undefined;
	return { user_ids, all: mentions.all === true, here: mentions.here === true };
}

/** El evento de un mensaje de sistema; sus datos salen en snake_case, como el resto de la vista. */
function system_view(raw: unknown): ImperiumDoc {
	const system = as_object(raw);
	const data = system.data ? as_object(system.data) : null;
	return defined({
		type: str(system.type),
		actor_id: str(system.actorId) || null,
		target_ids: system.targetIds ? as_array(system.targetIds).map(String) : undefined,
		data: data
			? Object.fromEntries(Object.entries(data).map(([key, value]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), value]))
			: undefined,
	});
}

function reply_view(reply: ImperiumDoc): ImperiumDoc {
	return defined({
		message_id: str(reply.messageId),
		sender_name: str(reply.senderName),
		text_preview: reply.textPreview == null ? null : String(reply.textPreview),
		kind: str(reply.kind) || 'text',
		attachment_kind: reply.attachmentKind,
		deleted: reply.deleted === true,
	});
}

/** `ChatMessageView` (contrato §3.2) de un documento de `messages`, para `viewer_id`. */
function message_view(
	doc: ImperiumDoc,
	conversation_key: string,
	users: Map<string, UserBrief>,
	reactions: ImperiumDoc[] = [],
	tally?: ChatPollTally,
	viewer_id = '',
): ImperiumDoc {
	const sender_id = str(doc.sender_user_id);
	const user = users.get(sender_id);
	const guest = doc.guestSender ? as_object(doc.guestSender) : null;
	const reply = as_object(doc.replyPreview);
	const deleted = doc.deleted ? as_object(doc.deleted) : null;
	const poll = doc.poll ? as_object(doc.poll) : null;
	const forwarded = doc.forwardedFrom ? as_object(doc.forwardedFrom) : null;
	const card = doc.recordCard ? as_object(doc.recordCard) : null;
	const voice = doc.voice ? as_object(doc.voice) : null;
	const view_once = doc.viewOnce ? as_object(doc.viewOnce) : null;
	const story = doc.storyRef ? as_object(doc.storyRef) : null;
	const call = doc.call ? as_object(doc.call) : null;
	return defined({
		_id: str(doc._id),
		client_id: str(doc.client_id) || undefined,
		conversation_id: str(doc.conversation_id),
		conversation_key,
		seq: Number(doc.seq),
		rev: Number(doc.rev) || 0,
		kind: str(doc.kind) || 'text',
		sender: sender_id
			? defined({ _id: sender_id, name: user?.name || str(doc.senderName), img: user?.img })
			: guest
				? { guest: true, participant_key: str(guest.participantKey), name: str(guest.name) }
				: null,
		text: String(doc.message ?? ''),
		mentions: mentions_view(doc),
		reply_to: reply.messageId ? reply_view(reply) : undefined,
		forwarded: forwarded ? { sender_name: str(forwarded.senderName), at: str(forwarded.at) } : undefined,
		attachments: as_array(doc.attachments).map((info) => attachment_view(info, !view_once || sender_id === viewer_id)),
		voice: voice ? { duration_ms: Number(voice.durationMs) || 0, peaks: as_array(voice.peaks).map(Number) } : undefined,
		poll: poll && !deleted ? poll_view(message_poll(doc), tally) : undefined,
		record_card: card
			? defined({
					model_name: str(card.modelName),
					document_id: str(card.documentId),
					label: str(card.label),
					route: str(card.route),
					status: str(card.status) || undefined,
				})
			: undefined,
		call: call
			? defined({
					call_id: str(call.callId),
					kind: str(call.kind),
					media: str(call.media),
					outcome: str(call.outcome),
					duration_s: call.durationS == null ? undefined : Number(call.durationS),
					initiator_id: str(call.initiatorId),
				})
			: undefined,
		system: doc.system ? system_view(doc.system) : undefined,
		story_ref: story
			? defined({
					story_id: str(story.storyId),
					kind: str(story.kind),
					text_preview: str(story.textPreview) || undefined,
					expires_at: str(story.expiresAt),
					available: str(story.expiresAt) > new Date().toISOString(),
				})
			: undefined,
		edited_at: str(doc.editedAt) || undefined,
		edit_count: Number(doc.editCount) || undefined,
		deleted: deleted ? { at: str(deleted.at), by_role: str(deleted.byRole) } : undefined,
		expires_at: str(doc.expires_at) || undefined,
		view_once: view_once ? view_once_view(view_once, sender_id, viewer_id) : undefined,
		scheduled: doc.scheduled === true ? true : undefined,
		reactions: deleted ? [] : reactions,
		created_at: str(doc.created_at),
		updated_at: str(doc.updated_at),
	});
}

/**
 * Quien lo envió ve quién lo abrió y cuándo (en un directo, cuándo lo abrió el otro); los demás
 * solo si lo abrieron ellos, para que en un grupo nadie más sepa quién lo vio.
 */
function view_once_view(view_once: ImperiumDoc, sender_id: string, viewer_id: string): ImperiumDoc {
	const opened = as_array(view_once.openedByUserIds).map(String);
	if (!sender_id || sender_id !== viewer_id) return { opened: opened.includes(viewer_id) };
	const at = as_object(view_once.openedAt);
	return {
		opened: opened.length > 0,
		opened_by: opened.map((user_id) => defined({ user_id, at: str(at[user_id]) || undefined })),
	};
}

/** Minúsculas y sin diacríticos, como el respaldo y la búsqueda del chat. */
function fold(text: string): string {
	return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function search_text(parts: string[]): string | null {
	return fold(parts.filter(Boolean).join(' ')).trim() || null;
}

function live_features(conversation: ImperiumDoc, settings: ChatSettings): boolean {
	return (Number(conversation.memberCount) || 0) <= settings.live_features_max_members;
}

/** Quien no lo guardó comparte acuses: así lo hacían los 1:1 de antes. */
function shares_read_receipts(privacy: Record<string, unknown>): boolean {
	return privacy.read_receipts !== false;
}

/** Contrato §1.1: caduca según el ajuste de la conversación, solo si la organización permite temporales. */
function expiry_of(conversation: ImperiumDoc, settings: ChatSettings, now: number): string | null {
	const seconds = Number(as_object(conversation.settings).ephemeralSeconds) || 0;
	return settings.ephemeral_enabled && seconds > 0 ? new Date(now + seconds * 1000).toISOString() : null;
}

/** Contrato §1.1: una nota de voz lleva su duración (hasta 15 min) y su forma de onda de 64 picos. */
function assert_voice(upload: ImperiumDoc): void {
	const duration = Number(upload.durationMs);
	if (!(duration > 0 && duration <= VOICE_MAX_SECONDS * 1000) || as_array(upload.peaks).length !== PEAKS_MAX) {
		throw invalid('Una nota de voz necesita su duración y su forma de onda de 64 picos.');
	}
}

/** Contrato §3.8: ver una vez es para una sola foto o un solo video, sin nada más. */
function assert_view_once(request: SendRequest, picked: ImperiumDoc[]): void {
	const [upload] = picked;
	const kind = upload
		? str(as_object(upload.chatUpload).kind) || mime_kind(str(upload.mimetype))
		: request.files.length
			? mime_kind(file_type(request.files[0]!))
			: '';
	if (picked.length + request.files.length !== 1 || (kind !== 'image' && kind !== 'video') || request.poll || request.record_ref) {
		throw invalid('Ver una vez es para una sola foto o un solo video.');
	}
}

async function open_direct(ctx: ChatCtx, recipient_id: string, at: string): Promise<ImperiumDoc> {
	const uid = actor_id(ctx);
	if (!recipient_id) throw invalid('Debes indicar la conversación o el usuario destinatario del chat.');
	if (recipient_id !== uid) {
		const [user] = await ctx.store.chat_users_brief([recipient_id]);
		if (!user) throw new ChatError(404, 'user_not_found', 'No encontramos a esa persona.');
		if (!user.is_active) throw new ChatError(403, 'user_inactive', 'Esa persona ya no está activa.');
	}
	const user_ids = [...new Set([uid, recipient_id])].sort();
	return ctx.store.chat_open_direct({ conversation_key: user_ids.join('::'), user_ids, created_by: uid, now: at });
}

/** Los campos que leen los builds de escritorio y APK ya instalados (contrato §1.1). */
async function legacy_fields(ctx: ChatCtx, conversation: ImperiumDoc, at: string): Promise<ImperiumDoc> {
	const uid = actor_id(ctx);
	const participants = str(conversation.conversation_key).split('::').filter(Boolean);
	const others = participants.filter((id) => id !== uid);
	const users = new Map((await ctx.store.chat_users_brief(others)).map((user) => [user._id, user]));
	const me = defined({
		_id: uid,
		name: actor_name(ctx) || undefined,
		email: str(ctx.actor?.email) || undefined,
		img: str(ctx.actor?.img) || undefined,
	});
	const recipients = others.length ? others : [uid];
	const peer = users.get(recipients[0]!);
	return {
		title: (others.length ? peer?.name || peer?.email : me.name) || 'Chat interno',
		recipientUserIds: recipients,
		direction: 'internal',
		participantUserIds: participants,
		participantSnapshot: [
			me,
			...others.flatMap((id) => {
				const user = users.get(id);
				return user ? [defined({ _id: id, name: user.name || undefined, email: user.email, img: user.img })] : [];
			}),
		],
		conversationKey: str(conversation.conversation_key),
		readByUserIds: [uid],
		from: uid,
		to: recipients[0],
		fecha: at,
	};
}

/** Subidas propias de esta conversación que aún no se ligan a un mensaje (o siguen en su programado), en orden. */
async function pending_uploads(
	store: ImperiumStore,
	ids: string[],
	uid: string,
	conversation: ImperiumDoc,
	scheduled_id?: string,
): Promise<ImperiumDoc[]> {
	if (!ids.length) return [];
	const { rows } = await store.find_many('attachment-management', {
		ids,
		take: ids.length,
		populate: false,
		skip_total: true,
	});
	const by_id = new Map(rows.map((row) => [str(row._id), row]));
	return ids.map((id) => {
		const row = by_id.get(id);
		const bound = str(row?.related_record_id);
		if (
			!row ||
			str(row.created_by_id) !== uid ||
			str(as_object(row.chatUpload).conversationId) !== str(conversation._id) ||
			(bound && !(bound === scheduled_id && str(row.related_model) === 'ChatScheduled'))
		) {
			throw new ChatError(422, 'invalid_attachment', 'Uno de los archivos no es válido o ya no está disponible.');
		}
		return row;
	});
}

async function reply_preview(
	store: ImperiumStore,
	reply_id: string,
	conversation: ImperiumDoc,
	member: ImperiumDoc,
): Promise<ImperiumDoc> {
	const replied = CHAT_ID.test(reply_id) ? await store.find_id('messages', reply_id) : null;
	if (
		!replied ||
		replied.is_active === false ||
		str(replied.conversation_id) !== str(conversation._id) ||
		Number(replied.seq) <= (Number(member.visibleFromSeq) || 0)
	) {
		throw invalid('El mensaje que intentas responder no pertenece a esta conversación.');
	}
	const first = as_object(as_array(replied.attachments)[0]);
	return defined({
		messageId: str(replied._id),
		senderUserId: str(replied.sender_user_id),
		senderName: str(replied.senderName),
		textPreview: String(replied.message ?? '').slice(0, 160),
		kind: str(replied.kind) || 'text',
		attachmentKind: first.attachmentId ? str(attachment_view(first).kind) : undefined,
	});
}

/** Contrato §10: el modo lento responde 429 `slow_mode` y no gasta la cuota de envío. */
function slow_mode(conversation: ImperiumDoc, member: ImperiumDoc, uid: string, now: number): Response | null {
	const settings = as_object(conversation.settings);
	const seconds = Number(settings.slowModeSeconds) || 0;
	if (seconds <= 0 || chat_can(chat_role(member.role), settings, 'skip_slow_mode')) return null;
	const slot = take_token(`chat-slow:${str(conversation._id)}:${uid}`, { capacity: 1, refill_per_s: 1 / seconds }, now);
	if (slot.ok) return null;
	return rate_limited_response(
		slot.retry_after_s,
		'slow_mode',
		`Modo lento: espera ${slot.retry_after_s} s para volver a escribir.`,
	);
}

/** Fuera del historial de documentos: el nombre del archivo también es parte del chat. */
function persist_chat_upload(store: ImperiumStore, file: Blob, uid: string, chat_upload: ImperiumDoc) {
	return outside_history_context(() =>
		persist_upload_as_attachment(store, file, {
			actor_id: uid,
			related_model: 'Message',
			related_record_id: '',
			field: 'attachments',
			index_if_is_array: 0,
			inside_array: true,
			chat_upload,
		}),
	);
}

/** Un reenvío comparte el archivo: del disco sale solo el que ya ninguna fila del chat usa. */
export async function remove_unused_files(store: ImperiumStore, names: string[]): Promise<void> {
	const in_use = await store.chat_files_in_use(names);
	for (const name of new Set(names)) {
		if (!name || in_use.has(name)) continue;
		for (const folder of resolve_upload_folders()) {
			const path = upload_file_path(folder, name);
			if (path && existsSync(path)) unlinkSync(path);
		}
	}
}

async function discard_uploads(store: ImperiumStore, rows: ImperiumDoc[]): Promise<void> {
	for (const row of rows) {
		const stored = str(row.name_stored);
		for (const folder of resolve_upload_folders()) {
			const path = stored ? upload_file_path(folder, stored) : null;
			if (path && existsSync(path)) unlinkSync(path);
		}
		await outside_history_context(() => store.remove('attachment-management', str(row._id)));
	}
}

async function store_files(
	store: ImperiumStore,
	files: Blob[],
	uid: string,
	conversation: ImperiumDoc,
): Promise<ImperiumDoc[]> {
	const stored: ImperiumDoc[] = [];
	try {
		for (const file of files) {
			stored.push(
				await persist_chat_upload(store, file, uid, {
					ownerUserId: uid,
					conversationId: str(conversation._id),
					kind: mime_kind(file_type(file)),
				}),
			);
		}
	} catch (err) {
		await discard_uploads(store, stored);
		throw err;
	}
	return stored;
}

/** Después de escribir en Postgres: el delta a los miembros y lo que esperan los builds viejos. */
async function publish_message(
	store: ImperiumStore,
	conversation: ImperiumDoc,
	message: ImperiumDoc,
	view: ImperiumDoc,
	settings: ChatSettings,
): Promise<void> {
	const conversation_id = str(conversation._id);
	const message_id = str(message._id);
	const seq = Number(message.seq);
	const members = await store.chat_member_ids(conversation_id);
	const delta = { conversation_id, op: 'message', seq, message_id, message: view };
	emit_to_users(members, 'update', { action: 'chat_delta', data: [delta] });
	emit_to_meeting_guests(conversation_id, [{ seq, delta }]);
	// Un build viejo no sabe pintar los mensajes del servidor.
	if (DIRECT_KINDS.has(str(conversation.kind)) && !(CHAT_SERVER_KINDS as readonly string[]).includes(str(message.kind))) {
		emit_messages_refresh(members, {
			reason: 'created',
			conversation_key: str(conversation.conversation_key),
			message_ids: [message_id],
			message: legacy_doc(message, ''),
		});
	}
	const online = online_user_ids();
	const reached = members.filter((id) => id !== str(message.sender_user_id) && online.has(id));
	const delivered = await store.chat_mark_delivered(conversation_id, reached, seq);
	if (delivered.length && live_features(conversation, settings)) {
		emit_to_users(members, 'update', {
			action: 'chat_delta',
			data: delivered.map((user_id) => ({ conversation_id, op: 'delivered', user_id, seq })),
		});
	}
}

function sent_response(ctx: ChatCtx, conversation: ImperiumDoc, message: ImperiumDoc, legacy: boolean) {
	if (str(message.conversation_id) !== str(conversation._id)) {
		throw invalid('Ese client_id ya se usó en otra conversación.');
	}
	const uid = actor_id(ctx);
	const view = message_view(message, str(conversation.conversation_key), new Map([[uid, actor_brief(ctx)]]), [], undefined, uid);
	return ok([legacy ? legacy_doc(message, uid) : view], SENT);
}

export async function create_chat_message(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const request = send_request(ctx.body);
	const now = new Date();
	const at = now.toISOString();
	const conversation = request.conversation_id
		? await find_chat_conversation(ctx.store, request.conversation_id)
		: await open_direct(ctx, request.recipient_user_id, at);
	const member = await assert_chat_member(ctx.store, conversation, uid);
	if (request.client_id) {
		const existing = await ctx.store.chat_message_by_client_id(uid, request.client_id);
		if (existing) return sent_response(ctx, conversation, existing, request.legacy);
	}
	const attachment_count = request.attachment_ids.length + request.files.length;
	const { poll } = request;
	assert_can_send(conversation, member, {
		attachments: attachment_count > 0 || Boolean(request.record_ref),
		poll: Boolean(poll),
		now: now.getTime(),
	});
	if (!request.text && !attachment_count && !poll && !request.record_ref) {
		throw invalid('Debes escribir un mensaje o adjuntar al menos un archivo.');
	}
	assert_text_length(request.text);
	if (attachment_count > MAX_ATTACHMENTS) {
		throw new ChatError(422, 'too_many_attachments', `Puedes enviar hasta ${MAX_ATTACHMENTS} archivos por mensaje.`);
	}
	for (const file of request.files) assert_upload_size(file, settings);
	const picked = await pending_uploads(ctx.store, request.attachment_ids, uid, conversation, ctx.scheduled_id);
	if (request.view_once) assert_view_once(request, picked);
	const reply = request.reply_to_message_id
		? await reply_preview(ctx.store, request.reply_to_message_id, conversation, member)
		: undefined;
	const mention = await plan_mentions(ctx, conversation, member, request.text, {
		confirmed: request.confirm_mass_mention,
		threshold: settings.mass_mention_threshold,
	});
	const card = request.record_ref ? await record_card(ctx, request.record_ref) : undefined;
	const slow = slow_mode(conversation, member, uid, now.getTime());
	if (slow) return slow;
	const allowed = take_token(`chat-send:${uid}`, SEND_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const stored = await store_files(ctx.store, request.files, uid, conversation);
	const infos = [
		...picked.map((row) => upload_info(row, request.meta.get(str(row._id)))),
		...stored.map((row) => upload_info(row)),
	];
	const kind = ctx.story_ref
		? 'story-reply'
		: poll
			? 'poll'
			: infos.length === 1 && infos[0]!.kind === 'voice'
				? 'voice'
				: infos.length
					? 'media'
					: card
						? 'record'
						: 'text';
	const poll_texts = poll ? [str(poll.question), ...as_array(poll.options).map((option) => str(as_object(option).text))] : [];
	const links = text_links(request.text);
	const id = new_id();
	const sender_name = actor_name(ctx);
	const legacy = DIRECT_KINDS.has(str(conversation.kind)) ? await legacy_fields(ctx, conversation, at) : {};
	let result: Awaited<ReturnType<ImperiumStore['chat_insert_message']>>;
	try {
		result = await ctx.store.chat_insert_message({
			id,
			conversation_id: str(conversation._id),
			sender_user_id: uid,
			client_id: request.client_id,
			kind,
			name: str(legacy.title) || str(conversation.name),
			search_field: search_text([request.text, ...infos.map((info) => str(info.name)), ...poll_texts, str(card?.label)]),
			payload: defined({
				...legacy,
				message: request.text,
				senderUserId: uid,
				senderName: sender_name,
				senderEmail: str(ctx.actor?.email) || undefined,
				sourceType: 'chat',
				conversationId: str(conversation._id),
				rev: 0,
				replyToMessageId: reply ? request.reply_to_message_id : undefined,
				replyPreview: reply,
				attachments: infos.length ? infos : undefined,
				voice: kind === 'voice' ? { durationMs: infos[0]!.durationMs, peaks: infos[0]!.peaks } : undefined,
				viewOnce: request.view_once ? { openedByUserIds: [] } : undefined,
				storyRef: ctx.story_ref,
				poll,
				recordCard: card,
				links: links.length ? links : undefined,
				mentions: mention.mentions,
				scheduled: ctx.scheduled_id ? true : undefined,
			}),
			preview: defined({
				messageId: id,
				senderId: uid,
				senderName: sender_name,
				kind,
				textPreview: (request.text || str(poll?.question) || str(card?.label)).slice(0, 160),
				at,
				attachmentKind: infos[0]?.kind,
			}),
			expires_at: expiry_of(conversation, settings, now.getTime()),
			share_read: shares_read_receipts(await ctx.store.chat_privacy(uid)),
			attachment_ids: infos.map((info) => str(info.attachmentId)),
			uploads_from: ctx.scheduled_id,
			now: at,
		});
	} catch (err) {
		await discard_uploads(ctx.store, stored);
		throw err;
	}
	if (!result || result.duplicate) await discard_uploads(ctx.store, stored);
	if (!result) throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	if (result.duplicate) return sent_response(ctx, conversation, result.message, request.legacy);
	const users = new Map([[uid, actor_brief(ctx)]]);
	const key = str(conversation.conversation_key);
	const view = message_view(result.message, key, users, [], undefined, uid);
	// Lo de "ver una vez" no lleva url a nadie, tampoco a los demás dispositivos de quien lo envía.
	const broadcast = request.view_once ? message_view(result.message, key, users) : view;
	await publish_message(ctx.store, conversation, result.message, broadcast, settings);
	await register_mentions(ctx, conversation, result.message, mention.recipients, str(reply?.senderUserId));
	return ok([request.legacy ? legacy_doc(result.message, uid) : view], SENT);
}

function upload_response(row: ImperiumDoc, conversation: ImperiumDoc, client_upload_id: string) {
	if (str(as_object(row.chatUpload).conversationId) !== str(conversation._id)) {
		throw invalid('Ese client_upload_id ya se usó en otra conversación.');
	}
	return ok([{ ...attachment_view(upload_info(row)), client_upload_id }], 'Archivo listo para enviar.');
}

/** Un archivo por petición; se liga al mensaje cuando se envía con `attachment_ids`. */
export async function create_chat_upload(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.body.conversation_id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	assert_can_send(conversation, member, { attachments: true, now: Date.now() });
	const client_upload_id = str(ctx.body.client_upload_id);
	if (!UUID.test(client_upload_id)) throw invalid('Falta el identificador de la subida (client_upload_id).');
	const existing = await ctx.store.chat_upload_by_client_id(uid, client_upload_id);
	if (existing) return upload_response(existing, conversation, client_upload_id);
	const file = ctx.body.file;
	if (!is_upload(file)) throw invalid('Sube un archivo por petición en el campo file.');
	assert_upload_size(file, settings);
	const chat_upload = defined({
		ownerUserId: uid,
		conversationId: str(conversation._id),
		clientUploadId: client_upload_id,
		kind: upload_kind(ctx.body.kind, file_type(file)),
		alt: meta_text(ctx.body.alt),
		decorative: flag(ctx.body.decorative),
		durationMs: whole(ctx.body.duration_ms),
		peaks: peaks(ctx.body.peaks),
		width: whole(ctx.body.width),
		height: whole(ctx.body.height),
	});
	if (chat_upload.kind === 'voice') assert_voice(chat_upload);
	const allowed = take_token(`chat-upload:${uid}`, UPLOAD_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	try {
		return upload_response(await persist_chat_upload(ctx.store, file, uid, chat_upload), conversation, client_upload_id);
	} catch (err) {
		const raced = is_unique_violation(err) ? await ctx.store.chat_upload_by_client_id(uid, client_upload_id) : null;
		if (!raced) throw err;
		return upload_response(raced, conversation, client_upload_id);
	}
}

export async function delete_chat_upload(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const id = str(ctx.params.attachmentId);
	const row = CHAT_ID.test(id) ? await ctx.store.find_id('attachment-management', id) : null;
	if (!row || row.is_active === false || !row.chatUpload || str(row.created_by_id) !== actor_id(ctx)) {
		throw new ChatError(404, 'upload_not_found', 'No encontramos ese archivo subido.');
	}
	if (str(row.related_record_id)) {
		throw new ChatError(409, 'upload_bound', 'El archivo ya se envió y no se puede quitar.');
	}
	await discard_uploads(ctx.store, [row]);
	return ok([], 'Archivo quitado.');
}

const PAGE_LIMIT = { fallback: 50, max: 100 };
const INBOX_LIMIT = { fallback: 40, max: 100 };
const LEGACY_PAGE = { fallback: 250, max: 500 };
const LEGACY_INBOX_MAX = 100;
const PINNED_MAX = 100;
const SYNC_NEW_MAX = 100;
const SYNC_CHANGED_MAX = 200;
const MENTION_SEQS_MAX = 20;
const INBOX_FILTERS = new Set<string>(['all', 'unread', 'mentions', 'direct', 'groups', 'archived']);
const CONVERSATION_KINDS = new Set<string>(['direct', 'self', 'group', 'channel', 'meeting']);
const LEGACY_THREAD = 'Historial del chat cargado correctamente.';

function seq_param(url: URL, key: string): number | undefined {
	const raw = url.searchParams.get(key);
	if (raw == null || raw === '') return undefined;
	const n = Number(raw);
	if (!Number.isSafeInteger(n) || n < 0) throw invalid();
	return n;
}

function limit_param(url: URL, key: string, bounds: { fallback: number; max: number }): number {
	return Math.min(seq_param(url, key) || bounds.fallback, bounds.max);
}

function iso_param(url: URL, key: string): string | undefined {
	const raw = str(url.searchParams.get(key));
	if (!raw) return undefined;
	const at = Date.parse(raw);
	if (!Number.isFinite(at)) throw invalid();
	return new Date(at).toISOString();
}

/**
 * Lo que cambió desde `changed_since` se lee con margen: una edición o una lectura se fecha al
 * empezar su petición y confirma después, y el cliente descarta lo repetido por `rev` o `seq`.
 */
const CHANGED_SINCE_MARGIN_MS = 5_000;

function changed_since_param(url: URL): string | undefined {
	const since = iso_param(url, 'changed_since');
	return since && new Date(Date.parse(since) - CHANGED_SINCE_MARGIN_MS).toISOString();
}

/** Los extras van en la raíz, como hermanos de `data` (contrato §0.2). */
function page_response(data: unknown[], message: string, extras: Record<string, unknown> = {}) {
	return { ...ok(data, message), ...extras, server_time: new Date().toISOString() };
}

/**
 * Remitentes, reacciones y votos de una página: una consulta cada uno. `key_of` da la llave de la
 * conversación de cada fila: una búsqueda junta varias.
 */
async function message_views(
	ctx: ChatCtx,
	rows: ImperiumDoc[],
	key_of: (row: ImperiumDoc) => string,
): Promise<ImperiumDoc[]> {
	return views_for(ctx.store, actor_id(ctx), rows, key_of);
}

/** `viewer_id`: el usuario, o `g:<id>` de un invitado, para sus reacciones y votos propios. */
async function views_for(
	store: ImperiumStore,
	viewer_id: string,
	rows: ImperiumDoc[],
	key_of: (row: ImperiumDoc) => string,
): Promise<ImperiumDoc[]> {
	if (!rows.length) return [];
	const users = new Map(
		(await store.chat_users_brief(rows.map((row) => str(row.sender_user_id)))).map((user) => [user._id, user]),
	);
	const reactions = await store.chat_reaction_summary(
		rows.map((row) => str(row._id)),
		viewer_id,
	);
	const tallies = await store.chat_poll_tally(
		rows.filter((row) => row.poll && !row.deleted).map((row) => str(row._id)),
		viewer_id,
	);
	return rows.map((row) =>
		message_view(row, key_of(row), users, reactions.get(str(row._id)), tallies.get(str(row._id)), viewer_id),
	);
}

/** `members` solo con funciones en vivo; los acuses son recíprocos: quien no comparte, no ve. */
async function read_state(ctx: ChatCtx, conversation: ImperiumDoc, member: ImperiumDoc, settings: ChatSettings) {
	const state = { my_last_read_seq: Number(member.last_read_seq) || 0 };
	if (!live_features(conversation, settings)) return state;
	const uid = actor_id(ctx);
	const sees_reads = shares_read_receipts(await ctx.store.chat_privacy(uid));
	const marks = await ctx.store.chat_read_marks(str(conversation._id));
	return {
		...state,
		members: marks.map((mark) => ({
			user_id: mark.user_id,
			public_read_seq: sees_reads || mark.user_id === uid ? mark.public_read_seq : 0,
			delivered_seq: mark.delivered_seq,
		})),
	};
}

/** Contrato §4.1: una página por `seq`, ascendente. Nunca marca leído. */
export async function read_message_page(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.conversationId));
	const member = await assert_chat_member(ctx.store, conversation, actor_id(ctx));
	const limit = limit_param(ctx.url, 'limit', PAGE_LIMIT);
	const page = {
		conversation_id: str(conversation._id),
		visible_from: Number(member.visibleFromSeq) || 0,
		viewer_id: actor_id(ctx),
	};
	let around = seq_param(ctx.url, 'around_seq');
	const around_id = str(ctx.url.searchParams.get('around_message_id'));
	if (around_id) {
		const target = CHAT_ID.test(around_id) ? await ctx.store.find_id('messages', around_id) : null;
		if (
			!target ||
			target.is_active === false ||
			str(target.conversation_id) !== page.conversation_id ||
			Number(target.seq) <= page.visible_from ||
			hidden_for(target, page.viewer_id)
		) {
			throw message_not_found();
		}
		around = Number(target.seq);
	}
	const before = seq_param(ctx.url, 'before_seq');
	const after = seq_param(ctx.url, 'after_seq');
	let rows: ImperiumDoc[];
	let has_more_before: boolean;
	let has_more_after: boolean;
	if (around !== undefined) {
		const half = Math.floor(limit / 2);
		const older = await ctx.store.chat_message_page({ ...page, direction: 'before', seq: around, limit: half });
		const newer = await ctx.store.chat_message_page({ ...page, direction: 'from', seq: around, limit: limit - half });
		rows = [...older.rows, ...newer.rows];
		has_more_before = older.more;
		has_more_after = newer.more;
	} else if (after !== undefined) {
		const newer = await ctx.store.chat_message_page({ ...page, direction: 'after', seq: after, limit });
		rows = newer.rows;
		has_more_before = after > page.visible_from;
		has_more_after = newer.more;
	} else if (before !== undefined) {
		const older = await ctx.store.chat_message_page({ ...page, direction: 'before', seq: before, limit });
		rows = older.rows;
		has_more_before = older.more;
		has_more_after = before <= (Number(conversation.last_seq) || 0);
	} else {
		const tail = await ctx.store.chat_message_page({ ...page, direction: 'tail', limit });
		rows = tail.rows;
		has_more_before = tail.more;
		has_more_after = false;
	}
	return page_response(await message_views(ctx, rows, () => str(conversation.conversation_key)), 'Mensajes cargados.', {
		has_more_before,
		has_more_after,
		read_state: await read_state(ctx, conversation, member, settings),
	});
}

/** Resincronización (contrato §11): lo nuevo después de `after_seq` y lo cambiado desde `changed_since`. */
export async function read_message_sync(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.conversationId));
	const member = await assert_chat_member(ctx.store, conversation, actor_id(ctx));
	const page = {
		conversation_id: str(conversation._id),
		visible_from: Number(member.visibleFromSeq) || 0,
		viewer_id: actor_id(ctx),
	};
	const after_seq = seq_param(ctx.url, 'after_seq') ?? 0;
	const since = changed_since_param(ctx.url);
	const fresh = await ctx.store.chat_message_page({ ...page, direction: 'after', seq: after_seq, limit: SYNC_NEW_MAX });
	const changed = since
		? await ctx.store.chat_changed_messages({ ...page, up_to_seq: after_seq, since, limit: SYNC_CHANGED_MAX })
		: { rows: [], more: false };
	return page_response(
		[
			{
				new_messages: await message_views(ctx, fresh.rows, () => str(conversation.conversation_key)),
				changed_messages: await message_views(ctx, changed.rows, () => str(conversation.conversation_key)),
				read_state: await read_state(ctx, conversation, member, settings),
				last_seq: Number(conversation.last_seq) || 0,
				has_more: fresh.more || changed.more,
			},
		],
		'Conversación sincronizada.',
	);
}

const SETTINGS_VIEW: Record<string, string> = {
	announcementOnly: 'announcement_only',
	slowModeSeconds: 'slow_mode_seconds',
	membersCanInvite: 'members_can_invite',
	membersCanPin: 'members_can_pin',
	membersCanEditInfo: 'members_can_edit_info',
	membersCanCall: 'members_can_call',
	membersCanMentionAll: 'members_can_mention_all',
	ephemeralSeconds: 'ephemeral_seconds',
	historyVisibleToNewMembers: 'history_visible_to_new_members',
};

function settings_view(raw: unknown): ImperiumDoc {
	const settings: ImperiumDoc = { ...DIRECT_CONVERSATION_SETTINGS, ...as_object(raw) };
	return Object.fromEntries(Object.entries(SETTINGS_VIEW).map(([camel, snake]) => [snake, settings[camel]]));
}

function prefs_view(member: ImperiumDoc): ImperiumDoc {
	const draft = member.draft ? as_object(member.draft) : null;
	return defined({
		muted_until: member.mutedUntil,
		pinned_order: member.pinnedOrder,
		archived: member.archived === true,
		folder: member.folder,
		wallpaper: member.wallpaper,
		sound: member.sound,
		nickname: member.nickname,
		notify_level: str(member.notifyLevel) || 'default',
		draft: draft
			? defined({ text: String(draft.text ?? ''), reply_to_message_id: draft.replyToMessageId, updated_at: draft.updatedAt })
			: (member.draft as null | undefined),
	});
}

function last_message_view(raw: unknown): ImperiumDoc | undefined {
	const last = as_object(raw);
	if (!last.messageId) return undefined;
	return defined({
		message_id: str(last.messageId),
		seq: Number(last.seq) || 0,
		sender_id: str(last.senderId) || null,
		sender_name: str(last.senderName),
		kind: str(last.kind) || 'text',
		text_preview: String(last.textPreview ?? ''),
		at: str(last.at),
		attachment_kind: last.attachmentKind,
		deleted: last.deleted === true ? true : undefined,
	});
}

function user_brief(user: ChatUserBrief): ImperiumDoc {
	return defined({ _id: user._id, name: user.name, email: user.email, img: user.img });
}

function peer_id(conversation: ImperiumDoc, uid: string): string | undefined {
	if (str(conversation.kind) !== 'direct') return undefined;
	return str(conversation.conversation_key)
		.split('::')
		.find((id) => id !== uid);
}

/** Los `peer` de una página salen en una consulta (sin N+1). */
async function peers_of(ctx: ChatCtx, rows: ChatInboxRow[]): Promise<Map<string, ChatUserBrief>> {
	const uid = actor_id(ctx);
	const ids = rows.flatMap((row) => peer_id(row.conversation, uid) ?? []);
	return new Map((await ctx.store.chat_users_brief(ids)).map((user) => [user._id, user]));
}

function active_call_view(raw: unknown): ImperiumDoc | undefined {
	const call = as_object(raw);
	if (!call.callId) return undefined;
	return { call_id: str(call.callId), media: str(call.media), participant_count: Number(call.participantCount) || 0 };
}

/** `ChatConversationView` (contrato §3.3) para quien la pide. */
function conversation_view(
	ctx: ChatCtx,
	row: ChatInboxRow,
	users: Map<string, ChatUserBrief>,
	settings: ChatSettings,
): ImperiumDoc {
	const { conversation, member } = row;
	const kind = str(conversation.kind);
	const peer = users.get(peer_id(conversation, actor_id(ctx)) ?? '');
	return defined({
		_id: str(conversation._id),
		conversation_key: str(conversation.conversation_key),
		kind,
		title: kind === 'direct' ? (peer?.name ?? '') : kind === 'self' ? actor_name(ctx) : str(conversation.name),
		description: str(conversation.description) || undefined,
		avatar_attachment_id: str(conversation.avatarAttachmentId) || undefined,
		peer: peer ? user_brief(peer) : undefined,
		meeting_id: str(conversation.meetingId) || undefined,
		member_count: Number(conversation.memberCount) || 0,
		my_role: chat_role(member.role),
		joined_at: str(member.joinedAt),
		visible_from_seq: Number(member.visibleFromSeq) || 0,
		last_seq: Number(conversation.last_seq) || 0,
		last_message_at: str(conversation.last_message_at) || undefined,
		last_message: last_message_view(conversation.lastMessage),
		my_last_read_seq: Number(member.last_read_seq) || 0,
		unread_count: row.unread_count,
		unread_mentions: row.unread_mention_seqs.length,
		unread_mention_seqs: row.unread_mention_seqs.slice(0, MENTION_SEQS_MAX),
		marked_unread: member.markedUnread === true,
		prefs: prefs_view(member),
		settings: settings_view(conversation.settings),
		live_features: live_features(conversation, settings),
		active_call: active_call_view(conversation.activeCall),
		updated_at: [str(conversation.updated_at), str(member.updated_at)].sort().at(-1),
	});
}

function removed_view(row: ChatInboxRow): ImperiumDoc {
	const reason = row.conversation.is_active === false ? 'deleted' : str(row.member.state);
	return { _id: str(row.conversation._id), removed: true, reason };
}

function is_listed_active(row: ChatInboxRow): boolean {
	return str(row.member.state) === 'active' && row.conversation.is_active !== false;
}

function chat_cursor(raw: string): { at: string; id: string } {
	const cursor = decode_cursor(raw);
	if (!cursor.id) throw invalid_cursor();
	return cursor;
}

/** Lo listado ya llegó: entregado en lote y, con funciones en vivo, su delta a los miembros. */
async function deliver_listed(ctx: ChatCtx, rows: ChatInboxRow[], settings: ChatSettings): Promise<void> {
	const listed = rows.filter(is_listed_active);
	const live = new Set(
		listed.filter((row) => live_features(row.conversation, settings)).map((row) => str(row.conversation._id)),
	);
	const uid = actor_id(ctx);
	const moved = await ctx.store.chat_mark_inbox_delivered(
		uid,
		listed.map((row) => str(row.conversation._id)),
	);
	for (const { conversation_id, seq, member_ids } of moved) {
		if (!live.has(conversation_id)) continue;
		emit_to_users(member_ids, 'update', {
			action: 'chat_delta',
			data: [{ conversation_id, op: 'delivered', user_id: uid, seq }],
		});
	}
}

/** Contrato §4.2: la bandeja; las fijadas primero en la página sin cursor y `counts` solo ahí. */
export async function list_my_conversations(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const params = ctx.url.searchParams;
	const filter = str(params.get('filter')) || 'all';
	const kind = str(params.get('kind'));
	if (!INBOX_FILTERS.has(filter) || (kind && !CONVERSATION_KINDS.has(kind))) throw invalid();
	const raw_cursor = str(params.get('cursor'));
	const cursor = raw_cursor ? chat_cursor(raw_cursor) : undefined;
	const changed_since = changed_since_param(ctx.url);
	const limit = limit_param(ctx.url, 'limit', INBOX_LIMIT);
	const uid = actor_id(ctx);
	const query = {
		user_id: uid,
		filter: filter as ChatInboxFilter,
		kinds: kind ? [kind] : undefined,
		folder: str(params.get('folder')) || undefined,
		changed_since,
	};
	const pinned =
		cursor || changed_since ? [] : await ctx.store.chat_conversation_page({ ...query, pinned: true, limit: PINNED_MAX });
	const page = await ctx.store.chat_conversation_page({
		...query,
		pinned: changed_since ? undefined : false,
		cursor,
		limit: limit + 1,
	});
	const rows = page.slice(0, limit);
	const last = rows.at(-1)!;
	const listed = [...pinned, ...rows];
	const users = await peers_of(ctx, listed);
	const views = listed.map((row) =>
		is_listed_active(row) ? conversation_view(ctx, row, users, settings) : removed_view(row),
	);
	await deliver_listed(ctx, listed, settings);
	return page_response(views, 'Conversaciones cargadas.', {
		next_cursor: page.length > limit ? encode_cursor(last.activity_at, str(last.conversation._id)) : null,
		...(cursor ? {} : { counts: await ctx.store.chat_inbox_counts(uid, new Date().toISOString()) }),
	});
}

async function own_row(ctx: ChatCtx, id = str(ctx.params.id)): Promise<ChatInboxRow> {
	const conversation = await find_chat_conversation(ctx.store, id);
	const [row] = await ctx.store.chat_conversation_page({
		user_id: actor_id(ctx),
		conversation_ids: [str(conversation._id)],
		limit: 1,
	});
	if (!row) throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
	return row;
}

export async function read_conversation_summary(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const row = await own_row(ctx);
	return ok([conversation_view(ctx, row, await peers_of(ctx, [row]), settings)], 'Conversación cargada.');
}

/**
 * Los fijados vigentes con su vista previa, solo los que quien pide (con su fila de miembro)
 * alcanza desde su `visibleFromSeq` y no ocultó; los mensajes y quien fijó salen en una consulta cada uno.
 */
async function pins_view(ctx: ChatCtx, conversation: ImperiumDoc, member: ImperiumDoc): Promise<ImperiumDoc[]> {
	const visible_from = Number(member.visibleFromSeq) || 0;
	const viewer = actor_id(ctx);
	const now = new Date().toISOString();
	const pins = as_array(conversation.pins)
		.map(as_object)
		.filter((pin) => !pin.expiresAt || str(pin.expiresAt) > now);
	if (!pins.length) return [];
	const ids = pins.map((pin) => str(pin.messageId));
	const { rows } = await ctx.store.find_many('messages', { ids, take: ids.length, populate: false, skip_total: true });
	const messages = new Map(rows.map((message) => [str(message._id), message]));
	const users = new Map(
		(await ctx.store.chat_users_brief(pins.map((pin) => str(pin.pinnedById)))).map((user) => [user._id, user]),
	);
	return pins.flatMap((pin) => {
		const message = messages.get(str(pin.messageId));
		const by = users.get(str(pin.pinnedById));
		if (
			!message ||
			!by ||
			str(message.conversation_id) !== str(conversation._id) ||
			Number(message.seq) <= visible_from ||
			hidden_for(message, viewer)
		) {
			return [];
		}
		return [
			{
				message_id: str(message._id),
				seq: Number(message.seq),
				pinned_by: user_brief(by),
				pinned_at: str(pin.pinnedAt),
				expires_at: pin.expiresAt ? str(pin.expiresAt) : null,
				preview: {
					sender_name: str(message.senderName),
					text_preview: String(message.message ?? '').slice(0, 160),
					kind: str(message.kind) || 'text',
				},
			},
		];
	});
}

export async function read_conversation_detail(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const row = await own_row(ctx);
	return ok(
		[
			{
				...conversation_view(ctx, row, await peers_of(ctx, [row]), settings),
				pins: await pins_view(ctx, row.conversation, row.member),
				...(await invites_and_requests(ctx, row)),
				read_state: await read_state(ctx, row.conversation, row.member, settings),
			},
		],
		'Conversación cargada.',
	);
}

/** `ChatConfigView` (contrato §3.4), sin secretos. Responde aunque la mensajería esté apagada. */
export async function read_chat_config(ctx: ChatCtx): Promise<unknown> {
	const settings = await chat_settings(ctx.store);
	return page_response(
		[
			{
				api_version: 2,
				messaging_enabled: settings.messaging_enabled,
				edit_window_minutes: settings.edit_window_minutes,
				delete_for_all_window_minutes: settings.delete_for_all_window_minutes,
				max_upload_mb: settings.max_upload_mb,
				max_attachments: MAX_ATTACHMENTS,
				voice_max_seconds: VOICE_MAX_SECONDS,
				text_max_chars: TEXT_MAX_CHARS,
				read_receipts: 'optional',
				typing_indicator: 'optional',
				presence_last_seen: 'approximate',
				group_creation: 'everyone',
				live_features_max_members: settings.live_features_max_members,
				max_group_members: settings.max_group_members,
				max_pinned_messages: settings.max_pinned_messages,
				mass_mention_threshold: settings.mass_mention_threshold,
				ephemeral_enabled: settings.ephemeral_enabled,
				ephemeral_options_seconds: [86400, 604800, 7776000],
				legal_hold: settings.legal_hold,
				user_customization: { bubble_colors: true, wallpapers: true, wallpaper_upload: true },
				features: {
					polls: true,
					scheduled: true,
					saved: true,
					stories: settings.stories_enabled,
					calls: settings.calls_enabled,
					meetings: settings.calls_enabled,
					guests: settings.guests_enabled,
					recording: settings.recording_enabled,
					captions_cloud: settings.captions_cloud_allowed,
				},
				calls: {
					mesh_max: settings.mesh_max,
					class_max: settings.class_max,
					ring_timeout_seconds: settings.ring_timeout_seconds,
					sfu_available: sfu_available(),
					turn_configured: turn_configured(),
				},
			},
		],
		'Configuración del chat.',
	);
}

/** Contrato §8: solo directos y self, en la forma heredada, con los no leídos de las marcas de agua. */
export async function read_my_conversations(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const rows = (
		await ctx.store.chat_conversation_page({ user_id: uid, kinds: ['direct', 'self'], limit: LEGACY_INBOX_MAX })
	).filter((row) => as_object(row.conversation.lastMessage).messageId);
	// Un build viejo no sabe pintar un mensaje de sistema: tras uno, la bandeja muestra el último de una persona.
	const after_server = (row: ChatInboxRow) => SERVER_KINDS.has(str(as_object(row.conversation.lastMessage).kind));
	const latest_ids = rows.filter((row) => !after_server(row)).map((row) => str(as_object(row.conversation.lastMessage).messageId));
	const latest = latest_ids.length
		? (
				await ctx.store.find_many('messages', {
					ids: latest_ids,
					take: latest_ids.length,
					include_inactive: true,
					populate: false,
					skip_total: true,
				})
			).rows
		: [];
	const by_id = new Map(latest.map((doc) => [str(doc._id), doc]));
	const by_conversation = new Map(
		(await ctx.store.chat_latest_user_messages(rows.filter(after_server).map((row) => str(row.conversation._id)))).map(
			(doc) => [str(doc.conversation_id), doc],
		),
	);
	const participants = (row: ChatInboxRow) => str(row.conversation.conversation_key).split('::');
	const users = new Map((await ctx.store.chat_users_brief(rows.flatMap(participants))).map((user) => [user._id, user]));
	return ok(
		rows.flatMap((row) => {
			const latest_message = after_server(row)
				? by_conversation.get(str(row.conversation._id))
				: by_id.get(str(as_object(row.conversation.lastMessage).messageId));
			if (!latest_message) return [];
			const ids = participants(row);
			const other = ids.find((id) => id !== uid) ?? uid;
			return [
				{
					conversation_key: str(row.conversation.conversation_key),
					participant_user_ids: ids,
					other_participant: { _id: other, name: users.get(other)?.name || other },
					latest_message: legacy_doc(latest_message, uid),
					unread_count: row.unread_count,
				},
			];
		}),
		'Conversaciones cargadas correctamente.',
	);
}

/**
 * Lo que leen los builds de escritorio y APK ya instalados (`MessageRecord`). Lo demás del documento
 * (la respuesta de un cuestionario, el correo de quien envía, los campos internos) no sale.
 */
const LEGACY_FIELDS = [
	'_id',
	'id',
	'title',
	'name',
	'message',
	'senderUserId',
	'senderName',
	'recipientUserIds',
	'direction',
	'sourceType',
	'participantUserIds',
	'participantSnapshot',
	'conversationKey',
	'conversationId',
	'conversation_id',
	'seq',
	'rev',
	'kind',
	'replyToMessageId',
	'replyPreview',
	'attachments',
	'readByUserIds',
	'relatedTicketId',
	'from',
	'to',
	'fecha',
	'editedAt',
	'deleted',
	'is_active',
	'createdAt',
	'updatedAt',
	'created_at',
	'updated_at',
];

/** El documento de las rutas heredadas: lo que cada quien hizo con el mensaje solo se ve para sí. */
function legacy_doc(doc: ImperiumDoc, uid: string): ImperiumDoc {
	const own = (ids: unknown) => as_array(ids).map(String).filter((id) => id === uid);
	return defined({
		...Object.fromEntries(LEGACY_FIELDS.filter((key) => key in doc).map((key) => [key, doc[key]])),
		hiddenForUserIds: doc.hiddenForUserIds === undefined ? undefined : own(doc.hiddenForUserIds),
		viewOnce: doc.viewOnce ? legacy_view_once(as_object(doc.viewOnce), own, uid) : undefined,
	});
}

/** Solo la apertura propia, con su hora; las de los demás no salen por las rutas heredadas. */
function legacy_view_once(view_once: ImperiumDoc, own: (ids: unknown) => string[], uid: string): ImperiumDoc {
	const at = as_object(view_once.openedAt)[uid];
	return defined({
		...view_once,
		openedByUserIds: own(view_once.openedByUserIds),
		openedAt: view_once.openedAt === undefined ? undefined : at === undefined ? {} : { [uid]: at },
	});
}

/**
 * Los acuses heredados salen de las marcas públicas: quien envió, quien lee ahora y quien ya leyó.
 * Son recíprocos: sin compartir los propios (`marks` vacío) no se ven los de los demás.
 */
function legacy_readers(doc: ImperiumDoc, uid: string, marks: ChatReadMarks[]): string[] {
	const seq = Number(doc.seq);
	const readers = marks.filter((mark) => mark.public_read_seq >= seq).map((mark) => mark.user_id);
	return [...new Set([str(doc.sender_user_id), uid, ...readers].filter(Boolean))];
}

/**
 * Contrato §8: la página más reciente en forma de documento. Sigue marcando leído, por marca de
 * agua, para los builds de escritorio y APK que no conocen `POST /read`.
 */
export async function read_conversation(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const other = str(ctx.params.participantId ?? ctx.url.searchParams.get('participant_id'));
	if (!other) throw invalid('Debes indicar el participante del chat.');
	const conversation_key = [...new Set([uid, other])].sort().join('::');
	const conversation = await ctx.store.find_where('chat-conversations', { conversation_key });
	if (!conversation || conversation.is_active === false) return ok([], LEGACY_THREAD);
	const member = await assert_chat_member(ctx.store, conversation, uid);
	const conversation_id = str(conversation._id);
	const { rows } = await ctx.store.chat_message_page({
		conversation_id,
		visible_from: Number(member.visibleFromSeq) || 0,
		viewer_id: uid,
		limit: limit_param(ctx.url, 'size', LEGACY_PAGE),
		direction: 'tail',
		user_only: true,
	});
	const marks = shares_read_receipts(await ctx.store.chat_privacy(uid)) ? await ctx.store.chat_read_marks(conversation_id) : [];
	await read_up_to(ctx, conversation, member, Number(conversation.last_seq) || 0, settings);
	return ok(
		rows.map((doc) => ({ ...legacy_doc(doc, uid), readByUserIds: legacy_readers(doc, uid, marks) })),
		LEGACY_THREAD,
	);
}

/**
 * Contrato §5.4: el lector ve su marca en sus otros dispositivos; los demás miembros, con
 * funciones en vivo, su marca pública, salvo quien no comparte acuses (son recíprocos).
 */
async function publish_read(
	ctx: ChatCtx,
	conversation: ImperiumDoc,
	previous_public: number,
	result: ChatReadResult,
	settings: ChatSettings,
): Promise<void> {
	const conversation_id = str(conversation._id);
	const uid = actor_id(ctx);
	emit_to_users([uid], 'update', {
		action: 'chat_delta',
		data: [
			{
				conversation_id,
				op: 'read',
				user_id: uid,
				seq: result.last_read_seq,
				patch: {
					last_read_seq: result.last_read_seq,
					unread_count: Math.max(result.last_seq - result.last_read_seq, 0),
					unread_mentions: result.mention_seqs.length,
					marked_unread: false,
				},
			},
		],
	});
	if (result.public_read_seq <= previous_public || !live_features(conversation, settings)) return;
	const others = (await ctx.store.chat_member_ids(conversation_id)).filter((id) => id !== uid);
	const hidden = await ctx.store.chat_receipts_off(others);
	emit_to_users(
		others.filter((id) => !hidden.has(id)),
		'update',
		{ action: 'chat_delta', data: [{ conversation_id, op: 'read', user_id: uid, seq: result.public_read_seq }] },
	);
}

async function read_up_to(
	ctx: ChatCtx,
	conversation: ImperiumDoc,
	member: ImperiumDoc,
	seq: number,
	settings: ChatSettings,
): Promise<ChatReadResult> {
	const uid = actor_id(ctx);
	const previous_public = Number(member.public_read_seq) || 0;
	const result = await ctx.store.chat_mark_read({
		conversation_id: str(conversation._id),
		user_id: uid,
		seq,
		share_read: shares_read_receipts(await ctx.store.chat_privacy(uid)),
		now: new Date().toISOString(),
	});
	if (!result) throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
	await publish_read(ctx, conversation, previous_public, result, settings);
	return result;
}

/** Contrato §4.2: la única forma de marcar leído en la API nueva. */
export async function mark_conversation_read(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	const seq = whole(ctx.body.seq);
	if (seq === undefined) throw invalid('Indica hasta qué mensaje se leyó (seq).');
	const allowed = take_token(`chat-read:${uid}`, READ_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const result = await read_up_to(ctx, conversation, member, seq, settings);
	return ok(
		[
			{
				last_read_seq: result.last_read_seq,
				public_read_seq: result.public_read_seq,
				unread_count: Math.max(result.last_seq - result.last_read_seq, 0),
				unread_mentions: result.mention_seqs.length,
			},
		],
		'Conversación leída.',
	);
}

export async function mark_conversation_unread(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	const allowed = take_token(`chat-read:${uid}`, READ_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const conversation_id = str(conversation._id);
	if (!(await ctx.store.chat_mark_unread(conversation_id, uid, new Date().toISOString()))) {
		throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
	}
	emit_to_users([uid], 'update', {
		action: 'chat_delta',
		data: [
			{
				conversation_id,
				op: 'read',
				user_id: uid,
				seq: Number(member.last_read_seq) || 0,
				patch: { marked_unread: true },
			},
		],
	});
	return ok([{ marked_unread: true }], 'Conversación marcada como no leída.');
}

const EDIT_RATE = { capacity: 30, refill_per_s: 30 / 60 };
const GROUP_KINDS = new Set(['group', 'channel', 'meeting']);
/** Los escribe el servidor: nadie los edita ni los borra para todos. */
const SERVER_KINDS = new Set<string>(CHAT_SERVER_KINDS);
const REVISIONS_MAX = 50;

function message_not_found(): ChatError {
	return new ChatError(404, 'message_not_found', 'No encontramos ese mensaje.');
}

function message_gone(): ChatError {
	return new ChatError(410, 'message_gone', 'Este mensaje se borró o caducó.');
}

function role_required(): ChatError {
	return new ChatError(403, 'role_required', 'Tu rol en esta conversación no permite esta acción.');
}

function not_sender(): ChatError {
	return new ChatError(403, 'not_sender', 'Solo quien envió el mensaje puede hacer esto.');
}

function hidden_for(message: ImperiumDoc, uid: string): boolean {
	return as_array(message.hiddenForUserIds).map(String).includes(uid);
}

/** Sigue siendo miembro activo, el mensaje cae en lo que ve y no lo ocultó para sí. */
async function still_sees(store: ImperiumStore, message: ImperiumDoc, user_id: string): Promise<boolean> {
	const member = await find_member(store, str(message.conversation_id), user_id);
	return member?.state === 'active' && Number(message.seq) > (Number(member.visibleFromSeq) || 0) && !hidden_for(message, user_id);
}

/** `minutes` en `null`: el parámetro está en 0, sin límite. */
function window_closed(message: ImperiumDoc, minutes: number | null, now: number): boolean {
	return minutes !== null && Date.parse(str(message.created_at)) + minutes * 60_000 < now;
}

function assert_live(message: ImperiumDoc): void {
	const expired = Boolean(message.expires_at) && str(message.expires_at) <= new Date().toISOString();
	if (message.is_active === false || message.deleted || expired) throw message_gone();
}

type MessageTarget = { message: ImperiumDoc; conversation: ImperiumDoc; member: ImperiumDoc };

/** El mensaje de `/message/:id`, si quien lo pide lo ve: miembro activo, desde su `visibleFromSeq` y sin ocultarlo. */
async function message_target(ctx: ChatCtx): Promise<MessageTarget> {
	const id = str(ctx.params.id);
	const message = CHAT_ID.test(id) ? await ctx.store.find_id('messages', id) : null;
	if (!message || !str(message.conversation_id)) throw message_not_found();
	const conversation = await find_chat_conversation(ctx.store, str(message.conversation_id));
	const member = await assert_chat_member(ctx.store, conversation, actor_id(ctx));
	if (Number(message.seq) <= (Number(member.visibleFromSeq) || 0) || hidden_for(message, actor_id(ctx))) {
		throw message_not_found();
	}
	return { message, conversation, member };
}

/** Un invitado sin cuenta no tiene fila de miembro; quien salió conserva su rol. */
async function sender_role(store: ImperiumStore, conversation_id: string, message: ImperiumDoc): Promise<ChatRole> {
	const sender = str(message.sender_user_id);
	if (!sender) return 'guest';
	const { rows } = await store.find_many('chat-members', {
		where: { conversation_id, user_id: sender },
		take: 1,
		populate: false,
		skip_total: true,
	});
	return chat_role(rows[0]?.role);
}

/** `message_updated` a los miembros, con lo que el cambio arrastra: las citas y la vista previa de la bandeja. */
async function publish_change(
	store: ImperiumStore,
	conversation: ImperiumDoc,
	change: ChatMessageChange,
	patch: ImperiumDoc,
): Promise<void> {
	const conversation_id = str(conversation._id);
	const { message } = change;
	const updated = (seq: number, message_id: string, patch: ImperiumDoc): { seq: number; delta: ImperiumDoc } => ({
		seq,
		delta: { conversation_id, op: 'message_updated', seq, message_id, patch },
	});
	const deltas: Array<{ seq: number; delta: ImperiumDoc; hidden_for?: unknown }> = [
		{
			...updated(Number(message.seq), str(message._id), {
				...patch,
				rev: Number(message.rev) || 0,
				updated_at: str(message.updated_at),
			}),
			hidden_for: message.hiddenForUserIds,
		},
		...change.quoting.map((quote) =>
			updated(quote.seq, quote.id, { reply_to: reply_view(quote.reply_preview), rev: quote.rev, updated_at: quote.updated_at }),
		),
	];
	if (change.last_message) {
		deltas.push({
			seq: Number(change.last_message.seq),
			delta: { conversation_id, op: 'conversation', patch: { last_message: last_message_view(change.last_message) } },
		});
	}
	await emit_seen_deltas(store, conversation_id, deltas);
}

/** Lo que caducó deja de verse: `removed` por mensaje, las citas sin texto y la vista previa de la bandeja. */
/** Lo que caducó, anunciado a quien veía cada mensaje (desde su `visibleFromSeq`), como cualquier cambio. */
export async function publish_expired(store: ImperiumStore, purge: ChatPurge): Promise<void> {
	const deltas = new Map<string, Array<{ seq: number; delta: ImperiumDoc }>>();
	const add = (conversation_id: string, seq: number, delta: ImperiumDoc) =>
		deltas.set(conversation_id, [...(deltas.get(conversation_id) ?? []), { seq, delta: { conversation_id, ...delta } }]);
	for (const row of purge.purged) add(row.conversation_id, row.seq, { op: 'removed', message_id: row.id, patch: { reason: 'deleted' } });
	for (const quote of purge.quoting) {
		add(quote.conversation_id, quote.seq, {
			op: 'message_updated',
			seq: quote.seq,
			message_id: quote.id,
			patch: { reply_to: reply_view(quote.reply_preview), rev: quote.rev, updated_at: quote.updated_at },
		});
	}
	for (const last of purge.last_messages) {
		const view = last_message_view(last.last_message);
		// Sin último mensaje la bandeja queda vacía para todos.
		add(last.conversation_id, Number(view?.seq) || Number.POSITIVE_INFINITY, { op: 'conversation', patch: { last_message: view } });
	}
	for (const [conversation_id, list] of deltas) await emit_seen_deltas(store, conversation_id, list);
	for (const row of purge.purged) await retire_chat_activity(store, { message_id: row.id });
}

/** Contrato §4.1: solo quien lo envió y dentro de la ventana; la auditoría guarda el antes. */
export async function edit_chat_message(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { message, conversation, member } = await message_target(ctx);
	assert_live(message);
	if (str(message.sender_user_id) !== uid) throw not_sender();
	if (!chat_can(chat_role(member.role), as_object(conversation.settings), 'edit_own')) throw role_required();
	const now = new Date();
	assert_can_send(conversation, member, { attachments: false, now: now.getTime() });
	if (SERVER_KINDS.has(str(message.kind)) || str(message.kind) === 'poll') {
		throw invalid('Este mensaje no se puede editar.');
	}
	if (typeof ctx.body.text !== 'string') throw invalid('Escribe el nuevo texto del mensaje (text).');
	const text = ctx.body.text.trim();
	assert_text_length(text);
	const attachments = as_array(message.attachments).map(as_object);
	if (!text && !attachments.length) throw invalid('Un mensaje sin archivos no puede quedar vacío; bórralo.');
	if (window_closed(message, settings.edit_window_minutes, now.getTime())) {
		throw new ChatError(403, 'edit_window_closed', 'Ya pasó el tiempo para editar este mensaje.');
	}
	if (text === String(message.message ?? '')) {
		return ok(await message_views(ctx, [message], () => str(conversation.conversation_key)), 'Mensaje editado.');
	}
	const mention = await plan_mentions(ctx, conversation, member, text, {
		confirmed: flag(ctx.body.confirm_mass_mention) === true,
		threshold: settings.mass_mention_threshold,
		previous: as_object(message.mentions),
	});
	const allowed = take_token(`chat-edit:${uid}`, EDIT_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const change = await ctx.store.chat_edit_message({
		id: str(message._id),
		text,
		search_field: search_text([text, ...attachments.map((info) => str(info.name))]),
		merge: { mentions: mention.mentions ?? { userIds: [], all: false, here: false }, links: text_links(text) },
		audit_id: new_id(),
		actor_id: uid,
		preview: text.slice(0, 160),
		now: now.toISOString(),
	});
	if (!change) throw message_gone();
	const edited = change.message;
	await publish_change(ctx.store, conversation, change, {
		text,
		mentions: mentions_view(edited) ?? { user_ids: [], all: false, here: false },
		edited_at: str(edited.editedAt),
		edit_count: Number(edited.editCount),
	});
	const kept = as_object(mention.mentions);
	if (!kept.all && !kept.here) {
		await ctx.store.chat_drop_mention_seq(str(conversation._id), Number(edited.seq), as_array(kept.userIds).map(String));
	}
	await register_mentions(ctx, conversation, edited, mention.recipients);
	return ok(await message_views(ctx, [edited], () => str(conversation.conversation_key)), 'Mensaje editado.');
}

/**
 * Contrato §4.1 y §9: `me` lo oculta solo para quien lo pide; `all` deja lápida y auditoría.
 * Lo propio, dentro de la ventana; lo ajeno (o lo propio fuera de ella), solo quien modera a su
 * autor en un grupo, canal o reunión.
 */
export async function delete_chat_message(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const scope = str(ctx.url.searchParams.get('scope'));
	if (scope !== 'me' && scope !== 'all') throw invalid('Indica si lo borras para ti o para todos (scope=me|all).');
	const uid = actor_id(ctx);
	const { message, conversation, member } = await message_target(ctx);
	const role = chat_role(member.role);
	const conversation_settings = as_object(conversation.settings);
	const conversation_id = str(conversation._id);
	const message_id = str(message._id);
	if (scope === 'me') {
		if (message.is_active === false) throw message_gone();
		if (!chat_can(role, conversation_settings, 'hide')) throw role_required();
		const allowed = take_token(`chat-edit:${uid}`, EDIT_RATE);
		if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
		if (await ctx.store.chat_hide_message(message_id, uid)) {
			emit_to_users([uid], 'update', {
				action: 'chat_delta',
				data: [{ conversation_id, op: 'removed', message_id, patch: { reason: 'hidden' } }],
			});
		}
		return ok([{ _id: message_id, scope }], 'Mensaje borrado para ti.');
	}
	assert_live(message);
	if (SERVER_KINDS.has(str(message.kind))) throw role_required();
	const own = str(message.sender_user_id) === uid;
	const target = own ? role : await sender_role(ctx.store, conversation_id, message);
	const moderates =
		GROUP_KINDS.has(str(conversation.kind)) && chat_can(role, conversation_settings, 'delete_others', target);
	if (!own && !moderates) throw role_required();
	if (own && !chat_can(role, conversation_settings, 'delete_own')) throw role_required();
	const now = new Date();
	if (own && !moderates && window_closed(message, settings.delete_for_all_window_minutes, now.getTime())) {
		throw new ChatError(403, 'delete_window_closed', 'Ya pasó el tiempo para borrar este mensaje para todos.');
	}
	const allowed = take_token(`chat-edit:${uid}`, EDIT_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const at = now.toISOString();
	const by_role = own ? 'sender' : 'moderator';
	const change = await ctx.store.chat_delete_message({
		id: message_id,
		deleted: { at, byUserId: uid, byRole: by_role },
		audit_id: new_id(),
		actor_id: uid,
		action: own ? 'delete' : 'delete_moderator',
		target_user_id: own ? null : str(message.sender_user_id) || null,
		now: at,
	});
	if (!change) throw message_gone();
	await publish_change(ctx.store, conversation, change, {
		text: '',
		attachments: [],
		reactions: [],
		deleted: { at, by_role },
	});
	await retire_chat_activity(ctx.store, { message_id });
	return ok([{ _id: message_id, scope }], 'Mensaje borrado para todos.');
}

/**
 * Contrato §4.1: leído y entregado por las marcas de agua (las listas solo con funciones en vivo)
 * y las versiones anteriores. Quien no comparte acuses tampoco ve quién leyó.
 */
export async function read_message_info(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { message, conversation, member } = await message_target(ctx);
	assert_live(message);
	const sender_id = str(message.sender_user_id);
	if (sender_id !== uid && !chat_can(chat_role(member.role), as_object(conversation.settings), 'read_any_info')) {
		throw not_sender();
	}
	const conversation_id = str(conversation._id);
	const receipts = await ctx.store.chat_message_receipts(conversation_id, Number(message.seq), sender_id || null);
	const sees_reads = shares_read_receipts(await ctx.store.chat_privacy(uid));
	const read_ids = sees_reads ? receipts.read_ids : [];
	const live = live_features(conversation, settings);
	const users = live
		? new Map((await ctx.store.chat_users_brief([...read_ids, ...receipts.delivered_ids])).map((user) => [user._id, user]))
		: new Map<string, ChatUserBrief>();
	const briefs = (ids: string[]) => ids.flatMap((id) => (users.has(id) ? [user_brief(users.get(id)!)] : []));
	const { rows } = await ctx.store.find_many('chat-audit', {
		where: { conversation_id, message_id: str(message._id), action: 'edit' },
		sort: 'created_at:asc',
		take: REVISIONS_MAX,
		populate: false,
		skip_total: true,
	});
	return ok(
		[
			defined({
				read_by: live ? briefs(read_ids) : undefined,
				delivered_to: live ? briefs(receipts.delivered_ids) : undefined,
				read_count: sees_reads ? receipts.read_count : 0,
				delivered_count: receipts.delivered_count,
				member_count: receipts.member_count,
				revisions: rows.map((row) => ({ at: str(row.created_at), text: String(as_object(row.before).text ?? '') })),
			}),
		],
		'Información del mensaje.',
	);
}

const REACT_RATE = { capacity: 60, refill_per_s: 1 };
const VOTE_RATE = { capacity: 30, refill_per_s: 30 / 60 };
const REACTIONS_PER_USER = 20;
const REACTORS_LIMIT = { fallback: 50, max: 100 };
const POLL_QUESTION_MAX = 300;
const POLL_OPTION_MAX = 100;
const POLL_OPTIONS = { min: 2, max: 12 };
const QUIZ_EXPLANATION_MAX = 500;
const POLL_CLOSES_MAX_MS = 365 * 24 * 3600_000;
const POLL_RESULTS = new Set(['always', 'after_vote', 'after_close']);
const GRAPHEMES = new Intl.Segmenter('es', { granularity: 'grapheme' });

/**
 * Un solo grafema que sea emoji. El que se escribe sin el selector de presentación (U+FE0F) se
 * guarda con él, para que «❤» y «❤️» cuenten como la misma reacción.
 */
export function reaction_emoji(value: unknown): string {
	const emoji = typeof value === 'string' ? value.trim() : '';
	const single = emoji.length <= 32 && [...GRAPHEMES.segment(emoji)].length === 1;
	const keycap = /^[0-9#*]️?⃣$/u.test(emoji);
	if (!single || !(keycap || /\p{Extended_Pictographic}/u.test(emoji) || /^\p{Regional_Indicator}{2}$/u.test(emoji))) {
		throw new ChatError(422, 'invalid_emoji', 'Esa reacción no es válida.');
	}
	if (keycap) return `${emoji[0]}️⃣`;
	if ([...emoji].length === 1 && !/\p{Emoji_Presentation}/u.test(emoji)) return `${emoji}️`;
	return emoji;
}

function poll_invalid(): ChatError {
	return new ChatError(422, 'poll_invalid', 'Revisa la encuesta: necesita pregunta y de 2 a 12 opciones.');
}

function poll_closed(): ChatError {
	return new ChatError(409, 'poll_closed', 'La encuesta ya está cerrada.');
}

function poll_invalid_choice(message = 'Esa opción no es válida para esta encuesta.'): ChatError {
	return new ChatError(422, 'poll_invalid_choice', message);
}

/** La encuesta de `ChatSendRequest` (contrato §3.8) como se guarda; las opciones ganan id. */
function poll_request(value: unknown): ImperiumDoc | undefined {
	if (value == null || value === '') return undefined;
	const poll = json_field(value);
	if (!poll || typeof poll !== 'object' || Array.isArray(poll)) throw poll_invalid();
	const input = poll as Record<string, unknown>;
	const question = typeof input.question === 'string' ? input.question.trim() : '';
	const texts = Array.isArray(input.options)
		? input.options.map((option) => (typeof option === 'string' ? option.trim() : ''))
		: [];
	if (
		!question ||
		question.length > POLL_QUESTION_MAX ||
		texts.length < POLL_OPTIONS.min ||
		texts.length > POLL_OPTIONS.max ||
		texts.some((text) => !text || text.length > POLL_OPTION_MAX) ||
		new Set(texts.map((text) => text.toLowerCase())).size !== texts.length
	) {
		throw poll_invalid();
	}
	const multiple = input.multiple === true;
	const results = input.results ?? 'always';
	if (typeof results !== 'string' || !POLL_RESULTS.has(results)) throw poll_invalid();
	const max_choices = input.max_choices == null ? undefined : Number(input.max_choices);
	const fits = (n: number) => multiple && Number.isInteger(n) && n >= 1 && n <= texts.length;
	if (max_choices !== undefined && !fits(max_choices)) throw poll_invalid();
	let closes_at: string | undefined;
	if (input.closes_at != null && input.closes_at !== '') {
		const at = Date.parse(String(input.closes_at));
		if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + POLL_CLOSES_MAX_MS) throw poll_invalid();
		closes_at = new Date(at).toISOString();
	}
	let quiz: ImperiumDoc | undefined;
	if (input.quiz != null) {
		const raw = as_object(input.quiz);
		const index = Number(raw.correct_option_index);
		const explanation = raw.explanation == null ? undefined : String(raw.explanation).trim();
		if (multiple || !Number.isInteger(index) || index < 0 || index >= texts.length) throw poll_invalid();
		if (explanation && explanation.length > QUIZ_EXPLANATION_MAX) throw poll_invalid();
		quiz = defined({ correctOptionId: `o${index + 1}`, explanation: explanation || undefined });
	}
	return defined({
		question,
		options: texts.map((text, index) => ({ id: `o${index + 1}`, text })),
		multiple,
		maxChoices: max_choices,
		anonymous: input.anonymous === true,
		results,
		closesAt: closes_at,
		quiz,
	});
}

/** Cerrada a mano o porque ya pasó `closesAt`. */
function poll_closed_at(poll: ImperiumDoc): string | undefined {
	if (poll.closedAt) return str(poll.closedAt);
	const closes = str(poll.closesAt);
	return closes && closes <= new Date().toISOString() ? closes : undefined;
}

/**
 * `PollView` (contrato §3.2) para quien lo ve: conteos solo si los resultados ya se muestran,
 * votantes solo si además no es anónima, y la respuesta de un cuestionario tras votar o cerrar.
 */
function poll_view(poll: ImperiumDoc, tally?: ChatPollTally): ImperiumDoc {
	const closed_at = poll_closed_at(poll);
	const counts = tally?.options ?? new Map<string, { votes: number; mine: boolean; voter_ids: string[] }>();
	const options = as_array(poll.options).map(as_object);
	const voted = options.some((option) => counts.get(str(option.id))?.mine);
	const results = str(poll.results) || 'always';
	const visible = results === 'always' || Boolean(closed_at) || (results === 'after_vote' && voted);
	const anonymous = poll.anonymous === true;
	const quiz = poll.quiz ? as_object(poll.quiz) : null;
	return defined({
		question: str(poll.question),
		multiple: poll.multiple === true,
		max_choices: poll.maxChoices,
		anonymous,
		results,
		closes_at: poll.closesAt,
		closed_at,
		total_voters: tally?.total_voters ?? 0,
		results_visible: visible,
		options: options.map((option) => {
			const count = counts.get(str(option.id));
			return defined({
				id: str(option.id),
				text: str(option.text),
				votes: visible ? (count?.votes ?? 0) : undefined,
				mine: count?.mine === true,
				voter_ids: visible && !anonymous ? (count?.voter_ids ?? []) : undefined,
			});
		}),
		quiz: quiz
			? voted || closed_at
				? defined({ correct_option_id: quiz.correctOptionId, explanation: quiz.explanation })
				: {}
			: undefined,
	});
}

/**
 * Lo que el delta de una encuesta lleva a todos (contrato §5.4): conteos solo si los resultados
 * son siempre visibles o ya cerró; si no, solo `total_voters` y `closed_at`. Nada propio de quien lo ve.
 */
function poll_broadcast(poll: ImperiumDoc, tally?: ChatPollTally): ImperiumDoc {
	const view = poll_view(poll, tally);
	const closed_at = view.closed_at;
	if (str(poll.results || 'always') !== 'always' && !closed_at) {
		return defined({ total_voters: view.total_voters, closed_at });
	}
	return defined({
		...view,
		results_visible: undefined,
		options: as_array(view.options).map((option) => ({ ...as_object(option), mine: undefined })),
		quiz: closed_at ? view.quiz : undefined,
	});
}

function poll_of(message: ImperiumDoc): ImperiumDoc {
	if (!message.poll) throw invalid('Ese mensaje no es una encuesta.');
	return message_poll(message);
}

/**
 * La encuesta del mensaje. La copia reenviada de un cuestionario lleva `quizFrom` cuando puede
 * conservar la respuesta (la reenvió su autor o el original ya había cerrado); una copia sin esa
 * marca, de antes de la regla, va sin respuesta: si no, quien la reenvió a su propio chat la leería
 * en el CSV, al cerrarla o al votarla y contestaría bien el original.
 */
function message_poll(message: ImperiumDoc): ImperiumDoc {
	const poll = as_object(message.poll);
	if (!message.forwardedFrom || !poll.quiz || poll.quizFrom) return poll;
	const { quiz: _hidden, ...rest } = poll;
	return rest;
}

/** La copia que se reenvía se reabre; la respuesta del cuestionario solo viaja según `message_poll`. */
function forwarded_poll(source: ImperiumDoc, uid: string): ImperiumDoc {
	const poll = message_poll(source);
	const { closesAt: _closes, closedAt: _closed, quiz, quizFrom: _from, ...rest } = poll;
	const quiz_from = !quiz ? undefined : str(source.sender_user_id) === uid ? 'author' : poll_closed_at(poll) ? 'closed' : undefined;
	return defined({ ...rest, ...(quiz_from ? { quiz, quizFrom: quiz_from } : {}) });
}

async function publish_poll(
	store: ImperiumStore,
	message: ImperiumDoc,
	poll: ImperiumDoc,
	change: { rev: number; updated_at: string },
	tally?: ChatPollTally,
): Promise<void> {
	const conversation_id = str(message.conversation_id);
	const seq = Number(message.seq);
	await emit_seen_deltas(store, conversation_id, [
		{
			seq,
			delta: {
				conversation_id,
				op: 'message_updated',
				seq,
				message_id: str(message._id),
				patch: { poll: poll_broadcast(poll, tally), rev: change.rev, updated_at: change.updated_at },
			},
			hidden_for: message.hiddenForUserIds,
		},
	]);
}

/** Contrato §4.1: sin `on` conmuta; hasta 20 emojis distintos por persona y mensaje. */
export async function toggle_chat_reaction(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { message, conversation, member } = await message_target(ctx);
	assert_live(message);
	if (!chat_can(chat_role(member.role), as_object(conversation.settings), 'react')) throw role_required();
	const emoji = reaction_emoji(ctx.body.emoji);
	const on = flag(ctx.body.on);
	const allowed = take_token(`chat-react:${uid}`, REACT_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const message_id = str(message._id);
	const result = await ctx.store.chat_toggle_reaction({
		message_id,
		user_id: uid,
		emoji,
		on,
		limit: REACTIONS_PER_USER,
		now: new Date().toISOString(),
	});
	if (!result) throw message_gone();
	if (result.limited) throw new ChatError(422, 'reaction_limit', 'Llegaste al máximo de reacciones en este mensaje.');
	if (result.changed) {
		const conversation_id = str(conversation._id);
		const members = await ctx.store.chat_member_ids(conversation_id);
		await emit_seen_deltas(ctx.store, conversation_id, [
			{
				seq: Number(message.seq),
				delta: {
					conversation_id,
					op: 'reaction',
					message_id,
					user_id: uid,
					patch: { emoji, op: result.mine ? 'add' : 'remove', count: result.count, rev: result.rev },
				},
				hidden_for: message.hiddenForUserIds,
			},
		]);
		const author = str(message.sender_user_id);
		if (!result.mine) {
			await retire_chat_activity(ctx.store, { message_id, context_type: 'chat-reaction', actor_id: uid, reaction: emoji });
		} else if (author !== uid && members.includes(author)) {
			await register_chat_activity(ctx.store, ctx.actor, [
				{
					user_id: author,
					context_type: 'chat-reaction',
					conversation_id,
					conversation_title: group_title_of(conversation),
					message_id,
					excerpt: String(message.message ?? ''),
					reaction: emoji,
				},
			]);
		}
	}
	return ok([{ emoji, count: result.count, mine: result.mine, rev: result.rev }], 'Reacción guardada.');
}

/** Quién reaccionó, en el orden en que lo hizo; los votos de una encuesta nunca salen aquí. */
export async function read_message_reactions(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const { message } = await message_target(ctx);
	assert_live(message);
	const raw_emoji = str(ctx.url.searchParams.get('emoji'));
	const raw_cursor = str(ctx.url.searchParams.get('cursor'));
	const limit = limit_param(ctx.url, 'limit', REACTORS_LIMIT);
	const { rows } = await ctx.store.find_many('chat-reactions', {
		where: { message_id: str(message._id), kind: 'emoji', value: raw_emoji ? reaction_emoji(raw_emoji) : undefined },
		sort: 'created_at:asc',
		after_created: raw_cursor ? chat_cursor(raw_cursor) : undefined,
		take: limit + 1,
		populate: false,
		skip_total: true,
	});
	const page = rows.slice(0, limit);
	const users = new Map((await ctx.store.chat_users_brief(page.map((row) => str(row.user_id)))).map((user) => [user._id, user]));
	const last = page.at(-1);
	return page_response(
		page.flatMap((row) => {
			const user = users.get(str(row.user_id));
			return user ? [{ emoji: str(row.value), user: user_brief(user), at: str(row.created_at) }] : [];
		}),
		'Reacciones cargadas.',
		{ next_cursor: rows.length > limit && last ? encode_cursor(str(last.created_at), str(last._id)) : null },
	);
}

/** Contrato §4.1: vale el último voto y `[]` lo retira; un cuestionario no cambia de respuesta. */
export async function vote_chat_poll(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { message, conversation, member } = await message_target(ctx);
	assert_live(message);
	if (!chat_can(chat_role(member.role), as_object(conversation.settings), 'vote')) throw role_required();
	const poll = poll_of(message);
	if (poll_closed_at(poll)) throw poll_closed();
	if (!Array.isArray(ctx.body.option_ids)) throw invalid('Indica las opciones que eliges (option_ids).');
	const option_ids = id_list(ctx.body.option_ids);
	const valid = new Set(as_array(poll.options).map((option) => str(as_object(option).id)));
	const max = poll.multiple === true ? Number(poll.maxChoices) || valid.size : 1;
	if (option_ids.some((id) => !valid.has(id)) || option_ids.length > max) throw poll_invalid_choice();
	if (poll.quiz && !option_ids.length) throw poll_invalid_choice('En un cuestionario la respuesta no se retira.');
	const allowed = take_token(`chat-vote:${uid}`, VOTE_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const message_id = str(message._id);
	const result = await ctx.store.chat_replace_votes({
		message_id,
		user_id: uid,
		option_ids,
		final: Boolean(poll.quiz),
		now: new Date().toISOString(),
	});
	if (!result) throw poll_closed();
	if (result.already_voted) throw poll_invalid_choice('Ya respondiste este cuestionario.');
	const tally = (await ctx.store.chat_poll_tally([message_id], uid)).get(message_id);
	if (result.changed) await publish_poll(ctx.store, message, poll, result, tally);
	return ok([poll_view(poll, tally)], 'Voto registrado.');
}

/** Contrato §9: la cierra quien la creó, o quien administra la conversación. */
export async function close_chat_poll(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { message, conversation, member } = await message_target(ctx);
	assert_live(message);
	const poll = poll_of(message);
	const can_close =
		str(message.sender_user_id) === uid ||
		chat_can(chat_role(member.role), as_object(conversation.settings), 'close_any_poll');
	if (!can_close) throw role_required();
	if (poll_closed_at(poll)) throw poll_closed();
	const message_id = str(message._id);
	const closed = await ctx.store.chat_close_poll(message_id, new Date().toISOString());
	if (!closed) throw poll_closed();
	const closed_poll = message_poll(closed);
	const tally = (await ctx.store.chat_poll_tally([message_id], uid)).get(message_id);
	await publish_poll(
		ctx.store,
		closed,
		closed_poll,
		{ rev: Number(closed.rev) || 0, updated_at: str(closed.updated_at) },
		tally,
	);
	return ok([poll_view(closed_poll, tally)], 'Encuesta cerrada.');
}

/** Contrato §4.1: la vista para quien lo pide o, con `format=csv`, los resultados para quien la creó o administra. */
export async function read_chat_poll(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { message, conversation, member } = await message_target(ctx);
	assert_live(message);
	const poll = poll_of(message);
	const message_id = str(message._id);
	const tally = (await ctx.store.chat_poll_tally([message_id], uid)).get(message_id);
	if (ctx.url.searchParams.get('format') !== 'csv') return ok([poll_view(poll, tally)], 'Encuesta cargada.');
	const can_export =
		str(message.sender_user_id) === uid ||
		chat_can(chat_role(member.role), as_object(conversation.settings), 'close_any_poll');
	if (!can_export) throw role_required();
	const anonymous = poll.anonymous === true;
	const options = as_array(poll.options).map(as_object);
	const voter_ids = anonymous ? [] : options.flatMap((option) => tally?.options.get(str(option.id))?.voter_ids ?? []);
	const users = new Map((await ctx.store.chat_users_brief(voter_ids)).map((user) => [user._id, user]));
	const correct = poll.quiz ? str(as_object(poll.quiz).correctOptionId) : '';
	const header = ['Opción', 'Votos', ...(correct ? ['Correcta'] : []), ...(anonymous ? [] : ['Votantes'])];
	const lines = options.map((option) => {
		const count = tally?.options.get(str(option.id));
		const names = (count?.voter_ids ?? []).map((id) => users.get(id)?.name || id).join('; ');
		return [
			str(option.text),
			String(count?.votes ?? 0),
			...(correct ? [str(option.id) === correct ? 'Sí' : 'No'] : []),
			...(anonymous ? [] : [names]),
		];
	});
	const csv = [['Pregunta', str(poll.question)], header, ...lines].map((cells) => cells.map(csv_cell).join(',')).join('\r\n');
	return new Response(`﻿${csv}\r\n`, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="encuesta-${message_id}.csv"`,
		},
	});
}

const MENTION = /\[@[^\n\]]*\]\(mention:([a-f\d]{24}|all|here)\)/gi;

type MentionPlan = {
	/** Lo que guarda el payload; sin menciones válidas, nada. */
	mentions?: { userIds: string[]; all: boolean; here: boolean };
	/** A quiénes avisa este envío o esta edición, sin repetir a quien ya se le avisó. */
	recipients: string[];
};

/**
 * Contrato §0.1 y §9: solo cuentan los miembros activos, sin quien escribe; `@todos` y `@aquí`
 * exigen permiso y, desde el umbral, `confirm_mass_mention`. `previous` son las menciones que el
 * mensaje ya tenía antes de editarlo: a esas personas no se les vuelve a avisar.
 */
async function plan_mentions(
	ctx: ChatCtx,
	conversation: ImperiumDoc,
	member: ImperiumDoc,
	text: string,
	opts: { confirmed: boolean; threshold: number; previous?: ImperiumDoc },
): Promise<MentionPlan> {
	const ids = new Set<string>();
	let all = false;
	let here = false;
	for (const [, target] of text.matchAll(MENTION)) {
		if (target === 'all') all = true;
		else if (target === 'here') here = true;
		else ids.add(target.toLowerCase());
	}
	if (!ids.size && !all && !here) return { recipients: [] };
	const role = chat_role(member.role);
	const settings = as_object(conversation.settings);
	if (!chat_can(role, settings, 'mention') || ((all || here) && !chat_can(role, settings, 'mention_all'))) {
		throw role_required();
	}
	const uid = actor_id(ctx);
	const others = (await ctx.store.chat_member_ids(str(conversation._id))).filter((id) => id !== uid);
	const user_ids = others.filter((id) => ids.has(id));
	const online = here && !all ? online_user_ids() : new Set<string>();
	const before = as_object(opts.previous);
	const new_mass = (all && before.all !== true) || (here && before.here !== true);
	const mass = !new_mass ? [] : all ? others : others.filter((id) => online.has(id));
	const notified = new Set(before.all === true ? others : as_array(before.userIds).map(String));
	const recipients = [...new Set([...user_ids, ...mass])].filter((id) => !notified.has(id));
	if (mass.length && recipients.length >= opts.threshold && !opts.confirmed) {
		throw new ChatError(
			409,
			'mass_mention_confirmation',
			`Esto notificará a ${recipients.length} personas. ¿Enviar de todos modos?`,
			{ recipients_count: recipients.length },
		);
	}
	return { mentions: { userIds: user_ids, all, here }, recipients };
}

/**
 * Las menciones quedan pendientes en cada miembro (`mentionSeqs`) y en su Actividad; quien recibe
 * una respuesta, si no lo mencionaron, también la ve ahí.
 */
async function register_mentions(
	ctx: ChatCtx,
	conversation: ImperiumDoc,
	message: ImperiumDoc,
	recipients: string[],
	replied_user_id = '',
): Promise<void> {
	const conversation_id = str(conversation._id);
	const message_id = str(message._id);
	if (recipients.length) {
		await ctx.store.chat_add_mention_seqs(conversation_id, recipients, Number(message.seq), str(message.updated_at));
	}
	const reply_to =
		replied_user_id &&
		replied_user_id !== actor_id(ctx) &&
		!recipients.includes(replied_user_id) &&
		(await ctx.store.chat_member_ids(conversation_id)).includes(replied_user_id)
			? replied_user_id
			: '';
	const excerpt = String(message.message ?? '');
	const where = { conversation_id, conversation_title: group_title_of(conversation), message_id, excerpt };
	await register_chat_activity(ctx.store, ctx.actor, [
		...recipients.map((user_id) => ({ user_id, context_type: 'chat-message' as const, ...where })),
		...(reply_to ? [{ user_id: reply_to, context_type: 'chat-reply' as const, ...where }] : []),
	]);
}

/** Los directos no guardan título: su Actividad muestra el nombre de la otra persona. */
function group_title_of(conversation: ImperiumDoc): string | undefined {
	return DIRECT_KINDS.has(str(conversation.kind)) ? undefined : str(conversation.name) || undefined;
}

const GROUP_RATE = { capacity: 10, refill_per_s: 10 / 3600 };
const PREFS_RATE = { capacity: 60, refill_per_s: 1 };
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 500;
const AVATAR_MAX_MB = 5;
const SLOW_MODE_MAX_S = 3600;
const MEMBERS_LIMIT = { fallback: 50, max: 100 };
const EPHEMERAL_SECONDS = new Set<unknown>([0, 86400, 604800, 7776000]);
const MEMBER_STATES = new Set(['active', 'requested', 'left', 'removed', 'banned']);
const ASSIGNABLE_ROLES = new Set(['admin', 'moderator', 'member']);
const NOTIFY_LEVELS = new Set(['default', 'all', 'mentions', 'none']);
const WALLPAPER_KINDS = new Set(['none', 'token', 'attachment']);
const WALLPAPER_VALUE_MAX = 200;
const FOLDER_MAX = 40;
const SOUND_MAX = 40;
const NICKNAME_MAX = 60;
/** Un grupo nuevo deja a sus miembros invitar y editar su información; lo demás, como un directo. */
const GROUP_SETTINGS = { ...DIRECT_CONVERSATION_SETTINGS, membersCanInvite: true, membersCanEditInfo: true };
/** En un canal, quien no administra solo lee y reacciona hasta que alguien le abra un permiso. */
const CHANNEL_SETTINGS = {
	...GROUP_SETTINGS,
	announcementOnly: true,
	membersCanInvite: false,
	membersCanPin: false,
	membersCanEditInfo: false,
	membersCanCall: false,
	membersCanMentionAll: false,
};

function default_settings(kind: string): ImperiumDoc {
	return kind === 'channel' ? CHANNEL_SETTINGS : GROUP_SETTINGS;
}
const ROLE_NAMES: Record<string, string> = {
	owner: 'dueño',
	admin: 'administrador',
	moderator: 'moderador',
	member: 'miembro',
};

function not_a_group(): ChatError {
	return new ChatError(409, 'not_a_group', 'Esta acción solo aplica a grupos y canales.');
}

function group_full(max: number): ChatError {
	return new ChatError(409, 'group_full', `El grupo alcanzó el máximo de ${max} miembros.`);
}

function not_member_target(): ChatError {
	return new ChatError(409, 'not_member_target', 'Esa persona no participa en esta conversación.');
}

function emit_chat_deltas(user_ids: string[], deltas: ImperiumDoc[]): void {
	if (user_ids.length && deltas.length) emit_to_users(user_ids, 'update', { action: 'chat_delta', data: deltas });
}

/** Los miembros activos agrupados por el seq desde el que ven el historial. */
async function members_by_visibility(store: ImperiumStore, conversation_id: string): Promise<Map<number, string[]>> {
	const groups = new Map<number, string[]>();
	for (const { user_id, visible_from } of await store.chat_member_visibility(conversation_id)) {
		groups.set(visible_from, [...(groups.get(visible_from) ?? []), user_id]);
	}
	return groups;
}

/**
 * Deltas de mensajes ya enviados: cada uno llega solo a quien ve, desde su `visibleFromSeq`, el
 * mensaje `seq` que toca. El seq va aparte porque en `reaction` y `conversation` el cliente
 * leería un hueco.
 */
const GUEST_DELTAS = new Set(['message', 'message_updated', 'reaction']);

/**
 * Contrato §5.4: los invitados admitidos de una reunión reciben los mensajes, sus cambios y sus
 * reacciones, solo desde su admisión. No tienen fila de miembro: van por su sesión.
 */
function emit_to_meeting_guests(conversation_id: string, deltas: Array<{ seq: number; delta: ImperiumDoc }>): void {
	for (const guest of guest_sessions_of_conversation(conversation_id)) {
		const visible = deltas
			.filter((item) => item.seq > guest.visible_from_seq && GUEST_DELTAS.has(str(item.delta.op)))
			.map((item) => item.delta);
		if (visible.length) emit_to_session(guest.session_id, 'update', { action: 'chat_delta', data: visible });
	}
}

async function emit_seen_deltas(
	store: ImperiumStore,
	conversation_id: string,
	deltas: Array<{ seq: number; delta: ImperiumDoc; hidden_for?: unknown }>,
): Promise<void> {
	emit_to_meeting_guests(conversation_id, deltas);
	const hiders = (item: { hidden_for?: unknown }) => as_array(item.hidden_for).map(String);
	for (const [visible_from, user_ids] of await members_by_visibility(store, conversation_id)) {
		const seen = deltas.filter((item) => item.seq > visible_from);
		// Quien ocultó el mensaje para sí ya no lo tiene: tampoco recibe sus cambios.
		const hiding = new Set(seen.flatMap(hiders));
		emit_chat_deltas(
			user_ids.filter((user_id) => !hiding.has(user_id)),
			seen.map((item) => item.delta),
		);
		for (const user_id of user_ids.filter((id) => hiding.has(id))) {
			emit_chat_deltas([user_id], seen.filter((item) => !hiders(item).includes(user_id)).map((item) => item.delta));
		}
	}
}

function membership_delta(conversation_id: string, user_id: string, patch: ImperiumDoc): ImperiumDoc {
	return { conversation_id, op: 'membership', user_id, patch };
}

/** `ChatMemberView` (contrato §3.3); quien solo pidió entrar aún no tiene `joinedAt`. */
function member_view(member: ImperiumDoc, user: ChatUserBrief | null | undefined): ImperiumDoc {
	return defined({
		user: user ? user_brief(user) : { _id: str(member.user_id), name: '' },
		role: chat_role(member.role),
		state: str(member.state),
		joined_at: str(member.joinedAt || member.requestedAt),
		restricted_until: str(member.restrictedUntil) || undefined,
	});
}

async function member_views(store: ImperiumStore, members: ImperiumDoc[]): Promise<ImperiumDoc[]> {
	const users = new Map(
		(await store.chat_users_brief(members.map((member) => str(member.user_id)))).map((user) => [user._id, user]),
	);
	return members.map((member) => member_view(member, users.get(str(member.user_id))));
}

/** La fila de una persona en la conversación, en el estado que tenga. */
async function find_member(store: ImperiumStore, conversation_id: string, user_id: string): Promise<ImperiumDoc | null> {
	if (!CHAT_ID.test(user_id)) return null;
	const { rows } = await store.find_many('chat-members', {
		where: { conversation_id, user_id },
		take: 1,
		populate: false,
		skip_total: true,
	});
	return rows[0] ?? null;
}

async function assert_users(store: ImperiumStore, ids: string[]): Promise<void> {
	const users = await store.chat_users_brief(ids);
	if (users.length !== ids.length) throw new ChatError(404, 'user_not_found', 'No encontramos a esa persona.');
	if (users.some((user) => !user.is_active)) throw new ChatError(403, 'user_inactive', 'Esa persona ya no está activa.');
}

type GroupTarget = { conversation: ImperiumDoc; member: ImperiumDoc; role: ChatRole; settings: ImperiumDoc };

/** La conversación de `:id` si es un grupo, un canal o una reunión, y el rol de quien actúa en ella. */
async function group_target(ctx: ChatCtx): Promise<GroupTarget> {
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, actor_id(ctx));
	if (!GROUP_KINDS.has(str(conversation.kind))) throw not_a_group();
	return { conversation, member, role: chat_role(member.role), settings: as_object(conversation.settings) };
}

async function view_of(ctx: ChatCtx, conversation_id: string, settings: ChatSettings): Promise<ImperiumDoc> {
	const row = await own_row(ctx, conversation_id);
	return conversation_view(ctx, row, await peers_of(ctx, [row]), settings);
}

async function audit(
	store: ImperiumStore,
	entry: {
		conversation_id: string;
		actor_id: string;
		action: string;
		message_id?: string;
		target_user_id?: string;
		before?: ImperiumDoc;
		after?: ImperiumDoc;
	},
): Promise<void> {
	await store.insert(
		'chat-audit',
		defined({
			conversation_id: entry.conversation_id,
			message_id: entry.message_id,
			actor_id: entry.actor_id,
			created_by: entry.actor_id,
			action: entry.action,
			targetUserId: entry.target_user_id,
			before: entry.before,
			after: entry.after,
		}),
	);
}

type SystemEvent = { type: string; target_ids?: string[]; data?: ImperiumDoc };

/** El texto de la bandeja; la vista del mensaje lleva el evento estructurado. */
function system_text(event: SystemEvent, actor: string, targets: string[]): string {
	const names = targets.length > 3 ? `${targets.slice(0, 3).join(', ')} y ${targets.length - 3} más` : targets.join(', ');
	const data = as_object(event.data);
	switch (event.type) {
		case 'created':
			return `${actor} creó ${data.kind === 'channel' ? 'el canal' : 'el grupo'}`;
		case 'members_added':
			return `${actor} agregó a ${names}`;
		case 'member_left':
			return `${actor} salió`;
		case 'member_removed':
			return `${actor} quitó a ${names}`;
		case 'renamed':
			return `${actor} cambió el nombre a «${str(data.title)}»`;
		case 'avatar_changed':
			return `${actor} cambió la imagen`;
		case 'role_changed':
			return `${names} ahora es ${ROLE_NAMES[str(data.role)] ?? str(data.role)}`;
		case 'ephemeral_changed':
			return `${actor} ${Number(data.seconds) ? 'activó' : 'desactivó'} los mensajes temporales`;
		case 'joined_by_link':
			return `${actor} se unió con un enlace`;
		case 'pinned':
			return `${actor} fijó un mensaje`;
		case 'meeting_scheduled':
			return `${actor} programó la reunión «${str(data.title)}»`;
		case 'meeting_updated':
			return `${actor} cambió la reunión «${str(data.title)}»`;
		case 'meeting_cancelled':
			return `${actor} canceló la reunión «${str(data.title)}»`;
		case 'recording':
			return `${actor} compartió la grabación de «${str(data.title)}»`;
		default:
			return `${actor} cambió los ajustes`;
	}
}

/**
 * Un mensaje de sistema con su `seq`: sin remitente, lo lee quien lo causó, y llega a los
 * miembros como cualquier otro mensaje.
 */
async function post_system_message(
	ctx: ChatCtx,
	conversation: ImperiumDoc,
	event: SystemEvent,
	settings: ChatSettings,
): Promise<void> {
	const uid = actor_id(ctx);
	const conversation_id = str(conversation._id);
	const at = new Date().toISOString();
	const id = new_id();
	const targets = event.target_ids ?? [];
	const names = new Map((await ctx.store.chat_users_brief(targets)).map((user) => [user._id, user.name]));
	const result = await ctx.store.chat_insert_message({
		id,
		conversation_id,
		sender_user_id: null,
		reader_user_id: uid,
		client_id: null,
		kind: 'system',
		name: str(conversation.name),
		search_field: null,
		payload: {
			message: '',
			sourceType: 'chat',
			conversationId: conversation_id,
			rev: 0,
			system: defined({ type: event.type, actorId: uid || null, targetIds: event.target_ids, data: event.data }),
		},
		preview: {
			messageId: id,
			senderId: null,
			senderName: actor_name(ctx),
			kind: 'system',
			textPreview: system_text(event, actor_name(ctx), targets.map((target) => names.get(target) ?? '')).slice(0, 160),
			at,
		},
		expires_at: null,
		share_read: shares_read_receipts(await ctx.store.chat_privacy(uid)),
		attachment_ids: [],
		now: at,
	});
	if (!result) return;
	const view = message_view(result.message, str(conversation.conversation_key), new Map());
	await publish_message(ctx.store, conversation, result.message, view, settings);
}

/** Lo de la reunión manda: sus miembros no invitan ni cambian el título por su cuenta. */
const MEETING_SETTINGS = { ...GROUP_SETTINGS, membersCanInvite: false, membersCanEditInfo: false, membersCanCall: false };

export type MeetingPeople = { cohost_ids: string[]; invitee_ids: string[] };

function meeting_roles(people: MeetingPeople): Map<string, 'admin' | 'member'> {
	const roles = new Map<string, 'admin' | 'member'>(people.invitee_ids.map((id) => [id, 'member']));
	for (const id of people.cohost_ids) roles.set(id, 'admin');
	return roles;
}

/**
 * La conversación `meeting` de una reunión (contrato §4.4): quien organiza es dueño, los
 * coanfitriones administran y los invitados internos son miembros.
 */
export async function open_meeting_conversation(
	ctx: ChatCtx,
	input: { meeting_id: string; title: string; description: string; people: MeetingPeople; now: string },
): Promise<ImperiumDoc> {
	const uid = actor_id(ctx);
	const id = new_id();
	const roles = meeting_roles(input.people);
	roles.delete(uid);
	const members = [
		{ user_id: uid, role: 'owner' },
		...[...roles].map(([user_id, role]) => ({ user_id, role, invited_by: uid })),
	];
	const conversation = await ctx.store.chat_create_group({
		id,
		kind: 'meeting',
		title: input.title,
		description: input.description,
		created_by: uid,
		payload: {
			createdById: uid,
			memberCount: members.length,
			settings: MEETING_SETTINGS,
			pins: [],
			invites: [],
			meetingId: input.meeting_id,
		},
		members,
		now: input.now,
	});
	for (const member of members) {
		emit_chat_deltas([member.user_id], [membership_delta(id, member.user_id, { state: 'active', role: member.role })]);
	}
	return conversation;
}

/**
 * Pone la conversación al día con la reunión editada: entran los nuevos, cambian los roles y salen
 * solo quienes la edición quitó (`removed_ids`): quien entró por el código sin invitación se queda.
 * El dueño (quien organiza) no se toca.
 */
export async function sync_meeting_conversation(
	ctx: ChatCtx,
	conversation_id: string,
	input: { title: string; description: string; people: MeetingPeople; removed_ids: string[] },
): Promise<void> {
	const settings = await chat_settings(ctx.store);
	const now = new Date().toISOString();
	const uid = actor_id(ctx);
	const wanted = meeting_roles(input.people);
	const { rows } = await ctx.store.find_many('chat-members', {
		where: { conversation_id, state: 'active' },
		take: settings.max_group_members,
		populate: false,
		skip_total: true,
	});
	const current = new Map(rows.map((row) => [str(row.user_id), chat_role(row.role)]));
	const entering = [...wanted.keys()].filter((id) => !current.has(id));
	if (entering.length) {
		const joined = await ctx.store.chat_join_members({
			conversation_id,
			user_ids: entering,
			state: 'active',
			invited_by: uid,
			max_members: settings.max_group_members,
			now,
		});
		if (joined.status === 'ok') {
			await publish_joined(ctx.store, joined.conversation, joined.joined);
			for (const id of entering) current.set(id, 'member');
		}
	}
	const deltas: ImperiumDoc[] = [];
	for (const [user_id, role] of current) {
		if (role === 'owner') continue;
		const target = wanted.get(user_id);
		if (!target && input.removed_ids.includes(user_id)) {
			const removed = await ctx.store.chat_remove_member({ conversation_id, user_id, expected_role: role, state: 'removed', now });
			if (removed) {
				deltas.push(membership_delta(conversation_id, user_id, { state: 'removed' }));
				emit_chat_deltas([user_id], [{ conversation_id, op: 'removed', patch: { reason: 'removed' } }]);
			}
		} else if (target && target !== role) {
			const updated = await ctx.store.chat_update_member({ conversation_id, user_id, expected_role: role, role: target, now });
			if (updated) deltas.push(membership_delta(conversation_id, user_id, { role: target }));
		}
	}
	const changed = await ctx.store.chat_update_conversation({
		id: conversation_id,
		title: input.title,
		description: input.description,
		merge: {},
		unset: [],
		now,
	});
	if (changed) {
		deltas.push({
			conversation_id,
			op: 'conversation',
			patch: {
				title: str(changed.conversation.name),
				description: str(changed.conversation.description),
				member_count: Number(changed.conversation.memberCount) || 0,
			},
		});
	}
	emit_chat_deltas(await ctx.store.chat_member_ids(conversation_id), deltas);
}

/** Quien entra por el código sin estar invitado queda como miembro al ser admitido (contrato §4.4). */
export async function join_meeting_conversation(store: ImperiumStore, conversation_id: string, user_id: string): Promise<void> {
	const settings = await chat_settings(store);
	const joined = await store.chat_join_members({
		conversation_id,
		user_ids: [user_id],
		state: 'active',
		max_members: settings.max_group_members,
		now: new Date().toISOString(),
	});
	if (joined.status === 'ok' && joined.joined.length) await publish_joined(store, joined.conversation, joined.joined);
}

/**
 * Quien entró por el código y el anfitrión expulsó deja la conversación: sin esto seguiría leyendo
 * el historial, la transcripción y las grabaciones de la reunión de la que lo sacaron.
 */
export async function leave_meeting_conversation(store: ImperiumStore, conversation_id: string, user_id: string): Promise<void> {
	const result = await store.chat_remove_member({ conversation_id, user_id, expected_role: 'member', state: 'removed', now: new Date().toISOString() });
	if (!result) return;
	emit_chat_deltas([user_id], [{ conversation_id, op: 'removed', patch: { reason: 'removed' } }]);
	emit_chat_deltas(await store.chat_member_ids(conversation_id), [
		membership_delta(conversation_id, user_id, { state: 'removed' }),
		{ conversation_id, op: 'conversation', patch: { member_count: Number(result.conversation.memberCount) || 0 } },
	]);
}

export type ChatGuest = { guest_id: string; name: string; visible_from_seq: number };

/** El chat de la reunión para un invitado admitido (contrato §4.4): solo lo de después de su admisión. */
export async function guest_message_page(store: ImperiumStore, conversation: ImperiumDoc, guest: ChatGuest, url: URL) {
	const limit = limit_param(url, 'limit', PAGE_LIMIT);
	const page = { conversation_id: str(conversation._id), visible_from: guest.visible_from_seq, viewer_id: `g:${guest.guest_id}` };
	const before = seq_param(url, 'before_seq');
	const after = seq_param(url, 'after_seq');
	const result =
		after !== undefined
			? await store.chat_message_page({ ...page, direction: 'after', seq: after, limit })
			: before !== undefined
				? await store.chat_message_page({ ...page, direction: 'before', seq: before, limit })
				: await store.chat_message_page({ ...page, direction: 'tail', limit });
	const has_more_before = after !== undefined ? after > page.visible_from : result.more;
	const views = await views_for(store, page.viewer_id, result.rows, () => str(conversation.conversation_key));
	return page_response(views, 'Mensajes cargados.', { has_more_before });
}

/** Contrato §9: un invitado solo escribe texto; responde, pero no adjunta, no menciona ni hace encuestas. */
export async function post_guest_message(
	store: ImperiumStore,
	conversation: ImperiumDoc,
	guest: ChatGuest,
	body: Record<string, unknown>,
): Promise<unknown> {
	const settings = await chat_settings(store);
	const conversation_id = str(conversation._id);
	const participant_key = `g:${guest.guest_id}`;
	const client_id = str(body.client_id);
	if (!UUID.test(client_id)) throw invalid('Falta el identificador del mensaje (client_id).');
	if (body.attachment_ids != null || body.poll != null || body.record_ref != null || body.files != null) {
		throw new ChatError(403, 'chat_send_denied', 'No puedes enviar mensajes en esta conversación.');
	}
	if (!chat_can('guest', as_object(conversation.settings), 'send')) {
		throw new ChatError(403, 'chat_send_denied', 'No puedes enviar mensajes en esta conversación.');
	}
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) throw invalid('Debes escribir un mensaje.');
	assert_text_length(text);
	const key = str(conversation.conversation_key);
	const sent = (message: ImperiumDoc) => {
		if (str(as_object(message.guestSender).participantKey) !== participant_key) throw invalid('Ese client_id ya se usó.');
		return ok([message_view(message, key, new Map())], SENT);
	};
	const existing = async () => {
		const { rows } = await store.find_many('messages', {
			where: { conversation_id, client_id },
			take: 1,
			populate: false,
			skip_total: true,
		});
		return rows[0] ?? null;
	};
	const before = await existing();
	if (before) return sent(before);
	const allowed = take_token(`chat-send:${participant_key}`, SEND_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const reply_id = str(body.reply_to_message_id);
	const reply = reply_id ? await reply_preview(store, reply_id, conversation, { visibleFromSeq: guest.visible_from_seq }) : undefined;
	const now = Date.now();
	const at = new Date(now).toISOString();
	const id = new_id();
	let result: Awaited<ReturnType<ImperiumStore['chat_insert_message']>>;
	try {
		result = await store.chat_insert_message({
			id,
			conversation_id,
			sender_user_id: null,
			client_id,
			kind: 'text',
			name: str(conversation.name),
			search_field: search_text([text]),
			payload: defined({
				message: text,
				senderName: guest.name,
				guestSender: { participantKey: participant_key, name: guest.name },
				sourceType: 'chat',
				conversationId: conversation_id,
				rev: 0,
				replyToMessageId: reply ? reply_id : undefined,
				replyPreview: reply,
			}),
			preview: { messageId: id, senderId: null, senderName: guest.name, kind: 'text', textPreview: text.slice(0, 160), at },
			expires_at: expiry_of(conversation, settings, now),
			share_read: false,
			attachment_ids: [],
			now: at,
		});
	} catch (err) {
		const repeated = is_unique_violation(err) ? await existing() : null;
		if (!repeated) throw err;
		return sent(repeated);
	}
	if (!result) throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	const view = message_view(result.message, key, new Map());
	await publish_message(store, conversation, result.message, view, settings);
	return ok([view], SENT);
}

/** El aviso de la reunión en su conversación: programada, cambiada o cancelada. */
export async function post_meeting_notice(
	ctx: ChatCtx,
	conversation_id: string,
	type: 'meeting_scheduled' | 'meeting_updated' | 'meeting_cancelled',
	data: ImperiumDoc,
): Promise<void> {
	const conversation = await find_chat_conversation(ctx.store, conversation_id);
	await post_system_message(ctx, conversation, { type, data }, await chat_settings(ctx.store));
}

/**
 * El mensaje de sistema `recording` (contrato §4.4) con su adjunto ya ligado: la fila del archivo
 * apunta a `message_id` antes de escribirlo, así que la membresía y el Range de `/api/media` lo
 * cubren como a cualquier adjunto del chat.
 */
export async function post_recording_message(
	store: ImperiumStore,
	input: { conversation_id: string; message_id: string; actor: { _id: string; name: string }; attachment: ImperiumDoc; data: ImperiumDoc },
): Promise<ImperiumDoc> {
	const settings = await chat_settings(store);
	const conversation = await find_chat_conversation(store, input.conversation_id);
	const conversation_id = str(conversation._id);
	const at = new Date().toISOString();
	const event: SystemEvent = { type: 'recording', data: input.data };
	const result = await store.chat_insert_message({
		id: input.message_id,
		conversation_id,
		sender_user_id: null,
		reader_user_id: input.actor._id,
		client_id: null,
		kind: 'system',
		name: str(conversation.name),
		search_field: null,
		payload: {
			message: '',
			sourceType: 'chat',
			conversationId: conversation_id,
			rev: 0,
			attachments: [input.attachment],
			system: { type: event.type, actorId: input.actor._id, data: input.data },
		},
		preview: {
			messageId: input.message_id,
			senderId: null,
			senderName: input.actor.name,
			kind: 'system',
			textPreview: system_text(event, input.actor.name, []).slice(0, 160),
			at,
		},
		expires_at: null,
		share_read: shares_read_receipts(await store.chat_privacy(input.actor._id)),
		attachment_ids: [],
		now: at,
	});
	if (!result) throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	const view = message_view(result.message, str(conversation.conversation_key), new Map());
	await publish_message(store, conversation, result.message, view, settings);
	return view;
}

/**
 * El mensaje `call` de una llamada (contrato §6.1): sin remitente y con `client_id` `call:<id>`, así
 * que no se repite. Lo lee quien llamó y, de `read_by`, quien iba al día; los demás lo tienen sin leer.
 * `null` si ya existía.
 */
export async function post_call_message(
	store: ImperiumStore,
	input: { conversation_id: string; call: ImperiumDoc; text_preview: string; read_by: string[] },
): Promise<ImperiumDoc | null> {
	const settings = await chat_settings(store);
	const conversation = await find_chat_conversation(store, input.conversation_id);
	const conversation_id = str(conversation._id);
	const initiator = str(input.call.initiatorId);
	const now = Date.now();
	const at = new Date(now).toISOString();
	const id = new_id();
	const [caller] = await store.chat_users_brief([initiator]);
	let result: Awaited<ReturnType<ImperiumStore['chat_insert_message']>>;
	try {
		result = await store.chat_insert_message({
			id,
			conversation_id,
			sender_user_id: null,
			reader_user_id: initiator,
			client_id: `call:${str(input.call.callId)}`,
			kind: 'call',
			name: str(conversation.name),
			search_field: null,
			payload: { message: '', sourceType: 'chat', conversationId: conversation_id, rev: 0, call: input.call },
			preview: {
				messageId: id,
				senderId: null,
				senderName: caller?.name ?? '',
				kind: 'call',
				textPreview: input.text_preview,
				at,
			},
			expires_at: expiry_of(conversation, settings, now),
			share_read: shares_read_receipts(await store.chat_privacy(initiator)),
			attachment_ids: [],
			now: at,
		});
	} catch (err) {
		if (is_unique_violation(err)) return null;
		throw err;
	}
	if (!result) return null;
	const message = result.message;
	const view = message_view(message, str(conversation.conversation_key), new Map());
	await publish_message(store, conversation, message, view, settings);
	const seq = Number(message.seq);
	const readers = [...new Set(input.read_by)].filter((user_id) => user_id !== initiator);
	const privacy = await store.chat_privacy_many(readers);
	const caught = await store.chat_catch_up_read({
		conversation_id,
		seq,
		user_ids: readers,
		sharing_ids: readers.filter((user_id) => shares_read_receipts(privacy.get(user_id)?.privacy ?? {})),
		now: at,
	});
	for (const row of caught) {
		emit_chat_deltas(
			[row.user_id],
			[
				{
					conversation_id,
					op: 'read',
					user_id: row.user_id,
					seq,
					patch: {
						last_read_seq: seq,
						unread_count: Math.max(row.last_seq - seq, 0),
						unread_mentions: row.mentions,
						marked_unread: false,
					},
				},
			],
		);
	}
	return message;
}

/** Quien entra recibe su membresía (y con ella lee la conversación); los demás, la suya y el nuevo total. */
async function publish_joined(store: ImperiumStore, conversation: ImperiumDoc, joined: ImperiumDoc[]): Promise<void> {
	const conversation_id = str(conversation._id);
	emit_chat_deltas(await store.chat_member_ids(conversation_id), [
		...joined.map((row) => membership_delta(conversation_id, str(row.user_id), { state: 'active', role: chat_role(row.role) })),
		{ conversation_id, op: 'conversation', patch: { member_count: Number(conversation.memberCount) || 0 } },
	]);
}

function group_title(value: unknown): string {
	const title = typeof value === 'string' ? value.trim() : '';
	if (!title || title.length > TITLE_MAX) throw invalid(`Ponle un nombre de hasta ${TITLE_MAX} caracteres.`);
	return title;
}

function group_description(value: unknown): string {
	if (value == null) return '';
	if (typeof value !== 'string' || value.trim().length > DESCRIPTION_MAX) {
		throw invalid(`La descripción admite hasta ${DESCRIPTION_MAX} caracteres.`);
	}
	return value.trim();
}

/** `Partial<ChatConversationSettings>` (snake_case) como se guarda; solo lo que viene. */
function settings_patch(value: unknown, settings: ChatSettings): ImperiumDoc {
	if (value == null || value === '') return {};
	const input = json_field(value);
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
	const patch: ImperiumDoc = {};
	for (const [camel, snake] of Object.entries(SETTINGS_VIEW)) {
		const raw = (input as Record<string, unknown>)[snake];
		if (raw === undefined) continue;
		if (camel === 'slowModeSeconds') {
			if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > SLOW_MODE_MAX_S) throw invalid();
		} else if (camel === 'ephemeralSeconds') {
			if (!EPHEMERAL_SECONDS.has(raw)) throw invalid();
			if (raw !== 0 && !settings.ephemeral_enabled) {
				throw new ChatError(403, 'feature_disabled', 'Tu organización desactivó esta función.');
			}
		} else if (typeof raw !== 'boolean') {
			throw invalid();
		}
		patch[camel] = raw;
	}
	return patch;
}

/** La imagen del grupo llega solo por multipart: una imagen de hasta 5 MB. */
function take_avatar(body: Record<string, unknown>): Blob | null {
	const file = body.avatar;
	if (file == null || file === '') return null;
	if (!is_upload(file)) throw invalid();
	const mime = file_type(file);
	if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
		throw new ChatError(415, 'upload_type_not_allowed', 'Ese tipo de archivo no se puede enviar.');
	}
	if (file.size > AVATAR_MAX_MB * 1024 * 1024) {
		throw new ChatError(413, 'upload_too_large', `El archivo supera el máximo de ${AVATAR_MAX_MB} MB.`);
	}
	return file;
}

function persist_avatar(store: ImperiumStore, file: Blob, uid: string, conversation_id: string) {
	return outside_history_context(() =>
		persist_upload_as_attachment(store, file, {
			actor_id: uid,
			related_model: 'ChatConversation',
			related_record_id: conversation_id,
			field: 'avatar',
			index_if_is_array: 0,
			inside_array: false,
		}),
	);
}

/** Contrato §4.2: el directo con otra persona, o el self con el propio id; se crea si no existe. */
export async function open_direct_conversation(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const conversation = await open_direct(ctx, str(ctx.body.user_id), new Date().toISOString());
	return ok([await view_of(ctx, str(conversation._id), settings)], 'Conversación lista.');
}

/** Contrato §4.2: grupo o canal; quien lo crea es su dueño y un canal solo admite anuncios. */
export async function create_group_conversation(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const kind = str(ctx.body.kind) || 'group';
	if (kind !== 'group' && kind !== 'channel') throw invalid();
	const title = group_title(ctx.body.title);
	const description = group_description(ctx.body.description);
	const conversation_settings = {
		...default_settings(kind),
		...settings_patch(ctx.body.settings, settings),
		...(kind === 'channel' ? { announcementOnly: true } : {}),
	};
	const member_ids = id_list(ctx.body.member_ids).filter((id) => id !== uid);
	if (member_ids.length + 1 > settings.max_group_members) throw group_full(settings.max_group_members);
	await assert_users(ctx.store, member_ids);
	const avatar = take_avatar(ctx.body);
	const allowed = take_token(`chat-group:${uid}`, GROUP_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	if (avatar) {
		const upload = take_token(`chat-upload:${uid}`, UPLOAD_RATE);
		if (!upload.ok) return rate_limited_response(upload.retry_after_s);
	}
	const id = new_id();
	const now = new Date().toISOString();
	const stored = avatar ? await persist_avatar(ctx.store, avatar, uid, id) : null;
	let conversation: ImperiumDoc;
	try {
		conversation = await ctx.store.chat_create_group({
			id,
			kind,
			title,
			description,
			created_by: uid,
			payload: defined({
				createdById: uid,
				memberCount: member_ids.length + 1,
				settings: conversation_settings,
				pins: [],
				invites: [],
				avatarAttachmentId: stored ? str(stored._id) : undefined,
			}),
			members: [
				{ user_id: uid, role: 'owner' },
				...member_ids.map((user_id) => ({ user_id, role: 'member', invited_by: uid })),
			],
			now,
		});
	} catch (err) {
		if (stored) await discard_uploads(ctx.store, [stored]);
		throw err;
	}
	for (const user_id of [uid, ...member_ids]) {
		emit_chat_deltas([user_id], [membership_delta(id, user_id, { state: 'active', role: user_id === uid ? 'owner' : 'member' })]);
	}
	await post_system_message(ctx, conversation, { type: 'created', data: { title, kind } }, settings);
	return ok([await view_of(ctx, id, settings)], kind === 'channel' ? 'Canal creado.' : 'Grupo creado.');
}

/** Contrato §4.2 y §9: título, descripción e imagen según el rol y el grupo; los ajustes, quien administra. */
export async function update_conversation_info(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	const title = ctx.body.title === undefined ? undefined : group_title(ctx.body.title);
	const description = ctx.body.description === undefined ? undefined : group_description(ctx.body.description);
	const patch = settings_patch(ctx.body.settings, settings);
	if (str(conversation.kind) === 'channel' && 'announcementOnly' in patch) patch.announcementOnly = true;
	const avatar = take_avatar(ctx.body);
	const remove_avatar = !avatar && flag(ctx.body.remove_avatar) === true;
	const changes_info = title !== undefined || description !== undefined || Boolean(avatar) || remove_avatar;
	const changes_settings = Object.keys(patch).length > 0;
	if (!changes_info && !changes_settings) throw invalid();
	if (
		(changes_info && !chat_can(role, current, 'edit_info')) ||
		(changes_settings && !chat_can(role, current, 'change_settings'))
	) {
		throw role_required();
	}
	if (avatar) {
		const upload = take_token(`chat-upload:${uid}`, UPLOAD_RATE);
		if (!upload.ok) return rate_limited_response(upload.retry_after_s);
	}
	const conversation_id = str(conversation._id);
	const stored = avatar ? await persist_avatar(ctx.store, avatar, uid, conversation_id) : null;
	let change: Awaited<ReturnType<ImperiumStore['chat_update_conversation']>>;
	try {
		change = await ctx.store.chat_update_conversation({
			id: conversation_id,
			title,
			description,
			settings: changes_settings ? patch : undefined,
			merge: stored ? { avatarAttachmentId: str(stored._id) } : {},
			unset: remove_avatar ? ['avatarAttachmentId'] : [],
			now: new Date().toISOString(),
		});
	} catch (err) {
		if (stored) await discard_uploads(ctx.store, [stored]);
		throw err;
	}
	if (!change) {
		if (stored) await discard_uploads(ctx.store, [stored]);
		throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	}
	const { conversation: updated, before } = change;
	const old_avatar = str(before.avatarAttachmentId);
	const new_avatar = str(updated.avatarAttachmentId);
	if (old_avatar && old_avatar !== new_avatar) {
		const row = await ctx.store.find_id('attachment-management', old_avatar);
		if (row) await discard_uploads(ctx.store, [row]);
	}
	const before_settings: ImperiumDoc = { ...default_settings(str(conversation.kind)), ...as_object(before.settings) };
	const changed = Object.keys(patch).filter((key) => before_settings[key] !== patch[key]);
	if (changed.length) {
		await audit(ctx.store, {
			conversation_id,
			actor_id: uid,
			action: 'settings_changed',
			before: Object.fromEntries(changed.map((key) => [key, before_settings[key]])),
			after: Object.fromEntries(changed.map((key) => [key, patch[key]])),
		});
	}
	emit_chat_deltas(await ctx.store.chat_member_ids(conversation_id), [
		{
			conversation_id,
			op: 'conversation',
			patch: defined({
				title: title === undefined ? undefined : str(updated.name),
				description: description === undefined ? undefined : str(updated.description),
				avatar_attachment_id: avatar || remove_avatar ? new_avatar || null : undefined,
				settings: changes_settings ? settings_view(updated.settings) : undefined,
			}),
		},
	]);
	if (title !== undefined && title !== str(before.name)) {
		await post_system_message(ctx, updated, { type: 'renamed', data: { title } }, settings);
	}
	if (old_avatar !== new_avatar) await post_system_message(ctx, updated, { type: 'avatar_changed' }, settings);
	if (changed.includes('ephemeralSeconds')) {
		await post_system_message(ctx, updated, { type: 'ephemeral_changed', data: { seconds: patch.ephemeralSeconds } }, settings);
	}
	const others = changed.filter((key) => key !== 'ephemeralSeconds');
	if (others.length) {
		await post_system_message(ctx, updated, { type: 'settings_changed', data: { settings: others.map((key) => SETTINGS_VIEW[key]) } }, settings);
	}
	return ok([await view_of(ctx, conversation_id, settings)], 'Conversación actualizada.');
}

/** Contrato §4.2: los activos para todos; las bajas y las solicitudes, solo para quien modera. */
export async function read_conversation_members(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, actor_id(ctx));
	const params = ctx.url.searchParams;
	const state = str(params.get('state')) || 'active';
	const role = str(params.get('role'));
	if (!MEMBER_STATES.has(state) || (role && chat_role(role) !== role)) throw invalid();
	if (state !== 'active' && !chat_can(chat_role(member.role), as_object(conversation.settings), 'read_departed')) {
		throw role_required();
	}
	const raw_cursor = str(params.get('cursor'));
	const limit = limit_param(ctx.url, 'limit', MEMBERS_LIMIT);
	const rows = await ctx.store.chat_member_page({
		conversation_id: str(conversation._id),
		states: [state],
		role: role || undefined,
		q: str(params.get('q')) || undefined,
		cursor: raw_cursor ? chat_cursor(raw_cursor) : undefined,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1)?.member;
	return page_response(
		page.map((row) => member_view(row.member, row.user)),
		'Miembros cargados.',
		{ next_cursor: rows.length > limit && last ? encode_cursor(str(last.created_at), str(last._id)) : null },
	);
}

/** Contrato §4.2 y §9: hasta el máximo del grupo; a quien está baneado no se le vuelve a añadir. */
export async function add_conversation_members(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	if (!chat_can(role, current, 'add_members')) throw role_required();
	const user_ids = id_list(ctx.body.user_ids).filter((id) => id !== uid);
	if (!user_ids.length) throw invalid('Indica a quién agregar (user_ids).');
	await assert_users(ctx.store, user_ids);
	const result = await ctx.store.chat_join_members({
		conversation_id: str(conversation._id),
		user_ids,
		state: 'active',
		invited_by: uid,
		max_members: settings.max_group_members,
		now: new Date().toISOString(),
	});
	if (result.status === 'banned') {
		throw new ChatError(403, 'banned', 'Ya no puedes unirte a esta conversación.', { user_ids: result.user_ids });
	}
	if (result.status === 'full') throw group_full(settings.max_group_members);
	if (result.status !== 'ok') throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	if (result.joined.length) {
		await publish_joined(ctx.store, result.conversation, result.joined);
		await post_system_message(
			ctx,
			result.conversation,
			{ type: 'members_added', target_ids: result.joined.map((row) => str(row.user_id)) },
			settings,
		);
	}
	return ok(await member_views(ctx.store, result.joined), 'Miembros agregados.');
}

/** Contrato §4.2 y §9: cambiar el rol (nunca el del dueño) o restringir a alguien hasta una fecha. */
export async function update_conversation_member(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	const conversation_id = str(conversation._id);
	const target_id = str(ctx.params.userId);
	const target = await find_member(ctx.store, conversation_id, target_id);
	if (!target || target.state !== 'active') throw not_member_target();
	const target_role = chat_role(target.role);
	const next_role = ctx.body.role === undefined ? undefined : str(ctx.body.role);
	if (next_role !== undefined && !ASSIGNABLE_ROLES.has(next_role)) throw invalid();
	let restricted_until: string | null | undefined;
	if (ctx.body.restricted_until === null || ctx.body.restricted_until === '') restricted_until = null;
	else if (ctx.body.restricted_until !== undefined) {
		const at = typeof ctx.body.restricted_until === 'string' ? Date.parse(ctx.body.restricted_until) : Number.NaN;
		if (!Number.isFinite(at)) throw invalid();
		restricted_until = new Date(at).toISOString();
	}
	if (next_role === undefined && restricted_until === undefined) throw invalid();
	if (next_role !== undefined) {
		if (target_role === 'owner') {
			throw new ChatError(409, 'owner_role_change', 'Para cambiar el rol del dueño, primero transfiere la propiedad.');
		}
		if (
			!chat_can(role, current, 'change_role', target_role) ||
			!chat_can(role, current, 'change_role', chat_role(next_role))
		) {
			throw role_required();
		}
	}
	if (restricted_until !== undefined && !chat_can(role, current, 'restrict', target_role)) throw role_required();
	const updated = await ctx.store.chat_update_member({
		conversation_id,
		user_id: target_id,
		expected_role: target_role,
		role: next_role,
		restricted_until,
		now: new Date().toISOString(),
	});
	if (!updated) throw role_required();
	const role_changed = next_role !== undefined && next_role !== target_role;
	if (role_changed) {
		await audit(ctx.store, {
			conversation_id,
			actor_id: uid,
			action: 'role_changed',
			target_user_id: target_id,
			before: { role: target_role },
			after: { role: next_role },
		});
	}
	if (restricted_until !== undefined) {
		await audit(ctx.store, {
			conversation_id,
			actor_id: uid,
			action: 'restricted',
			target_user_id: target_id,
			after: { restrictedUntil: restricted_until },
		});
	}
	emit_chat_deltas(await ctx.store.chat_member_ids(conversation_id), [
		membership_delta(
			conversation_id,
			target_id,
			defined({
				role: next_role === undefined ? undefined : chat_role(updated.role),
				restricted_until: restricted_until === undefined ? undefined : str(updated.restrictedUntil) || null,
			}),
		),
	]);
	if (role_changed) {
		await post_system_message(ctx, conversation, { type: 'role_changed', target_ids: [target_id], data: { role: next_role } }, settings);
	}
	return ok(await member_views(ctx.store, [updated]), 'Miembro actualizado.');
}

/** Los enlaces vigentes de quien deja el grupo se revocan con él. */
async function revoke_invites_of(store: ImperiumStore, conversation_id: string, user_id: string): Promise<void> {
	const at = new Date().toISOString();
	const own = (item: ImperiumDoc) => str(item.createdById) === user_id && !item.revokedAt;
	await store.chat_update_invites({
		conversation_id,
		join_code: null,
		now: at,
		update: (invites) => (invites.some(own) ? invites.map((item) => (own(item) ? { ...item, revokedAt: at } : item)) : null),
	});
}

/** Contrato §4.2 y §9: quitar, o banear con `ban=1`, a quien el rol permite moderar. */
export async function remove_conversation_member(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	const conversation_id = str(conversation._id);
	const target_id = str(ctx.params.userId);
	const ban = ['1', 'true'].includes(str(ctx.url.searchParams.get('ban')));
	if (target_id === uid) throw invalid('Para dejar la conversación usa «Salir».');
	// El rol va antes de buscar a la persona: un 409 contra un 403 diría quién salió o fue baneado.
	if (!chat_can(role, current, 'remove_member', 'member')) throw role_required();
	const target = await find_member(ctx.store, conversation_id, target_id);
	if (!target || (!ban && target.state !== 'active')) throw not_member_target();
	const target_role = chat_role(target.role);
	if (!chat_can(role, current, 'remove_member', target_role)) throw role_required();
	const state = ban ? 'banned' : 'removed';
	if (target.state === state) return ok([], 'Miembro baneado.');
	const result = await ctx.store.chat_remove_member({
		conversation_id,
		user_id: target_id,
		expected_role: target_role,
		state,
		now: new Date().toISOString(),
	});
	if (!result) throw role_required();
	await revoke_invites_of(ctx.store, conversation_id, target_id);
	await audit(ctx.store, {
		conversation_id,
		actor_id: uid,
		action: ban ? 'member_banned' : 'member_removed',
		target_user_id: target_id,
	});
	emit_chat_deltas([target_id], [{ conversation_id, op: 'removed', patch: { reason: state } }]);
	if (result.previous_state === 'active') {
		emit_chat_deltas(await ctx.store.chat_member_ids(conversation_id), [
			membership_delta(conversation_id, target_id, { state }),
			{ conversation_id, op: 'conversation', patch: { member_count: Number(result.conversation.memberCount) || 0 } },
		]);
		await post_system_message(ctx, result.conversation, { type: 'member_removed', target_ids: [target_id] }, settings);
	}
	return ok([], ban ? 'Miembro baneado.' : 'Miembro quitado.');
}

/** Contrato §4.2: salir de un grupo; si sale el dueño, alguien lo hereda y, si no queda nadie, se da de baja. */
export async function leave_conversation(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	await assert_chat_member(ctx.store, conversation, uid);
	if (DIRECT_KINDS.has(str(conversation.kind))) {
		throw new ChatError(409, 'cannot_leave_direct', 'No puedes salir de un chat directo; archívalo o silencialo.');
	}
	const conversation_id = str(conversation._id);
	const result = await ctx.store.chat_leave_conversation({
		conversation_id,
		user_id: uid,
		transfer_to: str(ctx.body.transfer_to) || undefined,
		now: new Date().toISOString(),
	});
	if (result.status === 'not_member_target') throw not_member_target();
	if (result.status !== 'ok') throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
	emit_chat_deltas([uid], [{ conversation_id, op: 'removed', patch: { reason: 'left' } }]);
	if (result.closed) return ok([], 'Saliste de la conversación.');
	await revoke_invites_of(ctx.store, conversation_id, uid);
	const left = result.conversation;
	const successor = result.successor_id;
	emit_chat_deltas(await ctx.store.chat_member_ids(conversation_id), [
		membership_delta(conversation_id, uid, { state: 'left' }),
		...(successor ? [membership_delta(conversation_id, successor, { role: 'owner' })] : []),
		{ conversation_id, op: 'conversation', patch: { member_count: Number(left.memberCount) || 0 } },
	]);
	await post_system_message(ctx, left, { type: 'member_left' }, settings);
	if (successor) {
		await post_system_message(ctx, left, { type: 'role_changed', target_ids: [successor], data: { role: 'owner' } }, settings);
	}
	return ok([], 'Saliste de la conversación.');
}

/** Contrato §4.2: solo el dueño la transfiere; pasa a administrador. */
export async function transfer_conversation_ownership(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	if (!chat_can(role, current, 'transfer')) throw role_required();
	const to = str(ctx.body.user_id);
	if (!to) throw invalid('Indica a quién transfieres la conversación (user_id).');
	const conversation_id = str(conversation._id);
	const result = await ctx.store.chat_transfer_owner({ conversation_id, from: uid, to, now: new Date().toISOString() });
	if (result.status === 'not_owner') throw role_required();
	if (result.status !== 'ok') throw not_member_target();
	await audit(ctx.store, { conversation_id, actor_id: uid, action: 'role_changed', target_user_id: to, after: { role: 'owner' } });
	emit_chat_deltas(await ctx.store.chat_member_ids(conversation_id), [
		membership_delta(conversation_id, to, { role: 'owner' }),
		membership_delta(conversation_id, uid, { role: 'admin' }),
	]);
	await post_system_message(ctx, conversation, { type: 'role_changed', target_ids: [to], data: { role: 'owner' } }, settings);
	return ok(await member_views(ctx.store, [result.owner, result.previous]), 'Propiedad transferida.');
}

function pref_text(value: unknown, max: number): string | null {
	if (value === null || value === '') return null;
	if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid();
	return value.trim();
}

/** Las `ChatConversationPrefs` que llegan (snake_case) como se guardan; `null` limpia. */
function prefs_patch(body: Record<string, unknown>, now: string): { merge: ImperiumDoc; pinned?: boolean } {
	const merge: ImperiumDoc = {};
	if (body.muted_until !== undefined) {
		const at = typeof body.muted_until === 'string' ? Date.parse(body.muted_until) : Number.NaN;
		if (body.muted_until !== null && !Number.isFinite(at)) throw invalid();
		merge.mutedUntil = body.muted_until === null ? null : new Date(at).toISOString();
	}
	if (body.archived !== undefined) {
		if (typeof body.archived !== 'boolean') throw invalid();
		merge.archived = body.archived;
	}
	if (body.folder !== undefined) merge.folder = pref_text(body.folder, FOLDER_MAX);
	if (body.sound !== undefined) merge.sound = pref_text(body.sound, SOUND_MAX);
	if (body.nickname !== undefined) merge.nickname = pref_text(body.nickname, NICKNAME_MAX);
	if (body.notify_level !== undefined) {
		if (!NOTIFY_LEVELS.has(str(body.notify_level))) throw invalid();
		merge.notifyLevel = str(body.notify_level);
	}
	if (body.wallpaper !== undefined) {
		const wallpaper = as_object(body.wallpaper);
		const kind = str(wallpaper.kind);
		const value = typeof wallpaper.value === 'string' ? wallpaper.value : '';
		const dim = Number(wallpaper.dim ?? 0);
		if (
			body.wallpaper !== null &&
			(!WALLPAPER_KINDS.has(kind) ||
				value.length > WALLPAPER_VALUE_MAX ||
				!(dim >= 0 && dim <= 0.6) ||
				(kind === 'attachment' && !CHAT_ID.test(value)))
		) {
			throw invalid();
		}
		merge.wallpaper = body.wallpaper === null ? null : { kind, value, dim };
	}
	if (body.draft !== undefined) {
		const draft = as_object(body.draft);
		const reply = str(draft.reply_to_message_id);
		if (
			body.draft !== null &&
			(typeof draft.text !== 'string' || draft.text.length > TEXT_MAX_CHARS || (reply && !CHAT_ID.test(reply)))
		) {
			throw invalid();
		}
		merge.draft = body.draft === null ? null : defined({ text: draft.text, replyToMessageId: reply || undefined, updatedAt: now });
	}
	if (body.pinned !== undefined && typeof body.pinned !== 'boolean') throw invalid();
	return { merge, pinned: body.pinned as boolean | undefined };
}

function wallpaper_upload(wallpaper: unknown): string {
	const value = as_object(wallpaper);
	return str(value.kind) === 'attachment' ? str(value.value) : '';
}

/**
 * La imagen de fondo se liga a la conversación para que la limpieza de 24 h no la borre: una
 * subida propia de esta conversación, sin ligar o ya ligada aquí como fondo.
 */
async function bind_wallpaper(store: ImperiumStore, id: string, uid: string, conversation_id: string, now: string): Promise<void> {
	const row = await store.find_id('attachment-management', id);
	const ours =
		row?.is_active !== false &&
		Boolean(row?.chatUpload) &&
		str(row?.created_by_id) === uid &&
		str(as_object(row?.chatUpload).conversationId) === conversation_id;
	const bound_here = str(row?.related_model) === 'ChatConversation' && str(row?.related_record_id) === conversation_id;
	if (ours && (bound_here || (await store.chat_bind_uploads([id], uid, 'ChatConversation', conversation_id, now)))) return;
	throw new ChatError(422, 'invalid_attachment', 'Uno de los archivos no es válido o ya no está disponible.');
}

/** Contrato §4.2: las preferencias propias de una conversación; sus otros dispositivos las reciben por `prefs`. */
export async function update_conversation_prefs(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	const now = new Date().toISOString();
	const { merge, pinned } = prefs_patch(ctx.body, now);
	if (!Object.keys(merge).length && pinned === undefined) throw invalid();
	const allowed = take_token(`chat-prefs:${uid}`, PREFS_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const conversation_id = str(conversation._id);
	const old_upload = merge.wallpaper === undefined ? '' : wallpaper_upload(member.wallpaper);
	const new_upload = wallpaper_upload(merge.wallpaper);
	if (new_upload) await bind_wallpaper(ctx.store, new_upload, uid, conversation_id, now);
	const updated = await ctx.store.chat_update_prefs({
		conversation_id,
		user_id: uid,
		merge,
		pinned,
		max_pinned: PINNED_MAX,
		now,
	});
	const release = (id: string) =>
		ctx.store.chat_release_upload({ id, owner_id: uid, model: 'ChatConversation', record_id: conversation_id, now });
	if (!updated) {
		if (new_upload && new_upload !== old_upload) await release(new_upload);
		throw invalid(`Puedes fijar hasta ${PINNED_MAX} conversaciones.`);
	}
	if (old_upload && old_upload !== new_upload) await release(old_upload);
	const prefs = prefs_view(updated);
	emit_chat_deltas([uid], [{ conversation_id, op: 'prefs', user_id: uid, patch: prefs }]);
	return ok([prefs], 'Preferencias guardadas.');
}

const INVITE_RATE = { capacity: 20, refill_per_s: 20 / 3600 };
const JOIN_RATE = { capacity: 20, refill_per_s: 20 / 3600 };
const INVITES_MAX = 20;
const INVITE_NAME_MAX = 60;
const INVITE_HOURS_MAX = 24 * 365;
const INVITE_USES_MAX = 10_000;
const REQUESTS_MAX = 100;
const STAFF_MAX = 200;
const INVITE_KINDS = new Set(['group', 'channel']);
const INVITE_TOKEN = /^([a-f0-9]{16})\.([a-f0-9]{32})$/;

function random_hex(bytes: number): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

/** Un enlace revocado se trata como inexistente. */
function invite_error(state: string): ChatError {
	if (state === 'expired') return new ChatError(410, 'invite_expired', 'El enlace de invitación caducó.');
	if (state === 'exhausted') return new ChatError(410, 'invite_exhausted', 'El enlace de invitación ya no admite más usos.');
	return new ChatError(404, 'invite_not_found', 'El enlace de invitación no existe.');
}

/** `ChatInviteView` (contrato §3.3); el token es `<join_code>.<secret>`. */
function invite_view(invite: ImperiumDoc, join_code: string, users: Map<string, ChatUserBrief>): ImperiumDoc {
	const token = `${join_code}.${str(invite.secret)}`;
	const by = users.get(str(invite.createdById));
	return defined({
		invite_id: str(invite.id),
		name: str(invite.name) || undefined,
		url: `/mensajes?chat_invite=${token}`,
		token,
		created_by: by ? user_brief(by) : { _id: str(invite.createdById), name: '' },
		created_at: str(invite.createdAt),
		expires_at: str(invite.expiresAt) || undefined,
		max_uses: invite.maxUses == null ? undefined : Number(invite.maxUses),
		uses: Number(invite.uses) || 0,
		requires_approval: invite.requiresApproval === true,
		revoked_at: str(invite.revokedAt) || undefined,
	});
}

/**
 * Contrato §3.3: los enlaces, a quien administra (todos) o a quien puede crearlos (los suyos);
 * las solicitudes pendientes, a quien modera.
 */
async function invites_and_requests(ctx: ChatCtx, row: ChatInboxRow): Promise<ImperiumDoc> {
	const { conversation, member } = row;
	if (!INVITE_KINDS.has(str(conversation.kind))) return {};
	const uid = actor_id(ctx);
	const role = chat_role(member.role);
	const settings = as_object(conversation.settings);
	const all = chat_can(role, settings, 'revoke_invite');
	const invites =
		all || chat_can(role, settings, 'create_invite')
			? as_array(conversation.invites)
					.map(as_object)
					.filter((invite) => all || str(invite.createdById) === uid)
			: null;
	const requests = chat_can(role, settings, 'approve_join')
		? await ctx.store.chat_member_page({
				conversation_id: str(conversation._id),
				states: ['requested'],
				limit: REQUESTS_MAX,
			})
		: null;
	const users = new Map(
		(await ctx.store.chat_users_brief((invites ?? []).map((invite) => str(invite.createdById)))).map((user) => [
			user._id,
			user,
		]),
	);
	return defined({
		invites: invites?.map((invite) => invite_view(invite, str(conversation.join_code), users)),
		pending_requests: requests?.map(({ member: request, user }) => ({
			user: user ? user_brief(user) : { _id: str(request.user_id), name: '' },
			requested_at: str(request.requestedAt),
		})),
	});
}

/** El grupo y el enlace de un token, si el enlace sigue sirviendo. */
async function invite_target(ctx: ChatCtx): Promise<{ conversation: ImperiumDoc; invite: ImperiumDoc }> {
	const match = INVITE_TOKEN.exec(str(ctx.params.token));
	const conversation = match ? await ctx.store.find_where('chat-conversations', { join_code: match[1] }) : null;
	const secret = Buffer.from(match?.[2] ?? '');
	const invite =
		conversation && conversation.is_active !== false && INVITE_KINDS.has(str(conversation.kind))
			? as_array(conversation.invites)
					.map(as_object)
					.find((item) => {
						const candidate = Buffer.from(str(item.secret));
						return candidate.length === secret.length && timingSafeEqual(candidate, secret);
					})
			: undefined;
	if (!conversation || !invite) throw invite_error('revoked');
	const state = invite_state(invite, new Date().toISOString());
	if (state !== 'live') throw invite_error(state);
	// El enlace vale lo que su autor, también para verlo: unirse lo vuelve a revisar bajo el bloqueo.
	const creator = await find_member(ctx.store, str(conversation._id), str(invite.createdById));
	if (creator?.state !== 'active' || !chat_can(chat_role(creator.role), as_object(conversation.settings), 'create_invite')) {
		throw invite_error('revoked');
	}
	return { conversation, invite };
}

/** Contrato §4.2 y §9: un enlace con nombre, caducidad, usos y aprobación; hasta 20 vigentes por grupo. */
export async function create_conversation_invite(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	if (!INVITE_KINDS.has(str(conversation.kind))) throw not_a_group();
	if (!chat_can(role, current, 'create_invite')) throw role_required();
	const name = pref_text(ctx.body.name ?? null, INVITE_NAME_MAX) ?? undefined;
	const hours = whole(ctx.body.expires_in_hours);
	const max_uses = whole(ctx.body.max_uses);
	if (hours === 0 || (hours ?? 0) > INVITE_HOURS_MAX || max_uses === 0 || (max_uses ?? 0) > INVITE_USES_MAX) {
		throw invalid();
	}
	const requires_approval = flag(ctx.body.requires_approval) === true;
	const allowed = take_token(`chat-invite:${uid}`, INVITE_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const now = new Date();
	const at = now.toISOString();
	const invite = defined({
		id: new_id(),
		secret: random_hex(16),
		name,
		createdById: uid,
		createdAt: at,
		expiresAt: hours ? new Date(now.getTime() + hours * 3_600_000).toISOString() : undefined,
		maxUses: max_uses,
		uses: 0,
		requiresApproval: requires_approval,
	});
	const result = await ctx.store.chat_update_invites({
		conversation_id: str(conversation._id),
		join_code: random_hex(8),
		now: at,
		update: (invites) => {
			const next = [...invites, invite];
			while (next.length > INVITES_MAX) {
				const dead = next.findIndex((item) => invite_state(item, at) !== 'live');
				if (dead < 0) return null;
				next.splice(dead, 1);
			}
			return next;
		},
	});
	if (result.status === 'rejected') {
		throw new ChatError(409, 'invite_limit', 'Esta conversación ya tiene el máximo de enlaces activos.');
	}
	if (result.status !== 'ok') throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	const users = new Map((await ctx.store.chat_users_brief([uid])).map((user) => [user._id, user]));
	return ok([invite_view(invite, str(result.conversation.join_code), users)], 'Enlace de invitación creado.');
}

/** Contrato §4.2 y §9: quien administra revoca cualquier enlace; un miembro, los suyos. */
export async function revoke_conversation_invite(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	const invite_id = str(ctx.params.inviteId);
	const invite = as_array(conversation.invites)
		.map(as_object)
		.find((item) => str(item.id) === invite_id);
	if (!invite) throw invite_error('revoked');
	if (!chat_can(role, current, str(invite.createdById) === uid ? 'revoke_own_invite' : 'revoke_invite')) {
		throw role_required();
	}
	const at = new Date().toISOString();
	const result = await ctx.store.chat_update_invites({
		conversation_id: str(conversation._id),
		join_code: null,
		now: at,
		update: (invites) => invites.map((item) => (item.id === invite_id && !item.revokedAt ? { ...item, revokedAt: at } : item)),
	});
	if (result.status !== 'ok') throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	return ok([], 'Enlace revocado.');
}

/** Contrato §4.2: lo mínimo para decidir si unirse; sin la imagen ni los miembros del grupo. */
export async function read_conversation_invite(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const { conversation, invite } = await invite_target(ctx);
	const member = await find_member(ctx.store, str(conversation._id), actor_id(ctx));
	return ok(
		[
			{
				title: str(conversation.name),
				kind: str(conversation.kind),
				member_count: Number(conversation.memberCount) || 0,
				requires_approval: invite.requiresApproval === true,
				already_member: member?.state === 'active',
			},
		],
		'Invitación cargada.',
	);
}

/** Contrato §4.2: unirse por enlace, o pedirlo si el enlace pide aprobación; quien está baneado no entra. */
export async function join_conversation_by_invite(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, invite } = await invite_target(ctx);
	const allowed = take_token(`chat-join:${uid}`, JOIN_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const conversation_id = str(conversation._id);
	const requested = invite.requiresApproval === true;
	const result = await ctx.store.chat_join_members({
		conversation_id,
		user_ids: [uid],
		state: requested ? 'requested' : 'active',
		max_members: settings.max_group_members,
		invite_id: str(invite.id),
		now: new Date().toISOString(),
	});
	if (result.status === 'banned') throw new ChatError(403, 'banned', 'Ya no puedes unirte a esta conversación.');
	if (result.status === 'full') throw group_full(settings.max_group_members);
	if (result.status.startsWith('invite_')) throw invite_error(result.status.slice('invite_'.length));
	if (result.status !== 'ok') throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	if (requested && result.previous[uid] !== 'active') {
		if (result.joined.length) {
			const { rows: staff } = await ctx.store.find_many('chat-members', {
				where: { conversation_id, state: 'active', role: { in: ['owner', 'admin', 'moderator'] } },
				take: STAFF_MAX,
				populate: false,
				skip_total: true,
			});
			emit_chat_deltas(
				staff.map((row) => str(row.user_id)),
				[membership_delta(conversation_id, uid, { state: 'requested' })],
			);
		}
		return ok([{ state: 'requested' }], 'Solicitud enviada.');
	}
	if (result.joined.length) {
		await publish_joined(ctx.store, result.conversation, result.joined);
		await post_system_message(ctx, result.conversation, { type: 'joined_by_link' }, settings);
	}
	return ok([{ state: 'active', conversation: await view_of(ctx, conversation_id, settings) }], 'Te uniste a la conversación.');
}

/** Contrato §4.2 y §9: quien modera aprueba (si cabe en el grupo) o rechaza una solicitud pendiente. */
export async function decide_join_request(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { conversation, role, settings: current } = await group_target(ctx);
	if (!chat_can(role, current, 'approve_join')) throw role_required();
	const approve = flag(ctx.body.approve);
	if (approve === undefined) throw invalid('Indica si apruebas la solicitud (approve).');
	const conversation_id = str(conversation._id);
	const user_id = str(ctx.params.userId);
	const not_requested = new ChatError(404, 'request_not_found', 'No hay una solicitud pendiente de esa persona.');
	const now = new Date().toISOString();
	if (!approve) {
		const denied = await ctx.store.chat_deny_request(conversation_id, user_id, now);
		if (!denied) throw not_requested;
		await audit(ctx.store, { conversation_id, actor_id: uid, action: 'join_denied', target_user_id: user_id });
		emit_chat_deltas([user_id], [{ conversation_id, op: 'removed', patch: { reason: 'removed' } }]);
		return ok(await member_views(ctx.store, [denied]), 'Solicitud rechazada.');
	}
	const result = await ctx.store.chat_join_members({
		conversation_id,
		user_ids: [user_id],
		state: 'active',
		only_requested: true,
		invited_by: uid,
		max_members: settings.max_group_members,
		now,
	});
	if (result.status === 'full') throw group_full(settings.max_group_members);
	if (result.status !== 'ok') throw not_requested;
	await audit(ctx.store, { conversation_id, actor_id: uid, action: 'join_approved', target_user_id: user_id });
	await publish_joined(ctx.store, result.conversation, result.joined);
	await post_system_message(ctx, result.conversation, { type: 'members_added', target_ids: [user_id] }, settings);
	return ok(await member_views(ctx.store, result.joined), 'Solicitud aprobada.');
}

const PIN_DURATIONS: Record<string, number | null> = {
	'24h': 24 * 3600_000,
	'7d': 7 * 24 * 3600_000,
	'30d': 30 * 24 * 3600_000,
	forever: null,
};

/**
 * Cada miembro recibe qué está fijado desde su `visibleFromSeq`, sin la vista previa: lo oculto
 * para cada quien solo lo filtra el detalle.
 */
async function publish_pins(ctx: ChatCtx, conversation: ImperiumDoc): Promise<void> {
	const conversation_id = str(conversation._id);
	const now = new Date().toISOString();
	const pins = as_array(conversation.pins)
		.map(as_object)
		.filter((pin) => !pin.expiresAt || str(pin.expiresAt) > now)
		.map((pin) => ({ message_id: str(pin.messageId), seq: Number(pin.seq) }));
	for (const [visible_from, user_ids] of await members_by_visibility(ctx.store, conversation_id)) {
		const seen = pins.filter((item) => item.seq > visible_from);
		emit_chat_deltas(user_ids, [{ conversation_id, op: 'conversation', patch: { pins: seen } }]);
	}
}

/** Contrato §4.2 y §9: fijar con caducidad, hasta el máximo de la organización; los vencidos no cuentan. */
export async function pin_conversation_message(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	if (!chat_can(chat_role(member.role), as_object(conversation.settings), 'pin')) throw role_required();
	const duration = str(ctx.body.duration) || 'forever';
	if (!(duration in PIN_DURATIONS)) throw invalid('Elige cuánto tiempo se fija (24h, 7d, 30d o forever).');
	const conversation_id = str(conversation._id);
	const message_id = str(ctx.body.message_id);
	const message = CHAT_ID.test(message_id) ? await ctx.store.find_id('messages', message_id) : null;
	if (
		!message ||
		message.is_active === false ||
		str(message.conversation_id) !== conversation_id ||
		Number(message.seq) <= (Number(member.visibleFromSeq) || 0) ||
		hidden_for(message, uid)
	) {
		throw message_not_found();
	}
	assert_live(message);
	if (SERVER_KINDS.has(str(message.kind))) throw invalid('Ese mensaje no se puede fijar.');
	const now = new Date();
	const at = now.toISOString();
	const lasts = PIN_DURATIONS[duration];
	const pin = {
		messageId: message_id,
		seq: Number(message.seq),
		pinnedById: uid,
		pinnedAt: at,
		expiresAt: lasts === null ? null : new Date(now.getTime() + lasts!).toISOString(),
	};
	const max = settings.max_pinned_messages;
	const result = await ctx.store.chat_update_pins({
		conversation_id,
		now: at,
		update: (pins) => {
			const live = pins.filter((item) => item.messageId !== message_id && (!item.expiresAt || str(item.expiresAt) > at));
			return live.length < max ? [...live, pin] : null;
		},
	});
	if (result.status === 'rejected') {
		throw new ChatError(409, 'pin_limit', `Solo se pueden fijar ${max} mensajes.`, { max });
	}
	if (result.status !== 'ok') throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	await audit(ctx.store, { conversation_id, actor_id: uid, action: 'pin', message_id });
	await publish_pins(ctx, result.conversation);
	await post_system_message(
		ctx,
		result.conversation,
		{ type: 'pinned', data: { messageId: message_id, seq: Number(message.seq) } },
		settings,
	);
	return ok(
		(await pins_view(ctx, result.conversation, member)).filter((item) => item.message_id === message_id),
		'Mensaje fijado.',
	);
}

/** Contrato §4.2: desfijar pide el mismo permiso que fijar; lo que no estaba fijado no cambia. */
export async function unpin_conversation_message(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	if (!chat_can(chat_role(member.role), as_object(conversation.settings), 'pin')) throw role_required();
	const conversation_id = str(conversation._id);
	const message_id = str(ctx.params.messageId);
	const result = await ctx.store.chat_update_pins({
		conversation_id,
		now: new Date().toISOString(),
		update: (pins) =>
			pins.some((item) => item.messageId === message_id) ? pins.filter((item) => item.messageId !== message_id) : null,
	});
	if (result.status === 'missing') throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	if (result.status === 'ok') {
		await audit(ctx.store, { conversation_id, actor_id: uid, action: 'unpin', message_id });
		await publish_pins(ctx, result.conversation);
	}
	return ok([], 'Mensaje desfijado.');
}

const FORWARD_RATE = { capacity: 10, refill_per_s: 10 / 60 };
const FORWARD_MESSAGES_MAX = 20;
const FORWARD_TARGETS_MAX = 10;
const FORWARD_KINDS = new Set(['text', 'media', 'voice', 'poll', 'record']);
/** Lo que una fila copiada conserva de la original: el mismo archivo. */
const STORED_FILE_FIELDS = ['name', 'name_stored', 'base64', 'filename', 'mimetype', 'file_ext', 'size_in_kb', 'file_readiness'];

/** Los mensajes que se reenvían, del más viejo al más nuevo, si quien reenvía los ve y no son de ver una vez. */
async function forward_sources(ctx: ChatCtx, ids: string[]): Promise<ImperiumDoc[]> {
	const uid = actor_id(ctx);
	const { rows } = await ctx.store.find_many('messages', { ids, take: ids.length, populate: false, skip_total: true });
	const conversation_ids = [...new Set(rows.map((row) => str(row.conversation_id)).filter(Boolean))];
	const { rows: memberships } = conversation_ids.length
		? await ctx.store.find_many('chat-members', {
				where: { user_id: uid, conversation_id: { in: conversation_ids } },
				take: conversation_ids.length,
				populate: false,
				skip_total: true,
			})
		: { rows: [] };
	const members = new Map(memberships.filter((row) => row.state === 'active').map((row) => [str(row.conversation_id), row]));
	const by_id = new Map(rows.map((row) => [str(row._id), row]));
	const sources = ids.map((id) => {
		const message = by_id.get(id);
		const member = members.get(str(message?.conversation_id));
		if (
			!message ||
			!member ||
			message.deleted ||
			Number(message.seq) <= (Number(member.visibleFromSeq) || 0) ||
			hidden_for(message, uid)
		) {
			throw message_not_found();
		}
		if (message.viewOnce) throw new ChatError(403, 'view_once_forward', 'Los mensajes de ver una vez no se pueden reenviar.');
		if (!FORWARD_KINDS.has(str(message.kind) || 'text')) throw invalid('Ese mensaje no se puede reenviar.');
		return message;
	});
	return sources.sort(
		(a, b) =>
			str(a.created_at).localeCompare(str(b.created_at)) ||
			Number(a.seq) - Number(b.seq) ||
			str(a._id).localeCompare(str(b._id)),
	);
}

/** Quita filas copiadas sin tocar el archivo, que sigue siendo de la original. */
async function drop_copies(store: ImperiumStore, copies: ImperiumDoc[]): Promise<void> {
	for (const copy of copies) {
		await outside_history_context(() => store.remove('attachment-management', str(copy.attachmentId)));
	}
}

/** Contrato §4.1: el archivo se reutiliza con una fila nueva, de quien reenvía y ligada al mensaje nuevo. */
async function copy_attachments(
	store: ImperiumStore,
	source: ImperiumDoc,
	target: { uid: string; conversation_id: string; message_id: string; at: string },
): Promise<ImperiumDoc[]> {
	const infos = as_array(source.attachments).map(as_object);
	if (!infos.length) return [];
	const ids = infos.map((info) => str(info.attachmentId));
	const { rows } = await store.find_many('attachment-management', { ids, take: ids.length, populate: false, skip_total: true });
	// Solo se copia lo que es de este mensaje: un id ajeno en su payload no abre el archivo de otro.
	const by_id = new Map(
		rows
			.filter((row) => row.related_model === 'Message' && str(row.related_record_id) === str(source._id))
			.map((row) => [str(row._id), row]),
	);
	const copies: ImperiumDoc[] = [];
	try {
		for (const [index, info] of infos.entries()) {
			const row = by_id.get(str(info.attachmentId));
			if (!row) throw new ChatError(422, 'invalid_attachment', 'Uno de los archivos no es válido o ya no está disponible.');
			const copy = await outside_history_context(() =>
				store.insert('attachment-management', {
					...Object.fromEntries(STORED_FILE_FIELDS.filter((key) => row[key] != null).map((key) => [key, row[key]])),
					created_by_id: target.uid,
					related_model: 'Message',
					related_record_id: target.message_id,
					field: 'attachments',
					index_if_is_array: index,
					inside_array: true,
					chatUpload: defined({
						...as_object(row.chatUpload),
						ownerUserId: target.uid,
						conversationId: target.conversation_id,
						clientUploadId: undefined,
						boundAt: target.at,
					}),
				}),
			);
			copies.push({ ...info, attachmentId: str(copy._id) });
		}
	} catch (err) {
		await drop_copies(store, copies);
		throw err;
	}
	return copies;
}

type Outgoing = {
	id: string;
	text: string;
	kind: string;
	attachments: ImperiumDoc[];
	search_field: string | null;
	/** Lo demás del payload: encuesta, voz, tarjeta, enlaces, menciones, origen. */
	content: ImperiumDoc;
};

type OutgoingTarget = { conversation: ImperiumDoc; legacy: ImperiumDoc; share_read: boolean };

/** Escribe y publica un mensaje de quien actúa armado por el servidor; un fallo quita las filas copiadas. */
async function insert_outgoing(
	ctx: ChatCtx,
	target: OutgoingTarget,
	out: Outgoing,
	settings: ChatSettings,
): Promise<{ message: ImperiumDoc; view: ImperiumDoc }> {
	const { conversation, legacy } = target;
	const uid = actor_id(ctx);
	const at = new Date().toISOString();
	const conversation_id = str(conversation._id);
	let result: Awaited<ReturnType<ImperiumStore['chat_insert_message']>> = null;
	try {
		result = await ctx.store.chat_insert_message({
			id: out.id,
			conversation_id,
			sender_user_id: uid,
			client_id: null,
			kind: out.kind,
			name: str(legacy.title) || str(conversation.name),
			search_field: out.search_field,
			payload: defined({
				...legacy,
				...out.content,
				message: out.text,
				senderUserId: uid,
				senderName: actor_name(ctx),
				senderEmail: str(ctx.actor?.email) || undefined,
				sourceType: 'chat',
				conversationId: conversation_id,
				rev: 0,
				attachments: out.attachments.length ? out.attachments : undefined,
			}),
			preview: defined({
				messageId: out.id,
				senderId: uid,
				senderName: actor_name(ctx),
				kind: out.kind,
				textPreview: (
					out.text ||
					str(as_object(out.content.poll).question) ||
					str(as_object(out.content.recordCard).label)
				).slice(0, 160),
				at,
				attachmentKind: out.attachments[0] ? attachment_view(out.attachments[0]).kind : undefined,
			}),
			expires_at: expiry_of(conversation, settings, Date.parse(at)),
			share_read: target.share_read,
			attachment_ids: [],
			now: at,
		});
	} finally {
		if (!result) await drop_copies(ctx.store, out.attachments);
	}
	if (!result) throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	const view = message_view(result.message, str(conversation.conversation_key), new Map([[uid, actor_brief(ctx)]]), [], undefined, uid);
	await publish_message(ctx.store, conversation, result.message, view, settings);
	return { message: result.message, view };
}

/**
 * Contrato §4.1: hasta 20 mensajes a hasta 10 conversaciones, del más viejo al más nuevo. Se
 * reenvía el contenido, sin cita ni menciones y con solo el nombre de quien lo escribió; `text`
 * va después, como mensaje propio, en cada conversación.
 */
export async function forward_chat_messages(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const message_ids = id_list(ctx.body.message_ids);
	const conversation_ids = id_list(ctx.body.conversation_ids);
	if (ctx.body.text != null && typeof ctx.body.text !== 'string') throw invalid();
	const text = str(ctx.body.text);
	if (
		!message_ids.length ||
		message_ids.length > FORWARD_MESSAGES_MAX ||
		!conversation_ids.length ||
		conversation_ids.length > FORWARD_TARGETS_MAX
	) {
		throw invalid(`Reenvía de 1 a ${FORWARD_MESSAGES_MAX} mensajes a de 1 a ${FORWARD_TARGETS_MAX} conversaciones.`);
	}
	assert_text_length(text);
	const sources = await forward_sources(ctx, message_ids);
	const now = Date.now();
	const files = sources.some((source) => as_array(source.attachments).length > 0 || Boolean(source.recordCard));
	const polls = sources.some((source) => Boolean(source.poll));
	const targets: Array<{ conversation: ImperiumDoc; member: ImperiumDoc; mention: MentionPlan }> = [];
	for (const id of conversation_ids) {
		const conversation = await find_chat_conversation(ctx.store, id);
		const member = await assert_chat_member(ctx.store, conversation, uid);
		assert_can_send(conversation, member, { attachments: files, poll: polls, now });
		const mention = await plan_mentions(ctx, conversation, member, text, {
			confirmed: flag(ctx.body.confirm_mass_mention) === true,
			threshold: settings.mass_mention_threshold,
		});
		targets.push({ conversation, member, mention });
	}
	for (const { conversation, member } of targets) {
		const slow = slow_mode(conversation, member, uid, now);
		if (slow) return slow;
	}
	const forwarding = take_token(`chat-forward:${uid}`, FORWARD_RATE);
	if (!forwarding.ok) return rate_limited_response(forwarding.retry_after_s);
	const allowed = take_token(`chat-send:${uid}`, SEND_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const share_read = shares_read_receipts(await ctx.store.chat_privacy(uid));
	const links = text_links(text);
	const views: ImperiumDoc[] = [];
	for (const { conversation, mention } of targets) {
		const conversation_id = str(conversation._id);
		const legacy = DIRECT_KINDS.has(str(conversation.kind))
			? await legacy_fields(ctx, conversation, new Date().toISOString())
			: {};
		const target = { conversation, legacy, share_read };
		for (const source of sources) {
			const id = new_id();
			const at = new Date().toISOString();
			const origin = source.forwardedFrom
				? as_object(source.forwardedFrom)
				: { senderName: source.senderName, at: source.created_at };
			const poll = source.poll ? forwarded_poll(source, uid) : undefined;
			const attachments = await copy_attachments(ctx.store, source, {
				uid,
				conversation_id,
				message_id: id,
				at,
			});
			const sent = await insert_outgoing(
				ctx,
				target,
				{
					id,
					text: String(source.message ?? ''),
					kind: str(source.kind) || 'text',
					attachments,
					search_field: (source.search_field as string | null) ?? null,
					content: defined({
						poll,
						voice: source.voice,
						recordCard: source.recordCard,
						links: source.links,
						forwardedFrom: { senderName: str(origin.senderName), at: str(origin.at) },
					}),
				},
				settings,
			);
			views.push(sent.view);
		}
		if (!text) continue;
		const sent = await insert_outgoing(
			ctx,
			target,
			{
				id: new_id(),
				text,
				kind: 'text',
				attachments: [],
				search_field: search_text([text]),
				content: defined({ links: links.length ? links : undefined, mentions: mention.mentions }),
			},
			settings,
		);
		views.push(sent.view);
		await register_mentions(ctx, conversation, sent.message, mention.recipients);
	}
	return ok(views, 'Mensajes reenviados.');
}

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'voice', 'file', 'link']);
const MEDIA_LIMIT = { fallback: 30, max: 60 };

/** Contrato §4.1: la galería de un tipo, de lo más nuevo a lo más viejo; `next_cursor` es el `before_seq` que sigue. */
export async function read_conversation_media(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.conversationId));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	const type = str(ctx.url.searchParams.get('type'));
	if (!MEDIA_TYPES.has(type)) throw invalid('Indica qué medios ver (type).');
	const page = await ctx.store.chat_media_page({
		conversation_id: str(conversation._id),
		visible_from: Number(member.visibleFromSeq) || 0,
		viewer_id: uid,
		type,
		before_seq: seq_param(ctx.url, 'before_seq'),
		limit: limit_param(ctx.url, 'limit', MEDIA_LIMIT),
	});
	const users = new Map(
		(await ctx.store.chat_users_brief(page.rows.map((row) => str(row.sender_user_id)))).map((user) => [user._id, user]),
	);
	const items = page.rows.flatMap((row): ImperiumDoc[] => {
		if (row.viewOnce) return [];
		const sender_id = str(row.sender_user_id);
		const user = users.get(sender_id);
		const item = {
			message_id: str(row._id),
			seq: Number(row.seq),
			created_at: str(row.created_at),
			sender: sender_id ? defined({ _id: sender_id, name: user?.name || str(row.senderName), img: user?.img }) : null,
		};
		if (type === 'link') return as_array(row.links).map((link) => ({ ...item, link: String(link) }));
		return as_array(row.attachments)
			.map((info) => attachment_view(info))
			.filter((attachment) => attachment.kind === type)
			.map((attachment) => ({ ...item, attachment }));
	});
	const last = page.rows.at(-1);
	return page_response(items, 'Medios cargados.', { next_cursor: page.more && last ? String(last.seq) : null });
}

const MEDIA_TOKEN_RATE = { capacity: 30, refill_per_s: 30 / 60 };
const MEDIA_TOKENS_MAX = 100;
const MEDIA_TOKEN_TTL_S = 600;
const VIEW_ONCE_TOKEN_TTL_S = 120;

function media_token_view(uid: string, attachment_id: string, exp: number): ImperiumDoc {
	return {
		attachment_id,
		url: `/api/media/${attachment_id}?mt=${sign_realtime_token({ t: 'media', sub: `u:${uid}`, aid: attachment_id, exp })}`,
		expires_at: new Date(exp * 1000).toISOString(),
	};
}

/**
 * Contrato §4.1: un token de 10 minutos por adjunto del chat que quien lo pide ve; los demás se
 * omiten. Filas, mensajes y membresías se leen en lote y cada adjunto pasa por la regla de /api/media.
 */
export async function issue_media_tokens(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const ids = id_list(ctx.body.attachment_ids);
	if (!ids.length || ids.length > MEDIA_TOKENS_MAX) throw invalid(`Pide de 1 a ${MEDIA_TOKENS_MAX} archivos (attachment_ids).`);
	const allowed = take_token(`chat-media-tokens:${uid}`, MEDIA_TOKEN_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const read = { take: ids.length, populate: false, skip_total: true };
	const attachments = (await ctx.store.find_many('attachment-management', { ...read, ids })).rows.filter((row) =>
		CHAT_ATTACHMENT_MODELS.has(str(row.related_model)),
	);
	const avatar = (row: ImperiumDoc) => str(row.related_model) === 'ChatConversation';
	const message_ids = attachments.filter((row) => !avatar(row)).map((row) => str(row.related_record_id)).filter(Boolean);
	const messages = message_ids.length ? (await ctx.store.find_many('messages', { ...read, ids: message_ids })).rows : [];
	const conversation_ids = [
		...new Set([
			...messages.map((row) => str(row.conversation_id)),
			...attachments.filter(avatar).map((row) => str(row.related_record_id)),
		]),
	].filter(Boolean);
	const memberships = conversation_ids.length
		? (await ctx.store.find_many('chat-members', { ...read, where: { user_id: uid, conversation_id: { in: conversation_ids } } })).rows
		: [];
	const by_message = new Map(messages.map((row) => [str(row._id), row]));
	const by_conversation = new Map(memberships.map((row) => [str(row.conversation_id), row]));
	// Lo de los mensajes ya está leído en lote; una historia o un programado se lee aparte.
	const preloaded: Pick<ImperiumStore, 'find_id' | 'find_many' | 'chat_contact_owners'> = {
		chat_contact_owners: (viewer_id, owner_ids) => ctx.store.chat_contact_owners(viewer_id, owner_ids),
		find_id: async (resource, id) => (resource === 'messages' ? (by_message.get(id) ?? null) : ctx.store.find_id(resource, id)),
		find_many: async (resource, opts = {}) => {
			if (resource !== 'chat-members') return ctx.store.find_many(resource, opts);
			const row = by_conversation.get(str(opts.where?.conversation_id));
			return { rows: row ? [row] : [], total: row ? 1 : 0 };
		},
	};
	const exp = Math.floor(Date.now() / 1000) + MEDIA_TOKEN_TTL_S;
	const tokens: ImperiumDoc[] = [];
	for (const row of attachments) {
		try {
			await assert_attachment_access(preloaded, ctx.actor, row);
		} catch (err) {
			if (err instanceof ChatError) continue;
			throw err;
		}
		tokens.push(media_token_view(uid, str(row._id), exp));
	}
	return ok(tokens, 'Tokens de medios listos.');
}

/**
 * Contrato §4.1: quien recibe una foto o un video de ver una vez lo abre una sola vez y tiene
 * 2 minutos para verlo; quien lo envió no lo gasta. Abrirlo cambia la vista de quien abre y la
 * de quien lo envió, que se entera de quién lo abrió y cuándo; nadie más.
 */
export async function open_view_once(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const { message } = await message_target(ctx);
	assert_live(message);
	if (!message.viewOnce) throw new ChatError(409, 'not_view_once', 'Este mensaje no es de ver una vez.');
	if (str(message.sender_user_id) !== uid) {
		// Recíproco como el resto de los acuses: quien no los comparte deja saber que lo abrió, no cuándo.
		const record_at = shares_read_receipts(await ctx.store.chat_privacy(uid));
		const opened = await ctx.store.chat_open_view_once(str(message._id), uid, new Date().toISOString(), record_at);
		if (!opened) throw new ChatError(410, 'view_once_opened', 'Ya abriste este mensaje.');
		const sender_id = str(opened.sender_user_id);
		const opened_for = (viewer_id: string): ImperiumDoc => ({
			conversation_id: str(opened.conversation_id),
			op: 'message_updated',
			seq: Number(opened.seq),
			message_id: str(opened._id),
			patch: {
				view_once: view_once_view(as_object(opened.viewOnce), sender_id, viewer_id),
				rev: Number(opened.rev) || 0,
				updated_at: str(opened.updated_at),
			},
		});
		emit_chat_deltas([uid], [opened_for(uid)]);
		if (sender_id && (await still_sees(ctx.store, opened, sender_id))) emit_chat_deltas([sender_id], [opened_for(sender_id)]);
	}
	const exp = Math.floor(Date.now() / 1000) + VIEW_ONCE_TOKEN_TTL_S;
	return ok(
		as_array(message.attachments).map((info) => media_token_view(uid, str(as_object(info).attachmentId), exp)),
		'Listo para verse una vez.',
	);
}

const SEARCH_RATE = { capacity: 30, refill_per_s: 30 / 60 };
const SEARCH_LIMIT = { fallback: 20, max: 50 };
const LEGACY_SEARCH_LIMIT = { fallback: 25, max: 100 };
/** Menos letras no aprovechan el índice de trigramas: solo valen dentro de una conversación. */
const SEARCH_MIN_CHARS = 3;
const SEARCH_HAS = new Set(['file', 'image', 'link', 'voice']);
const SNIPPET_BEFORE = 40;
const SNIPPET_MAX = 160;

/** El tramo de lo encontrado (el texto, un archivo, la encuesta o la tarjeta) alrededor de la coincidencia sin acentos. */
function search_snippet(message: ImperiumDoc, needle: string): string {
	const candidates = [
		String(message.message ?? ''),
		...as_array(message.attachments).map((attachment) => str(as_object(attachment).name)),
		str(as_object(message.poll).question),
		str(as_object(message.recordCard).label),
	];
	const chars = [...(candidates.find((text) => fold(text).includes(needle)) ?? candidates[0]!)];
	const origin: number[] = [];
	let folded = '';
	chars.forEach((char, index) => {
		const part = fold(char);
		folded += part;
		for (let i = 0; i < part.length; i++) origin.push(index);
	});
	const at = folded.indexOf(needle);
	const start = at < 0 ? 0 : Math.max(0, origin[at]! - SNIPPET_BEFORE);
	const end = Math.min(chars.length, start + SNIPPET_MAX);
	return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

/** La forma heredada (contrato §8): documentos de directos y self, con quién es la otra persona. */
async function legacy_search(ctx: ChatCtx): Promise<unknown> {
	const uid = actor_id(ctx);
	const params = ctx.url.searchParams;
	const needle = search_text([str(params.get('term') ?? params.get('termino'))]);
	if (!needle) return ok([], 'Debes indicar un texto para buscar en el chat.');
	const participant_id = str(params.get('participant_id') ?? params.get('participantId'));
	if (!participant_id && [...needle].length < SEARCH_MIN_CHARS) return ok([], 'Escribe al menos 3 letras para buscar.');
	const allowed = take_token(`chat-search:${uid}`, SEARCH_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	let conversation_id: string | undefined;
	if (participant_id) {
		const conversation_key = [...new Set([uid, participant_id])].sort().join('::');
		const conversation = await ctx.store.find_where('chat-conversations', { conversation_key });
		if (!conversation) return ok([], 'Coincidencias del chat cargadas correctamente.');
		conversation_id = str(conversation._id);
	}
	const rows = await ctx.store.chat_search({
		user_id: uid,
		needle,
		conversation_id,
		kinds: [...DIRECT_KINDS],
		limit: limit_param(ctx.url, 'limit', LEGACY_SEARCH_LIMIT),
	});
	const others = rows.map((row) => row.conversation_key.split('::').find((id) => id !== uid) ?? '');
	const users = new Map((await ctx.store.chat_users_brief(others)).map((user) => [user._id, user]));
	return ok(
		rows.map((row, index) => {
			const other = others[index]!;
			return defined({
				conversation_key: row.conversation_key,
				other_participant: other ? { _id: other, name: users.get(other)?.name || other } : undefined,
				message: legacy_doc(row.message, uid),
			});
		}),
		participant_id
			? 'Coincidencias del chat cargadas correctamente.'
			: 'Coincidencias globales del chat cargadas correctamente.',
	);
}

/**
 * Contrato §8: con `q`, la forma nueva, con filtros y cursor; con `term`, la heredada. Las dos
 * buscan en SQL, sin acentos, solo en lo que quien busca ve.
 */
export async function search_chat_messages(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const params = ctx.url.searchParams;
	if (!params.has('q')) return legacy_search(ctx);
	const uid = actor_id(ctx);
	const needle = search_text([str(params.get('q'))]) ?? '';
	const conversation_id = str(params.get('conversation_id'));
	if (!needle || (!conversation_id && [...needle].length < SEARCH_MIN_CHARS)) {
		throw new ChatError(400, 'search_term_too_short', 'Escribe al menos 3 letras para buscar.');
	}
	const has = str(params.get('has'));
	if (has && !SEARCH_HAS.has(has)) throw invalid();
	const raw_cursor = str(params.get('cursor'));
	const cursor = raw_cursor ? chat_cursor(raw_cursor) : undefined;
	const limit = limit_param(ctx.url, 'limit', SEARCH_LIMIT);
	const allowed = take_token(`chat-search:${uid}`, SEARCH_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const rows = await ctx.store.chat_search({
		user_id: uid,
		needle,
		conversation_id: conversation_id || undefined,
		from: str(params.get('from')) || undefined,
		has: has || undefined,
		before: iso_param(ctx.url, 'before'),
		after: iso_param(ctx.url, 'after'),
		cursor,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	const keys = new Map(page.map((row) => [str(row.message._id), row.conversation_key]));
	const views = await message_views(
		ctx,
		page.map((row) => row.message),
		(row) => keys.get(str(row._id)) ?? '',
	);
	const last = page.at(-1)?.message;
	return page_response(
		views.map((view, index) => ({
			conversation_id: view.conversation_id,
			message: view,
			snippet: search_snippet(page[index]!.message, needle),
		})),
		'Coincidencias del chat.',
		{ next_cursor: rows.length > limit && last ? encode_cursor(str(last.created_at), str(last._id)) : null },
	);
}

const SCHEDULE_MIN_MS = 60_000;
const SCHEDULE_MAX_MS = 365 * 24 * 3600_000;
const SCHEDULED_LIST_MAX = 100;
const SCHEDULED_ATTEMPTS = 5;
/** Lo enviado ya está en el hilo y lo cancelado ya no existe: la lista muestra lo que falta. */
const SCHEDULED_OPEN = ['pending', 'sending', 'failed'];

function scheduled_not_pending(): ChatError {
	return new ChatError(409, 'scheduled_not_pending', 'Ese mensaje programado ya no se puede cambiar.');
}

function scheduled_send_at(value: unknown, now: number): string {
	const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(at) || at < now + SCHEDULE_MIN_MS || at > now + SCHEDULE_MAX_MS) {
		throw new ChatError(422, 'invalid_send_at', 'Elige una fecha entre un minuto y un año a partir de ahora.');
	}
	return new Date(at).toISOString();
}

/** `ScheduledView` (contrato §3.7); los adjuntos de todos salen en una consulta. */
async function scheduled_views(store: ImperiumStore, rows: ImperiumDoc[]): Promise<ImperiumDoc[]> {
	const ids = rows.flatMap((row) => as_array(as_object(row.request).attachmentIds).map(String));
	const uploads = ids.length
		? (await store.find_many('attachment-management', { ids, take: ids.length, populate: false, skip_total: true })).rows
		: [];
	const by_id = new Map(uploads.map((upload) => [str(upload._id), upload]));
	return rows.map((row) => {
		const request = as_object(row.request);
		const meta = attachments_meta(request.attachmentsMeta);
		return defined({
			_id: str(row._id),
			conversation_id: str(row.conversation_id),
			send_at: str(row.send_at),
			state: str(row.state),
			text: String(request.text ?? ''),
			reply_to_message_id: str(request.replyToMessageId) || undefined,
			attachments: as_array(request.attachmentIds).flatMap((id) => {
				const upload = by_id.get(String(id));
				return upload ? [attachment_view(upload_info(upload, meta.get(String(id))))] : [];
			}),
			message_id: str(row.messageId) || undefined,
			error: str(row.error) || undefined,
		});
	});
}

async function own_scheduled(ctx: ChatCtx): Promise<ImperiumDoc> {
	const id = str(ctx.params.id);
	const row = CHAT_ID.test(id) ? await ctx.store.find_id('chat-scheduled', id) : null;
	if (!row || row.is_active === false || str(row.sender_user_id) !== actor_id(ctx)) throw message_not_found();
	return row;
}

/** Contrato §4.2: los programados propios de la conversación que aún no salen o que fallaron. */
export async function read_scheduled_messages(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	await assert_chat_member(ctx.store, conversation, uid);
	const { rows } = await ctx.store.find_many('chat-scheduled', {
		where: { conversation_id: str(conversation._id), sender_user_id: uid, state: { in: SCHEDULED_OPEN } },
		sort: 'send_at:asc',
		take: SCHEDULED_LIST_MAX,
		populate: false,
		skip_total: true,
	});
	return ok(await scheduled_views(ctx.store, rows), 'Mensajes programados.');
}

/**
 * Contrato §4.2: se valida como un envío (rol, adjuntos, encuesta, menciones con su confirmación) y
 * se guarda lo pedido tal cual, para enviarlo después por el flujo normal. Las subidas quedan ligadas
 * al programado: así la limpieza de 24 h no las toca y solo su autor las ve.
 */
export async function create_scheduled_message(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(ctx.params.id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	const request = send_request(ctx.body);
	if (request.legacy) throw invalid('Falta el identificador del envío (client_id).');
	if (request.view_once || request.record_ref) {
		throw invalid('Un mensaje programado no puede ser de ver una vez ni llevar la tarjeta de un registro.');
	}
	const now = Date.now();
	const send_at = scheduled_send_at(ctx.body.send_at, now);
	const attachment_count = request.attachment_ids.length + request.files.length;
	assert_can_send(conversation, member, { attachments: attachment_count > 0, poll: Boolean(request.poll), now });
	if (!request.text && !attachment_count && !request.poll) {
		throw invalid('Debes escribir un mensaje o adjuntar al menos un archivo.');
	}
	assert_text_length(request.text);
	if (attachment_count > MAX_ATTACHMENTS) {
		throw new ChatError(422, 'too_many_attachments', `Puedes enviar hasta ${MAX_ATTACHMENTS} archivos por mensaje.`);
	}
	for (const file of request.files) assert_upload_size(file, settings);
	const picked = await pending_uploads(ctx.store, request.attachment_ids, uid, conversation);
	if (request.reply_to_message_id) await reply_preview(ctx.store, request.reply_to_message_id, conversation, member);
	await plan_mentions(ctx, conversation, member, request.text, {
		confirmed: request.confirm_mass_mention,
		threshold: settings.mass_mention_threshold,
	});
	const allowed = take_token(`chat-send:${uid}`, SEND_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	const id = new_id();
	const at = new Date(now).toISOString();
	const stored = await store_files(ctx.store, request.files, uid, conversation);
	const attachment_ids = [...picked, ...stored].map((row) => str(row._id));
	const row = await ctx.store.insert('chat-scheduled', {
		_id: id,
		name: '',
		created_by: uid,
		conversation_id: str(conversation._id),
		sender_user_id: uid,
		send_at,
		state: 'pending',
		clientId: request.client_id,
		request: defined({
			text: request.text,
			replyToMessageId: request.reply_to_message_id || undefined,
			attachmentIds: attachment_ids.length ? attachment_ids : undefined,
			attachmentsMeta: request.meta.size ? json_field(ctx.body.attachments_meta) : undefined,
			poll: request.poll ? json_field(ctx.body.poll) : undefined,
			confirmMassMention: request.confirm_mass_mention || undefined,
		}),
		attempts: 0,
	});
	if (!(await ctx.store.chat_bind_uploads(attachment_ids, uid, 'ChatScheduled', id, at))) {
		await ctx.store.remove('chat-scheduled', id);
		await discard_uploads(ctx.store, stored);
		throw new ChatError(422, 'invalid_attachment', 'Uno de los archivos no es válido o ya no está disponible.');
	}
	return ok(await scheduled_views(ctx.store, [row]), 'Mensaje programado.');
}

/** Contrato §4.2: la hora o el texto, mientras siga pendiente; el texto nuevo vuelve a validar sus menciones. */
export async function update_scheduled_message(ctx: ChatCtx): Promise<unknown> {
	const settings = await enabled_settings(ctx.store);
	const uid = actor_id(ctx);
	const row = await own_scheduled(ctx);
	const conversation = await find_chat_conversation(ctx.store, str(row.conversation_id));
	const member = await assert_chat_member(ctx.store, conversation, uid);
	if (ctx.body.send_at === undefined && ctx.body.text === undefined) throw invalid();
	const send_at = ctx.body.send_at === undefined ? undefined : scheduled_send_at(ctx.body.send_at, Date.now());
	const request = as_object(row.request);
	let merge: ImperiumDoc = {};
	if (ctx.body.text !== undefined) {
		if (typeof ctx.body.text !== 'string') throw invalid();
		const text = ctx.body.text.trim();
		assert_text_length(text);
		if (!text && !as_array(request.attachmentIds).length && !request.poll) {
			throw invalid('Debes escribir un mensaje o adjuntar al menos un archivo.');
		}
		const confirmed = flag(ctx.body.confirm_mass_mention) === true;
		await plan_mentions(ctx, conversation, member, text, { confirmed, threshold: settings.mass_mention_threshold });
		merge = { request: defined({ ...request, text, confirmMassMention: confirmed || undefined }) };
	}
	const updated = await ctx.store.chat_update_scheduled({
		id: str(row._id),
		sender_user_id: uid,
		from: 'pending',
		send_at,
		merge,
		now: new Date().toISOString(),
	});
	if (!updated) throw scheduled_not_pending();
	return ok(await scheduled_views(ctx.store, [updated]), 'Mensaje programado actualizado.');
}

/** Contrato §4.2: cancelar mientras siga pendiente; sus subidas ya no van a salir. */
export async function cancel_scheduled_message(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const row = await own_scheduled(ctx);
	const cancelled = await ctx.store.chat_update_scheduled({
		id: str(row._id),
		sender_user_id: actor_id(ctx),
		from: 'pending',
		to: 'cancelled',
		now: new Date().toISOString(),
	});
	if (!cancelled) throw scheduled_not_pending();
	const ids = as_array(as_object(cancelled.request).attachmentIds).map(String);
	if (ids.length) {
		const { rows } = await ctx.store.find_many('attachment-management', { ids, take: ids.length, populate: false, skip_total: true });
		await discard_uploads(ctx.store, rows);
	}
	return ok(await scheduled_views(ctx.store, [cancelled]), 'Mensaje programado cancelado.');
}

/**
 * Contrato §1.6: el programado sale por el flujo normal, como si su autor lo enviara ahora, con su
 * `client_id`: si una corrida anterior ya lo había enviado, no se repite. Un 429 lo deja pendiente
 * hasta que el servidor dice que ya puede (hasta 5 intentos); un envío negado lo deja `failed` y
 * avisa a su autor.
 */
export async function send_scheduled(store: ImperiumStore, row: ImperiumDoc): Promise<void> {
	const id = str(row._id);
	const uid = str(row.sender_user_id);
	const conversation_id = str(row.conversation_id);
	const request = as_object(row.request);
	const attempts = (Number(row.attempts) || 0) + 1;
	const finish = (to: string, merge: ImperiumDoc, send_at?: string) =>
		store.chat_update_scheduled({ id, from: 'sending', to, send_at, merge: { ...merge, attempts }, now: new Date().toISOString() });
	const actor = await store.find_id('user', uid);
	const url = new URL('http://core/api/messages/chat');
	let error: string;
	try {
		if (!actor || actor.is_active === false) throw new ChatError(403, 'user_inactive', 'Esa persona ya no está activa.');
		const result = await create_chat_message({
			store,
			req: new Request(url, { method: 'POST' }),
			url,
			params: {},
			actor,
			scheduled_id: id,
			body: defined({
				conversation_id,
				client_id: str(row.clientId),
				text: String(request.text ?? ''),
				reply_to_message_id: request.replyToMessageId,
				attachment_ids: request.attachmentIds,
				attachments_meta: request.attachmentsMeta,
				poll: request.poll,
				confirm_mass_mention: request.confirmMassMention,
			}),
		});
		if (!(result instanceof Response)) {
			await finish('sent', { messageId: str(as_object(as_array(as_object(result).data)[0])._id) });
			return;
		}
		if (attempts < SCHEDULED_ATTEMPTS) {
			// Sin esperar, la misma pasada lo volvería a reclamar y gastaría sus intentos de golpe.
			const retry_after_s = Number(result.headers.get('retry-after')) || 30;
			await finish('pending', {}, new Date(Date.now() + retry_after_s * 1000).toISOString());
			return;
		}
		error = str(as_object(await result.json()).message);
	} catch (err) {
		if (!(err instanceof ChatError)) throw err;
		error = err.message;
	}
	await finish('failed', { error });
	await insert_notification(store, {
		recipientId: uid,
		type: 'chat-scheduled-failed',
		title: 'No se pudo enviar tu mensaje programado',
		message: error,
		isRead: false,
		source: {
			kind: 'chat',
			action: 'scheduled_failed',
			conversationId: conversation_id,
			route: `/mensajes?chat_conversation_id=${conversation_id}`,
		},
		payload: { scheduled_id: id },
	});
}

const SAVED_LIMIT = { fallback: 20, max: 50 };
const SAVED_STATES = new Set(['pending', 'notified', 'done']);
const SAVED_NOTE_MAX = 500;
const REMIND_MAX_MS = 365 * 24 * 3600_000;

function saved_not_found(): ChatError {
	return new ChatError(404, 'saved_not_found', 'No encontramos ese guardado.');
}

function saved_note(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length > SAVED_NOTE_MAX) {
		throw invalid(`La nota admite hasta ${SAVED_NOTE_MAX} caracteres.`);
	}
	return value.trim();
}

/** Un recordatorio en el futuro, hasta un año; `null` lo quita. */
function saved_remind_at(value: unknown, now: number): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null || value === '') return null;
	const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(at) || at <= now || at > now + REMIND_MAX_MS) {
		throw invalid('Elige un recordatorio en el futuro, hasta un año.');
	}
	return new Date(at).toISOString();
}

/** `SavedView` (contrato §3.7): el mensaje sale solo mientras quien lo guardó aún lo vea. */
async function saved_views(ctx: ChatCtx, rows: ImperiumDoc[]): Promise<ImperiumDoc[]> {
	const uid = actor_id(ctx);
	const read = { populate: false, skip_total: true };
	const ids = rows.map((row) => str(row.message_id));
	const messages = ids.length ? (await ctx.store.find_many('messages', { ...read, ids, take: ids.length })).rows : [];
	const conversation_ids = [...new Set(messages.map((message) => str(message.conversation_id)))];
	const [memberships, conversations] = conversation_ids.length
		? await Promise.all([
				ctx.store.find_many('chat-members', {
					...read,
					take: conversation_ids.length,
					where: { user_id: uid, conversation_id: { in: conversation_ids } },
				}),
				ctx.store.find_many('chat-conversations', { ...read, ids: conversation_ids, take: conversation_ids.length }),
			])
		: [{ rows: [] }, { rows: [] }];
	const members = new Map(memberships.rows.filter((row) => row.state === 'active').map((row) => [str(row.conversation_id), row]));
	const keys = new Map(conversations.rows.map((row) => [str(row._id), str(row.conversation_key)]));
	const now = new Date().toISOString();
	const visible = messages.filter((message) => {
		const member = members.get(str(message.conversation_id));
		return (
			member &&
			!message.deleted &&
			!(message.expires_at && str(message.expires_at) <= now) &&
			Number(message.seq) > (Number(member.visibleFromSeq) || 0) &&
			!hidden_for(message, uid)
		);
	});
	const views = new Map(
		(await message_views(ctx, visible, (row) => keys.get(str(row.conversation_id)) ?? '')).map((view) => [str(view._id), view]),
	);
	return rows.map((row) => {
		const preview = as_object(row.preview);
		return defined({
			_id: str(row._id),
			conversation_id: str(row.conversationId),
			message: views.get(str(row.message_id)) ?? null,
			preview: {
				sender_name: str(preview.senderName),
				text_preview: String(preview.textPreview ?? ''),
				kind: str(preview.kind) || 'text',
				at: str(preview.at),
			},
			note: str(row.note) || undefined,
			remind_at: str(row.remind_at) || undefined,
			state: str(row.state),
			created_at: str(row.created_at),
		});
	});
}

/** Contrato §4.1: uno por persona y mensaje; guardarlo otra vez cambia la nota o el recordatorio. */
export async function save_chat_message(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const { message } = await message_target(ctx);
	assert_live(message);
	const now = Date.now();
	const note = ctx.body.note == null || ctx.body.note === '' ? undefined : saved_note(ctx.body.note);
	const row = await ctx.store.chat_save_message({
		id: new_id(),
		user_id: actor_id(ctx),
		message_id: str(message._id),
		remind_at: saved_remind_at(ctx.body.remind_at, now) ?? null,
		payload: defined({
			conversationId: str(message.conversation_id),
			note,
			preview: {
				senderName: str(message.senderName),
				textPreview: String(message.message ?? '').slice(0, 160),
				kind: str(message.kind) || 'text',
				at: str(message.created_at),
			},
		}),
		now: new Date(now).toISOString(),
	});
	return ok(await saved_views(ctx, [row]), 'Mensaje guardado.');
}

/** Contrato §4.1: los guardados propios, del más nuevo al más viejo. */
export async function read_saved_messages(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const state = str(ctx.url.searchParams.get('state'));
	if (state && !SAVED_STATES.has(state)) throw invalid();
	const raw_cursor = str(ctx.url.searchParams.get('cursor'));
	const limit = limit_param(ctx.url, 'limit', SAVED_LIMIT);
	const { rows } = await ctx.store.find_many('chat-saved', {
		where: { user_id: actor_id(ctx), state: state || undefined },
		sort: 'created_at:desc',
		before_created: raw_cursor ? chat_cursor(raw_cursor) : undefined,
		take: limit + 1,
		populate: false,
		skip_total: true,
	});
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return page_response(await saved_views(ctx, page), 'Mensajes guardados.', {
		next_cursor: rows.length > limit && last ? encode_cursor(str(last.created_at), str(last._id)) : null,
	});
}

/** Contrato §4.1: la nota, el recordatorio (`null` lo quita) o marcarlo hecho. */
export async function update_saved_message(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	const patch: ChatSavedPatch = { remind_at: saved_remind_at(ctx.body.remind_at, Date.now()) };
	if (ctx.body.note !== undefined) patch.note = ctx.body.note === null || ctx.body.note === '' ? null : saved_note(ctx.body.note);
	if (ctx.body.state !== undefined) {
		if (ctx.body.state !== 'done') throw invalid();
		patch.done = true;
	}
	if (patch.note === undefined && patch.remind_at === undefined && !patch.done) throw invalid();
	const row = await ctx.store.chat_update_saved(str(ctx.params.id), actor_id(ctx), patch, new Date().toISOString());
	if (!row) throw saved_not_found();
	return ok(await saved_views(ctx, [row]), 'Guardado actualizado.');
}

export async function delete_saved_message(ctx: ChatCtx): Promise<unknown> {
	await enabled_settings(ctx.store);
	if (!(await ctx.store.chat_delete_saved(str(ctx.params.id), actor_id(ctx)))) throw saved_not_found();
	return ok([], 'Guardado quitado.');
}
