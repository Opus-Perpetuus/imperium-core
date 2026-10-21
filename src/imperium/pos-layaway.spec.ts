import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import extra_routes from './extra-routes.json';
import {
	cancel_layaway,
	layaway_lookup,
	prepare_layaway_rules,
	register_layaway_effects,
} from './pos-layaway.ts';
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
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(r: string, o: { where?: Record<string, unknown>; take?: number } = {}) {
			const rows = (data[r] ?? []).filter((row) => matches(row, o.where));
			return { rows: rows.slice(0, o.take ?? rows.length), total: rows.length };
		},
		async *scan(r: string, o: { where?: Record<string, unknown> } = {}) {
			yield (data[r] ?? []).filter((row) => matches(row, o.where));
		},
		async insert(r: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${(data[r] ?? []).length + 1}` };
			(data[r] ??= []).push(row);
			return row;
		},
		async update(r: string, id: string, patch: Row) {
			const rows = data[r] ?? [];
			const i = rows.findIndex((row) => String(row._id) === String(id));
			if (i < 0) return null;
			rows[i] = { ...rows[i], ...patch, _id: id };
			return rows[i];
		},
	} as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

function base_store() {
	return memory_store({
		products: [
			{ _id: 'p1', name: 'Bici', codigo: 'B1', existencia: 3, existenciaApartada: 1 },
			{ _id: 'p2', name: 'Casco', codigo: 'C1', existencia: 5 },
		],
		'pos-tickets': [],
		'inventory-movement': [],
		'inventory-stock-quant': [],
		'inventory-internal-location': [{ _id: 'alm', name: 'Almacén', _ref: 'inventory-internal-location-warehouse' }],
	});
}

const layaway_doc = (extra: Row = {}): Row => ({
	ticket_type: 'APARTADO',
	ticket_sequence: 'CAJA-1-9',
	client_id: 'cli-1',
	client_name: 'Ana',
	subtotal: 1000,
	items: [
		{ item_id: 'p1', item_name: 'Bici', quantity: 2, unit_price: 450 },
		{ item_id: 'p2', item_name: 'Casco', quantity: 1, unit_price: 100 },
	],
	payments: [{ method: 'efectivo', amount: 200 }],
	...extra,
});

describe('apartados POS', () => {
	test('valida cliente, anticipo y existencia libre; fija estado abierto', async () => {
		const store = base_store();
		const ok = await prepare_layaway_rules(store, layaway_doc());
		expect(ok).toMatchObject({ total_paid: 200, change: 0, payment_method: 'efectivo', layaway_status: 'abierto' });
		await expect(prepare_layaway_rules(store, layaway_doc({ client_id: '' }))).rejects.toThrow(/cliente/);
		await expect(prepare_layaway_rules(store, layaway_doc({ payments: [] }))).rejects.toThrow(/anticipo mayor a 0/);
		await expect(prepare_layaway_rules(store, layaway_doc({ payments: [{ method: 'efectivo', amount: 1001 }] }))).rejects.toThrow(/no puede pasar/);
		await expect(prepare_layaway_rules(store, layaway_doc({ payments: [{ method: 'credito', amount: 10 }] }))).rejects.toThrow(/no válida/);
		await expect(
			prepare_layaway_rules(store, layaway_doc({ items: [{ item_id: 'p1', item_name: 'Bici', quantity: 3 }] })),
		).rejects.toThrow(/libre 2/);
		const venta = { ticket_type: 'VENTA', subtotal: 5 };
		expect(await prepare_layaway_rules(store, venta)).toBe(venta);
	});

	test('aparta sin sacar existencia; los abonos liquidan y entonces sale del inventario', async () => {
		const store = base_store();
		const layaway = await store.insert('pos-tickets', { ...(await prepare_layaway_rules(store, layaway_doc())), _id: 'ap-1' });
		await register_layaway_effects(store, layaway);
		expect(store.data.products.map((p) => [p.existencia, p.existenciaApartada])).toEqual([[3, 3], [5, 1]]);
		expect(store.data['inventory-movement'].map((m) => m.tipo_movimiento)).toEqual(['apartado_logistica', 'apartado_logistica']);

		const abono = (amount: number, id: string) => ({ _id: id, ticket_type: 'ABONO_APARTADO', original_ticket: 'ap-1', subtotal: amount });
		await expect(prepare_layaway_rules(store, abono(900, 'x'))).rejects.toThrow(/saldo del apartado \(800.00\)/);
		const a1 = await prepare_layaway_rules(store, { ...abono(300, 'ab-1'), payments: [{ method: 'tarjeta', amount: 300 }] });
		expect(a1).toMatchObject({ client_id: 'cli-1', total_paid: 300, payment_method: 'tarjeta', items: [] });
		await store.insert('pos-tickets', a1);
		expect(await register_layaway_effects(store, a1)).toBeNull();
		expect((await layaway_lookup(store, { folio: 'CAJA-1-9' })).saldo).toBe(500);

		const a2 = await prepare_layaway_rules(store, abono(500, 'ab-2'));
		await store.insert('pos-tickets', a2);
		const closed = await register_layaway_effects(store, a2);
		expect(closed?.layaway_status).toBe('liquidado');
		expect(store.data.products.map((p) => [p.existencia, p.existenciaApartada])).toEqual([[1, 1], [4, 0]]);
		expect(store.data['inventory-movement'].map((m) => m.tipo_movimiento)).toEqual([
			'apartado_logistica', 'apartado_logistica', 'liberacion_logistica', 'liberacion_logistica', 'salida_entrega', 'salida_entrega',
		]);
		await expect(prepare_layaway_rules(store, abono(1, 'ab-3'))).rejects.toThrow(/ya está liquidado/);
		const info = await layaway_lookup(store, { id: 'ap-1' });
		expect(info).toMatchObject({ estado: 'liquidado', total: 1000, anticipo: 200, pagado: 1000, saldo: 0 });
		expect(info.abonos).toHaveLength(2);
	});

	test('cancelar libera lo apartado e informa lo que hay que regresar', async () => {
		const store = base_store();
		const layaway = await store.insert('pos-tickets', { ...(await prepare_layaway_rules(store, layaway_doc())), _id: 'ap-1' });
		await register_layaway_effects(store, layaway);
		const result = await cancel_layaway(store, 'ap-1');
		expect(result).toMatchObject({ estado: 'cancelado', por_regresar: 200 });
		expect(store.data.products.map((p) => [p.existencia, p.existenciaApartada])).toEqual([[3, 1], [5, 0]]);
		await expect(cancel_layaway(store, 'ap-1')).rejects.toThrow(/ya está cancelado/);
		await expect(cancel_layaway(store, 'nada')).rejects.toThrow(/no existe/);
	});

	test('corte: del apartado entra el anticipo en efectivo, no cuenta como venta', async () => {
		const at = '2026-10-21T10:00:00.000Z';
		const tickets = [
			{ _id: 'ap', ticket_sequence: '1', ticket_type: 'APARTADO', subtotal: 1000, total_paid: 200, payment_method: 'efectivo', payments: [{ method: 'efectivo', amount: 200 }], layaway_status: 'abierto', createdAt: at, pos_session: 'ses-1' },
			{ _id: 'ab', ticket_sequence: '2', ticket_type: 'ABONO_APARTADO', original_ticket: 'ap', subtotal: 300, payment_method: 'tarjeta', payments: [{ method: 'tarjeta', amount: 300 }], createdAt: at, pos_session: 'ses-1' },
			{ _id: 'v', ticket_sequence: '3', ticket_type: 'VENTA', subtotal: 50, createdAt: at, pos_session: 'ses-1' },
		];
		const store = memory_store({ 'pos-tickets': tickets });
		const report = await build_pos_session_report(store, session, 'VENTAS_PARCIAL', 'Ana', new Date('2026-10-21T12:00:00Z'));
		expect(report.expected_cash).toBe(100 + 200 + 0 + 50);
		expect(report.total_sales).toBe(50);
		expect(report.total_layaway_payments).toBe(500);
		const ap = (report.tickets as Row[]).find((t) => t._id === 'ap');
		expect(ap).toMatchObject({ layaway_status: 'abierto', display_amount: 200, cash_effect: 200 });
	});

	test('el alta de ticket acepta los tipos nuevos y las rutas están declaradas', async () => {
		const store = base_store();
		const created = await prepare_pos_ticket_create(store, { ...layaway_doc(), pos_session: 'ses-1' }, { _id: 'u1' });
		expect(created).toMatchObject({ ticket_type: 'APARTADO', layaway_status: 'abierto' });
		const actions = (extra_routes as { resource: string; method: string; path: string; action: string }[])
			.filter((r) => r.resource === 'pos-tickets')
			.map((r) => `${r.method} ${r.path}:${r.action}`);
		expect(actions).toContain('get /apartado:read_layaway');
		expect(actions).toContain('post /:id/apartado-cancelar:cancel_layaway');
	});
});
