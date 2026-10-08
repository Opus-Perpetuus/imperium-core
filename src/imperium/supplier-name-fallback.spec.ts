import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import {
	create_reception_from_purchase_order,
	ensure_pending_reception_from_purchase_order,
} from './inventory-reception-flow.ts';
import { prepare_purchase_order_create } from './purchase-order-flow.ts';
import {
	approve_purchase_request,
	create_purchase_orders_from_requests,
	prepare_purchase_request_create,
	submit_purchase_request,
} from './purchase-request-flow.ts';
import {
	draft_supplier_invoice_lines,
	prepare_supplier_invoice_create,
} from './supplier-invoice-flow.ts';
import { apply_supplier_payment } from './supplier-payment-flow.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

const PROV = '507f1f77bcf86cd799439021';
const PROD = '507f1f77bcf86cd799439031';
const PO = '507f1f77bcf86cd799439011';
const INV = '507f1f77bcf86cd799439041';

function memory_store(seed: Record<string, Row[]> = {}) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	const counters = new Map<string, number>();
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => {
			if (value && typeof value === 'object' && 'in' in (value as object)) {
				const list = (value as { in: unknown[] }).in.map((item) => String(item));
				return list.includes(String(row[key] ?? ''));
			}
			return row[key] === value;
		});
	};
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
		async find_many(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			const rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			return { rows, total: rows.length };
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

const contacto = (extra: Row = {}): Row => ({
	_id: PROV,
	name: 'Aceros del Norte',
	is_active: true,
	...extra,
});

describe('nombre de proveedor en la orden', () => {
	test('si el nombre viene vacío lo toma del contacto', async () => {
		const store = memory_store({ contacto: [contacto()] });
		const doc = await prepare_purchase_order_create(store, {
			proveedor: PROV,
			proveedor_nombre: '',
			articulos: [{ producto: PROD, producto_nombre: 'Tornillo', cantidad: 2, costo_unitario: 10 }],
		});
		expect(doc.proveedor_nombre).toBe('Aceros del Norte');
	});

	test('un nombre ya capturado no se sustituye', async () => {
		const store = memory_store({ contacto: [contacto()] });
		const doc = await prepare_purchase_order_create(store, {
			proveedor: PROV,
			proveedor_nombre: 'Nombre de la orden',
			articulos: [{ producto: PROD, producto_nombre: 'Tornillo', cantidad: 1, costo_unitario: 10 }],
		});
		expect(doc.proveedor_nombre).toBe('Nombre de la orden');
	});

	test('sin contacto el nombre sigue vacío', async () => {
		const store = memory_store({ contacto: [] });
		const doc = await prepare_purchase_order_create(store, {
			proveedor: PROV,
			articulos: [{ producto: PROD, producto_nombre: 'Tornillo', cantidad: 1, costo_unitario: 10 }],
		});
		expect(doc.proveedor_nombre).toBe('');
	});

	test('la solicitud sin proveedor_nombre en el producto guarda el nombre del contacto', async () => {
		const store = memory_store({
			contacto: [contacto()],
			'purchase-request': [],
			'purchase-order': [],
			'inventory-reception': [],
		});
		const doc = await prepare_purchase_request_create(
			store,
			{
				articulos: [
					{
						producto: PROD,
						producto_nombre: 'Tornillo',
						cantidad: 3,
						costo_estimado: 10,
						proveedor: PROV,
					},
				],
			},
			{ _id: 'u-sol', name: 'Almacén' },
		);
		expect(doc.articulos).toEqual([expect.objectContaining({ proveedor_nombre: '' })]);
		const request = await store.insert('purchase-request', doc);
		await submit_purchase_request(store, request._id);
		await approve_purchase_request(store, request._id, { _id: 'u-jefe', name: 'Compras' });
		const created = await create_purchase_orders_from_requests(store, [request._id]);
		expect(created.data[0]).toMatchObject({
			proveedor: PROV,
			proveedor_nombre: 'Aceros del Norte',
			tipo_origen: 'solicitud',
		});
		expect(store.data['inventory-reception'][0]).toMatchObject({
			proveedor_nombre: 'Aceros del Norte',
		});
	});
});

describe('recepción, factura y pago con orden de nombre vacío', () => {
	function orden_vacia(extra: Row = {}): Row {
		return {
			_id: PO,
			name: 'Compra 1',
			folio_interno: 1,
			estado: 'parcialmente_recibida',
			is_active: true,
			proveedor: PROV,
			proveedor_nombre: '',
			proveedor_rfc: '',
			subtotal: 100,
			articulos: [
				{
					producto: PROD,
					producto_nombre: 'Tornillo',
					cantidad: 2,
					cantidad_recibida: 2,
					costo_unitario: 50,
				},
			],
			...extra,
		};
	}

	test('la recepción pendiente usa el nombre del contacto', async () => {
		const store = memory_store({
			contacto: [contacto()],
			'purchase-order': [orden_vacia({ estado: 'aprobada', articulos: [
				{
					producto: PROD,
					producto_nombre: 'Tornillo',
					cantidad: 2,
					cantidad_recibida: 0,
					costo_unitario: 50,
				},
			] })],
			'inventory-reception': [],
		});
		const pending = await ensure_pending_reception_from_purchase_order(
			store,
			store.data['purchase-order'][0]!,
		);
		expect(pending?.proveedor_nombre).toBe('Aceros del Norte');
		const otra = await create_reception_from_purchase_order(store, PO, {});
		expect(otra.proveedor_nombre).toBe('Aceros del Norte');
	});

	test('la factura y su borrador usan el nombre del contacto', async () => {
		const store = memory_store({
			contacto: [contacto()],
			'purchase-order': [orden_vacia()],
			'supplier-invoice': [],
		});
		const draft = await draft_supplier_invoice_lines(store, PO);
		expect(draft.data[0]?.proveedor_nombre).toBe('Aceros del Norte');
		const doc = await prepare_supplier_invoice_create(store, {
			purchase_order: PO,
			numero_factura: 'F-1',
		});
		expect(doc.proveedor_nombre).toBe('Aceros del Norte');
	});

	test('el pago usa el nombre del contacto si la factura lo trae vacío', async () => {
		const store = memory_store({
			contacto: [contacto()],
			'supplier-invoice': [
				{
					_id: INV,
					estado: 'registrada',
					estado_match: 'conciliada',
					numero_factura: 'F-1',
					purchase_order: PO,
					proveedor: PROV,
					proveedor_nombre: '',
					total: 100,
					saldo: 100,
				},
			],
			'supplier-payment': [],
		});
		const pago = await apply_supplier_payment(store, { supplier_invoice: INV, monto: 10 });
		expect(pago.data[0]).toMatchObject({
			proveedor: PROV,
			proveedor_nombre: 'Aceros del Norte',
			monto: 10,
		});
	});

	test('si la orden ya trae nombre, factura y recepción lo conservan', async () => {
		const store = memory_store({
			contacto: [contacto({ name: 'Otro contacto' })],
			'purchase-order': [
				orden_vacia({
					proveedor_nombre: 'Aceros SA',
					estado: 'aprobada',
					articulos: [
						{
							producto: PROD,
							producto_nombre: 'Tornillo',
							cantidad: 2,
							cantidad_recibida: 0,
							costo_unitario: 50,
						},
					],
				}),
			],
			'inventory-reception': [],
			'supplier-invoice': [],
		});
		const reception = await create_reception_from_purchase_order(store, PO, {});
		expect(reception.proveedor_nombre).toBe('Aceros SA');
		const saved = store.data['purchase-order'][0]!;
		saved.estado = 'parcialmente_recibida';
		(saved.articulos as Row[])[0]!.cantidad_recibida = 2;
		const doc = await prepare_supplier_invoice_create(store, {
			purchase_order: PO,
			numero_factura: 'F-2',
		});
		expect(doc.proveedor_nombre).toBe('Aceros SA');
	});
});
