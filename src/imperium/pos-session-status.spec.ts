import { describe, expect, test } from 'bun:test';
import { assert_required_fields } from './required-fields.ts';
import { assert_objectid_refs } from './store.ts';
import {
	actor_can_restore_pos_session,
	prepare_pos_session_create,
	prepare_pos_session_update,
	resolve_pos_session_status_prompt,
} from './pos-session-flow.ts';
import {
	actor_may_present_pin,
	assert_pos_pin,
	issue_unlock_token,
	PinChallengeError,
	verify_unlock_token,
	verify_user_pin,
} from './user-pin.ts';

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

describe('POS session close prompt', () => {
	test('cerrar abre el diálogo de PIN una vez y no recarga', () => {
		const first = resolve_pos_session_status_prompt({
			previous_status: 'abierta',
			next_status: 'CERRADA',
			dialog_open: false,
		});
		const second = resolve_pos_session_status_prompt({
			previous_status: 'abierta',
			next_status: 'cerrada',
			dialog_open: true,
		});
		expect(first.ask_pin).toBe(true);
		expect(first.open_dialog).toBe(true);
		expect(first.reload).toBe(false);
		expect(first.normalized_status).toBe('cerrada');
		expect(second.open_dialog).toBe(false);
		expect(second.reload).toBe(false);
	});

	test('reabrir también pide PIN, incluido el cajero, y no recarga', () => {
		const prompt = resolve_pos_session_status_prompt({
			previous_status: 'cerrada',
			next_status: 'abierta',
			dialog_open: false,
		});
		expect(prompt.ask_pin).toBe(true);
		expect(prompt.open_dialog).toBe(true);
		expect(prompt.reload).toBe(false);
	});

	test('un cajero ajeno a assigned_users obtiene token con el PIN correcto', async () => {
		const creator = '550e8400-e29b-41d4-a716-446655440000';
		const cashier = 'dddddddddddddddddddddddd';
		const pin = {
			_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			document_id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
			document_model: 'PosSession',
			document_collection: 'pos-session',
			assigned_users: [creator],
			pin_hash: '1234',
			pin_version: 1,
			is_active: true,
		};
		expect(actor_may_present_pin(pin, cashier)).toBe(true);
		expect(actor_may_present_pin(pin, cashier, { skip_assignee_check: false })).toBe(true);
		expect(
			actor_may_present_pin(
				{ assigned_users: [creator], document_model: 'Otro', document_collection: 'otro' },
				cashier,
			),
		).toBe(false);
		const verified = await verify_user_pin(
			{ find_id: async () => pin } as never,
			{ pin_id: pin._id, pin: '1234' },
			{ _id: cashier },
		);
		const token = verified.data[0]?.unlock_token ?? '';
		expect(token).toBeTruthy();
		expect(verify_unlock_token(token, pin, cashier)).toBe(true);
		const challenge_store = {
			has: (name: string) => name === 'user-pin',
			find_where: async (resource: string) => (resource === 'user-pin' ? pin : null),
		} as never;
		const req = new Request('http://local/api/pos-session');
		await expect(
			assert_pos_pin(
				challenge_store,
				req,
				pin.document_id,
				{ method: 'PATCH', path: '/pos-session/:id', label: 'Cerrar o reabrir sesion POS' },
				{ _id: cashier },
				{ skip_assignee_check: false },
			),
		).rejects.toBeInstanceOf(PinChallengeError);
	});

	test('el mismo estatus no abre otro diálogo', () => {
		const prompt = resolve_pos_session_status_prompt({
			previous_status: 'abierta',
			next_status: 'abierta',
			dialog_open: false,
		});
		expect(prompt.ask_pin).toBe(false);
		expect(prompt.open_dialog).toBe(false);
		expect(prompt.reload).toBe(false);
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

describe('POS session create', () => {
	test('una sesión nueva nace abierta y sin fecha de cierre', async () => {
		const create_store = {
			has: () => false,
			find_id: async () => null,
			find_many: async () => ({ rows: [] }),
			next_auto_increment: async () => 7,
		} as never;
		const opening = '2026-10-09T18:00:00.000Z';
		const created = await prepare_pos_session_create(
			create_store,
			{
				opening_date: opening,
				closing_date: opening,
				fecha_cierre: opening,
				status: 'abierta',
				on_use: true,
			},
			actor,
		);
		expect(created.status).toBe('abierta');
		expect(created.opening_date).toBe(opening);
		expect(created.closing_date).toBeUndefined();
		expect(created.fecha_cierre).toBeUndefined();
	});
});
