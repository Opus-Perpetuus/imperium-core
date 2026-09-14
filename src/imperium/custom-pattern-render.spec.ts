import { describe, expect, test } from 'bun:test';
import {
	advance_increment_sequence,
	assign_document_increments,
	compute_reset_key,
	date_token_value,
	find_increment_control,
	find_or_create_increment_segment,
	format_increment_real_value,
	increment_control_record,
	preview_increment_value,
	resolve_custom_values,
} from './custom-pattern-render.ts';
import {
	after_pattern_part_write,
	rebuild_custom_pattern,
} from './pattern-parts-flow.ts';
import type { ImperiumDoc } from './envelope.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => row[key] === value);
	};
	const store = {
		data,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		resource_for_model(model: string) {
			if (model === 'CitizenReport') return 'citizen-report';
			if (model === 'DemoDoc') return 'demo-doc';
			if (model === 'Departments') return 'departments';
			return null;
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async next_auto_increment(
			model: string,
			field: string,
			opts: { context?: Record<string, unknown>; resource?: string } = {},
		) {
			return advance_increment_sequence(store as never, model, field, opts);
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		field_refs(resource: string) {
			if (resource === 'citizen-report') return { department: 'Departments' };
			return {};
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async insert(resource: string, doc: Row) {
			const unique = doc._unique_string_reference;
			if (
				resource === 'auto-increment-control' &&
				unique &&
				(data[resource] ?? []).some((row) => row._unique_string_reference === unique)
			) {
				throw new Error(`Ya existe un registro con el campo _unique_string_reference "${String(unique)}".`);
			}
			const row = { ...doc, _id: doc._id ?? `id-${crypto.randomUUID()}` };
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch };
			return rows[index];
		},
	};
	return store;
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

describe('assign_document_increments', () => {
	test('create with empty folio controls assigns CR-{sequence} from the shared pattern', async () => {
		const cases: Array<{ label: string; doc: Row }> = [
			{ label: 'sequence 0 and empty name', doc: { citizen_name: 'Ana', sequence: 0, name: '' } },
			{ label: 'sequence 0, name omitted', doc: { citizen_name: 'Ana', sequence: 0 } },
			{ label: 'name empty string', doc: { citizen_name: 'Ana', name: '' } },
			{ label: 'both omitted', doc: { citizen_name: 'Ana' } },
		];
		for (const incoming of cases) {
			const store = memory_store({
				'auto-increment-control': citizen_report_counters,
				'citizen-report': [],
			});
			const out = await assign_document_increments(
				store as never,
				'citizen-report',
				incoming.doc,
			);
			const sequence = Number(out.sequence);
			expect(Number.isFinite(sequence) && sequence > 0).toBe(true);
			expect(out.name).toBe(`CR-${sequence}`);
		}
	});

	test('a second create in the same store gets a later distinct folio', async () => {
		const store = memory_store({
			'auto-increment-control': citizen_report_counters,
			'citizen-report': [],
		});
		const first = await assign_document_increments(store as never, 'citizen-report', {
			citizen_name: 'Uno',
			sequence: 0,
			name: '',
		});
		const second = await assign_document_increments(store as never, 'citizen-report', {
			citizen_name: 'Dos',
			sequence: 0,
			name: '',
		});
		expect(Number(second.sequence)).toBeGreaterThan(Number(first.sequence));
		expect(String(second.name)).not.toBe(String(first.name));
		expect(first.name).toBe(`CR-${first.sequence}`);
		expect(second.name).toBe(`CR-${second.sequence}`);
	});
});

const user_token_parts: Row[] = [
	{
		_id: 'part-lit-pre',
		counter_config_id: 'inc-folio',
		token_type: 'literal',
		token_value: 'PRE-',
		order: 0,
		is_active: true,
	},
	{
		_id: 'part-yyyy',
		counter_config_id: 'inc-folio',
		token_type: 'yyyy',
		order: 1,
		is_active: true,
	},
	{
		_id: 'part-dash-1',
		counter_config_id: 'inc-folio',
		token_type: 'literal',
		token_value: '-',
		order: 2,
		is_active: true,
	},
	{
		_id: 'part-seq',
		counter_config_id: 'inc-folio',
		token_type: 'sequence',
		zero_padding: 4,
		format_mode: 'default',
		order: 3,
		is_active: true,
	},
	{
		_id: 'part-dash-2',
		counter_config_id: 'inc-folio',
		token_type: 'literal',
		token_value: '-',
		order: 4,
		is_active: true,
	},
	{
		_id: 'part-field',
		counter_config_id: 'inc-folio',
		token_type: 'field',
		field_path: 'dept',
		order: 5,
		is_active: true,
	},
	{
		_id: 'part-dash-3',
		counter_config_id: 'inc-folio',
		token_type: 'literal',
		token_value: '-',
		order: 6,
		is_active: true,
	},
	{
		_id: 'part-custom',
		counter_config_id: 'inc-folio',
		token_type: 'custom',
		order: 7,
		is_active: true,
	},
	{
		_id: 'part-inactive',
		counter_config_id: 'inc-folio',
		token_type: 'literal',
		token_value: 'XXX',
		order: 8,
		is_active: false,
	},
];

function user_token_store() {
	return memory_store({
		'auto-increment-control': [
			{
				_id: 'inc-folio',
				model_name: 'DemoDoc',
				increment_field: 'folio',
				index_name: 'demo_folio',
				type: 'custom',
				custom_pattern: 'STALE',
				ref_value: null,
				is_active: true,
				current_sequence: 0,
			},
		],
		'custom-pattern-increment-sequence-parts': user_token_parts,
		'custom-pattern-condition': [
			{
				_id: 'cond-match',
				part_id: 'part-custom',
				field_path: 'region',
				expected_value: 'norte',
				return_value: 'NORTE',
				is_default_value: false,
				is_active: true,
			},
			{
				_id: 'cond-default',
				part_id: 'part-custom',
				return_value: 'DEF',
				is_default_value: true,
				is_active: true,
			},
		],
		'demo-doc': [],
	});
}

describe('user-specified custom counter tokens', () => {
	test('write-path rebuild joins user token strings in order, ignoring inactive parts', async () => {
		const store = user_token_store();
		await after_pattern_part_write(store as never, user_token_parts[7]!);
		const control = store.data['auto-increment-control'][0];
		expect(control.custom_pattern).toBe(
			'PRE-[yyyy]-[sequence;ceros=4]-[field=dept]-[custom]',
		);
		expect(String(control.custom_pattern)).not.toContain('XXX');
		expect(String(control.custom_pattern)).not.toBe('STALE');
	});

	test('assign expands the rebuilt pattern instead of leaving raw brackets', async () => {
		const store = user_token_store();
		await after_pattern_part_write(store as never, user_token_parts[7]!);
		const out = await assign_document_increments(store as never, 'demo-doc', {
			dept: 'HR',
			region: 'norte',
			folio: '',
		});
		const year = date_token_value('yyyy');
		expect(out.folio).toBe(`PRE-${year}-0001-HR-NORTE`);
		expect(String(out.folio)).not.toContain('[yyyy]');
		expect(String(out.folio)).not.toContain('[sequence');
		expect(String(out.folio)).not.toContain('[field=');
		expect(String(out.folio)).not.toContain('[custom]');
	});

	test('sequence letra and romano rebuild to pre-v13 spellings', async () => {
		const store = memory_store({
			'auto-increment-control': [
				{
					_id: 'inc-fmt',
					model_name: 'DemoDoc',
					increment_field: 'code',
					type: 'custom',
					custom_pattern: '',
					ref_value: null,
					is_active: true,
				},
			],
			'custom-pattern-increment-sequence-parts': [
				{
					_id: 'p-letra',
					counter_config_id: 'inc-fmt',
					token_type: 'sequence',
					format_mode: 'letra',
					order: 0,
					is_active: true,
				},
				{
					_id: 'p-sep',
					counter_config_id: 'inc-fmt',
					token_type: 'literal',
					token_value: '-',
					order: 1,
					is_active: true,
				},
				{
					_id: 'p-romano',
					counter_config_id: 'inc-fmt',
					token_type: 'sequence',
					format_mode: 'romano',
					order: 2,
					is_active: true,
				},
			],
		});
		await rebuild_custom_pattern(store as never, 'inc-fmt');
		expect(store.data['auto-increment-control'][0]?.custom_pattern).toBe(
			'[sequence;letra=true]-[sequence;romano=true]',
		);
		const out = await assign_document_increments(store as never, 'demo-doc', {
			code: '',
		});
		expect(out.code).toBe('A-I');
		expect(String(out.code)).not.toContain('[sequence');
	});

	test('missing-parent rebuild does not invent a counter or pattern', async () => {
		const store = memory_store({
			'auto-increment-control': [],
			'custom-pattern-increment-sequence-parts': [
				{
					_id: 'orphan-part',
					counter_config_id: 'ghost',
					token_type: 'literal',
					token_value: 'NOPE',
					order: 0,
					is_active: true,
				},
			],
		});
		await rebuild_custom_pattern(store as never, 'ghost');
		expect(store.data['auto-increment-control']).toEqual([]);
	});
});

const DEPT_A = '69af40c25059cf0bfda2ca90';
const DEPT_B = '69af40c25059cf0bfda2ca91';

function department_counter_store(opts: {
	field_path: string;
	expected_a: string;
	expected_b: string;
}) {
	return memory_store({
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
				current_sequence: 0,
			},
		],
		'custom-pattern-increment-sequence-parts': [
			{
				_id: 'part-custom',
				counter_config_id: 'inc-name',
				token_type: 'custom',
				field_path: opts.field_path,
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
				format_mode: 'default',
				order: 2,
				is_active: true,
			},
		],
		'custom-pattern-condition': [
			{
				_id: 'cond-a',
				part_id: 'part-custom',
				field_path: opts.field_path,
				expected_value: opts.expected_a,
				return_value: 'OBR',
				own_count: true,
				is_default_value: false,
				is_active: true,
				modelo: 'CitizenReport',
			},
			{
				_id: 'cond-b',
				part_id: 'part-custom',
				field_path: opts.field_path,
				expected_value: opts.expected_b,
				return_value: 'ALC',
				own_count: true,
				is_default_value: false,
				is_active: true,
				modelo: 'CitizenReport',
			},
			{
				_id: 'cond-def',
				part_id: 'part-custom',
				return_value: 'GEN',
				own_count: true,
				is_default_value: true,
				is_active: true,
			},
		],
		departments: [
			{ _id: DEPT_A, name: 'Obras' },
			{ _id: DEPT_B, name: 'Alcantarillado' },
		],
		'citizen-report': [],
	});
}

describe('own_count department segments', () => {
	test('three creates A, A, B keep independent sequences and return_value in the folio', async () => {
		const store = department_counter_store({
			field_path: 'department',
			expected_a: DEPT_A,
			expected_b: DEPT_B,
		});
		const first = await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_A,
			name: '',
		});
		const second = await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_A,
			name: '',
		});
		const other = await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_B,
			name: '',
		});
		expect(first.name).toBe('OBR-001');
		expect(second.name).toBe('OBR-002');
		expect(other.name).toBe('ALC-001');
	});

	test('sanitized department id still matches expected name from field-values', async () => {
		const store = department_counter_store({
			field_path: 'department',
			expected_a: 'Obras',
			expected_b: 'Alcantarillado',
		});
		const control = await find_increment_control(store as never, 'CitizenReport', 'name');
		const custom = await resolve_custom_values(store as never, control, {
			department: DEPT_A,
		});
		expect(custom[0]?.value).toBe('OBR');
		expect(custom[0]?.is_reset_key).toBe(true);
		const out = await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_A,
			name: '',
		});
		expect(out.name).toBe('OBR-001');
	});

	test('nested department.name after sanitization hydrates the referenced department', async () => {
		const store = department_counter_store({
			field_path: 'department.name',
			expected_a: 'Obras',
			expected_b: 'Alcantarillado',
		});
		const control = await find_increment_control(store as never, 'CitizenReport', 'name');
		const reset = await compute_reset_key(store as never, control, { department: DEPT_A });
		expect(reset).toBe('OBR');
		const out = await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_A,
			name: '',
		});
		expect(out.name).toBe('OBR-001');
	});

	test('nested department._id after sanitization matches the id', async () => {
		const store = department_counter_store({
			field_path: 'department._id',
			expected_a: DEPT_A,
			expected_b: DEPT_B,
		});
		const out = await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_A,
			name: '',
		});
		expect(out.name).toBe('OBR-001');
	});

	test('default condition is the fallback when no expected value matches', async () => {
		const store = department_counter_store({
			field_path: 'department',
			expected_a: DEPT_A,
			expected_b: DEPT_B,
		});
		const out = await assign_document_increments(store as never, 'citizen-report', {
			department: 'unknown-dept',
			name: '',
		});
		expect(out.name).toBe('GEN-001');
	});

	test('preview with pattern_context renders the matching custom segment', async () => {
		const store = department_counter_store({
			field_path: 'department',
			expected_a: DEPT_A,
			expected_b: DEPT_B,
		});
		const preview = await preview_increment_value(
			store as never,
			'CitizenReport',
			'name',
			{ department: DEPT_A },
		);
		expect(preview.next_sequence).toBe(1);
		expect(preview.next_real_value).toBe('OBR-001');
	});

	test('counter token reads the pointed external tracker sequence', async () => {
		const store = memory_store({
			'auto-increment-control': [
				{
					_id: 'inc-folio',
					model_name: 'DemoDoc',
					increment_field: 'folio',
					type: 'custom',
					custom_pattern: 'X-[counter=ext;ceros=2]',
					ref_value: null,
					is_active: true,
					current_sequence: 0,
				},
				{
					_id: 'inc-ext',
					model_name: 'Other',
					increment_field: 'n',
					index_name: 'ext',
					type: 'numeric',
					ref_value: null,
					is_active: true,
					current_sequence: 7,
					current: 7,
					valor: 7,
				},
			],
			'demo-doc': [],
		});
		const out = await assign_document_increments(store as never, 'demo-doc', { folio: '' });
		expect(out.folio).toBe('X-07');
		expect(String(out.folio)).not.toContain('[counter=');
	});

	test('increment of a pointed segment advances that tracker only', async () => {
		const store = department_counter_store({
			field_path: 'department',
			expected_a: DEPT_A,
			expected_b: DEPT_B,
		});
		await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_A,
			name: '',
		});
		await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_B,
			name: '',
		});
		const obr = store.data['auto-increment-control'].find((row) => row.ref_value === 'OBR');
		expect(obr).toBeDefined();
		const result = await increment_control_record(store as never, obr!, 1);
		expect(Number(result.next)).toBe(2);
		expect(String(result.real_value)).toBe('OBR-002');
		const alc = store.data['auto-increment-control'].find((row) => row.ref_value === 'ALC');
		expect(Number(alc?.current_sequence)).toBe(1);
	});

	test('SQL-style bump without pattern_context persists the segment return_value', async () => {
		const store = department_counter_store({
			field_path: 'department',
			expected_a: DEPT_A,
			expected_b: DEPT_B,
		});
		await assign_document_increments(store as never, 'citizen-report', {
			department: DEPT_A,
			name: '',
		});
		const obr = store.data['auto-increment-control'].find((row) => row.ref_value === 'OBR');
		expect(obr).toBeDefined();
		await advance_increment_sequence(store as never, 'CitizenReport', 'name', {
			ref_value: 'OBR',
			bump: async (target, floor) => {
				const next =
					Math.max(Number(target.current_sequence ?? target.current ?? target.valor ?? 0), floor) +
					1;
				const config = await find_increment_control(store as never, 'CitizenReport', 'name');
				const broken = await format_increment_real_value(
					store as never,
					config ?? target,
					next,
				);
				expect(String(broken)).toBe('-002');
				await store.update('auto-increment-control', String(target._id), {
					current_sequence: next,
					current: next,
					valor: next,
					current_real_value: broken,
				});
				return next;
			},
		});
		const updated = store.data['auto-increment-control'].find(
			(row) => String(row._id) === String(obr?._id),
		);
		expect(String(updated?.current_real_value)).toBe('OBR-002');
		expect(String(updated?.current_real_value)).not.toContain('[custom]');
		expect(Number(updated?.current_sequence)).toBe(2);
	});
});

describe('find_or_create_increment_segment — reutilización de segmentos', () => {
	const OBR_UNIQUE = 'citizen-report::CitizenReport::name::citizen_report_name::"OBR"';
	const control: Row = {
		_id: 'inc-name',
		model_name: 'CitizenReport',
		collection: 'citizen-report',
		increment_field: 'name',
		index_name: 'citizen_report_name',
		type: 'custom',
		custom_pattern: '[custom]-[sequence;ceros=3]',
		ref_value: null,
		is_active: true,
		current_sequence: 0,
	};
	const segment = (overrides: Row): Row => ({
		...control,
		_id: 'seg-obr',
		current_sequence: 4,
		_unique_string_reference: OBR_UNIQUE,
		...overrides,
	});

	const shapes: Array<[string, Row]> = [
		['plano', { ref_value: 'OBR', segment: 'OBR' }],
		['envuelto (migrado)', { ref_value: '"OBR"', segment: '"OBR"' }],
		['doble envuelto', { ref_value: JSON.stringify(JSON.stringify('OBR')) }],
		['ref perdido con unique', { ref_value: null }],
		['increment_field NULL, solo campo', { increment_field: null, campo: 'name', ref_value: 'OBR' }],
	];
	for (const [label, overrides] of shapes) {
		test(`reutiliza el segmento ${label} sin insertar otra fila y deja el ref plano`, async () => {
			const store = memory_store({ 'auto-increment-control': [control, segment(overrides)] });
			const target = await find_or_create_increment_segment(store as never, control, 'OBR');
			expect(String(target._id)).toBe('seg-obr');
			expect(store.data['auto-increment-control'].length).toBe(2);
			const row = store.data['auto-increment-control'].find((r) => r._id === 'seg-obr')!;
			expect(row.ref_value).toBe('OBR');
			expect(row.segment).toBe('OBR');
			expect(Number(row.current_sequence)).toBe(4);
		});
	}

	test('si el insert choca con el unique, reintenta por clave y devuelve la fila existente', async () => {
		// model_name distinto: ninguna búsqueda por modelo la ve, pero el unique es el mismo.
		const store = memory_store({
			'auto-increment-control': [control, segment({ model_name: 'citizenreport', ref_value: 'OBR' })],
		});
		const target = await find_or_create_increment_segment(store as never, control, 'OBR');
		expect(String(target._id)).toBe('seg-obr');
		expect(store.data['auto-increment-control'].length).toBe(2);
	});

	test('el "+1" de la UI sobre una fila envuelta avanza ese mismo segmento (no duplica)', async () => {
		const store = memory_store({
			'auto-increment-control': [control, segment({ ref_value: '"OBR"', segment: '"OBR"' })],
		});
		const pointed = store.data['auto-increment-control'].find((r) => r._id === 'seg-obr')!;
		const result = await increment_control_record(store as never, pointed, 1);
		expect(result.next).toBe(5);
		expect(result.real_value).toBe('OBR-005');
		expect(store.data['auto-increment-control'].length).toBe(2);
		expect(store.data['auto-increment-control'].find((r) => r._id === 'seg-obr')?.ref_value).toBe('OBR');
	});
});

describe('find_increment_control', () => {
	test('un segmento nunca actúa como configuración cuando la global está desactivada', async () => {
		const store = memory_store({
			'auto-increment-control': [
				{ _id: 'inc-name', model_name: 'CitizenReport', increment_field: 'name', type: 'custom', custom_pattern: '[custom]-[sequence;ceros=3]', ref_value: null, is_active: false },
				{ _id: 'seg-obr', model_name: 'CitizenReport', increment_field: 'name', type: 'custom', custom_pattern: '[custom]-[sequence;ceros=3]', ref_value: 'OBR', is_active: true, current_sequence: 2 },
			],
		});
		const control = await find_increment_control(store as never, 'CitizenReport', 'name');
		expect(String(control?._id)).toBe('inc-name');
		const only_segment = memory_store({
			'auto-increment-control': [
				{ _id: 'seg-obr', model_name: 'CitizenReport', increment_field: 'name', type: 'custom', ref_value: 'OBR', is_active: true },
			],
		});
		expect(await find_increment_control(only_segment as never, 'CitizenReport', 'name')).toBeNull();
	});
});
