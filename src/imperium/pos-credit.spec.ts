import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import extra_routes from './extra-routes.json';
import {
	client_balance,
	client_credit_terms,
	client_statement,
	clients_aging,
	credit_refund_for_return,
	prepare_credit_rules,
} from './pos-credit.ts';
import { prepare_pos_return } from './pos-return.ts';
import { build_pos_session_report, prepare_pos_ticket_create } from './pos-session-flow.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;
const session = {
	_id: 'ses-1',
	status: 'abierta',
	is_active: true,
	on_use: true,
	created_by: 'u1',
	cash_register_opening_money: 100,
	cashier_name: 'Ana',
	branch_office: { name: 'Centro' },
};

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = { 'pos-session': [session], ...seed };
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where || Object.entries(where).every(([k, v]) => row[k] === v);
	return {
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async *scan(r: string, o: { where?: Record<string, unknown> } = {}) {
			yield (data[r] ?? []).filter((row) => matches(row, o.where));
		},
	} as unknown as ImperiumStore;
}

const contacts = [
	{ _id: 'cli-1', name: 'Ana', custom_data: { credito_limite: 1000, credito_dias: 30 } },
	{ _id: 'cli-2', name: 'Beto', custom_data: JSON.stringify({ credito_limite: '500' }) },
	{ _id: 'cli-3', name: 'Caro', custom_data: {} },
];

function credit_sale(id: string, amount: number, at: string, client = 'cli-1', extra: Row = {}): Row {
	return {
		_id: id,
		ticket_sequence: id,
		ticket_type: 'VENTA',
		client_id: client,
		client_name: 'Ana',
		subtotal: amount,
		payment_method: 'credito',
		payments: [{ method: 'credito', amount }],
		createdAt: at,
		...extra,
	};
}

describe('crédito POS', () => {
	test('términos desde campos personalizados; sin límite no hay crédito', async () => {
		const store = memory_store({ contacto: contacts, 'pos-tickets': [] });
		expect(await client_credit_terms(store, 'cli-1')).toEqual({ limite: 1000, dias: 30 });
		expect(await client_credit_terms(store, 'cli-2')).toEqual({ limite: 500, dias: 0 });
		expect(await client_credit_terms(store, 'cli-3')).toBeNull();
		expect(await client_credit_terms(store, 'nadie')).toBeNull();
	});

	test('venta a crédito: requiere cliente con crédito y cabe en el disponible', async () => {
		const store = memory_store({
			contacto: contacts,
			'pos-tickets': [credit_sale('v1', 800, '2026-10-01T12:00:00Z')],
		});
		const venta = (amount: number, client_id = 'cli-1') => ({
			ticket_type: 'VENTA',
			client_id,
			subtotal: amount,
			payments: [{ method: 'credito', amount }],
		});
		await expect(prepare_credit_rules(store, venta(150))).resolves.toBeTruthy();
		await expect(prepare_credit_rules(store, venta(250))).rejects.toThrow(/disponible 200.00/);
		await expect(prepare_credit_rules(store, venta(10, ''))).rejects.toThrow(/requiere un cliente/);
		await expect(prepare_credit_rules(store, venta(10, 'cli-3'))).rejects.toThrow(/no tiene crédito/);
		const contado = { ticket_type: 'VENTA', subtotal: 9999 };
		expect(await prepare_credit_rules(store, contado)).toBe(contado);
	});

	test('abono: no pasa del saldo ni se paga con crédito; baja el saldo', async () => {
		const tickets = [credit_sale('v1', 300, '2026-10-01T12:00:00Z')];
		const store = memory_store({ contacto: contacts, 'pos-tickets': tickets });
		const abono = await prepare_credit_rules(store, { ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 100, items: [{ x: 1 }] });
		expect(abono.items).toEqual([]);
		await expect(prepare_credit_rules(store, { ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 301 })).rejects.toThrow(/pasa del saldo/);
		await expect(prepare_credit_rules(store, { ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 0 })).rejects.toThrow(/mayor a 0/);
		await expect(prepare_credit_rules(store, { ticket_type: 'ABONO_CREDITO', subtotal: 5 })).rejects.toThrow(/requiere un cliente/);
		await expect(
			prepare_credit_rules(store, { ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 5, payments: [{ method: 'credito', amount: 5 }] }),
		).rejects.toThrow(/no se puede pagar con crédito/);
		tickets.push({ _id: 'a1', ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 120, createdAt: '2026-10-05T12:00:00Z' });
		tickets.push({ ...credit_sale('v2', 50, '2026-10-06T12:00:00Z'), state: 'cancelado' });
		expect(await client_balance(store, 'cli-1')).toBe(180);
	});

	test('el alta de ticket aplica crédito en ventas y abonos (y acepta el método credito)', async () => {
		const store = memory_store({ contacto: contacts, 'pos-tickets': [credit_sale('v1', 100, '2026-10-01T12:00:00Z')] });
		const venta = await prepare_pos_ticket_create(
			store,
			{ pos_session: 'ses-1', ticket_type: 'VENTA', client_id: 'cli-1', subtotal: 60, payments: [{ method: 'credito', amount: 40 }, { method: 'efectivo', amount: 50 }] },
			{ _id: 'u1' },
		);
		expect(venta).toMatchObject({ payment_method: 'mixto', change: 30 });
		const abono = await prepare_pos_ticket_create(
			store,
			{ pos_session: 'ses-1', ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 100, payments: [{ method: 'tarjeta', amount: 100 }] },
			{ _id: 'u1' },
		);
		expect(abono).toMatchObject({ ticket_type: 'ABONO_CREDITO', payment_method: 'tarjeta' });
		await expect(
			prepare_pos_ticket_create(store, { pos_session: 'ses-1', ticket_type: 'VENTA', subtotal: 10, payments: [{ method: 'credito', amount: 10 }] }, { _id: 'u1' }),
		).rejects.toThrow(/requiere un cliente/);
	});

	test('devolución de una venta a crédito baja primero el saldo de esa venta', async () => {
		const sale = credit_sale('v1', 100, '2026-10-01T12:00:00Z', 'cli-1', {
			payment_method: 'mixto',
			payments: [{ method: 'credito', amount: 60 }, { method: 'efectivo', amount: 40 }],
			items: [{ item_id: 'p1', item_name: 'Codo', quantity: 10, unit_price: 10 }],
		});
		const tickets: Row[] = [sale];
		const store = memory_store({ contacto: contacts, 'pos-tickets': tickets });
		expect(await credit_refund_for_return(store, sale, 50)).toBe(50);
		const ret = await prepare_pos_return(store, {
			ticket_type: 'DEVOLUCION',
			original_ticket: 'v1',
			items: [{ item_id: 'p1', quantity: 5 }],
		});
		expect(ret).toMatchObject({ subtotal: -50, payment_method: 'credito', payments: [{ method: 'credito', amount: 50 }] });
		tickets.push({ ...ret, _id: 'd1', createdAt: '2026-10-02T12:00:00Z' });
		expect(await credit_refund_for_return(store, sale, 50)).toBe(10);
		expect(await client_balance(store, 'cli-1')).toBe(10);
		const contado = { _id: 'v9', ticket_type: 'VENTA', subtotal: 20 };
		expect(await credit_refund_for_return(store, contado, 20)).toBe(0);
	});

	test('estado de cuenta y antigüedad: abonos FIFO y vencimiento a los días de crédito', async () => {
		const tickets: Row[] = [
			credit_sale('v1', 300, '2026-08-01T12:00:00Z'),
			credit_sale('v2', 200, '2026-10-10T12:00:00Z'),
			{ _id: 'a1', ticket_sequence: 'a1', ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 100, createdAt: '2026-09-01T12:00:00Z' },
			credit_sale('v3', 80, '2026-10-01T12:00:00Z', 'cli-2', { client_name: 'Beto' }),
			{ _id: 'v4', ticket_type: 'VENTA', client_id: 'cli-3', subtotal: 40, createdAt: '2026-10-01T12:00:00Z' },
		];
		const store = memory_store({ contacto: contacts, 'pos-tickets': tickets });
		const st = await client_statement(store, 'cli-1', '2026-10-21');
		expect(st).toMatchObject({ limite: 1000, dias: 30, saldo: 400, disponible: 600 });
		expect(st.movimientos.map((m) => m.saldo)).toEqual([300, 200, 400]);
		expect(st.cargos_abiertos).toEqual([
			expect.objectContaining({ _id: 'v1', saldo: 200, vence: '2026-08-31', tramo: 'd31_60' }),
			expect.objectContaining({ _id: 'v2', saldo: 200, vence: '2026-11-09', tramo: 'por_vencer' }),
		]);
		const aging = await clients_aging(store, '2026-10-21');
		expect(aging).toMatchObject({ saldo: 480, por_vencer: 200, d1_30: 80, d31_60: 200 });
		expect(aging.clientes.map((c) => c.cliente_id)).toEqual(['cli-1', 'cli-2']);
		await expect(client_statement(store, '')).rejects.toThrow(/cliente/);
	});

	test('corte: la venta a crédito no entra a la caja y el abono en efectivo sí', async () => {
		const at = '2026-10-21T10:00:00.000Z';
		const tickets = [
			credit_sale('v1', 100, at),
			{ _id: 'a1', ticket_sequence: 'a1', ticket_type: 'ABONO_CREDITO', client_id: 'cli-1', subtotal: 30, createdAt: at },
			{ _id: 'd1', ticket_sequence: 'd1', ticket_type: 'DEVOLUCION', subtotal: -20, payment_method: 'credito', payments: [{ method: 'credito', amount: 20 }], createdAt: at },
		];
		for (const t of tickets) t.pos_session = 'ses-1';
		const store = memory_store({ contacto: contacts, 'pos-tickets': tickets });
		const report = await build_pos_session_report(store, session, 'VENTAS_PARCIAL', 'Ana', new Date('2026-10-21T12:00:00Z'));
		expect(report.expected_cash).toBe(100 + 0 + 30 + 0);
		expect(report.total_sales).toBe(100);
		expect(report.total_credit_payments).toBe(30);
		expect(report.payments_by_method).toEqual({ credito: 100, efectivo: 0 });
	});

	test('rutas POS declaradas en minúsculas (el router compara el método en minúsculas)', () => {
		const routes = (extra_routes as { resource: string; method: string; action: string; path: string }[]).filter(
			(r) => r.resource === 'pos-tickets',
		);
		const actions = routes.map((r) => `${r.method} ${r.path}:${r.action}`);
		expect(actions).toContain('get /estado-cuenta:read_client_statement');
		expect(actions).toContain('get /antiguedad-clientes:read_clients_aging');
		expect(actions).toContain('get /devolucion-disponible:read_return_availability');
		for (const r of extra_routes as { method: string }[]) expect(r.method).toBe(r.method.toLowerCase());
	});
});
