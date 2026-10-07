/**
 * Handlers del chat sobre un almacén en memoria con la misma semántica que el SQL del store
 * (que `chat-store.spec.ts` prueba contra Postgres).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle_action } from './actions.ts';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { ACTIVITY_CONTEXTS, DIRECT_CONVERSATION_SETTINGS, invite_state, media_token_actor } from './chat-access.ts';
import type { ImperiumDoc } from './envelope.ts';
import { serve_media } from './media.ts';
import { bind_socket_identity_resolver, handle_socket_io } from './socket-stub.ts';
import { when_deferred_image_optimize_idle } from './uploads.ts';
import { CHAT_SERVER_KINDS } from './store.ts';
import type {
	ChatActivityQuery,
	ChatDeleteInput,
	ChatEditInput,
	ChatInboxQuery,
	ChatMemberQuery,
	ChatMessageInsert,
	ChatPageDirection,
	ChatSearchQuery,
	ImperiumStore,
} from './store.ts';

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const SERVER_KINDS: readonly string[] = CHAT_SERVER_KINDS;

type Tables = Record<string, ImperiumDoc[]>;

function chat_store(config: Record<string, unknown> = {}) {
	const tables: Tables = {
		user: [],
		configuration: Object.entries(config).map(([ref, value]) => ({ _id: hex_id(), _ref: ref, value })),
		'user-settings': [],
		'chat-conversations': [],
		'chat-members': [],
		'chat-reactions': [],
		'chat-audit': [],
		messages: [],
		mentions: [],
		'attachment-management': [],
	};
	const field = (row: ImperiumDoc, key: string) => row[key === 'ref' ? '_ref' : key];
	const matches = (row: ImperiumDoc, where: Record<string, unknown> = {}) =>
		Object.entries(where).every(([key, value]) =>
			value && typeof value === 'object' && 'in' in value
				? (value as { in: unknown[] }).in.includes(field(row, key))
				: field(row, key) === value,
		);
	const member_of = (conversation_id: string, user_id: string) =>
		tables['chat-members']!.find((row) => row.conversation_id === conversation_id && row.user_id === user_id);
	const hidden_for = (row: ImperiumDoc, user_id: string) =>
		((row.hiddenForUserIds as string[] | undefined) ?? []).includes(user_id);
	const live_message = (id: string) => tables.messages!.find((row) => row._id === id && row.is_active !== false && !row.deleted);
	const live_conversation = (id: string) =>
		tables['chat-conversations']!.find((row) => row._id === id && row.is_active !== false);
	/** Como el UPDATE de `memberCount`: se cuenta de las filas activas. */
	const recount = (conversation: ImperiumDoc, now: string) => {
		conversation.memberCount = tables['chat-members']!.filter(
			(row) => row.conversation_id === conversation._id && row.state === 'active',
		).length;
		conversation.updated_at = now;
	};
	const MEMBERSHIP_KEYS = ['joinedAt', 'leftAt', 'requestedAt', 'restrictedUntil', 'invitedById', 'visibleFromSeq', 'mentionSeqs', 'markedUnread'];
	/** Como `chat_media_kind_sql`: el tipo de un adjunto, también el de los legados, o los enlaces. */
	const has_media = (row: ImperiumDoc, type: string) => {
		if (type === 'link') return ((row.links as unknown[] | undefined) ?? []).length > 0;
		return ((row.attachments as ImperiumDoc[] | undefined) ?? []).some((info) => {
			const mime = String(info.mimetype ?? '');
			if (info.kind) return info.kind === type;
			if (info.isImage === true || mime.startsWith('image/')) return type === 'image';
			return type === (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');
		});
	};
	/** Como el CTE: la vista previa de la bandeja cambia solo si era su último mensaje. */
	const touch_last = (message: ImperiumDoc, patch: ImperiumDoc, now: string) => {
		const conversation = tables['chat-conversations']!.find((row) => row._id === message.conversation_id);
		const last = conversation?.lastMessage as ImperiumDoc | undefined;
		if (!conversation || !last || last.messageId !== message._id) return null;
		delete last.attachmentKind;
		Object.assign(last, patch);
		conversation.updated_at = now;
		return last;
	};
	const store = {
		tables,
		has: (resource: string) => resource in tables,
		async find_id(resource: string, id: string) {
			return tables[resource]?.find((row) => row._id === id) ?? null;
		},
		async find_many(
			resource: string,
			opts: {
				where?: Record<string, unknown>;
				ids?: string[];
				take?: number;
				include_inactive?: boolean;
				after_created?: { at: string; id: string };
				mongo_match?: Record<string, unknown>;
			},
		) {
			const after = opts.after_created;
			const hits = (tables[resource] ?? []).filter(
				(row) =>
					(opts.include_inactive || row.is_active !== false) &&
					(!opts.ids || opts.ids.includes(String(row._id))) &&
					matches(row, Object.fromEntries(Object.entries(opts.where ?? {}).filter(([, value]) => value !== undefined))) &&
					matches(row, opts.mongo_match) &&
					(!after || `${row.created_at}|${row._id}` > `${after.at}|${after.id}`),
			);
			return { rows: hits.slice(0, opts.take ?? 100), total: hits.length };
		},
		async insert(resource: string, doc: ImperiumDoc) {
			const row = { is_active: true, created_at: new Date().toISOString(), ...doc, _id: hex_id() };
			tables[resource]!.push(row);
			return row;
		},
		async insert_activity(payloads: ImperiumDoc[]) {
			const rows = await Promise.all(payloads.map((payload) => store.insert('mentions', { ...payload, name: 'mención' })));
			return rows.map((row, n) => ({ id: String(row._id), user_id: String(payloads[n]!.mentionedUserId) }));
		},
		async update(resource: string, id: string, patch: ImperiumDoc) {
			const row = tables[resource]?.find((item) => item._id === id);
			if (!row) return null;
			Object.assign(row, patch);
			return row;
		},
		async remove(resource: string, id: string) {
			return store.update(resource, id, { is_active: false });
		},
		async chat_open_direct(input: { conversation_key: string; user_ids: string[]; created_by: string; now: string }) {
			let conversation = tables['chat-conversations']!.find((row) => row.conversation_key === input.conversation_key);
			if (!conversation) {
				conversation = {
					_id: hex_id(),
					name: '',
					is_active: true,
					kind: input.user_ids.length > 1 ? 'direct' : 'self',
					conversation_key: input.conversation_key,
					last_seq: 0,
					createdById: input.created_by,
					memberCount: input.user_ids.length,
					participantUserIds: input.user_ids,
					settings: { ...DIRECT_CONVERSATION_SETTINGS },
					pins: [],
					invites: [],
					created_at: input.now,
					updated_at: input.now,
				};
				tables['chat-conversations']!.push(conversation);
			}
			for (const user_id of input.user_ids) {
				if (!member_of(String(conversation._id), user_id)) {
					add_member(store, String(conversation._id), user_id, 'member', input.now);
				}
			}
			return conversation;
		},
		async chat_insert_message(input: ChatMessageInsert) {
			const conversation = tables['chat-conversations']!.find(
				(row) => row._id === input.conversation_id && row.is_active !== false,
			);
			if (!conversation) return null;
			const existing =
				input.client_id && input.sender_user_id
					? await store.chat_message_by_client_id(input.sender_user_id, input.client_id)
					: null;
			if (existing) return { message: existing, duplicate: true };
			const seq = (Number(conversation.last_seq) || 0) + 1;
			Object.assign(conversation, {
				last_seq: seq,
				last_message_at: input.now,
				updated_at: input.now,
				lastMessage: { ...input.preview, seq },
			});
			const message: ImperiumDoc = {
				...input.payload,
				_id: input.id,
				name: input.name,
				is_active: true,
				created_by: input.sender_user_id,
				search_field: input.search_field,
				created_at: input.now,
				updated_at: input.now,
				conversation_id: input.conversation_id,
				seq,
				sender_user_id: input.sender_user_id,
				client_id: input.client_id,
				kind: input.kind,
				expires_at: input.expires_at,
			};
			tables.messages!.push(message);
			const sender = member_of(input.conversation_id, input.sender_user_id ?? input.reader_user_id ?? '');
			if (sender) {
				sender.last_read_seq = Math.max(Number(sender.last_read_seq) || 0, seq);
				sender.delivered_seq = Math.max(Number(sender.delivered_seq) || 0, seq);
				if (input.share_read) sender.public_read_seq = Math.max(Number(sender.public_read_seq) || 0, seq);
				Object.assign(sender, { markedUnread: false, mentionSeqs: [], updated_at: input.now });
			}
			input.attachment_ids.forEach((id, n) => {
				const row = tables['attachment-management']!.find(
					(item) => item._id === id && item.created_by_id === input.sender_user_id && !item.related_record_id,
				);
				if (!row) return;
				Object.assign(row, {
					related_record_id: input.id,
					field: 'attachments',
					index_if_is_array: String(n),
					inside_array: 'true',
					chatUpload: { ...(row.chatUpload as ImperiumDoc), boundAt: input.now },
				});
			});
			return { message, duplicate: false };
		},
		async chat_message_by_client_id(sender_user_id: string, client_id: string) {
			return (
				tables.messages!.find((row) => row.sender_user_id === sender_user_id && row.client_id === client_id) ?? null
			);
		},
		async chat_member_ids(conversation_id: string) {
			return tables['chat-members']!
				.filter((row) => row.conversation_id === conversation_id && row.state === 'active')
				.map((row) => String(row.user_id));
		},
		async chat_latest_user_messages(conversation_ids: string[]) {
			return conversation_ids.flatMap((id) =>
				tables.messages!
					.filter((row) => row.conversation_id === id && row.is_active !== false && !SERVER_KINDS.includes(String(row.kind)))
					.sort((a, b) => Number(b.seq) - Number(a.seq))
					.slice(0, 1),
			);
		},
		async chat_member_visibility(conversation_id: string) {
			return tables['chat-members']!
				.filter((row) => row.conversation_id === conversation_id && row.state === 'active')
				.map((row) => ({ user_id: String(row.user_id), visible_from: Number(row.visibleFromSeq) || 0 }));
		},
		async chat_mark_delivered(conversation_id: string, user_ids: string[], seq: number) {
			const moved: string[] = [];
			for (const user_id of user_ids) {
				const row = member_of(conversation_id, user_id);
				if (!row || row.state !== 'active' || (Number(row.delivered_seq) || 0) >= seq) continue;
				row.delivered_seq = seq;
				moved.push(user_id);
			}
			return moved;
		},
		async chat_users_brief(ids: string[]) {
			return tables.user!
				.filter((row) => ids.includes(String(row._id)))
				.map((row) => ({
					_id: String(row._id),
					name: String(row.name ?? ''),
					...(row.email ? { email: String(row.email) } : {}),
					...(row.img ? { img: String(row.img) } : {}),
					is_active: row.is_active !== false,
				}));
		},
		async chat_upload_by_client_id(owner_id: string, client_upload_id: string) {
			return (
				tables['attachment-management']!.find(
					(row) =>
						row.created_by_id === owner_id &&
						row.is_active !== false &&
						(row.chatUpload as ImperiumDoc | undefined)?.clientUploadId === client_upload_id,
				) ?? null
			);
		},
		async chat_privacy(user_id: string) {
			const row = tables['user-settings']!.find((item) => item.user_id === user_id);
			return ((row?.chat_preferences as ImperiumDoc | undefined)?.privacy as ImperiumDoc) ?? {};
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return tables[resource]?.find((row) => matches(row, where)) ?? null;
		},
		async *scan(resource: string) {
			yield (tables[resource] ?? []).filter((row) => row.is_active !== false);
		},
		loc: (resource: string) => ({ resource }),
		resource_for_model: (model: string) => (model.toLowerCase() in tables ? model.toLowerCase() : null),
		available_mongoose_models: () => [],
		is_model_installed: () => true,
		async chat_message_page(input: {
			conversation_id: string;
			visible_from: number;
			viewer_id: string;
			limit: number;
			direction: ChatPageDirection;
			seq?: number;
			user_only?: boolean;
		}) {
			const anchor = input.seq ?? 0;
			const keep: Record<ChatPageDirection, (seq: number) => boolean> = {
				tail: () => true,
				before: (seq) => seq < anchor,
				after: (seq) => seq > anchor,
				from: (seq) => seq >= anchor,
			};
			const descending = input.direction === 'tail' || input.direction === 'before';
			const rows = tables.messages!
				.filter(
					(row) =>
						row.conversation_id === input.conversation_id &&
						row.is_active !== false &&
						!hidden_for(row, input.viewer_id) &&
						Number(row.seq) > input.visible_from &&
						!(input.user_only && SERVER_KINDS.includes(String(row.kind))) &&
						keep[input.direction](Number(row.seq)),
				)
				.sort((a, b) => (descending ? -1 : 1) * (Number(a.seq) - Number(b.seq)))
				.slice(0, input.limit + 1);
			const page = rows.slice(0, input.limit);
			if (descending) page.reverse();
			return { rows: page, more: rows.length > input.limit };
		},
		async chat_changed_messages(input: {
			conversation_id: string;
			visible_from: number;
			viewer_id: string;
			up_to_seq: number;
			since: string;
			limit: number;
		}) {
			const rows = tables.messages!
				.filter(
					(row) =>
						row.conversation_id === input.conversation_id &&
						row.is_active !== false &&
						!hidden_for(row, input.viewer_id) &&
						Number(row.seq) > input.visible_from &&
						Number(row.seq) <= input.up_to_seq &&
						String(row.updated_at) > input.since,
				)
				.sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
			return { rows: rows.slice(0, input.limit), more: rows.length > input.limit };
		},
		async chat_reaction_summary(message_ids: string[], viewer_id: string) {
			const out = new Map<string, ImperiumDoc[]>();
			for (const id of message_ids) {
				const rows = tables['chat-reactions']!.filter((row) => row.message_id === id && row.kind === 'emoji');
				const emojis = [...new Set(rows.map((row) => String(row.value)))];
				if (!emojis.length) continue;
				out.set(
					id,
					emojis.map((emoji) => {
						const of = rows.filter((row) => row.value === emoji);
						return {
							emoji,
							count: of.length,
							mine: of.some((row) => row.user_id === viewer_id),
							sample_user_ids: of.slice(0, 3).map((row) => String(row.user_id)),
						};
					}),
				);
			}
			return out;
		},
		async chat_conversation_page(query: ChatInboxQuery) {
			const unread = (c: ImperiumDoc, m: ImperiumDoc) => Math.max((Number(c.last_seq) || 0) - (Number(m.last_read_seq) || 0), 0);
			const mentions = (m: ImperiumDoc) =>
				((m.mentionSeqs as number[] | undefined) ?? []).filter((seq) => seq > (Number(m.last_read_seq) || 0)).sort((a, b) => a - b);
			const activity = (c: ImperiumDoc) => String(c.last_message_at ?? c.created_at);
			const rows = tables['chat-members']!
				.filter((m) => m.user_id === query.user_id && m.is_active !== false)
				.flatMap((m) => {
					const c = tables['chat-conversations']!.find((row) => row._id === m.conversation_id);
					return c ? [{ c, m }] : [];
				})
				.filter(({ c, m }) => {
					if (query.conversation_ids && !query.conversation_ids.includes(String(c._id))) return false;
					if (query.changed_since) {
						return (
							['active', 'left', 'removed', 'banned'].includes(String(m.state)) &&
							[String(c.updated_at), String(m.updated_at)].sort().at(-1)! > query.changed_since
						);
					}
					if (m.state !== 'active' || c.is_active === false) return false;
					const archived = m.archived === true;
					if (query.filter === 'archived' ? !archived : query.filter && archived) return false;
					if (query.filter === 'unread' && !(unread(c, m) > 0 || m.markedUnread === true)) return false;
					if (query.filter === 'mentions' && !mentions(m).length) return false;
					if (query.filter === 'direct' && !['direct', 'self'].includes(String(c.kind))) return false;
					if (query.filter === 'groups' && !['group', 'channel', 'meeting'].includes(String(c.kind))) return false;
					if (query.kinds && !query.kinds.includes(String(c.kind))) return false;
					if (query.folder && m.folder !== query.folder) return false;
					if (query.pinned !== undefined && query.pinned !== (typeof m.pinnedOrder === 'number')) return false;
					return true;
				})
				.filter(({ c }) => {
					if (!query.cursor) return true;
					const at = activity(c);
					return at < query.cursor.at || (at === query.cursor.at && String(c._id) < query.cursor.id);
				})
				.sort((a, b) =>
					query.pinned
						? Number(a.m.pinnedOrder) - Number(b.m.pinnedOrder)
						: activity(b.c).localeCompare(activity(a.c)) || String(b.c._id).localeCompare(String(a.c._id)),
				)
				.slice(0, query.limit);
			return rows.map(({ c, m }) => ({
				conversation: c,
				member: m,
				activity_at: activity(c),
				unread_count: unread(c, m),
				unread_mention_seqs: mentions(m),
			}));
		},
		async chat_inbox_counts(user_id: string, now: string) {
			const rows = await store.chat_conversation_page({ user_id, limit: 1000 });
			const live = rows.filter((row) => row.member.archived !== true);
			const kind = (row: (typeof rows)[number], kinds: string[]) => kinds.includes(String(row.conversation.kind));
			return {
				all: live.length,
				unread: live.filter((row) => row.unread_count > 0 || row.member.markedUnread === true).length,
				mentions: live.filter((row) => row.unread_mention_seqs.length > 0).length,
				direct: live.filter((row) => kind(row, ['direct', 'self'])).length,
				groups: live.filter((row) => kind(row, ['group', 'channel', 'meeting'])).length,
				archived: rows.length - live.length,
				unread_messages_total: live
					.filter((row) => !(String(row.member.mutedUntil ?? '') > now))
					.reduce((sum, row) => sum + row.unread_count, 0),
				activity_unread: tables.mentions!.filter((row) => row.mentionedUserId === user_id && row.isRead !== true).length,
			};
		},
		async chat_mark_read(input: { conversation_id: string; user_id: string; seq: number; share_read: boolean; now: string }) {
			const member = member_of(input.conversation_id, input.user_id);
			const conversation = tables['chat-conversations']!.find((row) => row._id === input.conversation_id);
			if (!member || member.state !== 'active' || !conversation) return null;
			const last_seq = Number(conversation.last_seq) || 0;
			const read = Math.min(Math.max(Number(member.last_read_seq) || 0, input.seq), last_seq);
			Object.assign(member, {
				last_read_seq: read,
				public_read_seq: input.share_read ? Math.max(Number(member.public_read_seq) || 0, read) : member.public_read_seq,
				delivered_seq: Math.max(Number(member.delivered_seq) || 0, read),
				markedUnread: false,
				mentionSeqs: ((member.mentionSeqs as number[] | undefined) ?? []).filter((seq) => seq > read),
				updated_at: input.now,
			});
			return {
				last_read_seq: read,
				public_read_seq: Number(member.public_read_seq) || 0,
				delivered_seq: Number(member.delivered_seq),
				last_seq,
				mention_seqs: member.mentionSeqs as number[],
			};
		},
		async chat_mark_unread(conversation_id: string, user_id: string, now: string) {
			const member = member_of(conversation_id, user_id);
			if (!member || member.state !== 'active') return false;
			Object.assign(member, { markedUnread: true, updated_at: now });
			return true;
		},
		async chat_receipts_off(user_ids: string[]) {
			return new Set(
				tables['user-settings']!
					.filter(
						(row) =>
							user_ids.includes(String(row.user_id)) &&
							((row.chat_preferences as ImperiumDoc | undefined)?.privacy as ImperiumDoc | undefined)?.read_receipts === false,
					)
					.map((row) => String(row.user_id)),
			);
		},
		async chat_read_marks(conversation_id: string) {
			return tables['chat-members']!
				.filter((row) => row.conversation_id === conversation_id && row.state === 'active')
				.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)))
				.map((row) => ({
					user_id: String(row.user_id),
					last_read_seq: Number(row.last_read_seq) || 0,
					public_read_seq: Number(row.public_read_seq) || 0,
					delivered_seq: Number(row.delivered_seq) || 0,
				}));
		},
		async chat_edit_message(input: ChatEditInput) {
			const message = live_message(input.id);
			if (!message) return null;
			const before = String(message.message ?? '');
			Object.assign(message, input.merge, {
				message: input.text,
				editedAt: input.now,
				editCount: (Number(message.editCount) || 0) + 1,
				rev: (Number(message.rev) || 0) + 1,
				search_field: input.search_field,
				updated_at: input.now,
			});
			tables['chat-audit']!.push({
				_id: input.audit_id,
				is_active: true,
				conversation_id: message.conversation_id,
				message_id: input.id,
				actor_id: input.actor_id,
				action: 'edit',
				before: { text: before },
				after: { text: input.text },
				created_at: input.now,
			});
			return { message, last_message: touch_last(message, { textPreview: input.preview }, input.now), quoting: [] };
		},
		async chat_delete_message(input: ChatDeleteInput) {
			const message = live_message(input.id);
			if (!message) return null;
			const { kind, message: text, attachments, poll, mentions, replyToMessageId } = message;
			tables['chat-audit']!.push({
				_id: input.audit_id,
				is_active: true,
				conversation_id: message.conversation_id,
				message_id: input.id,
				actor_id: input.actor_id,
				action: input.action,
				before: Object.fromEntries(
					Object.entries({ kind, text, attachments, poll, mentions, replyToMessageId }).filter(([, value]) => value != null),
				),
				...(input.target_user_id ? { targetUserId: input.target_user_id } : {}),
				created_at: input.now,
			});
			for (const key of ['attachments', 'poll', 'voice', 'recordCard', 'mentions', 'replyPreview', 'replyToMessageId']) delete message[key];
			Object.assign(message, {
				message: '',
				deleted: input.deleted,
				rev: (Number(message.rev) || 0) + 1,
				search_field: null,
				updated_at: input.now,
			});
			const quoting = tables.messages!
				.filter((row) => row.replyToMessageId === input.id && row.conversation_id === message.conversation_id)
				.map((row) => {
					const { attachmentKind, ...preview } = row.replyPreview as ImperiumDoc;
					Object.assign(row, {
						replyPreview: { ...preview, textPreview: null, deleted: true },
						rev: (Number(row.rev) || 0) + 1,
						updated_at: input.now,
					});
					return {
						id: String(row._id),
						seq: Number(row.seq),
						rev: Number(row.rev),
						reply_preview: row.replyPreview as ImperiumDoc,
						updated_at: input.now,
					};
				});
			const last_message = touch_last(message, { textPreview: '', deleted: true }, input.now);
			await store.chat_drop_mention_seq(String(message.conversation_id), Number(message.seq), []);
			return { message, last_message, quoting };
		},
		async chat_toggle_reaction(input: { message_id: string; user_id: string; emoji: string; on?: boolean; limit: number; now: string }) {
			const message = live_message(input.message_id);
			if (!message) return null;
			const rows = tables['chat-reactions']!;
			const is_mine = (row: ImperiumDoc) =>
				row.message_id === input.message_id && row.user_id === input.user_id && row.kind === 'emoji';
			const mine = rows.filter(is_mine);
			const had = mine.some((row) => row.value === input.emoji);
			const want = input.on ?? !had;
			if (want && !had && mine.length >= input.limit) return { limited: true as const };
			if (want && !had) {
				rows.push({
					_id: hex_id(),
					is_active: true,
					message_id: input.message_id,
					conversation_id: message.conversation_id,
					user_id: input.user_id,
					kind: 'emoji',
					value: input.emoji,
					created_at: input.now,
				});
			}
			if (!want && had) rows.splice(rows.findIndex((row) => is_mine(row) && row.value === input.emoji), 1);
			if (want !== had) Object.assign(message, { rev: (Number(message.rev) || 0) + 1, updated_at: input.now });
			return {
				limited: false as const,
				changed: want !== had,
				mine: want,
				count: rows.filter((row) => row.message_id === input.message_id && row.kind === 'emoji' && row.value === input.emoji).length,
				rev: Number(message.rev) || 0,
				updated_at: String(message.updated_at),
			};
		},
		async chat_replace_votes(input: { message_id: string; user_id: string; option_ids: string[]; final: boolean; now: string }) {
			const message = live_message(input.message_id);
			const poll = message?.poll as ImperiumDoc | undefined;
			if (!message || !poll || poll.closedAt) return null;
			const rows = tables['chat-reactions']!;
			const is_mine = (row: ImperiumDoc) =>
				row.message_id === input.message_id && row.user_id === input.user_id && row.kind === 'vote';
			const mine = rows.filter(is_mine).map((row) => String(row.value));
			const same = mine.length === input.option_ids.length && input.option_ids.every((id) => mine.includes(id));
			if (input.final && mine.length && !same) return { already_voted: true as const };
			if (!same) {
				tables['chat-reactions'] = rows.filter((row) => !is_mine(row) || input.option_ids.includes(String(row.value)));
				for (const value of input.option_ids.filter((id) => !mine.includes(id))) {
					tables['chat-reactions']!.push({
						_id: hex_id(),
						is_active: true,
						message_id: input.message_id,
						conversation_id: message.conversation_id,
						user_id: input.user_id,
						kind: 'vote',
						value,
						created_at: input.now,
					});
				}
				Object.assign(message, { rev: (Number(message.rev) || 0) + 1, updated_at: input.now });
			}
			return { already_voted: false as const, changed: !same, rev: Number(message.rev) || 0, updated_at: String(message.updated_at) };
		},
		async chat_close_poll(message_id: string, now: string) {
			const message = live_message(message_id);
			const poll = message?.poll as ImperiumDoc | undefined;
			if (!message || !poll || poll.closedAt) return null;
			Object.assign(message, { poll: { ...poll, closedAt: now }, rev: (Number(message.rev) || 0) + 1, updated_at: now });
			return message;
		},
		async chat_poll_tally(message_ids: string[], viewer_id: string) {
			const out = new Map<string, { total_voters: number; options: Map<string, { votes: number; mine: boolean; voter_ids: string[] }> }>();
			for (const id of message_ids) {
				const votes = tables['chat-reactions']!.filter((row) => row.message_id === id && row.kind === 'vote');
				if (!votes.length) continue;
				const options = new Map<string, { votes: number; mine: boolean; voter_ids: string[] }>();
				for (const vote of votes) {
					const option = options.get(String(vote.value)) ?? { votes: 0, mine: false, voter_ids: [] };
					option.votes += 1;
					option.mine ||= vote.user_id === viewer_id;
					option.voter_ids.push(String(vote.user_id));
					options.set(String(vote.value), option);
				}
				out.set(id, { total_voters: new Set(votes.map((vote) => vote.user_id)).size, options });
			}
			return out;
		},
		async chat_drop_mention_seq(conversation_id: string, seq: number, keep_user_ids: string[]) {
			for (const row of tables['chat-members']!) {
				if (row.conversation_id !== conversation_id || keep_user_ids.includes(String(row.user_id))) continue;
				row.mentionSeqs = ((row.mentionSeqs as number[] | undefined) ?? []).filter((item) => item !== seq);
			}
		},
		async chat_add_mention_seqs(conversation_id: string, user_ids: string[], seq: number, now: string) {
			return user_ids.filter((user_id) => {
				const row = member_of(conversation_id, user_id);
				if (!row || row.state !== 'active' || (Number(row.last_read_seq) || 0) >= seq) return false;
				const seqs = new Set([...((row.mentionSeqs as number[] | undefined) ?? []), seq]);
				Object.assign(row, { mentionSeqs: [...seqs].sort((a, b) => a - b).slice(-20), updated_at: now });
				return true;
			});
		},
		async chat_activity_page(query: ChatActivityQuery) {
			const key = (row: ImperiumDoc) => `${row.created_at}|${row._id}`;
			return tables.mentions!
				.filter(
					(row) =>
						row.mentionedUserId === query.user_id &&
						row.is_active !== false &&
						(!query.context_types || query.context_types.includes(String(row.contextType))) &&
						(!query.unread || row.isRead !== true) &&
						(!query.before || key(row) < `${query.before.at}|${query.before.id}`),
				)
				.sort((a, b) => key(b).localeCompare(key(a)))
				.slice(0, query.limit);
		},
		async chat_activity_counts(user_id: string) {
			const unread = tables.mentions!.filter(
				(row) => row.mentionedUserId === user_id && row.is_active !== false && row.isRead !== true,
			);
			const of = (types: string[]) => unread.filter((row) => types.includes(String(row.contextType))).length;
			return {
				all: unread.length,
				chat: of(ACTIVITY_CONTEXTS.chat),
				history: of(ACTIVITY_CONTEXTS.history),
				reactions: of(ACTIVITY_CONTEXTS.reactions),
			};
		},
		async chat_mark_activity_read(input: { user_id: string; ids?: string[]; context_types?: string[]; now: string }) {
			const rows = tables.mentions!.filter(
				(row) =>
					row.mentionedUserId === input.user_id &&
					row.is_active !== false &&
					row.isRead !== true &&
					(!input.ids || input.ids.includes(String(row._id))) &&
					(!input.context_types || input.context_types.includes(String(row.contextType))),
			);
			for (const row of rows) Object.assign(row, { isRead: true, updated_at: input.now });
			return { ids: rows.map((row) => String(row._id)), notification_ids: [] };
		},
		async chat_retire_activity(input: { message_id: string; context_type?: string; actor_id?: string; reaction?: string; now: string }) {
			const rows = tables.mentions!.filter(
				(row) =>
					row.messageId === input.message_id &&
					row.is_active !== false &&
					(!input.context_type || row.contextType === input.context_type) &&
					(!input.actor_id || row.actorId === input.actor_id) &&
					(!input.reaction || row.reaction === input.reaction),
			);
			for (const row of rows) Object.assign(row, { is_active: false, updated_at: input.now });
			return rows.map((row) => ({ id: String(row._id), user_id: String(row.mentionedUserId) }));
		},
		async chat_hide_message(message_id: string, user_id: string) {
			const message = tables.messages!.find((row) => row._id === message_id && row.is_active !== false);
			if (!message || hidden_for(message, user_id)) return false;
			message.hiddenForUserIds = [...((message.hiddenForUserIds as string[] | undefined) ?? []), user_id];
			return true;
		},
		async chat_open_view_once(message_id: string, user_id: string, now: string) {
			const message = live_message(message_id);
			const opened = ((message?.viewOnce as ImperiumDoc | undefined)?.openedByUserIds as string[] | undefined) ?? [];
			if (!message?.viewOnce || opened.includes(user_id)) return null;
			Object.assign(message, {
				viewOnce: { openedByUserIds: [...opened, user_id] },
				rev: (Number(message.rev) || 0) + 1,
				updated_at: now,
			});
			return message;
		},
		async chat_message_receipts(conversation_id: string, seq: number, sender_id: string | null) {
			const others = tables['chat-members']!
				.filter((row) => row.conversation_id === conversation_id && row.state === 'active' && row.user_id !== sender_id)
				.sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
			const read_ids = others.filter((row) => (Number(row.public_read_seq) || 0) >= seq).map((row) => String(row.user_id));
			const delivered_ids = others.filter((row) => (Number(row.delivered_seq) || 0) >= seq).map((row) => String(row.user_id));
			return {
				member_count: others.length,
				read_count: read_ids.length,
				delivered_count: delivered_ids.length,
				read_ids,
				delivered_ids,
			};
		},
		async chat_create_group(input: {
			id: string;
			kind: string;
			title: string;
			description: string;
			created_by: string;
			payload: ImperiumDoc;
			members: Array<{ user_id: string; role: string; invited_by?: string }>;
			now: string;
		}) {
			const conversation: ImperiumDoc = {
				...input.payload,
				_id: input.id,
				name: input.title,
				description: input.description,
				is_active: true,
				created_by: input.created_by,
				kind: input.kind,
				conversation_key: `conv:${input.id}`,
				last_seq: 0,
				created_at: input.now,
				updated_at: input.now,
			};
			tables['chat-conversations']!.push(conversation);
			for (const member of input.members) {
				add_member(store, input.id, member.user_id, member.role, input.now, member.invited_by ? { invitedById: member.invited_by } : {});
			}
			recount(conversation, input.now);
			return conversation;
		},
		async chat_join_members(input: {
			conversation_id: string;
			user_ids: string[];
			state: 'active' | 'requested';
			invited_by?: string;
			max_members: number;
			only_requested?: boolean;
			invite_id?: string;
			now: string;
		}) {
			const conversation = live_conversation(input.conversation_id);
			if (!conversation) return { status: 'missing' as const };
			const invite = ((conversation.invites as ImperiumDoc[] | undefined) ?? []).find((item) => item.id === input.invite_id);
			if (input.invite_id) {
				const state = invite ? invite_state(invite, input.now) : 'revoked';
				if (state === 'revoked') return { status: 'invite_not_found' as const };
				if (state !== 'live') return { status: `invite_${state}` as const };
			}
			const previous: Record<string, string> = {};
			for (const id of input.user_ids) {
				const row = member_of(input.conversation_id, id);
				if (row) previous[id] = String(row.state);
			}
			const banned = input.user_ids.filter((id) => previous[id] === 'banned');
			if (banned.length) return { status: 'banned' as const, user_ids: banned };
			if (input.only_requested && input.user_ids.some((id) => previous[id] !== 'requested')) {
				return { status: 'not_requested' as const };
			}
			const entering = input.user_ids.filter((id) => previous[id] !== 'active' && previous[id] !== input.state);
			if (!entering.length) return { status: 'ok' as const, conversation, joined: [] as ImperiumDoc[], previous };
			const active = tables['chat-members']!.filter((row) => row.conversation_id === input.conversation_id && row.state === 'active');
			if (input.state === 'active' && active.length + entering.length > input.max_members) return { status: 'full' as const };
			const last_seq = Number(conversation.last_seq) || 0;
			const shares = (conversation.settings as ImperiumDoc | undefined)?.historyVisibleToNewMembers !== false;
			const joined = entering.map((user_id) => {
				const row: ImperiumDoc =
					member_of(input.conversation_id, user_id) ?? add_member(store, input.conversation_id, user_id, 'member', input.now);
				for (const key of MEMBERSHIP_KEYS) delete row[key];
				const marks = input.state === 'active' ? last_seq : 0;
				Object.assign(row, {
					state: input.state,
					role: 'member',
					last_read_seq: marks,
					delivered_seq: marks,
					mentionSeqs: [],
					markedUnread: false,
					updated_at: input.now,
					...(input.state === 'active'
						? { joinedAt: input.now, visibleFromSeq: shares ? 0 : last_seq }
						: { requestedAt: input.now }),
					...(input.invited_by ? { invitedById: input.invited_by } : {}),
				});
				return row;
			});
			if (invite) invite.uses = (Number(invite.uses) || 0) + 1;
			recount(conversation, input.now);
			return { status: 'ok' as const, conversation, joined, previous };
		},
		async chat_update_invites(input: {
			conversation_id: string;
			join_code: string | null;
			now: string;
			update: (invites: ImperiumDoc[]) => ImperiumDoc[] | null;
		}) {
			const conversation = live_conversation(input.conversation_id);
			if (!conversation) return { status: 'missing' as const };
			const invites = input.update(structuredClone((conversation.invites as ImperiumDoc[] | undefined) ?? []));
			if (!invites) return { status: 'rejected' as const };
			Object.assign(conversation, { join_code: conversation.join_code ?? input.join_code, invites, updated_at: input.now });
			return { status: 'ok' as const, conversation };
		},
		async chat_update_pins(input: { conversation_id: string; now: string; update: (pins: ImperiumDoc[]) => ImperiumDoc[] | null }) {
			const conversation = live_conversation(input.conversation_id);
			if (!conversation) return { status: 'missing' as const };
			const pins = input.update(structuredClone((conversation.pins as ImperiumDoc[] | undefined) ?? []));
			if (!pins) return { status: 'rejected' as const };
			Object.assign(conversation, { pins, updated_at: input.now });
			return { status: 'ok' as const, conversation };
		},
		async chat_media_page(input: {
			conversation_id: string;
			visible_from: number;
			viewer_id: string;
			type: string;
			before_seq?: number;
			limit: number;
		}) {
			const rows = tables.messages!
				.filter(
					(row) =>
						row.conversation_id === input.conversation_id &&
						row.is_active !== false &&
						!row.deleted &&
						!hidden_for(row, input.viewer_id) &&
						Number(row.seq) > input.visible_from &&
						(input.before_seq === undefined || Number(row.seq) < input.before_seq) &&
						has_media(row, input.type),
				)
				.sort((a, b) => Number(b.seq) - Number(a.seq));
			return { rows: rows.slice(0, input.limit), more: rows.length > input.limit };
		},
		async chat_search(query: ChatSearchQuery) {
			const key = (row: ImperiumDoc) => `${row.created_at}|${row._id}`;
			return tables.messages!
				.flatMap((row) => {
					const conversation = live_conversation(String(row.conversation_id));
					const member = member_of(String(row.conversation_id), query.user_id);
					const visible =
						conversation &&
						member?.state === 'active' &&
						row.is_active !== false &&
						String(row.search_field ?? '').includes(query.needle) &&
						Number(row.seq) > (Number(member.visibleFromSeq) || 0) &&
						!hidden_for(row, query.user_id) &&
						(!query.conversation_id || row.conversation_id === query.conversation_id) &&
						(!query.from || row.sender_user_id === query.from) &&
						(!query.has || has_media(row, query.has)) &&
						(!query.before || String(row.created_at) < query.before) &&
						(!query.after || String(row.created_at) > query.after) &&
						(!query.kinds || query.kinds.includes(String(conversation.kind))) &&
						(!query.cursor || key(row) < `${query.cursor.at}|${query.cursor.id}`);
					return visible ? [{ message: row, conversation_key: String(conversation.conversation_key) }] : [];
				})
				.sort((a, b) => key(b.message).localeCompare(key(a.message)))
				.slice(0, query.limit);
		},
		async chat_deny_request(conversation_id: string, user_id: string, now: string) {
			const member = member_of(conversation_id, user_id);
			if (!member || member.state !== 'requested') return null;
			return Object.assign(member, { state: 'removed', leftAt: now, updated_at: now });
		},
		async chat_remove_member(input: {
			conversation_id: string;
			user_id: string;
			expected_role: string;
			state: 'removed' | 'banned';
			now: string;
		}) {
			const conversation = live_conversation(input.conversation_id);
			const member = conversation ? member_of(input.conversation_id, input.user_id) : undefined;
			if (
				!conversation ||
				!member ||
				member.role !== input.expected_role ||
				member.state === input.state ||
				(input.state === 'removed' && member.state !== 'active')
			) {
				return null;
			}
			const previous_state = String(member.state);
			Object.assign(member, {
				state: input.state,
				role: member.role === 'owner' ? 'member' : member.role,
				leftAt: input.now,
				updated_at: input.now,
			});
			recount(conversation, input.now);
			return { conversation, member, previous_state };
		},
		async chat_leave_conversation(input: { conversation_id: string; user_id: string; transfer_to?: string; now: string }) {
			const conversation = live_conversation(input.conversation_id);
			const member = conversation ? member_of(input.conversation_id, input.user_id) : undefined;
			if (!conversation || !member || member.state !== 'active') return { status: 'not_member' as const };
			let successor_id: string | null = null;
			if (member.role === 'owner') {
				if (input.transfer_to) {
					const target = member_of(input.conversation_id, input.transfer_to);
					if (!target || target.state !== 'active' || input.transfer_to === input.user_id) {
						return { status: 'not_member_target' as const };
					}
					successor_id = input.transfer_to;
				} else {
					const joined = (row: ImperiumDoc) => String(row.joinedAt ?? row.created_at);
					const [next] = tables['chat-members']!
						.filter((row) => row.conversation_id === input.conversation_id && row.state === 'active' && row.user_id !== input.user_id)
						.sort(
							(a, b) =>
								Number(b.role === 'admin') - Number(a.role === 'admin') ||
								joined(a).localeCompare(joined(b)) ||
								String(a._id).localeCompare(String(b._id)),
						);
					successor_id = next ? String(next.user_id) : null;
				}
			}
			Object.assign(member, {
				state: 'left',
				role: member.role === 'owner' ? 'member' : member.role,
				leftAt: input.now,
				updated_at: input.now,
			});
			if (successor_id) Object.assign(member_of(input.conversation_id, successor_id)!, { role: 'owner', updated_at: input.now });
			recount(conversation, input.now);
			const closed = !conversation.memberCount;
			if (closed) conversation.is_active = false;
			return { status: 'ok' as const, conversation, successor_id, closed };
		},
		async chat_transfer_owner(input: { conversation_id: string; from: string; to: string; now: string }) {
			const from = live_conversation(input.conversation_id) ? member_of(input.conversation_id, input.from) : undefined;
			if (!from || from.state !== 'active' || from.role !== 'owner') return { status: 'not_owner' as const };
			const to = member_of(input.conversation_id, input.to);
			if (!to || to.state !== 'active' || input.to === input.from) return { status: 'not_member_target' as const };
			Object.assign(from, { role: 'admin', updated_at: input.now });
			Object.assign(to, { role: 'owner', updated_at: input.now });
			return { status: 'ok' as const, owner: to, previous: from };
		},
		async chat_update_member(input: {
			conversation_id: string;
			user_id: string;
			expected_role: string;
			role?: string;
			restricted_until?: string | null;
			now: string;
		}) {
			const member = member_of(input.conversation_id, input.user_id);
			if (!member || member.state !== 'active' || member.role !== input.expected_role) return null;
			if (input.role) member.role = input.role;
			if (input.restricted_until !== undefined) {
				delete member.restrictedUntil;
				if (input.restricted_until) member.restrictedUntil = input.restricted_until;
			}
			member.updated_at = input.now;
			return member;
		},
		async chat_update_conversation(input: {
			id: string;
			title?: string;
			description?: string;
			settings?: ImperiumDoc;
			merge: ImperiumDoc;
			unset: string[];
			now: string;
		}) {
			const conversation = live_conversation(input.id);
			if (!conversation) return null;
			const before = { ...conversation, settings: { ...(conversation.settings as ImperiumDoc) } };
			if (input.title !== undefined) conversation.name = input.title;
			if (input.description !== undefined) conversation.description = input.description;
			for (const key of input.unset) delete conversation[key];
			Object.assign(conversation, input.merge);
			if (input.settings) conversation.settings = { ...(conversation.settings as ImperiumDoc), ...input.settings };
			conversation.updated_at = input.now;
			return { conversation, before };
		},
		async chat_update_prefs(input: {
			conversation_id: string;
			user_id: string;
			merge: ImperiumDoc;
			pinned?: boolean;
			max_pinned: number;
			now: string;
		}) {
			const member = member_of(input.conversation_id, input.user_id);
			if (!member || member.state !== 'active') return null;
			const pinned = tables['chat-members']!.filter(
				(row) => row.user_id === input.user_id && row.state === 'active' && typeof row.pinnedOrder === 'number',
			);
			const was_pinned = typeof member.pinnedOrder === 'number';
			if (input.pinned && !was_pinned && pinned.length >= input.max_pinned) return null;
			Object.assign(member, input.merge, { updated_at: input.now });
			if (input.pinned === false) member.pinnedOrder = null;
			if (input.pinned && !was_pinned) member.pinnedOrder = Math.max(0, ...pinned.map((row) => Number(row.pinnedOrder))) + 1;
			return member;
		},
		async chat_member_page(query: ChatMemberQuery) {
			const key = (row: ImperiumDoc) => `${row.created_at}|${row._id}`;
			const needle = query.q?.toLowerCase();
			return tables['chat-members']!
				.filter(
					(row) =>
						row.conversation_id === query.conversation_id &&
						row.is_active !== false &&
						query.states.includes(String(row.state)) &&
						(!query.role || row.role === query.role) &&
						(!query.cursor || key(row) > `${query.cursor.at}|${query.cursor.id}`),
				)
				.map((member) => ({ member, user: tables.user!.find((row) => row._id === member.user_id) }))
				.filter(({ user }) => !needle || [user?.name, user?.email].some((value) => String(value ?? '').toLowerCase().includes(needle)))
				.sort((a, b) => key(a.member).localeCompare(key(b.member)))
				.slice(0, query.limit)
				.map(({ member, user }) => ({
					member,
					user: user
						? {
								_id: String(user._id),
								name: String(user.name ?? ''),
								...(user.email ? { email: String(user.email) } : {}),
								is_active: user.is_active !== false,
							}
						: null,
				}));
		},
		async chat_mark_inbox_delivered(user_id: string, conversation_ids: string[]) {
			const moved: Array<{ conversation_id: string; seq: number; member_ids: string[] }> = [];
			for (const conversation_id of conversation_ids) {
				const member = member_of(conversation_id, user_id);
				const conversation = tables['chat-conversations']!.find((row) => row._id === conversation_id);
				const last_seq = Number(conversation?.last_seq) || 0;
				if (!member || member.state !== 'active' || (Number(member.delivered_seq) || 0) >= last_seq) continue;
				member.delivered_seq = last_seq;
				moved.push({ conversation_id, seq: last_seq, member_ids: await store.chat_member_ids(conversation_id) });
			}
			return moved;
		},
	};
	return store;
}

type ChatStore = ReturnType<typeof chat_store>;

function add_user(store: ChatStore, name: string, extra: ImperiumDoc = {}): ImperiumDoc {
	const user = { _id: hex_id(), name, email: `${name.toLowerCase()}@empresa.com`, is_active: true, ...extra };
	store.tables.user!.push(user);
	return user;
}

function add_member(store: ChatStore, conversation_id: string, user_id: string, role: string, now: string, extra: ImperiumDoc = {}) {
	const row = {
		_id: hex_id(),
		is_active: true,
		state: 'active',
		conversation_id,
		user_id,
		role,
		last_read_seq: 0,
		public_read_seq: 0,
		delivered_seq: 0,
		joinedAt: now,
		visibleFromSeq: 0,
		mentionSeqs: [],
		markedUnread: false,
		archived: false,
		notifyLevel: 'default',
		created_at: now,
		updated_at: now,
		...extra,
	};
	store.tables['chat-members']!.push(row);
	return row;
}

/** Grupo con sus miembros por rol; los ajustes en camelCase, como el payload. */
function add_group(
	store: ChatStore,
	roles: Array<[ImperiumDoc, string, ImperiumDoc?]>,
	settings: ImperiumDoc = {},
): ImperiumDoc {
	const now = new Date().toISOString();
	const conversation = {
		_id: hex_id(),
		name: 'Compras',
		is_active: true,
		kind: 'group',
		conversation_key: '',
		last_seq: 0,
		memberCount: roles.length,
		settings: { ...DIRECT_CONVERSATION_SETTINGS, membersCanInvite: true, ...settings },
		pins: [],
		invites: [],
		created_at: now,
		updated_at: now,
	};
	conversation.conversation_key = `conv:${conversation._id}`;
	store.tables['chat-conversations']!.push(conversation);
	for (const [user, role, extra] of roles) add_member(store, conversation._id, String(user._id), role, now, extra);
	return conversation;
}

type Reply = {
	status: number;
	headers: Headers;
	body: { data: ImperiumDoc[]; message: string; code?: string; details?: ImperiumDoc } & Record<string, unknown>;
};

async function call(
	store: ChatStore,
	actor: ImperiumDoc,
	action: string,
	opts: {
		method?: string;
		resource?: string;
		path?: string;
		params?: Record<string, string>;
		json?: unknown;
		form?: FormData;
	} = {},
): Promise<Reply> {
	const method = opts.method ?? 'POST';
	const resource = opts.resource ?? 'messages';
	const url = new URL(`http://core/api/${resource}${opts.path ?? ''}`);
	const req = new Request(url, {
		method,
		headers: opts.json === undefined ? undefined : { 'content-type': 'application/json' },
		body: opts.form ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json)),
	});
	try {
		const res = await handle_action(
			store as unknown as ImperiumStore,
			{} as Bun.SQL,
			req,
			url,
			resource,
			action,
			opts.params ?? {},
			actor,
		);
		return { status: res.status, headers: res.headers, body: (await res.json()) as Reply['body'] };
	} catch (err) {
		const e = err as { status?: number; code?: string; message: string; details?: ImperiumDoc };
		return {
			status: e.status ?? 500,
			headers: new Headers(),
			body: { data: [], message: e.message, code: e.code, details: e.details },
		};
	}
}

const send = (store: ChatStore, actor: ImperiumDoc, json: unknown) => call(store, actor, 'create_chat_message', { json });

/** Respuestas sin sobre (CSV): el texto tal cual. */
async function raw(store: ChatStore, actor: ImperiumDoc, action: string, path: string, params: Record<string, string>) {
	const url = new URL(`http://core/api/messages${path}`);
	try {
		const res = await handle_action(store as unknown as ImperiumStore, {} as Bun.SQL, new Request(url), url, 'messages', action, params, actor);
		return { status: res.status, headers: res.headers, text: await res.text() };
	} catch (err) {
		return { status: (err as { status?: number }).status ?? 500, headers: new Headers(), text: (err as Error).message };
	}
}

function upload_form(fields: Record<string, string>, file?: File): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.append(key, value);
	if (file) form.append('file', file);
	return form;
}

const text_file = (name = 'notas.txt', size = 12) => new File(['x'.repeat(size)], name, { type: 'text/plain' });
/** La forma de onda de una nota de voz: 64 picos de 0 a 255. */
const WAVEFORM = Array.from({ length: 64 }, (_, i) => i * 4);

let upload_folder = '';
let previous_upload_folder: string | undefined;

beforeAll(() => {
	upload_folder = mkdtempSync(join(tmpdir(), 'imperium-chat-flow-'));
	previous_upload_folder = process.env.MULTER_UPLOAD_FOLDER;
	process.env.MULTER_UPLOAD_FOLDER = upload_folder;
});

afterAll(() => {
	if (previous_upload_folder === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
	else process.env.MULTER_UPLOAD_FOLDER = previous_upload_folder;
});

describe('envío: forma heredada', () => {
	test('abre el directo, numera por conversación y responde el documento de siempre', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const first = await send(store, ana, { recipient_user_id: beto._id, message: '  Hola  ' });
		const second = await send(store, ana, { recipient_user_id: beto._id, message: 'Otra' });
		expect(first.status).toBe(200);
		const [conversation] = store.tables['chat-conversations']!;
		const key = [ana._id, beto._id].sort().join('::');
		expect(conversation).toMatchObject({ kind: 'direct', conversation_key: key, last_seq: 2 });
		expect(first.body.data[0]).toMatchObject({
			conversation_id: conversation!._id,
			seq: 1,
			kind: 'text',
			message: 'Hola',
			senderUserId: ana._id,
			senderName: 'Ana',
			sourceType: 'chat',
			direction: 'internal',
			conversationKey: key,
			participantUserIds: key.split('::'),
			recipientUserIds: [beto._id],
			readByUserIds: [ana._id],
			title: 'Beto',
			name: 'Beto',
			rev: 0,
		});
		expect(second.body.data[0]).toMatchObject({ seq: 2, conversation_id: conversation!._id });
		expect(store.tables['chat-members']!.map((row) => [row.user_id, row.last_read_seq])).toEqual(
			expect.arrayContaining([
				[ana._id, 2],
				[beto._id, 0],
			]),
		);
	});

	test('el chat consigo mismo es un self', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const sent = await send(store, ana, { recipient_user_id: ana._id, message: 'Nota' });
		expect(store.tables['chat-conversations']![0]).toMatchObject({ kind: 'self', conversation_key: ana._id });
		expect(sent.body.data[0]).toMatchObject({ recipientUserIds: [ana._id], participantUserIds: [ana._id], title: 'Ana' });
	});

	test('un destinatario que no existe o está inactivo no abre conversación', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const baja = add_user(store, 'Baja', { is_active: false });
		expect((await send(store, ana, { recipient_user_id: hex_id(), message: 'Hola' })).body.code).toBe('user_not_found');
		const inactive = await send(store, ana, { recipient_user_id: baja._id, message: 'Hola' });
		expect([inactive.status, inactive.body.code]).toEqual([403, 'user_inactive']);
		expect(store.tables['chat-conversations']).toEqual([]);
	});
});

describe('envío: forma nueva', () => {
	test('responde la vista snake_case y un client_id repetido devuelve el mismo mensaje', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana', { img: '/ana.png' });
		const beto = add_user(store, 'Beto');
		const client_id = crypto.randomUUID();
		const first = await send(store, ana, { recipient_user_id: beto._id, client_id, text: 'Hola' });
		const conversation = store.tables['chat-conversations']![0]!;
		const again = await send(store, ana, { conversation_id: conversation._id, client_id, text: 'Hola' });
		expect(first.status).toBe(200);
		expect(first.body.data[0]).toEqual({
			_id: expect.any(String),
			client_id,
			conversation_id: conversation._id,
			conversation_key: conversation.conversation_key,
			seq: 1,
			rev: 0,
			kind: 'text',
			sender: { _id: ana._id, name: 'Ana', img: '/ana.png' },
			text: 'Hola',
			attachments: [],
			reactions: [],
			created_at: expect.any(String),
			updated_at: expect.any(String),
		});
		expect(again).toMatchObject({ status: 200, body: { data: [first.body.data[0]] } });
		expect(conversation.last_seq).toBe(1);
		expect(store.tables.messages).toHaveLength(1);
	});

	test('valida client_id, texto vacío, largo máximo y la conversación', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member']]);
		const client_id = () => crypto.randomUUID();
		const cases = await Promise.all([
			send(store, ana, { conversation_id: group._id, client_id: 'no-uuid', text: 'Hola' }),
			send(store, ana, { conversation_id: group._id, client_id: client_id(), text: '   ' }),
			send(store, ana, { conversation_id: group._id, client_id: client_id(), text: 'x'.repeat(10_001) }),
			send(store, ana, { conversation_id: hex_id(), client_id: client_id(), text: 'Hola' }),
			send(store, beto, { conversation_id: group._id, client_id: client_id(), text: 'Hola' }),
		]);
		expect(cases.map((reply) => [reply.status, reply.body.code])).toEqual([
			[422, 'invalid_request'],
			[422, 'invalid_request'],
			[422, 'text_too_long'],
			[404, 'conversation_not_found'],
			[403, 'not_member'],
		]);
		expect(store.tables.messages).toEqual([]);
	});

	test('solo administración escribe con anuncios; el invitado no manda adjuntos', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'admin'], [beto!, 'member'], [carla!, 'guest']], { announcementOnly: true });
		const text = (actor: ImperiumDoc) =>
			send(store, actor, { conversation_id: group._id, client_id: crypto.randomUUID(), text: 'Aviso' });
		expect((await text(beto!)).body.code).toBe('announcement_only');
		expect((await text(ana!)).status).toBe(200);
		expect((await text(carla!)).status).toBe(200);
		const upload = await call(store, carla!, 'create_chat_upload', {
			path: '/uploads',
			form: upload_form({ conversation_id: String(group._id), client_upload_id: crypto.randomUUID() }, text_file()),
		});
		expect([upload.status, upload.body.code]).toEqual([403, 'chat_send_denied']);
	});

	test('un miembro restringido no escribe hasta la hora indicada', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const until = new Date(Date.now() + 3_600_000).toISOString();
		const group = add_group(store, [[ana, 'member', { restrictedUntil: until }]]);
		const reply = await send(store, ana, { conversation_id: group._id, client_id: crypto.randomUUID(), text: 'Hola' });
		expect(reply).toMatchObject({ status: 403, body: { code: 'member_restricted', details: { restricted_until: until } } });
		expect(reply.body.message).toMatch(/^No puedes escribir aquí hasta \d{2}\/\d{2}\/\d{2}, \d{2}:\d{2}\.$/);
	});

	test('modo lento: 429 con Retry-After para quien no modera, sin tocar la cuota de envío', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'moderator'], [beto, 'member']], { slowModeSeconds: 30 });
		const text = (actor: ImperiumDoc) =>
			send(store, actor, { conversation_id: group._id, client_id: crypto.randomUUID(), text: 'Hola' });
		expect((await text(beto)).status).toBe(200);
		const slowed = await text(beto);
		expect(slowed.status).toBe(429);
		expect(slowed.headers.get('retry-after')).toBe('30');
		expect(slowed.body).toMatchObject({
			code: 'slow_mode',
			message: 'Modo lento: espera 30 s para volver a escribir.',
			details: { retry_after_s: 30 },
		});
		for (let i = 0; i < 3; i++) expect((await text(ana)).status).toBe(200);
	});

	test('ráfaga de 20 envíos por usuario y después 429 rate_limited', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const text = (actor: ImperiumDoc) =>
			send(store, actor, { conversation_id: group._id, client_id: crypto.randomUUID(), text: 'Hola' });
		const seen: number[] = [];
		while (seen.length < 60 && seen.at(-1) !== 429) seen.push((await text(ana)).status);
		expect(seen.slice(0, 20)).toEqual(Array(20).fill(200));
		expect(seen.at(-1)).toBe(429);
		const limited = await text(ana);
		expect(limited.body.code).toBe('rate_limited');
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		expect((await text(beto)).status).toBe(200);
	});

	test('con la mensajería apagada responde 403 messaging_disabled y no guarda nada; encendida envía', async () => {
		for (const enabled of [false, true]) {
			const store = chat_store({ 'configuration-messaging-enabled': enabled });
			const ana = add_user(store, 'Ana');
			const beto = add_user(store, 'Beto');
			const reply = await send(store, ana, { recipient_user_id: beto._id, message: 'Hola' });
			expect([reply.status, reply.body.code]).toEqual(enabled ? [200, undefined] : [403, 'messaging_disabled']);
			expect(store.tables.messages).toHaveLength(enabled ? 1 : 0);
		}
	});

	test('responder cita el mensaje de la misma conversación y nada de otra', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const first = await send(store, beto, { recipient_user_id: ana._id, client_id: crypto.randomUUID(), text: 'Pregunta' });
		const conversation_id = first.body.data[0]!.conversation_id;
		const reply = await send(store, ana, {
			conversation_id,
			client_id: crypto.randomUUID(),
			text: 'Respuesta',
			reply_to_message_id: first.body.data[0]!._id,
		});
		expect(reply.body.data[0]!.reply_to).toEqual({
			message_id: first.body.data[0]!._id,
			sender_name: 'Beto',
			text_preview: 'Pregunta',
			kind: 'text',
			deleted: false,
		});
		const elsewhere = add_group(store, [[ana, 'member']]);
		const foreign = await send(store, ana, {
			conversation_id: elsewhere._id,
			client_id: crypto.randomUUID(),
			text: 'No',
			reply_to_message_id: first.body.data[0]!._id,
		});
		expect([foreign.status, foreign.body.code]).toEqual([422, 'invalid_request']);
	});
});

describe('subidas del chat', () => {
	async function upload(store: ChatStore, actor: ImperiumDoc, conversation_id: string, extra: Record<string, string> = {}, file = text_file()) {
		return call(store, actor, 'create_chat_upload', {
			path: '/uploads',
			form: upload_form({ conversation_id, client_upload_id: crypto.randomUUID(), ...extra }, file),
		});
	}

	test('una subida con metadatos, idempotente por client_upload_id, se liga al enviar', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const client_upload_id = crypto.randomUUID();
		const fields = {
			conversation_id: String(group._id),
			client_upload_id,
			kind: 'voice',
			duration_ms: '4200',
			peaks: JSON.stringify(WAVEFORM),
		};
		// Bun deduce el tipo por la extensión: una nota de voz .webm llega como video/webm.
		const voice = new File([new Uint8Array(32)], 'nota.webm', { type: 'audio/webm' });
		const first = await call(store, ana, 'create_chat_upload', { path: '/uploads', form: upload_form(fields, voice) });
		const again = await call(store, ana, 'create_chat_upload', { path: '/uploads', form: upload_form(fields, voice) });
		expect(first.body.data[0]).toEqual({
			attachment_id: expect.any(String),
			url: `/api/media/${first.body.data[0]!.attachment_id}`,
			name: 'nota',
			file_ext: 'webm',
			mimetype: 'video/webm',
			size_kb: 32 / 1024,
			kind: 'voice',
			duration_ms: 4200,
			peaks: WAVEFORM,
			client_upload_id,
		});
		expect(again.body.data[0]).toEqual(first.body.data[0]);
		expect(store.tables['attachment-management']).toHaveLength(1);
		const attachment_id = String(first.body.data[0]!.attachment_id);
		const sent = await send(store, ana, {
			conversation_id: group._id,
			client_id: crypto.randomUUID(),
			attachment_ids: [attachment_id],
			attachments_meta: [{ attachment_id, alt: 'Nota de voz' }],
		});
		expect(sent.body.data[0]).toMatchObject({
			kind: 'voice',
			text: '',
			attachments: [{ attachment_id, kind: 'voice', alt: 'Nota de voz', duration_ms: 4200 }],
			voice: { duration_ms: 4200, peaks: WAVEFORM },
		});
		expect(store.tables['attachment-management']![0]).toMatchObject({
			related_record_id: sent.body.data[0]!._id,
			chatUpload: { ownerUserId: ana._id, conversationId: group._id, boundAt: sent.body.data[0]!.created_at },
		});
		expect(store.tables.messages![0]!.search_field).toBe('nota');
		const bound = await call(store, ana, 'delete_chat_upload', {
			method: 'DELETE',
			path: `/uploads/${attachment_id}`,
			params: { attachmentId: attachment_id },
		});
		expect([bound.status, bound.body.code]).toEqual([409, 'upload_bound']);
	});

	test('solo se ligan subidas propias, sin ligar y de la misma conversación', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const other = add_group(store, [[ana, 'member']]);
		const of_beto = await upload(store, beto, String(group._id));
		const elsewhere = await upload(store, ana, String(other._id));
		for (const id of [of_beto.body.data[0]!.attachment_id, elsewhere.body.data[0]!.attachment_id, hex_id()]) {
			const reply = await send(store, ana, { conversation_id: group._id, client_id: crypto.randomUUID(), attachment_ids: [id] });
			expect([reply.status, reply.body.code]).toEqual([422, 'invalid_attachment']);
		}
		const eleven = Array.from({ length: 11 }, hex_id);
		const many = await send(store, ana, { conversation_id: group._id, client_id: crypto.randomUUID(), attachment_ids: eleven });
		expect([many.status, many.body.code]).toEqual([422, 'too_many_attachments']);
	});

	test('el tipo declarado tiene que coincidir con el archivo y el tamaño con el parámetro', async () => {
		const store = chat_store({ 'configuration-chat-max-upload-mb': 1 });
		const ana = add_user(store, 'Ana');
		const group = add_group(store, [[ana, 'member']]);
		const mismatch = await upload(store, ana, String(group._id), { kind: 'voice' });
		expect([mismatch.status, mismatch.body.code]).toEqual([415, 'upload_type_not_allowed']);
		const big = await upload(store, ana, String(group._id), {}, text_file('grande.txt', 1024 * 1024 + 1));
		expect(big).toMatchObject({ status: 413, body: { code: 'upload_too_large', message: 'El archivo supera el máximo de 1 MB.' } });
		const bad_peaks = await upload(store, ana, String(group._id), { peaks: JSON.stringify([300]) });
		expect([bad_peaks.status, bad_peaks.body.code]).toEqual([422, 'invalid_request']);
		expect(store.tables['attachment-management']).toEqual([]);
	});

	test('quitar una subida sin ligar borra el archivo; la de otro no existe', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const attachment_id = String((await upload(store, ana, String(group._id))).body.data[0]!.attachment_id);
		const stored = String(store.tables['attachment-management']![0]!.name_stored);
		expect(existsSync(join(upload_folder, stored))).toBe(true);
		const remove = (actor: ImperiumDoc) =>
			call(store, actor, 'delete_chat_upload', {
				method: 'DELETE',
				path: `/uploads/${attachment_id}`,
				params: { attachmentId: attachment_id },
			});
		expect((await remove(beto)).body.code).toBe('upload_not_found');
		expect((await remove(ana)).body.data).toEqual([]);
		expect(existsSync(join(upload_folder, stored))).toBe(false);
		expect(store.tables['attachment-management']![0]!.is_active).toBe(false);
		expect((await remove(ana)).body.code).toBe('upload_not_found');
	});

	test('varios archivos multipart en el mismo envío llegan todos y quedan ligados', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const form = new FormData();
		form.append('recipient_user_id', String(beto._id));
		form.append('message', 'Planos');
		form.append('attachments', text_file('plano-a.txt'));
		form.append('attachments', text_file('plano-b.txt'));
		const sent = await call(store, ana, 'create_chat_message', { form });
		expect(sent.body.data[0]).toMatchObject({
			kind: 'media',
			message: 'Planos',
			attachments: [
				{ name: 'plano-a', fileExt: 'txt', kind: 'file' },
				{ name: 'plano-b', fileExt: 'txt', kind: 'file' },
			],
		});
		expect(store.tables['attachment-management']!.map((row) => [row.related_record_id, row.index_if_is_array])).toEqual([
			[sent.body.data[0]!._id, '0'],
			[sent.body.data[0]!._id, '1'],
		]);
		expect(readdirSync(upload_folder).length).toBeGreaterThanOrEqual(2);
	});
});

const get = (
	store: ChatStore,
	actor: ImperiumDoc,
	action: string,
	path: string,
	params: Record<string, string> = {},
	resource = 'messages',
) => call(store, actor, action, { method: 'GET', resource, path, params });

/** Directo con `count` mensajes alternados (impares de `a`, pares de `b`). */
async function chat_between(store: ChatStore, a: ImperiumDoc, b: ImperiumDoc, count: number): Promise<ImperiumDoc> {
	let conversation_id = '';
	for (let i = 1; i <= count; i++) {
		const [from, to] = i % 2 ? [a, b] : [b, a];
		const sent = await send(store, from, { recipient_user_id: to._id, client_id: crypto.randomUUID(), text: `m${i}` });
		conversation_id = String(sent.body.data[0]!.conversation_id);
	}
	return store.tables['chat-conversations']!.find((row) => row._id === conversation_id)!;
}

const seqs_of = (reply: Reply) => reply.body.data.map((row) => row.seq);
const member_row = (store: ChatStore, conversation: ImperiumDoc, user: ImperiumDoc) =>
	store.tables['chat-members']!.find((row) => row.conversation_id === conversation._id && row.user_id === user._id)!;

describe('historial por cursor', () => {
	test('la cola trae lo más reciente en orden ascendente; antes, después y alrededor paginan por seq', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 7);
		const id = String(conversation._id);
		const history = (query: string) => get(store, beto, 'read_message_page', `/history/${id}${query}`, { conversationId: id });
		const tail = await history('?limit=3');
		expect(seqs_of(tail)).toEqual([5, 6, 7]);
		expect(tail.body).toMatchObject({ has_more_before: true, has_more_after: false, server_time: expect.any(String) });
		expect(tail.body.data[2]).toMatchObject({ text: 'm7', sender: { _id: ana._id, name: 'Ana' }, kind: 'text' });
		const before = await history('?before_seq=5&limit=2');
		expect([seqs_of(before), before.body.has_more_before, before.body.has_more_after]).toEqual([[3, 4], true, true]);
		const after = await history('?after_seq=5');
		expect([seqs_of(after), after.body.has_more_before, after.body.has_more_after]).toEqual([[6, 7], true, false]);
		const m4 = store.tables.messages!.find((row) => row.conversation_id === id && row.seq === 4)!;
		const around = await history(`?around_message_id=${m4._id}&limit=4`);
		expect([seqs_of(around), around.body.has_more_before, around.body.has_more_after]).toEqual([[2, 3, 4, 5], true, true]);
		const other = await chat_between(store, ana, add_user(store, 'Carla'), 1);
		const foreign = store.tables.messages!.find((row) => row.conversation_id === other._id)!;
		expect((await history(`?around_message_id=${foreign._id}`)).body.code).toBe('message_not_found');
		expect((await history('?before_seq=-1')).status).toBe(422);
	});

	test('solo miembros, desde visibleFromSeq, con reacciones y acuses recíprocos', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 5);
		const id = String(conversation._id);
		const history = (actor: ImperiumDoc) => get(store, actor, 'read_message_page', `/history/${id}`, { conversationId: id });
		expect((await history(add_user(store, 'Intrusa'))).body.code).toBe('not_member');
		member_row(store, conversation, beto).visibleFromSeq = 3;
		const m5 = store.tables.messages!.find((row) => row.conversation_id === id && row.seq === 5)!;
		store.tables['chat-reactions']!.push({ message_id: m5._id, user_id: beto._id, kind: 'emoji', value: '👍' });
		const page = await history(beto);
		expect(seqs_of(page)).toEqual([4, 5]);
		expect(page.body.has_more_before).toBe(false);
		expect(page.body.data[1]!.reactions).toEqual([{ emoji: '👍', count: 1, mine: true, sample_user_ids: [beto._id] }]);
		const marks = (reply: Reply) => reply.body.read_state as { my_last_read_seq: number; members: ImperiumDoc[] };
		expect(marks(page)).toEqual({
			my_last_read_seq: 4,
			members: [ana, beto]
				.sort((a, b) => String(a._id).localeCompare(String(b._id)))
				.map((user) => ({ user_id: user._id, public_read_seq: user === ana ? 5 : 4, delivered_seq: user === ana ? 5 : 4 })),
		});
		store.tables['user-settings']!.push({ user_id: beto._id, chat_preferences: { privacy: { read_receipts: false } } });
		const reciprocal = marks(await history(beto)).members;
		expect(reciprocal.find((row) => row.user_id === ana._id)?.public_read_seq).toBe(0);
		expect(reciprocal.find((row) => row.user_id === beto._id)?.public_read_seq).toBe(4);
	});

	test('sync trae lo nuevo después de after_seq y lo ya cargado que cambió', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 7);
		const id = String(conversation._id);
		const since = new Date(Date.now() + 10_000).toISOString();
		const m2 = store.tables.messages!.find((row) => row.conversation_id === id && row.seq === 2)!;
		m2.updated_at = new Date(Date.now() + 60_000).toISOString();
		const sync = await get(store, ana, 'read_message_sync', `/sync/${id}?after_seq=5&changed_since=${since}`, { conversationId: id });
		const [result] = sync.body.data;
		expect(result!.new_messages as ImperiumDoc[]).toMatchObject([{ seq: 6 }, { seq: 7 }]);
		expect(result!.changed_messages as ImperiumDoc[]).toMatchObject([{ seq: 2, text: 'm2' }]);
		expect(result).toMatchObject({ last_seq: 7, has_more: false, read_state: { my_last_read_seq: 7 } });
		expect(sync.body.server_time).toEqual(expect.any(String));
	});

	test('sync con changed_since también trae lo fechado poco antes: un cambio confirma después de fecharse', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 3);
		const id = String(conversation._id);
		const since = new Date(Date.now() + 10_000).toISOString();
		const m1 = store.tables.messages!.find((row) => row.conversation_id === id && row.seq === 1)!;
		m1.updated_at = new Date(Date.parse(since) - 2000).toISOString();
		const sync = await get(store, ana, 'read_message_sync', `/sync/${id}?after_seq=3&changed_since=${since}`, { conversationId: id });
		expect((sync.body.data[0]!.changed_messages as ImperiumDoc[]).map((row) => row.seq)).toEqual([1]);
	});
});

describe('bandeja de conversaciones', () => {
	const mine = (store: ChatStore, actor: ImperiumDoc, query = '') =>
		get(store, actor, 'list_my_conversations', `/mine${query}`, {}, 'chat-conversations');

	test('vista por espectador, fijadas primero, cursor opaco y conteos en la primera página', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana', { img: '/ana.png' });
		const beto = add_user(store, 'Beto');
		const carla = add_user(store, 'Carla');
		const with_beto = await chat_between(store, beto, ana, 3);
		await Bun.sleep(5);
		const with_carla = await chat_between(store, carla, ana, 1);
		const group = add_group(store, [[ana, 'admin'], [beto, 'member']]);
		member_row(store, group, ana).pinnedOrder = 1;
		const first = await mine(store, ana, '?limit=1');
		expect(first.body.data.map((row) => row._id)).toEqual([group._id, with_carla._id]);
		expect(first.body.counts).toEqual({
			all: 3,
			unread: 2,
			mentions: 0,
			direct: 2,
			groups: 1,
			archived: 0,
			unread_messages_total: 2,
			activity_unread: 0,
		});
		const second = await mine(store, ana, `?limit=1&cursor=${first.body.next_cursor}`);
		expect(second.body.data.map((row) => row._id)).toEqual([with_beto._id]);
		expect(second.body.next_cursor).toBeNull();
		expect(second.body.counts).toBeUndefined();
		expect(second.body.data[0]).toEqual({
			_id: with_beto._id,
			conversation_key: with_beto.conversation_key,
			kind: 'direct',
			title: 'Beto',
			peer: { _id: beto._id, name: 'Beto', email: 'beto@empresa.com' },
			member_count: 2,
			my_role: 'member',
			joined_at: expect.any(String),
			visible_from_seq: 0,
			last_seq: 3,
			last_message_at: expect.any(String),
			last_message: {
				message_id: expect.any(String),
				seq: 3,
				sender_id: beto._id,
				sender_name: 'Beto',
				kind: 'text',
				text_preview: 'm3',
				at: expect.any(String),
			},
			my_last_read_seq: 2,
			unread_count: 1,
			unread_mentions: 0,
			unread_mention_seqs: [],
			marked_unread: false,
			prefs: { archived: false, notify_level: 'default' },
			settings: {
				announcement_only: false,
				slow_mode_seconds: 0,
				members_can_invite: false,
				members_can_pin: true,
				members_can_edit_info: false,
				members_can_call: true,
				members_can_mention_all: false,
				ephemeral_seconds: 0,
				history_visible_to_new_members: true,
			},
			live_features: true,
			updated_at: expect.any(String),
		});
		expect((await mine(store, ana, '?filter=nada')).status).toBe(422);
		expect((await mine(store, ana, '?cursor=no-es-un-cursor')).body.code).toBe('invalid_cursor');
	});

	test('con changed_since salen las bajas; listar marca entregado en lote', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 2);
		const group = add_group(store, [[beto, 'member']]);
		const since = new Date(Date.now() - 1000).toISOString();
		Object.assign(member_row(store, group, beto), { state: 'left', updated_at: new Date().toISOString() });
		member_row(store, conversation, ana).delivered_seq = 1;
		const changed = await mine(store, beto, `?changed_since=${since}`);
		expect(changed.body.data).toContainEqual({ _id: group._id, removed: true, reason: 'left' });
		await mine(store, ana);
		expect(member_row(store, conversation, ana).delivered_seq).toBe(2);
	});

	test('resumen y detalle: solo miembros; el detalle trae fijados vigentes y acuses', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 2);
		const id = String(conversation._id);
		const [m1, m2] = store.tables.messages!.filter((row) => row.conversation_id === id);
		conversation.pins = [
			{ messageId: m1!._id, seq: 1, pinnedById: beto._id, pinnedAt: '2026-10-01T00:00:00.000Z', expiresAt: null },
			{ messageId: m2!._id, seq: 2, pinnedById: ana._id, pinnedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:00.000Z' },
		];
		Object.assign(member_row(store, conversation, ana), {
			draft: { text: 'borrador', replyToMessageId: m1!._id, updatedAt: '2026-10-02T00:00:00.000Z' },
			mutedUntil: null,
			folder: 'Trabajo',
		});
		const summary = await get(store, ana, 'read_conversation_summary', `/${id}`, { id }, 'chat-conversations');
		expect(summary.body.data[0]).toMatchObject({ _id: id, title: 'Beto', unread_count: 1, my_last_read_seq: 1 });
		expect(summary.body.data[0]!.prefs).toEqual({
			muted_until: null,
			archived: false,
			folder: 'Trabajo',
			notify_level: 'default',
			draft: { text: 'borrador', reply_to_message_id: m1!._id, updated_at: '2026-10-02T00:00:00.000Z' },
		});
		const detail = await get(store, ana, 'read_conversation_detail', `/${id}/detail`, { id }, 'chat-conversations');
		expect(detail.body.data[0]).toMatchObject({
			_id: id,
			pins: [
				{
					message_id: m1!._id,
					seq: 1,
					pinned_by: { _id: beto._id, name: 'Beto' },
					expires_at: null,
					preview: { sender_name: 'Ana', text_preview: 'm1', kind: 'text' },
				},
			],
			read_state: { my_last_read_seq: 1 },
		});
		const outsider = add_user(store, 'Intrusa');
		expect((await get(store, outsider, 'read_conversation_summary', `/${id}`, { id }, 'chat-conversations')).body.code).toBe('not_member');
		const unknown = hex_id();
		expect(
			(await get(store, ana, 'read_conversation_detail', `/${unknown}/detail`, { id: unknown }, 'chat-conversations')).body.code,
		).toBe('conversation_not_found');
	});
});

describe('configuración efectiva del chat', () => {
	test('responde aunque la mensajería esté apagada y sin secretos', async () => {
		const store = chat_store({ 'configuration-messaging-enabled': false, 'configuration-chat-max-upload-mb': 20 });
		const config = await get(store, add_user(store, 'Ana'), 'read_chat_config', '/chat-config');
		expect(config.status).toBe(200);
		expect(config.body.data[0]).toMatchObject({
			api_version: 2,
			messaging_enabled: false,
			edit_window_minutes: 15,
			delete_for_all_window_minutes: 60,
			max_upload_mb: 20,
			max_attachments: 10,
			text_max_chars: 10000,
			features: { polls: true, stories: true, calls: true, meetings: true, guests: false },
			calls: { mesh_max: 4, class_max: 20, ring_timeout_seconds: 45, sfu_available: false, turn_configured: false },
		});
		expect(JSON.stringify(config.body)).not.toMatch(/secret|stun:/i);
	});
});

describe('rutas heredadas', () => {
	test('/conversations: solo directos y self con mensajes, en la forma de siempre', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		await chat_between(store, beto, ana, 3);
		await send(store, ana, { recipient_user_id: ana._id, message: 'nota' });
		add_group(store, [[ana, 'member']]);
		await store.chat_open_direct({
			conversation_key: [ana._id, add_user(store, 'Carla')._id].sort().join('::'),
			user_ids: [],
			created_by: String(ana._id),
			now: new Date().toISOString(),
		});
		const list = await get(store, ana, 'read_my_conversations', '/conversations');
		expect(list.body.data).toHaveLength(2);
		const direct = list.body.data.find((row) => (row.participant_user_ids as string[]).length === 2)!;
		expect(direct).toMatchObject({
			conversation_key: [ana._id, beto._id].sort().join('::'),
			other_participant: { _id: beto._id, name: 'Beto' },
			latest_message: { message: 'm3', seq: 3, senderUserId: beto._id },
			unread_count: 1,
		});
		const self = list.body.data.find((row) => (row.participant_user_ids as string[]).length === 1)!;
		expect(self).toMatchObject({ other_participant: { _id: ana._id, name: 'Ana' }, unread_count: 0 });
	});

	test('/conversation/:participantId: la página más reciente, acuses de las marcas y sigue marcando leído', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, beto, ana, 3);
		const thread = (actor: ImperiumDoc, other: ImperiumDoc) =>
			get(store, actor, 'read_conversation', `/conversation/${other._id}?size=2`, { participantId: String(other._id) });
		const page = await thread(ana, beto);
		expect(page.body.data.map((row) => [row.message, row.readByUserIds])).toEqual([
			['m2', [ana._id, beto._id]],
			['m3', [beto._id, ana._id]],
		]);
		expect(member_row(store, conversation, ana).last_read_seq).toBe(3);
		expect((await thread(ana, add_user(store, 'Nadie'))).body.data).toEqual([]);
	});

	test('/conversation/:participantId: quien no comparte acuses no ve los de los demás', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		store.tables['user-settings']!.push({ user_id: ana._id, chat_preferences: { privacy: { read_receipts: false } } });
		const conversation = await chat_between(store, ana, beto, 1);
		const id = String(conversation._id);
		await call(store, beto, 'mark_conversation_read', { resource: 'chat-conversations', path: `/${id}/read`, params: { id }, json: { seq: 1 } });
		expect(member_row(store, conversation, beto).public_read_seq).toBe(1);
		const page = await get(store, ana, 'read_conversation', `/conversation/${beto._id}`, { participantId: String(beto._id) });
		expect(page.body.data.map((row) => row.readByUserIds)).toEqual([[ana._id]]);
	});

	test('los documentos heredados no dicen quién más ocultó o abrió un mensaje', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 1);
		const message = store.tables.messages!.find((row) => row.conversation_id === conversation._id)!;
		expect((await remove(store, beto, message._id, 'me')).status).toBe(200);
		message.viewOnce = { openedByUserIds: [beto._id] };
		const leaks = (doc: ImperiumDoc | undefined) =>
			JSON.stringify([doc?.hiddenForUserIds, (doc?.viewOnce as ImperiumDoc | undefined)?.openedByUserIds]).includes(String(beto._id));
		const thread = await get(store, ana, 'read_conversation', `/conversation/${beto._id}`, { participantId: String(beto._id) });
		expect(thread.body.data).toHaveLength(1);
		expect(thread.body.data.some(leaks)).toBe(false);
		const [inbox] = (await get(store, ana, 'read_my_conversations', '/conversations')).body.data;
		expect(leaks(inbox!.latest_message as ImperiumDoc)).toBe(false);
		const found = await get(store, ana, 'search_chat_messages', `/search?term=m1&participant_id=${beto._id}`);
		expect(found.body.data).toHaveLength(1);
		expect(leaks(found.body.data[0]!.message as ImperiumDoc)).toBe(false);
	});

	test('el hilo y la bandeja heredados no traen mensajes de sistema', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 2);
		const last = store.tables.messages!.find((row) => row.conversation_id === conversation._id && row.seq === 2)!;
		expect((await pin(store, ana, conversation._id, { message_id: last._id })).status).toBe(200);
		expect(systems(store, conversation._id)).toEqual(['pinned']);
		const page = await get(store, beto, 'read_conversation', `/conversation/${ana._id}?size=2`, { participantId: String(ana._id) });
		expect(page.body.data.map((row) => [row.kind, row.message])).toEqual([
			['text', 'm1'],
			['text', 'm2'],
		]);
		const [inbox] = (await get(store, beto, 'read_my_conversations', '/conversations')).body.data;
		expect(inbox!.latest_message).toMatchObject({ _id: last._id, kind: 'text', message: 'm2' });
	});
});

describe('marcar leído', () => {
	const read = (store: ChatStore, actor: ImperiumDoc, id: string, json: unknown = {}) =>
		call(store, actor, 'mark_conversation_read', { resource: 'chat-conversations', path: `/${id}/read`, params: { id }, json });
	const unread = (store: ChatStore, actor: ImperiumDoc, id: string) =>
		call(store, actor, 'mark_conversation_unread', { resource: 'chat-conversations', path: `/${id}/unread`, params: { id }, json: {} });

	test('leer historial, sync, bandeja o detalle nunca marca; POST read sí, monótono y acotado a last_seq', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 5);
		const id = String(conversation._id);
		const marks = () => {
			const { last_read_seq, public_read_seq, delivered_seq } = member_row(store, conversation, beto);
			return { last_read_seq, public_read_seq };
		};
		const before = marks();
		expect(before).toEqual({ last_read_seq: 4, public_read_seq: 4 });
		await get(store, beto, 'read_message_page', `/history/${id}`, { conversationId: id });
		await get(store, beto, 'read_message_sync', `/sync/${id}?after_seq=0`, { conversationId: id });
		await get(store, beto, 'list_my_conversations', '/mine', {}, 'chat-conversations');
		await get(store, beto, 'read_conversation_detail', `/${id}/detail`, { id }, 'chat-conversations');
		expect(marks()).toEqual(before);
		const marked = await read(store, beto, id, { seq: 99 });
		expect(marked.body.data).toEqual([{ last_read_seq: 5, public_read_seq: 5, unread_count: 0, unread_mentions: 0 }]);
		expect((await read(store, beto, id, { seq: 2 })).body.data[0]).toMatchObject({ last_read_seq: 5 });
		expect(marks()).toEqual({ last_read_seq: 5, public_read_seq: 5 });
		expect((await read(store, beto, id, {})).status).toBe(422);
		expect((await read(store, add_user(store, 'Intrusa'), id, { seq: 1 })).body.code).toBe('not_member');
	});

	test('sin compartir acuses la marca pública no se mueve', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 3);
		store.tables['user-settings']!.push({ user_id: beto._id, chat_preferences: { privacy: { read_receipts: false } } });
		const marked = await read(store, beto, String(conversation._id), { seq: 3 });
		expect(marked.body.data[0]).toEqual({ last_read_seq: 3, public_read_seq: 2, unread_count: 0, unread_mentions: 0 });
	});

	test('no leído: se marca, sale en la bandeja y se quita al leer o al enviar', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, beto, ana, 2);
		const id = String(conversation._id);
		const inbox = async () =>
			(await get(store, ana, 'list_my_conversations', '/mine?filter=unread', {}, 'chat-conversations')).body.data;
		expect(await inbox()).toEqual([]);
		expect((await unread(store, ana, id)).body.data).toEqual([{ marked_unread: true }]);
		expect(await inbox()).toEqual([expect.objectContaining({ _id: id, marked_unread: true, unread_count: 0 })]);
		await read(store, ana, id, { seq: 2 });
		expect(await inbox()).toEqual([]);
		await unread(store, ana, id);
		await send(store, ana, { conversation_id: id, client_id: crypto.randomUUID(), text: 'Ya volví' });
		expect(member_row(store, conversation, ana).markedUnread).toBe(false);
		expect((await unread(store, add_user(store, 'Intrusa'), id)).body.code).toBe('not_member');
	});
});

const edit = (store: ChatStore, actor: ImperiumDoc, id: unknown, json: unknown) =>
	call(store, actor, 'edit_chat_message', { method: 'PATCH', path: `/message/${id}`, params: { id: String(id) }, json });

const remove = (store: ChatStore, actor: ImperiumDoc, id: unknown, scope?: string) =>
	call(store, actor, 'delete_chat_message', {
		method: 'DELETE',
		path: `/message/${id}${scope ? `?scope=${scope}` : ''}`,
		params: { id: String(id) },
	});

/** Envía al grupo y devuelve la vista. */
async function said(store: ChatStore, actor: ImperiumDoc, group: ImperiumDoc, text: string, extra: ImperiumDoc = {}) {
	const sent = await send(store, actor, { conversation_id: group._id, client_id: crypto.randomUUID(), text, ...extra });
	expect(sent.status).toBe(200);
	return sent.body.data[0]!;
}

const stored = (store: ChatStore, id: unknown) => store.tables.messages!.find((row) => row._id === id)!;

describe('editar y borrar mensajes', () => {
	test('quien lo envió lo edita: texto, rev, edited_at, auditoría con el antes y la vista previa de la bandeja', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const view = await said(store, ana, group, 'Hola a todos');
		const edited = await edit(store, ana, view._id, { text: '  Hola a todas  ' });
		expect(edited.status).toBe(200);
		expect(edited.body.data[0]).toMatchObject({
			_id: view._id,
			text: 'Hola a todas',
			rev: 1,
			edit_count: 1,
			edited_at: expect.any(String),
		});
		expect(store.tables['chat-audit']).toEqual([
			expect.objectContaining({
				conversation_id: group._id,
				message_id: view._id,
				actor_id: ana._id,
				action: 'edit',
				before: { text: 'Hola a todos' },
				after: { text: 'Hola a todas' },
			}),
		]);
		expect(group.lastMessage).toMatchObject({ messageId: view._id, textPreview: 'Hola a todas' });
		expect(stored(store, view._id).search_field).toBe('hola a todas');
		const same = await edit(store, ana, view._id, { text: 'Hola a todas' });
		expect([same.status, same.body.data[0]!.rev]).toEqual([200, 1]);
		expect(store.tables['chat-audit']).toHaveLength(1);
		const cases = await Promise.all([
			edit(store, beto, view._id, { text: 'Mío' }),
			edit(store, ana, view._id, { text: 'x'.repeat(10_001) }),
			edit(store, ana, view._id, { text: '   ' }),
			edit(store, ana, view._id, {}),
			edit(store, ana, hex_id(), { text: 'Nada' }),
			edit(store, add_user(store, 'Intrusa'), view._id, { text: 'Hola' }),
		]);
		expect(cases.map((reply) => [reply.status, reply.body.code])).toEqual([
			[403, 'not_sender'],
			[422, 'text_too_long'],
			[422, 'invalid_request'],
			[422, 'invalid_request'],
			[404, 'message_not_found'],
			[403, 'not_member'],
		]);
	});

	test('fuera de la ventana responde 403 edit_window_closed; con la ventana en 0 no hay límite', async () => {
		for (const [minutes, expected] of [
			[1, [403, 'edit_window_closed']],
			[0, [200, undefined]],
		] as const) {
			const store = chat_store({ 'configuration-chat-edit-window-minutes': minutes });
			const ana = add_user(store, 'Ana');
			const group = add_group(store, [[ana, 'member']]);
			const view = await said(store, ana, group, 'Antes');
			stored(store, view._id).created_at = new Date(Date.now() - 2 * 60_000).toISOString();
			const reply = await edit(store, ana, view._id, { text: 'Después' });
			expect([reply.status, reply.body.code]).toEqual([...expected]);
			expect(store.tables['chat-audit']).toHaveLength(minutes ? 0 : 1);
		}
	});

	test('borrar para todos deja lápida y auditoría, limpia la cita de las respuestas y ya no se edita', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const original = await said(store, ana, group, 'Dato sensible');
		const answer = await said(store, beto, group, 'Respuesta', { reply_to_message_id: original._id });
		store.tables['chat-reactions']!.push({ message_id: original._id, user_id: beto._id, kind: 'emoji', value: '👍' });
		const no_scope = await remove(store, ana, original._id);
		expect([no_scope.status, no_scope.body.code]).toEqual([422, 'invalid_request']);
		const removed = await remove(store, ana, original._id, 'all');
		expect(removed.body.data).toEqual([{ _id: original._id, scope: 'all' }]);
		expect(store.tables['chat-audit']).toEqual([
			expect.objectContaining({
				message_id: original._id,
				actor_id: ana._id,
				action: 'delete',
				before: { kind: 'text', text: 'Dato sensible' },
			}),
		]);
		const page = await get(store, beto, 'read_message_page', `/history/${group._id}`, { conversationId: String(group._id) });
		const [tombstone, reply] = page.body.data;
		expect(tombstone).toMatchObject({ _id: original._id, text: '', attachments: [], reactions: [], rev: 1 });
		expect(tombstone!.deleted).toEqual({ at: expect.any(String), by_role: 'sender' });
		expect(reply).toMatchObject({
			_id: answer._id,
			rev: 1,
			reply_to: { message_id: original._id, text_preview: null, deleted: true },
		});
		expect(stored(store, original._id).search_field).toBeNull();
		expect((await remove(store, ana, original._id, 'all')).body.code).toBe('message_gone');
		expect((await edit(store, ana, original._id, { text: 'Otra' })).status).toBe(410);
	});

	test('lo ajeno solo lo borra quien modera a su autor en un grupo; lo propio, dentro de la ventana', async () => {
		const store = chat_store({ 'configuration-chat-delete-window-minutes': 1 });
		const [owner, admin, moderator, member, other] = ['Olga', 'Adán', 'Moni', 'Memo', 'Otto'].map((name) =>
			add_user(store, name),
		) as ImperiumDoc[];
		const group = add_group(store, [
			[owner!, 'owner'],
			[admin!, 'admin'],
			[moderator!, 'moderator'],
			[member!, 'member'],
			[other!, 'member'],
		]);
		const by = async (author: ImperiumDoc) => (await said(store, author, group, `de ${author.name}`))._id;
		const attempt = async (actor: ImperiumDoc, author: ImperiumDoc) => {
			const reply = await remove(store, actor, await by(author), 'all');
			return reply.status === 200 ? 'ok' : reply.body.code;
		};
		expect(await attempt(other!, member!)).toBe('role_required');
		expect(await attempt(moderator!, admin!)).toBe('role_required');
		expect(await attempt(admin!, owner!)).toBe('role_required');
		expect(await attempt(moderator!, member!)).toBe('ok');
		expect(await attempt(admin!, moderator!)).toBe('ok');
		expect(await attempt(owner!, admin!)).toBe('ok');
		expect(store.tables['chat-audit']!.filter((row) => row.action === 'delete_moderator').map((row) => row.targetUserId)).toEqual([
			member!._id,
			moderator!._id,
			admin!._id,
		]);
		const late = await said(store, member!, group, 'Viejo');
		stored(store, late._id).created_at = new Date(Date.now() - 2 * 60_000).toISOString();
		expect((await remove(store, member!, late._id, 'all')).body.code).toBe('delete_window_closed');
		const moderated = await remove(store, moderator!, late._id, 'all');
		expect(moderated.status).toBe(200);
		expect(stored(store, late._id).deleted).toMatchObject({ byRole: 'moderator', byUserId: moderator!._id });
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const direct = await send(store, ana, { recipient_user_id: beto._id, client_id: crypto.randomUUID(), text: 'Hola' });
		expect((await remove(store, beto, direct.body.data[0]!._id, 'all')).body.code).toBe('role_required');
	});

	test('borrar para mí solo lo oculta a quien lo pide, también en sync y en la ruta heredada', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const conversation = await chat_between(store, ana, beto, 2);
		const id = String(conversation._id);
		const [m1] = store.tables.messages!.filter((row) => row.conversation_id === id);
		const hidden = await remove(store, beto, m1!._id, 'me');
		expect(hidden.body.data).toEqual([{ _id: m1!._id, scope: 'me' }]);
		expect(stored(store, m1!._id)).toMatchObject({ rev: 0, hiddenForUserIds: [beto._id] });
		const history = (actor: ImperiumDoc) => get(store, actor, 'read_message_page', `/history/${id}`, { conversationId: id });
		expect(seqs_of(await history(beto))).toEqual([2]);
		expect(seqs_of(await history(ana))).toEqual([1, 2]);
		const legacy = await get(store, beto, 'read_conversation', `/conversation/${ana._id}`, { participantId: String(ana._id) });
		expect(legacy.body.data.map((row) => row.seq)).toEqual([2]);
		const around = await get(store, beto, 'read_message_page', `/history/${id}?around_message_id=${m1!._id}`, { conversationId: id });
		expect(around.body.code).toBe('message_not_found');
		expect((await edit(store, beto, m1!._id, { text: 'x' })).body.code).toBe('message_not_found');
	});

	test('info: leído y entregado por las marcas, versiones anteriores y 403 not_sender a quien no lo envió', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const carla = add_user(store, 'Carla');
		const group = add_group(store, [[ana, 'member'], [beto, 'member'], [carla, 'moderator']]);
		const view = await said(store, ana, group, 'v1');
		await edit(store, ana, view._id, { text: 'v2' });
		await edit(store, ana, view._id, { text: 'v3' });
		Object.assign(member_row(store, group, beto), { public_read_seq: 1, delivered_seq: 1 });
		Object.assign(member_row(store, group, carla), { delivered_seq: 1 });
		const info = (actor: ImperiumDoc) => get(store, actor, 'read_message_info', `/message/${view._id}/info`, { id: String(view._id) });
		const own = await info(ana);
		expect(own.body.data[0]).toEqual({
			read_by: [{ _id: beto._id, name: 'Beto', email: 'beto@empresa.com' }],
			delivered_to: [
				{ _id: beto._id, name: 'Beto', email: 'beto@empresa.com' },
				{ _id: carla._id, name: 'Carla', email: 'carla@empresa.com' },
			].sort((a, b) => String(a._id).localeCompare(String(b._id))),
			read_count: 1,
			delivered_count: 2,
			member_count: 2,
			revisions: [
				{ at: expect.any(String), text: 'v1' },
				{ at: expect.any(String), text: 'v2' },
			],
		});
		expect((await info(carla)).body.data[0]).toMatchObject({ read_count: 1, revisions: [{ text: 'v1' }, { text: 'v2' }] });
		expect([(await info(beto)).status, (await info(beto)).body.code]).toEqual([403, 'not_sender']);
		store.tables['user-settings']!.push({ user_id: ana._id, chat_preferences: { privacy: { read_receipts: false } } });
		expect((await info(ana)).body.data[0]).toMatchObject({ read_by: [], read_count: 0, delivered_count: 2 });
	});
});

const react = (store: ChatStore, actor: ImperiumDoc, id: unknown, json: unknown) =>
	call(store, actor, 'toggle_chat_reaction', { path: `/message/${id}/reactions`, params: { id: String(id) }, json });

const reactors = (store: ChatStore, actor: ImperiumDoc, id: unknown, query = '') =>
	get(store, actor, 'read_message_reactions', `/message/${id}/reactions${query}`, { id: String(id) });

const vote = (store: ChatStore, actor: ImperiumDoc, id: unknown, option_ids: unknown) =>
	call(store, actor, 'vote_chat_poll', { path: `/message/${id}/vote`, params: { id: String(id) }, json: { option_ids } });

const close_poll = (store: ChatStore, actor: ImperiumDoc, id: unknown) =>
	call(store, actor, 'close_chat_poll', { path: `/message/${id}/poll-close`, params: { id: String(id) }, json: {} });

const read_poll = (store: ChatStore, actor: ImperiumDoc, id: unknown, query = '') =>
	get(store, actor, 'read_chat_poll', `/message/${id}/poll${query}`, { id: String(id) });

/** Una encuesta enviada al grupo por `author`. */
async function poll_in(store: ChatStore, author: ImperiumDoc, group: ImperiumDoc, poll: ImperiumDoc = {}) {
	return said(store, author, group, '', { poll: { question: '¿Cuándo nos vemos?', options: ['Lunes', 'Martes', 'Miércoles'], ...poll } });
}

describe('reacciones', () => {
	test('conmuta, normaliza el emoji, rechaza lo que no es un emoji y respeta el tope de 20', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const view = await said(store, ana, group, 'Hola');
		expect((await react(store, beto, view._id, { emoji: '👍' })).body.data).toEqual([{ emoji: '👍', count: 1, mine: true, rev: 1 }]);
		expect((await react(store, ana, view._id, { emoji: '❤' })).body.data[0]).toMatchObject({ emoji: '❤️', count: 1 });
		expect((await react(store, beto, view._id, { emoji: '❤️', on: true })).body.data[0]).toMatchObject({ emoji: '❤️', count: 2 });
		expect((await react(store, beto, view._id, { emoji: '❤️', on: true })).body.data[0]).toMatchObject({ count: 2, rev: 3 });
		expect((await react(store, beto, view._id, { emoji: '👍' })).body.data).toEqual([{ emoji: '👍', count: 0, mine: false, rev: 4 }]);
		for (const emoji of ['a', '👍👍', '', ':)', 'x'.repeat(40)]) {
			const reply = await react(store, beto, view._id, { emoji });
			expect([emoji, reply.status, reply.body.code]).toEqual([emoji, 422, 'invalid_emoji']);
		}
		const twenty = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '🙂', '🤗', '🤩'];
		for (const emoji of twenty.slice(1)) expect((await react(store, ana, view._id, { emoji, on: true })).status).toBe(200);
		const over = await react(store, ana, view._id, { emoji: '🤔' });
		expect([over.status, over.body.code]).toEqual([422, 'reaction_limit']);
		const page = await get(store, beto, 'read_message_page', `/history/${group._id}`, { conversationId: String(group._id) });
		expect(page.body.data[0]!.reactions as ImperiumDoc[]).toContainEqual({
			emoji: '❤️',
			count: 2,
			mine: true,
			sample_user_ids: [ana._id, beto._id],
		});
	});

	test('quién reaccionó: por emoji y en páginas con cursor; en una lápida responde 410', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member'], [carla!, 'member']]);
		const view = await said(store, ana!, group, 'Hola');
		for (const [actor, emoji] of [[beto!, '👍'], [carla!, '👍'], [carla!, '🎉']] as const) {
			await react(store, actor, view._id, { emoji });
			await Bun.sleep(2);
		}
		const first = await reactors(store, ana!, view._id, '?emoji=👍&limit=1');
		expect(first.body.data).toEqual([{ emoji: '👍', user: { _id: beto!._id, name: 'Beto', email: 'beto@empresa.com' }, at: expect.any(String) }]);
		const second = await reactors(store, ana!, view._id, `?emoji=👍&limit=1&cursor=${first.body.next_cursor}`);
		expect(second.body.data.map((row) => (row.user as ImperiumDoc)._id)).toEqual([carla!._id]);
		expect(second.body.next_cursor).toBeNull();
		expect((await reactors(store, ana!, view._id)).body.data.map((row) => row.emoji)).toEqual(['👍', '👍', '🎉']);
		expect((await reactors(store, add_user(store, 'Intrusa'), view._id)).body.code).toBe('not_member');
		await remove(store, ana!, view._id, 'all');
		expect((await react(store, beto!, view._id, { emoji: '👍' })).body.code).toBe('message_gone');
		expect((await reactors(store, beto!, view._id)).status).toBe(410);
	});
});

describe('encuestas', () => {
	test('se crea en el envío: kind poll, ids de opción, búsqueda por pregunta y opciones; poll_invalid si no cuadra', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const group = add_group(store, [[ana, 'member']]);
		const view = await poll_in(store, ana, group, { multiple: true, max_choices: 2, anonymous: true, results: 'after_vote' });
		expect(view).toMatchObject({
			kind: 'poll',
			text: '',
			poll: {
				question: '¿Cuándo nos vemos?',
				multiple: true,
				max_choices: 2,
				anonymous: true,
				results: 'after_vote',
				total_voters: 0,
				results_visible: false,
				options: [
					{ id: 'o1', text: 'Lunes', mine: false },
					{ id: 'o2', text: 'Martes', mine: false },
					{ id: 'o3', text: 'Miércoles', mine: false },
				],
			},
		});
		expect(stored(store, view._id).search_field).toBe('¿cuando nos vemos? lunes martes miercoles');
		expect(group.lastMessage).toMatchObject({ kind: 'poll', textPreview: '¿Cuándo nos vemos?' });
		const bad = [
			{ question: '', options: ['a', 'b'] },
			{ question: '¿?', options: ['solo una'] },
			{ question: '¿?', options: Array.from({ length: 13 }, (_, i) => `o${i}`) },
			{ question: '¿?', options: ['a', 'A'] },
			{ question: 'x'.repeat(301), options: ['a', 'b'] },
			{ question: '¿?', options: ['a', 'x'.repeat(101)] },
			{ question: '¿?', options: ['a', 'b'], results: 'nunca' },
			{ question: '¿?', options: ['a', 'b'], max_choices: 2 },
			{ question: '¿?', options: ['a', 'b'], closes_at: '2020-01-01T00:00:00.000Z' },
			{ question: '¿?', options: ['a', 'b'], quiz: { correct_option_index: 5 } },
			{ question: '¿?', options: ['a', 'b'], multiple: true, quiz: { correct_option_index: 0 } },
		];
		for (const poll of bad) {
			const reply = await send(store, ana, { conversation_id: group._id, client_id: crypto.randomUUID(), poll });
			expect([JSON.stringify(poll).slice(0, 40), reply.status, reply.body.code]).toEqual([JSON.stringify(poll).slice(0, 40), 422, 'poll_invalid']);
		}
	});

	test('votar: vale el último, [] retira, opción ajena 422, cerrada 409; after_vote muestra conteos al votar', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member'], [carla!, 'member']]);
		const view = await poll_in(store, ana!, group, { results: 'after_vote' });
		const first = await vote(store, beto!, view._id, ['o1']);
		expect(first.body.data[0]).toMatchObject({
			total_voters: 1,
			results_visible: true,
			options: [
				{ id: 'o1', votes: 1, mine: true, voter_ids: [beto!._id] },
				{ id: 'o2', votes: 0, mine: false, voter_ids: [] },
				{ id: 'o3', votes: 0, mine: false, voter_ids: [] },
			],
		});
		const unseen = (await read_poll(store, carla!, view._id)).body.data[0]!;
		expect(unseen).toMatchObject({ total_voters: 1, results_visible: false });
		expect((unseen.options as ImperiumDoc[])[0]).toEqual({ id: 'o1', text: 'Lunes', mine: false });
		expect((await vote(store, beto!, view._id, ['o2'])).body.data[0]!.options).toMatchObject([{ votes: 0 }, { votes: 1, mine: true }, { votes: 0 }]);
		const cases = await Promise.all([
			vote(store, carla!, view._id, ['o9']),
			vote(store, carla!, view._id, ['o1', 'o2']),
			vote(store, carla!, view._id, 'o1'),
			vote(store, carla!, (await said(store, ana!, group, 'texto'))._id, ['o1']),
		]);
		expect(cases.map((reply) => [reply.status, reply.body.code])).toEqual([
			[422, 'poll_invalid_choice'],
			[422, 'poll_invalid_choice'],
			[422, 'invalid_request'],
			[422, 'invalid_request'],
		]);
		expect((await vote(store, beto!, view._id, [])).body.data[0]).toMatchObject({ total_voters: 0, results_visible: false });
		expect(store.tables['chat-reactions']!.filter((row) => row.kind === 'vote')).toEqual([]);
		await vote(store, carla!, view._id, ['o3']);
		await close_poll(store, ana!, view._id);
		const late = await vote(store, beto!, view._id, ['o1']);
		expect([late.status, late.body.code]).toEqual([409, 'poll_closed']);
		expect((await read_poll(store, beto!, view._id)).body.data[0]).toMatchObject({
			closed_at: expect.any(String),
			results_visible: true,
			options: [{ votes: 0 }, { votes: 0 }, { votes: 1, voter_ids: [carla!._id] }],
		});
	});

	test('una encuesta anónima no expone a quién votó: ni en la vista, ni en la página, ni en el CSV', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member'], [carla!, 'member']]);
		const view = await poll_in(store, ana!, group, { anonymous: true });
		await vote(store, beto!, view._id, ['o1']);
		const voted = await vote(store, carla!, view._id, ['o1']);
		const options = (reply: Reply) => (reply.body.data[0]!.options ?? (reply.body.data[0]!.poll as ImperiumDoc).options) as ImperiumDoc[];
		expect(options(voted)[0]).toEqual({ id: 'o1', text: 'Lunes', votes: 2, mine: true });
		expect(options(await read_poll(store, ana!, view._id))[0]).toEqual({ id: 'o1', text: 'Lunes', votes: 2, mine: false });
		const page = await get(store, ana!, 'read_message_page', `/history/${group._id}`, { conversationId: String(group._id) });
		expect(options(page)[0]).toEqual({ id: 'o1', text: 'Lunes', votes: 2, mine: false });
		expect(JSON.stringify(page.body.data)).not.toContain(String(beto!._id));
		expect((await reactors(store, ana!, view._id)).body.data).toEqual([]);
		const csv = await raw(store, ana!, 'read_chat_poll', `/message/${view._id}/poll?format=csv`, { id: String(view._id) });
		expect([csv.status, csv.headers.get('content-type')]).toEqual([200, 'text/csv; charset=utf-8']);
		expect(csv.text).toBe('\uFEFFPregunta,¿Cuándo nos vemos?\r\nOpción,Votos\r\nLunes,2\r\nMartes,0\r\nMiércoles,0\r\n');
	});

	test('cerrar: quien la creó o administra; ya cerrada 409; el CSV solo para ellos, con votantes y sin fórmulas', async () => {
		const store = chat_store();
		const [ana, beto, moni, adan] = ['Ana', '=Beto', 'Moni', 'Adán'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member'], [moni!, 'moderator'], [adan!, 'admin']]);
		const view = await poll_in(store, ana!, group, { options: ['+Sí', 'No, gracias'] });
		await vote(store, beto!, view._id, ['o1']);
		const csv = (actor: ImperiumDoc) =>
			raw(store, actor, 'read_chat_poll', `/message/${view._id}/poll?format=csv`, { id: String(view._id) });
		expect((await csv(adan!)).text).toBe(
			"\uFEFFPregunta,¿Cuándo nos vemos?\r\nOpción,Votos,Votantes\r\n'+Sí,1,'=Beto\r\n\"No, gracias\",0,\r\n",
		);
		expect((await csv(moni!)).status).toBe(403);
		expect((await close_poll(store, moni!, view._id)).body.code).toBe('role_required');
		expect((await close_poll(store, beto!, view._id)).body.code).toBe('role_required');
		const closed = await close_poll(store, adan!, view._id);
		expect(closed.body.data[0]).toMatchObject({ closed_at: expect.any(String), results_visible: true });
		expect(stored(store, view._id)).toMatchObject({ rev: 2, poll: { closedAt: expect.any(String) } });
		expect((await close_poll(store, ana!, view._id)).body.code).toBe('poll_closed');
		const own = await poll_in(store, beto!, group);
		expect((await close_poll(store, beto!, own._id)).status).toBe(200);
	});

	test('cuestionario: la respuesta correcta aparece al votar o al cerrar y no se cambia', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member'], [carla!, 'member']]);
		const view = await poll_in(store, ana!, group, { quiz: { correct_option_index: 1, explanation: 'Es martes.' } });
		expect((view.poll as ImperiumDoc).quiz).toEqual({});
		const answered = await vote(store, beto!, view._id, ['o1']);
		expect(answered.body.data[0]!.quiz).toEqual({ correct_option_id: 'o2', explanation: 'Es martes.' });
		expect((await vote(store, beto!, view._id, ['o1'])).status).toBe(200);
		const change = await vote(store, beto!, view._id, ['o2']);
		expect([change.status, change.body.code, change.body.message]).toEqual([422, 'poll_invalid_choice', 'Ya respondiste este cuestionario.']);
		expect((await vote(store, beto!, view._id, [])).body.code).toBe('poll_invalid_choice');
		expect((await read_poll(store, carla!, view._id)).body.data[0]!.quiz).toEqual({});
		await close_poll(store, ana!, view._id);
		expect((await read_poll(store, carla!, view._id)).body.data[0]!.quiz).toEqual({ correct_option_id: 'o2', explanation: 'Es martes.' });
	});
});

const mention_of = (user: ImperiumDoc) => `[@${user.name}](mention:${user._id})`;

const activity = (store: ChatStore, user: ImperiumDoc) =>
	store.tables.mentions!.filter((row) => row.mentionedUserId === user._id && row.is_active !== false);

describe('menciones y Actividad', () => {
	test('solo cuentan los miembros activos: la vista, mentionSeqs, la bandeja y la Actividad', async () => {
		const store = chat_store();
		const [ana, beto, carla, dora] = ['Ana', 'Beto', 'Carla', 'Dora'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member'], [dora!, 'member', { state: 'left' }]]);
		const view = await said(store, ana!, group, `Hola ${[beto!, carla!, dora!, ana!].map(mention_of).join(', ')}`);
		expect(view.mentions).toEqual({ user_ids: [beto!._id], all: false, here: false });
		expect(member_row(store, group, beto!).mentionSeqs).toEqual([1]);
		expect(store.tables.mentions).toEqual([
			expect.objectContaining({
				mentionedUserId: beto!._id,
				contextType: 'chat-message',
				actorId: ana!._id,
				conversationId: group._id,
				messageId: view._id,
				excerpt: 'Hola @Beto, @Carla, @Dora, @Ana',
				isRead: false,
			}),
		]);
		const inbox = await get(store, beto!, 'list_my_conversations', '/mine', {}, 'chat-conversations');
		expect(inbox.body.data[0]).toMatchObject({ _id: group._id, unread_mentions: 1, unread_mention_seqs: [1] });
		expect(inbox.body.counts).toMatchObject({ mentions: 1, activity_unread: 1 });
		const mentioned = await get(store, beto!, 'list_my_conversations', '/mine?filter=mentions', {}, 'chat-conversations');
		expect(mentioned.body.data.map((row) => row._id)).toEqual([group._id]);
		const id = String(group._id);
		await call(store, beto!, 'mark_conversation_read', { resource: 'chat-conversations', path: `/${id}/read`, params: { id }, json: { seq: 1 } });
		expect(member_row(store, group, beto!).mentionSeqs).toEqual([]);
	});

	test('borrar el mensaje o editarlo sin la mención la quita de mentionSeqs y de la bandeja', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member'], [carla!, 'member']]);
		const first = await said(store, ana!, group, `Hola ${mention_of(beto!)}`);
		const second = await said(store, ana!, group, `Y ${mention_of(beto!)} con ${mention_of(carla!)}`);
		expect(member_row(store, group, beto!).mentionSeqs).toEqual([1, 2]);
		expect((await remove(store, ana!, first._id, 'all')).status).toBe(200);
		expect(member_row(store, group, beto!).mentionSeqs).toEqual([2]);
		expect((await edit(store, ana!, second._id, { text: `Y ya solo ${mention_of(carla!)}` })).status).toBe(200);
		expect([beto!, carla!].map((user) => member_row(store, group, user).mentionSeqs)).toEqual([[], [2]]);
		const inbox = await get(store, beto!, 'list_my_conversations', '/mine', {}, 'chat-conversations');
		expect(inbox.body.data[0]).toMatchObject({ _id: group._id, unread_mentions: 0, unread_mention_seqs: [] });
	});

	test('@todos: 403 sin permiso; desde el umbral 409 con recipients_count y nada guardado; confirmado avisa a todos', async () => {
		const store = chat_store({ 'configuration-chat-mass-mention-threshold': 2 });
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'member']]);
		const everyone = (actor: ImperiumDoc, extra: ImperiumDoc = {}) =>
			send(store, actor, { conversation_id: group._id, client_id: crypto.randomUUID(), text: '[@todos](mention:all) junta a las 5', ...extra });
		expect((await everyone(beto!)).body.code).toBe('role_required');
		const ask = await everyone(ana!);
		expect(ask).toMatchObject({ status: 409, body: { code: 'mass_mention_confirmation', details: { recipients_count: 2 } } });
		expect(ask.body.message).toBe('Esto notificará a 2 personas. ¿Enviar de todos modos?');
		expect(store.tables.messages).toEqual([]);
		const confirmed = await everyone(ana!, { confirm_mass_mention: true });
		expect(confirmed.body.data[0]!.mentions).toEqual({ user_ids: [], all: true, here: false });
		expect([beto!, carla!].map((user) => member_row(store, group, user).mentionSeqs)).toEqual([[1], [1]]);
		expect([activity(store, beto!).length, activity(store, carla!).length, activity(store, ana!).length]).toEqual([1, 1, 0]);
		(group.settings as ImperiumDoc).membersCanMentionAll = true;
		expect((await everyone(beto!)).status).toBe(409);
		const pair = add_group(store, [[ana!, 'owner'], [beto!, 'member']]);
		const small = await send(store, ana!, { conversation_id: pair._id, client_id: crypto.randomUUID(), text: '[@todos](mention:all) hola' });
		expect(small.status).toBe(200);
	});

	test('editar avisa solo las menciones nuevas y un @todos nuevo también pide confirmación', async () => {
		const store = chat_store({ 'configuration-chat-mass-mention-threshold': 1 });
		const [ana, beto, carla, dora] = ['Ana', 'Beto', 'Carla', 'Dora'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'member'], [dora!, 'member']]);
		const view = await said(store, ana!, group, `Hola ${mention_of(beto!)}`);
		const edited = await edit(store, ana!, view._id, { text: `Hola ${mention_of(beto!)} y ${mention_of(carla!)}` });
		expect(edited.body.data[0]!.mentions).toEqual({ user_ids: [beto!._id, carla!._id], all: false, here: false });
		expect([beto!, carla!, dora!].map((user) => activity(store, user).length)).toEqual([1, 1, 0]);
		expect(member_row(store, group, carla!).mentionSeqs).toEqual([1]);
		const everyone = `[@todos](mention:all) ${mention_of(beto!)} y ${mention_of(carla!)}`;
		const ask = await edit(store, ana!, view._id, { text: everyone });
		expect(ask).toMatchObject({ status: 409, body: { code: 'mass_mention_confirmation', details: { recipients_count: 1 } } });
		expect((await edit(store, ana!, view._id, { text: everyone, confirm_mass_mention: true })).status).toBe(200);
		expect([beto!, carla!, dora!].map((user) => activity(store, user).length)).toEqual([1, 1, 1]);
		await edit(store, ana!, view._id, { text: 'Sin menciones' });
		expect(stored(store, view._id).mentions).toEqual({ userIds: [], all: false, here: false });
	});

	test('responder deja Actividad a quien escribió; reaccionar a lo ajeno también y quitarla o borrar la retiran', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const question = await said(store, beto, group, 'Pregunta');
		const answer = await said(store, ana, group, 'Respuesta', { reply_to_message_id: question._id });
		await said(store, ana, group, `${mention_of(beto)} otra`, { reply_to_message_id: question._id });
		expect(activity(store, beto).map((row) => row.contextType)).toEqual(['chat-reply', 'chat-message']);
		await react(store, ana, question._id, { emoji: '👍' });
		await react(store, ana, answer._id, { emoji: '👍' });
		expect(activity(store, beto).at(-1)).toMatchObject({ contextType: 'chat-reaction', reaction: '👍', excerpt: 'Pregunta' });
		expect(activity(store, ana)).toEqual([]);
		await react(store, ana, question._id, { emoji: '👍' });
		expect(activity(store, beto).map((row) => row.contextType)).toEqual(['chat-reply', 'chat-message']);
		await remove(store, ana, answer._id, 'all');
		expect(activity(store, beto).map((row) => row.contextType)).toEqual(['chat-message']);
	});

	test('/my-mentions: ChatActivityItem por filtro, no leídas y cursor, con conteos; marcar leído', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana', { img: '/ana.png' });
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const view = await said(store, ana, group, `**Hola** ${mention_of(beto)}, revisa [esto](https://ejemplo.mx)`);
		await Bun.sleep(2);
		await said(store, ana, group, `Aparte ${mention_of(beto)}`);
		await Bun.sleep(2);
		const direct = await send(store, ana, { recipient_user_id: beto._id, client_id: crypto.randomUUID(), text: `${mention_of(beto)} ¿y tú?` });
		await Bun.sleep(2);
		await react(store, ana, (await said(store, beto, group, 'Mío'))._id, { emoji: '🎉' });
		await Bun.sleep(2);
		await store.insert('mentions', {
			mentionedUserId: beto._id,
			contextType: 'history-comment',
			actor: { _id: ana._id, name: 'Ana' },
			excerpt: 'Revisa el folio',
			source: { modelName: 'products', collectionName: 'products', documentId: 'd1', historyId: 'h1', route: '/productos', entityLabel: 'Tornillo' },
			isRead: false,
		});
		const mine = (query = '') => get(store, beto, 'read_my_mentions', `/my-mentions${query}`, {}, 'notifications');
		const all = await mine();
		expect(all.body.counts).toEqual({ all: 5, chat: 4, history: 1, reactions: 1 });
		expect(all.body.data.map((item) => item.kind)).toEqual(['comment_mention', 'reaction', 'mention', 'mention', 'mention']);
		expect(all.body.data[0]).toEqual({
			_id: expect.any(String),
			kind: 'comment_mention',
			created_at: expect.any(String),
			is_read: false,
			actor: { _id: ana._id, name: 'Ana', email: 'ana@empresa.com', img: '/ana.png' },
			excerpt: 'Revisa el folio',
			record: {
				model_name: 'products',
				collection_name: 'products',
				document_id: 'd1',
				history_id: 'h1',
				route: '/productos',
				entity_label: 'Tornillo',
			},
		});
		expect(all.body.data[1]).toMatchObject({ kind: 'reaction', reaction: '🎉', chat: { conversation_title: 'Compras' } });
		expect(all.body.data[2]!.chat).toEqual({
			conversation_id: direct.body.data[0]!.conversation_id,
			message_id: direct.body.data[0]!._id,
			conversation_title: 'Ana',
		});
		expect(all.body.data[4]).toMatchObject({
			excerpt: 'Hola @Beto, revisa esto',
			chat: { conversation_id: group._id, message_id: view._id, conversation_title: 'Compras' },
		});
		expect((await mine('?context=reactions')).body.data.map((item) => item.kind)).toEqual(['reaction']);
		expect((await mine('?context=history')).body.data.map((item) => item.kind)).toEqual(['comment_mention']);
		const first = await mine('?limit=2');
		expect(first.body.data).toHaveLength(2);
		const rest = await mine(`?limit=2&before=${first.body.next_cursor}`);
		const last = await mine(`?limit=2&before=${rest.body.next_cursor}`);
		expect([...first.body.data, ...rest.body.data, ...last.body.data].map((item) => item._id)).toEqual(all.body.data.map((item) => item._id));
		expect(last.body.next_cursor).toBeNull();
		expect((await mine('?context=nada')).body.code).toBe('invalid_request');
		expect((await mine('?before=no')).body.code).toBe('invalid_cursor');
		const mark = (json: unknown) =>
			call(store, beto, 'mark_mentions_read', { method: 'PATCH', resource: 'notifications', path: '/my-mentions/read', json });
		expect((await mark({ ids: [all.body.data[0]!._id] })).body.data).toEqual([{ updated: 1 }]);
		expect((await mine('?unread=1')).body.data).toHaveLength(4);
		expect((await mark({ all: true, context: 'reactions' })).body.data).toEqual([{ updated: 1 }]);
		expect((await mine()).body.counts).toEqual({ all: 3, chat: 3, history: 0, reactions: 0 });
		expect((await mark({})).body.code).toBe('invalid_request');
		expect((await mark({ all: true })).body.data).toEqual([{ updated: 3 }]);
		expect((await mine('?unread=1')).body.data).toEqual([]);
		expect((await get(store, ana, 'read_my_mentions', '/my-mentions', {}, 'notifications')).body.data).toEqual([]);
	});
});

describe('envío en tiempo real', () => {
	const POLLING = 'http://imperium.test/api/socket.io/?EIO=4&transport=polling';
	const sessions: Record<string, string> = {};
	bind_socket_identity_resolver(async (session_id) => sessions[session_id] ?? null);

	async function socket_of(user_id: string): Promise<string> {
		const cookie = `chat-flow-${user_id}`;
		sessions[cookie] = user_id;
		const req = new Request(POLLING, { headers: { cookie: `connect.sid=${cookie}` } });
		remember_socket_ip(req, `203.0.113.${Object.keys(sessions).length}`);
		const open = await (handle_socket_io(req) as Response).text();
		const sid = (JSON.parse(open.slice(1)) as { sid: string }).sid;
		await handle_socket_io(new Request(`${POLLING}&sid=${sid}`, { method: 'POST', body: '40' }));
		expect(await poll(sid)).toStartWith('40');
		return sid;
	}

	async function poll(sid: string): Promise<string> {
		return ((await handle_socket_io(new Request(`${POLLING}&sid=${sid}`))) as Response).text();
	}

	function updates(body: string): Array<{ action: string; data: ImperiumDoc[] }> {
		return body
			.split('\x1e')
			.filter((packet) => packet.startsWith('42'))
			.map((packet) => JSON.parse(packet.slice(2)) as [string, { action: string; data: ImperiumDoc[] }])
			.filter(([event]) => event === 'update')
			.map(([, payload]) => payload);
	}

	test('el mensaje llega como delta a los miembros, el directo también avisa a los builds viejos y queda entregado', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const ana_sid = await socket_of(String(ana._id));
		const beto_sid = await socket_of(String(beto._id));
		const sent = await send(store, ana, { recipient_user_id: beto._id, client_id: crypto.randomUUID(), text: 'Hola' });
		const view = sent.body.data[0]!;
		const conversation_id = view.conversation_id;
		const received = updates(await poll(beto_sid));
		expect(received.map((update) => update.action)).toEqual(['chat_delta', 'messages_refresh', 'chat_delta']);
		expect(received[0]!.data).toEqual([{ conversation_id, op: 'message', seq: 1, message_id: view._id, message: view }]);
		expect(received[1]!.data).toEqual([
			{
				recipient_id: beto._id,
				reason: 'created',
				conversation_key: view.conversation_key,
				message_ids: [view._id],
				message: expect.objectContaining({ _id: view._id, message: 'Hola', senderUserId: ana._id }),
			},
		]);
		expect(received[1]!.data[0]!.message).not.toHaveProperty('senderEmail');
		expect(received[2]!.data).toEqual([{ conversation_id, op: 'delivered', user_id: beto._id, seq: 1 }]);
		expect(updates(await poll(ana_sid)).map((update) => update.action)).toEqual([
			'chat_delta',
			'messages_refresh',
			'chat_delta',
		]);
		const beto_member = store.tables['chat-members']!.find((row) => row.user_id === beto._id);
		expect(beto_member).toMatchObject({ delivered_seq: 1, last_read_seq: 0 });
	});

	test('leer avisa a los otros dispositivos del lector y, con acuses recíprocos, a los demás miembros', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const carla = add_user(store, 'Carla');
		const group = add_group(store, [[ana, 'member'], [beto, 'member'], [carla, 'member']]);
		const id = String(group._id);
		const [ana_sid, beto_sid, carla_sid] = await Promise.all([ana, beto, carla].map((user) => socket_of(String(user._id))));
		await send(store, ana, { conversation_id: id, client_id: crypto.randomUUID(), text: 'Hola' });
		await send(store, ana, { conversation_id: id, client_id: crypto.randomUUID(), text: 'Otra' });
		for (const sid of [ana_sid, beto_sid, carla_sid]) await poll(sid);
		store.tables['user-settings']!.push({ user_id: carla._id, chat_preferences: { privacy: { read_receipts: false } } });
		await call(store, beto, 'mark_conversation_read', {
			resource: 'chat-conversations',
			path: `/${id}/read`,
			params: { id },
			json: { seq: 2 },
		});
		const reads = (body: string) =>
			updates(body)
				.filter((update) => update.action === 'chat_delta')
				.flatMap((update) => update.data)
				.filter((delta) => delta.op === 'read');
		expect(reads(await poll(beto_sid))).toEqual([
			{
				conversation_id: id,
				op: 'read',
				user_id: beto._id,
				seq: 2,
				patch: { last_read_seq: 2, unread_count: 0, unread_mentions: 0, marked_unread: false },
			},
		]);
		expect(reads(await poll(ana_sid))).toEqual([{ conversation_id: id, op: 'read', user_id: beto._id, seq: 2 }]);
		await send(store, ana, { conversation_id: id, client_id: crypto.randomUUID(), text: 'Para ver la cola' });
		expect(reads(await poll(carla_sid))).toEqual([]);
	});

	test('editar y borrar avisan message_updated con rev; borrar para mí avisa solo a quien lo ocultó', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const ana_sid = await socket_of(String(ana._id));
		const beto_sid = await socket_of(String(beto._id));
		const first = await said(store, ana, group, 'Hola');
		const second = await said(store, beto, group, 'Respuesta', { reply_to_message_id: first._id });
		for (const sid of [ana_sid, beto_sid]) await poll(sid);
		await edit(store, ana, first._id, { text: 'Hola, editado' });
		await remove(store, ana, first._id, 'all');
		const deltas = (body: string) =>
			updates(body)
				.filter((update) => update.action === 'chat_delta')
				.flatMap((update) => update.data);
		const conversation_id = group._id;
		expect(deltas(await poll(beto_sid))).toEqual([
			{
				conversation_id,
				op: 'message_updated',
				seq: 1,
				message_id: first._id,
				patch: {
					text: 'Hola, editado',
					mentions: { user_ids: [], all: false, here: false },
					edited_at: expect.any(String),
					edit_count: 1,
					rev: 1,
					updated_at: expect.any(String),
				},
			},
			{
				conversation_id,
				op: 'message_updated',
				seq: 1,
				message_id: first._id,
				patch: {
					text: '',
					attachments: [],
					reactions: [],
					deleted: { at: expect.any(String), by_role: 'sender' },
					rev: 2,
					updated_at: expect.any(String),
				},
			},
			{
				conversation_id,
				op: 'message_updated',
				seq: 2,
				message_id: second._id,
				patch: {
					reply_to: { message_id: first._id, sender_name: 'Ana', text_preview: null, kind: 'text', deleted: true },
					rev: 1,
					updated_at: expect.any(String),
				},
			},
		]);
		await poll(ana_sid);
		await remove(store, beto, second._id, 'me');
		expect(deltas(await poll(beto_sid))).toEqual([
			{ conversation_id, op: 'removed', message_id: second._id, patch: { reason: 'hidden' } },
		]);
		await said(store, beto, group, 'Otra');
		expect(deltas(await poll(ana_sid)).map((delta) => delta.op)).toEqual(['message', 'delivered']);
	});

	test('reaccionar y votar avisan con rev; el delta de una encuesta nunca lleva votantes anónimos ni conteos ocultos', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const ana_sid = await socket_of(String(ana._id));
		const text = await said(store, ana, group, 'Hola');
		const anonymous = await poll_in(store, ana, group, { anonymous: true });
		const hidden = await poll_in(store, ana, group, { results: 'after_close' });
		await poll(ana_sid);
		await react(store, beto, text._id, { emoji: '👍' });
		await vote(store, beto, anonymous._id, ['o2']);
		await vote(store, beto, hidden._id, ['o1']);
		const deltas = updates(await poll(ana_sid))
			.filter((update) => update.action === 'chat_delta')
			.flatMap((update) => update.data);
		const conversation_id = group._id;
		expect(deltas).toEqual([
			{ conversation_id, op: 'reaction', message_id: text._id, user_id: beto._id, patch: { emoji: '👍', op: 'add', count: 1, rev: 1 } },
			{
				conversation_id,
				op: 'message_updated',
				seq: 2,
				message_id: anonymous._id,
				patch: {
					poll: {
						question: '¿Cuándo nos vemos?',
						multiple: false,
						anonymous: true,
						results: 'always',
						total_voters: 1,
						options: [
							{ id: 'o1', text: 'Lunes', votes: 0 },
							{ id: 'o2', text: 'Martes', votes: 1 },
							{ id: 'o3', text: 'Miércoles', votes: 0 },
						],
					},
					rev: 1,
					updated_at: expect.any(String),
				},
			},
			{
				conversation_id,
				op: 'message_updated',
				seq: 3,
				message_id: hidden._id,
				patch: { poll: { total_voters: 1 }, rev: 1, updated_at: expect.any(String) },
			},
		]);
		expect(JSON.stringify(deltas.slice(1))).not.toContain(String(beto._id));
	});

	test('@aquí cuenta solo a quien está en línea y la Actividad avisa por notifications_refresh', async () => {
		const store = chat_store({ 'configuration-chat-mass-mention-threshold': 2 });
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'member']]);
		const beto_sid = await socket_of(String(beto!._id));
		const view = await said(store, ana!, group, '[@aquí](mention:here) ¿quién está?');
		expect(view.mentions).toEqual({ user_ids: [], all: false, here: true });
		expect([beto!, carla!].map((user) => member_row(store, group, user).mentionSeqs)).toEqual([[1], []]);
		await Bun.sleep(150);
		const refreshes = updates(await poll(beto_sid))
			.filter((update) => update.action === 'notifications_refresh')
			.flatMap((update) => update.data);
		expect(refreshes).toEqual([
			{ recipient_id: beto!._id, reason: 'activity_created', activity_ids: [store.tables.mentions![0]!._id] },
		]);
	});

	test('un grupo no emite messages_refresh', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const beto_sid = await socket_of(String(beto._id));
		await send(store, ana, { conversation_id: group._id, client_id: crypto.randomUUID(), text: 'Hola' });
		expect(updates(await poll(beto_sid)).map((update) => update.action)).toEqual(['chat_delta', 'chat_delta']);
	});

	test('expulsar avisa removed al expulsado y membership a los demás; las preferencias llegan a sus dispositivos', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'member']]);
		const id = String(group._id);
		const [ana_sid, beto_sid, carla_sid] = await Promise.all([ana!, beto!, carla!].map((user) => socket_of(String(user._id))));
		const removed = await call(store, ana!, 'remove_conversation_member', {
			method: 'DELETE',
			resource: 'chat-conversations',
			path: `/${id}/members/${carla!._id}?ban=1`,
			params: { id, userId: String(carla!._id) },
		});
		expect(removed.status).toBe(200);
		const deltas = (body: string) =>
			updates(body)
				.filter((update) => update.action === 'chat_delta')
				.flatMap((update) => update.data);
		expect(deltas(await poll(carla_sid))).toEqual([{ conversation_id: id, op: 'removed', patch: { reason: 'banned' } }]);
		const seen = deltas(await poll(beto_sid));
		expect(seen.slice(0, 2)).toEqual([
			{ conversation_id: id, op: 'membership', user_id: carla!._id, patch: { state: 'banned' } },
			{ conversation_id: id, op: 'conversation', patch: { member_count: 2 } },
		]);
		expect(seen[2]).toMatchObject({
			op: 'message',
			message: { kind: 'system', sender: null, system: { type: 'member_removed', actor_id: ana!._id, target_ids: [carla!._id] } },
		});
		await poll(ana_sid);
		await call(store, beto!, 'update_conversation_prefs', {
			method: 'PATCH',
			resource: 'chat-conversations',
			path: `/${id}/prefs`,
			params: { id },
			json: { archived: true },
		});
		expect(deltas(await poll(beto_sid))).toEqual([
			{ conversation_id: id, op: 'prefs', user_id: beto!._id, patch: { archived: true, notify_level: 'default' } },
		]);
	});

	test('editar, reaccionar o votar un mensaje de antes de visibleFromSeq no le llega a quien no lo ve', async () => {
		const store = chat_store();
		const [ana, beto, nora] = ['Ana', 'Beto', 'Nora'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member']]);
		const old = await said(store, ana!, group, 'texto viejo');
		const survey = await poll_in(store, ana!, group);
		const reply = await said(store, beto!, group, 'te respondo', { reply_to_message_id: old._id });
		add_member(store, String(group._id), String(nora!._id), 'member', new Date().toISOString(), { visibleFromSeq: 2 });
		const [beto_sid, nora_sid] = await Promise.all([beto!, nora!].map((user) => socket_of(String(user._id))));
		await edit(store, ana!, old._id, { text: 'EDITADO CONFIDENCIAL' });
		await react(store, beto!, old._id, { emoji: '👍' });
		await vote(store, beto!, survey._id, ['o1']);
		await react(store, ana!, reply._id, { emoji: '👍' });
		const seen = async (sid: string) =>
			updates(await poll(sid))
				.filter((update) => update.action === 'chat_delta')
				.flatMap((update) => update.data)
				.map((delta) => [delta.op, delta.message_id]);
		expect(await seen(nora_sid)).toEqual([['reaction', reply._id]]);
		expect(await seen(beto_sid)).toEqual([
			['message_updated', old._id],
			['reaction', old._id],
			['message_updated', survey._id],
			['reaction', reply._id],
		]);
	});

	test('los fijados de antes de visibleFromSeq no salen ni en el detalle ni en el delta de pins', async () => {
		const store = chat_store();
		const [ana, nora] = ['Ana', 'Nora'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner']]);
		const secret = await said(store, ana!, group, 'SECRETO previo a Nora');
		add_member(store, String(group._id), String(nora!._id), 'member', new Date().toISOString(), { visibleFromSeq: 1 });
		const later = await said(store, ana!, group, 'ya con Nora');
		const nora_sid = await socket_of(String(nora!._id));
		await pin(store, ana!, group._id, { message_id: secret._id });
		await pin(store, ana!, group._id, { message_id: later._id });
		const deltas = updates(await poll(nora_sid))
			.filter((update) => update.action === 'chat_delta')
			.flatMap((update) => update.data)
			.filter((delta) => delta.op === 'conversation')
			.map((delta) => (delta.patch as ImperiumDoc).pins as ImperiumDoc[]);
		expect(deltas.map((pins) => pins.map((item) => item.message_id))).toEqual([[], [later._id]]);
		// El delta solo dice qué está fijado; el texto se lee del detalle, que filtra por quien mira.
		expect(deltas.flat().map((item) => Object.keys(item).sort())).toEqual([['message_id', 'seq']]);
		expect(((await detail_of(store, nora!, group._id)).pins as ImperiumDoc[]).map((item) => item.message_id)).toEqual([later._id]);
		expect(((await detail_of(store, ana!, group._id)).pins as ImperiumDoc[]).map((item) => item.message_id)).toEqual([
			secret._id,
			later._id,
		]);
		expect((await remove(store, nora!, later._id, 'me')).status).toBe(200);
		expect((await detail_of(store, nora!, group._id)).pins).toEqual([]);
		expect(((await detail_of(store, ana!, group._id)).pins as ImperiumDoc[]).map((item) => item.message_id)).toContain(later._id);
	});
});

const PNG = Uint8Array.from(
	atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
	(char) => char.charCodeAt(0),
);

const in_conversation = (
	store: ChatStore,
	actor: ImperiumDoc,
	action: string,
	opts: { method?: string; path: string; params?: Record<string, string>; json?: unknown; form?: FormData },
) => call(store, actor, action, { resource: 'chat-conversations', ...opts });

const create_group = (store: ChatStore, actor: ImperiumDoc, json: ImperiumDoc) =>
	in_conversation(store, actor, 'create_group_conversation', { path: '/group', json });

const add_members = (store: ChatStore, actor: ImperiumDoc, id: unknown, user_ids: unknown[]) =>
	in_conversation(store, actor, 'add_conversation_members', {
		path: `/${id}/members`,
		params: { id: String(id) },
		json: { user_ids },
	});

const update_member = (store: ChatStore, actor: ImperiumDoc, id: unknown, user: ImperiumDoc, json: ImperiumDoc) =>
	in_conversation(store, actor, 'update_conversation_member', {
		method: 'PATCH',
		path: `/${id}/members/${user._id}`,
		params: { id: String(id), userId: String(user._id) },
		json,
	});

const remove_member = (store: ChatStore, actor: ImperiumDoc, id: unknown, user: ImperiumDoc, query = '') =>
	in_conversation(store, actor, 'remove_conversation_member', {
		method: 'DELETE',
		path: `/${id}/members/${user._id}${query}`,
		params: { id: String(id), userId: String(user._id) },
	});

const leave = (store: ChatStore, actor: ImperiumDoc, id: unknown, json: ImperiumDoc = {}) =>
	in_conversation(store, actor, 'leave_conversation', { path: `/${id}/leave`, params: { id: String(id) }, json });

const update_info = (store: ChatStore, actor: ImperiumDoc, id: unknown, body: ImperiumDoc | FormData) =>
	in_conversation(store, actor, 'update_conversation_info', {
		method: 'PATCH',
		path: `/${id}/info`,
		params: { id: String(id) },
		...(body instanceof FormData ? { form: body } : { json: body }),
	});

const update_prefs = (store: ChatStore, actor: ImperiumDoc, id: unknown, json: ImperiumDoc) =>
	in_conversation(store, actor, 'update_conversation_prefs', { method: 'PATCH', path: `/${id}/prefs`, params: { id: String(id) }, json });

const systems = (store: ChatStore, id: unknown) =>
	store.tables.messages!
		.filter((row) => row.conversation_id === id && row.kind === 'system')
		.map((row) => (row.system as ImperiumDoc).type);

describe('grupos y canales', () => {
	test('crear un grupo: dueño, miembros, ajustes y un mensaje de sistema que no cuenta como no leído para quien lo creó', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const created = await create_group(store, ana!, {
			title: '  Compras  ',
			description: 'Pedidos del mes',
			member_ids: [beto!._id, carla!._id, ana!._id],
			settings: { members_can_pin: false },
		});
		expect(created.status).toBe(200);
		const view = created.body.data[0]!;
		expect(view).toMatchObject({
			kind: 'group',
			title: 'Compras',
			description: 'Pedidos del mes',
			my_role: 'owner',
			member_count: 3,
			unread_count: 0,
			last_seq: 1,
			last_message: { kind: 'system', sender_id: null, text_preview: 'Ana creó el grupo' },
			settings: { members_can_pin: false, members_can_invite: true, members_can_edit_info: true, announcement_only: false },
		});
		expect(view.conversation_key).toBe(`conv:${view._id}`);
		const roles = store.tables['chat-members']!
			.filter((row) => row.conversation_id === view._id)
			.map((row) => [row.user_id, row.role, row.invitedById]);
		expect(roles).toEqual([
			[ana!._id, 'owner', undefined],
			[beto!._id, 'member', ana!._id],
			[carla!._id, 'member', ana!._id],
		]);
		const summary = await get(store, beto!, 'read_conversation_summary', `/${view._id}`, { id: String(view._id) }, 'chat-conversations');
		expect(summary.body.data[0]).toMatchObject({ my_role: 'member', unread_count: 1 });
		const history = await get(store, beto!, 'read_message_page', `/history/${view._id}`, { conversationId: String(view._id) });
		expect(history.body.data).toEqual([
			expect.objectContaining({
				kind: 'system',
				sender: null,
				text: '',
				system: { type: 'created', actor_id: ana!._id, data: { title: 'Compras', kind: 'group' } },
			}),
		]);
	});

	test('crear: título obligatorio, personas que existen y siguen activas, y sin pasar del máximo', async () => {
		const store = chat_store({ 'configuration-chat-max-group-members': 2 });
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const ida = add_user(store, 'Ida', { is_active: false });
		const outcome = async (json: ImperiumDoc) => {
			const reply = await create_group(store, ana!, json);
			return [reply.status, reply.body.code];
		};
		expect(await outcome({ title: '  ', member_ids: [beto!._id] })).toEqual([422, 'invalid_request']);
		expect(await outcome({ title: 'Compras', kind: 'foro', member_ids: [] })).toEqual([422, 'invalid_request']);
		expect(await outcome({ title: 'Compras', member_ids: [beto!._id, carla!._id] })).toEqual([409, 'group_full']);
		expect(await outcome({ title: 'Compras', member_ids: [hex_id()] })).toEqual([404, 'user_not_found']);
		expect(await outcome({ title: 'Compras', member_ids: [ida._id] })).toEqual([403, 'user_inactive']);
		expect(await outcome({ title: 'Compras', member_ids: [], settings: { ephemeral_seconds: 86400 } })).toEqual([403, 'feature_disabled']);
		expect(await outcome({ title: 'Compras', member_ids: [], settings: { slow_mode_seconds: -1 } })).toEqual([422, 'invalid_request']);
		expect(store.tables['chat-conversations']).toHaveLength(0);
	});

	test('un canal solo admite anuncios aunque se pida lo contrario: el miembro no escribe, quien administra sí', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const created = await create_group(store, ana, {
			title: 'Avisos',
			kind: 'channel',
			member_ids: [beto._id],
			settings: { announcement_only: false },
		});
		const id = created.body.data[0]!._id;
		expect(created.body.data[0]).toMatchObject({ kind: 'channel', settings: { announcement_only: true } });
		expect(created.body.message).toBe('Canal creado.');
		const denied = await send(store, beto, { conversation_id: id, client_id: crypto.randomUUID(), text: 'Hola' });
		expect([denied.status, denied.body.code]).toEqual([403, 'announcement_only']);
		expect((await send(store, ana, { conversation_id: id, client_id: crypto.randomUUID(), text: 'Aviso' })).status).toBe(200);
		const kept = await update_info(store, ana, id, { settings: { announcement_only: false, members_can_pin: false } });
		expect(kept.body.data[0]).toMatchObject({ settings: { announcement_only: true, members_can_pin: false } });
	});

	test('abrir el directo con otra persona o el self con el propio id; la segunda vez es el mismo', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const open = (user_id: unknown) =>
			in_conversation(store, ana, 'open_direct_conversation', { path: '/direct', json: { user_id } });
		const first = await open(beto._id);
		expect(first.body.data[0]).toMatchObject({
			kind: 'direct',
			title: 'Beto',
			peer: { _id: beto._id, name: 'Beto' },
			my_role: 'member',
			member_count: 2,
		});
		expect((await open(beto._id)).body.data[0]!._id).toBe(first.body.data[0]!._id);
		expect((await open(ana._id)).body.data[0]).toMatchObject({ kind: 'self', title: 'Ana', member_count: 1 });
		const missing = await open(hex_id());
		expect([missing.status, missing.body.code]).toEqual([404, 'user_not_found']);
		const on_direct = await add_members(store, ana, first.body.data[0]!._id, [add_user(store, 'Carla')._id]);
		expect([on_direct.status, on_direct.body.code]).toEqual([409, 'not_a_group']);
	});

	test('añadir: según el rol y el grupo, sin pasar del máximo; quien vuelve entra de nuevo y un baneado no', async () => {
		const store = chat_store({ 'configuration-chat-max-group-members': 4 });
		const [ana, beto, carla, dario, eva] = ['Ana', 'Beto', 'Carla', 'Dario', 'Eva'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member']], { membersCanInvite: false });
		const denied = await add_members(store, beto!, group._id, [carla!._id]);
		expect([denied.status, denied.body.code]).toEqual([403, 'role_required']);
		const added = await add_members(store, ana!, group._id, [carla!._id, beto!._id]);
		expect(added.status).toBe(200);
		expect(added.body.data).toEqual([
			{ user: { _id: carla!._id, name: 'Carla', email: 'carla@empresa.com' }, role: 'member', state: 'active', joined_at: expect.any(String) },
		]);
		expect(member_row(store, group, carla!)).toMatchObject({ invitedById: ana!._id, visibleFromSeq: 0 });
		expect(systems(store, group._id)).toEqual(['members_added']);
		expect(store.tables['chat-conversations']![0]!.lastMessage).toMatchObject({ textPreview: 'Ana agregó a Carla' });
		const full = await add_members(store, ana!, group._id, [dario!._id, eva!._id]);
		expect([full.status, full.body.code]).toEqual([409, 'group_full']);
		expect((await remove_member(store, ana!, group._id, carla!, '?ban=1')).status).toBe(200);
		const banned = await add_members(store, ana!, group._id, [dario!._id, carla!._id]);
		expect([banned.status, banned.body.code, banned.body.details]).toEqual([403, 'banned', { user_ids: [carla!._id] }]);
		expect(member_row(store, group, dario!)).toBeUndefined();
		await leave(store, beto!, group._id);
		expect((await add_members(store, ana!, group._id, [beto!._id])).body.data[0]).toMatchObject({ state: 'active', role: 'member' });
	});

	test('rol y restricción según la matriz: el dueño nombra administradores, el administrador solo moderadores', async () => {
		const store = chat_store();
		const [ana, beto, carla, dario] = ['Ana', 'Beto', 'Carla', 'Dario'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'member'], [dario!, 'member']]);
		const promoted = await update_member(store, ana!, group._id, beto!, { role: 'admin' });
		expect(promoted.body.data[0]).toMatchObject({ user: { _id: beto!._id }, role: 'admin', state: 'active' });
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({
			action: 'role_changed',
			actor_id: ana!._id,
			targetUserId: beto!._id,
			before: { role: 'member' },
			after: { role: 'admin' },
		});
		expect(systems(store, group._id)).toEqual(['role_changed']);
		const outcome = async (actor: ImperiumDoc, target: ImperiumDoc, json: ImperiumDoc) => {
			const reply = await update_member(store, actor, group._id, target, json);
			return [reply.status, reply.body.code];
		};
		expect(await outcome(beto!, carla!, { role: 'admin' })).toEqual([403, 'role_required']);
		expect(await outcome(beto!, carla!, { role: 'moderator' })).toEqual([200, undefined]);
		expect(await outcome(beto!, ana!, { role: 'member' })).toEqual([409, 'owner_role_change']);
		expect(await outcome(carla!, dario!, { role: 'moderator' })).toEqual([403, 'role_required']);
		expect(await outcome(ana!, dario!, { role: 'owner' })).toEqual([422, 'invalid_request']);
		expect(await outcome(ana!, add_user(store, 'Eva'), { role: 'member' })).toEqual([409, 'not_member_target']);
		const until = new Date(Date.now() + 3_600_000).toISOString();
		expect(await outcome(carla!, dario!, { restricted_until: until })).toEqual([200, undefined]);
		expect(await outcome(dario!, carla!, { restricted_until: until })).toEqual([403, 'role_required']);
		const muted = await send(store, dario!, { conversation_id: group._id, client_id: crypto.randomUUID(), text: 'Hola' });
		expect([muted.status, muted.body.code]).toEqual([403, 'member_restricted']);
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({ action: 'restricted', after: { restrictedUntil: until } });
		expect(await outcome(carla!, dario!, { restricted_until: null })).toEqual([200, undefined]);
		expect((await send(store, dario!, { conversation_id: group._id, client_id: crypto.randomUUID(), text: 'Hola' })).status).toBe(200);
	});

	test('expulsado sin acceso a medios ni historial; quien sigue en el grupo conserva ambos', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'member']]);
		const id = String(group._id);
		const form = new FormData();
		form.append('conversation_id', id);
		form.append('client_id', crypto.randomUUID());
		form.append('text', 'El plano');
		form.append('attachments', text_file('plano.txt'));
		const sent = await call(store, beto!, 'create_chat_message', { form });
		expect(sent.status).toBe(200);
		const attachment_id = String((sent.body.data[0]!.attachments as ImperiumDoc[])[0]!.attachment_id);
		const media = async (actor: ImperiumDoc) => (await serve_media(store as unknown as ImperiumStore, attachment_id, { actor })).status;
		const history = (actor: ImperiumDoc) => get(store, actor, 'read_message_page', `/history/${id}`, { conversationId: id });
		expect(await media(carla!)).toBe(200);
		expect((await history(carla!)).status).toBe(200);
		const removed = await remove_member(store, ana!, id, carla!);
		expect(removed.status).toBe(200);
		expect(member_row(store, group, carla!)).toMatchObject({ state: 'removed', leftAt: expect.any(String) });
		expect(group.memberCount).toBe(2);
		expect(await media(carla!)).toBe(403);
		const denied = await history(carla!);
		expect([denied.status, denied.body.code]).toEqual([403, 'not_member']);
		expect(await media(beto!)).toBe(200);
		expect(await media(ana!)).toBe(200);
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({ action: 'member_removed', targetUserId: carla!._id });
		expect(systems(store, id)).toEqual(['member_removed']);
		const again = await remove_member(store, ana!, id, carla!);
		expect([again.status, again.body.code]).toEqual([409, 'not_member_target']);
		const self = await remove_member(store, ana!, id, ana!);
		expect(self.status).toBe(422);
		const upward = await remove_member(store, beto!, id, ana!);
		expect([upward.status, upward.body.code]).toEqual([403, 'role_required']);
	});

	test('salir: el dueño deja sucesor (o al elegido); del directo no se sale; el último da de baja la conversación', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'admin']]);
		member_row(store, group, beto!).joinedAt = '2026-01-01T00:00:00.000Z';
		member_row(store, group, carla!).joinedAt = '2026-02-01T00:00:00.000Z';
		const unknown = await leave(store, ana!, group._id, { transfer_to: hex_id() });
		expect([unknown.status, unknown.body.code]).toEqual([409, 'not_member_target']);
		expect((await leave(store, ana!, group._id)).status).toBe(200);
		expect(member_row(store, group, carla!).role).toBe('owner');
		expect(member_row(store, group, ana!)).toMatchObject({ state: 'left', role: 'member' });
		expect(systems(store, group._id)).toEqual(['member_left', 'role_changed']);
		expect(store.tables['chat-conversations']![0]!.lastMessage).toMatchObject({ textPreview: 'Carla ahora es dueño' });
		expect((await leave(store, carla!, group._id, { transfer_to: beto!._id })).status).toBe(200);
		expect(member_row(store, group, beto!).role).toBe('owner');
		expect((await leave(store, beto!, group._id)).status).toBe(200);
		expect(group).toMatchObject({ is_active: false, memberCount: 0 });
		const direct = await chat_between(store, ana!, beto!, 1);
		const blocked = await leave(store, ana!, direct._id);
		expect([blocked.status, blocked.body.code]).toEqual([409, 'cannot_leave_direct']);
	});

	test('transferir: solo el dueño, a alguien que sigue en el grupo; el dueño pasa a administrador', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'admin']]);
		const transfer = (actor: ImperiumDoc, user_id: unknown) =>
			in_conversation(store, actor, 'transfer_conversation_ownership', {
				path: `/${group._id}/transfer`,
				params: { id: String(group._id) },
				json: { user_id },
			});
		expect((await transfer(beto!, beto!._id)).body.code).toBe('role_required');
		expect((await transfer(ana!, carla!._id)).body.code).toBe('not_member_target');
		const done = await transfer(ana!, beto!._id);
		expect(done.body.data.map((row) => [(row.user as ImperiumDoc)._id, row.role])).toEqual([
			[beto!._id, 'owner'],
			[ana!._id, 'admin'],
		]);
		expect(systems(store, group._id)).toEqual(['role_changed']);
	});

	test('información y ajustes: el título según el grupo, los ajustes quien administra y los temporales si la organización los permite', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'owner'], [beto, 'member']], { membersCanEditInfo: false });
		const outcome = async (actor: ImperiumDoc, body: ImperiumDoc) => {
			const reply = await update_info(store, actor, group._id, body);
			return [reply.status, reply.body.code];
		};
		expect(await outcome(beto, { title: 'Ventas' })).toEqual([403, 'role_required']);
		expect(await outcome(ana, {})).toEqual([422, 'invalid_request']);
		expect(await outcome(ana, { settings: { members_can_edit_info: true } })).toEqual([200, undefined]);
		expect(await outcome(beto, { title: 'Ventas', description: 'Del área' })).toEqual([200, undefined]);
		expect(await outcome(beto, { settings: { members_can_pin: false } })).toEqual([403, 'role_required']);
		expect(await outcome(ana, { settings: { ephemeral_seconds: 86400 } })).toEqual([403, 'feature_disabled']);
		expect(group).toMatchObject({ name: 'Ventas', description: 'Del área', settings: { membersCanEditInfo: true } });
		expect(systems(store, group._id)).toEqual(['settings_changed', 'renamed']);
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({
			action: 'settings_changed',
			before: { membersCanEditInfo: false },
			after: { membersCanEditInfo: true },
		});
		const direct = await chat_between(store, ana, beto, 1);
		const on_direct = await update_info(store, ana, direct._id, { title: 'Nuestro chat' });
		expect([on_direct.status, on_direct.body.code]).toEqual([409, 'not_a_group']);
		const ephemeral = chat_store({ 'configuration-chat-ephemeral-enabled': true });
		const owner = add_user(ephemeral, 'Ana');
		const temporal = add_group(ephemeral, [[owner, 'owner']]);
		const enabled = await update_info(ephemeral, owner, temporal._id, { settings: { ephemeral_seconds: 86400 } });
		expect(enabled.body.data[0]).toMatchObject({ settings: { ephemeral_seconds: 86400 } });
		expect(systems(ephemeral, temporal._id)).toEqual(['ephemeral_changed']);
	});

	test('la imagen del grupo: solo una imagen de hasta 5 MB, la anterior se retira y la ven solo los miembros', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const carla = add_user(store, 'Carla');
		const group = add_group(store, [[ana, 'owner']]);
		const with_avatar = (file: File) => {
			const form = new FormData();
			form.append('avatar', file);
			return update_info(store, ana, group._id, form);
		};
		const svg = await with_avatar(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
		expect([svg.status, svg.body.code]).toEqual([415, 'upload_type_not_allowed']);
		const big = await with_avatar(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'logo.png', { type: 'image/png' }));
		expect([big.status, big.body.code]).toEqual([413, 'upload_too_large']);
		const first = await with_avatar(new File([PNG], 'logo.png', { type: 'image/png' }));
		expect(first.status).toBe(200);
		const first_id = String(first.body.data[0]!.avatar_attachment_id);
		await when_deferred_image_optimize_idle();
		const row = store.tables['attachment-management']!.find((item) => item._id === first_id)!;
		expect(row).toMatchObject({ related_model: 'ChatConversation', related_record_id: group._id });
		const status = async (actor: ImperiumDoc, id: string) => (await serve_media(store as unknown as ImperiumStore, id, { actor })).status;
		expect(await status(ana, first_id)).toBe(200);
		expect(await status(carla, first_id)).toBe(403);
		const second = await with_avatar(new File([PNG], 'otro.png', { type: 'image/png' }));
		await when_deferred_image_optimize_idle();
		expect(second.body.data[0]!.avatar_attachment_id).not.toBe(first_id);
		expect(row.is_active).toBe(false);
		const removed = await update_info(store, ana, group._id, { remove_avatar: true });
		expect(removed.body.data[0]!.avatar_attachment_id).toBeUndefined();
		expect(systems(store, group._id)).toEqual(['avatar_changed', 'avatar_changed', 'avatar_changed']);
	});

	test('preferencias propias: fijar al final, archivar, silenciar y borrador; nada de esto toca a los demás', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const [first, second] = [add_group(store, [[ana, 'owner'], [beto, 'member']]), add_group(store, [[ana, 'owner']])];
		expect((await update_prefs(store, ana, first._id, { pinned: true })).body.data[0]).toMatchObject({ pinned_order: 1 });
		expect((await update_prefs(store, ana, second._id, { pinned: true })).body.data[0]).toMatchObject({ pinned_order: 2 });
		const saved = await update_prefs(store, ana, first._id, {
			pinned: false,
			archived: true,
			muted_until: '2026-12-31T00:00:00Z',
			folder: ' Trabajo ',
			notify_level: 'mentions',
			wallpaper: { kind: 'token', value: 'arena', dim: 0.3 },
			draft: { text: 'Pendiente', reply_to_message_id: hex_id() },
		});
		expect(saved.body.data[0]).toEqual({
			muted_until: '2026-12-31T00:00:00.000Z',
			pinned_order: null,
			archived: true,
			folder: 'Trabajo',
			wallpaper: { kind: 'token', value: 'arena', dim: 0.3 },
			notify_level: 'mentions',
			draft: { text: 'Pendiente', reply_to_message_id: expect.any(String), updated_at: expect.any(String) },
		});
		expect(member_row(store, first, beto)).toMatchObject({ archived: false, notifyLevel: 'default' });
		const cleared = await update_prefs(store, ana, first._id, { draft: null, folder: null });
		expect(cleared.body.data[0]).toMatchObject({ draft: null, folder: null });
		for (const json of [{}, { notify_level: 'a veces' }, { wallpaper: { kind: 'token', value: 'arena', dim: 0.9 } }, { pinned: 'sí' }, { folder: 'x'.repeat(41) }]) {
			expect((await update_prefs(store, ana, first._id, json)).status).toBe(422);
		}
		const stranger = await update_prefs(store, add_user(store, 'Carla'), first._id, { archived: true });
		expect(stranger.body.code).toBe('not_member');
	});

	test('miembros: los activos para todos, por nombre y con cursor; las bajas solo para quien modera', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'member']]);
		member_row(store, group, beto!).created_at = '2026-01-02T00:00:00.000Z';
		member_row(store, group, carla!).created_at = '2026-01-03T00:00:00.000Z';
		member_row(store, group, ana!).created_at = '2026-01-01T00:00:00.000Z';
		const members = (actor: ImperiumDoc, query = '') =>
			get(store, actor, 'read_conversation_members', `/${group._id}/members${query}`, { id: String(group._id) }, 'chat-conversations');
		const first = await members(beto!, '?limit=2');
		expect(first.body.data.map((row) => (row.user as ImperiumDoc).name)).toEqual(['Ana', 'Beto']);
		const rest = await members(beto!, `?limit=2&cursor=${first.body.next_cursor}`);
		expect(rest.body.data.map((row) => (row.user as ImperiumDoc).name)).toEqual(['Carla']);
		expect(rest.body.next_cursor).toBeNull();
		expect((await members(beto!, '?q=carl')).body.data).toEqual([
			{ user: { _id: carla!._id, name: 'Carla', email: 'carla@empresa.com' }, role: 'member', state: 'active', joined_at: expect.any(String) },
		]);
		await leave(store, carla!, group._id);
		expect((await members(beto!, '?state=left')).body.code).toBe('role_required');
		expect((await members(ana!, '?state=left')).body.data.map((row) => row.state)).toEqual(['left']);
		expect((await members(ana!, '?state=fuera')).status).toBe(422);
		expect((await members(add_user(store, 'Dario'))).body.code).toBe('not_member');
	});
});

const create_invite = (store: ChatStore, actor: ImperiumDoc, id: unknown, json: ImperiumDoc = {}) =>
	in_conversation(store, actor, 'create_conversation_invite', { path: `/${id}/invites`, params: { id: String(id) }, json });

const revoke_invite = (store: ChatStore, actor: ImperiumDoc, id: unknown, invite_id: unknown) =>
	in_conversation(store, actor, 'revoke_conversation_invite', {
		method: 'DELETE',
		path: `/${id}/invites/${invite_id}`,
		params: { id: String(id), inviteId: String(invite_id) },
	});

const preview_invite = (store: ChatStore, actor: ImperiumDoc, token: unknown) =>
	get(store, actor, 'read_conversation_invite', `/invite/${token}`, { token: String(token) }, 'chat-conversations');

const join_invite = (store: ChatStore, actor: ImperiumDoc, token: unknown) =>
	in_conversation(store, actor, 'join_conversation_by_invite', { path: `/invite/${token}/join`, params: { token: String(token) }, json: {} });

const decide = (store: ChatStore, actor: ImperiumDoc, id: unknown, user: ImperiumDoc, approve: unknown) =>
	in_conversation(store, actor, 'decide_join_request', {
		path: `/${id}/requests/${user._id}`,
		params: { id: String(id), userId: String(user._id) },
		json: { approve },
	});

const detail_of = async (store: ChatStore, actor: ImperiumDoc, id: unknown) =>
	(await get(store, actor, 'read_conversation_detail', `/${id}/detail`, { id: String(id) }, 'chat-conversations')).body.data[0]!;

describe('enlaces de invitación', () => {
	test('crear y revocar según la matriz; el detalle muestra todos a quien administra y los suyos a un miembro', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member'], [carla!, 'moderator']]);
		const created = await create_invite(store, ana!, group._id, { name: ' Equipo ', expires_in_hours: 24, max_uses: 5, requires_approval: true });
		expect(created.status).toBe(200);
		const view = created.body.data[0]!;
		expect(view).toEqual({
			invite_id: expect.any(String),
			name: 'Equipo',
			url: `/mensajes?chat_invite=${view.token}`,
			token: expect.stringMatching(/^[a-f0-9]{16}\.[a-f0-9]{32}$/),
			created_by: { _id: ana!._id, name: 'Ana', email: 'ana@empresa.com' },
			created_at: expect.any(String),
			expires_at: expect.any(String),
			max_uses: 5,
			uses: 0,
			requires_approval: true,
		});
		expect(String(view.token).startsWith(`${group.join_code}.`)).toBe(true);
		const own = (await create_invite(store, beto!, group._id)).body.data[0]!;
		expect(String(own.token).split('.')[0]).toBe(String(group.join_code));
		expect((await create_invite(store, carla!, group._id)).body.code).toBe('role_required');
		expect((await create_invite(store, ana!, group._id, { max_uses: 0 })).status).toBe(422);
		expect((await detail_of(store, ana!, group._id)).invites as ImperiumDoc[]).toHaveLength(2);
		expect(((await detail_of(store, beto!, group._id)).invites as ImperiumDoc[]).map((invite) => invite.invite_id)).toEqual([own.invite_id]);
		expect((await detail_of(store, carla!, group._id)).invites).toBeUndefined();
		expect((await revoke_invite(store, beto!, group._id, view.invite_id)).body.code).toBe('role_required');
		expect((await revoke_invite(store, carla!, group._id, own.invite_id)).body.code).toBe('role_required');
		expect((await revoke_invite(store, beto!, group._id, own.invite_id)).status).toBe(200);
		expect((await revoke_invite(store, ana!, group._id, hex_id())).body.code).toBe('invite_not_found');
		expect(((await detail_of(store, ana!, group._id)).invites as ImperiumDoc[])[1]).toMatchObject({ revoked_at: expect.any(String) });
		const direct = await chat_between(store, ana!, beto!, 1);
		expect((await create_invite(store, ana!, direct._id)).body.code).toBe('not_a_group');
	});

	test('hasta 20 enlaces vigentes: los revocados, caducados o agotados dejan lugar', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const group = add_group(store, [[ana, 'owner']]);
		group.join_code = 'a1b2c3d4e5f6a7b8';
		group.invites = Array.from({ length: 20 }, () => ({ id: hex_id(), secret: hex_id(), createdById: ana._id, uses: 0 }));
		const limit = await create_invite(store, ana, group._id);
		expect([limit.status, limit.body.code]).toEqual([409, 'invite_limit']);
		const invites = group.invites as ImperiumDoc[];
		await revoke_invite(store, ana, group._id, invites[3]!.id);
		const next = await create_invite(store, ana, group._id);
		expect(next.status).toBe(200);
		expect((group.invites as ImperiumDoc[]).map((invite) => invite.id)).not.toContain(invites[3]!.id);
		expect(group.invites).toHaveLength(20);
	});

	test('la vista previa no dice de más; unirse respeta caducidad, usos, baneos y cupo', async () => {
		const store = chat_store({ 'configuration-chat-max-group-members': 3 });
		const [ana, beto, carla, dario, eva] = ['Ana', 'Beto', 'Carla', 'Dario', 'Eva'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [carla!, 'member']]);
		const token = (await create_invite(store, ana!, group._id, { max_uses: 2 })).body.data[0]!.token;
		expect((await preview_invite(store, beto!, token)).body.data).toEqual([
			{ title: 'Compras', kind: 'group', member_count: 2, requires_approval: false, already_member: false },
		]);
		expect((await preview_invite(store, carla!, token)).body.data[0]).toMatchObject({ already_member: true });
		const joined = await join_invite(store, beto!, token);
		expect(joined.body.data[0]).toMatchObject({ state: 'active', conversation: { _id: group._id, my_role: 'member', member_count: 3 } });
		expect(systems(store, group._id)).toEqual(['joined_by_link']);
		expect(store.tables['chat-conversations']![0]!.lastMessage).toMatchObject({ textPreview: 'Beto se unió con un enlace' });
		expect((await join_invite(store, beto!, token)).body.data[0]).toMatchObject({ state: 'active' });
		expect((group.invites as ImperiumDoc[])[0]!.uses).toBe(1);
		await remove_member(store, ana!, group._id, carla!, '?ban=1');
		const banned = await join_invite(store, carla!, token);
		expect([banned.status, banned.body.code]).toEqual([403, 'banned']);
		await join_invite(store, dario!, token);
		const exhausted = await join_invite(store, eva!, token);
		expect([exhausted.status, exhausted.body.code]).toEqual([410, 'invite_exhausted']);
		const roomy = (await create_invite(store, ana!, group._id)).body.data[0]!.token;
		const full = await join_invite(store, eva!, roomy);
		expect([full.status, full.body.code]).toEqual([409, 'group_full']);
		(group.invites as ImperiumDoc[])[1]!.expiresAt = new Date(Date.now() - 1000).toISOString();
		expect((await preview_invite(store, eva!, roomy)).body.code).toBe('invite_expired');
		for (const bad of ['no-es-token', `${group.join_code}.${'0'.repeat(32)}`, `${'0'.repeat(16)}.${'0'.repeat(32)}`]) {
			const missing = await join_invite(store, eva!, bad);
			expect([missing.status, missing.body.code]).toEqual([404, 'invite_not_found']);
		}
	});

	test('con aprobación se pide; quien modera aprueba o rechaza y lo ve en el detalle', async () => {
		const store = chat_store();
		const [ana, beto, carla, dario] = ['Ana', 'Beto', 'Carla', 'Dario'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [carla!, 'moderator'], [dario!, 'member']]);
		const token = (await create_invite(store, ana!, group._id, { requires_approval: true })).body.data[0]!.token;
		expect((await join_invite(store, beto!, token)).body.data).toEqual([{ state: 'requested' }]);
		expect(member_row(store, group, beto!)).toMatchObject({ state: 'requested', requestedAt: expect.any(String) });
		expect(group.memberCount).toBe(3);
		expect((await join_invite(store, beto!, token)).body.data).toEqual([{ state: 'requested' }]);
		const history = await get(store, beto!, 'read_message_page', `/history/${group._id}`, { conversationId: String(group._id) });
		expect(history.body.code).toBe('not_member');
		expect((await detail_of(store, carla!, group._id)).pending_requests).toEqual([
			{ user: { _id: beto!._id, name: 'Beto', email: 'beto@empresa.com' }, requested_at: expect.any(String) },
		]);
		expect((await detail_of(store, dario!, group._id)).pending_requests).toBeUndefined();
		expect((await decide(store, dario!, group._id, beto!, true)).body.code).toBe('role_required');
		expect((await decide(store, carla!, group._id, beto!, 'tal vez')).status).toBe(422);
		const approved = await decide(store, carla!, group._id, beto!, true);
		expect(approved.body.data[0]).toMatchObject({ user: { _id: beto!._id }, state: 'active', role: 'member' });
		expect(group.memberCount).toBe(4);
		expect(systems(store, group._id)).toEqual(['members_added']);
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({ action: 'join_approved', actor_id: carla!._id, targetUserId: beto!._id });
		expect((await decide(store, carla!, group._id, beto!, true)).body.code).toBe('request_not_found');
		const eva = add_user(store, 'Eva');
		await join_invite(store, eva, token);
		const denied = await decide(store, ana!, group._id, eva, false);
		expect(denied.body.data[0]).toMatchObject({ user: { _id: eva._id }, state: 'removed' });
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({ action: 'join_denied', targetUserId: eva._id });
		expect((await join_invite(store, eva, token)).body.data).toEqual([{ state: 'requested' }]);
	});
});

const pin = (store: ChatStore, actor: ImperiumDoc, id: unknown, json: ImperiumDoc) =>
	in_conversation(store, actor, 'pin_conversation_message', { path: `/${id}/pins`, params: { id: String(id) }, json });

const unpin = (store: ChatStore, actor: ImperiumDoc, id: unknown, message_id: unknown) =>
	in_conversation(store, actor, 'unpin_conversation_message', {
		method: 'DELETE',
		path: `/${id}/pins/${message_id}`,
		params: { id: String(id), messageId: String(message_id) },
	});

const forward = (store: ChatStore, actor: ImperiumDoc, json: ImperiumDoc) =>
	call(store, actor, 'forward_chat_messages', { path: '/forward', json });

const gallery = (store: ChatStore, actor: ImperiumDoc, id: unknown, query: string) =>
	get(store, actor, 'read_conversation_media', `/media/${id}${query}`, { conversationId: String(id) });

/** Envía al grupo un mensaje con archivos de texto (multipart). */
async function said_with_files(store: ChatStore, actor: ImperiumDoc, conversation_id: unknown, text: string, names: string[]) {
	const form = new FormData();
	form.append('conversation_id', String(conversation_id));
	form.append('client_id', crypto.randomUUID());
	form.append('text', text);
	for (const name of names) form.append('attachments', text_file(name));
	const sent = await call(store, actor, 'create_chat_message', { form });
	expect(sent.status).toBe(200);
	return sent.body.data[0]!;
}

describe('fijados, reenvíos, tarjetas de registro y galería', () => {
	test('fijar según el rol, con caducidad y hasta el tope; los vencidos no cuentan; desfijar', async () => {
		const store = chat_store({ 'configuration-chat-max-pinned-messages': 2 });
		const [ana, beto] = ['Ana', 'Beto'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'owner'], [beto!, 'member']], { membersCanPin: false });
		const [m1, m2, m3] = [await said(store, beto!, group, 'uno'), await said(store, beto!, group, 'dos'), await said(store, beto!, group, 'tres')];
		expect((await pin(store, beto!, group._id, { message_id: m1._id })).body.code).toBe('role_required');
		const pinned = await pin(store, ana!, group._id, { message_id: m1._id, duration: '24h' });
		expect(pinned.body.data).toEqual([
			{
				message_id: m1._id,
				seq: 1,
				pinned_by: { _id: ana!._id, name: 'Ana', email: 'ana@empresa.com' },
				pinned_at: expect.any(String),
				expires_at: expect.any(String),
				preview: { sender_name: 'Beto', text_preview: 'uno', kind: 'text' },
			},
		]);
		expect(Date.parse(String(pinned.body.data[0]!.expires_at)) - Date.parse(String(pinned.body.data[0]!.pinned_at))).toBe(24 * 3600_000);
		expect(systems(store, group._id)).toEqual(['pinned']);
		expect(store.tables.messages!.at(-1)!.system).toMatchObject({ type: 'pinned', data: { messageId: m1._id, seq: 1 } });
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({ action: 'pin', message_id: m1._id, actor_id: ana!._id });
		await pin(store, ana!, group._id, { message_id: m2._id });
		const full = await pin(store, ana!, group._id, { message_id: m3._id });
		expect([full.status, full.body.code, full.body.details]).toEqual([409, 'pin_limit', { max: 2 }]);
		expect((await pin(store, ana!, group._id, { message_id: m1._id, duration: '7d' })).status).toBe(200);
		(group.pins as ImperiumDoc[]).find((item) => item.messageId === m1._id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
		expect((await pin(store, ana!, group._id, { message_id: m3._id, duration: 'forever' })).body.data[0]).toMatchObject({ expires_at: null });
		expect((group.pins as ImperiumDoc[]).map((item) => item.messageId)).toEqual([m2._id, m3._id]);
		expect(((await detail_of(store, beto!, group._id)).pins as ImperiumDoc[]).map((item) => item.message_id)).toEqual([m2._id, m3._id]);
		expect((await pin(store, ana!, group._id, { message_id: m3._id, duration: '1y' })).status).toBe(422);
		const other = add_group(store, [[ana!, 'owner']]);
		const foreign = await said(store, ana!, other, 'ajeno');
		expect((await pin(store, ana!, group._id, { message_id: foreign._id })).body.code).toBe('message_not_found');
		expect((await unpin(store, beto!, group._id, m2._id)).body.code).toBe('role_required');
		expect((await unpin(store, ana!, group._id, m2._id)).status).toBe(200);
		expect((group.pins as ImperiumDoc[]).map((item) => item.messageId)).toEqual([m3._id]);
		expect(store.tables['chat-audit']!.at(-1)).toMatchObject({ action: 'unpin', message_id: m2._id });
		expect((await unpin(store, ana!, group._id, m2._id)).status).toBe(200);
		await remove(store, beto!, m3._id, 'all');
		expect((await pin(store, ana!, group._id, { message_id: m3._id })).body.code).toBe('message_gone');
	});

	test('reenviar reutiliza el archivo con filas nuevas, sin cita ni menciones; el texto va al final de cada conversación', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const source = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		const team = add_group(store, [[ana!, 'member']]);
		const direct = await chat_between(store, ana!, carla!, 1);
		const file = await said_with_files(store, beto!, source._id, `Mira [@Ana](mention:${ana!._id}) https://ejemplo.com/a.`, ['plano.txt']);
		const poll = await poll_in(store, beto!, source);
		await vote(store, ana!, poll._id, ['o1']);
		const sent = await forward(store, ana!, {
			message_ids: [poll._id, file._id],
			conversation_ids: [team._id, direct._id],
			text: 'Revisen https://ejemplo.com/b',
		});
		expect(sent.status).toBe(200);
		const views = sent.body.data;
		expect(views.map((view) => [view.conversation_id, view.kind])).toEqual([
			[team._id, 'media'],
			[team._id, 'poll'],
			[team._id, 'text'],
			[direct._id, 'media'],
			[direct._id, 'poll'],
			[direct._id, 'text'],
		]);
		expect(views[0]).toMatchObject({
			sender: { _id: ana!._id, name: 'Ana' },
			text: file.text,
			forwarded: { sender_name: 'Beto', at: file.created_at },
		});
		expect(views[0]!.mentions).toBeUndefined();
		expect(views[1]!.poll).toMatchObject({ question: '¿Cuándo nos vemos?', total_voters: 0 });
		expect(views[2]).toMatchObject({ kind: 'text', text: 'Revisen https://ejemplo.com/b' });
		expect(views[2]!.forwarded).toBeUndefined();
		const original = (file.attachments as ImperiumDoc[])[0]!;
		const copied = (views[0]!.attachments as ImperiumDoc[])[0]!;
		expect(copied.attachment_id).not.toBe(original.attachment_id);
		const row = (id: unknown) => store.tables['attachment-management']!.find((item) => item._id === id)!;
		expect(row(copied.attachment_id)).toMatchObject({
			name_stored: row(original.attachment_id).name_stored,
			created_by_id: ana!._id,
			related_model: 'Message',
			related_record_id: views[0]!._id,
			chatUpload: { ownerUserId: ana!._id, conversationId: team._id },
		});
		const in_direct = (views[3]!.attachments as ImperiumDoc[])[0]!;
		const media = async (actor: ImperiumDoc, id: unknown) =>
			(await serve_media(store as unknown as ImperiumStore, String(id), { actor })).status;
		expect(await media(carla!, in_direct.attachment_id)).toBe(200);
		expect(await media(carla!, original.attachment_id)).toBe(403);
		expect(stored(store, views[3]!._id)).toMatchObject({ participantUserIds: expect.arrayContaining([ana!._id, carla!._id]) });
		expect(stored(store, views[0]!._id).links).toEqual(['https://ejemplo.com/a']);
		expect(stored(store, views[2]!._id).links).toEqual(['https://ejemplo.com/b']);
	});

	test('reenviar: ver una vez no se reenvía, lo que no se ve no existe y el destino tiene que admitirlo', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		const channel = add_group(store, [[ana!, 'member'], [carla!, 'owner']], { announcementOnly: true });
		const elsewhere = add_group(store, [[beto!, 'member']]);
		const hello = await said(store, beto!, group, 'Hola');
		const outcome = async (json: ImperiumDoc) => {
			const reply = await forward(store, ana!, json);
			return [reply.status, reply.body.code];
		};
		stored(store, hello._id).viewOnce = { openedByUserIds: [] };
		expect(await outcome({ message_ids: [hello._id], conversation_ids: [group._id] })).toEqual([403, 'view_once_forward']);
		delete stored(store, hello._id).viewOnce;
		const hidden = await said(store, beto!, elsewhere, 'Privado');
		expect(await outcome({ message_ids: [hidden._id], conversation_ids: [group._id] })).toEqual([404, 'message_not_found']);
		expect(await outcome({ message_ids: [hello._id], conversation_ids: [channel._id] })).toEqual([403, 'announcement_only']);
		expect(await outcome({ message_ids: [hello._id], conversation_ids: [elsewhere._id] })).toEqual([403, 'not_member']);
		expect(await outcome({ message_ids: Array.from({ length: 21 }, () => hello._id + ''), conversation_ids: [group._id] })).toEqual([200, undefined]);
		expect(await outcome({ message_ids: Array.from({ length: 21 }, hex_id), conversation_ids: [group._id] })).toEqual([422, 'invalid_request']);
		expect(await outcome({ message_ids: [hello._id], conversation_ids: [] })).toEqual([422, 'invalid_request']);
		const system = add_group(store, [[ana!, 'owner']]);
		await update_info(store, ana!, system._id, { title: 'Otro nombre' });
		const notice = store.tables.messages!.find((row) => row.conversation_id === system._id && row.kind === 'system')!;
		expect(await outcome({ message_ids: [notice._id], conversation_ids: [group._id] })).toEqual([422, 'invalid_request']);
	});

	test('tarjeta de un registro: quien puede leer el modelo la envía con el nombre y el estado del servidor', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana', { _ref: 'user-menu-management-0' });
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const ticket = { _id: hex_id(), name: 'TK-7 Fuga en bodega', state: 'abierto', is_active: true };
		store.tables.tickets = [ticket];
		const card = (actor: ImperiumDoc, record_ref: unknown, text = '') =>
			send(store, actor, { conversation_id: group._id, client_id: crypto.randomUUID(), text, record_ref });
		const sent = await card(ana, { model_name: 'tickets', document_id: ticket._id, route: '/internal/tickets/abc' });
		expect(sent.body.data[0]).toMatchObject({
			kind: 'record',
			text: '',
			record_card: {
				model_name: 'tickets',
				document_id: ticket._id,
				label: 'TK-7 Fuga en bodega',
				route: '/internal/tickets/abc',
				status: 'abierto',
			},
		});
		expect(stored(store, sent.body.data[0]!._id).search_field).toBe('tk-7 fuga en bodega');
		expect(store.tables['chat-conversations']!.find((row) => row._id === group._id)!.lastMessage).toMatchObject({
			kind: 'record',
			textPreview: 'TK-7 Fuga en bodega',
		});
		const outcome = async (actor: ImperiumDoc, record_ref: unknown) => {
			const reply = await card(actor, record_ref);
			return [reply.status, reply.body.code];
		};
		expect(await outcome(beto, { model_name: 'tickets', document_id: ticket._id, route: '/internal/tickets/abc' })).toEqual([403, 'forbidden']);
		expect(await outcome(ana, { model_name: 'messages', document_id: hex_id(), route: '/internal/mensajes' })).toEqual([403, 'forbidden']);
		expect(await outcome(ana, { model_name: 'tickets', document_id: ticket._id, route: '//otro.sitio/x' })).toEqual([422, 'invalid_request']);
		expect(await outcome(ana, { model_name: 'tickets', document_id: hex_id(), route: '/internal/tickets/x' })).toEqual([422, 'invalid_request']);
		const restricted = add_group(store, [[beto, 'member'], [ana, 'owner']], { announcementOnly: true });
		const blocked = await send(store, beto, {
			conversation_id: restricted._id,
			client_id: crypto.randomUUID(),
			record_ref: { model_name: 'tickets', document_id: ticket._id, route: '/internal/tickets/abc' },
		});
		expect(blocked.body.code).toBe('announcement_only');
	});

	test('tarjeta de un registro: las reglas de registro de lectura también cuentan; lo que no alcanza no existe', async () => {
		const store = chat_store();
		const rosa = add_user(store, 'Rosa');
		const group = add_group(store, [[rosa, 'member']]);
		store.tables['user-group'] = [
			{ _id: hex_id(), name: 'Soporte', user_ids: [rosa._id], access_rights_ids: ['lee-tickets'], record_rules_ids: ['solo-propios'] },
		];
		store.tables['access-rights'] = [{ _id: 'lee-tickets', model_id: 'tickets', allow_read: true }];
		store.tables['record-rules'] = [
			{ _id: 'solo-propios', name: 'Solo propios', model_id: 'tickets', allow_read: true, domain: '{"created_by":"$current_user_id"}' },
		];
		const own = { _id: hex_id(), name: 'TK-1 Propio', state: 'abierto', created_by: rosa._id };
		const foreign = { _id: hex_id(), name: 'TK-2 Ajeno confidencial', state: 'abierto', created_by: hex_id() };
		store.tables.tickets = [own, foreign];
		const card = (ticket: ImperiumDoc) =>
			send(store, rosa, {
				conversation_id: group._id,
				client_id: crypto.randomUUID(),
				record_ref: { model_name: 'tickets', document_id: ticket._id, route: '/internal/tickets/x' },
			});
		expect((await card(own)).body.data[0]).toMatchObject({ record_card: { label: 'TK-1 Propio' } });
		const denied = await card(foreign);
		expect([denied.status, denied.body.code]).toEqual([422, 'invalid_request']);
		expect(JSON.stringify(store.tables.messages)).not.toContain('confidencial');
	});

	test('galería: por tipo y por seq, con los enlaces del texto; lo oculto o borrado no sale', async () => {
		const store = chat_store();
		const [ana, beto] = ['Ana', 'Beto'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		const first = await said_with_files(store, beto!, group._id, '', ['primero.txt']);
		const linked = await said(store, ana!, group, 'Ver https://ejemplo.com/x, y http://ejemplo.org.');
		const second = await said_with_files(store, beto!, group._id, '', ['segundo.txt', 'tercero.txt']);
		const hidden = await said_with_files(store, beto!, group._id, '', ['oculto.txt']);
		const gone = await said_with_files(store, beto!, group._id, '', ['borrado.txt']);
		await remove(store, ana!, hidden._id, 'me');
		await remove(store, beto!, gone._id, 'all');
		const files = await gallery(store, ana!, group._id, '?type=file&limit=1');
		expect(files.body.data.map((item) => (item.attachment as ImperiumDoc).name)).toEqual(['segundo', 'tercero']);
		expect(files.body.data[0]).toMatchObject({ message_id: second._id, seq: 3, sender: { _id: beto!._id, name: 'Beto' } });
		expect(files.body.next_cursor).toBe('3');
		const older = await gallery(store, ana!, group._id, `?type=file&before_seq=${files.body.next_cursor}`);
		expect(older.body.data.map((item) => item.message_id)).toEqual([first._id]);
		expect(older.body.next_cursor).toBeNull();
		expect((await gallery(store, beto!, group._id, '?type=file')).body.data.map((item) => item.message_id)).toEqual([
			hidden._id,
			second._id,
			second._id,
			first._id,
		]);
		const links = await gallery(store, ana!, group._id, '?type=link');
		expect(links.body.data).toEqual([
			{ message_id: linked._id, seq: 2, created_at: expect.any(String), sender: { _id: ana!._id, name: 'Ana' }, link: 'https://ejemplo.com/x' },
			{ message_id: linked._id, seq: 2, created_at: expect.any(String), sender: { _id: ana!._id, name: 'Ana' }, link: 'http://ejemplo.org' },
		]);
		await edit(store, ana!, linked._id, { text: 'Sin enlaces' });
		expect((await gallery(store, ana!, group._id, '?type=link')).body.data).toEqual([]);
		expect((await gallery(store, ana!, group._id, '?type=image')).body.data).toEqual([]);
		expect((await gallery(store, ana!, group._id, '?type=todo')).status).toBe(422);
		expect((await gallery(store, add_user(store, 'Carla'), group._id, '?type=file')).body.code).toBe('not_member');
	});

	test('tokens de medios: solo para los adjuntos del chat que quien los pide ve', async () => {
		const store = chat_store();
		const [ana, beto] = ['Ana', 'Beto'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const mine = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		const theirs = add_group(store, [[beto!, 'member']]);
		const visible = await said_with_files(store, beto!, mine._id, '', ['visible.txt']);
		const foreign = await said_with_files(store, beto!, theirs._id, '', ['ajeno.txt']);
		const plain = { _id: hex_id(), name: 'reporte', related_model: 'citizen-report', related_record_id: hex_id(), is_active: true };
		const avatar = { _id: hex_id(), name: 'logo', related_model: 'ChatConversation', related_record_id: mine._id, is_active: true };
		store.tables['attachment-management']!.push(plain, avatar);
		const id_of = (view: ImperiumDoc) => String((view.attachments as ImperiumDoc[])[0]!.attachment_id);
		const issued = await call(store, ana!, 'issue_media_tokens', {
			path: '/media-tokens',
			json: { attachment_ids: [id_of(visible), id_of(foreign), plain._id, avatar._id, hex_id()] },
		});
		expect(issued.body.data.map((row) => row.attachment_id)).toEqual([id_of(visible), avatar._id]);
		const token = new URL(`http://core${issued.body.data[0]!.url}`).searchParams.get('mt');
		expect(media_token_actor(token, id_of(visible))).toEqual({ _id: ana!._id });
		expect(Date.parse(String(issued.body.data[0]!.expires_at)) - Date.now()).toBeGreaterThan(590_000);
		expect((await call(store, ana!, 'issue_media_tokens', { path: '/media-tokens', json: { attachment_ids: [] } })).status).toBe(422);
	});
});

const search = (store: ChatStore, actor: ImperiumDoc, query: string) => get(store, actor, 'search_chat_messages', `/search${query}`);

describe('búsqueda del chat', () => {
	test('sin acentos ni mayúsculas, con fragmento y cursor; solo en lo que quien busca ve', async () => {
		const store = chat_store();
		const [ana, beto, carla] = ['Ana', 'Beto', 'Carla'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		const theirs = add_group(store, [[beto!, 'member'], [carla!, 'member']]);
		const old = await said(store, beto!, group, 'Primera acción del proyecto');
		await Bun.sleep(2);
		const hidden = await said(store, beto!, group, 'Acción oculta para Ana');
		await Bun.sleep(2);
		const gone = await said(store, beto!, group, 'Acción que se borra');
		await Bun.sleep(2);
		const recent = await said(store, ana!, group, `${'x'.repeat(60)} ACCIÓN rápida de cierre ${'y'.repeat(200)}`);
		await Bun.sleep(2);
		const elsewhere = await said(store, carla!, theirs, 'Acción en otro grupo');
		await remove(store, ana!, hidden._id, 'me');
		await remove(store, beto!, gone._id, 'all');
		const first = await search(store, ana!, `?q=${encodeURIComponent('Acción')}&limit=1`);
		expect(first.status).toBe(200);
		expect(first.body.data).toEqual([
			{
				conversation_id: group._id,
				message: expect.objectContaining({ _id: recent._id, conversation_key: group.conversation_key, text: recent.text }),
				snippet: `…${String(recent.text).slice(61 - 40, 61 - 40 + 160)}…`,
			},
		]);
		const second = await search(store, ana!, `?q=accion&limit=1&cursor=${first.body.next_cursor}`);
		expect(second.body.data.map((row) => (row.message as ImperiumDoc)._id)).toEqual([old._id]);
		expect(second.body.data[0]!.snippet).toBe('Primera acción del proyecto');
		expect(second.body.next_cursor).toBeNull();
		expect((await search(store, beto!, '?q=accion')).body.data.map((row) => (row.message as ImperiumDoc)._id)).toEqual([
			elsewhere._id,
			recent._id,
			hidden._id,
			old._id,
		]);
		member_row(store, group, beto!).visibleFromSeq = old.seq;
		expect((await search(store, beto!, '?q=accion')).body.data).toHaveLength(3);
		await leave(store, beto!, group._id);
		expect((await search(store, beto!, '?q=accion')).body.data.map((row) => row.conversation_id)).toEqual([theirs._id]);
		const short = await search(store, ana!, '?q=ac');
		expect([short.status, short.body.code]).toEqual([400, 'search_term_too_short']);
		expect((await search(store, ana!, `?q=ac&conversation_id=${group._id}`)).body.data).toHaveLength(2);
	});

	test('filtros: conversación, remitente, medios, antes y después', async () => {
		const store = chat_store();
		const [ana, beto] = ['Ana', 'Beto'].map((name) => add_user(store, name)) as ImperiumDoc[];
		const first = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		const second = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		const text = await said(store, ana!, first, 'Informe semanal');
		const file = await said_with_files(store, beto!, first._id, 'Informe adjunto', ['informe.txt']);
		const link = await said(store, beto!, second, 'Informe en https://ejemplo.com/informe');
		const ids = async (query: string) =>
			(await search(store, ana!, `?q=informe${query}`)).body.data.map((row) => (row.message as ImperiumDoc)._id);
		expect(await ids('')).toHaveLength(3);
		expect(await ids(`&conversation_id=${first._id}`)).toEqual(expect.arrayContaining([text._id, file._id]));
		expect(await ids(`&conversation_id=${first._id}`)).toHaveLength(2);
		expect(await ids(`&from=${beto!._id}&has=file`)).toEqual([file._id]);
		expect(await ids('&has=link')).toEqual([link._id]);
		expect(await ids(`&before=${encodeURIComponent(String(text.created_at))}`)).toEqual([]);
		expect(await ids(`&after=${encodeURIComponent(String(link.created_at))}`)).toEqual([]);
		expect((await search(store, ana!, '?q=informe&has=gif')).status).toBe(422);
		expect((await search(store, ana!, '?q=INFORME&has=file')).body.data[0]!.snippet).toBe('Informe adjunto');
	});

	test('la forma heredada devuelve documentos de directos y self con la otra persona; los grupos no salen', async () => {
		const store = chat_store();
		const [ana, beto] = ['Ana', 'Beto'].map((name) => add_user(store, name)) as ImperiumDoc[];
		await send(store, beto!, { recipient_user_id: ana!._id, message: 'Revisa la cotización' });
		await Bun.sleep(2);
		await send(store, ana!, { recipient_user_id: ana!._id, message: 'Cotización para mí' });
		const group = add_group(store, [[ana!, 'member'], [beto!, 'member']]);
		await said(store, beto!, group, 'Cotización del grupo');
		const legacy = await search(store, ana!, '?term=cotizacion');
		expect(legacy.body.message).toBe('Coincidencias globales del chat cargadas correctamente.');
		expect(legacy.body.data).toEqual([
			{ conversation_key: ana!._id, message: expect.objectContaining({ message: 'Cotización para mí', sourceType: 'chat' }) },
			{
				conversation_key: [ana!._id, beto!._id].sort().join('::'),
				other_participant: { _id: beto!._id, name: 'Beto' },
				message: expect.objectContaining({ message: 'Revisa la cotización', senderUserId: beto!._id }),
			},
		]);
		const with_beto = await search(store, ana!, `?term=cotizacion&participant_id=${beto!._id}`);
		expect(with_beto.body.data.map((row) => row.conversation_key)).toEqual([[ana!._id, beto!._id].sort().join('::')]);
		expect((await search(store, ana!, '?term=co')).body.data).toEqual([]);
		expect((await search(store, ana!, '?term=')).body.message).toBe('Debes indicar un texto para buscar en el chat.');
	});
});

describe('notas de voz, ver una vez y temporales', () => {
	const voice_file = () => new File([new Uint8Array(32)], 'nota.webm', { type: 'audio/webm' });
	const clip = () => new File([new Uint8Array(16)], 'clip.mp4', { type: 'video/mp4' });
	async function upload(store: ChatStore, actor: ImperiumDoc, conversation_id: string, extra: Record<string, string>, file: File) {
		return call(store, actor, 'create_chat_upload', {
			path: '/uploads',
			form: upload_form({ conversation_id, client_upload_id: crypto.randomUUID(), ...extra }, file),
		});
	}

	test('una nota de voz necesita su duración, de hasta 15 min, y 64 picos; un audio no', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const id = String(add_group(store, [[ana, 'member']])._id);
		const peaks = JSON.stringify(WAVEFORM);
		const incomplete: Array<Record<string, string>> = [
			{ kind: 'voice', peaks },
			{ kind: 'voice', duration_ms: '4200' },
			{ kind: 'voice', duration_ms: '4200', peaks: JSON.stringify(WAVEFORM.slice(1)) },
			{ kind: 'voice', duration_ms: '900001', peaks },
		];
		for (const extra of incomplete) {
			const reply = await upload(store, ana, id, extra, voice_file());
			expect([reply.status, reply.body.code]).toEqual([422, 'invalid_request']);
		}
		expect((await upload(store, ana, id, { kind: 'voice', duration_ms: '900000', peaks }, voice_file())).status).toBe(200);
		const audio = await upload(store, ana, id, { kind: 'audio', peaks: JSON.stringify([1, 2, 3]) }, voice_file());
		expect(audio.body.data[0]).toMatchObject({ kind: 'audio', peaks: [1, 2, 3] });
	});

	test('ver una vez: una sola foto o video, sin url para los demás, se abre una vez por 2 min y quien lo envió no lo gasta', async () => {
		const store = chat_store();
		const ana = add_user(store, 'Ana');
		const beto = add_user(store, 'Beto');
		const group = add_group(store, [[ana, 'member'], [beto, 'member']]);
		const id = String(group._id);
		const first = String((await upload(store, ana, id, {}, clip())).body.data[0]!.attachment_id);
		const second = String((await upload(store, ana, id, {}, clip())).body.data[0]!.attachment_id);
		const note = String((await upload(store, ana, id, {}, text_file())).body.data[0]!.attachment_id);
		const view_once = (attachment_ids: string[]) =>
			send(store, ana, { conversation_id: id, client_id: crypto.randomUUID(), attachment_ids, view_once: true, text: 'mira' });
		for (const ids of [[first, second], [note], []]) {
			const reply = await view_once(ids);
			expect([reply.status, reply.body.code]).toEqual([422, 'invalid_request']);
		}
		const sent = (await view_once([first])).body.data[0]!;
		expect(sent).toMatchObject({ kind: 'media', view_once: { opened: false }, attachments: [{ attachment_id: first, url: `/api/media/${first}` }] });
		const message_id = String(sent._id);
		const seen_by_beto = async () => (await get(store, beto, 'read_message_page', `/history/${id}`, { conversationId: id })).body.data.at(-1)!;
		const before = await seen_by_beto();
		expect(before.view_once).toEqual({ opened: false });
		expect((before.attachments as ImperiumDoc[])[0]!.url).toBeUndefined();
		const media = async (actor: ImperiumDoc, token_user_id?: unknown) =>
			(await serve_media(store as unknown as ImperiumStore, first, { actor, token_user_id: token_user_id as string | undefined })).status;
		expect(await media(beto)).toBe(403);
		expect(await media(ana)).toBe(200);
		const open = (actor: ImperiumDoc, target = message_id) =>
			call(store, actor, 'open_view_once', { path: `/message/${target}/open`, params: { id: target } });
		const opened = await open(beto);
		expect(opened.body.data).toEqual([
			{ attachment_id: first, url: expect.stringContaining(`/api/media/${first}?mt=`), expires_at: expect.any(String) },
		]);
		const lasts = Date.parse(String(opened.body.data[0]!.expires_at)) - Date.now();
		expect(lasts).toBeGreaterThan(100_000);
		expect(lasts).toBeLessThanOrEqual(120_000);
		const token = new URL(`http://core${opened.body.data[0]!.url}`).searchParams.get('mt');
		expect(media_token_actor(token, first)).toEqual({ _id: beto._id });
		expect(await media(beto, beto._id)).toBe(200);
		expect(await media(beto, ana._id)).toBe(403);
		expect(await seen_by_beto()).toMatchObject({ view_once: { opened: true }, rev: 1 });
		const again = await open(beto);
		expect([again.status, again.body.code]).toEqual([410, 'view_once_opened']);
		expect((await open(ana)).status).toBe(200);
		expect(stored(store, message_id).viewOnce).toEqual({ openedByUserIds: [beto._id] });
		const plain = await said(store, ana, group, 'Hola');
		const not_once = await open(beto, String(plain._id));
		expect([not_once.status, not_once.body.code]).toEqual([409, 'not_view_once']);
		const issued = await call(store, beto, 'issue_media_tokens', { path: '/media-tokens', json: { attachment_ids: [first] } });
		expect(issued.body.data).toEqual([]);
		expect((await gallery(store, ana, id, '?type=video')).body.data).toEqual([]);
		await send(store, ana, { conversation_id: id, client_id: crypto.randomUUID(), attachment_ids: [second] });
		expect((await gallery(store, beto, id, '?type=video')).body.data.map((item) => (item.attachment as ImperiumDoc).url)).toEqual([
			`/api/media/${second}`,
		]);
	});

	test('temporales: caducan con el ajuste de la conversación solo si la organización los permite; lo vencido ya no se toca', async () => {
		const on = chat_store({ 'configuration-chat-ephemeral-enabled': true });
		const ana = add_user(on, 'Ana');
		const beto = add_user(on, 'Beto');
		const group = add_group(on, [[ana, 'member'], [beto, 'member']], { ephemeralSeconds: 86400 });
		const sent = await said(on, ana, group, 'Se borra mañana');
		expect(Date.parse(String(sent.expires_at)) - Date.parse(String(sent.created_at))).toBe(86_400_000);
		expect(stored(on, sent._id).expires_at).toBe(sent.expires_at);
		const forwarded = await forward(on, beto, { message_ids: [sent._id], conversation_ids: [group._id] });
		expect(forwarded.body.data[0]!.expires_at).toEqual(expect.any(String));
		stored(on, sent._id).expires_at = new Date(Date.now() - 1000).toISOString();
		const late = await react(on, beto, sent._id, { emoji: '👍' });
		expect([late.status, late.body.code]).toEqual([410, 'message_gone']);
		const off = chat_store();
		const carla = add_user(off, 'Carla');
		const quiet = add_group(off, [[carla, 'member']], { ephemeralSeconds: 86400 });
		expect((await said(off, carla, quiet, 'Se queda')).expires_at).toBeUndefined();
	});
});
