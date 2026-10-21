import { describe, expect, test } from 'bun:test';
import extra_routes from './extra-routes.json';
import { build_valuation, stock_valuation } from './inventory-valuation.ts';
import type { ImperiumStore } from './store.ts';

const products = new Map([
	['p1', { _id: 'p1', name: 'Cable', codigo: 'C1', costoCompraPromedio: 10 }],
	['p2', { _id: 'p2', name: 'Foco', codigo: 'F1', ultimoCostoCompra: 4 }],
]);

describe('existencias valorizadas por ubicación', () => {
	test('agrupa por ubicación, junta lotes del mismo producto y valora con el costo promedio', () => {
		const r = build_valuation(
			[
				{ producto: 'p1', ubicacion: 'U1', ubicacion_codigo: 'A-01', cantidad: 3, lote_codigo: 'L1' },
				{ producto: { _id: 'p1' }, ubicacion: 'U1', ubicacion_codigo: 'A-01', cantidad: 2, lote_codigo: 'L2' },
				{ producto: 'p2', ubicacion: 'U1', ubicacion_codigo: 'A-01', cantidad: 10 },
				{ producto: 'p2', ubicacion: 'U2', ubicacion_codigo: 'B-01', cantidad: 1 },
				{ producto: 'p2', ubicacion: 'U2', ubicacion_codigo: 'B-01', cantidad: 0 },
				{ producto: 'p1', ubicacion: 'U2', ubicacion_codigo: 'B-01', cantidad: 5, is_active: false },
			],
			products,
		);
		expect(r.valor).toBe(94);
		expect(r.detalle.map((u) => [u.ubicacion_codigo, u.productos, u.cantidad, u.valor])).toEqual([
			['A-01', 2, 15, 90],
			['B-01', 1, 1, 4],
		]);
		expect(r.detalle[0]!.lineas.map((l) => [l.producto_codigo, l.cantidad, l.valor])).toEqual([
			['C1', 5, 50],
			['F1', 10, 40],
		]);
	});

	test('filtra una ubicación; producto desconocido vale 0 y conserva el nombre de la fila', () => {
		const r = build_valuation(
			[
				{ producto: 'zz', producto_nombre: 'Viejo', ubicacion_id: 'U9', cantidad: 2 },
				{ producto: 'p1', ubicacion: 'U1', cantidad: 2 },
			],
			products,
			'U9',
		);
		expect(r.detalle).toHaveLength(1);
		expect(r.detalle[0]!.lineas[0]).toMatchObject({ producto_nombre: 'Viejo', valor: 0 });
		expect(r.detalle[0]!.ubicacion_codigo).toBe('Sin ubicación');
	});

	test('lee existencias y productos y la ruta GET está declarada', async () => {
		const store = {
			has: () => true,
			async *scan(resource: string) {
				yield resource === 'products' ? [...products.values()] : [{ producto: 'p1', ubicacion: 'U1', cantidad: 1 }];
			},
		} as unknown as ImperiumStore;
		expect((await stock_valuation(store)).valor).toBe(10);
		expect(
			(extra_routes as Array<Record<string, string>>).some(
				(e) => e.resource === 'inventory-stock-quant' && e.method === 'get' && e.path === '/valuacion' && e.action === 'read_valuation',
			),
		).toBe(true);
	});
});
