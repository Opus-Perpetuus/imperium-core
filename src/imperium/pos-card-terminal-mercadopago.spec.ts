import { describe, expect, test } from 'bun:test';
import { create_mercadopago_point, mp_order_status, MP_VIRTUAL_TERMINAL, type MercadoPagoPointOptions } from './pos-card-terminal-mercadopago.ts';

const TOKEN = 'TEST-0000-token-falso';

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fake_mp(reply: { status?: number; body?: unknown } = {}) {
	const sent: Sent[] = [];
	const fetch = async (url: string, init?: RequestInit) => {
		sent.push({
			url,
			method: String(init?.method),
			headers: init?.headers as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return new Response(JSON.stringify(reply.body ?? { id: 'ORD01', status: 'at_terminal', external_reference: 'TCK-1', total_amount: '80.50' }), {
			status: reply.status ?? 201,
		});
	};
	return { sent, fetch };
}

function point(extra: Partial<MercadoPagoPointOptions> = {}, reply?: { status?: number; body?: unknown }) {
	const mp = fake_mp(reply);
	return { mp, provider: create_mercadopago_point({ access_token: TOKEN, terminal_id: 'PAX_A910__SMARTPOS1', fetch: mp.fetch, ...extra }) };
}

const input = { amount: 80.5, external_reference: 'TCK-1', idempotency_key: 'idem-1' };

describe('Mercado Pago Point (Orders API)', () => {
	test('crear manda POST /v1/orders con el cuerpo y headers de la guía', async () => {
		const { mp, provider } = point({ expiration_time: 'PT2M' });
		const r = await provider.create_charge(input);
		expect(r).toMatchObject({ ok: true, charge: { id: 'ORD01', status: 'en_terminal', provider_status: 'at_terminal', amount: 80.5, external_reference: 'TCK-1' } });
		expect(mp.sent).toHaveLength(1);
		const [req] = mp.sent;
		expect(req.url).toBe('https://api.mercadopago.com/v1/orders');
		expect(req.method).toBe('POST');
		expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(req.headers['X-Idempotency-Key']).toBe('idem-1');
		expect(req.body).toEqual({
			type: 'point',
			external_reference: 'TCK-1',
			expiration_time: 'PT2M',
			transactions: { payments: [{ amount: '80.50' }] },
			config: { point: { terminal_id: 'PAX_A910__SMARTPOS1', print_on_terminal: 'no_ticket' } },
		});
		expect(JSON.stringify(req.body)).not.toContain('default_installments');
	});

	test('monto siempre con 2 decimales, terminal por cobro y base URL configurable', async () => {
		const { mp, provider } = point({ base_url: 'http://mp.local/' });
		await provider.create_charge({ ...input, amount: 100, terminal_id: 'OTRA__T2' });
		await provider.create_charge({ ...input, amount: 12.345, idempotency_key: 'idem-2' });
		expect(mp.sent.map((s) => s.url)).toEqual(['http://mp.local/v1/orders', 'http://mp.local/v1/orders']);
		expect(mp.sent.map((s) => (s.body as any).transactions.payments[0].amount)).toEqual(['100.00', '12.35']);
		expect((mp.sent[0].body as any).config.point.terminal_id).toBe('OTRA__T2');
		expect((mp.sent[0].body as any).expiration_time).toBeUndefined();
	});

	test('el reintento reusa la misma llave de idempotencia', async () => {
		const { mp, provider } = point();
		await provider.create_charge(input);
		await provider.create_charge(input);
		expect(mp.sent.map((s) => s.headers['X-Idempotency-Key'])).toEqual(['idem-1', 'idem-1']);
		await expect(provider.create_charge({ ...input, idempotency_key: ' ' })).rejects.toThrow(/idempotencia/);
		expect(mp.sent).toHaveLength(2);
	});

	test('consultar, cancelar y reembolsar', async () => {
		const { mp, provider } = point({}, { status: 200, body: { id: 'ORD01', status: 'processed', total_amount: '80.50' } });
		expect(await provider.fetch_charge('ORD01')).toMatchObject({ ok: true, charge: { status: 'aprobado' } });
		await provider.cancel_charge('ORD01', 'cancel-1');
		await provider.refund_charge!('ORD01', 'refund-1');
		expect(mp.sent.map((s) => [s.method, s.url, s.headers['X-Idempotency-Key'], s.body])).toEqual([
			['GET', 'https://api.mercadopago.com/v1/orders/ORD01', undefined, undefined],
			['POST', 'https://api.mercadopago.com/v1/orders/ORD01/cancel', 'cancel-1', undefined],
			['POST', 'https://api.mercadopago.com/v1/orders/ORD01/refund', 'refund-1', undefined],
		]);
		expect(mp.sent.every((s) => s.headers.Authorization === `Bearer ${TOKEN}`)).toBe(true);
		await expect(provider.cancel_charge('ORD01', '')).rejects.toThrow(/idempotencia/);
		await expect(provider.fetch_charge(' ')).rejects.toThrow(/id de la orden/);
	});

	test('mapea todos los estados de la orden', async () => {
		const expected = {
			created: 'pendiente',
			at_terminal: 'en_terminal',
			action_required: 'requiere_accion',
			processed: 'aprobado',
			failed: 'rechazado',
			canceled: 'cancelado',
			expired: 'expirado',
			refunded: 'reembolsado',
		};
		for (const [mp_status, status] of Object.entries(expected)) {
			expect(mp_order_status(mp_status)).toBe(status as any);
			const { provider } = point({}, { status: 200, body: { id: 'ORD01', status: mp_status } });
			expect(await provider.fetch_charge('ORD01')).toMatchObject({ ok: true, charge: { status, provider_status: mp_status } });
		}
		expect(mp_order_status('raro')).toBe('pendiente');
	});

	test('la terminal virtual solo se usa en modo prueba', async () => {
		const test = point({ terminal_id: undefined, test_mode: true });
		await test.provider.create_charge(input);
		expect((test.mp.sent[0].body as any).config.point.terminal_id).toBe(MP_VIRTUAL_TERMINAL);

		const prod = point({ terminal_id: undefined, test_mode: false });
		await expect(prod.provider.create_charge(input)).rejects.toThrow(/Falta la terminal/);
		await expect(prod.provider.create_charge({ ...input, terminal_id: MP_VIRTUAL_TERMINAL })).rejects.toThrow(/modo prueba/);
		expect(prod.mp.sent).toHaveLength(0);

		const prod_virtual = point({ terminal_id: MP_VIRTUAL_TERMINAL });
		await expect(prod_virtual.provider.create_charge(input)).rejects.toThrow(/modo prueba/);
		expect(prod_virtual.mp.sent).toHaveLength(0);
	});

	test('un error HTTP vuelve como ok:false con código y mensaje, sin el token', async () => {
		const { provider } = point({}, { status: 400, body: { errors: [{ code: 'invalid_terminal', message: `terminal inválida para Bearer ${TOKEN}` }] } });
		const r = await provider.create_charge(input);
		expect(r).toMatchObject({ ok: false, status_code: 400 });
		if (r.ok) throw new Error('debía fallar');
		expect(r.error).toContain('400');
		expect(r.error).toContain('terminal inválida');
		expect(r.error).not.toContain(TOKEN);

		const down = create_mercadopago_point({
			access_token: TOKEN,
			terminal_id: 'T1',
			fetch: async () => {
				throw new Error(`socket cerrado ${TOKEN}`);
			},
		});
		const d = await down.fetch_charge('ORD01');
		expect(d).toMatchObject({ ok: false, status_code: null });
		expect(JSON.stringify(d)).not.toContain(TOKEN);
	});

	test('valida referencia externa, monto y token antes de llamar', async () => {
		const { mp, provider } = point();
		await expect(provider.create_charge({ ...input, external_reference: 'Juan Pérez' })).rejects.toThrow(/referencia externa/);
		await expect(provider.create_charge({ ...input, external_reference: 'x'.repeat(65) })).rejects.toThrow(/referencia externa/);
		await expect(provider.create_charge({ ...input, amount: 0 })).rejects.toThrow(/mayor a 0/);
		expect(mp.sent).toHaveLength(0);
		expect(() => create_mercadopago_point({ access_token: ' ' })).toThrow(/access token/);
	});
});
