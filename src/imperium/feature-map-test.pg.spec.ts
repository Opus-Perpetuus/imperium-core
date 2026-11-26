/**
 * `feature_map_test` contra un Postgres real. Corre solo con
 * FEATURE_MAP_TEST_PG_URL (una base desechable: la vacía y la llena):
 *
 *   FEATURE_MAP_TEST_PG_URL=postgres://postgres@127.0.0.1:55433/fmt bun test src/imperium/feature-map-test.pg.spec.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { handle_service_plane, ensure_svc_tables } from '../service-plane.ts';
import { ensure_session_table } from './auth.ts';
import {
	ensure_feature_map_test_columns,
	feature_map_test_summary,
	purge_feature_map_test,
	run_with_feature_map_test,
} from './feature-map-test.ts';
import { open_core_sql } from './sql-client.ts';

const URL_PG = process.env.FEATURE_MAP_TEST_PG_URL ?? '';
const d = URL_PG ? describe : describe.skip;

d('feature_map_test en Postgres real', () => {
	// Una sola conexión: si la marca se filtrara entre consultas, aquí se vería.
	let sql: Bun.SQL;
	const marked = (schema: string, table: string, id: string) =>
		sql.unsafe(`SELECT feature_map_test AS m FROM "${schema}"."${table}" WHERE id = $1`, [id]).then((r) => (r as Array<{ m: boolean }>)[0]?.m);

	beforeAll(async () => {
		sql = open_core_sql(URL_PG, { max: 1 });
		for (const s of ['subject_configuracion', 'tenant_demo', 'subject_pos']) await sql.unsafe(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
		for (const t of ['imperium_sessions', 'imperium_auth_rate_limits', 'subject_history', 'subject_params', 'subject_counters', 'notificaciones'])
			await sql.unsafe(`DROP TABLE IF EXISTS public.${t} CASCADE`);
		// Tablas del núcleo con sus CREATE reales.
		await ensure_session_table(sql);
		await ensure_svc_tables(sql);
		// Tablas viejas sin la columna (o con el DEFAULT false de la primera versión).
		await sql.unsafe(`CREATE SCHEMA subject_configuracion`);
		await sql.unsafe(`CREATE TABLE subject_configuracion.user_management (id TEXT PRIMARY KEY, name TEXT, ref TEXT, email TEXT, payload JSONB DEFAULT '{}')`);
		await sql.unsafe(`CREATE SCHEMA tenant_demo`);
		await sql.unsafe(`CREATE TABLE tenant_demo.items (id TEXT PRIMARY KEY, name TEXT, feature_map_test BOOLEAN NOT NULL DEFAULT false)`);
		await sql.unsafe(`CREATE TABLE public.notificaciones (id TEXT PRIMARY KEY, texto TEXT)`);
		await sql.unsafe(`CREATE SCHEMA subject_pos`);
		await sql.unsafe(`CREATE TABLE subject_pos.ventas (id TEXT PRIMARY KEY)`);
		await sql.unsafe(`CREATE TABLE subject_pos.lineas (id TEXT PRIMARY KEY, venta_id TEXT REFERENCES subject_pos.ventas(id) ON DELETE CASCADE)`);
		await sql.unsafe(`INSERT INTO tenant_demo.items (id, name) VALUES ('real-viejo', 'ya existía')`);
		await sql.unsafe(`INSERT INTO subject_configuracion.user_management (id, name, ref, email) VALUES ('admin', 'Admin', 'user-menu-management-0', 'admin@municipio.gob.mx')`);
	});

	afterAll(async () => {
		await sql?.close();
	});

	test('todas las tablas (public, apps y tenant) quedan con la columna y el DEFAULT que marca', async () => {
		await ensure_feature_map_test_columns(sql);
		const rows = (await sql.unsafe(`
			SELECT n.nspname || '.' || c.relname AS t, pg_get_expr(ad.adbin, ad.adrelid) AS def
			  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			  LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'feature_map_test'
			  LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
			 WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`)) as Array<{ t: string; def: string | null }>;
		expect(rows.length).toBeGreaterThanOrEqual(9);
		for (const r of rows) expect([r.t, r.def ?? '']).toEqual([r.t, expect.stringContaining('imperium.feature_map_test')]);
		expect(await marked('tenant_demo', 'items', 'real-viejo')).toBe(false);
		// Idempotente.
		expect(await ensure_feature_map_test_columns(sql)).toBe(0);
	});

	test('fuera de una corrida nada se marca; dentro se marca todo INSERT, aunque sea SQL a mano', async () => {
		await sql.unsafe(`INSERT INTO public.notificaciones (id, texto) VALUES ('n-real', 'real')`);
		await run_with_feature_map_test(true, async () => {
			await sql.unsafe(`INSERT INTO public.notificaciones (id, texto) VALUES ($1, 'prueba')`, ['n-test']);
			await sql`INSERT INTO tenant_demo.items (id, name) VALUES (${'i-test'}, ${'QA-IA'})`;
			await sql.begin(async (tx) => {
				await tx.unsafe(`INSERT INTO subject_pos.ventas (id) VALUES ('v-test'), ('v-test2')`);
				await tx.unsafe(`INSERT INTO subject_pos.lineas (id, venta_id) VALUES ('l-test', 'v-test')`);
			});
			// Historial: el INSERT especializado del plano de servicios.
			const res = await handle_service_plane(sql, () => true, new Request('http://x/history', {
				method: 'POST', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ resource: 'ventas', action: 'create', record_id: 'v-test' }),
			}), 'subject-pos', '/history');
			expect(res.status).toBeLessThan(300);
			// Sesión: el mismo INSERT de auth.create_session.
			await sql.unsafe(`INSERT INTO public.imperium_sessions (id, payload, expires_at) VALUES ('s-test', '{}'::jsonb, now() + interval '1 day')`);
			// Cuentas creadas en la corrida: una ia.* y una con correo real.
			await sql.unsafe(`INSERT INTO subject_configuracion.user_management (id, name, email) VALUES ('ia', 'IA cajero', 'ia.cajero@qa.imperium.test'), ('real-en-corrida', 'Persona', 'persona@cliente.mx')`);
			// Consecutivo (tabla de estructura).
			await sql.unsafe(`INSERT INTO public.subject_counters (technical_id, name, n) VALUES ('subject-pos', 'turno', 1)`);
		});
		// Lo que entra después por la misma conexión ya no se marca.
		await sql.unsafe(`INSERT INTO public.notificaciones (id, texto) VALUES ('n-real2', 'real')`);
		await sql.unsafe(`INSERT INTO subject_pos.ventas (id) VALUES ('v-real')`);
		await sql.unsafe(`INSERT INTO subject_pos.lineas (id, venta_id) VALUES ('l-real', 'v-test2')`);
		expect(await marked('public', 'notificaciones', 'n-test')).toBe(true);
		expect(await marked('public', 'notificaciones', 'n-real')).toBe(false);
		expect(await marked('public', 'notificaciones', 'n-real2')).toBe(false);
		expect(await marked('tenant_demo', 'items', 'i-test')).toBe(true);
		expect(await marked('subject_pos', 'lineas', 'l-test')).toBe(true);
		expect(await marked('public', 'imperium_sessions', 's-test')).toBe(true);
		const hist = (await sql.unsafe(`SELECT feature_map_test AS m FROM public.subject_history`)) as Array<{ m: boolean }>;
		expect(hist.map((h) => h.m)).toEqual([true]);
		const summary = await feature_map_test_summary(sql);
		expect(summary.total).toBe(10);
	});

	test('la purga borra lo de prueba, nunca al admin semilla ni cuentas o filas reales', async () => {
		// Aunque el admin semilla quedara marcado (p. ej. a mano), no se borra.
		await sql.unsafe(`UPDATE subject_configuracion.user_management SET feature_map_test = true WHERE id = 'admin'`);
		const r = await purge_feature_map_test(sql, { account_tables: ['subject_configuracion.user_management'] });
		const left = (q: string) => sql.unsafe(q).then((rows) => (rows as Array<{ id: string }>).map((x) => x.id).sort());
		expect(await left(`SELECT id FROM public.notificaciones`)).toEqual(['n-real', 'n-real2']);
		expect(await left(`SELECT id FROM tenant_demo.items`)).toEqual(['real-viejo']);
		expect(await left(`SELECT id FROM subject_pos.ventas`)).toEqual(['v-real', 'v-test2']);
		expect(await left(`SELECT id FROM subject_pos.lineas`)).toEqual(['l-real']);
		expect(await left(`SELECT id FROM public.imperium_sessions`)).toEqual([]);
		expect(await left(`SELECT id FROM public.subject_history`)).toEqual([]);
		// La cuenta semilla del bot (ia.cajero) se queda y sale desmarcada (Lupo, 2026-11-18).
		expect(await left(`SELECT id FROM subject_configuracion.user_management`)).toEqual(['admin', 'ia', 'real-en-corrida']);
		expect(await marked('subject_configuracion', 'user_management', 'ia')).toBe(false);
		expect(r.kept_accounts).toEqual([{ table: 'subject_configuracion.user_management', rows: 1 }]);
		expect(r.blocked.map((b) => b.table).sort()).toEqual(['subject_configuracion.user_management', 'subject_pos.ventas']);
		expect(r.protected).toEqual([{ table: 'public.subject_counters', rows: 1 }]);
		expect(r.total).toBe(6);
	});
});
