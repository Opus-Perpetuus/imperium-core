/**
 * Ruta de surtimiento y reabasto por faltante. Espejo de
 * `inventory-stock-quant.service.compute_picking_route` y
 * `purchase-order.replenishment.service`.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export function round_quantity(value: number): number {
	return Number(Number(value ?? 0).toFixed(4));
}

export type PickingSourceQuant = {
	ubicacion: string;
	ubicacion_codigo: string;
	cantidad_disponible: number;
};

export type PickingRenglon = {
	ubicacion: string;
	ubicacion_codigo: string;
	disponible: number;
	tomar: number;
};

export type PickingRoute = {
	producto: string;
	cantidad_requerida: number;
	renglones: PickingRenglon[];
	faltante: number;
	cubierto: boolean;
};

export function build_picking_renglones(
	sorted_quants: PickingSourceQuant[],
	cantidad_requerida: number,
): { renglones: PickingRenglon[]; faltante: number } {
	const renglones: PickingRenglon[] = [];
	let restante = round_quantity(cantidad_requerida);
	for (const quant of sorted_quants) {
		if (restante <= 0) break;
		const disponible = round_quantity(quant.cantidad_disponible);
		const tomar = round_quantity(Math.min(disponible, restante));
		if (tomar <= 0) continue;
		renglones.push({
			ubicacion: String(quant.ubicacion),
			ubicacion_codigo: quant.ubicacion_codigo,
			disponible,
			tomar,
		});
		restante = round_quantity(restante - tomar);
	}
	return { renglones, faltante: round_quantity(Math.max(0, restante)) };
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '');
	return String(value).trim();
}

function quant_disponible(row: ImperiumDoc): number {
	if (row.cantidad_disponible != null && row.cantidad_disponible !== '') {
		return Number(row.cantidad_disponible);
	}
	return Number(row.cantidad ?? 0) - Number(row.cantidad_apartada ?? 0);
}

export function weighted_moving_average(values: number[]): number {
	if (!values.length) return 0;
	let weighted_sum = 0;
	let weight_total = 0;
	values.forEach((value, index) => {
		const weight = index + 1;
		weighted_sum += round_quantity(value) * weight;
		weight_total += weight;
	});
	return weight_total > 0 ? round_quantity(weighted_sum / weight_total) : 0;
}

export async function compute_picking_route(
	store: ImperiumStore,
	producto: string,
	cantidad_requerida: number,
): Promise<PickingRoute> {
	const requerido = round_quantity(cantidad_requerida);
	const quants = store.has('inventory-stock-quant')
		? (
				await store.find_many('inventory-stock-quant', {
					where: { producto },
					take: 20000,
					include_inactive: false,
					populate: false,
				})
			).rows
		: [];
	const sources: Array<PickingSourceQuant & { secuencia: number }> = [];
	for (const row of quants) {
		const pid = ref_id(row.producto) || String(row.producto_id ?? '');
		if (pid !== producto) continue;
		const disponible = quant_disponible(row);
		if (!(disponible > 0)) continue;
		const loc_id = ref_id(row.ubicacion) || String(row.ubicacion_id ?? '');
		let secuencia = 0;
		let codigo = String(row.ubicacion_codigo ?? '');
		if (loc_id && store.has('inventory-internal-location')) {
			const loc = await store.find_id('inventory-internal-location', loc_id);
			if (loc) {
				secuencia = Number(loc.secuencia_surtido ?? 0) || 0;
				if (!codigo) codigo = String(loc.codigo ?? loc.name ?? '');
			}
		}
		sources.push({
			ubicacion: loc_id,
			ubicacion_codigo: codigo,
			cantidad_disponible: disponible,
			secuencia,
		});
	}
	sources.sort((a, b) => {
		if (a.secuencia !== b.secuencia) return a.secuencia - b.secuencia;
		return String(a.ubicacion_codigo).localeCompare(String(b.ubicacion_codigo), 'es');
	});
	const { renglones, faltante } = build_picking_renglones(sources, requerido);
	return {
		producto,
		cantidad_requerida: requerido,
		renglones,
		faltante,
		cubierto: faltante <= 0,
	};
}

async function compute_weighted_consumption(
	store: ImperiumStore,
	producto: string,
	periodos = 6,
): Promise<number> {
	if (!store.has('inventory-movement')) return 0;
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth() - (periodos - 1), 1);
	const { rows } = await store.find_many('inventory-movement', {
		where: {
			producto,
			tipo_movimiento: 'salida_entrega',
			fecha_movimiento: { gte: start.toISOString() },
		},
		take: 5000,
		include_inactive: true,
		populate: false,
	});
	const totals = new Map<string, number>();
	for (const row of rows) {
		const pid = ref_id(row.producto) || String(row.producto_id ?? '');
		if (pid !== producto) continue;
		if (String(row.tipo_movimiento ?? row.tipo ?? '') !== 'salida_entrega') continue;
		const fecha = new Date(String(row.fecha_movimiento ?? row.createdAt ?? row.created_at ?? ''));
		if (!Number.isFinite(fecha.getTime()) || fecha < start) continue;
		const key = `${fecha.getFullYear()}-${fecha.getMonth() + 1}`;
		totals.set(key, round_quantity((totals.get(key) ?? 0) + Number(row.cantidad ?? 0)));
	}
	const values: number[] = [];
	for (let offset = periodos - 1; offset >= 0; offset--) {
		const period = new Date(now.getFullYear(), now.getMonth() - offset, 1);
		values.push(totals.get(`${period.getFullYear()}-${period.getMonth() + 1}`) ?? 0);
	}
	return weighted_moving_average(values);
}

async function upsert_draft_replenishment_item(
	store: ImperiumStore,
	params: {
		producto: string;
		producto_nombre: string;
		producto_codigo?: string;
		faltante: number;
		consumo: number;
		costo_unitario: number;
		pedido_folio?: string;
	},
): Promise<ImperiumDoc> {
	const faltante = round_quantity(params.faltante);
	const consumo = round_quantity(params.consumo);
	const cantidad = round_quantity(faltante + consumo);
	const costo_unitario = round_quantity(params.costo_unitario);
	const { rows } = await store.find_many('purchase-order', {
		where: { estado: 'borrador', tipo_origen: 'reabasto' },
		take: 1,
		include_inactive: false,
		populate: false,
	});
	let order = rows[0] ?? null;
	const articulos = as_array(order?.articulos).map(as_object);
	const existing = articulos.find((item) => ref_id(item.producto) === params.producto);
	if (existing) {
		existing.cantidad = round_quantity(Number(existing.cantidad ?? 0) + cantidad);
		existing.cantidad_faltante = round_quantity(Number(existing.cantidad_faltante ?? 0) + faltante);
		existing.cantidad_sugerida_consumo = consumo;
		existing.costo_unitario = costo_unitario;
		existing.importe = round_quantity(Number(existing.cantidad) * costo_unitario);
		if (params.pedido_folio) {
			const folios = String(existing.origen_pedido_folio ?? '')
				.split(',')
				.map((folio) => folio.trim())
				.filter(Boolean);
			if (!folios.includes(params.pedido_folio)) {
				existing.origen_pedido_folio = [...folios, params.pedido_folio].join(', ');
			}
		}
	} else {
		articulos.push({
			producto: params.producto,
			producto_nombre: params.producto_nombre,
			producto_codigo: params.producto_codigo ?? '',
			descripcion_origen: '',
			cantidad,
			cantidad_recibida: 0,
			costo_unitario,
			importe: round_quantity(cantidad * costo_unitario),
			origen_pedido_folio: params.pedido_folio ?? '',
			cantidad_faltante: faltante,
			cantidad_sugerida_consumo: consumo,
		});
	}
	const total_cantidad = round_quantity(
		articulos.reduce((sum, item) => sum + Number(item.cantidad ?? 0), 0),
	);
	const subtotal = round_quantity(
		articulos.reduce((sum, item) => sum + Number(item.importe ?? 0), 0),
	);
	if (order) {
		return (await store.update('purchase-order', String(order._id), {
			articulos,
			total_cantidad,
			subtotal,
		}))!;
	}
	return store.insert('purchase-order', {
		name: 'Reabasto automático',
		description: 'Orden generada automáticamente por faltantes de surtimiento',
		estado: 'borrador',
		tipo_origen: 'reabasto',
		articulos,
		total_cantidad,
		subtotal,
		is_active: true,
	});
}

export async function generate_replenishment_for_order(
	store: ImperiumStore,
	pedido_id: string,
): Promise<{
	pedido_folio: string;
	faltantes: Array<{
		producto: string;
		producto_nombre: string;
		faltante: number;
		consumo: number;
	}>;
}> {
	if (!pedido_id || !/^[a-f0-9]{24}$/i.test(pedido_id)) {
		throw new Error('Debes indicar un pedido válido');
	}
	const pedido = await store.find_id('pedidos', pedido_id);
	if (!pedido) throw new Error('No se encontró el pedido indicado');
	const pedido_folio = String(pedido.folio_interno ?? pedido.folio ?? pedido_id);
	const faltantes: Array<{
		producto: string;
		producto_nombre: string;
		faltante: number;
		consumo: number;
	}> = [];
	for (const raw of as_array(pedido.articulos)) {
		const articulo = as_object(raw);
		const producto_id = ref_id(articulo.product);
		const cantidad = round_quantity(Number(articulo.cantidad ?? 0));
		if (!producto_id || !/^[a-f0-9]{24}$/i.test(producto_id) || !(cantidad > 0)) continue;
		const ruta = await compute_picking_route(store, producto_id, cantidad);
		if (ruta.faltante <= 0) continue;
		const product = await store.find_id('products', producto_id);
		if (!product) continue;
		const consumo = await compute_weighted_consumption(store, producto_id, 6);
		const costo_unitario = round_quantity(
			Number(product.ultimoCostoCompra ?? product.costoCompraPromedio ?? 0),
		);
		await upsert_draft_replenishment_item(store, {
			producto: producto_id,
			producto_nombre: String(product.name ?? ''),
			producto_codigo: product.codigo != null ? String(product.codigo) : '',
			faltante: ruta.faltante,
			consumo,
			costo_unitario,
			pedido_folio,
		});
		faltantes.push({
			producto: producto_id,
			producto_nombre: String(product.name ?? ''),
			faltante: ruta.faltante,
			consumo,
		});
	}
	return { pedido_folio, faltantes };
}
