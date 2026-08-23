/**
 * Metadata de campos de estatus: mismos defaults que `__state_fields` de los
 * schemas Mongoose, mezclados con `status-option-control` y el tracker.
 * `schema_validation.required` y `attachment_fields` salen de los schemas
 * Mongoose (`jsonSchema()` / refs a AttachmentManagement).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { as_array, as_object } from './envelope.ts';
import { RESOURCE_ALIASES, type ImperiumStore } from './store.ts';

type SchemaConstraints = {
	required: Record<string, string[]>;
	attachment_fields: Record<string, string[]>;
};

const CONSTRAINTS: SchemaConstraints = JSON.parse(
	readFileSync(join(import.meta.dir, 'schema-constraints.json'), 'utf8'),
) as SchemaConstraints;

const STATUS_OPTION_CONFIGURATION_TYPE = 'status-options-by-module';
const DEFAULT_FIELD = 'state';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const TYPE_COLOR: Record<string, string> = {
	neutral: '#6c757d',
	primary: '#0d6efd',
	secondary: '#6c757d',
	info: '#0dcaf0',
	success: '#198754',
	warning: '#ffc107',
	danger: '#dc3545',
	notice: '#6f42c1',
	black: '#212529',
};

export type StateValue = {
	value: string;
	type: string;
	display_leyend: string;
	color: string;
	icon?: string;
};

export type StateField = {
	field_name: string;
	enabled: boolean;
	read_only: boolean;
	values: StateValue[];
};

export type StateFieldsMetadata = {
	fields: StateField[];
	has_state_fields: boolean;
};

type RawValue = {
	value: string;
	type?: string;
	display_leyend?: string;
	label?: string;
	color?: string;
	icon?: string;
	field_name?: string;
};

function text(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

function identifier(value: unknown) {
	if (typeof value !== 'string') return '';
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '_')
		.replace(/[^a-z0-9_]/g, '')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
}

function value_type(value: unknown) {
	const raw = text(value).toLowerCase();
	return raw || 'neutral';
}

function value_color(type: string, color: unknown) {
	const raw = text(color);
	if (HEX_COLOR.test(raw)) return raw;
	return TYPE_COLOR[type] || TYPE_COLOR.neutral;
}

function v(
	value: string,
	type: string,
	display_leyend: string,
	extra: { icon?: string; color?: string } = {},
): RawValue {
	return { value, type, display_leyend, ...extra };
}

function field(
	field_name: string,
	values: RawValue[],
	extra: { read_only?: boolean } = {},
): { field_name: string; enabled: boolean; read_only?: boolean; values: RawValue[] } {
	return { field_name, enabled: true, ...extra, values };
}

const PLANNING = [
	v('pendiente', 'warning', 'Pendiente'),
	v('en_progreso', 'info', 'En progreso'),
	v('en_revision', 'notice', 'En revisión'),
	v('bloqueado', 'danger', 'Bloqueado'),
	v('completado', 'success', 'Completado'),
	v('cancelado', 'black', 'Cancelado'),
];

const RAW_DEFAULTS: Record<
	string,
	Array<{ field_name: string; enabled: boolean; read_only?: boolean; values: RawValue[] }>
> = {
	pedidos: [
		field('estado', [
			v('borrador', 'neutral', 'Borrador'),
			v('confirmado', 'primary', 'Confirmado'),
			v('por_surtir', 'warning', 'Por surtir'),
			v('surtiendo', 'info', 'Surtiendo'),
			v('surtido', 'success', 'Surtido'),
			v('enviado', 'success', 'Enviado'),
			v('cancelado', 'danger', 'Cancelado'),
		]),
	],
	'purchase-order': [
		field('estado', [
			v('borrador', 'warning', 'Borrador'),
			v('aprobada', 'info', 'Aprobada'),
			v('parcialmente_recibida', 'warning', 'Recepción parcial'),
			v('confirmada', 'success', 'Confirmada'),
			v('archivada', 'danger', 'Archivada'),
		]),
	],
	'citizen-report': [
		field('status', [
			v('pendiente', 'danger', 'Pendiente', { icon: 'fas fa-exclamation-circle' }),
			v('en_proceso', 'primary', 'En proceso', { icon: 'fas fa-gear' }),
			v('terminado', 'success', 'Terminado', { icon: 'fas fa-check' }),
		]),
	],
	'pos-session': [
		field('status', [
			v('abierta', 'warning', 'Abierta'),
			v('cerrada', 'neutral', 'Cerrada'),
			v('cancelada', 'danger', 'Cancelada'),
		]),
	],
	'pos-tickets': [
		field('state', [
			v('borrador', 'warning', 'Borrador', { color: '#f59f00', icon: 'fas fa-file-alt' }),
			v('confirmado', 'info', 'Confirmado', { color: '#0d6efd', icon: 'fas fa-check-circle' }),
			v('facturado', 'success', 'Facturado', { color: '#198754', icon: 'fas fa-file-invoice-dollar' }),
			v('cancelado', 'danger', 'Cancelado', { color: '#dc3545', icon: 'fas fa-ban' }),
		]),
	],
	'pos-order': [
		field('state', [
			v('BORRADOR', 'warning', 'Borrador'),
			v('CONFIRMADO', 'info', 'Confirmado'),
			v('HECHO', 'success', 'Hecho'),
			v('CANCELADO', 'danger', 'Cancelado'),
		]),
	],
	vehicle: [
		field('estado_operativo', [
			v('disponible', 'success', 'Disponible', { icon: 'fas fa-check' }),
			v('asignado', 'primary', 'Asignado', { icon: 'fas fa-user' }),
			v('mantenimiento', 'warning', 'Mantenimiento', { icon: 'fas fa-wrench' }),
			v('inactivo', 'danger', 'Inactivo', { icon: 'fas fa-ban' }),
		]),
	],
	'delivery-package': [
		field('estado', [
			v('pendiente', 'warning', 'Pendiente'),
			v('asignado', 'primary', 'Asignado'),
			v('cargado', 'info', 'Cargado'),
			v('en_ruta', 'success', 'En ruta'),
			v('entregado', 'success', 'Entregado'),
			v('incidencia', 'danger', 'Incidencia'),
			v('cancelado', 'neutral', 'Cancelado'),
		]),
	],
	'delivery-return': [
		field('estado', [
			v('borrador', 'warning', 'Borrador'),
			v('firmado', 'info', 'Firmado'),
			v('recibido_almacen', 'success', 'Recibido en almacén'),
		]),
	],
	'planeacion-proyectos': [field('state', PLANNING)],
	'planeacion-proyectos-task': [field('status', PLANNING)],
	'planeacion-mis-tareas': [field('state', PLANNING)],
	tickets: [
		field('status', [
			v('open', 'warning', 'Abierto', { icon: 'fas fa-exclamation' }),
			v('in_progress', 'info', 'En proceso', { icon: 'fas fa-gears' }),
			v('resolved', 'success', 'Resuelto', { icon: 'fas fa-check' }),
			v('closed', 'neutral', 'Cerrado', { icon: 'fas fa-ban' }),
		]),
	],
	'inventory-reception': [
		field('estado', [
			v('pendiente', 'warning', 'Pendiente'),
			v('parcial', 'info', 'Parcial'),
			v('recibida', 'success', 'Recibida'),
			v('cancelada', 'danger', 'Cancelada'),
		]),
	],
	'inventory-physical-count': [
		field('estado', [
			v('borrador', 'warning', 'Borrador'),
			v('contado', 'info', 'Contado'),
			v('aplicado', 'success', 'Aplicado'),
		]),
	],
	'inventory-movement': [
		field(
			'tipo_movimiento',
			[
				v('recepcion_compra', 'success', 'Recepción compra'),
				v('apartado_logistica', 'info', 'Apartado logística'),
				v('liberacion_logistica', 'warning', 'Liberación logística'),
				v('salida_entrega', 'primary', 'Salida entrega'),
				v('transferencia_interna', 'secondary', 'Transferencia interna'),
				v('ajuste_manual', 'danger', 'Ajuste manual'),
				v('recepcion_devolucion', 'info', 'Recepción devolución'),
			],
			{ read_only: true },
		),
	],
	'inventory-internal-location': [
		field('tipo', [
			v('almacen', 'success', 'Almacén'),
			v('logistica', 'info', 'Logística'),
			v('transito', 'warning', 'Tránsito'),
			v('cliente', 'primary', 'Cliente'),
			v('ajuste', 'danger', 'Ajuste'),
		]),
	],
};

const MODEL_ID: Record<string, string> = {
	pedidos: 'Pedidos',
	'purchase-order': 'PurchaseOrder',
	'citizen-report': 'CitizenReport',
	'pos-session': 'PosSession',
	'pos-tickets': 'PosTickets',
	'pos-order': 'PosOrder',
	vehicle: 'Vehicle',
	'delivery-package': 'DeliveryPackage',
	'delivery-return': 'DeliveryReturn',
	'planeacion-proyectos': 'Proyectos',
	'planeacion-proyectos-task': 'ProyectoTask',
	'planeacion-mis-tareas': 'MisTareas',
	tickets: 'Ticket',
	'inventory-reception': 'InventoryReception',
	'inventory-physical-count': 'InventoryPhysicalCount',
	'inventory-movement': 'InventoryMovement',
	'inventory-internal-location': 'InventoryInternalLocation',
};

export function canonical_state_resource(resource: string) {
	if (resource === 'pedidos-surtir') return 'pedidos';
	return RESOURCE_ALIASES[resource] ?? resource;
}

export function model_id_for_resource(resource: string) {
	const canonical = canonical_state_resource(resource);
	return (
		MODEL_ID[canonical] ??
		canonical.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase())
	);
}

function normalize_values(values: unknown): StateValue[] {
	const out = new Map<string, StateValue>();
	for (const item of as_array(values)) {
		const rec = as_object(item);
		const value = identifier(rec.value);
		const display_leyend = text(rec.display_leyend) || text(rec.label);
		if (!value || !display_leyend) continue;
		const type = value_type(rec.type);
		out.set(value, {
			value,
			type,
			display_leyend,
			color: value_color(type, rec.color),
			icon: text(rec.icon) || undefined,
		});
	}
	return [...out.values()];
}

function normalize_field(
	config: Record<string, unknown> | null | undefined,
	field_name: string,
): StateField {
	return {
		field_name: field_name.trim(),
		enabled: config?.enabled !== false,
		read_only: config?.read_only === true,
		values: normalize_values(config?.values),
	};
}

export function empty_state_fields(): StateFieldsMetadata {
	return { fields: [], has_state_fields: false };
}

function normalize_metadata(raw: unknown): StateFieldsMetadata {
	const rec = as_object(raw);
	const source = Array.isArray(raw) ? raw : as_array(rec.fields);
	const seen = new Set<string>();
	const fields = source
		.map((item) => {
			const field_rec = as_object(item);
			const name = text(field_rec.field_name);
			if (!name || seen.has(name)) return null;
			seen.add(name);
			return normalize_field(field_rec, name);
		})
		.filter((item): item is StateField => Boolean(item && item.enabled));
	return { fields, has_state_fields: fields.length > 0 };
}

function defaults_for(resource: string): StateFieldsMetadata {
	return normalize_metadata(RAW_DEFAULTS[canonical_state_resource(resource)] ?? []);
}

function merge_persisted(
	base: StateFieldsMetadata,
	persisted: { status_fields?: unknown; options?: unknown } | null,
): StateFieldsMetadata {
	const configured_fields = as_array(persisted?.status_fields)
		.map((item) => (typeof item === 'string' ? item.trim() : text(as_object(item).field_name)))
		.filter(Boolean);
	const configured_options = as_array(persisted?.options)
		.map((item) => as_object(item))
		.filter((option) => identifier(option.value) && (text(option.label) || text(option.display_leyend)));
	if (!configured_fields.length && !configured_options.length) return base;

	const default_names = base.fields.map((field) => field.field_name);
	const names = [...new Set([...default_names, ...configured_fields])].filter(Boolean);
	const option_map = new Map<string, RawValue>();
	for (const field of base.fields) {
		for (const value of field.values) {
			option_map.set(`${field.field_name}::${value.value}`, {
				value: value.value,
				label: value.display_leyend,
				type: value.type,
				color: value.color,
				icon: value.icon,
				field_name: field.field_name,
			});
		}
	}
	for (const option of configured_options) {
		const field_name = text(option.field_name) || DEFAULT_FIELD;
		const value = identifier(option.value);
		const label = text(option.label) || text(option.display_leyend);
		if (!value || !label) continue;
		option_map.set(`${field_name}::${value}`, {
			value,
			label,
			type: value_type(option.type),
			color: text(option.color) || undefined,
			icon: text(option.icon) || undefined,
			field_name,
		});
	}
	const fields = names.map((field_name) => {
		const base_field = base.fields.find((field) => field.field_name === field_name);
		const values = [...option_map.values()]
			.filter((option) => (option.field_name || DEFAULT_FIELD) === field_name)
			.map((option) => ({
				value: option.value,
				display_leyend: option.label || option.display_leyend || option.value,
				type: option.type,
				color: option.color,
				icon: option.icon,
			}));
		return normalize_field(
			{ enabled: base_field?.enabled ?? true, read_only: base_field?.read_only === true, values },
			field_name,
		);
	});
	return { fields, has_state_fields: fields.length > 0 };
}

async function load_tracker_doc(store: ImperiumStore, resource: string) {
	if (!store.has('model-tracker')) return null;
	const model_id = model_id_for_resource(resource);
	return (
		(await store.find_where('model-tracker', { __model_name: model_id })) ??
		(await store.find_where('model-tracker', { name: model_id }))
	);
}

async function find_tracker_metadata(store: ImperiumStore, resource: string) {
	const tracker = await load_tracker_doc(store, resource);
	return normalize_metadata(tracker?.__state_fields);
}

const OBJECT_ID_PATTERN = '^[0-9a-fA-F]{24}$';

function json_schema_type(type: string) {
	const normalized = type.toLowerCase();
	if (normalized === 'number' || normalized === 'decimal128') return 'number';
	if (normalized === 'boolean' || normalized === 'bool') return 'boolean';
	return 'string';
}

function object_id_property(ref?: string) {
	return {
		type: 'string',
		pattern: OBJECT_ID_PATTERN,
		...(ref ? { 'x-ref': ref } : {}),
	};
}

function property_for_descriptor(
	field: { type?: string; is_array?: boolean; ref?: string },
	ref_fallback?: string,
) {
	const ref = field.ref || ref_fallback;
	const type = text(field.type);
	const is_object_id = type === 'objectid' || Boolean(ref);
	if (field.is_array) {
		return {
			type: 'array',
			items: is_object_id ? object_id_property(ref) : { type: json_schema_type(type) },
		};
	}
	if (is_object_id) return object_id_property(ref);
	return { type: json_schema_type(type) };
}

function build_schema_properties(
	store: ImperiumStore,
	resource: string,
	tracker: Record<string, unknown> | null,
) {
	const properties: Record<string, Record<string, unknown>> = {
		name: { type: 'string' },
		description: { type: 'string' },
		is_active: { type: 'boolean' },
	};
	const refs = store.field_refs(canonical_state_resource(resource));
	for (const field of as_array(tracker?.__schema_fields)) {
		const rec = as_object(field);
		const path = text(rec.path);
		if (!path || path.includes('.')) continue;
		properties[path] = property_for_descriptor(
			{
				type: text(rec.type),
				is_array: rec.is_array === true,
				ref: text(rec.ref) || undefined,
			},
			refs[path],
		);
	}
	for (const [field, model] of Object.entries(refs)) {
		if (field.includes('.')) continue;
		const current = properties[field] ?? {};
		if (current.type === 'array') {
			const items = as_object(current.items);
			properties[field] = {
				type: 'array',
				items: { ...items, ...object_id_property(model) },
			};
			continue;
		}
		properties[field] = { ...current, ...object_id_property(model) };
	}
	return properties;
}

function build_batch_import(
	store: ImperiumStore,
	resource: string,
	tracker: Record<string, unknown> | null,
	properties: Record<string, Record<string, unknown>>,
) {
	const fields = as_array(tracker?.__schema_fields)
		.map((item) => text(as_object(item).path))
		.filter(Boolean);
	const available = [...new Set([...fields, ...Object.keys(properties)])];
	const refs = store.field_refs(canonical_state_resource(resource));
	const helper_fields = [
		...as_array(tracker?.__schema_fields)
			.filter((item) => as_object(item).is_reference === true || text(as_object(item).ref))
			.map((item) => `${text(as_object(item).path).replace(/\./g, '_')}_name*`),
		...Object.keys(refs).map((field) => `${field.replace(/\./g, '_')}_name*`),
	].filter((value, index, all) => value && all.indexOf(value) === index);
	const automatic_match_fields = ['_id', 'name', 'description'].filter((field) =>
		available.includes(field),
	);
	const matchable_source = as_array(tracker?.__batch_matchable_fields).map((item) => text(item));
	const matchable_fields = (matchable_source.length ? matchable_source : Object.keys(refs))
		.filter((path) => path && !automatic_match_fields.includes(path))
		.map((path) => ({
			path,
			type: 'objectid',
			ref: refs[path] || text(as_object(
				as_array(tracker?.__schema_fields).find((item) => as_object(item).path === path),
			).ref) || undefined,
		}));
	return {
		available_fields: available,
		helper_fields,
		automatic_match_fields,
		matchable_fields,
	};
}

function constraint_list(map: Record<string, string[]>, resource: string) {
	const canonical = canonical_state_resource(resource);
	return map[canonical] ?? map[resource] ?? [];
}

function is_attachment_ref(model: string) {
	return model.replace(/[_-]/g, '').toLowerCase() === 'attachmentmanagement';
}

function attachment_fields_for(
	store: ImperiumStore,
	resource: string,
	tracker: Record<string, unknown> | null,
) {
	const canonical = canonical_state_resource(resource);
	const from_file = constraint_list(CONSTRAINTS.attachment_fields, canonical);
	const from_refs = Object.entries(store.field_refs(canonical))
		.filter(([, model]) => is_attachment_ref(model))
		.map(([field]) => field)
		.filter((field) => field && !field.includes('.'));
	const from_tracker = as_array(tracker?.__schema_fields)
		.map((item) => as_object(item))
		.filter((rec) => is_attachment_ref(text(rec.ref)))
		.map((rec) => text(rec.path))
		.filter((path) => path && !path.includes('.'));
	return [...new Set([...from_file, ...from_refs, ...from_tracker])];
}

async function find_persisted_config(store: ImperiumStore, resource: string) {
	if (!store.has('module-management') || !store.has('configuration')) return null;
	const model_id = model_id_for_resource(resource);
	const module_record =
		(await store.find_where('module-management', { model_id })) ??
		(await store.find_where('module-management', { module_name: model_id }));
	if (!module_record?._id) return null;
	const module_id = String(module_record._id);
	const { rows } = await store.find_many('configuration', {
		where: { type: STATUS_OPTION_CONFIGURATION_TYPE },
		take: 2000,
		include_inactive: true,
	});
	const configuration =
		rows.find((row) => String(row.module_id ?? as_object(row.value).module_id ?? '') === module_id) ??
		null;
	if (!configuration) return null;
	return as_object(configuration.value);
}

export async function load_state_fields_metadata(
	store: ImperiumStore,
	resource: string,
): Promise<StateFieldsMetadata> {
	const canonical = canonical_state_resource(resource);
	const defaults = defaults_for(canonical);
	const tracker = await find_tracker_metadata(store, canonical);
	const base = tracker.fields.length ? tracker : defaults;
	return merge_persisted(base, await find_persisted_config(store, canonical));
}

export async function schema_validation_for(store: ImperiumStore, resource: string) {
	const canonical = canonical_state_resource(resource);
	const [state_fields, tracker] = await Promise.all([
		load_state_fields_metadata(store, resource),
		load_tracker_doc(store, canonical),
	]);
	const properties = build_schema_properties(store, canonical, tracker);
	return {
		type: 'object',
		properties,
		required: constraint_list(CONSTRAINTS.required, canonical),
		metadata: {
			state_fields,
			model_id: model_id_for_resource(resource),
			attachment_fields: attachment_fields_for(store, canonical, tracker),
			batch_import: build_batch_import(store, canonical, tracker, properties),
		},
	};
}

export function state_field_for(
	metadata: StateFieldsMetadata,
	field_path: string,
): StateField | null {
	return metadata.fields.find((field) => field.enabled && field.field_name === field_path) ?? null;
}
