/**
 * Entradas y salidas manuales de inventario (panel «Entrada / salida» de
 * Movimientos). El ledger `inventory-movement` no acepta altas por CRUD; este
 * flujo ajusta la existencia por ubicación y asienta el movimiento.
 */
import {
	apply_quant_delta,
	find_warehouse_location,
	product_has_quants,
	recompute_product_existencia,
} from './delivery-return-flow.ts';
import type { ImperiumDoc } from './envelope.ts';
import { is_record_id } from './record-id.ts';
import type { ImperiumStore } from './store.ts';
import { allow_negative_stock } from './negative-stock.ts';

export const MANUAL_ENTRY = 'entrada_manual';
export const MANUAL_EXIT = 'salida_manual';

export type ManualMovementParams = {
	tipo: string;
	producto: string;
	ubicacion?: string;
	cantidad: number;
	motivo?: string;
	costo_unitario?: number;
	usuario?: string;
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

async function quant_cantidad(store: ImperiumStore, producto: string, ubicacion: string) {
	if (!store.has('inventory-stock-quant')) return null;
	const { rows } = await store.find_many('inventory-stock-quant', {
		where: { producto, ubicacion },
		take: 500,
		include_inactive: true,
		populate: false,
	});
	return round_qty(rows.reduce((sum, row) => sum + Number(row.cantidad ?? 0), 0));
}

export async function register_manual_movement(
	store: ImperiumStore,
	params: ManualMovementParams,
): Promise<ImperiumDoc> {
	const tipo = text(params.tipo);
	if (tipo !== MANUAL_ENTRY && tipo !== MANUAL_EXIT) {
		throw new Error('Elige si es una entrada o una salida');
	}
	const producto_id = text(params.producto);
	if (!producto_id || !is_record_id(producto_id)) throw new Error('Elige un producto');
	const cantidad = round_qty(Number(params.cantidad ?? 0));
	if (!(cantidad > 0)) throw new Error('La cantidad debe ser mayor a cero');
	const product = await store.find_id('products', producto_id);
	if (!product) throw new Error('No se encontró el producto indicado');

	let ubicacion: ImperiumDoc | null = null;
	const ubicacion_id = text(params.ubicacion);
	if (ubicacion_id) {
		ubicacion = await store.find_id('inventory-internal-location', ubicacion_id);
		if (!ubicacion) throw new Error('No se encontró la ubicación indicada');
	} else if (store.has('inventory-internal-location')) {
		ubicacion = await find_warehouse_location(store);
	}

	const es_salida = tipo === MANUAL_EXIT;
	const delta = es_salida ? -cantidad : cantidad;
	const existencia_previa = round_qty(Number(product.existencia ?? 0));

	if (es_salida && !(await allow_negative_stock(store))) {
		const en_ubicacion = ubicacion?._id
			? await quant_cantidad(store, producto_id, String(ubicacion._id))
			: null;
		const sin_quants = !(await product_has_quants(store, producto_id));
		const disponible = sin_quants || en_ubicacion == null ? existencia_previa : en_ubicacion;
		if (cantidad > disponible) {
			const donde = ubicacion && !sin_quants ? ` en ${text(ubicacion.codigo) || text(ubicacion.name)}` : '';
			throw new Error(
				`No hay existencia suficiente${donde} (hay ${disponible}, quieres sacar ${cantidad}). ` +
					'Ajusta la cantidad o activa "Inventario · Permitir existencia negativa".',
			);
		}
	}

	const sin_filas_previas = !(await product_has_quants(store, producto_id));
	if (ubicacion?._id) {
		await apply_quant_delta(store, {
			producto: producto_id,
			producto_nombre: text(product.name),
			producto_codigo: text(product.codigo),
			ubicacion: String(ubicacion._id),
			ubicacion_codigo: text(ubicacion.codigo),
			delta,
		});
	}
	await recompute_product_existencia(store, producto_id, {
		sin_filas_previas: sin_filas_previas || !ubicacion?._id,
		delta,
		existencia_previa,
	});
	const after = await store.find_id('products', producto_id);
	const resultante = round_qty(Number(after?.existencia ?? existencia_previa + delta));
	const apartado = round_qty(Number(after?.existenciaApartada ?? 0));
	const motivo = text(params.motivo);
	const etiqueta = es_salida ? 'Salida manual' : 'Entrada manual';
	const loc_id = ubicacion?._id ? String(ubicacion._id) : undefined;
	const loc_nombre = ubicacion ? text(ubicacion.name) || text(ubicacion.codigo) : '';
	const doc: ImperiumDoc = {
		name: `${etiqueta} ${text(product.name)}`,
		description: motivo || etiqueta,
		tipo_movimiento: tipo,
		producto: producto_id,
		producto_id,
		producto_nombre: text(product.name),
		producto_codigo: text(product.codigo),
		cantidad,
		ubicacion_origen: es_salida ? loc_id : undefined,
		ubicacion_origen_id: es_salida ? loc_id : undefined,
		ubicacion_origen_nombre: es_salida ? loc_nombre : '',
		ubicacion_destino: es_salida ? undefined : loc_id,
		ubicacion_destino_id: es_salida ? undefined : loc_id,
		ubicacion_destino_nombre: es_salida ? '' : loc_nombre,
		documento_tipo: 'manual',
		documento_nombre: etiqueta,
		documento_referencia: motivo,
		stock_total_previo: existencia_previa,
		stock_total_resultante: resultante,
		stock_apartado_previo: apartado,
		stock_apartado_resultante: apartado,
		stock_disponible_resultante: round_qty(resultante - apartado),
		fecha_movimiento: new Date().toISOString(),
	};
	const costo = Number(params.costo_unitario);
	if (Number.isFinite(costo) && costo > 0) doc.costo_unitario = costo;
	if (!store.has('inventory-movement')) return doc;
	return (await store.insert('inventory-movement', doc)) ?? doc;
}
