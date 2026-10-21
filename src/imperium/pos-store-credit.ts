/**
 * Saldo a favor del cliente (vale de devolución) sobre los tickets, sin tablas nuevas:
 *
 * - Una devolución ligada con `refund_method: 'saldo_favor'` no saca efectivo:
 *   lo reembolsado queda en `payments` con método `saldo_favor` y suma al
 *   saldo a favor del cliente.
 * - Una venta puede pagarse (toda o en parte) con `saldo_favor`, hasta el
 *   saldo disponible del cliente.
 * - Saldo = devoluciones vivas a saldo a favor − ventas vivas pagadas con él.
 */
import type { ImperiumDoc } from './envelope.ts';
import { read_payments } from './pos-payments.ts';
import type { ImperiumStore } from './store.ts';

export const STORE_CREDIT_METHOD = 'saldo_favor';
const CANCELLED = new Set(['cancelado', 'canceled', 'cancelled']);

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

function money(n: number): number {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function live(t: ImperiumDoc): boolean {
	return t.is_active !== false && !CANCELLED.has(text(t.state ?? t.estado).toLowerCase());
}

export function store_credit_amount(ticket: ImperiumDoc): number {
	return money(read_payments(ticket).filter((p) => p.method === STORE_CREDIT_METHOD).reduce((s, p) => s + p.amount, 0));
}

/** Saldo a favor disponible del cliente, opcionalmente sin contar un ticket. */
export async function client_store_credit(store: ImperiumStore, client_id: string, except = ''): Promise<number> {
	const id = text(client_id);
	if (!id || !store.has('pos-tickets')) return 0;
	let balance = 0;
	for await (const page of store.scan('pos-tickets', { where: { client_id: id } })) {
		for (const t of page) {
			if (!live(t) || String(t._id ?? '') === except) continue;
			const amount = store_credit_amount(t);
			if (!amount) continue;
			const type = text(t.ticket_type).toUpperCase() || 'VENTA';
			if (type === 'DEVOLUCION') balance += amount;
			else if (type === 'VENTA') balance -= amount;
		}
	}
	return money(balance);
}

/** Venta pagada con saldo a favor: requiere cliente y que alcance el saldo. */
export async function prepare_store_credit_sale(store: ImperiumStore, doc: ImperiumDoc): Promise<ImperiumDoc> {
	const amount = store_credit_amount(doc);
	if (amount <= 0) return doc;
	const client_id = text(doc.client_id);
	if (!client_id) throw new Error('Pagar con saldo a favor requiere un cliente');
	const available = await client_store_credit(store, client_id, String(doc._id ?? ''));
	if (amount - available > 0.005) {
		throw new Error(`Saldo a favor insuficiente: disponible ${available.toFixed(2)}`);
	}
	return doc;
}

/** Consulta del saldo a favor de un cliente. */
export async function store_credit_lookup(store: ImperiumStore, client_id: string | null) {
	const id = text(client_id);
	if (!id) throw new Error('Indica el cliente');
	return { cliente: id, saldo_favor: await client_store_credit(store, id) };
}
