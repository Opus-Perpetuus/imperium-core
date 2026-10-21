import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import extra_routes from './extra-routes.json';
import { prepare_quote_rules, quote_lookup, register_quote_conversion } from './pos-quote.ts';
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

function memory_store(tickets: Row[]) {
	const data: Record<string, Row[]> = { 'pos-session': [session], 'pos-tickets': tickets };
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where || Object.entries(where).every(([k, v]) => row[k] === v);
	return {
		data,
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
		async update(r: string, id: string, patch: Row) {
			const rows = data[r] ?? [];
			const i = rows.findIndex((row) => String(row._id) === String(id));
			rows[i] = { ...rows[i], ...patch, _id: id };
			return rows[i];
		},
	} as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

const quote_doc: Row = {
	ticket_type: 'COTIZACION',
	ticket_sequence: 'CAJA-1-4',
	client_id: 'c1',
	client_name: 'Ana',
	subtotal: 120,
	items: [{ item_id: 'p1', item_name: 'Codo', quantity: 4, unit_price: 30 }],
	payments: [{ method: 'efectivo', amount: 120 }],
	total_paid: 120,
};

describe('cotizaciones POS', () => {
	test('la cotización no cobra: sin pagos, abierta; requiere artículos e importe', async () => {
		const store = memory_store([]);
		const q = await prepare_quote_rules(store, quote_doc);
		expect(q).toMatchObject({ total_paid: 0, change: 0, quote_status: 'abierta' });
		expect(q).not.toHaveProperty('payments');
		await expect(prepare_quote_rules(store, { ...quote_doc, items: [] })).rejects.toThrow(/artículos/);
		await expect(prepare_quote_rules(store, { ...quote_doc, subtotal: 0 })).rejects.toThrow(/importe/);
		const venta = { ticket_type: 'VENTA', subtotal: 1 };
		expect(await prepare_quote_rules(store, venta)).toBe(venta);
	});

	test('una venta ligada convierte la cotización una sola vez', async () => {
		const tickets: Row[] = [{ ...quote_doc, _id: 'q1', quote_status: 'abierta' }, { _id: 'v0', ticket_type: 'VENTA' }];
		const store = memory_store(tickets);
		const sale = { _id: 'v1', ticket_type: 'VENTA', ticket_sequence: 'CAJA-1-5', original_ticket: 'q1', subtotal: 120 };
		await expect(prepare_quote_rules(store, sale)).resolves.toBe(sale);
		await expect(prepare_quote_rules(store, { ...sale, original_ticket: 'v0' })).rejects.toThrow(/solo puede ligarse/);
		tickets.push(sale);
		await register_quote_conversion(store, sale);
		expect(store.data['pos-tickets'][0].quote_status).toBe('convertida');
		await expect(prepare_quote_rules(store, { ...sale, _id: 'v2' })).rejects.toThrow(/ya se convirtió/);
		const info = await quote_lookup(store, { folio: 'CAJA-1-4' });
		expect(info).toMatchObject({ _id: 'q1', estado: 'convertida', total: 120, venta: 'CAJA-1-5', cliente_id: 'c1' });
		expect(info.items).toEqual([{ item_id: 'p1', item_name: 'Codo', quantity: 4, unit_price: 30 }]);
		await expect(quote_lookup(store, { folio: 'nada' })).rejects.toThrow(/No se encontró/);
	});

	test('el alta acepta COTIZACION y el corte no la cuenta en caja ni en ventas', async () => {
		const store = memory_store([]);
		const created = await prepare_pos_ticket_create(store, { ...quote_doc, pos_session: 'ses-1' }, { _id: 'u1' });
		expect(created).toMatchObject({ ticket_type: 'COTIZACION', quote_status: 'abierta', total_paid: 0 });
		expect(created).not.toHaveProperty('payments');
		const at = '2026-10-21T10:00:00.000Z';
		const report_store = memory_store([
			{ _id: 'q', ticket_sequence: '1', ticket_type: 'COTIZACION', subtotal: 500, createdAt: at, pos_session: 'ses-1' },
			{ _id: 'v', ticket_sequence: '2', ticket_type: 'VENTA', subtotal: 50, createdAt: at, pos_session: 'ses-1' },
		]);
		const report = await build_pos_session_report(report_store, session, 'VENTAS_PARCIAL', 'Ana', new Date('2026-10-21T12:00:00Z'));
		expect(report.expected_cash).toBe(150);
		expect(report.total_sales).toBe(50);
		expect((report.tickets as Row[]).find((t) => t._id === 'q')).toMatchObject({ cash_effect: 0, display_amount: 500 });
		const actions = (extra_routes as { resource: string; method: string; path: string; action: string }[])
			.filter((r) => r.resource === 'pos-tickets')
			.map((r) => `${r.method} ${r.path}:${r.action}`);
		expect(actions).toContain('get /cotizacion:read_quote');
	});
});
