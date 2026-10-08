import { describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const PO = '507f1f77bcf86cd799439011';
const PROD = '507f1f77bcf86cd799439031';

type Row = ImperiumDoc;

function memory_store(): ImperiumStore & { data: Record<string, Row[]> } {
	const data: Record<string, Row[]> = {
		'purchase-order': [
			{
				_id: PO,
				name: 'Compra 1',
				estado: 'aprobada',
				is_active: true,
				articulos: [
					{
						producto: PROD,
						producto_nombre: 'Tornillo',
						cantidad: 10,
						cantidad_recibida: 0,
						costo_unitario: 5,
					},
				],
			},
		],
		products: [
			{
				_id: PROD,
				name: 'Tornillo',
				puedoComprarlo: true,
				existencia: 10,
			},
		],
	};
	const store = {
		data,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch, _id: id };
			return rows[index];
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

function post(store: ImperiumStore, cantidad: unknown) {
	const req = new Request(`http://local/api/purchase-order/${PO}/register-receipt`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			articulos: [{ producto: PROD, cantidad, costo_unitario: 5 }],
		}),
	});
	return handle_action(
		store,
		null as never,
		req,
		new URL(req.url),
		'purchase-order',
		'register_receipt',
		{ id: PO },
		null,
	);
}

async function recibido(store: ImperiumStore & { data: Record<string, Row[]> }) {
	const po = store.data['purchase-order'][0]!;
	const line = (po.articulos as Row[])[0]!;
	const product = store.data.products[0]!;
	return { cantidad_recibida: line.cantidad_recibida, existencia: product.existencia };
}

describe('register-receipt exige cantidad finita mayor a cero', () => {
	test('rechaza cantidad negativa, cero y no numérica sin mover existencia', async () => {
		for (const cantidad of [-3, 0, 'abc', null, Number.POSITIVE_INFINITY]) {
			const store = memory_store();
			await expect(post(store, cantidad)).rejects.toThrow(
				'La cantidad recibida de Tornillo debe ser mayor que cero',
			);
			expect(await recibido(store)).toEqual({ cantidad_recibida: 0, existencia: 10 });
		}
	});

	test('una cantidad positiva recibe y suma existencia', async () => {
		const store = memory_store();
		const res = await post(store, 2);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.message).toBe('Recepción registrada correctamente');
		expect(await recibido(store)).toEqual({ cantidad_recibida: 2, existencia: 12 });
	});
});
