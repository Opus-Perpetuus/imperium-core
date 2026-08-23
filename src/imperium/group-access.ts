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
	const { rows } = await store.find_many('user-group', {
		mongo_match: { user_ids: { $regex: uid } },
		take: 20000,
		include_inactive: false,
	});
	return rows
		.filter((group) => id_list(group.user_ids).includes(uid))
		.map((group) => String(group._ref ?? group.ref ?? ''))
		.filter(Boolean);
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
