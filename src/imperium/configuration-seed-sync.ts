/**
 * Inserta parámetros de sistema cuyo `_ref` aún no existe.
 * No reescribe `value` de filas ya persistidas.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ImperiumDoc } from './envelope.ts';
import {
	load_configuration_parameter_seeds,
	make_module_id_resolver,
	reconcile_configuration_seeds,
	type ConfigurationSeedDoc,
} from './reconcile-configuration-seeds.ts';
import type { ImperiumStore, SubjectInfo } from './store.ts';
import { plan_escritorio_menu } from './escritorio-menu-seed.ts';
import { plan_portal_menus } from './portal-menu-seed.ts';
import { ensure_installed_subject_menus } from './subject-menu-seed.ts';

function backend_src_root(): string {
	const from_env = process.env.IMPERIUM_BACKEND_SRC;
	if (from_env && existsSync(from_env)) return from_env;
	const catalog = process.env.CATALOG_PATH;
	if (catalog) {
		const candidate = join(dirname(catalog), '../backend/src');
		if (existsSync(candidate)) return candidate;
	}
	return join(import.meta.dir, '../../../../backend/src');
}

export function configuration_parameter_seeds(): ConfigurationSeedDoc[] {
	const walked = load_configuration_parameter_seeds(backend_src_root());
	if (walked.length) return walked;
	const snapshot = join(import.meta.dir, 'configuration-parameter-seeds.json');
	if (!existsSync(snapshot)) return [];
	return JSON.parse(readFileSync(snapshot, 'utf8')) as ConfigurationSeedDoc[];
}

async function collect_scan(
	store: ImperiumStore,
	resource: string,
	opts: { include_inactive?: boolean; fields?: string[] } = {},
): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan(resource, opts)) out.push(...page);
	return out;
}

/**
 * Las pantallas del portal necesitan fila de menú para ser alcanzables; se
 * siembran en la misma pasada que los parámetros, y por las mismas razones.
 */
async function ensure_portal_landing_menu(store: ImperiumStore): Promise<void> {
	if (!store.has('menu-management')) return;
	const menus = await collect_scan(store, 'menu-management', {
		include_inactive: true,
		fields: ['_id', '_ref', 'parent_id'],
	});
	for (const row of plan_portal_menus(menus)) {
		await store.insert('menu-management', row);
	}
}

function is_disabled_flag(value: unknown) {
	return value === false || value === 'false';
}

function installed_subjects_from_markers(
	store: ImperiumStore,
	modules: ImperiumDoc[],
): SubjectInfo[] {
	return store.subjects.filter((sub) => {
		const rows = modules.filter((row) => {
			const ref = String(row._ref ?? row.ref ?? '');
			const module_name = String(row.module_name ?? '');
			const name = String(row.name ?? '');
			return (
				ref === sub.technical_id ||
				module_name === sub.slug ||
				name === sub.name
			);
		});
		if (!rows.length) return false;
		return rows.some((row) => !is_disabled_flag(row.is_enable));
	});
}

async function ensure_escritorio_menu(store: ImperiumStore): Promise<void> {
	if (!store.has('menu-management')) return;
	const menus = await collect_scan(store, 'menu-management', {
		include_inactive: true,
		fields: ['_id', '_ref', 'parent_id'],
	});
	const plan = plan_escritorio_menu(menus);
	if (plan.insert) await store.insert('menu-management', plan.row);
}

export async function apply_missing_configuration_seeds(
	store: ImperiumStore,
): Promise<{ created: string[]; patched: string[]; message: string }> {
	const seeds = configuration_parameter_seeds();
	const modules = store.has('module-management')
		? await collect_scan(store, 'module-management', {
				include_inactive: true,
			})
		: [];
	const existing = store.has('configuration')
		? await collect_scan(store, 'configuration', {
				include_inactive: true,
				fields: ['_id', '_ref', 'value', 'module_id'],
			})
		: [];
	const plan = reconcile_configuration_seeds(
		seeds,
		existing,
		make_module_id_resolver(modules),
	);
	for (const doc of plan.inserts) {
		await store.insert('configuration', doc);
	}
	const by_ref = new Map(
		existing.map((row) => [String(row._ref ?? ''), row] as const),
	);
	for (const patch of plan.module_id_patches) {
		const row = by_ref.get(patch._ref);
		const id = String(row?._id ?? row?.id ?? '');
		if (!id) continue;
		await store.update('configuration', id, {
			module_id: patch.module_id,
		});
	}
	await ensure_portal_landing_menu(store);
	await ensure_escritorio_menu(store);
	await ensure_installed_subject_menus(
		store,
		installed_subjects_from_markers(store, modules),
	);
	const created = plan.inserts.map((row) => row._ref);
	const patched = plan.module_id_patches.map((row) => row._ref);
	const message =
		created.length || patched.length
			? `Se crearon ${created.length} parámetro(s) y se asignó módulo a ${patched.length}.`
			: 'No faltaba ningún parámetro.';
	return { created, patched, message };
}
