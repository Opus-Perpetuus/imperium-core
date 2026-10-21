import { describe, expect, test } from 'bun:test';
import extra_routes from './extra-routes.json';
import { aging_bucket, build_supplier_aging, supplier_aging } from './supplier-aging.ts';
import type { ImperiumStore } from './store.ts';

describe('antigüedad de saldos de cuentas por pagar', () => {
	test('tramos por días vencidos', () => {
		expect([-3, 0, 1, 30, 31, 60, 61, 90, 91].map(aging_bucket)).toEqual([
			'por_vencer', 'por_vencer', 'd1_30', 'd1_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'mas_90',
		]);
	});

	test('agrupa por proveedor, suma saldos por tramo y omite pagadas y canceladas', () => {
		const r = build_supplier_aging(
			[
				{ _id: '1', proveedor: 'P1', proveedor_nombre: 'Aceros', total: 1000, saldo: 400, fecha_vencimiento: '2026-10-10' },
				{ _id: '2', proveedor: { _id: 'P1' }, proveedor_nombre: 'Aceros', total: 500, saldo: 500, fecha_vencimiento: '2026-11-05' },
				{ _id: '3', proveedor: 'P2', proveedor_nombre: 'Bloques', total: 300, saldo: 300, fecha_vencimiento: '2026-06-01' },
				{ _id: '4', proveedor: 'P2', total: 300, saldo: 0, fecha_vencimiento: '2026-06-01' },
				{ _id: '5', proveedor: 'P2', total: 300, saldo: 300, estado: 'cancelada', fecha_vencimiento: '2026-06-01' },
				{ _id: '6', proveedor: 'P2', total: 300, saldo: 300, is_active: false },
			],
			'2026-10-21',
		);
		expect(r.corte).toBe('2026-10-21');
		expect(r.saldo).toBe(1200);
		expect([r.por_vencer, r.d1_30, r.mas_90]).toEqual([500, 400, 300]);
		expect(r.proveedores.map((p) => [p.proveedor_nombre, p.saldo])).toEqual([
			['Aceros', 900],
			['Bloques', 300],
		]);
		expect(r.proveedores[0]!.facturas.map((f) => [f._id, f.dias_vencida])).toEqual([
			['1', 11],
			['2', -15],
		]);
	});

	test('sin vencimiento usa la fecha de factura y sin saldo usa el total', () => {
		const r = build_supplier_aging([{ _id: '1', total: 50, fecha_factura: '2026-09-01' }], '2026-10-21');
		expect(r.d31_60).toBe(50);
	});

	test('corte inválido se rechaza; lee facturas y la ruta GET está declarada', async () => {
		expect(() => build_supplier_aging([], 'mañana')).toThrow('Fecha de corte inválida');
		const store = {
			has: () => true,
			async *scan() {
				yield [{ _id: '1', total: 10, saldo: 10, fecha_vencimiento: '2026-10-20' }];
			},
		} as unknown as ImperiumStore;
		expect((await supplier_aging(store, '2026-10-21')).d1_30).toBe(10);
		expect(
			(extra_routes as Array<Record<string, string>>).some(
				(e) => e.resource === 'supplier-invoice' && e.method === 'get' && e.path === '/antiguedad-saldos' && e.action === 'read_aging',
			),
		).toBe(true);
	});
});
