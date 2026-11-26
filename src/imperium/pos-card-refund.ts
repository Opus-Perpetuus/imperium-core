// Solo se reembolsan a la tarjeta los pagos con tarjeta cuya referencia es un cobro de terminal que reembolsa por API.
import { createHash } from 'node:crypto';
import type { ImperiumDoc } from './envelope.ts';
import { refund_terminal_charge, refundable_amount, type TerminalDeps } from './pos-card-terminal-flow.ts';
import { read_payments, type PosPayment } from './pos-payments.ts';

export const CARD_METHOD = 'tarjeta';
const NO_CARD = 'La venta no tiene un pago con tarjeta por reembolsar; elige efectivo o saldo a favor';

function money(n: number): number {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function card_payments(ticket: ImperiumDoc): PosPayment[] {
	return read_payments(ticket).filter((p) => p.method === CARD_METHOD && p.reference);
}

export function card_left_by_reference(original: ImperiumDoc, prior_returns: ImperiumDoc[]): Map<string, number> {
	const left = new Map<string, number>();
	for (const p of card_payments(original)) left.set(p.reference!, money((left.get(p.reference!) ?? 0) + p.amount));
	for (const p of prior_returns.flatMap(card_payments)) {
		if (left.has(p.reference!)) left.set(p.reference!, money(left.get(p.reference!)! - p.amount));
	}
	return left;
}

export function card_refund_lines(
	original: ImperiumDoc,
	prior_returns: ImperiumDoc[],
	amount: number,
): Array<PosPayment & { refund_key: string }> {
	let rest = money(amount);
	if (rest <= 0) return [];
	const lines: Array<PosPayment & { refund_key: string }> = [];
	for (const [reference, left] of card_left_by_reference(original, prior_returns)) {
		const use = money(Math.min(left, rest));
		if (use <= 0) continue;
		const seed = `${String(original._id ?? '')}:${prior_returns.length}:${reference}:${Math.round(use * 100)}`;
		const refund_key = `devpos-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
		lines.push({ method: CARD_METHOD, amount: use, reference, refund_key });
		rest = money(rest - use);
		if (rest <= 0) break;
	}
	if (!lines.length) throw new Error(NO_CARD);
	return lines;
}

export async function refund_return_to_card(deps: TerminalDeps | null, doc: ImperiumDoc): Promise<ImperiumDoc> {
	const lines = (Array.isArray(doc.payments) ? doc.payments : []).filter(
		(p: ImperiumDoc) => p?.method === CARD_METHOD && p.refund_key,
	) as Array<ImperiumDoc>;
	if (!lines.length) return doc;
	if (!deps) throw new Error('No hay conexión con la terminal para reembolsar; elige efectivo o saldo a favor');
	for (const line of lines) {
		await refund_terminal_charge(deps, {
			id: String(line.reference),
			amount: Number(line.amount),
			idempotency_key: String(line.refund_key),
		});
	}
	return { ...doc, card_refund_status: 'reembolsado' };
}

export async function card_refundable(
	deps: TerminalDeps,
	original: ImperiumDoc,
	prior_returns: ImperiumDoc[],
): Promise<number> {
	let total = 0;
	for (const [reference, left] of card_left_by_reference(original, prior_returns)) {
		const record = await deps.charges.find_by_id(reference).catch(() => null);
		if (record) total += Math.min(Math.max(left, 0), refundable_amount(record));
	}
	return money(total);
}
