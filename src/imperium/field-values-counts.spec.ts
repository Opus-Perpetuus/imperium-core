import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { field_values_from_counts, field_values_from_distinct } from './field-values.ts';
import { push_where_clauses } from './store.ts';

// #327: el filtro mostraba siempre «1 coincidencia»: el distinct traía un valor
// por fila sin su conteo. #329: los valores de una subtabla salían de todos los
// documentos porque el distinct ignoraba los filtros de la vista.
describe('#327 field-values con el conteo real', () => {
	test('cada valor trae cuántos registros lo tienen (0, 1 y más de 1)', () => {
		const options = field_values_from_counts(
			[
				{ v: 'por_surtir', n: 7 },
				{ v: 'borrador', n: 1 },
			],
			'estado',
			{
				field_name: 'estado',
				enabled: true,
				read_only: false,
				values: [
					{ value: 'borrador', type: 'neutral', display_leyend: 'Borrador', color: '#6c757d' },
					{ value: 'por_surtir', type: 'warning', display_leyend: 'Por surtir', color: '#ffc107' },
					{ value: 'cancelado', type: 'danger', display_leyend: 'Cancelado', color: '#dc3545' },
				],
			},
		);
		const by_value = Object.fromEntries(options.map((o) => [o.value, o.count]));
		expect(by_value).toEqual({ borrador: 1, por_surtir: 7, cancelado: 0 });
	});

	test('arreglos (tags) en texto JSON cuentan cada etiqueta con el peso de su fila', () => {
		const options = field_values_from_counts(
			[
				{ v: '["Urgente","Mayoreo"]', n: 3 },
				{ v: '["Urgente"]', n: 2 },
			],
			'tags',
			null,
		);
		const by_value = Object.fromEntries(options.map((o) => [o.value, o.count]));
		expect(by_value).toEqual({ Urgente: 5, Mayoreo: 3 });
	});

	test('sin conteos (store viejo) sigue contando una vez por valor', () => {
		const options = field_values_from_distinct(['a', 'b'], 'campo', null);
		expect(options.map((o) => o.count)).toEqual([1, 1]);
	});
});

describe('#329 field-values dentro de la vista (subtablas)', () => {
	test('el where de la lista se vuelve SQL igual que en find_many', () => {
		const params: unknown[] = [];
		const clauses: string[] = [];
		push_where_clauses(
			new Set(['id', 'pedido_id', 'is_active']),
			{ pedido_id: 'P-1', codigo: { in: ['A', 'B'] }, fecha: { gte: '2026-11-01' } },
			params,
			clauses,
		);
		expect(clauses[0]).toBe('"pedido_id" = $1');
		expect(clauses[1]).toContain('IN ($2, $3)');
		expect(clauses.length).toBe(3);
		expect(params.slice(0, 3)).toEqual(['P-1', 'A', 'B']);
	});

	test('el endpoint usa distinct_counts con el where de la vista, sin el filtro de su propia columna', () => {
		const src = readFileSync(join(import.meta.dir, 'crud.ts'), 'utf8');
		const start = src.indexOf("segs[0] === 'field-values'");
		const block = src.slice(start, start + 2600);
		expect(block).toContain('field_values_view_where(store, resource, url, actor, field_path)');
		expect(block).toContain('store.distinct_counts(resource, field_path');
		const helper = src.slice(src.indexOf('async function field_values_view_where('));
		expect(helper.slice(0, 900)).toContain('if (key === field_path) delete where[key];');
	});
});
