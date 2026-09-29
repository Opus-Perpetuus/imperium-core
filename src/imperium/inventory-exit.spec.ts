import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { apply_quant_delta, recompute_product_existencia } from './delivery-return-flow.ts';
import { register_package_delivery_exit } from './inventory-logistics-flow.ts';
import { register_pos_ticket_exit } from './inventory-exit.ts';
import { register_order_fulfillment_exit } from './pedidos-flow.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const PEDIDO = '507f1f77bcf86cd799439011';
const BULTO = '507f1f77bcf86cd799439012';
const ANAQUEL_A = '507f1f77bcf86cd799439021';
const ANAQUEL_B = '507f1f77bcf86cd799439022';
const ALMACEN = '507f1f77bcf86cd799439023';
const RECEPCION = '507f1f77bcf86cd799439024';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
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
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(
			resource: string,
			opts: { where?: Record<string, unknown>; take?: number; ids?: string[] } = {},
		) {
			const rows = (data[resource] ?? []).filter(
				(row) => matches(row, opts.where) && (!opts.ids || opts.ids.includes(String(row._id))),
			);
			const take = opts.take ?? rows.length;
			return { rows: rows.slice(0, take), total: rows.length };
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
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
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

const ubicaciones: Row[] = [
	{ _id: ANAQUEL_A, codigo: 'A-01', secuencia_surtido: 2 },
	{ _id: ANAQUEL_B, codigo: 'B-01', secuencia_surtido: 1 },
	{ _id: ALMACEN, codigo: 'ALM', _ref: 'inventory-internal-location-warehouse' },
	{ _id: RECEPCION, codigo: 'REC' },
];

function quant(ubicacion: string, ubicacion_codigo: string, cantidad: number): Row {
	return {
		_id: `q-${ubicacion}`,
		producto: PRODUCTO,
		ubicacion,
		ubicacion_codigo,
		cantidad,
		cantidad_apartada: 0,
		cantidad_disponible: cantidad,
	};
}

function store_con(existencia: number, quants: Row[], extra: Row = {}) {
	return memory_store({
		products: [{ _id: PRODUCTO, name: 'Codo', codigo: 'COD-1', existencia, ...extra }],
		'inventory-stock-quant': quants,
		'inventory-internal-location': ubicaciones,
		'inventory-movement': [],
		pedidos: [],
	});
}

function cantidades(store: { data: Record<string, Row[]> }) {
	return Object.fromEntries(
		store.data['inventory-stock-quant'].map((row) => [row.ubicacion_codigo, row.cantidad]),
	);
}

function suma_quants(store: { data: Record<string, Row[]> }) {
	return store.data['inventory-stock-quant'].reduce((acc, row) => acc + Number(row.cantidad), 0);
}

const pedido_surtido = (cantidad: number): Row => ({
	_id: PEDIDO,
	folio: 7,
	articulos: [{ product: PRODUCTO, cantidad }],
});

describe('salidas de inventario por ubicación', () => {
	test('recibo 10, surto 3, recibo 5: la existencia queda en 12, no en 15', async () => {
		const store = store_con(10, [quant(ANAQUEL_A, 'A-01', 10)]);
		await register_order_fulfillment_exit(store, pedido_surtido(3));
		await apply_quant_delta(store, {
			producto: PRODUCTO,
			producto_nombre: 'Codo',
			producto_codigo: 'COD-1',
			ubicacion: RECEPCION,
			ubicacion_codigo: 'REC',
			delta: 5,
		});
		await recompute_product_existencia(store, PRODUCTO);
		const product = await store.find_id('products', PRODUCTO);
		expect(product?.existencia).toBe(12);
		expect(cantidades(store)).toEqual({ 'A-01': 7, REC: 5 });
	});

	test('descuenta en el orden de la ruta de surtido', async () => {
		const store = store_con(4, [quant(ANAQUEL_A, 'A-01', 2), quant(ANAQUEL_B, 'B-01', 2)]);
		await register_order_fulfillment_exit(store, pedido_surtido(3));
		expect(cantidades(store)).toEqual({ 'A-01': 1, 'B-01': 0 });
	});

	test('lo que falta por ubicación sale del almacén general y la suma sigue igual a la existencia', async () => {
		const store = store_con(2, [quant(ANAQUEL_A, 'A-01', 2)]);
		await register_order_fulfillment_exit(store, pedido_surtido(3));
		const product = await store.find_id('products', PRODUCTO);
		expect(product?.existencia).toBe(-1);
		expect(cantidades(store)).toEqual({ 'A-01': 0, ALM: -1 });
		expect(suma_quants(store)).toBe(-1);
	});

	test('un producto sin existencias por ubicación sigue como hoy', async () => {
		const store = store_con(10, []);
		await register_order_fulfillment_exit(store, pedido_surtido(3));
		const product = await store.find_id('products', PRODUCTO);
		expect(product?.existencia).toBe(7);
		expect(store.data['inventory-stock-quant']).toEqual([]);
	});

	test('repetir la salida del mismo pedido no descuenta dos veces', async () => {
		const store = store_con(10, [quant(ANAQUEL_A, 'A-01', 10)]);
		await register_order_fulfillment_exit(store, pedido_surtido(3));
		await register_order_fulfillment_exit(store, pedido_surtido(3));
		expect(cantidades(store)).toEqual({ 'A-01': 7 });
	});

	test('la entrega de un bulto descuenta por ubicación', async () => {
		const store = store_con(10, [quant(ANAQUEL_A, 'A-01', 10)], { existenciaApartada: 4 });
		await register_package_delivery_exit(
			store,
			{ _id: BULTO, name: 'BULTO-1', contenido: [{ product: PRODUCTO, quantity: 4 }] },
			'evento-1',
			'2026-09-28T12:00:00.000Z',
		);
		const product = await store.find_id('products', PRODUCTO);
		expect(product?.existencia).toBe(6);
		expect(product?.existenciaApartada).toBe(0);
		expect(cantidades(store)).toEqual({ 'A-01': 6 });
	});

	test('el ticket de POS descuenta por ubicación lo mismo que baja la existencia', async () => {
		const store = store_con(2, [quant(ANAQUEL_A, 'A-01', 2)]);
		await register_pos_ticket_exit(store, {
			ticket_type: 'VENTA',
			items: [{ item_id: PRODUCTO, quantity: 5 }],
		});
		const product = await store.find_id('products', PRODUCTO);
		expect(product?.existencia).toBe(0);
		expect(cantidades(store)).toEqual({ 'A-01': 0 });
	});

	test('un ticket que no es venta no mueve existencias', async () => {
		const store = store_con(2, [quant(ANAQUEL_A, 'A-01', 2)]);
		await register_pos_ticket_exit(store, {
			ticket_type: 'RETIRO',
			items: [{ item_id: PRODUCTO, quantity: 1 }],
		});
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(2);
		expect(cantidades(store)).toEqual({ 'A-01': 2 });
	});
});
