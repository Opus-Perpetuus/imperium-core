/**
 * Conteo de solo lectura para el seguimiento de #349: órdenes confirmadas antes
 * del arreglo dejaron su recepción abierta (`pendiente`/`parcial`) con lo que la
 * orden ya registra como recibido, así que «en camino» lo cuenta dos veces.
 * Aquí solo se lee: no hay modo de corrección.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

/** Los mismos estados que suma `in_transit_for_product`. */
export const EN_CAMINO_STATES = ['pendiente', 'parcial'] as const;

export type DriftLine = {
	producto: string;
	producto_nombre: string;
	pendiente_orden: number;
	pendiente_recepciones: number;
	excedente: number;
};

export type DriftOrder = {
	orden_id: string;
	orden_nombre: string;
	estado_orden: string;
	recepciones: string[];
	lineas: DriftLine[];
	excedente: number;
};

export type DriftReport = {
	recepciones_abiertas: number;
	ordenes_revisadas: number;
	ordenes_afectadas: number;
	recepciones_afectadas: number;
	excedente_total: number;
	recepciones_sin_orden: string[];
	afectadas: DriftOrder[];
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function num(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function is_en_camino(reception: ImperiumDoc): boolean {
	return (
		reception.is_active !== false &&
		(EN_CAMINO_STATES as readonly string[]).includes(text(reception.estado))
	);
}

export function reception_order_id(reception: ImperiumDoc): string {
	return ref_id(reception.purchase_order) || ref_id(reception.orden_compra);
}

/**
 * Por producto: lo que las recepciones abiertas de la orden siguen esperando
 * contra lo que de verdad le falta a la orden. Lo que sobra es lo que «en
 * camino» cuenta de más.
 */
export function order_drift(po: ImperiumDoc, receptions: ImperiumDoc[]): DriftOrder | null {
	const open = receptions.filter(is_en_camino);
	if (!open.length) return null;
	const po_pending = new Map<string, number>();
	const names = new Map<string, string>();
	for (const raw of as_array(po.articulos)) {
		const item = as_object(raw);
		const producto = ref_id(item.producto ?? item.product_id);
		if (!producto) continue;
		const pending = Math.max(0, num(item.cantidad) - num(item.cantidad_recibida));
		po_pending.set(producto, round_qty((po_pending.get(producto) ?? 0) + pending));
		names.set(producto, text(item.producto_nombre ?? item.name));
	}
	const rec_pending = new Map<string, number>();
	const rec_with_product = new Map<string, Set<string>>();
	for (const reception of open) {
		for (const raw of as_array(reception.articulos)) {
			const item = as_object(raw);
			const producto = ref_id(item.producto);
			if (!producto) continue;
			const pending = Math.max(0, num(item.cantidad_esperada) - num(item.cantidad_recibida));
			if (pending <= 0) continue;
			rec_pending.set(producto, round_qty((rec_pending.get(producto) ?? 0) + pending));
			if (!names.get(producto)) names.set(producto, text(item.producto_nombre));
			const ids = rec_with_product.get(producto) ?? new Set<string>();
			ids.add(text(reception._id));
			rec_with_product.set(producto, ids);
		}
	}
	const lineas: DriftLine[] = [];
	const recepciones = new Set<string>();
	for (const [producto, pendiente_recepciones] of rec_pending) {
		const pendiente_orden = po_pending.get(producto) ?? 0;
		const excedente = round_qty(pendiente_recepciones - pendiente_orden);
		if (excedente <= 1e-6) continue;
		lineas.push({
			producto,
			producto_nombre: names.get(producto) ?? '',
			pendiente_orden,
			pendiente_recepciones,
			excedente,
		});
		for (const id of rec_with_product.get(producto) ?? []) recepciones.add(id);
	}
	if (!lineas.length) return null;
	return {
		orden_id: text(po._id),
		orden_nombre: text(po.name),
		estado_orden: text(po.estado),
		recepciones: [...recepciones].sort(),
		lineas,
		excedente: round_qty(lineas.reduce((sum, line) => sum + line.excedente, 0)),
	};
}

/** Solo usa lecturas del store (`scan` y `find_id`). */
export async function count_double_counted_receptions(store: ImperiumStore): Promise<DriftReport> {
	const by_order = new Map<string, ImperiumDoc[]>();
	const recepciones_sin_orden: string[] = [];
	let recepciones_abiertas = 0;
	for await (const page of store.scan('inventory-reception', {
		where: { estado: { in: [...EN_CAMINO_STATES] } },
		include_inactive: false,
	})) {
		for (const reception of page) {
			if (!is_en_camino(reception)) continue;
			recepciones_abiertas += 1;
			const po_id = reception_order_id(reception);
			if (!po_id) continue;
			by_order.set(po_id, [...(by_order.get(po_id) ?? []), reception]);
		}
	}
	const afectadas: DriftOrder[] = [];
	for (const [po_id, receptions] of by_order) {
		const po = await store.find_id('purchase-order', po_id);
		if (!po) {
			recepciones_sin_orden.push(...receptions.map((r) => text(r._id)));
			continue;
		}
		const drift = order_drift(po, receptions);
		if (drift) afectadas.push(drift);
	}
	afectadas.sort((a, b) => a.orden_nombre.localeCompare(b.orden_nombre) || a.orden_id.localeCompare(b.orden_id));
	return {
		recepciones_abiertas,
		ordenes_revisadas: by_order.size,
		ordenes_afectadas: afectadas.length,
		recepciones_afectadas: new Set(afectadas.flatMap((o) => o.recepciones)).size,
		excedente_total: round_qty(afectadas.reduce((sum, o) => sum + o.excedente, 0)),
		recepciones_sin_orden: recepciones_sin_orden.sort(),
		afectadas,
	};
}
