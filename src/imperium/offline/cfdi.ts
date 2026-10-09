export const CFDI_ALARM_MS = 24 * 60 * 60 * 1000;
export const CFDI_DEADLINE_MS = 72 * 60 * 60 * 1000;
/** El bloqueo entra en la última hora, antes de cumplir las 72 h. */
export const CFDI_BLOCK_MARGIN_MS = 60 * 60 * 1000;

export type CfdiQueueState = "pending" | "alarm" | "blocked";

export function cfdi_queue_state(sold_at: number, now: number): CfdiQueueState {
	const age = now - sold_at;
	if (age >= CFDI_DEADLINE_MS - CFDI_BLOCK_MARGIN_MS) return "blocked";
	if (age >= CFDI_ALARM_MS) return "alarm";
	return "pending";
}

export function global_invoice_total(
	tickets: { total: number; provisional: boolean }[],
): number {
	return round_money(
		tickets
			.filter((ticket) => ticket.provisional)
			.reduce((sum, ticket) => sum + ticket.total, 0),
	);
}

function round_money(value: number): number {
	return Math.round(value * 100) / 100;
}
