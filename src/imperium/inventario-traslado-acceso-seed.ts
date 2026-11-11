/**
 * Permisos de movimientos y traslados de inventario para el grupo Almacén.
 *
 * El núcleo no corre las siembras de Express; estas filas se insertan aquí,
 * idempotentes por `_ref`. Si la fila ya existe pero no deja registrar el
 * traslado, se actualizan las banderas (el grupo Almacén sí debe poder
 * trasladar).
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export type AlmacenInventarioAccessRight = {
	_ref: string;
	name: string;
	description: string;
	model_id: string;
	group_id: 'user-group-almacen';
	allow_read: boolean;
	allow_create: boolean;
	allow_update: boolean;
	allow_delete: boolean;
	is_active: true;
};

export const ALMACEN_INVENTARIO_ACCESS_RIGHTS: AlmacenInventarioAccessRight[] = [
	{
		_ref: 'almacen-access-rights-inventory-movement',
		name: 'InventoryMovement | Almacén (crear/actualizar)',
		description: 'Almacén: registrar un traslado entre ubicaciones.',
		model_id: 'InventoryMovement',
		group_id: 'user-group-almacen',
		allow_read: true,
		allow_create: true,
		allow_update: true,
		allow_delete: false,
		is_active: true,
	},
	{
		_ref: 'almacen-access-rights-inventory-stock-quant',
		name: 'InventoryStockQuant | Almacén (leer/actualizar)',
		description: 'Almacén: reparar la existencia del producto contra la suma de ubicaciones.',
		model_id: 'InventoryStockQuant',
		group_id: 'user-group-almacen',
		allow_read: true,
		allow_create: false,
		allow_update: true,
		allow_delete: false,
		is_active: true,
	},
];

type FilaRef = {
	_id?: unknown;
	id?: unknown;
	_ref?: unknown;
	allow_read?: unknown;
	allow_create?: unknown;
	allow_update?: unknown;
	allow_delete?: unknown;
	is_active?: unknown;
};

function flag(value: unknown): boolean {
	return value === true || value === 'true' || value === 1 || value === '1';
}

function row_id(row: FilaRef | null | undefined): string {
	return String(row?._id ?? row?.id ?? '').trim();
}

export function plan_almacen_inventario_access_rights(existing: FilaRef[]): {
	inserts: AlmacenInventarioAccessRight[];
	patches: Array<{ id: string; _ref: string } & Partial<AlmacenInventarioAccessRight>>;
} {
	const by_ref = new Map(
		existing.map((row) => [String(row._ref ?? ''), row] as const).filter(([ref]) => Boolean(ref)),
	);
	const inserts: AlmacenInventarioAccessRight[] = [];
	const patches: Array<{ id: string; _ref: string } & Partial<AlmacenInventarioAccessRight>> = [];
	for (const wanted of ALMACEN_INVENTARIO_ACCESS_RIGHTS) {
		const current = by_ref.get(wanted._ref);
		if (!current) {
			inserts.push({ ...wanted });
			continue;
		}
		const id = row_id(current);
		if (!id) continue;
		const patch: { id: string; _ref: string } & Partial<AlmacenInventarioAccessRight> = {
			id,
			_ref: wanted._ref,
		};
		let dirty = false;
		for (const key of ['allow_read', 'allow_create', 'allow_update', 'allow_delete'] as const) {
			if (flag(current[key]) !== wanted[key]) {
				patch[key] = wanted[key];
				dirty = true;
			}
		}
		if (current.is_active === false || current.is_active === 'false') {
			patch.is_active = true;
			dirty = true;
		}
		if (dirty) patches.push(patch);
	}
	return { inserts, patches };
}

async function collect_scan(store: ImperiumStore, resource: string): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan(resource, { include_inactive: true })) out.push(...page);
	return out;
}

export async function ensure_almacen_traslado_access(
	store: ImperiumStore,
): Promise<{ rights: string[]; patched: string[] }> {
	const rights: string[] = [];
	const patched: string[] = [];
	if (!store.has('access-rights')) return { rights, patched };
	const existing = await collect_scan(store, 'access-rights');
	const plan = plan_almacen_inventario_access_rights(existing);
	for (const row of plan.inserts) {
		await store.insert('access-rights', row);
		rights.push(row._ref);
	}
	for (const patch of plan.patches) {
		const { id, _ref, ...fields } = patch;
		await store.update('access-rights', id, fields);
		patched.push(_ref);
	}
	return { rights, patched };
}
