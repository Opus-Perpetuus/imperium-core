/**
 * Cotizaciones del POS sobre los tickets: `COTIZACION` guarda artículos y
 * precios sin cobrar ni mover existencia (`quote_status: abierta`). Una venta
 * con `original_ticket` apuntando a la cotización la convierte
 * (`quote_status: convertida`); una cotización se convierte una sola vez.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const TICKET_COTIZACION = 'COTIZACION';
export const QUOTE_OPEN = 'abierta';
export const QUOTE_CONVERTED = 'convertida';
const CANCELLED = new Set(['cancelado', 'canceled', 'cancelled']);

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

function money(n: number): number {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function type_of(t: ImperiumDoc): string {
	return text(t.ticket_type).toUpperCase();
}

function live(t: ImperiumDoc): boolean {
	return t.is_active !== false && !CANCELLED.has(text(t.state ?? t.estado).toLowerCase());
}

function items_of(raw: unknown): ImperiumDoc[] {
	let value = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			value = [];
		}
	}
	return as_array(value)
		.map(as_object)
		.filter((i) => text(i.item_id ?? i.producto ?? i.product_id) && Number(i.quantity ?? i.cantidad ?? 0) > 0);
}

/** Venta ligada a algo: solo puede ser una cotización abierta. */
function is_quote_sale(doc: ImperiumDoc): boolean {
	return (type_of(doc) || 'VENTA') === 'VENTA' && !!text(doc.original_ticket);
}

export async function prepare_quote_rules(store: ImperiumStore, doc: ImperiumDoc): Promise<ImperiumDoc> {
	const type = type_of(doc);
	if (type === TICKET_COTIZACION) {
		if (!items_of(doc.items).length) throw new Error('La cotización no tiene artículos');
		if (!(money(Number(doc.subtotal ?? 0)) > 0)) throw new Error('La cotización requiere un importe mayor a 0');
		const { payments: _p, payment_method: _m, ...rest } = doc;
		return { ...rest, total_paid: 0, change: 0, quote_status: QUOTE_OPEN };
	}
	if (is_quote_sale(doc)) {
		const quote = await store.find_id('pos-tickets', text(doc.original_ticket));
		if (!quote || type_of(quote) !== TICKET_COTIZACION) {
			throw new Error('Una venta solo puede ligarse a una cotización');
		}
		if (!live(quote)) throw new Error('La cotización está cancelada o inactiva');
		if (text(quote.quote_status) !== QUOTE_OPEN) throw new Error('La cotización ya se convirtió en venta');
	}
	return doc;
}

/** Después de crear la venta ligada, marca la cotización como convertida. */
export async function register_quote_conversion(store: ImperiumStore, created: ImperiumDoc): Promise<void> {
	if (!is_quote_sale(created)) return;
	const quote = await store.find_id('pos-tickets', text(created.original_ticket));
	if (!quote || type_of(quote) !== TICKET_COTIZACION || text(quote.quote_status) !== QUOTE_OPEN) return;
	await store.update('pos-tickets', String(quote._id), { quote_status: QUOTE_CONVERTED });
}

/** Cotización por id o folio con sus artículos, total, estado y la venta que la convirtió. */
export async function quote_lookup(store: ImperiumStore, q: { id?: string | null; folio?: string | null }) {
	let quote: ImperiumDoc | null = null;
	if (text(q.id)) quote = await store.find_id('pos-tickets', text(q.id));
	else if (text(q.folio)) {
		for await (const page of store.scan('pos-tickets', { where: { ticket_sequence: text(q.folio) } })) {
			quote = page.find((t) => type_of(t) === TICKET_COTIZACION) ?? quote;
		}
	} else throw new Error('Indica el folio de la cotización');
	if (!quote || type_of(quote) !== TICKET_COTIZACION) throw new Error('No se encontró la cotización');
	let venta = '';
	for await (const page of store.scan('pos-tickets', { where: { original_ticket: String(quote._id ?? '') } })) {
		const sale = page.find((t) => (type_of(t) || 'VENTA') === 'VENTA' && live(t));
		if (sale) venta = text(sale.ticket_sequence);
	}
	return {
		_id: String(quote._id ?? ''),
		folio: text(quote.ticket_sequence),
		fecha: quote.createdAt ?? quote.created_at ?? null,
		cliente_id: text(quote.client_id),
		cliente_nombre: `${text(quote.client_name)} ${text(quote.client_lastname)}`.trim(),
		estado: live(quote) ? text(quote.quote_status) || QUOTE_OPEN : 'cancelada',
		items: items_of(quote.items).map((i) => ({
			item_id: text(i.item_id ?? i.producto ?? i.product_id),
			item_name: text(i.item_name ?? i.name),
			quantity: Number(i.quantity ?? i.cantidad ?? 0),
			unit_price: money(Number(i.unit_price ?? i.price ?? 0)),
		})),
		total: money(Number(quote.subtotal ?? 0)),
		venta,
	};
}
