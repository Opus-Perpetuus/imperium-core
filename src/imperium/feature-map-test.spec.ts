import { describe, expect, test } from 'bun:test';
import {
	ensure_feature_map_test_columns,
	FEATURE_MAP_TEST_COLUMN,
	FEATURE_MAP_TEST_HEADER,
	feature_map_test_delete_order,
	feature_map_test_requested,
	feature_map_test_summary,
	in_feature_map_test,
	mark_feature_map_test_row,
	purge_feature_map_test,
	run_with_feature_map_test,
} from './feature-map-test.ts';
import { handle_feature_map_test, is_feature_map_test_path } from './feature-map-test-http.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

/** Postgres de mentira: tablas con filas `{ id, feature_map_test }` y FKs hijo → padre. */
function fake_pg(seed: Record<string, Array<{ id: string; feature_map_test?: boolean; parent?: string }>>, fks: Array<[string, string]> = []) {
	const tables = new Map(Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
	const log: string[] = [];
	const key_of = (sql: string) => {
		const m = /"([^"]+)"\."([^"]+)"/.exec(sql);
		return m ? `${m[1]}.${m[2]}` : '';
	};
	return {
		log,
		tables,
		async unsafe(sql: string): Promise<unknown[]> {
			log.push(sql.replace(/\s+/g, ' ').trim());
			if (/LEFT JOIN pg_attrdef/.test(sql)) {
				return [...tables.keys()]
					.filter((k) => tables.get(k)!.some((r) => !(FEATURE_MAP_TEST_COLUMN in r)))
					.map((k) => ({ schema: k.split('.')[0], table: k.split('.')[1], has: false, marks: false }));
			}
			if (/WHERE EXISTS \(SELECT 1 FROM pg_attribute/.test(sql)) {
				return [...tables.keys()].map((k) => ({ schema: k.split('.')[0], table: k.split('.')[1] }));
			}
			if (/FROM pg_constraint/.test(sql) && !/array_agg/.test(sql)) return fks.map(([child, parent]) => ({ child, parent }));
			if (/^\s*ALTER TABLE/.test(sql)) {
				for (const r of tables.get(key_of(sql)) ?? []) r.feature_map_test ??= false;
				return [];
			}
			if (/SELECT count\(\*\)/.test(sql)) {
				return [{ n: (tables.get(key_of(sql)) ?? []).filter((r) => r.feature_map_test === true).length }];
			}
			if (/^\s*DELETE FROM/.test(sql)) {
				const key = key_of(sql);
				const rows = tables.get(key) ?? [];
				// NOT EXISTS: una fila que algún hijo todavía referencia se queda.
				const referenced = (id: string) =>
					fks.some(([child, parent]) => parent === key && (tables.get(child) ?? []).some((c) => c.parent === id));
				const doomed = rows.filter((r) => r.feature_map_test === true && !referenced(r.id));
				tables.set(key, rows.filter((r) => !doomed.includes(r)));
				return doomed.map((r) => ({ id: r.id }));
			}
			return [];
		},
	};
}

describe('cabecera y contexto de prueba', () => {
	test('la cabecera activa la marca', () => {
		expect(feature_map_test_requested(new Headers({ [FEATURE_MAP_TEST_HEADER]: '1' }))).toBe(true);
		expect(feature_map_test_requested(new Headers({ [FEATURE_MAP_TEST_HEADER]: 'true' }))).toBe(true);
		expect(feature_map_test_requested(new Headers({ [FEATURE_MAP_TEST_HEADER]: '0' }))).toBe(false);
		expect(feature_map_test_requested(new Headers())).toBe(false);
		expect(feature_map_test_requested(null)).toBe(false);
	});

	test('el contexto vive solo dentro de la petición (también tras await)', async () => {
		expect(in_feature_map_test()).toBe(false);
		await run_with_feature_map_test(true, async () => {
			await Promise.resolve();
			expect(in_feature_map_test()).toBe(true);
			expect(mark_feature_map_test_row({ a: 1 })).toEqual({ a: 1, feature_map_test: true });
		});
		await run_with_feature_map_test(false, async () => {
			expect(mark_feature_map_test_row({ a: 1 })).toEqual({ a: 1 });
		});
		expect(in_feature_map_test()).toBe(false);
	});
});

describe('columna feature_map_test en todas las tablas', () => {
	test('agrega la columna a las tablas que no la tienen', async () => {
		const pg = fake_pg({ 'subject_pos.ventas': [{ id: 'v1' }], 'subject_core.user': [{ id: 'u1', feature_map_test: false }] });
		expect(await ensure_feature_map_test_columns(pg)).toBe(1);
		expect(pg.log.some((l) => l.includes('ALTER TABLE "subject_pos"."ventas" ADD COLUMN IF NOT EXISTS feature_map_test BOOLEAN NOT NULL DEFAULT COALESCE(current_setting(\'imperium.feature_map_test\', true) = \'on\', false)'))).toBe(true);
		expect(pg.log.some((l) => l.includes('"subject_core"."user" ADD COLUMN'))).toBe(false);
	});

	test('todo CREATE TABLE de Postgres del núcleo (public, db_admin, apps) nace con la columna', async () => {
		const root = new URL('../', import.meta.url).pathname;
		const glob = new Bun.Glob('**/*.ts');
		let seen = 0;
		for await (const rel of glob.scan(root)) {
			if (rel.endsWith('.spec.ts') || rel.includes('offline/') || rel.includes('node_modules')) continue;
			const src = await Bun.file(root + rel).text();
			for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+(?:\$\{[^}]+\}|[^\s($]+)(?:\.(?:\$\{[^}]+\}|[^\s(]+))?\s*\(/g)) {
				let depth = 0;
				let j = m.index! + m[0].length - 1;
				for (; j < src.length; j++) {
					if (src[j] === '(') depth++;
					else if (src[j] === ')' && --depth === 0) break;
				}
				const body = src.slice(m.index!, j);
				seen++;
				expect([rel, body.includes('FEATURE_MAP_TEST_COLUMN_DDL')]).toEqual([rel, true]);
			}
		}
		expect(seen).toBeGreaterThanOrEqual(20);
	});

	test('el marcado se enciende solo en sentencias que insertan', async () => {
		const { feature_map_test_inserts } = await import('./feature-map-test.ts');
		expect(feature_map_test_inserts('INSERT INTO public.imperium_sessions (id) VALUES ($1)')).toBe(true);
		expect(feature_map_test_inserts('WITH x AS (SELECT 1) insert into "s"."t" SELECT * FROM x')).toBe(true);
		expect(feature_map_test_inserts('MERGE INTO t USING s ON true WHEN NOT MATCHED THEN INSERT VALUES (1)')).toBe(true);
		expect(feature_map_test_inserts('SELECT * FROM t WHERE note = 1 -- insert into')).toBe(false);
		expect(feature_map_test_inserts('UPDATE t SET a = 1')).toBe(false);
	});

	test('el cliente SQL del núcleo enciende la variable de transacción en las corridas', async () => {
		const src = await Bun.file(new URL('./sql-client.ts', import.meta.url)).text();
		expect(src).toContain('await tx.unsafe(FEATURE_MAP_TEST_SET_LOCAL)');
		expect(src).toMatch(/in_feature_map_test\(\) && feature_map_test_inserts\(query\)/);
		const { FEATURE_MAP_TEST_SET_LOCAL } = await import('./feature-map-test.ts');
		// `true` = SET LOCAL: muere con la transacción y no se filtra a otra consulta del pool.
		expect(FEATURE_MAP_TEST_SET_LOCAL).toBe("SELECT set_config('imperium.feature_map_test', 'on', true)");
	});

	test('la purga nunca borra al admin semilla y en cuentas solo correos de prueba', async () => {
		const { delete_marked_sql } = await import('./feature-map-test.ts');
		const plain = delete_marked_sql({ schema: 'public', table: 'notas' }, [], '1');
		expect(plain).toContain("<> 'user-menu-management-0'");
		expect(plain).not.toContain("LIKE '%.test'");
		const accounts = delete_marked_sql({ schema: 'subject_configuracion', table: 'user_management' }, [], '1', { account_table: true });
		expect(accounts).toContain("LIKE '%.test'");
		expect(accounts).toContain("@example\\.(com|org|net)$");
	});

	test('la purga nunca borra las cuentas semilla de los bots (ia.*@qa.imperium.test): las desmarca', async () => {
		const { delete_marked_sql, unmark_bot_accounts_sql } = await import('./feature-map-test.ts');
		const t = { schema: 'subject_configuracion', table: 'user_management' };
		expect(delete_marked_sql(t, [], '1', { account_table: true })).toContain("AND NOT (lower(COALESCE(to_jsonb(p) ->> 'email'");
		expect(delete_marked_sql(t, [], '1', { account_table: true })).toContain("LIKE '%@qa.imperium.test')");
		const unmark = unmark_bot_accounts_sql(t);
		expect(unmark).toStartWith('UPDATE "subject_configuracion"."user_management" p SET feature_map_test = false');
		expect(unmark).toContain("LIKE '%@qa.imperium.test'");
	});

	test('las tablas que crea el núcleo ya nacen con la columna', async () => {
		const src = await Bun.file(new URL('./store.ts', import.meta.url)).text();
		const creates = src.match(/CREATE TABLE IF NOT EXISTS \$\{[^}]+\} \([\s\S]*?\n\s+\)/g) ?? [];
		expect(creates.length).toBeGreaterThanOrEqual(3);
		for (const ddl of creates.filter((d) => d.includes('payload JSONB'))) {
			expect(ddl).toContain('${FEATURE_MAP_TEST_COLUMN_DDL}');
		}
	});
});

describe('borrado en masa', () => {
	test('hijos antes que padres', () => {
		const order = feature_map_test_delete_order(
			[
				{ schema: 'subject_pos', table: 'ventas' },
				{ schema: 'subject_pos', table: 'venta_lineas' },
				{ schema: 'subject_core', table: 'user' },
			],
			[
				{ child: 'subject_pos.venta_lineas', parent: 'subject_pos.ventas' },
				{ child: 'subject_pos.ventas', parent: 'subject_core.user' },
				{ child: 'subject_pos.ventas', parent: 'subject_pos.ventas' },
			],
		).map((t) => `${t.schema}.${t.table}`);
		expect(order).toEqual(['subject_pos.venta_lineas', 'subject_pos.ventas', 'subject_core.user']);
	});

	test('un ciclo no bloquea: quedan al final', () => {
		const order = feature_map_test_delete_order(
			[{ schema: 's', table: 'a' }, { schema: 's', table: 'b' }],
			[{ child: 's.a', parent: 's.b' }, { child: 's.b', parent: 's.a' }],
		);
		expect(order).toHaveLength(2);
	});

	test('borra solo lo marcado, en orden de FKs, y avisa los ids borrados', async () => {
		const pg = fake_pg(
			{
				'subject_pos.ventas': [
					{ id: 'v-test', feature_map_test: true },
					{ id: 'v-real', feature_map_test: false },
				],
				'subject_pos.venta_lineas': [
					{ id: 'l-test', feature_map_test: true, parent: 'v-test' },
					{ id: 'l-real', feature_map_test: false, parent: 'v-real' },
				],
			},
			[['subject_pos.venta_lineas', 'subject_pos.ventas']],
		);
		const seen: Array<[string, string[]]> = [];
		const r = await purge_feature_map_test(pg, { on_deleted: (t, ids) => void seen.push([t, ids]) });
		expect(r.total).toBe(2);
		expect(r.blocked).toEqual([]);
		expect(pg.tables.get('subject_pos.ventas')!.map((x) => x.id)).toEqual(['v-real']);
		expect(pg.tables.get('subject_pos.venta_lineas')!.map((x) => x.id)).toEqual(['l-real']);
		expect(seen).toEqual([
			['subject_pos.venta_lineas', ['l-test']],
			['subject_pos.ventas', ['v-test']],
		]);
	});

	test('una fila real que apunta a una de prueba la deja bloqueada y lo reporta', async () => {
		const pg = fake_pg(
			{
				'subject_pos.ventas': [{ id: 'v-test', feature_map_test: true }],
				'subject_pos.venta_lineas': [{ id: 'l-real', feature_map_test: false, parent: 'v-test' }],
			},
			[['subject_pos.venta_lineas', 'subject_pos.ventas']],
		);
		const r = await purge_feature_map_test(pg);
		expect(r.total).toBe(0);
		expect(r.blocked.map((b) => b.table)).toEqual(['subject_pos.ventas']);
		expect(r.blocked[0]!.error).toContain('siguen referenciadas');
		expect(pg.tables.get('subject_pos.ventas')).toHaveLength(1);
	});

	test('el DELETE nunca se apoya en CASCADE: excluye filas con hijos', async () => {
		const { delete_marked_sql } = await import('./feature-map-test.ts');
		const sql = delete_marked_sql(
			{ schema: 'subject_pos', table: 'ventas' },
			[
				{ child_schema: 'subject_pos', child_table: 'lineas', child_columns: ['venta_id'], parent_columns: ['id'] },
				{ child_schema: 'subject_pos', child_table: 'ventas', child_columns: ['origen_id'], parent_columns: ['id'] },
			],
			'p.id::text AS id',
		);
		expect(sql).toContain('WHERE p.feature_map_test = true');
		expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "subject_pos"."lineas" c WHERE c."venta_id" = p."id")');
		expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "subject_pos"."ventas" c WHERE c."origen_id" = p."id" AND c.feature_map_test IS NOT TRUE)');
	});

	test('el resumen cuenta por tabla', async () => {
		const pg = fake_pg({
			'subject_pos.ventas': [{ id: '1', feature_map_test: true }, { id: '2', feature_map_test: true }],
			'subject_core.user': [{ id: 'u', feature_map_test: false }],
		});
		expect(await feature_map_test_summary(pg)).toEqual({ tables: [{ table: 'subject_pos.ventas', rows: 2 }], total: 2 });
	});
});

describe('store.insert marca la fila en una corrida de prueba', () => {
	function store_with_log() {
		const log: Array<{ sql: string; params?: unknown[] }> = [];
		const sql = {
			unsafe: async (q: string, params?: unknown[]) => {
				log.push({ sql: q, params });
				if (/^\s*INSERT INTO/.test(q)) return [{ id: 'nuevo', name: 'x' }];
				return [];
			},
		};
		const store = new ImperiumStore(sql as unknown as Bun.SQL, load_catalog_path());
		const resource = store.all_locs.find((l) => l.resource === 'unit-of-measure')?.resource ?? store.all_locs[0]!.resource;
		return { store, log, resource };
	}

	test('con la cabecera, el INSERT lleva feature_map_test = true', async () => {
		const { store, log, resource } = store_with_log();
		await run_with_feature_map_test(true, () => store.insert(resource, { name: 'QA-IA prueba' }));
		const insert = log.find((l) => /^\s*INSERT INTO/.test(l.sql) && l.sql.includes(store.qt(resource)))!;
		expect(insert.sql).toContain('"feature_map_test"');
		const cols = /\(([^)]*)\) VALUES/.exec(insert.sql)![1]!.split(',').map((c) => c.trim());
		expect(insert.params![cols.indexOf('"feature_map_test"')]).toBe(true);
		expect(log.some((l) => l.sql.includes('ADD COLUMN IF NOT EXISTS feature_map_test'))).toBe(true);
	});

	test('sin la cabecera no se toca (ni aunque el cuerpo lo pida)', async () => {
		const { store, log, resource } = store_with_log();
		await store.insert(resource, { name: 'real', feature_map_test: true });
		const insert = log.find((l) => /^\s*INSERT INTO/.test(l.sql) && l.sql.includes(store.qt(resource)))!;
		expect(insert.sql).not.toContain('feature_map_test');
	});
});

describe('ruta /api/feature-map-test', () => {
	const store = { all_locs: [] } as unknown as ImperiumStore;
	const pg = fake_pg({ 'subject_pos.ventas': [{ id: 'v', feature_map_test: true }] });
	const admin = async () => ({ _id: 'a', _ref: 'user-menu-management-0' });
	const other = async () => ({ _id: 'b', _ref: 'otro' });

	test('reconoce la ruta', () => {
		expect(is_feature_map_test_path('/feature-map-test')).toBe(true);
		expect(is_feature_map_test_path('/feature-map-test/purge')).toBe(true);
		expect(is_feature_map_test_path('/feature-map-tests')).toBe(false);
	});

	test('sin sesión 401; usuario normal 403', async () => {
		const req = new Request('http://x/api/feature-map-test/purge', { method: 'POST' });
		expect((await handle_feature_map_test(store, pg as never, req, '/feature-map-test/purge', { actor: async () => null })).status).toBe(401);
		expect((await handle_feature_map_test(store, pg as never, req, '/feature-map-test/purge', { actor: other })).status).toBe(403);
		expect(pg.tables.get('subject_pos.ventas')).toHaveLength(1);
	});

	test('el superadministrador ve el resumen y purga', async () => {
		const get = await handle_feature_map_test(store, pg as never, new Request('http://x/api/feature-map-test'), '/feature-map-test', { actor: admin });
		expect(((await get.json()) as { total: number }).total).toBe(1);
		const post = await handle_feature_map_test(store, pg as never, new Request('http://x/api/feature-map-test/purge', { method: 'POST' }), '/feature-map-test/purge', { actor: admin });
		const body = (await post.json()) as { ok: boolean; total: number };
		expect(body).toMatchObject({ ok: true, total: 1 });
		expect(pg.tables.get('subject_pos.ventas')).toHaveLength(0);
	});
});

describe('cableado en el servidor', () => {
	test('cada petición corre con la marca de su cabecera y el plano de datos de las apps marca sus INSERT', async () => {
		const src = await Bun.file(new URL('../server.ts', import.meta.url)).text();
		expect(src).toContain('run_with_feature_map_test(feature_map_test_requested(req.headers)');
		expect(src).toMatch(/op === 'insert'[\s\S]{0,400}in_feature_map_test\(\)[\s\S]{0,200}row\[FEATURE_MAP_TEST_COLUMN\] = true/);
		// una app no puede marcar (ni desmarcar) por su cuenta
		expect(src).toMatch(/delete row\[FEATURE_MAP_TEST_COLUMN\]/);
		// al instalar el esquema de una app, sus tablas reciben la columna
		expect(src).toMatch(/apply_subject_schema_bundle\(sql, bundle\);\s*\/\/[^\n]*\n\s*await ensure_feature_map_test_columns\(sql\)/);
	});
});
