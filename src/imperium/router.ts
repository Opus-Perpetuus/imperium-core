/**
 * Enruta el contrato HTTP original de Imperium sobre SQL.
 */
import extra from './extra-routes.json';
import {
	assert_http_access,
	current_user,
	ensure_session_table,
	handle_auth,
	is_auth_login_post,
	is_password_define_post,
	is_public_auth_get,
	is_public_extra_action,
} from './auth.ts';
import {
	can_enter_internal,
	PUBLIC_LANDING_ENABLED_REF,
} from '@opus-perpetuus/imperium-core-kit';
import { handle_crud } from './crud.ts';
import { handle_action } from './actions.ts';
import { handle_db_admin, is_db_admin_path } from './db-admin.ts';
import { handle_mcp_agent, seed_mcp_access } from './mcp-agent.ts';
import { ChatError, media_token_actor } from './chat-access.ts';
import { serve_media } from './media.ts';
import { recover_orphan_processing_uploads } from './uploads.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';
import { caught_http_error, fail } from './envelope.ts';
import { PinChallengeError } from './user-pin.ts';
import {
	bind_debug_store,
	debug_error,
	debug_info,
	persist_request_log,
	should_read_response_body,
} from './debug-request-log.ts';
import { run_with_history_context } from './history.ts';
import {
	assert_subject_resource_access,
	get_subject_details,
	list_catalog_subjects,
	list_subject_updates,
	backfill_installed_images,
	accept_subject_lifecycle,
	accept_subject_update,
	accept_subject_update_all,
	installed_technical_ids,
	seed_missing_install_rows,
	subject_lifecycle_body,
	technical_id_is_installed,
	subjects_access_denied,
	SubjectLifecycleError,
	SubjectNotInstalledError,
} from './subjects-admin.ts';
import { is_master_request } from './subject-secret.ts';
import {
	add_manual_entry,
	is_catalog_authorized,
	list_catalog_entries,
	remove_manual_entry,
	set_odoo_authorized,
	SubjectCatalogError,
} from './subject-catalog.ts';
import { is_base_subject_slug } from './subject-runtime.ts';
import {
	read_subject_auto_update_enabled,
	write_subject_auto_update_enabled,
} from './subject-auto-update.ts';
import { discover_subject_versions } from './subject-discovery.ts';
import {
	create_postgres_portal_store,
	handle_portal_request,
	is_anonymous_portal_read,
	portal_route_path,
} from './portal.ts';
import { portal_html_sanitize } from './portal-sanitize.ts';
import { share_binding_of } from './share-binding.ts';
import { handle_share_api, share_allows_media } from './shares.ts';

type ExtraRoute = {
	resource: string;
	method: string;
	path: string;
	action: string;
};

const EXTRAS = extra as ExtraRoute[];

/**
 * Cerrar sesión no pasa por el filtro de «solo personal»: un cliente del sitio
 * público recibía 403 y su sesión seguía viva en el servidor.
 */
export function is_auth_logout(req: Request): boolean {
	const path = new URL(req.url).pathname.replace(/^\/api(?=\/)/, '').replace(/\/$/, '');
	const method = req.method.toUpperCase();
	return (method === 'DELETE' && path === '/auth') || (method === 'POST' && path === '/auth/logout');
}

export function create_imperium_layer(sql: Bun.SQL) {
	const store = new ImperiumStore(sql, load_catalog_path());
	const portal_store = create_postgres_portal_store(sql);
	let ready: Promise<void> | null = null;
	const load_installed_subjects = async () => {
		try {
			store.set_installed_subjects(await installed_technical_ids(store, sql));
		} catch (err) {
			debug_error(err instanceof Error ? err.message : String(err));
		}
	};
	/**
	 * Preparación única del proceso. Toda petición autenticada espera aquí, así
	 * que deja rastro al empezar y al terminar: sin esas dos líneas, un arranque
	 * lento es indistinguible de un núcleo colgado —el puerto acepta, nadie
	 * contesta y el log no dice nada.
	 */
	const boot = () => {
		ready ??= (async () => {
			const started = Date.now();
			// El logger no escribe hasta tener el store enlazado.
			bind_debug_store(store);
			debug_info('imperium-core: preparando el arranque…');
			await ensure_session_table(sql);
			// Antes de ensure_defaults: la siembra de RH mira qué está instalado.
			await load_installed_subjects();
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
			try {
				await recover_orphan_processing_uploads(store);
			} catch (err) {
				debug_error(
					err instanceof Error ? err.message : String(err),
				);
			}
			// En una base recién creada la primera carga puede fallar
			// (module-management sin tabla); sin caché todo cuenta como instalado.
			await load_installed_subjects();
			debug_info(
				`imperium-core: arranque listo en ${Date.now() - started} ms`,
			);
		})().catch((err) => {
			ready = null;
			throw err;
		});
		return ready;
	};

	return {
		store,
		// El gateway de apps lo necesita para vestir sus páginas públicas con la
		// personalización que se haya publicado desde la GUI.
		portal_store,
		async handle(req: Request): Promise<Response | null> {
			const started_ms = Date.now();
			const url = new URL(req.url);
			const path = strip_api_prefix(url.pathname);
			if (is_anonymous_portal_read(req)) {
				const portal = await handle_portal_request(req, {
					store: portal_store,
					sanitize: portal_html_sanitize,
					actor: null,
					read_landing_enabled: () => read_landing_enabled_flag(store),
				});
				return portal ? add_cors(req, portal) : portal;
			}
			if (is_auth_login_post(req) || is_public_auth_get(req) || is_auth_logout(req)) {
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
			if (peek && !can_enter_internal(peek) && !is_password_define_post(req)) {
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
					read_landing_enabled: () => read_landing_enabled_flag(store),
				});
				if (portal) {
					const out = add_cors(req, portal);
					if (out) note_request(store, sql, req, out, started_ms);
					return out;
				}
			}
			const out = await dispatch(store, sql, req, url, path);
			if (out) note_request(store, sql, req, out, started_ms);
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
				const token_actor = media_token_actor(url.searchParams.get('mt'), decodeURIComponent(id));
				const actor = (await current_user(sql, req)) ?? token_actor;
				if (!actor) {
					return add_cors(
						req,
						Response.json(
							{ error: 'No estás autenticado', message: 'No estás autenticado' },
							{ status: 401 },
						),
					);
				}
				const shared = share_binding_of(req);
				if (shared) {
					const doc = store.has('attachment-management')
						? await store.find_id('attachment-management', decodeURIComponent(id))
						: null;
					if (!doc || !share_allows_media(shared, String(doc.related_model ?? ''))) {
						return add_cors(
							req,
							Response.json(
								{
									error: 'Esto no forma parte de la vista compartida.',
									message: 'Esto no forma parte de la vista compartida.',
									code: 'compartido_fuera_de_alcance',
								},
								{ status: 403 },
							),
						);
					}
				}
				return add_cors(
					req,
					await serve_media(store, decodeURIComponent(id), {
						req,
						actor,
						token_user_id: token_actor ? String(token_actor._id) : undefined,
					}),
				);
			}
			if (path === '/subjects' || path.startsWith('/subjects/')) {
				return add_cors(req, await handle_subjects(store, sql, req, path));
			}
			if (is_db_admin_path(path)) {
				return add_cors(
					req,
					await handle_db_admin(store, sql, req, url, path),
				);
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
					const mapped = caught_http_error(err);
					debug_error(err instanceof Error ? err.message : String(err));
					return add_cors(
						req,
						Response.json(
							{ ok: false, error: mapped.code ?? 'error', message: mapped.message },
							{ status: mapped.status },
						),
					);
				}
			}
			if (req.method === 'OPTIONS' && looks_imperium(path, store)) {
				return add_cors(req, new Response(null, { status: 204 }));
			}
			if (path === '/compartir' || path.startsWith('/compartir/')) {
				return add_cors(req, await handle_share_api(store, sql, req, url, path));
			}
			const hit = split_resource(path, store);
			if (!hit) return null;
			try {
				const actor = await current_user(sql, req);
				return await run_with_history_context(
					{
						actor,
						method: req.method,
						path,
						user_agent: req.headers.get('user-agent') ?? undefined,
					},
					async () => {
				const extra_hit = match_extra(hit.resource, req.method, hit.rest);
				if (!is_public_extra_action(hit.resource, extra_hit?.action)) {
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
				const mapped = caught_http_error(err);
				debug_error(err instanceof Error ? err.message : String(err));
				const extra: Record<string, unknown> = {};
				if (mapped.code) extra.code = mapped.code;
				if (mapped.field_errors) extra.field_errors = mapped.field_errors;
				if (err instanceof SubjectNotInstalledError && err.details) {
					extra.details = err.details;
				}
				if (err instanceof ChatError && err.details) extra.details = err.details;
				return add_cors(
					req,
					Response.json(fail(mapped.message, mapped.status, extra).body, { status: mapped.status }),
				);
			}
}

function with_dependencies(
	message: string,
	dependencies: ReadonlyArray<{ name: string }> | undefined,
): string {
	if (!dependencies?.length) return message;
	return `${message} (también: ${dependencies.map((d) => d.name).join(', ')})`;
}

async function handle_subjects(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	path: string,
): Promise<Response> {
	// Un solo candado para toda la rama. El listado publicaba el catálogo —y
	// ahora también qué versión corre cada app— a cualquiera que alcanzara el
	// puerto; era la única sub-ruta sin comprobación.
	const actor = await current_user(sql, req);
	const denied = subjects_access_denied(
		req.method,
		actor,
		is_master_request(req),
	);
	if (denied) return denied;
	if (req.method === 'GET' && (path === '/subjects' || path === '/subjects/')) {
		const data = await list_catalog_subjects(store, sql);
		return Response.json({ data, total_elementos: data.length, message: 'Apps' });
	}
	if (path === '/subjects/catalog' || path.startsWith('/subjects/catalog/')) {
		try {
			return await handle_subject_catalog(store, sql, req, path);
		} catch (err) {
			if (err instanceof SubjectCatalogError) {
				return Response.json(
					{ error: err.code, code: err.code, message: err.message },
					{ status: err.status },
				);
			}
			throw err;
		}
	}
	if (
		path === '/subjects/auto-update' ||
		path === '/subjects/auto-update/'
	) {
		if (req.method === 'GET') {
			return Response.json({
				enabled: await read_subject_auto_update_enabled(store),
			});
		}
		if (req.method === 'PUT' || req.method === 'POST') {
			const body = (await req.json().catch(() => ({}))) as {
				enabled?: unknown;
			};
			const result = await write_subject_auto_update_enabled(
				store,
				body.enabled === true,
			);
			if (!result.ok) {
				return Response.json(
					{
						error: 'no_configuration',
						message:
							'No se pudo guardar el ajuste: falta el parámetro de sistema',
					},
					{ status: 409 },
				);
			}
			return Response.json({ enabled: result.enabled });
		}
	}
	if (
		req.method === 'POST' &&
		(path === '/subjects/updates/refresh' ||
			path === '/subjects/updates/refresh/')
	) {
		// "Buscar actualizaciones": antes de comparar, se averigua qué corre
		// de verdad en las apps que se instalaron cuando aún no se anotaba, y
		// qué versiones nuevas hay en el registro aunque el catálogo no las pida.
		const filled = await backfill_installed_images(store, sql);
		const discovery = await discover_subject_versions(store, sql).catch(() => null);
		const data = await list_subject_updates(store, sql);
		return Response.json({
			data,
			total_elementos: data.length,
			filled: filled.filled,
			unknown: filled.unknown,
			discovered: discovery?.found ?? [],
			registry_errors: discovery?.errors ?? [],
			message: 'Actualizaciones disponibles',
		});
	}
	if (
		req.method === 'GET' &&
		(path === '/subjects/updates' || path === '/subjects/updates/')
	) {
		const data = await list_subject_updates(store, sql);
		return Response.json({
			data,
			total_elementos: data.length,
			message: 'Actualizaciones disponibles',
		});
	}
	if (
		req.method === 'POST' &&
		(path === '/subjects/updates/apply' ||
			path === '/subjects/updates/apply/')
	) {
		const result = await accept_subject_update_all(store, sql, actor);
		// Las saltadas (una dependencia desinstalándose, un grafo roto) se
		// nombran: sin esto, "todas saltadas" se leía como "no hay nada nuevo".
		const skipped = result.skipped.map((item) => item.message);
		const message = result.total
			? with_dependencies(
					`Actualizando ${result.total} apps en segundo plano`,
					result.dependencies,
				)
			: skipped.length
				? 'No se actualizó ninguna app'
				: 'No hay apps con versión nueva';
		return Response.json(
			{
				...result,
				message: [message, ...skipped].join('. '),
			},
			{ status: 202 },
		);
	}
	const upd = path.match(/^\/subjects\/(subject-[a-z0-9-]+)\/update\/?$/);
	if (upd && req.method === 'POST') {
		const technical_id = upd[1]!;
		try {
			const accepted = await accept_subject_update(
				store,
				sql,
				technical_id,
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
					data: accepted.rows,
					dependencies: accepted.dependencies,
					notification: accepted.notification,
					message: with_dependencies(
						'Actualización en segundo plano',
						accepted.dependencies,
					),
				},
				{ status: 202 },
			);
		} catch (err) {
			if (err instanceof SubjectLifecycleError) {
				return Response.json(subject_lifecycle_body(err), {
					status: err.status,
				});
			}
			throw err;
		}
	}
	const m = path.match(/^\/subjects\/(subject-[a-z0-9-]+)\/(install|uninstall)\/?$/);
	if (m && req.method === 'POST') {
		const technical_id = m[1]!;
		const installed = m[2] === 'install';
		if (installed && !is_master_request(req)) {
			const refused = await install_refused(store, sql, technical_id);
			if (refused) return refused;
		}
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
					data: accepted.rows,
					dependencies: accepted.dependencies,
					notification: accepted.notification,
					message: installed
						? with_dependencies(
								'Instalación en segundo plano',
								accepted.dependencies,
							)
						: 'Desinstalación en segundo plano',
				},
				{ status: 202 },
			);
		} catch (err) {
			if (err instanceof SubjectLifecycleError) {
				return Response.json(subject_lifecycle_body(err), {
					status: err.status,
				});
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

/**
 * Desde Módulos solo se instala lo que está en el catálogo del tenant. El
 * maestro (Odoo por el host) no pasa por aquí: `subjects-sync` autoriza antes
 * de instalar.
 */
async function install_refused(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_id: string,
): Promise<Response | null> {
	const sub = store.subjects.find((item) => item.technical_id === technical_id);
	const authorized = await is_catalog_authorized(sql, technical_id);
	if (!sub) {
		if (!authorized) return null;
		return Response.json(
			{
				error: 'subject_not_registered',
				code: 'subject_not_registered',
				message:
					'La app está en el catálogo, pero este servidor todavía no la tiene registrada para correrla',
			},
			{ status: 409 },
		);
	}
	if (
		authorized ||
		is_base_subject_slug(sub.slug) ||
		(await technical_id_is_installed(store, sql, technical_id))
	) {
		return null;
	}
	return Response.json(
		{
			error: 'subject_not_authorized',
			code: 'subject_not_authorized',
			message: `${sub.name} no está autorizada para este servidor: se autoriza desde Odoo o se agrega al catálogo`,
		},
		{ status: 403 },
	);
}

/**
 * `GET` lista las filas del catálogo; `POST` da de alta una app a mano y
 * `DELETE /<technical_id>` la quita (solo el superadministrador: lo exige el
 * candado de `/subjects`). `PUT /authorized` lo usa Odoo, solo con el maestro.
 */
async function handle_subject_catalog(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	path: string,
): Promise<Response> {
	const rest = path.replace(/^\/subjects\/catalog\/?/, '').replace(/\/$/, '');
	if (!rest && req.method === 'GET') {
		const data = await list_catalog_entries(sql);
		return Response.json({ data, total_elementos: data.length, message: 'Catálogo' });
	}
	if (!rest && req.method === 'POST') {
		const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		const entry = await add_manual_entry(store.subjects, sql, body);
		return Response.json(
			{ data: entry, message: `${entry.name} quedó en el catálogo` },
			{ status: 201 },
		);
	}
	if (rest === 'authorized' && (req.method === 'PUT' || req.method === 'POST')) {
		if (!is_master_request(req)) {
			return Response.json(
				{
					error: 'master_required',
					code: 'master_required',
					message: 'Las apps autorizadas las fija Odoo',
				},
				{ status: 403 },
			);
		}
		const body = (await req.json().catch(() => ({}))) as { slugs?: unknown };
		const result = await set_odoo_authorized(store.subjects, sql, body.slugs);
		return Response.json({ data: result, message: 'Apps autorizadas' });
	}
	const one = rest.match(/^(subject-[a-z0-9-]+)$/);
	if (one && req.method === 'DELETE') {
		const removed = await remove_manual_entry(sql, one[1]!);
		if (!removed) {
			return Response.json({ error: `unknown entry ${one[1]}` }, { status: 404 });
		}
		return Response.json({ data: { technical_id: one[1] }, message: 'Se quitó del catálogo' });
	}
	return Response.json({ error: 'not found' }, { status: 404 });
}

async function read_landing_enabled_flag(
	store: ImperiumStore,
): Promise<unknown> {
	try {
		if (!store.has('configuration')) return undefined;
		const doc = await store.find_where('configuration', {
			_ref: PUBLIC_LANDING_ENABLED_REF,
		});
		return doc?.value;
	} catch {
		return undefined;
	}
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
	if (p === '/compartir' || p.startsWith('/compartir/')) return true;
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

function note_request(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	res: Response,
	started_ms: number,
): void {
	if (req.method === 'OPTIONS') return;
	const snapshot = clone_for_request_log(res);
	void (async () => {
		const actor = await current_user(sql, req).catch(() => null);
		await persist_request_log(store, req, snapshot, actor, started_ms);
	})().catch(() => {});
}

/**
 * Un archivo servido no se lee: su texto acabaría en la bitácora, que se
 * difunde a todos los sockets, y clonarlo lo cargaría completo en memoria.
 */
export function clone_for_request_log(res: Response): Response {
	if (
		res.headers.has('content-disposition') ||
		!should_read_response_body(res.headers.get('content-type'))
	) {
		return new Response(null, { status: res.status, headers: res.headers });
	}
	return res.clone();
}

export function add_cors(req: Request, res: Response | null): Response | null {
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
