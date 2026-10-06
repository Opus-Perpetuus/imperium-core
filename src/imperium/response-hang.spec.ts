import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { create_imperium_layer } from './router.ts';
import { with_deadline } from './sql-client.ts';

const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';

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
	const real = new Bun.SQL(DATABASE_URL);
	let hang_debug_log = false;
	let hang_configuration = false;

	const sql = new Proxy(real, {
		get(target, prop) {
			if (prop === 'unsafe') {
				return (query: string, params?: unknown[]) => {
					const text = String(query);
					if (
						hang_debug_log &&
						/insert\s+into/i.test(text) &&
						/debug_log/i.test(text)
					) {
						return new Promise(() => {});
					}
					if (hang_configuration && /configuration/i.test(text)) {
						return new Promise(() => {});
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
		await layer.handle(new Request('http://imperium.test/api/__no_such__'));
	}, 120_000);

	afterAll(async () => {
		hang_debug_log = false;
		hang_configuration = false;
		await real.close({ timeout: 1 });
	});

	describe('respuestas que antes se quedaban sin bytes', () => {
		test('GET /api/user-settings sin sesión cierra con 401 aunque el log no vuelva', async () => {
			hang_debug_log = true;
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					const out = await layer.handle(req);
					return out ?? Response.json({ error: 'not found' }, { status: 404 });
				},
			});
			try {
				const res = await fetch(new URL('/api/user-settings', server.url), {
					headers: { origin: 'https://127.0.0.1:4213' },
					signal: AbortSignal.timeout(3000),
				});
				expect(res.status).toBe(401);
				const body = (await res.json()) as { message?: string; error?: string };
				expect(body.message).toBe('No estás autenticado');
				expect(body.error).toBe('No estás autenticado');
			} finally {
				server.stop(true);
				hang_debug_log = false;
			}
		}, 15_000);

		test('GET /api/auth/branding cuelga en SQL y aun así cierra con JSON', async () => {
			hang_configuration = true;
			const server = Bun.serve({
				port: 0,
				async fetch(req) {
					try {
						const out = await with_deadline(
							layer.handle(req).then((res) => res ?? Response.json({ error: 'not found' }, { status: 404 })),
							400,
						);
						return out;
					} catch (err) {
						const failure = err as Error & { status?: number };
						const message = failure instanceof Error ? failure.message : String(err);
						const status =
							typeof failure.status === 'number' &&
							failure.status >= 400 &&
							failure.status < 600
								? failure.status
								: 500;
						return Response.json({ error: message, message }, { status });
					}
				},
			});
			try {
				const res = await fetch(new URL('/api/auth/branding', server.url), {
					signal: AbortSignal.timeout(2000),
				});
				expect(res.status).toBe(503);
				const body = (await res.json()) as { message?: string };
				expect(String(body.message)).toContain('no terminó');
			} finally {
				server.stop(true);
				hang_configuration = false;
			}
		});
	});
} else {
	describe.skip('respuestas que antes se quedaban sin bytes (sin postgres)', () => {
		test('omitido sin base', () => {});
	});
}
