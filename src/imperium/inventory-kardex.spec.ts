import { describe, expect, test } from 'bun:test';
import extra_routes from './extra-routes.json';
import type { ImperiumDoc } from './envelope.ts';
import { build_kardex, kardex_bounds, movement_delta, product_kardex } from './inventory-kardex.ts';
import type { ImperiumStore } from './store.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const product: ImperiumDoc = {
	_id: PRODUCTO,
	name: 'Tornillo',
	codigo: 'T-1',
	unidad: 'pza',
	costoCompraPromedio: 2.5,
};

function mov(fecha: string, tipo: string, previo: number | null, resultante: number | null, extra: ImperiumDoc = {}) {
	return {
		_id: `${fecha}-${tipo}`,
		producto: PRODUCTO,
		tipo_movimiento: tipo,
		fecha_movimiento: fecha,
		cantidad: Math.abs((resultante ?? 0) - (previo ?? 0)) || extra.cantidad,
		stock_total_previo: previo,
		stock_total_resultante: resultante,
		...extra,
	};
}

describe('kárdex de producto', () => {
	test('entradas, salidas y existencia en orden cronológico aunque lleguen desordenados', () => {
		const k = build_kardex(product, [
			mov('2026-10-03T10:00:00.000Z', 'salida_entrega', 10, 7, { documento_referencia: 'T-0001' }),
			mov('2026-10-01T10:00:00.000Z', 'recepcion_compra', 0, 10, { costo_unitario: 2.4 }),
			mov('2026-10-04T10:00:00.000Z', 'ajuste_manual', 7, 8),
		]);
		expect(k.movimientos.map((r) => [r.entrada, r.salida, r.existencia])).toEqual([
			[10, 0, 10],
			[0, 3, 7],
			[1, 0, 8],
		]);
		expect(k.saldo_inicial).toBe(0);
		expect(k.total_entradas).toBe(11);
		expect(k.total_salidas).toBe(3);
		expect(k.saldo_final).toBe(8);
		expect(k.valor_final).toBe(20);
		expect(k.movimientos[0]!.costo_unitario).toBe(2.4);
		expect(k.movimientos[1]!.documento).toBe('T-0001');
	});

	test('el rango deja fuera lo anterior como saldo inicial y corta lo posterior', () => {
		const k = build_kardex(
			product,
			[
				mov('2026-09-20T10:00:00', 'recepcion_compra', 0, 50),
				mov('2026-10-02T10:00:00', 'salida_entrega', 50, 45),
				mov('2026-11-01T10:00:00', 'salida_entrega', 45, 40),
			],
			{ desde: '2026-10-01', hasta: '2026-10-31' },
		);
		expect(k.saldo_inicial).toBe(50);
		expect(k.movimientos).toHaveLength(1);
		expect(k.saldo_final).toBe(45);
	});

	test('sin movimientos en el rango el saldo final es el inicial', () => {
		const k = build_kardex(product, [mov('2026-09-20T10:00:00', 'recepcion_compra', 0, 12)], {
			desde: '2026-10-01',
		});
		expect(k.movimientos).toHaveLength(0);
		expect(k.saldo_inicial).toBe(12);
		expect(k.saldo_final).toBe(12);
	});

	test('apartados y traslados no cambian la existencia; sin columnas de stock se deduce del tipo', () => {
		expect(movement_delta(mov('2026-10-01', 'apartado_logistica', 10, 10))).toBe(0);
		expect(movement_delta({ tipo_movimiento: 'transferencia_interna', cantidad: 4 })).toBe(0);
		expect(movement_delta({ tipo_movimiento: 'recepcion_compra', cantidad: 4 })).toBe(4);
		expect(movement_delta({ tipo_movimiento: 'salida_entrega', cantidad: 4 })).toBe(-4);
	});

	test('fechas inválidas o invertidas se rechazan', () => {
		expect(() => kardex_bounds({ desde: 'ayer' })).toThrow('Fecha inválida');
		expect(() => kardex_bounds({ desde: '2026-10-05', hasta: '2026-10-01' })).toThrow('posterior');
	});

	test('lee movimientos por producto o producto_id sin duplicar y ruta GET declarada', async () => {
		const rows = [
			mov('2026-10-01T10:00:00', 'recepcion_compra', 0, 5),
			{ ...mov('2026-10-02T10:00:00', 'salida_entrega', 5, 4), producto: undefined, producto_id: PRODUCTO },
			mov('2026-10-03T10:00:00', 'salida_entrega', 4, 3, { producto: 'otro' }),
		];
		const store = {
			has: (r: string) => r === 'products' || r === 'inventory-movement',
			find_id: async (_r: string, id: string) => (id === PRODUCTO ? product : null),
			async *scan(_r: string, opts: { where: Record<string, unknown> }) {
				const [k, v] = Object.entries(opts.where)[0]!;
				yield rows.filter((row) => (row as Record<string, unknown>)[k] === v);
			},
		} as unknown as ImperiumStore;
		const k = await product_kardex(store, PRODUCTO);
		expect(k.movimientos.map((r) => r.existencia)).toEqual([5, 4]);
		await expect(product_kardex(store, 'nada')).rejects.toThrow('El producto no existe');
		expect(
			(extra_routes as Array<Record<string, string>>).some(
				(r) => r.resource === 'inventory-movement' && r.method === 'get' && r.path === '/kardex/:producto_id' && r.action === 'read_kardex',
			),
		).toBe(true);
	});
});
