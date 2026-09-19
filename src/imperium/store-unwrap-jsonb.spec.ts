import { describe, expect, test } from 'bun:test';
import { string_jsonb_ids_sql, unwrap_jsonb_string_sql } from './store.ts';

// Una fila con `\\u0000` en el texto abortaba el UPDATE en lote de toda la columna.
describe('unwrap de jsonb string-wrapped', () => {
	const qt = '"subject_configuracion"."debug_log"';
	const guard = `strpos(("payload" #>> '{}'), '\\u0000') = 0`;

	test('el lote salta las filas con \\u0000', () => {
		const sql = unwrap_jsonb_string_sql(qt, 'payload');
		expect(sql).toContain(`jsonb_typeof("payload") = 'string'`);
		expect(sql).toContain(guard);
		expect(sql).toContain(`SET "payload" = (t."payload" #>> '{}')::jsonb`);
	});

	test('el modo por fila recorre los mismos ids', () => {
		const sql = string_jsonb_ids_sql(qt, 'payload');
		expect(sql).toContain(guard);
		expect(sql).toContain('LIMIT 1000');
	});
});
