/**
 * Salidas de inventario (surtido de pedido, entrega de bulto, venta POS).
 * Además de `products.existencia`, descuentan las existencias por ubicación:
 * recepciones, traslados y conteos recalculan la existencia como la suma por
 * ubicación, y sin este descuento lo ya surtido volvía a contar.
 */
import { apply_quant_delta } from './delivery-return-flow.ts';
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { compute_picking_route, round_quantity } from './inventory-picking.ts';
import type { ImperiumStore } from './store.ts';

const WAREHOUSE_REF = 'inventory-internal-location-warehouse';

/**
 * Descuenta `cantidad` de las ubicaciones del producto en el orden de la ruta
 * de surtido. Lo que no alcance sale del almacén general (puede quedar en
 * negativo) para que la suma por ubicación siga igual a la existencia. Un
 * producto sin existencias por ubicación no se toca.
 */
export async function consume_exit_quants(
	store: ImperiumStore,
	product: ImperiumDoc,
	cantidad: number,
): Promise<void> {
	const producto = String(product._id ?? '');
	const requerido = round_quantity(cantidad);
	if (!producto || requerido <= 0 || !store.has('inventory-stock-quant')) return;
	const { rows } = await store.find_many('inventory-stock-quant', {
		where: { producto },
		take: 1,
		include_inactive: true,
		populate: false,
	});
	if (!rows.length) return;
	const base = {
		producto,
		producto_nombre: String(product.name ?? ''),
		producto_codigo: String(product.codigo ?? ''),
	};
	const route = await compute_picking_route(store, producto, requerido);
	for (const renglon of route.renglones) {
		await apply_quant_delta(store, {
			...base,
			ubicacion: renglon.ubicacion,
			ubicacion_codigo: renglon.ubicacion_codigo,
			delta: -renglon.tomar,
		});
	}
	if (route.faltante <= 0 || !store.has('inventory-internal-location')) return;
	const warehouse =
		(await store.find_where('inventory-internal-location', { _ref: WAREHOUSE_REF })) ??
		(await store.find_where('inventory-internal-location', { ref: WAREHOUSE_REF }));
	if (!warehouse?._id) return;
	await apply_quant_delta(store, {
		...base,
		ubicacion: String(warehouse._id),
		ubicacion_codigo: String(warehouse.codigo ?? warehouse.name ?? ''),
		delta: -route.faltante,
	});
}

/** Venta POS: resta lo vendido de la existencia del producto (nunca por debajo de 0). */
export async function register_pos_ticket_exit(
	store: ImperiumStore,
	ticket: ImperiumDoc,
): Promise<void> {
	if (String(ticket.ticket_type ?? 'VENTA').toUpperCase() !== 'VENTA') return;
	const items = as_array(ticket.items).map(as_object);
	for (const item of items) {
		const pid = String(item.item_id ?? item.producto ?? item.product_id ?? '');
		const qty = Number(item.quantity ?? item.cantidad ?? 0);
		if (!pid || !qty || !store.has('products')) continue;
		const product = await store.find_id('products', pid);
		if (!product) continue;
		const previa = Number(product.existencia ?? 0);
		const next = Math.max(previa - qty, 0);
		await store.update('products', pid, { existencia: next });
		await consume_exit_quants(store, product, previa - next);
		await insert_pos_sale_movement(store, ticket, product, qty, previa, next);
	}
}

async function insert_pos_sale_movement(
	store: ImperiumStore,
	ticket: ImperiumDoc,
	product: ImperiumDoc,
	cantidad: number,
	stock_total_previo: number,
	stock_total_resultante: number,
): Promise<void> {
	if (!store.has('inventory-movement')) return;
	const warehouse = store.has('inventory-internal-location')
		? ((await store.find_where('inventory-internal-location', { _ref: WAREHOUSE_REF })) ??
			(await store.find_where('inventory-internal-location', { ref: WAREHOUSE_REF })))
		: null;
	const producto = String(product._id ?? '');
	const apartado = round_quantity(Number(product.existenciaApartada ?? 0));
	await store.insert('inventory-movement', {
		name: `Venta POS ${String(product.name ?? producto)}`,
		producto,
		producto_id: producto,
		producto_nombre: product.name,
		producto_codigo: product.codigo,
		tipo_movimiento: 'salida_entrega',
		ubicacion_origen: warehouse?._id,
		ubicacion_origen_id: warehouse?._id,
		ubicacion_origen_nombre: warehouse?.name,
		documento_tipo: 'pos-ticket',
		documento_id: String(ticket._id ?? ''),
		documento_modelo: 'PosTickets',
		documento_nombre: String(ticket.name ?? ticket.ticket_sequence ?? ''),
		documento_referencia: String(ticket.ticket_sequence ?? ''),
		description: 'Salida por venta en punto de venta',
		cantidad: round_quantity(cantidad),
		stock_total_previo: round_quantity(stock_total_previo),
		stock_total_resultante: round_quantity(stock_total_resultante),
		stock_apartado_previo: apartado,
		stock_apartado_resultante: apartado,
		fecha_movimiento: new Date().toISOString(),
	});
}
