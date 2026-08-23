/**
 * Pagos de cobranza: apply/cancel y recálculo como CobranzaPaymentService.
 * Status/provider son los enums originales (APLICADO, EFECTIVO).
 */
import { ok, type ImperiumDoc } from './envelope.ts';
import { sync_cobranza_sources } from './cobranza-lookup-flow.ts';
import { is_pos_session_open } from './pos-session-flow.ts';
import type { ImperiumStore } from './store.ts';

export const COBRANZA_PAYMENT_APPLIED = 'APLICADO';
export const COBRANZA_PAYMENT_CANCELED = 'CANCELADO';
export const COBRANZA_PAYMENT_CASH = 'EFECTIVO';

export type CobranzaPaymentCtx = {
	store: ImperiumStore;
	actor: ImperiumDoc | null;
	body: ImperiumDoc;
	params: Record<string, string>;
};

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function actor_id(actor: ImperiumDoc | null): string {
	return text(actor?._id);
}

function now(): string {
	return new Date().toISOString();
}

function is_object_id(value: string): boolean {
	return /^[a-f0-9]{24}$/i.test(value);
}

function payment_status(doc: ImperiumDoc | null | undefined): string {
	return String(doc?.status ?? doc?.estado ?? '').trim().toUpperCase();
}

export function cobranza_charge_is_canceled(charge: ImperiumDoc): boolean {
	const status = payment_status(charge);
	return status === 'CANCELADO' || status === 'CANCELED';
}

export function cobranza_payment_is_applied(doc: ImperiumDoc): boolean {
	const status = payment_status(doc) || COBRANZA_PAYMENT_APPLIED;
	return status === COBRANZA_PAYMENT_APPLIED || status === 'APPLIED';
}

export function cobranza_payment_is_canceled(doc: ImperiumDoc): boolean {
	const status = payment_status(doc);
	return status === COBRANZA_PAYMENT_CANCELED || status === 'CANCELED';
}

function is_cash_provider(value: unknown): boolean {
	const raw = String(value ?? COBRANZA_PAYMENT_CASH).trim().toUpperCase();
	return raw === COBRANZA_PAYMENT_CASH || raw === 'CASH';
}

async function next_payment_folio(store: ImperiumStore, context?: ImperiumDoc): Promise<number> {
	return store.next_auto_increment('CobranzaPayment', 'folio', {
		resource: 'cobranza-payment',
		context,
	});
}

async function hydrate_method(
	store: ImperiumStore,
	payment: ImperiumDoc,
): Promise<ImperiumDoc> {
	const id = ref_id(payment.method_id);
	if (!id || !store.has('violation-payment-method')) return payment;
	const method = await store.find_id('violation-payment-method', id);
	return {
		...payment,
		method_id: method
			? { _id: method._id, name: method.name ?? '' }
			: { _id: id, name: '' },
	};
}

async function method_id_for(store: ImperiumStore, name: string): Promise<string> {
	if (!store.has('violation-payment-method')) return '';
	const existing = await store.find_where('violation-payment-method', { name });
	if (existing) return String(existing._id);
	const created = await store.insert('violation-payment-method', {
		name,
		is_active: true,
	});
	return String(created._id);
}

export async function recompute_cobranza_charge(
	store: ImperiumStore,
	charge_id: string,
): Promise<ImperiumDoc | null> {
	const charge = await store.find_id('cobranza', charge_id);
	if (!charge || cobranza_charge_is_canceled(charge)) return charge;
	let paid_amount = Number(charge.paid_amount ?? 0);
	if (store.has('cobranza-payment')) {
		const { rows } = await store.find_many('cobranza-payment', {
			where: { charge_id },
			take: 5000,
			include_inactive: true,
			populate: false,
		});
		const applied = rows.filter((row) => cobranza_payment_is_applied(row));
		if (applied.length) {
			paid_amount = applied.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
		} else {
			paid_amount = 0;
		}
	}
	const total = Number(charge.total_amount ?? 0);
	const balance = Math.max(total - paid_amount, 0);
	const status = balance <= 0 ? 'PAGADO' : paid_amount > 0 ? 'PARCIAL' : 'PENDIENTE';
	const updated = await store.update('cobranza', charge_id, {
		paid_amount,
		balance,
		status,
		estado: status.toLowerCase(),
	});
	await sync_cobranza_sources(store, updated ?? { ...charge, paid_amount, balance, status });
	return updated;
}

export async function apply_cobranza_payment(ctx: CobranzaPaymentCtx) {
	const charge_id = text(ctx.body.charge_id ?? ctx.body.cobranza);
	const method_id = text(ctx.body.method_id);
	const pos_session_id = text(ctx.body.pos_session_id);
	const amount = Number(ctx.body.amount ?? ctx.body.importe ?? ctx.body.monto);
	if (!charge_id) throw new Error('Se requiere el cargo a abonar.');
	if (!method_id) throw new Error('Se requiere el método de pago.');
	if (!pos_session_id) throw new Error('Se requiere una sesión de caja abierta.');
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error('El monto del pago debe ser mayor a cero.');
	}
	if (!is_cash_provider(ctx.body.provider)) {
		throw new Error('Los pagos con Stripe o Mitec se inician desde «Pagar en línea».');
	}
	const charge = await ctx.store.find_id('cobranza', charge_id);
	if (!charge) throw new Error('No se encontró el cargo.');
	if (cobranza_charge_is_canceled(charge)) {
		throw new Error('El cargo está cancelado; no admite pagos.');
	}
	const balance = Number(charge.balance ?? 0);
	if (balance <= 0) throw new Error('El cargo ya está pagado.');
	if (amount > balance + 0.009) {
		throw new Error(`El monto excede el saldo pendiente (${balance.toFixed(2)}).`);
	}
	const session = await ctx.store.find_id('pos-session', pos_session_id);
	if (!session) throw new Error('No se encontró la sesión de caja.');
	if (!is_pos_session_open(session)) {
		throw new Error('La sesión de caja no está abierta.');
	}
	const cashier = actor_id(ctx.actor);
	const folio = await next_payment_folio(ctx.store, {
		charge_id: charge._id,
		amount,
		pos_session_id,
	});
	const created = await ctx.store.insert('cobranza-payment', {
		name: `Pago ${charge.reference}`,
		folio,
		charge_id: charge._id,
		amount,
		method_id,
		pos_session_id,
		cashier_id: cashier,
		created_by: cashier,
		payment_date: now(),
		status: COBRANZA_PAYMENT_APPLIED,
		estado: 'aplicado',
		provider: COBRANZA_PAYMENT_CASH,
		sync: true,
	});
	const updated_charge = await recompute_cobranza_charge(ctx.store, String(charge._id));
	const hydrated = await hydrate_method(ctx.store, created);
	return {
		...ok([hydrated], 'Pago aplicado correctamente.'),
		charge: updated_charge,
	};
}

export async function cancel_cobranza_payment(ctx: CobranzaPaymentCtx) {
	const id = text(ctx.params.id ?? ctx.body._id ?? ctx.body.id);
	if (!id || !is_object_id(id)) throw new Error('Identificador de pago inválido.');
	const payment = await ctx.store.find_id('cobranza-payment', id);
	if (!payment) throw new Error('No se encontró el pago.');
	if (cobranza_payment_is_canceled(payment)) {
		throw new Error('El pago ya está cancelado.');
	}
	const updated = await ctx.store.update('cobranza-payment', String(payment._id), {
		status: COBRANZA_PAYMENT_CANCELED,
		estado: 'cancelado',
	});
	const charge_id = ref_id(payment.charge_id);
	const updated_charge = charge_id ? await recompute_cobranza_charge(ctx.store, charge_id) : null;
	return {
		...ok([updated ?? payment], 'Pago cancelado correctamente.'),
		charge: updated_charge,
	};
}

export async function apply_online_cobranza_payment(
	store: ImperiumStore,
	params: { charge_id: string; amount: number; provider: string; provider_ref?: string },
) {
	const charge = await store.find_id('cobranza', params.charge_id);
	if (!charge) throw new Error('No se encontró el cargo.');
	if (cobranza_charge_is_canceled(charge)) {
		throw new Error('El cargo está cancelado; no admite pagos.');
	}
	const amount = Math.min(params.amount, Number(charge.balance ?? params.amount));
	if (!(amount > 0)) return;
	const payment_name = `Pago ${charge.reference} ${params.provider_ref || params.provider}`;
	if (params.provider_ref && store.has('cobranza-payment')) {
		const already = await store.find_where('cobranza-payment', { name: payment_name });
		if (already) return;
	}
	if (!store.has('cobranza-payment')) {
		await recompute_cobranza_charge(store, String(charge._id));
		return;
	}
	const method_name = String(params.provider).toUpperCase() === 'MITEC' ? 'Mitec' : 'Stripe';
	const method_id = await method_id_for(store, method_name);
	const folio = await next_payment_folio(store, {
		name: payment_name,
		charge_id: charge._id,
		provider: params.provider,
	});
	await store.insert('cobranza-payment', {
		name: payment_name,
		folio,
		charge_id: charge._id,
		amount,
		method_id,
		payment_date: now(),
		status: COBRANZA_PAYMENT_APPLIED,
		estado: 'aplicado',
		provider: String(params.provider).toUpperCase(),
		sync: true,
	});
	await recompute_cobranza_charge(store, String(charge._id));
}
