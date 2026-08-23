/**
 * Acciones de module-management: mocks, seeds e índices de búsqueda.
 * Mismos mensajes que `module-management.service.ts`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { as_array, ok, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const MOCK_DEFAULT_COUNT = 200;
const MOCK_MAX_COUNT = 5000;
const MOCK_FORBIDDEN_MODEL_NAMES = new Set([
	'ModuleManagement',
	'ModuleManagementReference',
	'MenuManagement',
	'AccessRights',
	'RecordRules',
	'ModelTrackerCustom',
	'DocumentChangeHistory',
	'AutoIncrementTrackerControl',
	'Configuration',
	'Auth',
	'UserPin',
	'DebugLog',
]);

type ModuleCtx = {
	store: ImperiumStore;
	sql: Bun.SQL;
	params: Record<string, string>;
	body: Record<string, unknown>;
};

async function resolve_module(store: ImperiumStore, identifier: string) {
	if (!identifier) return null;
	return (
		(await store.find_id('module-management', identifier)) ??
		(await store.find_where('module-management', { model_id: identifier })) ??
		(await store.find_where('module-management', { module_name: identifier })) ??
		(await store.find_where('module-management', { name: identifier }))
	);
}

function resolve_resource(store: ImperiumStore, module_record: ImperiumDoc) {
	const model_id = String(module_record.model_id ?? '');
	if (MOCK_FORBIDDEN_MODEL_NAMES.has(model_id)) {
		throw new Error(
			`El módulo "${module_record.name}" es un módulo de sistema y no admite datos de prueba.`,
		);
	}
	const resource = store.resource_for_model(model_id);
	if (!resource || !store.has(resource)) {
		throw new Error(
			`No se encontró el modelo "${model_id}" del módulo "${module_record.name}".`,
		);
	}
	return resource;
}

async function hard_remove(ctx: ModuleCtx, resource: string, id: string) {
	await ctx.sql.unsafe(`DELETE FROM ${ctx.store.qt(resource)} WHERE id = $1`, [id]);
}

function is_mock(doc: ImperiumDoc) {
	return doc.__mock === true || doc.__mock === 'true' || doc.__mock === 1;
}

async function list_mocks(store: ImperiumStore, resource: string) {
	const { rows } = await store.find_many(resource, {
		where: { __mock: true },
		take: 20000,
		include_inactive: true,
	});
	return rows.filter(is_mock);
}

export async function generate_mock_data(ctx: ModuleCtx) {
	const module_record = await resolve_module(ctx.store, ctx.params.id);
	if (!module_record) throw new Error('Módulo no encontrado');
	const resource = resolve_resource(ctx.store, module_record);
	const requested = Math.floor(Number(ctx.body.count ?? MOCK_DEFAULT_COUNT));
	const total = Number.isFinite(requested)
		? Math.min(Math.max(requested, 1), MOCK_MAX_COUNT)
		: MOCK_DEFAULT_COUNT;
	let inserted = 0;
	for (let i = 0; i < total; i++) {
		await ctx.store.insert(resource, {
			name: `Registro de prueba ${i + 1}`,
			description: `Dato de prueba generado para ${module_record.name}`,
			__mock: true,
			is_active: true,
		});
		inserted += 1;
	}
	return ok(
		[module_record],
		`Se generaron ${inserted} registro(s) de prueba para el módulo "${module_record.name}".`,
		inserted,
	);
}

export async function delete_mock_data(ctx: ModuleCtx) {
	const module_record = await resolve_module(ctx.store, ctx.params.id);
	if (!module_record) throw new Error('Módulo no encontrado');
	const resource = resolve_resource(ctx.store, module_record);
	const rows = await list_mocks(ctx.store, resource);
	let deleted = 0;
	for (const row of rows) {
		await hard_remove(ctx, resource, String(row._id));
		deleted += 1;
	}
	return ok(
		[module_record],
		`Se eliminaron ${deleted} registro(s) de prueba del módulo "${module_record.name}".`,
		deleted,
	);
}

type SeedRecord = {
	model: string;
	override: boolean;
	doc: Record<string, unknown>;
	refs: Record<string, unknown>;
};

type PendingRef = {
	resource: string;
	ref: string;
	fields: Record<string, string | string[]>;
};

const MANUAL_ACTIONS = {
	CLICK: 'click',
	INPUT: 'input',
	NAVIGATE: 'navigate',
	OBSERVE: 'observe',
};

const MANUAL_PLACEMENTS = {
	AUTO: 'auto',
	TOP: 'top',
	RIGHT: 'right',
	BOTTOM: 'bottom',
	LEFT: 'left',
};

function backend_src(): string {
	const from_env = process.env.IMPERIUM_BACKEND_SRC;
	if (from_env && existsSync(from_env)) return from_env;
	const catalog = process.env.CATALOG_PATH;
	if (catalog) {
		const candidate = join(dirname(catalog), '../backend/src');
		if (existsSync(candidate)) return candidate;
	}
	return join(import.meta.dir, '../../../../backend/src');
}

function kebab_name(value: string) {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/[^a-zA-Z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
}

function strip_ts_comments(src: string) {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function read_balanced_args(src: string, open_index: number) {
	let depth = 0;
	let in_str: string | null = null;
	let escape = false;
	for (let i = open_index; i < src.length; i++) {
		const c = src[i]!;
		if (in_str) {
			if (escape) {
				escape = false;
				continue;
			}
			if (c === '\\') {
				escape = true;
				continue;
			}
			if (c === in_str) in_str = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			in_str = c;
			continue;
		}
		if (c === '(') depth += 1;
		else if (c === ')') {
			depth -= 1;
			if (depth === 0) return src.slice(open_index + 1, i);
		}
	}
	return '';
}

function split_top_args(args: string) {
	const parts: string[] = [];
	let depth_paren = 0;
	let depth_brace = 0;
	let depth_brack = 0;
	let in_str: string | null = null;
	let escape = false;
	let start = 0;
	for (let i = 0; i < args.length; i++) {
		const c = args[i]!;
		if (in_str) {
			if (escape) {
				escape = false;
				continue;
			}
			if (c === '\\') {
				escape = true;
				continue;
			}
			if (c === in_str) in_str = null;
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			in_str = c;
			continue;
		}
		if (c === '(') depth_paren += 1;
		else if (c === ')') depth_paren -= 1;
		else if (c === '{') depth_brace += 1;
		else if (c === '}') depth_brace -= 1;
		else if (c === '[') depth_brack += 1;
		else if (c === ']') depth_brack -= 1;
		else if (
			c === ',' &&
			depth_paren === 0 &&
			depth_brace === 0 &&
			depth_brack === 0
		) {
			parts.push(args.slice(start, i).trim());
			start = i + 1;
		}
	}
	const last = args.slice(start).trim();
	if (last) parts.push(last);
	return parts;
}

function extract_exported_strings(src: string) {
	const map = new Map<string, string>();
	for (const match of src.matchAll(
		/export const ([A-Z0-9_]+)\s*=\s*["']([^"']+)["']/g,
	)) {
		map.set(match[1]!, match[2]!);
	}
	return map;
}

function resolve_import_path(spec: string, from_file: string) {
	const root = backend_src();
	if (spec.startsWith('#components/')) {
		return `${join(root, 'components', spec.slice('#components/'.length))}.ts`;
	}
	if (spec.startsWith('#plugins/')) {
		return `${join(root, 'plugins', spec.slice('#plugins/'.length))}.ts`;
	}
	if (spec.startsWith('#models/')) {
		return `${join(root, 'models', spec.slice('#models/'.length))}.ts`;
	}
	if (spec.startsWith('.')) {
		return `${join(dirname(from_file), spec)}.ts`;
	}
	return '';
}

function collect_seed_strings(file: string, seen = new Set<string>()) {
	const strings = new Map<string, string>();
	if (!existsSync(file) || seen.has(file)) return strings;
	seen.add(file);
	const src = readFileSync(file, 'utf8');
	for (const [key, value] of extract_exported_strings(src)) strings.set(key, value);
	for (const match of src.matchAll(
		/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g,
	)) {
		const names = match[1]!.split(',').map((part) =>
			part.trim().split(/\s+as\s+/)[0]!.trim(),
		);
		if (!names.some((name) => /^[A-Z0-9_]+$/.test(name))) continue;
		const imported = resolve_import_path(match[2]!, file);
		if (!imported || !existsSync(imported)) continue;
		for (const [key, value] of collect_seed_strings(imported, seen)) {
			if (names.includes(key)) strings.set(key, value);
		}
	}
	return strings;
}

function eval_seed_object(expr: string, strings: Map<string, string>) {
	let text = expr.trim().replace(/,\s*$/, '');
	text = text.replace(
		/([A-Za-z0-9_]+)Model\.modelName(?:\s+as\s+string)?/g,
		(_, name: string) => JSON.stringify(name),
	);
	text = text.replace(
		/([A-Za-z0-9_]+)\.modelName(?:\s+as\s+string)?/g,
		(_, name: string) => JSON.stringify(name.replace(/Model$/, '')),
	);
	const bindings: Record<string, unknown> = {
		InteractiveManualStepAction: MANUAL_ACTIONS,
		InteractiveManualStepPlacement: MANUAL_PLACEMENTS,
	};
	for (const [key, value] of strings) bindings[key] = value;
	const keys = Object.keys(bindings);
	const values = Object.values(bindings);
	return new Function(...keys, `"use strict"; return (${text});`)(...values);
}

export function parse_module_data_file(file: string): SeedRecord[] {
	const src = strip_ts_comments(readFileSync(file, 'utf8'));
	const strings = collect_seed_strings(file);
	const records: SeedRecord[] = [];
	let model = '';
	let override = false;
	let i = 0;
	while (i < src.length) {
		const rest = src.slice(i);
		const add = rest.match(
			/^add_model(?:<[^>]*>)?\(\s*([A-Za-z0-9_]+)\.modelName\s*(?:,\s*(true|false))?/,
		);
		if (add) {
			model = add[1]!.replace(/Model$/, '');
			override = add[2] === 'true';
			i += add[0].length;
			continue;
		}
		if (rest.startsWith('.record(') || rest.startsWith('record(')) {
			const paren = src.indexOf('(', i);
			const args = read_balanced_args(src, paren);
			const parts = split_top_args(args);
			try {
				const doc = eval_seed_object(parts[0] ?? '{}', strings);
				const refs = parts[1] ? eval_seed_object(parts[1], strings) : {};
				if (doc && typeof doc === 'object' && (doc as { _ref?: unknown })._ref) {
					records.push({
						model,
						override,
						doc: doc as Record<string, unknown>,
						refs:
							refs && typeof refs === 'object'
								? (refs as Record<string, unknown>)
								: {},
					});
				}
			} catch {
				// El seed original a veces usa helpers; se omite el registro irresoluble.
			}
			i = paren + args.length + 2;
			continue;
		}
		i += 1;
	}
	return records;
}

function find_data_file_in_root(root: string, candidates: Set<string>): string | null {
	if (!existsSync(root)) return null;
	const entries = readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const entry_path = join(root, entry.name);
		if (candidates.has(entry.name.toLowerCase())) {
			for (const name of ['module.data.ts', 'module.data.js']) {
				const file = join(entry_path, name);
				if (existsSync(file)) return file;
			}
		}
		const nested = find_data_file_in_root(entry_path, candidates);
		if (nested) return nested;
	}
	return null;
}

function resolve_module_data_file(module_record: ImperiumDoc) {
	const root = backend_src();
	const location = String(module_record.module_location ?? '').trim();
	const module_name = String(module_record.module_name ?? '').trim();
	const parent = String(module_record.parent_module ?? '').trim();
	const explicit = [
		location && module_name
			? join(root, location, parent, module_name, 'module.data.ts')
			: '',
		location && module_name
			? join(root, location, module_name, 'module.data.ts')
			: '',
		String(module_record.path ?? '').endsWith('module.data')
			? join(root, `${String(module_record.path)}.ts`)
			: '',
	];
	for (const file of explicit) {
		if (file && existsSync(file)) return file;
	}
	const candidates = new Set(
		[String(module_record.model_id ?? ''), module_name]
			.filter(Boolean)
			.flatMap((value) => [kebab_name(value), value.toLowerCase()]),
	);
	return (
		find_data_file_in_root(join(root, 'components'), candidates) ??
		find_data_file_in_root(join(root, 'plugins'), candidates)
	);
}

function dependency_ids(module_record: ImperiumDoc) {
	const raw = module_record.module_dependencies;
	if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
	if (typeof raw === 'string' && raw.trim()) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
		} catch {
			return [raw];
		}
	}
	return as_array(raw).map(String).filter(Boolean);
}

async function upsert_by_ref(
	store: ImperiumStore,
	resource: string,
	doc: ImperiumDoc,
	allow_overwrite: boolean,
) {
	const ref = String(doc._ref ?? '');
	const existing =
		(await store.find_where(resource, { _ref: ref })) ??
		(await store.find_where(resource, { ref }));
	if (existing) {
		if (!allow_overwrite) return existing;
		return (await store.update(resource, String(existing._id), doc)) ?? existing;
	}
	return store.insert(resource, doc);
}

async function upsert_module_reference(
	store: ImperiumStore,
	reference: string,
	model: string,
) {
	if (!store.has('module-management-reference')) return;
	const existing = await store.find_where('module-management-reference', {
		reference,
	});
	const doc = {
		name: reference,
		reference,
		model,
		_ref: reference,
	};
	if (existing) {
		await store.update('module-management-reference', String(existing._id), doc);
		return;
	}
	await store.insert('module-management-reference', doc);
}

async function resolve_external_id(
	store: ImperiumStore,
	external: string,
	fallback_resource?: string,
) {
	const mmr = store.has('module-management-reference')
		? await store.find_where('module-management-reference', { reference: external })
		: null;
	const model = String(mmr?.model ?? '');
	const target =
		(model ? store.resource_for_model(model) : null) ?? fallback_resource ?? null;
	if (!target || !store.has(target)) return null;
	const hit =
		(await store.find_where(target, { _ref: external })) ??
		(await store.find_where(target, { ref: external }));
	return hit?._id ? String(hit._id) : null;
}

async function apply_pending_refs(store: ImperiumStore, pending: PendingRef[]) {
	for (const item of pending) {
		if (!store.has(item.resource)) continue;
		const rec =
			(await store.find_where(item.resource, { _ref: item.ref })) ??
			(await store.find_where(item.resource, { ref: item.ref }));
		if (!rec) continue;
		const patch: ImperiumDoc = {};
		for (const [field, value] of Object.entries(item.fields)) {
			if (Array.isArray(value)) {
				const ids: string[] = [];
				for (const ref of value) {
					const id = await resolve_external_id(store, ref, item.resource);
					if (id) ids.push(id);
				}
				if (ids.length) patch[field] = ids;
				continue;
			}
			const id = await resolve_external_id(
				store,
				value,
				field === 'parent_id' ? 'menu-management' : item.resource,
			);
			if (id) patch[field] = id;
		}
		if (Object.keys(patch).length) {
			await store.update(item.resource, String(rec._id), patch);
		}
	}
}

async function install_seeds_for_record(
	store: ImperiumStore,
	module_record: ImperiumDoc,
	options: { force?: boolean },
	pending: PendingRef[],
) {
	const file = resolve_module_data_file(module_record);
	if (!file) return;
	const auto_install = readFileSync(file, 'utf8').includes('.auto_install()');
	const records = parse_module_data_file(file);
	for (const record of records) {
		const resource = store.resource_for_model(record.model);
		if (!resource || !store.has(resource)) continue;
		const doc = { ...record.doc };
		const refs: Record<string, string | string[]> = {};
		for (const [key, value] of Object.entries(record.refs ?? {})) {
			if (Array.isArray(value)) refs[key] = value.map(String);
			else if (value != null) refs[key] = String(value);
		}
		if (doc.parent_id) {
			refs.parent_id = String(doc.parent_id);
			delete doc.parent_id;
		}
		const ref = String(doc._ref ?? '');
		if (!ref) continue;
		await upsert_module_reference(store, ref, record.model);
		const allow_overwrite = Boolean(options.force || record.override || auto_install);
		await upsert_by_ref(store, resource, doc, allow_overwrite);
		if (Object.keys(refs).length) {
			pending.push({ resource, ref, fields: refs });
		}
	}
	await store.update('module-management', String(module_record._id), {
		data_installed_at: new Date().toISOString(),
	});
}

async function ensure_parent_available(store: ImperiumStore, module_record: ImperiumDoc) {
	const parent_name = String(module_record.parent_module ?? '').trim();
	if (!parent_name) return;
	const parent =
		(await store.find_where('module-management', { module_name: parent_name })) ??
		(await store.find_where('module-management', { model_id: parent_name })) ??
		(await store.find_where('module-management', { name: parent_name }));
	if (!parent) {
		throw new Error(
			`El submódulo "${module_record.name}" requiere instalar primero el módulo padre "${parent_name}".`,
		);
	}
	if (!parent.is_enable || !parent.data_installed_at) {
		throw new Error(
			`El submódulo "${module_record.name}" requiere instalar primero el módulo padre "${parent.name}".`,
		);
	}
}

async function install_module_comprehensive(
	store: ImperiumStore,
	identifier: string,
	options: { force?: boolean },
	visited: Set<string>,
	pending: PendingRef[],
): Promise<string[]> {
	const module_record = await resolve_module(store, identifier);
	if (!module_record) throw new Error('Módulo no encontrado');
	const model_id = String(module_record.model_id ?? '');
	if (visited.has(model_id)) return [];
	visited.add(model_id);
	await store.update('module-management', String(module_record._id), {
		is_enable: true,
	});
	const installed: string[] = [];
	for (const dependency of dependency_ids(module_record)) {
		const dep = await resolve_module(store, dependency);
		if (!dep) continue;
		installed.push(
			...(await install_module_comprehensive(
				store,
				String(dep.model_id ?? dep._id),
				options,
				visited,
				pending,
			)),
		);
	}
	const fresh = (await store.find_id('module-management', String(module_record._id))) ??
		module_record;
	if (options.force || !fresh.data_installed_at) {
		await install_seeds_for_record(store, fresh, options, pending);
		installed.push(model_id);
	}
	const { rows: children } = await store.find_many('module-management', {
		where: { parent_module: String(fresh.module_name ?? '') },
		take: 500,
		include_inactive: true,
	});
	for (const child of children) {
		if (!child.model_id) continue;
		installed.push(
			...(await install_module_comprehensive(
				store,
				String(child.model_id),
				options,
				visited,
				pending,
			)),
		);
	}
	return installed;
}

async function record_module_history(
	store: ImperiumStore,
	module_record: ImperiumDoc,
	action: { actionName: string; actionDescription: string; operationType: string },
) {
	if (!store.has('document-change-history')) return;
	await store.insert('document-change-history', {
		name: action.actionName,
		collectionName: 'module-management',
		modelName: 'ModuleManagement',
		documentId: String(module_record._id),
		operationType: action.operationType,
		actionName: action.actionName,
		actionDescription: action.actionDescription,
		changeCount: 0,
		changes: [],
	});
}

async function run_install(
	store: ImperiumStore,
	module_record: ImperiumDoc,
	options: { force?: boolean },
) {
	const pending: PendingRef[] = [];
	const installed = await install_module_comprehensive(
		store,
		String(module_record.model_id ?? module_record._id),
		options,
		new Set(),
		pending,
	);
	await apply_pending_refs(store, pending);
	return installed;
}

export async function install_module_data(ctx: ModuleCtx) {
	const module_record = await resolve_module(ctx.store, ctx.params.id);
	if (!module_record) throw new Error('Módulo no encontrado');
	try {
		await ensure_parent_available(ctx.store, module_record);
		const installed = await run_install(ctx.store, module_record, { force: true });
		await record_module_history(ctx.store, module_record, {
			actionName: 'Instalación de datos',
			actionDescription: installed.length
				? `Se instalaron datos en ${installed.length} módulo(s).`
				: 'Se revisó la instalación de datos del módulo.',
			operationType: 'module_data_installation',
		});
		return ok([], 'Datos del módulo instalados exitosamente', 0);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('requiere instalar primero')) throw error;
		throw new Error(`Error instalando datos del módulo ${ctx.params.id}`);
	}
}

export async function force_recreate_data(ctx: ModuleCtx) {
	const module_record = await resolve_module(ctx.store, ctx.params.id);
	if (!module_record) throw new Error('Módulo no encontrado');
	await ensure_parent_available(ctx.store, module_record);
	const installed = await run_install(ctx.store, module_record, { force: true });
	const fresh =
		(await ctx.store.find_id('module-management', String(module_record._id))) ??
		module_record;
	await record_module_history(ctx.store, fresh, {
		actionName: 'Recreación de datos',
		actionDescription: installed.length
			? `Se recrearon los datos en ${installed.length} módulo(s).`
			: 'Se recrearon los datos del módulo.',
		operationType: 'module_data_recreation',
	});
	return ok([fresh], 'Datos del módulo recreados exitosamente');
}

export async function activate_module(ctx: ModuleCtx) {
	const module_record = await resolve_module(ctx.store, ctx.params.id);
	if (!module_record) throw new Error('Módulo no encontrado');
	await ensure_parent_available(ctx.store, module_record);
	await ctx.store.update('module-management', String(module_record._id), {
		is_enable: true,
	});
	const installed = await run_install(ctx.store, module_record, { force: true });
	const fresh =
		(await ctx.store.find_id('module-management', String(module_record._id))) ??
		module_record;
	await record_module_history(ctx.store, fresh, {
		actionName: 'Activación de módulo',
		actionDescription: installed.length
			? `Se activó el módulo y se instalaron datos en ${installed.length} módulo(s).`
			: 'Se activó el módulo.',
		operationType: 'module_activation',
	});
	return ok([fresh], 'Módulo activado exitosamente');
}

export async function migrate_legacy_modules(ctx: ModuleCtx) {
	const { rows } = await ctx.store.find_many('module-management', {
		take: 2000,
		include_inactive: true,
	});
	let migratedCount = 0;
	const errors: string[] = [];
	for (const module_record of rows) {
		const path = String(module_record.path ?? '').trim();
		if (!path) continue;
		if (module_record.module_location && module_record.module_name) continue;
		try {
			const parts = path.split('/').filter((part) => part && part !== '..');
			if (parts.length < 2) {
				errors.push(`Cannot parse path for module ${module_record.name}: ${path}`);
				continue;
			}
			const module_location = parts[0]!;
			const remaining = parts.slice(1);
			if (!remaining.length || remaining[remaining.length - 1] !== 'module.data') {
				errors.push(`Invalid path format for module ${module_record.name}: ${path}`);
				continue;
			}
			remaining.pop();
			let module_name: string;
			let parent_module: string | undefined;
			if (remaining.length === 1) {
				module_name = remaining[0]!;
			} else if (remaining.length === 2) {
				parent_module = remaining[0];
				module_name = remaining[1]!;
			} else if (remaining.length === 3) {
				parent_module = `${remaining[0]}/${remaining[1]}`;
				module_name = remaining[2]!;
			} else {
				errors.push(`Cannot parse complex path for module ${module_record.name}: ${path}`);
				continue;
			}
			await ctx.store.update('module-management', String(module_record._id), {
				module_location,
				module_name,
				parent_module,
			});
			migratedCount += 1;
		} catch (error) {
			errors.push(`Error migrating module ${module_record.name}: ${error}`);
		}
	}
	return ok(
		[{ migratedCount, errors }],
		`Migrated ${migratedCount} legacy modules to dynamic metadata${
			errors.length ? ` (${errors.length} errors)` : ''
		}`,
		migratedCount,
	);
}

export async function recreate_indexes(ctx: ModuleCtx) {
	const { rows } = await ctx.store.find_many('module-management', {
		take: 2000,
		include_inactive: true,
	});
	if (!rows.length) throw new Error('No hay módulos para recrear índices.');
	for (const module_record of rows) {
		const model_id = String(module_record.model_id ?? '');
		const resource = ctx.store.resource_for_model(model_id);
		if (!resource || !ctx.store.has(resource)) continue;
		const docs = await ctx.store.find_many(resource, { take: 2000, include_inactive: true });
		for (const doc of docs.rows) {
			const search = [doc.name, doc.description, doc._ref]
				.map((part) => String(part ?? '').trim())
				.filter(Boolean)
				.join(' ');
			if (search && String(doc.search_field ?? '') !== search) {
				await ctx.store.update(resource, String(doc._id), { search_field: search });
			}
		}
	}
	return ok([], 'Índices de búsqueda recreados exitosamente para todos los modelos.');
}
