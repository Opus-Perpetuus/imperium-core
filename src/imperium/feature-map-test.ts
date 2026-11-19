/**
 * Datos de prueba de los feature maps (`feature_map_test`).
 *
 * Toda tabla de la base (núcleo, apps, `public` y cualquier esquema de
 * tenant; solo se saltan los catálogos de Postgres y las tablas de
 * extensiones) lleva la columna `feature_map_test BOOLEAN NOT NULL`, falsa por
 * omisión. Lo que se crea durante una corrida de feature map (petición con la
 * cabecera `x-imperium-feature-map-test: 1`) queda en `true`, y al terminar la
 * corrida `POST /api/feature-map-test/purge` lo borra en masa, hijos antes que
 * padres.
 *
 * El marcado no depende de quién inserte: el DEFAULT de la columna lee la
 * variable de transacción `imperium.feature_map_test`, y el cliente SQL del
 * núcleo (`sql-client.ts`) la enciende con `SET LOCAL` en cada INSERT (o
 * transacción) de una petición marcada. Así quedan marcados también los INSERT
 * SQL especializados (sesiones, chat, historial, notificaciones…). Fuera de una
 * corrida la variable no existe y el DEFAULT da `false`.
 *
 * La cabecera solo marca lo que esa petición inserta; nunca toca filas que ya
 * existían. Borrar exige al superadministrador semilla, que nunca se borra, y
 * tampoco borra las cuentas semilla de los bots (`@qa.imperium.test`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const FEATURE_MAP_TEST_COLUMN = 'feature_map_test';
export const FEATURE_MAP_TEST_HEADER = 'x-imperium-feature-map-test';
/** Variable de transacción que enciende el marcado (`on`). */
export const FEATURE_MAP_TEST_GUC = 'imperium.feature_map_test';
/** DEFAULT de la columna: `false` salvo dentro de una transacción marcada. */
export const FEATURE_MAP_TEST_DEFAULT_SQL = `COALESCE(current_setting('${FEATURE_MAP_TEST_GUC}', true) = 'on', false)`;
/** DDL de la columna para un CREATE TABLE o un ADD COLUMN. */
export const FEATURE_MAP_TEST_COLUMN_DDL = `${FEATURE_MAP_TEST_COLUMN} BOOLEAN NOT NULL DEFAULT ${FEATURE_MAP_TEST_DEFAULT_SQL}`;
/** Enciende el marcado solo para la transacción en curso. */
export const FEATURE_MAP_TEST_SET_LOCAL = `SELECT set_config('${FEATURE_MAP_TEST_GUC}', 'on', true)`;
/** Esquemas que nunca se tocan (catálogos de Postgres). */
export const FEATURE_MAP_TEST_SKIP_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'] as const;
/** Administrador semilla: nunca se borra, aunque esté marcado. */
export const FEATURE_MAP_TEST_SEED_ADMIN_REF = 'user-menu-management-0';
/**
 * Tablas de estructura de la instancia (qué apps hay, sus esquemas, sus
 * consecutivos y la bitácora de administración). Llevan la columna, pero la
 * purga no las vacía: borrar una fila ahí rompe la instalación, no un dato.
 */
export const FEATURE_MAP_TEST_PROTECTED = new Set([
	'public.app_registry',
	'public.app_manifest_snapshot',
	'public.app_registry_audit',
	'public.subject_installs',
	'public.subject_schema_versions',
	'public.subject_catalog',
	'public.subject_catalog_settings',
	'public.subject_counters',
	'public.subject_params',
	'db_admin.audit_log',
	'db_admin.instance',
]);
/**
 * Cuentas semilla de los bots (`ia.<rol>@qa.imperium.test` y cualquier otra
 * del dominio de QA). Las usan los bots fuera de una corrida: la purga nunca
 * las borra; si quedaron marcadas (seed viejo que las creó con la cabecera) se
 * desmarcan.
 */
export const FEATURE_MAP_TEST_BOT_DOMAIN = 'qa.imperium.test';
export const FEATURE_MAP_TEST_BOT_ACCOUNT_EMAIL_SQL = `(lower(EMAIL) LIKE '%@${FEATURE_MAP_TEST_BOT_DOMAIN}')`;
/** Correos que nunca son de una persona real (RFC 2606): `.test`, `example.*`. */
export const FEATURE_MAP_TEST_ACCOUNT_EMAIL_SQL = `(lower(EMAIL) LIKE '%.test' OR lower(EMAIL) ~ '@example\\.(com|org|net)$')`;

/** ¿La sentencia escribe filas nuevas? (para encender el marcado solo ahí). */
export function feature_map_test_inserts(query: string): boolean {
	const text = query.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
	return /\b(insert\s+into|merge\s+into|copy\s+[\w."]+(\s*\([^)]*\))?\s+from)\b/i.test(text);
}

const als = new AsyncLocalStorage<{ on: boolean }>();

/** ¿La petición viene de una corrida de feature map? (`1`, `true`, `si`). */
export function feature_map_test_requested(headers: Headers | null | undefined): boolean {
	const raw = String(headers?.get(FEATURE_MAP_TEST_HEADER) ?? '').trim().toLowerCase();
	return raw === '1' || raw === 'true' || raw === 'si' || raw === 'sí' || raw === 'yes';
}

export function run_with_feature_map_test<T>(on: boolean, fn: () => T): T {
	return als.run({ on }, fn);
}

/** ¿Lo que se inserta ahora es de una corrida de feature map? */
export function in_feature_map_test(): boolean {
	return als.getStore()?.on === true;
}

/** Marca la fila si estamos en una corrida de prueba (prevalece sobre el valor del llamador). */
export function mark_feature_map_test_row<T extends Record<string, unknown>>(row: T, on = in_feature_map_test()): T {
	if (on) (row as Record<string, unknown>)[FEATURE_MAP_TEST_COLUMN] = true;
	return row;
}

type Sql = { unsafe(query: string, params?: unknown[]): Promise<unknown[]> };

function q(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Tablas de la base: ordinarias o particionadas (no sus particiones), de
 * cualquier esquema que no sea de Postgres y que no sean de una extensión.
 */
const TABLES_SQL = `
	SELECT n.nspname AS schema, c.relname AS table, c.oid AS oid
	  FROM pg_class c
	  JOIN pg_namespace n ON n.oid = c.relnamespace
	 WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
	   AND n.nspname NOT IN (${FEATURE_MAP_TEST_SKIP_SCHEMAS.map((x) => `'${x}'`).join(', ')})
	   AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
	   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`;

/**
 * Agrega la columna a toda tabla de Imperium que no la tenga. Idempotente;
 * una tabla que falla no frena las demás. Devuelve cuántas se agregaron.
 */
export async function ensure_feature_map_test_columns(sql: Sql): Promise<number> {
	let rows: Array<{ schema: string; table: string; has: boolean; marks: boolean }> = [];
	try {
		rows = (await sql.unsafe(
			`SELECT t.schema, t.table,
			        a.attnum IS NOT NULL AS has,
			        COALESCE(pg_get_expr(ad.adbin, ad.adrelid) LIKE '%${FEATURE_MAP_TEST_GUC}%', false) AS marks
			   FROM (${TABLES_SQL}) t
			   LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = '${FEATURE_MAP_TEST_COLUMN}' AND NOT a.attisdropped
			   LEFT JOIN pg_attrdef ad ON ad.adrelid = t.oid AND ad.adnum = a.attnum
			  WHERE a.attnum IS NULL OR ad.adbin IS NULL
			     OR pg_get_expr(ad.adbin, ad.adrelid) NOT LIKE '%${FEATURE_MAP_TEST_GUC}%'`,
		)) as Array<{ schema: string; table: string; has: boolean; marks: boolean }>;
	} catch {
		return 0;
	}
	let added = 0;
	for (const row of rows) {
		const qt = `${q(row.schema)}.${q(row.table)}`;
		try {
			// DEFAULT estable: Postgres no reescribe la tabla y las filas viejas quedan en false.
			await sql.unsafe(
				row.has
					? `ALTER TABLE ${qt} ALTER COLUMN ${FEATURE_MAP_TEST_COLUMN} SET DEFAULT ${FEATURE_MAP_TEST_DEFAULT_SQL}`
					: `ALTER TABLE ${qt} ADD COLUMN IF NOT EXISTS ${FEATURE_MAP_TEST_COLUMN_DDL}`,
			);
			added++;
		} catch {
			/* tabla en uso o sin permiso: la próxima pasada la toma */
		}
	}
	return added;
}

export type FeatureMapTestTable = { schema: string; table: string };
export type FeatureMapTestFk = { child: string; parent: string };

/** `schema.tabla` */
export function table_key(t: FeatureMapTestTable): string {
	return `${t.schema}.${t.table}`;
}

/**
 * Orden de borrado: una tabla va antes que las tablas a las que apunta (hijos
 * antes que padres). Ciclos y autorreferencias no bloquean: lo que quede se
 * agrega al final y el borrado reintenta por pasadas.
 */
export function feature_map_test_delete_order(
	tables: FeatureMapTestTable[],
	fks: FeatureMapTestFk[],
): FeatureMapTestTable[] {
	const by_key = new Map(tables.map((t) => [table_key(t), t]));
	// referenced_by[parent] = hijos que apuntan a parent
	const pending_children = new Map<string, Set<string>>();
	for (const key of by_key.keys()) pending_children.set(key, new Set());
	for (const fk of fks) {
		if (fk.child === fk.parent) continue;
		if (!by_key.has(fk.child) || !by_key.has(fk.parent)) continue;
		pending_children.get(fk.parent)!.add(fk.child);
	}
	const out: FeatureMapTestTable[] = [];
	const done = new Set<string>();
	let progress = true;
	while (progress) {
		progress = false;
		for (const key of [...by_key.keys()].sort()) {
			if (done.has(key)) continue;
			const kids = pending_children.get(key)!;
			if ([...kids].every((kid) => done.has(kid))) {
				out.push(by_key.get(key)!);
				done.add(key);
				progress = true;
			}
		}
	}
	for (const key of [...by_key.keys()].sort()) if (!done.has(key)) out.push(by_key.get(key)!);
	return out;
}

async function marked_tables(sql: Sql): Promise<FeatureMapTestTable[]> {
	return (await sql.unsafe(
		`SELECT t.schema, t.table FROM (${TABLES_SQL}) t
		  WHERE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = '${FEATURE_MAP_TEST_COLUMN}' AND NOT a.attisdropped)`,
	)) as FeatureMapTestTable[];
}

async function foreign_keys(sql: Sql): Promise<FeatureMapTestFk[]> {
	try {
		const rows = (await sql.unsafe(
			`SELECT cn.nspname || '.' || cc.relname AS child, pn.nspname || '.' || pc.relname AS parent
			   FROM pg_constraint k
			   JOIN pg_class cc ON cc.oid = k.conrelid
			   JOIN pg_namespace cn ON cn.oid = cc.relnamespace
			   JOIN pg_class pc ON pc.oid = k.confrelid
			   JOIN pg_namespace pn ON pn.oid = pc.relnamespace
			  WHERE k.contype = 'f'`,
		)) as FeatureMapTestFk[];
		return rows;
	} catch {
		return [];
	}
}

export type FeatureMapTestSummary = { tables: Array<{ table: string; rows: number }>; total: number };

/** Cuántas filas marcadas hay por tabla (solo las que tienen alguna). */
export async function feature_map_test_summary(sql: Sql): Promise<FeatureMapTestSummary> {
	const tables: Array<{ table: string; rows: number }> = [];
	for (const t of await marked_tables(sql)) {
		try {
			const rows = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM ${q(t.schema)}.${q(t.table)} WHERE ${FEATURE_MAP_TEST_COLUMN} = true`,
			)) as Array<{ n: number }>;
			const n = Number(rows[0]?.n ?? 0);
			if (n > 0) tables.push({ table: table_key(t), rows: n });
		} catch {
			/* tabla que desapareció entre la lista y el conteo */
		}
	}
	tables.sort((a, b) => a.table.localeCompare(b.table));
	return { tables, total: tables.reduce((sum, t) => sum + t.rows, 0) };
}

export type FeatureMapTestPurge = {
	deleted: Array<{ table: string; rows: number }>;
	total: number;
	/** Tablas que no se pudieron vaciar (FK desde una fila que no es de prueba). */
	blocked: Array<{ table: string; error: string }>;
	/** Filas marcadas en tablas de estructura, que la purga no toca a propósito. */
	protected: Array<{ table: string; rows: number }>;
	/** Cuentas semilla de los bots que estaban marcadas: se desmarcan y se quedan. */
	kept_accounts: Array<{ table: string; rows: number }>;
};

type FkRef = { child_schema: string; child_table: string; child_columns: string[]; parent_columns: string[] };

/** FKs (también compuestas y desde otros esquemas) que apuntan a la tabla. */
async function referencing_fks(sql: Sql, t: FeatureMapTestTable): Promise<FkRef[]> {
	try {
		return (await sql.unsafe(
			`SELECT cn.nspname AS child_schema, cc.relname AS child_table,
			        array_agg(ca.attname ORDER BY keys.n) AS child_columns,
			        array_agg(pa.attname ORDER BY keys.n) AS parent_columns
			   FROM pg_constraint k
			   JOIN pg_class cc ON cc.oid = k.conrelid
			   JOIN pg_namespace cn ON cn.oid = cc.relnamespace
			   JOIN pg_class pc ON pc.oid = k.confrelid
			   JOIN pg_namespace pn ON pn.oid = pc.relnamespace
			   CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY AS keys(cnum, pnum, n)
			   JOIN pg_attribute ca ON ca.attrelid = cc.oid AND ca.attnum = keys.cnum
			   JOIN pg_attribute pa ON pa.attrelid = pc.oid AND pa.attnum = keys.pnum
			  WHERE k.contype = 'f' AND pn.nspname = $1 AND pc.relname = $2
			  GROUP BY k.oid, cn.nspname, cc.relname`,
			[t.schema, t.table],
		)) as FkRef[];
	} catch {
		return [];
	}
}

/**
 * DELETE de las filas marcadas que ninguna otra fila referencia. No se confía
 * en ON DELETE CASCADE / SET NULL: así nunca se borra ni se modifica una fila
 * real. Los hijos marcados se borran antes (orden de FKs); una autorreferencia
 * entre filas marcadas no bloquea.
 */
/** Guardas por fila: el administrador semilla nunca; en tablas de cuentas, solo correos de prueba y nunca las cuentas semilla de los bots. */
export function keep_guards(account_table: boolean): string {
	const field = (name: string) => `COALESCE(to_jsonb(p) ->> '${name}', to_jsonb(p) -> 'payload' ->> '${name}', '')`;
	const seed = ` AND ${field('ref')} <> '${FEATURE_MAP_TEST_SEED_ADMIN_REF}' AND ${field('_ref')} <> '${FEATURE_MAP_TEST_SEED_ADMIN_REF}'`;
	if (!account_table) return seed;
	const email = field('email');
	return `${seed} AND ${FEATURE_MAP_TEST_ACCOUNT_EMAIL_SQL.replaceAll('EMAIL', email)} AND NOT ${FEATURE_MAP_TEST_BOT_ACCOUNT_EMAIL_SQL.replaceAll('EMAIL', email)}`;
}

/** Desmarca las cuentas semilla de los bots (nunca se borran). */
export function unmark_bot_accounts_sql(t: FeatureMapTestTable): string {
	const email = `COALESCE(to_jsonb(p) ->> 'email', to_jsonb(p) -> 'payload' ->> 'email', '')`;
	return `UPDATE ${q(t.schema)}.${q(t.table)} p SET ${FEATURE_MAP_TEST_COLUMN} = false WHERE p.${FEATURE_MAP_TEST_COLUMN} = true AND ${FEATURE_MAP_TEST_BOT_ACCOUNT_EMAIL_SQL.replaceAll('EMAIL', email)} RETURNING 1`;
}

export function delete_marked_sql(
	t: FeatureMapTestTable,
	refs: FkRef[],
	returning: string,
	opts: { account_table?: boolean } = {},
): string {
	const guards = refs.map((ref) => {
		const join = ref.child_columns.map((col, i) => `c.${q(col)} = p.${q(ref.parent_columns[i]!)}`).join(' AND ');
		const self = ref.child_schema === t.schema && ref.child_table === t.table;
		return ` AND NOT EXISTS (SELECT 1 FROM ${q(ref.child_schema)}.${q(ref.child_table)} c WHERE ${join}${self ? ` AND c.${FEATURE_MAP_TEST_COLUMN} IS NOT TRUE` : ''})`;
	});
	return `DELETE FROM ${q(t.schema)}.${q(t.table)} p WHERE p.${FEATURE_MAP_TEST_COLUMN} = true${keep_guards(opts.account_table === true)}${guards.join('')} RETURNING ${returning}`;
}

/** Borra las filas marcadas libres de una tabla y devuelve sus `id` (o `null` si la tabla no tiene `id`). */
async function delete_marked(sql: Sql, t: FeatureMapTestTable, account_table: boolean): Promise<Array<string | null>> {
	const refs = await referencing_fks(sql, t);
	try {
		const rows = (await sql.unsafe(delete_marked_sql(t, refs, 'p.id::text AS id', { account_table }))) as Array<{ id?: unknown }>;
		return rows.map((row) => (row.id == null ? null : String(row.id)));
	} catch (err) {
		const e = err as { code?: string; errno?: string };
		if (e?.code !== '42703' && e?.errno !== '42703') throw err;
		const rows = (await sql.unsafe(delete_marked_sql(t, refs, '1', { account_table }))) as unknown[];
		return rows.map(() => null);
	}
}

async function count_marked(sql: Sql, t: FeatureMapTestTable): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${q(t.schema)}.${q(t.table)} WHERE ${FEATURE_MAP_TEST_COLUMN} = true`,
	)) as Array<{ n: number }>;
	return Number(rows[0]?.n ?? 0);
}

/**
 * Borra en masa todas las filas `feature_map_test = true`, hijos antes que
 * padres, por pasadas: si una tabla choca con una FK, se reintenta después de
 * vaciar las demás. Lo que siga bloqueado se reporta en `blocked`.
 */
export async function purge_feature_map_test(
	sql: Sql,
	opts: {
		max_passes?: number;
		on_deleted?: (table: string, ids: string[]) => Promise<void> | void;
		/** `schema.tabla` de las cuentas de usuario: ahí solo se borran correos de prueba. */
		account_tables?: Iterable<string>;
	} = {},
): Promise<FeatureMapTestPurge> {
	const max_passes = opts.max_passes ?? 5;
	const accounts = new Set(opts.account_tables ?? []);
	const all = await marked_tables(sql);
	const errors_before = new Map<string, string>();
	const protected_left: Array<{ table: string; rows: number }> = [];
	for (const t of all.filter((x) => FEATURE_MAP_TEST_PROTECTED.has(table_key(x)))) {
		const n = await count_marked(sql, t).catch(() => 0);
		if (n > 0) protected_left.push({ table: table_key(t), rows: n });
	}
	const kept_accounts: Array<{ table: string; rows: number }> = [];
	for (const t of all.filter((x) => accounts.has(table_key(x)))) {
		try {
			const rows = (await sql.unsafe(unmark_bot_accounts_sql(t))) as unknown[];
			if (rows.length) kept_accounts.push({ table: table_key(t), rows: rows.length });
		} catch (err) {
			errors_before.set(table_key(t), String((err as Error)?.message ?? err));
		}
	}
	const order = feature_map_test_delete_order(
		all.filter((x) => !FEATURE_MAP_TEST_PROTECTED.has(table_key(x))),
		await foreign_keys(sql),
	);
	const deleted = new Map<string, number>();
	const errors = new Map<string, string>(errors_before);
	for (let pass = 0; pass < max_passes; pass++) {
		let progress = false;
		for (const t of order) {
			try {
				const rows = await delete_marked(sql, t, accounts.has(table_key(t)));
				errors.delete(table_key(t));
				if (!rows.length) continue;
				deleted.set(table_key(t), (deleted.get(table_key(t)) ?? 0) + rows.length);
				progress = true;
				const ids = rows.filter((id): id is string => typeof id === 'string' && id !== '');
				if (ids.length && opts.on_deleted) {
					await Promise.resolve(opts.on_deleted(table_key(t), ids)).catch(() => undefined);
				}
			} catch (err) {
				errors.set(table_key(t), String((err as Error)?.message ?? err));
			}
		}
		if (!progress) break;
	}
	// Lo que siga marcado lo retiene una fila real (o un error): se reporta, no se fuerza.
	const blocked: Array<{ table: string; error: string }> = [];
	for (const t of order) {
		const key = table_key(t);
		const left = await count_marked(sql, t).catch(() => 0);
		if (errors.has(key)) blocked.push({ table: key, error: errors.get(key)! });
		else if (left > 0)
			blocked.push({
				table: key,
				error: accounts.has(key)
					? `${left} cuentas marcadas se quedan: administrador semilla, correo que no es de prueba o referenciadas (las cuentas semilla de los bots se desmarcan)`
					: `${left} filas de prueba siguen referenciadas por filas que no son de prueba`,
			});
	}
	const list = [...deleted].map(([table, rows]) => ({ table, rows })).sort((a, b) => a.table.localeCompare(b.table));
	return {
		deleted: list,
		total: list.reduce((sum, t) => sum + t.rows, 0),
		blocked,
		protected: protected_left,
		kept_accounts,
	};
}
