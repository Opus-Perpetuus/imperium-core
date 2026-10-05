import { describe, expect, test } from 'bun:test';
import { fixture_plan, load_corpus, score_line, validate_corpus } from './ai-query-corpus.ts';
import { widgets_from_plan } from './ai-query-harness.ts';

describe('ai query corpus', () => {
	test('el corpus graded cabe en el catálogo del tablero', () => {
		const summary = validate_corpus();
		expect(summary).toEqual({
			ok: true,
			count: 48,
			intents: 8,
			min_variants: 6,
			tiers: 'non-decreasing',
			unknown_model_ids: 0,
			provider_strings: 0,
		});
	});

	test('cada fixture sale del plan que ya usa el chat', () => {
		for (const fixture of load_corpus().fixtures) {
			const plan = fixture_plan(fixture);
			expect(plan, fixture.id).not.toBeNull();
			expect(plan!.answer, fixture.id).toBe(fixture.answer);
			expect(plan!.steps, fixture.id).toEqual(fixture.steps);
			expect(
				widgets_from_plan(plan!).map((widget) => ({
					model_id: widget.model_id,
					widget_type: widget.widget_type,
				})),
				fixture.id,
			).toEqual(fixture.steps.map((step) => ({ model_id: step.model_id, widget_type: step.widget_type })));
		}
	});

	test('un acierto exige texto y el mismo modelo y tipo', () => {
		const question = load_corpus().questions.find((item) => item.id === 'plain_list-01')!;
		expect(
			score_line(
				{
					prompt: question.prompt,
					assistant: 'Mostrando Pedidos.',
					widgets: [{ model_id: 'Pedidos', widget_type: 'table' }],
				},
				question,
			).status,
		).toBe('pass');
	});

	test('una lista que llega como gráfica no cuenta como acierto', () => {
		const question = load_corpus().questions.find((item) => item.id === 'plain_list-01')!;
		const hit = score_line(
			{
				prompt: question.prompt,
				assistant: 'Ahí va.',
				widgets: [{ model_id: 'Pedidos', widget_type: 'chart-bar', spec: { model_id: 'Pedidos', widget_type: 'chart-bar' } }],
			},
			question,
		);
		expect(hit.status).toBe('residual');
		expect(hit.kind).toBe('chart_fallback');
	});

	test('fuera de catálogo con texto y sin widgets es acierto', () => {
		const question = load_corpus().questions.find((item) => item.id === 'out_of_catalog-02')!;
		expect(
			score_line({ prompt: question.prompt, assistant: 'París no está en los módulos.', widgets: [] }, question).status,
		).toBe('pass');
	});

	test('un silencio del modelo es residual de entorno', () => {
		const question = load_corpus().questions.find((item) => item.id === 'numeric_limit-04')!;
		const hit = score_line(
			{ prompt: question.prompt, assistant: '', error: 'No se pudo procesar la consulta', http_status: 0, widgets: [] },
			question,
		);
		expect(hit.status).toBe('residual');
		expect(hit.kind).toBe('env');
	});

	test('un 403 es residual de entorno', () => {
		const question = load_corpus().questions.find((item) => item.id === 'plain_list-01')!;
		const hit = score_line(
			{ prompt: question.prompt, assistant: '', error: 'el servicio respondió 403', http_status: 403, widgets: [] },
			question,
		);
		expect(hit.status).toBe('residual');
		expect(hit.kind).toBe('env');
	});

	test('una suma marcada como tabla es un fallo del arnés', () => {
		const question = load_corpus().questions.find((item) => item.id === 'kpi_sum-01')!;
		const hit = score_line(
			{
				prompt: question.prompt,
				assistant: 'suma',
				api_answer: 'suma',
				widgets: [
					{
						model_id: 'Pedidos',
						widget_type: 'table',
						spec: { model_id: 'Pedidos', widget_type: 'table', aggregation: { op: 'sum', field: 'total' } },
					},
				],
			},
			question,
		);
		expect(hit.kind).toBe('harness');
		expect(hit.status).toBe('fail');
	});
});
