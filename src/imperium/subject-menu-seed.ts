/**
 * Filas de menú y AccessRights de las apps instaladas.
 *
 * `reshape_subject_menus` las materializa en memoria (subject-root-*,
 * subject-mod-*). Sin fila en `menu-management` no aparecen en Manejo de
 * menús ni se pueden asignar a un grupo — SEREM: CE instalada, solo
 * Escritorio en el catálogo, Mario 0 menús (#63).
 *
 * Idempotente por `_ref`. `model` vacío: carpeta/lanzador, no exige ACL
 * para verse; los AccessRights se siembran aparte para el picker de
 * Permisos de acceso.
 */
import type { RegistrySql } from './app-registry.ts';
import type { ImperiumDoc } from './envelope.ts';
import { collect_group_menu_ids } from './group-access.ts';
import {
	load_installed_menu_snapshots,
	overlay_snapshot_menus,
	type SnapshotMenuHost,
} from './snapshot-menu-overlay.ts';
import type { ImperiumStore, SubjectInfo } from './store.ts';

export type MenuRow = {
	_id?: unknown;
	id?: unknown;
	_ref?: unknown;
	parent_id?: unknown;
	[key: string]: unknown;
};

export type PlannedSubjectMenu = {
	_ref: string;
	name: string;
	path: string;
	icon: string;
	order: number;
	model: string;
	parent_ref: string | null;
	description: string;
};

export type PlannedAccessRight = {
	_ref: string;
	name: string;
	description: string;
	model_id: string;
	allow_read: boolean;
	allow_create: boolean;
	allow_update: boolean;
	allow_delete: boolean;
};

const SUBJECT_ICONS: Record<string, string> = {
	almacen: 'fa-warehouse',
	ventas: 'fa-chart-line',
	configuracion: 'fa-cog',
	rh: 'fa-users',
	reportes: 'fa-chart-bar',
	logistica: 'fa-truck',
	pos: 'fa-store',
	'control-municipal': 'fa-landmark',
	'control-emergencias': 'fa-ambulance',
	'control-escolar': 'fa-graduation-cap',
	'control-hospitalario': 'fa-hospital',
	turnos: 'fa-id-card',
	planeacion: 'fa-clipboard-list',
	pagos: 'fa-credit-card',
	'facturacion-electronica': 'fa-file-invoice',
	'tableros-dinamicos': 'fa-chart-pie',
	vehiculos: 'fa-truck',
	'dispositivos-fisicos': 'fa-desktop',
	'configuraciones-de-vista': 'fa-table-columns',
	tienda: 'fa-store',
};

export function model_id_from_resource(resource: string): string {
	return resource
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

function present_refs(rows: Array<{ _ref?: unknown }>): Set<string> {
	return new Set(rows.map((row) => String(row._ref ?? '')).filter(Boolean));
}

const norm_path = (path: unknown): string => {
	const raw = String(path ?? '').trim().replace(/\/+$/, '');
	return raw && !raw.startsWith('/') ? `/${raw}` : raw;
};

/**
 * Refs del catálogo/snapshot que no están en la base por `_ref` pero sí como
 * fila: mismo path dentro del árbol de la app (o de un ref `<slug>-…`), o la
 * misma carpeta por nombre bajo el mismo padre. Pasa cuando el admin o una
 * versión vieja la sembró con otro `_ref`. Sin esto, cada arranque del núcleo
 * la volvía a crear con un `order` al final de la lista (incidente G85).
 */
export function existing_menu_twins(
	sub: Pick<SubjectInfo, 'slug' | 'path' | 'menu_ref' | 'modules' | 'menus'>,
	existing: MenuRow[],
): Map<string, string> {
	const present = present_refs(existing);
	const by_ref = new Map<string, string>();
	for (const row of existing) {
		const ref = String(row._ref ?? '');
		const id = row_id(row);
		if (ref && id && !by_ref.has(ref)) by_ref.set(ref, id);
	}
	const out = new Map<string, string>();
	const root_ref = String(sub.menu_ref ?? '').trim();
	const root_path = norm_path(sub.path);
	let root_id = by_ref.get(root_ref) ?? '';
	if (root_ref && !root_id && root_path) {
		const twin = existing.find(
			(row) => !String(row.parent_id ?? '').trim() && norm_path(row.path) === root_path,
		);
		if (twin && row_id(twin)) {
			root_id = row_id(twin);
			out.set(root_ref, root_id);
		}
	}
	// Filas de la app: el árbol bajo su raíz y los refs `<slug>-…`.
	const prefix = `${sub.slug}-`;
	const tree = new Set<string>(root_id ? [root_id] : []);
	let grew = true;
	while (grew) {
		grew = false;
		for (const row of existing) {
			const id = row_id(row);
			if (!id || tree.has(id)) continue;
			if (tree.has(String(row.parent_id ?? '')) || String(row._ref ?? '').startsWith(prefix)) {
				tree.add(id);
				grew = true;
			}
		}
	}
	const own = existing.filter((row) => tree.has(row_id(row)));
	const id_of = (ref: string): string => by_ref.get(ref) ?? out.get(ref) ?? '';
	const declared: Array<{ ref: string; path: string; name: string; parent_ref: string }> = [];
	for (const mod of sub.modules ?? []) {
		declared.push({
			ref: String(mod.menu_ref ?? '').trim(),
			path: norm_path(mod.path),
			name: String(mod.name ?? ''),
			parent_ref: root_ref,
		});
	}
	for (const menu of sub.menus ?? []) {
		declared.push({
			ref: String(menu.menu_ref ?? '').trim(),
			path: norm_path(menu.path),
			name: String(menu.name ?? ''),
			parent_ref: String(menu.parent_ref ?? root_ref).trim(),
		});
	}
	// Una fila cuyo `_ref` la app declara ya es de ese ref: no es gemela de otro.
	const declared_refs = new Set([root_ref, ...declared.map((item) => item.ref)]);
	const taken = new Set<string>(out.values());
	for (const row of existing) {
		if (declared_refs.has(String(row._ref ?? ''))) taken.add(row_id(row));
	}
	for (const item of declared) {
		if (!item.ref || present.has(item.ref) || out.has(item.ref)) continue;
		const parent_id = id_of(item.parent_ref);
		const twin = own.find((row) => {
			if (taken.has(row_id(row))) return false;
			if (item.path) return norm_path(row.path) === item.path;
			return (
				!norm_path(row.path) &&
				!!parent_id &&
				String(row.parent_id ?? '') === parent_id &&
				String(row.name ?? '').trim() === item.name.trim()
			);
		});
		const id = twin ? row_id(twin) : '';
		if (id) {
			out.set(item.ref, id);
			taken.add(id);
		}
	}
	return out;
}

export function plan_subject_menus(
	sub: Pick<
		SubjectInfo,
		'slug' | 'name' | 'path' | 'menu_ref' | 'modules' | 'menus'
	>,
	existing: MenuRow[],
): PlannedSubjectMenu[] {
	// `present` arranca con lo que ya está en la base, pero cada fila planeada se
	// añade también: el mismo `menu_ref` puede aparecer en `modules[]` y en
	// `menus[]` del catálogo —es la forma de decir "este nodo es el del módulo,
	// con este icono y esta ruta"— y sin registrarlo sobre la marcha se planeaban
	// dos INSERT del mismo `_ref`. Una app ya sembrada no lo notaba (la base lo
	// filtraba); una app nueva reventaba con `menu_management_ref_key` y dejaba
	// `POST /module-management/seed-default-data` en 500.
	const present = present_refs(existing);
	for (const ref of existing_menu_twins(sub, existing).keys()) present.add(ref);
	const out: PlannedSubjectMenu[] = [];
	const add = (row: PlannedSubjectMenu) => {
		if (present.has(row._ref)) return;
		present.add(row._ref);
		out.push(row);
	};
	const menu_ref = String(sub.menu_ref ?? '').trim();
	if (menu_ref) {
		add({
			_ref: menu_ref,
			name: sub.name,
			path: sub.path || '',
			icon: SUBJECT_ICONS[sub.slug] ?? 'fa-cube',
			order: 50,
			model: '',
			parent_ref: null,
			description: `App ${sub.name}`,
		});
	}
	let order = 10;
	for (const mod of sub.modules ?? []) {
		const ref = String(mod.menu_ref ?? '').trim();
		if (!ref || present.has(ref)) {
			order += 10;
			continue;
		}
		add({
			_ref: ref,
			name: mod.name,
			path: mod.path || '',
			icon: mod.icon || 'fa-circle',
			order,
			model: '',
			parent_ref: menu_ref || null,
			description: mod.name,
		});
		order += 10;
	}
	for (const spec of sub.menus ?? []) {
		const ref = String(spec.menu_ref ?? '').trim();
		if (!ref || present.has(ref)) continue;
		add({
			_ref: ref,
			name: spec.name,
			path: spec.path ?? '',
			icon: spec.icon,
			order,
			model: '',
			parent_ref: spec.parent_ref ?? (menu_ref || null),
			description: spec.name,
		});
		order += 10;
	}
	return out;
}

export function plan_subject_access_rights(
	sub: Pick<SubjectInfo, 'slug' | 'name' | 'modules'>,
	existing: Array<{ _ref?: unknown }>,
): PlannedAccessRight[] {
	const present = present_refs(existing);
	const out: PlannedAccessRight[] = [];
	const root_ref = `${sub.slug}-access-rights-0`;
	if (!present.has(root_ref)) {
		out.push({
			_ref: root_ref,
			name: `${sub.name} | Permisos generales`,
			description: 'Modifica los permisos de los registros',
			model_id: model_id_from_resource(sub.slug),
			allow_read: true,
			allow_create: true,
			allow_update: true,
			allow_delete: true,
		});
	}
	for (const mod of sub.modules ?? []) {
		const ref = `${mod.resource}-access-rights-0`;
		if (present.has(ref)) continue;
		out.push({
			_ref: ref,
			name: `${mod.name} | Permisos generales`,
			description: 'Modifica los permisos de los registros',
			model_id: model_id_from_resource(mod.resource),
			allow_read: true,
			allow_create: true,
			allow_update: true,
			allow_delete: true,
		});
	}
	return out;
}

function is_on(row: MenuRow): boolean {
	const v = row.is_active;
	return v === undefined || v === null || v === true || v === 't' || v === 'true' || v === 1;
}

/**
 * Filas que se apagan al arrancar: solo las que la app retira a propósito.
 * `retired_menu_paths` del catálogo (`/model-tracker`) y las páginas de
 * `manifest.public.pages` que el overlay ya no cuelga del menú interno
 * («Tienda pública: leer»). Nada más: una página con ruta válida (aunque sea
 * alias de un recurso) o una carpeta no se apagan, y ninguna fila cambia de
 * carpeta ni de ruta. En el G85, apagar alias y carpetas «vacías» tiró 21
 * filas con ruta (Surtido, Agua potable, Proyectos…).
 */
export function plan_stale_subject_menus(
	sub: Pick<SubjectInfo, 'slug'> & Pick<SnapshotMenuHost, 'retired_menu_paths'>,
	wanted_refs: ReadonlySet<string>,
	existing: MenuRow[],
	granted_ids: ReadonlySet<string> = new Set(),
): MenuRow[] {
	const retired = new Set<string>();
	for (const path of sub.retired_menu_paths ?? []) {
		const norm = norm_path(path);
		if (norm) retired.add(norm);
	}
	if (!retired.size) return [];
	const prefix = `${sub.slug}-`;
	// Un _ref en dos filas no se sabe cuál es la sembrada: no se toca ninguna.
	const ref_count = ref_counts(existing);
	return existing.filter((row) => {
		const ref = String(row._ref ?? '');
		const path = norm_path(row.path);
		if (!path || !retired.has(path)) return false;
		if (!ref.startsWith(prefix) || wanted_refs.has(ref)) return false;
		if ((ref_count.get(ref) ?? 0) > 1) return false;
		// Una fila que algún grupo asigna (`menus_ids`) es de alguien: no se apaga.
		if (granted_ids.has(row_id(row))) return false;
		return is_on(row);
	});
}

function ref_counts(existing: MenuRow[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const row of existing) {
		const ref = String(row._ref ?? '');
		if (ref) out.set(ref, (out.get(ref) ?? 0) + 1);
	}
	return out;
}

/**
 * Filas de la app cuyo `path` es una ruta vieja que ya no enruta y que el
 * catálogo renombró (`renamed_menu_paths`, p.ej. `/pedidos-surtir` →
 * `/pedidos/surtir`). Solo cambia el `path`: mismo id, carpeta, orden y
 * permisos. Un _ref en dos filas no se toca.
 */
export function plan_menu_repaths(
	sub: Pick<SubjectInfo, 'slug' | 'renamed_menu_paths'>,
	existing: MenuRow[],
): Array<{ row: MenuRow; path: string }> {
	const renames = new Map<string, string>();
	for (const [from, to] of Object.entries(sub.renamed_menu_paths ?? {})) {
		const a = norm_path(from);
		const b = norm_path(to);
		if (a && b && a !== b) renames.set(a, b);
	}
	if (!renames.size) return [];
	const prefix = `${sub.slug}-`;
	const counts = ref_counts(existing);
	const out: Array<{ row: MenuRow; path: string }> = [];
	for (const row of existing) {
		const ref = String(row._ref ?? '');
		const to = renames.get(norm_path(row.path));
		if (!to || !ref.startsWith(prefix) || (counts.get(ref) ?? 0) > 1) continue;
		out.push({ row, path: to });
	}
	return out;
}

/**
 * Carpetas que el catálogo marca (`hidden_empty_menu_refs`) y que no tienen
 * ningún hijo activo: en el sidebar solo son un título sin nada debajo. Se
 * apagan (reversible); con un hijo activo no se tocan. Una carpeta cuyos hijos
 * son solo carpetas que también se apagan aquí cuenta como vacía. Nunca se
 * reactivan: si el admin la apagó o la prende, el arranque no lo deshace.
 */
export function plan_hidden_empty_folders(
	sub: Pick<SubjectInfo, 'slug' | 'hidden_empty_menu_refs'>,
	existing: MenuRow[],
	granted_ids: ReadonlySet<string> = new Set(),
): MenuRow[] {
	const refs = new Set(
		(sub.hidden_empty_menu_refs ?? []).map((ref) => String(ref ?? '').trim()).filter(Boolean),
	);
	if (!refs.size) return [];
	const prefix = `${sub.slug}-`;
	const counts = ref_counts(existing);
	const candidates = existing.filter((row) => {
		const ref = String(row._ref ?? '');
		return (
			refs.has(ref) &&
			ref.startsWith(prefix) &&
			(counts.get(ref) ?? 0) === 1 &&
			!norm_path(row.path) &&
			!granted_ids.has(row_id(row)) &&
			is_on(row)
		);
	});
	const off = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const row of candidates) {
			const id = row_id(row);
			if (!id || off.has(id)) continue;
			const busy = existing.some(
				(child) =>
					String(child.parent_id ?? '') === id && is_on(child) && !off.has(row_id(child)),
			);
			if (!busy) {
				off.add(id);
				grew = true;
			}
		}
	}
	return candidates.filter((row) => off.has(row_id(row)));
}

function row_id(row: MenuRow | ImperiumDoc | null | undefined): string {
	return String(row?._id ?? row?.id ?? '').trim();
}

async function collect_scan(
	store: ImperiumStore,
	resource: string,
): Promise<ImperiumDoc[]> {
	if (!store.has(resource)) return [];
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan(resource, { include_inactive: true })) {
		out.push(...page);
	}
	return out;
}

/**
 * Inserta menús y ACL que faltan para las apps ya instaladas, apaga
 * (`is_active=false`, reversible) las filas rotas que un overlay viejo dejó
 * (ver `plan_stale_subject_menus`) y las carpetas vacías que el catálogo marca
 * (`plan_hidden_empty_folders`), y corrige rutas renombradas
 * (`plan_menu_repaths`). No asigna el grupo (eso lo hace el admin).
 */
export async function ensure_installed_subject_menus(
	store: ImperiumStore,
	installed: SubjectInfo[],
	sql?: RegistrySql | null,
): Promise<{ menus: string[]; rights: string[]; retired?: string[]; repathed?: string[] }> {
	const created_menus: string[] = [];
	const retired: string[] = [];
	const repathed: string[] = [];
	const created_rights: string[] = [];
	if (!installed.length) return { menus: created_menus, rights: created_rights };

	const menus = store.has('menu-management')
		? await collect_scan(store, 'menu-management')
		: [];
	const rights = store.has('access-rights')
		? await collect_scan(store, 'access-rights')
		: [];
	const granted = new Set<string>(
		collect_group_menu_ids(
			store.has('user-group') ? await collect_scan(store, 'user-group') : [],
		),
	);
	const ref_to_id = new Map<string, string>();
	for (const row of menus) {
		const ref = String(row._ref ?? '');
		const id = row_id(row);
		if (ref && id) ref_to_id.set(ref, id);
	}

	const subjects = overlay_snapshot_menus(
		installed,
		sql ? await load_installed_menu_snapshots(sql) : [],
	);
	for (const sub of subjects) {
		if (!store.has('menu-management')) break;
		for (const [ref, id] of existing_menu_twins(sub, menus)) {
			if (!ref_to_id.has(ref)) ref_to_id.set(ref, id);
		}
		const planned = plan_subject_menus(sub, menus);
		for (const plan of planned) {
			const parent_id = plan.parent_ref
				? ref_to_id.get(plan.parent_ref) || null
				: null;
			const inserted = await store.insert('menu-management', {
				_ref: plan._ref,
				name: plan.name,
				description: plan.description,
				path: plan.path,
				icon: plan.icon,
				order: plan.order,
				is_active: true,
				model: plan.model,
				parent_id,
			});
			const id = row_id(inserted);
			if (id) ref_to_id.set(plan._ref, id);
			menus.push(inserted);
			created_menus.push(plan._ref);
		}
		const wanted = new Set<string>(
			[
				sub.menu_ref,
				...(sub.modules ?? []).map((mod) => mod.menu_ref),
				...(sub.menus ?? []).map((menu) => menu.menu_ref),
			]
				.map((ref) => String(ref ?? '').trim())
				.filter(Boolean),
		);
		for (const row of plan_stale_subject_menus(sub, wanted, menus, granted)) {
			const id = row_id(row);
			if (!id) continue;
			await store.update('menu-management', id, { is_active: false });
			row.is_active = false;
			retired.push(String(row._ref ?? id));
		}
		for (const { row, path } of plan_menu_repaths(sub, menus)) {
			const id = row_id(row);
			if (!id) continue;
			await store.update('menu-management', id, { path });
			row.path = path;
			repathed.push(String(row._ref ?? id));
		}
		for (const row of plan_hidden_empty_folders(sub, menus, granted)) {
			const id = row_id(row);
			if (!id) continue;
			await store.update('menu-management', id, { is_active: false });
			row.is_active = false;
			retired.push(String(row._ref ?? id));
		}
	}

	if (store.has('access-rights')) {
		for (const sub of installed) {
			for (const plan of plan_subject_access_rights(sub, rights)) {
				const inserted = await store.insert('access-rights', {
					...plan,
					is_active: true,
				});
				rights.push(inserted);
				created_rights.push(plan._ref);
			}
		}
	}

	return { menus: created_menus, rights: created_rights, retired, repathed };
}
