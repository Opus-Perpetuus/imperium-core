import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	is_unique_violation,
	json_unwrap_error_action,
	unwrap_jsonb_string_one_sql,
} from './store.ts';

const bun_unique = {
	code: 'ERR_POSTGRES_SERVER_ERROR',
	errno: '23505',
	message:
		'duplicate key value violates unique constraint "uq_custom_user_themes_user_id_theme_name"',
};

describe('is_unique_violation', () => {
	test('reconoce el PostgresError de Bun (23505 en errno, no en code)', () => {
		expect(is_unique_violation(bun_unique)).toBe(true);
	});

	test('reconoce SQLSTATE en code y el texto de Postgres', () => {
		expect(is_unique_violation({ code: '23505' })).toBe(true);
		expect(
			is_unique_violation({
				message:
					'duplicate key value violates unique constraint "uq_custom_user_themes_user_id_theme_name"',
			}),
		).toBe(true);
	});

	test('no traga 42P01 ni errores ajenos', () => {
		expect(
			is_unique_violation({
				code: 'ERR_POSTGRES_SERVER_ERROR',
				errno: '42P01',
			}),
		).toBe(false);
		expect(is_unique_violation({ code: 'ERR_POSTGRES_SERVER_ERROR' })).toBe(
			false,
		);
		expect(is_unique_violation(null)).toBe(false);
	});
});

describe('json_unwrap_error_action', () => {
	test('el unwrap por lote que choca unique pasa a fila a fila; tabla faltante se salta', () => {
		expect(json_unwrap_error_action(bun_unique)).toBe('lenient');
		expect(
			json_unwrap_error_action({
				code: 'ERR_POSTGRES_SERVER_ERROR',
				errno: '42P01',
				message: 'relation "subject_tienda.providers" does not exist',
			}),
		).toBe('skip-table');
		expect(json_unwrap_error_action({ message: 'syntax error' })).toBe(
			'throw',
		);
	});
});

describe('artefacto unwrap', () => {
	test('ensure_object_json_cells usa json_unwrap_error_action y unwrap por id', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async ensure_object_json_cells(');
		const body = src.slice(
			start,
			src.indexOf('async ensure_defaults(', start),
		);
		expect(body).toContain('json_unwrap_error_action');
		expect(body).toContain('unwrap_jsonb_string_one_sql');
		expect(src).toContain('json_unwrap_error_action(err)');
	});

	test('unwrap_jsonb_string_one_sql actualiza una fila por $1', () => {
		const sql = unwrap_jsonb_string_one_sql(
			'"subject_configuracion"."custom_user_themes"',
			'payload',
		);
		expect(sql).toContain('#>>');
		expect(sql).toContain('WHERE id = $1');
		expect(sql).not.toContain('LIMIT 1000');
	});
});
