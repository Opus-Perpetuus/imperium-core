import { describe, expect, test } from 'bun:test';
import { CORE_VERSION, health_status, probe_database } from './health.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe('/health', () => {
	test('solo está sano con el arranque listo y la base contestando', () => {
		expect(health_status('ready', true)).toBe(200);
		expect(health_status('running', true)).toBe(503);
		expect(health_status('idle', true)).toBe(503);
		expect(health_status('failed', true)).toBe(503);
		expect(health_status('ready', false)).toBe(503);
	});

	test('una base que no contesta a tiempo cuenta como caída', async () => {
		const hung = (() => new Promise(() => {})) as unknown as Bun.SQL;
		const started = Date.now();
		expect(await probe_database(hung, 50)).toBe(false);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	test('una base que falla cuenta como caída', async () => {
		const broken = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as Bun.SQL;
		expect(await probe_database(broken, 50)).toBe(false);
	});

	test.skipIf(!DATABASE_URL)('una base viva contesta', async () => {
		const sql = new Bun.SQL(DATABASE_URL as string);
		expect(await probe_database(sql)).toBe(true);
		await sql.close();
	});

	test('reporta la versión del núcleo', () => {
		expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
	});
});
