/**
 * Enruta el contrato HTTP original de Imperium sobre SQL.
 */
import extra from './extra-routes.json';
import { handle_auth, current_user, ensure_session_table } from './auth.ts';
import { handle_crud } from './crud.ts';
import { handle_action } from './actions.ts';
import { serve_media } from './media.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';
import { fail } from './envelope.ts';
import { PinChallengeError } from './user-pin.ts';

type ExtraRoute = {
	resource: string;
	method: string;
	path: string;
	action: string;
};

const EXTRAS = extra as ExtraRoute[];

export function create_imperium_layer(sql: Bun.SQL) {
	const store = new ImperiumStore(sql, load_catalog_path());
	let ready: Promise<void> | null = null;
	const boot = () => {
		ready ??= (async () => {
			await ensure_session_table(sql);
			await store.ensure_defaults();
		})();
		return ready;
	};

	return {
		store,
		async handle(req: Request): Promise<Response | null> {
			await boot();
			const url = new URL(req.url);
			const path = strip_api_prefix(url.pathname);
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
			if (path === '/auth' || path.startsWith('/auth/')) {
				const auth_url = new URL(req.url);
				auth_url.pathname = path;
				return add_cors(req, await handle_auth(store, sql, req, auth_url));
			}
			if (req.method === 'OPTIONS' && looks_imperium(path, store)) {
				return add_cors(req, new Response(null, { status: 204 }));
			}
			const hit = split_resource(path, store);
			if (!hit) return null;
			const actor = await current_user(sql, req);
			try {
				const extra_hit = match_extra(hit.resource, req.method, hit.rest);
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
				const message = err instanceof Error ? err.message : String(err);
				return add_cors(req, Response.json(fail(message).body, { status: 400 }));
			}
		},
	};
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
