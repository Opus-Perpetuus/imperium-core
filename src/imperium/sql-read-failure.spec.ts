import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { caught_http_error } from './envelope.ts';
import { FieldValidationError } from './required-fields.ts';
import { create_imperium_layer } from './router.ts';
import { open_core_sql, with_deadline } from './sql-client.ts';
import { HttpAuthRequiredError } from './auth.ts';

const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';

const PROBE = 'public.core_sql_read_probe';
const READ_MESSAGE = 'No se pudo leer la respuesta de la base';

describe('caught_http_error', () => {
	test('un error del driver sin status es 503, no 400', () => {
		const mapped = caught_http_error(new Error('Failed to read data'));
		expect(mapped.status).toBe(503);
		expect(mapped.code).toBe('sql_read_failed');
		expect(mapped.message).toBe(READ_MESSAGE);
		expect(mapped.message).not.toContain('Failed to read data');
	});

	test('una validación sigue en 400', () => {
		const mapped = caught_http_error(
			new FieldValidationError({ email: ['requerido'] }, 'El email es requerido'),
		);
		expect(mapped.status).toBe(400);
		expect(mapped.message).toBe('El email es requerido');
		expect(mapped.field_errors).toEqual({ email: ['requerido'] });
	});

	test('un error de negocio sin status sigue en 400', () => {
		const mapped = caught_http_error(new Error('El registro no existe'));
		expect(mapped.status).toBe(400);
		expect(mapped.message).toBe('El registro no existe');
	});

	test('autenticación y unique de Postgres no se vuelven 503', () => {
		expect(caught_http_error(new HttpAuthRequiredError()).status).toBe(401);
		const dup = Object.assign(
			new Error('duplicate key value violates unique constraint "core_sql_read_probe_pkey"'),
			{ errno: '23505', code: 'ERR_POSTGRES_SERVER_ERROR' },
		);
		const mapped = caught_http_error(dup);
		expect(mapped.status).toBe(400);
		expect(mapped.message).toContain('Ya existe');
	});

	test('el tope de SQL y el de HTTP conservan su mensaje', () => {
		const sql = caught_http_error(
			Object.assign(new Error('La base no respondió a tiempo'), {
				status: 503,
				code: 'sql_timeout',
			}),
		);
		expect(sql.status).toBe(503);
		expect(sql.code).toBe('sql_timeout');
		expect(sql.message).toBe('La base no respondió a tiempo');
		const http = caught_http_error(
			Object.assign(new Error('La solicitud no terminó a tiempo'), {
				status: 503,
				code: 'http_deadline',
			}),
		);
		expect(http.code).toBe('http_deadline');
		expect(http.message).toContain('no terminó');
	});
});

async function postgres_responde(): Promise<boolean> {
	let sql: Bun.SQL | undefined;
	try {
		sql = new Bun.SQL(DATABASE_URL, {
			max: 1,
			idleTimeout: 0,
			connectionTimeout: 2,
		});
		await sql.unsafe('SELECT 1');
		return true;
	} catch {
		return false;
	} finally {
		await sql?.close({ timeout: 1 }).catch(() => {});
	}
}

const has_db = await postgres_responde();

if (has_db) {
	describe('lecturas concurrentes del pool', () => {
		const sql = open_core_sql(DATABASE_URL, { max: 2, query_timeout_ms: 8_000 });

		beforeAll(async () => {
			await sql.unsafe(`DROP TABLE IF EXISTS ${PROBE}`);
			await sql.unsafe(
				`CREATE TABLE ${PROBE} (
					id text PRIMARY KEY,
					payload jsonb NOT NULL,
					body text NOT NULL
				)`,
			);
			const payload = JSON.stringify({ note: 'x'.repeat(1024), n: 1 });
			await sql.unsafe(
				`INSERT INTO ${PROBE} (id, payload, body) VALUES ($1, $2::jsonb, $3)`,
				['fila-1', payload, 'cuerpo de lectura'],
			);
		});

		afterAll(async () => {
			await sql.unsafe(`DROP TABLE IF EXISTS ${PROBE}`).catch(() => {});
			await sql.close({ timeout: 1 });
		});

		test('el tagged template pasa por el cliente vivo', async () => {
			const rows = (await sql`SELECT 1 AS n`) as Array<{ n: number }>;
			expect(Number(rows[0]?.n)).toBe(1);
		});

		test('40 GET paralelos, tres rondas, todas 200', async () => {
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					const id = new URL(req.url).pathname.split('/').pop() ?? '';
					try {
						const rows = await sql.unsafe(
							`SELECT id, payload, body FROM ${PROBE} WHERE id = $1`,
							[id],
						);
						return Response.json({ data: rows });
					} catch (err) {
						const mapped = caught_http_error(err);
						return Response.json(
							{ message: mapped.message, error: mapped.message, code: mapped.code },
							{ status: mapped.status },
						);
					}
				},
			});
			try {
				for (let round = 0; round < 3; round++) {
					const responses = await Promise.all(
						Array.from({ length: 40 }, () =>
							fetch(new URL('/api/probe/fila-1', server.url), {
								signal: AbortSignal.timeout(8_000),
							}),
						),
					);
					for (const res of responses) {
						const text = await res.text();
						expect(text).not.toContain('Failed to read data');
						expect(res.status).toBe(200);
						const body = JSON.parse(text) as { data?: Array<{ id?: string }> };
						expect(body.data?.[0]?.id).toBe('fila-1');
					}
				}
			} finally {
				server.stop(true);
			}
		}, 30_000);

		test('un unique violado no se disfraza de fallo de lectura', async () => {
			await expect(
				sql.unsafe(
					`INSERT INTO ${PROBE} (id, payload, body) VALUES ('fila-1', '{}'::jsonb, 'otra')`,
				),
			).rejects.toThrow(/duplicate key|unique|Ya existe/i);
		});
	});

	describe('el driver cierra la conexión al no decodificar', () => {
		const sql = open_core_sql(DATABASE_URL, { max: 1, query_timeout_ms: 5_000 });

		afterAll(async () => {
			await sql.close({ timeout: 1 });
		});

		test('la consulta mala sale 503 y la siguiente lectura funciona', async () => {
			await expect(sql.unsafe(`SELECT '[0:1]={a,b}'::text[] AS v`)).rejects.toMatchObject({
				status: 503,
				code: 'sql_read_failed',
				message: READ_MESSAGE,
			});
			const rows = (await sql.unsafe('SELECT 1 AS n')) as Array<{ n: number }>;
			expect(Number(rows[0]?.n)).toBe(1);
		}, 20_000);

		test('las consultas buenas que compartían la conexión no salen en 400', async () => {
			const settled = await Promise.allSettled([
				sql.unsafe('SELECT 1 AS n'),
				sql.unsafe(`SELECT '[0:1]={a,b}'::text[] AS v`),
				sql.unsafe('SELECT 2 AS n'),
			]);
			expect(settled[1]?.status).toBe('rejected');
			for (const item of settled) {
				if (item.status === 'fulfilled') continue;
				const err = item.reason as Error & { status?: number; code?: string };
				expect(err.status).not.toBe(400);
				expect(err.status).toBe(503);
				expect(err.message).not.toContain('Failed to read data');
				expect(err.code === 'sql_read_failed' || err.code === 'sql_timeout').toBe(true);
			}
			const rows = (await sql.unsafe('SELECT 3 AS n')) as Array<{ n: number }>;
			expect(Number(rows[0]?.n)).toBe(3);
		}, 20_000);
	});

	describe('el router no convierte un fallo interno en 400', () => {
		let mode: 'off' | 'driver' | 'validation' = 'off';
		const real = new Bun.SQL(DATABASE_URL);
		const sql = new Proxy(real, {
			get(target, prop) {
				if (prop === 'unsafe') {
					return (query: string, params?: unknown[]) => {
						if (
							mode !== 'off' &&
							/imperium_sessions/i.test(String(query)) &&
							/^\s*select/i.test(String(query))
						) {
							if (mode === 'driver') throw new Error('Failed to read data');
							throw new FieldValidationError(
								{ email: ['requerido'] },
								'El email es requerido',
							);
						}
						return target.unsafe(query, params);
					};
				}
				const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
				return typeof value === 'function'
					? (value as (...args: unknown[]) => unknown).bind(target)
					: value;
			},
		}) as unknown as Bun.SQL;
		const layer = create_imperium_layer(sql);

		beforeAll(async () => {
			mode = 'off';
			await layer.handle(new Request('http://imperium.test/api/__no_such__'));
		}, 120_000);

		afterAll(async () => {
			mode = 'off';
			await real.close({ timeout: 1 });
		});

		test('Failed to read data en la sesión sale 503', async () => {
			mode = 'driver';
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					const out = await layer.handle(req);
					return out ?? Response.json({ error: 'not found' }, { status: 404 });
				},
			});
			try {
				const res = await fetch(new URL('/api/user-settings', server.url), {
					headers: { cookie: 'connect.sid=lectura-rota' },
					signal: AbortSignal.timeout(8_000),
				});
				const body = (await res.json()) as { message?: string; code?: string };
				expect(res.status).toBe(503);
				expect(body.code).toBe('sql_read_failed');
				expect(body.message).toBe(READ_MESSAGE);
			} finally {
				mode = 'off';
				server.stop(true);
			}
		}, 20_000);

		test('una validación lanzada en la misma consulta sigue en 400', async () => {
			mode = 'validation';
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					const out = await layer.handle(req);
					return out ?? Response.json({ error: 'not found' }, { status: 404 });
				},
			});
			try {
				const res = await fetch(new URL('/api/user-settings', server.url), {
					headers: { cookie: 'connect.sid=validacion' },
					signal: AbortSignal.timeout(8_000),
				});
				const body = (await res.json()) as {
					message?: string;
					field_errors?: { email?: string[] };
				};
				expect(res.status).toBe(400);
				expect(body.message).toBe('El email es requerido');
				expect(body.field_errors?.email).toEqual(['requerido']);
			} finally {
				mode = 'off';
				server.stop(true);
			}
		}, 20_000);
	});

	describe('pool saturado', () => {
		const sql = open_core_sql(DATABASE_URL, { max: 4, query_timeout_ms: 4_000 });
		const layer = create_imperium_layer(sql);
		const watch = new Bun.SQL(DATABASE_URL, {
			max: 1,
			idleTimeout: 0,
			connectionTimeout: 5,
		});

		beforeAll(async () => {
			await layer.handle(new Request('http://imperium.test/api/__no_such__'));
		}, 120_000);

		afterAll(async () => {
			await sql.close({ timeout: 1 }).catch(() => {});
			await watch.close({ timeout: 1 }).catch(() => {});
		});

		test('user-settings y login responden con cuerpo y después la base vuelve', async () => {
			const sleeps = Array.from({ length: 4 }, () =>
				sql
					.unsafe('SELECT pg_sleep(30) /* core_sql_read_probe_saturacion */')
					.then(() => null)
					.catch(() => null),
			);
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					const work = layer
						.handle(req)
						.then((res) => res ?? Response.json({ error: 'not found' }, { status: 404 }));
					void work.catch(() => {});
					try {
						return await with_deadline(work, 4_000);
					} catch (err) {
						const mapped = caught_http_error(err);
						const body: Record<string, unknown> = {
							error: mapped.message,
							message: mapped.message,
						};
						if (mapped.code) body.code = mapped.code;
						return Response.json(body, { status: mapped.status });
					}
				},
			});
			try {
				const deadline = Date.now() + 3_000;
				let active = 0;
				while (Date.now() < deadline) {
					const rows = (await watch.unsafe(
						`SELECT count(*)::int AS n
						 FROM pg_stat_activity
						 WHERE query LIKE '%core_sql_read_probe_saturacion%'
						   AND state = 'active'`,
					)) as Array<{ n: number }>;
					active = Number(rows[0]?.n ?? 0);
					if (active >= 4) break;
					await Bun.sleep(40);
				}
				expect(active).toBeGreaterThanOrEqual(4);

				const [settings, login] = await Promise.all([
					fetch(new URL('/api/user-settings', server.url), {
						headers: { cookie: 'connect.sid=saturacion-no-existe' },
						signal: AbortSignal.timeout(8_000),
					}),
					fetch(new URL('/api/auth/login', server.url), {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							email: 'nadie-saturacion@example.com',
							password: 'no-es-la-clave',
						}),
						signal: AbortSignal.timeout(8_000),
					}),
				]);
				for (const res of [settings, login]) {
					const text = await res.text();
					expect(text.length).toBeGreaterThan(0);
					expect(text).not.toContain('Failed to read data');
					const body = JSON.parse(text) as { message?: string; error?: string };
					expect(body.message || body.error).toBeTruthy();
					expect([401, 429, 500, 502, 503]).toContain(res.status);
				}
			} finally {
				server.stop(true);
				await Promise.allSettled(sleeps);
			}
			const rows = (await sql.unsafe('SELECT 1 AS n')) as Array<{ n: number }>;
			expect(Number(rows[0]?.n)).toBe(1);
		}, 40_000);
	});
} else {
	describe.skip('lecturas concurrentes del pool (sin postgres)', () => {
		test('omitido sin base', () => {});
	});
	describe.skip('el driver cierra la conexión al no decodificar (sin postgres)', () => {
		test('omitido sin base', () => {});
	});
	describe.skip('el router no convierte un fallo interno en 400 (sin postgres)', () => {
		test('omitido sin base', () => {});
	});
	describe.skip('pool saturado (sin postgres)', () => {
		test('omitido sin base', () => {});
	});
}
