import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { core_pool_options, open_core_sql } from './sql-client.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';

const POOL_ENV = ['CORE_SQL_POOL_MAX', 'CORE_SQL_IDLE_TIMEOUT_S', 'CORE_SQL_CONNECT_TIMEOUT_S'];

describe('core_pool_options', () => {
	const saved = Object.fromEntries(POOL_ENV.map((name) => [name, process.env[name]]));

	afterEach(() => {
		for (const name of POOL_ENV) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	test('sin env: 20 conexiones, idle 60 s y connect 10 s', () => {
		for (const name of POOL_ENV) delete process.env[name];
		expect(core_pool_options(30_000)).toEqual({
			max: 20,
			idle_timeout_s: 60,
			connect_timeout_s: 10,
		});
	});

	test('el env manda y lo inválido cae al default', () => {
		process.env.CORE_SQL_POOL_MAX = '35';
		process.env.CORE_SQL_IDLE_TIMEOUT_S = '120';
		process.env.CORE_SQL_CONNECT_TIMEOUT_S = 'nada';
		expect(core_pool_options(30_000)).toEqual({
			max: 35,
			idle_timeout_s: 120,
			connect_timeout_s: 10,
		});
	});

	test('el idle nunca queda por debajo del tope de consulta', () => {
		process.env.CORE_SQL_IDLE_TIMEOUT_S = '5';
		expect(core_pool_options(30_000).idle_timeout_s).toBe(30);
	});
});

async function postgres_responde(): Promise<boolean> {
	let sql: Bun.SQL | undefined;
	try {
		sql = new Bun.SQL(DATABASE_URL, { max: 1, idleTimeout: 0, connectionTimeout: 2 });
		await sql.unsafe('SELECT 1');
		return true;
	} catch {
		return false;
	} finally {
		await sql?.close({ timeout: 1 }).catch(() => {});
	}
}

const has_db = await postgres_responde();

type PoolUsage = { total: number; active: number; sleeping: number };

function watcher(application_name: string) {
	const probe = new Bun.SQL(DATABASE_URL, { max: 1, prepare: false });
	const usage = async (): Promise<PoolUsage> => {
		const [row] = (await probe.unsafe(
			`SELECT count(*)::int AS total,
			        count(*) FILTER (WHERE state <> 'idle')::int AS active,
			        count(*) FILTER (WHERE query LIKE '%pg_sleep%' AND state = 'active')::int AS sleeping
			   FROM pg_stat_activity
			  WHERE application_name LIKE $1`,
			[`${application_name}:%`],
		)) as PoolUsage[];
		return row!;
	};
	let peak = 0;
	let sampling = false;
	let loop: Promise<void> | undefined;
	return {
		usage,
		get peak() {
			return peak;
		},
		start() {
			sampling = true;
			loop = (async () => {
				while (sampling) {
					peak = Math.max(peak, (await usage()).total);
					await Bun.sleep(10);
				}
			})();
		},
		async stop() {
			sampling = false;
			await loop;
		},
		async until(check: (u: PoolUsage) => boolean, ms: number): Promise<PoolUsage> {
			const end = Date.now() + ms;
			let last = await usage();
			while (!check(last) && Date.now() < end) {
				await Bun.sleep(50);
				last = await usage();
			}
			return last;
		},
		close: () => probe.close({ timeout: 1 }),
	};
}

if (has_db) {
	describe('pool del núcleo bajo user-group/mass-query (#208)', () => {
		const MAX = 5;
		const app = `pool-spec-${crypto.randomUUID().slice(0, 8)}`;
		const sql = open_core_sql(DATABASE_URL, {
			max: MAX,
			query_timeout_ms: 2_000,
			idle_timeout_s: 1,
			application_name: app,
		});
		const store = new ImperiumStore(sql, load_catalog_path());
		const watch = watcher(app);
		const prefix = `pool208-${crypto.randomUUID().slice(0, 8)}-`;
		const ids = Array.from({ length: 80 }, (_, i) => `${prefix}${i}`);
		let server: ReturnType<typeof Bun.serve>;

		beforeAll(async () => {
			const table = store.qt('user-group');
			const schema = table.split('.')[0]!;
			await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
			await sql.unsafe(
				`CREATE TABLE IF NOT EXISTS ${table} (
					id TEXT PRIMARY KEY, name TEXT, description TEXT, is_active BOOLEAN DEFAULT true,
					state TEXT, ref TEXT, search_field TEXT, created_by TEXT,
					custom_data JSONB DEFAULT '{}'::jsonb, payload JSONB DEFAULT '{}'::jsonb,
					created_at TEXT, updated_at TEXT
				)`,
			);
			for (const id of ids) {
				await sql.unsafe(`INSERT INTO ${table} (id, name) VALUES ($1, $2)`, [id, `Grupo ${id}`]);
			}
			server = Bun.serve({
				port: 0,
				async fetch(req) {
					const path = new URL(req.url).pathname;
					if (req.method === 'POST' && path === '/api/user-group/mass-query') {
						const body = (await req.json()) as { ids: string[] };
						const { rows } = await store.find_many('user-group', {
							ids: body.ids,
							take: body.ids.length || 1,
							skip: 0,
							include_inactive: true,
							populate: false,
							skip_total: true,
						});
						return Response.json({ data: rows });
					}
					const id = path.split('/').pop() ?? '';
					return Response.json({ data: await store.find_id('user-group', id) });
				},
				error: (err) => Response.json({ message: String(err) }, { status: 503 }),
			});
		});

		afterAll(async () => {
			server?.stop(true);
			await sql
				.unsafe(`DELETE FROM ${store.qt('user-group')} WHERE id LIKE $1`, [`${prefix}%`])
				.catch(() => {});
			await sql.close({ timeout: 1 });
			await watch.close();
		});

		test('400 peticiones concurrentes: nunca pasa del máximo y las conexiones vuelven a 0', async () => {
			watch.start();
			try {
				for (let round = 0; round < 2; round++) {
					const responses = await Promise.all(
						Array.from({ length: 200 }, (_, i) => {
							if (i % 3 === 0) {
								return fetch(new URL(`/api/user-group/${ids[i % ids.length]}`, server.url));
							}
							const picked = ids.slice(0, 1 + ((i * 7 + round) % ids.length));
							return fetch(new URL('/api/user-group/mass-query', server.url), {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify({ ids: picked }),
							});
						}),
					);
					for (const res of responses) {
						expect(res.status).toBe(200);
						const body = (await res.json()) as { data: unknown };
						expect(body.data).toBeTruthy();
					}
				}
			} finally {
				await watch.stop();
			}
			expect(watch.peak).toBeGreaterThan(0);
			expect(watch.peak).toBeLessThanOrEqual(MAX);
			expect((await watch.until((u) => u.active === 0, 2_000)).active).toBe(0);
			expect((await watch.until((u) => u.total === 0, 6_000)).total).toBe(0);
		}, 30_000);

		test('una consulta colgada recicla el pool sin dejar las conexiones viejas abiertas', async () => {
			const hung = await Promise.allSettled(
				Array.from({ length: MAX }, () => sql.unsafe('SELECT pg_sleep(20)')),
			);
			for (const item of hung) expect(item.status).toBe('rejected');
			const after = await watch.until((u) => u.sleeping === 0, 2_000);
			expect(after.sleeping).toBe(0);
			expect(after.total).toBeLessThanOrEqual(MAX);
			const reads = await Promise.all(
				Array.from({ length: 30 }, () => sql.unsafe('SELECT 1 AS n')),
			);
			expect(reads).toHaveLength(30);
			expect((await watch.usage()).total).toBeLessThanOrEqual(MAX);
			expect((await watch.until((u) => u.total === 0, 6_000)).total).toBe(0);
		}, 30_000);

		test('bind message supplies N parameters recicla la conexión y la lectura se reintenta', async () => {
			const bind_app = `bind-spec-${crypto.randomUUID().slice(0, 8)}`;
			const schema = `pool208_bind_${crypto.randomUUID().slice(0, 8)}`;
			const bind_sql = open_core_sql(DATABASE_URL, {
				max: 1,
				query_timeout_ms: 2_000,
				application_name: bind_app,
			});
			const first_generation = () =>
				sql.unsafe(
					`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE $1`,
					[`${bind_app}:%:0`],
				) as Promise<Array<{ n: number }>>;
			try {
				await sql.unsafe(`CREATE SCHEMA ${schema}`);
				await sql.unsafe(
					`CREATE FUNCTION ${schema}.glitch(app text) RETURNS int LANGUAGE plpgsql AS $fn$
					BEGIN
						IF current_setting('application_name') LIKE app || ':%:0' THEN
							RAISE EXCEPTION USING ERRCODE = '08P01',
								MESSAGE = 'bind message supplies 29 parameters, but prepared statement "PSELECT * FROM "subject_configuracion"."u$5" requires 1';
						END IF;
						RETURN 1;
					END $fn$`,
				);
				const rows = (await bind_sql.unsafe(`SELECT ${schema}.glitch($1) AS n`, [
					bind_app,
				])) as Array<{ n: number }>;
				expect(rows[0]?.n).toBe(1);
				const end = Date.now() + 3_000;
				let left = (await first_generation())[0]!.n;
				while (left > 0 && Date.now() < end) {
					await Bun.sleep(50);
					left = (await first_generation())[0]!.n;
				}
				expect(left).toBe(0);
			} finally {
				await bind_sql.close({ timeout: 1 }).catch(() => {});
				await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
			}
		}, 15_000);
	});
} else {
	describe.skip('pool del núcleo bajo user-group/mass-query (sin postgres)', () => {
		test('omitido sin base', () => {});
	});
}
