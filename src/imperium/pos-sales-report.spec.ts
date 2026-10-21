import { describe, expect, test } from 'bun:test';
import extra_routes from './extra-routes.json';
import type { ImperiumDoc } from './envelope.ts';
import { build_sales_by_product, pos_sales_by_product } from './pos-sales-report.ts';
import type { ImperiumStore } from './store.ts';

const A = '507f1f77bcf86cd799439013';
const B = '507f1f77bcf86cd799439014';
const products = new Map<string, ImperiumDoc>([
	[A, { _id: A, name: 'Agua', codigo: 'AG', costoCompraPromedio: 6 }],
	[B, { _id: B, name: 'Pan', codigo: 'PN', ultimoCostoCompra: 2 }],
]);

function ticket(id: string, at: string, items: ImperiumDoc[], extra: ImperiumDoc = {}): ImperiumDoc {
	return { _id: id, createdAt: at, ticket_type: 'VENTA', state: 'confirmado', items: JSON.stringify(items), ...extra };
}

describe('ventas por artículo y utilidad', () => {
	test('suma cantidad e importe, costea con el costo promedio y ordena por importe', () => {
		const r = build_sales_by_product(
			[
				ticket('t1', '2026-10-01T12:00:00', [
					{ item_id: A, quantity: 2, unit_price: 10, total: 20 },
					{ item_id: B, quantity: 5, unit_price: 3, total: 15 },
				]),
				ticket('t2', '2026-10-02T12:00:00', [{ item_id: A, quantity: 1, unit_price: 10 }]),
			],
			products,
		);
		expect(r.total_tickets).toBe(2);
		expect(r.articulos.map((a) => [a.codigo, a.cantidad, a.importe, a.costo, a.utilidad, a.tickets])).toEqual([
			['AG', 3, 30, 18, 12, 2],
			['PN', 5, 15, 10, 5, 1],
		]);
		expect(r.articulos[0]!.margen_pct).toBe(40);
		expect([r.importe, r.costo, r.utilidad]).toEqual([45, 28, 17]);
	});

	test('devoluciones restan; cancelados, inactivos, retiros y fuera de rango no cuentan', () => {
		const r = build_sales_by_product(
			[
				ticket('t1', '2026-10-01T12:00:00', [{ item_id: A, quantity: 3, total: 30 }]),
				ticket('t2', '2026-10-01T13:00:00', [{ item_id: A, quantity: 1, total: 10 }], { ticket_type: 'DEVOLUCION' }),
				ticket('t3', '2026-10-01T14:00:00', [{ item_id: A, quantity: 9, total: 90 }], { state: 'cancelado' }),
				ticket('t4', '2026-10-01T15:00:00', [{ item_id: A, quantity: 9, total: 90 }], { is_active: false }),
				ticket('t5', '2026-10-01T16:00:00', [], { ticket_type: 'RETIRO_MANUAL_CAJA', subtotal: 100 }),
				ticket('t6', '2026-11-01T12:00:00', [{ item_id: A, quantity: 9, total: 90 }]),
			],
			products,
			{ desde: '2026-10-01', hasta: '2026-10-31' },
		);
		expect(r.total_tickets).toBe(2);
		expect(r.articulos).toHaveLength(1);
		expect([r.articulos[0]!.cantidad, r.articulos[0]!.importe, r.articulos[0]!.costo]).toEqual([2, 20, 12]);
	});

	test('producto borrado conserva el nombre del ticket y margen nulo sin importe', () => {
		const r = build_sales_by_product(
			[ticket('t1', '2026-10-01T12:00:00', [{ item_id: 'x', item_name: 'Viejo', quantity: 1, total: 0 }])],
			products,
		);
		expect(r.articulos[0]!.nombre).toBe('Viejo');
		expect(r.articulos[0]!.margen_pct).toBeNull();
	});

	test('filtra por sesión, trae productos por id y la ruta GET está declarada', async () => {
		const calls: unknown[] = [];
		const store = {
			has: () => true,
			async *scan(_r: string, opts: unknown) {
				calls.push(opts);
				yield [ticket('t1', '2026-10-01T12:00:00', [{ item_id: A, quantity: 1, total: 10 }])];
			},
			find_many: async (_r: string, opts: { ids: string[] }) => ({
				rows: opts.ids.map((id) => products.get(id)).filter(Boolean),
				total: 0,
			}),
		} as unknown as ImperiumStore;
		const r = await pos_sales_by_product(store, { sesion: 'S1' });
		expect(calls[0]).toEqual({ where: { pos_session: 'S1' } });
		expect(r.costo).toBe(6);
		await expect(pos_sales_by_product(store, { desde: 'x' })).rejects.toThrow('Fecha inválida');
		expect(
			(extra_routes as Array<Record<string, string>>).some(
				(e) => e.resource === 'pos-tickets' && e.method === 'get' && e.path === '/ventas-por-articulo' && e.action === 'read_sales_by_product',
			),
		).toBe(true);
	});
});
