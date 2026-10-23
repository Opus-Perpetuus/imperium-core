import { describe, expect, test } from 'bun:test';
import {
	BULK_CLOSE_MAX_SESSIONS,
	BULK_CLOSE_RELEASE_REASON,
	bulk_close_blocker,
	bulk_close_pos_sessions,
} from './pos-session-bulk-close.ts';

const ADMIN = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', _ref: 'user-menu-management-0' };
const CAJERO = { _id: 'cccccccccccccccccccccccc' };

function session(id: string, extra: Record<string, unknown> = {}) {
	return {
		_id: id,
		name: `SES-${id.slice(0, 4)}`,
		status: 'abierta',
		on_use: false,
		cashier_name: 'Ana',
		cash_register_opening_money: 100,
		updatedAt: '2026-10-01T10:00:00.000Z',
		runtime_state: { mode: 'ONLINE', items: [] },
		usage_history: [
			{ started_at: '2026-10-01T09:00:00.000Z', used_by_user: CAJERO._id, cashier_name: 'Ana' },
		],
		...extra,
	};
}

function fake_store(docs: Record<string, any>, tickets: any[] = [], opts: { mutate_on_second_read?: string } = {}) {
	const reads: Record<string, number> = {};
	const updates: Array<{ id: string; patch: any }> = [];
	const store = {
		has: (name: string) => name === 'pos-tickets',
		async find_id(_name: string, id: string) {
			reads[id] = (reads[id] ?? 0) + 1;
			const doc = docs[id];
			if (!doc) return null;
			if (opts.mutate_on_second_read === id && reads[id] > 1) {
				return { ...doc, updatedAt: '2026-10-01T11:00:00.000Z' };
			}
			return structuredClone(doc);
		},
		async update(_name: string, id: string, patch: any) {
			updates.push({ id, patch });
			docs[id] = { ...docs[id], ...patch };
			return docs[id];
		},
		async *scan(_name: string, args: any) {
			yield tickets.filter((t) => t.pos_session === args.where.pos_session);
		},
	};
	return { store: store as never, updates };
}

const ID1 = '111111111111111111111111';
const ID2 = '222222222222222222222222';
const ID3 = '333333333333333333333333';
const ID4 = '444444444444444444444444';
const ID5 = '555555555555555555555555';

describe('bulk close POS sessions', () => {
	test('solo el superadministrador puede usarlo', async () => {
		const { store } = fake_store({ [ID1]: session(ID1) });
		await expect(
			bulk_close_pos_sessions(store, CAJERO, { ids: [ID1], reason: 'fin de turno' }),
		).rejects.toMatchObject({ status: 403, code: 'access_denied' });
		await expect(
			bulk_close_pos_sessions(store, null, { ids: [ID1], reason: 'fin de turno' }),
		).rejects.toMatchObject({ status: 403 });
	});

	test('valida ids y razón', async () => {
		const { store } = fake_store({});
		await expect(bulk_close_pos_sessions(store, ADMIN, { ids: [], reason: 'fin de turno' })).rejects.toMatchObject({ status: 400 });
		const muchos = Array.from({ length: BULK_CLOSE_MAX_SESSIONS + 1 }, (_, i) => i.toString(16).padStart(24, '0'));
		await expect(bulk_close_pos_sessions(store, ADMIN, { ids: muchos, reason: 'fin de turno' })).rejects.toMatchObject({ status: 400 });
		await expect(bulk_close_pos_sessions(store, ADMIN, { ids: [ID1], reason: 'abc' })).rejects.toMatchObject({ status: 400 });
		await expect(bulk_close_pos_sessions(store, ADMIN, { ids: [ID1], reason: 'x'.repeat(301) })).rejects.toMatchObject({ status: 400 });
	});

	test('dry_run no escribe, no pide razón y resume tickets', async () => {
		const { store, updates } = fake_store(
			{ [ID1]: session(ID1) },
			[{ _id: 't1', ticket_sequence: 'T-1', pos_session: ID1, ticket_type: 'VENTA', subtotal: 50, total_paid: 50, createdAt: '2026-10-01T09:30:00.000Z' }],
		);
		const res = await bulk_close_pos_sessions(store, ADMIN, { ids: [ID1, ID1], dry_run: true });
		expect(updates).toHaveLength(0);
		const out = res.data[0] as any;
		expect(out.por_cerrar).toHaveLength(1);
		expect(out.por_cerrar[0]).toMatchObject({ _id: ID1, ticket_count: 1, total_sales: 50, expected_cash: 150 });
		expect(res.message).toBe('Se cerrarían: 1. Omitidas: 0.');
	});

	test('omite bloqueadas sin force y deja auditoría al cerrar', async () => {
		const docs = {
			[ID1]: session(ID1),
			[ID2]: session(ID2, { on_use: true }),
			[ID3]: session(ID3, { runtime_state: { mode: 'ONLINE', items: [{ product_id: 'x', quantity: 1 }] } }),
			[ID4]: session(ID4, { runtime_state: { mode: 'OFFLINE', items: [] } }),
			[ID5]: session(ID5, { status: 'cerrada' }),
		};
		const { store, updates } = fake_store(docs);
		const res = await bulk_close_pos_sessions(store, ADMIN, {
			ids: [ID1, ID2, ID3, ID4, ID5, 'ffffffffffffffffffffffff'],
			reason: 'Cierre de fin de día',
		});
		const out = res.data[0] as any;
		expect(out.cerradas.map((s: any) => s._id)).toEqual([ID1]);
		expect(Object.fromEntries(out.omitidas.map((s: any) => [s._id, s.code]))).toEqual({
			[ID2]: 'on_use',
			[ID3]: 'open_order',
			[ID4]: 'offline',
			[ID5]: 'not_open',
			ffffffffffffffffffffffff: 'not_found',
		});
		expect(updates).toHaveLength(1);
		const patch = updates[0].patch;
		expect(patch).toMatchObject({ status: 'cerrada', on_use: false });
		expect(patch.closing_date).toBeTruthy();
		expect(patch.usage_history[0].ended_at).toBeTruthy();
		expect(patch.usage_history[0].release_reason).toBe(BULK_CLOSE_RELEASE_REASON);
		const audit = patch.usage_history.at(-1);
		expect(audit).toMatchObject({
			used_by_user: ADMIN._id,
			cashier_name: 'Ana',
			release_reason: `${BULK_CLOSE_RELEASE_REASON}: Cierre de fin de día`,
		});
		expect(res.message).toBe('Sesiones cerradas: 1. Omitidas: 5.');
	});

	test('force cierra las bloqueadas pero nunca las que no están abiertas', async () => {
		const docs = {
			[ID2]: session(ID2, { on_use: true }),
			[ID4]: session(ID4, { runtime_state: { mode: 'OFFLINE', items: [] } }),
			[ID5]: session(ID5, { status: 'cancelada' }),
		};
		const { store, updates } = fake_store(docs);
		const res = await bulk_close_pos_sessions(store, ADMIN, { ids: [ID2, ID4, ID5], reason: 'Cajas olvidadas', force: true });
		const out = res.data[0] as any;
		expect(out.cerradas.map((s: any) => s._id)).toEqual([ID2, ID4]);
		expect(out.omitidas.map((s: any) => s.code)).toEqual(['not_open']);
		expect(updates).toHaveLength(2);
	});

	test('si la sesión cambió mientras se cerraba, se omite', async () => {
		const { store, updates } = fake_store({ [ID1]: session(ID1) }, [], { mutate_on_second_read: ID1 });
		const res = await bulk_close_pos_sessions(store, ADMIN, { ids: [ID1], reason: 'fin de turno' });
		const out = res.data[0] as any;
		expect(out.cerradas).toHaveLength(0);
		expect(out.omitidas[0].code).toBe('changed');
		expect(updates).toHaveLength(0);
	});

	test('bulk_close_blocker respeta el orden de bloqueos', () => {
		expect(bulk_close_blocker(session(ID1, { status: 'cerrada', on_use: true }))).toBe('not_open');
		expect(bulk_close_blocker(session(ID1, { on_use: true, runtime_state: { mode: 'OFFLINE', items: [1] } }))).toBe('on_use');
		expect(bulk_close_blocker(session(ID1, { runtime_state: { mode: 'OFFLINE', items: [1] } }))).toBe('open_order');
		expect(bulk_close_blocker(session(ID1, { status: 'OPEN' }))).toBeNull();
	});
});
