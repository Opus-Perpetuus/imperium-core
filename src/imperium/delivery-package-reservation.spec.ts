import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	prepare_delivery_package_create,
	prepare_delivery_package_update,
} from './delivery-package-flow.ts';
import { sync_order_logistics_reservation } from './inventory-logistics-flow.ts';

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
});
