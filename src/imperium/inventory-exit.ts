/**
 * Salidas de inventario (surtido de pedido, entrega de bulto, venta POS).
 * Además de `products.existencia`, descuentan las existencias por ubicación:
 * primero las de la ruta de surtido y el resto en el almacén general. Con un
 * almacén (`WarehouseScope`) solo se toma de él y el resto sale de él mismo.
 */
import { apply_quant_delta, find_warehouse_location, type QuantLot } from './delivery-return-flow.ts';
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { compute_picking_route, round_quantity } from './inventory-picking.ts';
import { kit_components_of } from './pos-product-rules.ts';
import { allow_negative_stock, assert_salida_sin_negativos } from './negative-stock.ts';
import { pos_ticket_warehouse_id, warehouse_scope, type WarehouseScope } from './warehouse-scope.ts';
import type { ImperiumStore } from './store.ts';

/**
 * Descuenta `cantidad` de las ubicaciones del producto en el orden de la ruta
 * de surtido. Lo que no alcance, o toda la cantidad si no hay existencias por
 * ubicación, sale del almacén general (`inventory-internal-location-warehouse`).
 * Si el producto no tiene fila ahí, se crea y puede quedar negativa.
 */
type ExitTouch = QuantLot & { cantidad: number; ubicacion: string; ubicacion_codigo: string };

function tag_ubicacion(
	portions: Array<QuantLot & { cantidad: number }>,
	ubicacion: string,
	ubicacion_codigo: string,
): ExitTouch[] {
	return portions.map((portion) => ({ ...portion, ubicacion, ubicacion_codigo }));
}

export async function consume_exit_quants(
	store: ImperiumStore,
	product: ImperiumDoc,
	cantidad: number,
	scope: WarehouseScope | null = null,
): Promise<ExitTouch[]> {
	const touched: ExitTouch[] = [];
	const producto = String(product._id ?? '');
	const requerido = round_quantity(cantidad);
	if (!producto || requerido <= 0 || !store.has('inventory-stock-quant')) return touched;
	const base = {
		producto,
		producto_nombre: String(product.name ?? ''),
		producto_codigo: String(product.codigo ?? ''),
	};
	const route = await compute_picking_route(store, producto, requerido, {
		ubicaciones: scope?.ids,
	});
	for (const renglon of route.renglones) {
		touched.push(
			...tag_ubicacion(
				await apply_quant_delta(store, {
					...base,
					ubicacion: renglon.ubicacion,
					ubicacion_codigo: renglon.ubicacion_codigo,
					delta: -renglon.tomar,
				}),
				renglon.ubicacion,
				renglon.ubicacion_codigo,
			),
		);
	}
	if (route.faltante <= 0) return touched;
	const warehouse = scope?.almacen ?? (await find_warehouse_location(store));
	if (!warehouse?._id) return touched;
	const ubicacion = String(warehouse._id);
	const ubicacion_codigo = String(warehouse.codigo ?? warehouse.name ?? '');
	touched.push(
		...tag_ubicacion(
			await apply_quant_delta(store, {
				...base,
				ubicacion,
				ubicacion_codigo,
				delta: -route.faltante,
			}),
			ubicacion,
			ubicacion_codigo,
		),
	);
	return touched;
}

/** Rastro de lotes de una salida (los lotes salen por caducidad, FEFO): campos del movimiento. */
export function exit_lot_trace(touched: Array<QuantLot & { cantidad: number }>): ImperiumDoc {
	const by_lot = new Map<string, QuantLot & { cantidad: number }>();
	for (const t of touched) {
		if (!t.lote) continue;
		const prev = by_lot.get(t.lote);
		by_lot.set(t.lote, { ...t, cantidad: round_quantity((prev?.cantidad ?? 0) + Math.abs(Number(t.cantidad) || 0)) });
	}
	const lots = [...by_lot.values()];
	if (!lots.length) return {};
	if (lots.length === 1) {
		return { lote: lots[0].lote, lote_codigo: lots[0].lote_codigo, fecha_caducidad: lots[0].fecha_caducidad };
	}
	return {
		lote_codigo: lots.map((l) => l.lote_codigo || l.lote).join(', '),
		lotes_detalle: lots.map((l) => `${l.lote_codigo || l.lote} (${l.cantidad})`).join(', '),
	};
}

/** Cantidad que sale por producto en una venta POS (kits → componentes). */
async function pos_ticket_exits(
	store: ImperiumStore,
	ticket: ImperiumDoc,
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (String(ticket.ticket_type ?? 'VENTA').toUpperCase() !== 'VENTA') return out;
	if (!store.has('products')) return out;
	const add = (id: string, q: number) => out.set(id, round_quantity((out.get(id) ?? 0) + q));
	for (const item of as_array(ticket.items).map(as_object)) {
		const pid = String(item.item_id ?? item.producto ?? item.product_id ?? '');
		const qty = Number(item.quantity ?? item.cantidad ?? 0);
		if (!pid || !qty) continue;
		const product = await store.find_id('products', pid);
		if (!product) continue;
		const components = kit_components_of(product);
		if (components.length) {
			for (const c of components) add(c.producto, round_quantity(qty * c.cantidad));
			continue;
		}
		add(pid, qty);
	}
	return out;
}

/** Almacén de la venta: el de la sucursal de la caja o, si no, el del vendedor. */
export async function pos_ticket_scope(
	store: ImperiumStore,
	ticket: ImperiumDoc,
): Promise<WarehouseScope | null> {
	return warehouse_scope(store, await pos_ticket_warehouse_id(store, ticket));
}

/**
 * Antes de crear una venta POS: bloquea si dejaría existencia negativa (salvo
 * que se permita). Con almacén de sucursal o vendedor, cuenta solo la de él.
 */
export async function assert_pos_ticket_stock(
	store: ImperiumStore,
	ticket: ImperiumDoc,
): Promise<void> {
	const salidas = await pos_ticket_exits(store, ticket);
	if (!salidas.size) return;
	await assert_salida_sin_negativos(store, 'vender', salidas, await pos_ticket_scope(store, ticket), {
		libre: true,
	});
}

/**
 * Venta POS: resta lo vendido de la existencia del producto. Sin permiso de
 * negativos no baja de 0 (la venta ya se bloqueó antes); con permiso, sí.
 */
export async function register_pos_ticket_exit(
	store: ImperiumStore,
	ticket: ImperiumDoc,
	scope_override?: WarehouseScope | null,
): Promise<void> {
	if (String(ticket.ticket_type ?? 'VENTA').toUpperCase() !== 'VENTA') return;
	const items = as_array(ticket.items).map(as_object);
	const scope =
		scope_override !== undefined ? scope_override : items.length ? await pos_ticket_scope(store, ticket) : null;
	for (const item of items) {
		const pid = String(item.item_id ?? item.producto ?? item.product_id ?? '');
		const qty = Number(item.quantity ?? item.cantidad ?? 0);
		if (!pid || !qty || !store.has('products')) continue;
		const product = await store.find_id('products', pid);
		if (!product) continue;
		// Kit: salen sus componentes (cantidad del kit × cantidad del componente), no el kit.
		const components = kit_components_of(product);
		if (components.length) {
			for (const c of components) {
				const component = await store.find_id('products', c.producto);
				if (component) {
					await exit_product(store, ticket, component, round_quantity(qty * c.cantidad), scope);
				}
			}
			continue;
		}
		await exit_product(store, ticket, product, qty, scope);
	}
}

async function exit_product(
	store: ImperiumStore,
	ticket: ImperiumDoc,
	product: ImperiumDoc,
	qty: number,
	scope: WarehouseScope | null,
): Promise<void> {
	const pid = String(product._id ?? '');
	const previa = Number(product.existencia ?? 0);
	const next = (await allow_negative_stock(store))
		? round_quantity(previa - qty)
		: Math.max(previa - qty, 0);
	await store.update('products', pid, { existencia: next });
	const touched = await consume_exit_quants(store, product, previa - next, scope);
	await insert_pos_sale_movement(store, ticket, product, qty, previa, next, touched, scope);
}

function group_exit_touches(touched: ExitTouch[]) {
	const order: string[] = [];
	const by = new Map<string, { ubicacion: string; ubicacion_codigo: string; cantidad: number; lots: ExitTouch[] }>();
	for (const touch of touched) {
		let group = by.get(touch.ubicacion);
		if (!group) {
			group = { ubicacion: touch.ubicacion, ubicacion_codigo: touch.ubicacion_codigo, cantidad: 0, lots: [] };
			by.set(touch.ubicacion, group);
			order.push(touch.ubicacion);
		}
		group.cantidad = round_quantity(group.cantidad + Math.abs(Number(touch.cantidad) || 0));
		group.lots.push(touch);
	}
	return order.map((id) => by.get(id)!);
}

async function insert_pos_sale_movement(
	store: ImperiumStore,
	ticket: ImperiumDoc,
	product: ImperiumDoc,
	cantidad: number,
	stock_total_previo: number,
	stock_total_resultante: number,
	touched: ExitTouch[],
	scope: WarehouseScope | null = null,
): Promise<void> {
	if (!store.has('inventory-movement')) return;
	const groups = group_exit_touches(touched);
	const taken = round_quantity(groups.reduce((sum, group) => sum + group.cantidad, 0));
	const sold = round_quantity(cantidad);
	const last = groups.at(-1);
	if (last && sold > taken) last.cantidad = round_quantity(last.cantidad + sold - taken);
	if (!groups.length) {
		const warehouse = scope?.almacen ?? (await find_warehouse_location(store));
		await write_pos_sale_movement(store, ticket, product, {
			cantidad,
			stock_total_previo,
			stock_total_resultante,
			ubicacion_id: warehouse?._id ? String(warehouse._id) : '',
			ubicacion_nombre: String(warehouse?.name ?? ''),
			lot_trace: {},
		});
		return;
	}
	let previo = round_quantity(stock_total_previo);
	for (const [i, group] of groups.entries()) {
		const resultante =
			i === groups.length - 1
				? round_quantity(stock_total_resultante)
				: round_quantity(previo - group.cantidad);
		const loc = store.has('inventory-internal-location')
			? await store.find_id('inventory-internal-location', group.ubicacion)
			: null;
		await write_pos_sale_movement(store, ticket, product, {
			cantidad: group.cantidad,
			stock_total_previo: previo,
			stock_total_resultante: resultante,
			ubicacion_id: group.ubicacion,
			ubicacion_nombre: String(loc?.name ?? group.ubicacion_codigo),
			lot_trace: exit_lot_trace(group.lots),
		});
		previo = resultante;
	}
}

async function write_pos_sale_movement(
	store: ImperiumStore,
	ticket: ImperiumDoc,
	product: ImperiumDoc,
	parte: {
		cantidad: number;
		stock_total_previo: number;
		stock_total_resultante: number;
		ubicacion_id: string;
		ubicacion_nombre: string;
		lot_trace: ImperiumDoc;
	},
): Promise<void> {
	const { lotes_detalle, ...lot_fields } = parte.lot_trace;
	const producto = String(product._id ?? '');
	const apartado = round_quantity(Number(product.existenciaApartada ?? 0));
	await store.insert('inventory-movement', {
		name: `Venta POS ${String(product.name ?? producto)}`,
		producto,
		producto_id: producto,
		producto_nombre: product.name,
		producto_codigo: product.codigo,
		tipo_movimiento: 'salida_entrega',
		ubicacion_origen: parte.ubicacion_id || undefined,
		ubicacion_origen_id: parte.ubicacion_id || undefined,
		ubicacion_origen_nombre: parte.ubicacion_nombre,
		documento_tipo: 'pos-ticket',
		documento_id: String(ticket._id ?? ''),
		documento_modelo: 'PosTickets',
		documento_nombre: String(ticket.name ?? ticket.ticket_sequence ?? ''),
		documento_referencia: String(ticket.ticket_sequence ?? ''),
		description: lotes_detalle
			? `Salida por venta en punto de venta. Lotes: ${String(lotes_detalle)}`
			: 'Salida por venta en punto de venta',
		...lot_fields,
		cantidad: round_quantity(parte.cantidad),
		stock_total_previo: round_quantity(parte.stock_total_previo),
		stock_total_resultante: round_quantity(parte.stock_total_resultante),
		stock_apartado_previo: apartado,
		stock_apartado_resultante: apartado,
		fecha_movimiento: new Date().toISOString(),
	});
}
