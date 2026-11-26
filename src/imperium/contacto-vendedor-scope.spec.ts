/**
 * Clientes por vendedor (#291). La parte de SQL corre contra un Postgres real
 * solo con CONTACTO_VENDEDOR_PG_URL (crea y borra una tabla temporal):
 *
 *   CONTACTO_VENDEDOR_PG_URL=postgres://imperium@127.0.0.1:5434/imperium_core bun test src/imperium/contacto-vendedor-scope.spec.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	con_vendedor_asignado,
	contacto_vendedor_match,
	vendedor_ve_solo_sus_clientes,
} from './contacto-vendedor-scope.ts';
import { record_rule_scope } from './crud.ts';
import type { ImperiumDoc } from './envelope.ts';
import { GROUP_REF_VENDEDORES, GROUP_REF_VENTAS } from './group-access.ts';
import { list_search_columns, uses_word_search, word_search_sql } from './list-search.ts';
import { mongo_match_to_sql } from './record-rules.ts';
import type { ImperiumStore } from './store.ts';

const VENDEDOR = { _id: '64a1b2c3d4e5f6a7b8c9d0e1', name: 'IA Vendedor' };
const OTRO = '64a1b2c3d4e5f6a7b8c9d0ff';
const vendedor_access = { has_full_access: false, user_group_refs: [GROUP_REF_VENDEDORES] };

describe('quién ve solo sus clientes', () => {
	test('un vendedor sí; admin, ventas y quien administra grupos no', () => {
		expect(vendedor_ve_solo_sus_clientes(vendedor_access)).toBe(true);
		expect(vendedor_ve_solo_sus_clientes({ has_full_access: true, user_group_refs: [GROUP_REF_VENDEDORES] })).toBe(false);
		expect(vendedor_ve_solo_sus_clientes({ user_group_refs: [GROUP_REF_VENDEDORES, GROUP_REF_VENTAS] })).toBe(false);
		expect(
			vendedor_ve_solo_sus_clientes({
				user_group_refs: [GROUP_REF_VENDEDORES],
				permissions_by_model: { UserGroup: { allow_update: true } },
			}),
		).toBe(false);
		expect(vendedor_ve_solo_sus_clientes({ user_group_refs: ['user-group-almacen'] })).toBe(false);
		expect(vendedor_ve_solo_sus_clientes(null)).toBe(false);
	});

	test('el filtro es solo para contacto y por el id del vendedor', () => {
		expect(contacto_vendedor_match('pedidos', vendedor_access, VENDEDOR)).toBeNull();
		expect(contacto_vendedor_match('contacto', { user_group_refs: [GROUP_REF_VENTAS] }, VENDEDOR)).toBeNull();
		expect(contacto_vendedor_match('contacto', vendedor_access, VENDEDOR)).toEqual({
			usuariosAsignados: { $regex: VENDEDOR._id },
		});
		const params: unknown[] = [];
		const sql = mongo_match_to_sql(
			contacto_vendedor_match('contacto', vendedor_access, VENDEDOR),
			new Set(['usuariosAsignados']),
			params,
		);
		expect(sql).toContain('"usuariosAsignados"');
		expect(params).toEqual([VENDEDOR._id]);
	});

	test('el cliente que da de alta un vendedor queda asignado a él', () => {
		expect(con_vendedor_asignado({ name: 'Nuevo' }, vendedor_access, VENDEDOR).usuariosAsignados).toEqual([VENDEDOR._id]);
		expect(con_vendedor_asignado({ name: 'N', usuariosAsignados: `["${OTRO}"]` }, vendedor_access, VENDEDOR).usuariosAsignados).toEqual([OTRO, VENDEDOR._id]);
		const ya = { name: 'N', usuariosAsignados: [VENDEDOR._id] };
		expect(con_vendedor_asignado(ya, vendedor_access, VENDEDOR)).toBe(ya);
		const admin = { name: 'N' };
		expect(con_vendedor_asignado(admin, { has_full_access: true }, VENDEDOR)).toBe(admin);
	});
});

/* Store mínimo para build_access: grupos, derechos y reglas de registro. */
function fake_store(groups: ImperiumDoc[], rules: ImperiumDoc[] = []): ImperiumStore {
	const data: Record<string, ImperiumDoc[]> = {
		'user-group': groups,
		'access-rights': [],
		'record-rules': rules,
	};
	return {
		has: (resource: string) => resource in data,
		is_resource_installed: () => true,
		is_model_installed: () => true,
		resource_for_model: (model: string) => (model === 'RecordRules' ? 'record-rules' : null),
		async *scan(resource: string) {
			yield data[resource] ?? [];
		},
	} as unknown as ImperiumStore;
}

describe('el alcance del CRUD de contacto (lo que no puede saltar el front)', () => {
	const grupo = (ref: string, users: string[]) => ({ _id: `g-${ref}`, _ref: ref, name: ref, user_ids: users });

	test('vendedor: lista, detalle, editar y borrar quedan acotados a sus clientes', async () => {
		const store = fake_store([grupo(GROUP_REF_VENDEDORES, [VENDEDOR._id])]);
		for (const method of ['GET', 'PUT', 'DELETE']) {
			const scope = await record_rule_scope(store, VENDEDOR, 'contacto', method);
			expect(scope.match).toEqual({ usuariosAsignados: { $regex: VENDEDOR._id } });
		}
		expect((await record_rule_scope(store, VENDEDOR, 'pedidos', 'GET')).match).toBeNull();
	});

	test('vendedor que también es de Ventas: ve todo', async () => {
		const store = fake_store([
			grupo(GROUP_REF_VENDEDORES, [VENDEDOR._id]),
			grupo(GROUP_REF_VENTAS, [VENDEDOR._id]),
		]);
		expect((await record_rule_scope(store, VENDEDOR, 'contacto', 'GET')).match).toBeNull();
	});

	test('admin sembrado: ve todo', async () => {
		const admin = { _id: 'adm', _ref: 'user-menu-management-0' };
		expect((await record_rule_scope(fake_store([]), admin, 'contacto', 'GET')).match).toBeNull();
	});
});

describe('búsqueda de contactos por nombre', () => {
	test('contacto busca por palabras sin acentos en nombre, código y RFC', () => {
		expect(uses_word_search('contacto')).toBe(true);
		expect(uses_word_search('pedidos')).toBe(false);
		const cols = list_search_columns('contacto', ['name', 'search_field', 'codigo', 'rfc', 'usuariosAsignados']);
		expect(cols).toEqual(['name', 'search_field', 'codigo', 'rfc']);
		const params: string[] = [];
		const sql = word_search_sql(['name', 'codigo'], 'María  GONZÁLEZ', (v) => {
			params.push(v);
			return `$${params.length}`;
		}, (c) => `"${c}"`);
		expect(params).toEqual(['%maria%', '%gonzalez%']);
		expect(sql.match(/ AND /g)).toHaveLength(1);
		expect(sql).toContain(`translate(lower("name"::text)`);
	});
});

const URL_PG = process.env.CONTACTO_VENDEDOR_PG_URL ?? '';
const d = URL_PG ? describe : describe.skip;

d('contacto en Postgres real', () => {
	let sql: Bun.SQL;
	const table = 'tmp_contacto_vendedor_291';
	beforeAll(async () => {
		sql = new Bun.SQL(URL_PG);
		await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await sql.unsafe(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, name TEXT, codigo TEXT, "usuariosAsignados" TEXT)`);
		await sql.unsafe(
			`INSERT INTO ${table} VALUES
				('c1', 'FAUSTO GONZÁLEZ MARÍA CECILIA', '102415', $1),
				('c2', 'Ferretería Gonzalo', '200777', $2),
				('c3', 'Abarrotes Peña', '300', $3),
				('c4', 'Sin vendedor', '400', NULL)`,
			[`["${VENDEDOR._id}"]`, `${OTRO},${VENDEDOR._id}`, `["${OTRO}"]`],
		);
	});
	afterAll(async () => {
		await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await sql.close();
	});

	const query = async (where: string, params: unknown[]) =>
		((await sql.unsafe(`SELECT id FROM ${table} WHERE ${where} ORDER BY id`, params)) as Array<{ id: string }>).map((r) => r.id);

	test('el vendedor solo recibe sus clientes (arreglo JSON o lista con comas)', async () => {
		const params: unknown[] = [];
		const where = mongo_match_to_sql(contacto_vendedor_match('contacto', vendedor_access, VENDEDOR), new Set(['usuariosAsignados']), params);
		expect(await query(where, params)).toEqual(['c1', 'c2']);
	});

	test('«maria gonzalez» halla «FAUSTO GONZÁLEZ MARÍA CECILIA»; el número sigue sirviendo', async () => {
		for (const [q, ids] of [['maria gonzalez', ['c1']], ['102415', ['c1']], ['pena', ['c3']], ['gonza', ['c1', 'c2']]] as const) {
			const params: unknown[] = [];
			const where = word_search_sql(['name', 'codigo'], q, (v) => {
				params.push(v);
				return `$${params.length}`;
			}, (c) => `"${c}"`);
			expect(await query(where, params)).toEqual([...ids]);
		}
	});
});
