/**
 * Catálogo SQL de tablas (PostGressTableTracker).
 * Sustituye al model-tracker de Mongoose: `__schema_fields` se deriva de
 * columnas + refs + custom fields, y el detalle acepta UUID o `__model_name`.
 */
import {
	normalize_custom_field_definitions,
	type CustomFieldDefinition,
} from './custom-fields.ts';
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { model_id_for_resource } from './state-fields.ts';
import type { ExtraCol, ImperiumStore, ModuleLoc } from './store.ts';

export const TRACKER_RESOURCE = 'postgres-table-tracker';
export const TRACKER_PATH = '/postgres-table-tracker';
export const TRACKER_MENU_REF = 'postgres-table-tracker-menu-management-0';
export const TRACKER_MODEL_NAME = 'PostGressTableTracker';

const LEGACY_TRACKER_PATH = '/model-tracker';
const LEGACY_TRACKER_MENU_REF = 'model-tracker-menu-management-0';
const LEGACY_TRACKER_RESOURCE = 'model-tracker';

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONGO_ID_RE = /^[a-f0-9]{24}$/i;

const EXCLUDED_PATHS = new Set(['__v', 'search_field', 'payload', 'id']);
const BATCH_MATCH_EXCLUDED = new Set(['createdAt', 'updatedAt', 'search_field']);
const BATCH_MATCH_TYPES = new Set([
	'string',
	'number',
	'boolean',
	'objectid',
	'date',
	'decimal',
]);

const STANDARD_FIELDS: TrackerSchemaField[] = [
	{ path: '_id', type: 'string', is_array: false, is_reference: false, source: 'schema' },
	{ path: 'name', type: 'string', is_array: false, is_reference: false, source: 'schema' },
	{
		path: 'description',
		type: 'string',
		is_array: false,
		is_reference: false,
		source: 'schema',
	},
	{
		path: 'is_active',
		type: 'boolean',
		is_array: false,
		is_reference: false,
		source: 'schema',
	},
	{ path: 'createdAt', type: 'date', is_array: false, is_reference: false, source: 'schema' },
	{ path: 'updatedAt', type: 'date', is_array: false, is_reference: false, source: 'schema' },
];

export type TrackerSchemaField = {
	path: string;
	type: string;
	is_array: boolean;
	is_reference: boolean;
	ref?: string;
	label?: string;
	source?: 'schema' | 'custom_field';
};

export type DeriveSchemaFieldsInput = {
	columns: ExtraCol[];
	refs?: Record<string, string>;
	custom_fields?: Array<{ field_path: string; type?: string; label?: string }>;
};

export function is_postgres_table_tracker_resource(resource: string) {
	return resource === TRACKER_RESOURCE;
}

export function looks_like_tracker_row_id(id: string) {
	return UUID_RE.test(id) || MONGO_ID_RE.test(id);
}

function norm_path(value: unknown) {
	return String(value ?? '').replace(/\/+$/, '');
}

function menu_bits(row: { path?: unknown; _ref?: unknown; resource?: unknown }) {
	return {
		path: norm_path(row.path),
		ref: String(row._ref ?? ''),
		resource: String(row.resource ?? ''),
	};
}

export function is_legacy_model_tracker_menu(row: {
	path?: unknown;
	_ref?: unknown;
	resource?: unknown;
}) {
	const { path, ref, resource } = menu_bits(row);
	return (
		path === LEGACY_TRACKER_PATH ||
		ref === LEGACY_TRACKER_MENU_REF ||
		resource === LEGACY_TRACKER_RESOURCE
	);
}

export function is_postgres_table_tracker_menu(row: {
	path?: unknown;
	_ref?: unknown;
	resource?: unknown;
}) {
	const { path, ref, resource } = menu_bits(row);
	return (
		path === TRACKER_PATH ||
		ref === TRACKER_MENU_REF ||
		resource === TRACKER_RESOURCE
	);
}

/** Super admin ve el tracker SQL; el menú Mongo queda fuera para todos. */
export function should_hide_tracker_menu(
	row: { path?: unknown; _ref?: unknown; resource?: unknown },
	has_full_access: boolean,
) {
	if (is_legacy_model_tracker_menu(row)) return true;
	if (is_postgres_table_tracker_menu(row) && !has_full_access) return true;
	return false;
}

const CONFIGURACION_MENU_REFS = new Set([
	'module-management-menu-root-settings',
	'configuracion-menu-root',
]);

/**
 * El catálogo puede no traer el módulo (core arrancado con catálogo viejo)
 * y la BD puede seguir con `/model-tracker`. El super admin igual necesita
 * el ítem SQL bajo Configuración.
 */
export function ensure_super_admin_tracker_menu(
	menus: ImperiumDoc[],
	has_full_access: boolean,
): ImperiumDoc[] {
	if (!has_full_access) return menus;
	if (menus.some((row) => is_postgres_table_tracker_menu(row))) return menus;

	const root =
		menus.find((row) => CONFIGURACION_MENU_REFS.has(String(row._ref ?? ''))) ??
		menus.find(
			(row) =>
				!row.parent_id &&
				(String(row.subject_slug ?? '') === 'configuracion' ||
					String(row.name ?? '') === 'Configuración'),
		);

	menus.push({
		_id: 'subject-mod-configuracion-postgres-table-tracker',
		id: 'subject-mod-configuracion-postgres-table-tracker',
		name: 'Rastreador/Catálogo de tablas SQL',
		path: TRACKER_PATH,
		parent_id: root?._id ?? null,
		_ref: TRACKER_MENU_REF,
		icon: 'fa-circle',
		order: 10,
		is_active: true,
		model: TRACKER_MODEL_NAME,
	});
	return menus;
}

function tracker_type_from_column(col: ExtraCol, ref?: string) {
	if (ref) return 'objectid';
	const pg = String(col.pg ?? '').toLowerCase();
	const crud = String(col.crud ?? '').toLowerCase();
	if (pg === 'boolean' || crud === 'boolean') return 'boolean';
	if (
		['number', 'real', 'integer', 'int', 'int4', 'int8', 'numeric', 'double', 'float', 'decimal'].includes(
			pg,
		) ||
		crud === 'number'
	) {
		return 'number';
	}
	if (pg.includes('timestamp') || pg === 'date' || crud === 'date') return 'date';
	if (pg === 'json' || pg === 'jsonb' || crud === 'json') return 'mixed';
	return 'string';
}

function column_is_array(col: ExtraCol) {
	const component = String(col.component ?? '').toLowerCase();
	const crud = String(col.crud ?? '').toLowerCase();
	return component.includes('array') || crud === 'array';
}

function custom_field_type(type?: string) {
	const normalized = String(type ?? '').toLowerCase();
	if (normalized === 'number') return 'number';
	if (normalized === 'boolean') return 'boolean';
	if (normalized === 'date') return 'date';
	return 'string';
}

export function derive_schema_fields(input: DeriveSchemaFieldsInput): TrackerSchemaField[] {
	const fields = new Map<string, TrackerSchemaField>();
	const refs = input.refs ?? {};
	const push = (field: TrackerSchemaField) => {
		if (!field.path || EXCLUDED_PATHS.has(field.path) || fields.has(field.path)) return;
		fields.set(field.path, field);
	};
	for (const field of STANDARD_FIELDS) push({ ...field });
	for (const col of input.columns) {
		const path = String(col.name ?? '').trim();
		if (!path) continue;
		const ref = refs[path] || undefined;
		push({
			path,
			type: tracker_type_from_column(col, ref),
			is_array: column_is_array(col),
			is_reference: Boolean(ref),
			...(ref ? { ref } : {}),
			source: 'schema',
		});
	}
	for (const [path, ref] of Object.entries(refs)) {
		if (!path || !ref) continue;
		push({
			path,
			type: 'objectid',
			is_array: path.includes('.'),
			is_reference: true,
			ref,
			source: 'schema',
		});
	}
	for (const custom of input.custom_fields ?? []) {
		const path = String(custom.field_path ?? '').trim();
		if (!path) continue;
		push({
			path,
			type: custom_field_type(custom.type),
			is_array: false,
			is_reference: false,
			label: custom.label,
			source: 'custom_field',
		});
	}
	return [...fields.values()];
}

export function compute_tracker_fingerprint(
	model_name: string,
	collection: string,
	fields: TrackerSchemaField[],
) {
	const paths = fields
		.filter((field) => field.source !== 'custom_field')
		.map((field) => field.path)
		.sort()
		.join(',');
	return `${model_name}|${collection}|${paths}`;
}

export function is_batch_matchable_field(field: TrackerSchemaField) {
	if (field.is_array) return false;
	if (BATCH_MATCH_EXCLUDED.has(field.path)) return false;
	return BATCH_MATCH_TYPES.has(field.type);
}

export function tracker_model_id_for_resource(resource: string) {
	if (resource === TRACKER_RESOURCE) return TRACKER_MODEL_NAME;
	return model_id_for_resource(resource);
}

export function build_tracker_doc(input: {
	loc: Pick<ModuleLoc, 'resource' | 'collection' | 'name' | 'columns'>;
	refs?: Record<string, string>;
	custom_fields?: Array<{ field_path: string; type?: string; label?: string }>;
}): ImperiumDoc {
	const model_id = tracker_model_id_for_resource(input.loc.resource);
	const fields = derive_schema_fields({
		columns: input.loc.columns,
		refs: input.refs,
		custom_fields: input.custom_fields,
	});
	const fingerprint = compute_tracker_fingerprint(model_id, input.loc.collection, fields);
	return {
		name: model_id,
		__model_name: model_id,
		__collection: input.loc.collection,
		__use_text_search: true,
		__text_index_paths: fields
			.filter(
				(field) =>
					(field.type === 'string' || field.type === 'number') &&
					!field.is_array &&
					!field.is_reference,
			)
			.map((field) => field.path),
		__text_index_populate_options: fields
			.filter((field) => field.is_reference && field.ref)
			.map((field) => ({ path: field.path, model: field.ref })),
		__field_paths: fields.map((field) => field.path),
		__schema_fields: fields,
		__state_fields: { fields: [], has_state_fields: false },
		__batch_matchable_fields: fields
			.filter(is_batch_matchable_field)
			.map((field) => field.path),
		__use_history_recollection: true,
		__history_path_names: [],
		__ref: input.loc.resource,
		__fingerprint: fingerprint,
		is_active: true,
	};
}

const MONGOOSE_TRACKER_KEYS = new Set([
	'__strict',
	'__strictQuery',
	'__bufferCommands',
	'__capped',
	'__versionKey',
	'__optimisticConcurrency',
	'__minimize',
	'__autoIndex',
	'__discriminatorKey',
	'__shardKey',
	'__read',
	'__validateBeforeSave',
	'__validateModifiedOnly',
	'___id',
	'__id',
	'__typeKey',
	'__timestamps',
	'__pluralization',
	'__v',
	'__t',
	'path',
	'type',
	'is_array',
	'is_reference',
	'label',
	'source',
	'value',
	'display_leyend',
	'color',
	'icon',
	'field_name',
	'enabled',
	'read_only',
	'values',
	'fields',
	'has_state_fields',
]);

export function omit_mongoose_tracker_keys(doc: ImperiumDoc): ImperiumDoc {
	const out: ImperiumDoc = { ...doc };
	for (const key of MONGOOSE_TRACKER_KEYS) delete out[key];
	return out;
}

export async function lookup_tracker(
	store: Pick<ImperiumStore, 'has' | 'find_id' | 'find_where'>,
	id_or_name: string,
): Promise<ImperiumDoc | null> {
	if (!store.has(TRACKER_RESOURCE)) return null;
	const key = id_or_name.trim();
	if (!key) return null;
	if (looks_like_tracker_row_id(key)) {
		const by_id = await store.find_id(TRACKER_RESOURCE, key);
		if (by_id) return omit_mongoose_tracker_keys(by_id);
	}
	const found =
		(await store.find_where(TRACKER_RESOURCE, { __model_name: key })) ??
		(await store.find_where(TRACKER_RESOURCE, { name: key }));
	return found ? omit_mongoose_tracker_keys(found) : null;
}

async function custom_fields_by_model(
	store: ImperiumStore,
): Promise<Map<string, CustomFieldDefinition[]>> {
	const out = new Map<string, CustomFieldDefinition[]>();
	if (!store.has('custom-field-control')) return out;
	const modules = new Map<string, string>();
	if (store.has('module-management')) {
		for await (const page of store.scan('module-management', {
			include_inactive: true,
		})) {
			for (const row of page) {
				const id = String(row._id ?? '');
				const model_id = String(row.model_id ?? '').trim();
				if (id && model_id) modules.set(id, model_id);
			}
		}
	}
	for await (const page of store.scan('custom-field-control', {
		include_inactive: false,
	})) {
		for (const row of page) {
			const model_id =
				String(row.model_id ?? '').trim() ||
				modules.get(String(row.module_id ?? '')) ||
				'';
			if (!model_id) continue;
			const fields = normalize_custom_field_definitions(row.fields);
			if (fields.length) out.set(model_id, fields);
		}
	}
	return out;
}

function unique_locs(store: ImperiumStore): ModuleLoc[] {
	const seen = new Set<string>();
	const out: ModuleLoc[] = [];
	for (const loc of store.locs.values()) {
		if (seen.has(loc.resource)) continue;
		seen.add(loc.resource);
		out.push(loc);
	}
	return out;
}

export async function sync_postgres_table_tracker(store: ImperiumStore): Promise<void> {
	if (!store.has(TRACKER_RESOURCE)) return;
	const custom_by_model = await custom_fields_by_model(store);
	const existing = new Map<string, ImperiumDoc>();
	for await (const page of store.scan(TRACKER_RESOURCE, { include_inactive: true })) {
		for (const row of page) {
			const name = String(row.__model_name ?? row.name ?? '');
			if (name) existing.set(name, row);
		}
	}
	const keep = new Set<string>();
	for (const loc of unique_locs(store)) {
		const model_id = tracker_model_id_for_resource(loc.resource);
		keep.add(model_id);
		const custom = custom_by_model.get(model_id) ?? [];
		const doc = build_tracker_doc({
			loc,
			refs: store.field_refs(loc.resource),
			custom_fields: custom,
		});
		const prev = existing.get(model_id);
		if (prev && String(prev.__fingerprint ?? '') === String(doc.__fingerprint ?? '')) {
			continue;
		}
		if (prev?._id) {
			await store.update(TRACKER_RESOURCE, String(prev._id), doc);
		} else {
			await store.insert(TRACKER_RESOURCE, doc);
		}
	}
	for (const [name, row] of existing) {
		if (keep.has(name) || !row._id) continue;
		await store.remove(TRACKER_RESOURCE, String(row._id));
	}
}

export async function ensure_postgres_table_tracker_access(store: ImperiumStore) {
	if (!store.has('access-rights')) return;
	const existing =
		(await store.find_where('access-rights', {
			_ref: 'postgres-table-tracker-access-rights-0',
		})) ??
		(await store.find_where('access-rights', { model_id: TRACKER_MODEL_NAME }));
	if (existing) return;
	await store.insert('access-rights', {
		_ref: 'postgres-table-tracker-access-rights-0',
		name: 'PostGressTableTracker | Permisos generales',
		description: 'Consulta el catálogo de tablas SQL registradas',
		model_id: TRACKER_MODEL_NAME,
		allow_read: true,
		allow_create: false,
		allow_update: false,
		allow_delete: false,
	});
}

export function schema_fields_of(tracker: ImperiumDoc | null | undefined): TrackerSchemaField[] {
	const out: TrackerSchemaField[] = [];
	for (const item of as_array(tracker?.__schema_fields)) {
		const rec = as_object(item);
		const path = String(rec.path ?? '').trim();
		if (!path) continue;
		out.push({
			path,
			type: String(rec.type ?? 'string'),
			is_array: rec.is_array === true,
			is_reference: rec.is_reference === true,
			ref: rec.ref ? String(rec.ref) : undefined,
			label: rec.label ? String(rec.label) : undefined,
			source: rec.source === 'custom_field' ? 'custom_field' : 'schema',
		});
	}
	return out;
}
