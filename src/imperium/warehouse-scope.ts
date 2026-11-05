/**
 * Almacén como alcance de existencia. Un almacén es una ubicación interna de
 * tipo `almacen`; su existencia es la suma de las filas de
 * `inventory-stock-quant` en él y en todas sus sububicaciones.
 *
 * - `inventory-internal-location.sucursal`: sucursal dueña del almacén (el POS
 *   de esa sucursal vende de ahí).
 * - `user.almacen`: almacén del vendedor (sus pedidos, también los offline,
 *   se surten de ahí; el modo offline descarga su existencia).
 * - `pedidos.almacen`: almacén del que sale el pedido; se fija al crearlo.
 *
 * Sin almacén configurado todo sigue como antes: existencia global del
 * producto y faltantes al almacén general.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const GENERAL_WAREHOUSE_REF = 'inventory-internal-location-warehouse';

function round_quantity(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

export type WarehouseScope = {
	almacen: ImperiumDoc;
	/** Ids del almacén y de todas sus sububicaciones. */
	ids: Set<string>;
};

export function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

export function is_general_warehouse(location: ImperiumDoc | null | undefined): boolean {
	const ref = String(location?._ref ?? location?.ref ?? '');
	return ref === GENERAL_WAREHOUSE_REF;
}

/** Alcance del almacén `almacen_id`, o null si no existe o no se indicó. */
export async function warehouse_scope(
	store: ImperiumStore,
	almacen_id: unknown,
): Promise<WarehouseScope | null> {
	const id = ref_id(almacen_id);
	if (!id || !store.has('inventory-internal-location')) return null;
	const almacen = await store.find_id('inventory-internal-location', id);
	if (!almacen) return null;
	const children = new Map<string, string[]>();
	for await (const page of store.scan('inventory-internal-location', { include_inactive: true })) {
		for (const row of page) {
			const parent = ref_id(row.parent);
			if (!parent) continue;
			const list = children.get(parent) ?? [];
			list.push(String(row._id));
			children.set(parent, list);
		}
	}
	const ids = new Set<string>([id]);
	const queue = [id];
	while (queue.length) {
		for (const child of children.get(queue.shift()!) ?? []) {
			if (ids.has(child)) continue;
			ids.add(child);
			queue.push(child);
		}
	}
	return { almacen, ids };
}

/** Almacén de la sucursal: la ubicación tipo `almacen` ligada a ella de menor nivel. */
export async function branch_warehouse_id(store: ImperiumStore, branch_id: unknown): Promise<string> {
	const branch = ref_id(branch_id);
	if (!branch || !store.has('inventory-internal-location')) return '';
	const { rows } = await store.find_many('inventory-internal-location', {
		where: { sucursal: branch },
		take: 50,
		populate: false,
	});
	const almacenes = rows
		.filter((row) => row.is_active !== false && String(row.tipo ?? 'almacen') === 'almacen')
		.sort((a, b) => Number(a.nivel ?? 0) - Number(b.nivel ?? 0));
	return almacenes[0]?._id ? String(almacenes[0]._id) : '';
}

/** Almacén guardado en el pedido, o el del vendedor si el documento no trae uno. */
export async function pedido_warehouse_id(
	store: ImperiumStore,
	pedido: { almacen?: unknown; usuario?: unknown } | null | undefined,
): Promise<string> {
	const stored = ref_id(pedido?.almacen);
	if (stored) return stored;
	return user_warehouse_id(store, pedido?.usuario);
}

/** Almacén asignado al usuario (vendedor). */
export async function user_warehouse_id(store: ImperiumStore, user: unknown): Promise<string> {
	if (user && typeof user === 'object' && 'almacen' in (user as object)) {
		return ref_id((user as ImperiumDoc).almacen);
	}
	const id = ref_id(user);
	if (!id || !store.has('user')) return '';
	const doc = await store.find_id('user', id);
	return ref_id(doc?.almacen);
}

/**
 * Almacén de una venta POS: el de la sucursal de la sesión de caja; si la
 * sucursal no tiene almacén, el del usuario que vende.
 */
export async function pos_ticket_warehouse_id(
	store: ImperiumStore,
	ticket: ImperiumDoc,
): Promise<string> {
	const session_id = ref_id(ticket.pos_session);
	if (session_id && store.has('pos-session')) {
		const session = await store.find_id('pos-session', session_id);
		const by_branch = await branch_warehouse_id(store, session?.branch_office);
		if (by_branch) return by_branch;
	}
	return user_warehouse_id(store, ticket.created_by);
}

async function product_quants(store: ImperiumStore, producto: string): Promise<ImperiumDoc[]> {
	if (!producto || !store.has('inventory-stock-quant')) return [];
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan('inventory-stock-quant', {
		where: { producto },
		include_inactive: true,
	})) {
		for (const row of page) {
			if (ref_id(row.producto) === producto) out.push(row);
		}
	}
	return out;
}

function quant_libre(row: ImperiumDoc): number {
	if (row.cantidad_disponible != null && row.cantidad_disponible !== '') {
		return Number(row.cantidad_disponible);
	}
	return Number(row.cantidad ?? 0) - Number(row.cantidad_apartada ?? 0);
}

/**
 * Existencia del producto dentro del almacén. `libre` descuenta lo apartado.
 * Un producto sin ninguna fila por ubicación tiene toda su existencia en el
 * almacén general.
 */
export async function scope_stock(
	store: ImperiumStore,
	product: ImperiumDoc,
	scope: WarehouseScope,
	opts: { libre?: boolean } = {},
): Promise<number> {
	const producto = String(product._id ?? '');
	const quants = await product_quants(store, producto);
	if (!quants.length) {
		if (!is_general_warehouse(scope.almacen)) return 0;
		const total = Number(product.existencia ?? 0);
		const apartado = opts.libre ? Math.max(Number(product.existenciaApartada ?? 0), 0) : 0;
		return round_quantity(total - apartado);
	}
	let total = 0;
	for (const row of quants) {
		if (!scope.ids.has(ref_id(row.ubicacion))) continue;
		total += opts.libre ? quant_libre(row) : Number(row.cantidad ?? 0);
	}
	return round_quantity(total);
}

/**
 * Existencia libre por producto en el almacén, para el modo offline. Solo
 * trae productos con existencia en el almacén; el resto tiene 0.
 */
export async function scope_stock_snapshot(
	store: ImperiumStore,
	scope: WarehouseScope,
): Promise<Array<{ producto: string; cantidad: number }>> {
	const by_product = new Map<string, number>();
	const con_filas = new Set<string>();
	if (store.has('inventory-stock-quant')) {
		for await (const page of store.scan('inventory-stock-quant', { include_inactive: true })) {
			for (const row of page) {
				const producto = ref_id(row.producto);
				if (!producto) continue;
				con_filas.add(producto);
				if (!scope.ids.has(ref_id(row.ubicacion))) continue;
				by_product.set(producto, (by_product.get(producto) ?? 0) + quant_libre(row));
			}
		}
	}
	if (is_general_warehouse(scope.almacen) && store.has('products')) {
		for await (const page of store.scan('products', {})) {
			for (const product of page) {
				const id = String(product._id ?? '');
				if (!id || con_filas.has(id)) continue;
				const libre =
					Number(product.existencia ?? 0) - Math.max(Number(product.existenciaApartada ?? 0), 0);
				if (libre) by_product.set(id, libre);
			}
		}
	}
	return [...by_product.entries()].map(([producto, cantidad]) => ({
		producto,
		cantidad: round_quantity(cantidad),
	}));
}

/**
 * Almacén al que pertenece una ubicación: el ancestro más cercano (o ella
 * misma) que es almacén de una sucursal, de un vendedor, el almacén general o
 * la raíz del árbol.
 */
export async function owning_warehouse(
	store: ImperiumStore,
	location_id: unknown,
): Promise<ImperiumDoc | null> {
	const id = ref_id(location_id);
	if (!id || !store.has('inventory-internal-location')) return null;
	const by_id = new Map<string, ImperiumDoc>();
	for await (const page of store.scan('inventory-internal-location', { include_inactive: true })) {
		for (const row of page) by_id.set(String(row._id), row);
	}
	const de_vendedor = new Set<string>();
	if (store.has('user')) {
		for await (const page of store.scan('user', {})) {
			for (const user of page) {
				const almacen = ref_id(user.almacen);
				if (almacen) de_vendedor.add(almacen);
			}
		}
	}
	let current = by_id.get(id) ?? null;
	const seen = new Set<string>();
	while (current) {
		const current_id = String(current._id);
		if (seen.has(current_id)) break;
		seen.add(current_id);
		if (ref_id(current.sucursal) || is_general_warehouse(current) || de_vendedor.has(current_id)) {
			return current;
		}
		const parent = by_id.get(ref_id(current.parent));
		if (!parent) return current;
		current = parent;
	}
	return current;
}
