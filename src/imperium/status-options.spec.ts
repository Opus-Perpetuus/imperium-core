import { describe, expect, test } from 'bun:test';
import { list_status_option_control } from './status-options.ts';

function ctx(url: string) {
	return {
		store: { has: () => false },
		params: {},
		actor: null,
		body: {},
		url: new URL(url),
	};
}

describe('list_status_option_control', () => {
	test('module list includes tipo_de_instancia so the Angular table can paint columns', async () => {
		const result = await list_status_option_control(
			ctx('http://test/api/status-option-control') as never,
		);

		expect(result.tipo_de_instancia).toBeTruthy();
		expect(Object.keys(result.tipo_de_instancia ?? {})).toEqual([
			'name',
			'module_name',
			'model_id',
			'is_enable',
			'status_fields_count',
			'status_options_count',
			'has_configuration',
		]);
		expect(result.tipo_de_instancia?.name).toEqual({
			nombre_encabezado: 'name',
			tipo: 'string',
		});
	});

	test('option list includes tipo_de_instancia for the option-row columns', async () => {
		const result = await list_status_option_control(
			ctx(
				'http://test/api/status-option-control?module=not-a-module-id',
			) as never,
		);

		expect(result.tipo_de_instancia).toBeTruthy();
		expect(Object.keys(result.tipo_de_instancia ?? {})).toEqual([
			'name',
			'description',
			'option_field_name',
			'option_color',
			'option_type',
		]);
	});
});
