/**
 * Apartado y salida logística de bultos, como InventoryMovementService
 * (`sync_order_logistics_reservation` / `register_package_delivery_exit`).
 * Empaque post-surtido: no-op (el stock ya salió al pasar a «surtido»).
 * Empaque pre-surtido: aparta existencia y la descuenta al confirmar entrega.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const WAREHOUSE_REF = 'inventory-internal-location-warehouse';
const LOGISTICS_REF = 'inventory-internal-location-logistics';
const CUSTOMER_REF = 'inventory-internal-location-customer';
const RESERVATION = 'apartado_logistica';
const RELEASE = 'liberacion_logistica';
const DELIVERY_EXIT = 'salida_entrega';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function is_id(value: string): boolean {
	return /^[a-f0-9]{24}$/i.test(value);
}

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

async function location_by_ref(store: ImperiumStore, ref: string) {
	if (!store.has('inventory-internal-location')) return null;
	return (
		(await store.find_where('inventory-internal-location', { _ref: ref })) ??
		(await store.find_where('inventory-internal-location', { ref }))
	);
}

async function get_order_reserved_quantities(store: ImperiumStore, pedido_id: string) {
	const reserved = new Map<string, number>();
	if (!store.has('inventory-movement')) return reserved;
	const { rows } = await store.find_many('inventory-movement', {
		where: { documento_tipo: 'pedido', documento_id: pedido_id },
		take: 5000,
		include_inactive: true,
		populate: false,
	});
	for (const row of rows) {
		const tipo = text(row.tipo_movimiento);
		if (tipo !== RESERVATION && tipo !== RELEASE) continue;
		const product_id = ref_id(row.producto) || text(row.producto_id);
		if (!product_id) continue;
		const signed = tipo === RESERVATION ? Number(row.cantidad ?? 0) : -Number(row.cantidad ?? 0);
		reserved.set(product_id, round_qty((reserved.get(product_id) ?? 0) + signed));
	}
	return reserved;
}

async function insert_movement(store: ImperiumStore, record: ImperiumDoc) {
	if (!store.has('inventory-movement')) return;
	const cantidad = round_qty(Number(record.cantidad ?? 0));
	if (cantidad <= 0) return;
	const dedupe_key = text(record.dedupe_key);
	if (dedupe_key) {
		const { rows } = await store.find_many('inventory-movement', {
			where: { dedupe_key },
			take: 1,
			include_inactive: true,
			populate: false,
		});
		if (rows.length) return;
	}
	const stock_apartado_previo = round_qty(Number(record.stock_apartado_previo ?? 0));
	const stock_apartado_resultante = round_qty(
		Number(record.stock_apartado_resultante ?? stock_apartado_previo),
	);
	const stock_total_previo = round_qty(Number(record.stock_total_previo ?? 0));
	const stock_total_resultante = round_qty(Number(record.stock_total_resultante ?? stock_total_previo));
	await store.insert('inventory-movement', {
		...record,
		name: `${text(record.tipo_movimiento)} | ${text(record.producto_nombre)}`,
		cantidad,
		stock_apartado_previo,
		stock_apartado_resultante,
		stock_total_previo,
		stock_total_resultante,
		stock_disponible_resultante: round_qty(stock_total_resultante - stock_apartado_resultante),
		dedupe_key: dedupe_key || undefined,
	});
}

export async function sync_order_logistics_reservation(
	store: ImperiumStore,
	pedido_id: string,
): Promise<void> {
	const normalized_order_id = text(pedido_id);
	if (!normalized_order_id || !is_id(normalized_order_id)) return;
	if (!store.has('delivery-package') || !store.has('products')) return;

	const { rows } = await store.find_many('delivery-package', {
		where: { pedido: normalized_order_id },
		take: 5000,
		include_inactive: false,
		populate: false,
	});
	const desired = new Map<string, number>();
	for (const pack of rows) {
		if (pack.is_active === false || text(pack.estado) === 'entregado') continue;
		for (const raw of as_array(pack.contenido)) {
			const item = as_object(raw);
			const product_id = ref_id(item.product) || text(item.product);
			const quantity = round_qty(Number(item.quantity ?? 0));
			if (!product_id || !is_id(product_id) || quantity <= 0) continue;
			desired.set(product_id, round_qty((desired.get(product_id) ?? 0) + quantity));
		}
	}

	const current = await get_order_reserved_quantities(store, normalized_order_id);
	const affected = [...new Set([...desired.keys(), ...current.keys()])];
	if (!affected.length) return;

	const pedido = await store.find_id('pedidos', normalized_order_id);
	if (!pedido) throw new Error('No se encontró el pedido para sincronizar inventario');
	const estado = text(pedido.estado);
	if (estado === 'surtido' || estado === 'enviado') return;

	const warehouse = await location_by_ref(store, WAREHOUSE_REF);
	const logistics = await location_by_ref(store, LOGISTICS_REF);
	const folio_referencia = text(pedido.folio_interno ?? pedido.folio);

	for (const product_id of affected) {
		const product = await store.find_id('products', product_id);
		if (!product || product.is_active === false) {
			throw new Error('Uno de los productos empacados ya no existe o está inactivo');
		}
		const desired_quantity = desired.get(product_id) ?? 0;
		const current_quantity = current.get(product_id) ?? 0;
		const difference = round_qty(desired_quantity - current_quantity);
		if (difference === 0) continue;

		const stock_total_previo = round_qty(Number(product.existencia ?? 0));
		const stock_apartado_previo = round_qty(Number(product.existenciaApartada ?? 0));
		if (difference > 0) {
			const available = round_qty(stock_total_previo - stock_apartado_previo);
			if (difference > available) {
				throw new Error(
					`No hay inventario suficiente para apartar ${difference} de ${product.name}`,
				);
			}
		}
		const stock_apartado_resultante = round_qty(stock_apartado_previo + difference);
		if (stock_apartado_resultante < 0) {
			throw new Error(
				`El apartado de ${product.name} quedaría negativo al sincronizar logística`,
			);
		}
		await store.update('products', product_id, {
			existenciaApartada: stock_apartado_resultante,
		});
		await insert_movement(store, {
			producto: product_id,
			producto_id: product_id,
			producto_nombre: product.name,
			producto_codigo: product.codigo,
			tipo_movimiento: difference > 0 ? RESERVATION : RELEASE,
			ubicacion_origen: warehouse?._id,
			ubicacion_origen_id: warehouse?._id,
			ubicacion_origen_nombre: warehouse?.name,
			ubicacion_destino: logistics?._id,
			ubicacion_destino_id: logistics?._id,
			ubicacion_destino_nombre: logistics?.name,
			documento_tipo: 'pedido',
			documento_id: String(pedido._id ?? normalized_order_id),
			documento_modelo: 'Pedidos',
			documento_nombre: text(pedido.name),
			documento_referencia: folio_referencia,
			description:
				difference > 0
					? 'Apartado automático por empaque logístico'
					: 'Liberación automática por ajuste de empaque logístico',
			cantidad: Math.abs(difference),
			stock_total_previo,
			stock_total_resultante: stock_total_previo,
			stock_apartado_previo,
			stock_apartado_resultante,
			fecha_movimiento: new Date().toISOString(),
		});
	}
}

export async function register_package_delivery_exit(
	store: ImperiumStore,
	package_record: ImperiumDoc,
	event_id: string,
	delivered_at: string,
): Promise<void> {
	const package_id = text(package_record._id);
	if (!package_id || !is_id(package_id)) {
		throw new Error('No se pudo registrar la salida del bulto entregado');
	}
	const grouped = new Map<
		string,
		{ quantity: number; product_name: string; product_code: string }
	>();
	for (const raw of as_array(package_record.contenido)) {
		const item = as_object(raw);
		const product_id = ref_id(item.product) || text(item.product);
		const quantity = round_qty(Number(item.quantity ?? 0));
		if (!product_id || !is_id(product_id) || quantity <= 0) continue;
		const current = grouped.get(product_id);
		if (!current) {
			grouped.set(product_id, {
				quantity,
				product_name: text(item.product_name),
				product_code: text(item.product_code),
			});
			continue;
		}
		current.quantity = round_qty(current.quantity + quantity);
	}
	if (!grouped.size) return;

	const pedido_id = ref_id(package_record.pedido) || text(package_record.pedido);
	if (pedido_id && is_id(pedido_id) && store.has('pedidos')) {
		const pedido = await store.find_id('pedidos', pedido_id);
		const estado = text(pedido?.estado);
		if (estado === 'surtido' || estado === 'enviado') return;
	}
	if (!store.has('products')) return;

	const logistics = await location_by_ref(store, LOGISTICS_REF);
	const customer = await location_by_ref(store, CUSTOMER_REF);
	const folio_referencia =
		text(package_record.pedido_folio_interno) || text(package_record.pedido_folio);

	for (const [product_id, grouped_item] of grouped) {
		const product = await store.find_id('products', product_id);
		if (!product || product.is_active === false) {
			throw new Error(
				`No se encontró el producto ${grouped_item.product_name} para registrar la entrega`,
			);
		}
		const quantity = grouped_item.quantity;
		const stock_total_previo = round_qty(Number(product.existencia ?? 0));
		const stock_apartado_previo = round_qty(Number(product.existenciaApartada ?? 0));
		if (quantity > stock_total_previo) {
			throw new Error(
				`No hay existencia suficiente para entregar ${quantity} de ${product.name}`,
			);
		}
		if (quantity > stock_apartado_previo) {
			throw new Error(
				`El inventario apartado de ${product.name} es insuficiente para registrar la entrega`,
			);
		}
		const stock_total_resultante = round_qty(stock_total_previo - quantity);
		const stock_apartado_resultante = round_qty(stock_apartado_previo - quantity);
		await store.update('products', product_id, {
			existencia: stock_total_resultante,
			existenciaApartada: stock_apartado_resultante,
		});
		await insert_movement(store, {
			producto: product_id,
			producto_id: product_id,
			producto_nombre: product.name,
			producto_codigo: product.codigo,
			tipo_movimiento: DELIVERY_EXIT,
			ubicacion_origen: logistics?._id,
			ubicacion_origen_id: logistics?._id,
			ubicacion_origen_nombre: logistics?.name,
			ubicacion_destino: customer?._id,
			ubicacion_destino_id: customer?._id,
			ubicacion_destino_nombre: customer?.name,
			documento_tipo: 'delivery-package',
			documento_id: package_id,
			documento_modelo: 'DeliveryPackage',
			documento_nombre: text(package_record.name),
			documento_referencia: folio_referencia,
			description: 'Salida automática por entrega confirmada al cliente',
			cantidad: quantity,
			stock_total_previo,
			stock_total_resultante,
			stock_apartado_previo,
			stock_apartado_resultante,
			fecha_movimiento: delivered_at,
			dedupe_key: `delivery:${package_id}:${product_id}:${event_id}`,
		});
	}
}
