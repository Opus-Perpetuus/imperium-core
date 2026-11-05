import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { register_manual_movement } from './inventory-manual-movement.ts';
import { movement_delta } from './inventory-kardex.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const NEG_REF = 'configuration-inventory-allow-negative-stock';

function memory_store(existencia: number, permitir_negativos?: boolean) {
	const data: Record<string, ImperiumDoc[]> = {
		products: [{ _id: PRODUCTO, name: 'Codo', codigo: 'C1', existencia }],
		'inventory-movement': [],
		configuration: permitir_negativos === undefined ? [] : [{ _id: 'c', _ref: NEG_REF, value: permitir_negativos }],
	};
	let seq = 0;
	const matches = (row: ImperiumDoc, where: Record<string, unknown>) =>
		Object.entries(where).every(([k, v]) => row[k] === v);
	const store = {
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async insert(r: string, doc: ImperiumDoc) {
			const row = { ...doc, _id: String(++seq) };
			data[r].push(row);
			return row;
		},
		async update(r: string, id: string, patch: ImperiumDoc) {
			const row = (data[r] ?? []).find((x) => String(x._id) === String(id));
			if (row) Object.assign(row, patch);
			return row ?? null;
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, ImperiumDoc[]> };
}

describe('entrada / salida manual', () => {
	test('entrada suma existencia y asienta el movimiento', async () => {
		const store = memory_store(5);
		const mov = await register_manual_movement(store, { tipo: 'entrada_manual', producto: PRODUCTO, cantidad: 3, motivo: 'encontrado' });
		expect(store.data.products[0].existencia).toBe(8);
		expect(mov).toMatchObject({ tipo_movimiento: 'entrada_manual', stock_total_previo: 5, stock_total_resultante: 8 });
		expect(movement_delta(mov)).toBe(3);
	});

	test('salida resta existencia', async () => {
		const store = memory_store(5);
		const mov = await register_manual_movement(store, { tipo: 'salida_manual', producto: PRODUCTO, cantidad: 2 });
		expect(store.data.products[0].existencia).toBe(3);
		expect(movement_delta(mov)).toBe(-2);
	});

	test('por defecto bloquea la salida que dejaría negativo', async () => {
		const store = memory_store(1);
		await expect(
			register_manual_movement(store, { tipo: 'salida_manual', producto: PRODUCTO, cantidad: 2 }),
		).rejects.toThrow('existencia suficiente');
		expect(store.data.products[0].existencia).toBe(1);
		expect(store.data['inventory-movement']).toHaveLength(0);
	});

	test('con el interruptor en SÍ permite quedar negativo', async () => {
		const store = memory_store(1, true);
		await register_manual_movement(store, { tipo: 'salida_manual', producto: PRODUCTO, cantidad: 2 });
		expect(store.data.products[0].existencia).toBe(-1);
	});

	test('rechaza tipo o cantidad inválidos', async () => {
		const store = memory_store(1);
		await expect(register_manual_movement(store, { tipo: 'x', producto: PRODUCTO, cantidad: 1 })).rejects.toThrow();
		await expect(register_manual_movement(store, { tipo: 'entrada_manual', producto: PRODUCTO, cantidad: 0 })).rejects.toThrow();
	});
});
