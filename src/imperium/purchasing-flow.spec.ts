import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	approve_purchase_request,
	create_purchase_orders_from_requests,
	prepare_purchase_request_create,
	submit_purchase_request,
} from './purchase-request-flow.ts';
import {
	authorize_supplier_invoice,
	draft_supplier_invoice_lines,
	match_supplier_invoice,
	prepare_supplier_invoice_create,
	revalidate_po_invoices,
} from './supplier-invoice-flow.ts';
import { apply_supplier_payment, cancel_supplier_payment } from './supplier-payment-flow.ts';

type Row = ImperiumDoc;

const PO = '507f1f77bcf86cd799439011';
const PROV_A = '507f1f77bcf86cd799439021';
const PROV_B = '507f1f77bcf86cd799439022';
const CODO = '507f1f77bcf86cd799439031';
const TUBO = '507f1f77bcf86cd799439032';

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	const counters = new Map<string, number>();
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where || Object.entries(where).every(([key, value]) => row[key] === value);
	let n = 0;
	const store = {
		data,
		has: (resource: string) => Object.hasOwn(data, resource),
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = { ...doc, _id: doc._id ?? `507f1f77bcf86cd7994${String(n).padStart(5, '0')}` };
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
		async next_auto_increment(model: string) {
			const next = (counters.get(model) ?? 0) + 1;
			counters.set(model, next);
			return next;
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

const orden = (extra: Row = {}): Row => ({
	_id: PO,
	folio_interno: 7,
	estado: 'parcialmente_recibida',
	proveedor: PROV_A,
	proveedor_nombre: 'Aceros SA',
	proveedor_rfc: 'ACE010101AAA',
	subtotal: 1000,
	articulos: [
		{ producto: CODO, producto_nombre: 'Codo', cantidad: 10, cantidad_recibida: 6, costo_unitario: 50 },
		{ producto: TUBO, producto_nombre: 'Tubo', cantidad: 5, cantidad_recibida: 5, costo_unitario: 100 },
	],
	...extra,
});

const store_con_orden = (extra: Row = {}) =>
	memory_store({
		'purchase-order': [orden(extra)],
		'supplier-invoice': [],
		'supplier-payment': [],
	});

const TOL = { price_pct: 0, qty_pct: 0 };

describe('conciliación de 3 vías', () => {
	test('facturar lo recibido al precio de la orden queda conciliado', () => {
		const match = match_supplier_invoice(
			orden(),
			{
				subtotal: 800,
				total: 928,
				impuestos: 128,
				articulos: [
					{ producto: CODO, cantidad: 6, valor_unitario: 50 },
					{ producto: TUBO, cantidad: 5, valor_unitario: 100 },
				],
			},
			[0, 0],
			TOL,
		);
		expect(match.blocking).toEqual([]);
		expect(match.diferencias).toEqual([]);
	});

	test('más de lo recibido o precio distinto es diferencia; más de lo pedido bloquea', () => {
		const diferencia = match_supplier_invoice(
			orden(),
			{ subtotal: 440, total: 440, articulos: [{ producto: CODO, cantidad: 8, valor_unitario: 55 }] },
			[0, 0],
			TOL,
		);
		expect(diferencia.blocking).toEqual([]);
		expect(diferencia.diferencias.length).toBe(2);
		const bloqueo = match_supplier_invoice(
			orden(),
			{ subtotal: 150, total: 150, articulos: [{ producto: CODO, cantidad: 3, valor_unitario: 50 }] },
			[8, 0],
			TOL,
		);
		expect(bloqueo.blocking[0]).toContain('más de lo pedido');
	});
});

describe('factura de proveedor', () => {
	test('sin líneas toma lo recibido y aún no facturado de la orden', async () => {
		const store = store_con_orden();
		const doc = await prepare_supplier_invoice_create(store, {
			purchase_order: PO,
			numero_factura: 'F-1',
		});
		expect(doc.articulos).toEqual([
			expect.objectContaining({ producto: CODO, cantidad: 6, valor_unitario: 50, importe: 300 }),
			expect.objectContaining({ producto: TUBO, cantidad: 5, valor_unitario: 100, importe: 500 }),
		]);
		expect(doc).toMatchObject({
			subtotal: 800,
			total: 800,
			estado: 'registrada',
			estado_match: 'conciliada',
			estado_pago: 'pendiente',
			saldo: 800,
			proveedor: PROV_A,
			folio: 1,
		});
	});

	test('las líneas en borrador son lo recibido menos lo ya facturado', async () => {
		const store = store_con_orden();
		const doc = await prepare_supplier_invoice_create(store, {
			purchase_order: PO,
			numero_factura: 'F-1',
			articulos: [{ producto: CODO, cantidad: 4, valor_unitario: 50 }],
		});
		await store.insert('supplier-invoice', doc);
		const draft = await draft_supplier_invoice_lines(store, PO);
		expect(draft.data[0]!.articulos).toEqual([
			expect.objectContaining({ producto: CODO, cantidad: 2 }),
			expect.objectContaining({ producto: TUBO, cantidad: 5 }),
		]);
	});

	test('orden en borrador, UUID repetido o RFC ajeno no se registran', async () => {
		await expect(
			prepare_supplier_invoice_create(store_con_orden({ estado: 'borrador' }), {
				purchase_order: PO,
				numero_factura: 'F-1',
			}),
		).rejects.toThrow('aprobadas');
		const store = store_con_orden();
		store.data['supplier-invoice'].push({ _id: 'otra', uuid: 'abc-123', estado: 'registrada' });
		await expect(
			prepare_supplier_invoice_create(store, { purchase_order: PO, numero_factura: 'F-2', uuid: 'ABC-123' }),
		).rejects.toThrow('UUID');
		await expect(
			prepare_supplier_invoice_create(store_con_orden(), {
				purchase_order: PO,
				numero_factura: 'F-3',
				emisor_rfc: 'XXX010101XXX',
			}),
		).rejects.toThrow('RFC');
	});

	test('una recepción posterior concilia la factura que tenía diferencias', async () => {
		const store = store_con_orden();
		const doc = await prepare_supplier_invoice_create(store, {
			purchase_order: PO,
			numero_factura: 'F-1',
			articulos: [{ producto: CODO, cantidad: 10, valor_unitario: 50 }],
		});
		expect(doc.estado_match).toBe('con_diferencias');
		const invoice = await store.insert('supplier-invoice', doc);
		const po = store.data['purchase-order'][0]!;
		(po.articulos as Row[])[0]!.cantidad_recibida = 10;
		await revalidate_po_invoices(store, PO);
		expect((await store.find_id('supplier-invoice', String(invoice._id)))?.estado_match).toBe('conciliada');
	});
});

describe('pagos a proveedor', () => {
	async function factura(store: ReturnType<typeof store_con_orden>, extra: Row = {}) {
		const doc = await prepare_supplier_invoice_create(store, {
			purchase_order: PO,
			numero_factura: 'F-1',
			articulos: [{ producto: TUBO, cantidad: 1, valor_unitario: 100 }],
			...extra,
		});
		return store.insert('supplier-invoice', doc);
	}

	test('40 + 60 la dejan pagada; cancelar el de 40 la regresa a parcial', async () => {
		const store = store_con_orden();
		const invoice = await factura(store);
		const primero = await apply_supplier_payment(store, { supplier_invoice: invoice._id, monto: 40 });
		await apply_supplier_payment(store, { supplier_invoice: invoice._id, monto: 60 });
		expect(await store.find_id('supplier-invoice', String(invoice._id))).toMatchObject({
			estado_pago: 'pagada',
			monto_pagado: 100,
			saldo: 0,
		});
		await expect(
			apply_supplier_payment(store, { supplier_invoice: invoice._id, monto: 1 }),
		).rejects.toThrow('saldo');
		await cancel_supplier_payment(store, primero.data[0]!._id, 'duplicado');
		expect(await store.find_id('supplier-invoice', String(invoice._id))).toMatchObject({
			estado_pago: 'parcial',
			monto_pagado: 60,
			saldo: 40,
		});
	});

	test('una factura con diferencias no se paga hasta autorizarlas', async () => {
		const store = store_con_orden();
		const invoice = await factura(store, {
			articulos: [{ producto: TUBO, cantidad: 1, valor_unitario: 120 }],
		});
		await expect(
			apply_supplier_payment(store, { supplier_invoice: invoice._id, monto: 10 }),
		).rejects.toThrow('diferencias');
		await authorize_supplier_invoice(store, invoice._id, { _id: 'u1', name: 'Compras' }, 'precio pactado');
		const pago = await apply_supplier_payment(store, { supplier_invoice: invoice._id, monto: 10 });
		expect(pago.data[0]).toMatchObject({ status: 'APLICADO', monto: 10, proveedor: PROV_A });
	});
});

describe('solicitudes de compra', () => {
	test('dos proveedores dan dos órdenes; repetir no duplica; quien solicita no aprueba', async () => {
		const store = memory_store({ 'purchase-request': [], 'purchase-order': [] });
		const solicitante = { _id: 'u-sol', name: 'Almacén' };
		const doc = await prepare_purchase_request_create(
			store,
			{
				articulos: [
					{ producto: CODO, producto_nombre: 'Codo', cantidad: 4, costo_estimado: 50, proveedor: PROV_A },
					{ producto: TUBO, producto_nombre: 'Tubo', cantidad: 2, costo_estimado: 100, proveedor: PROV_B },
					{ producto: CODO, producto_nombre: 'Codo', cantidad: 1, costo_estimado: 50, proveedor: PROV_A },
				],
			},
			solicitante,
		);
		expect(doc).toMatchObject({ estado: 'borrador', total_estimado: 450, solicitante: 'u-sol' });
		const request = await store.insert('purchase-request', doc);
		await submit_purchase_request(store, request._id);
		await expect(approve_purchase_request(store, request._id, solicitante)).rejects.toThrow(
			'propia',
		);
		await approve_purchase_request(store, request._id, { _id: 'u-jefe', name: 'Compras' });
		const first = await create_purchase_orders_from_requests(store, [request._id]);
		expect(first.data.length).toBe(2);
		const po_a = first.data.find((po) => po.proveedor === PROV_A)!;
		expect(po_a).toMatchObject({ estado: 'borrador', tipo_origen: 'solicitud' });
		expect(po_a.articulos).toEqual([expect.objectContaining({ producto: CODO, cantidad: 5 })]);
		expect((await store.find_id('purchase-request', String(request._id)))?.estado).toBe('convertida');
		await expect(create_purchase_orders_from_requests(store, [request._id])).rejects.toThrow(
			'no está aprobada',
		);
		expect(store.data['purchase-order'].length).toBe(2);
	});
});
