import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { build_pos_session_report, prepare_pos_ticket_create } from './pos-session-flow.ts';
import type { ImperiumStore } from './store.ts';

const session = {
	_id: 'ses-1',
	status: 'abierta',
	is_active: true,
	on_use: true,
	created_by: 'user-1',
	cash_register_opening_money: 500,
	cashier_name: 'Ana',
	branch_office: { _id: 'b1', name: 'Centro' },
};
const actor = { _id: 'user-1' };

function store_of(tickets: ImperiumDoc[]): ImperiumStore {
	return {
		has: (r: string) => r === 'pos-tickets',
		async find_id(resource: string, id: string) {
			return resource === 'pos-session' && id === 'ses-1' ? session : null;
		},
		async find_where() {
			return null;
		},
		async *scan() {
			yield tickets;
		},
	} as unknown as ImperiumStore;
}

describe('entrada de efectivo a caja', () => {
	test('exige cantidad y motivo, y no lleva artículos', async () => {
		const store = store_of([]);
		const base = { pos_session: 'ses-1', ticket_type: 'entrada_efectivo' };
		await expect(prepare_pos_ticket_create(store, { ...base, cash_in_reason: 'cambio' }, actor)).rejects.toThrow(
			/cantidad mayor a 0/,
		);
		await expect(prepare_pos_ticket_create(store, { ...base, cash_in_amount: 100 }, actor)).rejects.toThrow(/motivo/);
		const ok = await prepare_pos_ticket_create(
			store,
			{ ...base, cash_in_amount: '150.456', cash_in_reason: ' morralla ', items: [{ item_id: 'x' }] },
			actor,
		);
		expect(ok).toMatchObject({
			ticket_type: 'ENTRADA_EFECTIVO',
			cash_in_amount: 150.46,
			cash_in_reason: 'morralla',
			items: [],
			withdrawal_amount: 0,
		});
	});

	test('suma a la caja esperada y aparece en el corte; los demás tipos no cambian', async () => {
		const at = '2026-10-21T10:00:00.000Z';
		const tickets = [
			{ _id: 'v', ticket_sequence: 'S-1', ticket_type: 'VENTA', subtotal: 200, createdAt: at },
			{ _id: 'r', ticket_sequence: 'S-2', ticket_type: 'RETIRO_MANUAL_CAJA', withdrawal_amount: 50, createdAt: at },
			{ _id: 'e', ticket_sequence: 'S-3', ticket_type: 'ENTRADA_EFECTIVO', cash_in_amount: 100, cash_in_reason: 'cambio', createdAt: at },
		];
		const report = await build_pos_session_report(store_of(tickets), session, 'VENTAS_PARCIAL', 'Ana', new Date('2026-10-21T12:00:00Z'));
		expect(report.expected_cash).toBe(750);
		expect(report.total_sales).toBe(200);
		expect(report.total_manual_withdrawals).toBe(50);
		expect(report.total_cash_in).toBe(100);
		const entry = (report.tickets as ImperiumDoc[]).find((t) => t._id === 'e');
		expect(entry).toMatchObject({ client_name: 'Entrada de efectivo', cash_effect: 100, display_amount: 100, cash_in_reason: 'cambio' });
		expect((report.tickets as ImperiumDoc[]).find((t) => t._id === 'v')).not.toHaveProperty('cash_in_amount');
	});
});
