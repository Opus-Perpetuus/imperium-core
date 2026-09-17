/**
 * Ejecuta el SQL que escribe una persona en la consola del gestor.
 *
 * Toda la seguridad la pone Postgres, no el análisis del texto: cada sentencia
 * corre en su propia transacción con `SET LOCAL ROLE` a un rol restringido y,
 * en lectura, `SET TRANSACTION READ ONLY`. Un `WITH x AS (DELETE …)` disfrazado
 * de consulta falla en el ejecutor aunque el clasificador se hubiera equivocado.
 * El clasificador (`db-admin-sql.ts`) solo sirve para avisar y para la bitácora.
 */
import {
	apply_row_limit,
	classify_statement,
	split_statements,
	type StatementKind,
} from './db-admin-sql.ts';
import {
	CONSOLE_ROLE_READ,
	CONSOLE_ROLE_WRITE,
	write_audit,
	type DbAdminCapabilities,
} from './db-admin-setup.ts';

export type ConsoleMode = 'read' | 'write' | 'ddl';

/** Palabra exacta que hay que teclear para lo irreversible. */
export const CONFIRM_WORD = 'CONFIRMO';

export const DEFAULT_ROW_LIMIT = 500;
export const MAX_ROW_LIMIT = 5000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;

export type ConsoleRequest = {
	sql: string;
	/**
	 * Envuelve la sentencia en `EXPLAIN` antes de ejecutarla.
	 *
	 * `EXPLAIN` a secas no corre la consulta; `EXPLAIN ANALYZE` **sí la corre**,
	 * y por eso pasa por aquí y no por una ruta aparte: un `EXPLAIN ANALYZE
	 * DELETE …` servido fuera de este camino borraría filas de verdad con el rol
	 * del núcleo, saltándose el rol restringido, la transacción de solo lectura,
	 * el límite de tiempo y la bitácora.
	 */
	explain?: { analyze: boolean };
	mode?: ConsoleMode;
	limit?: number;
	timeout_ms?: number;
	/** `CONFIRMO` para DDL y para escrituras sin `WHERE`. */
	confirm?: string;
	/** Corre y deshace: dice cuántas filas tocaría sin dejar el cambio. */
	dry_run?: boolean;
};

export type ConsoleResult = {
	command: string;
	kind: StatementKind;
	mode: ConsoleMode;
	columns: string[];
	rows: unknown[][];
	row_count: number;
	duration_ms: number;
	/** Se añadió un `LIMIT` que el operador no escribió. */
	limited: boolean;
	dry_run: boolean;
	notices: string[];
};

export class ConsoleError extends Error {
	readonly status: number;
	readonly code: string;
	readonly needs_confirmation: boolean;

	constructor(
		message: string,
		opts: { status?: number; code?: string; needs_confirmation?: boolean } = {},
	) {
		super(message);
		this.status = opts.status ?? 400;
		this.code = opts.code ?? 'db_admin_console';
		this.needs_confirmation = opts.needs_confirmation ?? false;
	}
}

/** Sentinela para salir de `sql.begin` deshaciendo sin que parezca un fallo. */
const ROLLBACK = Symbol('imperium.dry_run');

export type ConsoleActor = {
	id?: string | null;
	label?: string | null;
	origin: 'session' | 'app';
	source_ip?: string | null;
};

export async function run_console_statement(
	sql: Bun.SQL,
	request: ConsoleRequest,
	caps: DbAdminCapabilities,
	actor: ConsoleActor,
): Promise<ConsoleResult> {
	const mode: ConsoleMode = request.mode ?? 'read';
	const notices: string[] = [];

	const statements = split_statements(String(request.sql ?? ''));
	if (statements.length === 0) {
		throw new ConsoleError('No escribiste ninguna sentencia.');
	}
	if (statements.length > 1) {
		// Aceptar varias sentencias haría que un `;` colado al final de una
		// consulta se ejecutara sin que nadie lo leyera.
		throw new ConsoleError(
			`Manda una sentencia a la vez; llegaron ${statements.length}. ` +
				'Ejecuta cada una por separado.',
			{ code: 'varias_sentencias' },
		);
	}

	const parsed = classify_statement(statements[0]!);
	if (parsed.kind === 'empty') {
		throw new ConsoleError('No escribiste ninguna sentencia.');
	}
	if (parsed.kind === 'transaction') {
		throw new ConsoleError(
			'La consola maneja la transacción por ti: no mandes BEGIN, COMMIT ni ROLLBACK. ' +
				'Usa "ensayo" para ver el efecto sin dejarlo.',
			{ code: 'transaccion_manual' },
		);
	}

	if (parsed.kind === 'dml' && mode === 'read') {
		throw new ConsoleError(
			`"${parsed.command}" escribe. Cambia el modo a Escritura para ejecutarlo.`,
			{ code: 'modo_insuficiente' },
		);
	}
	if (parsed.kind === 'ddl' && mode !== 'ddl') {
		throw new ConsoleError(
			`"${parsed.command}" altera la estructura de la base. ` +
				'Cambia el modo a Estructura (DDL) para ejecutarlo.',
			{ code: 'modo_insuficiente' },
		);
	}
	if (mode !== 'read' && !caps.restricted_roles) {
		throw new ConsoleError(
			'No hay roles restringidos en esta base, así que la consola solo permite lectura. ' +
				`Detalle: ${caps.roles_error ?? 'desconocido'}`,
			{ status: 409, code: 'sin_roles' },
		);
	}

	// `EXPLAIN ANALYZE` ejecuta: solo se permite sobre lecturas, y aun así corre
	// en la transacción de solo lectura como cualquier otra.
	if (request.explain?.analyze && parsed.kind !== 'read') {
		throw new ConsoleError(
			`"${parsed.command}" escribe, y medir el plan con ANALYZE lo ejecutaría de verdad. ` +
				'Usa el modo ensayo, que corre y deshace.',
			{ code: 'explain_analyze_escribe' },
		);
	}

	const confirmed = String(request.confirm ?? '').trim().toUpperCase() === CONFIRM_WORD;
	if (parsed.unbounded_write && !confirmed && !request.dry_run) {
		throw new ConsoleError(
			`Ese ${parsed.command} no tiene WHERE: afecta a TODAS las filas. ` +
				`Escribe ${CONFIRM_WORD} para confirmar, o pruébalo en modo ensayo.`,
			{ code: 'escritura_sin_where', needs_confirmation: true },
		);
	}
	if (mode === 'ddl' && !confirmed && !request.dry_run) {
		throw new ConsoleError(
			`Los cambios de estructura no se deshacen solos. Escribe ${CONFIRM_WORD} para confirmar.`,
			{ code: 'ddl_sin_confirmar', needs_confirmation: true },
		);
	}

	const limit = clamp(request.limit ?? DEFAULT_ROW_LIMIT, 1, MAX_ROW_LIMIT);
	const timeout_ms = clamp(
		request.timeout_ms ?? DEFAULT_TIMEOUT_MS,
		1_000,
		MAX_TIMEOUT_MS,
	);
	let final_sql: string;
	if (request.explain) {
		const options = request.explain.analyze
			? 'ANALYZE, BUFFERS, VERBOSE, COSTS, FORMAT TEXT'
			: 'VERBOSE, COSTS, FORMAT TEXT';
		final_sql = `EXPLAIN (${options}) ${parsed.sql}`;
		notices.push(
			request.explain.analyze
				? 'ANALYZE ejecuta la consulta para medirla; corrió en solo lectura.'
				: 'Plan estimado: la consulta no se ejecutó.',
		);
	} else {
		final_sql = apply_row_limit(parsed, limit);
		if (parsed.needs_limit) {
			notices.push(`Se añadió LIMIT ${limit}: pueden faltar filas.`);
		}
	}
	if (request.dry_run && parsed.kind !== 'read') {
		notices.push('Ensayo: el cambio se deshizo al terminar.');
	}

	const read_only = mode === 'read' || Boolean(request.explain);
	const role =
		read_only
			? CONSOLE_ROLE_READ
			: mode === 'write'
				? CONSOLE_ROLE_WRITE
				: null;

	const started = Date.now();
	// En un objeto y no en una variable suelta: la asignación ocurre dentro del
	// callback de `sql.begin` y el análisis de flujo no la ve.
	const box: { result: ConsoleResult | null } = { result: null };
	let failure: unknown = null;

	try {
		await sql.begin(async (tx) => {
			await tx.unsafe(`SET LOCAL statement_timeout = ${timeout_ms}`);
			await tx.unsafe(`SET LOCAL lock_timeout = ${Math.min(timeout_ms, 5_000)}`);
			await tx.unsafe(
				`SET LOCAL idle_in_transaction_session_timeout = ${timeout_ms + 5_000}`,
			);
			// Neutraliza el search_path heredado: una función `SECURITY DEFINER`
			// puede ser secuestrada por un esquema que se cuele antes
			// (CVE-2018-1058).
			await tx.unsafe(`SET LOCAL search_path = pg_catalog, public`);
			if (role && caps.restricted_roles) {
				await tx.unsafe(`SET LOCAL ROLE ${role}`);
			}
			if (read_only) {
				await tx.unsafe('SET TRANSACTION READ ONLY');
			}

			const rows = (await tx.unsafe(final_sql)) as Array<Record<string, unknown>> & {
				count?: number;
				command?: string;
			};
			const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

			box.result = {
				command: String(rows.command ?? parsed.command),
				kind: parsed.kind,
				mode,
				columns,
				rows: rows.map((row) => columns.map((c) => row[c] ?? null)),
				row_count: typeof rows.count === 'number' ? rows.count : rows.length,
				duration_ms: Date.now() - started,
				limited: parsed.needs_limit,
				dry_run: Boolean(request.dry_run),
				notices,
			};

			if (request.dry_run) throw ROLLBACK;
		});
	} catch (err) {
		if (err !== ROLLBACK) failure = err;
	}

	await write_audit(sql, {
		actor_id: actor.id ?? null,
		actor_label: actor.label ?? null,
		origin: actor.origin,
		source_ip: actor.source_ip ?? null,
		operation: request.explain
			? `consola.plan${request.explain.analyze ? '.analyze' : ''}`
			: request.dry_run
				? 'consola.ensayo'
				: 'consola',
		mode,
		statement: parsed.sql,
		target: null,
		row_count: box.result?.row_count ?? null,
		duration_ms: Date.now() - started,
		succeeded: !failure,
		error: failure ? message_of(failure) : null,
	});

	if (failure) throw as_console_error(failure);
	if (!box.result) {
		throw new ConsoleError('La sentencia no devolvió nada.', { status: 500 });
	}
	return box.result;
}

function clamp(value: number, low: number, high: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return low;
	return Math.min(high, Math.max(low, Math.trunc(n)));
}

function message_of(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Traduce los errores de Postgres que el operador va a ver seguido.
 *
 * `57014` llega como "canceling statement due to statement timeout", que no
 * dice cuál era el límite ni que lo puso la consola.
 */
function as_console_error(err: unknown): ConsoleError {
	const errno = String((err as { errno?: unknown }).errno ?? '');
	const raw = message_of(err);
	if (errno === '57014') {
		return new ConsoleError(
			`Se acabó el tiempo y la consulta se canceló. Acótala o sube el límite de tiempo. (${raw})`,
			{ code: 'tiempo_agotado' },
		);
	}
	if (errno === '25006') {
		return new ConsoleError(
			`La transacción es de solo lectura: esa sentencia escribe. Cambia el modo. (${raw})`,
			{ code: 'solo_lectura' },
		);
	}
	if (errno === '42501') {
		return new ConsoleError(
			`El rol de la consola no tiene ese permiso — es a propósito. (${raw})`,
			{ code: 'sin_permiso', status: 403 },
		);
	}
	return new ConsoleError(raw, { code: 'error_sql' });
}
