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
	for await (const page of store.scan('inventory-movement', {
		where: {
			documento_tipo: 'pedido',
			documento_id: pedido_id,
			tipo_movimiento: { in: [RESERVATION, RELEASE] },
		},
		include_inactive: true,
	})) {
		for (const row of page) {
			const tipo = text(row.tipo_movimiento);
			if (tipo !== RESERVATION && tipo !== RELEASE) continue;
			const product_id = ref_id(row.producto) || text(row.producto_id);
			if (!product_id) continue;
			const signed = tipo === RESERVATION ? Number(row.cantidad ?? 0) : -Number(row.cantidad ?? 0);
			reserved.set(product_id, round_qty((reserved.get(product_id) ?? 0) + signed));
		}
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

	const desired = new Map<string, number>();
	for await (const page of store.scan('delivery-package', {
		where: { pedido: normalized_order_id },
		include_inactive: false,
	})) {
		for (const pack of page) {
			if (pack.is_active === false || text(pack.estado) === 'entregado') continue;
			for (const raw of as_array(pack.contenido)) {
				const item = as_object(raw);
				const product_id = ref_id(item.product) || text(item.product);
				const quantity = round_qty(Number(item.quantity ?? 0));
				if (!product_id || !is_id(product_id) || quantity <= 0) continue;
				desired.set(product_id, round_qty((desired.get(product_id) ?? 0) + quantity));
			}
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

function round_qty(value: unknown): number {
	return Number(Number(value ?? 0).toFixed(4));
}

/** `__get_statistics` de existencias: cantidad total y ubicaciones con stock. */
export async function stock_quant_stats_extras(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<{ total_cantidad: number; ubicaciones_con_existencia: number }> {
	let total_cantidad = 0;
	let ubicaciones_con_existencia = 0;
	for await (const page of store.scan('inventory-stock-quant', {
		include_inactive: true,
		mongo_match,
	})) {
		for (const row of page) {
			const qty = round_qty(row.cantidad);
			total_cantidad += qty;
			if (qty > 0) ubicaciones_con_existencia += 1;
		}
	}
	return {
		total_cantidad: round_qty(total_cantidad),
		ubicaciones_con_existencia,
	};
}

/** `__get_statistics` de movimientos: `total_quantity` + `by_type`. */
export async function inventory_movement_stats_extras(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<{
	total_quantity: number;
	by_type: Array<{ type: string | null; count: number; total_quantity: number }>;
}> {
	const grouped = new Map<string | null, { count: number; total_quantity: number }>();
	let total_quantity = 0;
	for await (const page of store.scan('inventory-movement', {
		include_inactive: true,
		mongo_match,
	})) {
		for (const row of page) {
			const raw = row.tipo_movimiento;
			const key = raw == null || raw === '' ? null : String(raw);
			const qty = round_qty(row.cantidad);
			total_quantity += qty;
			const current = grouped.get(key) ?? { count: 0, total_quantity: 0 };
			current.count += 1;
			current.total_quantity += qty;
			grouped.set(key, current);
		}
	}
	return {
		total_quantity: round_qty(total_quantity),
		by_type: [...grouped.entries()]
			.sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')))
			.map(([type, value]) => ({
				type,
				count: value.count,
				total_quantity: round_qty(value.total_quantity),
			})),
	};
}

function round_cost(value: unknown): number {
	return Number(Number(value ?? 0).toFixed(2));
}

function parse_stats_date(value: unknown, fallback: Date): Date {
	if (!value) return fallback;
	const parsed = new Date(String(value));
	return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function consume_fifo(
	queues: Map<string, Array<{ remaining: number; unit_cost: number }>>,
	product_id: string,
	quantity: number,
): number {
	let pending = round_qty(quantity);
	let consumed_cost = 0;
	const queue = queues.get(product_id) ?? [];
	let last_cost = queue[queue.length - 1]?.unit_cost ?? 0;
	while (pending > 0.000001 && queue.length) {
		const lot = queue[0]!;
		const take = Math.min(lot.remaining, pending);
		consumed_cost += take * lot.unit_cost;
		lot.remaining = round_qty(lot.remaining - take);
		pending = round_qty(pending - take);
		last_cost = lot.unit_cost;
		if (lot.remaining <= 0.000001) queue.shift();
	}
	if (pending > 0.000001 && last_cost > 0) {
		consumed_cost += pending * last_cost;
	}
	queues.set(product_id, queue);
	return round_cost(consumed_cost);
}

function sale_time(row: ImperiumDoc): number {
	return new Date(String(row.createdAt ?? row.created_at ?? '')).getTime();
}

function product_id_of(item: Record<string, unknown>): string {
	const raw = item.product ?? item.producto;
	if (raw && typeof raw === 'object') return String((raw as { _id?: unknown })._id ?? '').trim();
	return String(raw ?? '').trim();
}

/**
 * `__get_statistics` de entradas de costo: totales + `estimated_fifo`
 * del mes (o `date_from`/`date_to`) como el original.
 */
export async function cost_entry_stats(
	store: ImperiumStore,
	url?: URL,
	mongo_match?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	const now = new Date();
	const first_day = new Date(now.getFullYear(), now.getMonth(), 1);
	const date_from = parse_stats_date(url?.searchParams.get('date_from'), first_day);
	const date_to = parse_stats_date(url?.searchParams.get('date_to'), now);
	let total_quantity = 0;
	let total_cost = 0;
	let total_records = 0;
	const fifo_queues = new Map<string, Array<{ remaining: number; unit_cost: number }>>();
	for await (const page of store.scan('inventory-cost-entry', {
		include_inactive: true,
		mongo_match,
		order: 'fecha_entrada',
	})) {
		for (const entry of page) {
			total_records += 1;
			total_quantity += Number(entry.cantidad ?? 0);
			total_cost += Number(entry.costo_total ?? 0);
			const stamp = new Date(String(entry.fecha_entrada ?? entry.createdAt ?? '')).getTime();
			if (!Number.isFinite(stamp) || stamp > date_to.getTime()) continue;
			const product_id = product_id_of(entry) || String(entry.producto ?? '').trim();
			const quantity = round_qty(entry.cantidad);
			if (!product_id || quantity <= 0) continue;
			const queue = fifo_queues.get(product_id) ?? [];
			queue.push({
				remaining: quantity,
				unit_cost: Number(entry.costo_unitario ?? 0),
			});
			fifo_queues.set(product_id, queue);
		}
	}
	const from_ms = date_from.getTime();
	const to_ms = date_to.getTime();
	let period_sales_total = 0;
	let period_sales_quantity = 0;
	let period_fifo_cost = 0;
	const sales_by_product = new Map<
		string,
		{ quantity: number; sale_amount: number; fifo_cost: number }
	>();
	for await (const page of store.scan('pedidos', {
		include_inactive: false,
		order: 'created_at',
		where: { created_at: { lte: date_to.toISOString() } },
	})) {
		for (const sale of page) {
			if (sale.is_active === false || String(sale.estado ?? '') === 'cancelado') continue;
			const stamp = sale_time(sale);
			if (!Number.isFinite(stamp) || stamp > to_ms) continue;
			const in_period = stamp >= from_ms;
			for (const raw of as_array(sale.articulos)) {
				const item = as_object(raw);
				const product_id = product_id_of(item);
				const quantity = round_qty(item.cantidad);
				if (!product_id || quantity <= 0) continue;
				const fifo_cost = consume_fifo(fifo_queues, product_id, quantity);
				if (!in_period) continue;
				const sale_amount = round_cost(item.importe ?? 0);
				period_sales_total += sale_amount;
				period_sales_quantity += quantity;
				period_fifo_cost += fifo_cost;
				const current = sales_by_product.get(product_id) ?? {
					quantity: 0,
					sale_amount: 0,
					fifo_cost: 0,
				};
				current.quantity = round_qty(current.quantity + quantity);
				current.sale_amount = round_cost(current.sale_amount + sale_amount);
				current.fifo_cost = round_cost(current.fifo_cost + fifo_cost);
				sales_by_product.set(product_id, current);
			}
		}
	}
	return {
		total_records,
		total_quantity: round_qty(total_quantity),
		total_cost: round_cost(total_cost),
		date_range: { from: date_from, to: date_to },
		estimated_fifo: {
			sales_total: round_cost(period_sales_total),
			sales_quantity: round_qty(period_sales_quantity),
			inventory_cost: round_cost(period_fifo_cost),
			gross_margin: round_cost(period_sales_total - period_fifo_cost),
			by_product: [...sales_by_product.entries()].map(([product_id, summary]) => ({
				product_id,
				...summary,
				gross_margin: round_cost(summary.sale_amount - summary.fifo_cost),
			})),
		},
		last_updated: now,
		kpis: {
			total_records: { label: 'Total', value: total_records },
			total_quantity: { label: 'Cantidad', value: round_qty(total_quantity) },
			total_cost: { label: 'Costo', value: round_cost(total_cost) },
		},
	};
}
