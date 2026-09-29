/**
 * Solicitudes de compra internas: borrador → enviada → aprobada/rechazada, y
 * las aprobadas se convierten en órdenes de compra en borrador, una por
 * proveedor. Las líneas ya convertidas quedan marcadas con su orden.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { ensure_pending_reception_from_purchase_order } from './inventory-reception-flow.ts';
import { prepare_purchase_order_create } from './purchase-order-flow.ts';
import type { ImperiumStore } from './store.ts';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function num(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function round_money(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Normaliza las partidas; proveedor y costo salen del producto si no vienen. */
async function normalize_lines(store: ImperiumStore, raw: unknown): Promise<ImperiumDoc[]> {
	const lines = as_array(raw).map(as_object);
	if (!lines.length) throw new Error('La solicitud debe contener al menos una partida');
	const out: ImperiumDoc[] = [];
	for (const [index, line] of lines.entries()) {
		const cantidad = num(line.cantidad);
		if (cantidad <= 0) throw new Error(`La partida ${index + 1} requiere una cantidad mayor a cero`);
		const producto = ref_id(line.producto);
		const product = producto && store.has('products') ? await store.find_id('products', producto) : null;
		const producto_nombre = text(line.producto_nombre) || text(product?.name);
		if (!producto_nombre) throw new Error(`La partida ${index + 1} requiere un producto`);
		const costo_estimado =
			line.costo_estimado != null && line.costo_estimado !== ''
				? num(line.costo_estimado)
				: num(product?.ultimoCostoCompra);
		out.push({
			...line,
			producto: producto || undefined,
			producto_nombre,
			producto_codigo: text(line.producto_codigo) || text(product?.codigo),
			cantidad,
			costo_estimado,
			proveedor: ref_id(line.proveedor) || ref_id(product?.proveedor) || undefined,
			proveedor_nombre: text(line.proveedor_nombre) || text(product?.proveedor_nombre),
		});
	}
	return out;
}

function total_estimado(lines: ImperiumDoc[]): number {
	return round_money(lines.reduce((s, line) => s + num(line.cantidad) * num(line.costo_estimado), 0));
}

export async function prepare_purchase_request_create(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const articulos = await normalize_lines(store, incoming.articulos);
	const doc: ImperiumDoc = {
		...incoming,
		articulos,
		total_estimado: total_estimado(articulos),
		estado: 'borrador',
		solicitante: text(actor?._id) || text(incoming.solicitante) || undefined,
		solicitante_nombre: text(actor?.name) || text(incoming.solicitante_nombre),
		ordenes_compra: [],
	};
	delete doc._id;
	for (const field of ['aprobado_por', 'aprobado_por_nombre', 'fecha_aprobacion', 'motivo_rechazo']) {
		delete doc[field];
	}
	doc.folio = await store.next_auto_increment('PurchaseRequest', 'folio', {
		resource: 'purchase-request',
		context: doc,
	});
	doc.name = text(incoming.name) || `Solicitud de compra ${doc.folio}`;
	return doc;
}

export async function prepare_purchase_request_update(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	previous: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró la solicitud indicada');
	if (text(previous.estado) !== 'borrador') {
		throw new Error('Solo se edita una solicitud en borrador');
	}
	const merged: ImperiumDoc = { ...previous, ...incoming };
	for (const field of [
		'estado',
		'folio',
		'solicitante',
		'solicitante_nombre',
		'aprobado_por',
		'aprobado_por_nombre',
		'fecha_aprobacion',
		'motivo_rechazo',
		'ordenes_compra',
	]) {
		merged[field] = previous[field];
	}
	merged.articulos = await normalize_lines(store, merged.articulos);
	merged.total_estimado = total_estimado(merged.articulos as ImperiumDoc[]);
	return merged;
}

async function need_request(store: ImperiumStore, id: unknown): Promise<ImperiumDoc> {
	const request_id = ref_id(id);
	const request = request_id ? await store.find_id('purchase-request', request_id) : null;
	if (!request) throw new Error('No se encontró la solicitud de compra indicada');
	return request;
}

/** Cambia el estado si la solicitud está en uno de `from`. */
async function transition(
	store: ImperiumStore,
	id: unknown,
	from: string[],
	to: string,
	patch: ImperiumDoc = {},
): Promise<ImperiumDoc | null> {
	const request = await need_request(store, id);
	const estado = text(request.estado);
	if (!from.includes(estado)) {
		throw new Error(`No puedes pasar una solicitud «${estado}» a «${to}»`);
	}
	return store.update('purchase-request', String(request._id), { ...patch, estado: to });
}

export async function submit_purchase_request(store: ImperiumStore, id: unknown) {
	return ok([await transition(store, id, ['borrador'], 'enviada')], 'Solicitud enviada a aprobación');
}

export async function approve_purchase_request(
	store: ImperiumStore,
	id: unknown,
	actor: ImperiumDoc | null,
) {
	const request = await need_request(store, id);
	if (actor?._id && text(request.solicitante) === text(actor._id)) {
		throw new Error('Quien solicita no puede aprobar su propia solicitud');
	}
	const saved = await transition(store, id, ['enviada'], 'aprobada', {
		aprobado_por: text(actor?._id) || undefined,
		aprobado_por_nombre: text(actor?.name),
		fecha_aprobacion: new Date().toISOString(),
	});
	return ok([saved], 'Solicitud aprobada');
}

export async function reject_purchase_request(store: ImperiumStore, id: unknown, motivo: unknown) {
	const razon = text(motivo);
	if (!razon) throw new Error('Indica el motivo del rechazo');
	const saved = await transition(store, id, ['enviada'], 'rechazada', { motivo_rechazo: razon });
	return ok([saved], 'Solicitud rechazada');
}

export async function cancel_purchase_request(store: ImperiumStore, id: unknown) {
	return ok([await transition(store, id, ['borrador', 'enviada'], 'cancelada')], 'Solicitud cancelada');
}

/**
 * Convierte las partidas aprobadas y sin orden de las solicitudes `ids` en
 * órdenes de compra en borrador, una por proveedor, sumando el mismo producto
 * (la recepción asigna a la primera partida de cada producto). Repetir la
 * conversión no duplica órdenes.
 */
export async function create_purchase_orders_from_requests(store: ImperiumStore, ids: unknown) {
	const request_ids = as_array(ids).map(ref_id).filter(Boolean);
	if (!request_ids.length) throw new Error('Indica las solicitudes a convertir');
	const requests: ImperiumDoc[] = [];
	for (const id of request_ids) {
		const request = await need_request(store, id);
		if (text(request.estado) !== 'aprobada') {
			throw new Error(`La solicitud ${text(request.folio) || id} no está aprobada`);
		}
		requests.push(request);
	}
	type Pending = { request: ImperiumDoc; index: number; line: ImperiumDoc };
	const by_supplier = new Map<string, Pending[]>();
	for (const request of requests) {
		for (const [index, line] of as_array(request.articulos).map(as_object).entries()) {
			if (ref_id(line.purchase_order)) continue;
			const proveedor = ref_id(line.proveedor);
			if (!proveedor) {
				throw new Error(
					`La partida «${text(line.producto_nombre)}» de la solicitud ${text(request.folio)} no tiene proveedor`,
				);
			}
			const group = by_supplier.get(proveedor) ?? [];
			group.push({ request, index, line });
			by_supplier.set(proveedor, group);
		}
	}
	const created: ImperiumDoc[] = [];
	const po_by_line = new Map<string, string>();
	for (const [proveedor, pending] of by_supplier) {
		const merged = new Map<string, ImperiumDoc>();
		for (const { line } of pending) {
			const key = ref_id(line.producto) || `nombre:${text(line.producto_nombre)}`;
			const current = merged.get(key);
			if (current) {
				current.cantidad = num(current.cantidad) + num(line.cantidad);
				continue;
			}
			merged.set(key, {
				producto: ref_id(line.producto) || undefined,
				producto_nombre: text(line.producto_nombre),
				producto_codigo: text(line.producto_codigo),
				cantidad: num(line.cantidad),
				cantidad_recibida: 0,
				costo_unitario: num(line.costo_estimado),
			});
		}
		const solicitudes = [...new Set(pending.map(({ request }) => String(request._id)))];
		const po_doc = await prepare_purchase_order_create(store, {
			proveedor,
			proveedor_nombre: text(pending[0]!.line.proveedor_nombre),
			tipo_origen: 'solicitud',
			solicitudes_origen: solicitudes,
			referencia_origen: pending.map(({ request }) => text(request.folio)).filter(Boolean).join(', '),
			articulos: [...merged.values()],
		});
		const po = await store.insert('purchase-order', po_doc);
		await ensure_pending_reception_from_purchase_order(store, po);
		created.push(po);
		for (const { request, index } of pending) {
			po_by_line.set(`${String(request._id)}:${index}`, String(po._id));
		}
	}
	for (const request of requests) {
		const articulos = as_array(request.articulos).map(as_object);
		const ordenes = new Set(as_array(request.ordenes_compra).map(ref_id).filter(Boolean));
		for (const [index, line] of articulos.entries()) {
			const po_id = po_by_line.get(`${String(request._id)}:${index}`);
			if (!po_id) continue;
			line.purchase_order = po_id;
			ordenes.add(po_id);
		}
		const all_converted = articulos.every((line) => ref_id(line.purchase_order));
		await store.update('purchase-request', String(request._id), {
			articulos,
			ordenes_compra: [...ordenes],
			...(all_converted ? { estado: 'convertida' } : {}),
		});
	}
	return ok(created, created.length ? 'Órdenes de compra generadas' : 'No había partidas por convertir');
}
