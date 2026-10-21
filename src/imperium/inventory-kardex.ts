/**
 * Kárdex de un producto: movimientos de inventario en orden, con entradas,
 * salidas y existencia después de cada uno, más el saldo al inicio del rango.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const ENTRY_TYPES = new Set(['recepcion_compra', 'recepcion_devolucion']);
const EXIT_TYPES = new Set(['salida_entrega']);

export type KardexRange = { desde?: string; hasta?: string };

export type KardexRow = {
	_id: string;
	fecha: string;
	tipo_movimiento: string;
	documento_tipo: string;
	documento: string;
	ubicacion: string;
	entrada: number;
	salida: number;
	existencia: number;
	costo_unitario: number | null;
};

export type Kardex = {
	producto: { _id: string; name: string; codigo: string; unidad: string };
	desde: string | null;
	hasta: string | null;
	saldo_inicial: number;
	total_entradas: number;
	total_salidas: number;
	saldo_final: number;
	costo_promedio: number;
	valor_final: number;
	movimientos: KardexRow[];
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function qty(value: unknown): number {
	return Number((Number(value) || 0).toFixed(4));
}

function money(value: unknown): number {
	return Number((Number(value) || 0).toFixed(2));
}

function finite(value: unknown): number | null {
	if (value == null || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function ref_id(value: unknown): string {
	if (value && typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

function movement_time(row: ImperiumDoc): number {
	const raw = row.fecha_movimiento ?? row.createdAt ?? row.created_at;
	const t = new Date(String(raw ?? '')).getTime();
	return Number.isNaN(t) ? 0 : t;
}

/** Inicio del día de `desde` y fin del día de `hasta`; acepta `YYYY-MM-DD` o ISO. */
export function kardex_bounds(range: KardexRange): { from: number; to: number } {
	const parse = (raw: string | undefined, end: boolean): number | null => {
		const value = text(raw);
		if (!value) return null;
		const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
		const t = new Date(day ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}` : value).getTime();
		if (Number.isNaN(t)) throw new Error(`Fecha inválida: ${value}`);
		return t;
	};
	const from = parse(range.desde, false) ?? Number.NEGATIVE_INFINITY;
	const to = parse(range.hasta, true) ?? Number.POSITIVE_INFINITY;
	if (from > to) throw new Error('La fecha inicial es posterior a la final');
	return { from, to };
}

/**
 * Cambio de existencia total del movimiento. Manda la diferencia
 * resultante − previa que guarda cada movimiento; sin esas columnas se
 * deduce del tipo. Apartados y traslados internos no cambian el total.
 */
export function movement_delta(row: ImperiumDoc): number {
	const before = finite(row.stock_total_previo);
	const after = finite(row.stock_total_resultante);
	if (before != null && after != null) return qty(after - before);
	const tipo = text(row.tipo_movimiento);
	const cantidad = Math.abs(Number(row.cantidad) || 0);
	if (ENTRY_TYPES.has(tipo)) return qty(cantidad);
	if (EXIT_TYPES.has(tipo)) return qty(-cantidad);
	return 0;
}

export function build_kardex(
	product: ImperiumDoc,
	movements: ImperiumDoc[],
	range: KardexRange = {},
): Kardex {
	const { from, to } = kardex_bounds(range);
	const sorted = [...movements].sort((a, b) => movement_time(a) - movement_time(b));
	let saldo = 0;
	let saldo_inicial = 0;
	let entradas = 0;
	let salidas = 0;
	const rows: KardexRow[] = [];
	for (const row of sorted) {
		const t = movement_time(row);
		const delta = movement_delta(row);
		const after = finite(row.stock_total_resultante);
		saldo = after != null ? qty(after) : qty(saldo + delta);
		if (t < from) {
			saldo_inicial = saldo;
			continue;
		}
		if (t > to) break;
		if (!rows.length) {
			const before = finite(row.stock_total_previo);
			saldo_inicial = before != null ? qty(before) : qty(saldo - delta);
		}
		const entrada = delta > 0 ? delta : 0;
		const salida = delta < 0 ? -delta : 0;
		entradas += entrada;
		salidas += salida;
		const cost = finite(row.costo_unitario);
		rows.push({
			_id: text(row._id),
			fecha: new Date(t).toISOString(),
			tipo_movimiento: text(row.tipo_movimiento),
			documento_tipo: text(row.documento_tipo),
			documento: text(row.documento_referencia) || text(row.documento_nombre),
			ubicacion: text(row.ubicacion_destino_nombre) || text(row.ubicacion_origen_nombre),
			entrada: qty(entrada),
			salida: qty(salida),
			existencia: saldo,
			costo_unitario: cost == null ? null : money(cost),
		});
	}
	const saldo_final = rows.length ? rows[rows.length - 1]!.existencia : saldo_inicial;
	const costo_promedio = money(product.costoCompraPromedio ?? product.ultimoCostoCompra ?? 0);
	return {
		producto: {
			_id: text(product._id),
			name: text(product.name),
			codigo: text(product.codigo),
			unidad: text(product.unidad),
		},
		desde: text(range.desde) || null,
		hasta: text(range.hasta) || null,
		saldo_inicial,
		total_entradas: qty(entradas),
		total_salidas: qty(salidas),
		saldo_final,
		costo_promedio,
		valor_final: money(saldo_final * costo_promedio),
		movimientos: rows,
	};
}

export async function product_kardex(
	store: ImperiumStore,
	product_id: string,
	range: KardexRange = {},
): Promise<Kardex> {
	if (!store.has('products')) throw new Error('La app Almacén no está instalada');
	const product = await store.find_id('products', product_id);
	if (!product) throw new Error('El producto no existe');
	const seen = new Map<string, ImperiumDoc>();
	if (store.has('inventory-movement')) {
		for (const where of [{ producto: product_id }, { producto_id: product_id }]) {
			for await (const page of store.scan('inventory-movement', { where })) {
				for (const row of page) {
					if (ref_id(row.producto) !== product_id && text(row.producto_id) !== product_id) continue;
					seen.set(text(row._id) || `${seen.size}`, row);
				}
			}
		}
	}
	return build_kardex(product, [...seen.values()], range);
}
