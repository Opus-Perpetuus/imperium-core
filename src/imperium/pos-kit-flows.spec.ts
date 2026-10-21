import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { register_pos_ticket_exit } from './inventory-exit.ts';
import { clients_aging } from './pos-credit.ts';
import {
	layaway_lookup,
	prepare_layaway_rules,
	register_layaway_effects,
	release_layaway_on_cancel,
} from './pos-layaway.ts';
import { assert_return_within_sale, register_pos_return_entry, revert_pos_return_entry } from './pos-return.ts';
import { register_pos_reprint } from './pos-reprint.ts';
import { prepare_pos_return } from './pos-return.ts';
import { client_store_credit, prepare_store_credit_sale } from './pos-store-credit.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = seed;
	let seq = 0;
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([k, v]) =>
			v && typeof v === 'object' && 'in' in (v as object)
				? ((v as { in: unknown[] }).in ?? []).includes(row[k])
				: row[k] === v,
		);
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
			const row = { createdAt: new Date(Date.UTC(2026, 9, 21, 12, 0, seq)).toISOString(), ...doc, _id: doc._id ?? `${r}-${++seq}` };
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
		async next_auto_increment() {
			return (data['pos-tickets'] ?? []).reduce((m, t) => Math.max(m, Number(t.remision_numero ?? 0)), 0) + 1;
		},
	} as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

const kit = { _id: 'kit', name: 'Kit baño', existencia: 0, kit_componentes: [{ producto: 'codo', cantidad: 2 }, { producto: 'tubo', cantidad: 1 }] };

function base_store() {
	return memory_store({
		products: [kit, { _id: 'codo', name: 'Codo', existencia: 10 }, { _id: 'tubo', name: 'Tubo', existencia: 5 }],
		'inventory-movement': [],
		'pos-tickets': [],
	});
}

const product = (s: ImperiumStore & { data: Record<string, Row[]> }, id: string) =>
	s.data.products.find((p) => p._id === id)!;

describe('kits en devoluciones y apartados', () => {
	test('devolver un kit reingresa sus componentes; cancelar la devolución lo revierte', async () => {
		const s = base_store();
		const sale = await s.insert('pos-tickets', { ticket_type: 'VENTA', ticket_sequence: 'V1', items: [{ item_id: 'kit', quantity: 2, unit_price: 50 }] });
		await register_pos_ticket_exit(s, sale);
		expect(product(s, 'codo').existencia).toBe(6);
		expect(product(s, 'tubo').existencia).toBe(3);
		const ret = await s.insert('pos-tickets', { ticket_type: 'DEVOLUCION', original_ticket: sale._id, items: [{ item_id: 'kit', quantity: 1 }], restock_mode: 'auto' });
		const result = await register_pos_return_entry(s, ret);
		expect(result.map((r) => [r.producto, r.reingresado])).toEqual([['codo', 2], ['tubo', 1]]);
		expect(product(s, 'codo').existencia).toBe(8);
		expect(product(s, 'tubo').existencia).toBe(4);
		expect(await revert_pos_return_entry(s, ret)).toBe(2);
		expect(await revert_pos_return_entry(s, ret)).toBe(0);
		expect(product(s, 'codo').existencia).toBe(6);
		expect(product(s, 'tubo').existencia).toBe(3);
	});

	test('apartar un kit valida y aparta componentes; liquidar crea la venta y saca componentes', async () => {
		const s = base_store();
		const doc = { ticket_type: 'APARTADO', ticket_sequence: 'A1', client_id: 'c1', subtotal: 100, items: [{ item_id: 'kit', quantity: 6 }], payments: [{ method: 'efectivo', amount: 20 }] };
		await expect(prepare_layaway_rules(s, doc)).rejects.toThrow(/Codo \(libre 10\)/);
		const ok_doc = await prepare_layaway_rules(s, { ...doc, items: [{ item_id: 'kit', quantity: 2 }] });
		const layaway = await s.insert('pos-tickets', ok_doc);
		await register_layaway_effects(s, layaway);
		expect(product(s, 'codo').existenciaApartada).toBe(4);
		expect(product(s, 'tubo').existenciaApartada).toBe(2);
		expect(product(s, 'kit').existenciaApartada).toBeUndefined();
		// La receta del kit cambia: se libera lo que realmente se apartó.
		product(s, 'kit').kit_componentes = [{ producto: 'codo', cantidad: 1 }];
		const abono = await s.insert('pos-tickets', { ticket_type: 'ABONO_APARTADO', original_ticket: layaway._id, subtotal: 80, pos_session: 'S2' });
		await register_layaway_effects(s, abono);
		expect(product(s, 'codo').existenciaApartada).toBe(0);
		expect(product(s, 'tubo').existenciaApartada).toBe(0);
		const sale = s.data['pos-tickets'].find((t) => t.ticket_type === 'VENTA')!;
		expect(sale).toMatchObject({ ticket_sequence: 'A1-V', subtotal: 100, payment_method: 'apartado', pos_session: 'S2', original_ticket: layaway._id });
		const exits = s.data['inventory-movement'].filter((m) => m.tipo_movimiento === 'salida_entrega');
		expect(exits.every((m) => m.documento_id === sale._id)).toBe(true);
		expect((await layaway_lookup(s, { id: String(layaway._id) })).venta).toBe('A1-V');
	});

	test('cancelar un apartado abierto por el CRUD libera lo apartado una sola vez', async () => {
		const s = base_store();
		const layaway = await s.insert('pos-tickets', await prepare_layaway_rules(s, { ticket_type: 'APARTADO', ticket_sequence: 'A2', client_id: 'c1', subtotal: 50, items: [{ item_id: 'codo', quantity: 3 }], payments: [{ method: 'efectivo', amount: 10 }] }));
		await register_layaway_effects(s, layaway);
		expect(product(s, 'codo').existenciaApartada).toBe(3);
		const previous = { ...layaway };
		const current = await s.update('pos-tickets', String(layaway._id), { state: 'cancelado' });
		expect(await release_layaway_on_cancel(s, previous, current)).toBe(true);
		expect(product(s, 'codo').existenciaApartada).toBe(0);
		expect(s.data['pos-tickets'][0].layaway_status).toBe('cancelado');
		// Una edición que no cancela no libera.
		expect(await release_layaway_on_cancel(s, { ...previous, _id: 'x' }, { ...previous, _id: 'x', client_name: 'Otro' })).toBe(false);
	});

	test('dos devoluciones simultáneas: la posterior que excede se cancela', async () => {
		const s = base_store();
		const sale = await s.insert('pos-tickets', { ticket_type: 'VENTA', items: [{ item_id: 'codo', quantity: 2 }] });
		const r1 = await s.insert('pos-tickets', { ticket_type: 'DEVOLUCION', original_ticket: sale._id, items: [{ item_id: 'codo', quantity: 2 }] });
		const r2 = await s.insert('pos-tickets', { ticket_type: 'DEVOLUCION', original_ticket: sale._id, items: [{ item_id: 'codo', quantity: 1 }] });
		await assert_return_within_sale(s, r1);
		await expect(assert_return_within_sale(s, r2)).rejects.toThrow(/al mismo tiempo/);
		expect(s.data['pos-tickets'].find((t) => t._id === r2._id)).toMatchObject({ state: 'cancelado', is_active: false });
	});
});

describe('reimpresión y remisión', () => {
	test('remisión con consecutivo propio; reimpresiones marcan copia y quién', async () => {
		const s = memory_store({ 'pos-tickets': [{ _id: 't1', ticket_sequence: 'V9', items: '[]' }, { _id: 't2', ticket_sequence: 'V10', items: [] }] });
		const actor = { _id: 'u1', name: 'Ana' };
		const first = await register_pos_reprint(s, { folio: 'V9', tipo: 'remision' }, actor);
		expect(first).toMatchObject({ remision_folio: 'REM-000001', copia: false });
		const again = await register_pos_reprint(s, { id: 't1', tipo: 'remision' }, actor);
		expect(again).toMatchObject({ remision_folio: 'REM-000001', copia: true });
		expect((await register_pos_reprint(s, { id: 't2', tipo: 'remision' }, null)).remision_folio).toBe('REM-000002');
		const ticket = await register_pos_reprint(s, { id: 't1', tipo: 'ticket' }, actor);
		expect(ticket.copia).toBe(true);
		expect((ticket.reprint_log as Row[]).map((e) => [e.tipo, e.copia, e.usuario])).toEqual([
			['remision', false, 'Ana'],
			['remision', true, 'Ana'],
			['ticket', true, 'Ana'],
		]);
		await expect(register_pos_reprint(s, { id: 't1', tipo: 'otra' }, actor)).rejects.toThrow(/tipo/);
	});
});

describe('antigüedad de clientes paginada', () => {
	test('sin parámetros todos; con por_pagina una página y los totales de todos', async () => {
		const tickets = ['a', 'b', 'c'].map((c, i) => ({
			_id: `t${i}`,
			ticket_type: 'VENTA',
			client_id: c,
			client_name: c.toUpperCase(),
			subtotal: 100 * (i + 1),
			payments: [{ method: 'credito', amount: 100 * (i + 1) }],
			payment_method: 'credito',
			createdAt: '2026-10-01T12:00:00.000Z',
		}));
		const s = memory_store({ 'pos-tickets': tickets });
		const all = await clients_aging(s, '2026-10-21');
		expect(all.clientes.length).toBe(3);
		expect(all.pagina).toBeUndefined();
		const page = await clients_aging(s, '2026-10-21', { pagina: 2, por_pagina: 2 });
		expect(page.clientes.map((c) => c.cliente_id)).toEqual(['a']);
		expect(page).toMatchObject({ pagina: 2, por_pagina: 2, total_clientes: 3, saldo: all.saldo });
	});
});

describe('saldo a favor', () => {
	test('devolución a saldo a favor no saca efectivo y se gasta en otra venta hasta el saldo', async () => {
		const s = memory_store({
			products: [],
			'pos-tickets': [{ _id: 'v1', ticket_type: 'VENTA', client_id: 'c1', items: [{ item_id: 'codo', quantity: 3, unit_price: 10 }] }],
		});
		const ret = await prepare_pos_return(s, { ticket_type: 'DEVOLUCION', original_ticket: 'v1', refund_method: 'saldo_favor', items: [{ item_id: 'codo', quantity: 2 }] });
		expect(ret.payments).toEqual([{ method: 'saldo_favor', amount: 20 }]);
		expect(ret.subtotal).toBe(-20);
		expect('refund_method' in ret).toBe(false);
		await s.insert('pos-tickets', ret);
		expect(await client_store_credit(s, 'c1')).toBe(20);
		const sale = { ticket_type: 'VENTA', client_id: 'c1', subtotal: 30, payments: [{ method: 'saldo_favor', amount: 25 }, { method: 'efectivo', amount: 5 }] };
		await expect(prepare_store_credit_sale(s, sale)).rejects.toThrow(/insuficiente: disponible 20.00/);
		await expect(prepare_store_credit_sale(s, { ...sale, client_id: '' })).rejects.toThrow(/cliente/);
		const ok_sale = { ...sale, payments: [{ method: 'saldo_favor', amount: 15 }, { method: 'efectivo', amount: 15 }] };
		expect(await prepare_store_credit_sale(s, ok_sale)).toBe(ok_sale);
		await s.insert('pos-tickets', ok_sale);
		expect(await client_store_credit(s, 'c1')).toBe(5);
	});

	test('sin cliente no se puede devolver a saldo a favor', async () => {
		const s = memory_store({ products: [], 'pos-tickets': [{ _id: 'v1', ticket_type: 'VENTA', items: [{ item_id: 'codo', quantity: 1, unit_price: 10 }] }] });
		await expect(
			prepare_pos_return(s, { ticket_type: 'DEVOLUCION', original_ticket: 'v1', refund_method: 'saldo_favor', items: [{ item_id: 'codo', quantity: 1 }] }),
		).rejects.toThrow(/requiere un cliente/);
	});
});

describe('lotes en la salida POS', () => {
	test('salen por caducidad (FEFO) y el movimiento guarda el rastro de lotes', async () => {
		const quant = (lote: string, fecha: string, cantidad: number) => ({
			_id: `q-${lote}`,
			producto: 'codo',
			ubicacion: 'L1',
			ubicacion_codigo: 'L1',
			lote,
			lote_codigo: lote,
			fecha_caducidad: fecha,
			cantidad,
		});
		const s = memory_store({
			products: [{ _id: 'codo', name: 'Codo', existencia: 6 }],
			'inventory-movement': [],
			'inventory-stock-quant': [quant('A', '2026-12-01', 3), quant('B', '2026-11-01', 3)],
			'inventory-internal-location': [{ _id: 'L1', codigo: 'L1' }],
		});
		await register_pos_ticket_exit(s, { _id: 'v1', ticket_type: 'VENTA', items: [{ item_id: 'codo', quantity: 4 }] });
		const left = Object.fromEntries(s.data['inventory-stock-quant'].map((q) => [q.lote, q.cantidad]));
		expect(left).toEqual({ A: 2, B: 0 });
		const mov = s.data['inventory-movement'][0];
		expect(mov.lote_codigo).toBe('B, A');
		expect(String(mov.description)).toContain('Lotes: B (3), A (1)');
		await register_pos_ticket_exit(s, { _id: 'v2', ticket_type: 'VENTA', items: [{ item_id: 'codo', quantity: 1 }] });
		expect(s.data['inventory-movement'][1]).toMatchObject({ lote: 'A', lote_codigo: 'A', fecha_caducidad: '2026-12-01' });
	});
});
