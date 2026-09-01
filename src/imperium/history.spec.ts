import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	build_history_action_description,
	diff_docs,
	enrich_history_change,
	enrich_history_row,
	history_find_many_opts,
	history_page_limits,
} from './history.ts';

describe('diff_docs', () => {
	test('edit writes a template with previous and next values, not just the field name', () => {
		const changes = diff_docs(
			{ _id: 'cfg-1', value: 'old', type: 'string' },
			{ _id: 'cfg-1', value: 'new', type: 'number' },
		);
		const value_change = changes.find((change) => change.normalizedPath === 'value');
		expect(value_change).toBeDefined();
		expect(String(value_change?.displayPath)).toContain('{{valorAnterior}}');
		expect(String(value_change?.displayPath)).toContain('{{valorNuevo}}');
		expect(value_change?.displayPathValues).toEqual(
			expect.objectContaining({
				etiqueta: 'value',
				valorAnterior: '"old"',
				valorNuevo: '"new"',
			}),
		);
		expect(value_change?.displayPath).not.toBe('value');
	});

	test('create uses the add template with the new value', () => {
		const [change] = diff_docs(null, { _id: 'n1', name: 'Almacén' });
		expect(change?.tipoMovimiento).toBe('crear');
		expect(String(change?.displayPath)).toContain('{{valorNuevo}}');
		expect(change?.displayPathValues).toEqual(
			expect.objectContaining({
				etiqueta: 'nombre',
				valorNuevo: '"Almacén"',
			}),
		);
	});
});

describe('history_page_limits', () => {
	test('defaults to 15 and never over-fetches thousands of rows', () => {
		expect(history_page_limits({})).toEqual({ desde: 0, limite: 15 });
		expect(history_page_limits({ limite: '50', desde: '15' })).toEqual({
			desde: 15,
			limite: 50,
		});
		expect(history_page_limits({ limite: '999' }).limite).toBe(50);
	});
});

describe('history_find_many_opts', () => {
	test('pages in SQL by documentId instead of an OR soup or a 20000-row scan', () => {
		const opts = history_find_many_opts({
			document_id: 'cfg-1',
			canonical: 'configuration',
			collection_name: 'configuration',
			desde: 15,
			limite: 15,
		});
		expect(opts.take).toBe(15);
		expect(opts.skip).toBe(15);
		expect(opts.take).toBeLessThan(100);
		expect(opts.populate).toBe(false);
		expect(opts.where).toEqual({ documentId: 'cfg-1' });
		expect(opts).not.toHaveProperty('mongo_match');
	});
});

describe('read_history source contract', () => {
	test('pages history through history_find_many_opts instead of a 20000-row scan', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const fn = src.slice(src.indexOf('async function read_history'));
		const body = fn.slice(0, fn.indexOf('\nasync function read_history_by_id'));
		expect(body).toContain('history_find_many_opts');
		expect(body).not.toMatch(/take:\s*20000/);
		expect(body).not.toContain('history_row_matches');
	});
});

describe('build_history_action_description', () => {
	test('interpolates etiqueta and values instead of storing raw placeholders', () => {
		const description = build_history_action_description([
			{
				tipoMovimiento: 'editar',
				displayLabel: 'estatus',
				displayPath:
					'Se cambió {{etiqueta}} de {{valorAnterior}} (i{class:fas fa-arrow-right}) {{valorNuevo}}',
				displayPathValues: {
					etiqueta: 'estatus',
					valorAnterior: '"open"',
					valorNuevo: '"resolved"',
				},
			},
		]);
		expect(description).toBe('Se cambió estatus de "open" → "resolved"');
		expect(description).not.toContain('{{');
		expect(description).not.toContain('(i{');
	});
});

describe('enrich_history_row', () => {
	test('legacy actionDescription templates are interpolated on read', () => {
		const row = enrich_history_row({
			actionDescription:
				'Se cambió {{etiqueta}} de {{valorAnterior}} (i{class:fas fa-arrow-right}) {{valorNuevo}}',
			changes: [
				{
					tipoMovimiento: 'editar',
					displayLabel: 'estatus',
					displayPath:
						'Se cambió {{etiqueta}} de {{valorAnterior}} (i{class:fas fa-arrow-right}) {{valorNuevo}}',
					displayPathValues: {
						etiqueta: 'estatus',
						valorAnterior: '"open"',
						valorNuevo: '"resolved"',
					},
				},
			],
		});
		expect(String(row.actionDescription)).toBe(
			'Se cambió estatus de "open" → "resolved"',
		);
	});
});

describe('enrich_history_change', () => {
	test('legacy rows that only stored the field name still expose before/after', () => {
		const enriched = enrich_history_change({
			tipoMovimiento: 'editar',
			normalizedPath: 'value',
			displayLabel: 'value',
			displayPath: 'value',
			before: 'old',
			after: 'new',
		});
		expect(String(enriched.displayPath)).toContain('{{valorAnterior}}');
		expect(enriched.displayPathValues).toEqual(
			expect.objectContaining({
				valorAnterior: '"old"',
				valorNuevo: '"new"',
			}),
		);
	});
});
