import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { pedidos_sync_offline } from './actions.ts';
import {
	ALLOW_NEGATIVE_STOCK_REF,
	faltantes_de_existencia,
	prepare_pedido_update,
} from './pedidos-flow.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const PRODUCTO_2 = '507f1f77bcf86cd799439014';
const ADMIN = { _id: 'admin', _ref: 'user-menu-management-0', name: 'admin' } as ImperiumDoc;

function memory_store(products: ImperiumDoc[], permitir_negativos?: boolean) {
	const data: Record<string, ImperiumDoc[]> = { products, pedidos: [] };
	if (permitir_negativos !== undefined) {
		data.configuration = [{ _id: 'c', _ref: ALLOW_NEGATIVE_STOCK_REF, value: permitir_negativos }];
	}
	let seq = 0;
	const matches = (row: ImperiumDoc, where: Record<string, unknown>) =>
		Object.entries(where).every(([k, v]) => row[k] === v);
	const store = {
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async insert(r: string, doc: ImperiumDoc) {
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

async function sync(store: ImperiumStore, articulos: ImperiumDoc[]) {
	const res = await pedidos_sync_offline({
		store,
		actor: ADMIN,
		body: {
			pedidos: [{ offline_uuid: 'u-1', folio: 'F-1', estado: 'confirmado', articulos }],
		},
	} as never);
	return (await res.json()) as {
		resultados: Array<{ status: string; estado?: string; aviso?: string }>;
		avisos?: string[];
	};
}

describe('sync offline de pedidos con existencia', () => {
	test('con existencia suficiente queda confirmado y sin aviso', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }]);
		const out = await sync(store, [{ product: PRODUCTO, cantidad: 4, precio: 1 }]);
		expect(out.resultados[0]).toMatchObject({ status: 'creado', estado: 'confirmado' });
		expect(out.resultados[0].aviso).toBeUndefined();
		expect(out.avisos).toBeUndefined();
		expect(store.data.pedidos[0].estado).toBe('confirmado');
	});

	test('sin existencia queda en borrador (pendiente) con aviso', async () => {
		const store = memory_store([
			{ _id: PRODUCTO, name: 'Codo', existencia: 2 },
			{ _id: PRODUCTO_2, name: 'Tubo', existencia: 50 },
		]);
		const out = await sync(store, [
			{ product: PRODUCTO, cantidad: 5, precio: 1 },
			{ product: PRODUCTO_2, cantidad: 1, precio: 1 },
		]);
		expect(out.resultados[0]).toMatchObject({ status: 'creado', estado: 'borrador' });
		expect(out.resultados[0].aviso).toContain('Codo (pide 5, hay 2)');
		expect(out.resultados[0].aviso).not.toContain('Tubo');
		expect(out.avisos).toHaveLength(1);
		expect(store.data.pedidos[0].estado).toBe('borrador');
	});

	test('cuenta lo apartado y suma renglones del mismo producto', async () => {
		const store = memory_store([
			{ _id: PRODUCTO, name: 'Codo', existencia: 10, existenciaApartada: 4 },
		]);
		const faltan = await faltantes_de_existencia(store, [
			{ product: PRODUCTO, cantidad: 4 },
			{ product: PRODUCTO, cantidad: 3 },
		]);
		expect(faltan).toEqual([
			{ product_id: PRODUCTO, nombre: 'Codo', requerido: 7, disponible: 6 },
		]);
	});

	test('producto inexistente cuenta como sin existencia', async () => {
		const store = memory_store([]);
		const faltan = await faltantes_de_existencia(store, [{ product: 'x', cantidad: 1 }]);
		expect(faltan[0]).toMatchObject({ requerido: 1, disponible: 0 });
	});
});

describe('permitir existencia negativa (configurable)', () => {
	test('con el interruptor en SÍ, offline sin existencia se confirma como antes', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 0 }], true);
		const out = await sync(store, [{ product: PRODUCTO, cantidad: 5, precio: 1 }]);
		expect(out.resultados[0]).toMatchObject({ status: 'creado', estado: 'confirmado' });
		expect(out.avisos).toBeUndefined();
	});

	test('con el interruptor en NO explícito, offline sin existencia queda en borrador', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 0 }], false);
		const out = await sync(store, [{ product: PRODUCTO, cantidad: 5, precio: 1 }]);
		expect(out.resultados[0].estado).toBe('borrador');
	});

	const previo = (articulos: ImperiumDoc[]) =>
		({ _id: 'p1', estado: 'surtiendo', articulos }) as ImperiumDoc;

	test('por defecto bloquea surtir si la existencia quedaría negativa', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 3 }]);
		const articulos = [{ product: PRODUCTO, cantidad: 5, precio: 1 }];
		await expect(
			prepare_pedido_update(store, { estado: 'surtido', articulos }, ADMIN, previo(articulos)),
		).rejects.toThrow('existencia quedaría negativa');
	});

	test('surtir usa lo capturado en cantidad_surtida', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 3 }]);
		const articulos = [{ product: PRODUCTO, cantidad: 5, cantidad_surtida: 3, precio: 1 }];
		const out = await prepare_pedido_update(
			store,
			{ estado: 'surtido', articulos },
			ADMIN,
			previo(articulos),
		);
		expect(out.estado).toBe('surtido');
	});

	test('con el interruptor en SÍ permite surtir aunque quede negativa', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 3 }], true);
		const articulos = [{ product: PRODUCTO, cantidad: 5, precio: 1 }];
		const out = await prepare_pedido_update(
			store,
			{ estado: 'surtido', articulos },
			ADMIN,
			previo(articulos),
		);
		expect(out.estado).toBe('surtido');
	});
});
