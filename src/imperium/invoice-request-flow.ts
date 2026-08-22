/**
 * Solicitudes de facturación: generate/authorize/send/mark/cancel como el original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const IR_PENDING = 'pendiente_autorizacion_cobranza';
export const IR_READY = 'listo_para_comercial';
export const IR_SENT = 'enviado_a_comercial';
export const IR_INVOICED = 'facturado';
export const IR_CANCELED = 'cancelado';

const IR_PENDING_ALIASES = new Set([IR_PENDING, 'pendiente_autorizacion']);
const IR_READY_ALIASES = new Set([IR_READY, 'lista_comercial']);
const IR_SENT_ALIASES = new Set([IR_SENT, 'enviada_comercial']);
const IR_INVOICED_ALIASES = new Set([IR_INVOICED, 'facturada']);
const IR_CANCELED_ALIASES = new Set([IR_CANCELED, 'cancelada']);

const ALLOWED_ORDER_STATES = new Set([
	'confirmado',
	'por_surtir',
	'surtiendo',
	'surtido',
	'enviado',
]);

const DEFAULT_SPLIT_THRESHOLD = 2000;
const EPSILON_MONEY = 0.009;
const EPSILON_QUANTITY = 0.00009;

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function round_money(value: number): number {
	return Number((Number(value) || 0).toFixed(2));
}

function round_quantity(value: number): number {
	return Number((Number(value) || 0).toFixed(4));
}

function actor_display(actor: ImperiumDoc | null): string {
	const raw = [actor?.name, actor?.nombre, actor?.apellido]
		.map((part) => text(part))
		.filter(Boolean)
		.join(' ')
		.trim();
	return raw || text(actor?.email) || 'Sistema';
}

type InvoiceLine = {
	pedido_articulo_index: number;
	product?: string;
	product_name: string;
	product_code?: string;
	cantidad: number;
	precio_unitario: number;
	monto_total: number;
	observaciones?: string;
	quantity_is_integer: boolean;
};

type SplitItem = {
	pedido_articulo_index: number;
	product?: string;
	product_name: string;
	product_code?: string;
	cantidad_original: number;
	cantidad_facturable: number;
	precio_unitario: number;
	monto_total: number;
	observaciones?: string;
};

type SubOrder = {
	index: number;
	name: string;
	monto_total: number;
	articulos_count: number;
	articulos: SplitItem[];
};

function suborder_name(folio: string, index: number): string {
	return `${folio}-SUB-${String(index).padStart(2, '0')}`;
}

function can_regenerate(existing?: ImperiumDoc | null): boolean {
	if (!existing) return true;
	const estado = text(existing.estado);
	return !IR_SENT_ALIASES.has(estado) && !IR_INVOICED_ALIASES.has(estado);
}

async function sync_order_invoice_state(store: ImperiumStore, request: ImperiumDoc) {
	const pedido_id = ref_id(request.pedido);
	if (!pedido_id) {
		throw new Error('No se pudo sincronizar la solicitud de facturación con el pedido.');
	}
	const updated = await store.update('pedidos', pedido_id, {
		invoice_request_id: request._id,
		invoice_request_name: request.name,
		invoice_request_estado: request.estado,
		invoice_request_monto_total: request.monto_total,
		invoice_request_actualizado: new Date().toISOString(),
	});
	if (!updated) {
		throw new Error('No se pudo sincronizar la solicitud de facturación con el pedido.');
	}
}

async function find_existing_request(store: ImperiumStore, order_id: string) {
	const { rows } = await store.find_many('invoice-request', {
		where: { pedido: order_id },
		take: 50,
		include_inactive: true,
		populate: false,
		sort: 'created_at:desc',
	});
	return (
		rows.find((row) => row.is_active !== false && !IR_CANCELED_ALIASES.has(text(row.estado))) ??
		null
	);
}

async function load_order(store: ImperiumStore, order_id: string) {
	const pedido = await store.find_id('pedidos', order_id);
	if (!pedido || pedido.is_active === false) {
		throw new Error('No se encontró el pedido para facturación.');
	}
	const contacto_id = ref_id(pedido.contacto);
	let contacto: ImperiumDoc | null = null;
	if (contacto_id && store.has('contacto')) {
		contacto = await store.find_id('contacto', contacto_id);
	} else if (pedido.contacto && typeof pedido.contacto === 'object') {
		contacto = as_object(pedido.contacto);
	}
	return { pedido, contacto };
}

function resolve_contact_config(contacto: ImperiumDoc | null) {
	const threshold = round_money(
		Number(contacto?.facturacion_dividida_monto_maximo) || DEFAULT_SPLIT_THRESHOLD,
	);
	return {
		contacto_nombre: text(contacto?.name),
		contacto_rfc: text(contacto?.rfc) || undefined,
		requiere_facturacion_dividida: Boolean(contacto?.facturacion_dividida_habilitada),
		monto_umbral: threshold > 0 ? threshold : round_money(DEFAULT_SPLIT_THRESHOLD),
		requiere_autorizacion_cobranza: Boolean(
			contacto?.facturacion_requiere_autorizacion_cobranza,
		),
	};
}

function validate_order_state(pedido: ImperiumDoc, contacto: ImperiumDoc | null) {
	if (!ALLOWED_ORDER_STATES.has(text(pedido.estado))) {
		throw new Error(
			'Solo se pueden generar solicitudes para pedidos confirmados, surtidos o enviados.',
		);
	}
	if (!ref_id(pedido.contacto) && !contacto) {
		throw new Error('El pedido debe tener un cliente asignado antes de generar la solicitud.');
	}
	if (!as_array(pedido.articulos).length) {
		throw new Error('El pedido no tiene artículos facturables para generar sub-pedidos.');
	}
}

function normalize_invoice_lines(
	pedido: ImperiumDoc,
	threshold: number,
	split_enabled: boolean,
): InvoiceLine[] {
	const normalized = as_array(pedido.articulos).map((raw, index) => {
		const articulo = as_object(raw);
		const cantidad = round_quantity(Number(articulo.cantidad ?? 0));
		const monto_total = round_money(
			Number(articulo.importe ?? 0) > 0
				? Number(articulo.importe ?? 0)
				: cantidad * Number(articulo.precio ?? 0),
		);
		if (cantidad <= 0) {
			throw new Error(
				`El artículo ${index + 1} del pedido no tiene cantidad válida para facturación.`,
			);
		}
		if (monto_total <= 0) {
			throw new Error(
				`El artículo ${index + 1} del pedido no tiene importe válido para facturación.`,
			);
		}
		const precio_unitario = round_money(monto_total / cantidad);
		if (split_enabled && precio_unitario > threshold + EPSILON_MONEY) {
			throw new Error(
				`El artículo ${index + 1} excede el umbral unitario de ${threshold} y no puede dividirse automáticamente.`,
			);
		}
		const raw_product = articulo.product ?? articulo.producto;
		const product =
			typeof raw_product === 'string'
				? raw_product
				: text(as_object(raw_product)._id) || undefined;
		const product_name =
			typeof raw_product === 'object' ? text(as_object(raw_product).name) : '';
		const product_code =
			typeof raw_product === 'object' ? text(as_object(raw_product).codigo) || undefined : undefined;
		return {
			pedido_articulo_index: index,
			product,
			product_name: product_name || `Artículo ${String(index + 1).padStart(2, '0')}`,
			product_code,
			cantidad,
			precio_unitario,
			monto_total,
			observaciones: text(articulo.observaciones) || undefined,
			quantity_is_integer: Math.abs(cantidad - Math.round(cantidad)) <= EPSILON_QUANTITY,
		};
	});
	if (!normalized.length) throw new Error('No hay artículos válidos para facturar el pedido.');
	return normalized;
}

function split_item(line: InvoiceLine, chunk_quantity: number, chunk_amount: number): SplitItem {
	return {
		pedido_articulo_index: line.pedido_articulo_index,
		product: line.product,
		product_name: line.product_name,
		product_code: line.product_code,
		cantidad_original: line.cantidad,
		cantidad_facturable: chunk_quantity,
		precio_unitario: line.precio_unitario,
		monto_total: chunk_amount,
		observaciones: line.observaciones,
	};
}

function build_suborders(
	folio: string,
	lines: InvoiceLine[],
	threshold: number,
	split_enabled: boolean,
): SubOrder[] {
	if (!split_enabled) {
		const articulos = lines.map((line) => split_item(line, line.cantidad, line.monto_total));
		return [
			{
				index: 1,
				name: suborder_name(folio, 1),
				monto_total: round_money(articulos.reduce((acc, item) => acc + item.monto_total, 0)),
				articulos_count: articulos.length,
				articulos,
			},
		];
	}
	const suborders: SubOrder[] = [];
	let current: SubOrder = {
		index: 1,
		name: suborder_name(folio, 1),
		monto_total: 0,
		articulos_count: 0,
		articulos: [],
	};
	const push_current = () => {
		if (!current.articulos.length) return;
		current.monto_total = round_money(current.monto_total);
		current.articulos_count = current.articulos.length;
		suborders.push(current);
		const next_index = suborders.length + 1;
		current = {
			index: next_index,
			name: suborder_name(folio, next_index),
			monto_total: 0,
			articulos_count: 0,
			articulos: [],
		};
	};
	for (const line of lines) {
		let remaining_quantity = round_quantity(line.cantidad);
		let remaining_amount = round_money(line.monto_total);
		while (remaining_quantity > EPSILON_QUANTITY && remaining_amount > EPSILON_MONEY) {
			const available_amount = round_money(threshold - current.monto_total);
			if (available_amount <= EPSILON_MONEY) {
				push_current();
				continue;
			}
			let chunk_quantity = remaining_quantity;
			if (remaining_amount > available_amount + EPSILON_MONEY) {
				const raw_quantity = available_amount / line.precio_unitario;
				chunk_quantity = line.quantity_is_integer
					? Math.floor(raw_quantity)
					: Math.floor(raw_quantity * 10000) / 10000;
				if (chunk_quantity <= EPSILON_QUANTITY) {
					push_current();
					continue;
				}
			}
			chunk_quantity = round_quantity(Math.min(chunk_quantity, remaining_quantity));
			const is_last = Math.abs(chunk_quantity - remaining_quantity) <= EPSILON_QUANTITY;
			const chunk_amount = is_last
				? remaining_amount
				: round_money(chunk_quantity * line.precio_unitario);
			if (
				current.monto_total + chunk_amount > threshold + EPSILON_MONEY &&
				current.articulos.length > 0
			) {
				push_current();
				continue;
			}
			current.articulos.push(split_item(line, chunk_quantity, chunk_amount));
			current.monto_total = round_money(current.monto_total + chunk_amount);
			current.articulos_count = current.articulos.length;
			remaining_quantity = round_quantity(remaining_quantity - chunk_quantity);
			remaining_amount = round_money(remaining_amount - chunk_amount);
			if (remaining_quantity <= EPSILON_QUANTITY) break;
			if (current.monto_total >= threshold - EPSILON_MONEY) push_current();
		}
	}
	push_current();
	if (!suborders.length) {
		throw new Error('No se pudieron generar sub-pedidos contables para la solicitud.');
	}
	return suborders;
}

function build_payload(
	pedido: ImperiumDoc,
	contacto: ImperiumDoc | null,
	existing: ImperiumDoc | null,
): ImperiumDoc {
	validate_order_state(pedido, contacto);
	const contact_config = resolve_contact_config(contacto);
	const lines = normalize_invoice_lines(
		pedido,
		contact_config.monto_umbral,
		contact_config.requiere_facturacion_dividida,
	);
	const folio = text(pedido.folio);
	const subpedidos = build_suborders(
		folio,
		lines,
		contact_config.monto_umbral,
		contact_config.requiere_facturacion_dividida,
	);
	const monto_total = round_money(
		subpedidos.reduce((acc, sub) => acc + Number(sub.monto_total ?? 0), 0),
	);
	const approved_existing =
		Boolean(existing?.autorizado_cobranza) && contact_config.requiere_autorizacion_cobranza;
	const autorizado_cobranza =
		!contact_config.requiere_autorizacion_cobranza || approved_existing;
	return {
		name: `SOL-FAC-${folio}`,
		description: `${contact_config.contacto_nombre} | Pedido ${folio}`,
		pedido: String(pedido._id ?? ''),
		pedido_folio: folio,
		pedido_estado: text(pedido.estado),
		contacto: ref_id(pedido.contacto) || undefined,
		contacto_nombre: contact_config.contacto_nombre,
		contacto_rfc: contact_config.contacto_rfc,
		pedido_total: round_money(Number(pedido.total ?? pedido.importe ?? 0)),
		pedido_iva: round_money(Number(pedido.iva ?? 0)),
		monto_total,
		monto_umbral: contact_config.monto_umbral,
		base_calculo: 'importe',
		requiere_facturacion_dividida: contact_config.requiere_facturacion_dividida,
		requiere_autorizacion_cobranza: contact_config.requiere_autorizacion_cobranza,
		autorizado_cobranza,
		autorizado_cobranza_fecha: approved_existing
			? existing?.autorizado_cobranza_fecha
			: undefined,
		autorizado_cobranza_usuario_nombre: approved_existing
			? existing?.autorizado_cobranza_usuario_nombre
			: undefined,
		autorizado_cobranza_notas: approved_existing ? existing?.autorizado_cobranza_notas : undefined,
		estado: autorizado_cobranza ? IR_READY : IR_PENDING,
		subpedidos,
		observaciones_pedido: text(pedido.observaciones) || undefined,
		is_active: true,
	};
}

export async function generate_invoice_from_order(
	store: ImperiumStore,
	order_id: string,
): Promise<{ record: ImperiumDoc; message: string }> {
	const id = text(order_id);
	if (!id) throw new Error('Debes especificar el pedido a facturar.');
	const { pedido, contacto } = await load_order(store, id);
	const existing = await find_existing_request(store, id);
	if (!can_regenerate(existing)) {
		throw new Error(
			'La solicitud ya fue enviada a comercial o marcada como facturada y no puede regenerarse.',
		);
	}
	const payload = build_payload(pedido, contacto, existing);
	const record = existing?._id
		? await store.update('invoice-request', String(existing._id), payload)
		: await store.insert('invoice-request', payload);
	if (!record) throw new Error('No se pudo guardar la solicitud de facturación.');
	await sync_order_invoice_state(store, record);
	return {
		record,
		message: existing
			? 'Solicitud de facturación actualizada'
			: 'Solicitud de facturación generada',
	};
}

export async function authorize_invoice_request(
	store: ImperiumStore,
	id: string,
	actor: ImperiumDoc | null,
	notas?: unknown,
): Promise<ImperiumDoc> {
	const rec = await store.find_id('invoice-request', id);
	if (!rec || rec.is_active === false) throw new Error('No se encontró la solicitud de facturación.');
	if (!rec.requiere_autorizacion_cobranza) {
		throw new Error('Esta solicitud no requiere autorización de cobranza.');
	}
	const estado = text(rec.estado);
	if (IR_CANCELED_ALIASES.has(estado)) throw new Error('La solicitud está cancelada.');
	if (IR_INVOICED_ALIASES.has(estado)) {
		throw new Error('La solicitud ya fue marcada como facturada.');
	}
	if (IR_SENT_ALIASES.has(estado)) throw new Error('La solicitud ya fue enviada a comercial.');
	if (estado && !IR_PENDING_ALIASES.has(estado)) {
		throw new Error('Solo se puede autorizar una solicitud pendiente de cobranza.');
	}
	const updated = await store.update('invoice-request', String(rec._id), {
		autorizado_cobranza: true,
		autorizado_cobranza_fecha: new Date().toISOString(),
		autorizado_cobranza_usuario_nombre: actor_display(actor),
		autorizado_cobranza_notas: text(notas) || undefined,
		estado: IR_READY,
	});
	if (!updated) throw new Error('No se encontró la solicitud de facturación.');
	await sync_order_invoice_state(store, updated);
	return updated;
}

export async function send_invoice_to_commercial(
	store: ImperiumStore,
	id: string,
	actor: ImperiumDoc | null,
	comercial_referencia?: unknown,
): Promise<ImperiumDoc> {
	const rec = await store.find_id('invoice-request', id);
	if (!rec || rec.is_active === false) throw new Error('No se encontró la solicitud de facturación.');
	if (text(rec.estado) && !IR_READY_ALIASES.has(text(rec.estado))) {
		throw new Error('La solicitud debe estar lista para comercial antes de enviarse.');
	}
	const updated = await store.update('invoice-request', String(rec._id), {
		estado: IR_SENT,
		enviado_a_comercial_fecha: new Date().toISOString(),
		enviado_a_comercial_usuario_nombre: actor_display(actor),
		comercial_referencia: text(comercial_referencia) || undefined,
	});
	if (!updated) throw new Error('No se encontró la solicitud de facturación.');
	await sync_order_invoice_state(store, updated);
	return updated;
}

export async function mark_invoice_request(
	store: ImperiumStore,
	id: string,
	actor: ImperiumDoc | null,
	factura_referencia?: unknown,
): Promise<ImperiumDoc> {
	const rec = await store.find_id('invoice-request', id);
	if (!rec || rec.is_active === false) throw new Error('No se encontró la solicitud de facturación.');
	if (text(rec.estado) && !IR_SENT_ALIASES.has(text(rec.estado))) {
		throw new Error(
			'La solicitud debe haberse enviado a comercial antes de marcarse como facturada.',
		);
	}
	const updated = await store.update('invoice-request', String(rec._id), {
		estado: IR_INVOICED,
		facturado_fecha: new Date().toISOString(),
		facturado_usuario_nombre: actor_display(actor),
		factura_referencia: text(factura_referencia) || undefined,
	});
	if (!updated) throw new Error('No se encontró la solicitud de facturación.');
	await sync_order_invoice_state(store, updated);
	return updated;
}

export async function cancel_invoice_request(
	store: ImperiumStore,
	id: string,
	motivo?: unknown,
): Promise<ImperiumDoc> {
	const rec = await store.find_id('invoice-request', id);
	if (!rec || rec.is_active === false) throw new Error('No se encontró la solicitud de facturación.');
	if (IR_INVOICED_ALIASES.has(text(rec.estado))) {
		throw new Error('No se puede cancelar una solicitud ya facturada.');
	}
	const reason = text(motivo);
	const description = reason
		? `${text(rec.description)}\nCancelado: ${reason}`.trim()
		: rec.description;
	const updated = await store.update('invoice-request', String(rec._id), {
		estado: IR_CANCELED,
		fecha_cancelacion: new Date().toISOString(),
		description,
	});
	if (!updated) throw new Error('No se encontró la solicitud de facturación.');
	await sync_order_invoice_state(store, updated);
	return updated;
}
