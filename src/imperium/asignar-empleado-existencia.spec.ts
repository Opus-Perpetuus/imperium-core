import { describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const PEDIDO = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const EMPLEADO = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const FANTASMA = 'dddddddddddddddddddddddd';
const ACTOR = 'cccccccccccccccccccccccc';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>): ImperiumStore {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
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
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch };
			return rows[index];
		},
	} as unknown as ImperiumStore;
}

function store_for(employees: Row[]) {
	return memory_store({
		pedidos: [{ _id: PEDIDO, estado: 'por_surtir', is_active: true }],
		employee: employees,
		'user-group': [
			{
				_id: 'ffffffffffffffffffffffff',
				_ref: 'user-group-almacen',
				user_ids: [ACTOR],
			},
		],
	});
}

function post(store: ImperiumStore, employee_id: string) {
	const req = new Request(`http://local/api/pedidos/${PEDIDO}/asignar-empleado`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ employee_id }),
	});
	return handle_action(
		store,
		null as never,
		req,
		new URL(req.url),
		'pedidos',
		'asignar_empleado',
		{ id: PEDIDO },
		{ _id: ACTOR, name: 'Prueba Almacén' },
	);
}

describe('asignar_empleado exige un empleado real', () => {
	test('un id que no existe no deja el pedido en surtiendo', async () => {
		const store = store_for([{ _id: EMPLEADO, name: 'Surtidor', is_active: true }]);
		await expect(post(store, FANTASMA)).rejects.toThrow('No se encontró el empleado indicado.');
		const saved = await store.find_id('pedidos', PEDIDO);
		expect(saved?.estado).toBe('por_surtir');
		expect(saved?.assigned_employee).toBeUndefined();
	});

	test('un empleado inactivo no se asigna', async () => {
		const store = store_for([{ _id: EMPLEADO, name: 'Baja', is_active: false }]);
		await expect(post(store, EMPLEADO)).rejects.toThrow('El empleado está inactivo.');
		const saved = await store.find_id('pedidos', PEDIDO);
		expect(saved?.estado).toBe('por_surtir');
	});

	test('un empleado activo sí se asigna', async () => {
		const store = store_for([{ _id: EMPLEADO, name: 'Surtidor', is_active: true }]);
		const res = await post(store, EMPLEADO);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.data[0].assigned_employee).toEqual({ _id: EMPLEADO, name: 'Surtidor' });
		expect(body.data[0].estado).toBe('surtiendo');
	});
});
