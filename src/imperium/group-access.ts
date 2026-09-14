/**
 * Grupos sembrados y transiciones de pedido. Espejo de
 * `backend/src/components/pedidos/group-access.utils.ts`.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const SEED_ADMIN_REF = 'user-menu-management-0';
export const GROUP_REF_VENDEDORES = 'user-group-vendedores';
export const GROUP_REF_VENTAS = 'user-group-ventas';
export const GROUP_REF_ALMACEN = 'user-group-almacen';
export const GROUP_REF_SURTIDORES = 'user-group-surtidores';
export const GROUP_REF_LOGISTICA = 'user-group-logistica';
export const GROUP_REF_CHOFERES = 'user-group-choferes';

const TRANSITION_GROUPS: Record<string, string[]> = {
	'confirmado->por_surtir': [GROUP_REF_VENTAS],
	'por_surtir->surtiendo': [GROUP_REF_ALMACEN, GROUP_REF_SURTIDORES],
	'surtiendo->surtido': [GROUP_REF_ALMACEN, GROUP_REF_SURTIDORES],
};

export function is_seed_admin(actor: ImperiumDoc | null): boolean {
	return String(actor?._ref ?? actor?.ref ?? '') === SEED_ADMIN_REF;
}

export function collect_group_menu_ids(
	groups: Array<{ menus_ids?: unknown }>,
): string[] {
	const ids = new Set<string>();
	for (const group of groups) {
		for (const id of id_list(group.menus_ids)) {
			ids.add(id);
		}
	}
	return [...ids];
}

export function access_has_full_admin_scope(
	access: { has_full_access?: boolean } | null | undefined,
): boolean {
	return access?.has_full_access === true;
}

export type MenuAccessSlice = {
	has_full_access?: boolean;
	has_user_groups?: boolean;
	menu_ids?: string[];
	models?: string[];
	permissions_by_model?: Record<string, { allow_update?: boolean }>;
};

/** Quien puede escribir grupos ve el catálogo entero de menús en el picker. */
export function can_manage_user_groups(access: MenuAccessSlice | null | undefined): boolean {
	if (access_has_full_admin_scope(access)) return true;
	const perms = access?.permissions_by_model ?? {};
	for (const [model, flags] of Object.entries(perms)) {
		if (model.replace(/[^A-Za-z0-9]/g, '').toLowerCase() !== 'usergroup') continue;
		if (flags.allow_update) return true;
	}
	return false;
}

/**
 * Menús del launcher: con grupos, solo `menus_ids`; un AccessRights amplio
 * no pinta todos los menús del modelo. Sin modelo en ACL se oculta (ticket 63).
 */
export function filter_menus_for_access<
	T extends { _id?: unknown; parent_id?: unknown; model?: unknown },
>(rows: T[], access: MenuAccessSlice): T[] {
	if (access_has_full_admin_scope(access)) return rows;
	const assigned = new Set((access.menu_ids ?? []).map(String).filter(Boolean));
	const models = new Set((access.models ?? []).map(String).filter(Boolean));
	let filtered: T[];
	if (access.has_user_groups) {
		if (!assigned.size) return [];
		filtered = rows.filter((row) => assigned.has(String(row._id ?? '')));
	} else {
		filtered = rows.filter((row) => {
			const mid = String(row._id ?? '');
			const model = String(row.model ?? '').trim();
			return assigned.has(mid) || (model !== '' && models.has(model));
		});
	}
	filtered = filtered.filter((row) => {
		const model = String(row.model ?? '').trim();
		if (!model) return true;
		return models.has(model);
	});
	const by_id = new Map(rows.map((row) => [String(row._id ?? ''), row]));
	const keep = new Map(filtered.map((row) => [String(row._id ?? ''), row]));
	for (const row of [...keep.values()]) {
		let pid = row.parent_id ? String(row.parent_id) : '';
		while (pid && !keep.has(pid) && by_id.has(pid)) {
			const parent = by_id.get(pid)!;
			keep.set(pid, parent);
			pid = parent.parent_id ? String(parent.parent_id) : '';
		}
	}
	return [...keep.values()];
}

/**
 * `reshape_subject_menus` materializa apps instaladas del catálogo.
 * Tras el ACL, solo quedan las filas permitidas y las carpetas padre
 * que las agrupan — no las raíces sintéticas del resto de subjects.
 */
export function keep_reshaped_menus_for_access<
	T extends { _id?: unknown; parent_id?: unknown },
>(allowed_rows: T[], reshaped: T[]): T[] {
	const allowed_ids = new Set(
		allowed_rows.map((row) => String(row._id ?? '')).filter(Boolean),
	);
	if (!allowed_ids.size) return [];
	const by_id = new Map(reshaped.map((row) => [String(row._id ?? ''), row]));
	const keep = new Map<string, T>();
	for (const row of reshaped) {
		const id = String(row._id ?? '');
		if (allowed_ids.has(id)) keep.set(id, row);
	}
	for (const row of [...keep.values()]) {
		let pid = row.parent_id ? String(row.parent_id) : '';
		while (pid && !keep.has(pid) && by_id.has(pid)) {
			const parent = by_id.get(pid)!;
			keep.set(pid, parent);
			pid = parent.parent_id ? String(parent.parent_id) : '';
		}
	}
	return reshaped.filter((row) => keep.has(String(row._id ?? '')));
}

function id_list(value: unknown): string[] {
	return as_array(value)
		.map((item) => {
			if (item && typeof item === 'object') {
				const rec = item as Record<string, unknown>;
				return String(rec._id ?? rec.id ?? '');
			}
			return String(item ?? '');
		})
		.filter(Boolean);
}

export async function actor_group_refs(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
): Promise<string[]> {
	if (!store.has('user-group')) return [];
	const uid = String(actor?._id ?? '');
	if (!uid) return [];
	const refs: string[] = [];
	for await (const page of store.scan('user-group', {
		mongo_match: { user_ids: { $regex: uid } },
		include_inactive: false,
	})) {
		for (const group of page) {
			if (!id_list(group.user_ids).includes(uid)) continue;
			const ref = String(group._ref ?? group.ref ?? '');
			if (ref) refs.push(ref);
		}
	}
	return refs;
}

export async function assert_state_transition_allowed(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	prev_estado?: string,
	next_estado?: string,
): Promise<void> {
	if (!next_estado || next_estado === prev_estado) return;
	if (is_seed_admin(actor)) return;
	const required = TRANSITION_GROUPS[`${prev_estado}->${next_estado}`];
	if (!required) return;
	const refs = await actor_group_refs(store, actor);
	if (!required.some((group) => refs.includes(group))) {
		throw new Error(
			`No tienes permiso para cambiar el pedido de "${prev_estado}" a "${next_estado}". Esta acción está reservada al grupo correspondiente.`,
		);
	}
}

export async function assert_pedido_create_estado(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	requested_estado?: string,
): Promise<void> {
	if (!requested_estado) return;
	if (['borrador', 'confirmado'].includes(requested_estado)) return;
	if (is_seed_admin(actor)) return;
	const refs = await actor_group_refs(store, actor);
	if (!refs.includes(GROUP_REF_VENTAS) && !refs.includes(GROUP_REF_ALMACEN)) {
		throw new Error(
			`No puedes crear un pedido directamente en estado "${requested_estado}".`,
		);
	}
}
