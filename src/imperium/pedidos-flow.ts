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
