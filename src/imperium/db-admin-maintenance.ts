/**
 * Mantenimiento: VACUUM, ANALYZE y REINDEX.
 *
 * Ninguna de estas corre dentro de una transacción —`REINDEX CONCURRENTLY` y
 * `VACUUM` lo prohíben— así que no pueden pasar por `sql.begin` ni llevar
 * `SET LOCAL`. Y como el nombre de la tabla va incrustado en el texto (Postgres
 * no acepta parámetros para identificadores), el objetivo se resuelve **antes**
 * contra el catálogo con `to_regclass` y se vuelve a escribir desde ahí: lo que
 * se ejecuta es el nombre que devolvió Postgres, no el que mandó el cliente.
 */
import { write_audit } from './db-admin-setup.ts';
import { start_task, type Task } from './db-admin-tasks.ts';

export type MaintenanceOp =
	| 'analyze'
	| 'vacuum'
	| 'vacuum_analyze'
	| 'vacuum_full'
	| 'reindex_table'
	| 'reindex_index'
	| 'reindex_schema';

/** Las que toman ACCESS EXCLUSIVE: bloquean la tabla entera mientras corren. */
export const BLOCKING_OPS: ReadonlySet<MaintenanceOp> = new Set<MaintenanceOp>([
	'vacuum_full',
	'reindex_table',
	'reindex_index',
	'reindex_schema',
]);

export const MAINTENANCE_LABELS: Record<MaintenanceOp, string> = {
	analyze: 'Actualizar estadísticas (ANALYZE)',
	vacuum: 'Limpiar filas muertas (VACUUM)',
	vacuum_analyze: 'Limpiar y actualizar estadísticas',
	vacuum_full: 'Reescribir la tabla (VACUUM FULL)',
	reindex_table: 'Reconstruir los índices de la tabla',
	reindex_index: 'Reconstruir un índice',
	reindex_schema: 'Reconstruir los índices del esquema',
};

export class MaintenanceError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export type MaintenanceRequest = {
	op: MaintenanceOp;
	/** `esquema.tabla`, `esquema.indice` o `esquema` según la operación. */
	target: string;
	/** Solo para REINDEX: sin bloquear la tabla. */
	concurrently?: boolean;
	confirm?: string;
};

const SYSTEM_SCHEMAS = new Set([
	'pg_catalog',
	'information_schema',
	'pg_toast',
]);

/**
 * Comprueba que el objetivo existe y devuelve su nombre entrecomillado tal cual
 * lo conoce el catálogo.
 */
async function resolve_relation(
	sql: Bun.SQL,
	target: string,
	expect_index: boolean,
): Promise<{ quoted: string; schema: string; name: string }> {
	const rows = (await sql.unsafe(
		`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
		   FROM pg_class c
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE c.oid = to_regclass($1)::oid`,
		[target],
	)) as Array<Record<string, unknown>>;
	const row = rows[0];
	if (!row) {
		throw new MaintenanceError(`No existe "${target}" en esta base.`, 404);
	}
	const schema = String(row.schema);
	const name = String(row.name);
	const kind = String(row.kind);
	if (SYSTEM_SCHEMAS.has(schema)) {
		throw new MaintenanceError(
			`"${target}" es del sistema; el gestor no lo toca.`,
			403,
		);
	}
	const is_index = kind === 'i' || kind === 'I';
	if (expect_index && !is_index) {
		throw new MaintenanceError(`"${target}" no es un índice.`);
	}
	if (!expect_index && is_index) {
		throw new MaintenanceError(`"${target}" es un índice, no una tabla.`);
	}
	return { quoted: `${quote(schema)}.${quote(name)}`, schema, name };
}

async function resolve_schema(sql: Bun.SQL, target: string): Promise<string> {
	if (SYSTEM_SCHEMAS.has(target)) {
		throw new MaintenanceError(
			`"${target}" es del sistema; el gestor no lo toca.`,
			403,
		);
	}
	const rows = (await sql.unsafe(
		`SELECT nspname FROM pg_namespace WHERE nspname = $1`,
		[target],
	)) as Array<Record<string, unknown>>;
	if (!rows[0]) {
		throw new MaintenanceError(`No existe el esquema "${target}".`, 404);
	}
	return quote(String(rows[0].nspname));
}

export async function build_maintenance_sql(
	sql: Bun.SQL,
	request: MaintenanceRequest,
): Promise<{ statement: string; target: string }> {
	const target = String(request.target ?? '').trim();
	if (!target) throw new MaintenanceError('Falta decir sobre qué.');
	const concurrently = request.concurrently ? ' CONCURRENTLY' : '';

	switch (request.op) {
		case 'analyze': {
			const rel = await resolve_relation(sql, target, false);
			return { statement: `ANALYZE ${rel.quoted}`, target };
		}
		case 'vacuum': {
			const rel = await resolve_relation(sql, target, false);
			return { statement: `VACUUM ${rel.quoted}`, target };
		}
		case 'vacuum_analyze': {
			const rel = await resolve_relation(sql, target, false);
			return { statement: `VACUUM ANALYZE ${rel.quoted}`, target };
		}
		case 'vacuum_full': {
			const rel = await resolve_relation(sql, target, false);
			return { statement: `VACUUM FULL ${rel.quoted}`, target };
		}
		case 'reindex_table': {
			const rel = await resolve_relation(sql, target, false);
			return { statement: `REINDEX TABLE${concurrently} ${rel.quoted}`, target };
		}
		case 'reindex_index': {
			const rel = await resolve_relation(sql, target, true);
			return { statement: `REINDEX INDEX${concurrently} ${rel.quoted}`, target };
		}
		case 'reindex_schema': {
			const schema = await resolve_schema(sql, target);
			return { statement: `REINDEX SCHEMA${concurrently} ${schema}`, target };
		}
		default:
			throw new MaintenanceError(`Operación desconocida: ${request.op}`);
	}
}

export type MaintenanceActor = {
	id?: string | null;
	label?: string | null;
	origin: 'session' | 'app';
	source_ip?: string | null;
};

/**
 * Lanza la operación en segundo plano y devuelve la ficha del trabajo.
 *
 * Las que bloquean piden confirmación escrita: un VACUUM FULL sobre una tabla
 * grande deja la aplicación entera esperando, y eso no debe salir de un clic
 * distraído.
 */
export async function run_maintenance(
	sql: Bun.SQL,
	request: MaintenanceRequest,
	actor: MaintenanceActor,
): Promise<Task> {
	const { statement, target } = await build_maintenance_sql(sql, request);

	if (BLOCKING_OPS.has(request.op) && !request.concurrently) {
		if (String(request.confirm ?? '').trim().toUpperCase() !== 'CONFIRMO') {
			throw new MaintenanceError(
				`${MAINTENANCE_LABELS[request.op]} bloquea la tabla mientras corre. ` +
					'Escribe CONFIRMO, o usa la opción "sin bloquear" si está disponible.',
			);
		}
	}

	return start_task(
		'mantenimiento',
		`${MAINTENANCE_LABELS[request.op]} — ${target}`,
		async (handle) => {
			handle.log(statement);
			const started = Date.now();
			try {
				await sql.unsafe(statement);
				const duration_ms = Date.now() - started;
				handle.log(`Listo en ${Math.round(duration_ms / 1000)} s.`);
				await write_audit(sql, {
					actor_id: actor.id ?? null,
					actor_label: actor.label ?? null,
					origin: actor.origin,
					source_ip: actor.source_ip ?? null,
					operation: `mantenimiento.${request.op}`,
					statement,
					target,
					duration_ms,
					succeeded: true,
				});
				return { statement, target, duration_ms };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await write_audit(sql, {
					actor_id: actor.id ?? null,
					actor_label: actor.label ?? null,
					origin: actor.origin,
					source_ip: actor.source_ip ?? null,
					operation: `mantenimiento.${request.op}`,
					statement,
					target,
					duration_ms: Date.now() - started,
					succeeded: false,
					error: message,
				});
				throw err;
			}
		},
	);
}

/**
 * Índices que quedaron inválidos.
 *
 * Un `REINDEX CONCURRENTLY` que falla a medias deja un `_ccnew` que ya no sirve
 * para leer pero se sigue manteniendo en cada escritura. Nadie lo ve si no se
 * busca a propósito.
 */
export async function list_invalid_indexes(
	sql: Bun.SQL,
): Promise<Array<Record<string, unknown>>> {
	return (await sql.unsafe(`
		SELECT n.nspname AS schema, c.relname AS name, t.relname AS table_name,
		       pg_relation_size(c.oid)::bigint AS bytes
		  FROM pg_index x
		  JOIN pg_class c ON c.oid = x.indexrelid
		  JOIN pg_class t ON t.oid = x.indrelid
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE NOT x.indisvalid
		   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
		 ORDER BY n.nspname, c.relname
	`)) as Array<Record<string, unknown>>;
}

function quote(name: string): string {
	return `"${String(name).replace(/"/g, '""')}"`;
}
