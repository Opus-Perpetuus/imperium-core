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
import type { ImperiumDoc } from './envelope.ts';
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
 * Inserta menús y ACL que faltan para las apps ya instaladas.
 * No toca filas existentes. No asigna el grupo (eso lo hace el admin).
 */
export async function ensure_installed_subject_menus(
	store: ImperiumStore,
	installed: SubjectInfo[],
): Promise<{ menus: string[]; rights: string[] }> {
	const created_menus: string[] = [];
	const created_rights: string[] = [];
	if (!installed.length) return { menus: created_menus, rights: created_rights };

	const menus = store.has('menu-management')
		? await collect_scan(store, 'menu-management')
		: [];
	const rights = store.has('access-rights')
		? await collect_scan(store, 'access-rights')
		: [];
	const ref_to_id = new Map<string, string>();
	for (const row of menus) {
		const ref = String(row._ref ?? '');
		const id = row_id(row);
		if (ref && id) ref_to_id.set(ref, id);
	}

	for (const sub of installed) {
		if (!store.has('menu-management')) break;
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

	return { menus: created_menus, rights: created_rights };
}
