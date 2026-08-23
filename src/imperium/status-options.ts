/**
 * Opciones de estatus — mismo contrato que `status-option-control.service.ts`.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { query_list } from './body.ts';
import type { ImperiumStore } from './store.ts';

const STATUS_OPTION_CONFIGURATION_TYPE = 'status-options-by-module';
const STATUS_OPTION_DEFAULT_TYPE = 'info';
const STATUS_OPTION_DEFAULT_COLOR = '#6c757d';
const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const STATUS_OPTION_TYPE_TO_COLOR: Record<string, string> = {
	info: '#0dcaf0',
	success: '#198754',
	warning: '#ffc107',
	danger: '#dc3545',
	notice: '#6f42c1',
};

type StatusCtx = {
	store: ImperiumStore;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
	url?: URL;
};

type StatusOption = {
	value: string;
	label: string;
	type: string;
	color: string;
	icon?: string;
	field_name?: string;
	description?: string;
	is_user_defined?: boolean;
};

function text(value: unknown) {
	return typeof value === 'string' ? value.trim() : '';
}

function slug(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

function field_name(value: unknown) {
	return text(value).replace(/[^a-zA-Z0-9_.]/g, '');
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

function option_color(value: unknown, fallback_type: string) {
	const raw = text(value);
	if (HEX_COLOR_REGEX.test(raw)) return raw;
	return STATUS_OPTION_TYPE_TO_COLOR[fallback_type] || STATUS_OPTION_DEFAULT_COLOR;
}

function option_icon(value: unknown) {
	const raw = text(value).replace(/\s+/g, ' ');
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, ' ');
	return sanitized || undefined;
}

function normalize_fields(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const fields = value
		.map((item) => {
			if (typeof item === 'string') return field_name(item);
			if (item && typeof item === 'object') {
				return field_name((item as Record<string, unknown>).field_name);
			}
			return '';
		})
		.filter(Boolean);
	return [...new Set(fields)];
}

function normalize_options(value: unknown): StatusOption[] {
	if (!Array.isArray(value)) return [];
	const out = new Map<string, StatusOption>();
	for (const item of value) {
		const rec = as_object(item);
		const name = text(rec.name);
		const label = text(rec.label) || name;
		const raw_value = text(rec.value) || label || name;
		const normalized_value = slug(raw_value);
		const type = text(rec.type) || STATUS_OPTION_DEFAULT_TYPE;
		const option_field = field_name(rec.field_name);
		if (!normalized_value || !label) continue;
		const option: StatusOption = {
			value: normalized_value,
			label,
			type,
			color: option_color(rec.color, type),
			icon: option_icon(rec.icon ?? rec.option_icon),
			field_name: option_field || undefined,
			description: text(rec.description) || undefined,
			is_user_defined:
				rec.is_user_defined === true ? true : rec.is_user_defined === false ? false : undefined,
		};
		out.set(`${option.field_name || 'default'}::${option.value}`, option);
	}
	return [...out.values()];
}

function option_key(option: StatusOption) {
	return `${option.field_name || 'default'}::${option.value}`;
}

function stamp_user_defined(options: StatusOption[], defaults: StatusOption[]) {
	const default_keys = new Set(defaults.map(option_key));
	return options.map((option) => ({
		...option,
		is_user_defined:
			option.is_user_defined === true ? true : !default_keys.has(option_key(option)),
	}));
}

function merge_fields(configured: string[], defaults: string[]) {
	return [...new Set([...defaults, ...configured].map(field_name).filter(Boolean))];
}

function merge_options(configured: StatusOption[], defaults: StatusOption[]) {
	const out = new Map<string, StatusOption>();
	for (const option of defaults) out.set(option_key(option), option);
	for (const option of configured) out.set(option_key(option), option);
	return [...out.values()];
}

function configuration_value(doc: ImperiumDoc) {
	return as_object(doc.value);
}

function configuration_ref(module_name: string) {
	const normalized = module_name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `configuration-status-options-${normalized || 'module'}`;
}

async function list_status_configurations(store: ImperiumStore) {
	if (!store.has('configuration')) return [] as ImperiumDoc[];
	const { rows } = await store.find_many('configuration', {
		where: { type: STATUS_OPTION_CONFIGURATION_TYPE },
		take: 20000,
		include_inactive: true,
	});
	return rows;
}

async function find_module(store: ImperiumStore, module_id: string) {
	if (!module_id) return null;
	return (
		(await store.find_id('module-management', module_id)) ??
		(await store.find_where('module-management', { model_id: module_id })) ??
		(await store.find_where('module-management', { module_name: module_id }))
	);
}

async function find_existing_configuration(store: ImperiumStore, module_id: string) {
	const rows = await list_status_configurations(store);
	return (
		rows.find((row) => String(row.module_id ?? configuration_value(row).module_id ?? '') === module_id) ??
		null
	);
}

function aliases_for_field(options: StatusOption[], field: string) {
	const aliases = new Map<string, string>();
	for (const option of options) {
		if (option.field_name && option.field_name !== field) continue;
		const by_value = identifier(option.value);
		const by_label = identifier(option.label);
		if (by_value) aliases.set(by_value, option.value);
		if (by_label) aliases.set(by_label, option.value);
	}
	return aliases;
}

function resolve_value(options: StatusOption[], field: string, current: unknown) {
	if (typeof current !== 'string') return undefined;
	const key = identifier(current);
	if (!key) return undefined;
	return aliases_for_field(options, field).get(key);
}

async function upsert_configuration(
	store: ImperiumStore,
	ref: string,
	payload: ImperiumDoc,
) {
	const existing =
		(await store.find_where('configuration', { ref })) ??
		(await store.find_where('configuration', { _ref: ref }));
	if (existing?._id) {
		return store.update('configuration', String(existing._id), {
			...payload,
			_ref: ref,
			is_active: true,
		});
	}
	return store.insert('configuration', {
		...payload,
		_ref: ref,
		is_active: true,
	});
}

function build_record(module_record: ImperiumDoc, configuration: ImperiumDoc | null) {
	const value = configuration ? configuration_value(configuration) : {};
	const fields = merge_fields(normalize_fields(value.status_fields), []);
	const options = normalize_options(value.options);
	const module_id = String(module_record._id);
	return {
		_id: module_id,
		name: String(module_record.name ?? module_record.module_name ?? ''),
		description: String(module_record.description ?? ''),
		module_id,
		module_name: String(module_record.module_name ?? ''),
		model_id: String(module_record.model_id ?? ''),
		is_enable: Boolean(module_record.is_enable),
		configuration_id: configuration?._id ? String(configuration._id) : undefined,
		has_configuration: Boolean(configuration?._id),
		status_options_count: options.length,
		status_fields_count: fields.length,
		status_fields: fields,
		status_options: options,
		is_active: true,
	};
}

export async function save_status_config(ctx: StatusCtx) {
	const module_id = text(ctx.params.module_id);
	if (!module_id) throw new Error('Debes indicar el módulo a configurar.');
	const module_record = await find_module(ctx.store, module_id);
	if (!module_record) throw new Error('No se encontró el módulo solicitado.');
	const existing = await find_existing_configuration(ctx.store, module_id);
	const existing_value = existing ? configuration_value(existing) : {};
	const normalized_options = normalize_options(
		Array.isArray(ctx.body.options) ? ctx.body.options : existing_value.options,
	);
	const normalized_fields = normalize_fields(
		Array.isArray(ctx.body.status_fields) ? ctx.body.status_fields : existing_value.status_fields,
	);
	const merged_fields = merge_fields(normalized_fields, []);
	const merged_options = stamp_user_defined(merge_options(normalized_options, []), []);
	if (!merged_fields.length) {
		throw new Error('Debes proporcionar al menos un campo de estatus válido para el módulo.');
	}
	const ref =
		text(existing?._ref) ||
		configuration_ref(String(module_record.module_name || module_record.name || module_id));
	const saved = await upsert_configuration(ctx.store, ref, {
		name: `Opciones de estado | ${module_record.name}`,
		description: `Configuración de opciones de estado para el módulo ${module_record.name}.`,
		module_id,
		type: STATUS_OPTION_CONFIGURATION_TYPE,
		value: {
			module_id,
			module_name: String(module_record.module_name ?? ''),
			model_id: String(module_record.model_id ?? ''),
			status_fields: merged_fields,
			options: merged_options,
		},
		is_system: false,
	});
	return ok([build_record(module_record, saved)], 'Configuración de estado guardada correctamente.');
}

async function collect_spurious(store: ImperiumStore) {
	const rows = await list_status_configurations(store);
	const spurious: Array<Record<string, unknown>> = [];
	for (const configuration of rows) {
		const value = configuration_value(configuration);
		const module_id = text(configuration.module_id ?? value.module_id);
		const model_id = text(value.model_id);
		const options = normalize_options(value.options);
		const valid_by_field = new Map<string, StatusOption[]>();
		const orphans: StatusOption[] = [];
		for (const option of options) {
			if (option.is_user_defined === false) {
				orphans.push(option);
				continue;
			}
			const key = option.field_name || 'state';
			const list = valid_by_field.get(key) ?? [];
			list.push(option);
			valid_by_field.set(key, list);
		}
		if (!orphans.length) continue;
		const resource = model_id ? store.resource_for_model(model_id) : null;
		for (const option of orphans) {
			const field = option.field_name || 'state';
			let usage_count = 0;
			if (resource && store.has(resource)) {
				const found = await store.find_many(resource, {
					where: { [field]: option.value },
					take: 1,
					include_inactive: true,
				});
				usage_count = found.total;
			}
			spurious.push({
				module_id,
				module_name: text(value.module_name),
				model_name: model_id,
				model_id,
				configuration_id: String(configuration._id ?? ''),
				field_name: field,
				value: option.value,
				label: option.label,
				type: option.type,
				usage_count,
				replacement_candidates: (valid_by_field.get(field) ?? []).map((candidate) => ({
					value: candidate.value,
					label: candidate.label,
				})),
			});
		}
	}
	return spurious;
}

export async function normalize_state_values(ctx: StatusCtx) {
	const configurations = await list_status_configurations(ctx.store);
	const summaries: Array<Record<string, unknown>> = [];
	for (const configuration of configurations) {
		const value = configuration_value(configuration);
		const model_id = text(value.model_id);
		const fields = normalize_fields(value.status_fields);
		const options = normalize_options(value.options);
		if (!model_id || !fields.length || !options.length) continue;
		const resource = ctx.store.resource_for_model(model_id);
		if (!resource || !ctx.store.has(resource)) continue;
		const summary = {
			model_name: model_id,
			collection_name: resource,
			state_fields: fields,
			scanned_documents: 0,
			executed_documents: 0,
			updated_documents: 0,
			updated_fields: 0,
		};
		const { rows } = await ctx.store.find_many(resource, { take: 5000, include_inactive: true });
		for (const document of rows) {
			summary.scanned_documents += 1;
			const update: Record<string, string> = {};
			const descriptions: string[] = [];
			let executable = false;
			for (const field of fields) {
				const current = document[field];
				const resolved = resolve_value(options, field, current);
				if (!resolved || typeof current !== 'string') continue;
				executable = true;
				if (resolved === current) continue;
				update[field] = resolved;
				descriptions.push(`${field}: ${current} -> ${resolved}`);
			}
			if (!executable) continue;
			summary.executed_documents += 1;
			const changed = Object.keys(update);
			if (!changed.length) continue;
			await ctx.store.update(resource, String(document._id), update);
			if (ctx.store.has('document-change-history')) {
				await ctx.store.insert('document-change-history', {
					name: 'Valores de estatus normalizados',
					actionName: 'Valores de estatus normalizados',
					actionDescription: descriptions.join(' · '),
					operationType: 'normalize-state-values',
					collectionName: resource,
					modelName: model_id,
					documentId: String(document._id),
					created_by: String(ctx.actor?._id ?? ''),
				});
			}
			summary.updated_documents += 1;
			summary.updated_fields += changed.length;
		}
		summaries.push(summary);
	}
	const result = {
		total_models: summaries.length,
		executed_models: summaries.filter((item) => Number(item.executed_documents) > 0).length,
		normalized_models: summaries.filter((item) => Number(item.updated_documents) > 0).length,
		scanned_documents: summaries.reduce((total, item) => total + Number(item.scanned_documents), 0),
		executed_documents: summaries.reduce((total, item) => total + Number(item.executed_documents), 0),
		updated_documents: summaries.reduce((total, item) => total + Number(item.updated_documents), 0),
		updated_fields: summaries.reduce((total, item) => total + Number(item.updated_fields), 0),
		results: summaries,
		spurious_options: await collect_spurious(ctx.store),
	};
	const spurious_note = result.spurious_options.length
		? ` Se detectaron ${result.spurious_options.length} opciones de estatus huérfanas (no creadas por el usuario y ausentes del model) pendientes de revisar.`
		: '';
	return ok(
		[result],
		(result.executed_documents
			? `Se ejecutó la normalización sobre ${result.executed_documents} registros de ${result.executed_models} modelos; ${result.updated_documents} requirieron actualización efectiva.`
			: 'La normalización se ejecutó, pero no encontró registros configurados con valores de estatus para confirmar o actualizar.') +
			spurious_note,
		summaries.length,
	);
}

export async function resolve_spurious_options(ctx: StatusCtx) {
	const raw = as_array(ctx.body.resolutions).map((item) => as_object(item));
	const summary = {
		removed_options: 0,
		updated_documents: 0,
		cleared_documents: 0,
		results: [] as Array<Record<string, unknown>>,
	};
	const by_module = new Map<string, Array<Record<string, unknown>>>();
	for (const resolution of raw) {
		const module_id = text(resolution.module_id);
		const value = text(resolution.value);
		if (!module_id || !value) continue;
		const list = by_module.get(module_id) ?? [];
		list.push(resolution);
		by_module.set(module_id, list);
	}
	for (const [module_id, resolutions] of by_module) {
		const configuration = await find_existing_configuration(ctx.store, module_id);
		if (!configuration?._id) continue;
		const value = configuration_value(configuration);
		const model_id = text(value.model_id);
		const resource = model_id ? ctx.store.resource_for_model(model_id) : null;
		const removal_keys = new Set(
			resolutions.map(
				(resolution) => `${text(resolution.field_name) || 'state'}::${text(resolution.value)}`,
			),
		);
		for (const resolution of resolutions) {
			const field = text(resolution.field_name) || 'state';
			const current = text(resolution.value);
			const replacement = text(resolution.replacement_value);
			let updated_documents = 0;
			if (resource && ctx.store.has(resource)) {
				const { rows } = await ctx.store.find_many(resource, {
					where: { [field]: current },
					take: 5000,
					include_inactive: true,
				});
				for (const document of rows) {
					await ctx.store.update(
						resource,
						String(document._id),
						replacement ? { [field]: replacement } : { [field]: null },
					);
					updated_documents += 1;
				}
				if (replacement) summary.updated_documents += updated_documents;
				else summary.cleared_documents += updated_documents;
			}
			summary.removed_options += 1;
			summary.results.push({
				module_id,
				field_name: field,
				value: current,
				replacement_value: replacement || null,
				updated_documents,
			});
		}
		const remaining = normalize_options(value.options).filter(
			(option) => !removal_keys.has(`${option.field_name || 'state'}::${option.value}`),
		);
		await ctx.store.update('configuration', String(configuration._id), {
			value: { ...value, options: remaining },
		});
	}
	return ok(
		[summary],
		summary.removed_options
			? `Se eliminaron ${summary.removed_options} opciones huérfanas; ${summary.updated_documents} registros reemplazados y ${summary.cleared_documents} limpiados.`
			: 'No se recibieron opciones huérfanas para limpiar.',
		summary.results.length,
	);
}

function matches_term(record: ImperiumDoc, fields: string[], termino: string) {
	if (!termino) return true;
	const needle = termino.toLowerCase();
	return fields.some((field) => String(record[field] ?? '').toLowerCase().includes(needle));
}

function build_option_rows(module_record: ImperiumDoc, configuration: ImperiumDoc | null) {
	const projection = build_record(module_record, configuration);
	const options = as_array(projection.status_options);
	return options.map((raw, index) => {
		const option = as_object(raw);
		const option_value = String(option.value ?? '');
		const option_field_name = String(option.field_name ?? '');
		return {
			...projection,
			_id: `${projection.module_id || 'module'}-${option_field_name || 'default'}-${option_value || index}-${index}`,
			name: String(option.label ?? option_value),
			description: String(option.description ?? ''),
			option_field_name: option_field_name || undefined,
			option_value,
			option_color: option.color,
			option_icon: option.icon,
			option_type: String(option.type ?? STATUS_OPTION_DEFAULT_TYPE),
			option_is_default: false,
			is_option_row: true,
		};
	});
}

/**
 * GET /status-option-control: filas virtuales por módulo (o por opción si `?module=`).
 */
export async function list_status_option_control(ctx: StatusCtx) {
	const q = ctx.url ? query_list(ctx.url) : { skip: 0, take: 100, q: '' };
	const module_filter = text(ctx.url?.searchParams.get('module'));
	if (module_filter) {
		if (!/^[a-f0-9]{24}$/i.test(module_filter)) {
			return ok([], 'No se encontró el módulo solicitado.');
		}
		const module_record = await find_module(ctx.store, module_filter);
		if (!module_record) return ok([], 'No se encontró el módulo solicitado.');
		const configuration = await find_existing_configuration(ctx.store, String(module_record._id));
		const filtered = build_option_rows(module_record, configuration).filter((row) =>
			matches_term(
				row,
				['name', 'description', 'option_field_name', 'option_type', 'option_color', 'option_icon'],
				q.q,
			),
		);
		return ok(
			filtered.slice(q.skip, q.skip + q.take),
			`Opciones configuradas para ${module_record.name}.`,
			filtered.length,
		);
	}
	if (!ctx.store.has('module-management')) {
		return ok([], 'Opciones de estado por módulo cargadas correctamente.');
	}
	const { rows: modules } = await ctx.store.find_many('module-management', {
		take: 20000,
		include_inactive: true,
	});
	const configs = await list_status_configurations(ctx.store);
	const by_module = new Map<string, ImperiumDoc>();
	for (const row of configs) {
		const module_id = String(row.module_id ?? configuration_value(row).module_id ?? '');
		if (module_id) by_module.set(module_id, row);
	}
	const filtered = modules
		.map((module_record) =>
			build_record(module_record, by_module.get(String(module_record._id)) ?? null),
		)
		.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'))
		.filter((row) => matches_term(row, ['name', 'description', 'module_name', 'model_id'], q.q));
	return ok(
		filtered.slice(q.skip, q.skip + q.take),
		'Opciones de estado por módulo cargadas correctamente.',
		filtered.length,
	);
}

/**
 * GET /status-option-control/:id — el original lee ModuleManagement, no la colección.
 */
export async function read_status_option_control(ctx: StatusCtx) {
	const module_id = text(ctx.params.id);
	if (!module_id) throw new Error('Debes indicar el módulo a consultar.');
	if (!/^[a-f0-9]{24}$/i.test(module_id)) {
		throw new Error('No se encontró el módulo solicitado.');
	}
	const module_record = await find_module(ctx.store, module_id);
	if (!module_record) throw new Error('No se encontró el módulo solicitado.');
	const configuration = await find_existing_configuration(ctx.store, String(module_record._id));
	return ok([build_record(module_record, configuration)], 'Ruta encontrada');
}
