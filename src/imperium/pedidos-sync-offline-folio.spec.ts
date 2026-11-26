import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { pedidos_sync_offline } from './actions.ts';

// Odoo #272: el sync offline descartaba como duplicado cualquier pedido cuyo
// folio de teléfono ya existía, aunque fuera otro pedido (segundo teléfono o
// navegador del mismo vendedor el mismo día), y respondía 200.

const PRODUCTO = '507f1f77bcf86cd799439013';
const PRODUCTO_2 = '507f1f77bcf86cd799439014';
const VENDEDOR = { _id: 'v1', name: 'Vendedor' } as ImperiumDoc;
const OTRO = { _id: 'v2', name: 'Vendedor' } as ImperiumDoc;
const FOLIO = 'Vendedor-2026_11_18-1';

/** Memoria con los únicos de `pedidos` (`offline_uuid`, `folio_offline`) como en BD. */
function memory_store(opts: { carrera?: boolean } = {}) {
	const data: Record<string, ImperiumDoc[]> = {
		products: [
			{ _id: PRODUCTO, name: 'Codo', existencia: 10, costoVenta: 5 },
			{ _id: PRODUCTO_2, name: 'Tee', existencia: 10, costoVenta: 5 },
		],
		pedidos: [],
	};
	let seq = 0;
	let ocultar_folio = Boolean(opts.carrera);
	const matches = (row: ImperiumDoc, where: Record<string, unknown>) =>
		Object.entries(where).every(([k, v]) => row[k] === v);
	const store = {
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			// Carrera: la primera búsqueda por folio no ve la fila que otra
			// petición acaba de escribir; el índice único sí la ve.
			if (ocultar_folio && 'folio_offline' in where) {
				ocultar_folio = false;
				return null;
			}
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async insert(r: string, doc: ImperiumDoc) {
			if (r === 'pedidos') {
				for (const field of ['offline_uuid', 'folio_offline']) {
					const value = doc[field];
					if (value && data.pedidos.some((row) => row[field] === value)) {
						throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
					}
				}
			}
			const row = { ...doc, _id: String(++seq) };
			data[r].push(row);
			return row;
		},
		async next_auto_increment() {
			return ++seq;
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, ImperiumDoc[]> };
}

type Resultado = { status: string; motivo?: string; _id?: string; aviso?: string; error?: string };

async function sync(store: ImperiumStore, actor: ImperiumDoc, pedidos: ImperiumDoc[]) {
	const res = await pedidos_sync_offline({ store, actor, body: { pedidos } } as never);
	const body = (await res.json()) as { ok: boolean; message?: string; resultados: Resultado[] };
	return { status: res.status, ...body };
}

const pedido = (offline_uuid: string, producto = PRODUCTO, cantidad = 1) => ({
	offline_uuid,
	folio: FOLIO,
	contacto: 'c1',
	articulos: [{ product: producto, cantidad, precio: 5 }],
});

describe('sync offline: folio de teléfono repetido (Odoo #272)', () => {
	test('otro teléfono del mismo vendedor con el mismo folio no pierde su pedido', async () => {
		const store = memory_store();
		const a = await sync(store, VENDEDOR, [pedido('tel-a', PRODUCTO, 1)]);
		const b = await sync(store, VENDEDOR, [pedido('tel-b', PRODUCTO_2, 3)]);
		expect(a.resultados[0].status).toBe('creado');
		expect(b.status).toBe(200);
		expect(b.resultados[0].status).toBe('creado');
		expect(b.resultados[0].aviso).toContain('otro pedido');
		expect(store.data.pedidos).toHaveLength(2);
		expect(store.data.pedidos.map((p) => p.folio_offline)).toEqual([FOLIO, `${FOLIO}#tel-b`]);
	});

	test('el mismo pedido reenviado con otro uuid es duplicado real y devuelve su fila', async () => {
		const store = memory_store();
		const a = await sync(store, VENDEDOR, [pedido('tel-a')]);
		const b = await sync(store, VENDEDOR, [pedido('copia-local')]);
		expect(b.status).toBe(200);
		expect(b.resultados[0]).toMatchObject({ status: 'duplicado', motivo: 'folio', _id: a.resultados[0]._id });
		expect(store.data.pedidos).toHaveLength(1);
	});

	test('mismo folio y artículos pero de otro vendedor es otro pedido', async () => {
		const store = memory_store();
		await sync(store, VENDEDOR, [pedido('tel-a')]);
		const b = await sync(store, OTRO, [pedido('tel-b')]);
		expect(b.resultados[0].status).toBe('creado');
		expect(store.data.pedidos).toHaveLength(2);
	});

	test('en un mismo lote, dos pedidos distintos con el mismo folio se crean los dos', async () => {
		const store = memory_store();
		const out = await sync(store, VENDEDOR, [pedido('tel-a', PRODUCTO), pedido('tel-b', PRODUCTO_2)]);
		expect(out.resultados.map((r) => r.status)).toEqual(['creado', 'creado']);
		expect(store.data.pedidos).toHaveLength(2);
	});

	test('si otra petición ganó el folio entre la búsqueda y el alta, se guarda aparte', async () => {
		const store = memory_store({ carrera: true });
		store.data.pedidos.push({ _id: 'x', offline_uuid: 'tel-a', folio_offline: FOLIO, usuario: 'v1', huella_offline: 'otra' });
		const out = await sync(store, VENDEDOR, [pedido('tel-b')]);
		expect(out.resultados[0].status).toBe('creado');
		expect(store.data.pedidos.map((p) => p.folio_offline)).toEqual([FOLIO, `${FOLIO}#tel-b`]);
	});

	test('lo rechazado no responde 200: 422 con mensaje y lo válido del lote sí queda', async () => {
		const store = memory_store();
		const out = await sync(store, VENDEDOR, [{ folio: 'sin-uuid', articulos: [] }, pedido('tel-a')]);
		expect(out.status).toBe(422);
		expect(out.ok).toBe(false);
		expect(out.message).toContain('Falta el identificador local del pedido');
		expect(out.resultados.map((r) => r.status)).toEqual(['error', 'creado']);
		expect(store.data.pedidos).toHaveLength(1);
	});
});
