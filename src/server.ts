/**
 * Imperium Core — host de apps (subjects), mismos principios que Kirel NOX:
 * Postgres compartido, el núcleo aplica DDL, gateway /api/m/<technicalId>,
 * data plane kit-mediado. Las apps no abren la base de dominio.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	pg_schema_name,
	type KirletSchemaBundle,
} from '@opus-perpetuus/imperium-core-kit';
import { handle_service_plane, service_plane_match } from './service-plane.ts';
import { add_cors, create_imperium_layer } from './imperium/router.ts';
import { current_user, ensure_session_table } from './imperium/auth.ts';
import { start_subject_auto_update } from './imperium/subject-auto-update.ts';
import {
	handle_socket_io,
	SOCKET_IO_IDLE_TIMEOUT_SECONDS,
} from './imperium/socket-stub.ts';
import {
	is_noisy_path,
	print_console_log,
} from './imperium/debug-request-log.ts';
import {
	apply_subject_schema_bundle,
	schema_bundle_mismatch,
} from './imperium/subject-schema.ts';
import { ColumnListCache } from './imperium/column-list-cache.ts';
import {
	is_column_name,
	qident,
	search_sql,
	where_sql,
} from './imperium/data-plane-where.ts';
import {
	subjects_access_denied,
	technical_id_is_installed,
} from './imperium/subjects-admin.ts';
import { portal_html_sanitize } from './imperium/portal-sanitize.ts';
import { remember_socket_ip } from './imperium/auth-rate-limit.ts';
import { get_published } from './imperium/portal.ts';
import {
	merge_subject_page,
	subject_override_slug,
} from './imperium/subject-page-override.ts';
import { is_stale_schema_cache } from './imperium/postgres-stale-plan.ts';
import {
	resolve_email_settings,
	send_subject_notification_email,
} from './imperium/email.ts';
import {
	resolve_subject_identity,
	subject_proxy_headers,
	subject_proxy_response,
	type SubjectIdentityRealm,
	type SubjectModuleRef,
} from './imperium/subject-identity.ts';
import {
	authorize_subject_plane,
	dev_attach_enabled,
	gateway_secret_warnings,
	is_master_request,
	is_subject_request,
	master_secret,
	subject_secret_mode,
} from './imperium/subject-secret.ts';
import {
	AppProxyRequestError,
	bytes_for_proxy,
	guard_app_proxy_body,
} from './imperium/app-proxy-body.ts';

const PORT = Number(process.env.PORT ?? 3100);
const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';
const CATALOG_PATH =
	process.env.CATALOG_PATH ?? join(import.meta.dir, '../../catalog.json');

type Catalog = {
	subjects: Array<{
		slug: string;
		name: string;
		technical_id: string;
		catalog_id: string;
		image: string;
		resource: string;
		table: string;
		collection: string;
		path: string;
		kind: string;
		menu_ref?: string;
		modules?: SubjectModuleRef[];
	}>;
};

const catalog_text = readFileSync(CATALOG_PATH, 'utf8');
const catalog: Catalog = JSON.parse(catalog_text);
/** Los tid que aceptan el plano de datos y el de servicios. */
const CATALOG_TIDS = new Set(catalog.subjects.map((s) => s.technical_id));
/**
 * Huella del catálogo con el que arrancó el proceso. El fichero es un bind
 * mount: un update puede reescribirlo sin recrear el contenedor, y entonces el
 * núcleo sigue sirviendo los pines viejos. Comparar este hash con el
 * `sha256sum` del fichero en disco delata ese desfase.
 */
const CATALOG_HASH = new Bun.CryptoHasher('sha256')
	.update(catalog_text)
	.digest('hex');

// Bun termina el proceso ante un rechazo o una excepción sin atender: un
// trabajo en segundo plano que falle no puede tumbar el núcleo entero.
const failure_text = (value: unknown) =>
	value instanceof Error ? (value.stack ?? value.message) : String(value);
process.on('unhandledRejection', (reason) => {
	print_console_log('error', `Promesa rechazada sin atender: ${failure_text(reason)}`);
});

const sql = new Bun.SQL(DATABASE_URL);
const imperium = create_imperium_layer(sql);
/** Overrides de desarrollo (`POST /api/subjects/dev-attach`). Gana a env/DNS. */
const subject_url_overrides = new Map<string, string>();

const subject_url = (technical_id: string) => {
	const slug = technical_id.replace(/^subject-/, '');
	const host = process.env.SUBJECT_HOST_PREFIX ?? 'subject-';
	const domain = process.env.SUBJECT_NETWORK_DOMAIN ?? '';
	if (subject_url_overrides.has(slug))
		return subject_url_overrides.get(slug)!;
	if (process.env[`SUBJECT_URL_${slug}`])
		return process.env[`SUBJECT_URL_${slug}`];
	if (domain)
		return `http://${host}${slug}:${process.env.SUBJECT_PORT ?? 3000}`;
	const port = 4000 + (Math.abs(hash(slug)) % 5000);
	return process.env.SUBJECT_DEV_BASE
		? `${process.env.SUBJECT_DEV_BASE.replace(/\/$/, '')}`
		: `http://127.0.0.1:${port}`;
};

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}

async function apply_bundle(bundle: KirletSchemaBundle): Promise<void> {
	await apply_subject_schema_bundle(sql, bundle);
	forget_columns(pg_schema_name(bundle.technicalId));
}

/**
 * Lista de columnas de una tabla, en caché.
 *
 * El plano de datos consultaba con `SELECT *`, y ahí está la raíz del fallo tras
 * un DDL: el tipo del resultado depende de las columnas, Postgres invalida el
 * plan preparado al añadir una y Bun guarda el statement por **texto** de la
 * consulta — así que reintentar el mismo `SELECT *` reusa el statement muerto y
 * falla igual, para siempre, hasta reiniciar el núcleo (medido: el reintento
 * corre y vuelve a fallar).
 *
 * Con la lista explícita, añadir una columna cambia el texto: se prepara un
 * statement nuevo y el viejo nunca se vuelve a usar.
 */
const column_cache = new ColumnListCache(30_000);

function forget_columns(schema: string): void {
	column_cache.forget_schema(schema);
}

async function select_list(schema: string, table: string): Promise<string> {
	const key = `${schema}.${table}`;
	let cols = column_cache.get(key);
	if (!cols) {
		const rows = await sql.unsafe(
			`SELECT column_name FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2
              ORDER BY ordinal_position`,
			[schema, table],
		);
		cols = rows
			.map((row) => String((row as { column_name: unknown }).column_name))
			.filter(is_column_name);
		// Tabla que aún no existe: `*` deja que Postgres dé el error de siempre
		// («relation does not exist»), que es el que la app sabe leer.
		if (cols.length === 0) return '*';
		column_cache.set(key, cols);
	}
	return cols.map(qident).join(', ');
}

async function data_plane(
	technical_id: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const schema = pg_schema_name(technical_id);
	const op = body.op as string;
	if (op === 'batch' && Array.isArray(body.ops)) {
		const out = [];
		for (const inner of body.ops as Record<string, unknown>[]) {
			out.push(await data_plane(technical_id, inner));
		}
		return out;
	}
	const table = String(body.table ?? '');
	if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error('invalid table');
	const qt = `${qident(schema)}.${qident(table)}`;

	if (op === 'findMany') {
		const opts = (body.opts ?? {}) as {
			where?: Record<string, unknown>;
			limit?: number;
			offset?: number;
			orderBy?: Record<string, string>;
			search?: { fields: string[]; q: string };
		};
		const w = where_sql(opts.where);
		const se = search_sql(opts.search, Boolean(w.sql), w.params.length + 1);
		const extra = se.sql;
		const params = [...w.params, ...se.params];
		const order = opts.orderBy
			? ' ORDER BY ' +
				Object.entries(opts.orderBy)
					.filter(([k]) => is_column_name(k))
					.map(
						([k, d]) =>
							`${qident(k)} ${d === 'desc' ? 'DESC' : 'ASC'}`,
					)
					.join(', ')
			: '';
		const limit = Number.isFinite(opts.limit)
			? ` LIMIT ${Number(opts.limit)}`
			: ' LIMIT 200';
		const offset = Number.isFinite(opts.offset)
			? ` OFFSET ${Number(opts.offset)}`
			: '';
		const rows = await sql.unsafe(
			`SELECT ${await select_list(schema, table)} FROM ${qt}${w.sql}${extra}${order}${limit}${offset}`,
			params,
		);
		return rows;
	}
	if (op === 'findOne') {
		const w = where_sql(body.where as Record<string, unknown>);
		const rows = await sql.unsafe(
			`SELECT ${await select_list(schema, table)} FROM ${qt}${w.sql} LIMIT 1`,
			w.params,
		);
		return rows[0] ?? null;
	}
	if (op === 'insert') {
		const row = (body.row ?? {}) as Record<string, unknown>;
		const keys = Object.keys(row).filter(is_column_name);
		const cols = keys.map(qident).join(', ');
		const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
		const rows = await sql.unsafe(
			`INSERT INTO ${qt} (${cols}) VALUES (${vals}) RETURNING ${await select_list(schema, table)}`,
			keys.map((k) => row[k]),
		);
		return rows[0];
	}
	if (op === 'update') {
		const patch = (body.patch ?? {}) as Record<string, unknown>;
		const keys = Object.keys(patch).filter(is_column_name);
		const set = keys.map((k, i) => `${qident(k)} = $${i + 1}`).join(', ');
		const w = where_sql(
			body.where as Record<string, unknown>,
			keys.length + 1,
		);
		const rows = await sql.unsafe(
			`UPDATE ${qt} SET ${set}${w.sql} RETURNING ${await select_list(schema, table)}`,
			[...keys.map((k) => patch[k]), ...w.params],
		);
		return rows[0] ?? null;
	}
	if (op === 'delete') {
		const w = where_sql(body.where as Record<string, unknown>);
		const rows = await sql.unsafe(
			`DELETE FROM ${qt}${w.sql} RETURNING id`,
			w.params,
		);
		return rows.length;
	}
	if (op === 'count') {
		const w = where_sql(body.where as Record<string, unknown>);
		const se = search_sql(
			body.search as { fields?: string[]; q?: string } | undefined,
			Boolean(w.sql),
			w.params.length + 1,
		);
		const rows = await sql.unsafe(
			`SELECT count(*)::int AS n FROM ${qt}${w.sql}${se.sql}`,
			[...w.params, ...se.params],
		);
		return rows[0]?.n ?? 0;
	}
	if (op === 'distinct') {
		const field = String(body.field ?? '');
		if (!is_column_name(field)) throw new Error('invalid field');
		const q = String(body.q ?? '').trim();
		const params: unknown[] = [];
		let extra = '';
		if (q) {
			params.push(`%${q}%`);
			extra = ` WHERE ${qident(field)}::text ILIKE $1`;
		}
		const rows = await sql.unsafe(
			`SELECT DISTINCT ${qident(field)} AS v FROM ${qt}${extra} LIMIT 200`,
			params,
		);
		return rows
			.map((row) => (row as { v: unknown }).v)
			.filter((value) => value != null && value !== '');
	}
	throw new Error(`unknown op ${op}`);
}

/**
 * Una sola reintentada cuando el DDL invalidó el plan preparado.
 *
 * `install-schemas` añade columnas y `SELECT *` cambia de tipo de resultado, así
 * que Postgres rechaza cada consulta posterior sobre esa tabla. La segunda
 * preparación ya ve las columnas nuevas. Reintentar aquí —y no vaciar la caché
 * al aplicar el DDL— es lo que cubre el caso real: el DDL puede venir de otra
 * réplica o de una migración a mano, y esas conexiones no son nuestras.
 */
async function data_plane_with_retry(
	technical_id: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	try {
		return await data_plane(technical_id, body);
	} catch (err) {
		if (!is_stale_schema_cache(err)) throw err;
		// El esquema cambió bajo los pies: soltar las columnas en caché hace que
		// el reintento arme otro texto de consulta y, con él, otro statement.
		forget_columns(pg_schema_name(technical_id));
		print_console_log(
			'warning',
			`data plane ${technical_id}: el esquema cambió, releyendo columnas`,
		);
		return await data_plane(technical_id, body);
	}
}

async function proxy_subject(
	technical_id: string,
	req: Request,
	rest: string,
	identity: Parameters<typeof subject_proxy_headers>[2],
): Promise<Response> {
	// Sin maestro no hay firma, y una app en `SUBJECT_AUTH=off` trataría la
	// petición sin firmar como su admin sintético.
	if (!master_secret()) {
		return Response.json(
			{
				error: 'El secreto de gateway del núcleo no está configurado',
				message: 'El secreto de gateway del núcleo no está configurado',
				code: 'gateway_secret_missing',
			},
			{ status: 503 },
		);
	}
	const base = subject_url(technical_id);
	const url = new URL(req.url);
	const target = `${base}${rest}${url.search}`;
	const headers = subject_proxy_headers(req.headers, technical_id, identity);
	const init: RequestInit = { method: req.method, headers };
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		try {
			const raw = await bytes_for_proxy(req);
			init.body = await guard_app_proxy_body(
				raw,
				headers.get('content-type'),
			);
		} catch (err) {
			if (err instanceof AppProxyRequestError) {
				return Response.json(
					{ error: err.message, message: err.message },
					{ status: err.status },
				);
			}
			throw err;
		}
		headers.delete('content-length');
	}
	try {
		return subject_proxy_response(
			await fetch(target, {
				...init,
				signal: AbortSignal.timeout(4000),
			}),
		);
	} catch (err) {
		return Response.json(
			{
				error: `subject unreachable: ${technical_id}`,
				detail: String(err),
			},
			{ status: 502 },
		);
	}
}

/**
 * Página pública de una app, vestida con la personalización publicada.
 *
 * El marco se guarda en el núcleo, así que la app no sabe que existe: sigue
 * sirviendo su página igual y aquí se le pone alrededor lo que se haya
 * configurado desde la GUI. Sin personalización la respuesta de la app pasa sin
 * tocarse —ni siquiera se lee su cuerpo—, que es el caso normal.
 *
 * Solo se viste el realm público: el lanzador interno enseña la página tal como
 * la sirve la app.
 */
async function dress_public_page(
	technical_id: string,
	req: Request,
	rest: string,
	res: Response,
): Promise<Response> {
	if (req.method !== 'GET') return res;
	const page = rest.match(/^\/pages\/([^/?]+)$/);
	if (!page || !res.ok) return res;
	if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
		return res;
	}
	let page_id: string;
	try {
		page_id = decodeURIComponent(page[1]!);
	} catch {
		return res;
	}
	let override: Record<string, unknown> | null = null;
	try {
		override = await get_published(
			imperium.portal_store,
			subject_override_slug(technical_id, page_id),
		);
	} catch {
		override = null;
	}
	if (!override) return res;
	// Sobre una copia: si el cuerpo no resulta ser el descriptor esperado hay
	// que poder devolver el original, y leerlo aquí ya lo habría consumido.
	try {
		const doc = (await res.clone().json()) as unknown;
		return Response.json(merge_subject_page(doc, override));
	} catch {
		// La personalización no puede ser motivo de que una página deje de verse.
		return res;
	}
}

/**
 * Clave de memoria de grants: la cookie de sesión, no el usuario.
 *
 * Dos pestañas del mismo usuario comparten entrada, y cerrar sesión invalida la
 * suya sin tocar la de nadie más.
 */
function session_key_of(req: Request): string {
	const cookie = req.headers.get('cookie') ?? '';
	const hit = cookie.match(/connect\.sid=([^;]+)/);
	return hit?.[1] ?? 'anon';
}

function subject_of(technical_id: string) {
	return catalog.subjects.find((s) => s.technical_id === technical_id);
}

/** Identidad firmada para un salto del gateway, o el 401 del realm interno. */
async function gateway_identity(
	technical_id: string,
	req: Request,
	realm: SubjectIdentityRealm,
): Promise<
	| { ok: true; identity: Awaited<ReturnType<typeof resolve_subject_identity>>['identity'] }
	| { ok: false; response: Response }
> {
	const sub = subject_of(technical_id);
	const resolved = await resolve_subject_identity({
		store: imperium.store,
		sql,
		req,
		technical_id,
		slug: sub?.slug ?? technical_id.replace(/^subject-/, ''),
		modules: sub?.modules ?? [],
		realm,
		session_key: session_key_of(req),
	});
	if (realm === 'internal' && !resolved.authenticated) {
		return {
			ok: false,
			response: Response.json(
				{
					error: 'No has iniciado sesión',
					message: 'No has iniciado sesión',
					code: 'unauthorized',
				},
				{ status: 401 },
			),
		};
	}
	return { ok: true, identity: resolved.identity };
}

function log_api(
	req: Request,
	path: string,
	status: number,
	started_ms: number,
) {
	if (is_noisy_path(path)) return;
	// persist_request_log ya imprime el tráfico /api de Imperium (CRUD, auth).
	if (
		path.startsWith('/api/') &&
		!path.includes('/kirlets/') &&
		!path.includes('/subjects/data') &&
		!path.startsWith('/api/m/')
	) {
		return;
	}
	const level =
		status >= 400 ? 'error' : status >= 300 ? 'warning' : 'success';
	print_console_log(
		level,
		`${req.method} ${path} ${status} ${Date.now() - started_ms}ms`,
	);
}

const server = Bun.serve({
	port: PORT,
	idleTimeout: SOCKET_IO_IDLE_TIMEOUT_SECONDS,
	async fetch(req, server) {
		// La IP del socket, que el cliente no elige: el limitador la prefiere
		// sobre `x-forwarded-for` salvo que el despliegue declare que hay un
		// proxy delante (ver `request_ip`).
		remember_socket_ip(req, server.requestIP(req)?.address ?? null);
		const started_ms = Date.now();
		const url = new URL(req.url);
		const path = url.pathname;
		const res = await (async () => {
			if (
				(req.method === 'GET' || req.method === 'HEAD') &&
				(path === '/' || path === '/app' || path === '/app/')
			) {
				const html = readFileSync(
					join(import.meta.dir, 'ui.html'),
					'utf8',
				);
				return new Response(html, {
					headers: { 'content-type': 'text/html; charset=utf-8' },
				});
			}

			const socket = handle_socket_io(req);
			if (socket) return socket;

			if (path === '/health' || path === '/api/health') {
				// Con CORS: el navegador lo usa como sonda de conectividad desde
				// el sitio publico, que corre en otro origen en desarrollo.
				return add_cors(
					req,
					Response.json({
						ok: true,
						unit: 'imperium-core',
						subjects: catalog.subjects.length,
						catalog_hash: CATALOG_HASH,
						imperium_resources: imperium.store.locs.size,
						// Solo el modo, nunca material secreto: dev-local elige
						// con él si la app recibe el maestro o su derivado.
						secret_mode: subject_secret_mode(),
					}),
				)!;
			}

			if (path === '/api/subjects/dev-attach' && req.method === 'POST') {
				// Repunta el tráfico de una app a cualquier URL: fuera de
				// desarrollo la ruta no existe.
				if (!dev_attach_enabled()) {
					return Response.json({ error: 'not found' }, { status: 404 });
				}
				if (!is_master_request(req)) {
					return Response.json(
						{ error: 'forbidden' },
						{ status: 403 },
					);
				}
				let body: { slug?: string; url?: string | null } = {};
				try {
					body = (await req.json()) as typeof body;
				} catch {
					return Response.json(
						{ error: 'invalid json' },
						{ status: 400 },
					);
				}
				const slug = String(body.slug ?? '')
					.replace(/^subject-/, '')
					.trim();
				if (!slug || !catalog.subjects.some((s) => s.slug === slug)) {
					return Response.json(
						{ error: `unknown subject ${slug}` },
						{ status: 404 },
					);
				}
				const url = body.url == null ? '' : String(body.url).trim();
				if (!url) {
					subject_url_overrides.delete(slug);
				} else {
					if (!/^https?:\/\/[^ \t\n]+$/i.test(url)) {
						return Response.json(
							{ error: 'url must be http(s)' },
							{ status: 400 },
						);
					}
					subject_url_overrides.set(slug, url.replace(/\/$/, ''));
				}
				return Response.json({
					data: {
						slug,
						url: subject_url(`subject-${slug}`),
						overridden: subject_url_overrides.has(slug),
					},
				});
			}
			let svc: ReturnType<typeof service_plane_match> = null;
			try {
				svc = service_plane_match(path);
			} catch {
				// Tid mal codificado (`decodeURIComponent` lanza): no es ninguna app.
				return Response.json({ error: 'unknown subject' }, { status: 404 });
			}
			if (svc) {
				if (!CATALOG_TIDS.has(svc.tid)) {
					return Response.json(
						{ error: `unknown subject ${svc.tid}` },
						{ status: 404 },
					);
				}
				return handle_service_plane(
					sql,
					is_subject_request,
					req,
					svc.tid,
					svc.rest,
					url,
					{
						sanitize_html: portal_html_sanitize,
						send_email: async (input) =>
							send_subject_notification_email({
								settings: await resolve_email_settings(
									imperium.store,
								),
								...input,
							}),
					},
				);
			}

			const data_m = path.match(
				/^\/api\/(?:subjects|kirlets)\/data\/([^/]+)$/,
			);
			if (data_m && req.method === 'POST') {
				let technical_id = '';
				try {
					technical_id = decodeURIComponent(data_m[1]!);
				} catch {
					/* mal codificado: fuera del catálogo, 404 */
				}
				const denied = authorize_subject_plane(
					req,
					technical_id,
					CATALOG_TIDS,
				);
				if (denied) return denied;
				let body: Record<string, unknown> = {};
				try {
					body = (await req.json()) as Record<string, unknown>;
					const data = await data_plane_with_retry(
						technical_id,
						body,
					);
					return Response.json({ data });
				} catch (err) {
					// La app solo ve el 400; sin esta línea el motivo (columna,
					// operador, SQL) no queda en ningún log del núcleo.
					print_console_log(
						'error',
						`data plane ${technical_id} ${String(body.op ?? '?')} ${String(body.table ?? '')}: ${String(err)}`,
					);
					return Response.json(
						{ error: String(err) },
						{ status: 400 },
					);
				}
			}

			const gw = path.match(
				/^\/api\/(p\/)?m\/(subject-[a-z0-9-]+)(\/.*)?$/,
			);
			if (gw) {
				const realm: SubjectIdentityRealm = gw[1] ? 'public' : 'internal';
				const technical_id = gw[2]!;
				const rest = gw[3] ?? '/';
				if (
					!(await technical_id_is_installed(
						imperium.store,
						sql,
						technical_id,
					))
				) {
					const sub = imperium.store.subjects.find(
						(item) => item.technical_id === technical_id,
					);
					const name = sub?.name ?? 'Esta app';
					return add_cors(
						req,
						Response.json(
							{
								error: `${name} no está instalada`,
								message: `${name} no está instalada`,
								code: 'subject_not_installed',
								details: {
									slug: sub?.slug,
									name: sub?.name,
									technical_id,
								},
							},
							{ status: 404 },
						),
					)!;
				}
				const gate = await gateway_identity(technical_id, req, realm);
				if (!gate.ok) return add_cors(req, gate.response)!;
				const proxied = await proxy_subject(
					technical_id,
					req,
					rest,
					gate.identity,
				);
				// Todo lo que sale del núcleo lleva CORS menos esto, que se
				// devolvía crudo. El escaparate público de una app
				// (`/api/p/m/<app>/…`) se consume desde otro origen —la APK se
				// sirve a sí misma desde `https://localhost`, y una tienda web
				// puede vivir en otro dominio—, así que sin cabeceras el
				// navegador tiraba la respuesta y el catálogo salía como
				// "Esta aplicación no está disponible".
				return add_cors(
					req,
					realm === 'public'
						? await dress_public_page(
								technical_id,
								req,
								rest,
								proxied,
							)
						: proxied,
				)!;
			}

			const install_one = path.match(
				/^\/api\/subjects\/install-schemas\/(subject-[a-z0-9-]+)$/,
			);
			if (
				req.method === 'POST' &&
				(path === '/api/subjects/install-schemas' || install_one)
			) {
				// Aplica DDL de cualquier app: el mismo candado que instalar
				// desde /subjects. El maestro para el arranque en frío (todavía
				// no hay usuario ni cookie) o la sesión del administrador.
				if (!is_master_request(req)) {
					// La tabla de sesión la crea la capa Imperium; aquí se
					// entra antes, así que hay que asegurarla o revienta en una
					// base virgen.
					await ensure_session_table(sql);
					const actor = await current_user(sql, req).catch(() => null);
					const denied = subjects_access_denied(req.method, actor, false);
					if (denied) return denied;
				}
				const only =
					install_one?.[1] ??
					url.searchParams.get('technical_id') ??
					'';
				const targets = only
					? catalog.subjects.filter((s) => s.technical_id === only)
					: catalog.subjects;
				if (only && targets.length === 0) {
					return Response.json(
						{ error: `unknown subject ${only}` },
						{ status: 404 },
					);
				}
				const results = [];
				for (const s of targets) {
					const base = subject_url(s.technical_id);
					try {
						const res = await fetch(`${base}/schema`);
						if (!res.ok) {
							results.push({
								id: s.technical_id,
								ok: false,
								status: res.status,
							});
							continue;
						}
						const bundle = (await res.json()) as KirletSchemaBundle;
						const mismatch = schema_bundle_mismatch(
							bundle,
							s.technical_id,
						);
						if (mismatch) {
							results.push({
								id: s.technical_id,
								ok: false,
								error: mismatch,
							});
							continue;
						}
						await apply_bundle(bundle);
						results.push({
							id: s.technical_id,
							ok: true,
							schema: pg_schema_name(s.technical_id),
						});
					} catch (err) {
						results.push({
							id: s.technical_id,
							ok: false,
							error: String(err),
						});
					}
				}
				return Response.json({ data: results });
			}

			const compat = await imperium.handle(req);
			if (compat) return compat;

			return Response.json({ error: 'not found' }, { status: 404 });
		})();
		log_api(req, path, res.status, started_ms);
		return res;
	},
});

console.log(`imperium-core listening on :${server.port}`);
// Después de escuchar: un fallo de arranque (puerto ocupado) debe seguir
// tumbando el proceso con código de error, no dejarlo vivo sin servir.
process.on('uncaughtException', (err) => {
	print_console_log('error', `Excepción sin atender: ${failure_text(err)}`);
});
for (const warning of gateway_secret_warnings()) {
	print_console_log('warning', warning);
}

// Reloj de actualización automática de apps. Apagado mientras el parámetro de
// sistema esté en NO, que es como nace. Solo corre en el proceso del núcleo:
// el operador arranca por `subject-operator.ts` y no pasa por aquí.
start_subject_auto_update(imperium.store, sql);
