/**
 * Facturas de proveedor ligadas a una orden de compra: conciliación de 3 vías
 * (pedido → recibido → facturado), estado de pago calculado desde los pagos y
 * acciones de revalidar, autorizar diferencias y cancelar.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { is_missing_relation, type ImperiumStore } from './store.ts';

const EPS = 1e-6;
const PRICE_TOLERANCE_REF = 'configuration-purchase-price-tolerance-pct';
const QTY_TOLERANCE_REF = 'configuration-purchase-qty-tolerance-pct';
const NON_INVOICEABLE_PO = new Set(['borrador', 'archivada']);
export const SUPPLIER_PAYMENT_APPLIED = 'APLICADO';
export const SUPPLIER_PAYMENT_CANCELED = 'CANCELADO';

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

export type InvoiceTolerances = { price_pct: number; qty_pct: number };

export type InvoiceMatch = {
	/** Errores que impiden registrar la factura. */
	blocking: string[];
	/** Diferencias que dejan la factura sin pagar hasta autorizarlas. */
	diferencias: string[];
	avisos: string[];
	lineas: ImperiumDoc[];
};

/** Índice de la partida de la OC que corresponde a una línea de factura. */
function po_line_index(po_lines: ImperiumDoc[], line: ImperiumDoc): number {
	const explicit = line.po_linea;
	if (explicit !== undefined && explicit !== null && explicit !== '') {
		const index = Number(explicit);
		return Number.isInteger(index) && index >= 0 && index < po_lines.length ? index : -1;
	}
	const producto = ref_id(line.producto);
	if (producto) {
		const by_product = po_lines.findIndex((item) => ref_id(item.producto) === producto);
		if (by_product >= 0) return by_product;
	}
	const codigo = text(line.codigo_proveedor) || text(line.producto_codigo);
	if (!codigo) return -1;
	return po_lines.findIndex(
		(item) => text(item.codigo_proveedor) === codigo || text(item.producto_codigo) === codigo,
	);
}

/**
 * Compara las líneas de la factura contra la OC: lo facturado (esta factura +
 * `facturado_previo` de otras) no puede pasar de lo pedido; si pasa de lo
 * recibido o el precio se sale de la tolerancia, es una diferencia a autorizar.
 */
export function match_supplier_invoice(
	po: ImperiumDoc,
	invoice: ImperiumDoc,
	facturado_previo: number[],
	tolerances: InvoiceTolerances,
): InvoiceMatch {
	const po_lines = as_array(po.articulos).map(as_object);
	const out: InvoiceMatch = { blocking: [], diferencias: [], avisos: [], lineas: [] };
	const facturado = po_lines.map((_, i) => num(facturado_previo[i]));
	const invoice_lines = as_array(invoice.articulos).map(as_object);
	let suma_importes = 0;
	for (const [n, line] of invoice_lines.entries()) {
		const cantidad = num(line.cantidad);
		const valor_unitario = num(line.valor_unitario);
		const importe = line.importe != null && line.importe !== '' ? num(line.importe) : cantidad * valor_unitario;
		suma_importes += importe;
		const index = po_line_index(po_lines, line);
		if (index < 0) {
			out.diferencias.push(`La línea ${n + 1} de la factura no corresponde a ninguna partida de la orden`);
			continue;
		}
		const item = po_lines[index]!;
		facturado[index] = facturado[index]! + cantidad;
		const precio_oc = num(item.costo_unitario);
		if (Math.abs(valor_unitario - precio_oc) > precio_oc * (tolerances.price_pct / 100) + 0.005) {
			out.diferencias.push(
				`El precio de ${text(item.producto_nombre) || `la partida ${index + 1}`} (${valor_unitario}) no coincide con la orden (${precio_oc})`,
			);
		}
	}
	for (const [index, item] of po_lines.entries()) {
		const pedido = num(item.cantidad);
		const recibido = num(item.cantidad_recibida);
		const total_facturado = facturado[index]!;
		const nombre = text(item.producto_nombre) || `la partida ${index + 1}`;
		if (total_facturado > pedido + EPS) {
			out.blocking.push(`Se factura más de lo pedido de ${nombre} (${total_facturado} de ${pedido})`);
		} else if (total_facturado > recibido * (1 + tolerances.qty_pct / 100) + EPS) {
			out.diferencias.push(`Se factura más de lo recibido de ${nombre} (${total_facturado} de ${recibido})`);
		}
		out.lineas.push({
			po_linea: index,
			producto: ref_id(item.producto),
			producto_nombre: text(item.producto_nombre),
			pedido,
			recibido,
			facturado: total_facturado,
			precio_oc: num(item.costo_unitario),
		});
	}
	const subtotal = num(invoice.subtotal);
	if (Math.abs(round_money(suma_importes) - subtotal) > 1) {
		out.blocking.push('La suma de las líneas no coincide con el subtotal de la factura');
	}
	if (Math.abs(num(invoice.total) - (subtotal + num(invoice.impuestos))) > 1) {
		out.blocking.push('El total no coincide con subtotal más impuestos');
	}
	if (Math.abs(subtotal - num(po.subtotal)) > 1) {
		out.avisos.push('El subtotal de la factura no es el de la orden (facturación parcial)');
	}
	return out;
}

async function read_tolerance(store: ImperiumStore, ref: string): Promise<number> {
	if (!store.has('configuration')) return 0;
	const cfg =
		(await store.find_where('configuration', { _ref: ref })) ??
		(await store.find_where('configuration', { ref }));
	const value = Number(as_object(cfg?.value).value ?? cfg?.value);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

async function tolerances(store: ImperiumStore): Promise<InvoiceTolerances> {
	return {
		price_pct: await read_tolerance(store, PRICE_TOLERANCE_REF),
		qty_pct: await read_tolerance(store, QTY_TOLERANCE_REF),
	};
}

async function po_invoices(store: ImperiumStore, po_id: string): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan('supplier-invoice', {
		where: { purchase_order: po_id },
		include_inactive: true,
	})) {
		out.push(...page);
	}
	return out.filter((row) => text(row.estado) !== 'cancelada');
}

/** Cantidad ya facturada por partida de la OC, sin contar la factura `except_id`. */
async function facturado_por_linea(
	store: ImperiumStore,
	po: ImperiumDoc,
	except_id = '',
): Promise<number[]> {
	const po_lines = as_array(po.articulos).map(as_object);
	const totals = po_lines.map(() => 0);
	for (const invoice of await po_invoices(store, String(po._id))) {
		if (String(invoice._id) === except_id) continue;
		for (const line of as_array(invoice.articulos).map(as_object)) {
			const index = po_line_index(po_lines, line);
			if (index >= 0) totals[index] = totals[index]! + num(line.cantidad);
		}
	}
	return totals;
}

function normalize_lines(po: ImperiumDoc, raw_lines: unknown, pendiente: number[]): ImperiumDoc[] {
	const po_lines = as_array(po.articulos).map(as_object);
	const lines = as_array(raw_lines).map(as_object);
	const source = lines.length
		? lines
		: po_lines
				.map((item, index) => ({
					po_linea: index,
					producto: ref_id(item.producto),
					producto_nombre: text(item.producto_nombre),
					codigo_proveedor: text(item.codigo_proveedor),
					cantidad: Math.max(0, num(item.cantidad_recibida) - pendiente[index]!),
					valor_unitario: num(item.costo_unitario),
				}))
				.filter((line) => line.cantidad > 0);
	return source.map((line) => {
		const cantidad = num(line.cantidad);
		const valor_unitario = num(line.valor_unitario);
		if (cantidad <= 0) throw new Error('Cada línea de la factura requiere una cantidad mayor a cero');
		return {
			...line,
			producto: ref_id(line.producto) || undefined,
			cantidad,
			valor_unitario,
			importe:
				line.importe != null && line.importe !== ''
					? round_money(num(line.importe))
					: round_money(cantidad * valor_unitario),
		};
	});
}

function apply_match(doc: ImperiumDoc, match: InvoiceMatch): ImperiumDoc {
	if (match.blocking.length) throw new Error(match.blocking.join('. '));
	return {
		...doc,
		estado_match: match.diferencias.length ? 'con_diferencias' : 'conciliada',
		match_detalle: {
			lineas: match.lineas,
			diferencias: match.diferencias,
			avisos: match.avisos,
			revisado_en: new Date().toISOString(),
		},
	};
}

/** Líneas recibidas y aún no facturadas de la OC, para precargar una factura. */
export async function draft_supplier_invoice_lines(store: ImperiumStore, po_id: unknown) {
	const po = await need_po(store, po_id);
	const previo = await facturado_por_linea(store, po);
	return ok(
		[
			{
				purchase_order: String(po._id),
				proveedor: ref_id(po.proveedor) || undefined,
				proveedor_nombre: text(po.proveedor_nombre),
				proveedor_rfc: text(po.proveedor_rfc),
				articulos: normalize_lines(po, [], previo),
			},
		],
		'Líneas pendientes de facturar',
	);
}

async function need_po(store: ImperiumStore, value: unknown): Promise<ImperiumDoc> {
	const po_id = ref_id(value);
	const po = po_id ? await store.find_id('purchase-order', po_id) : null;
	if (!po) throw new Error('La factura requiere una orden de compra válida');
	return po;
}

async function assert_not_duplicated(store: ImperiumStore, doc: ImperiumDoc, except_id = '') {
	const others: ImperiumDoc[] = [];
	for await (const page of store.scan('supplier-invoice', { include_inactive: true })) {
		others.push(...page.filter((row) => String(row._id) !== except_id && text(row.estado) !== 'cancelada'));
	}
	const uuid = text(doc.uuid).toUpperCase();
	if (uuid && others.some((row) => text(row.uuid).toUpperCase() === uuid)) {
		throw new Error('Ya hay una factura registrada con ese UUID');
	}
	const numero = text(doc.numero_factura);
	const proveedor = ref_id(doc.proveedor);
	if (
		others.some(
			(row) => text(row.numero_factura) === numero && ref_id(row.proveedor) === proveedor,
		)
	) {
		throw new Error('Ese número de factura ya está registrado para el proveedor');
	}
}

export async function prepare_supplier_invoice_create(
	store: ImperiumStore,
	incoming: ImperiumDoc,
): Promise<ImperiumDoc> {
	const po = await need_po(store, incoming.purchase_order);
	if (NON_INVOICEABLE_PO.has(text(po.estado))) {
		throw new Error('Solo se registran facturas de órdenes aprobadas o recibidas');
	}
	const numero_factura = text(incoming.numero_factura);
	if (!numero_factura) throw new Error('La factura requiere número de factura');
	const proveedor_rfc = text(po.proveedor_rfc);
	const emisor_rfc = text(incoming.emisor_rfc);
	if (emisor_rfc && proveedor_rfc && emisor_rfc.toUpperCase() !== proveedor_rfc.toUpperCase()) {
		throw new Error('El RFC del emisor no es el del proveedor de la orden');
	}
	await assert_not_duplicated(store, {
		uuid: incoming.uuid,
		numero_factura,
		proveedor: ref_id(po.proveedor),
	});
	const previo = await facturado_por_linea(store, po);
	const articulos = normalize_lines(po, incoming.articulos, previo);
	if (!articulos.length) throw new Error('No hay nada pendiente de facturar en la orden');
	const subtotal =
		incoming.subtotal != null && incoming.subtotal !== ''
			? num(incoming.subtotal)
			: round_money(articulos.reduce((s, line) => s + num(line.importe), 0));
	const impuestos = num(incoming.impuestos);
	const total =
		incoming.total != null && incoming.total !== '' ? num(incoming.total) : round_money(subtotal + impuestos);
	const doc: ImperiumDoc = {
		...incoming,
		name: `Factura ${numero_factura}`,
		numero_factura,
		purchase_order: String(po._id),
		purchase_order_folio: text(po.folio_interno),
		proveedor: ref_id(po.proveedor) || undefined,
		proveedor_nombre: text(po.proveedor_nombre),
		proveedor_rfc,
		emisor_rfc,
		origen: text(incoming.origen) || 'manual',
		articulos,
		subtotal,
		impuestos,
		total,
		estado: 'registrada',
		estado_pago: 'pendiente',
		monto_pagado: 0,
		saldo: total,
	};
	delete doc.autorizado_por;
	delete doc.motivo_autorizacion;
	const matched = apply_match(doc, match_supplier_invoice(po, doc, previo, await tolerances(store)));
	matched.folio = await store.next_auto_increment('SupplierInvoice', 'folio', {
		resource: 'supplier-invoice',
		context: matched,
	});
	return matched;
}

const COMPUTED_FIELDS = [
	'estado',
	'estado_match',
	'estado_pago',
	'monto_pagado',
	'saldo',
	'match_detalle',
	'autorizado_por',
	'motivo_autorizacion',
	'folio',
	'purchase_order',
];

export async function prepare_supplier_invoice_update(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	previous: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró la factura indicada');
	if (text(previous.estado) === 'cancelada') throw new Error('La factura está cancelada');
	if (num(previous.monto_pagado) > 0) {
		throw new Error('La factura tiene pagos aplicados; cancélalos para editarla');
	}
	const patch = { ...incoming };
	for (const field of COMPUTED_FIELDS) delete patch[field];
	const po = await need_po(store, previous.purchase_order);
	const previo = await facturado_por_linea(store, po, String(previous._id));
	const merged: ImperiumDoc = { ...previous, ...patch };
	merged.articulos = normalize_lines(po, merged.articulos, previo);
	merged.total = num(merged.total);
	merged.saldo = merged.total;
	await assert_not_duplicated(store, merged, String(previous._id));
	const matched = apply_match(merged, match_supplier_invoice(po, merged, previo, await tolerances(store)));
	delete matched.autorizado_por;
	delete matched.motivo_autorizacion;
	return matched;
}

/** Recalcula lo pagado, el saldo y el estado de pago desde los pagos aplicados. */
export async function recompute_supplier_invoice(
	store: ImperiumStore,
	invoice_id: string,
): Promise<ImperiumDoc | null> {
	const invoice = await store.find_id('supplier-invoice', invoice_id);
	if (!invoice) return null;
	let pagado = 0;
	if (store.has('supplier-payment')) {
		for await (const page of store.scan('supplier-payment', {
			where: { supplier_invoice: invoice_id },
			include_inactive: true,
		})) {
			for (const payment of page) {
				if (text(payment.status).toUpperCase() === SUPPLIER_PAYMENT_APPLIED) pagado += num(payment.monto);
			}
		}
	}
	const total = num(invoice.total);
	const monto_pagado = round_money(pagado);
	const saldo = round_money(Math.max(total - monto_pagado, 0));
	const estado_pago = monto_pagado <= 0 ? 'pendiente' : saldo <= 0.009 ? 'pagada' : 'parcial';
	return store.update('supplier-invoice', invoice_id, { monto_pagado, saldo, estado_pago });
}

/**
 * Revalida las facturas de la OC tras una recepción (las autorizadas no se
 * degradan). Si la app de ventas aún no aplicó la tabla de facturas en el
 * tenant, la recepción sigue sin revalidar.
 */
export async function revalidate_po_invoices(store: ImperiumStore, po_id: string): Promise<void> {
	if (!store.has('supplier-invoice')) return;
	const po = await store.find_id('purchase-order', po_id);
	if (!po) return;
	let invoices: ImperiumDoc[];
	try {
		invoices = await po_invoices(store, po_id);
	} catch (err) {
		if (is_missing_relation(err)) return;
		throw err;
	}
	const tol = await tolerances(store);
	for (const invoice of invoices) {
		if (text(invoice.estado_match) === 'autorizada') continue;
		const previo = await facturado_por_linea(store, po, String(invoice._id));
		const match = match_supplier_invoice(po, invoice, previo, tol);
		const estado_match = match.blocking.length || match.diferencias.length ? 'con_diferencias' : 'conciliada';
		await store.update('supplier-invoice', String(invoice._id), {
			estado_match,
			match_detalle: {
				lineas: match.lineas,
				diferencias: [...match.blocking, ...match.diferencias],
				avisos: match.avisos,
				revisado_en: new Date().toISOString(),
			},
		});
	}
}

async function need_invoice(store: ImperiumStore, id: unknown): Promise<ImperiumDoc> {
	const invoice_id = ref_id(id);
	const invoice = invoice_id ? await store.find_id('supplier-invoice', invoice_id) : null;
	if (!invoice) throw new Error('No se encontró la factura de proveedor indicada');
	return invoice;
}

export async function revalidate_supplier_invoice(store: ImperiumStore, id: unknown) {
	const invoice = await need_invoice(store, id);
	await revalidate_po_invoices(store, ref_id(invoice.purchase_order));
	return ok([await store.find_id('supplier-invoice', String(invoice._id))], 'Factura revalidada');
}

export async function authorize_supplier_invoice(
	store: ImperiumStore,
	id: unknown,
	actor: ImperiumDoc | null,
	motivo: unknown,
) {
	const invoice = await need_invoice(store, id);
	if (text(invoice.estado) === 'cancelada') throw new Error('La factura está cancelada');
	if (text(invoice.estado_match) !== 'con_diferencias') {
		throw new Error('Solo se autorizan facturas con diferencias');
	}
	const razon = text(motivo);
	if (!razon) throw new Error('Indica el motivo para autorizar las diferencias');
	const saved = await store.update('supplier-invoice', String(invoice._id), {
		estado_match: 'autorizada',
		autorizado_por: text(actor?.name) || text(actor?._id),
		motivo_autorizacion: razon,
	});
	return ok([saved], 'Diferencias autorizadas');
}

export async function cancel_supplier_invoice(store: ImperiumStore, id: unknown) {
	const invoice = await need_invoice(store, id);
	if (num(invoice.monto_pagado) > 0) {
		throw new Error('La factura tiene pagos aplicados; cancélalos primero');
	}
	const saved = await store.update('supplier-invoice', String(invoice._id), { estado: 'cancelada' });
	return ok([saved], 'Factura cancelada');
}
