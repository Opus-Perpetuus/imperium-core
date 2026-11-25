import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import {
	computed_distinct_counts,
	DECORATED_LIST_FIELDS,
	is_decorated_list_field,
	resolve_list_filters,
	undecorated_filter_gaps,
	visible_list_filter_columns,
} from './list-computed-fields.ts';
import { list_instance_type } from './list-projection.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const BASE = ['subject-configuracion', 'subject-configuraciones-de-vista', 'subject-planeacion'];
const USER_ID = '507f1f77bcf86cd799439011';

const ROUTES: ImperiumDoc[] = [
	{ _id: 'r-norte', name: 'Zona Norte', contacts: ['c-1', { _id: 'c-3' }] },
	{ _id: 'r-centro', name: 'Centro', contacts: JSON.stringify([{ $oid: 'c-1' }, 'c-2']) },
];

const USERS: ImperiumDoc[] = [
	{ _id: USER_ID, name: 'IA Vendedor' },
	{ _id: '507f1f77bcf86cd799439012', name: 'IA Ventas' },
];

type Counts = Array<{ v: unknown; n: number }>;

function store_with(opts: { routes?: ImperiumDoc[]; users?: ImperiumDoc[]; counts?: Record<string, Counts> } = {}) {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.set_installed_subjects([...BASE, 'subject-ventas', 'subject-logistica']);
	const routes = opts.routes ?? ROUTES;
	const users = opts.users ?? USERS;
	const counts = opts.counts ?? {};
	(store as unknown as { find_many: unknown }).find_many = async (
		resource: string,
		find_opts: { ids?: string[]; where?: Record<string, unknown> } = {},
	) => {
		if (resource === 'delivery-route') return { rows: routes, total: routes.length };
		if (resource !== 'user') throw new Error(`consulta inesperada a ${resource}`);
		let rows = users;
		const ids = find_opts.ids ?? [];
		if (ids.length) rows = rows.filter((row) => ids.includes(String(row._id)));
		const name = find_opts.where?.name;
		if (typeof name === 'string') rows = rows.filter((row) => row.name === name);
		else if (name && typeof name === 'object' && Array.isArray((name as { in?: unknown[] }).in)) {
			const wanted = new Set((name as { in: unknown[] }).in.map(String));
			rows = rows.filter((row) => wanted.has(String(row.name)));
		}
		return { rows, total: rows.length };
	};
	(store as unknown as { distinct_counts: unknown }).distinct_counts = async (
		_resource: string,
		field: string,
	): Promise<Counts> => counts[field] ?? [];
	return store;
}

describe('#358 filtro automático de columnas calculadas y relacionales', () => {
	test('ruta está decorada en pedidos, pedidos-surtir y contactos, y sale en la proyección', () => {
		expect(is_decorated_list_field('pedidos', 'ruta')).toBe(true);
		expect(is_decorated_list_field('pedidos-surtir', 'ruta')).toBe(true);
		expect(is_decorated_list_field('contacto', 'ruta')).toBe(true);
		expect(is_decorated_list_field('pedidos', 'folio')).toBe(false);
		expect(list_instance_type('pedidos')?.ruta?.tipo).toBe('string');
		expect(list_instance_type('contacto')?.ruta?.tipo).toBe('string');
		expect(visible_list_filter_columns('pedidos')).toContain('ruta');
		expect(visible_list_filter_columns('pedidos')).toContain('usuario');
		expect(visible_list_filter_columns('pedidos')).not.toContain('usuario_id');
		expect(undecorated_filter_gaps()).toEqual([]);
		expect(DECORATED_LIST_FIELDS.length).toBeGreaterThan(0);
	});

	test('filtrar pedidos por el nombre de la ruta se reescribe a los contactos de esa ruta', async () => {
		const store = store_with();
		expect(await resolve_list_filters(store, 'pedidos', { ruta: 'Centro', estado: 'por_surtir' })).toEqual({
			estado: 'por_surtir',
			contacto_id: { in: ['c-1', 'c-2'] },
		});
	});

	test('un pedido cuyo cliente está en varias rutas coincide si se elige una de ellas', async () => {
		const store = store_with();
		const where = await resolve_list_filters(store, 'pedidos', { ruta: 'Zona Norte' });
		expect(where).toEqual({ contacto_id: { in: ['c-1', 'c-3'] } });
		expect((where.contacto_id as { in: string[] }).in).toContain('c-1');
	});

	test('varias rutas se unen; si no hay coincidencia no devuelve filas', async () => {
		const store = store_with();
		const both = await resolve_list_filters(store, 'pedidos', { ruta: { in: ['Centro', 'Zona Norte'] } });
		expect(new Set((both.contacto_id as { in: string[] }).in)).toEqual(new Set(['c-1', 'c-2', 'c-3']));
		expect(await resolve_list_filters(store, 'pedidos', { ruta: 'Ruta fantasma' })).toEqual({
			contacto_id: '__no_match__',
		});
	});

	test('en contactos el filtro de ruta recorta por id del contacto', async () => {
		const store = store_with();
		expect(await resolve_list_filters(store, 'contacto', { ruta: 'Centro' })).toEqual({
			_id: { in: ['c-1', 'c-2'] },
		});
	});

	test('el menú de Ruta lista nombres individuales con el conteo de pedidos', async () => {
		const store = store_with({
			counts: {
				contacto_id: [
					{ v: 'c-1', n: 2 },
					{ v: 'c-2', n: 1 },
					{ v: 'c-3', n: 3 },
				],
			},
		});
		const values = await computed_distinct_counts(store, 'pedidos', 'ruta');
		expect(values).toEqual([
			{ v: 'Centro', n: 3 },
			{ v: 'Zona Norte', n: 5 },
		]);
	});

	test('la búsqueda del menú recorta por nombre de ruta', async () => {
		const store = store_with({
			counts: { contacto_id: [{ v: 'c-1', n: 1 }] },
		});
		const values = await computed_distinct_counts(store, 'pedidos', 'ruta', { q: 'nor' });
		expect(values).toEqual([{ v: 'Zona Norte', n: 1 }]);
	});

	test('el filtro por nombre de vendedor sigue reescribiéndose a ids', async () => {
		const store = store_with();
		expect(await resolve_list_filters(store, 'pedidos', { usuario: 'IA Vendedor', estado: 'confirmado' })).toEqual({
			estado: 'confirmado',
			usuario: { in: [USER_ID] },
		});
	});

	test('ruta y vendedor se pueden combinar en el mismo where', async () => {
		const store = store_with();
		expect(await resolve_list_filters(store, 'pedidos', { ruta: 'Centro', usuario: 'IA Vendedor' })).toEqual({
			usuario: { in: [USER_ID] },
			contacto_id: { in: ['c-1', 'c-2'] },
		});
	});

	test('computed_distinct_counts no interviene en columnas físicas', async () => {
		const store = store_with();
		expect(await computed_distinct_counts(store, 'pedidos', 'estado')).toBeNull();
	});
});
