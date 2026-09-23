import { describe, expect, test } from 'bun:test';
import { is_stale_schema_cache } from './postgres-stale-plan.ts';

describe('is_stale_schema_cache', () => {
	test('plan invalidado al añadir una columna (0A000)', () => {
		expect(
			is_stale_schema_cache({
				code: 'ERR_POSTGRES_SERVER_ERROR',
				errno: '0A000',
				message: 'cached plan must not change result type',
			}),
		).toBe(true);
	});

	test('columna en caché que ya se borró (42703)', () => {
		expect(is_stale_schema_cache({ errno: '42703' })).toBe(true);
		expect(
			is_stale_schema_cache({
				message: 'PostgresError: column "qa_hard" does not exist',
			}),
		).toBe(true);
	});

	test('reconoce el mensaje aunque el SQLSTATE no venga', () => {
		expect(
			is_stale_schema_cache({
				message: 'cached plan must not change result type',
			}),
		).toBe(true);
	});

	test('statement preparado con menos columnas de las que hay ahora', () => {
		// Sin SQLSTATE propio: solo el mensaje del protocolo. Aparece al aplicar
		// el esquema de una app con el núcleo caliente, y sin reconocerlo la ruta
		// se queda en 400 hasta reiniciar el núcleo (comprobado).
		expect(
			is_stale_schema_cache({
				code: 'ERR_POSTGRES_SERVER_ERROR',
				message:
					'bind message has 21 result formats but query has 22 columns',
			}),
		).toBe(true);
	});

	test('no traga otros 0A000 ni errores ajenos', () => {
		expect(
			is_stale_schema_cache({ errno: '0A000', message: 'no se soporta eso' }),
		).toBe(false);
		expect(is_stale_schema_cache({ code: '42P01' })).toBe(false);
		expect(is_stale_schema_cache({ message: 'syntax error' })).toBe(false);
		expect(is_stale_schema_cache(null)).toBe(false);
	});
});
