/**
 * Ciclo de vida de pedidos: create/update como el service original
 * (`folio`, `folio_interno`, totales, transiciones, salida de inventario).
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import {
	assert_pedido_create_estado,
	assert_state_transition_allowed,
} from './group-access.ts';
import { broadcast_event } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

const WAREHOUSE_REF = 'inventory-internal-location-warehouse';
const CUSTOMER_REF = 'inventory-internal-location-customer';

export function emit_pedidos_updated() {
	broadcast_event('update', { action: 'pedidos_updated', data: [] });
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '');
	return String(value).trim();
}

function round_money(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function pad2(n: number) {
	return String(n).padStart(2, '0');
}

function build_folio(actor: ImperiumDoc | null): string {
	const user_name = String(actor?.name ?? actor?.nombre ?? 'USR') || 'USR';
	const d = new Date();
	const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
	return `${user_name}-${stamp}`;
}

function normalize_articulos_product(doc: ImperiumDoc, previos?: unknown) {
	if (!Array.isArray(doc.articulos)) return;
	const prev = Array.isArray(previos) ? previos : [];
	doc.articulos = doc.articulos.map((raw, index) => {
		const articulo = as_object(raw);
		let product = articulo.product;
		if (product && typeof product === 'object') {
			product = ref_id(product);
		}
		const vacio = product == null || product === '';
		if (vacio && prev[index] != null) {
			const previous = as_object(prev[index]).product;
			product =
				previous && typeof previous === 'object' ? ref_id(previous) : String(previous ?? '');
		}
		return { ...articulo, product };
	});
}

function normalize_lista_de_precios_id(doc: ImperiumDoc) {
	const lista = doc.listaDePreciosId;
	if (lista && typeof lista === 'object') {
		doc.listaDePreciosId = ref_id(lista);
	}
}

async function recompute_totals(store: ImperiumStore, doc: ImperiumDoc) {
	if (!Array.isArray(doc.articulos)) return;
	let importe = 0;
	const articulos = doc.articulos.map((raw) => {
		const articulo = as_object(raw);
		const cantidad = Number(articulo.cantidad) || 0;
		const precio = Number(articulo.precio) || 0;
		const importe_linea = round_money(cantidad * precio);
		importe += importe_linea;
		return { ...articulo, importe: importe_linea };
	});
	importe = round_money(importe);
	let iva_rate = 0;
	const lista_id = String(doc.listaDePreciosId ?? '').trim();
	if (lista_id && store.has('lista-de-precios')) {
		const lista = await store.find_id('lista-de-precios', lista_id);
		iva_rate = Number(lista?.iva ?? 0) || 0;
	}
	const iva = round_money(importe * (iva_rate / 100));
	doc.articulos = articulos;
	doc.importe = importe;
	doc.iva = iva;
	doc.total = round_money(importe + iva);
}

export async function prepare_pedido_create(
	store: ImperiumStore,
	doc: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const out: ImperiumDoc = { ...doc };
	delete out._id;
	delete out.folio_interno;
	normalize_articulos_product(out);
	normalize_lista_de_precios_id(out);
	await recompute_totals(store, out);
	await assert_pedido_create_estado(store, actor, out.estado ? String(out.estado) : undefined);
	out.usuario = actor?._id ? String(actor._id) : out.usuario;
	out.folio = build_folio(actor);
	out.folio_interno = await store.next_auto_increment('Pedidos', 'folio_interno', {
		resource: 'pedidos',
		context: out,
	});
	out.name = `PEDIDO-${out.folio}`;
	return out;
}

export async function prepare_pedido_update(
	store: ImperiumStore,
	doc: ImperiumDoc,
	actor: ImperiumDoc | null,
	previous: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const out: ImperiumDoc = { ...doc };
	delete out.eliminado;
	delete out.createdAt;
	delete out.updatedAt;
	delete out.folio_interno;
	normalize_articulos_product(out, previous?.articulos);
	normalize_lista_de_precios_id(out);
	await recompute_totals(store, out);
	await assert_state_transition_allowed(
		store,
		actor,
		previous?.estado != null ? String(previous.estado) : undefined,
		out.estado != null ? String(out.estado) : undefined,
	);
	if (previous?.folio_interno != null && previous.folio_interno !== '') {
		out.folio_interno = previous.folio_interno;
	}
	return out;
}

async function location_by_ref(store: ImperiumStore, ref: string) {
	if (!store.has('inventory-internal-location')) return null;
	return (
		(await store.find_where('inventory-internal-location', { _ref: ref })) ??
		(await store.find_where('inventory-internal-location', { ref }))
	);
}

export async function register_order_fulfillment_exit(
	store: ImperiumStore,
	pedido: ImperiumDoc,
): Promise<void> {
	const pedido_id = String(pedido._id ?? '');
	if (!pedido_id || !store.has('products')) return;
	const articulos = as_array(pedido.articulos).map(as_object);
	const hay_captura = articulos.some((a) => round_qty(Number(a.cantidad_surtida ?? 0)) > 0);
	const grouped = new Map<string, number>();
	for (const articulo of articulos) {
		const product_id = ref_id(articulo.product);
		const quantity = round_qty(
			Number(hay_captura ? articulo.cantidad_surtida ?? 0 : articulo.cantidad ?? 0),
		);
		if (!product_id || quantity <= 0) continue;
		grouped.set(product_id, round_qty((grouped.get(product_id) ?? 0) + quantity));
	}
	if (!grouped.size) return;
	const keys = [...grouped.keys()].map((id) => `order-fulfillment:${pedido_id}:${id}`);
	if (store.has('inventory-movement')) {
		const { rows } = await store.find_many('inventory-movement', {
			where: { dedupe_key: { in: keys } },
			take: keys.length,
			include_inactive: true,
			populate: false,
		});
		for (const row of rows) {
			const product_id = String(row.dedupe_key ?? '').split(':').pop();
			if (product_id) grouped.delete(product_id);
		}
	}
	if (!grouped.size) return;
	const warehouse = await location_by_ref(store, WAREHOUSE_REF);
	const customer = await location_by_ref(store, CUSTOMER_REF);
	const folio_referencia = String(pedido.folio_interno ?? pedido.folio ?? '');
	const documento_nombre = pedido.folio ? `PEDIDO-${pedido.folio}` : '';
	for (const [product_id, quantity] of grouped) {
		const product = await store.find_id('products', product_id);
		if (!product) continue;
		const stock_total_previo = round_qty(Number(product.existencia ?? 0));
		const stock_apartado_previo = round_qty(Number(product.existenciaApartada ?? 0));
		const stock_total_resultante = round_qty(stock_total_previo - quantity);
		await store.update('products', product_id, { existencia: stock_total_resultante });
		if (!store.has('inventory-movement')) continue;
		await store.insert('inventory-movement', {
			name: `Salida ${product.name ?? product_id}`,
			producto: product_id,
			producto_id: product_id,
			producto_nombre: product.name,
			producto_codigo: product.codigo,
			tipo_movimiento: 'salida_entrega',
			ubicacion_origen: warehouse?._id,
			ubicacion_origen_id: warehouse?._id,
			ubicacion_origen_nombre: warehouse?.name,
			ubicacion_destino: customer?._id,
			ubicacion_destino_id: customer?._id,
			ubicacion_destino_nombre: customer?.name,
			documento_tipo: 'pedido',
			documento_id: pedido_id,
			documento_modelo: 'Pedidos',
			documento_nombre,
			documento_referencia: folio_referencia,
			description: 'Salida automática por pedido surtido',
			cantidad: quantity,
			stock_total_previo,
			stock_total_resultante,
			stock_apartado_previo,
			stock_apartado_resultante: stock_apartado_previo,
			fecha_movimiento: new Date().toISOString(),
			dedupe_key: `order-fulfillment:${pedido_id}:${product_id}`,
		});
	}
}

export async function after_pedido_mutate(
	store: ImperiumStore,
	kind: 'create' | 'update' | 'delete',
	current: ImperiumDoc | null,
	previous?: ImperiumDoc | null,
): Promise<void> {
	if (
		kind === 'update' &&
		current &&
		previous &&
		String(previous.estado ?? '') !== 'surtido' &&
		String(current.estado ?? '') === 'surtido'
	) {
		const articulos = current.articulos ?? previous.articulos;
		await register_order_fulfillment_exit(store, { ...current, articulos });
	}
	emit_pedidos_updated();
}

export function is_pedido_resource(resource: string) {
	return resource === 'pedidos' || resource === 'pedidos-surtir';
}

function text(value: unknown): string {
	return String(value ?? '').trim();
}

export function decorate_pedido(doc: ImperiumDoc, mode: 'list' | 'detail'): ImperiumDoc {
	const out: ImperiumDoc = { ...doc };
	const folio = text(out.folio);
	if (folio) out.name = `PEDIDO-${folio}`;
	if (!text(out.fecha)) {
		out.fecha = out.createdAt ?? out.created_at ?? out.fecha;
	}
	const contact_id = ref_id(out.contacto_id) || ref_id(out.contacto);
	if (contact_id) out.contacto_id = contact_id;
	if (out.invoice_request_id != null && out.invoice_request_id !== '') {
		out.invoice_request_id = ref_id(out.invoice_request_id) || out.invoice_request_id;
	}
	if (mode === 'list') {
		const contact = as_object(out.contacto);
		if (contact._id) out.contacto = text(contact.name) || contact_id;
		const employee = as_object(out.assigned_employee);
		if (employee._id) {
			out.assigned_employee = text(employee.name) || ref_id(employee);
		}
	}
	return out;
}

const CONTACTO_DETAIL_KEYS = [
	'rfc',
	'codigo',
	'domicilios',
	'facturacion_dividida_habilitada',
	'facturacion_dividida_monto_maximo',
	'facturacion_requiere_autorizacion_cobranza',
] as const;

export async function hydrate_pedido_detail(
	store: ImperiumStore,
	doc: ImperiumDoc,
): Promise<ImperiumDoc> {
	const out = decorate_pedido(doc, 'detail');
	const contact_id = ref_id(out.contacto_id) || ref_id(out.contacto);
	if (contact_id && store.has('contacto')) {
		const contact = await store.find_id('contacto', contact_id);
		if (contact) {
			const picked: ImperiumDoc = { _id: contact._id, name: contact.name };
			for (const key of CONTACTO_DETAIL_KEYS) {
				if (contact[key] !== undefined) picked[key] = contact[key];
			}
			out.contacto = picked;
		}
	}
	const lista_id = ref_id(out.listaDePreciosId);
	if (lista_id && store.has('lista-de-precios')) {
		const lista = await store.find_id('lista-de-precios', lista_id);
		if (lista) {
			out.listaDePreciosId = {
				_id: lista._id,
				name: lista.name,
				...(lista.iva !== undefined ? { iva: lista.iva } : {}),
			};
		}
	}
	return out;
}

export async function enrich_pedidos_list(
	store: ImperiumStore,
	rows: ImperiumDoc[],
): Promise<ImperiumDoc[]> {
	const decorated = rows.map((row) => decorate_pedido(row, 'list'));
	if (!decorated.length || !store.has('contacto')) {
		return decorated.map((row) => ({ ...row, ruta: text(row.ruta) }));
	}
	const contact_ids = [
		...new Set(decorated.map((row) => ref_id(row.contacto_id)).filter(Boolean)),
	];
	if (!contact_ids.length) {
		return decorated.map((row) => ({ ...row, ruta: text(row.ruta) }));
	}
	const contacts = await store.find_many('contacto', {
		ids: contact_ids,
		take: contact_ids.length,
		include_inactive: true,
		populate: false,
	});
	const route_ids = new Set<string>();
	const routes_by_contact = new Map<string, string[]>();
	for (const contact of contacts.rows) {
		const rutas = as_array(contact.rutas).map(ref_id).filter(Boolean);
		routes_by_contact.set(String(contact._id), rutas);
		for (const id of rutas) route_ids.add(id);
	}
	const names = new Map<string, string>();
	if (route_ids.size && store.has('delivery-route')) {
		const routes = await store.find_many('delivery-route', {
			ids: [...route_ids],
			take: route_ids.size,
			include_inactive: true,
			populate: false,
		});
		for (const route of routes.rows) names.set(String(route._id), text(route.name));
	}
	return decorated.map((row) => {
		const ids = routes_by_contact.get(ref_id(row.contacto_id)) ?? [];
		return {
			...row,
			ruta: ids.map((id) => names.get(id)).filter(Boolean).join(', '),
		};
	});
}

function created_ms(doc: ImperiumDoc): number {
	return new Date(String(doc.createdAt ?? doc.created_at ?? '')).getTime();
}

function money_of(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

async function load_name_map(store: ImperiumStore, resource: string, ids: string[]) {
	const wanted = [...new Set(ids.filter(Boolean))];
	const names = new Map<string, string>();
	if (!wanted.length || !store.has(resource)) return names;
	const { rows } = await store.find_many(resource, {
		ids: wanted,
		take: wanted.length,
		include_inactive: true,
		populate: false,
	});
	for (const row of rows) names.set(String(row._id), text(row.name) || text(row.nombre));
	return names;
}

/**
 * Estadísticas de ventas del listado de pedidos: mismos filtros y shape
 * que `PedidosService.get_statistics` (KPIs + gráficas del panel).
 */
export async function pedidos_sales_stats(
	store: ImperiumStore,
	url?: URL,
	mongo_match?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	const now = new Date();
	const date_from = url?.searchParams.get('date_from')
		? new Date(String(url.searchParams.get('date_from')))
		: new Date(new Date().setDate(now.getDate() - 30));
	const date_to = url?.searchParams.get('date_to')
		? new Date(String(url.searchParams.get('date_to')))
		: new Date();
	const estados = [
		...(url?.searchParams.getAll('estados[]') ?? []),
		...(url?.searchParams.getAll('estados') ?? []),
	].filter(Boolean);
	const wanted_states = estados.length ? estados : ['confirmado'];
	const from_ms = date_from.getTime();
	const to_ms = date_to.getTime();
	const today_start = new Date();
	today_start.setHours(0, 0, 0, 0);
	const today_end = new Date();
	today_end.setHours(23, 59, 59, 999);
	const scan_from = new Date(Math.min(from_ms, today_start.getTime()));
	const scan_to = new Date(Math.max(to_ms, today_end.getTime()));
	const seller_sales = new Map<string, { total_vendido: number; pedidos_count: number }>();
	const client_sales = new Map<string, { total_comprado: number; pedidos_count: number }>();
	const trend = new Map<string, number>();
	const by_state = new Map<string, number>();
	const product_sales = new Map<string, { cantidad: number; importe: number }>();
	const today_by_seller = new Map<string, number>();
	let total_sales = 0;
	let total_orders = 0;
	for await (const page of store.scan('pedidos', {
		where: {
			created_at: { gte: scan_from.toISOString(), lte: scan_to.toISOString() },
			estado: { in: wanted_states },
		},
		include_inactive: true,
		mongo_match,
	})) {
		for (const row of page) {
			const created = created_ms(row);
			if (!Number.isFinite(created)) continue;
			const in_period = created >= from_ms && created <= to_ms;
			const in_today = created >= today_start.getTime() && created <= today_end.getTime();
			if (!in_period && !in_today) continue;
			const seller = ref_id(row.usuario) || 'sin-vendedor';
			if (in_today) {
				today_by_seller.set(seller, (today_by_seller.get(seller) ?? 0) + money_of(row.importe));
			}
			if (!in_period) continue;
			const importe = money_of(row.importe);
			total_sales += importe;
			total_orders += 1;
			const seller_row = seller_sales.get(seller) ?? { total_vendido: 0, pedidos_count: 0 };
			seller_row.total_vendido += importe;
			seller_row.pedidos_count += 1;
			seller_sales.set(seller, seller_row);
			const client = ref_id(row.contacto) || ref_id(row.contacto_id) || 'sin-cliente';
			const client_row = client_sales.get(client) ?? { total_comprado: 0, pedidos_count: 0 };
			client_row.total_comprado += importe;
			client_row.pedidos_count += 1;
			client_sales.set(client, client_row);
			const day = new Date(created).toISOString().slice(0, 10);
			trend.set(day, (trend.get(day) ?? 0) + importe);
			const estado = String(row.estado ?? 'sin-estado');
			by_state.set(estado, (by_state.get(estado) ?? 0) + importe);
			for (const raw of as_array(row.articulos)) {
				const line = as_object(raw);
				const pid = ref_id(line.product) || 'producto';
				const current = product_sales.get(pid) ?? { cantidad: 0, importe: 0 };
				current.cantidad += money_of(line.cantidad);
				current.importe += money_of(line.importe);
				product_sales.set(pid, current);
			}
		}
	}
	const top_seller_ids = [...seller_sales.entries()]
		.sort((a, b) => b[1].total_vendido - a[1].total_vendido)
		.slice(0, 10)
		.map(([id]) => id);
	const best_client_id = [...client_sales.entries()].sort(
		(a, b) => b[1].total_comprado - a[1].total_comprado,
	)[0]?.[0];
	const top_product_ids = [...product_sales.entries()]
		.sort((a, b) => b[1].cantidad - a[1].cantidad)
		.slice(0, 10)
		.map(([id]) => id);
	const [users, contacts, products] = await Promise.all([
		load_name_map(store, 'user', [...top_seller_ids, ...today_by_seller.keys()]),
		load_name_map(store, 'contacto', best_client_id ? [best_client_id] : []),
		load_name_map(store, 'products', top_product_ids),
	]);
	const top_sellers = [...seller_sales.entries()]
		.sort((a, b) => b[1].total_vendido - a[1].total_vendido)
		.slice(0, 10)
		.map(([id, row]) => ({
			name: users.get(id) || 'Sin Vendedor Asignado',
			total_vendido: row.total_vendido,
			pedidos_count: row.pedidos_count,
		}));
	const best = [...client_sales.entries()].sort((a, b) => b[1].total_comprado - a[1].total_comprado)[0];
	const best_client = best
		? {
				name: contacts.get(best[0]) || 'Sin Cliente',
				total_comprado: best[1].total_comprado,
				pedidos_count: best[1].pedidos_count,
			}
		: null;
	const sales_trend = [...trend.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([name, value]) => ({ name, value }));
	const sales_by_state = [...by_state.entries()].map(([name, value]) => ({ name, value }));
	const top_products = [...product_sales.entries()]
		.sort((a, b) => b[1].cantidad - a[1].cantidad)
		.slice(0, 10)
		.map(([id, row]) => ({
			name: products.get(id) || 'Producto',
			value: row.cantidad,
			cantidad: row.cantidad,
			importe: row.importe,
		}));
	const top = top_products[0];
	const most_sold_product = top
		? { name: top.name, cantidad: top.cantidad, importe: top.importe }
		: null;
	const sales_today = [...today_by_seller.entries()].map(([id, value]) => ({
		name: users.get(id) || 'Sin Vendedor Asignado',
		value,
	}));
	return {
		date_range: { from: date_from, to: date_to },
		filters: { estados: wanted_states },
		kpis: {
			total_sales,
			total_orders,
			average_ticket: total_orders ? total_sales / total_orders : 0,
			total_sellers: seller_sales.size,
		},
		charts: {
			sales_today: { data: sales_today },
			top_products: { data: top_products },
			most_sold_product,
			top_sellers: { data: top_sellers },
			sales_trend: { data: sales_trend },
			sales_by_state: { data: sales_by_state },
			best_client,
		},
		__export_data: {
			top_sellers,
			top_products,
			sales_trend,
			sales_by_state,
		},
	};
}
