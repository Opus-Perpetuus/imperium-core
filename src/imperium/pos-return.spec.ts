import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { register_pos_ticket_exit } from './inventory-exit.ts';
import {
	pos_return_lookup,
	prepare_pos_return,
	register_pos_return_entry,
} from './pos-return.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;
const P1 = 'prod-1';
const P2 = 'prod-2';
const ALM = 'loc-alm';

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [k, rows] of Object.entries(seed)) data[k] = rows.map((r) => ({ ...r }));
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([k, v]) =>
			v && typeof v === 'object' && 'in' in v ? (v as { in: unknown[] }).in.includes(row[k]) : row[k] === v,
		);
	const store = {
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(r: string, o: { where?: Record<string, unknown>; take?: number } = {}) {
			const rows = (data[r] ?? []).filter((row) => matches(row, o.where));
			return { rows: rows.slice(0, o.take ?? rows.length), total: rows.length };
		},
		async *scan(r: string, o: { where?: Record<string, unknown> } = {}) {
			yield (data[r] ?? []).filter((row) => matches(row, o.where));
		},
		async insert(r: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${crypto.randomUUID()}` };
			(data[r] ??= []).push(row);
			return row;
		},
		async update(r: string, id: string, patch: Row) {
			const rows = data[r] ?? [];
			const i = rows.findIndex((row) => String(row._id) === String(id));
			if (i < 0) return null;
			rows[i] = { ...rows[i], ...patch, _id: id };
			return rows[i];
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

const sale: Row = {
	_id: 'venta-1',
	ticket_type: 'VENTA',
	ticket_sequence: 'CAJA-1-7',
	state: 'confirmado',
	client_name: 'Ana',
	items: JSON.stringify([
		{ item_id: P1, item_name: 'Codo', quantity: 3, unit_price: 10 },
		{ item_id: P2, item_name: 'Tubo', quantity: 2, unit_price: 25.5 },
	]),
};

function store_with(existencia1: number, existencia2 = 10) {
	return memory_store({
		products: [
			{ _id: P1, name: 'Codo', codigo: 'C1', existencia: existencia1 },
			{ _id: P2, name: 'Tubo', codigo: 'T1', existencia: existencia2 },
		],
		'pos-tickets': [{ ...sale }],
		'inventory-movement': [],
		'inventory-stock-quant': [],
		'inventory-internal-location': [{ _id: ALM, codigo: 'ALM', _ref: 'inventory-internal-location-warehouse' }],
	});
}

async function sell(store: ReturnType<typeof store_with>) {
	await register_pos_ticket_exit(store, store.data['pos-tickets'][0]);
}

async function create_return(store: ReturnType<typeof store_with>, doc: Row) {
	const prepared = await prepare_pos_return(store, { ticket_type: 'DEVOLUCION', ...doc });
	const created = await store.insert('pos-tickets', prepared);
	const result = await register_pos_return_entry(store, created);
	return { created, result };
}

const existencia = async (store: ImperiumStore, id: string) => (await store.find_id('products', id))?.existencia;

describe('devoluciones POS ligadas a la venta', () => {
	test('sin original_ticket el ticket DEVOLUCION queda como siempre', async () => {
		const store = store_with(10);
		const doc = { ticket_type: 'DEVOLUCION', subtotal: 50, items: [{ item_id: P1, quantity: 99 }] };
		expect(await prepare_pos_return(store, doc)).toBe(doc);
		expect(await register_pos_return_entry(store, doc)).toEqual([]);
		expect(await existencia(store, P1)).toBe(10);
	});

	test('toma precios de la venta, subtotal negativo y reingresa lo devuelto', async () => {
		const store = store_with(10);
		await sell(store);
		expect(await existencia(store, P1)).toBe(7);
		const { created, result } = await create_return(store, {
			original_ticket: 'venta-1',
			items: [{ item_id: P1, quantity: 2, unit_price: 999 }],
		});
		expect(created.subtotal).toBe(-20);
		expect(created.items).toEqual([
			{ item_id: P1, item_name: 'Codo', unit_price: 10, quantity: 2, total: 20, price_origin: 'devolucion' },
		]);
		expect(created.client_name).toBe('Ana');
		expect(result).toEqual([{ producto: P1, devuelto: 2, reingresado: 2, motivo: 'reingresado' }]);
		expect(await existencia(store, P1)).toBe(9);
		const mov = store.data['inventory-movement'].find((m) => m.tipo_movimiento === 'recepcion_devolucion');
		expect(mov).toMatchObject({ documento_id: created._id, stock_total_previo: 7, stock_total_resultante: 9, ubicacion_destino: ALM });
		expect(store.data['inventory-stock-quant'].find((q) => q.ubicacion === ALM)?.cantidad).toBe(-1);
	});

	test('no deja devolver más de lo vendido menos lo ya devuelto', async () => {
		const store = store_with(10);
		await sell(store);
		await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 2 }] });
		await expect(
			prepare_pos_return(store, { ticket_type: 'DEVOLUCION', original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 2 }] }),
		).rejects.toThrow(/vendidos 3, ya devueltos 2/);
		await expect(
			prepare_pos_return(store, { ticket_type: 'DEVOLUCION', original_ticket: 'venta-1', items: [{ item_id: 'otro', quantity: 1 }] }),
		).rejects.toThrow(/no está en la venta original/);
		await expect(
			prepare_pos_return(store, { ticket_type: 'DEVOLUCION', original_ticket: 'nada', items: [{ item_id: P1, quantity: 1 }] }),
		).rejects.toThrow(/no existe/);
		await expect(
			prepare_pos_return(store, { ticket_type: 'DEVOLUCION', original_ticket: 'venta-1', restock_mode: 'x', items: [{ item_id: P1, quantity: 1 }] }),
		).rejects.toThrow(/restock_mode/);
	});

	test('una devolución cancelada libera su cantidad', async () => {
		const store = store_with(10);
		await sell(store);
		const { created } = await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 3 }] });
		await store.update('pos-tickets', String(created._id), { state: 'cancelado' });
		const lookup = await pos_return_lookup(store, { folio: 'CAJA-1-7' });
		expect(lookup.lineas).toEqual([
			{ item_id: P1, item_name: 'Codo', unit_price: 10, vendido: 3, devuelto: 0, disponible: 3 },
			{ item_id: P2, item_name: 'Tubo', unit_price: 25.5, vendido: 2, devuelto: 0, disponible: 2 },
		]);
	});

	test('reingresa solo lo que la venta restó (existencia topada en 0)', async () => {
		const store = store_with(1);
		await sell(store);
		expect(await existencia(store, P1)).toBe(0);
		const { result } = await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 3 }] });
		expect(result[0]).toMatchObject({ devuelto: 3, reingresado: 1 });
		expect(await existencia(store, P1)).toBe(1);
	});

	test('dos devoluciones parciales no reingresan más de lo restado', async () => {
		const store = store_with(2);
		await sell(store);
		const a = await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 1 }] });
		const b = await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 2 }] });
		expect(a.result[0].reingresado).toBe(1);
		expect(b.result[0]).toMatchObject({ reingresado: 1, devuelto: 2 });
		expect(await existencia(store, P1)).toBe(2);
	});

	test('restock_mode none registra la devolución sin tocar inventario', async () => {
		const store = store_with(10);
		await sell(store);
		const { created, result } = await create_return(store, {
			original_ticket: 'venta-1',
			restock_mode: 'NONE',
			items: [{ item_id: P2, quantity: 1 }],
		});
		expect(created.restock_mode).toBe('none');
		expect(created.subtotal).toBe(-25.5);
		expect(result).toEqual([{ producto: P2, devuelto: 1, reingresado: 0, motivo: 'sin_reingreso' }]);
		expect(await existencia(store, P2)).toBe(8);
	});

	test('un ajuste manual posterior a la venta evita el doble conteo salvo modo auto explícito', async () => {
		const store = store_with(10);
		await sell(store);
		store.data['inventory-movement'].push({
			_id: 'aj-1',
			producto: P1,
			tipo_movimiento: 'ajuste_manual',
			stock_total_previo: 7,
			stock_total_resultante: 9,
			fecha_movimiento: new Date(Date.now() + 1000).toISOString(),
		});
		const auto = await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 1 }] });
		expect(auto.result[0].motivo).toBe('ajuste_manual_detectado');
		const forced = await create_return(store, {
			original_ticket: 'venta-1',
			restock_mode: 'auto',
			items: [{ item_id: P1, quantity: 1 }],
		});
		expect(forced.result[0]).toMatchObject({ reingresado: 1, motivo: 'reingresado' });
	});

	test('es idempotente y no reingresa si la venta no dejó salida', async () => {
		const store = store_with(10);
		const { created, result } = await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 1 }] });
		expect(result[0].motivo).toBe('sin_salida_registrada');
		await sell(store);
		const other = await create_return(store, { original_ticket: 'venta-1', items: [{ item_id: P1, quantity: 1 }] });
		expect(other.result[0].reingresado).toBe(1);
		const again = await register_pos_return_entry(store, other.created);
		expect(again[0].motivo).toBe('ya_reingresado');
		expect(created._id).toBeTruthy();
	});

	test('solo se devuelve una venta viva', async () => {
		const store = store_with(10);
		store.data['pos-tickets'].push({ _id: 'retiro', ticket_type: 'RETIRO_MANUAL_CAJA' });
		await expect(pos_return_lookup(store, { id: 'retiro' })).rejects.toThrow(/Solo se puede devolver/);
		await expect(pos_return_lookup(store, { folio: 'X' })).rejects.toThrow(/No hay un ticket/);
		await expect(pos_return_lookup(store, {})).rejects.toThrow(/Indica/);
	});
});
