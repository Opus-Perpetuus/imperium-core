/**
 * Objetos propios del gestor de base de datos: esquema `db_admin`, bitácora y
 * los dos roles con los que corre la consola.
 *
 * Los roles son la frontera real. El núcleo se conecta como dueño del clúster,
 * así que una consola que corriera con esa conexión podría `COPY … FROM
 * PROGRAM` (ejecución de comandos en el contenedor de Postgres),
 * `pg_read_server_file`, `lo_export` y crear superusuarios. `SET LOCAL ROLE` a
 * un rol sin esos privilegios cierra todo eso de golpe, y `LOCAL` lo deja atado
 * a la transacción: no se escapa al resto de la conexión, que es compartida.
 */
import { debug_error } from './debug-request-log.ts';

/** Solo lectura: `pg_read_all_data` y nada más. */
export const CONSOLE_ROLE_READ = 'imperium_console_lectura';
/** Lectura y escritura de filas; sigue sin poder alterar el esquema. */
export const CONSOLE_ROLE_WRITE = 'imperium_console_escritura';

export const DB_ADMIN_SCHEMA = 'db_admin';

export type DbAdminCapabilities = {
	/** Los roles restringidos existen y se puede hacer `SET LOCAL ROLE`. */
	restricted_roles: boolean;
	/** `pg_stat_statements` está instalado. */
	stat_statements: boolean;
	/** Motivo por el que no hay roles restringidos, si es el caso. */
	roles_error: string | null;
};

let cached: DbAdminCapabilities | null = null;

/**
 * Crea (si faltan) los objetos del gestor. Idempotente.
 *
 * Un fallo creando los roles no tumba el módulo: se sigue con la consola en
 * modo lectura sobre transacción `READ ONLY`, que Postgres aplica en el
 * ejecutor, y se apaga la escritura. Peor es no tener gestor.
 */
export async function ensure_db_admin_objects(
	sql: Bun.SQL,
): Promise<DbAdminCapabilities> {
	if (cached) return cached;

	await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${DB_ADMIN_SCHEMA}`);
	await sql.unsafe(`
		CREATE TABLE IF NOT EXISTS ${DB_ADMIN_SCHEMA}.audit_log (
			id           BIGSERIAL PRIMARY KEY,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			actor_id     TEXT,
			actor_label  TEXT,
			origin       TEXT NOT NULL,
			source_ip    TEXT,
			operation    TEXT NOT NULL,
			mode         TEXT,
			statement    TEXT,
			target       TEXT,
			row_count    INTEGER,
			duration_ms  INTEGER,
			succeeded    BOOLEAN NOT NULL,
			error        TEXT
		)
	`);
	await sql.unsafe(`
		CREATE INDEX IF NOT EXISTS audit_log_created_at_idx
			ON ${DB_ADMIN_SCHEMA}.audit_log (created_at DESC)
	`);

	let restricted_roles = false;
	let roles_error: string | null = null;
	try {
		for (const [role, extra] of [
			[CONSOLE_ROLE_READ, [] as string[]],
			[CONSOLE_ROLE_WRITE, ['pg_write_all_data']],
		] as const) {
			// INHERIT es obligatorio, no una preferencia: los privilegios de la
			// consola vienen de `pg_read_all_data`, y con NOINHERIT ser miembro
			// no basta —haría falta otro SET ROLE— así que cada lectura moría
			// con "permission denied for table".
			await sql.unsafe(`
				DO $imperium$ BEGIN
					IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
						CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
					END IF;
				END $imperium$
			`);
			// Repara los roles que quedaron con NOINHERIT de una versión previa.
			await sql.unsafe(`ALTER ROLE ${role} INHERIT`);
			for (const predefined of ['pg_read_all_data', ...extra]) {
				await grant_inherited(sql, predefined, role);
			}
			// Sin esto `SET LOCAL ROLE` falla con "permission denied to set role".
			await sql.unsafe(`GRANT ${role} TO CURRENT_USER`);
			// La consola no escribe su propia bitácora: si pudiera, podría
			// borrar el rastro de lo que acaba de hacer.
			await sql.unsafe(
				`REVOKE ALL ON ALL TABLES IN SCHEMA ${DB_ADMIN_SCHEMA} FROM ${role}`,
			);
			await sql.unsafe(
				`REVOKE ALL ON SCHEMA ${DB_ADMIN_SCHEMA} FROM ${role}`,
			);
		}
		restricted_roles = true;
	} catch (err) {
		roles_error = err instanceof Error ? err.message : String(err);
		debug_error(`db-admin: sin roles restringidos — ${roles_error}`);
	}

	const stat_statements = await sql
		.unsafe(
			`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`,
		)
		.then((rows) => (rows as unknown[]).length > 0)
		.catch(() => false);

	cached = { restricted_roles, stat_statements, roles_error };
	return cached;
}

/**
 * Concede una membresía que el rol **hereda** de verdad.
 *
 * Desde PostgreSQL 16 cada membresía lleva su propia opción de herencia,
 * fijada al concederla a partir del `rolinherit` de ese momento. Una membresía
 * concedida cuando el rol era NOINHERIT se queda sin heredar aunque después se
 * haga `ALTER ROLE … INHERIT`: `pg_has_role(rol, grupo, 'USAGE')` sigue en
 * `false` y cada lectura muere con "permission denied for table". Hay que
 * volver a conceder diciéndolo. `WITH INHERIT TRUE` no existe antes de PG16,
 * de ahí el respaldo.
 */
async function grant_inherited(
	sql: Bun.SQL,
	group: string,
	role: string,
): Promise<void> {
	try {
		await sql.unsafe(`GRANT ${group} TO ${role} WITH INHERIT TRUE`);
	} catch {
		await sql.unsafe(`GRANT ${group} TO ${role}`);
	}
}

/** Olvida lo memorizado (las pruebas montan varias bases en un proceso). */
export function reset_db_admin_capabilities(): void {
	cached = null;
}

export type AuditEntry = {
	actor_id?: string | null;
	actor_label?: string | null;
	/** `session` cuando lo pidió una persona, `app` cuando fue el programador. */
	origin: 'session' | 'app';
	source_ip?: string | null;
	operation: string;
	mode?: string | null;
	statement?: string | null;
	target?: string | null;
	row_count?: number | null;
	duration_ms?: number | null;
	succeeded: boolean;
	error?: string | null;
};

/**
 * Deja constancia. Nunca lanza: una bitácora rota no debe convertir una
 * operación que sí ocurrió en un error que el operador lee como "no pasó nada".
 */
export async function write_audit(sql: Bun.SQL, entry: AuditEntry): Promise<void> {
	try {
		await sql.unsafe(
			`INSERT INTO ${DB_ADMIN_SCHEMA}.audit_log
				(actor_id, actor_label, origin, source_ip, operation, mode,
				 statement, target, row_count, duration_ms, succeeded, error)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			[
				entry.actor_id ?? null,
				entry.actor_label ?? null,
				entry.origin,
				entry.source_ip ?? null,
				entry.operation,
				entry.mode ?? null,
				entry.statement ?? null,
				entry.target ?? null,
				entry.row_count ?? null,
				entry.duration_ms ?? null,
				entry.succeeded,
				entry.error ?? null,
			],
		);
	} catch (err) {
		debug_error(
			`db-admin: no se pudo escribir la bitácora — ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * Filtro de texto de la bitácora. Busca donde el operador mira: qué se hizo,
 * quién y con qué sentencia. `null` cuando no hay término, para no pegar un
 * WHERE que siempre es cierto.
 */
function audit_search(term?: string): { clause: string; value: string } | null {
	const needle = (term ?? '').trim();
	if (!needle) return null;
	return {
		clause: `WHERE operation ILIKE $1 OR actor_label ILIKE $1
			 OR statement ILIKE $1 OR target ILIKE $1 OR error ILIKE $1`,
		value: `%${needle}%`,
	};
}

export async function read_audit(
	sql: Bun.SQL,
	opts: { limit?: number; offset?: number; term?: string } = {},
): Promise<Record<string, unknown>[]> {
	const limit = Math.min(Math.max(1, opts.limit ?? 100), 500);
	const offset = Math.max(0, opts.offset ?? 0);
	const search = audit_search(opts.term);
	const rows = search
		? await sql.unsafe(
				`SELECT * FROM ${DB_ADMIN_SCHEMA}.audit_log
			 ${search.clause}
			 ORDER BY created_at DESC, id DESC
			 LIMIT $2 OFFSET $3`,
				[search.value, limit, offset],
			)
		: await sql.unsafe(
				`SELECT * FROM ${DB_ADMIN_SCHEMA}.audit_log
			 ORDER BY created_at DESC, id DESC
			 LIMIT $1 OFFSET $2`,
				[limit, offset],
			);
	return rows as Record<string, unknown>[];
}

/**
 * Cuántas entradas casan con el término. El paginador de la lista necesita el
 * total real: sin él solo sabe cuántas filas trajo la página que está viendo.
 */
export async function count_audit(sql: Bun.SQL, term?: string): Promise<number> {
	const search = audit_search(term);
	const rows = search
		? await sql.unsafe(
				`SELECT COUNT(*)::int AS total FROM ${DB_ADMIN_SCHEMA}.audit_log ${search.clause}`,
				[search.value],
			)
		: await sql.unsafe(`SELECT COUNT(*)::int AS total FROM ${DB_ADMIN_SCHEMA}.audit_log`);
	return Number((rows as Array<{ total?: number }>)[0]?.total ?? 0);
}

/** Una entrada por id, para la vista de detalle. */
export async function read_audit_entry(
	sql: Bun.SQL,
	id: string,
): Promise<Record<string, unknown> | null> {
	const numeric = Number(id);
	if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
	const rows = await sql.unsafe(
		`SELECT * FROM ${DB_ADMIN_SCHEMA}.audit_log WHERE id = $1`,
		[numeric],
	);
	return (rows as Record<string, unknown>[])[0] ?? null;
}
