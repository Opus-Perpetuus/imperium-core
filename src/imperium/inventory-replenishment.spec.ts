import { describe, expect, test } from 'bun:test';
import extra_routes from './extra-routes.json';
import { build_replenishment, products_to_replenish, replenishment_row } from './inventory-replenishment.ts';
import type { ImperiumStore } from './store.ts';

describe('reabastecimiento por mínimos y máximos', () => {
	test('sugiere llegar al máximo descontando lo apartado', () => {
		const row = replenishment_row({
			_id: 'p1',
			name: 'Cemento',
			existencia: 12,
			existenciaApartada: 4,
			stockMinimo: 10,
			stockMaximo: '50',
			ultimoCostoCompra: 180,
		});
		expect(row).toMatchObject({ disponible: 8, maximo: 50, sugerido: 42, importe_estimado: 7560 });
	});

	test('sin máximo (o máximo menor al mínimo) sugiere llegar al mínimo', () => {
		expect(replenishment_row({ existencia: 3, stockMinimo: 5 })!.sugerido).toBe(2);
		expect(replenishment_row({ existencia: 3, stockMinimo: 5, stockMaximo: '4' })!.sugerido).toBe(2);
		expect(replenishment_row({ existencia: 5, stockMinimo: 5 })!.sugerido).toBe(0);
	});

	test('sobre el mínimo o sin mínimo no aparece', () => {
		expect(replenishment_row({ existencia: 6, stockMinimo: 5 })).toBeNull();
		expect(replenishment_row({ existencia: -2, stockMinimo: 0 })).toBeNull();
	});

	test('filtra por proveedor, omite inactivos y no comprables, ordena por proveedor y urgencia', () => {
		const r = build_replenishment(
			[
				{ _id: 'a', name: 'A', existencia: 4, stockMinimo: 5, proveedor: 'P2', proveedor_nombre: 'Zeta' },
				{ _id: 'b', name: 'B', existencia: 0, stockMinimo: 5, proveedor: { _id: 'P1' }, proveedor_nombre: 'Alfa' },
				{ _id: 'c', name: 'C', existencia: 4, stockMinimo: 5, proveedor: 'P1', proveedor_nombre: 'Alfa' },
				{ _id: 'd', name: 'D', existencia: 0, stockMinimo: 5, is_active: false },
				{ _id: 'e', name: 'E', existencia: 0, stockMinimo: 5, puedoComprarlo: false },
			],
		);
		expect(r.productos.map((p) => p.producto_id)).toEqual(['b', 'c', 'a']);
		expect(build_replenishment([{ _id: 'b', existencia: 0, stockMinimo: 1, proveedor: 'P1' }], 'P2').total_productos).toBe(0);
	});

	test('lee todos los productos y la ruta GET está declarada', async () => {
		const store = {
			has: () => true,
			async *scan() {
				yield [{ _id: 'a', existencia: 0, stockMinimo: 2 }];
				yield [{ _id: 'b', existencia: 9, stockMinimo: 2 }];
			},
		} as unknown as ImperiumStore;
		expect((await products_to_replenish(store)).productos.map((p) => p.producto_id)).toEqual(['a']);
		expect(
			(extra_routes as Array<Record<string, string>>).some(
				(e) => e.resource === 'products' && e.method === 'get' && e.path === '/reabastecer' && e.action === 'read_replenishment',
			),
		).toBe(true);
	});
});
