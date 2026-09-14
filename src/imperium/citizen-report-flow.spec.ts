import { describe, expect, test } from 'bun:test';
import {
	advance_increment_sequence,
	assign_document_increments,
} from './custom-pattern-render.ts';
import type { ImperiumDoc } from './envelope.ts';
import {
	prepare_citizen_report_write,
	sanitize_citizen_report_evidence,
} from './citizen-report-flow.ts';

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
			if (model === 'Departments') return 'departments';
			return null;
		},
		field_refs(resource: string) {
			if (resource === 'citizen-report') return { department: 'Departments' };
			return {};
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
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async insert(resource: string, doc: Row) {
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

describe('citizen-report-flow', () => {
	test('sanitize_citizen_report_evidence drops empty slots', () => {
		expect(
			sanitize_citizen_report_evidence([
				'',
				{ _id: '' },
				null,
				'507f1f77bcf86cd799439011',
			]),
		).toEqual(['507f1f77bcf86cd799439011']);
	});

	test('prepare_citizen_report_write persists department id and sanitizes evidence', async () => {
		const store = {
			next_auto_increment: async () => 81,
			has: () => false,
		};
		const incoming = {
			citizen_name: 'QA Persistencia Uno',
			citizen_email: 'qa.persist.uno@example.com',
			department: { _id: '69af40c25059cf0bfda2ca90', name: 'Obras' },
			evidence_before_images: ['', { _id: '' }],
			images: [],
			name: '',
		};
		const out = await prepare_citizen_report_write(
			store as never,
			incoming,
			true,
		);
		expect(out.department).toBe(incoming.department._id);
		expect(out.citizen_name).toBe(incoming.citizen_name);
		expect(out.evidence_before_images).toEqual([]);
		expect(out.images).toBeUndefined();
	});

	test('own_count per department assigns independent sequences after prepare (A, A, B)', async () => {
		const dept_a = '69af40c25059cf0bfda2ca90';
		const dept_b = '69af40c25059cf0bfda2ca91';
		const store = memory_store({
			'auto-increment-control': [
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
					field_path: 'department',
					order: 0,
					is_active: true,
				},
				{
					_id: 'part-dash',
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
			'citizen-report': [],
		});
		const create = async (department: { _id: string; name: string }, citizen_name: string) => {
			const prepared = await prepare_citizen_report_write(
				store as never,
				{
					citizen_name,
					citizen_email: `${citizen_name.toLowerCase()}@example.com`,
					department,
				},
				true,
			);
			expect(prepared.department).toBe(department._id);
			const out = await assign_document_increments(
				store as never,
				'citizen-report',
				prepared,
			);
			expect(String(out.name ?? '')).not.toMatch(/\[custom\]|\[sequence/);
			return out;
		};
		const first = await create({ _id: dept_a, name: 'Obras' }, 'Ana');
		const second = await create({ _id: dept_a, name: 'Obras' }, 'Bea');
		const other = await create({ _id: dept_b, name: 'Alcantarillado' }, 'Ciro');
		expect(first.name).toBe('OBR-001');
		expect(second.name).toBe('OBR-002');
		expect(other.name).toBe('ALC-001');
	});

	test('POST create order renders a non-CR counters pattern and never leaves name blank', async () => {
		const store = memory_store({
			'auto-increment-control': [
				{
					_id: 'inc-seq',
					model_name: 'CitizenReport',
					increment_field: 'sequence',
					index_name: 'citizen_report_sequence',
					type: 'numeric',
					ref_value: null,
					is_active: true,
				},
				{
					_id: 'inc-name',
					model_name: 'CitizenReport',
					increment_field: 'name',
					index_name: 'citizen_report_name',
					type: 'custom',
					custom_pattern: 'AYTO-[sequence;ceros=3]',
					ref_value: null,
					is_active: true,
				},
			],
			'citizen-report': [],
		});
		const incoming = {
			citizen_name: 'QA Persistencia Uno',
			citizen_email: 'qa.persist.uno@example.com',
			sequence: 0,
			name: '',
		};
		const prepared = await prepare_citizen_report_write(
			store as never,
			incoming,
			true,
		);
		expect(String(prepared.name ?? '').trim()).toBe('');
		const out = await assign_document_increments(
			store as never,
			'citizen-report',
			prepared,
		);
		expect(String(out.name ?? '').trim()).toBeTruthy();
		expect(String(out.name)).not.toMatch(/^CR-/);
		expect(out.name).toBe('AYTO-001');
	});
});
