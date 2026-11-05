import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { assert_pos_ticket_stock, register_pos_ticket_exit } from './inventory-exit.ts';
import { register_package_delivery_exit } from './inventory-logistics-flow.ts';
import { ALLOW_NEGATIVE_STOCK_REF, assert_salida_sin_negativos } from './negative-stock.ts';
import { revert_pos_return_entry } from './pos-return.ts';

const P = '507f1f77bcf86cd799439013';
type Row = ImperiumDoc;

function store_con(
	existencia: number,
	extra: Record<string, Row[]> = {},
	permitir?: boolean,
	apartado?: number,
) {
	const data: Record<string, Row[]> = {
		products: [{ _id: P, name: 'Codo', codigo: 'C1', existencia, existenciaApartada: apartado ?? existencia + 10 }],
		'inventory-movement': [],
		...extra,
	};
	if (permitir !== undefined) {
		data.configuration = [{ _id: 'c', _ref: ALLOW_NEGATIVE_STOCK_REF, value: permitir }];
	}
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([k, v]) =>
			v && typeof v === 'object' && 'in' in v
				? (v as { in: unknown[] }).in.includes(row[k])
				: row[k] === v,
		);
	const store = {
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((x) => String(x._id) === String(id)) ?? null;
		},
		async find_where(r: string, w: Record<string, unknown>) {
			return (data[r] ?? []).find((x) => matches(x, w)) ?? null;
		},
		async find_many(r: string, o: { where?: Record<string, unknown> } = {}) {
			const rows = (data[r] ?? []).filter((x) => matches(x, o.where));
			return { rows, total: rows.length };
		},
		async *scan(r: string, o: { where?: Record<string, unknown> } = {}) {
			yield (data[r] ?? []).filter((x) => matches(x, o.where));
		},
		async insert(r: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? crypto.randomUUID() };
			(data[r] ??= []).push(row);
			return row;
		},
		async update(r: string, id: string, patch: Row) {
			const rows = data[r] ?? [];
			const i = rows.findIndex((x) => String(x._id) === String(id));
			if (i < 0) return null;
			rows[i] = { ...rows[i], ...patch, _id: id };
			return rows[i];
		},
	};
	return store as unknown as ImperiumStore;
}

const venta = (quantity: number) => ({
	_id: 't1',
	ticket_type: 'VENTA',
	items: [{ item_id: P, quantity }],
});
const existencia = async (s: ImperiumStore) => (await s.find_id('products', P))?.existencia;

describe('caja / POS', () => {
	test('por defecto bloquea la venta que dejaría existencia negativa', async () => {
		const s = store_con(2, {}, undefined, 0);
		await expect(assert_pos_ticket_stock(s, venta(5))).rejects.toThrow(
			'No se puede vender: la existencia quedaría negativa en Codo (sale 5, hay 2)',
		);
	});

	test('con existencia suficiente no bloquea', async () => {
		await expect(assert_pos_ticket_stock(store_con(5, {}, undefined, 0), venta(5))).resolves.toBeUndefined();
	});

	test('sin almacén, lo libre descuenta lo apartado', async () => {
		const s = store_con(10, {}, undefined, 4);
		const salidas = new Map([[P, 7]]);
		await expect(assert_salida_sin_negativos(s, 'vender', salidas, null, { libre: true })).rejects.toThrow(
			'Codo (sale 7, hay 6)',
		);
		await expect(assert_salida_sin_negativos(s, 'vender', new Map([[P, 6]]), null, { libre: true })).resolves.toBeUndefined();
		await expect(assert_salida_sin_negativos(s, 'vender', salidas, null)).resolves.toBeUndefined();
	});

	test('con el interruptor en SÍ vende y la existencia queda negativa', async () => {
		const s = store_con(2, {}, true);
		await assert_pos_ticket_stock(s, venta(5));
		await register_pos_ticket_exit(s, venta(5));
		expect(await existencia(s)).toBe(-3);
	});

	test('las devoluciones (no VENTA) no se bloquean', async () => {
		const s = store_con(0);
		await expect(
			assert_pos_ticket_stock(s, { ...venta(5), ticket_type: 'DEVOLUCION' }),
		).resolves.toBeUndefined();
	});
});

describe('entrega de bulto (logística)', () => {
	const bulto = { _id: '507f1f77bcf86cd799439012', name: 'BULTO-1', contenido: [{ product: P, quantity: 4 }] };

	test('por defecto bloquea la entrega sin existencia', async () => {
		const s = store_con(1);
		await expect(
			register_package_delivery_exit(s, bulto, 'e1', '2026-11-04T12:00:00.000Z'),
		).rejects.toThrow('No se puede entregar: la existencia quedaría negativa');
		expect(await existencia(s)).toBe(1);
	});

	test('con el interruptor en SÍ entrega y queda negativa', async () => {
		const s = store_con(1, {}, true);
		await register_package_delivery_exit(s, bulto, 'e1', '2026-11-04T12:00:00.000Z');
		expect(await existencia(s)).toBe(-3);
	});
});

describe('cancelar devolución de caja (revierte reingreso)', () => {
	const devolucion = { _id: 'r1', ticket_type: 'DEVOLUCION', original_ticket: 't1' };
	const movimiento = {
		_id: 'm1',
		documento_id: 'r1',
		documento_tipo: 'pos-ticket',
		tipo_movimiento: 'recepcion_devolucion',
		producto: P,
		cantidad: 3,
		stock_total_previo: 0,
		stock_total_resultante: 3,
	};

	test('por defecto bloquea si dejaría existencia negativa', async () => {
		const s = store_con(1, { 'inventory-movement': [movimiento] });
		await expect(revert_pos_return_entry(s, devolucion)).rejects.toThrow(
			'No se puede cancelar la devolución',
		);
	});

	test('con el interruptor en SÍ revierte y queda negativa', async () => {
		const s = store_con(1, { 'inventory-movement': [movimiento] }, true);
		await revert_pos_return_entry(s, devolucion);
		expect(await existencia(s)).toBe(-2);
	});
});
