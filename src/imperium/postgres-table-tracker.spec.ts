import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { reshape_subject_menus } from './auth.ts';
import { postgres_table_tracker_field_values } from './postgres-table-tracker-field-values.ts';
import {
	TRACKER_MENU_REF,
	TRACKER_MODEL_NAME,
	TRACKER_PATH,
	TRACKER_RESOURCE,
	build_tracker_doc,
	derive_schema_fields,
	looks_like_tracker_row_id,
	lookup_tracker,
	should_hide_tracker_menu,
	tracker_model_id_for_resource,
	type TrackerSchemaField,
} from './postgres-table-tracker.ts';
import type { ExtraCol } from './store.ts';
import type { ImperiumDoc } from './envelope.ts';

const CITIZEN_REPORT_COLUMNS: ExtraCol[] = [
	{ name: 'citizen_name', pg: 'text', crud: 'string' },
	{ name: 'citizen_phone', pg: 'text', crud: 'string' },
	{ name: 'status', pg: 'text', crud: 'string' },
	{ name: 'priority', pg: 'text', crud: 'string' },
	{ name: 'sequence', pg: 'real', crud: 'number' },
	{ name: 'parent_report_id', pg: 'text', crud: 'string' },
	{ name: 'public_submission', pg: 'boolean', crud: 'boolean' },
	{ name: 'latitude', pg: 'real', crud: 'number' },
	{ name: 'longitude', pg: 'real', crud: 'number' },
	{ name: 'borough', pg: 'text', crud: 'string' },
];

const CITIZEN_REPORT_REFS: Record<string, string> = {
	borough: 'Boroughs',
	delegado: 'Employee',
	parent_report_id: 'CitizenReport',
	citizen_report_problem: 'CitizenReportProblem',
	reporting_medium: 'CitizenReportReportingMedium',
	evidence_before_images: 'AttachmentManagement',
};

function field_by_path(fields: TrackerSchemaField[], path: string) {
	return fields.find((field) => field.path === path);
}

function memory_tracker_store(rows: ImperiumDoc[]) {
	const data = rows.map((row) => ({ ...row }));
	return {
		has(resource: string) {
			return resource === TRACKER_RESOURCE;
		},
		async find_id(resource: string, id: string) {
			if (resource !== TRACKER_RESOURCE) return null;
			return data.find((row) => String(row._id) === id) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			if (resource !== TRACKER_RESOURCE) return null;
			return (
				data.find((row) =>
					Object.entries(where).every(([key, value]) => row[key] === value),
				) ?? null
			);
		},
	};
}

describe('PostGressTableTracker catalog derivation', () => {
	test('CitizenReport schema fields include increment path, collection keys, and refs', () => {
		const fields = derive_schema_fields({
			columns: CITIZEN_REPORT_COLUMNS,
			refs: CITIZEN_REPORT_REFS,
			custom_fields: [
				{
					field_path: 'custom_data.folio_extra',
					type: 'string',
					label: 'Folio extra',
				},
			],
		});
		expect(field_by_path(fields, 'name')?.type).toBe('string');
		expect(field_by_path(fields, 'sequence')).toEqual({
			path: 'sequence',
			type: 'number',
			is_array: false,
			is_reference: false,
			source: 'schema',
		});
		expect(field_by_path(fields, 'citizen_name')?.type).toBe('string');
		expect(field_by_path(fields, 'public_submission')?.type).toBe('boolean');
		expect(field_by_path(fields, 'parent_report_id')).toMatchObject({
			path: 'parent_report_id',
			type: 'objectid',
			is_array: false,
			is_reference: true,
			ref: 'CitizenReport',
		});
		expect(field_by_path(fields, 'delegado')).toMatchObject({
			is_reference: true,
			ref: 'Employee',
			type: 'objectid',
		});
		expect(field_by_path(fields, 'custom_data.folio_extra')).toMatchObject({
			source: 'custom_field',
			label: 'Folio extra',
			is_array: false,
			is_reference: false,
		});
		const doc = build_tracker_doc({
			loc: {
				resource: 'citizen-report',
				collection: 'citizen-report',
				name: 'Reportes',
				columns: CITIZEN_REPORT_COLUMNS,
			},
			refs: CITIZEN_REPORT_REFS,
		});
		expect(doc.__model_name).toBe('CitizenReport');
		expect(doc.__collection).toBe('citizen-report');
		expect(Array.isArray(doc.__schema_fields)).toBe(true);
		expect(
			(doc.__schema_fields as TrackerSchemaField[]).some((field) => field.path === 'sequence'),
		).toBe(true);
	});

	test('tracker doc and form describe SQL columns, not mongoose flags', () => {
		const doc = build_tracker_doc({
			loc: {
				resource: 'citizen-report',
				collection: 'citizen-report',
				name: 'Reportes',
				columns: CITIZEN_REPORT_COLUMNS,
			},
			refs: CITIZEN_REPORT_REFS,
		});
		const fields = doc.__schema_fields as TrackerSchemaField[];
		expect(fields.some((field) => field.path === 'name')).toBe(true);
		expect(fields.some((field) => field.path === 'sequence')).toBe(true);
		expect(field_by_path(fields, 'citizen_name')?.type).toBe('string');
		expect(field_by_path(fields, 'citizen_name')?.is_reference).toBe(false);
		expect(field_by_path(fields, 'borough')).toMatchObject({
			is_reference: true,
			ref: 'Boroughs',
		});
		const mongoose_flags = [
			'__versionKey',
			'__discriminatorKey',
			'__bufferCommands',
			'__strictQuery',
			'__capped',
			'__strict',
			'__minimize',
			'__autoIndex',
			'__shardKey',
			'__read',
			'__validateBeforeSave',
			'__validateModifiedOnly',
			'___id',
			'__id',
			'__typeKey',
			'__timestamps',
			'__pluralization',
			'__optimisticConcurrency',
			'__v',
			'__t',
		];
		for (const flag of mongoose_flags) {
			expect(doc).not.toHaveProperty(flag);
		}
		const catalog = JSON.parse(
			readFileSync(new URL('../../catalog.json', import.meta.url), 'utf8'),
		) as {
			subjects: Array<{
				modules?: Array<{ resource?: string; columns?: Array<{ name?: string }> }>;
			}>;
		};
		const tracker_mod = catalog.subjects
			.flatMap((subject) => subject.modules ?? [])
			.find((mod) => mod.resource === TRACKER_RESOURCE);
		const col_names = (tracker_mod?.columns ?? []).map((col) => String(col.name ?? ''));
		expect(col_names).toContain('__model_name');
		expect(col_names).toContain('__schema_fields');
		for (const flag of mongoose_flags) {
			expect(col_names).not.toContain(flag);
		}
		expect(col_names).not.toContain('display_leyend');
		expect(col_names).not.toContain('field_name');
		const form_src = readFileSync(
			new URL(
				'../../../../frontend/src/app/components/configuration/postgres-table-tracker/postgres-table-tracker-form/postgres-table-tracker-form.component.ts',
				import.meta.url,
			),
			'utf8',
		);
		expect(form_src).not.toContain("control_name: '__versionKey'");
		expect(form_src).not.toContain("control_name: '__bufferCommands'");
		expect(form_src).not.toContain("control_name: '__strictQuery'");
		expect(form_src).not.toContain("control_name: '__capped'");
		expect(form_src).toContain("control_name: '__schema_fields'");
		expect(form_src).toContain('Tabla SQL');
		const field_values_src = readFileSync(
			new URL('./postgres-table-tracker-field-values.ts', import.meta.url),
			'utf8',
		);
		expect(field_values_src).not.toContain('take: 20000');
		expect(field_values_src).toContain('value_counts');
	});

	test('tracker model id keeps the required PostGressTableTracker spelling', () => {
		expect(TRACKER_MODEL_NAME).toBe('PostGressTableTracker');
		expect(tracker_model_id_for_resource(TRACKER_RESOURCE)).toBe(
			'PostGressTableTracker',
		);
		expect(tracker_model_id_for_resource('citizen-report')).toBe('CitizenReport');
	});
});

describe('PostGressTableTracker lookup', () => {
	const row: ImperiumDoc = {
		_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
		name: 'CitizenReport',
		__model_name: 'CitizenReport',
		__collection: 'citizen-report',
		__schema_fields: derive_schema_fields({
			columns: CITIZEN_REPORT_COLUMNS,
			refs: CITIZEN_REPORT_REFS,
		}),
	};

	test('CitizenReport is a model name, not a row id', () => {
		expect(looks_like_tracker_row_id('CitizenReport')).toBe(false);
		expect(looks_like_tracker_row_id('aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
		expect(looks_like_tracker_row_id('11111111-1111-4111-8111-111111111111')).toBe(
			true,
		);
	});

	test('lookup by mongoose model name and by UUID both return schema fields', async () => {
		const store = memory_tracker_store([row]);
		const by_name = await lookup_tracker(store, 'CitizenReport');
		expect(by_name?._id).toBe(row._id);
		expect(Array.isArray(by_name?.__schema_fields)).toBe(true);
		const by_id = await lookup_tracker(store, String(row._id));
		expect(by_id?._id).toBe(row._id);
	});

	test('lookup strips stored mongoose flags from the document the form binds', async () => {
		const store = memory_tracker_store([
			{
				...row,
				__versionKey: '__v',
				__bufferCommands: true,
				__strictQuery: true,
				display_leyend: 'Pendiente',
			},
		]);
		const found = await lookup_tracker(store, 'CitizenReport');
		expect(found?.__schema_fields).toBeTruthy();
		expect(found).not.toHaveProperty('__versionKey');
		expect(found).not.toHaveProperty('__bufferCommands');
		expect(found).not.toHaveProperty('display_leyend');
	});

	test('missing model name is not-found, not a UUID-only miss', async () => {
		const store = memory_tracker_store([row]);
		expect(await lookup_tracker(store, 'DoesNotExist')).toBeNull();
		expect(await lookup_tracker(store, 'bbbbbbbbbbbbbbbbbbbbbbbb')).toBeNull();
	});
});

describe('PostGressTableTracker menu visibility', () => {
	test('super admin sees PostGressTableTracker; others and Mongo tracker do not', () => {
		const sql_menu = {
			path: TRACKER_PATH,
			_ref: TRACKER_MENU_REF,
			resource: TRACKER_RESOURCE,
		};
		const mongo_menu = {
			path: '/model-tracker',
			_ref: 'model-tracker-menu-management-0',
			resource: 'model-tracker',
		};
		expect(should_hide_tracker_menu(sql_menu, true)).toBe(false);
		expect(should_hide_tracker_menu(sql_menu, false)).toBe(true);
		expect(should_hide_tracker_menu(mongo_menu, true)).toBe(true);
		expect(should_hide_tracker_menu(mongo_menu, false)).toBe(true);
	});

	test('reshape injects PostGressTableTracker for super admin even without catalog module', () => {
		const store = {
			subjects: [
				{
					slug: 'configuracion',
					name: 'Configuración',
					path: '/configuracion',
					menu_ref: 'module-management-menu-root-settings',
					technical_id: 'subject-configuracion',
					image: '',
					modules: [
						{
							resource: 'user',
							path: '/user',
							menu_ref: 'user-menu-management-0',
							name: 'Usuarios',
						},
					],
				},
			],
		};
		const rows = [
			{
				_id: 'root-cfg',
				name: 'Configuración',
				path: '',
				parent_id: null,
				_ref: 'module-management-menu-root-settings',
			},
			{
				_id: 'legacy-tracker',
				name: 'Rastreador/Catálogo de modelos Mongo',
				path: '/model-tracker',
				parent_id: 'root-cfg',
				_ref: 'model-tracker-menu-management-0',
			},
		];
		const admin = reshape_subject_menus(store, rows, new Set(), true);
		const other = reshape_subject_menus(store, rows, new Set(), false);
		const admin_tracker = admin.find(
			(m) =>
				String(m.path ?? '').replace(/\/+$/, '') === TRACKER_PATH ||
				String(m._ref ?? '') === TRACKER_MENU_REF,
		);
		expect(admin_tracker).toBeTruthy();
		expect(String(admin_tracker?.parent_id ?? '')).toBe('root-cfg');
		expect(
			admin.some(
				(m) =>
					String(m.path ?? '').replace(/\/+$/, '') ===
					'/model-tracker',
			),
		).toBe(false);
		expect(
			other.some(
				(m) =>
					String(m.path ?? '').replace(/\/+$/, '') === TRACKER_PATH ||
					String(m._ref ?? '') === TRACKER_MENU_REF,
			),
		).toBe(false);
		expect(
			other.some(
				(m) =>
					String(m.path ?? '').replace(/\/+$/, '') ===
					'/model-tracker',
			),
		).toBe(false);
	});

	test('super admin menus attach tracker as child of live Configuración root', () => {
		const config_id = '6a6a69999c323a0625de5c28';
		const store = {
			subjects: [
				{
					slug: 'configuracion',
					name: 'Configuración',
					path: '/configuracion',
					menu_ref: 'module-management-menu-root-settings',
					technical_id: 'subject-configuracion',
					image: '',
					modules: [
						{
							resource: 'user',
							path: '/user',
							menu_ref: 'user-menu-management-0',
							name: 'Usuarios',
						},
						{
							resource: TRACKER_RESOURCE,
							path: TRACKER_PATH,
							menu_ref: TRACKER_MENU_REF,
							name: 'Rastreador/Catálogo de tablas SQL',
						},
					],
				},
			],
		};
		const rows = [
			{
				_id: config_id,
				name: 'Configuración',
				path: '',
				parent_id: null,
				_ref: 'module-management-menu-root-settings',
			},
			{
				_id: '6a6a69999c323a0625de5c22',
				name: 'Rastreador/Catálogo de modelos Mongo',
				path: '/model-tracker',
				parent_id: config_id,
				_ref: 'model-tracker-menu-management-0',
			},
		];
		const admin = reshape_subject_menus(store, rows, new Set(), true);
		const tracker = admin.find(
			(m) =>
				String(m.path ?? '').replace(/\/+$/, '') === TRACKER_PATH ||
				String(m._ref ?? '') === TRACKER_MENU_REF,
		);
		expect(tracker).toBeTruthy();
		expect(String(tracker?.parent_id ?? '')).toBe(config_id);
		expect(
			admin.some(
				(m) =>
					String(m.path ?? '').replace(/\/+$/, '') === '/model-tracker',
			),
		).toBe(false);
	});

	test('reshape reparents an orphan SQL tracker under the Configuración root', () => {
		const config_id = '6a6a69999c323a0625de5c28';
		const store = {
			subjects: [
				{
					slug: 'configuracion',
					name: 'Configuración',
					path: '/configuracion',
					menu_ref: 'module-management-menu-root-settings',
					technical_id: 'subject-configuracion',
					image: '',
					modules: [
						{
							resource: 'user',
							path: '/user',
							menu_ref: 'user-menu-management-0',
							name: 'Usuarios',
						},
					],
				},
			],
		};
		const rows = [
			{
				_id: config_id,
				name: 'Configuración',
				path: '',
				parent_id: null,
				_ref: 'module-management-menu-root-settings',
			},
			{
				_id: 'orphan-sql-tracker',
				name: 'Rastreador/Catálogo de tablas SQL',
				path: TRACKER_PATH,
				parent_id: null,
				_ref: TRACKER_MENU_REF,
			},
		];
		const admin = reshape_subject_menus(store, rows, new Set(), true);
		const tracker = admin.find(
			(m) => String(m._ref ?? '') === TRACKER_MENU_REF,
		);
		expect(tracker).toBeTruthy();
		expect(String(tracker?.parent_id ?? '')).toBe(config_id);
	});

	test('reshape_subject_menus attaches PostGressTableTracker only for super admin', () => {
		const store = {
			subjects: [
				{
					slug: 'configuracion',
					name: 'Configuración',
					path: '/configuracion',
					menu_ref: 'configuracion-menu-root',
					technical_id: 'subject-configuracion',
					image: '',
					modules: [
						{
							resource: TRACKER_RESOURCE,
							path: TRACKER_PATH,
							menu_ref: TRACKER_MENU_REF,
							name: 'Rastreador/Catálogo de tablas SQL',
						},
					],
				},
			],
		};
		const rows = [
			{
				_id: 'root-cfg',
				name: 'Configuración',
				path: '/configuracion',
				parent_id: null,
				_ref: 'configuracion-menu-root',
			},
		];
		const admin = reshape_subject_menus(store, rows, new Set(), true);
		const other = reshape_subject_menus(store, rows, new Set(), false);
		expect(
			admin.some(
				(m) => String(m.path ?? '').replace(/\/+$/, '') === TRACKER_PATH,
			),
		).toBe(true);
		expect(
			other.some(
				(m) => String(m.path ?? '').replace(/\/+$/, '') === TRACKER_PATH,
			),
		).toBe(false);
	});
});

describe('PostGressTableTracker field-values (shipped path)', () => {
	test('returns { value, label, count, is_reference } via value_counts, never take 20000', async () => {
		const tracker: ImperiumDoc = {
			_id: 'tracker-citizen',
			__model_name: 'CitizenReport',
			__schema_fields: derive_schema_fields({
				columns: CITIZEN_REPORT_COLUMNS,
				refs: CITIZEN_REPORT_REFS,
			}),
		};
		let value_counts_calls = 0;
		let scan_calls = 0;
		const store = {
			has(resource: string) {
				return resource === TRACKER_RESOURCE || resource === 'citizen-report';
			},
			resource_for_model(model: string) {
				return model === 'CitizenReport' ? 'citizen-report' : null;
			},
			field_refs() {
				return CITIZEN_REPORT_REFS;
			},
			async find_id() {
				return null;
			},
			async find_where(_resource: string, where: Record<string, unknown>) {
				if (where.__model_name === 'CitizenReport') return tracker;
				return null;
			},
			async value_counts(resource: string, field: string) {
				value_counts_calls += 1;
				expect(resource).toBe('citizen-report');
				expect(field).toBe('status');
				return [
					{ value: 'open', count: 2 },
					{ value: 'closed', count: 1 },
				];
			},
			async *scan() {
				scan_calls += 1;
				yield [];
			},
		};
		const result = await postgres_table_tracker_field_values({
			store: store as never,
			params: { model_tracker_id: 'CitizenReport', field_path: 'status' },
			url: new URL('http://imperium.test/api/postgres-table-tracker/global/CitizenReport/field-values/status'),
		});
		expect(value_counts_calls).toBe(1);
		expect(scan_calls).toBe(0);
		expect(result.total_elementos).toBe(2);
		expect(result.data).toEqual([
			{ value: 'closed', label: 'closed', count: 1, is_reference: false },
			{ value: 'open', label: 'open', count: 2, is_reference: false },
		]);
	});

	test('nested/array/ref paths scan a projection, not take 20000', async () => {
		const src = readFileSync(
			new URL('./postgres-table-tracker-field-values.ts', import.meta.url),
			'utf8',
		);
		expect(src).toContain('value_counts');
		expect(src).toContain('fields: [field_path]');
		expect(src).toContain('populate_lite: true');
		expect(src).toContain('store.scan(');
		expect(src).not.toContain('take: 20000');
		expect(src).toContain('lookup_tracker');
	});
});

describe('v13 surface no longer serves model-tracker', () => {
	test('extras, auth, crud and actions retarget PostGressTableTracker', () => {
		const extras = readFileSync(new URL('./extra-routes.json', import.meta.url), 'utf8');
		const auth = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
		const crud = readFileSync(new URL('./crud.ts', import.meta.url), 'utf8');
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		expect(extras).toContain(`"resource": "${TRACKER_RESOURCE}"`);
		expect(extras).not.toContain('"resource": "model-tracker"');
		expect(auth).toContain(`${TRACKER_RESOURCE}:get_all_models`);
		expect(auth).toContain('should_hide_tracker_menu');
		expect(auth).not.toContain('model-tracker:get_all_models');
		expect(crud).toContain('lookup_tracker');
		expect(crud).toContain('is_postgres_table_tracker_resource');
		expect(actions).toContain(`${TRACKER_RESOURCE}:get_all_models`);
		expect(actions).toContain('postgres_table_tracker_field_values');
		expect(actions).not.toContain('model-tracker:get_all_models');
		const catalog = readFileSync(new URL('../../catalog.json', import.meta.url), 'utf8');
		expect(catalog).toContain('"resource": "postgres-table-tracker"');
		expect(catalog).not.toContain('"resource": "model-tracker"');
	});

	test('view-list create and edit field-values call PostGressTableTrackerService', () => {
		const src = readFileSync(
			new URL(
				'../../../../frontend/src/app/components/ux/views/view-list/view-list.component.ts',
				import.meta.url,
			),
			'utf8',
		);
		expect(src).toContain('PostGressTableTrackerService');
		expect(src).toContain('this.postgres_table_tracker_service');
		expect(src).toContain(
			'this.postgres_table_tracker_service\n            .read_field_values_for_model',
		);
		expect(src).toContain(
			'await this.postgres_table_tracker_service\n                .read_field_values_for_model',
		);
		expect(src).not.toContain('this.model_tracker_service');
		expect(src).not.toContain('ModelTrackerService');
	});
});
