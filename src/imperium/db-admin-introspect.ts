/**
 * Lecturas de diagnóstico del gestor: esquema, tamaños, salud y actividad.
 *
 * Todo sale de los catálogos y de las vistas de estadística, así que ninguna de
 * estas consultas escribe ni bloquea. Los tamaños se calculan con
 * `pg_total_relation_size`, no con `COUNT(*)`: contar filas de verdad en cada
 * tabla al abrir el árbol es justo lo que vuelve inservible un explorador de
 * esquema en una base grande. El conteo que se muestra es la estimación de
 * `reltuples`, que el planificador refresca con VACUUM/ANALYZE.
 */

export type SchemaSummary = {
	schema: string;
	tables: number;
	total_bytes: number;
};

export type TableSummary = {
	schema: string;
	name: string;
	kind: string;
	estimated_rows: number;
	total_bytes: number;
	table_bytes: number;
	index_bytes: number;
	comment: string | null;
};

/** Esquemas de usuario, sin los del sistema. */
const USER_SCHEMAS = `
	n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
	AND n.nspname NOT LIKE 'pg_temp%'
	AND n.nspname NOT LIKE 'pg_toast_temp%'
`;

export async function list_schemas(sql: Bun.SQL): Promise<SchemaSummary[]> {
	const rows = await sql.unsafe(`
		SELECT n.nspname AS schema,
		       count(c.oid)::int AS tables,
		       coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint AS total_bytes
		  FROM pg_namespace n
		  LEFT JOIN pg_class c
		    ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'm')
		 WHERE ${USER_SCHEMAS}
		 GROUP BY n.nspname
		 ORDER BY n.nspname
	`);
	return (rows as Record<string, unknown>[]).map((r) => ({
		schema: String(r.schema),
		tables: Number(r.tables ?? 0),
		total_bytes: Number(r.total_bytes ?? 0),
	}));
}

export async function list_tables(
	sql: Bun.SQL,
	schema?: string,
): Promise<TableSummary[]> {
	const filter = schema ? 'AND n.nspname = $1' : '';
	const rows = await sql.unsafe(
		`
		SELECT n.nspname AS schema,
		       c.relname AS name,
		       CASE c.relkind WHEN 'r' THEN 'tabla'
		                      WHEN 'p' THEN 'particionada'
		                      WHEN 'm' THEN 'vista materializada'
		                      WHEN 'v' THEN 'vista'
		                      ELSE c.relkind::text END AS kind,
		       greatest(c.reltuples, 0)::bigint AS estimated_rows,
		       pg_total_relation_size(c.oid)::bigint AS total_bytes,
		       pg_relation_size(c.oid)::bigint AS table_bytes,
		       pg_indexes_size(c.oid)::bigint AS index_bytes,
		       obj_description(c.oid, 'pg_class') AS comment
		  FROM pg_class c
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE c.relkind IN ('r', 'p', 'm', 'v')
		   AND ${USER_SCHEMAS}
		   ${filter}
		 ORDER BY pg_total_relation_size(c.oid) DESC, c.relname
		 LIMIT 500
	`,
		schema ? [schema] : [],
	);
	return (rows as Record<string, unknown>[]).map((r) => ({
		schema: String(r.schema),
		name: String(r.name),
		kind: String(r.kind),
		estimated_rows: Number(r.estimated_rows ?? 0),
		total_bytes: Number(r.total_bytes ?? 0),
		table_bytes: Number(r.table_bytes ?? 0),
		index_bytes: Number(r.index_bytes ?? 0),
		comment: r.comment == null ? null : String(r.comment),
	}));
}

export async function describe_table(
	sql: Bun.SQL,
	schema: string,
	table: string,
): Promise<Record<string, unknown>> {
	const [columns, indexes, constraints, stats] = await Promise.all([
		sql.unsafe(
			`
			SELECT a.attname AS name,
			       format_type(a.atttypid, a.atttypmod) AS type,
			       a.attnotnull AS not_null,
			       pg_get_expr(d.adbin, d.adrelid) AS default_value,
			       col_description(a.attrelid, a.attnum) AS comment
			  FROM pg_attribute a
			  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			 WHERE a.attrelid = to_regclass($1)::oid
			   AND a.attnum > 0 AND NOT a.attisdropped
			 ORDER BY a.attnum
		`,
			[`${quote(schema)}.${quote(table)}`],
		),
		sql.unsafe(
			`
			SELECT i.relname AS name,
			       pg_get_indexdef(x.indexrelid) AS definition,
			       x.indisunique AS is_unique,
			       x.indisprimary AS is_primary,
			       x.indisvalid AS is_valid,
			       pg_relation_size(x.indexrelid)::bigint AS bytes,
			       coalesce(s.idx_scan, 0)::bigint AS scans
			  FROM pg_index x
			  JOIN pg_class i ON i.oid = x.indexrelid
			  LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid
			 WHERE x.indrelid = to_regclass($1)::oid
			 ORDER BY x.indisprimary DESC, i.relname
		`,
			[`${quote(schema)}.${quote(table)}`],
		),
		sql.unsafe(
			`
			SELECT conname AS name,
			       CASE contype WHEN 'p' THEN 'primaria'
			                    WHEN 'f' THEN 'foránea'
			                    WHEN 'u' THEN 'única'
			                    WHEN 'c' THEN 'verificación'
			                    ELSE contype::text END AS kind,
			       pg_get_constraintdef(oid) AS definition
			  FROM pg_constraint
			 WHERE conrelid = to_regclass($1)::oid
			 ORDER BY contype, conname
		`,
			[`${quote(schema)}.${quote(table)}`],
		),
		sql.unsafe(
			`
			SELECT n_live_tup::bigint AS live_rows,
			       n_dead_tup::bigint AS dead_rows,
			       last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
			       seq_scan::bigint AS seq_scans,
			       coalesce(idx_scan, 0)::bigint AS idx_scans
			  FROM pg_stat_user_tables
			 WHERE schemaname = $1 AND relname = $2
		`,
			[schema, table],
		),
	]);

	return {
		schema,
		table,
		columns,
		indexes,
		constraints,
		stats: (stats as unknown[])[0] ?? null,
	};
}

export type HealthReport = Record<string, unknown>;

/**
 * Panel de una sola mirada.
 *
 * Cada bloque va por separado y a prueba de fallos: `pg_stat_statements` puede
 * no estar instalado y `pg_stat_checkpointer` no existe antes de PG17, y que
 * falte uno no puede dejar sin panel a los demás.
 */
export async function read_health(sql: Bun.SQL): Promise<HealthReport> {
	const [
		version,
		size,
		cache,
		connections,
		wraparound,
		dead_tuples,
		invalid_indexes,
		unused_indexes,
		long_running,
		blocked,
		sequences,
		collation,
	] = await Promise.all([
		one(sql, `SELECT version() AS version, current_database() AS database,
		                 current_setting('server_version_num')::int AS version_num`),
		one(sql, `SELECT pg_database_size(current_database())::bigint AS bytes`),
		one(
			sql,
			`SELECT round(100.0 * sum(heap_blks_hit)
			         / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) AS hit_ratio
			   FROM pg_statio_user_tables`,
		),
		one(
			sql,
			`SELECT count(*)::int AS used,
			        current_setting('max_connections')::int AS maximum,
			        count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction
			   FROM pg_stat_activity`,
		),
		one(
			sql,
			`SELECT max(age(datfrozenxid))::bigint AS oldest_xid_age,
			        current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age
			   FROM pg_database`,
		),
		many(
			sql,
			`SELECT schemaname AS schema, relname AS name,
			        n_live_tup::bigint AS live_rows, n_dead_tup::bigint AS dead_rows,
			        round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct
			   FROM pg_stat_user_tables
			  WHERE n_dead_tup > 1000
			  ORDER BY n_dead_tup DESC LIMIT 10`,
		),
		many(
			sql,
			`SELECT n.nspname AS schema, c.relname AS name,
			        t.relname AS table_name
			   FROM pg_index x
			   JOIN pg_class c ON c.oid = x.indexrelid
			   JOIN pg_class t ON t.oid = x.indrelid
			   JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE NOT x.indisvalid AND ${USER_SCHEMAS}
			  ORDER BY n.nspname, c.relname LIMIT 50`,
		),
		many(
			sql,
			`SELECT s.schemaname AS schema, s.indexrelname AS name,
			        s.relname AS table_name,
			        pg_relation_size(s.indexrelid)::bigint AS bytes
			   FROM pg_stat_user_indexes s
			   JOIN pg_index i ON i.indexrelid = s.indexrelid
			  WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
			  ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 20`,
		),
		many(
			sql,
			`SELECT pid, usename AS "user", state,
			        extract(epoch FROM now() - query_start)::int AS seconds,
			        left(query, 300) AS query
			   FROM pg_stat_activity
			  WHERE pid <> pg_backend_pid() AND state <> 'idle'
			    AND query_start < now() - interval '30 seconds'
			  ORDER BY query_start LIMIT 20`,
		),
		many(
			sql,
			`SELECT a.pid, a.usename AS "user", pg_blocking_pids(a.pid) AS blocked_by,
			        left(a.query, 300) AS query
			   FROM pg_stat_activity a
			  WHERE cardinality(pg_blocking_pids(a.pid)) > 0 LIMIT 20`,
		),
		many(
			sql,
			`SELECT schemaname AS schema, sequencename AS name,
			        last_value::bigint AS last_value, max_value::bigint AS max_value,
			        round(100.0 * last_value / nullif(max_value, 0), 2) AS pct
			   FROM pg_sequences
			  WHERE last_value IS NOT NULL
			    AND last_value > max_value / 2
			  ORDER BY pct DESC LIMIT 20`,
		),
		// Una actualización de glibc reordena la colación sin tocar los índices:
		// los B-tree quedan desordenados por dentro y devuelven filas de menos.
		// REINDEX es el único arreglo, y esto es lo que lo delata.
		many(
			sql,
			`SELECT datname AS database, datcollversion AS recorded_version,
			        pg_database_collation_actual_version(oid) AS actual_version
			   FROM pg_database
			  WHERE datcollversion IS NOT NULL
			    AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)`,
		),
	]);

	return {
		server: version,
		database_bytes: Number((size as Record<string, unknown> | null)?.bytes ?? 0),
		cache,
		connections,
		wraparound,
		dead_tuples,
		invalid_indexes,
		unused_indexes,
		long_running,
		blocked,
		sequences_near_limit: sequences,
		collation_mismatch: collation,
	};
}

/** Consultas más caras. Requiere `pg_stat_statements`. */
export async function read_top_queries(sql: Bun.SQL): Promise<unknown[]> {
	return many(
		sql,
		`SELECT left(query, 400) AS query, calls::bigint AS calls,
		        round(total_exec_time)::bigint AS total_ms,
		        round(mean_exec_time, 2) AS mean_ms,
		        rows::bigint AS rows
		   FROM pg_stat_statements
		  ORDER BY total_exec_time DESC LIMIT 25`,
	);
}

async function one(
	sql: Bun.SQL,
	query: string,
): Promise<Record<string, unknown> | null> {
	try {
		const rows = (await sql.unsafe(query)) as Record<string, unknown>[];
		return rows[0] ?? null;
	} catch {
		return null;
	}
}

async function many(sql: Bun.SQL, query: string): Promise<unknown[]> {
	try {
		return (await sql.unsafe(query)) as unknown[];
	} catch {
		return [];
	}
}

/** Comilla un identificador para incrustarlo en `to_regclass`. */
function quote(name: string): string {
	return `"${String(name).replace(/"/g, '""')}"`;
}
