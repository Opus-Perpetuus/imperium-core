/**
 * Productos: misma proyección y escritura que el service original
 * (`existenciaDisponible`, ubicación preferida hoja, costo de inventario).
 */
import { type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function num(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

export function decorate_product(doc: ImperiumDoc): ImperiumDoc {
	const existencia = num(doc.existencia);
	const apartada = Math.max(num(doc.existenciaApartada), 0);
	return {
		...doc,
		existencia,
		existenciaApartada: apartada,
		existenciaDisponible: existencia - apartada,
	};
}

export async function prepare_product_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
): Promise<ImperiumDoc> {
	const doc = { ...incoming };
	if (!('ubicacion_preferida' in incoming)) return doc;
	const raw = incoming.ubicacion_preferida;
	if (raw == null || raw === '') {
		doc.ubicacion_preferida = null;
		doc.ubicacion_preferida_codigo = '';
		return doc;
	}
	const id = ref_id(raw);
	if (!id || id.length < 12) {
		doc.ubicacion_preferida = null;
		doc.ubicacion_preferida_codigo = '';
		return doc;
	}
	const loc = await store.find_id('inventory-internal-location', id);
	if (!loc) throw new Error('La ubicación preferida indicada no existe');
	if (loc.permite_almacenaje === false) {
		throw new Error('La ubicación preferida debe permitir almacenaje (hoja del almacén)');
	}
	doc.ubicacion_preferida = id;
	doc.ubicacion_preferida_codigo = String(loc.codigo ?? '');
	return doc;
}

export async function products_inventory_cost(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<number> {
	let total = 0;
	for await (const page of store.scan('products', {
		include_inactive: true,
		mongo_match,
	})) {
		for (const row of page) {
			const existencia = num(row.existencia);
			if (existencia < 0) continue;
			total += existencia * num(row.costoVenta);
		}
	}
	return total;
}
