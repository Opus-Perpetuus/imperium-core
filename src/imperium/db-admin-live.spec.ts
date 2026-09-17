/**
 * Prueba del gestor contra un Postgres de verdad.
 *
 * No está en `yarn test` del núcleo a propósito: necesita una base levantada y
 * la suite del repo tiene que poder correr sin ella. Se lanza a mano cuando se
 * toca el gestor:
 *
 *   DB_ADMIN_TEST_URL=postgres://imperium:imperium@127.0.0.1:5434/imperium_core \
 *     bun test src/imperium/db-admin-live.spec.ts
 *
 * Lo que comprueba no se puede comprobar de otra forma: que el rol restringido
 * impide de verdad `COPY … TO PROGRAM`, que la transacción de solo lectura
 * rechaza un CTE que escribe, y que el tiempo máximo corta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
	ConsoleError,
	run_console_statement,
	type ConsoleActor,
} from './db-admin-console.ts';
import {
	ensure_db_admin_objects,
	read_audit,
	reset_db_admin_capabilities,
	type DbAdminCapabilities,
} from './db-admin-setup.ts';
import { list_schemas, list_tables, read_health } from './db-admin-introspect.ts';
import { build_maintenance_sql, MaintenanceError } from './db-admin-maintenance.ts';

const URL_BASE = process.env.DB_ADMIN_TEST_URL ?? '';
const actor: ConsoleActor = {
	id: 'prueba',
	label: 'prueba@imperium',
	origin: 'session',
	source_ip: '127.0.0.1',
};

let sql: Bun.SQL;
let caps: DbAdminCapabilities;

const suite = URL_BASE ? describe : describe.skip;

suite('gestor contra Postgres real', () => {
	beforeAll(async () => {
		reset_db_admin_capabilities();
		sql = new Bun.SQL(URL_BASE);
		caps = await ensure_db_admin_objects(sql);
		await sql.unsafe('DROP TABLE IF EXISTS db_admin_prueba');
		await sql.unsafe('CREATE TABLE db_admin_prueba (id int primary key, nota text)');
		await sql.unsafe(
			"INSERT INTO db_admin_prueba VALUES (1,'uno'),(2,'dos'),(3,'tres')",
		);
	});

	afterAll(async () => {
		await sql.unsafe('DROP TABLE IF EXISTS db_admin_prueba');
		await sql.end();
	});

	it('crea los roles restringidos', () => {
		expect(caps.restricted_roles).toBe(true);
	});

	it('lee en modo lectura', async () => {
		const out = await run_console_statement(
			sql,
			{ sql: 'SELECT id, nota FROM db_admin_prueba ORDER BY id' },
			caps,
			actor,
		);
		expect(out.columns).toEqual(['id', 'nota']);
		expect(out.rows).toEqual([
			[1, 'uno'],
			[2, 'dos'],
			[3, 'tres'],
		]);
		expect(out.limited).toBe(true);
	});

	it('el rol de la consola no puede ejecutar programas del servidor', async () => {
		// Este es el agujero que convierte una consola SQL en ejecución de
		// comandos dentro del contenedor de Postgres.
		await expect(
			run_console_statement(
				sql,
				{ sql: "COPY (SELECT 1) TO PROGRAM 'touch /tmp/imperium-rce'", mode: 'write' },
				caps,
				actor,
			),
		).rejects.toThrow(/permission denied|permiso/i);
	});

	it('la transacción de solo lectura rechaza un CTE que escribe aunque pase el clasificador', async () => {
		// Se fuerza modo escritura para que el clasificador no lo pare y sea
		// Postgres quien lo rechace... salvo que el clasificador ya lo vea.
		const statement =
			'WITH x AS (DELETE FROM db_admin_prueba RETURNING *) SELECT * FROM x';
		await expect(
			run_console_statement(sql, { sql: statement, mode: 'read' }, caps, actor),
		).rejects.toThrow(/escribe|read-only|only/i);
		const quedan = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM db_admin_prueba',
		)) as Array<{ n: number }>;
		expect(quedan[0]!.n).toBe(3);
	});

	it('rechaza varias sentencias en un envío', async () => {
		await expect(
			run_console_statement(
				sql,
				{ sql: 'SELECT 1; DROP TABLE db_admin_prueba' },
				caps,
				actor,
			),
		).rejects.toThrow(/una sentencia a la vez/i);
		const existe = (await sql.unsafe(
			"SELECT to_regclass('db_admin_prueba') IS NOT NULL AS hay",
		)) as Array<{ hay: boolean }>;
		expect(existe[0]!.hay).toBe(true);
	});

	it('pide confirmación para un UPDATE sin WHERE', async () => {
		const attempt = run_console_statement(
			sql,
			{ sql: "UPDATE db_admin_prueba SET nota = 'x'", mode: 'write' },
			caps,
			actor,
		);
		await expect(attempt).rejects.toThrow(/CONFIRMO/);
		await expect(attempt).rejects.toBeInstanceOf(ConsoleError);
		const intactas = (await sql.unsafe(
			"SELECT count(*)::int AS n FROM db_admin_prueba WHERE nota <> 'x'",
		)) as Array<{ n: number }>;
		expect(intactas[0]!.n).toBe(3);
	});

	it('el ensayo dice cuántas filas tocaría y no deja el cambio', async () => {
		const out = await run_console_statement(
			sql,
			{
				sql: "UPDATE db_admin_prueba SET nota = 'ensayo'",
				mode: 'write',
				dry_run: true,
			},
			caps,
			actor,
		);
		expect(out.row_count).toBe(3);
		const sin_tocar = (await sql.unsafe(
			"SELECT count(*)::int AS n FROM db_admin_prueba WHERE nota = 'ensayo'",
		)) as Array<{ n: number }>;
		expect(sin_tocar[0]!.n).toBe(0);
	});

	it('escribe de verdad cuando se confirma', async () => {
		const out = await run_console_statement(
			sql,
			{
				sql: "UPDATE db_admin_prueba SET nota = 'ok' WHERE id = 1",
				mode: 'write',
			},
			caps,
			actor,
		);
		expect(out.row_count).toBe(1);
		const fila = (await sql.unsafe(
			'SELECT nota FROM db_admin_prueba WHERE id = 1',
		)) as Array<{ nota: string }>;
		expect(fila[0]!.nota).toBe('ok');
	});

	it('el rol de escritura no puede alterar la estructura', async () => {
		await expect(
			run_console_statement(
				sql,
				{ sql: 'ALTER TABLE db_admin_prueba ADD COLUMN x int', mode: 'write' },
				caps,
				actor,
			),
		).rejects.toThrow(/Estructura|DDL/i);
	});

	it('EXPLAIN a secas no ejecuta la consulta', async () => {
		const out = await run_console_statement(
			sql,
			{ sql: 'SELECT * FROM db_admin_prueba', explain: { analyze: false } },
			caps,
			actor,
		);
		expect(out.rows.map((r) => String(r[0])).join(' ')).toMatch(/Scan/i);
		expect(out.notices.join(' ')).toMatch(/no se ejecutó/i);
	});

	it('EXPLAIN ANALYZE no sirve para colar una escritura', async () => {
		// `EXPLAIN ANALYZE` ejecuta de verdad: servido fuera del camino guardado
		// sería un borrado con el rol del núcleo disfrazado de "ver el plan".
		await expect(
			run_console_statement(
				sql,
				{
					sql: 'DELETE FROM db_admin_prueba',
					mode: 'write',
					explain: { analyze: true },
				},
				caps,
				actor,
			),
		).rejects.toThrow(/ejecutaría de verdad/i);
		const quedan = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM db_admin_prueba',
		)) as Array<{ n: number }>;
		expect(quedan[0]!.n).toBe(3);
	});

	it('EXPLAIN ANALYZE de una lectura corre en solo lectura', async () => {
		const out = await run_console_statement(
			sql,
			{
				sql: 'SELECT count(*) FROM db_admin_prueba',
				explain: { analyze: true },
			},
			caps,
			actor,
		);
		expect(out.rows.map((r) => String(r[0])).join(' ')).toMatch(
			/actual time|Execution Time/i,
		);
	});

	it('un CTE que escribe tampoco pasa por la puerta del plan', async () => {
		await expect(
			run_console_statement(
				sql,
				{
					sql: 'WITH x AS (DELETE FROM db_admin_prueba RETURNING *) SELECT * FROM x',
					mode: 'write',
					explain: { analyze: true },
				},
				caps,
				actor,
			),
		).rejects.toThrow(/ejecutaría de verdad/i);
		const quedan = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM db_admin_prueba',
		)) as Array<{ n: number }>;
		expect(quedan[0]!.n).toBe(3);
	});

	it('corta por tiempo', async () => {
		await expect(
			run_console_statement(
				sql,
				{ sql: 'SELECT pg_sleep(5)', timeout_ms: 1_000 },
				caps,
				actor,
			),
		).rejects.toThrow(/tiempo/i);
	});

	it('deja rastro en la bitácora', async () => {
		await run_console_statement(
			sql,
			{ sql: 'SELECT 1 AS marca_bitacora' },
			caps,
			actor,
		);
		const filas = await read_audit(sql, { limit: 20 });
		const mia = filas.find((f) =>
			String(f.statement ?? '').includes('marca_bitacora'),
		);
		expect(mia).toBeDefined();
		expect(mia!.actor_label).toBe('prueba@imperium');
		expect(mia!.succeeded).toBe(true);
	});

	it('la bitácora también guarda los fallos', async () => {
		await run_console_statement(sql, { sql: 'SELECT fallo_a_proposito()' }, caps, actor).catch(
			() => null,
		);
		const filas = await read_audit(sql, { limit: 20 });
		const mia = filas.find((f) =>
			String(f.statement ?? '').includes('fallo_a_proposito'),
		);
		expect(mia).toBeDefined();
		expect(mia!.succeeded).toBe(false);
		expect(String(mia!.error)).toMatch(/fallo_a_proposito/);
	});

	it('lista esquemas y tablas con tamaños', async () => {
		const schemas = await list_schemas(sql);
		expect(schemas.some((s) => s.schema === 'public')).toBe(true);
		const tables = await list_tables(sql, 'public');
		const mine = tables.find((t) => t.name === 'db_admin_prueba');
		expect(mine).toBeDefined();
		expect(mine!.total_bytes).toBeGreaterThan(0);
	});

	it('el panel de salud responde entero', async () => {
		const health = await read_health(sql);
		expect(health.server).toBeTruthy();
		expect(Number(health.database_bytes)).toBeGreaterThan(0);
		expect(Array.isArray(health.invalid_indexes)).toBe(true);
		expect(health.connections).toBeTruthy();
	});

	it('el mantenimiento reescribe el objetivo desde el catálogo', async () => {
		const built = await build_maintenance_sql(sql, {
			op: 'reindex_table',
			target: 'db_admin_prueba',
		});
		expect(built.statement).toBe('REINDEX TABLE "public"."db_admin_prueba"');
	});

	it('el mantenimiento rechaza un objetivo que no existe', async () => {
		await expect(
			build_maintenance_sql(sql, { op: 'vacuum', target: 'no_existe_jamas' }),
		).rejects.toBeInstanceOf(MaintenanceError);
	});

	it('el mantenimiento no toca los catálogos del sistema', async () => {
		await expect(
			build_maintenance_sql(sql, { op: 'vacuum_full', target: 'pg_catalog.pg_class' }),
		).rejects.toThrow(/sistema/i);
	});

	it('el mantenimiento no se deja inyectar por el nombre', async () => {
		await expect(
			build_maintenance_sql(sql, {
				op: 'vacuum',
				target: 'db_admin_prueba"; DROP TABLE db_admin_prueba; --',
			}),
		).rejects.toBeInstanceOf(MaintenanceError);
	});
});
