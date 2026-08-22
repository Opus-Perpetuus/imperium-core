/**
 * Tableros dinámicos: visibilidad por fila y dueño, como el service original.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';
import { build_access } from './auth.ts';
import { is_seed_admin } from './group-access.ts';
import type { ImperiumStore } from './store.ts';

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
