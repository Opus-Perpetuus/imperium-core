/**
 * Listas de opciones que no son estatus (select, radio, choice, datalist).
 * El estatus sigue en `status-option-control`. Aquí cada módulo guarda
 * listas con clave (`list_key`) y la siembra solo agrega valores ausentes.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { query_list } from './body.ts';
import { fill_empty_presentation, insert_missing, sanitize_option_value } from './option-seed.ts';
import type { ImperiumStore } from './store.ts';

export const GENERAL_OPTION_LIST_TYPE = 'general-option-lists-by-module';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const TYPE_TO_COLOR: Record<string, string> = {
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

type ListCtx = {
	store: ImperiumStore;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
	url?: URL;
};

export type GeneralOption = {
	value: string;
	label: string;
	description?: string;
	color?: string;
	icon?: string;
	type?: string;
	is_user_defined?: boolean;
};

export type GeneralList = {
	list_key: string;
	label: string;
	field_name: string;
	options: GeneralOption[];
};

type SeedEntry = {
	module_id?: string;
	model_id?: string;
	module_name?: string;
	lists?: unknown;
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

function list_key_of(value: unknown) {
	return slug(text(value));
}

function field_name_of(value: unknown) {
	return text(value).replace(/[^a-zA-Z0-9_.]/g, '');
}

function option_icon(value: unknown) {
	const raw = text(value).replace(/\s+/g, ' ');
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, ' ');
	return sanitized || undefined;
}

function configuration_value(doc: ImperiumDoc) {
	return as_object(doc.value);
}

function configuration_ref(name: string) {
	const normalized = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return `configuration-general-option-lists-${normalized || 'module'}`;
}

function normalize_new_option(raw: unknown, user_defined: boolean): GeneralOption | null {
	const rec = as_object(raw);
	const label = text(rec.label) || text(rec.name);
	// Conserva mayúsculas del value (SAT O/E/AGU, USD/MXN); slug solo para list_key/refs.
	const value = sanitize_option_value(text(rec.value) || label);
	if (!value || !label) return null;
	const option: GeneralOption = {
		value,
		label,
		is_user_defined: user_defined,
	};
	const description = text(rec.description);
	const color = text(rec.color);
	const icon = option_icon(rec.icon ?? rec.option_icon);
	const type = text(rec.type);
	if (description) option.description = description;
	if (HEX_COLOR.test(color)) option.color = color;
	else if (type && TYPE_TO_COLOR[type]) option.color = TYPE_TO_COLOR[type];
	if (icon) option.icon = icon;
	if (type) option.type = type;
	return option;
}

function lists_of(value: Record<string, unknown>): GeneralList[] {
	return as_array(value.lists).map((item) => {
		const rec = as_object(item);
		const list_key = list_key_of(rec.list_key) || list_key_of(rec.field_name);
		return {
			list_key,
			label: text(rec.label) || list_key,
			field_name: field_name_of(rec.field_name) || list_key,
			options: as_array(rec.options) as GeneralOption[],
		};
	}).filter((list) => list.list_key);
}

async function list_configurations(store: ImperiumStore) {
	if (!store.has('configuration')) return [] as ImperiumDoc[];
	const rows: ImperiumDoc[] = [];
	for await (const page of store.scan('configuration', {
		where: { type: GENERAL_OPTION_LIST_TYPE },
		include_inactive: true,
	})) {
		rows.push(...page);
	}
	return rows;
}

async function find_module(store: ImperiumStore, module_id: string) {
	if (!module_id || !store.has('module-management')) return null;
	return (
		(await store.find_id('module-management', module_id)) ??
		(await store.find_where('module-management', { model_id: module_id })) ??
		(await store.find_where('module-management', { module_name: module_id }))
	);
}

async function resolve_target(store: ImperiumStore, entry: SeedEntry) {
	const asked_module = text(entry.module_id);
	const asked_model = text(entry.model_id);
	let module_record: ImperiumDoc | null = null;
	if (asked_module) module_record = await find_module(store, asked_module);
	if (!module_record && asked_model) module_record = await find_module(store, asked_model);
	const module_id = module_record?._id ? String(module_record._id) : asked_module;
	const model_id = text(module_record?.model_id) || asked_model;
	const module_name =
		text(module_record?.module_name) || text(entry.module_name) || model_id || module_id;
	const name = text(module_record?.name) || module_name || model_id || module_id;
	return {
		module_record,
		module_id,
		model_id,
		module_name,
		name,
		storage_id: module_id || model_id,
	};
}

function config_matches(row: ImperiumDoc, module_id: string, model_id: string) {
	const value = configuration_value(row);
	const mid = text(row.module_id ?? value.module_id);
	const model = text(row.model_id ?? value.model_id);
	if (module_id && (mid === module_id || model === module_id)) return true;
	if (model_id && (model === model_id || mid === model_id)) return true;
	return false;
}

async function find_configuration(store: ImperiumStore, module_id: string, model_id: string) {
	const rows = await list_configurations(store);
	return rows.find((row) => config_matches(row, module_id, model_id)) ?? null;
}

async function upsert(store: ImperiumStore, ref: string, payload: ImperiumDoc, existing: ImperiumDoc | null) {
	if (existing?._id) {
		return store.update('configuration', String(existing._id), payload);
	}
	return store.insert('configuration', {
		...payload,
		_ref: ref,
		is_active: true,
	});
}

function seed_entries(body: Record<string, unknown>): SeedEntry[] {
	const many = as_array(body.entries).map((item) => as_object(item) as SeedEntry);
	if (many.length) return many;
	if (Array.isArray(body.lists) || text(body.model_id) || text(body.module_id)) {
		return [body as SeedEntry];
	}
	return [];
}

function public_option(option: GeneralOption) {
	return {
		value: option.value,
		label: option.label,
		...(option.description ? { description: option.description } : {}),
		...(option.color ? { color: option.color } : {}),
		...(option.icon ? { icon: option.icon } : {}),
	};
}

export async function option_lists_for_model(store: ImperiumStore, model_id: string) {
	const wanted = text(model_id);
	if (!wanted) return [] as GeneralList[];
	const rows = await list_configurations(store);
	const row = rows.find((item) => config_matches(item, '', wanted));
	if (!row) return [] as GeneralList[];
	return lists_of(configuration_value(row)).map((list) => ({
		...list,
		options: list.options.map((option) => ({
			value: text(as_object(option).value) || option.value,
			label: text(as_object(option).label) || option.label,
			description: option.description,
			color: option.color,
			icon: option.icon,
			type: option.type,
			is_user_defined: option.is_user_defined === true,
		})),
	}));
}

export async function general_choice_options(
	store: ImperiumStore,
	model_id: string,
	field: string,
	bound_list_key?: string,
) {
	const lists = await option_lists_for_model(store, model_id);
	const key = list_key_of(bound_list_key) || field;
	const list = lists.find((item) => item.list_key === key || item.field_name === field || item.list_key === field);
	if (!list) return null;
	return list.options.map((option) => ({
		value: option.value,
		label: option.label,
		count: 0,
		description: option.description,
		color: option.color,
		icon: option.icon,
	}));
}

/**
 * POST /general-option-list-control/seed-defaults
 * Crea listas y valores que no existen. Rellena color/icon solo si estaban vacíos; no pisa el resto.
 */
export async function seed_general_option_lists(ctx: ListCtx) {
	const body = as_object(ctx.body);
	const entries = seed_entries(body);
	let inserted = 0;
	let skipped = 0;
	let filled_total = 0;
	let created_configurations = 0;
	let created_lists = 0;
	const results: Array<Record<string, unknown>> = [];
	for (const entry of entries) {
		const target = await resolve_target(ctx.store, entry);
		if (!target.storage_id) {
			skipped += 1;
			continue;
		}
		const existing = await find_configuration(ctx.store, target.module_id, target.model_id);
		const value = existing ? configuration_value(existing) : {};
		const lists = lists_of(value);
		let entry_inserted = 0;
		let entry_skipped = 0;
		let entry_filled = 0;
		const next = [...lists];
		for (const raw of as_array(entry.lists)) {
			const spec = as_object(raw);
			const key = list_key_of(spec.list_key) || list_key_of(spec.field_name);
			if (!key) continue;
			const incoming = as_array(spec.options)
				.map((option) => normalize_new_option(option, false))
				.filter((option): option is GeneralOption => Boolean(option));
			const index = next.findIndex((list) => list.list_key === key);
			if (index < 0) {
				if (!incoming.length) continue;
				next.push({
					list_key: key,
					label: text(spec.label) || key,
					field_name: field_name_of(spec.field_name) || key,
					options: incoming,
				});
				created_lists += 1;
				entry_inserted += incoming.length;
				continue;
			}
			const current = next[index]!;
			const merged = insert_missing(current.options, incoming, false);
			const filled = fill_empty_presentation(merged.options, incoming, false);
			entry_inserted += merged.inserted;
			entry_skipped += merged.skipped;
			entry_filled += filled.filled;
			if (merged.inserted === 0 && filled.filled === 0) continue;
			next[index] = { ...current, options: filled.options };
		}
		inserted += entry_inserted;
		skipped += entry_skipped;
		filled_total += entry_filled;
		results.push({
			module_id: target.storage_id,
			model_id: target.model_id,
			inserted: entry_inserted,
			skipped: entry_skipped,
			filled: entry_filled,
		});
		if (entry_inserted === 0 && entry_filled === 0) continue;
		const next_value = {
			...value,
			module_id: text(value.module_id) || target.storage_id,
			module_name: text(value.module_name) || target.module_name,
			model_id: text(value.model_id) || target.model_id,
			lists: next,
		};
		if (existing?._id) {
			await ctx.store.update('configuration', String(existing._id), { value: next_value });
			continue;
		}
		const ref = configuration_ref(target.module_name || target.storage_id);
		await upsert(
			ctx.store,
			ref,
			{
				name: `Listas de opciones | ${target.name}`,
				description: `Opciones que no son estatus para ${target.name}.`,
				module_id: target.storage_id,
				model_id: target.model_id,
				type: GENERAL_OPTION_LIST_TYPE,
				value: next_value,
				is_system: false,
			},
			null,
		);
		created_configurations += 1;
	}
	const summary = {
		inserted,
		skipped,
		filled: filled_total,
		created_configurations,
		created_lists,
		results,
	};
	return ok([summary], seed_message(inserted, skipped, filled_total), results.length);
}

function seed_message(inserted: number, skipped: number, filled = 0) {
	const parts: string[] = [];
	if (inserted) parts.push(`Se agregaron ${inserted} opciones que faltaban`);
	if (filled) parts.push(`se rellenó color/icon en ${filled} vacías`);
	if (!parts.length) {
		return 'No había opciones nuevas ni color/icon vacíos: las existentes se dejaron igual.';
	}
	return `${parts.join('; ')}. ${skipped} ya existían con presentación completa.`;
}

export async function add_general_option(ctx: ListCtx) {
	const module_id = text(ctx.params.module_id);
	const list_key = list_key_of(ctx.params.list_key);
	if (!module_id || !list_key) throw new Error('Debes indicar el módulo y la lista.');
	const option = normalize_new_option(ctx.body, true);
	if (!option) throw new Error('Debes indicar una etiqueta para la opción.');
	const target = await resolve_target(ctx.store, { module_id });
	if (!target.storage_id) throw new Error('No se encontró el módulo solicitado.');
	const existing = await find_configuration(ctx.store, target.module_id || module_id, target.model_id);
	const value = existing ? configuration_value(existing) : {};
	const lists = lists_of(value);
	const index = lists.findIndex((list) => list.list_key === list_key);
	let inserted = 0;
	const next = [...lists];
	if (index < 0) {
		next.push({
			list_key,
			label: text(ctx.body.list_label) || list_key,
			field_name: field_name_of(ctx.body.field_name) || list_key,
			options: [option],
		});
		inserted = 1;
	} else {
		const current = next[index]!;
		const merged = insert_missing(current.options, [option], false);
		inserted = merged.inserted;
		if (merged.inserted > 0) next[index] = { ...current, options: merged.options };
	}
	if (inserted > 0) {
		const next_value = {
			...value,
			module_id: text(value.module_id) || target.storage_id,
			module_name: text(value.module_name) || target.module_name,
			model_id: text(value.model_id) || target.model_id,
			lists: next,
		};
		if (existing?._id) {
			await ctx.store.update('configuration', String(existing._id), { value: next_value });
		} else {
			await upsert(
				ctx.store,
				configuration_ref(target.module_name || target.storage_id),
				{
					name: `Listas de opciones | ${target.name}`,
					description: `Opciones que no son estatus para ${target.name}.`,
					module_id: target.storage_id,
					model_id: target.model_id,
					type: GENERAL_OPTION_LIST_TYPE,
					value: next_value,
					is_system: false,
				},
				null,
			);
		}
	}
	const saved = await find_configuration(ctx.store, target.module_id || module_id, target.model_id);
	return ok(
		[build_record(target.module_record, saved, target)],
		inserted
			? 'Opción agregada.'
			: 'Esa opción ya existía y se dejó igual.',
	);
}

export async function read_general_option_list_options(ctx: ListCtx) {
	const model_id = text(ctx.url?.searchParams.get('model_id'));
	const module_id = text(ctx.url?.searchParams.get('module') ?? ctx.url?.searchParams.get('module_id'));
	const list_key = list_key_of(ctx.url?.searchParams.get('list_key'));
	if (!list_key || (!model_id && !module_id)) {
		throw new Error('Debes indicar model_id o module y list_key.');
	}
	const row = await find_configuration(ctx.store, module_id, model_id);
	const list = row
		? lists_of(configuration_value(row)).find((item) => item.list_key === list_key)
		: undefined;
	const options = (list?.options ?? []).map((option) => public_option(as_object(option) as GeneralOption));
	return ok(options, 'Opciones de la lista cargadas correctamente.', options.length);
}

function build_record(
	module_record: ImperiumDoc | null,
	configuration: ImperiumDoc | null,
	fallback?: { storage_id: string; model_id: string; module_name: string; name: string },
) {
	const value = configuration ? configuration_value(configuration) : {};
	const lists = lists_of(value);
	const module_id = module_record?._id
		? String(module_record._id)
		: text(configuration?.module_id ?? value.module_id) || fallback?.storage_id || '';
	const options = lists.reduce((total, list) => total + list.options.length, 0);
	return {
		_id: module_id,
		name: module_record ? String(module_record.name ?? module_record.module_name ?? '') : fallback?.name || module_id,
		description: String(module_record?.description ?? ''),
		module_id,
		module_name: module_record
			? String(module_record.module_name ?? '')
			: text(value.module_name) || fallback?.module_name || '',
		model_id: module_record
			? String(module_record.model_id ?? '')
			: text(configuration?.model_id ?? value.model_id) || fallback?.model_id || '',
		is_enable: module_record ? Boolean(module_record.is_enable) : true,
		configuration_id: configuration?._id ? String(configuration._id) : undefined,
		has_configuration: Boolean(configuration?._id),
		lists_count: lists.length,
		options_count: options,
		lists,
		is_active: true,
	};
}

function matches_term(record: ImperiumDoc, fields: string[], termino: string) {
	if (!termino) return true;
	const needle = termino.toLowerCase();
	return fields.some((field) => String(record[field] ?? '').toLowerCase().includes(needle));
}

const MODULE_LIST_KEYS = [
	'name',
	'module_name',
	'model_id',
	'lists_count',
	'options_count',
	'has_configuration',
] as const;

const OPTION_LIST_KEYS = ['name', 'description', 'list_key', 'option_value', 'option_color'] as const;

type ListInstanceType = Record<string, { nombre_encabezado: string; tipo: string }>;

function list_instance_type(keys: readonly string[]): ListInstanceType {
	const out: ListInstanceType = {};
	for (const key of keys) out[key] = { nombre_encabezado: key.replace(/_/g, ' '), tipo: 'string' };
	return out;
}

function with_list_instance_type<T extends Record<string, unknown>>(body: T, keys: readonly string[]) {
	return { ...body, tipo_de_instancia: list_instance_type(keys) };
}

function option_rows(record: ReturnType<typeof build_record>) {
	return record.lists.flatMap((list) =>
		list.options.map((raw, index) => {
			const option = as_object(raw);
			const option_value = String(option.value ?? '');
			return {
				...record,
				lists: undefined,
				_id: `${record.module_id || 'module'}-${list.list_key}-${option_value || index}-${index}`,
				name: String(option.label ?? option_value),
				description: String(option.description ?? ''),
				list_key: list.list_key,
				list_label: list.label,
				field_name: list.field_name,
				option_value,
				option_color: option.color,
				option_icon: option.icon,
				is_option_row: true,
			};
		}),
	);
}

export async function list_general_option_list_control(ctx: ListCtx) {
	const q = ctx.url ? query_list(ctx.url) : { skip: 0, take: 100, q: '' };
	const module_filter = text(ctx.url?.searchParams.get('module'));
	if (module_filter) {
		if (!/^[A-Za-z0-9_-]{1,80}$/.test(module_filter)) {
			return with_list_instance_type(ok([], 'No se encontró el módulo solicitado.'), OPTION_LIST_KEYS);
		}
		const module_record = await find_module(ctx.store, module_filter);
		const configuration = await find_configuration(
			ctx.store,
			module_record?._id ? String(module_record._id) : module_filter,
			text(module_record?.model_id) || module_filter,
		);
		if (!module_record && !configuration) {
			return with_list_instance_type(ok([], 'No se encontró el módulo solicitado.'), OPTION_LIST_KEYS);
		}
		const record = build_record(module_record, configuration, {
			storage_id: module_filter,
			model_id: text(module_record?.model_id) || module_filter,
			module_name: text(module_record?.module_name),
			name: text(module_record?.name) || module_filter,
		});
		const filtered = option_rows(record).filter((row) =>
			matches_term(row, ['name', 'description', 'list_key', 'option_value', 'option_color'], q.q),
		);
		return with_list_instance_type(
			ok(filtered.slice(q.skip, q.skip + q.take), `Opciones de ${record.name}.`, filtered.length),
			OPTION_LIST_KEYS,
		);
	}
	const configs = await list_configurations(ctx.store);
	const modules: ImperiumDoc[] = [];
	if (ctx.store.has('module-management')) {
		for await (const page of ctx.store.scan('module-management', { include_inactive: true })) {
			modules.push(...page);
		}
	}
	const used = new Set<string>();
	const rows = modules.map((module_record) => {
		const module_id = String(module_record._id ?? '');
		const model_id = text(module_record.model_id);
		const configuration = configs.find((row) => config_matches(row, module_id, model_id)) ?? null;
		if (configuration?._id) used.add(String(configuration._id));
		return build_record(module_record, configuration);
	});
	for (const configuration of configs) {
		if (used.has(String(configuration._id ?? ''))) continue;
		const value = configuration_value(configuration);
		rows.push(
			build_record(null, configuration, {
				storage_id: text(configuration.module_id ?? value.module_id) || text(value.model_id),
				model_id: text(configuration.model_id ?? value.model_id),
				module_name: text(value.module_name),
				name: text(configuration.name) || text(value.model_id),
			}),
		);
	}
	const filtered = rows
		.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'))
		.filter((row) => matches_term(row, ['name', 'description', 'module_name', 'model_id'], q.q));
	return with_list_instance_type(
		ok(
			filtered.slice(q.skip, q.skip + q.take),
			'Listas de opciones por módulo cargadas correctamente.',
			filtered.length,
		),
		MODULE_LIST_KEYS,
	);
}

export async function read_general_option_list_control(ctx: ListCtx) {
	const module_id = text(ctx.params.id);
	if (!module_id) throw new Error('Debes indicar el módulo a consultar.');
	const module_record = await find_module(ctx.store, module_id);
	const configuration = await find_configuration(
		ctx.store,
		module_record?._id ? String(module_record._id) : module_id,
		text(module_record?.model_id) || module_id,
	);
	if (!module_record && !configuration) throw new Error('No se encontró el módulo solicitado.');
	return ok(
		[
			build_record(module_record, configuration, {
				storage_id: module_id,
				model_id: text(module_record?.model_id) || module_id,
				module_name: text(module_record?.module_name),
				name: text(module_record?.name) || module_id,
			}),
		],
		'Ruta encontrada',
	);
}

/**
 * El editor manda la lista completa. La siembra (`seed_defaults`) no usa esta ruta:
 * aquí el usuario sí puede renombrar o quitar lo que está editando.
 */
export async function save_general_option_lists(ctx: ListCtx) {
	const module_id = text(ctx.params.module_id);
	if (!module_id) throw new Error('Debes indicar el módulo a configurar.');
	const target = await resolve_target(ctx.store, { module_id });
	if (!target.module_record && !target.storage_id) {
		throw new Error('No se encontró el módulo solicitado.');
	}
	const existing = await find_configuration(ctx.store, target.module_id || module_id, target.model_id);
	const posted = lists_of({ lists: ctx.body.lists });
	if (!posted.length) throw new Error('Debes indicar al menos una lista de opciones.');
	const value = existing ? configuration_value(existing) : {};
	const next_value = {
		...value,
		module_id: target.storage_id,
		module_name: target.module_name,
		model_id: target.model_id,
		lists: posted,
	};
	const ref =
		text(existing?._ref) || configuration_ref(target.module_name || target.storage_id);
	const saved = await upsert(
		ctx.store,
		ref,
		existing?._id
			? { value: next_value }
			: {
					name: `Listas de opciones | ${target.name}`,
					description: `Opciones que no son estatus para ${target.name}.`,
					module_id: target.storage_id,
					model_id: target.model_id,
					type: GENERAL_OPTION_LIST_TYPE,
					value: next_value,
					_ref: ref,
					is_system: false,
				},
		existing,
	);
	return ok(
		[build_record(target.module_record, saved ?? existing, target)],
		'Listas de opciones guardadas correctamente.',
	);
}
