import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { apply_quant_delta, quant_total_for_pair } from './delivery-return-flow.ts';
import { assert_tracking_flags, split_receipt_lots } from './inventory-lot-flow.ts';
import { register_internal_transfer } from './inventory-reception-flow.ts';
import { register_order_fulfillment_exit } from './pedidos-flow.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const A = '507f1f77bcf86cd799439021';
const B = '507f1f77bcf86cd799439022';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([key, value]) =>
			value && typeof value === 'object' && 'in' in value
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
		async find_many(resource: string, opts: { where?: Record<string, unknown>; take?: number; ids?: string[] } = {}) {
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

const base = { producto: PRODUCTO, producto_nombre: 'Suero', producto_codigo: 'SUE-1' };

function store_con_lotes() {
	return memory_store({
		products: [{ _id: PRODUCTO, name: 'Suero', codigo: 'SUE-1', existencia: 10, maneja_lote: true, tiene_caducidad: true }],
		'inventory-stock-quant': [
			{ _id: 'q1', ...base, ubicacion: A, ubicacion_codigo: 'A', cantidad: 2 },
			{ _id: 'q2', ...base, ubicacion: A, ubicacion_codigo: 'A', cantidad: 5, lote: 'L2', lote_codigo: 'L-TARDE', fecha_caducidad: '2027-06-01' },
			{ _id: 'q3', ...base, ubicacion: A, ubicacion_codigo: 'A', cantidad: 3, lote: 'L1', lote_codigo: 'L-PRONTO', fecha_caducidad: '2026-12-01' },
		],
		'inventory-internal-location': [
			{ _id: A, codigo: 'A', permite_almacenaje: true, secuencia_surtido: 1 },
			{ _id: B, codigo: 'B', permite_almacenaje: true },
		],
		'inventory-movement': [],
		pedidos: [],
	});
}

function por_lote(store: { data: Record<string, Row[]> }, ubicacion: string) {
	return Object.fromEntries(
		store.data['inventory-stock-quant']
			.filter((row) => row.ubicacion === ubicacion)
			.map((row) => [String(row.lote_codigo || 'sin lote'), row.cantidad]),
	);
}

describe('lotes al recibir', () => {
	const suero = { _id: PRODUCTO, name: 'Suero', maneja_lote: true, tiene_caducidad: true };
	test('los lotes deben sumar lo recibido y traer caducidad', () => {
		expect(
			split_receipt_lots(suero, 5, [
				{ lote_codigo: 'l-1', fecha_caducidad: '2027-01-31T00:00:00Z', cantidad: 3 },
				{ lote_codigo: 'L-2', fecha_caducidad: '2027-02-28', cantidad: 2 },
			]),
		).toEqual([
			{ lote_codigo: 'L-1', fecha_caducidad: '2027-01-31', cantidad: 3 },
			{ lote_codigo: 'L-2', fecha_caducidad: '2027-02-28', cantidad: 2 },
		]);
		expect(() => split_receipt_lots(suero, 5, [])).toThrow('Captura los lotes');
		expect(() => split_receipt_lots(suero, 5, [{ lote_codigo: 'L-1', fecha_caducidad: '2027-01-31', cantidad: 4 }])).toThrow('suman 4');
		expect(() => split_receipt_lots(suero, 1, [{ lote_codigo: 'L-1', cantidad: 1 }])).toThrow('caducidad');
	});

	test('las series son de una pieza y no se repiten; un producto sin control no acepta lotes', () => {
		const equipo = { _id: PRODUCTO, name: 'Radio', maneja_serial: true };
		expect(split_receipt_lots(equipo, 2, [{ lote_codigo: 'S1' }, { lote_codigo: 'S2' }]).length).toBe(2);
		expect(() => split_receipt_lots(equipo, 2, [{ lote_codigo: 'S1' }, { lote_codigo: 's1' }])).toThrow('repetid');
		expect(() => split_receipt_lots(equipo, 2, [{ lote_codigo: 'S1', cantidad: 2 }])).toThrow('una pieza');
		expect(() => split_receipt_lots({ name: 'Tornillo' }, 1, [{ lote_codigo: 'X' }])).toThrow('no maneja');
		expect(split_receipt_lots({ name: 'Tornillo' }, 1, [])).toEqual([]);
	});

	test('lote y serie son excluyentes; la caducidad va con uno de los dos', () => {
		expect(() => assert_tracking_flags({ maneja_lote: true, maneja_serial: true })).toThrow('no ambos');
		expect(() => assert_tracking_flags({ tiene_caducidad: true })).toThrow('caducidad');
		expect(() => assert_tracking_flags({ maneja_serial: true, tiene_caducidad: true })).not.toThrow();
	});
});

describe('existencias por lote', () => {
	test('una salida sin lote toma primero lo que no tiene lote y luego lo que caduca antes', async () => {
		const store = store_con_lotes();
		const portions = await apply_quant_delta(store, { ...base, ubicacion: A, ubicacion_codigo: 'A', delta: -4 });
		expect(portions.map((p) => [p.lote_codigo || 'sin lote', p.cantidad])).toEqual([
			['sin lote', 2],
			['L-PRONTO', 2],
		]);
		expect(por_lote(store, A)).toEqual({ 'sin lote': 0, 'L-TARDE': 5, 'L-PRONTO': 1 });
		expect(await quant_total_for_pair(store, PRODUCTO, A)).toBe(6);
	});

	test('una entrada con lote va a la fila de ese lote', async () => {
		const store = store_con_lotes();
		await apply_quant_delta(store, { ...base, ubicacion: A, ubicacion_codigo: 'A', delta: 4, lote: 'L2' });
		await apply_quant_delta(store, { ...base, ubicacion: A, ubicacion_codigo: 'A', delta: 1 });
		expect(por_lote(store, A)).toEqual({ 'sin lote': 3, 'L-TARDE': 9, 'L-PRONTO': 3 });
	});

	test('el traslado conserva el lote en el destino, con un movimiento por lote', async () => {
		const store = store_con_lotes();
		await register_internal_transfer(store, { producto: PRODUCTO, ubicacion_origen: A, ubicacion_destino: B, cantidad: 6 });
		expect(por_lote(store, B)).toEqual({ 'sin lote': 2, 'L-PRONTO': 3, 'L-TARDE': 1 });
		expect(por_lote(store, A)).toEqual({ 'sin lote': 0, 'L-TARDE': 4, 'L-PRONTO': 0 });
		expect(store.data['inventory-movement'].map((m) => [m.lote_codigo ?? 'sin lote', m.cantidad])).toEqual([
			['sin lote', 2],
			['L-PRONTO', 3],
			['L-TARDE', 1],
		]);
		await register_internal_transfer(store, { producto: PRODUCTO, ubicacion_origen: A, ubicacion_destino: B, cantidad: 4, lote: 'L2' });
		expect(por_lote(store, B)['L-TARDE']).toBe(5);
		await expect(
			register_internal_transfer(store, { producto: PRODUCTO, ubicacion_origen: A, ubicacion_destino: B, cantidad: 1, lote: 'L2' }),
		).rejects.toThrow('disponible 0');
	});

	test('surtir un pedido descuenta por caducidad y la suma sigue igual a la existencia', async () => {
		const store = store_con_lotes();
		await register_order_fulfillment_exit(store, { _id: 'ped-1', articulos: [{ product: PRODUCTO, cantidad: 6 }] });
		expect(por_lote(store, A)).toEqual({ 'sin lote': 0, 'L-TARDE': 4, 'L-PRONTO': 0 });
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(4);
	});
});
