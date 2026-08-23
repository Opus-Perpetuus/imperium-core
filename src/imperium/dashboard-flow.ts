/**
 * Tableros dinámicos: visibilidad por fila y dueño, como el service original.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { build_access } from './auth.ts';
import { is_seed_admin } from './group-access.ts';
import {
	access_flag,
	build_model_denied_message,
	context_from_actor,
	parse_domain,
	record_rule_lookup_keys,
	record_rule_scope_from_access,
	substitute_placeholders,
} from './record-rules.ts';
import type { ImperiumStore } from './store.ts';

const WIDGET_TABLE_MAX_LIMIT = 100;
const WIDGET_CHART_MAX_GROUPS = 50;
const BLOCKED_PATH_SEGMENTS = new Set(['password', 'permissions']);

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function has_id(value: unknown, id: string) {
	return as_array(value).some((entry) => ref_id(entry) === id);
}

function intersects_ids(value: unknown, ids: string[]) {
	if (!ids.length) return false;
	const wanted = new Set(ids);
	return as_array(value).some((entry) => wanted.has(ref_id(entry)));
}

export function is_dashboard_resource(resource: string) {
	return resource === 'dynamic-dashboard';
}

export function is_view_preset_resource(resource: string) {
	return resource === 'view-config-preset';
}

export async function dashboard_access(store: ImperiumStore, actor: ImperiumDoc | null) {
	if (!actor) return { full: false, user_id: '', group_ids: [] as string[] };
	if (is_seed_admin(actor)) return { full: true, user_id: ref_id(actor._id), group_ids: [] };
	const access = await build_access(store, actor);
	return {
		full: access.has_full_access === true,
		user_id: ref_id(actor._id),
		group_ids: (access.user_group_ids ?? []).map(String),
	};
}

export function dashboard_is_visible(
	doc: ImperiumDoc,
	access: { full: boolean; user_id: string; group_ids: string[] },
) {
	if (access.full) return true;
	const uid = access.user_id;
	if (!uid) return false;
	if (ref_id(doc.created_by) === uid) return true;
	if (doc.is_global === true) return true;
	if (has_id(doc.assigned_user_ids, uid)) return true;
	return intersects_ids(doc.assigned_user_group_ids, access.group_ids);
}

export function dashboard_can_manage(
	doc: ImperiumDoc | null,
	access: { full: boolean; user_id: string },
) {
	if (!doc) return false;
	if (access.full) return true;
	return Boolean(access.user_id) && ref_id(doc.created_by) === access.user_id;
}

export function prepare_dashboard_write(
	incoming: ImperiumDoc,
	actor: ImperiumDoc | null,
	access: { full: boolean; user_id: string },
	is_create: boolean,
): ImperiumDoc {
	const doc = { ...incoming };
	if (!access.full) {
		delete doc.is_global;
		delete doc.assigned_user_ids;
		delete doc.assigned_user_group_ids;
	}
	if (is_create) {
		if (access.user_id) doc.created_by = access.user_id;
		else if (actor?._id) doc.created_by = String(actor._id);
	} else {
		delete doc.created_by;
	}
	return doc;
}

export function prepare_view_preset_create(incoming: ImperiumDoc, actor: ImperiumDoc | null) {
	const doc = { ...incoming };
	if (actor?._id && !doc.created_by) doc.created_by = String(actor._id);
	return doc;
}

function is_blocked_path(path: string) {
	return String(path ?? '')
		.split('.')
		.some(
			(segment) =>
				BLOCKED_PATH_SEGMENTS.has(segment.toLowerCase()) || segment.startsWith('__'),
		);
}

function widget_resource_candidates(raw: string): string[] {
	const kebab = raw
		.replace(/^\/+/, '')
		.replace(/Model$/, '')
		.replace(/([a-z])([A-Z])/g, '$1-$2')
		.toLowerCase();
	const collapsed = kebab.replace(/-/g, '');
	const out = [kebab, raw, collapsed];
	if (kebab && !kebab.endsWith('s')) out.push(`${kebab}s`);
	if (kebab.endsWith('s') && kebab.length > 1) out.push(kebab.slice(0, -1));
	if (kebab.endsWith('y') && kebab.length > 1) out.push(`${kebab.slice(0, -1)}ies`);
	return [...new Set(out.filter(Boolean))];
}

function resolve_widget_resource(store: ImperiumStore, raw: string) {
	const from_refs = store.resource_for_model(raw);
	if (from_refs) return from_refs;
	for (const name of widget_resource_candidates(raw)) {
		if (store.has(name)) return name;
	}
	const collapsed = String(raw ?? '')
		.replace(/^\/+/, '')
		.replace(/Model$/, '')
		.replace(/([a-z])([A-Z])/g, '$1-$2')
		.toLowerCase()
		.replace(/-/g, '');
	const hit = [...store.locs.keys()].find((key) => {
		const k = key.replace(/-/g, '');
		if (k === collapsed || k === `${collapsed}s` || `${k}s` === collapsed) return true;
		return same_model_token(catalog_model_id(key), raw);
	});
	if (hit) return hit;
	throw new Error(`El modelo '${raw}' no está disponible.`);
}

function resolve_relative_from(relative: string, now = new Date()) {
	const from = new Date(now);
	switch (relative) {
		case 'today':
			from.setHours(0, 0, 0, 0);
			return from;
		case 'last_7d':
			from.setDate(from.getDate() - 7);
			return from;
		case 'last_30d':
			from.setDate(from.getDate() - 30);
			return from;
		case 'last_90d':
			from.setDate(from.getDate() - 90);
			return from;
		case 'this_month':
			return new Date(now.getFullYear(), now.getMonth(), 1);
		case 'this_year':
			return new Date(now.getFullYear(), 0, 1);
		default:
			throw new Error(`Rango relativo no soportado: '${relative}'.`);
	}
}

function build_date_range_match(date_range: Record<string, unknown>, date_field: string) {
	const mode = String(date_range.mode ?? 'none');
	if (mode === 'none') return null;
	if (mode === 'relative') {
		return { [date_field]: { $gte: resolve_relative_from(String(date_range.relative ?? '')) } };
	}
	const criteria: Record<string, unknown> = {};
	if (date_range.from) criteria.$gte = new Date(String(date_range.from));
	if (date_range.to) criteria.$lte = new Date(String(date_range.to));
	if (!Object.keys(criteria).length) {
		throw new Error("El rango de fechas absoluto requiere 'from' y/o 'to'.");
	}
	return { [date_field]: criteria };
}

function build_widget_match(parts: Array<Record<string, unknown> | null>) {
	const present = parts.filter((part): part is Record<string, unknown> => Boolean(part));
	if (!present.length) return null;
	if (present.length === 1) return present[0];
	return { $and: present };
}

function same_model_token(left: string, right: string) {
	return left.replace(/[^A-Za-z0-9]/g, '').toLowerCase() === right.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

async function assert_widget_module_enabled(
	store: ImperiumStore,
	resource: string,
	model_id: string,
) {
	if (!store.has('module-management')) return;
	const exact = await store.find_many('module-management', {
		where: { model_id, is_enable: true },
		take: 1,
		include_inactive: false,
		populate: false,
	});
	if (exact.rows[0] && access_flag(exact.rows[0].is_enable)) return;
	const { rows } = await store.find_many('module-management', {
		where: { is_enable: true },
		take: 20000,
		include_inactive: false,
		populate: false,
	});
	if (!rows.length) return;
	const tokens = record_rule_lookup_keys(resource, model_id);
	const hit = rows.find((row) => {
		const mid = String(row.model_id ?? '');
		const name = String(row.module_name ?? row.name ?? '');
		return tokens.some((token) => same_model_token(mid, token) || same_model_token(name, token));
	});
	const enabled = hit && access_flag(hit.is_enable) && hit.is_active !== false;
	if (!enabled) {
		throw new Error(`El módulo del modelo '${model_id}' está deshabilitado.`);
	}
}

function can_read_model(
	access: Awaited<ReturnType<typeof build_access>>,
	resource: string,
	model_id: string,
) {
	if (access.has_full_access) return { ok: true, message: '' };
	const keys = record_rule_lookup_keys(resource, model_id);
	for (const key of keys) {
		if (access.permissions_by_model?.[key]?.allow_read) return { ok: true, message: '' };
	}
	const collapsed = resource.replace(/-/g, '').toLowerCase();
	for (const [model, perms] of Object.entries(access.permissions_by_model ?? {})) {
		if (model.replace(/[^A-Za-z0-9]/g, '').toLowerCase() === collapsed && perms.allow_read) {
			return { ok: true, message: '' };
		}
	}
	return {
		ok: false,
		message: build_model_denied_message('GET', model_id || resource, access.user_group_names ?? []),
	};
}

function numeric_value(row: ImperiumDoc, field: string) {
	const raw = field.includes('.')
		? field.split('.').reduce<unknown>((acc, key) => as_object(acc)[key], row)
		: row[field];
	return Number(raw ?? 0);
}

function group_label(value: unknown) {
	if (value && typeof value === 'object') {
		return String(as_object(value).name ?? 'Sin valor');
	}
	return String(value ?? 'Sin valor');
}

function date_bucket(value: unknown, granularity: string) {
	const date = new Date(String(value ?? ''));
	if (Number.isNaN(date.getTime())) return 'Sin valor';
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	const d = String(date.getUTCDate()).padStart(2, '0');
	if (granularity === 'year') return String(y);
	if (granularity === 'month') return `${y}-${m}`;
	if (granularity === 'week') {
		const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
		const day = tmp.getUTCDay() || 7;
		tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
		const year_start = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
		const week = Math.ceil(((tmp.getTime() - year_start.getTime()) / 86400000 + 1) / 7);
		return `${tmp.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
	}
	return `${y}-${m}-${d}`;
}

export async function resolve_widget_data(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	body: Record<string, unknown>,
) {
	const spec = as_object(body.spec ?? body);
	const pagination = as_object(body.pagination ?? {});
	const widget_type = String(spec.widget_type ?? '');
	const model_id = String(spec.model_id ?? spec.model ?? spec.resource ?? '');
	if (!widget_type || !model_id) {
		throw new Error("La especificación del widget requiere 'widget_type' y 'model_id'.");
	}
	let resource: string;
	try {
		resource = resolve_widget_resource(store, model_id);
	} catch {
		throw new Error(`El modelo '${model_id}' no está disponible.`);
	}
	await assert_widget_module_enabled(store, resource, model_id);
	const access = actor
		? await build_access(store, actor)
		: { has_full_access: false, permissions_by_model: {}, user_group_ids: [] };
	const readable = can_read_model(access, resource, model_id);
	if (!readable.ok) {
		return ok(
			[{ widget_type, denied: true, message: readable.message }],
			'Sin acceso al modelo del widget',
		);
	}
	const parsed_domain = spec.domain ? parse_domain(spec.domain) : null;
	if (parsed_domain) {
		const walk = (node: unknown) => {
			if (Array.isArray(node)) {
				node.forEach(walk);
				return;
			}
			if (!node || typeof node !== 'object') return;
			for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
				if (key.startsWith('$')) {
					walk(value);
					continue;
				}
				if (is_blocked_path(key)) {
					throw new Error(`El campo '${key}' no está permitido como filtro del dominio.`);
				}
				walk(value);
			}
		};
		walk(parsed_domain);
	}
	const domain_match = parsed_domain
		? (substitute_placeholders(
				parsed_domain,
				context_from_actor(actor, [
					...((access.user_group_ids as string[]) ?? []),
					...((access.user_group_refs as string[]) ?? []),
				]),
			) as Record<string, unknown>)
		: null;
	const date_range = as_object(spec.date_range);
	const date_match =
		(date_range.mode ?? 'none') !== 'none'
			? build_date_range_match(date_range, String(spec.date_field || 'createdAt'))
			: null;
	const scope = record_rule_scope_from_access(
		access,
		actor,
		record_rule_lookup_keys(resource, model_id),
		'allow_read',
	);
	const mongo_match = build_widget_match([
		{ is_active: true },
		date_match,
		domain_match,
		scope.match,
	]);
	const take = Math.min(
		WIDGET_TABLE_MAX_LIMIT,
		Math.max(1, Number(pagination.limite ?? (widget_type === 'table' ? 20 : 5000)) || 20),
	);
	const skip = Math.max(0, Number(pagination.desde ?? 0) || 0);
	const for_table = widget_type === 'table';
	const sort_field = String(pagination.campoSort ?? '').trim() || 'createdAt';
	const sort_dir = Number(pagination.sort) === 1 ? 'asc' : 'desc';
	const { rows, total } = await store.find_many(resource, {
		take: for_table ? take : 20000,
		skip: for_table ? skip : 0,
		mongo_match,
		include_inactive: true,
		sort: for_table ? `${sort_field}:${sort_dir}` : undefined,
	});
	const agg = as_object(spec.aggregation);
	const op = String(agg.op ?? 'count');
	const field = String(agg.field ?? '');
	if (op !== 'count' && is_blocked_path(field)) {
		throw new Error(`El campo '${field}' no está permitido como campo de agregación.`);
	}
	const scalar = () => {
		if (op === 'sum') return rows.reduce((acc, row) => acc + numeric_value(row, field), 0);
		if (op === 'avg') {
			return rows.length
				? rows.reduce((acc, row) => acc + numeric_value(row, field), 0) / rows.length
				: 0;
		}
		if (op === 'min') {
			return rows.length ? Math.min(...rows.map((row) => numeric_value(row, field))) : 0;
		}
		if (op === 'max') {
			return rows.length ? Math.max(...rows.map((row) => numeric_value(row, field))) : 0;
		}
		return total;
	};
	if (widget_type === 'kpi') {
		return ok([{ widget_type, denied: false, kpi: { value: scalar() } }], 'Datos del widget obtenidos');
	}
	if (widget_type === 'progress') {
		const progress = as_object(spec.progress);
		return ok(
			[{
				widget_type,
				denied: false,
				progress: {
					value: scalar(),
					target_value: progress.target_value,
					target_date: progress.target_date,
				},
			}],
			'Datos del widget obtenidos',
		);
	}
	if (widget_type.startsWith('chart-')) {
		const group_by = String(spec.group_by ?? '');
		if (!group_by) throw new Error("Los widgets de gráfica requieren 'group_by'.");
		if (is_blocked_path(group_by)) {
			throw new Error(`El campo '${group_by}' no está permitido como campo de agrupación.`);
		}
		const granularity = String(spec.group_by_date_granularity ?? '');
		const map = new Map<string, number>();
		for (const row of rows) {
			const raw = group_by.includes('.')
				? group_by.split('.').reduce<unknown>((acc, key) => as_object(acc)[key], row)
				: row[group_by];
			const name = granularity ? date_bucket(raw, granularity) : group_label(raw);
			map.set(name, (map.get(name) ?? 0) + (op === 'count' ? 1 : numeric_value(row, field)));
		}
		const ranked = [...map.entries()]
			.map(([name, value]) => ({ name, value }))
			.sort((a, b) => (granularity ? a.name.localeCompare(b.name) : b.value - a.value));
		const head = ranked.slice(0, WIDGET_CHART_MAX_GROUPS);
		if (ranked.length > WIDGET_CHART_MAX_GROUPS) {
			const rest = ranked.slice(WIDGET_CHART_MAX_GROUPS).reduce((acc, item) => acc + item.value, 0);
			head.push({ name: 'Otros', value: rest });
		}
		return ok(
			[{
				widget_type,
				denied: false,
				chart: { series: head, truncated: ranked.length > WIDGET_CHART_MAX_GROUPS },
			}],
			'Datos del widget obtenidos',
		);
	}
	if (widget_type !== 'table') {
		throw new Error(`Tipo de widget no soportado: '${widget_type}'.`);
	}
	const requested = as_array(spec.fields).map(String).filter(Boolean);
	const fields = (requested.length ? requested : ['name']).filter((path) => !is_blocked_path(path));
	if (!fields.length) {
		throw new Error("Los widgets de tabla requieren columnas en 'fields'.");
	}
	const table_rows = rows.map((row) => {
		if (!fields.length) return row;
		const slim: Record<string, unknown> = {};
		for (const key of fields) slim[key] = row[key];
		return slim;
	});
	return ok(
		[{
			widget_type,
			denied: false,
			table: {
				rows: table_rows,
				total_elementos: total,
				fields: fields.length ? fields : Object.keys(table_rows[0] ?? { name: 1 }),
			},
		}],
		'Datos del widget obtenidos',
	);
}

const INTERNAL_CATALOG_RESOURCES = new Set([
	'debug-log',
	'document-change-history',
	'mentions',
	'model-tracker',
]);

const CATALOG_FIELD_LABELS: Record<string, string> = {
	_id: 'Id',
	name: 'Nombre',
	description: 'Descripción',
	is_active: 'Activo',
	createdAt: 'Creado',
	updatedAt: 'Actualizado',
	estado: 'Estado',
	state: 'Estado',
};

export function catalog_model_id(resource: string) {
	if (resource === 'branchoffice') return 'Branchoffice';
	return resource
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

function try_resolve_widget_resource(store: ImperiumStore, raw: string) {
	if (!raw) return '';
	try {
		return resolve_widget_resource(store, raw);
	} catch {
		return '';
	}
}

function catalog_field_type(path: string, pg?: string, ref?: string) {
	if (ref) return 'ObjectID';
	if (path === 'createdAt' || path === 'updatedAt' || path.endsWith('_at') || path.endsWith('At')) {
		return 'Date';
	}
	if (path === 'is_active') return 'Boolean';
	if (pg === 'boolean') return 'Boolean';
	if (pg === 'number') return 'Number';
	if (pg === 'json') return 'Mixed';
	return 'String';
}

function push_catalog_field(
	fields: Map<string, Record<string, unknown>>,
	path: string,
	type: string,
	extra: Record<string, unknown> = {},
) {
	if (!path || is_blocked_path(path) || fields.has(path)) return;
	fields.set(path, {
		path,
		type,
		label: CATALOG_FIELD_LABELS[path] ?? path,
		...extra,
	});
}

async function build_catalog_fields(store: ImperiumStore, resource: string) {
	const fields = new Map<string, Record<string, unknown>>();
	const loc = store.loc(resource);
	const refs = store.field_refs(resource);
	push_catalog_field(fields, '_id', 'String');
	push_catalog_field(fields, 'name', 'String');
	push_catalog_field(fields, 'description', 'String');
	push_catalog_field(fields, 'is_active', 'Boolean');
	push_catalog_field(fields, 'createdAt', 'Date');
	push_catalog_field(fields, 'updatedAt', 'Date');
	for (const col of loc.columns) {
		const ref = refs[col.name];
		push_catalog_field(fields, col.name, catalog_field_type(col.name, col.pg, ref), {
			is_reference: Boolean(ref),
			ref: ref || undefined,
		});
	}
	for (const [path, ref] of Object.entries(refs)) {
		push_catalog_field(fields, path, 'ObjectID', { is_reference: true, ref });
	}
	const { rows } = await store.find_many(resource, {
		take: 1,
		include_inactive: true,
		populate: false,
	});
	const sample = rows[0] ?? {};
	for (const key of Object.keys(sample)) {
		if (key === 'payload' || key === 'custom_data' || key === 'id') continue;
		const value = sample[key];
		const type =
			value instanceof Date
				? 'Date'
				: typeof value === 'boolean'
					? 'Boolean'
					: typeof value === 'number'
						? 'Number'
						: Array.isArray(value)
							? 'Array'
							: value && typeof value === 'object'
								? 'Mixed'
								: 'String';
		push_catalog_field(fields, key, type, { is_array: Array.isArray(value) });
	}
	return [...fields.values()];
}

export async function resolve_dashboard_catalog(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
) {
	const access = actor
		? await build_access(store, actor)
		: { has_full_access: false, permissions_by_model: {}, user_group_names: [] as string[] };
	const modules = store.has('module-management')
		? (
				await store.find_many('module-management', {
					where: { is_enable: true },
					take: 20000,
					include_inactive: false,
					populate: false,
				})
			).rows
		: [];
	const enabled = modules.filter(
		(row) => access_flag(row.is_enable) && row.is_active !== false,
	);
	const seen = new Set<string>();
	const pending: Array<{ resource: string; model_id: string; module_name: string }> = [];
	const consider = (resource: string, model_id: string, module_name: string) => {
		if (!resource || INTERNAL_CATALOG_RESOURCES.has(resource) || !store.has(resource)) return;
		if (seen.has(resource) || seen.has(model_id)) return;
		if (!can_read_model(access, resource, model_id).ok) return;
		seen.add(resource);
		seen.add(model_id);
		pending.push({ resource, model_id, module_name });
	};
	if (enabled.length) {
		for (const row of enabled) {
			const model_id = String(row.model_id ?? '').trim();
			const resource = try_resolve_widget_resource(
				store,
				model_id || String(row.module_name ?? row.name ?? ''),
			);
			if (!resource) continue;
			consider(
				resource,
				model_id || catalog_model_id(resource),
				String(row.name ?? row.module_name ?? model_id ?? resource),
			);
		}
	} else {
		for (const loc of store.locs.values()) {
			consider(loc.resource, catalog_model_id(loc.resource), loc.name);
		}
	}
	const entries = [];
	for (const item of pending) {
		entries.push({
			model_id: item.model_id,
			module_name: item.module_name,
			fields: await build_catalog_fields(store, item.resource),
		});
	}
	return ok(entries, 'Catálogo de modelos disponible');
}
