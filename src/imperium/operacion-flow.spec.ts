import { describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const PEDIDO = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const EMPLEADO = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OTRO = 'eeeeeeeeeeeeeeeeeeeeeeee';
const ACTOR = 'cccccccccccccccccccccccc';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>): ImperiumStore {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => {
			if (value && typeof value === 'object' && 'in' in (value as object)) {
				const list = (value as { in: unknown[] }).in.map((item) => String(item));
				return list.includes(String(row[key] ?? ''));
			}
			return row[key] === value;
		});
	};
	return {
		data,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async *scan(resource: string) {
			yield data[resource] ?? [];
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_many(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			const rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			return { rows };
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch };
			return rows[index];
		},
	} as unknown as ImperiumStore;
}

function actor(group_ref: string) {
	return {
		_id: ACTOR,
		name: 'Prueba Almacén',
		employee: EMPLEADO,
		groups: group_ref,
	};
}

function store_for(estado: string, assigned = '') {
	return memory_store({
		pedidos: [
			{
				_id: PEDIDO,
				estado,
				assigned_employee: assigned,
				is_active: true,
			},
		],
		employee: [{ _id: EMPLEADO, name: 'Surtidor Prueba' }],
		'user-group': [
			{
				_id: 'ffffffffffffffffffffffff',
				_ref: 'user-group-almacen',
				user_ids: [ACTOR],
			},
		],
	});
}

async function post_asignar(
	store: ImperiumStore,
	body: Record<string, unknown>,
	who: ImperiumDoc | null = actor('user-group-almacen'),
	id = PEDIDO,
) {
	const req = new Request(`http://local/api/pedidos/${id}/asignar-empleado`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return handle_action(
		store,
		null as never,
		req,
		new URL(req.url),
		'pedidos',
		'asignar_empleado',
		{ id },
		who,
	);
}

describe('POST /pedidos/:id/asignar-empleado', () => {
	test('almacén pasa por_surtir a surtiendo y devuelve el nombre', async () => {
		const store = store_for('por_surtir');
		const res = await post_asignar(store, { employee_id: EMPLEADO });
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.message).toBe('Pedido asignado para surtir');
		expect(body.data[0].estado).toBe('surtiendo');
		expect(body.data[0].assigned_employee).toEqual({
			_id: EMPLEADO,
			name: 'Surtidor Prueba',
		});
		expect(body.data[0].init_time).toBeTruthy();
		const saved = await store.find_id('pedidos', PEDIDO);
		expect(saved?.estado).toBe('surtiendo');
		expect(saved?.assigned_employee).toBe(EMPLEADO);
	});

	test('acepta assigned_employee como objeto', async () => {
		const store = store_for('por_surtir');
		const res = await post_asignar(store, { assigned_employee: { _id: EMPLEADO } });
		const body = await res.json();
		expect(body.data[0].estado).toBe('surtiendo');
		expect(body.data[0].assigned_employee._id).toBe(EMPLEADO);
	});

	test('rechaza a quien no es almacén', async () => {
		const store = memory_store({
			pedidos: [{ _id: PEDIDO, estado: 'por_surtir' }],
			employee: [{ _id: EMPLEADO, name: 'Surtidor Prueba' }],
			'user-group': [
				{
					_id: 'ffffffffffffffffffffffff',
					_ref: 'user-group-vendedores',
					user_ids: [ACTOR],
				},
			],
		});
		await expect(post_asignar(store, { employee_id: EMPLEADO })).rejects.toThrow(
			/No tienes permiso para asignar/,
		);
	});

	test('rechaza empleado y pedido inválidos', async () => {
		const store = store_for('por_surtir');
		await expect(post_asignar(store, { employee_id: 'no' })).rejects.toThrow(
			'Empleado no válido.',
		);
		await expect(
			post_asignar(store, { employee_id: EMPLEADO }, actor('user-group-almacen'), 'x'),
		).rejects.toThrow('Identificador de pedido no válido.');
	});

	test('no reasigna un surtiendo de otro empleado', async () => {
		const store = store_for('surtiendo', OTRO);
		await expect(post_asignar(store, { employee_id: EMPLEADO })).rejects.toThrow(
			/ya lo está surtiendo otro empleado/,
		);
	});

	test('por_surtir ya asignado a otro no se pisa', async () => {
		const store = store_for('por_surtir', OTRO);
		await expect(post_asignar(store, { employee_id: EMPLEADO })).rejects.toThrow(
			/ya está asignado a otro empleado/,
		);
	});

	test('surtiendo del mismo empleado no cambia el inicio', async () => {
		const store = store_for('surtiendo', EMPLEADO);
		const before = await store.find_id('pedidos', PEDIDO);
		await store.update('pedidos', PEDIDO, { init_time: '2026-09-27T00:00:00.000Z' });
		const res = await post_asignar(store, { employee_id: EMPLEADO });
		const body = await res.json();
		expect(body.message).toBe('Pedido ya asignado');
		expect(body.data[0].init_time).toBe('2026-09-27T00:00:00.000Z');
		expect(before?.estado).toBe('surtiendo');
	});

	test('un confirmado no se asigna', async () => {
		const store = store_for('confirmado');
		await expect(post_asignar(store, { employee_id: EMPLEADO })).rejects.toThrow(
			/no está disponible para asignar/,
		);
	});
});

describe('delivery-package depart', () => {
	test('el núcleo no aplica la salida a ruta', async () => {
		const store = memory_store({
			'delivery-package': [
				{
					_id: 'dddddddddddddddddddddddd',
					estado: 'cargado',
					is_active: true,
					logistics_events: [],
				},
			],
		});
		const req = new Request(
			'http://local/api/delivery-package/dddddddddddddddddddddddd/logistics-event',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ event_type: 'depart', event_id: 'evt-depart' }),
			},
		);
		await expect(
			handle_action(
				store,
				null as never,
				req,
				new URL(req.url),
				'delivery-package',
				'apply_logistics_event',
				{ id: 'dddddddddddddddddddddddd' },
				actor('user-group-choferes'),
			),
		).rejects.toThrow(/no es válido/);
		const saved = await store.find_id('delivery-package', 'dddddddddddddddddddddddd');
		expect(saved?.estado).toBe('cargado');
	});
});
