/**
 * Terminal de cobro con tarjeta del POS. El proveedor cobra en su equipo y solo
 * devuelve id, estado y monto: ningún dato de tarjeta pasa por Imperium. Un
 * cobro aprobado entra a `payments` como tarjeta con el id como referencia.
 */
import { create_mercadopago_point } from './pos-card-terminal-mercadopago.ts';
import type { PosPayment } from './pos-payments.ts';

export const TERMINAL_STATUSES = [
	'pendiente',
	'en_terminal',
	'requiere_accion',
	'aprobado',
	'rechazado',
	'cancelado',
	'expirado',
	'reembolsado',
] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
const FINAL_STATUSES = new Set<string>(['aprobado', 'rechazado', 'cancelado', 'expirado', 'reembolsado']);

export type TerminalChargeInput = {
	amount: number;
	external_reference: string;
	idempotency_key: string;
	terminal_id?: string;
	reference?: string;
};

export type TerminalCharge = {
	id: string;
	status: TerminalStatus;
	provider_status: string;
	amount: number;
	external_reference: string;
	raw?: unknown;
};

export type TerminalResult = { ok: true; charge: TerminalCharge } | { ok: false; error: string; status_code: number | null };

export interface CardTerminalProvider {
	readonly slug: string;
	readonly label: string;
	create_charge(input: TerminalChargeInput): Promise<TerminalResult>;
	fetch_charge(id: string): Promise<TerminalResult>;
	cancel_charge(id: string, idempotency_key: string): Promise<TerminalResult>;
	refund_charge?(id: string, idempotency_key: string): Promise<TerminalResult>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const EXTERNAL_REFERENCE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_KEYS = new Set(['access_token', 'webhook_secret']);
export const SECRET_MASK = '********';

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

export function is_final_status(status: string): boolean {
	return FINAL_STATUSES.has(status);
}

export function valid_external_reference(ref: unknown): string {
	const value = text(ref);
	if (!EXTERNAL_REFERENCE.test(value)) {
		throw new Error('La referencia externa debe tener de 1 a 64 letras, números, guion o guion bajo');
	}
	return value;
}

export function charge_amount(amount: unknown): number {
	const n = Math.round(Number(amount) * 100) / 100;
	if (!Number.isFinite(n) || !(n > 0)) throw new Error('El cobro necesita un monto mayor a 0');
	return n;
}

export function amount_string(amount: unknown): string {
	return charge_amount(amount).toFixed(2);
}

export function required_key(key: unknown, what = 'La llave de idempotencia'): string {
	const value = text(key);
	if (!value) throw new Error(`${what} es obligatoria`);
	return value;
}

export function normalize_charge_input(input: TerminalChargeInput): TerminalChargeInput {
	const terminal_id = text(input.terminal_id);
	const reference = text(input.reference);
	return {
		amount: charge_amount(input.amount),
		external_reference: valid_external_reference(input.external_reference),
		idempotency_key: required_key(input.idempotency_key),
		...(terminal_id ? { terminal_id } : {}),
		...(reference ? { reference } : {}),
	};
}

export function charge_to_pos_payment(charge: TerminalCharge): PosPayment {
	if (charge.status !== 'aprobado') throw new Error('Solo un cobro aprobado entra a la venta');
	return { method: 'tarjeta', amount: charge_amount(charge.amount), reference: charge.id };
}

export function create_manual_terminal(label = 'Terminal aparte (referencia a mano)'): CardTerminalProvider {
	const not_tracked = (): TerminalResult => ({
		ok: false,
		error: 'El cobro manual se hace en la terminal aparte; aquí no se consulta ni se cancela',
		status_code: null,
	});
	return {
		slug: 'manual',
		label,
		async create_charge(input) {
			const v = normalize_charge_input(input);
			const id = v.reference ?? v.external_reference;
			return {
				ok: true,
				charge: { id, status: 'aprobado', provider_status: 'manual', amount: v.amount, external_reference: v.external_reference },
			};
		},
		async fetch_charge() {
			return not_tracked();
		},
		async cancel_charge() {
			return not_tracked();
		},
	};
}

export type SimulatedTerminal = CardTerminalProvider & {
	refund_charge(id: string, idempotency_key: string): Promise<TerminalResult>;
	force_status(id: string, status: TerminalStatus): void;
};

export function create_simulated_terminal(opts: { label?: string; final_status?: TerminalStatus } = {}): SimulatedTerminal {
	const final_status = opts.final_status ?? 'aprobado';
	const charges = new Map<string, TerminalCharge>();
	const by_key = new Map<string, string>();
	let seq = 0;
	const found = (id: string): TerminalResult => {
		const charge = charges.get(id);
		return charge ? { ok: true, charge: { ...charge } } : { ok: false, error: `Cobro ${id} no encontrado`, status_code: 404 };
	};
	const move = (id: string, from: (s: TerminalStatus) => boolean, to: TerminalStatus, idempotency_key: string): TerminalResult => {
		required_key(idempotency_key);
		const charge = charges.get(id);
		if (!charge) return found(id);
		if (charge.status !== to) {
			if (!from(charge.status)) return { ok: false, error: `El cobro está ${charge.status}`, status_code: 409 };
			charge.status = to;
			charge.provider_status = to;
		}
		return found(id);
	};
	return {
		slug: 'simulado',
		label: opts.label ?? 'Terminal simulada',
		async create_charge(input) {
			const v = normalize_charge_input(input);
			const existing = by_key.get(v.idempotency_key);
			if (existing) return found(existing);
			const id = `sim-${++seq}`;
			charges.set(id, { id, status: 'en_terminal', provider_status: 'en_terminal', amount: v.amount, external_reference: v.external_reference });
			by_key.set(v.idempotency_key, id);
			return found(id);
		},
		async fetch_charge(id) {
			const charge = charges.get(id);
			if (charge && !is_final_status(charge.status)) {
				charge.status = final_status;
				charge.provider_status = final_status;
			}
			return found(id);
		},
		async cancel_charge(id, idempotency_key) {
			return move(id, (s) => !is_final_status(s), 'cancelado', idempotency_key);
		},
		async refund_charge(id, idempotency_key) {
			return move(id, (s) => s === 'aprobado', 'reembolsado', idempotency_key);
		},
		force_status(id, status) {
			const charge = charges.get(id);
			if (!charge) throw new Error(`Cobro ${id} no encontrado`);
			charge.status = status;
			charge.provider_status = status;
		},
	};
}

export type TerminalConfigRow = { adapter?: unknown; label?: unknown; config_json?: unknown };

export function parse_terminal_config(raw: unknown): Record<string, unknown> {
	let parsed = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {};
		}
	}
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
}

export function build_card_terminal(
	row: TerminalConfigRow,
	opts: { fetch?: FetchLike; base_url?: string } = {},
): CardTerminalProvider | null {
	const config = parse_terminal_config(row.config_json);
	const label = text(row.label) || undefined;
	switch (text(row.adapter)) {
		case 'manual':
			return create_manual_terminal(label);
		case 'simulado': {
			const final_status = TERMINAL_STATUSES.find((s) => s === config.final_status && is_final_status(s));
			return create_simulated_terminal({ label, final_status });
		}
		case 'mercadopago_point':
			return create_mercadopago_point({
				access_token: text(config.access_token),
				terminal_id: text(config.terminal_id) || undefined,
				test_mode: config.test_mode === true,
				expiration_time: text(config.expiration_time) || undefined,
				label,
				...opts,
			});
		default:
			return null;
	}
}

export function mask_terminal_row<T extends TerminalConfigRow>(row: T): T {
	const config = parse_terminal_config(row.config_json);
	for (const key of Object.keys(config)) {
		if (SECRET_KEYS.has(key) && text(config[key])) config[key] = SECRET_MASK;
	}
	return { ...row, config_json: typeof row.config_json === 'string' ? JSON.stringify(config) : config };
}
