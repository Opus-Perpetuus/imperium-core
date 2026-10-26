/**
 * Apagado por defecto. El esquema se crea igual: encender el interruptor no
 * depende de una migración aparte. Sin el flag, las rutas responden 404.
 */
import { build_access, current_user } from './auth.ts';
import { etag_matches, user_bootstrap, type LeafAccess } from './app-registry-bootstrap.ts';
import { install_registry_app, page_registry_catalog, version_view, type CatalogApp } from './app-registry-catalog.ts';
import { debug_error } from './debug-request-log.ts';
import type { ImperiumDoc } from './envelope.ts';
import { is_seed_admin } from './group-access.ts';
import type { ImperiumStore } from './store.ts';
import { coerce_flag, read_config_value } from './subject-versions.ts';
import { sql_app_registry, type AppRegistryRepository } from './app-registry-store.ts';
import {
	read_installed_image_manifest,
	sync_slug_manifest,
	type ManifestReader,
} from './app-registry-sync.ts';
import { run_subject_docker } from './subject-runtime.ts';

export const APP_REGISTRY_ENABLED_REF = 'configuration-app-registry-enabled';
export const REGISTRY_API_VERSION = 1;

export const REGISTRY_DEFERRED_ROUTES = ['PUT /api/registry/apps/:slug/version-policy'] as const;

const ENV_ON = new Set(['1', 'true', 'si', 'sí', 'yes', 'on']);

export type RegistrySql = {
	unsafe: (query: string, params?: unknown[]) => Promise<unknown>;
};

export const APP_REGISTRY_SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS public.app_registry (
      slug TEXT PRIMARY KEY,
      technical_id TEXT NOT NULL,
      repository JSONB,
      image_repo TEXT,
      policy TEXT,
      hold BOOLEAN NOT NULL DEFAULT FALSE,
      pin_tag TEXT,
      channel TEXT,
      update_window JSONB,
      installed_tag TEXT,
      installed_digest TEXT,
      discovered_tag TEXT,
      previous_tag TEXT,
      install_status TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT app_registry_slug_chk CHECK (slug ~ '^[a-z][a-z0-9-]*$'),
      CONSTRAINT app_registry_policy_chk CHECK (
        policy IS NULL OR policy = 'same-major-auto-patch'
      ),
      CONSTRAINT app_registry_channel_chk CHECK (
        channel IS NULL OR channel IN ('stable', 'canary')
      ),
      CONSTRAINT app_registry_install_status_chk CHECK (
        install_status IS NULL OR install_status IN ('ok', 'failed', 'upgrading')
      )
    )`,
	`CREATE TABLE IF NOT EXISTS public.app_manifest_snapshot (
      slug TEXT PRIMARY KEY,
      manifest_hash TEXT NOT NULL,
      manifest JSONB NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      image_digest TEXT,
      previous_manifest JSONB,
      CONSTRAINT app_manifest_snapshot_slug_chk CHECK (slug ~ '^[a-z][a-z0-9-]*$')
    )`,
	`CREATE TABLE IF NOT EXISTS public.app_registry_audit (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_user_id TEXT,
      action TEXT NOT NULL,
      slug TEXT,
      detail JSONB,
      CONSTRAINT app_registry_audit_action_chk CHECK (
        action IN ('install', 'sync', 'policy', 'reject')
      )
    )`,
	`CREATE INDEX IF NOT EXISTS app_registry_audit_slug_at_idx
      ON public.app_registry_audit (slug, at DESC)`,
] as const;

export async function ensure_app_registry_schema(sql: RegistrySql): Promise<void> {
	for (const statement of APP_REGISTRY_SCHEMA_STATEMENTS) {
		await sql.unsafe(statement);
	}
}

/**
 * `null` = no hay override y manda el parámetro de sistema.
 * Cualquier valor que no sea un sí explícito apaga: un typo no enciende el registro.
 */
export function app_registry_env_override(
	env: Record<string, string | undefined> = process.env,
): boolean | null {
	const raw = env.IMPERIUM_APP_REGISTRY;
	if (raw == null) return null;
	return ENV_ON.has(raw.trim().toLowerCase());
}

export async function read_app_registry_enabled(store: ImperiumStore): Promise<boolean> {
	const override = app_registry_env_override();
	if (override != null) return override;
	const value = await read_config_value(store, APP_REGISTRY_ENABLED_REF);
	return coerce_flag(value);
}

export function is_app_registry_path(path: string): boolean {
	return path === '/registry' || path.startsWith('/registry/');
}

export type RegistryDispatch = {
	sql: RegistrySql;
	enabled: boolean;
	user: ImperiumDoc | null;
	store?: ImperiumStore;
	access?: LeafAccess;
	repo?: AppRegistryRepository;
	read_manifest?: ManifestReader;
	catalog?: readonly CatalogApp[];
	run_install?: (input: {
		slug: string;
		image: string;
		registry_installed_tag: string | null;
	}) => Promise<{ ok: boolean; skipped: boolean; image: string | null; error?: string }>;
};

export async function handle_app_registry_http(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	path: string,
): Promise<Response> {
	const enabled = await read_app_registry_enabled(store);
	const user = enabled ? await current_user(sql, req).catch(() => null) : null;
	let access: LeafAccess | undefined;
	if (enabled && user) {
		if (is_seed_admin(user)) {
			access = { full: true, allow_read: () => true };
		} else {
			const built = await build_access(store, user).catch(() => null);
			const perms = (built?.permissions_by_model ?? {}) as Record<string, { allow_read?: boolean }>;
			access = {
				full: built?.has_full_access === true,
				allow_read: (model) => perms[model]?.allow_read === true,
			};
		}
	}
	return dispatch_app_registry(
		{
			sql,
			enabled,
			user,
			store,
			access,
			catalog: store.subjects.map((sub) => ({
				slug: sub.slug,
				name: sub.name,
				technical_id: sub.technical_id,
				image: sub.image,
			})),
			read_manifest: read_installed_image_manifest,
			run_install: async (input) => {
				const result = await run_subject_docker('install', input);
				return {
					ok: result.ok,
					skipped: result.skipped,
					image: result.image,
					error: result.error,
				};
			},
		},
		req,
		path,
	);
}

export async function dispatch_app_registry(
	deps: RegistryDispatch,
	req: Request,
	path: string,
): Promise<Response> {
	if (!deps.enabled) {
		return Response.json({ error: 'not found' }, { status: 404 });
	}
	if (req.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: registry_headers() });
	}
	if (!deps.user) {
		return registry_json(401, {
			registryApiVersion: REGISTRY_API_VERSION,
			error: 'unauthorized',
			message: 'No estás autenticado',
		});
	}

	const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	const method = req.method.toUpperCase();
	const user_bootstrap = parts.length === 2 && parts[1] === 'bootstrap';
	if (!is_seed_admin(deps.user) && !(user_bootstrap && (method === 'GET' || method === 'HEAD'))) {
		return registry_json(403, {
			registryApiVersion: REGISTRY_API_VERSION,
			error: 'forbidden',
			message: 'El registro de apps es solo para administradores.',
		});
	}

	if (parts.length === 1 && parts[0] === 'registry') {
		if (method !== 'GET' && method !== 'HEAD') return method_not_allowed();
		try {
			await ensure_app_registry_schema(deps.sql);
		} catch (err) {
			debug_error(err instanceof Error ? err.message : String(err));
			return registry_json(503, {
				registryApiVersion: REGISTRY_API_VERSION,
				error: 'registry_schema_unavailable',
				message: 'No se pudo preparar el esquema del registro.',
			});
		}
		return registry_json(200, {
			registryApiVersion: REGISTRY_API_VERSION,
			enabled: true,
			schemaReady: true,
			tables: ['app_registry', 'app_manifest_snapshot', 'app_registry_audit'],
			userBootstrap: 'ready',
			envWrite: false,
			deferred: [...REGISTRY_DEFERRED_ROUTES],
		});
	}

	const route = match_registry_route(parts, method);
	if (route === 'invalid-slug') {
		return registry_json(404, {
			registryApiVersion: REGISTRY_API_VERSION,
			error: 'not_found',
			message: 'App desconocida',
		});
	}
	if (route === 'method') return method_not_allowed();
	if (route === 'version-policy') return not_implemented();
	if (!route) {
		return registry_json(404, {
			registryApiVersion: REGISTRY_API_VERSION,
			error: 'not_found',
			message: 'Ruta desconocida',
		});
	}
	const repo = deps.repo ?? sql_app_registry(deps.sql);
	const actor = String(deps.user._ref ?? deps.user._id ?? '') || null;
	try {
		if (route.kind === 'user-bootstrap') return await respond_user_bootstrap(deps, repo, req);
		if (route.kind === 'debug-bootstrap') return await respond_debug_bootstrap(repo, route.slug);
		if (route.kind === 'sync') {
			const outcome = await sync_slug_manifest(
				repo,
				route.slug,
				deps.read_manifest ?? read_installed_image_manifest,
				actor,
			);
			return registry_json(outcome.status, {
				registryApiVersion: REGISTRY_API_VERSION,
				...outcome.body,
			});
		}
		if (route.kind === 'apps') return await respond_apps(deps, repo, req);
		if (route.kind === 'versions') return await respond_versions(deps, repo, route.slug);
		return await respond_install(deps, repo, req, route.slug, actor);
	} catch (err) {
		debug_error(err instanceof Error ? err.message : String(err));
		return registry_json(503, {
			registryApiVersion: REGISTRY_API_VERSION,
			error: 'registry_unavailable',
			message: 'El registro no está disponible.',
		});
	}
}

const SLUG = /^[a-z][a-z0-9-]*$/;

type RegistryRoute =
	| { kind: 'user-bootstrap' }
	| { kind: 'apps' }
	| { kind: 'debug-bootstrap'; slug: string }
	| { kind: 'sync'; slug: string }
	| { kind: 'install'; slug: string }
	| { kind: 'versions'; slug: string }
	| 'version-policy'
	| 'method'
	| 'invalid-slug'
	| null;

function match_registry_route(parts: string[], method: string): RegistryRoute {
	if (parts[0] !== 'registry') return null;
	if (parts.length === 2 && parts[1] === 'bootstrap') {
		return method === 'GET' || method === 'HEAD' ? { kind: 'user-bootstrap' } : 'method';
	}
	if (parts.length === 2 && parts[1] === 'apps') {
		return method === 'GET' || method === 'HEAD' ? { kind: 'apps' } : 'method';
	}
	if (parts.length !== 4 || parts[1] !== 'apps') return null;
	let slug = parts[2] ?? '';
	try {
		slug = decodeURIComponent(slug);
	} catch {
		return 'invalid-slug';
	}
	if (!SLUG.test(slug)) return 'invalid-slug';
	const action = parts[3];
	if (action === 'bootstrap') return method === 'GET' || method === 'HEAD' ? { kind: 'debug-bootstrap', slug } : 'method';
	if (action === 'sync-manifest') return method === 'POST' ? { kind: 'sync', slug } : 'method';
	if (action === 'install') return method === 'POST' ? { kind: 'install', slug } : 'method';
	if (action === 'versions') return method === 'GET' || method === 'HEAD' ? { kind: 'versions', slug } : 'method';
	if (action === 'version-policy') return method === 'PUT' ? 'version-policy' : 'method';
	return null;
}

function not_implemented(): Response {
	return registry_json(501, {
		registryApiVersion: REGISTRY_API_VERSION,
		error: 'not_implemented',
		message: 'La política de versiones no escribe el entorno.',
		availableIn: 'M4',
		envWrite: false,
	});
}

function locale_chain(req: Request, user: ImperiumDoc | null): string[] {
	const pref = String(user?.language ?? user?.locale ?? '').trim();
	const accept = req.headers.get('accept-language') ?? '';
	const from_header = accept
		.split(',')
		.map((part) => part.split(';')[0]?.trim() ?? '')
		.filter(Boolean);
	return [...(pref ? [pref] : []), ...from_header];
}

function catalog_of(deps: RegistryDispatch): CatalogApp[] {
	if (deps.catalog) return [...deps.catalog];
	return (deps.store?.subjects ?? []).map((sub) => ({
		slug: sub.slug,
		name: sub.name,
		technical_id: sub.technical_id,
		image: sub.image,
	}));
}

async function respond_user_bootstrap(
	deps: RegistryDispatch,
	repo: AppRegistryRepository,
	req: Request,
): Promise<Response> {
	const snapshots = await repo.list_snapshots();
	const access = deps.access ?? {
		full: deps.user ? is_seed_admin(deps.user) : false,
		allow_read: () => false,
	};
	const built = user_bootstrap(snapshots, access, locale_chain(req, deps.user));
	if (etag_matches(req.headers.get('if-none-match'), built.etag)) {
		return registry_json(304, null, { ETag: built.etag, 'Cache-Control': 'private' });
	}
	return registry_json(
		200,
		{
			registryApiVersion: REGISTRY_API_VERSION,
			etag: built.etag,
			leaves: built.leaves,
			menu: built.menu,
		},
		{ ETag: built.etag, 'Cache-Control': 'private' },
	);
}

async function respond_debug_bootstrap(repo: AppRegistryRepository, slug: string): Promise<Response> {
	const row = await repo.get_snapshot(slug);
	if (!row) {
		return registry_json(404, {
			registryApiVersion: REGISTRY_API_VERSION,
			error: 'not_found',
			message: 'App desconocida',
		});
	}
	const built = user_bootstrap([row], { full: true, allow_read: () => true }, ['es']);
	return registry_json(200, {
		registryApiVersion: REGISTRY_API_VERSION,
		slug,
		manifest_hash: row.manifest_hash,
		leaves: built.leaves,
	});
}

async function respond_apps(
	deps: RegistryDispatch,
	repo: AppRegistryRepository,
	req: Request,
): Promise<Response> {
	const url = new URL(req.url);
	const installed_raw = url.searchParams.get('installed');
	const limit_raw = Number(url.searchParams.get('limit') ?? '');
	const page = page_registry_catalog({
		subjects: catalog_of(deps),
		registry: await repo.list_registry(),
		q: url.searchParams.get('q') ?? '',
		installed: installed_raw == null ? null : installed_raw === '1' || installed_raw === 'true',
		cursor: url.searchParams.get('cursor') ?? '',
		limit: Number.isFinite(limit_raw) && limit_raw > 0 ? limit_raw : undefined,
	});
	return registry_json(200, {
		registryApiVersion: REGISTRY_API_VERSION,
		items: page.items,
		next_cursor: page.next_cursor,
		envWrite: false,
	});
}

async function respond_versions(
	deps: RegistryDispatch,
	repo: AppRegistryRepository,
	slug: string,
): Promise<Response> {
	const app = catalog_of(deps).find((item) => item.slug === slug) ?? null;
	const row = await repo.get_registry(slug);
	if (!app && !row) {
		return registry_json(404, {
			registryApiVersion: REGISTRY_API_VERSION,
			error: 'not_found',
			message: 'App desconocida',
		});
	}
	return registry_json(200, {
		registryApiVersion: REGISTRY_API_VERSION,
		...version_view(app, row),
	});
}

async function respond_install(
	deps: RegistryDispatch,
	repo: AppRegistryRepository,
	req: Request,
	slug: string,
	actor: string | null,
): Promise<Response> {
	let tag: string | null = null;
	let digest: string | null = null;
	try {
		const body = (await req.json()) as { tag?: string; digest?: string };
		tag = body.tag ?? null;
		digest = body.digest ?? null;
	} catch {
		tag = null;
	}
	const app = catalog_of(deps).find((item) => item.slug === slug) ?? null;
	const outcome = await install_registry_app({
		repo,
		slug,
		app,
		tag,
		digest,
		actor,
		read: deps.read_manifest ?? read_installed_image_manifest,
		run:
			deps.run_install ??
			(async (input) => {
				const result = await run_subject_docker('install', input);
				return {
					ok: result.ok,
					skipped: result.skipped,
					image: result.image,
					error: result.error,
				};
			}),
	});
	return registry_json(outcome.status, {
		registryApiVersion: REGISTRY_API_VERSION,
		...outcome.body,
	});
}

function method_not_allowed(): Response {
	return registry_json(405, {
		registryApiVersion: REGISTRY_API_VERSION,
		error: 'method_not_allowed',
		message: 'Método no permitido',
	});
}

function registry_headers(): Headers {
	const headers = new Headers();
	headers.set('X-Imperium-Registry-Api', String(REGISTRY_API_VERSION));
	return headers;
}

function registry_json(
	status: number,
	body: Record<string, unknown> | null,
	extra?: Record<string, string>,
): Response {
	const headers = registry_headers();
	headers.set('content-type', 'application/json; charset=utf-8');
	for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value);
	return new Response(status === 304 || status === 204 || body == null ? null : JSON.stringify(body), {
		status,
		headers,
	});
}
