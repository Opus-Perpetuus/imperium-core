/**
 * Clientes por vendedor (#291): un vendedor solo ve los contactos que tiene
 * asignados en `contacto.usuariosAsignados`. Se aplica en el alcance del CRUD
 * (lista, detalle, búsquedas, valores de campo, editar y borrar), así que el
 * front no lo puede saltar.
 *
 * Quién queda acotado: un miembro del grupo Vendedores que no esté también en
 * Ventas ni pueda administrar grupos de usuario. El administrador y los roles
 * superiores siguen viendo todo.
 */
import type { ImperiumDoc } from './envelope.ts';
import {
	GROUP_REF_VENDEDORES,
	GROUP_REF_VENTAS,
	can_manage_user_groups,
	type MenuAccessSlice,
} from './group-access.ts';

export const CONTACTO_ASIGNADOS_FIELD = 'usuariosAsignados';

export type VendedorAccess = MenuAccessSlice & { user_group_refs?: string[] };

export function vendedor_ve_solo_sus_clientes(access: VendedorAccess | null | undefined): boolean {
	if (!access || access.has_full_access) return false;
	const refs = access.user_group_refs ?? [];
	if (!refs.includes(GROUP_REF_VENDEDORES)) return false;
	if (refs.includes(GROUP_REF_VENTAS)) return false;
	return !can_manage_user_groups(access);
}

/**
 * Filtro Mongo-like para `contacto`, o null si el actor ve todo. La celda puede
 * venir como arreglo JSON (`["id"]`), id suelto o lista separada por comas: un
 * id de 24 hex dentro del texto basta (mismo criterio que `user-group.user_ids`).
 */
export function contacto_vendedor_match(
	resource: string,
	access: VendedorAccess | null | undefined,
	actor: ImperiumDoc | null,
): Record<string, unknown> | null {
	if (resource !== 'contacto') return null;
	if (!vendedor_ve_solo_sus_clientes(access)) return null;
	const uid = String(actor?._id ?? '').trim();
	if (!uid) return { _id: { $in: [] } };
	return { [CONTACTO_ASIGNADOS_FIELD]: { $regex: uid.replace(/[^A-Za-z0-9_-]/g, '') } };
}

export function and_match(
	a: Record<string, unknown> | null,
	b: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!a) return b;
	if (!b) return a;
	return { $and: [a, b] };
}

function asignados_de(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean);
	const text = String(value ?? '').trim();
	if (!text) return [];
	if (text.startsWith('[')) {
		try {
			return asignados_de(JSON.parse(text));
		} catch {
			// celda legada que no es JSON: se trata como lista separada por comas
		}
	}
	return text.split(',').map((v) => v.replace(/["[\]\s]/g, '')).filter(Boolean);
}

/**
 * Un vendedor acotado que da de alta un cliente queda asignado a él; si no,
 * el contacto recién creado le desaparecería de la lista.
 */
export function con_vendedor_asignado(
	doc: ImperiumDoc,
	access: VendedorAccess | null | undefined,
	actor: ImperiumDoc | null,
): ImperiumDoc {
	if (!vendedor_ve_solo_sus_clientes(access)) return doc;
	const uid = String(actor?._id ?? '').trim();
	if (!uid) return doc;
	const actuales = asignados_de(doc[CONTACTO_ASIGNADOS_FIELD]);
	if (actuales.includes(uid)) return doc;
	return { ...doc, [CONTACTO_ASIGNADOS_FIELD]: [...actuales, uid] };
}
