/**
 * Formas de pago de una venta POS. Sin `payments` el ticket es todo en
 * efectivo, como siempre. Con `payments` ([{method, amount, reference}]):
 * lo que no es efectivo no puede pasar del total ni dar cambio, entre todo
 * debe cubrir el total y a la caja solo entra la parte en efectivo.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';

export const PAYMENT_CASH = 'efectivo';
export const PAYMENT_METHODS = ['efectivo', 'tarjeta', 'transferencia', 'vale', 'otro'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
const METHOD_SET = new Set<string>(PAYMENT_METHODS);

export type PosPayment = { method: string; amount: number; reference?: string };

function money(n: number): number {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

export function read_payments(ticket: ImperiumDoc): PosPayment[] {
	return as_array(ticket.payments)
		.map(as_object)
		.map((p) => ({ method: text(p.method).toLowerCase(), amount: money(Number(p.amount)), reference: text(p.reference) }))
		.filter((p) => p.method && p.amount > 0);
}

/** Valida y completa las formas de pago de una venta; sin `payments` no toca nada. */
export function prepare_pos_payments(doc: ImperiumDoc, extra_methods: readonly string[] = []): ImperiumDoc {
	const raw = as_array(doc.payments);
	if (!raw.length) return doc;
	const allowed = new Set([...METHOD_SET, ...extra_methods]);
	const payments: PosPayment[] = [];
	for (const entry of raw.map(as_object)) {
		const method = text(entry.method).toLowerCase();
		const amount = money(Number(entry.amount));
		if (!allowed.has(method)) throw new Error(`Forma de pago no válida: ${method || '(vacía)'}`);
		if (!(amount > 0)) throw new Error('Cada forma de pago necesita un monto mayor a 0');
		const reference = text(entry.reference);
		payments.push(reference ? { method, amount, reference } : { method, amount });
	}
	const total = money(Number(doc.subtotal ?? 0));
	const cash = money(payments.filter((p) => p.method === PAYMENT_CASH).reduce((s, p) => s + p.amount, 0));
	const non_cash = money(payments.filter((p) => p.method !== PAYMENT_CASH).reduce((s, p) => s + p.amount, 0));
	if (non_cash - total > 0.005) {
		throw new Error('Los pagos que no son en efectivo no pueden pasar del total de la venta');
	}
	if (total - (cash + non_cash) > 0.005) {
		throw new Error('Los pagos no cubren el total de la venta');
	}
	const methods = [...new Set(payments.map((p) => p.method))];
	return {
		...doc,
		payments,
		payment_method: methods.length === 1 ? methods[0] : 'mixto',
		total_paid: money(cash + non_cash),
		change: money(cash + non_cash - total),
	};
}

/** Parte que no entra a la caja (tarjeta, transferencia…); 0 sin `payments`. */
export function non_cash_amount(ticket: ImperiumDoc): number {
	return money(read_payments(ticket).filter((p) => p.method !== PAYMENT_CASH).reduce((s, p) => s + p.amount, 0));
}

/** Importe cobrado por forma de pago (ventas sin `payments` cuentan como efectivo). */
export function payments_by_method(sales: ImperiumDoc[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const sale of sales) {
		const subtotal = money(Number(sale.subtotal ?? 0));
		const non_cash = read_payments(sale).filter((p) => p.method !== PAYMENT_CASH);
		let rest = subtotal;
		for (const p of non_cash) {
			out[p.method] = money((out[p.method] ?? 0) + p.amount);
			rest -= p.amount;
		}
		out[PAYMENT_CASH] = money((out[PAYMENT_CASH] ?? 0) + rest);
	}
	return out;
}
