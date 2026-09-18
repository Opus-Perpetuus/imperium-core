/**
 * Superficie HTTP del gestor de base de datos (`/api/db-admin/...`).
 *
 * Vive en el núcleo porque es el único proceso con la conexión a Postgres y con
 * el volumen de adjuntos montado; las apps v13 no abren la base por contrato.
 * La app `subject-database-manager` guarda las políticas y los horarios y llama
 * aquí; el navegador llama aquí directo para lo interactivo.
 *
 * Quién puede entrar:
 *   - una sesión de administrador sembrado, o
 *   - la app del gestor, con el secreto de gateway **y** estando instalada.
 * Lo segundo importa: el secreto es el mismo para las veinte apps, así que sin
 * comprobar de cuál viene, Tienda podría volcar la base. Y si la app no está
 * instalada no hay gestor — que es justo lo que pidió el usuario: por defecto
 * esto no hace nada.
 */
import { timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { current_user } from './auth.ts';
import { is_seed_admin } from './group-access.ts';
import { ok, fail, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { disabled_subject_slugs } from './subjects-admin.ts';
import {
	count_audit,
	ensure_db_admin_objects,
	read_audit,
	read_audit_entry,
	type DbAdminCapabilities,
} from './db-admin-setup.ts';
import {
	ConsoleError,
	run_console_statement,
	type ConsoleActor,
} from './db-admin-console.ts';
import {
	describe_table,
	list_schemas,
	list_tables,
	read_health,
	read_top_queries,
} from './db-admin-introspect.ts';
import {
	MaintenanceError,
	list_invalid_indexes,
	run_maintenance,
} from './db-admin-maintenance.ts';
import {
	ARCHIVE_SUFFIX,
	BackupError,
	backup_tooling,
	delete_backup,
	find_backup,
	list_backups,
	prune_backups,
	start_backup,
	verify_backup,
} from './db-admin-backup.ts';
import { get_task, list_tasks } from './db-admin-tasks.ts';

/** Slug de la app que tiene permiso de llamar por el plano de gateway. */
export const MANAGER_SLUG = 'database-manager';
export const MANAGER_TECHNICAL_ID = `subject-${MANAGER_SLUG}`;

export function is_db_admin_path(path: string): boolean {
	return path === '/db-admin' || path.startsWith('/db-admin/');
}

type Access =
	| { ok: true; actor: ConsoleActor }
	| { ok: false; status: number; message: string };

async function authorize(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
): Promise<Access> {
	const source_ip =
		req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		req.headers.get('x-real-ip') ||
		null;

	const user = (await current_user(sql, req).catch(() => null)) as ImperiumDoc | null;
	if (user) {
		if (!is_seed_admin(user)) {
			return {
				ok: false,
				status: 403,
				message: 'El gestor de base de datos es solo para administradores.',
			};
		}
		return {
			ok: true,
			actor: {
				id: String(user._id ?? user.id ?? ''),
				label: String(user.email ?? user.name ?? 'administrador'),
				origin: 'session',
				source_ip,
			},
		};
	}

	if (gateway_ok(req)) {
		const caller =
			req.headers.get('x-imperium-subject')?.trim() ??
			req.headers.get('x-nox-kirlet-technical-id')?.trim() ??
			'';
		if (caller !== MANAGER_TECHNICAL_ID) {
			return {
				ok: false,
				status: 403,
				message: `El plano de apps solo acepta a ${MANAGER_TECHNICAL_ID} en el gestor.`,
			};
		}
		const disabled = await disabled_subject_slugs(store, sql).catch(
			() => new Set<string>([MANAGER_SLUG]),
		);
		if (disabled.has(MANAGER_SLUG)) {
			return {
				ok: false,
				status: 409,
				message:
					'La app Gestor de base de datos no está instalada; no hay nada que automatizar.',
			};
		}
		return {
			ok: true,
			actor: {
				id: MANAGER_TECHNICAL_ID,
				label: 'Gestor de base de datos (programado)',
				origin: 'app',
				source_ip,
			},
		};
	}

	return { ok: false, status: 401, message: 'No estás autenticado' };
}

function gateway_ok(req: Request): boolean {
	const expected = process.env.CORE_SUBJECT_GATEWAY_SECRET ?? '';
	if (!expected) return false;
	const got =
		req.headers.get('x-core-subject-gateway-secret') ??
		req.headers.get('x-nox-kirlet-gateway-secret') ??
		'';
	const a = Buffer.from(got);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

export async function handle_db_admin(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
	path: string,
): Promise<Response> {
	const access = await authorize(store, sql, req);
	if (!access.ok) {
		const body = fail(access.message, access.status);
		return Response.json(body.body, { status: body.status });
	}
	const actor = access.actor;

	let caps: DbAdminCapabilities;
	try {
		caps = await ensure_db_admin_objects(sql);
	} catch (err) {
		const body = fail(
			`No se pudo preparar el gestor: ${err instanceof Error ? err.message : String(err)}`,
			500,
		);
		return Response.json(body.body, { status: body.status });
	}

	const rest = path.slice('/db-admin'.length).replace(/^\/+|\/+$/g, '');
	const segments = rest ? rest.split('/') : [];
	const method = req.method.toUpperCase();

	try {
		return await route(store, sql, req, url, segments, method, actor, caps);
	} catch (err) {
		const status =
			err instanceof ConsoleError ||
			err instanceof MaintenanceError ||
			err instanceof BackupError
				? err.status
				: 500;
		const message = err instanceof Error ? err.message : String(err);
		const extra: Record<string, unknown> = {};
		if (err instanceof ConsoleError) {
			extra.code = err.code;
			extra.needs_confirmation = err.needs_confirmation;
		}
		return Response.json(fail(message, status, extra).body, { status });
	}
}

async function route(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
	segments: string[],
	method: string,
	actor: ConsoleActor,
	caps: DbAdminCapabilities,
): Promise<Response> {
	const [head, ...tail] = segments;

	if (!head && method === 'GET') {
		return Response.json(
			ok(
				{
					capabilities: caps,
					tooling: await backup_tooling(),
					actor: { label: actor.label, origin: actor.origin },
				},
				'Gestor de base de datos',
			),
		);
	}

	if (head === 'health' && method === 'GET') {
		return Response.json(ok(await read_health(sql), 'Salud de la base'));
	}

	if (head === 'schemas' && method === 'GET') {
		return Response.json(ok(await list_schemas(sql), 'Esquemas'));
	}

	if (head === 'tables' && method === 'GET') {
		if (tail.length === 2) {
			return Response.json(
				ok(await describe_table(sql, tail[0]!, tail[1]!), 'Tabla'),
			);
		}
		const schema = url.searchParams.get('schema') ?? undefined;
		return Response.json(ok(await list_tables(sql, schema || undefined), 'Tablas'));
	}

	if (head === 'query' && method === 'POST') {
		const body = (await read_json(req)) as Record<string, unknown>;
		const result = await run_console_statement(
			sql,
			{
				sql: String(body.sql ?? ''),
				mode: body.mode as never,
				limit: body.limit as number | undefined,
				timeout_ms: body.timeout_ms as number | undefined,
				confirm: body.confirm as string | undefined,
				dry_run: Boolean(body.dry_run),
			},
			caps,
			actor,
		);
		return Response.json(ok(result, 'Sentencia ejecutada'));
	}

	if (head === 'explain' && method === 'POST') {
		const body = (await read_json(req)) as Record<string, unknown>;
		// Mismo ejecutor que la consola: rol restringido, solo lectura, límite de
		// tiempo y bitácora. `EXPLAIN ANALYZE` ejecuta de verdad, así que servirlo
		// por fuera sería una puerta trasera a todas esas barreras.
		const result = await run_console_statement(
			sql,
			{
				sql: String(body.sql ?? ''),
				mode: 'read',
				timeout_ms: body.timeout_ms as number | undefined,
				explain: { analyze: Boolean(body.analyze) },
			},
			caps,
			actor,
		);
		return Response.json(
			ok(
				{
					plan: result.rows.map((row) => String(row[0] ?? '')).join('\n'),
					notices: result.notices,
					duration_ms: result.duration_ms,
				},
				'Plan de ejecución',
			),
		);
	}

	if (head === 'top-queries' && method === 'GET') {
		if (!caps.stat_statements) {
			return Response.json(
				ok(
					[],
					'pg_stat_statements no está instalado: añádelo a shared_preload_libraries y ' +
						'corre CREATE EXTENSION pg_stat_statements.',
				),
			);
		}
		return Response.json(ok(await read_top_queries(sql), 'Consultas más caras'));
	}

	if (head === 'invalid-indexes' && method === 'GET') {
		return Response.json(ok(await list_invalid_indexes(sql), 'Índices inválidos'));
	}

	if (head === 'maintenance' && method === 'POST') {
		const body = (await read_json(req)) as Record<string, unknown>;
		const task = await run_maintenance(
			sql,
			{
				op: body.op as never,
				target: String(body.target ?? ''),
				concurrently: Boolean(body.concurrently),
				confirm: body.confirm as string | undefined,
			},
			actor,
		);
		return Response.json(ok(task, 'Mantenimiento en curso'), { status: 202 });
	}

	if (head === 'backups') {
		return backups_route(sql, req, tail, method, actor);
	}

	if (head === 'tasks' && method === 'GET') {
		if (tail[0]) {
			const task = get_task(tail[0]);
			if (!task) {
				return Response.json(fail('No existe ese trabajo.', 404).body, {
					status: 404,
				});
			}
			return Response.json(ok(task, 'Trabajo'));
		}
		return Response.json(ok(list_tasks(), 'Trabajos'));
	}

	if (head === 'audit' && method === 'GET') {
		if (tail[0]) {
			const entry = await read_audit_entry(sql, tail[0]);
			if (!entry) {
				return Response.json(fail('No existe esa entrada.', 404).body, {
					status: 404,
				});
			}
			return Response.json(ok(entry, 'Entrada de la bitácora'));
		}
		// `limite`/`desde`/`termino` son los nombres que manda la lista de
		// Angular; `limit`/`offset` siguen aceptándose para quien llame a mano.
		const limit = Number(
			url.searchParams.get('limite') ?? url.searchParams.get('limit') ?? 100,
		);
		const offset = Number(
			url.searchParams.get('desde') ?? url.searchParams.get('offset') ?? 0,
		);
		const term = url.searchParams.get('termino') ?? undefined;
		const [rows, total] = await Promise.all([
			read_audit(sql, { limit, offset, term }),
			count_audit(sql, term),
		]);
		return Response.json(ok(rows, 'Bitácora', total));
	}

	void store;
	return Response.json(fail('Ruta desconocida del gestor.', 404).body, {
		status: 404,
	});
}

async function backups_route(
	sql: Bun.SQL,
	req: Request,
	tail: string[],
	method: string,
	actor: ConsoleActor,
): Promise<Response> {
	if (tail.length === 0 && method === 'GET') {
		return Response.json(ok(list_backups(), 'Respaldos'));
	}

	if (tail.length === 0 && method === 'POST') {
		const body = (await read_json(req)) as Record<string, unknown>;
		const task = start_backup(
			sql,
			{
				label: body.label as string | undefined,
				include_attachments: body.include_attachments !== false,
				trigger: (body.trigger as never) ?? 'manual',
				id: body.id as string | undefined,
			},
			actor,
		);
		return Response.json(ok(task, 'Respaldo en curso'), { status: 202 });
	}

	if (tail[0] === 'prune' && method === 'POST') {
		const body = (await read_json(req)) as Record<string, unknown>;
		const removed = await prune_backups(sql, Number(body.keep ?? 5), actor);
		return Response.json(ok({ removed }, `Se borraron ${removed.length}`));
	}

	const id = tail[0];
	if (!id) {
		return Response.json(fail('Falta el respaldo.', 400).body, { status: 400 });
	}

	if (tail.length === 1 && method === 'GET') {
		const found = find_backup(id);
		if (!found) {
			return Response.json(fail('No existe ese respaldo.', 404).body, {
				status: 404,
			});
		}
		return Response.json(ok(found.manifest, 'Respaldo'));
	}

	if (tail.length === 1 && method === 'DELETE') {
		await delete_backup(sql, id, actor);
		return Response.json(ok(null, 'Respaldo borrado'));
	}

	if (tail[1] === 'verify' && method === 'POST') {
		return Response.json(ok(await verify_backup(sql, id, actor), 'Verificación'));
	}

	if (tail[1] === 'download' && method === 'GET') {
		const found = find_backup(id);
		if (!found) {
			return Response.json(fail('No existe ese respaldo.', 404).body, {
				status: 404,
			});
		}
		// `Bun.file` transmite desde disco: un respaldo de varios GB no cabe en
		// memoria y leerlo entero tumbaría el núcleo.
		return new Response(Bun.file(found.path), {
			headers: {
				'content-type': 'application/x-tar',
				'content-length': String(found.manifest.archive_bytes),
				'content-disposition': `attachment; filename="${basename(found.path)}"`,
				'x-imperium-backup-sha256': found.manifest.archive_sha256,
			},
		});
	}

	void ARCHIVE_SUFFIX;
	return Response.json(fail('Ruta desconocida del gestor.', 404).body, {
		status: 404,
	});
}

async function read_json(req: Request): Promise<unknown> {
	const text = await req.text();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new ConsoleError('El cuerpo de la petición no es JSON.');
	}
}
