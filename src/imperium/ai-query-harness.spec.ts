import { describe, expect, test } from 'bun:test';
import { detail_fields, pick_model_object, plan_from_model, widgets_from_plan } from './ai-query-harness.ts';

describe('ai query harness', () => {
	test('un plan con dos listas y un tope', () => {
		const plan = plan_from_model({
			answer: 'Dos listas.',
			steps: [
				{ model_id: 'User', limit: 10 },
				{ model_id: 'Products', search: 'tornillo', filters: [{ field: 'existencia', op: 'lt', value: 0 }] },
			],
		});
		expect(plan.steps).toEqual([
			{ model_id: 'User', title: 'User', search: '', limit: 10, sort: '', widget_type: 'table', aggregation: null, filters: [] },
			{
				model_id: 'Products',
				title: 'Products',
				search: 'tornillo',
				limit: null,
				sort: '',
				widget_type: 'table',
				aggregation: null,
				filters: [{ field: 'existencia', op: 'lt', value: '0' }],
			},
		]);
		expect(widgets_from_plan(plan)[1].filters[0].op).toBe('lt');
	});

	test('un objeto suelto con model_id es un paso', () => {
		const plan = plan_from_model({ model_id: 'Products', limit: 11 });
		expect(plan.steps.map((step) => step.model_id)).toEqual(['Products']);
		expect(plan.steps[0].limit).toBe(11);
	});

	test('confirmada en la búsqueda pasa a estado confirmado', () => {
		const plan = plan_from_model({ model_id: 'Pedidos', search: 'confirmada', limit: 1, sort: 'updated_at:desc' });
		expect(plan.steps[0].search).toBe('');
		expect(plan.steps[0].filters).toEqual([{ field: 'estado', op: 'eq', value: 'confirmado' }]);
		expect(plan.steps[0].sort).toBe('updated_at:desc');
	});

	test('toma el JSON del plan aunque el razonamiento traiga otro objeto', () => {
		const text = 'pensé { "nota": "no cierra" y luego {"answer":"suma","steps":[{"model_id":"Pedidos","widget_type":"table","aggregation":{"op":"sum","field":"total"}}]}';
		const parsed = pick_model_object(text);
		expect(parsed?.answer).toBe('suma');
		const plan = plan_from_model(parsed!);
		expect(plan.steps[0].widget_type).toBe('kpi');
		expect(plan.steps[0].aggregation).toEqual({ op: 'sum', field: 'total' });
	});

	test('una respuesta de factura devuelve el objeto exterior', () => {
		const text = '{"proveedor_nombre":"ACME","articulos":[{"descripcion":"Tornillo","importe":100}]}';
		expect(pick_model_object(text)).toEqual({
			proveedor_nombre: 'ACME',
			articulos: [{ descripcion: 'Tornillo', importe: 100 }],
		});
	});

	test('un límite por encima de 100 se queda en 100 y el 1 se conserva', () => {
		expect(plan_from_model({ model_id: 'User', limit: 250 }).steps[0].limit).toBe(100);
		expect(plan_from_model({ model_id: 'User', limit: 1 }).steps[0].limit).toBe(1);
		expect(plan_from_model({ model_id: 'User', limit: 0 }).steps[0].limit).toBeNull();
	});

	test('fuera de catálogo deja la respuesta y ningún paso', () => {
		const plan = plan_from_model({ answer: 'Eso no está en los módulos.', steps: [] });
		expect(plan.answer).toBe('Eso no está en los módulos.');
		expect(plan.steps).toEqual([]);
		expect(widgets_from_plan(plan)).toEqual([]);
	});

	test('una suma pedida como tabla sale como kpi', () => {
		const plan = plan_from_model({
			answer: 'suma',
			steps: [{ model_id: 'Pedidos', widget_type: 'table', aggregation: { op: 'sum' } }],
		});
		expect(plan.steps[0].widget_type).toBe('kpi');
		expect(plan.steps[0].aggregation).toEqual({ op: 'sum', field: 'total' });
	});

	test('confirmadas dentro de la búsqueda pasa a estado confirmado', () => {
		const plan = plan_from_model({ model_id: 'Pedidos', search: 'cliente confirmadas, norte' });
		expect(plan.steps[0].search).toBe('cliente norte');
		expect(plan.steps[0].filters).toEqual([{ field: 'estado', op: 'eq', value: 'confirmado' }]);
	});

	test('detail pide campos solo de esos modelos', () => {
		const text = detail_fields(
			[
				{ model_id: 'Products', fields: [{ path: 'descripcion' }, { path: 'existencia' }] },
				{ model_id: 'User', fields: [{ path: 'email' }] },
			],
			['Products'],
		);
		expect(text).toBe('- Products: descripcion, existencia');
	});
});
