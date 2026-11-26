/**
 * Ciclo de vida de pedidos: create/update como el service original
 * (`folio`, `folio_interno`, totales, transiciones, salida de inventario).
 */
import { assign_capture_gps, resolve_capture_gps } from './delivery-gps.ts';
import { routes_by_contact, ruta_names } from './contacto-rutas.ts';
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import {
	assert_pedido_create_estado,
	assert_state_transition_allowed,
} from './group-access.ts';
import { product_has_quants } from './delivery-return-flow.ts';
import { consume_exit_quants } from './inventory-exit.ts';
import {
	apartado_logistica_por_almacen,
	sync_pedido_status_reservation,
} from './inventory-logistics-flow.ts';
import { pedido_warehouse_id, scope_stock, user_warehouse_id, warehouse_scope } from './warehouse-scope.ts';
import {
	ALLOW_NEGATIVE_STOCK_REF,
	allow_negative_stock,
	mensaje_negativos,
} from './negative-stock.ts';

export { ALLOW_NEGATIVE_STOCK_REF, allow_negative_stock };
import { read_config_value } from './subject-versions.ts';
import { broadcast_event } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

const WAREHOUSE_REF = 'inventory-internal-location-warehouse';
const CUSTOMER_REF = 'inventory-internal-location-customer';
const ESTADOS_ANTES_DE_CONFIRMAR = new Set(['', 'borrador']);

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
	opciones: { validar_confirmacion?: boolean } = {},
): Promise<ImperiumDoc> {
	const out: ImperiumDoc = { ...doc };
	delete out._id;
	delete out.folio_interno;
	normalize_articulos_product(out);
	normalize_lista_de_precios_id(out);
	await recompute_totals(store, out);
	await assert_pedido_create_estado(store, actor, out.estado ? String(out.estado) : undefined);
	out.usuario = actor?._id ? String(actor._id) : out.usuario;
	if (!ref_id(out.almacen) && actor?._id) {
		const almacen = await user_warehouse_id(store, actor);
		if (almacen) out.almacen = almacen;
	}
	if (text(out.estado) === 'confirmado' && opciones.validar_confirmacion !== false) {
		await assert_pedido_confirmable(store, out);
	}
	await sync_pedido_status_reservation(store, out, { dry_run: true });
	const folio_base = build_folio(actor);
	out.folio = folio_base;
	out.folio_interno = await store.next_auto_increment('Pedidos', 'folio_interno', {
		resource: 'pedidos',
		context: out,
	});
	// Usuario y hora no bastan: dos altas del mismo usuario en el mismo segundo
	// (lote offline, doble clic, semillas) compartían folio (Odoo #267). El
	// folio interno sale de un contador atómico, así que el sufijo lo hace único.
	out.folio = `${folio_base}-${out.folio_interno}`;
	out.name = `PEDIDO-${out.folio}`;
	if (!text(out.fecha)) out.fecha = new Date().toISOString();
	out.search_field = await pedido_search_field(store, out);
	assign_capture_gps(out, 'order', resolve_capture_gps(out, 'order', 'toma del pedido'));
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
	// La ruta se deriva de delivery-route.contacts al leer (#275): no se guarda.
	delete out.ruta;
	normalize_articulos_product(out, previous?.articulos);
	normalize_lista_de_precios_id(out);
	await recompute_totals(store, out);
	await assert_state_transition_allowed(
		store,
		actor,
		previous?.estado != null ? String(previous.estado) : undefined,
		out.estado != null ? String(out.estado) : undefined,
	);
	if (previous) {
		const pedido = {
			...previous,
			...out,
			_id: previous._id,
			articulos: out.articulos ?? previous.articulos,
			almacen: out.almacen ?? previous.almacen,
			usuario: out.usuario ?? previous.usuario,
		};
		if (
			text(out.estado) === 'confirmado' &&
			ESTADOS_ANTES_DE_CONFIRMAR.has(text(previous.estado))
		) {
			await assert_pedido_confirmable(store, pedido);
		}
		// Validar el apartado antes de guardar: si no alcanza, el pedido no
		// cambia de etapa (antes quedaba en Por surtir sin apartar nada).
		await sync_pedido_status_reservation(store, pedido, { dry_run: true });
	}
	if (
		previous &&
		String(previous.estado ?? '') !== 'surtido' &&
		String(out.estado ?? '') === 'surtido'
	) {
		const almacen = await pedido_warehouse_id(store, {
			almacen: out.almacen ?? previous.almacen,
			usuario: out.usuario ?? previous.usuario,
		});
		if (almacen && !ref_id(out.almacen ?? previous.almacen)) out.almacen = almacen;
		await assert_surtido_sin_negativos(
			store,
			out.articulos ?? previous.articulos,
			almacen || undefined,
		);
	}
	if (previous?.folio_interno != null && previous.folio_interno !== '') {
		out.folio_interno = previous.folio_interno;
	}
	if (String(out.order_gps_status ?? '').trim()) {
		assign_capture_gps(out, 'order', resolve_capture_gps(out, 'order', 'toma del pedido'));
	}
	if (!text(out.fecha) && text(previous?.fecha)) out.fecha = previous?.fecha;
	out.search_field = await pedido_search_field(store, { ...(previous ?? {}), ...out });
	return out;
}

async function pedido_search_field(store: ImperiumStore, doc: ImperiumDoc): Promise<string> {
	const contacto_id = ref_id(doc.contacto_id) || ref_id(doc.contacto);
	let nombre = '';
	if (contacto_id && store.has('contacto')) {
		const contacto = await store.find_id('contacto', contacto_id);
		nombre = text(contacto?.name);
	}
	if (!nombre && doc.contacto && typeof doc.contacto === 'object') {
		nombre = text(as_object(doc.contacto).name);
	}
	const lineas = as_array(doc.articulos)
		.map((raw) => text(as_object(raw).observaciones))
		.filter(Boolean);
	return [nombre, text(doc.observaciones), ...lineas].filter(Boolean).join('\n');
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
	const scope = await warehouse_scope(store, await pedido_warehouse_id(store, pedido));
	const warehouse = scope?.almacen ?? (await location_by_ref(store, WAREHOUSE_REF));
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
		await consume_exit_quants(store, product, quantity, scope);
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
	const pedido = kind === 'delete' ? previous : current;
	if (pedido) {
		const con_lineas = {
			...pedido,
			articulos: pedido.articulos ?? previous?.articulos,
			almacen: pedido.almacen ?? previous?.almacen,
			usuario: pedido.usuario ?? previous?.usuario,
		};
		// Liberar el apartado antes de la salida: si sigue apartado, no hay
		// disponible para descontar al pasar a surtido.
		await sync_pedido_status_reservation(store, con_lineas, {
			deleted: kind === 'delete',
		});
	}
	if (
		kind === 'update' &&
		current &&
		previous &&
		String(previous.estado ?? '') !== 'surtido' &&
		String(current.estado ?? '') === 'surtido'
	) {
		const articulos = current.articulos ?? previous.articulos;
		await register_order_fulfillment_exit(store, {
			...current,
			articulos,
			almacen: current.almacen ?? previous.almacen,
			usuario: current.usuario ?? previous.usuario,
		});
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
		const user_id = ref_id(out.usuario_id) || ref_id(out.usuario);
		if (user_id && looks_like_record_id(user_id)) out.usuario_id = user_id;
		const user = as_object(out.usuario);
		if (user._id) out.usuario = text(user.name) || user_id;
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
	// #275: el detalle muestra vendedor y ruta por nombre, igual que la lista.
	const by_contact = contact_id ? await routes_by_contact(store) : new Map();
	out.ruta = ruta_names(by_contact.get(contact_id));
	const uid = usuario_id_of(out);
	if (uid) {
		out.usuario_id = uid;
		const name =
			usuario_name_of(out) || ((await load_name_map(store, 'user', [uid])).get(uid) ?? '');
		out.usuario = { _id: uid, name };
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
	const by_contact = decorated.length ? await routes_by_contact(store) : new Map();
	const missing_ids = decorated
		.map((row) => ({ id: usuario_id_of(row), name: usuario_name_of(row) }))
		.filter((row) => row.id && !row.name)
		.map((row) => row.id);
	const user_names = missing_ids.length
		? await load_name_map(store, 'user', missing_ids)
		: new Map();
	return decorated.map((row) => {
		const uid = usuario_id_of(row);
		const name = usuario_name_of(row) || (uid ? (user_names.get(uid) ?? '') : '');
		return {
			...row,
			ruta: ruta_names(by_contact.get(ref_id(row.contacto_id))),
			usuario: name,
			...(uid ? { usuario_id: uid } : {}),
		};
	});
}

function usuario_id_of(row: ImperiumDoc): string {
	const from_id = ref_id(row.usuario_id);
	if (from_id && looks_like_record_id(from_id)) return from_id;
	const from_user = ref_id(row.usuario);
	return looks_like_record_id(from_user) ? from_user : '';
}

function usuario_name_of(row: ImperiumDoc): string {
	const user = as_object(row.usuario);
	const from_object = text(user.name);
	if (from_object) return from_object;
	const raw = text(row.usuario);
	return raw && !looks_like_record_id(raw) ? raw : '';
}

/** Id de documento (ObjectId de 24 hex o UUID). Un nombre de vendedor no aplica. */
export function looks_like_record_id(value: string): boolean {
	const text_value = String(value ?? '').trim();
	return (
		/^[a-f0-9]{24}$/i.test(text_value) ||
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			text_value,
		)
	);
}

const NO_MATCH_USUARIO = '__no_match__';

/**
 * El filtro de columna Vendedor manda el `name` del usuario (`?usuario=IA Vendedor`).
 * En la tabla `usuario` es el id: se resuelve a `{ in: ids }` antes del WHERE.
 */
export async function resolve_pedidos_usuario_filter(
	store: ImperiumStore,
	where: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (!where || (where.usuario == null && where.usuario_id == null)) return where;
	const raw = where.usuario ?? where.usuario_id;
	const values = Array.isArray((raw as { in?: unknown[] })?.in)
		? (raw as { in: unknown[] }).in.map((item) => String(item ?? '').trim())
		: [String(raw ?? '').trim()];
	const ids: string[] = [];
	const names: string[] = [];
	for (const value of values.filter(Boolean)) {
		if (looks_like_record_id(value)) ids.push(value);
		else names.push(value);
	}
	if (names.length && store.has('user')) {
		const found = await store.find_many('user', {
			where: names.length === 1 ? { name: names[0] } : { name: { in: names } },
			take: 200,
			include_inactive: true,
			populate: false,
			skip_total: true,
		});
		const wanted = new Set(names);
		for (const row of found.rows) {
			const id = String(row._id ?? '').trim();
			const name = text(row.name);
			if (id && wanted.has(name)) ids.push(id);
		}
	}
	const next = { ...where };
	delete next.usuario_id;
	next.usuario = ids.length ? { in: [...new Set(ids)] } : NO_MATCH_USUARIO;
	return next;
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

export type FaltanteExistencia = {
	product_id: string;
	nombre: string;
	requerido: number;
	disponible: number;
};

/**
 * Renglones de un pedido que no alcanzan con la existencia libre
 * (`existencia - existenciaApartada`) del producto. Un producto inexistente
 * cuenta como disponible 0. Se agrupa por producto para no aprobar dos renglones
 * del mismo artículo que juntos rebasan la existencia. Con `almacen` cuenta
 * solo la existencia de ese almacén (el del vendedor). `comprometido` resta
 * lo ya aceptado en el mismo lote, con clave almacén resuelto y producto.
 */
function clave_comprometido(scope_id: string, product_id: string): string {
	return `${scope_id}|${product_id}`;
}

export function acumular_comprometido(
	comprometido: Map<string, number>,
	scope_id: string,
	articulos_raw: unknown,
): void {
	for (const articulo of as_array(articulos_raw).map(as_object)) {
		const product_id = ref_id(articulo.product);
		const quantity = round_qty(Number(articulo.cantidad ?? 0));
		if (!product_id || !(quantity > 0)) continue;
		const key = clave_comprometido(scope_id, product_id);
		comprometido.set(key, round_qty((comprometido.get(key) ?? 0) + quantity));
	}
}

export async function faltantes_de_existencia(
	store: ImperiumStore,
	articulos_raw: unknown,
	opts: {
		modo?: 'pedido' | 'surtido';
		almacen?: unknown;
		comprometido?: Map<string, number>;
	} = {},
): Promise<FaltanteExistencia[]> {
	if (!store.has('products')) return [];
	const surtido = opts.modo === 'surtido';
	const articulos = as_array(articulos_raw).map(as_object);
	// Al surtir se descuenta lo capturado (`cantidad_surtida`) si hay captura,
	// igual que `register_order_fulfillment_exit`; y del total, no de lo libre.
	const hay_captura =
		surtido && articulos.some((a) => round_qty(Number(a.cantidad_surtida ?? 0)) > 0);
	const grouped = new Map<string, number>();
	for (const articulo of articulos) {
		const product_id = ref_id(articulo.product);
		const quantity = round_qty(
			Number(hay_captura ? articulo.cantidad_surtida ?? 0 : articulo.cantidad ?? 0),
		);
		if (!product_id || !(quantity > 0)) continue;
		grouped.set(product_id, round_qty((grouped.get(product_id) ?? 0) + quantity));
	}
	const faltantes: FaltanteExistencia[] = [];
	const scope = grouped.size ? await warehouse_scope(store, opts.almacen) : null;
	const scope_id = scope ? String(scope.almacen._id) : '';
	const apartado_pedidos =
		scope && !surtido ? await apartado_logistica_por_almacen(store, scope_id) : null;
	for (const [product_id, requerido] of grouped) {
		const product = await store.find_id('products', product_id);
		const apartado_aqui =
			apartado_pedidos && (await product_has_quants(store, product_id))
				? apartado_pedidos.get(product_id) ?? 0
				: 0;
		const disponible = !product
			? 0
			: scope
				? round_qty((await scope_stock(store, product, scope, { libre: !surtido })) - apartado_aqui)
				: round_qty(
					Number(product.existencia ?? 0) -
						(surtido ? 0 : Math.max(Number(product.existenciaApartada ?? 0), 0)),
				);
		const ya = opts.comprometido?.get(clave_comprometido(scope_id, product_id)) ?? 0;
		const neto = round_qty(disponible - ya);
		if (requerido > neto) {
			faltantes.push({
				product_id,
				nombre: String(product?.name ?? product_id),
				requerido,
				disponible: Math.max(neto, 0),
			});
		}
	}
	return faltantes;
}

function detalle_faltantes(faltantes: FaltanteExistencia[]): string {
	return faltantes.map((f) => `${f.nombre} (pide ${f.requerido}, hay ${f.disponible})`).join(', ');
}

export const PEDIDOS_OFFLINE_ESTADO_REF = 'configuration-pedidos-offline-sync-estado';
export const PEDIDOS_OFFLINE_ESTADOS = ['confirmado', 'borrador'] as const;
export type EstadoPedidoOffline = (typeof PEDIDOS_OFFLINE_ESTADOS)[number];

/** Estado con el que llegan los pedidos sincronizados del offline (parámetro; por omisión confirmado). */
export async function estado_pedidos_offline(store: ImperiumStore): Promise<EstadoPedidoOffline> {
	const valor = text(await read_config_value(store, PEDIDOS_OFFLINE_ESTADO_REF)).toLowerCase();
	return (PEDIDOS_OFFLINE_ESTADOS as readonly string[]).includes(valor)
		? (valor as EstadoPedidoOffline)
		: 'confirmado';
}

export function aviso_faltantes(folio: string, faltantes: FaltanteExistencia[]): string {
	const nombre = folio ? `El pedido ${folio}` : 'El pedido';
	return `${nombre} se confirmó sin existencia suficiente: ${detalle_faltantes(faltantes)}.`;
}

export function aviso_sin_precio(folio: string, productos: string[]): string {
	const nombre = folio ? `El pedido ${folio}` : 'El pedido';
	return `${nombre} se confirmó sin precio en: ${productos.join(', ')}.`;
}

export async function articulos_sin_precio(
	store: ImperiumStore,
	articulos_raw: unknown,
): Promise<string[]> {
	const nombres: string[] = [];
	for (const articulo of as_array(articulos_raw).map(as_object)) {
		const product_id = ref_id(articulo.product);
		if (!product_id || Number(articulo.precio) > 0) continue;
		const product = store.has('products') ? await store.find_id('products', product_id) : null;
		nombres.push(String(product?.name ?? product_id));
	}
	return nombres;
}

async function assert_pedido_confirmable(store: ImperiumStore, pedido: ImperiumDoc): Promise<void> {
	const sin_precio = await articulos_sin_precio(store, pedido.articulos);
	if (sin_precio.length) {
		throw new Error(
			`No se puede confirmar el pedido: el precio debe ser mayor a 0 en ${sin_precio.join(', ')}.`,
		);
	}
	if (await allow_negative_stock(store)) return;
	const faltantes = await faltantes_de_existencia(store, pedido.articulos, {
		almacen: await pedido_warehouse_id(store, pedido),
	});
	if (!faltantes.length) return;
	throw new Error(
		`No se puede confirmar el pedido: no hay existencia disponible en el almacén para ${detalle_faltantes(faltantes)}.`,
	);
}

/** Bloquea el paso a `surtido` si la salida dejaría existencia negativa. */
export async function assert_surtido_sin_negativos(
	store: ImperiumStore,
	articulos: unknown,
	almacen?: unknown,
): Promise<void> {
	if (await allow_negative_stock(store)) return;
	const faltantes = await faltantes_de_existencia(store, articulos, { modo: 'surtido', almacen });
	if (!faltantes.length) return;
	throw new Error(mensaje_negativos('surtir', faltantes));
}
