import { describe, expect, test } from 'bun:test';
import extra_routes from './extra-routes.json';
import { build_expiry_report, expiring_stock, parse_expiry_days } from './inventory-expiry.ts';
import type { ImperiumStore } from './store.ts';

const HOY = new Date('2026-10-21T12:00:00');

describe('caducidades próximas', () => {
	test('vencidos primero, luego por vencer dentro del plazo; sin cantidad o sin fecha no salen', () => {
		const r = build_expiry_report(
			[
				{ _id: 'a', producto_nombre: 'Leche', lote_codigo: 'L1', fecha_caducidad: '2026-10-25', cantidad: 5 },
				{ _id: 'b', producto_nombre: 'Yogur', lote_codigo: 'L2', fecha_caducidad: '2026-10-19', cantidad: 2 },
				{ _id: 'c', producto_nombre: 'Queso', fecha_caducidad: '2026-12-31', cantidad: 9 },
				{ _id: 'd', producto_nombre: 'Crema', fecha_caducidad: '2026-10-22', cantidad: 0 },
				{ _id: 'e', producto_nombre: 'Pan', cantidad: 3 },
				{ _id: 'f', producto_nombre: 'Jamón', fecha_caducidad: '2026-10-22', cantidad: 1, is_active: false },
			],
			30,
			HOY,
		);
		expect(r.existencias.map((x) => [x._id, x.dias_restantes, x.estado])).toEqual([
			['b', -2, 'vencido'],
			['a', 4, 'por_vencer'],
		]);
		expect([r.vencidos, r.por_vencer]).toEqual([1, 1]);
	});

	test('0 días deja solo lo vencido y lo que vence hoy', () => {
		const r = build_expiry_report(
			[
				{ _id: 'hoy', fecha_caducidad: '2026-10-21', cantidad: 1 },
				{ _id: 'manana', fecha_caducidad: '2026-10-22', cantidad: 1 },
			],
			0,
			HOY,
		);
		expect(r.existencias.map((x) => x._id)).toEqual(['hoy']);
	});

	test('días por defecto 30 y valida el parámetro', () => {
		expect(parse_expiry_days(undefined)).toBe(30);
		expect(parse_expiry_days('7')).toBe(7);
		expect(() => parse_expiry_days('-1')).toThrow('entero');
		expect(() => parse_expiry_days('abc')).toThrow('entero');
	});

	test('lee existencias por ubicación y la ruta GET está declarada', async () => {
		const store = {
			has: () => true,
			async *scan() {
				yield [{ _id: 'x', fecha_caducidad: '2000-01-01', cantidad: 1 }];
			},
		} as unknown as ImperiumStore;
		expect((await expiring_stock(store, '5')).vencidos).toBe(1);
		expect(
			(extra_routes as Array<Record<string, string>>).some(
				(e) => e.resource === 'inventory-stock-quant' && e.method === 'get' && e.path === '/caducidades' && e.action === 'read_expiring',
			),
		).toBe(true);
	});
});
