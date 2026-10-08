/**
 * Acceso a lo privado del chat. Se lee solo por las acciones del chat: nunca por
 * el CRUD genérico, reportes, tableros, MCP, el rastreador ni el motor de
 * búsqueda, ni siquiera como administrador.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { verify_realtime_token } from './realtime-tokens.ts';
import type { ImperiumStore } from './store.ts';

/** notifications y mentions llevan extractos de los chats y son de un solo destinatario. */
const CHAT_PRIVATE_RESOURCES = new Set(['messages', 'notifications', 'mentions']);

/** Todos los recursos nuevos del chat llevan el prefijo `chat-`. */
export function is_chat_private_resource(resource: string): boolean {
	return CHAT_PRIVATE_RESOURCES.has(resource) || resource.startsWith('chat-');
}

/** `Message` lo escribe el chat; `messages`, una subida por el CRUD genérico. */
export const CHAT_ATTACHMENT_MODELS = new Set([
	'Message',
	'messages',
	'ChatConversation',
	'ChatStory',
	'ChatScheduled',
]);

/** Los `contextType` de `mentions` que entran en cada filtro de la bandeja de Actividad (contrato §3.5). */
export const ACTIVITY_CONTEXTS: Record<'chat' | 'history' | 'reactions', string[]> = {
	chat: ['chat-message', 'chat-reply', 'chat-reaction', 'chat-missed-call'],
	history: ['history-comment', 'history-reply', 'document'],
	reactions: ['chat-reaction'],
};

/**
 * Ajustes fijos de un directo o un self (contrato §9): no hay roles, invitaciones ni
 * ajustes que cambiar, y los dos pueden fijar y llamar.
 */
export const DIRECT_CONVERSATION_SETTINGS = {
	announcementOnly: false,
	slowModeSeconds: 0,
	membersCanInvite: false,
	membersCanPin: true,
	membersCanEditInfo: false,
	membersCanCall: true,
	membersCanMentionAll: false,
	ephemeralSeconds: 0,
	historyVisibleToNewMembers: true,
};

export function is_chat_attachment(doc: ImperiumDoc | null): boolean {
	return CHAT_ATTACHMENT_MODELS.has(String(doc?.related_model ?? ''));
}

/** `mongo_match` de las filas de `attachment-management` que no son del chat. */
const NOT_CHAT_ATTACHMENT: Record<string, unknown> = {
	$or: [{ related_model: { $exists: false } }, { related_model: { $nin: [...CHAT_ATTACHMENT_MODELS] } }],
};

/**
 * Cómo cita una fila del historial a un recurso del chat: por recurso (`messages`), por la colección
 * de Mongo (`__messages`) o por el modelo (`Message`). El chat ya no escribe ahí; quedan las de antes.
 */
const CHAT_HISTORY_NAME = '^(__)?([Mm]essages?|[Nn]otifications?|[Mm]entions?|chat[-_].*|Chat[A-Z].*)$';
const CHAT_HISTORY_FIELDS = ['modelName', 'collectionName', 'model'];

/** Una fila sin esos campos sigue visible: `NOT (NULL ~ …)` la habría escondido. */
const NOT_CHAT_HISTORY: Record<string, unknown> = {
	$and: CHAT_HISTORY_FIELDS.map((field) => ({
		$or: [{ [field]: { $exists: false } }, { $nor: [{ [field]: { $regex: CHAT_HISTORY_NAME } }] }],
	})),
};

function is_chat_history(doc: ImperiumDoc | null): boolean {
	const pattern = new RegExp(CHAT_HISTORY_NAME);
	return CHAT_HISTORY_FIELDS.some((field) => doc?.[field] != null && pattern.test(String(doc[field])));
}

/** Recursos compartidos con filas del chat: ningún lector genérico las ve, ni el administrador. */
const CHAT_ROWS: Record<string, Record<string, unknown>> = {
	'attachment-management': NOT_CHAT_ATTACHMENT,
	'document-change-history': NOT_CHAT_HISTORY,
};

export function without_chat_rows(
	resource: string,
	match: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const visible = CHAT_ROWS[resource];
	if (!visible) return match;
	return match ? { $and: [match, visible] } : visible;
}

export function is_chat_row(resource: string, doc: ImperiumDoc | null): boolean {
	if (resource === 'attachment-management') return is_chat_attachment(doc);
	return resource === 'document-change-history' && is_chat_history(doc);
}

export class ChatError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = 'ChatError';
	}
}

export type ChatRole = 'owner' | 'admin' | 'moderator' | 'member' | 'guest';

export type ChatVerb =
	| 'send'
	| 'attach'
	| 'skip_slow_mode'
	| 'edit_own'
	| 'delete_own'
	| 'hide'
	| 'delete_others'
	| 'read_any_info'
	| 'poll'
	| 'react'
	| 'vote'
	| 'close_any_poll'
	| 'mention'
	| 'mention_all'
	| 'edit_info'
	| 'change_settings'
	| 'add_members'
	| 'read_departed'
	| 'restrict'
	| 'remove_member'
	| 'change_role'
	| 'transfer'
	| 'create_invite'
	| 'revoke_invite'
	| 'revoke_own_invite'
	| 'approve_join'
	| 'pin'
	| 'call';

const CHAT_ROLES = new Set<ChatRole>(['owner', 'admin', 'moderator', 'member', 'guest']);
const RANK: Record<ChatRole, number> = { owner: 4, admin: 3, moderator: 2, member: 1, guest: 0 };

export function chat_role(value: unknown): ChatRole {
	return CHAT_ROLES.has(value as ChatRole) ? (value as ChatRole) : 'member';
}

/**
 * La matriz de roles del contrato §9. `settings` como se guarda en el payload (camelCase);
 * `target` es el rol de quien escribió el mensaje o del miembro sobre el que se actúa. En
 * `change_role` vale para el rol de antes y para el nuevo: se pregunta por los dos.
 */
export function chat_can(
	role: ChatRole,
	settings: Record<string, unknown>,
	verb: ChatVerb,
	target: ChatRole = 'owner',
): boolean {
	const staff = role === 'owner' || role === 'admin' || role === 'moderator';
	const manager = role === 'owner' || role === 'admin';
	switch (verb) {
		case 'send':
			return role !== 'member' || settings.announcementOnly !== true;
		case 'attach':
		case 'poll':
			return role !== 'guest' && chat_can(role, settings, 'send');
		case 'skip_slow_mode':
		case 'read_any_info':
		case 'read_departed':
		case 'approve_join':
			return staff;
		case 'change_settings':
		case 'revoke_invite':
			return manager;
		case 'revoke_own_invite':
			return manager || role === 'member';
		case 'create_invite':
			return manager || (role === 'member' && settings.membersCanInvite === true);
		case 'transfer':
			return role === 'owner';
		case 'edit_info':
			return manager || (role === 'member' && settings.membersCanEditInfo === true);
		case 'add_members':
			return staff || (role === 'member' && settings.membersCanInvite === true);
		case 'pin':
			return staff || (role === 'member' && settings.membersCanPin === true);
		case 'call':
			return staff || (role === 'member' && settings.membersCanCall === true);
		case 'restrict':
		case 'remove_member':
			return staff && RANK[target] < RANK[role];
		case 'change_role':
			if (role === 'owner') return target === 'admin' || target === 'moderator' || target === 'member';
			return role === 'admin' && (target === 'moderator' || target === 'member');
		case 'edit_own':
		case 'delete_own':
		case 'hide':
		case 'react':
		case 'vote':
		case 'mention':
			return role !== 'guest';
		case 'mention_all':
			return staff || (role === 'member' && settings.membersCanMentionAll === true);
		case 'close_any_poll':
			return role === 'owner' || role === 'admin';
		case 'delete_others':
			if (role === 'owner') return true;
			if (role === 'admin') return target !== 'owner';
			return role === 'moderator' && (target === 'member' || target === 'guest');
	}
}

const CHAT_ID = /^[a-f0-9]{24}$/i;

/** Un enlace de invitación sirve mientras no se revoque, no caduque y le queden usos. */
export function invite_state(
	invite: Record<string, unknown>,
	now: string,
): 'live' | 'revoked' | 'expired' | 'exhausted' {
	if (invite.revokedAt) return 'revoked';
	if (invite.expiresAt && String(invite.expiresAt) <= now) return 'expired';
	if (invite.maxUses != null && (Number(invite.uses) || 0) >= Number(invite.maxUses)) return 'exhausted';
	return 'live';
}

export async function find_chat_conversation(
	store: Pick<ImperiumStore, 'find_id'>,
	conversation_id: string,
): Promise<ImperiumDoc> {
	const conversation = CHAT_ID.test(conversation_id)
		? await store.find_id('chat-conversations', conversation_id)
		: null;
	if (!conversation || conversation.is_active === false) {
		throw new ChatError(404, 'conversation_not_found', 'No encontramos esa conversación.');
	}
	return conversation;
}

export async function assert_chat_member(
	store: Pick<ImperiumStore, 'find_many'>,
	conversation: ImperiumDoc,
	user_id: string,
): Promise<ImperiumDoc> {
	const { rows } = await store.find_many('chat-members', {
		where: { conversation_id: String(conversation._id), user_id },
		take: 1,
		populate: false,
		skip_total: true,
	});
	const member = rows[0];
	if (!user_id || !member || member.state !== 'active') {
		throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
	}
	return member;
}

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Mexico_City';

export function assert_can_send(
	conversation: ImperiumDoc,
	member: ImperiumDoc,
	opts: { attachments: boolean; poll?: boolean; now: number },
): void {
	const role = chat_role(member.role);
	const settings = as_object(conversation.settings);
	if (!chat_can(role, settings, 'send')) {
		throw new ChatError(403, 'announcement_only', 'Solo los administradores pueden escribir aquí.');
	}
	if ((opts.attachments && !chat_can(role, settings, 'attach')) || (opts.poll && !chat_can(role, settings, 'poll'))) {
		throw new ChatError(403, 'chat_send_denied', 'No puedes enviar mensajes en esta conversación.');
	}
	const until = Date.parse(String(member.restrictedUntil ?? ''));
	if (until > opts.now) {
		const hora = new Date(until).toLocaleString('es-MX', {
			dateStyle: 'short',
			timeStyle: 'short',
			hourCycle: 'h23',
			timeZone: APP_TIMEZONE,
		});
		throw new ChatError(403, 'member_restricted', `No puedes escribir aquí hasta ${hora}.`, {
			restricted_until: new Date(until).toISOString(),
		});
	}
}

async function active_member(
	store: Pick<ImperiumStore, 'find_many'>,
	conversation_id: string,
	user_id: string,
): Promise<ImperiumDoc | null> {
	const { rows } = await store.find_many('chat-members', {
		where: { conversation_id, user_id },
		take: 1,
		populate: false,
		skip_total: true,
	});
	return rows[0]?.state === 'active' ? rows[0] : null;
}

/** Un invitado admitido: la conversación de su reunión y el `seq` desde el que la ve. */
export type GuestReader = { conversation_id: string; visible_from_seq: number };

/**
 * Contrato §6.7: quien sigue en la conversación y desde lo que ve; quien salió o fue expulsado, ya
 * no. `token_user_id`: a quién se emitió el `?mt=` de la petición para este adjunto; el de ver una
 * vez solo lo da `POST /message/:id/open`. `guest`: sin sesión, el invitado admitido de una reunión.
 */
export async function assert_attachment_access(
	store: Pick<ImperiumStore, 'find_id' | 'find_many' | 'chat_contact_owners'>,
	actor: ImperiumDoc | null,
	attachment: ImperiumDoc,
	opts: { token_user_id?: string; guest?: GuestReader | null } = {},
): Promise<void> {
	const model = String(attachment.related_model ?? '');
	const record_id = String(attachment.related_record_id ?? '').trim();
	// Un invitado no tiene sesión: solo alcanza el chat de su reunión, nunca otro archivo.
	if (!actor && opts.guest) {
		if (model !== 'Message' || !record_id) throw attachment_forbidden();
		return assert_guest_access(store, opts.guest, record_id);
	}
	if (!CHAT_ATTACHMENT_MODELS.has(model)) return;
	const actor_id = String(actor?._id ?? '');
	if (actor_id && record_id && model === 'ChatConversation') {
		if (await active_member(store, record_id, actor_id)) return;
		throw attachment_forbidden();
	}
	if (actor_id && record_id && model === 'ChatScheduled') {
		const scheduled = await store.find_id('chat-scheduled', record_id);
		if (String(scheduled?.sender_user_id ?? '') === actor_id) return;
		throw attachment_forbidden();
	}
	if (actor_id && record_id && model === 'ChatStory') return assert_story_access(store, actor_id, record_id);
	// Un modelo del chat sin regla propia se niega.
	if (!actor_id || (model !== 'Message' && model !== 'messages')) throw attachment_forbidden();
	if (!record_id) {
		if (String(attachment.created_by_id ?? '') === actor_id) return;
		throw attachment_forbidden();
	}
	const message = await store.find_id('messages', record_id);
	const expired = Boolean(message?.expires_at) && String(message?.expires_at) <= new Date().toISOString();
	if (!message || message.is_active === false || message.deleted || expired) {
		throw new ChatError(410, 'message_gone', 'Este mensaje se borró o caducó.');
	}
	const conversation_id = String(message.conversation_id ?? '');
	// Lo legado sin conversación lleva sus participantes.
	if (!conversation_id) {
		if (as_array(message.participantUserIds).map(String).includes(actor_id)) return;
		throw attachment_forbidden();
	}
	const member = await active_member(store, conversation_id, actor_id);
	if (!member || Number(message.seq) <= (Number(member.visibleFromSeq) || 0)) throw attachment_forbidden();
	if (message.viewOnce && String(message.sender_user_id ?? '') !== actor_id && opts.token_user_id !== actor_id) {
		throw attachment_forbidden();
	}
}

/** Lo del chat de su reunión que llegó después de su admisión; "ver una vez" nunca. */
async function assert_guest_access(store: Pick<ImperiumStore, 'find_id'>, guest: GuestReader, message_id: string): Promise<void> {
	const message = await store.find_id('messages', message_id);
	const expired = Boolean(message?.expires_at) && String(message?.expires_at) <= new Date().toISOString();
	if (!message || message.is_active === false || message.deleted || expired) {
		throw new ChatError(410, 'message_gone', 'Este mensaje se borró o caducó.');
	}
	if (
		String(message.conversation_id ?? '') !== guest.conversation_id ||
		Number(message.seq) <= guest.visible_from_seq ||
		message.viewOnce
	) {
		throw attachment_forbidden();
	}
}

/** Contrato §6.7: la historia vigente, para su autor y su audiencia (contrato §1.8). */
async function assert_story_access(
	store: Pick<ImperiumStore, 'find_id' | 'find_many' | 'chat_contact_owners'>,
	actor_id: string,
	story_id: string,
): Promise<void> {
	const story = await store.find_id('chat-stories', story_id);
	if (!story || story.is_active === false || String(story.expires_at ?? '') <= new Date().toISOString()) {
		throw new ChatError(410, 'story_expired', 'La historia caducó.');
	}
	const author_id = String(story.author_id ?? '');
	if (author_id === actor_id) return;
	const audience = as_object(story.audience);
	const listed = (key: string) => as_array(audience[key]).map(String).includes(actor_id);
	if (listed('excludeIds')) throw attachment_forbidden();
	if (audience.kind === 'users' && !listed('userIds')) throw attachment_forbidden();
	if (audience.kind === 'contacts' && !(await store.chat_contact_owners(actor_id, [author_id])).length) {
		throw attachment_forbidden();
	}
}

/**
 * Quién pide `/api/media/:id?mt=` sin cookie: el usuario del token, solo para
 * ese adjunto. Un invitado (`g:`) no recibe actor: ningún adjunto tiene regla
 * para invitados.
 */
export function media_token_actor(token: string | null, attachment_id: string): ImperiumDoc | null {
	const claims = token ? verify_realtime_token(token, 'media') : null;
	if (!claims || claims.aid !== attachment_id || !claims.sub.startsWith('u:')) return null;
	return { _id: claims.sub.slice(2) };
}

function attachment_forbidden(): ChatError {
	return new ChatError(403, 'attachment_forbidden', 'No tienes acceso a este archivo.');
}
