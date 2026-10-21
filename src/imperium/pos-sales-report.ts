/**
 * Ventas por artículo y utilidad a partir de los tickets POS: cantidad,
 * importe, costo estimado con el costo promedio de compra del producto,
 * utilidad y margen. Las devoluciones restan.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { kardex_bounds, type KardexRange } from './inventory-kardex.ts';
import type { ImperiumStore } from './store.ts';

const CANCELED = new Set(['cancelado', 'canceled', 'cancelled']);

export type SalesByProductRow = {
	producto_id: string;
	codigo: string;
	nombre: string;
	cantidad: number;
	importe: number;
	costo: number;
	utilidad: number;
	margen_pct: number | null;
	tickets: number;
};

export type SalesByProduct = {
	desde: string | null;
	hasta: string | null;
	total_tickets: number;
	cantidad: number;
	importe: number;
	costo: number;
	utilidad: number;
	margen_pct: number | null;
	articulos: SalesByProductRow[];
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function round(value: number, digits = 2): number {
	return Number((Number(value) || 0).toFixed(digits));
}

function margin(utilidad: number, importe: number): number | null {
	return importe ? round((utilidad / importe) * 100) : null;
}

function ticket_time(ticket: ImperiumDoc): number {
	const t = new Date(String(ticket.createdAt ?? ticket.created_at ?? '')).getTime();
	return Number.isNaN(t) ? 0 : t;
}

function ticket_sign(ticket: ImperiumDoc): number {
	if (ticket.is_active === false) return 0;
	if (CANCELED.has(text(ticket.state ?? ticket.estado).toLowerCase())) return 0;
	const type = text(ticket.ticket_type).toUpperCase() || 'VENTA';
	if (type === 'VENTA') return 1;
	if (type === 'DEVOLUCION') return -1;
	return 0;
}

export function build_sales_by_product(
	tickets: ImperiumDoc[],
	products: Map<string, ImperiumDoc>,
	range: KardexRange = {},
): SalesByProduct {
	const { from, to } = kardex_bounds(range);
	const rows = new Map<string, SalesByProductRow & { ticket_ids: Set<string> }>();
	const counted = new Set<string>();
	for (const ticket of tickets) {
		const sign = ticket_sign(ticket);
		const t = ticket_time(ticket);
		if (!sign || t < from || t > to) continue;
		counted.add(text(ticket._id) || `${counted.size}`);
		for (const raw of as_array(ticket.items)) {
			const item = as_object(raw);
			const id = text(item.item_id ?? item.producto ?? item.product_id);
			const quantity = Number(item.quantity ?? item.cantidad ?? 0) || 0;
			if (!id || !quantity) continue;
			const product = products.get(id);
			const amount = Number(item.total ?? quantity * Number(item.unit_price ?? 0)) || 0;
			const unit_cost = Number(product?.costoCompraPromedio ?? product?.ultimoCostoCompra ?? 0) || 0;
			const row = rows.get(id) ?? {
				producto_id: id,
				codigo: text(product?.codigo),
				nombre: text(product?.name) || text(item.item_name),
				cantidad: 0,
				importe: 0,
				costo: 0,
				utilidad: 0,
				margen_pct: null,
				tickets: 0,
				ticket_ids: new Set<string>(),
			};
			row.cantidad += sign * quantity;
			row.importe += sign * amount;
			row.costo += sign * quantity * unit_cost;
			row.ticket_ids.add(text(ticket._id));
			rows.set(id, row);
		}
	}
	const articulos = [...rows.values()]
		.map(({ ticket_ids, ...row }) => {
			const importe = round(row.importe);
			const costo = round(row.costo);
			const utilidad = round(importe - costo);
			return {
				...row,
				cantidad: round(row.cantidad, 4),
				importe,
				costo,
				utilidad,
				margen_pct: margin(utilidad, importe),
				tickets: ticket_ids.size,
			};
		})
		.sort((a, b) => b.importe - a.importe || a.nombre.localeCompare(b.nombre));
	const importe = round(articulos.reduce((s, r) => s + r.importe, 0));
	const costo = round(articulos.reduce((s, r) => s + r.costo, 0));
	const utilidad = round(importe - costo);
	return {
		desde: text(range.desde) || null,
		hasta: text(range.hasta) || null,
		total_tickets: counted.size,
		cantidad: round(articulos.reduce((s, r) => s + r.cantidad, 0), 4),
		importe,
		costo,
		utilidad,
		margen_pct: margin(utilidad, importe),
		articulos,
	};
}

export async function pos_sales_by_product(
	store: ImperiumStore,
	range: KardexRange & { sesion?: string } = {},
): Promise<SalesByProduct> {
	kardex_bounds(range);
	const tickets: ImperiumDoc[] = [];
	if (store.has('pos-tickets')) {
		const session = text(range.sesion);
		for await (const page of store.scan('pos-tickets', session ? { where: { pos_session: session } } : {})) {
			tickets.push(...page);
		}
	}
	const ids = new Set<string>();
	for (const ticket of tickets) {
		for (const raw of as_array(ticket.items)) {
			const id = text(as_object(raw).item_id);
			if (id) ids.add(id);
		}
	}
	const products = new Map<string, ImperiumDoc>();
	if (ids.size && store.has('products')) {
		const { rows } = await store.find_many('products', {
			ids: [...ids],
			take: ids.size,
			include_inactive: true,
			skip_total: true,
		});
		for (const product of rows) {
			products.set(text(product._id), product);
		}
	}
	return build_sales_by_product(tickets, products, range);
}
