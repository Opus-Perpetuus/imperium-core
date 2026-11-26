import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { create_simulated_terminal, SECRET_MASK } from './pos-card-terminal.ts';
import {
	cancel_terminal_charge,
	card_terminal_view,
	charge_on_terminal,
	handle_mp_orders_webhook,
	normalize_card_terminal,
	read_card_terminal,
	read_mercadopago_gateway,
	read_terminal_charge,
	sql_gateway_source,
	terminal_external_reference,
	verify_mp_signature,
	type CardTerminalConfig,
	type GatewayRow,
	type TerminalChargeRecord,
	type TerminalChargeRepo,
	type TerminalDeps,
} from './pos-card-terminal-flow.ts';

const TOKEN = 'TEST-1234-token-falso';
const SECRET = 'secreto-webhook-falso';
const MP_TERMINAL = { adapter: 'mercadopago_point' as const, terminal_id: 'PAX_A910__SMARTPOS1' };

function gateway(row: GatewayRow | null = { adapter: 'mercadopago', is_active: 1, config_json: { access_token: TOKEN, webhook_secret: SECRET } }) {
	const asked: string[] = [];
	return { asked, source: async (slug: string) => (asked.push(slug), row) };
}

function memory_repo(): TerminalChargeRepo & { rows: Map<string, TerminalChargeRecord> } {
	const rows = new Map<string, TerminalChargeRecord>();
	return {
		rows,
		async find_by_key(key) {
			return [...rows.values()].find((r) => r.idempotency_key === key) ?? null;
		},
		async find_by_id(id) {
			return rows.get(id) ?? null;
		},
		async save(r) {
			rows.set(r.id, { ...r });
			return r;
		},
	};
}

function fake_mp(statuses: string[]) {
	const sent: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
	const fetch = async (url: string, init?: RequestInit) => {
		sent.push({ url, method: String(init?.method), headers: init?.headers as Record<string, string> });
		const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
		return new Response(JSON.stringify({ id: 'ORD01ABC', status, external_reference: 'T-100', total_amount: '250.00' }), { status: 201 });
	};
	return { sent, fetch };
}

function deps(extra: Partial<TerminalDeps> = {}): TerminalDeps & { charges: ReturnType<typeof memory_repo> } {
	return { gateways: gateway().source, charges: memory_repo(), ...extra } as TerminalDeps & { charges: ReturnType<typeof memory_repo> };
}

const charge = (d: TerminalDeps, terminal: CardTerminalConfig = MP_TERMINAL, key = 'idem-1') =>
	charge_on_terminal(d, { session_id: 'S1', terminal, amount: 250, external_reference: 'T-100', idempotency_key: key });

function signed_headers(data_id: string, secret = SECRET, request_id = 'req-1', ts = '1732500000') {
	const v1 = createHmac('sha256', secret).update(`id:${data_id.toLowerCase()};request-id:${request_id};ts:${ts};`).digest('hex');
	return new Headers({ 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': request_id });
}

describe('pasarela de la tienda como fuente del token', () => {
	test('lee token y secreto de la fila mercadopago', async () => {
		const g = gateway();
		expect(await read_mercadopago_gateway(g.source)).toEqual({ access_token: TOKEN, webhook_secret: SECRET, test_mode: true });
		expect(g.asked).toEqual(['mercadopago']);
	});

	test('sin fila, inactiva, sin token o con la tabla ausente: «Configura Mercado Pago en la tienda»', async () => {
		const missing = [
			gateway(null).source,
			gateway({ is_active: 0, config_json: { access_token: TOKEN } }).source,
			gateway({ is_active: 1, config_json: '{}' }).source,
			async () => {
				throw new Error('relation "payment_gateways" does not exist');
			},
		];
		for (const source of missing) {
			await expect(read_mercadopago_gateway(source)).rejects.toThrow('Configura Mercado Pago en la tienda');
		}
	});

	test('config_json como texto y token de producción', async () => {
		const g = gateway({ is_active: true, config_json: JSON.stringify({ access_token: 'APP_USR-1', webhook_secret: SECRET }) });
		expect((await read_mercadopago_gateway(g.source)).test_mode).toBe(false);
	});

	test('fuente SQL consulta la tabla de la tienda por slug; sin tabla no consulta', async () => {
		const calls: unknown[][] = [];
		const sql = { unsafe: async (q: string, p?: unknown[]) => (calls.push([q, p]), [{ is_active: 1 }]) };
		expect(await sql_gateway_source(sql, '"subject_tienda"."payment_gateways"')('mercadopago')).toEqual({ is_active: 1 });
		expect(String(calls[0][0])).toContain('FROM "subject_tienda"."payment_gateways" WHERE slug = $1');
		expect(await sql_gateway_source(sql, null)('mercadopago')).toBeNull();
		expect(calls).toHaveLength(1);
	});
});

describe('configuración de terminal por caja', () => {
	test('solo adaptador y terminal; manual por defecto', () => {
		expect(read_card_terminal({})).toEqual({ adapter: 'manual', terminal_id: '' });
		expect(read_card_terminal({ card_terminal: JSON.stringify(MP_TERMINAL) })).toEqual(MP_TERMINAL);
		expect(normalize_card_terminal({ adapter: 'simulado', access_token: 'x' })).toEqual({ adapter: 'simulado', terminal_id: '' });
		expect(() => normalize_card_terminal({ adapter: 'otro' })).toThrow('adaptador');
	});

	test('la vista enmascara token y secreto de la pasarela', async () => {
		const view = await card_terminal_view({ card_terminal: MP_TERMINAL }, gateway().source);
		expect(view).toEqual({
			adapter: 'mercadopago_point',
			gateway_ready: true,
			config_json: { terminal_id: MP_TERMINAL.terminal_id, access_token: SECRET_MASK, webhook_secret: SECRET_MASK },
		});
		expect(JSON.stringify(view)).not.toContain(TOKEN);
		expect((await card_terminal_view({}, gateway(null).source)).gateway_ready).toBe(false);
	});

	test('referencia externa desde el folio, sin caracteres inválidos y ≤64', () => {
		expect(terminal_external_reference('T/100 A', 2)).toBe('T-100-A-2');
		expect(terminal_external_reference('x'.repeat(80), 'r1')).toHaveLength(64);
		expect(() => terminal_external_reference('')).toThrow('folio');
	});
});

describe('cobrar, consultar y cancelar en Mercado Pago Point', () => {
	test('aprobado: estado normalizado y PosPayment listo, sin token en la salida', async () => {
		const mp = fake_mp(['processed']);
		const d = deps({ fetch: mp.fetch });
		const view = await charge(d);
		expect(view.charge).toMatchObject({ id: 'ORD01ABC', status: 'aprobado', pos_session: 'S1', amount: 250, action_required: false });
		expect(view.payment).toEqual({ method: 'tarjeta', amount: 250, reference: 'ORD01ABC' });
		expect(mp.sent[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(mp.sent[0].headers['X-Idempotency-Key']).toBe('idem-1');
		expect(JSON.stringify(view)).not.toContain(TOKEN);
		expect(JSON.stringify(view)).not.toContain('idem-1');
		expect(d.charges.rows.get('ORD01ABC')?.status).toBe('aprobado');
	});

	test.each([
		['failed', 'rechazado', false],
		['action_required', 'requiere_accion', true],
		['expired', 'expirado', false],
	])('%s → %s sin PosPayment', async (mp_status, status, action_required) => {
		const view = await charge(deps({ fetch: fake_mp([mp_status]).fetch }));
		expect(view.charge.status).toBe(status);
		expect(view.charge.action_required).toBe(action_required);
		expect(view.payment).toBeNull();
	});

	test('sin pasarela no llama a Mercado Pago', async () => {
		const mp = fake_mp(['processed']);
		await expect(charge(deps({ gateways: gateway(null).source, fetch: mp.fetch }))).rejects.toThrow('Configura Mercado Pago en la tienda');
		expect(mp.sent).toHaveLength(0);
	});

	test('idempotencia: la misma llave relee la order en vez de crear otra', async () => {
		const mp = fake_mp(['at_terminal', 'processed']);
		const d = deps({ fetch: mp.fetch });
		expect((await charge(d)).charge.status).toBe('en_terminal');
		const again = await charge(d);
		expect(again.charge.status).toBe('aprobado');
		expect(mp.sent.map((s) => `${s.method} ${s.url}`)).toEqual([
			'POST https://api.mercadopago.com/v1/orders',
			'GET https://api.mercadopago.com/v1/orders/ORD01ABC',
		]);
		expect(d.charges.rows.size).toBe(1);
		await expect(
			charge_on_terminal(d, { session_id: 'S2', terminal: MP_TERMINAL, amount: 250, external_reference: 'T-100', idempotency_key: 'idem-1' }),
		).rejects.toThrow('ya se usó');
	});

	test('consultar relee la order y cancelar manda /cancel con su llave', async () => {
		const mp = fake_mp(['at_terminal', 'action_required', 'canceled']);
		const d = deps({ fetch: mp.fetch });
		await charge(d);
		const read = await read_terminal_charge(d, { session_id: 'S1', terminal: MP_TERMINAL, id: 'ORD01ABC' });
		expect(read.charge).toMatchObject({ status: 'requiere_accion', action_required: true });
		const canceled = await cancel_terminal_charge(d, { session_id: 'S1', terminal: MP_TERMINAL, id: 'ORD01ABC', idempotency_key: 'cancel-1' });
		expect(canceled.charge.status).toBe('cancelado');
		expect(mp.sent[2]).toMatchObject({ method: 'POST', url: 'https://api.mercadopago.com/v1/orders/ORD01ABC/cancel' });
		expect(mp.sent[2].headers['X-Idempotency-Key']).toBe('cancel-1');
	});

	test('un cobro de otra caja no se consulta ni se cancela', async () => {
		const d = deps({ fetch: fake_mp(['at_terminal']).fetch });
		await charge(d);
		await expect(read_terminal_charge(d, { session_id: 'S2', terminal: MP_TERMINAL, id: 'ORD01ABC' })).rejects.toThrow('no encontrado');
		await expect(
			cancel_terminal_charge(d, { session_id: 'S2', terminal: MP_TERMINAL, id: 'ORD01ABC', idempotency_key: 'c' }),
		).rejects.toThrow('no encontrado');
	});
});

describe('proveedores simulado y manual', () => {
	test('simulado: en terminal, luego aprobado o cancelado sin red ni pasarela', async () => {
		const d = deps({ gateways: gateway(null).source, simulated: create_simulated_terminal() });
		const sim = { adapter: 'simulado' as const, terminal_id: '' };
		const first = await charge(d, sim);
		expect(first.charge.status).toBe('en_terminal');
		const read = await read_terminal_charge(d, { session_id: 'S1', terminal: sim, id: first.charge.id });
		expect(read.payment).toEqual({ method: 'tarjeta', amount: 250, reference: first.charge.id });
		const second = await charge(d, sim, 'idem-2');
		const canceled = await cancel_terminal_charge(d, { session_id: 'S1', terminal: sim, id: second.charge.id, idempotency_key: 'c-2' });
		expect(canceled.charge.status).toBe('cancelado');
	});

	test('manual: aprobado con la referencia externa y la relectura no llama al proveedor', async () => {
		const d = deps({ gateways: gateway(null).source });
		const manual = { adapter: 'manual' as const, terminal_id: '' };
		const view = await charge(d, manual);
		expect(view.payment).toEqual({ method: 'tarjeta', amount: 250, reference: 'T-100' });
		expect((await read_terminal_charge(d, { session_id: 'S1', terminal: manual, id: 'T-100' })).charge.status).toBe('aprobado');
	});
});

describe('webhook orders de Mercado Pago', () => {
	const body = { type: 'order', action: 'order.processed', data: { id: 'ORD01ABC' } };

	test('firma con el manifiesto de la tienda y comparación estricta', () => {
		const h = signed_headers('ORD01ABC');
		const input = { x_signature: h.get('x-signature'), x_request_id: 'req-1', data_id: 'ORD01ABC', secret: SECRET };
		expect(verify_mp_signature(input)).toBe(true);
		expect(verify_mp_signature({ ...input, secret: 'otro' })).toBe(false);
		expect(verify_mp_signature({ ...input, x_request_id: 'req-2' })).toBe(false);
		expect(verify_mp_signature({ ...input, x_signature: 'ts=1,v1=zz' })).toBe(false);
		expect(verify_mp_signature({ ...input, x_signature: null })).toBe(false);
	});

	test('firma válida: no confía en el cuerpo, relee la order y actualiza el cobro', async () => {
		const mp = fake_mp(['at_terminal', 'processed']);
		const d = deps({ fetch: mp.fetch });
		await charge(d);
		const reply = await handle_mp_orders_webhook(d, {
			headers: signed_headers('ORD01ABC'),
			query: new URLSearchParams('data.id=ORD01ABC&type=order'),
			body: { ...body, status: 'failed' },
		});
		expect(reply).toEqual({ status: 200, body: { received: true, status: 'aprobado' } });
		expect(mp.sent[1]).toMatchObject({ method: 'GET', url: 'https://api.mercadopago.com/v1/orders/ORD01ABC' });
		expect(d.charges.rows.get('ORD01ABC')?.status).toBe('aprobado');
		const again = await handle_mp_orders_webhook(d, { headers: signed_headers('ORD01ABC'), query: new URLSearchParams(), body });
		expect(again.body.status).toBe('aprobado');
		expect(d.charges.rows.size).toBe(1);
	});

	test('firma inválida, sin cabeceras o sin pasarela: 401 y sin llamar a Mercado Pago', async () => {
		const mp = fake_mp(['processed']);
		const d = deps({ fetch: mp.fetch });
		const query = new URLSearchParams();
		const cases = [
			{ d, headers: signed_headers('ORD01ABC', 'secreto-equivocado') },
			{ d, headers: new Headers() },
			{ d: deps({ gateways: gateway(null).source, fetch: mp.fetch }), headers: signed_headers('ORD01ABC') },
		];
		for (const c of cases) {
			expect(await handle_mp_orders_webhook(c.d, { headers: c.headers, query, body })).toEqual({ status: 401, body: { received: false } });
		}
		expect(mp.sent).toHaveLength(0);
	});

	test('order desconocida u otro tópico: 200 sin tocar nada', async () => {
		const mp = fake_mp(['processed']);
		const d = deps({ fetch: mp.fetch });
		const query = new URLSearchParams();
		expect((await handle_mp_orders_webhook(d, { headers: signed_headers('ORD01ABC'), query, body })).body).toEqual({ received: true, ignored: true });
		const other = { type: 'payment', data: { id: 'ORD01ABC' } };
		expect((await handle_mp_orders_webhook(d, { headers: signed_headers('ORD01ABC'), query, body: other })).body.ignored).toBe(true);
		expect(mp.sent).toHaveLength(0);
	});
});
