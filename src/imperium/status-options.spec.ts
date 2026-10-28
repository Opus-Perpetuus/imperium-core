import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { list_status_option_control } from './status-options.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]> = {}) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	const store = {
		data,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (
				(data[resource] ?? []).find((row) =>
					Object.entries(where).every(([key, value]) => row[key] === value),
				) ?? null
			);
		},
		async *scan(resource: string, opts?: { where?: Record<string, unknown> }) {
			let rows = data[resource] ?? [];
			if (opts?.where) {
				rows = rows.filter((row) =>
					Object.entries(opts.where ?? {}).every(([key, value]) => row[key] === value),
				);
			}
			yield rows;
		},
	};
	return store as unknown as ImperiumStore;
}

function ctx(url: string, store: ImperiumStore = memory_store()) {
	return {
		store,
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

	test('configs keyed by subject model_id show has_configuration even without module UUID', async () => {
		const store = memory_store({
			'module-management': [
				{
					_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
					name: 'Vehículos',
					module_name: 'vehiculos',
					model_id: '',
					is_enable: true,
				},
			],
			configuration: [
				{
					_id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
					type: 'status-options-by-module',
					module_id: 'subject-vehiculos/vehicle',
					model_id: 'subject-vehiculos/vehicle',
					name: 'Opciones de estado | vehicle',
					value: {
						module_id: 'subject-vehiculos/vehicle',
						model_id: 'subject-vehiculos/vehicle',
						module_name: 'vehicle',
						status_fields: ['estado_operativo'],
						options: [
							{
								value: 'disponible',
								label: 'Disponible',
								type: 'success',
								color: '#198754',
								field_name: 'estado_operativo',
							},
						],
					},
				},
			],
		});
		const result = await list_status_option_control(
			ctx('http://test/api/status-option-control?take=50', store) as never,
		);
		const rows = result.data as Array<Record<string, unknown>>;
		const with_config = rows.filter((row) => row.has_configuration === true);
		expect(with_config.length).toBe(1);
		expect(with_config[0]?.model_id).toBe('subject-vehiculos/vehicle');
		expect(with_config[0]?.status_options_count).toBe(1);
		const subject_row = rows.find((row) => row.module_id === 'aaaaaaaaaaaaaaaaaaaaaaaa');
		expect(subject_row?.has_configuration).toBe(false);
	});
});
