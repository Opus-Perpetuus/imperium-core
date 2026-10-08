import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { is_record_id } from './record-id.ts';
import {
	acomodar_reception,
	create_reception_from_purchase_order,
	ensure_pending_reception_from_purchase_order,
	in_transit_for_product,
	list_pending_for_product,
	register_internal_transfer,
	reservar_reception,
} from './inventory-reception-flow.ts';

const SYNC = 'sync-comercial-prod-20260918';
const HEX = '507f1f77bcf86cd799439013';
const PO = '507f1f77bcf86cd799439099';
const A = '507f1f77bcf86cd799439021';
const B = '507f1f77bcf86cd799439022';
const REC = '507f1f77bcf86cd799439088';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([key, value]) =>
			value && typeof value === 'object' && 'in' in (value as object)
				? (value as { in: unknown[] }).in.includes(row[key])
				: row[key] === value,
		);
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
		async find_many(
			resource: string,
			opts: { where?: Record<string, unknown>; take?: number; ids?: string[] } = {},
		) {
			const rows = (data[resource] ?? []).filter(
				(row) => matches(row, opts.where) && (!opts.ids || opts.ids.includes(String(row._id))),
			);
			return { rows: rows.slice(0, opts.take ?? rows.length), total: rows.length };
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = { ...doc, _id: doc._id ?? `id-${n}` };
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

function po_con_sync() {
	return memory_store({
		'purchase-order': [
			{
				_id: PO,
				name: 'OC sync',
				estado: 'confirmada',
				articulos: [
					{
						producto: SYNC,
						producto_nombre: 'Producto prueba',
						producto_codigo: 'SYNC-1',
						cantidad: 4,
						cantidad_recibida: 0,
					},
				],
			},
		],
		'inventory-reception': [],
	});
}

function almacen_con_sync() {
	return memory_store({
		products: [{ _id: SYNC, name: 'Producto prueba', codigo: 'SYNC-1', existencia: 10 }],
		'inventory-stock-quant': [
			{ _id: 'q1', producto: SYNC, ubicacion: A, ubicacion_codigo: 'REC', cantidad: 10 },
		],
		'inventory-internal-location': [
			{
				_id: A,
				_ref: 'inventory-internal-location-receptions',
				codigo: 'REC',
				permite_almacenaje: true,
			},
			{ _id: B, codigo: 'A1', permite_almacenaje: true },
		],
		'inventory-movement': [],
		'inventory-reception': [
			{
				_id: REC,
				name: 'Recepción sync',
				estado: 'pendiente',
				is_active: true,
				purchase_order_nombre: 'OC sync',
				articulos: [
					{
						producto: SYNC,
						producto_nombre: 'Producto prueba',
						cantidad_esperada: 4,
						cantidad_recibida: 4,
						cantidad_acomodada: 0,
						reservas: [],
					},
				],
			},
		],
	});
}

describe('ids de producto sincronizado', () => {
	test('acepta ObjectId, id del kit y el id estable de sync; rechaza vacío y texto', () => {
		expect(is_record_id(HEX)).toBe(true);
		expect(is_record_id('registro_42c14311f4a3401e')).toBe(true);
		expect(is_record_id(SYNC)).toBe(true);
		expect(is_record_id('')).toBe(false);
		expect(is_record_id('   ')).toBe(false);
		expect(is_record_id('producto')).toBe(false);
		expect(is_record_id('Producto prueba')).toBe(false);
		expect(is_record_id('sync')).toBe(false);
		expect(is_record_id('sync-')).toBe(false);
	});

	test('en camino cuenta el producto sync y sigue exigiendo un id', async () => {
		const store = almacen_con_sync();
		const row = await in_transit_for_product(store, SYNC);
		expect(row.producto).toBe(SYNC);
		expect(row.recepciones).toBe(1);
		expect(row.en_camino).toBe(0);
		const pendientes = await list_pending_for_product(store, SYNC);
		expect(pendientes).toEqual([]);
		await expect(in_transit_for_product(store, '')).rejects.toThrow(
			'Se necesita el id del producto',
		);
		await expect(in_transit_for_product(store, 'Producto prueba')).rejects.toThrow(
			'Se necesita el id del producto',
		);
		await expect(list_pending_for_product(store, 'producto')).rejects.toThrow(
			'Se necesita el id del producto',
		);
	});

	test('en camino y pendientes usan la mercancía que aún no llega', async () => {
		const store = memory_store({
			'inventory-reception': [
				{
					_id: REC,
					name: 'Recepción sync',
					estado: 'pendiente',
					is_active: true,
					purchase_order_nombre: 'OC sync',
					articulos: [
						{
							producto: SYNC,
							producto_nombre: 'Producto prueba',
							cantidad_esperada: 5,
							cantidad_recibida: 1,
							reservas: [{ cantidad: 1 }],
						},
					],
				},
			],
		});
		const row = await in_transit_for_product(store, SYNC);
		expect(row.en_camino).toBe(3);
		expect(row.recepciones).toBe(1);
		const pendientes = await list_pending_for_product(store, SYNC);
		expect(pendientes).toEqual([
			{
				_id: REC,
				name: 'Recepción sync',
				purchase_order_nombre: 'OC sync',
				disponible: 3,
			},
		]);
	});

	test('la recepción desde una orden conserva el producto sync', async () => {
		const store = po_con_sync();
		const po = (await store.find_id('purchase-order', PO))!;
		const pendiente = await ensure_pending_reception_from_purchase_order(store, po);
		expect(pendiente?.articulos?.[0]?.producto).toBe(SYNC);
		const creada = await create_reception_from_purchase_order(store, PO, {});
		expect(creada.articulos?.[0]?.producto).toBe(SYNC);
		await expect(create_reception_from_purchase_order(store, '', {})).rejects.toThrow(
			'Se necesita el id de la orden de compra',
		);
		await expect(create_reception_from_purchase_order(store, 'orden 1', {})).rejects.toThrow(
			'Se necesita el id de la orden de compra',
		);
	});

	test('el traslado mueve un producto sync y rechaza un id vacío o de texto', async () => {
		const store = almacen_con_sync();
		await register_internal_transfer(store, {
			producto: SYNC,
			ubicacion_origen: A,
			ubicacion_destino: B,
			cantidad: 2,
		});
		const movimientos = store.data['inventory-movement'] ?? [];
		expect(movimientos.some((row) => row.producto_id === SYNC && row.cantidad === 2)).toBe(true);
		await expect(
			register_internal_transfer(store, {
				producto: '',
				ubicacion_origen: A,
				ubicacion_destino: B,
				cantidad: 1,
			}),
		).rejects.toThrow('Debes indicar un producto válido');
		await expect(
			register_internal_transfer(store, {
				producto: 'Producto prueba',
				ubicacion_origen: A,
				ubicacion_destino: B,
				cantidad: 1,
			}),
		).rejects.toThrow('Debes indicar un producto válido');
	});

	test('acomodar y reservar aceptan el producto sync y rechazan texto', async () => {
		const store = almacen_con_sync();
		const acomodada = await acomodar_reception(store, REC, {
			producto: SYNC,
			ubicacion_destino_codigo: 'A1',
			cantidad: 1,
		});
		const linea = (acomodada.articulos as ImperiumDoc[])[0];
		expect(linea?.cantidad_acomodada).toBe(1);
		const en_camino = memory_store({
			'inventory-reception': [
				{
					_id: REC,
					estado: 'pendiente',
					is_active: true,
					articulos: [
						{
							producto: SYNC,
							producto_nombre: 'Producto prueba',
							cantidad_esperada: 4,
							cantidad_recibida: 0,
							reservas: [],
						},
					],
				},
			],
		});
		const reservada = await reservar_reception(en_camino, REC, {
			producto: SYNC,
			cantidad: 1,
			documento_tipo: 'pedido',
			documento_id: 'ped-1',
			documento_nombre: 'PED-1',
		});
		const reservas = ((reservada.articulos as ImperiumDoc[])[0]?.reservas ?? []) as ImperiumDoc[];
		expect(reservas.some((row) => row.documento_id === 'ped-1')).toBe(true);
		await expect(
			acomodar_reception(store, REC, { producto: '', cantidad: 1, ubicacion_destino_codigo: 'A1' }),
		).rejects.toThrow('Se necesita un producto válido');
		await expect(
			reservar_reception(store, REC, {
				producto: 'producto',
				cantidad: 1,
				documento_tipo: 'pedido',
				documento_id: 'ped-2',
			}),
		).rejects.toThrow('Se necesita un producto válido');
	});
});
