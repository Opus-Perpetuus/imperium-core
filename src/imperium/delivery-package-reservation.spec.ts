import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	prepare_delivery_package_create,
	prepare_delivery_package_update,
} from './delivery-package-flow.ts';
import {
	list_delivery_package_inventory_inconsistencies,
	sync_order_logistics_reservation,
} from './inventory-logistics-flow.ts';

const PEDIDO = '507f1f77bcf86cd799439011';
const BULTO = '507f1f77bcf86cd799439012';
const TORNILLO = '507f1f77bcf86cd799439013';
const TUERCA = '507f1f77bcf86cd799439014';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
	const folios: string[] = [];
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => {
			if (value && typeof value === 'object' && 'in' in value) {
				return (value as { in: unknown[] }).in.includes(row[key]);
			}
			return row[key] === value;
		});
	};
	const store = {
		data,
		folios,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async assert_resource_installed() {},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			const rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			return { rows, total: rows.length };
		},
		async count(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			return (data[resource] ?? []).filter((row) => matches(row, opts.where)).length;
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async next_auto_increment() {
			folios.push('consumido');
			throw new Error('folio consumido');
		},
		async insert(resource: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${crypto.randomUUID()}` };
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch, _id: id };
			return rows[index];
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]>; folios: string[] };
}

function pedido(estado: string): Row {
	return {
		_id: PEDIDO,
		name: 'Pedido 1',
		folio_interno: 1,
		estado,
		articulos: [
			{ product: TORNILLO, cantidad: 10 },
			{ product: TUERCA, cantidad: 10 },
		],
	};
}

const productos = (): Row[] => [
	{ _id: TORNILLO, name: 'Tornillo', existencia: 5, existenciaApartada: 0 },
	{ _id: TUERCA, name: 'Tuerca', existencia: 2, existenciaApartada: 0 },
];

describe('bultos: el apartado se valida antes de guardar', () => {
	test('sin inventario el alta se rechaza sin consumir folio', async () => {
		const store = memory_store({
			pedidos: [pedido('confirmado')],
			products: productos(),
			'delivery-package': [],
			'inventory-movement': [],
		});
		await expect(
			prepare_delivery_package_create(store, {
				pedido: PEDIDO,
				contenido: [{ product: TORNILLO, quantity: 8 }],
			}),
		).rejects.toThrow('No hay inventario suficiente para apartar 8 de Tornillo');
		expect(store.folios).toEqual([]);
	});

	test('un pedido que el alta deja en surtido no aparta ni valida', async () => {
		const store = memory_store({
			pedidos: [pedido('por_surtir')],
			products: productos(),
			'delivery-package': [],
			'inventory-movement': [],
		});
		await expect(
			prepare_delivery_package_create(store, {
				pedido: PEDIDO,
				contenido: [{ product: TORNILLO, quantity: 8 }],
			}),
		).rejects.toThrow('folio consumido');
	});

	test('al editar un bulto no cuenta dos veces su propio apartado', async () => {
		const bulto = {
			_id: BULTO,
			pedido: PEDIDO,
			estado: 'pendiente',
			codigo_bulto: 'BULTO-000001',
			name: 'BULTO-000001',
			contenido: [{ product: TORNILLO, quantity: 4 }],
		};
		const store = memory_store({
			pedidos: [pedido('confirmado')],
			products: [{ _id: TORNILLO, name: 'Tornillo', existencia: 5, existenciaApartada: 4 }],
			'delivery-package': [bulto],
			'inventory-movement': [
				{
					documento_tipo: 'pedido',
					documento_id: PEDIDO,
					tipo_movimiento: 'apartado_logistica',
					producto: TORNILLO,
					cantidad: 4,
				},
			],
		});
		const out = await prepare_delivery_package_update(
			store,
			{ contenido: [{ product: TORNILLO, quantity: 5 }] },
			bulto,
		);
		expect(out.codigo_bulto).toBe('BULTO-000001');
		await expect(
			prepare_delivery_package_update(
				store,
				{ contenido: [{ product: TORNILLO, quantity: 6 }] },
				bulto,
			),
		).rejects.toThrow('No hay inventario suficiente para apartar 2 de Tornillo');
	});

	test('si un producto no alcanza no se aparta ninguno', async () => {
		const store = memory_store({
			pedidos: [pedido('confirmado')],
			products: productos(),
			'delivery-package': [
				{
					_id: BULTO,
					pedido: PEDIDO,
					estado: 'pendiente',
					contenido: [
						{ product: TORNILLO, quantity: 3 },
						{ product: TUERCA, quantity: 3 },
					],
				},
			],
			'inventory-movement': [],
		});
		await expect(sync_order_logistics_reservation(store, PEDIDO)).rejects.toThrow(
			'No hay inventario suficiente para apartar 3 de Tuerca',
		);
		expect(store.data.products.map((p) => p.existenciaApartada)).toEqual([0, 0]);
		expect(store.data['inventory-movement']).toEqual([]);
	});

	test('sin confirmación lista el faltante y no aparta ni consume folio', async () => {
		const store = memory_store({
			pedidos: [pedido('confirmado')],
			products: [{ _id: TORNILLO, name: 'Tornillo' }],
			'delivery-package': [],
			'inventory-movement': [],
		});
		const gaps = await list_delivery_package_inventory_inconsistencies(
			store,
			pedido('confirmado'),
			[{ product: TORNILLO, quantity: 2 }],
		);
		expect(gaps).toEqual([
			{
				product: TORNILLO,
				producto: 'Tornillo',
				cantidad_a_apartar: 2,
				cantidad_registrada: 0,
			},
		]);
		expect(store.folios).toEqual([]);
		expect(store.data['inventory-movement']).toEqual([]);
	});

	test('la confirmación deja seguir el alta y registra el apartado', async () => {
		const store = memory_store({
			pedidos: [pedido('confirmado')],
			products: productos(),
			'delivery-package': [
				{
					_id: BULTO,
					pedido: PEDIDO,
					estado: 'pendiente',
					contenido: [{ product: TORNILLO, quantity: 8 }],
				},
			],
			'inventory-movement': [],
		});
		await expect(
			prepare_delivery_package_create(
				store,
				{
					pedido: PEDIDO,
					contenido: [{ product: TORNILLO, quantity: 8 }],
					confirmar_inventario_inconsistente: true,
				},
				{ confirmar_inventario_inconsistente: true },
			),
		).rejects.toThrow('folio consumido');
		await sync_order_logistics_reservation(store, PEDIDO, {
			permitir_inventario_inconsistente: true,
		});
		expect(store.data.products.find((row) => row._id === TORNILLO)?.existenciaApartada).toBe(8);
		expect(store.data['inventory-movement']).toHaveLength(1);
	});

	test('con almacén del pedido aparta lo que sí hay en ese alcance', async () => {
		const ALM_RUTA = '507f1f77bcf86cd799439021';
		const ALM_GENERAL = '507f1f77bcf86cd799439022';
		const store = memory_store({
			pedidos: [{ ...pedido('confirmado'), almacen: ALM_RUTA }],
			products: [{ _id: TORNILLO, name: 'Tornillo', existencia: 43, existenciaApartada: 0 }],
			'inventory-internal-location': [
				{ _id: ALM_RUTA, name: 'Ruta', tipo: 'almacen' },
				{ _id: ALM_GENERAL, name: 'General', tipo: 'almacen' },
			],
			'inventory-stock-quant': [
				{
					_id: 'q-ruta',
					producto: TORNILLO,
					ubicacion: ALM_RUTA,
					cantidad: 3,
					cantidad_apartada: 0,
					cantidad_disponible: 3,
				},
				{
					_id: 'q-gen',
					producto: TORNILLO,
					ubicacion: ALM_GENERAL,
					cantidad: 40,
					cantidad_apartada: 0,
					cantidad_disponible: 40,
				},
			],
			'delivery-package': [
				{
					_id: BULTO,
					pedido: PEDIDO,
					estado: 'pendiente',
					contenido: [{ product: TORNILLO, quantity: 3 }],
				},
			],
			'inventory-movement': [],
		});
		await sync_order_logistics_reservation(store, PEDIDO);
		expect(store.data.products[0].existenciaApartada).toBe(3);
		expect(store.data['inventory-movement']).toHaveLength(1);
	});

	test('con almacén del pedido no aparta existencia de otro almacén', async () => {
		const ALM_RUTA = '507f1f77bcf86cd799439021';
		const ALM_GENERAL = '507f1f77bcf86cd799439022';
		const ANAQUEL = '507f1f77bcf86cd799439023';
		const store = memory_store({
			pedidos: [{ ...pedido('confirmado'), almacen: ALM_RUTA }],
			products: [{ _id: TORNILLO, name: 'Tornillo', existencia: 43, existenciaApartada: 0 }],
			'inventory-internal-location': [
				{ _id: ALM_RUTA, name: 'Ruta', tipo: 'almacen' },
				{
					_id: ALM_GENERAL,
					name: 'General',
					tipo: 'almacen',
					_ref: 'inventory-internal-location-warehouse',
				},
				{ _id: ANAQUEL, parent: ALM_RUTA, tipo: 'almacen' },
			],
			'inventory-stock-quant': [
				{
					_id: 'q-anaquel',
					producto: TORNILLO,
					ubicacion: ANAQUEL,
					cantidad: 3,
					cantidad_apartada: 0,
					cantidad_disponible: 3,
				},
				{
					_id: 'q-gen',
					producto: TORNILLO,
					ubicacion: ALM_GENERAL,
					cantidad: 40,
					cantidad_apartada: 0,
					cantidad_disponible: 40,
				},
			],
			'delivery-package': [
				{
					_id: BULTO,
					pedido: PEDIDO,
					estado: 'pendiente',
					contenido: [{ product: TORNILLO, quantity: 5 }],
				},
			],
			'inventory-movement': [],
		});
		await expect(sync_order_logistics_reservation(store, PEDIDO)).rejects.toThrow(
			'No hay inventario suficiente para apartar 5 de Tornillo',
		);
		expect(store.data.products[0].existenciaApartada).toBe(0);
		expect(store.data['inventory-movement']).toEqual([]);
	});

	test('un segundo pedido del mismo almacén no reusa lo ya apartado ahí', async () => {
		const ALM_RUTA = '507f1f77bcf86cd799439021';
		const ALM_GENERAL = '507f1f77bcf86cd799439022';
		const PEDIDO_2 = '507f1f77bcf86cd799439016';
		const BULTO_2 = '507f1f77bcf86cd799439017';
		const store = memory_store({
			pedidos: [
				{ ...pedido('confirmado'), almacen: ALM_RUTA },
				{ ...pedido('confirmado'), _id: PEDIDO_2, almacen: ALM_RUTA },
			],
			products: [{ _id: TORNILLO, name: 'Tornillo', existencia: 55, existenciaApartada: 4 }],
			'inventory-internal-location': [
				{ _id: ALM_RUTA, name: 'Ruta', tipo: 'almacen' },
				{ _id: ALM_GENERAL, name: 'General', tipo: 'almacen' },
			],
			'inventory-stock-quant': [
				{
					_id: 'q-ruta',
					producto: TORNILLO,
					ubicacion: ALM_RUTA,
					cantidad: 5,
					cantidad_apartada: 0,
					cantidad_disponible: 5,
				},
				{
					_id: 'q-gen',
					producto: TORNILLO,
					ubicacion: ALM_GENERAL,
					cantidad: 50,
					cantidad_apartada: 0,
					cantidad_disponible: 50,
				},
			],
			'delivery-package': [
				{
					_id: BULTO_2,
					pedido: PEDIDO_2,
					estado: 'pendiente',
					contenido: [{ product: TORNILLO, quantity: 3 }],
				},
			],
			'inventory-movement': [
				{
					documento_tipo: 'pedido',
					documento_id: PEDIDO,
					tipo_movimiento: 'apartado_logistica',
					producto: TORNILLO,
					cantidad: 4,
				},
			],
		});
		await expect(sync_order_logistics_reservation(store, PEDIDO_2)).rejects.toThrow(
			'No hay inventario suficiente para apartar 3 de Tornillo',
		);
		expect(store.data.products[0].existenciaApartada).toBe(4);
	});

	test('sin filas por ubicación, un almacén que no es el general no tiene existencia', async () => {
		const ALM_RUTA = '507f1f77bcf86cd799439021';
		const store = memory_store({
			pedidos: [{ ...pedido('confirmado'), almacen: ALM_RUTA }],
			products: [{ _id: TORNILLO, name: 'Tornillo', existencia: 10, existenciaApartada: 0 }],
			'inventory-internal-location': [
				{ _id: ALM_RUTA, name: 'Ruta', tipo: 'almacen' },
				{
					_id: '507f1f77bcf86cd799439022',
					name: 'General',
					tipo: 'almacen',
					_ref: 'inventory-internal-location-warehouse',
				},
			],
			'inventory-stock-quant': [],
			'delivery-package': [
				{
					_id: BULTO,
					pedido: PEDIDO,
					estado: 'pendiente',
					contenido: [{ product: TORNILLO, quantity: 1 }],
				},
			],
			'inventory-movement': [],
		});
		await expect(sync_order_logistics_reservation(store, PEDIDO)).rejects.toThrow(
			'No hay inventario suficiente para apartar 1 de Tornillo',
		);
	});

	test('sin almacén en el pedido el apartado sigue con la existencia global', async () => {
		const store = memory_store({
			pedidos: [pedido('confirmado')],
			products: [{ _id: TORNILLO, name: 'Tornillo', existencia: 5, existenciaApartada: 1 }],
			'delivery-package': [
				{
					_id: BULTO,
					pedido: PEDIDO,
					estado: 'pendiente',
					contenido: [{ product: TORNILLO, quantity: 4 }],
				},
			],
			'inventory-movement': [],
		});
		await sync_order_logistics_reservation(store, PEDIDO);
		expect(store.data.products[0].existenciaApartada).toBe(5);
	});

	test('sin la marca, editar sigue rechazando el faltante', async () => {
		const bulto = {
			_id: BULTO,
			pedido: PEDIDO,
			estado: 'pendiente',
			codigo_bulto: 'BULTO-000001',
			name: 'BULTO-000001',
			contenido: [{ product: TORNILLO, quantity: 4 }],
		};
		const store = memory_store({
			pedidos: [pedido('confirmado')],
			products: [{ _id: TORNILLO, name: 'Tornillo', existencia: 5, existenciaApartada: 4 }],
			'delivery-package': [bulto],
			'inventory-movement': [
				{
					documento_tipo: 'pedido',
					documento_id: PEDIDO,
					tipo_movimiento: 'apartado_logistica',
					producto: TORNILLO,
					cantidad: 4,
				},
			],
		});
		await expect(
			prepare_delivery_package_update(
				store,
				{
					contenido: [{ product: TORNILLO, quantity: 8 }],
					confirmar_inventario_inconsistente: true,
				},
				bulto,
			),
		).rejects.toThrow('No hay inventario suficiente para apartar 4 de Tornillo');
	});
});
