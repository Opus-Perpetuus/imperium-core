/**
 * Historias de 24 h (contrato §4.5): texto con un fondo del tema, imagen o video, para una audiencia
 * (la organización, los contactos o usuarios elegidos, sin los excluidos) que se resuelve en SQL.
 * Las vistas son recíprocas: quien no comparte las suyas cuenta sin nombre, y el autor solo ve quién
 * la vio si comparte las suyas. Responder una historia es un mensaje `story-reply` en el directo.
 */
import { ChatError } from './chat-access.ts';
import {
	attachment_view,
	create_chat_message,
	reaction_emoji,
	remove_unused_files,
	upload_info,
} from './chat-flow.ts';
import { chat_settings, type ChatSettings } from './chat-settings.ts';
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { outside_history_context } from './history.ts';
import { rate_limited_response, take_token } from './rate-bucket.ts';
import type { ChatUserBrief, ImperiumStore } from './store.ts';
import { is_upload, persist_upload_as_attachment } from './uploads.ts';

export type StoryCtx = {
	store: ImperiumStore;
	req: Request;
	url: URL;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
};

const STORY_TTL_MS = 24 * 3600_000;
const STORY_RATE = { capacity: 10, refill_per_s: 10 / 3600 };
const UPLOAD_RATE = { capacity: 30, refill_per_s: 30 / 60 };
const TEXT_MAX = 700;
const CAPTION_MAX = 300;
const AUDIENCE_MAX = 1000;
const FEED_LIMIT = { fallback: 20, max: 50 };
const VIEWERS_MAX = 500;
const KINDS = new Set(['text', 'image', 'video']);
const AUDIENCES = new Set(['organization', 'contacts', 'users']);
/** La llave de un color del tema; nunca un color suelto. */
const BACKGROUND_KEY = /^[a-z][a-z0-9-]{0,39}$/;
const CHAT_ID = /^[a-f0-9]{24}$/i;

function str(value: unknown): string {
	return value == null ? '' : String(value).trim();
}

function defined<T extends Record<string, unknown>>(rec: T): T {
	for (const key of Object.keys(rec)) if (rec[key] === undefined) delete rec[key];
	return rec;
}

function invalid(message = 'La petición no es válida.'): ChatError {
	return new ChatError(422, 'invalid_request', message);
}

function story_not_found(): ChatError {
	return new ChatError(404, 'story_not_found', 'Esa historia ya no está disponible.');
}

function actor_id(ctx: StoryCtx): string {
	return str(ctx.actor?._id);
}

async function stories_settings(store: ImperiumStore): Promise<ChatSettings> {
	const settings = await chat_settings(store);
	if (!settings.messaging_enabled) {
		throw new ChatError(403, 'messaging_disabled', 'El chat está desactivado en esta organización.');
	}
	if (!settings.stories_enabled) throw new ChatError(403, 'feature_disabled', 'Tu organización desactivó esta función.');
	return settings;
}

/** Multipart manda los objetos como texto JSON. */
function json_field(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw invalid();
	}
}

function user_ids(value: unknown): string[] {
	if (value == null) return [];
	if (!Array.isArray(value) || value.length > AUDIENCE_MAX || !value.every((id) => typeof id === 'string' && CHAT_ID.test(id))) {
		throw invalid();
	}
	return [...new Set(value as string[])];
}

/** `audience` de la petición (snake_case) como se guarda; sin ella, la organización. */
function audience_of(value: unknown): ImperiumDoc {
	if (value == null || value === '') return { kind: 'organization', userIds: [], excludeIds: [] };
	const input = as_object(json_field(value));
	const kind = str(input.kind) || 'organization';
	const chosen = user_ids(input.user_ids);
	if (!AUDIENCES.has(kind) || (kind === 'users' && !chosen.length)) {
		throw invalid('Elige para quién es la historia: la organización, tus contactos o personas elegidas.');
	}
	return { kind, userIds: kind === 'users' ? chosen : [], excludeIds: user_ids(input.exclude_ids) };
}

function optional_text(value: unknown, max: number): string | undefined {
	if (value == null || value === '') return undefined;
	if (typeof value !== 'string' || value.trim().length > max) throw invalid(`El texto admite hasta ${max} caracteres.`);
	return value.trim() || undefined;
}

function brief(user: ChatUserBrief): ImperiumDoc {
	return defined({ _id: user._id, name: user.name, email: user.email, img: user.img });
}

/** `StoryView` (contrato §3.7): la audiencia y cuántos la vieron, solo para su autor. */
function story_view(
	row: ImperiumDoc,
	opts: { author?: ChatUserBrief; attachment?: ImperiumDoc; own: boolean; view_count?: number },
): ImperiumDoc {
	const audience = as_object(row.audience);
	return defined({
		_id: str(row._id),
		author: opts.author ? brief(opts.author) : { _id: str(row.author_id), name: '' },
		kind: str(row.kind),
		text: typeof row.text === 'string' && row.text ? row.text : undefined,
		background: str(row.background) || undefined,
		attachment: opts.attachment ? attachment_view(upload_info(opts.attachment)) : undefined,
		caption: str(row.caption) || undefined,
		created_at: str(row.created_at),
		expires_at: str(row.expires_at),
		viewed: opts.own || Boolean(row.my_viewed_at),
		my_reaction: str(row.my_reaction) || undefined,
		audience: opts.own
			? {
					kind: str(audience.kind) || 'organization',
					user_ids: as_array(audience.userIds).map(String),
					exclude_ids: as_array(audience.excludeIds).map(String),
				}
			: undefined,
		view_count: opts.own ? (opts.view_count ?? 0) : undefined,
	});
}

/** Autores, archivos y conteos de vistas de las historias en una consulta cada uno. */
async function story_views(ctx: StoryCtx, rows: ImperiumDoc[]): Promise<ImperiumDoc[]> {
	const uid = actor_id(ctx);
	const own = (row: ImperiumDoc) => str(row.author_id) === uid;
	const file_ids = rows.map((row) => str(row.attachmentId)).filter(Boolean);
	const [users, files, counts] = await Promise.all([
		ctx.store.chat_users_brief(rows.map((row) => str(row.author_id))),
		file_ids.length
			? ctx.store.find_many('attachment-management', { ids: file_ids, take: file_ids.length, populate: false, skip_total: true })
			: Promise.resolve({ rows: [] as ImperiumDoc[], total: 0 }),
		ctx.store.chat_story_view_counts(rows.filter(own).map((row) => str(row._id))),
	]);
	const authors = new Map(users.map((user) => [user._id, user]));
	const attachments = new Map(files.rows.map((file) => [str(file._id), file]));
	return rows.map((row) =>
		story_view(row, {
			author: authors.get(str(row.author_id)),
			attachment: attachments.get(str(row.attachmentId)),
			own: own(row),
			view_count: counts.get(str(row._id)),
		}),
	);
}

type FeedCursor = { muted: boolean; at: string; id: string };

function decode_cursor(raw: string): FeedCursor {
	const cursor = as_object(Buffer.from(raw, 'base64url').toString('utf8'));
	if (typeof cursor.muted === 'boolean' && typeof cursor.at === 'string' && typeof cursor.id === 'string' && cursor.id) {
		return { muted: cursor.muted, at: cursor.at, id: cursor.id };
	}
	throw new ChatError(400, 'invalid_cursor', 'La página solicitada ya no es válida; recarga la lista.');
}

function limit_param(url: URL): number {
	const n = Number(url.searchParams.get('limit'));
	return Number.isSafeInteger(n) && n > 0 ? Math.min(n, FEED_LIMIT.max) : FEED_LIMIT.fallback;
}

/**
 * Contrato §4.5: una entrada por autor con sus historias vigentes, las de quien la pide primero (solo
 * en la página sin cursor) y los autores silenciados al final.
 */
export async function read_story_feed(ctx: StoryCtx): Promise<unknown> {
	await stories_settings(ctx.store);
	const uid = actor_id(ctx);
	const raw_cursor = str(ctx.url.searchParams.get('cursor'));
	const cursor = raw_cursor ? decode_cursor(raw_cursor) : undefined;
	const limit = limit_param(ctx.url);
	const now = new Date().toISOString();
	const muted = await ctx.store.chat_muted_story_authors(uid);
	const authors = await ctx.store.chat_story_feed({ viewer_id: uid, now, muted, cursor, limit: limit + 1 });
	const page = authors.slice(0, limit);
	const ids = [...(cursor ? [] : [uid]), ...page.map((row) => row.author_id)];
	const views = await story_views(ctx, await ctx.store.chat_story_items(uid, ids, now));
	const of_author = (id: string) => views.filter((view) => as_object(view.author)._id === id);
	const entries: ImperiumDoc[] = [];
	const mine = of_author(uid);
	if (!cursor && mine.length) {
		entries.push({ author: mine[0]!.author, stories: mine, has_unseen: false, latest_at: str(mine.at(-1)!.created_at) });
	}
	for (const row of page) {
		const stories = of_author(row.author_id);
		if (stories.length) entries.push({ author: stories[0]!.author, stories, has_unseen: row.has_unseen, latest_at: row.latest_at });
	}
	const last = page.at(-1);
	return {
		...ok(entries, 'Historias cargadas.'),
		next_cursor:
			authors.length > limit && last
				? Buffer.from(JSON.stringify({ muted: last.muted, at: last.latest_at, id: last.author_id })).toString('base64url')
				: null,
		server_time: now,
	};
}

/** Contrato §4.5: las historias vigentes de una persona que quien las pide puede ver. */
export async function read_author_stories(ctx: StoryCtx): Promise<unknown> {
	await stories_settings(ctx.store);
	const author_id = str(ctx.params.userId);
	const rows = CHAT_ID.test(author_id)
		? await ctx.store.chat_story_items(actor_id(ctx), [author_id], new Date().toISOString())
		: [];
	if (!rows.length) throw story_not_found();
	return ok(await story_views(ctx, rows), 'Historias cargadas.');
}

/** Contrato §4.5: texto con fondo, o una imagen o un video con el límite de subida; caduca a las 24 h. */
export async function create_story(ctx: StoryCtx): Promise<unknown> {
	const settings = await stories_settings(ctx.store);
	const uid = actor_id(ctx);
	const kind = str(ctx.body.kind);
	if (!KINDS.has(kind)) throw invalid('Elige si la historia es de texto, de imagen o de video.');
	const text = optional_text(ctx.body.text, TEXT_MAX);
	const caption = optional_text(ctx.body.caption, CAPTION_MAX);
	const background = str(ctx.body.background);
	if (background && !BACKGROUND_KEY.test(background)) throw invalid('El fondo es la llave de un color del tema.');
	const audience = audience_of(ctx.body.audience);
	const file = ctx.body.file;
	if (kind === 'text') {
		if (!text || is_upload(file)) throw invalid('Una historia de texto lleva su texto y ningún archivo.');
	} else {
		if (!is_upload(file)) throw invalid('Sube la imagen o el video de la historia en el campo file.');
		const mime = (file.type || 'application/octet-stream').toLowerCase();
		const fits = kind === 'image' ? mime.startsWith('image/') && mime !== 'image/svg+xml' : mime.startsWith('video/');
		if (!fits) throw new ChatError(415, 'upload_type_not_allowed', 'Ese tipo de archivo no se puede enviar.');
		if (file.size > settings.max_upload_mb * 1024 * 1024) {
			throw new ChatError(413, 'upload_too_large', `El archivo supera el máximo de ${settings.max_upload_mb} MB.`);
		}
	}
	const allowed = take_token(`chat-story:${uid}`, STORY_RATE);
	if (!allowed.ok) return rate_limited_response(allowed.retry_after_s);
	if (is_upload(file)) {
		const upload = take_token(`chat-upload:${uid}`, UPLOAD_RATE);
		if (!upload.ok) return rate_limited_response(upload.retry_after_s);
	}
	const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
	const stored = is_upload(file)
		? await outside_history_context(() =>
				persist_upload_as_attachment(ctx.store, file, {
					actor_id: uid,
					related_model: 'ChatStory',
					related_record_id: id,
					field: 'file',
					index_if_is_array: 0,
					inside_array: false,
				}),
			)
		: null;
	let row: ImperiumDoc;
	try {
		row = await ctx.store.insert(
			'chat-stories',
			defined({
				_id: id,
				name: '',
				created_by: uid,
				author_id: uid,
				expires_at: new Date(Date.now() + STORY_TTL_MS).toISOString(),
				kind,
				text,
				background: background || undefined,
				caption,
				attachmentId: stored ? str(stored._id) : undefined,
				audience,
			}),
		);
	} catch (err) {
		if (stored) {
			await outside_history_context(() => ctx.store.remove('attachment-management', str(stored._id)));
			await remove_unused_files(ctx.store, [str(stored.name_stored)]);
		}
		throw err;
	}
	return ok(await story_views(ctx, [row]), 'Historia publicada.');
}

/** Contrato §4.5: solo su autor; sale con sus vistas y su archivo. */
export async function delete_story(ctx: StoryCtx): Promise<unknown> {
	await stories_settings(ctx.store);
	const id = str(ctx.params.id);
	const dropped = CHAT_ID.test(id)
		? await ctx.store.chat_drop_stories([id], new Date().toISOString(), actor_id(ctx))
		: { ids: [], files: [] };
	if (!dropped.ids.length) throw story_not_found();
	await remove_unused_files(ctx.store, dropped.files);
	return ok([], 'Historia borrada.');
}

/** La historia de `:id` si quien la pide es su autor o está en su audiencia, y aún no vence. */
async function visible_story(ctx: StoryCtx): Promise<ImperiumDoc> {
	const id = str(ctx.params.id);
	const story = CHAT_ID.test(id) ? await ctx.store.chat_story_visible(actor_id(ctx), id) : null;
	if (!story) throw story_not_found();
	if (str(story.expires_at) <= new Date().toISOString()) throw new ChatError(410, 'story_expired', 'La historia caducó.');
	return story;
}

/** Contrato §4.5: una vista por persona, con su reacción; sin nombre si quien la ve no comparte sus vistas. */
export async function view_story(ctx: StoryCtx): Promise<unknown> {
	await stories_settings(ctx.store);
	const uid = actor_id(ctx);
	const story = await visible_story(ctx);
	const reaction = ctx.body.reaction == null || ctx.body.reaction === '' ? undefined : reaction_emoji(ctx.body.reaction);
	if (str(story.author_id) !== uid) {
		const privacy = await ctx.store.chat_privacy(uid);
		await ctx.store.chat_view_story({
			story_id: str(story._id),
			viewer_id: uid,
			payload: defined({ anonymous: privacy.story_view_receipts === false, reaction }),
			now: new Date().toISOString(),
		});
	}
	return ok([{ viewed: true }], 'Historia vista.');
}

/** Contrato §4.5: solo su autor y solo si comparte sus vistas; quien no comparte las suyas cuenta sin nombre. */
export async function read_story_viewers(ctx: StoryCtx): Promise<unknown> {
	await stories_settings(ctx.store);
	const uid = actor_id(ctx);
	const id = str(ctx.params.id);
	const story = CHAT_ID.test(id) ? await ctx.store.find_id('chat-stories', id) : null;
	if (!story || story.is_active === false) throw story_not_found();
	if (str(story.author_id) !== uid) throw new ChatError(403, 'not_author', 'Solo quien publicó la historia puede ver esto.');
	if ((await ctx.store.chat_privacy(uid)).story_view_receipts === false) {
		throw new ChatError(403, 'receipts_off', 'Activa tus confirmaciones de vista para ver quién vio tu historia.');
	}
	const { viewers, anonymous_count } = await ctx.store.chat_story_viewers(id, VIEWERS_MAX);
	const users = new Map((await ctx.store.chat_users_brief(viewers.map((view) => view.viewer_id))).map((user) => [user._id, user]));
	return {
		...ok(
			viewers.flatMap((view) => {
				const user = users.get(view.viewer_id);
				return user ? [defined({ viewer: brief(user), viewed_at: view.viewed_at, reaction: view.reaction ?? undefined })] : [];
			}),
			'Vistas cargadas.',
		),
		anonymous_count,
	};
}

/** Contrato §4.5: la respuesta sale por el envío normal al directo con su autor, como `story-reply`. */
export async function reply_to_story(ctx: StoryCtx): Promise<unknown> {
	await stories_settings(ctx.store);
	const story = await visible_story(ctx);
	const author_id = str(story.author_id);
	if (author_id === actor_id(ctx)) throw invalid('No puedes responder tu propia historia.');
	if (typeof ctx.body.text !== 'string' || !ctx.body.text.trim()) throw invalid('Escribe la respuesta.');
	const preview = String(story.text ?? '') || String(story.caption ?? '');
	return create_chat_message({
		...ctx,
		body: { recipient_user_id: author_id, client_id: ctx.body.client_id, text: ctx.body.text },
		story_ref: defined({
			storyId: str(story._id),
			kind: str(story.kind),
			textPreview: preview.slice(0, 160) || undefined,
			expiresAt: str(story.expires_at),
		}),
	});
}
