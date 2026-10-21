/**
 * Existencias valorizadas por ubicación: cantidad y valor (cantidad × costo
 * promedio de compra del producto) de cada producto en cada ubicación.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export type ValuationLine = {
	producto_id: string;
	producto_codigo: string;
	producto_nombre: string;
	cantidad: number;
	costo_unitario: number;
	valor: number;
};

export type ValuationLocation = {
	ubicacion_id: string;
	ubicacion_codigo: string;
	productos: number;
	cantidad: number;
	valor: number;
	lineas: ValuationLine[];
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value && typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

function money(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

function qty(value: number): number {
	return Number(value.toFixed(4));
}

function unit_cost(product: ImperiumDoc | undefined): number {
	return Number(product?.costoCompraPromedio ?? 0) || Number(product?.ultimoCostoCompra ?? 0) || 0;
}

export function build_valuation(
	quants: ImperiumDoc[],
	products: Map<string, ImperiumDoc>,
	ubicacion = '',
) {
	const wanted = text(ubicacion);
	const locations = new Map<string, ValuationLocation & { by_product: Map<string, ValuationLine> }>();
	for (const q of quants) {
		if (q.is_active === false) continue;
		const cantidad = Number(q.cantidad ?? 0) || 0;
		if (!cantidad) continue;
		const loc_id = ref_id(q.ubicacion) || text(q.ubicacion_id);
		if (wanted && loc_id !== wanted) continue;
		const pid = ref_id(q.producto) || text(q.producto_id);
		const product = products.get(pid);
		const loc = locations.get(loc_id) ?? {
			ubicacion_id: loc_id,
			ubicacion_codigo: text(q.ubicacion_codigo) || 'Sin ubicación',
			productos: 0,
			cantidad: 0,
			valor: 0,
			lineas: [],
			by_product: new Map(),
		};
		const cost = unit_cost(product);
		const line = loc.by_product.get(pid) ?? {
			producto_id: pid,
			producto_codigo: text(product?.codigo) || text(q.producto_codigo),
			producto_nombre: text(product?.name) || text(q.producto_nombre),
			cantidad: 0,
			costo_unitario: money(cost),
			valor: 0,
		};
		line.cantidad = qty(line.cantidad + cantidad);
		line.valor = money(line.cantidad * cost);
		loc.by_product.set(pid, line);
		locations.set(loc_id, loc);
	}
	const ubicaciones = [...locations.values()]
		.map(({ by_product, ...loc }) => {
			const lineas = [...by_product.values()].sort((a, b) => b.valor - a.valor || a.producto_nombre.localeCompare(b.producto_nombre));
			return {
				...loc,
				productos: lineas.length,
				cantidad: qty(lineas.reduce((s, l) => s + l.cantidad, 0)),
				valor: money(lineas.reduce((s, l) => s + l.valor, 0)),
				lineas,
			};
		})
		.sort((a, b) => a.ubicacion_codigo.localeCompare(b.ubicacion_codigo));
	return {
		ubicaciones: ubicaciones.length,
		valor: money(ubicaciones.reduce((s, u) => s + u.valor, 0)),
		detalle: ubicaciones,
	};
}

export async function stock_valuation(store: ImperiumStore, ubicacion = '') {
	const quants: ImperiumDoc[] = [];
	if (store.has('inventory-stock-quant')) {
		for await (const page of store.scan('inventory-stock-quant', {})) quants.push(...page);
	}
	const products = new Map<string, ImperiumDoc>();
	if (store.has('products')) {
		for await (const page of store.scan('products', { include_inactive: true })) {
			for (const p of page) products.set(text(p._id), p);
		}
	}
	return build_valuation(quants, products, ubicacion);
}
