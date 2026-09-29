import { describe, expect, test } from 'bun:test';
import { resolve_delivery_gps } from './delivery-gps.ts';

const PUNTO = { latitude: 20.5937, longitude: -103.1234 };

describe('resolve_delivery_gps', () => {
	test('con coordenadas válidas la entrega queda ok', () => {
		expect(
			resolve_delivery_gps({
				delivery_gps_status: 'ok',
				delivery_coordinates: PUNTO,
				delivery_gps_accuracy_m: '12.5',
			}),
		).toEqual({ coordinates: PUNTO, status: 'ok', reason: null, accuracy_m: 12.5 });
	});

	test('sin coordenadas exige el motivo', () => {
		expect(() => resolve_delivery_gps({ delivery_gps_status: 'sin_gps' })).toThrow(
			'motivo',
		);
		expect(() =>
			resolve_delivery_gps({ delivery_gps_status: 'ok', delivery_coordinates: null }),
		).toThrow('motivo');
	});

	test('sin coordenadas y con motivo se acepta como sin_gps', () => {
		expect(
			resolve_delivery_gps({
				delivery_gps_status: 'sin_gps',
				delivery_gps_missing_reason: '  Sin señal en la zona ',
			}),
		).toEqual({ coordinates: null, status: 'sin_gps', reason: 'Sin señal en la zona', accuracy_m: null });
	});

	test('coordenadas fuera de rango o (0,0) se rechazan en un cliente nuevo', () => {
		for (const delivery_coordinates of [
			{ latitude: 0, longitude: 0 },
			{ latitude: 95, longitude: 10 },
			{ latitude: 'x', longitude: 10 },
		]) {
			expect(() =>
				resolve_delivery_gps({ delivery_gps_status: 'ok', delivery_coordinates }),
			).toThrow('coordenadas');
		}
	});

	test('un evento sin estado de GPS (cliente o cola anterior) nunca se rechaza: queda legado', () => {
		expect(resolve_delivery_gps({})).toEqual({
			coordinates: null,
			status: 'legado',
			reason: null,
			accuracy_m: null,
		});
		expect(resolve_delivery_gps({ delivery_coordinates: { latitude: 0, longitude: 0 } })).toEqual({
			coordinates: null,
			status: 'legado',
			reason: null,
			accuracy_m: null,
		});
		expect(resolve_delivery_gps({ delivery_coordinates: PUNTO })).toEqual({
			coordinates: PUNTO,
			status: 'legado',
			reason: null,
			accuracy_m: null,
		});
	});
});
