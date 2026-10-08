import { afterAll, describe, expect, test } from 'bun:test';
import {
	discovered_versions,
	record_install_error,
	write_install_row,
} from './subjects-admin.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const ID = `subject-qa-${crypto.randomUUID().slice(0, 8)}`;

afterAll(async () => {
	if (!sql) return;
	await sql.unsafe('DELETE FROM public.subject_installs WHERE technical_id = $1', [ID]);
	await sql.close();
});

describe.skipIf(!sql)('motivo del fallo al instalar una app', () => {
	test('un fallo deja el motivo y el siguiente intento lo limpia', async () => {
		const db = sql as Bun.SQL;
		await write_install_row(db, ID, true, 1, 'installing');
		await write_install_row(db, ID, false, 1, 'error');
		await record_install_error(db, ID, 'No se pudo instalar Tienda: pull access denied');

		let row = (await discovered_versions(db)).get(ID);
		expect(row?.status).toBe('error');
		expect(row?.last_error).toBe('No se pudo instalar Tienda: pull access denied');
		expect(row?.last_error_at).not.toBeNull();

		await write_install_row(db, ID, true, 1, 'installing');
		row = (await discovered_versions(db)).get(ID);
		expect(row?.last_error).toBeNull();
		expect(row?.last_error_at).toBeNull();
	});

	test('un fallo al actualizar conserva la app instalada y deja el motivo', async () => {
		const db = sql as Bun.SQL;
		await write_install_row(db, ID, true, 1, 'updating');
		await write_install_row(db, ID, true, 1, 'installed');
		await record_install_error(db, ID, 'No se pudo actualizar Tienda: timeout');
		const row = (await discovered_versions(db)).get(ID);
		expect(row?.installed).toBe(true);
		expect(row?.last_error).toBe('No se pudo actualizar Tienda: timeout');
	});
});
