import { describe, expect, test } from 'bun:test';
import { get_widget_kind, register_widget_kind, validate_widget_spec, widget_kinds } from './widget-kinds.ts';

const CATALOG = [
	{
		model_id: 'Products',
		module_name: 'Productos',
		fields: [{ path: '_id' }, { path: 'name' }, { path: 'precio' }, { path: 'estado' }, { path: 'updatedAt' }],
	},
];

function errors_of(spec: Record<string, unknown>) {
	const res = validate_widget_spec(spec, CATALOG);
	return res.ok ? [] : res.errors;
}

describe('registro de tipos de widget', () => {
	test('registra los tipos que pinta el tablero', () => {
		expect(widget_kinds().map((kind) => kind.widget_type)).toEqual(
			expect.arrayContaining(['kpi', 'progress', 'chart-pie', 'chart-line', 'chart-bar', 'table']),
		);
		expect(get_widget_kind('table')?.max_rows).toBe(100);
	});

	test('un tipo registrado aparece en la lista', () => {
		register_widget_kind({ widget_type: 'gauge-prueba', family: 'kpi', aggregations: ['count'], max_rows: 10 });
		expect(widget_kinds().map((kind) => kind.widget_type)).toContain('gauge-prueba');
	});
});

describe('validate_widget_spec', () => {
	test('acepta un widget dentro del catálogo', () => {
		const res = validate_widget_spec(
			{
				widget_type: 'kpi',
				model_id: 'Products',
				aggregation: { op: 'sum', field: 'precio' },
				filters: [{ field: 'estado', op: 'eq', value: 'confirmado' }],
				sort: 'updatedAt:desc',
			},
			CATALOG,
		);
		expect(res.ok).toBe(true);
	});

	test('rechaza un tipo no registrado', () => {
		expect(errors_of({ widget_type: 'note', model_id: 'Products' }).join(' ')).toContain("'note'");
	});

	test('rechaza una entidad fuera del catálogo', () => {
		expect(errors_of({ widget_type: 'table', model_id: 'User' }).join(' ')).toContain("'User'");
	});

	test('rechaza un campo fuera del catálogo en valor, agrupación, orden o filtro', () => {
		expect(errors_of({ widget_type: 'kpi', model_id: 'Products', aggregation: { op: 'sum', field: 'costo' } })).toHaveLength(1);
		expect(errors_of({ widget_type: 'chart-bar', model_id: 'Products', group_by: 'proveedor' })).toHaveLength(1);
		expect(errors_of({ widget_type: 'table', model_id: 'Products', sort: 'costo:desc' })).toHaveLength(1);
		expect(errors_of({ widget_type: 'table', model_id: 'Products', filters: [{ field: 'costo', op: 'eq', value: 1 }] })).toHaveLength(1);
		expect(errors_of({ widget_type: 'table', model_id: 'Products', fields: ['name', 'costo'] })).toHaveLength(1);
	});

	test('rechaza campos sensibles y con prefijo __ aunque el catálogo los traiga', () => {
		const catalog = [{ model_id: 'User', fields: [{ path: 'password' }, { path: '__v' }, { path: 'permissions' }] }];
		const res = validate_widget_spec(
			{ widget_type: 'table', model_id: 'User', fields: ['password', '__v', 'permissions'] },
			catalog,
		);
		expect(res.ok ? [] : res.errors).toHaveLength(3);
	});

	test('rechaza un operador de filtro fuera de la lista', () => {
		expect(errors_of({ widget_type: 'table', model_id: 'Products', filters: [{ field: 'estado', op: 'regex', value: '.*' }] })).toHaveLength(1);
	});

	test('rechaza una agregación que el tipo no permite', () => {
		expect(errors_of({ widget_type: 'chart-pie', model_id: 'Products', group_by: 'estado', aggregation: { op: 'avg', field: 'precio' } }).join(' ')).toContain("'avg'");
	});

	test('rechaza domain crudo del modelo', () => {
		expect(errors_of({ widget_type: 'table', model_id: 'Products', domain: { password: { $exists: true } } }).join(' ')).toContain('domain');
	});

	test('recorta el límite de filas al tope del tipo', () => {
		const res = validate_widget_spec({ widget_type: 'table', model_id: 'Products', limit: 5000 }, CATALOG);
		expect(res.ok && res.spec.limit).toBe(100);
	});
});
