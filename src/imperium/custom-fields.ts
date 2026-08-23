/**
 * Campos personalizados: mismo contrato que
 * `get_model_custom_field_definitions` + `merge_custom_fields_into_schema_validation`.
 */
import { as_array, as_object } from './envelope.ts';
import type { StateFieldsMetadata } from './state-fields.ts';
import type { ImperiumStore } from './store.ts';

const CUSTOM_FIELD_DATA_PATH = 'custom_data';
const TYPES = new Set(['string', 'number', 'boolean', 'date', 'textarea', 'status']);

export type CustomFieldDefinition = {
	field_name: string;
	field_path: string;
	label: string;
	description?: string;
	type: string;
	required: boolean;
	enabled: boolean;
	show_in_list: boolean;
	list_order?: number;
	form_order?: number;
	placeholder?: string;
	default_value?: unknown;
	state_field_name?: string;
};

export type CustomFieldSchemaValidationMetadata = {
	fields: CustomFieldDefinition[];
	by_path: Record<string, CustomFieldDefinition>;
	has_custom_fields: boolean;
};

function text(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

function slug(value: string) {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

function number_or_undefined(value: unknown) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
}

function as_boolean(value: unknown, fallback: boolean) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (['true', '1', 'si', 'yes'].includes(normalized)) return true;
		if (['false', '0', 'no'].includes(normalized)) return false;
	}
	return fallback;
}

function field_type(value: unknown) {
	const normalized = text(value).toLowerCase();
	return TYPES.has(normalized) ? normalized : 'string';
}

function sort_fields(fields: CustomFieldDefinition[]) {
	return [...fields].sort((left, right) => {
		const left_order = left.form_order ?? Number.MAX_SAFE_INTEGER;
		const right_order = right.form_order ?? Number.MAX_SAFE_INTEGER;
		if (left_order !== right_order) return left_order - right_order;
		return left.label.localeCompare(right.label, 'es', {
			sensitivity: 'base',
			numeric: true,
		});
	});
}

export function normalize_custom_field_definition(value: unknown): CustomFieldDefinition | null {
	const rec = as_object(value);
	const field_name = slug(text(rec.field_name || rec.slug || rec.name));
	if (!field_name) return null;
	const type = field_type(rec.type);
	const enabled = as_boolean(rec.enabled, true);
	if (!enabled) return null;
	return {
		field_name,
		field_path: `${CUSTOM_FIELD_DATA_PATH}.${field_name}`,
		label: text(rec.label || rec.display_name || rec.name) || field_name,
		description: text(rec.description) || undefined,
		type,
		required: as_boolean(rec.required, false),
		enabled: true,
		show_in_list: as_boolean(rec.show_in_list, false),
		list_order: number_or_undefined(rec.list_order),
		form_order: number_or_undefined(rec.form_order),
		placeholder: text(rec.placeholder) || undefined,
		default_value: rec.default_value,
		state_field_name:
			type === 'status'
				? text(rec.state_field_name) || `${CUSTOM_FIELD_DATA_PATH}.${field_name}`
				: undefined,
	};
}

export function normalize_custom_field_definitions(value: unknown): CustomFieldDefinition[] {
	const fields_by_path = new Map<string, CustomFieldDefinition>();
	for (const item of as_array(value)) {
		const field = normalize_custom_field_definition(item);
		if (!field) continue;
		fields_by_path.set(field.field_path, field);
	}
	return sort_fields([...fields_by_path.values()]);
}

export function build_custom_field_metadata(
	fields: CustomFieldDefinition[],
): CustomFieldSchemaValidationMetadata {
	const normalized = sort_fields(fields.filter((field) => field.enabled));
	return {
		fields: normalized,
		by_path: Object.fromEntries(normalized.map((field) => [field.field_path, field])),
		has_custom_fields: normalized.length > 0,
	};
}

function property_for(field: CustomFieldDefinition) {
	const schema_type = field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string';
	return {
		title: field.label,
		type: schema_type,
		...(field.description ? { description: field.description } : {}),
		...(field.default_value !== undefined ? { default: field.default_value } : {}),
	};
}

export async function load_custom_field_definitions(
	store: ImperiumStore,
	model_id: string,
): Promise<CustomFieldDefinition[]> {
	if (!model_id || !store.has('custom-field-control')) return [];
	let module_id = '';
	if (store.has('module-management')) {
		const module_record =
			(await store.find_where('module-management', { model_id })) ??
			(await store.find_where('module-management', { module_name: model_id }));
		if (module_record && module_record.is_active !== false) {
			module_id = String(module_record._id ?? '');
		}
	}
	const where = module_id ? { module_id } : { model_id };
	const { rows } = await store.find_many('custom-field-control', {
		where,
		take: 20,
		include_inactive: false,
		populate: false,
	});
	let config = rows[0] ?? null;
	if (!config && module_id) {
		const fallback = await store.find_many('custom-field-control', {
			where: { model_id },
			take: 20,
			include_inactive: false,
			populate: false,
		});
		config = fallback.rows[0] ?? null;
	}
	if (!config) return [];
	return normalize_custom_field_definitions(config.fields);
}

export function merge_custom_state_fields(
	state_fields: StateFieldsMetadata,
	custom_fields: CustomFieldDefinition[],
): StateFieldsMetadata {
	const extras = custom_fields
		.filter((field) => field.type === 'status')
		.map((field) => ({
			field_name: field.state_field_name || field.field_path,
			enabled: true,
			read_only: false,
			values: [] as StateFieldsMetadata['fields'][number]['values'],
		}));
	if (!extras.length) return state_fields;
	const existing = new Set(state_fields.fields.map((field) => field.field_name));
	const fields = [...state_fields.fields, ...extras.filter((field) => !existing.has(field.field_name))];
	return { fields, has_state_fields: fields.length > 0 };
}

export function merge_custom_fields_into_schema<T extends Record<string, unknown>>(
	schema: T,
	custom_fields: CustomFieldDefinition[],
): T {
	const current = as_object(schema);
	const properties = as_object(current.properties);
	const existing_custom = as_object(properties[CUSTOM_FIELD_DATA_PATH]);
	const custom_properties = as_object(existing_custom.properties);
	const required = as_array(existing_custom.required)
		.map((item) => text(item))
		.filter(Boolean);
	for (const field of custom_fields) {
		custom_properties[field.field_name] = property_for(field);
		if (field.required && !required.includes(field.field_name)) {
			required.push(field.field_name);
		}
	}
	const metadata = as_object(current.metadata);
	return {
		...current,
		properties: {
			...properties,
			[CUSTOM_FIELD_DATA_PATH]: {
				...existing_custom,
				title: 'Campos personalizados',
				type: 'object',
				properties: custom_properties,
				...(required.length ? { required } : {}),
			},
		},
		metadata: {
			...metadata,
			custom_fields: build_custom_field_metadata(custom_fields),
		},
	} as T;
}
