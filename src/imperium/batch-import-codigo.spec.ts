import { describe, expect, test } from 'bun:test';
import { is_code_field, normalize_code_value, run_batch_import } from './batch-import.ts';

describe('importación en lote: códigos sin coma (#294)', () => {
	test('normaliza separador de miles y .0 solo en códigos numéricos', () => {
		expect(normalize_code_value(1262)).toBe('1262');
		expect(normalize_code_value('1,262')).toBe('1262');
		expect(normalize_code_value(' 12,345,678 ')).toBe('12345678');
		expect(normalize_code_value('1262.0')).toBe('1262');
		expect(normalize_code_value('1,262.00')).toBe('1262');
		expect(normalize_code_value('AH0119')).toBe('AH0119');
		expect(normalize_code_value('0040')).toBe('0040');
		expect(normalize_code_value('1,5')).toBe('1,5');
		expect(normalize_code_value('1/2')).toBe('1/2');
		expect(normalize_code_value(null)).toBe(null);
	});

	test('solo aplica a campos de código', () => {
		expect(is_code_field('codigo')).toBe(true);
		expect(is_code_field('codigo_bulto')).toBe(true);
		expect(is_code_field('ubicacion_preferida_codigo')).toBe(true);
		expect(is_code_field('nombreCompleto')).toBe(false);
		expect(is_code_field('costoVenta')).toBe(false);
	});

	test('una fila «1,262» actualiza el producto 1262 en vez de crear un duplicado', async () => {
		const existing = [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'ACIDO', codigo: '1262' }];
		const store = {
			field_refs: () => ({}),
			column_names: () => new Set(['codigo']),
			find_id: async () => null,
			find_many: async (_r: string, opts: { where: Record<string, unknown> }) => {
				const [[field, value]] = Object.entries(opts.where);
				return { rows: existing.filter((row) => (row as Record<string, unknown>)[field] === value) };
			},
		};
		const created: unknown[] = [];
		const updated: Array<[string, Record<string, unknown>]> = [];
		const result = (await run_batch_import({
			store: store as never,
			resource: 'products',
			rows: [{ codigo: '1,262', costoVenta: 32.87 }, { codigo: 1262.0, costoVenta: 33 }],
			match_field: 'codigo',
			persist_create: async (doc) => {
				created.push(doc);
				return { ...doc, _id: 'nuevo' };
			},
			persist_update: async (id, doc) => {
				updated.push([id, doc]);
				return { ...doc, _id: id };
			},
		})) as Record<string, any>;
		expect(created).toEqual([]);
		expect(updated.map(([id, doc]) => [id, doc.codigo])).toEqual([
			['aaaaaaaaaaaaaaaaaaaaaaaa', '1262'],
			['aaaaaaaaaaaaaaaaaaaaaaaa', '1262'],
		]);
		expect(result.summary).toMatchObject({ created: 0, updated: 2, failed: 0 });
	});

	test('en automático (sin «Campo adicional») el código también coincide en productos', async () => {
		const existing = [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'ACIDO', codigo: '1262' }];
		const store = {
			field_refs: () => ({}),
			column_names: () => new Set(['codigo']),
			find_id: async () => null,
			find_many: async (_r: string, opts: { where: Record<string, unknown> }) => {
				const [[field, value]] = Object.entries(opts.where);
				return { rows: existing.filter((row) => (row as Record<string, unknown>)[field] === value) };
			},
		};
		const run = (resource: string) =>
			run_batch_import({
				store: store as never,
				resource,
				rows: [{ codigo: '1,262', name: 'ACIDO NUEVO NOMBRE' }],
				match_field: null,
				dry_run: true,
				persist_create: async (doc) => ({ ...doc, _id: 'nuevo' }),
				persist_update: async (id, doc) => ({ ...doc, _id: id }),
			}) as Promise<Record<string, any>>;
		expect((await run('products')).summary).toMatchObject({ created: 0, updated: 1, failed: 0 });
		// Otros recursos siguen con _id, name y description.
		expect((await run('contacto')).summary).toMatchObject({ created: 1, updated: 0 });
	});
});
