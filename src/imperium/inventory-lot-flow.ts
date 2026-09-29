/**
 * Lotes, números de serie y caducidad. Un producto que maneja lote o serie
 * exige capturarlos al recibir; una serie es un lote de una pieza. Las
 * existencias por ubicación llevan el lote (ver `apply_quant_delta`).
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const FECHA = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function flag(value: unknown): boolean {
	return value === true || value === 'true' || value === 1;
}

export type ProductTracking = { lote: boolean; serial: boolean; caducidad: boolean };

export function product_tracking(product: ImperiumDoc | null | undefined): ProductTracking {
	return {
		lote: flag(product?.maneja_lote),
		serial: flag(product?.maneja_serial),
		caducidad: flag(product?.tiene_caducidad),
	};
}

/** Lote y serie son excluyentes; la caducidad se lleva por lote o por serie. */
export function assert_tracking_flags(doc: ImperiumDoc): void {
	const tracking = product_tracking(doc);
	if (tracking.lote && tracking.serial) {
		throw new Error('Un producto maneja lote o número de serie, no ambos');
	}
	if (tracking.caducidad && !tracking.lote && !tracking.serial) {
		throw new Error('La caducidad se controla por lote o por número de serie');
	}
}

export type ReceiptLot = { lote_codigo: string; fecha_caducidad: string; cantidad: number };

/**
 * Reparte lo recibido de un producto en sus lotes o series. Sin control de
 * lote no acepta lotes; con él exige que sumen lo recibido, series de una
 * pieza sin repetir y caducidad `AAAA-MM-DD` si el producto la maneja.
 */
export function split_receipt_lots(
	product: ImperiumDoc,
	cantidad: number,
	raw_lotes: unknown,
): ReceiptLot[] {
	const tracking = product_tracking(product);
	const nombre = text(product.name) || 'el producto';
	const lotes = as_array(raw_lotes).map(as_object);
	if (!tracking.lote && !tracking.serial) {
		if (lotes.length) throw new Error(`${nombre} no maneja lotes ni series`);
		return [];
	}
	if (!lotes.length) {
		throw new Error(`Captura ${tracking.serial ? 'los números de serie' : 'los lotes'} de ${nombre}`);
	}
	const vistos = new Set<string>();
	const out = lotes.map((raw): ReceiptLot => {
		const lote_codigo = text(raw.lote_codigo ?? raw.codigo).toUpperCase();
		if (!lote_codigo) throw new Error(`Hay un lote sin código en ${nombre}`);
		const cantidad_lote = tracking.serial ? Number(raw.cantidad ?? 1) : Number(raw.cantidad ?? 0);
		if (tracking.serial && cantidad_lote !== 1) {
			throw new Error(`La serie ${lote_codigo} de ${nombre} debe ser de una pieza`);
		}
		if (!(cantidad_lote > 0)) throw new Error(`El lote ${lote_codigo} de ${nombre} no tiene cantidad`);
		if (vistos.has(lote_codigo)) {
			throw new Error(`${tracking.serial ? 'La serie' : 'El lote'} ${lote_codigo} está repetido`);
		}
		vistos.add(lote_codigo);
		const fecha_caducidad = text(raw.fecha_caducidad).slice(0, 10);
		if (tracking.caducidad && !FECHA.test(fecha_caducidad)) {
			throw new Error(`Indica la caducidad (AAAA-MM-DD) del lote ${lote_codigo} de ${nombre}`);
		}
		return { lote_codigo, fecha_caducidad: FECHA.test(fecha_caducidad) ? fecha_caducidad : '', cantidad: cantidad_lote };
	});
	const suma = out.reduce((s, lot) => s + lot.cantidad, 0);
	if (Math.abs(suma - cantidad) > 1e-6) {
		throw new Error(`Los lotes de ${nombre} suman ${suma} y se recibieron ${cantidad}`);
	}
	return out;
}

/** Una serie que ya se recibió no puede volver a entrar. */
export async function assert_new_serials(
	store: ImperiumStore,
	product: ImperiumDoc,
	lots: ReceiptLot[],
): Promise<void> {
	if (!product_tracking(product).serial || !store.has('inventory-lot')) return;
	for (const lot of lots) {
		const existing = await store.find_where('inventory-lot', {
			producto: String(product._id),
			name: lot.lote_codigo,
		});
		if (existing) throw new Error(`La serie ${lot.lote_codigo} ya fue recibida`);
	}
}

/**
 * Busca el lote (producto + código) o lo crea, y le suma lo recibido. Una
 * serie que ya existe no se puede recibir otra vez.
 */
export async function ensure_inventory_lot(
	store: ImperiumStore,
	params: {
		product: ImperiumDoc;
		lot: ReceiptLot;
		source?: ImperiumDoc | null;
		recepcion?: string;
	},
): Promise<ImperiumDoc> {
	const producto = String(params.product._id);
	const tracking = product_tracking(params.product);
	const existing = await store.find_where('inventory-lot', {
		producto,
		name: params.lot.lote_codigo,
	});
	if (existing) {
		if (tracking.serial) {
			throw new Error(`La serie ${params.lot.lote_codigo} ya fue recibida`);
		}
		const updated = await store.update('inventory-lot', String(existing._id), {
			cantidad_recibida: Number(existing.cantidad_recibida ?? 0) + params.lot.cantidad,
			...(params.lot.fecha_caducidad && !text(existing.fecha_caducidad)
				? { fecha_caducidad: params.lot.fecha_caducidad }
				: {}),
		});
		return updated ?? existing;
	}
	return store.insert('inventory-lot', {
		name: params.lot.lote_codigo,
		producto,
		producto_codigo: text(params.product.codigo),
		producto_nombre: text(params.product.name),
		tipo: tracking.serial ? 'serie' : 'lote',
		fecha_caducidad: params.lot.fecha_caducidad || undefined,
		fecha_recepcion: new Date().toISOString().slice(0, 10),
		proveedor: ref_id(params.source?.proveedor) || undefined,
		proveedor_nombre: text(params.source?.proveedor_nombre),
		orden_compra: params.source?._id ? String(params.source._id) : undefined,
		recepcion: params.recepcion || undefined,
		cantidad_recibida: params.lot.cantidad,
	});
}
