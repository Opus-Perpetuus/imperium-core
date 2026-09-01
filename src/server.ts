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
import { create_imperium_layer } from './imperium/router.ts';
import {
	handle_socket_io,
	SOCKET_IO_IDLE_TIMEOUT_SECONDS,
} from './imperium/socket-stub.ts';
import {
	is_noisy_path,
	print_console_log,
} from './imperium/debug-request-log.ts';
import { apply_subject_schema_bundle } from './imperium/subject-schema.ts';
import { technical_id_is_installed } from './imperium/subjects-admin.ts';

const PORT = Number(process.env.PORT ?? 3100);
const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';
const GATEWAY_SECRET =
	process.env.CORE_SUBJECT_GATEWAY_SECRET ?? 'imperium-subject-dev-secret';
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
	}>;
};

const catalog: Catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
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
}

function qident(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad ident ${name}`);
	return `"${name.replace(/"/g, '""')}"`;
}

function where_sql(
	schema: string,
	table: string,
	where: Record<string, unknown> | undefined,
	start = 1,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [];
	const clauses: string[] = [];
	if (!where) return { sql: '', params };
	let i = start;
	for (const [k, v] of Object.entries(where)) {
		if (!/^[a-z_][a-z0-9_]*$/i.test(k)) continue;
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const o = v as Record<string, unknown>;
			if ('in' in o && Array.isArray(o.in)) {
				params.push(o.in);
				clauses.push(`${qident(k)} = ANY($${i++})`);
				continue;
			}
			if ('ne' in o) {
				params.push(o.ne);
				clauses.push(`${qident(k)} IS DISTINCT FROM $${i++}`);
				continue;
			}
			if ('isNull' in o) {
				clauses.push(`${qident(k)} IS NULL`);
				continue;
			}
		}
		params.push(v);
		clauses.push(`${qident(k)} = $${i++}`);
	}
	return {
		sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
		params,
	};
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
		const w = where_sql(schema, table, opts.where);
		let extra = '';
		const params = [...w.params];
		if (opts.search?.q && opts.search.fields?.length) {
			const likes = opts.search.fields
				.filter((f) => /^[a-z_][a-z0-9_]*$/i.test(f))
				.map((f) => {
					params.push(`%${opts.search!.q}%`);
					return `${qident(f)} ILIKE $${params.length}`;
				});
			if (likes.length)
				extra =
					(w.sql ? ' AND ' : ' WHERE ') + `(${likes.join(' OR ')})`;
		}
		const order = opts.orderBy
			? ' ORDER BY ' +
				Object.entries(opts.orderBy)
					.filter(([k]) => /^[a-z_][a-z0-9_]*$/i.test(k))
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
			`SELECT * FROM ${qt}${w.sql}${extra}${order}${limit}${offset}`,
			params,
		);
		return rows;
	}
	if (op === 'findOne') {
		const w = where_sql(
			schema,
			table,
			body.where as Record<string, unknown>,
		);
		const rows = await sql.unsafe(
			`SELECT * FROM ${qt}${w.sql} LIMIT 1`,
			w.params,
		);
		return rows[0] ?? null;
	}
	if (op === 'insert') {
		const row = (body.row ?? {}) as Record<string, unknown>;
		const keys = Object.keys(row).filter((k) =>
			/^[a-z_][a-z0-9_]*$/i.test(k),
		);
		const cols = keys.map(qident).join(', ');
		const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
		const rows = await sql.unsafe(
			`INSERT INTO ${qt} (${cols}) VALUES (${vals}) RETURNING *`,
			keys.map((k) => row[k]),
		);
		return rows[0];
	}
	if (op === 'update') {
		const patch = (body.patch ?? {}) as Record<string, unknown>;
		const keys = Object.keys(patch).filter((k) =>
			/^[a-z_][a-z0-9-]*$/i.test(k),
		);
		const set = keys.map((k, i) => `${qident(k)} = $${i + 1}`).join(', ');
		const w = where_sql(
			schema,
			table,
			body.where as Record<string, unknown>,
			keys.length + 1,
		);
		const rows = await sql.unsafe(
			`UPDATE ${qt} SET ${set}${w.sql} RETURNING *`,
			[...keys.map((k) => patch[k]), ...w.params],
		);
		return rows[0] ?? null;
	}
	if (op === 'delete') {
		const w = where_sql(
			schema,
			table,
			body.where as Record<string, unknown>,
		);
		const rows = await sql.unsafe(
			`DELETE FROM ${qt}${w.sql} RETURNING id`,
			w.params,
		);
		return rows.length;
	}
	if (op === 'count') {
		const w = where_sql(
			schema,
			table,
			body.where as Record<string, unknown>,
		);
		const rows = await sql.unsafe(
			`SELECT count(*)::int AS n FROM ${qt}${w.sql}`,
			w.params,
		);
		return rows[0]?.n ?? 0;
	}
	if (op === 'distinct') {
		const field = String(body.field ?? '');
		if (!/^[a-z_][a-z0-9_]*$/i.test(field)) throw new Error('invalid field');
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

async function proxy_subject(
	technical_id: string,
	req: Request,
	rest: string,
): Promise<Response> {
	const base = subject_url(technical_id);
	const url = new URL(req.url);
	const target = `${base}${rest}${url.search}`;
	const headers = new Headers(req.headers);
	headers.set('x-nox-kirlet-gateway-secret', GATEWAY_SECRET);
	headers.set('x-nox-kirlet-id', technical_id);
	headers.set('x-core-subject-gateway-secret', GATEWAY_SECRET);
	const init: RequestInit = { method: req.method, headers };
	if (req.method !== 'GET' && req.method !== 'HEAD')
		init.body = await req.arrayBuffer();
	try {
		return await fetch(target, {
			...init,
			signal: AbortSignal.timeout(4000),
		});
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
	async fetch(req) {
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
				return Response.json({
					ok: true,
					unit: 'imperium-core',
					subjects: catalog.subjects.length,
					imperium_resources: imperium.store.locs.size,
				});
			}

			if (path === '/api/subjects/dev-attach' && req.method === 'POST') {
				const secret =
					req.headers.get('x-core-subject-gateway-secret') ??
					req.headers.get('x-nox-kirlet-gateway-secret') ??
					'';
				if (secret !== GATEWAY_SECRET) {
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
			const svc = service_plane_match(path);
			if (svc) {
				return handle_service_plane(
					sql,
					GATEWAY_SECRET,
					req,
					svc.tid,
					svc.rest,
					url,
				);
			}

			const data_m = path.match(
				/^\/api\/(?:subjects|kirlets)\/data\/([^/]+)$/,
			);
			if (data_m && req.method === 'POST') {
				const secret =
					req.headers.get('x-core-subject-gateway-secret') ??
					req.headers.get('x-nox-kirlet-gateway-secret') ??
					'';
				if (secret !== GATEWAY_SECRET) {
					return Response.json(
						{ error: 'forbidden' },
						{ status: 403 },
					);
				}
				const technical_id = decodeURIComponent(data_m[1]!);
				try {
					const body = (await req.json()) as Record<string, unknown>;
					const data = await data_plane(technical_id, body);
					return Response.json({ data });
				} catch (err) {
					return Response.json(
						{ error: String(err) },
						{ status: 400 },
					);
				}
			}

			const gw = path.match(/^\/api\/m\/(subject-[a-z0-9-]+)(\/.*)?$/);
			if (gw) {
				const technical_id = gw[1]!;
				const rest = gw[2] ?? '/';
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
					return Response.json(
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
					);
				}
				return proxy_subject(technical_id, req, rest);
			}

			const install_one = path.match(
				/^\/api\/subjects\/install-schemas\/(subject-[a-z0-9-]+)$/,
			);
			if (
				req.method === 'POST' &&
				(path === '/api/subjects/install-schemas' || install_one)
			) {
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
