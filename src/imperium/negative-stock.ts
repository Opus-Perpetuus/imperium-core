/**
 * Regla única de existencia negativa para todas las salidas de inventario.
 * Por defecto NO se permite; el parámetro de sistema
 * `configuration-inventory-allow-negative-stock` en SÍ la habilita.
 */
import { coerce_flag, read_config_value } from './subject-versions.ts';
import type { ImperiumStore } from './store.ts';

export const ALLOW_NEGATIVE_STOCK_REF = 'configuration-inventory-allow-negative-stock';
export const ALLOW_NEGATIVE_STOCK_LABEL = 'Inventario · Permitir existencia negativa';

/** ¿Se permite existencia negativa? Solo un SÍ explícito la habilita. */
export async function allow_negative_stock(store: ImperiumStore): Promise<boolean> {
	return coerce_flag(await read_config_value(store, ALLOW_NEGATIVE_STOCK_REF));
}

export type FaltanteSalida = { nombre: string; requerido: number; disponible: number };

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/** Mensaje uniforme del bloqueo. */
export function mensaje_negativos(accion: string, faltantes: FaltanteSalida[]): string {
	const detalle = faltantes
		.map((f) => `${f.nombre} (sale ${f.requerido}, hay ${f.disponible})`)
		.join(', ');
	return (
		`No se puede ${accion}: la existencia quedaría negativa en ${detalle}. ` +
		`Ajusta las cantidades o activa "${ALLOW_NEGATIVE_STOCK_LABEL}".`
	);
}

/**
 * Lanza si alguna salida (producto → cantidad) dejaría la existencia total
 * por debajo de 0 y los negativos no están permitidos.
 */
export async function assert_salida_sin_negativos(
	store: ImperiumStore,
	accion: string,
	salidas: Map<string, number>,
): Promise<void> {
	if (!salidas.size || !store.has('products')) return;
	if (await allow_negative_stock(store)) return;
	const faltantes: FaltanteSalida[] = [];
	for (const [product_id, requerido] of salidas) {
		if (!(requerido > 0)) continue;
		const product = await store.find_id('products', product_id);
		const disponible = round_qty(Number(product?.existencia ?? 0));
		if (requerido > disponible) {
			faltantes.push({
				nombre: String(product?.name ?? product_id),
				requerido: round_qty(requerido),
				disponible: Math.max(disponible, 0),
			});
		}
	}
	if (faltantes.length) throw new Error(mensaje_negativos(accion, faltantes));
}
