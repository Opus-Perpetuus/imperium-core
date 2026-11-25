import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { ImperiumDoc } from './envelope.ts';
import { card_refundable, refund_return_to_card } from './pos-card-refund.ts';
import { create_simulated_terminal } from './pos-card-terminal.ts';
import { create_mercadopago_point } from './pos-card-terminal-mercadopago.ts';
import {
	handle_mp_orders_webhook,
	refund_terminal_charge,
	type TerminalChargeRecord,
	type TerminalChargeRepo,
	type TerminalDeps,
} from './pos-card-terminal-flow.ts';
import { prepare_pos_return } from './pos-return.ts';
import { build_pos_session_report } from './pos-session-flow.ts';
import type { ImperiumStore } from './store.ts';

const TOKEN = 'TEST-1234-token-falso';
const SECRET = 'secreto-webhook-falso';
const gateways = async () => ({ adapter: 'mercadopago', is_active: 1, config_json: { access_token: TOKEN, webhook_secret: SECRET } });

function memory_repo(seed: TerminalChargeRecord[] = []): TerminalChargeRepo & { rows: Map<string, TerminalChargeRecord> } {
	const rows = new Map(seed.map((r) => [r.id, { ...r }]));
	return {
		rows,
		async find_by_key(key) {
			return [...rows.values()].find((r) => r.idempotency_key === key) ?? null;
		},
		async find_by_id(id) {
			return rows.get(id) ? { ...rows.get(id)! } : null;
		},
		async save(r) {
			rows.set(r.id, { ...r });
			return r;
		},
	};
}

function memory_store(tickets: ImperiumDoc[]) {
	const data: Record<string, ImperiumDoc[]> = { 'pos-tickets': tickets.map((t) => ({ ...t })) };
	const matches = (row: ImperiumDoc, where: Record<string, unknown> = {}) => Object.entries(where).every(([k, v]) => row[k] === v);
	return {
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === id) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(r: string, o: { where?: Record<string, unknown> } = {}) {
			const rows = (data[r] ?? []).filter((row) => matches(row, o.where));
			return { rows, total: rows.length };
		},
		async *scan(r: string, o: { where?: Record<string, unknown> } = {}) {
			yield (data[r] ?? []).filter((row) => matches(row, o.where));
		},
	} as unknown as ImperiumStore & { data: Record<string, ImperiumDoc[]> };
}

const ITEMS = [{ item_id: 'p1', item_name: 'Codo', quantity: 4, unit_price: 25 }];

function card_sale(reference: string, extra: ImperiumDoc = {}): ImperiumDoc {
	return {
		_id: 'venta-1',
		ticket_type: 'VENTA',
		ticket_sequence: 'CAJA-1-7',
		state: 'confirmado',
		subtotal: 100,
		items: ITEMS,
		payment_method: 'tarjeta',
		payments: [{ method: 'tarjeta', amount: 100, reference }],
		...extra,
	};
}

function return_doc(quantity: number, refund_method?: string): ImperiumDoc {
	return {
		ticket_type: 'DEVOLUCION',
		original_ticket: 'venta-1',
		pos_session: 'ses-1',
		items: [{ item_id: 'p1', quantity }],
		...(refund_method ? { refund_method } : {}),
	};
}

async function simulated_setup(amount = 100) {
	const terminal = create_simulated_terminal();
	const created = await terminal.create_charge({ amount, external_reference: 'CAJA-1-7', idempotency_key: 'cobro-1' });
	if (!created.ok) throw new Error(created.error);
	await terminal.fetch_charge(created.charge.id);
	const record: TerminalChargeRecord = {
		id: created.charge.id,
		idempotency_key: 'cobro-1',
		pos_session: 'ses-1',
		adapter: 'simulado',
		external_reference: 'CAJA-1-7',
		amount,
		status: 'aprobado',
		provider_status: 'aprobado',
	};
	const charges = memory_repo([record]);
	let calls = 0;
	const counted = {
		...terminal,
		async refund_charge(id: string, key: string, amt?: number) {
			calls++;
			return terminal.refund_charge(id, key, amt);
		},
	};
	const deps: TerminalDeps = { gateways, charges, simulated: counted };
	return { deps, charges, id: record.id, calls: () => calls };
}

describe('devolución a la tarjeta', () => {
	test('reembolso total: la devolución lleva el pago a tarjeta y el cobro queda reembolsado', async () => {
		const { deps, charges, id } = await simulated_setup();
		const store = memory_store([card_sale(id)]);
		const prepared = await prepare_pos_return(store, return_doc(4, 'tarjeta'));
		expect(prepared.subtotal).toBe(-100);
		expect(prepared.payment_method).toBe('tarjeta');
		expect(prepared.payments).toEqual([expect.objectContaining({ method: 'tarjeta', amount: 100, reference: id })]);
		const done = await refund_return_to_card(deps, prepared);
		expect(done.card_refund_status).toBe('reembolsado');
		expect(charges.rows.get(id)).toMatchObject({ status: 'reembolsado', refunded_amount: 100 });
		expect(charges.rows.get(id)!.refunds).toHaveLength(1);
	});

	test('reembolso parcial y luego el resto; la llave cambia con cada devolución', async () => {
		const { deps, charges, id } = await simulated_setup();
		const store = memory_store([card_sale(id)]);
		const first = await refund_return_to_card(deps, await prepare_pos_return(store, return_doc(1, 'tarjeta')));
		expect(charges.rows.get(id)).toMatchObject({ status: 'aprobado', refunded_amount: 25 });
		store.data['pos-tickets'].push({ ...first, _id: 'dev-1' });
		expect(await card_refundable(deps, store.data['pos-tickets'][0], [store.data['pos-tickets'][1]])).toBe(75);
		const second = await prepare_pos_return(store, return_doc(3, 'tarjeta'));
		const key = (p: unknown) => (p as ImperiumDoc[])[0].refund_key;
		expect(key(second.payments)).not.toBe(key(first.payments));
		await refund_return_to_card(deps, second);
		expect(charges.rows.get(id)).toMatchObject({ status: 'reembolsado', refunded_amount: 100 });
	});

	test('idempotente: reintentar la misma devolución no reembolsa dos veces', async () => {
		const { deps, charges, id, calls } = await simulated_setup();
		const store = memory_store([card_sale(id)]);
		const prepared = await prepare_pos_return(store, return_doc(2, 'tarjeta'));
		const again = await prepare_pos_return(store, return_doc(2, 'tarjeta'));
		expect(again.payments).toEqual(prepared.payments);
		await refund_return_to_card(deps, prepared);
		await refund_return_to_card(deps, again);
		expect(calls()).toBe(1);
		expect(charges.rows.get(id)).toMatchObject({ refunded_amount: 50 });
		expect(charges.rows.get(id)!.refunds).toHaveLength(1);
	});

	test('nunca reembolsa más de lo cobrado en la terminal', async () => {
		const { deps, id } = await simulated_setup(60);
		const store = memory_store([card_sale(id, { payments: [{ method: 'tarjeta', amount: 60, reference: id }, { method: 'efectivo', amount: 40 }] })]);
		const prepared = await prepare_pos_return(store, return_doc(4, 'tarjeta'));
		expect(prepared.payments).toEqual([expect.objectContaining({ method: 'tarjeta', amount: 60 })]);
		await expect(refund_terminal_charge(deps, { id, amount: 61, idempotency_key: 'otra' })).rejects.toThrow('del cobro quedan 60.00');
	});

	test('si la pasarela rechaza, el error es claro y el cobro no cambia', async () => {
		const charges = memory_repo([
			{ id: 'ORD1', idempotency_key: 'k', pos_session: 'ses-1', adapter: 'mercadopago_point', external_reference: 'CAJA-1-7', amount: 100, status: 'aprobado', provider_status: 'processed' },
		]);
		const fetch = async () => new Response(JSON.stringify({ errors: [{ message: 'refund not allowed' }] }), { status: 400 });
		const store = memory_store([card_sale('ORD1')]);
		const prepared = await prepare_pos_return(store, return_doc(4, 'tarjeta'));
		await expect(refund_return_to_card({ gateways, charges, fetch }, prepared)).rejects.toThrow(
			'La terminal no reembolsó: Mercado Pago respondió 400: refund not allowed. Elige efectivo o saldo a favor',
		);
		expect(charges.rows.get('ORD1')).toMatchObject({ status: 'aprobado' });
		expect(charges.rows.get('ORD1')!.refunds).toBeUndefined();
	});

	test('Mercado Pago: parcial manda transactions con el pago y X-Idempotency-Key; total sin cuerpo', async () => {
		const sent: Array<{ url: string; init?: RequestInit }> = [];
		const fetch = async (url: string, init?: RequestInit) => {
			sent.push({ url, init });
			const order = { id: 'ORD1', status: 'processed', total_amount: '100.00', transactions: { payments: [{ id: 'PAY1', amount: '100.00' }] } };
			return new Response(JSON.stringify(order), { status: 200 });
		};
		const mp = create_mercadopago_point({ access_token: TOKEN, test_mode: true, fetch });
		await mp.refund_charge!('ORD1', 'llave-1', 25);
		await mp.refund_charge!('ORD1', 'llave-2');
		expect(sent.map((s) => `${s.init?.method} ${s.url}`)).toEqual([
			'GET https://api.mercadopago.com/v1/orders/ORD1',
			'POST https://api.mercadopago.com/v1/orders/ORD1/refund',
			'POST https://api.mercadopago.com/v1/orders/ORD1/refund',
		]);
		expect(JSON.parse(String(sent[1].init?.body))).toEqual({ transactions: [{ id: 'PAY1', amount: '25.00' }] });
		expect((sent[1].init?.headers as Record<string, string>)['X-Idempotency-Key']).toBe('llave-1');
		expect(sent[2].init?.body).toBeUndefined();
	});

	test('webhook refunded refleja el reembolso sin duplicarlo', async () => {
		const base = { idempotency_key: 'k', pos_session: 'ses-1', adapter: 'mercadopago_point', external_reference: 'CAJA-1-7', amount: 100, provider_status: 'processed' };
		const charges = memory_repo([
			{ ...base, id: 'ORD1', status: 'aprobado' },
			{ ...base, id: 'ORD2', status: 'reembolsado', refunded_amount: 100, refunds: [{ key: 'devpos-x', amount: 100, at: '2026-11-25' }] },
		]);
		const fetch = async (url: string) =>
			new Response(JSON.stringify({ id: url.split('/').pop(), status: 'refunded', total_amount: '100.00', transactions: { refunds: [{ amount: '100.00' }] } }), { status: 200 });
		const deps: TerminalDeps = { gateways, charges, fetch };
		const hook = async (id: string) => {
			const ts = '1700000000';
			const v1 = createHmac('sha256', SECRET).update(`id:${id.toLowerCase()};request-id:req-1;ts:${ts};`).digest('hex');
			return handle_mp_orders_webhook(deps, {
				headers: new Headers({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': 'req-1' }),
				query: new URLSearchParams(),
				body: { type: 'order', data: { id } },
			});
		};
		expect((await hook('ORD1')).body).toEqual({ received: true, status: 'reembolsado' });
		await hook('ORD1');
		expect(charges.rows.get('ORD1')).toMatchObject({ status: 'reembolsado', refunded_amount: 100 });
		await hook('ORD2');
		expect(charges.rows.get('ORD2')).toMatchObject({ refunded_amount: 100 });
		expect(charges.rows.get('ORD2')!.refunds).toHaveLength(1);
		expect(await card_refundable(deps, card_sale('ORD1'), [])).toBe(0);
	});

	test('venta sin cobro en terminal: sin forma elegida queda como hoy y «a la tarjeta» se rechaza', async () => {
		const store = memory_store([card_sale('', { payments: undefined, payment_method: undefined })]);
		const plain = await prepare_pos_return(store, return_doc(1));
		expect(plain.payments).toBeUndefined();
		expect(plain.subtotal).toBe(-25);
		expect(await refund_return_to_card(null, plain)).toBe(plain);
		await expect(prepare_pos_return(store, return_doc(1, 'tarjeta'))).rejects.toThrow('elige efectivo o saldo a favor');
		const manual = memory_store([card_sale('REF-MANUAL')]);
		const charges = memory_repo();
		await expect(refund_return_to_card({ gateways, charges }, await prepare_pos_return(manual, return_doc(1, 'tarjeta')))).rejects.toThrow(
			'no se cobró en la terminal',
		);
	});

	test('corte: la devolución a tarjeta no baja el efectivo y se desglosa aparte', async () => {
		const at = '2026-11-25T10:00:00.000Z';
		const tickets = [
			{ _id: 'a', ticket_sequence: '1', ticket_type: 'VENTA', subtotal: 100, payment_method: 'tarjeta', payments: [{ method: 'tarjeta', amount: 100, reference: 'ORD1' }], createdAt: at },
			{ _id: 'b', ticket_sequence: '2', ticket_type: 'VENTA', subtotal: 50, createdAt: at },
			{ _id: 'c', ticket_sequence: '3', ticket_type: 'DEVOLUCION', original_ticket: 'a', subtotal: -40, payment_method: 'tarjeta', payments: [{ method: 'tarjeta', amount: 40, reference: 'ORD1' }], createdAt: at },
			{ _id: 'd', ticket_sequence: '4', ticket_type: 'DEVOLUCION', original_ticket: 'b', subtotal: -10, createdAt: at },
		];
		const session = { _id: 'ses-1', status: 'abierta', is_active: true, cash_register_opening_money: 100, cashier_name: 'Ana', branch_office: { name: 'Centro' } };
		const store = {
			has: (r: string) => r === 'pos-tickets',
			async find_id() {
				return null;
			},
			async find_where() {
				return null;
			},
			async *scan() {
				yield tickets;
			},
		} as unknown as ImperiumStore;
		const report = await build_pos_session_report(store, session, 'VENTAS_PARCIAL', 'Ana', new Date('2026-11-25T12:00:00Z'));
		expect(report.expected_cash).toBe(100 + 50 - 10);
		expect(report.payments_by_method).toEqual({ efectivo: 50, tarjeta: 100, devolucion_tarjeta: 40 });
		expect((report.tickets as ImperiumDoc[]).find((t) => t._id === 'c')).toMatchObject({ cash_effect: 0 });
	});
});
