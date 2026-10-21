/**
 * Productos en o bajo su mínimo y la cantidad sugerida para llegar al
 * máximo (o al mínimo si no tiene máximo), agrupables por proveedor.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export type ReplenishmentRow = {
	producto_id: string;
	codigo: string;
	nombre: string;
	unidad: string;
	proveedor_id: string;
	proveedor_nombre: string;
	existencia: number;
	apartado: number;
	disponible: number;
	minimo: number;
	maximo: number | null;
	sugerido: number;
	costo_unitario: number;
	importe_estimado: number;
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function num(value: unknown): number {
	const n = Number(String(value ?? '').replace(',', '.'));
	return Number.isFinite(n) ? n : 0;
}

function qty(value: number): number {
	return Number(value.toFixed(4));
}

function ref_id(value: unknown): string {
	if (value && typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

/** `null` si el producto no está en o bajo su mínimo o no tiene mínimo. */
export function replenishment_row(product: ImperiumDoc): ReplenishmentRow | null {
	const minimo = num(product.stockMinimo);
	if (!(minimo > 0)) return null;
	const existencia = num(product.existencia);
	const apartado = num(product.existenciaApartada);
	const disponible = qty(existencia - apartado);
	if (disponible > minimo) return null;
	const raw_max = num(product.stockMaximo);
	const maximo = raw_max > 0 ? raw_max : null;
	const objetivo = maximo != null && maximo > minimo ? maximo : minimo;
	const sugerido = qty(Math.max(objetivo - disponible, 0));
	const costo_unitario = num(product.ultimoCostoCompra) || num(product.costoCompraPromedio);
	return {
		producto_id: text(product._id),
		codigo: text(product.codigo),
		nombre: text(product.name),
		unidad: text(product.unidad),
		proveedor_id: ref_id(product.proveedor),
		proveedor_nombre: text(product.proveedor_nombre),
		existencia: qty(existencia),
		apartado: qty(apartado),
		disponible,
		minimo,
		maximo,
		sugerido,
		costo_unitario: Number(costo_unitario.toFixed(2)),
		importe_estimado: Number((sugerido * costo_unitario).toFixed(2)),
	};
}

export function build_replenishment(products: ImperiumDoc[], proveedor = ''): {
	total_productos: number;
	importe_estimado: number;
	productos: ReplenishmentRow[];
} {
	const wanted = text(proveedor);
	const productos = products
		.filter((p) => p.is_active !== false && p.puedoComprarlo !== false)
		.map(replenishment_row)
		.filter((row): row is ReplenishmentRow => row != null)
		.filter((row) => !wanted || row.proveedor_id === wanted)
		.sort(
			(a, b) =>
				a.proveedor_nombre.localeCompare(b.proveedor_nombre) ||
				a.disponible - a.minimo - (b.disponible - b.minimo) ||
				a.nombre.localeCompare(b.nombre),
		);
	return {
		total_productos: productos.length,
		importe_estimado: Number(productos.reduce((s, r) => s + r.importe_estimado, 0).toFixed(2)),
		productos,
	};
}

export async function products_to_replenish(store: ImperiumStore, proveedor = '') {
	const products: ImperiumDoc[] = [];
	if (store.has('products')) {
		for await (const page of store.scan('products', {})) products.push(...page);
	}
	return build_replenishment(products, proveedor);
}
