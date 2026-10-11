/**
 * Permisos de Devoluciones para Choferes, Almacén y Logística, y lectura de la plantilla del ticket de Choferes y Vendedores.
 *
 * El núcleo no corre las siembras de Express y el lector de `module.data`
 * se salta `accesos_flujo()`. Estas filas se insertan aquí, idempotentes
 * por `_ref`, sin pisar las que ya existen.
 */
import type { ImperiumDoc } from './envelope.ts';
import { id_list } from './group-access.ts';
import type { ImperiumStore } from './store.ts';

export const DEVOLUCIONES_MENU_REF = 'delivery-return-menu-management-0';

export const DEVOLUCIONES_MENU_GROUPS = [
	'user-group-choferes',
	'user-group-almacen',
	'user-group-logistica',
] as const;

type GrupoDevolucion = { ref: string; nombre: string; slug: string };

const GRUPOS_DEVOLUCION: GrupoDevolucion[] = [
	{ ref: 'user-group-choferes', nombre: 'Choferes', slug: 'choferes' },
	{ ref: 'user-group-almacen', nombre: 'Almacén', slug: 'almacen' },
	{ ref: 'user-group-logistica', nombre: 'Logística', slug: 'logistica' },
];

export type DevolucionAccessRight = {
	_ref: string;
	name: string;
	description: string;
	model_id: string;
	group_id: string;
	allow_read: boolean;
	allow_create: boolean;
	allow_update: boolean;
	allow_delete: boolean;
	is_active: true;
};

function derecho_devolucion(grupo: GrupoDevolucion): DevolucionAccessRight {
	return {
		_ref: `delivery-return-access-rights-${grupo.slug}`,
		name: `DeliveryReturn | ${grupo.nombre} (crear/leer/firmar)`,
		description: `${grupo.nombre}: crear, leer y firmar el manifiesto de devolución.`,
		model_id: 'DeliveryReturn',
		group_id: grupo.ref,
		allow_read: true,
		allow_create: true,
		allow_update: true,
		allow_delete: false,
		is_active: true,
	};
}

function derecho_firma(grupo: GrupoDevolucion): DevolucionAccessRight {
	return {
		_ref: `attachment-firma-access-rights-${grupo.slug}`,
		name: `AttachmentManagement | ${grupo.nombre} (crear firma)`,
		description: `${grupo.nombre}: crear el adjunto de la firma de conformidad.`,
		model_id: 'AttachmentManagement',
		group_id: grupo.ref,
		allow_read: false,
		allow_create: true,
		allow_update: false,
		allow_delete: false,
		is_active: true,
	};
}

const DERECHO_UBICACIONES: DevolucionAccessRight = {
	_ref: 'almacen-access-rights-inventory-internal-location',
	name: 'InventoryInternalLocation | Almacén (leer/actualizar)',
	description: 'Almacén: importar el árbol de ubicaciones.',
	model_id: 'InventoryInternalLocation',
	group_id: 'user-group-almacen',
	allow_read: true,
	allow_create: false,
	allow_update: true,
	allow_delete: false,
	is_active: true,
};

const DERECHO_PLANTILLA_TICKET_CHOFERES: DevolucionAccessRight = {
	_ref: 'choferes-access-rights-epson-ticket-template',
	name: 'EpsonTicketTemplate | Choferes (leer)',
	description: 'Choferes: leer la plantilla con la que se imprime el ticket de la entrega.',
	model_id: 'EpsonTicketTemplate',
	group_id: 'user-group-choferes',
	allow_read: true,
	allow_create: false,
	allow_update: false,
	allow_delete: false,
	is_active: true,
};

const DERECHO_PLANTILLA_TICKET_VENDEDORES: DevolucionAccessRight = {
	_ref: 'vendedores-access-rights-epson-ticket-template',
	name: 'EpsonTicketTemplate | Vendedores (leer)',
	description: 'Vendedores: leer la plantilla con la que el pedido offline imprime el ticket.',
	model_id: 'EpsonTicketTemplate',
	group_id: 'user-group-vendedores',
	allow_read: true,
	allow_create: false,
	allow_update: false,
	allow_delete: false,
	is_active: true,
};

export type DevolucionRecordRule = DevolucionAccessRight & { domain: string };

const REGLA_PLANTILLA_TICKET_VENDEDORES: DevolucionRecordRule = {
	_ref: 'vendedores-record-rule-epson-offline-order',
	name: 'EpsonTicketTemplate | Vendedores: pedido offline',
	description: 'Vendedores sólo leen la plantilla OFFLINE_ORDER del ticket de pedido offline.',
	is_active: true,
	model_id: 'EpsonTicketTemplate',
	group_id: 'user-group-vendedores',
	domain: JSON.stringify({ template_key: 'OFFLINE_ORDER' }),
	allow_read: true,
	allow_create: false,
	allow_update: false,
	allow_delete: false,
};

export const DEVOLUCIONES_RECORD_RULES = [REGLA_PLANTILLA_TICKET_VENDEDORES];

export const DEVOLUCIONES_ACCESS_RIGHTS: DevolucionAccessRight[] = [
	...GRUPOS_DEVOLUCION.map(derecho_devolucion),
	...GRUPOS_DEVOLUCION.map(derecho_firma),
	DERECHO_UBICACIONES,
	DERECHO_PLANTILLA_TICKET_CHOFERES,
	DERECHO_PLANTILLA_TICKET_VENDEDORES,
];

type FilaRef = { _ref?: unknown };

type FilaId = {
	_id?: unknown;
	id?: unknown;
	_ref?: unknown;
	menus_ids?: unknown;
};

export type MenuGroupPatch = { id: string; menus_ids: string[] };

function row_id(row: { _id?: unknown; id?: unknown } | null | undefined): string {
	return String(row?._id ?? row?.id ?? '').trim();
}

export function plan_devoluciones_access_rights(existing: FilaRef[]): DevolucionAccessRight[] {
	const present = new Set(existing.map((row) => String(row._ref ?? '')).filter(Boolean));
	return DEVOLUCIONES_ACCESS_RIGHTS.filter((row) => !present.has(row._ref)).map((row) => ({
		...row,
	}));
}

export function plan_devoluciones_record_rules(existing: FilaRef[]): DevolucionRecordRule[] {
	const present = new Set(existing.map((row) => String(row._ref ?? '')).filter(Boolean));
	return DEVOLUCIONES_RECORD_RULES.filter((row) => !present.has(row._ref)).map((row) => ({
		...row,
	}));
}

export function plan_devoluciones_menu_groups(
	menus: FilaId[],
	groups: FilaId[],
): MenuGroupPatch[] {
	const menu = menus.find((row) => String(row._ref ?? '') === DEVOLUCIONES_MENU_REF);
	const menu_id = row_id(menu);
	if (!menu_id) return [];
	const by_ref = new Map<string, FilaId>();
	for (const group of groups) {
		const ref = String(group._ref ?? '');
		if (ref && !by_ref.has(ref)) by_ref.set(ref, group);
	}
	const out: MenuGroupPatch[] = [];
	for (const ref of DEVOLUCIONES_MENU_GROUPS) {
		const group = by_ref.get(ref);
		if (!group) continue;
		const id = row_id(group);
		if (!id) continue;
		const current = id_list(group.menus_ids);
		if (current.includes(menu_id)) continue;
		out.push({ id, menus_ids: [...current, menu_id] });
	}
	return out;
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

export async function ensure_devoluciones_access(
	store: ImperiumStore,
): Promise<{ rights: string[]; rules: string[]; groups: string[] }> {
	const rights: string[] = [];
	const rules: string[] = [];
	const groups: string[] = [];
	if (store.has('access-rights')) {
		const existing = await collect_scan(store, 'access-rights', { include_inactive: true });
		for (const row of plan_devoluciones_access_rights(existing)) {
			await store.insert('access-rights', row);
			rights.push(row._ref);
		}
	}
	if (store.has('record-rules')) {
		const existing = await collect_scan(store, 'record-rules', { include_inactive: true });
		for (const row of plan_devoluciones_record_rules(existing)) {
			await store.insert('record-rules', row);
			rules.push(row._ref);
		}
	}
	if (store.has('menu-management') && store.has('user-group')) {
		const menus = await collect_scan(store, 'menu-management', { include_inactive: true });
		const group_rows = await collect_scan(store, 'user-group', { include_inactive: true });
		for (const patch of plan_devoluciones_menu_groups(menus, group_rows)) {
			await store.update('user-group', patch.id, { menus_ids: patch.menus_ids });
			groups.push(patch.id);
		}
	}
	return { rights, rules, groups };
}
