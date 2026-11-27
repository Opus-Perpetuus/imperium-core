import { afterAll, describe, expect, test } from 'bun:test';
import { ensure_user_device_table, insert_user_device, type UserDeviceInput } from './user-device.ts';

const CAMPOS = [
	'user_id',
	'name',
	'model',
	'public_key',
	'fcm_token',
	'registered_at',
	'last_used_at',
	'status',
	'attestation',
] as const;

function captura() {
	const calls: Array<{ query: string; params: unknown[] }> = [];
	const sql = {
		unsafe(query: string, params: unknown[] = []) {
			calls.push({ query, params });
			return Promise.resolve([]);
		},
	} as unknown as Bun.SQL;
	return { sql, calls };
}

const fila = (over: Partial<UserDeviceInput> = {}): UserDeviceInput => ({
	id: 'dev-1',
	user_id: 'user-1',
	name: 'Pixel de Ana',
	model: 'Pixel 8',
	public_key: 'spki-base64url',
	fcm_token: 'sekreto-fcm',
	registered_at: '2026-11-27T18:00:00.000Z',
	last_used_at: null,
	status: 'activo',
	attestation: 'cadena-keystore',
	...over,
});

describe('tabla user_device', () => {
	test('acepta los campos del dispositivo y no interpola el token', async () => {
		const { sql, calls } = captura();
		await ensure_user_device_table(sql);
		await insert_user_device(sql, fila());

		const create = calls.find((c) => c.query.includes('CREATE TABLE'));
		expect(create?.query).toContain('public.user_device');
		for (const campo of CAMPOS) {
			expect(create?.query).toContain(campo);
		}
		expect(create?.query).toContain("CHECK (status IN ('activo', 'revocado'))");
		expect(create?.query).toContain('feature_map_test');
		expect(calls.some((c) => c.query.includes('user_device_user_active_idx'))).toBe(true);

		const insert = calls.find((c) => c.query.includes('INSERT INTO public.user_device'));
		expect(insert).toBeDefined();
		for (const campo of CAMPOS) {
			expect(insert?.query).toContain(campo);
		}
		expect(insert?.query).not.toContain('sekreto-fcm');
		expect(insert?.params).toEqual([
			'dev-1',
			'user-1',
			'Pixel de Ana',
			'Pixel 8',
			'spki-base64url',
			'sekreto-fcm',
			'2026-11-27T18:00:00.000Z',
			null,
			'activo',
			'cadena-keystore',
		]);
	});
});

const DATABASE_URL =
	process.env.DATABASE_URL ?? 'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';

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

if (has_db) {
	describe('user_device en Postgres', () => {
		const sql = new Bun.SQL(DATABASE_URL, { max: 1, idleTimeout: 1 });
		const id = `ud-${crypto.randomUUID()}`;

		afterAll(async () => {
			await sql.unsafe(`DELETE FROM public.user_device WHERE id = $1`, [id]).catch(() => {});
			await sql.close({ timeout: 1 });
		});

		test('guarda y lee la fila, y rechaza un estado distinto', async () => {
			await ensure_user_device_table(sql);
			await insert_user_device(
				sql,
				fila({
					id,
					fcm_token: 'token-de-prueba',
					attestation: null,
					last_used_at: '2026-11-27T18:05:00.000Z',
				}),
			);
			const rows = (await sql.unsafe(
				`SELECT id, user_id, name, model, public_key, fcm_token, status, attestation,
                last_used_at IS NOT NULL AS tuvo_uso
           FROM public.user_device WHERE id = $1`,
				[id],
			)) as Array<Record<string, unknown>>;
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				id,
				user_id: 'user-1',
				name: 'Pixel de Ana',
				model: 'Pixel 8',
				public_key: 'spki-base64url',
				fcm_token: 'token-de-prueba',
				status: 'activo',
				attestation: null,
				tuvo_uso: true,
			});

			await expect(
				insert_user_device(sql, fila({ id: `${id}-mal`, status: 'pendiente' as 'activo' })),
			).rejects.toThrow();
			await sql.unsafe(`DELETE FROM public.user_device WHERE id = $1`, [`${id}-mal`]).catch(() => {});
		});
	});
}
