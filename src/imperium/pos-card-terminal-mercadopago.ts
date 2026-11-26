/**
 * Mercado Pago Point por la Orders API en modo PDV. La terminal virtual de
 * prueba solo se usa con `test_mode`: en producción falta la terminal y se
 * rechaza el cobro en vez de mandarlo a una terminal que no existe.
 */
import {
	amount_string,
	normalize_charge_input,
	required_key,
	type CardTerminalProvider,
	type FetchLike,
	type TerminalResult,
	type TerminalStatus,
} from './pos-card-terminal.ts';

export const MP_API_BASE = 'https://api.mercadopago.com';
export const MP_VIRTUAL_TERMINAL = 'NEWLAND_N950__SBX0000001';

const MP_STATUS: Record<string, TerminalStatus> = {
	created: 'pendiente',
	at_terminal: 'en_terminal',
	action_required: 'requiere_accion',
	processed: 'aprobado',
	failed: 'rechazado',
	canceled: 'cancelado',
	expired: 'expirado',
	refunded: 'reembolsado',
};

export function mp_order_status(status: unknown): TerminalStatus {
	return MP_STATUS[String(status ?? '')] ?? 'pendiente';
}

export type MercadoPagoPointOptions = {
	access_token: string;
	terminal_id?: string;
	test_mode?: boolean;
	expiration_time?: string;
	label?: string;
	base_url?: string;
	fetch?: FetchLike;
};

type MpOrder = {
	id?: unknown;
	status?: unknown;
	external_reference?: unknown;
	total_amount?: unknown;
	transactions?: { payments?: Array<{ id?: unknown; amount?: unknown }>; refunds?: Array<{ amount?: unknown }> };
};

function mp_error(data: unknown): string {
	const body = (data ?? {}) as { errors?: Array<{ code?: unknown; message?: unknown }>; message?: unknown; error?: unknown };
	const first = body.errors?.[0];
	return String(first?.message ?? first?.code ?? body.message ?? body.error ?? '');
}

export function create_mercadopago_point(opts: MercadoPagoPointOptions): CardTerminalProvider {
	const token = String(opts.access_token ?? '').trim();
	if (!token) throw new Error('Mercado Pago Point necesita el access token');
	const base = (opts.base_url || MP_API_BASE).replace(/\/+$/, '');
	const do_fetch = opts.fetch ?? fetch;
	const test_mode = opts.test_mode === true;
	const hide = (s: string) => s.split(token).join('***');

	function terminal_for(requested?: string): string {
		const terminal = requested || opts.terminal_id || (test_mode ? MP_VIRTUAL_TERMINAL : '');
		if (!terminal) throw new Error('Falta la terminal de Mercado Pago Point de esta caja');
		if (terminal === MP_VIRTUAL_TERMINAL && !test_mode) {
			throw new Error('La terminal virtual de prueba solo se usa en modo prueba');
		}
		return terminal;
	}

	async function call(method: 'GET' | 'POST', path: string, idempotency_key?: string, body?: unknown): Promise<TerminalResult> {
		const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		if (idempotency_key) headers['X-Idempotency-Key'] = idempotency_key;
		let res: Response;
		try {
			res = await do_fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		} catch (err) {
			return { ok: false, error: hide(`Mercado Pago no respondió: ${(err as Error)?.message ?? err}`), status_code: null };
		}
		const data = (await res.json().catch(() => null)) as MpOrder | null;
		if (!res.ok) {
			return { ok: false, error: hide(`Mercado Pago respondió ${res.status}: ${mp_error(data) || res.statusText}`), status_code: res.status };
		}
		if (!data?.id) return { ok: false, error: 'Mercado Pago no devolvió la orden', status_code: res.status };
		return {
			ok: true,
			charge: {
				id: String(data.id),
				status: mp_order_status(data.status),
				provider_status: String(data.status ?? ''),
				amount: Number(data.total_amount ?? data.transactions?.payments?.[0]?.amount ?? 0),
				external_reference: String(data.external_reference ?? ''),
				raw: data,
			},
		};
	}

	const order_path = (id: string) => `/v1/orders/${encodeURIComponent(required_key(id, 'El id de la orden'))}`;

	return {
		slug: 'mercadopago_point',
		label: opts.label ?? 'Mercado Pago Point',
		async create_charge(input) {
			const v = normalize_charge_input(input);
			return call('POST', '/v1/orders', v.idempotency_key, {
				type: 'point',
				external_reference: v.external_reference,
				...(opts.expiration_time ? { expiration_time: opts.expiration_time } : {}),
				transactions: { payments: [{ amount: amount_string(v.amount) }] },
				config: { point: { terminal_id: terminal_for(v.terminal_id), print_on_terminal: 'no_ticket' } },
			});
		},
		async fetch_charge(id) {
			return call('GET', order_path(id));
		},
		async cancel_charge(id, idempotency_key) {
			return call('POST', `${order_path(id)}/cancel`, required_key(idempotency_key));
		},
		async refund_charge(id, idempotency_key, amount) {
			const key = required_key(idempotency_key);
			if (amount === undefined) return call('POST', `${order_path(id)}/refund`, key);
			const order = await call('GET', order_path(id));
			if (!order.ok) return order;
			const payment_id = String((order.charge.raw as MpOrder).transactions?.payments?.[0]?.id ?? '');
			if (!payment_id) return { ok: false, error: 'La orden de Mercado Pago no tiene pago que reembolsar', status_code: null };
			return call('POST', `${order_path(id)}/refund`, key, { transactions: [{ id: payment_id, amount: amount_string(amount) }] });
		},
	};
}
