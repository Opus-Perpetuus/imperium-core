import { describe, expect, test } from 'bun:test';
import { is_missing_relation } from './store.ts';

describe('is_missing_relation', () => {
	test('reconoce el PostgresError de Bun (42P01 en errno, no en code)', () => {
		expect(
			is_missing_relation({
				code: 'ERR_POSTGRES_SERVER_ERROR',
				errno: '42P01',
				message: 'relation "subject_tienda.providers" does not exist',
			}),
		).toBe(true);
	});

	test('reconoce SQLSTATE en code y columnas faltantes', () => {
		expect(is_missing_relation({ code: '42P01' })).toBe(true);
		expect(is_missing_relation({ code: '42703' })).toBe(true);
		expect(is_missing_relation({ errno: '42703' })).toBe(true);
	});

	test('no traga errores ajenos', () => {
		expect(is_missing_relation({ code: 'ERR_POSTGRES_SERVER_ERROR' })).toBe(
			false,
		);
		expect(is_missing_relation({ message: 'syntax error' })).toBe(false);
		expect(is_missing_relation(null)).toBe(false);
	});
});
