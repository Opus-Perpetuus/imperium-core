/**
 * Enruta el contrato HTTP original de Imperium sobre SQL.
 */
import { timingSafeEqual } from 'node:crypto';
import extra from './extra-routes.json';
import {
	assert_http_access,
	current_user,
	ensure_session_table,
	handle_auth,
	is_auth_login_post,
	is_public_auth_get,
	is_public_extra_action,
} from './auth.ts';
import { can_enter_internal } from '@opus-perpetuus/imperium-core-kit';
import { handle_crud } from './crud.ts';
import { handle_action } from './actions.ts';
import { handle_mcp_agent, seed_mcp_access } from './mcp-agent.ts';
import { serve_media } from './media.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';
import { fail, humanize_caught_error } from './envelope.ts';
import { PinChallengeError } from './user-pin.ts';
import { bind_debug_store, debug_error, persist_request_log } from './debug-request-log.ts';
import { run_with_history_context } from './history.ts';
import {
	assert_subject_resource_access,
	get_subject_details,
	list_catalog_subjects,
	accept_subject_lifecycle,
	seed_missing_install_rows,
	SubjectLifecycleError,
	SubjectNotInstalledError,
} from './subjects-admin.ts';
import {
	create_postgres_portal_store,
	handle_portal_request,
	is_anonymous_portal_read,
	portal_route_path,
} from './portal.ts';
import { portal_html_sanitize } from './portal-sanitize.ts';

type ExtraRoute = {
	resource: string;
	method: string;
	path: string;
	action: string;
};

const EXTRAS = extra as ExtraRoute[];

export function create_imperium_layer(sql: Bun.SQL) {
	const store = new ImperiumStore(sql, load_catalog_path());
	const portal_store = create_postgres_portal_store(sql);
	let ready: Promise<void> | null = null;
	const boot = () => {
		ready ??= (async () => {
			bind_debug_store(store);
			await ensure_session_table(sql);
			try {
				await store.ensure_defaults();
			} catch (err) {
				debug_error(
					err instanceof Error ? err.message : String(err),
				);
			}
			try {
				await seed_mcp_access(store);
			} catch (err) {
				debug_error(
					err instanceof Error ? err.message : String(err),
				);
			}
			try {
				await seed_missing_install_rows(store, sql);
			} catch (err) {
				debug_error(
					err instanceof Error ? err.message : String(err),
				);
			}
		})().catch((err) => {
			ready = null;
			throw err;
		});
		return ready;
	};

	return {
		store,
		async handle(req: Request): Promise<Response | null> {
			const started_ms = Date.now();
			const url = new URL(req.url);
			const path = strip_api_prefix(url.pathname);
			if (is_anonymous_portal_read(req)) {
				const portal = await handle_portal_request(req, {
					store: portal_store,
					sanitize: portal_html_sanitize,
					actor: null,
				});
				return portal ? add_cors(req, portal) : portal;
			}
			if (is_auth_login_post(req) || is_public_auth_get(req)) {
				await ensure_session_table(sql);
				const auth_url = new URL(req.url);
				auth_url.pathname = strip_api_prefix(auth_url.pathname);
				return add_cors(
					req,
					await handle_auth(store, sql, req, auth_url),
				);
			}
			await ensure_session_table(sql);
			const peek = await current_user(sql, req).catch(() => null);
			if (peek && !can_enter_internal(peek)) {
				return add_cors(
					req,
					Response.json(
						{
							message: 'Solo usuarios internos',
							error: 'Solo usuarios internos',
						},
						{ status: 403 },
					),
				);
			}
			await boot();
			if (portal_route_path(url.pathname)) {
				const actor = await current_user(sql, req);
				const portal = await handle_portal_request(req, {
					store: portal_store,
					sanitize: portal_html_sanitize,
					actor,
				});
				if (portal) {
					const out = add_cors(req, portal);
					if (out && req.method !== 'OPTIONS') {
						await persist_request_log(store, req, out.clone(), actor, started_ms);
					}
					return out;
				}
			}
			const out = await dispatch(store, sql, req, url, path);
			if (out && req.method !== 'OPTIONS') {
				const actor = await current_user(sql, req).catch(() => null);
				await persist_request_log(store, req, out.clone(), actor, started_ms);
			}
			return out;
		},
	};
}

async function dispatch(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
	path: string,
): Promise<Response | null> {
			if (path === '/media' || path.startsWith('/media/')) {
				const id = path.slice('/media/'.length).split('/')[0] ?? '';
				const actor = await current_user(sql, req);
				if (!actor) {
					return add_cors(
						req,
						Response.json(
							{ error: 'No estás autenticado', message: 'No estás autenticado' },
							{ status: 401 },
						),
					);
				}
				return add_cors(req, await serve_media(store, decodeURIComponent(id)));
			}
			if (path === '/subjects' || path.startsWith('/subjects/')) {
				return add_cors(req, await handle_subjects(store, sql, req, path));
			}
			if (path === '/auth' || path.startsWith('/auth/')) {
				const auth_url = new URL(req.url);
				auth_url.pathname = path;
				return add_cors(req, await handle_auth(store, sql, req, auth_url));
			}
			if (path === '/mcp-agent' || path.startsWith('/mcp-agent/')) {
				const mcp_url = new URL(req.url);
				mcp_url.pathname = path;
				try {
					return add_cors(req, await handle_mcp_agent(store, sql, req, mcp_url));
				} catch (err) {
					const e = err as Error & { status?: number; code?: string };
					debug_error(e.message ?? String(err));
					return add_cors(
						req,
						Response.json(
							{ ok: false, error: e.code ?? 'error', message: e.message },
							{ status: e.status ?? 400 },
						),
					);
				}
			}
			if (req.method === 'OPTIONS' && looks_imperium(path, store)) {
				return add_cors(req, new Response(null, { status: 204 }));
			}
			const hit = split_resource(path, store);
			if (!hit) return null;
			const actor = await current_user(sql, req);
			try {
				return await run_with_history_context(
					{
						actor,
						method: req.method,
						path,
						user_agent: req.headers.get('user-agent') ?? undefined,
					},
					async () => {
				const extra_hit = match_extra(hit.resource, req.method, hit.rest);
				if (!is_public_extra_action(extra_hit?.action)) {
					await assert_http_access(store, actor, hit.resource, req.method, {
						extra: Boolean(extra_hit),
						action: extra_hit?.action,
						rest: hit.rest,
					});
					await assert_subject_resource_access(store, sql, hit.resource);
				}
				if (extra_hit) {
					const res = await handle_action(
						store,
						sql,
						req,
						url,
						hit.resource,
						extra_hit.action,
						extra_hit.params,
						actor,
					);
					return add_cors(req, res);
				}
				const crud = await handle_crud(store, req, url, hit.resource, hit.rest, actor);
				if (crud) return add_cors(req, crud);
				return add_cors(
					req,
					Response.json(fail('not found', 404).body, { status: 404 }),
				);
					},
				);
			} catch (err) {
				if (err instanceof PinChallengeError) {
					return add_cors(
						req,
						Response.json(
							{
								message: err.message,
								error: err.message,
								code: err.code,
								details: { user_pin_challenge: err.challenge },
								user_pin_challenge: err.challenge,
							},
							{ status: 400 },
						),
					);
				}
				const e = err as Error & { status?: number; code?: string };
				const humanized = humanize_caught_error(err);
				const message = humanized.message;
				const status = e.status ?? 400;
				debug_error(message);
				const extra: Record<string, unknown> = {};
				if (humanized.code) extra.code = humanized.code;
				if (humanized.field_errors) extra.field_errors = humanized.field_errors;
				if (err instanceof SubjectNotInstalledError && err.details) {
					extra.details = err.details;
				}
				return add_cors(
					req,
					Response.json(fail(message, status, extra).body, { status }),
				);
			}
}

function subject_gateway_ok(req: Request): boolean {
	const expected = process.env.CORE_SUBJECT_GATEWAY_SECRET ?? '';
	if (!expected) return false;
	const got = req.headers.get('x-core-subject-gateway-secret') ?? '';
	const a = Buffer.from(got);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

async function handle_subjects(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	path: string,
): Promise<Response> {
	if (req.method === 'GET' && (path === '/subjects' || path === '/subjects/')) {
		const data = await list_catalog_subjects(store, sql);
		return Response.json({ data, total_elementos: data.length, message: 'Apps' });
	}
	const m = path.match(/^\/subjects\/(subject-[a-z0-9-]+)\/(install|uninstall)\/?$/);
	if (m && req.method === 'POST') {
		const actor = await current_user(sql, req);
		if (!actor && !subject_gateway_ok(req)) {
			return Response.json(
				{ error: 'No estás autenticado', message: 'No estás autenticado' },
				{ status: 401 },
			);
		}
		const technical_id = m[1]!;
		const installed = m[2] === 'install';
		try {
			const accepted = await accept_subject_lifecycle(
				store,
				sql,
				technical_id,
				installed,
				actor,
			);
			if (!accepted) {
				return Response.json(
					{ error: `unknown subject ${technical_id}` },
					{ status: 404 },
				);
			}
			return Response.json(
				{
					accepted: true,
					already_running: accepted.already_running,
					data: [accepted.row],
					notification: accepted.notification,
					message: installed
						? 'Instalación en segundo plano'
						: 'Desinstalación en segundo plano',
				},
				{ status: 202 },
			);
		} catch (err) {
			if (err instanceof SubjectLifecycleError) {
				return Response.json(
					{ error: err.code, message: err.message },
					{ status: err.status },
				);
			}
			throw err;
		}
	}
	const detail = path.match(/^\/subjects\/(subject-[a-z0-9-]+)\/?$/);
	if (detail && req.method === 'GET') {
		const row = await get_subject_details(store, sql, detail[1]!);
		if (!row) {
			return Response.json(
				{ error: `unknown subject ${detail[1]}` },
				{ status: 404 },
			);
		}
		return Response.json({ data: row, message: 'App' });
	}
	return Response.json({ error: 'not found' }, { status: 404 });
}

function strip_api_prefix(path: string): string {
	if (path === '/api') return '/';
	if (path.startsWith('/api/')) return path.slice(4) || '/';
	return path;
}

function looks_imperium(path: string, store: ImperiumStore): boolean {
	const p = strip_api_prefix(path);
	if (p === '/auth' || p.startsWith('/auth/')) return true;
	if (p === '/media' || p.startsWith('/media/')) return true;
	if (p === '/mcp-agent' || p.startsWith('/mcp-agent/')) return true;
	if (p === '/subjects' || p.startsWith('/subjects/')) return true;
	if (portal_route_path(path)) return true;
	return split_resource(p, store) != null;
}

function split_resource(
	path: string,
	store: ImperiumStore,
): { resource: string; rest: string } | null {
	const segs = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	if (!segs.length) return null;
	if (segs[0] === 'api') return null;
	const resource = segs[0]!;
	if (!store.has(resource)) return null;
	return { resource, rest: '/' + segs.slice(1).join('/') };
}

function match_extra(
	resource: string,
	method: string,
	rest: string,
): { action: string; params: Record<string, string> } | null {
	const path = rest === '/' ? '/' : rest.replace(/\/+$/, '') || '/';
	const candidates = EXTRAS.filter(
		(e) => e.resource === resource && e.method === method.toLowerCase(),
	).sort((a, b) => score(b.path) - score(a.path));
	for (const e of candidates) {
		const params = match_path(e.path, path);
		if (params) return { action: e.action, params };
	}
	return null;
}

function score(pattern: string): number {
	return pattern.split('/').filter((s) => s && !s.startsWith(':')).length * 10 + pattern.length;
}

function match_path(pattern: string, actual: string): Record<string, string> | null {
	const ps = pattern.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	const as_ = actual.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	if (ps.length !== as_.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < ps.length; i++) {
		if (ps[i]!.startsWith(':')) params[ps[i]!.slice(1)] = decodeURIComponent(as_[i]!);
		else if (ps[i] !== as_[i]) return null;
	}
	return params;
}

function add_cors(req: Request, res: Response | null): Response | null {
	if (!res) return null;
	const origin = req.headers.get('origin');
	if (!origin) return res;
	const headers = new Headers(res.headers);
	headers.set('access-control-allow-origin', origin);
	headers.set('access-control-allow-credentials', 'true');
	headers.set(
		'access-control-allow-headers',
		req.headers.get('access-control-request-headers') ??
			'content-type,authorization,x-user-pin-token',
	);
	headers.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS');
	return new Response(res.body, { status: res.status, headers });
}
