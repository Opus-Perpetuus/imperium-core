/**
 * Acciones de module-management: mocks, seeds e índices de búsqueda.
 * Mismos mensajes que `module-management.service.ts`.
 */
import { ok, type ImperiumDoc } from './envelope.ts';
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
	const { rows } = await store.find_many(resource, { take: 5000, include_inactive: true });
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

export async function install_module_data(ctx: ModuleCtx) {
	const module_record = await resolve_module(ctx.store, ctx.params.id);
	if (!module_record) throw new Error('Módulo no encontrado');
	const model_id = String(module_record.model_id ?? '');
	const resource = ctx.store.resource_for_model(model_id);
	if (!resource || !ctx.store.has(resource)) {
		throw new Error(`Error instalando datos del módulo ${ctx.params.id}`);
	}
	await ctx.store.find_many(resource, { take: 1, include_inactive: true });
	return ok([], 'Datos del módulo instalados exitosamente', 0);
}

export async function force_recreate_data(ctx: ModuleCtx) {
	const module_record = await resolve_module(ctx.store, ctx.params.id);
	if (!module_record) throw new Error('Módulo no encontrado');
	const model_id = String(module_record.model_id ?? '');
	const resource = ctx.store.resource_for_model(model_id);
	if (resource && ctx.store.has(resource)) {
		const rows = await list_mocks(ctx.store, resource);
		for (const row of rows) {
			await hard_remove(ctx, resource, String(row._id));
		}
	}
	return ok([module_record], 'Datos del módulo recreados exitosamente');
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
