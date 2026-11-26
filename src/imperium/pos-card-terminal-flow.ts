// Terminal por caja (F2): el token y el secreto vienen de la pasarela Mercado Pago de la tienda del cliente; la caja solo guarda adaptador y terminal.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { FEATURE_MAP_TEST_COLUMN_DDL } from './feature-map-test.ts';
import {
	build_card_terminal,
	charge_to_pos_payment,
	create_simulated_terminal,
	mask_terminal_row,
	parse_terminal_config,
	required_key,
	type CardTerminalProvider,
	type FetchLike,
	type TerminalCharge,
	type TerminalResult,
} from './pos-card-terminal.ts';
import type { PosPayment } from './pos-payments.ts';

export const CARD_TERMINAL_ADAPTERS = ['manual', 'simulado', 'mercadopago_point'] as const;
export type CardTerminalAdapter = (typeof CARD_TERMINAL_ADAPTERS)[number];
export type CardTerminalConfig = { adapter: CardTerminalAdapter; terminal_id: string };

export type GatewayRow = { adapter?: unknown; is_active?: unknown; config_json?: unknown };
export type GatewaySource = (slug: string) => Promise<GatewayRow | null>;
export type MercadoPagoGateway = { access_token: string; webhook_secret: string; test_mode: boolean };

export type TerminalRefund = { key: string; amount: number; at: string };

export type TerminalChargeRecord = {
	id: string;
	idempotency_key: string;
	pos_session: string;
	adapter: string;
	external_reference: string;
	amount: number;
	status: string;
	provider_status: string;
	refunded_amount?: number;
	refunds?: TerminalRefund[];
	created_at?: string;
	updated_at?: string;
};

export interface TerminalChargeRepo {
	find_by_key(idempotency_key: string): Promise<TerminalChargeRecord | null>;
	find_by_id(id: string): Promise<TerminalChargeRecord | null>;
	save(record: TerminalChargeRecord): Promise<TerminalChargeRecord>;
}

export type TerminalDeps = {
	gateways: GatewaySource;
	charges: TerminalChargeRepo;
	fetch?: FetchLike;
	base_url?: string;
	simulated?: CardTerminalProvider;
};

export type ChargeView = {
	charge: Omit<TerminalChargeRecord, 'idempotency_key'> & { action_required: boolean };
	payment: PosPayment | null;
};

const SHARED_SIMULATED = create_simulated_terminal();
const NO_GATEWAY = 'Configura Mercado Pago en la tienda';

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

function is_active(v: unknown): boolean {
	return v === true || Number(v) === 1 || v === 't' || v === 'true';
}

export async function read_mercadopago_gateway(source: GatewaySource): Promise<MercadoPagoGateway> {
	const row = await source('mercadopago').catch(() => null);
	if (!row || !is_active(row.is_active)) throw new Error(NO_GATEWAY);
	const config = parse_terminal_config(row.config_json);
	const access_token = text(config.access_token);
	if (!access_token) throw new Error(NO_GATEWAY);
	return { access_token, webhook_secret: text(config.webhook_secret), test_mode: access_token.startsWith('TEST-') };
}

export function read_card_terminal(session: Record<string, unknown> | null | undefined): CardTerminalConfig {
	const raw = parse_terminal_config(session?.card_terminal);
	const adapter = CARD_TERMINAL_ADAPTERS.find((a) => a === raw.adapter) ?? 'manual';
	return { adapter, terminal_id: text(raw.terminal_id) };
}

export function normalize_card_terminal(input: Record<string, unknown>): CardTerminalConfig {
	const adapter = CARD_TERMINAL_ADAPTERS.find((a) => a === text(input.adapter));
	if (!adapter) throw new Error(`El adaptador de terminal debe ser ${CARD_TERMINAL_ADAPTERS.join(', ')}`);
	return { adapter, terminal_id: text(input.terminal_id) };
}

export async function card_terminal_view(session: Record<string, unknown>, gateways: GatewaySource) {
	const terminal = read_card_terminal(session);
	const gateway = await read_mercadopago_gateway(gateways).catch(() => null);
	return mask_terminal_row({
		adapter: terminal.adapter,
		gateway_ready: Boolean(gateway),
		config_json: {
			terminal_id: terminal.terminal_id,
			access_token: gateway?.access_token ?? '',
			webhook_secret: gateway?.webhook_secret ?? '',
		},
	});
}

export function terminal_external_reference(folio: unknown, attempt?: unknown): string {
	const base = text(folio).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	if (!base) throw new Error('El cobro necesita el folio del ticket');
	const suffix = text(attempt).replace(/[^A-Za-z0-9]+/g, '');
	return suffix ? `${base.slice(0, 63 - suffix.length)}-${suffix}` : base.slice(0, 64);
}

export async function provider_for(deps: TerminalDeps, terminal: CardTerminalConfig): Promise<CardTerminalProvider> {
	if (terminal.adapter === 'simulado') return deps.simulated ?? SHARED_SIMULATED;
	if (terminal.adapter === 'manual') return build_card_terminal({ adapter: 'manual' })!;
	const gateway = await read_mercadopago_gateway(deps.gateways);
	return build_card_terminal(
		{
			adapter: 'mercadopago_point',
			config_json: { access_token: gateway.access_token, terminal_id: terminal.terminal_id, test_mode: gateway.test_mode },
		},
		{ fetch: deps.fetch, base_url: deps.base_url },
	)!;
}

export function charge_view(record: TerminalChargeRecord): ChargeView {
	const { idempotency_key: _key, ...charge } = record;
	const approved = { id: record.id, status: record.status, amount: record.amount } as TerminalCharge;
	return {
		charge: { ...charge, action_required: record.status === 'requiere_accion' },
		payment: record.status === 'aprobado' ? charge_to_pos_payment(approved) : null,
	};
}

function unwrap(result: TerminalResult): TerminalCharge {
	if (!result.ok) throw new Error(result.error);
	return result.charge;
}

function money(n: number): number {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function apply_charge(record: TerminalChargeRecord, charge: TerminalCharge): TerminalChargeRecord {
	const reported = charge.refunded_amount ?? (charge.status === 'reembolsado' ? record.amount : 0);
	return {
		...record,
		status: charge.status,
		provider_status: charge.provider_status,
		refunded_amount: money(Math.max(record.refunded_amount ?? 0, reported)),
		updated_at: new Date().toISOString(),
	};
}

export const REFUNDABLE_ADAPTERS = new Set(['simulado', 'mercadopago_point']);

export function refundable_amount(record: TerminalChargeRecord): number {
	if (!REFUNDABLE_ADAPTERS.has(record.adapter) || record.status !== 'aprobado') return 0;
	return Math.max(money(record.amount - (record.refunded_amount ?? 0)), 0);
}

export async function refund_terminal_charge(
	deps: TerminalDeps,
	input: { id: string; amount: number; idempotency_key: string },
): Promise<TerminalChargeRecord> {
	const idempotency_key = required_key(input.idempotency_key);
	const amount = money(input.amount);
	const record = await deps.charges.find_by_id(required_key(input.id, 'El id del cobro'));
	if (!record) throw new Error(`El pago con tarjeta ${input.id} no se cobró en la terminal; elige efectivo o saldo a favor`);
	if ((record.refunds ?? []).some((r) => r.key === idempotency_key)) return record;
	if (!REFUNDABLE_ADAPTERS.has(record.adapter)) {
		throw new Error('Esta terminal no reembolsa por sistema; elige efectivo o saldo a favor');
	}
	const left = refundable_amount(record);
	if (amount - left > 0.005) {
		throw new Error(`No se puede reembolsar ${amount.toFixed(2)} a la tarjeta: del cobro quedan ${left.toFixed(2)}`);
	}
	const provider = await provider_for(deps, { adapter: record.adapter as CardTerminalAdapter, terminal_id: '' });
	const whole = !(record.refunded_amount ?? 0) && Math.abs(amount - record.amount) < 0.005;
	const result = await provider.refund_charge!(record.id, idempotency_key, whole ? undefined : amount);
	if (!result.ok) throw new Error(`La terminal no reembolsó: ${result.error}. Elige efectivo o saldo a favor`);
	const next = apply_charge(record, result.charge);
	const refunded = money(Math.max(next.refunded_amount ?? 0, (record.refunded_amount ?? 0) + amount));
	return deps.charges.save({
		...next,
		status: record.amount - refunded < 0.005 ? 'reembolsado' : next.status,
		refunded_amount: refunded,
		refunds: [...(record.refunds ?? []), { key: idempotency_key, amount, at: next.updated_at! }],
	});
}

export async function charge_on_terminal(
	deps: TerminalDeps,
	input: { session_id: string; terminal: CardTerminalConfig; amount: number; external_reference: string; idempotency_key: string },
): Promise<ChargeView> {
	const idempotency_key = required_key(input.idempotency_key);
	const provider = await provider_for(deps, input.terminal);
	const existing = await deps.charges.find_by_key(idempotency_key);
	if (existing) {
		if (existing.pos_session !== input.session_id || existing.external_reference !== input.external_reference) {
			throw new Error('La llave de idempotencia ya se usó con otro cobro');
		}
		return refresh(deps, existing, provider);
	}
	const charge = unwrap(
		await provider.create_charge({
			amount: input.amount,
			external_reference: input.external_reference,
			idempotency_key,
			...(input.terminal.terminal_id ? { terminal_id: input.terminal.terminal_id } : {}),
		}),
	);
	const now = new Date().toISOString();
	const saved = await deps.charges.save({
		id: charge.id,
		idempotency_key,
		pos_session: input.session_id,
		adapter: provider.slug,
		external_reference: charge.external_reference || input.external_reference,
		amount: charge.amount || input.amount,
		status: charge.status,
		provider_status: charge.provider_status,
		created_at: now,
		updated_at: now,
	});
	return charge_view(saved);
}

async function refresh(deps: TerminalDeps, record: TerminalChargeRecord, provider: CardTerminalProvider): Promise<ChargeView> {
	if (record.adapter === 'manual') return charge_view(record);
	const charge = unwrap(await provider.fetch_charge(record.id));
	return charge_view(await deps.charges.save(apply_charge(record, charge)));
}

async function session_charge(deps: TerminalDeps, session_id: string, id: string): Promise<TerminalChargeRecord> {
	const record = await deps.charges.find_by_id(required_key(id, 'El id del cobro'));
	if (!record || record.pos_session !== session_id) throw new Error('Cobro no encontrado en esta caja');
	return record;
}

export async function read_terminal_charge(
	deps: TerminalDeps,
	input: { session_id: string; terminal: CardTerminalConfig; id: string },
): Promise<ChargeView> {
	const record = await session_charge(deps, input.session_id, input.id);
	return refresh(deps, record, await provider_for(deps, { ...input.terminal, adapter: record.adapter as CardTerminalAdapter }));
}

export async function cancel_terminal_charge(
	deps: TerminalDeps,
	input: { session_id: string; terminal: CardTerminalConfig; id: string; idempotency_key: string },
): Promise<ChargeView> {
	const record = await session_charge(deps, input.session_id, input.id);
	const provider = await provider_for(deps, { ...input.terminal, adapter: record.adapter as CardTerminalAdapter });
	const charge = unwrap(await provider.cancel_charge(record.id, input.idempotency_key));
	return charge_view(await deps.charges.save(apply_charge(record, charge)));
}

export function verify_mp_signature(input: {
	x_signature: string | null;
	x_request_id: string | null;
	data_id: string;
	secret: string;
}): boolean {
	if (!input.x_signature || !input.secret || !input.data_id) return false;
	const parts: Record<string, string> = {};
	for (const piece of input.x_signature.split(',')) {
		const [k, v] = piece.split('=').map((s) => s.trim());
		if (k && v) parts[k] = v;
	}
	if (!parts.ts || !parts.v1) return false;
	const manifest = `id:${input.data_id.toLowerCase()};request-id:${input.x_request_id ?? ''};ts:${parts.ts};`;
	const expected = Buffer.from(createHmac('sha256', input.secret).update(manifest).digest('hex'), 'hex');
	const given = Buffer.from(parts.v1, 'hex');
	return expected.length === given.length && timingSafeEqual(expected, given);
}

export type WebhookReply = { status: 200 | 401; body: Record<string, unknown> };

export async function handle_mp_orders_webhook(
	deps: TerminalDeps,
	input: { headers: Headers; query: URLSearchParams; body: Record<string, unknown> },
): Promise<WebhookReply> {
	const data = (input.body.data && typeof input.body.data === 'object' ? input.body.data : {}) as Record<string, unknown>;
	const data_id = text(input.query.get('data.id') ?? data.id ?? input.query.get('id'));
	const gateway = await read_mercadopago_gateway(deps.gateways).catch(() => null);
	const signed = verify_mp_signature({
		x_signature: input.headers.get('x-signature'),
		x_request_id: input.headers.get('x-request-id'),
		data_id,
		secret: gateway?.webhook_secret ?? '',
	});
	if (!gateway || !signed) return { status: 401, body: { received: false } };
	const topic = text(input.body.type ?? input.query.get('type') ?? input.body.topic ?? input.query.get('topic'));
	if (topic && topic !== 'order') return { status: 200, body: { received: true, ignored: true } };
	const record = await deps.charges.find_by_id(data_id);
	if (!record) return { status: 200, body: { received: true, ignored: true } };
	const provider = await provider_for(deps, { adapter: 'mercadopago_point', terminal_id: '' });
	const result = await provider.fetch_charge(record.id);
	if (!result.ok) return { status: 200, body: { received: true, ignored: true } };
	const saved = await deps.charges.save(apply_charge(record, result.charge));
	return { status: 200, body: { received: true, status: saved.status } };
}

export type SqlLike = { unsafe(query: string, params?: unknown[]): Promise<unknown[]> };

export function sql_gateway_source(sql: SqlLike, gateways_table: string | null): GatewaySource {
	return async (slug) => {
		if (!gateways_table) return null;
		const rows = (await sql.unsafe(
			`SELECT adapter, is_active, config_json FROM ${gateways_table} WHERE slug = $1 OR adapter = $1 LIMIT 1`,
			[slug],
		)) as GatewayRow[];
		return rows[0] ?? null;
	};
}

export function sql_terminal_deps(sql: SqlLike, gateways_table: string | null): TerminalDeps {
	return { gateways: sql_gateway_source(sql, gateways_table), charges: sql_charge_repo(sql, 'public.pos_card_terminal_charge') };
}

const ensured_tables = new Set<string>();

export function sql_charge_repo(sql: SqlLike, table: string): TerminalChargeRepo {
	const ready = async () => {
		if (ensured_tables.has(table)) return;
		await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${table} (
			id TEXT PRIMARY KEY,
			idempotency_key TEXT NOT NULL UNIQUE,
			pos_session TEXT NOT NULL,
			adapter TEXT NOT NULL,
			external_reference TEXT NOT NULL,
			amount NUMERIC(14,2) NOT NULL,
			status TEXT NOT NULL,
			provider_status TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			refunded_amount NUMERIC(14,2) DEFAULT 0,
			refunds JSONB DEFAULT '[]',
			${FEATURE_MAP_TEST_COLUMN_DDL}
		)`);
		await sql.unsafe(
			`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(14,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS refunds JSONB DEFAULT '[]'`,
		);
		ensured_tables.add(table);
	};
	const one = async (where: string, value: string) => {
		await ready();
		const rows = (await sql.unsafe(`SELECT * FROM ${table} WHERE ${where} = $1 LIMIT 1`, [value])) as Array<
			Omit<TerminalChargeRecord, 'refunds'> & { refunds?: unknown }
		>;
		const row = rows[0];
		if (!row) return null;
		const refunds = typeof row.refunds === 'string' ? JSON.parse(row.refunds) : row.refunds;
		return { ...row, amount: Number(row.amount), refunded_amount: Number(row.refunded_amount ?? 0), refunds: Array.isArray(refunds) ? refunds : [] };
	};
	return {
		find_by_key: (key) => one('idempotency_key', key),
		find_by_id: (id) => one('id', id),
		async save(r) {
			await ready();
			await sql.unsafe(
				`INSERT INTO ${table} (id, idempotency_key, pos_session, adapter, external_reference, amount, status, provider_status, created_at, updated_at, refunded_amount, refunds)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
				ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, provider_status = EXCLUDED.provider_status, updated_at = EXCLUDED.updated_at,
					refunded_amount = GREATEST(${table}.refunded_amount, EXCLUDED.refunded_amount), refunds = EXCLUDED.refunds`,
				[r.id, r.idempotency_key, r.pos_session, r.adapter, r.external_reference, r.amount, r.status, r.provider_status, r.created_at ?? r.updated_at, r.updated_at ?? r.created_at, r.refunded_amount ?? 0, JSON.stringify(r.refunds ?? [])],
			);
			return r;
		},
	};
}
