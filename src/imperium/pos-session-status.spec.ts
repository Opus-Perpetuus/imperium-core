import { describe, expect, test } from 'bun:test';
import { assert_required_fields } from './required-fields.ts';
import { assert_objectid_refs } from './store.ts';
import {
	actor_can_restore_pos_session,
	prepare_pos_session_update,
} from './pos-session-flow.ts';
import { issue_unlock_token, verify_unlock_token } from './user-pin.ts';

const store = { has: () => false, find_id: async () => null } as never;
const actor = { _id: 'cccccccccccccccccccccccc' };
const previous = {
	_id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
	name: 'SES-1-NORTE-1710000000',
	consecutivo: 1,
	opening_date: '2026-01-01T00:00:00.000Z',
	cashier: 'no-es-un-id',
	cashier_name: 'Ana',
	branch_office: 'tampoco',
	cash_register_opening_money: 100,
	created_by: '550e8400-e29b-41d4-a716-446655440000',
	status: 'abierta',
	on_use: true,
	runtime_state: {
		mode: 'ONLINE',
		sequence: 1,
		cash: 0,
		items: [{ product_id: 'ffffffffffffffffffffffff', quantity: 1, unit_price: 10 }],
	},
	usage_history: [
		{
			started_at: '2026-01-01T00:00:00.000Z',
			used_by_user: 'cccccccccccccccccccccccc',
			cashier: 'no-es-un-id',
			cashier_name: 'Ana',
		},
	],
};

describe('POS session status update', () => {
	test('un cambio de estatus no revalida el resto de la sesión', async () => {
		const patch = await prepare_pos_session_update(
			store,
			{ _id: previous._id, status: 'cancelada' },
			previous,
			actor,
		);
		expect(patch.status).toBe('cancelada');
		expect(patch.closing_date).toBeTruthy();
		expect(patch.on_use).toBe(false);
		expect(patch.name).toBeUndefined();
		expect(patch.cashier).toBeUndefined();
		expect(patch.created_by).toBeUndefined();
		expect(patch.runtime_state).toBeUndefined();
		expect(() => assert_required_fields('pos-session', { ...previous, ...patch }, Object.keys(patch))).not.toThrow();
		expect(() => assert_objectid_refs('pos-session', { ...previous, ...patch }, Object.keys(patch))).not.toThrow();
	});

	test('cerrar deja fecha de cierre; volver a abierta no la exige', async () => {
		const closed = await prepare_pos_session_update(
			store,
			{ status: 'CERRADA' },
			previous,
			actor,
		);
		expect(closed.status).toBe('cerrada');
		expect(closed.closing_date).toBeTruthy();
		const reopened = await prepare_pos_session_update(
			store,
			{ status: 'abierta' },
			{ ...previous, status: 'cerrada', closing_date: '2026-01-02T00:00:00.000Z' },
			actor,
		);
		expect(reopened.status).toBe('abierta');
		expect(reopened.closing_date).toBeNull();
	});
});

describe('POS session restore', () => {
	test('el dueño de una sesión abierta la restaura sin PIN', () => {
		expect(actor_can_restore_pos_session(previous, actor)).toBe(true);
		expect(
			actor_can_restore_pos_session(previous, { _id: 'dddddddddddddddddddddddd' }),
		).toBe(false);
		expect(
			actor_can_restore_pos_session({ ...previous, status: 'cerrada' }, actor),
		).toBe(false);
	});

	test('un PIN válido desbloquea aunque el registro no traiga document_model', () => {
		const pin = {
			_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			document_id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
			pin_version: 1,
		};
		const issued = issue_unlock_token(pin, String(actor._id));
		expect(verify_unlock_token(issued.token, pin, String(actor._id))).toBe(true);
	});
});
