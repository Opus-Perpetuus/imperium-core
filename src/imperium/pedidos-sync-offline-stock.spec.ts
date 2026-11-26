import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { pedidos_sync_offline } from './actions.ts';
import { list_search_columns } from './list-search.ts';
import { search_index_text } from './search-engine.ts';
import {
	ALLOW_NEGATIVE_STOCK_REF,
	PEDIDOS_OFFLINE_ESTADO_REF,
	faltantes_de_existencia,
	prepare_pedido_update,
} from './pedidos-flow.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const PRODUCTO_2 = '507f1f77bcf86cd799439014';
const ADMIN = { _id: 'admin', _ref: 'user-menu-management-0', name: 'admin' } as ImperiumDoc;

function memory_store(products: ImperiumDoc[], permitir_negativos?: boolean, estado_offline?: unknown) {
	const data: Record<string, ImperiumDoc[]> = { products, pedidos: [] };
	if (permitir_negativos !== undefined || estado_offline !== undefined) data.configuration = [];
	if (permitir_negativos !== undefined) {
		data.configuration.push({ _id: 'c', _ref: ALLOW_NEGATIVE_STOCK_REF, value: permitir_negativos });
	}
	if (estado_offline !== undefined) {
		data.configuration.push({ _id: 'e', _ref: PEDIDOS_OFFLINE_ESTADO_REF, value: estado_offline });
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

	test('en un mismo lote lo ya confirmado se resta del siguiente para el aviso', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }], false);
		const res = await pedidos_sync_offline({
			store,
			actor: ADMIN,
			body: {
				pedidos: [
					{
						offline_uuid: 'u-1',
						folio: 'F-1',
						estado: 'confirmado',
						articulos: [{ product: PRODUCTO, cantidad: 6, precio: 1 }],
					},
					{
						offline_uuid: 'u-2',
						folio: 'F-2',
						estado: 'confirmado',
						articulos: [{ product: PRODUCTO, cantidad: 6, precio: 1 }],
					},
					{
						offline_uuid: 'u-3',
						folio: 'F-3',
						estado: 'confirmado',
						articulos: [{ product: PRODUCTO, cantidad: 4, precio: 1 }],
					},
				],
			},
		} as never);
		const out = (await res.json()) as {
			resultados: Array<{ estado?: string; aviso?: string }>;
		};
		expect(out.resultados.map((r) => r.estado)).toEqual(['confirmado', 'confirmado', 'confirmado']);
		expect(out.resultados[0].aviso).toBeUndefined();
		expect(out.resultados[1].aviso).toContain('Codo (pide 6, hay 4)');
		expect(out.resultados[2].aviso).toContain('Codo (pide 4,');
		expect(store.data.pedidos.map((p) => p.estado)).toEqual(['confirmado', 'confirmado', 'confirmado']);
	});

	test('sin existencia llega confirmado con aviso', async () => {
		const store = memory_store(
			[
				{ _id: PRODUCTO, name: 'Codo', existencia: 2 },
				{ _id: PRODUCTO_2, name: 'Tubo', existencia: 50 },
			],
			false,
		);
		const out = await sync(store, [
			{ product: PRODUCTO, cantidad: 5, precio: 1 },
			{ product: PRODUCTO_2, cantidad: 1, precio: 1 },
		]);
		expect(out.resultados[0]).toMatchObject({ status: 'creado', estado: 'confirmado' });
		expect(out.resultados[0].aviso).toBe('El pedido F-1 se confirmó sin existencia suficiente: Codo (pide 5, hay 2).');
		expect(out.avisos).toHaveLength(1);
		expect(store.data.pedidos[0].estado).toBe('confirmado');
	});

	test('sin precio llega confirmado con aviso en vez de fallar', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }]);
		const out = await sync(store, [{ product: PRODUCTO, cantidad: 1, precio: 0 }]);
		expect(out.resultados[0]).toMatchObject({ status: 'creado', estado: 'confirmado' });
		expect(out.resultados[0].aviso).toBe('El pedido F-1 se confirmó sin precio en: Codo.');
		expect(store.data.pedidos[0].estado).toBe('confirmado');
	});
});

describe('estado de los pedidos sincronizados (parámetro, Odoo #262)', () => {
	test('con el parámetro en borrador llegan en borrador, sin revisar existencia', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 0 }], undefined, 'borrador');
		const out = await sync(store, [{ product: PRODUCTO, cantidad: 5, precio: 1 }]);
		expect(out.resultados[0]).toMatchObject({ status: 'creado', estado: 'borrador' });
		expect(out.resultados[0].aviso).toBeUndefined();
		expect(store.data.pedidos[0].estado).toBe('borrador');
	});

	test('el estado lo decide el servidor, no el que manda el teléfono', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }], undefined, 'borrador');
		const res = await pedidos_sync_offline({
			store,
			actor: ADMIN,
			body: { pedidos: [{ offline_uuid: 'u-9', folio: 'F-9', estado: 'surtido', articulos: [] }] },
		} as never);
		const out = (await res.json()) as { resultados: Array<{ estado?: string }> };
		expect(out.resultados[0].estado).toBe('borrador');
	});

	test('el pedido sincronizado llega con fecha (Odoo #267)', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }]);
		await sync(store, [{ product: PRODUCTO, cantidad: 1, precio: 1 }]);
		const fecha = String(store.data.pedidos[0].fecha ?? '');
		expect(Number.isNaN(new Date(fecha).getTime())).toBe(false);
	});

	test('un valor que no es un estado permitido usa confirmado', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }], undefined, 'surtido');
		const out = await sync(store, [{ product: PRODUCTO, cantidad: 1, precio: 1 }]);
		expect(out.resultados[0].estado).toBe('confirmado');
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

	test('con el interruptor en NO explícito, offline sin existencia llega confirmado con aviso', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 0 }], false);
		const out = await sync(store, [{ product: PRODUCTO, cantidad: 5, precio: 1 }]);
		expect(out.resultados[0].estado).toBe('confirmado');
		expect(out.resultados[0].aviso).toContain('Codo (pide 5, hay 0)');
	});

	const previo = (articulos: ImperiumDoc[]) =>
		({ _id: 'p1', estado: 'surtiendo', articulos }) as ImperiumDoc;

	test('sin el parámetro permite surtir aunque quede negativa', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 3 }]);
		const articulos = [{ product: PRODUCTO, cantidad: 5, precio: 1 }];
		const out = await prepare_pedido_update(store, { estado: 'surtido', articulos }, ADMIN, previo(articulos));
		expect(out.estado).toBe('surtido');
	});

	test('con el parámetro en NO bloquea surtir si la existencia quedaría negativa', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 3 }], false);
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

describe('sync offline de pedidos: contacto como referencia (#264)', () => {
	const CONTACTO = '62dedd2044431c7c0c020039';
	async function sync_contacto(contacto: unknown) {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }]);
		await pedidos_sync_offline({
			store,
			actor: ADMIN,
			body: {
				pedidos: [
					{
						offline_uuid: 'u-1',
						folio: 'F-1',
						estado: 'confirmado',
						contacto,
						articulos: [{ product: PRODUCTO, cantidad: 1, precio: 1 }],
					},
				],
			},
		} as never);
		return store.data.pedidos[0];
	}

	test('el contacto completo del celular se guarda como su id, no como JSON', async () => {
		const pedido = await sync_contacto({ _id: CONTACTO, name: 'ALVAREZ GONZALEZ MARIA', rfc: 'XAXX010101000' });
		expect(pedido.contacto).toBe(CONTACTO);
	});

	test('el contacto que ya llega como id se guarda igual', async () => {
		const pedido = await sync_contacto(CONTACTO);
		expect(pedido.contacto).toBe(CONTACTO);
	});

	test('el pedido sincronizado se encuentra buscando el nombre del contacto (SQL y Meilisearch)', async () => {
		const store = memory_store([{ _id: PRODUCTO, name: 'Codo', existencia: 10 }]);
		store.data.contacto = [{ _id: CONTACTO, name: 'ALVAREZ GONZALEZ MARIA', codigo: '1050094' }];
		await pedidos_sync_offline({
			store,
			actor: ADMIN,
			body: {
				pedidos: [
					{
						offline_uuid: 'u-1',
						folio: 'F-1',
						estado: 'confirmado',
						contacto: { _id: CONTACTO, name: 'ALVAREZ GONZALEZ MARIA' },
						articulos: [{ product: PRODUCTO, cantidad: 1, precio: 1 }],
					},
				],
			},
		} as never);
		const pedido = store.data.pedidos[0];
		expect(pedido.contacto).toBe(CONTACTO);
		// La lista de pedidos busca con ILIKE en search_field (pg_trgm)…
		expect(list_search_columns('pedidos', new Set(['name', 'search_field', 'contacto']))).toContain(
			'search_field',
		);
		expect(String(pedido.search_field)).toContain('ALVAREZ GONZALEZ MARIA');
		// …y Meilisearch indexa search_index_text, que lleva el search_field.
		expect(search_index_text(pedido)).toContain('ALVAREZ GONZALEZ MARIA');
	});
});
