import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	apply_quant_delta,
	product_has_quants,
	recompute_product_existencia,
	recibir_delivery_return,
} from './delivery-return-flow.ts';
import { register_package_delivery_exit } from './inventory-logistics-flow.ts';
import { apply_physical_count } from './inventory-physical-count-flow.ts';
import { register_pos_ticket_exit } from './inventory-exit.ts';
import { register_order_fulfillment_exit } from './pedidos-flow.ts';
import { apply_purchase_receipt_stock } from './purchase-order-flow.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const PEDIDO = '507f1f77bcf86cd799439011';
const BULTO = '507f1f77bcf86cd799439012';
const PEDIDO_2 = '507f1f77bcf86cd799439015';
const ANAQUEL_A = '507f1f77bcf86cd799439021';
const ANAQUEL_B = '507f1f77bcf86cd799439022';
const ALMACEN = '507f1f77bcf86cd799439023';
const RECEPCION = '507f1f77bcf86cd799439024';
const DEVOLUCION = '507f1f77bcf86cd799439031';
const DEVOLUCION_2 = '507f1f77bcf86cd799439032';
const CONTEO = '507f1f77bcf86cd799439033';
const CONTEO_2 = '507f1f77bcf86cd799439034';
const ORDEN = '507f1f77bcf86cd799439035';

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

	test('un producto sin existencias por ubicación descuenta del almacén general', async () => {
		const store = store_con(10, []);
		await register_order_fulfillment_exit(store, pedido_surtido(3));
		const product = await store.find_id('products', PRODUCTO);
		expect(product?.existencia).toBe(7);
		expect(cantidades(store)).toEqual({ ALM: -3 });
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

	test('la venta POS queda en movimientos de inventario', async () => {
		const store = store_con(10, [quant(ANAQUEL_A, 'A-01', 10)]);
		await register_pos_ticket_exit(store, {
			_id: 'ticket-1',
			name: 'SES-15-3',
			ticket_type: 'VENTA',
			items: [{ item_id: PRODUCTO, quantity: 3 }],
		});
		const [movimiento] = store.data['inventory-movement'];
		expect(store.data['inventory-movement']).toHaveLength(1);
		expect(movimiento).toMatchObject({
			producto: PRODUCTO,
			tipo_movimiento: 'salida_entrega',
			documento_tipo: 'pos-ticket',
			documento_id: 'ticket-1',
			documento_nombre: 'SES-15-3',
			ubicacion_origen: ALMACEN,
			cantidad: 3,
			stock_total_previo: 10,
			stock_total_resultante: 7,
		});
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

function habilitar_recepcion(store: { data: Record<string, Row[]> }) {
	const rec = store.data['inventory-internal-location'].find((row) => row._id === RECEPCION);
	if (rec) rec.permite_almacenaje = true;
}

function devolucion(id: string, cantidad = 1): Row {
	return {
		_id: id,
		name: `Devolución ${id.slice(-4)}`,
		pedido_folio: `dev-${id.slice(-4)}`,
		estado: 'firmado',
		lineas: [
			{
				producto: PRODUCTO,
				producto_nombre: 'Codo',
				producto_codigo: 'COD-1',
				cantidad,
			},
		],
	};
}

async function recibir_devolucion(
	store: ImperiumStore & { data: Record<string, Row[]> },
	id: string,
	cantidad = 1,
) {
	habilitar_recepcion(store);
	store.data['delivery-return'] = store.data['delivery-return'] ?? [];
	store.data['delivery-return'].push(devolucion(id, cantidad));
	await recibir_delivery_return(store, id, RECEPCION, null);
}

async function existencia_de(store: ImperiumStore) {
	return (await store.find_id('products', PRODUCTO))?.existencia;
}

function filas_ubicacion(store: { data: Record<string, Row[]> }, ubicacion: string) {
	return store.data['inventory-stock-quant'].filter((row) => row.ubicacion === ubicacion);
}

async function aplicar_conteo(
	store: ImperiumStore & { data: Record<string, Row[]> },
	id: string,
	sistema: number,
	contada: number,
	ubicacion?: { id: string; codigo: string },
) {
	store.data['inventory-physical-count'] = [
		{
			_id: id,
			estado: 'contado',
			name: `Conteo ${id.slice(-4)}`,
			...(ubicacion ? { ubicacion: ubicacion.id, ubicacion_codigo: ubicacion.codigo } : {}),
			lineas: [{ producto: PRODUCTO, cantidad_sistema: sistema, cantidad_contada: contada }],
		},
	];
	await apply_physical_count(store, id);
}

function compra(
	cantidad: number,
	extra: {
		lote?: string;
		lote_codigo?: string;
		sin_filas_previas?: boolean;
		receipt_key?: string;
	} = {},
) {
	return {
		producto: PRODUCTO,
		cantidad,
		costo_unitario: 8,
		source: { _id: ORDEN, name: 'OC-1' },
		receipt_key: extra.receipt_key ?? `r-${cantidad}`,
		ubicacion_destino: RECEPCION,
		...extra,
	};
}

describe('existencia general sin filas por ubicación (PROFESA 462)', () => {
	test('Mechita: dos surtidos y la devolución dejan general y suma en -3', async () => {
		const store = store_con(0, []);
		await register_order_fulfillment_exit(store, {
			_id: PEDIDO,
			folio: 7,
			articulos: [{ product: PRODUCTO, cantidad: 2 }],
		});
		await register_order_fulfillment_exit(store, {
			_id: PEDIDO_2,
			folio: 8,
			articulos: [{ product: PRODUCTO, cantidad: 2 }],
		});
		expect(await existencia_de(store)).toBe(-4);
		expect(suma_quants(store)).toBe(-4);

		await recibir_devolucion(store, DEVOLUCION, 1);
		expect(await existencia_de(store)).toBe(-3);
		expect(suma_quants(store)).toBe(-3);
		expect(cantidades(store)).toEqual({ ALM: -4, REC: 1 });
		const movimiento = store.data['inventory-movement'].find(
			(row) => row.tipo_movimiento === 'recepcion_devolucion',
		);
		expect(movimiento).toMatchObject({
			tipo_movimiento: 'recepcion_devolucion',
			stock_total_resultante: -3,
		});
	});

	test('legado sin filas: cada devolución conserva la salida en el almacén general', async () => {
		const store = store_con(-4, []);
		await recibir_devolucion(store, DEVOLUCION, 1);
		expect(await existencia_de(store)).toBe(-3);
		expect(suma_quants(store)).toBe(-3);
		expect(cantidades(store)).toEqual({ REC: 1, ALM: -4 });

		await recibir_devolucion(store, DEVOLUCION_2, 1);
		expect(await existencia_de(store)).toBe(-2);
		expect(suma_quants(store)).toBe(-2);
		expect(cantidades(store)).toEqual({ REC: 2, ALM: -4 });
	});

	test('sin almacén general la devolución solo ajusta la existencia', async () => {
		const store = store_con(-4, []);
		store.data['inventory-internal-location'] = store.data['inventory-internal-location'].filter(
			(row) => row._id !== ALMACEN,
		);
		await recibir_devolucion(store, DEVOLUCION, 1);
		expect(await existencia_de(store)).toBe(-3);
		expect(suma_quants(store)).toBe(1);
		expect(cantidades(store)).toEqual({ REC: 1 });
	});

	test('recepción de compra sin filas deja general y suma en 1', async () => {
		const store = store_con(-4, [], { puedoComprarlo: true });
		await apply_purchase_receipt_stock(store, compra(5));
		expect(await existencia_de(store)).toBe(1);
		expect(suma_quants(store)).toBe(1);
		expect(cantidades(store)).toEqual({ REC: 5, ALM: -4 });
	});

	test('recepción de compra con dos lotes asienta el hueco una sola vez', async () => {
		const store = store_con(-4, [], { puedoComprarlo: true });
		const sin_filas = !(await product_has_quants(store, PRODUCTO));
		await apply_purchase_receipt_stock(
			store,
			compra(2, {
				lote: '507f1f77bcf86cd799439041',
				lote_codigo: 'L1',
				sin_filas_previas: sin_filas,
				receipt_key: 'r1',
			}),
		);
		await apply_purchase_receipt_stock(
			store,
			compra(3, {
				lote: '507f1f77bcf86cd799439042',
				lote_codigo: 'L2',
				sin_filas_previas: sin_filas,
				receipt_key: 'r2',
			}),
		);
		expect(await existencia_de(store)).toBe(1);
		expect(suma_quants(store)).toBe(1);
		const alm = filas_ubicacion(store, ALMACEN);
		expect(alm).toHaveLength(1);
		expect(alm[0]?.cantidad).toBe(-4);
		expect(
			filas_ubicacion(store, RECEPCION)
				.map((row) => row.cantidad)
				.sort(),
		).toEqual([2, 3]);
	});

	test('conteo sin filas deja la general en previa más diferencia', async () => {
		const con_ubicacion = store_con(-4, []);
		await aplicar_conteo(con_ubicacion, CONTEO, 0, 1, { id: RECEPCION, codigo: 'REC' });
		expect(await existencia_de(con_ubicacion)).toBe(-3);
		expect(suma_quants(con_ubicacion)).toBe(-3);
		expect(cantidades(con_ubicacion)).toEqual({ REC: 1, ALM: -4 });

		const sin_ubicacion = store_con(-4, []);
		await aplicar_conteo(sin_ubicacion, CONTEO_2, 0, 3);
		expect(await existencia_de(sin_ubicacion)).toBe(-1);
		expect(suma_quants(sin_ubicacion)).toBe(-1);
		expect(cantidades(sin_ubicacion)).toEqual({ ALM: -1 });
	});

	test('con filas, la devolución iguala la general a la suma y no mueve el almacén', async () => {
		const store = store_con(9, [quant(ANAQUEL_A, 'A-01', 5), quant(ALMACEN, 'ALM', 2)]);
		await recibir_devolucion(store, DEVOLUCION, 1);
		expect(await existencia_de(store)).toBe(8);
		expect(suma_quants(store)).toBe(8);
		expect(cantidades(store)).toEqual({ 'A-01': 5, ALM: 2, REC: 1 });
		expect(filas_ubicacion(store, ALMACEN)).toHaveLength(1);
	});

	test('con filas, la recepción de compra iguala la general a la suma sin fila extra', async () => {
		const store = store_con(9, [quant(ANAQUEL_A, 'A-01', 5), quant(ALMACEN, 'ALM', 2)], {
			puedoComprarlo: true,
		});
		await apply_purchase_receipt_stock(store, compra(5, { receipt_key: 'con-filas' }));
		expect(await existencia_de(store)).toBe(12);
		expect(suma_quants(store)).toBe(12);
		expect(cantidades(store)).toEqual({ 'A-01': 5, ALM: 2, REC: 5 });
		expect(filas_ubicacion(store, ALMACEN)).toHaveLength(1);
	});

	test('con filas, el conteo iguala la general a la suma sin fila extra', async () => {
		const store = store_con(9, [quant(ANAQUEL_A, 'A-01', 5), quant(ALMACEN, 'ALM', 2)]);
		await aplicar_conteo(store, CONTEO, 5, 4, { id: ANAQUEL_A, codigo: 'A-01' });
		expect(await existencia_de(store)).toBe(6);
		expect(suma_quants(store)).toBe(6);
		expect(cantidades(store)).toEqual({ 'A-01': 4, ALM: 2 });
		expect(filas_ubicacion(store, ALMACEN)).toHaveLength(1);
	});

	test('recompute sin opciones sigue dejando la general en la suma', async () => {
		const store = store_con(9, [quant(ANAQUEL_A, 'A-01', 5), quant(ALMACEN, 'ALM', 2)]);
		await recompute_product_existencia(store, PRODUCTO);
		expect(await existencia_de(store)).toBe(7);
		expect(cantidades(store)).toEqual({ 'A-01': 5, ALM: 2 });
	});
});
