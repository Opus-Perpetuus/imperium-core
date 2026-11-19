import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { decorate_list_instance_type } from './list-headers.ts';
import { list_instance_type, list_projection_keys, project_list_docs } from './list-projection.ts';
import {
	decorate_pedido,
	enrich_pedidos_list,
	looks_like_record_id,
	resolve_pedidos_usuario_filter,
} from './pedidos-flow.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const BASE = ['subject-configuracion', 'subject-configuraciones-de-vista', 'subject-planeacion'];
const USER_ID = '507f1f77bcf86cd799439011';

function store_with_users(users: ImperiumDoc[]) {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.set_installed_subjects([...BASE, 'subject-ventas']);
	(store as unknown as { find_many: unknown }).find_many = async (resource: string, opts: { ids?: string[]; where?: Record<string, unknown> } = {}) => {
		if (resource === 'delivery-route') return { rows: [], total: 0 };
		if (resource !== 'user') throw new Error(`consulta inesperada a ${resource}`);
		let rows = users;
		const ids = opts.ids ?? [];
		if (ids.length) rows = rows.filter((row) => ids.includes(String(row._id)));
		const name = opts.where?.name;
		if (typeof name === 'string') rows = rows.filter((row) => row.name === name);
		else if (name && typeof name === 'object' && Array.isArray((name as { in?: unknown[] }).in)) {
			const wanted = new Set((name as { in: unknown[] }).in.map(String));
			rows = rows.filter((row) => wanted.has(String(row.name)));
		}
		return { rows, total: rows.length };
	};
	return store;
}

describe('lista de pedidos: columna Vendedor', () => {
	test('la proyección incluye usuario como columna y oculta usuario_id', () => {
		expect(list_projection_keys('pedidos')).toContain('usuario');
		expect(list_projection_keys('pedidos')).toContain('usuario_id');
		const tipo = list_instance_type('pedidos') ?? {};
		expect(Object.keys(tipo)).toContain('usuario');
		expect(Object.keys(tipo)).not.toContain('usuario_id');
	});

	test('el encabezado de usuario es Vendedor', () => {
		const out = decorate_list_instance_type('pedidos', {
			usuario: { nombre_encabezado: 'usuario', tipo: 'string' },
		});
		expect(out.usuario).toEqual({ nombre_encabezado: 'Vendedor', tipo: 'string' });
	});

	test('decorate_pedido en lista deja el nombre del vendedor y su id', () => {
		const row = decorate_pedido(
			{ _id: 'p-1', folio: '10', usuario: { _id: USER_ID, name: 'IA Vendedor' } },
			'list',
		);
		expect(row.usuario).toBe('IA Vendedor');
		expect(row.usuario_id).toBe(USER_ID);
	});

	test('enrich_pedidos_list resuelve el nombre si solo llega el id', async () => {
		const store = store_with_users([{ _id: USER_ID, name: 'IA Vendedor' }]);
		const rows = await enrich_pedidos_list(store, [
			{ _id: 'p-1', folio: '10', usuario: USER_ID },
		]);
		expect(rows[0]!.usuario).toBe('IA Vendedor');
		expect(rows[0]!.usuario_id).toBe(USER_ID);
		expect(project_list_docs('pedidos', rows)[0]!.usuario).toBe('IA Vendedor');
	});

	test('looks_like_record_id distingue ids de nombres', () => {
		expect(looks_like_record_id(USER_ID)).toBe(true);
		expect(looks_like_record_id('IA Vendedor')).toBe(false);
		expect(looks_like_record_id('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
	});

	test('el filtro por nombre de vendedor se reescribe a ids', async () => {
		const store = store_with_users([
			{ _id: USER_ID, name: 'IA Vendedor' },
			{ _id: '507f1f77bcf86cd799439012', name: 'IA Ventas' },
		]);
		expect(await resolve_pedidos_usuario_filter(store, { usuario: 'IA Vendedor', estado: 'confirmado' })).toEqual({
			estado: 'confirmado',
			usuario: { in: [USER_ID] },
		});
		expect(await resolve_pedidos_usuario_filter(store, { usuario: USER_ID })).toEqual({
			usuario: { in: [USER_ID] },
		});
		expect(await resolve_pedidos_usuario_filter(store, { usuario: 'Nadie' })).toEqual({
			usuario: '__no_match__',
		});
		expect(await resolve_pedidos_usuario_filter(store, { estado: 'confirmado' })).toEqual({
			estado: 'confirmado',
		});
	});
});
