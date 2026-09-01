/**
 * Portal CMS: configurable public landing (draft ≠ published until publish).
 * Persist is store-agnostic so bun tests drive the same functions as HTTP.
 */
import {
	apply_landing_code,
	default_home_document,
	sanitize_page_document_html,
	validate_page_descriptor,
	type NoxUiValidationIssue,
} from '@opus-perpetuus/imperium-core-kit';
import { fail } from './envelope.ts';
import type { ImperiumDoc } from './envelope.ts';

export type PortalPageRow = {
	slug: string;
	name: string;
	draft: Record<string, unknown>;
	published: Record<string, unknown> | null;
	published_at: string | null;
	published_by: string | null;
	is_active: boolean;
};

export type PortalPageStore = {
	get(slug: string): Promise<PortalPageRow | null>;
	put(row: PortalPageRow): Promise<void>;
};

export type PortalHtmlSanitize = (html: string) => string;

export type PortalRequestCtx = {
	store: PortalPageStore;
	sanitize: PortalHtmlSanitize;
	actor: ImperiumDoc | null;
};

const HOME_SLUG = 'home';

export function create_memory_portal_store(): PortalPageStore {
	const rows = new Map<string, PortalPageRow>();
	return {
		async get(slug) {
			const row = rows.get(slug);
			return row ? structuredClone(row) : null;
		},
		async put(row) {
			rows.set(row.slug, structuredClone(row));
		},
	};
}

export function create_postgres_portal_store(sql: Bun.SQL): PortalPageStore {
	let ready: Promise<void> | null = null;
	const boot = () => {
		ready ??= sql
			.unsafe(
				`
      CREATE TABLE IF NOT EXISTS public.portal_pages (
        slug TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        draft JSONB NOT NULL,
        published JSONB,
        published_at TIMESTAMPTZ,
        published_by TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `,
			)
			.then(() => undefined);
		return ready;
	};
	return {
		async get(slug) {
			await boot();
			const rows = await sql.unsafe(
				`SELECT slug, name, draft, published, published_at, published_by, is_active
         FROM public.portal_pages WHERE slug = $1 LIMIT 1`,
				[slug],
			);
			const row = rows[0] as
				| {
						slug: string;
						name: string;
						draft: Record<string, unknown>;
						published: Record<string, unknown> | null;
						published_at: Date | string | null;
						published_by: string | null;
						is_active: boolean;
				  }
				| undefined;
			if (!row) return null;
			return {
				slug: row.slug,
				name: row.name,
				draft: as_object(row.draft),
				published: row.published == null ? null : as_object(row.published),
				published_at:
					row.published_at == null
						? null
						: typeof row.published_at === 'string'
							? row.published_at
							: row.published_at.toISOString(),
				published_by: row.published_by,
				is_active: row.is_active,
			};
		},
		async put(row) {
			await boot();
			await sql.unsafe(
				`INSERT INTO public.portal_pages
           (slug, name, draft, published, published_at, published_by, is_active, updated_at)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, now())
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           draft = EXCLUDED.draft,
           published = EXCLUDED.published,
           published_at = EXCLUDED.published_at,
           published_by = EXCLUDED.published_by,
           is_active = EXCLUDED.is_active,
           updated_at = now()`,
				[
					row.slug,
					row.name,
					JSON.stringify(row.draft),
					row.published == null ? null : JSON.stringify(row.published),
					row.published_at,
					row.published_by,
					row.is_active,
				],
			);
		},
	};
}

function as_object(value: unknown): Record<string, unknown> {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			/* fall through */
		}
		return {};
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function prepare_document(
	document: unknown,
	sanitize: PortalHtmlSanitize,
):
	| { ok: true; document: Record<string, unknown> }
	| { ok: false; issues: NoxUiValidationIssue[] } {
	if (typeof document === 'string') {
		const applied = apply_landing_code(document);
		if (!applied.ok) return applied;
		document = applied.document;
	}
	if (!document || typeof document !== 'object' || Array.isArray(document)) {
		return {
			ok: false,
			issues: [{ path: '$', message: 'Page descriptor must be an object' }],
		};
	}
	const sanitized = sanitize_page_document_html(
		document,
		sanitize,
	) as Record<string, unknown>;
	const check = validate_page_descriptor(sanitized);
	if (!check.ok) return { ok: false, issues: check.issues };
	return { ok: true, document: sanitized };
}

export async function ensure_home(
	store: PortalPageStore,
	sanitize: PortalHtmlSanitize,
): Promise<PortalPageRow> {
	const existing = await store.get(HOME_SLUG);
	if (existing) return existing;
	const prepared = prepare_document(default_home_document(), sanitize);
	const doc = prepared.ok ? prepared.document : default_home_document();
	const now = new Date().toISOString();
	const row: PortalPageRow = {
		slug: HOME_SLUG,
		name: String(doc['title'] ?? 'Inicio'),
		draft: doc,
		published: doc,
		published_at: now,
		published_by: 'seed',
		is_active: true,
	};
	await store.put(row);
	return row;
}

export async function get_published(
	store: PortalPageStore,
	slug: string,
): Promise<Record<string, unknown> | null> {
	const row = await store.get(slug);
	if (!row || !row.is_active || row.published == null) return null;
	return row.published;
}

export async function get_draft(
	store: PortalPageStore,
	slug: string,
): Promise<PortalPageRow | null> {
	return store.get(slug);
}

export async function put_draft(
	store: PortalPageStore,
	slug: string,
	document: unknown,
	sanitize: PortalHtmlSanitize,
): Promise<
	| { ok: true; draft: Record<string, unknown> }
	| { ok: false; issues: NoxUiValidationIssue[] }
> {
	await ensure_home(store, sanitize);
	const prepared = prepare_document(document, sanitize);
	if (!prepared.ok) return prepared;
	const existing = await store.get(slug);
	const row: PortalPageRow = {
		slug,
		name: String(prepared.document['title'] ?? slug),
		draft: prepared.document,
		published: existing?.published ?? null,
		published_at: existing?.published_at ?? null,
		published_by: existing?.published_by ?? null,
		is_active: existing?.is_active ?? true,
	};
	await store.put(row);
	return { ok: true, draft: prepared.document };
}

export async function publish_home(
	store: PortalPageStore,
	slug: string,
	actor_id: string | null,
	sanitize: PortalHtmlSanitize,
): Promise<
	| { ok: true; document: Record<string, unknown> }
	| { ok: false; issues: NoxUiValidationIssue[] }
> {
	await ensure_home(store, sanitize);
	const existing = await store.get(slug);
	if (!existing) {
		return {
			ok: false,
			issues: [{ path: '$', message: 'page_not_found' }],
		};
	}
	const prepared = prepare_document(existing.draft, sanitize);
	if (!prepared.ok) return prepared;
	const now = new Date().toISOString();
	await store.put({
		...existing,
		name: String(prepared.document['title'] ?? existing.name),
		draft: prepared.document,
		published: prepared.document,
		published_at: now,
		published_by: actor_id,
		is_active: true,
	});
	return { ok: true, document: prepared.document };
}

function actor_id(actor: ImperiumDoc | null): string | null {
	if (!actor) return null;
	const id = actor._id ?? actor.id;
	return id == null ? null : String(id);
}

function json_error(message: string, status: number, extra?: Record<string, unknown>) {
	const failed = fail(message, status, extra);
	return Response.json(failed.body, { status: failed.status });
}

/**
 * Published-home reads must not wait on Imperium seed/session boot.
 */
export function is_anonymous_portal_read(req: Request): boolean {
	const path = portal_route_path(new URL(req.url).pathname);
	if (!path?.startsWith('/p/portal')) return false;
	const method = req.method.toUpperCase();
	return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

/**
 * Map a request pathname to the portal route (strips `/api`).
 * Returns null when the path is not a portal URL.
 */
export function portal_route_path(pathname: string): string | null {
	let path = pathname;
	if (path === '/api') path = '/';
	else if (path.startsWith('/api/')) path = path.slice(4) || '/';
	if (
		path === '/p/portal' ||
		path.startsWith('/p/portal/') ||
		path === '/portal' ||
		path.startsWith('/portal/')
	) {
		return path;
	}
	return null;
}

/**
 * Public + admin portal HTTP. Reads `req.url` (including `/api` prefix).
 * Public GET `/api/p/portal/pages/:slug` needs no actor.
 */
export async function handle_portal_request(
	req: Request,
	ctx: PortalRequestCtx,
): Promise<Response | null> {
	const path = portal_route_path(new URL(req.url).pathname);
	if (!path) return null;
	const method = req.method.toUpperCase();
	if (method === 'OPTIONS') {
		return new Response(null, { status: 204 });
	}
	const public_page = path.match(/^\/p\/portal\/pages\/([^/]+)$/);
	if (public_page && (method === 'GET' || method === 'HEAD')) {
		await ensure_home(ctx.store, ctx.sanitize);
		const slug = decodeURIComponent(public_page[1]!);
		const published = await get_published(ctx.store, slug);
		if (!published) {
			return json_error('page_not_found', 404);
		}
		return Response.json(published);
	}

	const admin_page = path.match(/^\/portal\/pages\/([^/]+)(?:\/(draft|publish))?$/);
	if (!admin_page) return null;

	if (!ctx.actor) {
		return json_error('No estás autenticado', 401);
	}

	const slug = decodeURIComponent(admin_page[1]!);
	const action = admin_page[2] ?? '';
	await ensure_home(ctx.store, ctx.sanitize);

	if (method === 'GET' && !action) {
		const row = await get_draft(ctx.store, slug);
		if (!row) return json_error('page_not_found', 404);
		return Response.json({
			slug: row.slug,
			name: row.name,
			draft: row.draft,
			published: row.published,
			published_at: row.published_at,
			is_active: row.is_active,
		});
	}

	if (method === 'PUT' && action === 'draft') {
		let body: unknown = {};
		try {
			body = await req.json();
		} catch {
			return json_error('JSON inválido', 400);
		}
		const document =
			body &&
			typeof body === 'object' &&
			!Array.isArray(body) &&
			'document' in (body as Record<string, unknown>)
				? (body as Record<string, unknown>)['document']
				: body;
		const saved = await put_draft(ctx.store, slug, document, ctx.sanitize);
		if (!saved.ok) {
			return json_error('invalid_descriptor', 400, { issues: saved.issues });
		}
		return Response.json({ slug, draft: saved.draft });
	}

	if (method === 'POST' && action === 'publish') {
		const published = await publish_home(
			ctx.store,
			slug,
			actor_id(ctx.actor),
			ctx.sanitize,
		);
		if (!published.ok) {
			return json_error('invalid_descriptor', 400, { issues: published.issues });
		}
		return Response.json({
			slug,
			published: published.document,
		});
	}

	return json_error('not found', 404);
}
