import { afterAll, describe, expect, test } from 'bun:test';
import { open_core_sql, request_with_received_body, with_deadline } from './sql-client.ts';

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
	describe('open_core_sql', () => {
		const sql = open_core_sql(DATABASE_URL, { query_timeout_ms: 400 });

		afterAll(async () => {
			await sql.close({ timeout: 1 });
		});

		test('una consulta que no vuelve se rechaza y la siguiente sí corre', async () => {
			await expect(sql.unsafe('SELECT pg_sleep(5)')).rejects.toThrow(/no respondió/);
			const rows = (await sql.unsafe('SELECT 1 AS n')) as Array<{ n: number }>;
			expect(rows[0]?.n).toBe(1);
		}, { timeout: 20_000 });
	});
} else {
	describe.skip('open_core_sql (sin postgres)', () => {
		test('omitido sin base', () => {});
	});
}

function deadline_failure(err: unknown): Response {
	const failure = err as { status?: number };
	const message = err instanceof Error ? err.message : String(err);
	const status =
		typeof failure.status === 'number' && failure.status >= 400 && failure.status < 600
			? failure.status
			: 500;
	return Response.json({ error: message, message }, { status });
}

function slow_multipart(payload: string, pause_ms: number): {
	body: ReadableStream<Uint8Array>;
	boundary: string;
} {
	const boundary = '----imperiumslow';
	const enc = new TextEncoder();
	const head =
		`--${boundary}\r\n` +
		'Content-Disposition: form-data; name="archivo"; filename="lento.txt"\r\n' +
		'Content-Type: text/plain\r\n\r\n';
	const tail = `\r\n--${boundary}--\r\n`;
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(enc.encode(head));
			const step = Math.max(1, Math.ceil(payload.length / 4));
			for (let i = 0; i < payload.length; i += step) {
				await Bun.sleep(pause_ms);
				controller.enqueue(enc.encode(payload.slice(i, i + step)));
			}
			controller.enqueue(enc.encode(tail));
			controller.close();
		},
	});
	return { body, boundary };
}

describe('with_deadline', () => {
	test('un fetch que no termina igual entrega JSON y cierra', async () => {
		const server = Bun.serve({
			port: 0,
			async fetch() {
				try {
					return await with_deadline(new Promise<Response>(() => {}), 300);
				} catch (err) {
					return deadline_failure(err);
				}
			},
		});
		try {
			const res = await fetch(server.url, { signal: AbortSignal.timeout(2000) });
			expect(res.status).toBe(503);
			const body = (await res.json()) as { message?: string };
			expect(body.message).toContain('no terminó');
		} finally {
			server.stop(true);
		}
	});

	test('una subida lenta no recibe 503 mientras los bytes siguen llegando', async () => {
		const deadline_ms = 400;
		const payload = 'lento-ok';
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				try {
					const ready = await request_with_received_body(req);
					return await with_deadline(
						(async () => {
							const form = await ready.formData();
							const file = form.get('archivo');
							const text = file instanceof Blob ? await file.text() : String(file ?? '');
							return Response.json({ text });
						})(),
						deadline_ms,
					);
				} catch (err) {
					return deadline_failure(err);
				}
			},
		});
		const { body, boundary } = slow_multipart(payload, 300);
		const started = Date.now();
		try {
			const res = await fetch(server.url, {
				method: 'POST',
				headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
				body,
			});
			const elapsed = Date.now() - started;
			expect(res.status).toBe(200);
			expect(elapsed).toBeGreaterThan(deadline_ms);
			const json = (await res.json()) as { text?: string; code?: string };
			expect(json.text).toBe(payload);
			expect(json.code).toBeUndefined();
		} finally {
			server.stop(true);
		}
	}, 10_000);

	test('con el cuerpo ya recibido un handler colgado sigue en 503', async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				try {
					const ready = await request_with_received_body(req);
					return await with_deadline(
						(async () => {
							const text = await ready.text();
							if (text !== 'listo') {
								return Response.json({ message: 'cuerpo inesperado' }, { status: 400 });
							}
							return await new Promise<Response>(() => {});
						})(),
						300,
					);
				} catch (err) {
					return deadline_failure(err);
				}
			},
		});
		const started = Date.now();
		try {
			const res = await fetch(server.url, {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'listo',
				signal: AbortSignal.timeout(2000),
			});
			expect(res.status).toBe(503);
			expect(Date.now() - started).toBeLessThan(1500);
			const json = (await res.json()) as { message?: string };
			expect(json.message).toContain('no terminó');
		} finally {
			server.stop(true);
		}
	});

	test('el servidor recibe el cuerpo antes de arrancar el plazo', async () => {
		const src = await Bun.file(new URL('../server.ts', import.meta.url)).text();
		const receive = src.indexOf('await request_with_received_body(req)');
		const deadline = src.indexOf('await with_deadline(');
		expect(receive).toBeGreaterThan(-1);
		expect(deadline).toBeGreaterThan(receive);
	});
});
