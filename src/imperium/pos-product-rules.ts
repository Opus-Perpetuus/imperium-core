/**
 * Reglas de venta por producto, guardadas en columnas JSON nuevas de
 * `products` (si no vienen, nada cambia):
 *
 * - `precios_escala`: [{desde, precio}] precio de mayoreo desde una cantidad.
 * - `promociones`: [{nombre, tipo: porcentaje|precio|nxm, valor, n, m, desde, hasta}].
 * - `conversiones_unidad`: [{unidad, factor, codigo}] p. ej. caja = 12 piezas.
 * - `kit_componentes`: [{producto, producto_nombre, cantidad}] al vender el
 *   kit se descuentan sus componentes en lugar del kit.
 *
 * El POS aplica precios y conversiones; el núcleo normaliza y valida al
 * guardar el producto y descuenta los componentes de los kits.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const PRODUCT_RULE_FIELDS = ['precios_escala', 'promociones', 'conversiones_unidad', 'kit_componentes'] as const;
const PROMO_TYPES = new Set(['porcentaje', 'precio', 'nxm']);

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : NaN;
}

function money(n: number): number {
	return Math.round(n * 100) / 100;
}

function qty(n: number): number {
	return Math.round(n * 1e6) / 1e6;
}

function rows(raw: unknown): ImperiumDoc[] {
	let value = raw;
	if (typeof raw === 'string') {
		if (!raw.trim()) return [];
		try {
			value = JSON.parse(raw);
		} catch {
			throw new Error('Las reglas de venta del producto deben ser una lista JSON');
		}
	}
	if (value == null) return [];
	if (!Array.isArray(value)) throw new Error('Las reglas de venta del producto deben ser una lista');
	return as_array(value).map(as_object);
}

function day(raw: unknown, label: string): string {
	const value = text(raw);
	if (!value) return '';
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	if (!m || Number.isNaN(new Date(`${m[1]}T00:00:00`).getTime())) throw new Error(`Fecha inválida en ${label}: ${value}`);
	return m[1];
}

export function normalize_price_scales(raw: unknown): ImperiumDoc[] {
	const seen = new Set<number>();
	return rows(raw)
		.map((r) => {
			const desde = num(r.desde);
			const precio = num(r.precio);
			if (!(desde > 1)) throw new Error('Cada precio por escala necesita «desde» mayor a 1');
			if (!(precio >= 0)) throw new Error('Cada precio por escala necesita un precio válido');
			if (seen.has(desde)) throw new Error(`Precio por escala repetido desde ${desde}`);
			seen.add(desde);
			return { desde: qty(desde), precio: money(precio) };
		})
		.sort((a, b) => a.desde - b.desde);
}

export function normalize_promotions(raw: unknown): ImperiumDoc[] {
	return rows(raw).map((r) => {
		const tipo = text(r.tipo).toLowerCase();
		if (!PROMO_TYPES.has(tipo)) throw new Error('Tipo de promoción inválido (porcentaje, precio o nxm)');
		const desde = day(r.desde, 'la promoción');
		const hasta = day(r.hasta, 'la promoción');
		if (desde && hasta && hasta < desde) throw new Error('La promoción termina antes de empezar');
		const base = { nombre: text(r.nombre) || tipo, tipo, desde, hasta };
		if (tipo === 'nxm') {
			const n = num(r.n);
			const m = num(r.m);
			if (!Number.isInteger(n) || !Number.isInteger(m) || !(n > m) || !(m >= 1)) {
				throw new Error('La promoción NxM necesita enteros con N mayor que M (p. ej. 3x2)');
			}
			return { ...base, n, m };
		}
		const valor = num(r.valor);
		if (tipo === 'porcentaje' && !(valor > 0 && valor < 100)) throw new Error('El porcentaje de promoción debe estar entre 0 y 100');
		if (tipo === 'precio' && !(valor >= 0)) throw new Error('El precio de promoción debe ser válido');
		return { ...base, valor: money(valor) };
	});
}

export function normalize_unit_conversions(raw: unknown): ImperiumDoc[] {
	const codes = new Set<string>();
	return rows(raw).map((r) => {
		const unidad = text(r.unidad);
		const factor = num(r.factor);
		const codigo = text(r.codigo);
		if (!unidad) throw new Error('Cada conversión necesita la unidad (p. ej. caja)');
		if (!(factor > 0) || factor === 1) throw new Error(`La conversión ${unidad} necesita un factor mayor a 0 y distinto de 1`);
		if (codigo) {
			if (codes.has(codigo)) throw new Error(`Código de conversión repetido: ${codigo}`);
			codes.add(codigo);
		}
		return { unidad, factor: qty(factor), codigo };
	});
}

export async function normalize_kit_components(store: ImperiumStore, raw: unknown, self_id: string): Promise<ImperiumDoc[]> {
	const out = new Map<string, ImperiumDoc>();
	for (const r of rows(raw)) {
		const id = text(as_object(r.producto)._id ?? r.producto);
		const cantidad = num(r.cantidad);
		if (!id) throw new Error('Cada componente del kit necesita un producto');
		if (!(cantidad > 0)) throw new Error('Cada componente del kit necesita una cantidad mayor a 0');
		if (self_id && id === self_id) throw new Error('Un kit no puede contenerse a sí mismo');
		const product = store.has('products') ? await store.find_id('products', id) : null;
		if (!product) throw new Error(`El componente del kit no existe: ${id}`);
		if (rows(product.kit_componentes).length) throw new Error(`${text(product.name)} ya es un kit: no se permiten kits dentro de kits`);
		const prev = out.get(id);
		out.set(id, {
			producto: id,
			producto_nombre: text(product.name),
			cantidad: qty(Number(prev?.cantidad ?? 0) + cantidad),
		});
	}
	return [...out.values()];
}

/** Normaliza solo los campos de reglas que vienen en el documento. */
export async function normalize_product_rules(store: ImperiumStore, doc: ImperiumDoc, self_id = ''): Promise<ImperiumDoc> {
	const out = { ...doc };
	if ('precios_escala' in doc) out.precios_escala = normalize_price_scales(doc.precios_escala);
	if ('promociones' in doc) out.promociones = normalize_promotions(doc.promociones);
	if ('conversiones_unidad' in doc) out.conversiones_unidad = normalize_unit_conversions(doc.conversiones_unidad);
	if ('kit_componentes' in doc) {
		out.kit_componentes = await normalize_kit_components(store, doc.kit_componentes, self_id || text(doc._id));
	}
	return out;
}

/** Componentes del kit (vacío si el producto no es kit). */
export function kit_components_of(product: ImperiumDoc): Array<{ producto: string; cantidad: number }> {
	try {
		return rows(product.kit_componentes)
			.map((r) => ({ producto: text(r.producto), cantidad: Number(r.cantidad) }))
			.filter((r) => r.producto && r.cantidad > 0);
	} catch {
		return [];
	}
}

/**
 * Cambia cada kit por sus componentes (cantidad del kit × cantidad del componente).
 * Los productos que no son kit, o que ya no existen, pasan tal cual.
 */
export async function expand_kit_quantities(
	store: ImperiumStore,
	quantities: Map<string, number>,
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	const add = (id: string, q: number) => out.set(id, Math.round(((out.get(id) ?? 0) + q) * 10000) / 10000);
	for (const [id, q] of quantities) {
		const product = store.has('products') ? await store.find_id('products', id) : null;
		const components = product ? kit_components_of(product) : [];
		if (!components.length) {
			add(id, q);
			continue;
		}
		for (const c of components) add(c.producto, q * c.cantidad);
	}
	return out;
}
