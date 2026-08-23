/**
 * Órdenes de compra: create/update y entrada de inventario como el service original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import {
	apply_quant_delta,
	recompute_product_existencia,
} from './delivery-return-flow.ts';
import type { ImperiumStore } from './store.ts';

const WAREHOUSE_REF = 'inventory-internal-location-warehouse';
const RECEPTIONS_REF = 'inventory-internal-location-receptions';
const RECEPTION_CONFIG_REF = 'configuration-inventory-recepcion-default-location';

function config_ref(value: unknown): string {
	let current = value;
	if (typeof current === 'string') {
		const trimmed = current.trim();
		if (!trimmed) return '';
		try {
			current = JSON.parse(trimmed);
		} catch {
			current = trimmed.replace(/^"+|"+$/g, '');
		}
	}
	return text(current);
}
const EDITABLE = new Set(['borrador', 'aprobada']);

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function round_money(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

function positive_number(value: unknown, field_name: string, allow_zero = true): number {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n)) throw new Error(`El campo ${field_name} debe ser numérico`);
	if (!allow_zero && n <= 0) throw new Error(`El campo ${field_name} debe ser mayor que cero`);
	return n;
}

function build_name(payload: ImperiumDoc): string {
	const provided = text(payload.name);
	if (provided) return provided;
	const source_reference = text(payload.referencia_origen);
	const supplier_name = text(payload.proveedor_nombre);
	if (source_reference && supplier_name) return `Compra ${source_reference} - ${supplier_name}`;
	if (source_reference) return `Compra ${source_reference}`;
	if (supplier_name) return `Compra a ${supplier_name}`;
	return `Orden de compra ${new Date().toISOString().slice(0, 10)}`;
}

function normalize_item(raw_item: ImperiumDoc, index: number) {
	const cantidad = positive_number(raw_item.cantidad, `articulos[${index}].cantidad`, false);
	const cantidad_recibida = positive_number(
		raw_item.cantidad_recibida,
		`articulos[${index}].cantidad_recibida`,
	);
	const costo_unitario = positive_number(
		raw_item.costo_unitario,
		`articulos[${index}].costo_unitario`,
	);
	if (cantidad_recibida > cantidad) {
		throw new Error(
			`La cantidad recibida de la partida ${index + 1} no puede exceder la cantidad solicitada`,
		);
	}
	const producto_nombre = text(raw_item.producto_nombre ?? raw_item.descripcion_origen);
	if (!producto_nombre) {
		throw new Error(`La partida ${index + 1} requiere un producto o descripción`);
	}
	const producto = raw_item.producto
		? typeof raw_item.producto === 'object'
			? ref_id(raw_item.producto)
			: text(raw_item.producto)
		: undefined;
	return {
		...raw_item,
		producto,
		producto_nombre,
		producto_codigo: text(raw_item.producto_codigo),
		codigo_proveedor: text(raw_item.codigo_proveedor),
		descripcion_origen: text(raw_item.descripcion_origen),
		cantidad,
		cantidad_recibida,
		costo_unitario,
		importe: round_money(cantidad * costo_unitario),
	};
}

function normalize_payload(payload: ImperiumDoc): ImperiumDoc {
	const articulos = as_array(payload.articulos).map((raw, index) =>
		normalize_item(as_object(raw), index),
	);
	if (!articulos.length) {
		throw new Error('La orden de compra debe contener al menos una partida');
	}
	const total_cantidad = round_qty(articulos.reduce((s, item) => s + Number(item.cantidad), 0));
	const total_recibido = round_qty(
		articulos.reduce((s, item) => s + Number(item.cantidad_recibida ?? 0), 0),
	);
	const subtotal = round_money(articulos.reduce((s, item) => s + Number(item.importe), 0));
	return {
		...payload,
		name: build_name(payload),
		description: text(payload.description),
		proveedor: payload.proveedor ? ref_id(payload.proveedor) || text(payload.proveedor) : undefined,
		proveedor_nombre: text(payload.proveedor_nombre),
		proveedor_rfc: text(payload.proveedor_rfc),
		referencia_origen: text(payload.referencia_origen),
		articulos,
		total_cantidad,
		total_recibido,
		subtotal,
	};
}

export async function prepare_purchase_order_create(
	store: ImperiumStore,
	doc: ImperiumDoc,
): Promise<ImperiumDoc> {
	const out = normalize_payload({ ...doc });
	delete out._id;
	delete out.folio_interno;
	out.estado = 'borrador';
	out.state = 'borrador';
	out.folio_interno = await store.next_auto_increment('PurchaseOrder', 'folio_interno', {
		resource: 'purchase-order',
	});
	if (!out.tipo_origen) out.tipo_origen = 'manual';
	return out;
}

export async function prepare_purchase_order_update(
	doc: ImperiumDoc,
	previous: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró la orden de compra indicada');
	if (!EDITABLE.has(text(previous.estado))) {
		throw new Error('No puedes modificar una orden con recepciones registradas');
	}
	const out = normalize_payload({ ...previous, ...doc });
	delete out.folio_interno;
	out.estado = previous.estado;
	out.fecha_aprobacion = previous.fecha_aprobacion;
	out.fecha_confirmacion = previous.fecha_confirmacion;
	out.recepciones = previous.recepciones ?? [];
	out.folio_interno = previous.folio_interno;
	return out;
}

export async function resolve_reception_location(
	store: ImperiumStore,
	preferred_id?: string,
): Promise<{ id: string; codigo: string; name: string } | null> {
	if (preferred_id && store.has('inventory-internal-location')) {
		const loc = await store.find_id('inventory-internal-location', preferred_id);
		if (loc) {
			return {
				id: String(loc._id),
				codigo: text(loc.codigo),
				name: text(loc.name),
			};
		}
	}
	if (!store.has('inventory-internal-location')) return null;
	let ref = RECEPTIONS_REF;
	if (store.has('configuration')) {
		const cfg =
			(await store.find_where('configuration', { _ref: RECEPTION_CONFIG_REF })) ??
			(await store.find_where('configuration', { ref: RECEPTION_CONFIG_REF }));
		const configured = config_ref(cfg?.value);
		if (configured) ref = configured;
	}
	const by_ref =
		(await store.find_where('inventory-internal-location', { _ref: ref })) ??
		(await store.find_where('inventory-internal-location', { ref })) ??
		(await store.find_where('inventory-internal-location', { _ref: RECEPTIONS_REF })) ??
		(await store.find_where('inventory-internal-location', { _ref: WAREHOUSE_REF }));
	if (!by_ref) return null;
	return {
		id: String(by_ref._id),
		codigo: text(by_ref.codigo),
		name: text(by_ref.name),
	};
}

export async function apply_purchase_receipt_stock(
	store: ImperiumStore,
	params: {
		producto: string;
		cantidad: number;
		costo_unitario: number;
		source: ImperiumDoc;
		receipt_key: string;
		ubicacion_destino?: string;
		ubicacion_destino_nombre?: string;
		referencia?: string;
	},
): Promise<void> {
	const product = await store.find_id('products', params.producto);
	if (!product) {
		throw new Error('No fue posible cargar uno de los productos de la recepción');
	}
	if (product.puedoComprarlo !== true && product.puedoComprarlo !== 'true' && product.puedoComprarlo !== 1) {
		throw new Error('Una o más partidas apuntan a productos no comprables o inexistentes');
	}
	const cantidad = round_qty(params.cantidad);
	const costo = round_money(params.costo_unitario);
	const stock_previo = round_qty(Number(product.existencia ?? 0));
	const stock_apartado = round_qty(Number(product.existenciaApartada ?? 0));
	const stock_base = Math.max(stock_previo, 0);
	const costo_total = round_money(cantidad * costo);
	const stock_resultante = round_qty(stock_previo + cantidad);
	const avg = round_money(Number(product.costoCompraPromedio ?? 0));
	const costo_promedio = round_money(
		stock_base + cantidad > 0
			? (stock_base * avg + costo_total) / (stock_base + cantidad)
			: costo,
	);
	const fecha = new Date().toISOString();
	await store.update('products', params.producto, {
		existencia: stock_resultante,
		ultimoCostoCompra: costo,
		costoCompraPromedio: costo_promedio,
		fechaUltimaCompra: fecha,
	});
	const destination = await resolve_reception_location(store, params.ubicacion_destino);
	if (store.has('inventory-cost-entry')) {
		await store.insert('inventory-cost-entry', {
			name: `${text(params.source.name)} - ${text(product.name)}`,
			description: `Entrada generada por la recepción ${params.receipt_key} de la orden ${text(params.source.name)}`,
			receipt_key: params.receipt_key,
			orden_compra: params.source._id,
			orden_compra_nombre: params.source.name,
			orden_compra_folio: params.source.folio_interno,
			producto: params.producto,
			producto_nombre: text(product.name),
			producto_codigo: text(product.codigo),
			cantidad,
			costo_unitario: costo,
			costo_total,
			stock_previo,
			stock_resultante,
			costo_promedio_resultante: costo_promedio,
			fecha_entrada: fecha,
		});
	}
	if (store.has('inventory-movement')) {
		await store.insert('inventory-movement', {
			name: `Recepción ${text(product.name)}`,
			producto: params.producto,
			producto_id: params.producto,
			producto_nombre: text(product.name),
			producto_codigo: text(product.codigo),
			tipo_movimiento: 'recepcion_compra',
			ubicacion_destino: destination?.id,
			ubicacion_destino_id: destination?.id,
			ubicacion_destino_nombre: params.ubicacion_destino_nombre || destination?.codigo || destination?.name,
			documento_tipo: 'purchase-order',
			documento_id: String(params.source._id ?? ''),
			documento_modelo: 'PurchaseOrder',
			documento_nombre: text(params.source.name),
			documento_referencia:
				text(params.referencia) ||
				text(params.source.referencia_origen) ||
				text(params.source.folio_interno),
			description: `Recepción de compra ${params.receipt_key}`,
			cantidad,
			costo_unitario: costo,
			stock_total_previo: stock_previo,
			stock_total_resultante: stock_resultante,
			stock_apartado_previo: stock_apartado,
			stock_apartado_resultante: stock_apartado,
			fecha_movimiento: fecha,
			dedupe_key: `purchase-receipt:${params.source._id}:${params.receipt_key}:${params.producto}`,
		});
	}
	if (destination) {
		await apply_quant_delta(store, {
			producto: params.producto,
			producto_nombre: text(product.name),
			producto_codigo: text(product.codigo),
			ubicacion: destination.id,
			ubicacion_codigo: destination.codigo || destination.name,
			delta: cantidad,
		});
		await recompute_product_existencia(store, params.producto);
		await store.update('products', params.producto, {
			ultimoCostoCompra: costo,
			costoCompraPromedio: costo_promedio,
			fechaUltimaCompra: fecha,
		});
	}
}

/**
 * Estadísticas de órdenes de compra: mismos totales, `by_state` y
 * `daily_stats` que el `__get_statistics` original.
 */
export async function purchase_order_stats(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	const { rows } = await store.find_many('purchase-order', {
		take: 5000,
		include_inactive: true,
		populate: false,
		mongo_match,
	});
	const total_records = rows.length;
	const active_records = rows.filter((row) => row.is_active !== false).length;
	const inactive_records = total_records - active_records;
	const grouped = new Map<string, { count: number; subtotal: number; total_recibido: number }>();
	for (const row of rows) {
		const state = text(row.estado ?? row.state) || 'sin_estado';
		const current = grouped.get(state) ?? { count: 0, subtotal: 0, total_recibido: 0 };
		current.count += 1;
		current.subtotal += Number(row.subtotal ?? 0) || 0;
		current.total_recibido += Number(row.total_recibido ?? 0) || 0;
		grouped.set(state, current);
	}
	const by_state = [...grouped.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([state, item]) => ({
			state,
			count: item.count,
			subtotal: round_money(item.subtotal),
			total_recibido: round_qty(item.total_recibido),
		}));
	const thirty_days_ago = new Date();
	thirty_days_ago.setDate(thirty_days_ago.getDate() - 30);
	const from_ms = thirty_days_ago.getTime();
	const daily = new Map<string, number>();
	for (const row of rows) {
		const created = new Date(String(row.createdAt ?? row.created_at ?? '')).getTime();
		if (!Number.isFinite(created) || created < from_ms) continue;
		const day = new Date(created).toISOString().slice(0, 10);
		daily.set(day, (daily.get(day) ?? 0) + 1);
	}
	const daily_stats = [...daily.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, count]) => ({ date, count }));
	return {
		total_records,
		active_records,
		inactive_records,
		by_state,
		date_range: { from: thirty_days_ago, to: new Date() },
		daily_stats,
		last_updated: new Date(),
		kpis: {
			total_records: { label: 'Total', value: total_records },
			active_records: { label: 'Activas', value: active_records },
			inactive_records: { label: 'Inactivas', value: inactive_records },
		},
		charts: {
			by_state: {
				data: by_state.map((item) => ({
					name: item.state,
					value: item.count,
				})),
			},
		},
	};
}
