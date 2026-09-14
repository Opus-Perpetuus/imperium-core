import { describe, expect, test } from 'bun:test';
import { normalize_all_counters, prepare_increment_create } from './increment-normalize.ts';
import { is_global_ref, unwrap_ref_value } from './custom-pattern-render.ts';
import type { ImperiumDoc } from './envelope.ts';

type Row = ImperiumDoc;

function memory_store(
	seed: Record<string, Row[]>,
	opts: {
		/** Campos únicos por recurso (como `assert_unique_business_keys`). */
		unique?: Record<string, string[]>;
		/** Ids cuyo update lanza (documento con refs inválidas, etc.). */
		fail_update_ids?: string[];
		/** Recursos cuyo scan lanza (tabla inaccesible). */
		fail_scan_resources?: string[];
	} = {},
) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => row[key] === value);
	};
	const assert_unique = (resource: string, doc: Row, except_id?: string) => {
		for (const field of opts.unique?.[resource] ?? []) {
			const value = doc[field];
			if (value == null || String(value).trim() === '') continue;
			const clash = (data[resource] ?? []).find(
				(row) => String(row[field]) === String(value) && String(row._id) !== String(except_id ?? ''),
			);
			if (clash) throw new Error(`Ya existe un registro con el campo ${field} "${String(value)}".`);
		}
	};
	return {
		data,
		writes: [] as Array<{ resource: string; id: string; patch: Row }>,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		resource_for_model(model: string) {
			if (model === 'CitizenReport') return 'citizen-report';
			if (model === 'Departments') return 'departments';
			return null;
		},
		field_refs(resource: string) {
			if (resource === 'citizen-report') return { department: 'Departments' };
			return {};
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async *scan(resource: string, scan_opts: { where?: Record<string, unknown> } = {}) {
			if (opts.fail_scan_resources?.includes(resource)) {
				throw new Error(`relation "${resource}" does not exist`);
			}
			yield (data[resource] ?? []).filter((row) => matches(row, scan_opts.where));
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async insert(resource: string, doc: Row) {
			assert_unique(resource, doc);
			const row = { ...doc, _id: doc._id ?? `id-${crypto.randomUUID()}` };
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			if (opts.fail_update_ids?.includes(String(id))) {
				throw new Error(`${id}: referencia inválida`);
			}
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			assert_unique(resource, { ...rows[index], ...patch }, id);
			rows[index] = { ...rows[index], ...patch };
			this.writes.push({ resource, id: String(id), patch });
			return rows[index];
		},
	};
}

const DEPT_A = '69af40c25059cf0bfda2ca90';
const DEPT_B = '69af40c25059cf0bfda2ca91';

/** Config global `[custom]-[sequence;ceros=3]` con own_count por departamento. */
function department_pattern_seed(): Record<string, Row[]> {
	return {
		'auto-increment-control': [
			{
				_id: 'inc-name',
				model_name: 'CitizenReport',
				collection: 'citizen-report',
				increment_field: 'name',
				index_name: 'citizen_report_name',
				type: 'custom',
				custom_pattern: '[custom]-[sequence;ceros=3]',
				ref_value: null,
				is_active: true,
				current_sequence: 9,
			},
		],
		'custom-pattern-increment-sequence-parts': [
			{ _id: 'part-custom', counter_config_id: 'inc-name', token_type: 'custom', order: 0, is_active: true },
			{ _id: 'part-lit', counter_config_id: 'inc-name', token_type: 'literal', token_value: '-', order: 1, is_active: true },
			{ _id: 'part-seq', counter_config_id: 'inc-name', token_type: 'sequence', zero_padding: 3, order: 2, is_active: true },
		],
		'custom-pattern-condition': [
			{ _id: 'cond-a', part_id: 'part-custom', field_path: 'department', expected_value: DEPT_A, return_value: 'OBR', own_count: true, is_default_value: false, is_active: true },
			{ _id: 'cond-b', part_id: 'part-custom', field_path: 'department', expected_value: DEPT_B, return_value: 'ALC', own_count: true, is_default_value: false, is_active: true },
		],
		departments: [
			{ _id: DEPT_A, name: 'Obras' },
			{ _id: DEPT_B, name: 'Alcantarillado' },
		],
		'citizen-report': [
			{ _id: 'r1', department: DEPT_A, name: 'OBR-009', createdAt: '2026-01-01T00:00:00.000Z' },
			{ _id: 'r2', department: DEPT_A, name: 'OBR-010', createdAt: '2026-01-02T00:00:00.000Z' },
			{ _id: 'r3', department: DEPT_B, name: 'ALC-003', createdAt: '2026-01-03T00:00:00.000Z' },
		],
	};
}

const OBR_UNIQUE = 'citizen-report::CitizenReport::name::citizen_report_name::"OBR"';

/** Fila de segmento OBR con el `ref_value` en la forma que se quiera probar. */
function obr_segment_row(overrides: Row): Row {
	return {
		_id: 'seg-obr',
		model_name: 'CitizenReport',
		collection: 'citizen-report',
		increment_field: 'name',
		index_name: 'citizen_report_name',
		type: 'custom',
		custom_pattern: '[custom]-[sequence;ceros=3]',
		is_active: true,
		current_sequence: 2,
		_unique_string_reference: OBR_UNIQUE,
		...overrides,
	};
}

const citizen_report_counters: Row[] = [
	{
		_id: 'inc-seq',
		model_name: 'CitizenReport',
		increment_field: 'sequence',
		index_name: 'citizen_report_sequence',
		type: 'numeric',
		ref_value: null,
		is_active: true,
		current_sequence: 0,
	},
	{
		_id: 'inc-name',
		model_name: 'CitizenReport',
		increment_field: 'name',
		index_name: 'citizen_report_name',
		type: 'custom',
		custom_pattern: 'CR-[field=sequence]',
		ref_value: null,
		is_active: true,
		current_sequence: 0,
	},
];

function reports_with_empty_folios(): Row[] {
	return [
		{ _id: 'r1', sequence: 7, name: '', createdAt: '2026-01-01T00:00:00.000Z' },
		{ _id: 'r2', sequence: 8, name: null, createdAt: '2026-01-02T00:00:00.000Z' },
		{ _id: 'r3', sequence: 9, name: 'CR-9', createdAt: '2026-01-03T00:00:00.000Z' },
		{ _id: 'r4', sequence: 10, name: 'CR-0', createdAt: '2026-01-04T00:00:00.000Z' },
	];
}

describe('normalize_all_counters', () => {
	test('normal mode fills empty name from CR-[field=sequence] using the document sequence', async () => {
		const store = memory_store({
			'auto-increment-control': citizen_report_counters,
			'citizen-report': reports_with_empty_folios(),
		});
		const summary = await normalize_all_counters(store as never, { force: false });
		const name_index = summary.results.find((row) => row.increment_field === 'name');
		expect(name_index).toBeDefined();
		expect(name_index!.scanned_documents).toBeGreaterThanOrEqual(4);
		const by_id = Object.fromEntries(
			store.data['citizen-report'].map((row) => [String(row._id), row]),
		);
		expect(by_id.r1.name).toBe('CR-7');
		expect(by_id.r2.name).toBe('CR-8');
		expect(by_id.r3.name).toBe('CR-9');
		expect(by_id.r4.name).toBe('CR-10');
		expect(summary.updated_documents).toBeGreaterThan(0);
	});

	test('force mode rewrites empty folios instead of skipping them', async () => {
		const store = memory_store({
			'auto-increment-control': citizen_report_counters,
			'citizen-report': reports_with_empty_folios(),
		});
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.forced).toBe(true);
		const name_index = summary.results.find((row) => row.increment_field === 'name');
		expect(name_index).toBeDefined();
		expect(name_index!.scanned_documents).toBeGreaterThanOrEqual(4);
		expect(name_index!.updated_documents).toBeGreaterThan(0);
		for (const row of store.data['citizen-report']) {
			const sequence = Number(row.sequence);
			expect(Number.isFinite(sequence) && sequence > 0).toBe(true);
			expect(row.name).toBe(`CR-${sequence}`);
		}
	});

	test('force mode renumbers independently per own_count department segment', async () => {
		const dept_a = '69af40c25059cf0bfda2ca90';
		const dept_b = '69af40c25059cf0bfda2ca91';
		const store = memory_store({
			'auto-increment-control': [
				{
					_id: 'inc-name',
					model_name: 'CitizenReport',
					increment_field: 'name',
					index_name: 'citizen_report_name',
					type: 'custom',
					custom_pattern: '[custom]-[sequence;ceros=3]',
					ref_value: null,
					is_active: true,
					current_sequence: 9,
				},
			],
			'custom-pattern-increment-sequence-parts': [
				{
					_id: 'part-custom',
					counter_config_id: 'inc-name',
					token_type: 'custom',
					order: 0,
					is_active: true,
				},
				{
					_id: 'part-lit',
					counter_config_id: 'inc-name',
					token_type: 'literal',
					token_value: '-',
					order: 1,
					is_active: true,
				},
				{
					_id: 'part-seq',
					counter_config_id: 'inc-name',
					token_type: 'sequence',
					zero_padding: 3,
					order: 2,
					is_active: true,
				},
			],
			'custom-pattern-condition': [
				{
					_id: 'cond-a',
					part_id: 'part-custom',
					field_path: 'department',
					expected_value: dept_a,
					return_value: 'OBR',
					own_count: true,
					is_default_value: false,
					is_active: true,
				},
				{
					_id: 'cond-b',
					part_id: 'part-custom',
					field_path: 'department',
					expected_value: dept_b,
					return_value: 'ALC',
					own_count: true,
					is_default_value: false,
					is_active: true,
				},
			],
			departments: [
				{ _id: dept_a, name: 'Obras' },
				{ _id: dept_b, name: 'Alcantarillado' },
			],
			'citizen-report': [
				{
					_id: 'r1',
					department: dept_a,
					name: 'OBR-009',
					createdAt: '2026-01-01T00:00:00.000Z',
				},
				{
					_id: 'r2',
					department: dept_a,
					name: 'OBR-010',
					createdAt: '2026-01-02T00:00:00.000Z',
				},
				{
					_id: 'r3',
					department: dept_b,
					name: 'ALC-003',
					createdAt: '2026-01-03T00:00:00.000Z',
				},
			],
		});
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.forced).toBe(true);
		const by_id = Object.fromEntries(
			store.data['citizen-report'].map((row) => [String(row._id), row]),
		);
		expect(by_id.r1.name).toBe('OBR-001');
		expect(by_id.r2.name).toBe('OBR-002');
		expect(by_id.r3.name).toBe('ALC-001');
		const obr = store.data['auto-increment-control'].find((row) => row.ref_value === 'OBR');
		const alc = store.data['auto-increment-control'].find((row) => row.ref_value === 'ALC');
		expect(Number(obr?.current_sequence)).toBe(2);
		expect(Number(alc?.current_sequence)).toBe(1);
	});

	test('force mode reuses legacy wrapped segment rows instead of duplicating them', async () => {
		const dept_a = '69af40c25059cf0bfda2ca90';
		const dept_b = '69af40c25059cf0bfda2ca91';
		const store = memory_store({
			'auto-increment-control': [
				{
					_id: 'inc-name',
					model_name: 'CitizenReport',
					increment_field: 'name',
					index_name: 'citizen_report_name',
					type: 'custom',
					custom_pattern: '[custom]-[sequence;ceros=3]',
					ref_value: null,
					is_active: true,
					current_sequence: 9,
				},
				// Fila legacy: `ref_value` envuelto como JSON-string (`"OBR"`),
				// tal como quedó en la BD v13 tras la migración desde Mongo.
				{
					_id: 'seg-obr',
					model_name: 'CitizenReport',
					increment_field: 'name',
					index_name: 'citizen_report_name',
					type: 'custom',
					custom_pattern: '[custom]-[sequence;ceros=3]',
					ref_value: '"OBR"',
					segment: '"OBR"',
					is_active: true,
					current_sequence: 2,
					_unique_string_reference:
						'citizen-report::CitizenReport::name::citizen_report_name::"OBR"',
				},
			],
			'custom-pattern-increment-sequence-parts': [
				{
					_id: 'part-custom',
					counter_config_id: 'inc-name',
					token_type: 'custom',
					order: 0,
					is_active: true,
				},
				{
					_id: 'part-lit',
					counter_config_id: 'inc-name',
					token_type: 'literal',
					token_value: '-',
					order: 1,
					is_active: true,
				},
				{
					_id: 'part-seq',
					counter_config_id: 'inc-name',
					token_type: 'sequence',
					zero_padding: 3,
					order: 2,
					is_active: true,
				},
			],
			'custom-pattern-condition': [
				{
					_id: 'cond-a',
					part_id: 'part-custom',
					field_path: 'department',
					expected_value: dept_a,
					return_value: 'OBR',
					own_count: true,
					is_default_value: false,
					is_active: true,
				},
				{
					_id: 'cond-b',
					part_id: 'part-custom',
					field_path: 'department',
					expected_value: dept_b,
					return_value: 'ALC',
					own_count: true,
					is_default_value: false,
					is_active: true,
				},
			],
			departments: [
				{ _id: dept_a, name: 'Obras' },
				{ _id: dept_b, name: 'Alcantarillado' },
			],
			'citizen-report': [
				{
					_id: 'r1',
					department: dept_a,
					name: 'OBR-009',
					createdAt: '2026-01-01T00:00:00.000Z',
				},
				{
					_id: 'r2',
					department: dept_a,
					name: 'OBR-010',
					createdAt: '2026-01-02T00:00:00.000Z',
				},
				{
					_id: 'r3',
					department: dept_b,
					name: 'ALC-003',
					createdAt: '2026-01-03T00:00:00.000Z',
				},
			],
		});
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.forced).toBe(true);
		const by_id = Object.fromEntries(
			store.data['citizen-report'].map((row) => [String(row._id), row]),
		);
		expect(by_id.r1.name).toBe('OBR-001');
		expect(by_id.r2.name).toBe('OBR-002');
		expect(by_id.r3.name).toBe('ALC-001');
		// Sin duplicados: una sola fila de segmento OBR (la legacy, reutilizada).
		const obr_rows = store.data['auto-increment-control'].filter(
			(row) => row.ref_value === 'OBR' || row.ref_value === '"OBR"',
		);
		expect(obr_rows.length).toBe(1);
		expect(String(obr_rows[0]?._id)).toBe('seg-obr');
		// La fila legacy se actualiza con el conteo real y no la pisa a 0 el
		// barrido de segmentos huérfanos (que comparaba el ref envuelto).
		expect(Number(obr_rows[0]?.current_sequence)).toBe(2);
		const alc = store.data['auto-increment-control'].find((row) => row.ref_value === 'ALC');
		expect(Number(alc?.current_sequence)).toBe(1);
	});
});

describe('normalize_all_counters — segmentos con formas legacy', () => {
	const shapes: Array<[string, Row]> = [
		['doble envuelto', { ref_value: '"\\"OBR\\""', segment: '"\\"OBR\\""' }],
		['ref_value perdido (null) con unique de segmento', { ref_value: null, segment: 'OBR' }],
		['increment_field NULL en columna, solo `campo`', { increment_field: null, campo: 'name', ref_value: 'OBR' }],
	];
	for (const [label, overrides] of shapes) {
		test(`force reutiliza y repara el segmento ${label} en vez de chocar con el unique`, async () => {
			const seed = department_pattern_seed();
			seed['auto-increment-control']!.push(obr_segment_row(overrides));
			const store = memory_store(seed, { unique: { 'auto-increment-control': ['_unique_string_reference'] } });
			const summary = await normalize_all_counters(store as never, { force: true });
			expect(summary.failed_indexes).toBe(0);
			expect(summary.errors).toEqual([]);
			const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
			expect(by_id.r1.name).toBe('OBR-001');
			expect(by_id.r2.name).toBe('OBR-002');
			expect(by_id.r3.name).toBe('ALC-001');
			const obr_rows = store.data['auto-increment-control'].filter(
				(row) => row._unique_string_reference === OBR_UNIQUE,
			);
			expect(obr_rows.length).toBe(1);
			expect(String(obr_rows[0]?._id)).toBe('seg-obr');
			expect(Number(obr_rows[0]?.current_sequence)).toBe(2);
			// Reparado: la clave del segmento queda plana para todos los lectores.
			expect(obr_rows[0]?.ref_value).toBe('OBR');
			expect(obr_rows[0]?.segment).toBe('OBR');
			expect(obr_rows[0]?.current_real_value).toBe('OBR-002');
		});
	}

	test('force alinea filas duplicadas del mismo segmento y pone en 0 los huérfanos', async () => {
		const seed = department_pattern_seed();
		seed['auto-increment-control']!.push(
			obr_segment_row({ ref_value: 'OBR' }),
			// Duplicado creado con el ref envuelto (otro unique): debe quedar en el mismo conteo.
			obr_segment_row({
				_id: 'seg-obr-dup',
				ref_value: '"OBR"',
				current_sequence: 7,
				_unique_string_reference: 'citizen-report::CitizenReport::name::citizen_report_name::"\\"OBR\\""',
			}),
			// Segmento sin documentos: vuelve a 0.
			obr_segment_row({
				_id: 'seg-zzz',
				ref_value: 'ZZZ',
				current_sequence: 4,
				_unique_string_reference: 'citizen-report::CitizenReport::name::citizen_report_name::"ZZZ"',
			}),
		);
		const store = memory_store(seed);
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.errors).toEqual([]);
		const rows = Object.fromEntries(store.data['auto-increment-control'].map((row) => [String(row._id), row]));
		expect(Number(rows['seg-obr']?.current_sequence)).toBe(2);
		expect(Number(rows['seg-obr-dup']?.current_sequence)).toBe(2);
		expect(Number(rows['seg-zzz']?.current_sequence)).toBe(0);
	});
});

describe('normalize_all_counters — la corrida nunca se detiene', () => {
	test('modo normal: un documento cuyo update falla queda como fallido y el resto se normaliza', async () => {
		const store = memory_store(
			{
				'auto-increment-control': citizen_report_counters,
				'citizen-report': reports_with_empty_folios(),
			},
			{ fail_update_ids: ['r1'] },
		);
		const summary = await normalize_all_counters(store as never, { force: false });
		const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
		expect(by_id.r1.name).toBe('');
		expect(by_id.r2.name).toBe('CR-8');
		expect(by_id.r4.name).toBe('CR-10');
		expect(summary.unresolved_documents).toBe(0);
		expect(summary.failed_documents).toBe(1);
		expect(summary.failed_indexes).toBe(0);
		expect(summary.errors.some((line) => line.includes('r1'))).toBe(true);
	});

	test('force: el documento cuya escritura falla conserva su folio y el tracker no baja de su secuencia', async () => {
		const seed = department_pattern_seed();
		seed['citizen-report'] = [
			{ _id: 'r1', department: DEPT_A, name: 'OBR-005', borough: 'Centro', createdAt: '2026-01-01T00:00:00.000Z' },
			{ _id: 'r2', department: DEPT_A, name: 'OBR-010', createdAt: '2026-01-02T00:00:00.000Z' },
			{ _id: 'r3', department: DEPT_A, name: 'OBR-011', createdAt: '2026-01-03T00:00:00.000Z' },
		];
		const store = memory_store(seed, { fail_update_ids: ['r1'] });
		const summary = await normalize_all_counters(store as never, { force: true });
		const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
		expect(by_id.r1.name).toBe('OBR-005');
		expect(by_id.r2.name).toBe('OBR-002');
		expect(by_id.r3.name).toBe('OBR-003');
		expect(summary.failed_documents).toBe(1);
		// Sin piso, la siguiente alta sería OBR-004 y luego OBR-005 (duplicado de r1).
		const obr = store.data['auto-increment-control'].find((row) => row.ref_value === 'OBR');
		expect(Number(obr?.current_sequence)).toBe(5);
	});
});

describe('normalize_all_counters — [custom] sin valor', () => {
	test('force deja intacto el documento sin condición y no pisa el contador global', async () => {
		const seed = department_pattern_seed();
		const dept_x = '69af40c25059cf0bfda2ca99';
		seed['citizen-report'] = [
			{ _id: 'r1', department: dept_x, name: 'OBR-004', createdAt: '2026-01-01T00:00:00.000Z' },
			{ _id: 'r2', department: DEPT_A, name: 'OBR-010', createdAt: '2026-01-02T00:00:00.000Z' },
		];
		const store = memory_store(seed);
		const summary = await normalize_all_counters(store as never, { force: true });
		const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
		expect(by_id.r1.name).toBe('OBR-004');
		expect(by_id.r2.name).toBe('OBR-001');
		expect(summary.unresolved_documents).toBe(1);
		expect(summary.errors.some((line) => line.includes('sin valor para [custom]'))).toBe(true);
		const global = store.data['auto-increment-control'].find((row) => row._id === 'inc-name');
		expect(Number(global?.current_sequence)).toBe(9);
		expect(store.data['auto-increment-control'].some((row) => String(row.current_real_value).startsWith('-'))).toBe(false);
	});

	test('modo normal no reescribe un folio válido a "-NNN" cuando la condición ya no existe', async () => {
		const seed = department_pattern_seed();
		seed['custom-pattern-condition'] = seed['custom-pattern-condition']!.filter((row) => row._id !== 'cond-a');
		seed['citizen-report'] = [
			{ _id: 'r1', department: DEPT_A, name: 'OBR-004', createdAt: '2026-01-01T00:00:00.000Z' },
		];
		const store = memory_store(seed);
		const summary = await normalize_all_counters(store as never, { force: false });
		expect(store.data['citizen-report'][0]?.name).toBe('OBR-004');
		expect(summary.unresolved_documents).toBe(1);
		expect(summary.updated_documents).toBe(0);
	});
});

describe('normalize_all_counters — identidad del contador', () => {
	test('dos globales para el mismo modelo+campo con distinto index_name se procesan una sola vez', async () => {
		const seed = department_pattern_seed();
		seed['auto-increment-control']!.push(
			{
				_id: 'inc-name-b',
				model_name: 'CitizenReport',
				collection: 'citizen-report',
				increment_field: 'name',
				index_name: 'name',
				type: 'custom',
				custom_pattern: 'CR-[sequence;ceros=3]',
				ref_value: null,
				is_active: true,
				current_sequence: 0,
			},
			obr_segment_row({ ref_value: 'OBR' }),
		);
		const store = memory_store(seed);
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.total_indexes).toBe(1);
		const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
		expect(by_id.r1.name).toBe('OBR-001');
		expect(by_id.r3.name).toBe('ALC-001');
		const obr = store.data['auto-increment-control'].find((row) => row._id === 'seg-obr');
		expect(Number(obr?.current_sequence)).toBe(2);
	});
});

describe('normalize_all_counters — fallos por índice y por segmento', () => {
	test('un contador cuyo modelo es inaccesible se reporta y los demás se procesan', async () => {
		const seed = department_pattern_seed();
		seed['auto-increment-control']!.push({
			_id: 'inc-dept',
			model_name: 'Departments',
			increment_field: 'name',
			index_name: 'departments_name',
			type: 'numeric',
			ref_value: null,
			is_active: true,
			current_sequence: 0,
		});
		const store = memory_store(seed, { fail_scan_resources: ['departments'] });
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.failed_indexes).toBe(1);
		expect(summary.total_indexes).toBe(2);
		expect(summary.errors.some((line) => line.startsWith('Departments.name:'))).toBe(true);
		const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
		expect(by_id.r1.name).toBe('OBR-001');
		expect(by_id.r3.name).toBe('ALC-001');
	});

	test('un insert de segmento que choca con el unique se reintenta por clave y no aborta', async () => {
		const seed = department_pattern_seed();
		// Fila que las búsquedas por modelo no ven (model_name distinto) pero cuyo unique choca.
		seed['auto-increment-control']!.push(obr_segment_row({ model_name: 'citizenreport', ref_value: 'OBR' }));
		const store = memory_store(seed, { unique: { 'auto-increment-control': ['_unique_string_reference'] } });
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.errors).toEqual([]);
		const obr_rows = store.data['auto-increment-control'].filter((row) => row._unique_string_reference === OBR_UNIQUE);
		expect(obr_rows.length).toBe(1);
		expect(Number(obr_rows[0]?.current_sequence)).toBe(2);
	});
});

describe('normalize_all_counters — renumeración con folio único', () => {
	test('force intercambia folios de documentos desordenados sin violar la unicidad', async () => {
		const seed = department_pattern_seed();
		// Cronología invertida: r1 (más viejo) tiene OBR-002 y r2 tiene OBR-001 → ciclo A↔B.
		seed['citizen-report'] = [
			{ _id: 'r1', department: DEPT_A, name: 'OBR-002', createdAt: '2026-01-01T00:00:00.000Z' },
			{ _id: 'r2', department: DEPT_A, name: 'OBR-001', createdAt: '2026-01-02T00:00:00.000Z' },
			{ _id: 'r3', department: DEPT_A, name: 'OBR-005', createdAt: '2026-01-03T00:00:00.000Z' },
		];
		const store = memory_store(seed, { unique: { 'citizen-report': ['name'] } });
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.unresolved_documents).toBe(0);
		expect(summary.errors).toEqual([]);
		const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
		expect(by_id.r1.name).toBe('OBR-001');
		expect(by_id.r2.name).toBe('OBR-002');
		expect(by_id.r3.name).toBe('OBR-003');
		// Ningún write intermedio dejó dos documentos con el mismo folio.
		expect(summary.updated_documents).toBe(3);
	});

	test('force numérico con campo único usa placeholders negativos solo para romper ciclos', async () => {
		const store = memory_store(
			{
				'auto-increment-control': [
					{ _id: 'inc-seq', model_name: 'CitizenReport', increment_field: 'sequence', index_name: 'citizen_report_sequence', type: 'numeric', ref_value: null, is_active: true, current_sequence: 0 },
				],
				'citizen-report': [
					{ _id: 'r1', sequence: 2, createdAt: '2026-01-01T00:00:00.000Z' },
					{ _id: 'r2', sequence: 1, createdAt: '2026-01-02T00:00:00.000Z' },
				],
			},
			{ unique: { 'citizen-report': ['sequence'] } },
		);
		const summary = await normalize_all_counters(store as never, { force: true });
		expect(summary.errors).toEqual([]);
		const by_id = Object.fromEntries(store.data['citizen-report'].map((row) => [String(row._id), row]));
		expect(by_id.r1.sequence).toBe(1);
		expect(by_id.r2.sequence).toBe(2);
		expect(store.writes.some((w) => Number(w.patch.sequence) < 0)).toBe(true);
		expect(Number(store.data['auto-increment-control'][0]?.current_sequence)).toBe(2);
	});
});

describe('normalize_all_counters — regex de [custom] y validación de tipo', () => {
	function suffix_seed(): Record<string, Row[]> {
		return {
			'auto-increment-control': [
				{
					_id: 'inc-name',
					model_name: 'CitizenReport',
					collection: 'citizen-report',
					increment_field: 'name',
					index_name: 'citizen_report_name',
					type: 'custom',
					// [custom] pegado a [sequence], return_value que termina en dígito.
					custom_pattern: '[custom][sequence;ceros=3]',
					ref_value: null,
					is_active: true,
					current_sequence: 0,
				},
			],
			'custom-pattern-increment-sequence-parts': [
				{ _id: 'part-custom', counter_config_id: 'inc-name', token_type: 'custom', order: 0, is_active: true },
				{ _id: 'part-seq', counter_config_id: 'inc-name', token_type: 'sequence', zero_padding: 3, order: 1, is_active: true },
			],
			'custom-pattern-condition': [
				{ _id: 'cond-a', part_id: 'part-custom', field_path: 'department', expected_value: DEPT_A, return_value: 'D1', own_count: true, is_default_value: false, is_active: true },
			],
			departments: [{ _id: DEPT_A, name: 'Depto 1' }],
			'citizen-report': [
				{ _id: 'r1', department: DEPT_A, name: 'D1005', createdAt: '2026-01-01T00:00:00.000Z' },
			],
		};
	}

	test('modo normal ancla el [custom] y no hace crecer el folio en cada corrida (D1005 se mantiene)', async () => {
		const store = memory_store(suffix_seed());
		const first = await normalize_all_counters(store as never, { force: false });
		expect(store.data['citizen-report'][0]?.name).toBe('D1005');
		expect(first.updated_documents).toBe(0);
		// Idempotente: una segunda corrida tampoco lo cambia.
		await normalize_all_counters(store as never, { force: false });
		expect(store.data['citizen-report'][0]?.name).toBe('D1005');
	});

	test('modo normal deja intacto un folio cuyo segmento (condición) ya no casa el prefijo', async () => {
		const seed = suffix_seed();
		seed['custom-pattern-condition']![0]!.expected_value = DEPT_B;
		seed.departments!.push({ _id: DEPT_B, name: 'Depto 2' });
		// El documento sigue en DEPT_A → el custom resuelve vacío → intacto.
		const store = memory_store(seed);
		const summary = await normalize_all_counters(store as never, { force: false });
		expect(store.data['citizen-report'][0]?.name).toBe('D1005');
		expect(summary.unresolved_documents).toBe(1);
	});

	test('alphanumeric no reescribe un folio con minúsculas o dígitos (dato inválido)', async () => {
		const store = memory_store({
			'auto-increment-control': [
				{ _id: 'inc-code', model_name: 'CitizenReport', increment_field: 'name', index_name: 'code', type: 'alphanumeric', ref_value: null, is_active: true, current_sequence: 0 },
			],
			'citizen-report': [
				{ _id: 'r1', name: 'AB', createdAt: '2026-01-01T00:00:00.000Z' },
				{ _id: 'r2', name: 'a1', createdAt: '2026-01-02T00:00:00.000Z' },
			],
		});
		const summary = await normalize_all_counters(store as never, { force: false });
		// 'AB' es válido y ya está normalizado; 'a1' es inválido → intacto.
		expect(store.data['citizen-report'][0]?.name).toBe('AB');
		expect(store.data['citizen-report'][1]?.name).toBe('a1');
		expect(summary.unresolved_documents).toBe(1);
	});
});

describe('unwrap_ref_value', () => {
	test('desenvuelve refs legacy guardados como JSON-string, a cualquier profundidad', () => {
		expect(unwrap_ref_value('"AGP"')).toBe('AGP');
		expect(unwrap_ref_value('"OBR"')).toBe('OBR');
		expect(unwrap_ref_value(JSON.stringify(JSON.stringify('OBR')))).toBe('OBR');
	});

	test('deja intactos los valores planos y no-string', () => {
		expect(unwrap_ref_value('AGP')).toBe('AGP');
		expect(unwrap_ref_value('')).toBe('');
		expect(unwrap_ref_value(null)).toBe('');
		expect(unwrap_ref_value('["AGP"]')).toBe('["AGP"]');
	});
});

describe('prepare_increment_create', () => {
	const base = { model_name: 'CitizenReport', increment_field: 'name', type: 'custom', custom_pattern: 'X-[seq]' };
	const store_with = (rows: Row[]) => {
		const store = memory_store({ 'auto-increment-control': rows });
		return {
			...store,
			available_mongoose_models: () => [{ model_name: 'CitizenReport', collection: 'citizen-report' }],
		};
	};

	test('rechaza una segunda global activa para el mismo modelo+campo aunque cambie index_name', async () => {
		const store = store_with([
			{ _id: 'inc-a', model_name: 'CitizenReport', increment_field: 'name', index_name: 'citizen_report_name', ref_value: null, is_active: true },
		]);
		await expect(
			prepare_increment_create(store as never, { ...base, index_name: 'otro_indice' }),
		).rejects.toThrow('Ya existe un control de auto-incremento para esa combinación.');
	});

	test('un segmento existente no bloquea crear la global de su campo', async () => {
		const store = store_with([
			{ _id: 'seg', model_name: 'CitizenReport', increment_field: 'name', index_name: 'name', ref_value: 'OBR', is_active: true },
		]);
		const created = await prepare_increment_create(store as never, { ...base });
		expect(created._unique_string_reference).toBe('citizen-report::CitizenReport::name::name::null');
	});
});

describe('is_global_ref', () => {
	test('trata como global los refs vacíos migrados envueltos', () => {
		expect(is_global_ref(null)).toBe(true);
		expect(is_global_ref('')).toBe(true);
		expect(is_global_ref('""')).toBe(true);
		expect(is_global_ref('"null"')).toBe(true);
		expect(is_global_ref('OBR')).toBe(false);
		expect(is_global_ref('"OBR"')).toBe(false);
	});
});
