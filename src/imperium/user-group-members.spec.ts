/**
 * Pestaña «Grupos» de la ficha de usuario: `GET /api/user-group?user_ids=<id>`
 * pide los grupos cuyo arreglo `user_ids` contiene al usuario. La parte de
 * Postgres real corre con `DATABASE_URL`, ids aleatorios y limpieza al final.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { id_list_member_sql, ImperiumStore, load_catalog_path } from './store.ts';

function capture_store() {
	const calls: Array<{ query: string; params: unknown[] }> = [];
	const sql = {
		unsafe(query: string, params: unknown[] = []) {
			calls.push({ query, params });
			if (query.startsWith('SELECT count(*)')) return Promise.resolve([{ n: 0 }]);
			return Promise.resolve([]);
		},
	} as unknown as Bun.SQL;
	return { store: new ImperiumStore(sql, load_catalog_path()), calls };
}

describe('filtro por lista de ids (`*_ids`)', () => {
	test('user_ids pide pertenencia al arreglo, no igualdad con la celda', async () => {
		const { store, calls } = capture_store();
		await store.find_many('user-group', { where: { user_ids: 'u1' }, take: 200, populate: false });
		const list = calls.find((c) => c.query.includes('"user_ids"'));
		expect(list?.query).toContain(id_list_member_sql('"user_ids"::text', '$1'));
		expect(list?.query).not.toContain('"user_ids" = $1');
		expect(list?.params).toContain('u1');
	});

	test('varios valores: basta con que uno esté en la lista', async () => {
		const { store, calls } = capture_store();
		await store.find_many('user-group', { where: { user_ids: { in: ['u1', 'u2'] } }, take: 200, populate: false });
		const list = calls.find((c) => c.query.includes('"user_ids"'));
		expect(list?.query).toContain(
			`(${id_list_member_sql('"user_ids"::text', '$1')} OR ${id_list_member_sql('"user_ids"::text', '$2')})`,
		);
		expect(list?.query).not.toContain('"user_ids" IN');
	});

	test('un campo que no es lista conserva la igualdad', async () => {
		const { store, calls } = capture_store();
		await store.find_many('user-group', { where: { name: 'Ventas' }, take: 200, populate: false });
		expect(calls.some((c) => c.query.includes('"name" = $1'))).toBe(true);
	});
});

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const store = sql ? new ImperiumStore(sql, load_catalog_path()) : null;
const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const created: string[] = [];

afterAll(async () => {
	if (!sql || !store) return;
	if (created.length) {
		await sql.unsafe(
			`DELETE FROM ${store.qt('user-group')} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[created],
		);
	}
	await sql.close();
});

describe.skipIf(!sql)('grupos del usuario en Postgres', () => {
	const db = sql!;
	const st = store!;

	beforeAll(async () => {
		const [schema] = st.qt('user-group').split('.');
		await db.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
		await db.unsafe(`
			CREATE TABLE IF NOT EXISTS ${st.qt('user-group')} (
				id TEXT PRIMARY KEY, name TEXT, description TEXT, is_active BOOLEAN DEFAULT true,
				state TEXT, ref TEXT, search_field TEXT, created_by TEXT,
				custom_data JSONB DEFAULT '{}'::jsonb, payload JSONB DEFAULT '{}'::jsonb,
				created_at TEXT, updated_at TEXT,
				menus_ids TEXT, user_ids TEXT, access_rights_ids TEXT, record_rules_ids TEXT
			)`);
	});

	test('find_many con user_ids trae solo los grupos que contienen al usuario', async () => {
		const ana = hex_id();
		const beto = `${ana}0`;
		const tag = hex_id();
		const grupo = async (name: string, user_ids: unknown) => {
			const id = hex_id();
			created.push(id);
			await st.insert('user-group', { _id: id, name: `${tag} ${name}`, user_ids } as never);
			return id;
		};
		const ventas = await grupo('Ventas', [beto, ana]);
		const almacen = await grupo('Almacén', [{ _id: ana }]);
		await grupo('Solo Beto', [beto]);
		await grupo('Vacío', []);
		await grupo('Sin lista', null);

		const { rows } = await st.find_many('user-group', { where: { user_ids: ana }, take: 200, populate: false, sql_search_only: true });
		const mine = rows.filter((row) => String(row.name).startsWith(tag)).map((row) => row._id).sort();
		expect(mine).toEqual([ventas, almacen].sort());
	});

	test('el predicado aguanta texto, jsonb, NULL y texto legado que no es JSON', async () => {
		const rows = (await db.unsafe(
			`SELECT k FROM (VALUES
				('texto', '["u1","u2"]'::text),
				('jsonb', '["u2", "u1"]'::jsonb::text),
				('objeto', '[{"_id":"u1"}]'),
				('suelto', 'u1'),
				('legado', 'u1, u2 sin json'),
				('prefijo', '["u10"]'),
				('vacio', '[]'),
				('nulo', NULL)
			) AS t(k, user_ids)
			WHERE ${id_list_member_sql('user_ids', '$1')}
			ORDER BY k`,
			['u1'],
		)) as Array<{ k: string }>;
		expect(rows.map((r) => r.k)).toEqual(['jsonb', 'objeto', 'suelto', 'texto']);
	});
});
