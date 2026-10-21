import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { non_cash_amount, payments_by_method, prepare_pos_payments } from './pos-payments.ts';
import { build_pos_session_report, prepare_pos_ticket_create } from './pos-session-flow.ts';
import type { ImperiumStore } from './store.ts';

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

function store_of(tickets: ImperiumDoc[] = []): ImperiumStore {
	return {
		has: (r: string) => r === 'pos-tickets',
		async find_id(r: string, id: string) {
			return r === 'pos-session' && id === 'ses-1' ? session : null;
		},
		async find_where() {
			return null;
		},
		async *scan() {
			yield tickets;
		},
	} as unknown as ImperiumStore;
}

describe('formas de pago POS', () => {
	test('sin payments el ticket queda intacto (efectivo de siempre)', () => {
		const doc = { subtotal: 100, total_paid: 200, change: 100 };
		expect(prepare_pos_payments(doc)).toBe(doc);
		expect(non_cash_amount(doc)).toBe(0);
	});

	test('tarjeta por el total y mixto con cambio solo del efectivo', () => {
		expect(prepare_pos_payments({ subtotal: 80, payments: [{ method: 'TARJETA', amount: 80, reference: ' 1234 ' }] })).toMatchObject({
			payments: [{ method: 'tarjeta', amount: 80, reference: '1234' }],
			payment_method: 'tarjeta',
			total_paid: 80,
			change: 0,
		});
		expect(
			prepare_pos_payments({
				subtotal: 100,
				payments: [
					{ method: 'transferencia', amount: 60 },
					{ method: 'efectivo', amount: 50 },
				],
			}),
		).toMatchObject({ payment_method: 'mixto', total_paid: 110, change: 10 });
	});

	test('rechaza métodos raros, montos en cero, sobrepago no efectivo y faltantes', () => {
		expect(() => prepare_pos_payments({ subtotal: 10, payments: [{ method: 'bitcoin', amount: 10 }] })).toThrow(/no válida/);
		expect(() => prepare_pos_payments({ subtotal: 10, payments: [{ method: 'tarjeta', amount: 0 }] })).toThrow(/mayor a 0/);
		expect(() => prepare_pos_payments({ subtotal: 10, payments: [{ method: 'tarjeta', amount: 12 }] })).toThrow(/no pueden pasar/);
		expect(() => prepare_pos_payments({ subtotal: 10, payments: [{ method: 'efectivo', amount: 5 }] })).toThrow(/no cubren/);
	});

	test('el alta de venta aplica las reglas; otros tipos no', async () => {
		const venta = await prepare_pos_ticket_create(
			store_of(),
			{ pos_session: 'ses-1', ticket_type: 'VENTA', subtotal: 50, payments: [{ method: 'tarjeta', amount: 50 }] },
			{ _id: 'u1' },
		);
		expect(venta.payment_method).toBe('tarjeta');
		const retiro = await prepare_pos_ticket_create(
			store_of(),
			{ pos_session: 'ses-1', ticket_type: 'RETIRO_MANUAL_CAJA', withdrawal_amount: 5, withdrawal_reason: 'x', withdrawal_signature: 'data:image/png;base64,AAA', payments: [{ method: 'bitcoin', amount: 1 }] },
			{ _id: 'u1' },
		);
		expect(retiro.payment_method).toBeUndefined();
	});

	test('a la caja esperada solo entra el efectivo y el corte desglosa por forma de pago', async () => {
		const at = '2026-10-21T10:00:00.000Z';
		const tickets = [
			{ _id: 'a', ticket_sequence: '1', ticket_type: 'VENTA', subtotal: 200, createdAt: at },
			{ _id: 'b', ticket_sequence: '2', ticket_type: 'VENTA', subtotal: 100, payment_method: 'tarjeta', payments: [{ method: 'tarjeta', amount: 100 }], createdAt: at },
			{ _id: 'c', ticket_sequence: '3', ticket_type: 'VENTA', subtotal: 50, payment_method: 'mixto', payments: [{ method: 'transferencia', amount: 30 }, { method: 'efectivo', amount: 40 }], createdAt: at },
		];
		const report = await build_pos_session_report(store_of(tickets), session, 'VENTAS_PARCIAL', 'Ana', new Date('2026-10-21T12:00:00Z'));
		expect(report.total_sales).toBe(350);
		expect(report.expected_cash).toBe(100 + 200 + 0 + 20);
		expect(report.payments_by_method).toEqual({ efectivo: 220, tarjeta: 100, transferencia: 30 });
		const b = (report.tickets as ImperiumDoc[]).find((t) => t._id === 'b');
		expect(b).toMatchObject({ payment_method: 'tarjeta', non_cash_amount: 100, cash_effect: 0 });
		expect((report.tickets as ImperiumDoc[]).find((t) => t._id === 'a')).not.toHaveProperty('payment_method');
	});

	test('payments_by_method suma ventas legadas como efectivo', () => {
		expect(payments_by_method([{ subtotal: 10 }, { subtotal: 5, payments: [{ method: 'vale', amount: 5 }] }])).toEqual({ efectivo: 10, vale: 5 });
	});
});
