/**
 * Al guardar un permiso (access-rights) con Grupo, que también quede en la
 * lista «Permisos de acceso» del grupo (user-group.access_rights_ids).
 *
 * Sin esto el permiso queda desconectado del formulario del grupo: en
 * imperium-v13 (13.78.5) «Acceso: PurchaseRequest | Ventas» tenía grupo pero
 * no estaba en la lista de Ventas y daba 403 en Solicitudes de compra (#157).
 * Solo agrega; no quita el permiso de otros grupos a los que se haya ligado.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

function ref_text(value: unknown): string {
	if (value && typeof value === 'object') {
		const rec = value as Record<string, unknown>;
		return String(rec._id ?? rec.id ?? '').trim();
	}
	return String(value ?? '').trim();
}

function id_list(value: unknown): string[] {
	return as_array(value).map(ref_text).filter(Boolean);
}

async function find_group(store: ImperiumStore, gid: string): Promise<ImperiumDoc | null> {
	const by_id = await store.find_id('user-group', gid).catch(() => null);
	if (by_id) return by_id;
	return (await store.find_where('user-group', { _ref: gid })) ?? null;
}

/**
 * El datalist del permiso compara `group_id` con el `_id` del grupo.
 * Los seeds guardan el `_ref` (o a veces el grupo poblado).
 */
export async function access_right_group_for_form(
	store: ImperiumStore,
	right: ImperiumDoc,
): Promise<ImperiumDoc> {
	if (!store.has('user-group')) return right;
	const gid = ref_text(right.group_id);
	if (!gid) return right;
	const group = await find_group(store, gid);
	const id = ref_text(group?._id);
	if (!id || right.group_id === id) return right;
	return { ...right, group_id: id };
}

/** Devuelve el grupo actualizado, o null si no hubo que tocar nada. */
export async function link_access_right_to_group(
	store: ImperiumStore,
	right: ImperiumDoc | null | undefined,
): Promise<ImperiumDoc | null> {
	if (!right || !store.has('user-group')) return null;
	const rid = ref_text(right._id);
	const gid = ref_text(right.group_id);
	if (!rid || !gid) return null;
	const group = await find_group(store, gid);
	if (!group) return null;
	const ids = id_list(group.access_rights_ids);
	if (ids.includes(rid)) return null;
	return store.update('user-group', ref_text(group._id), {
		access_rights_ids: [...ids, rid],
	});
}
