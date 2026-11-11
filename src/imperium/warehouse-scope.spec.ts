import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { pedidos_sync_offline, read_offline_stock } from './actions.ts';
import { assert_pos_ticket_stock, register_pos_ticket_exit } from './inventory-exit.ts';
import { register_package_delivery_exit } from './inventory-logistics-flow.ts';
import { register_internal_transfer } from './inventory-reception-flow.ts';
import { ALLOW_NEGATIVE_STOCK_REF } from './negative-stock.ts';
import {
	after_pedido_mutate,
	assert_surtido_sin_negativos,
	prepare_pedido_create,
	prepare_pedido_update,
	register_order_fulfillment_exit,
} from './pedidos-flow.ts';
import { cancel_layaway, prepare_layaway_rules, register_layaway_effects } from './pos-layaway.ts';
import { scope_stock, pos_ticket_warehouse_id, scope_stock_snapshot, warehouse_scope } from './warehouse-scope.ts';

const PRODUCTO = '507f1f77bcf86cd799439013';
const GENERAL = '507f1f77bcf86cd799439021';
const ALM_CENTRO = '507f1f77bcf86cd799439022';
const ALM_CENTRO_A1 = '507f1f77bcf86cd799439023';
const ALM_CENTRO_A2 = '507f1f77bcf86cd799439024';
const ALM_RUTA = '507f1f77bcf86cd799439025';
const CLIENTE = '507f1f77bcf86cd799439026';
const SUC_CENTRO = '507f1f77bcf86cd799439031';
const SUC_NORTE = '507f1f77bcf86cd799439032';
const SESION_CENTRO = '507f1f77bcf86cd799439041';
const SESION_NORTE = '507f1f77bcf86cd799439042';
const VENDEDOR = '507f1f77bcf86cd799439051';
const CAJERO = '507f1f77bcf86cd799439052';
const PEDIDO = '507f1f77bcf86cd799439061';
const BULTO = '507f1f77bcf86cd799439071';
const ADMIN = { _id: 'admin', _ref: 'user-menu-management-0', name: 'admin' } as ImperiumDoc;

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	let seq = 0;
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([key, value]) => {
			if (value && typeof value === 'object' && 'in' in value) {
				return (value as { in: unknown[] }).in.includes(row[key]);
			}
			return row[key] === value;
		});
	const store = {
		data,
		has: (resource: string) => Object.hasOwn(data, resource),
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			return (data[resource] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(
			resource: string,
			opts: { where?: Record<string, unknown>; take?: number; ids?: string[] } = {},
		) {
			const rows = (data[resource] ?? []).filter(
				(row) => matches(row, opts.where) && (!opts.ids || opts.ids.includes(String(row._id))),
			);
			return { rows: rows.slice(0, opts.take ?? rows.length), total: rows.length };
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async insert(resource: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${++seq}` };
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch, _id: id };
			return rows[index];
		},
		async next_auto_increment() {
			return ++seq;
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

const ubicaciones: Row[] = [
	{
		_id: GENERAL,
		codigo: 'GEN',
		name: 'Almacén general',
		tipo: 'almacen',
		permite_almacenaje: true,
		_ref: 'inventory-internal-location-warehouse',
	},
	{
		_id: ALM_CENTRO,
		codigo: 'CEN',
		name: 'Almacén Centro',
		tipo: 'almacen',
		nivel: 0,
		permite_almacenaje: false,
		sucursal: SUC_CENTRO,
	},
	{
		_id: ALM_CENTRO_A1,
		codigo: 'CEN-A1',
		name: 'Anaquel 1',
		tipo: 'almacen',
		nivel: 1,
		parent: ALM_CENTRO,
		permite_almacenaje: true,
		secuencia_surtido: 1,
	},
	{
		_id: ALM_CENTRO_A2,
		codigo: 'CEN-A2',
		name: 'Anaquel 2',
		tipo: 'almacen',
		nivel: 1,
		parent: ALM_CENTRO,
		permite_almacenaje: true,
		secuencia_surtido: 2,
	},
	{ _id: ALM_RUTA, codigo: 'RUT', name: 'Camioneta ruta 1', tipo: 'almacen', permite_almacenaje: true },
	{ _id: CLIENTE, codigo: 'CLI', tipo: 'cliente', _ref: 'inventory-internal-location-customer' },
];

function quant(ubicacion: string, cantidad: number): Row {
	const codigo = String(ubicaciones.find((u) => u._id === ubicacion)?.codigo ?? '');
	return {
		_id: `q-${ubicacion}`,
		producto: PRODUCTO,
		ubicacion,
		ubicacion_codigo: codigo,
		cantidad,
		cantidad_apartada: 0,
		cantidad_disponible: cantidad,
	};
}

function store_con(quants: Row[], opts: { existencia?: number; negativos?: boolean } = {}) {
	const existencia = opts.existencia ?? quants.reduce((s, q) => s + Number(q.cantidad), 0);
	const data: Record<string, Row[]> = {
		products: [{ _id: PRODUCTO, name: 'Codo', codigo: 'COD-1', existencia }],
		'inventory-stock-quant': quants,
		'inventory-internal-location': ubicaciones,
		'inventory-movement': [],
		pedidos: [],
		user: [
			{ _id: VENDEDOR, name: 'Vendedor ruta', almacen: ALM_RUTA },
			{ _id: CAJERO, name: 'Cajero' },
		],
		'pos-session': [
			{ _id: SESION_CENTRO, branch_office: SUC_CENTRO },
			{ _id: SESION_NORTE, branch_office: SUC_NORTE },
		],
	};
	if (opts.negativos !== undefined) {
		data.configuration = [{ _id: 'c', _ref: ALLOW_NEGATIVE_STOCK_REF, value: opts.negativos }];
	}
	return memory_store(data);
}

function cantidades(store: { data: Record<string, Row[]> }) {
	return Object.fromEntries(
		store.data['inventory-stock-quant'].map((row) => [row.ubicacion_codigo, row.cantidad]),
	);
}

describe('traslados entre almacenes', () => {
	test('del almacén general (sin filas por ubicación) al almacén del vendedor', async () => {
		const store = store_con([], { existencia: 10 });
		await register_internal_transfer(store, {
			producto: PRODUCTO,
			ubicacion_origen: GENERAL,
			ubicacion_destino: ALM_RUTA,
			cantidad: 4,
		});
		expect(cantidades(store)).toEqual({ GEN: 6, RUT: 4 });
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(10);
		const [mov] = store.data['inventory-movement'];
		expect(store.data['inventory-movement']).toHaveLength(1);
		expect(mov).toMatchObject({
			tipo_movimiento: 'transferencia_interna',
			documento_tipo: 'traslado',
			ubicacion_origen: GENERAL,
			ubicacion_destino: ALM_RUTA,
			cantidad: 4,
		});
		expect(String(mov.description)).toContain('Traslado entre almacenes Almacén general → Camioneta ruta 1');
	});

	test('desde un almacén con anaqueles toma en orden de surtido: un movimiento por ubicación', async () => {
		const store = store_con([quant(ALM_CENTRO_A1, 2), quant(ALM_CENTRO_A2, 5)]);
		await register_internal_transfer(store, {
			producto: PRODUCTO,
			ubicacion_origen: ALM_CENTRO,
			ubicacion_destino: ALM_RUTA,
			cantidad: 4,
		});
		expect(cantidades(store)).toMatchObject({ 'CEN-A1': 0, 'CEN-A2': 3, RUT: 4 });
		const movs = store.data['inventory-movement'];
		expect(movs.map((m) => [m.ubicacion_origen, m.cantidad])).toEqual([
			[ALM_CENTRO_A1, 2],
			[ALM_CENTRO_A2, 2],
		]);
		expect(movs.every((m) => String(m.description).startsWith('Traslado entre almacenes'))).toBe(true);
	});

	test('dentro del mismo almacén sigue siendo traslado interno', async () => {
		const store = store_con([quant(ALM_CENTRO_A1, 3)]);
		await register_internal_transfer(store, {
			producto: PRODUCTO,
			ubicacion_origen: ALM_CENTRO_A1,
			ubicacion_destino: ALM_CENTRO_A2,
			cantidad: 1,
		});
		expect(store.data['inventory-movement'][0].description).toBe('Traslado interno CEN-A1 → CEN-A2');
	});

	test('desde_almacen toma las sububicaciones aunque el origen permita almacenaje', async () => {
		const store = store_con([quant(ALM_RUTA, 1)]);
		const hijo = '507f1f77bcf86cd799439027';
		await store.insert('inventory-internal-location', {
			_id: hijo,
			codigo: 'RUT-A',
			name: 'Cajón',
			parent: ALM_RUTA,
			tipo: 'almacen',
			permite_almacenaje: true,
			secuencia_surtido: 1,
		});
		await store.insert('inventory-stock-quant', {
			_id: 'q-hijo',
			producto: PRODUCTO,
			ubicacion: hijo,
			ubicacion_codigo: 'RUT-A',
			cantidad: 4,
			cantidad_apartada: 0,
			cantidad_disponible: 4,
		});
		await expect(
			register_internal_transfer(store, {
				producto: PRODUCTO,
				ubicacion_origen: ALM_RUTA,
				ubicacion_destino: GENERAL,
				cantidad: 3,
			}),
		).rejects.toThrow(/disponible 1/);
		await register_internal_transfer(store, {
			producto: PRODUCTO,
			ubicacion_origen: ALM_RUTA,
			ubicacion_destino: GENERAL,
			cantidad: 3,
			desde_almacen: true,
		});
		expect(cantidades(store)).toMatchObject({ RUT: 0, 'RUT-A': 2, GEN: 3 });
	});

	test('no traslada más de lo que tiene el almacén de origen', async () => {
		const store = store_con([quant(ALM_CENTRO_A1, 1), quant(GENERAL, 50)]);
		await expect(
			register_internal_transfer(store, {
				producto: PRODUCTO,
				ubicacion_origen: ALM_CENTRO,
				ubicacion_destino: ALM_RUTA,
				cantidad: 2,
			}),
		).rejects.toThrow('No hay existencia disponible suficiente en Almacén Centro (disponible 1)');
	});

	test('desde_almacen sin cantidad mueve todo el stock del almacén', async () => {
		const store = store_con([quant(ALM_CENTRO_A1, 2), quant(ALM_CENTRO_A2, 5), quant(GENERAL, 50)]);
		await register_internal_transfer(store, {
			producto: PRODUCTO,
			ubicacion_origen: ALM_CENTRO,
			ubicacion_destino: ALM_RUTA,
			cantidad: 0,
			desde_almacen: true,
		});
		expect(cantidades(store)).toMatchObject({ 'CEN-A1': 0, 'CEN-A2': 0, RUT: 7, GEN: 50 });
		expect(store.data['inventory-movement'].reduce((s, m) => s + Number(m.cantidad), 0)).toBe(7);
	});
});

describe('POS: sale del almacén de la sucursal', () => {
	test('la sesión de caja de la sucursal resuelve su almacén; sin almacén, el del usuario', async () => {
		const store = store_con([]);
		expect(await pos_ticket_warehouse_id(store, { pos_session: SESION_CENTRO })).toBe(ALM_CENTRO);
		expect(
			await pos_ticket_warehouse_id(store, { pos_session: SESION_NORTE, created_by: VENDEDOR }),
		).toBe(ALM_RUTA);
		expect(await pos_ticket_warehouse_id(store, { pos_session: SESION_NORTE, created_by: CAJERO })).toBe('');
	});

	test('no vende existencia de otra sucursal aunque el total alcance', async () => {
		const store = store_con([quant(ALM_CENTRO_A1, 1), quant(GENERAL, 50)]);
		const ticket = {
			ticket_type: 'VENTA',
			pos_session: SESION_CENTRO,
			items: [{ item_id: PRODUCTO, quantity: 3 }],
		};
		await expect(assert_pos_ticket_stock(store, ticket)).rejects.toThrow(
			'No se puede vender en Almacén Centro',
		);
		await assert_pos_ticket_stock(store, { ...ticket, pos_session: SESION_NORTE });
	});

	test('la venta descuenta del almacén de la sucursal y el movimiento sale de él', async () => {
		const store = store_con([quant(ALM_CENTRO_A2, 4), quant(ALM_CENTRO_A1, 1), quant(GENERAL, 50)]);
		await register_pos_ticket_exit(store, {
			_id: 'ticket-1',
			ticket_type: 'VENTA',
			pos_session: SESION_CENTRO,
			items: [{ item_id: PRODUCTO, quantity: 3 }],
		});
		expect(cantidades(store)).toEqual({ 'CEN-A2': 2, 'CEN-A1': 0, GEN: 50 });
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(52);
		const movs = store.data['inventory-movement'];
		expect(movs.every((m) => m.tipo_movimiento === 'salida_entrega' && m.documento_tipo === 'pos-ticket')).toBe(true);
		expect(movs.map((m) => [m.ubicacion_origen, m.cantidad])).toEqual([
			[ALM_CENTRO_A1, 1],
			[ALM_CENTRO_A2, 2],
		]);
	});

	test('un apartado reserva el almacén de la sucursal, no la existencia de otros', async () => {
		const store = store_con([quant(ALM_CENTRO_A1, 2), quant(ALM_CENTRO_A2, 5), quant(GENERAL, 50)]);
		const apartado = (quantity: number) => ({
			ticket_type: 'APARTADO',
			ticket_sequence: 'CAJA-1',
			pos_session: SESION_CENTRO,
			created_by: CAJERO,
			client_id: 'cli-1',
			subtotal: 10,
			items: [{ item_id: PRODUCTO, item_name: 'Codo', quantity }],
			payments: [{ method: 'efectivo', amount: 1 }],
		});
		await expect(prepare_layaway_rules(store, apartado(8))).rejects.toThrow(/Almacén Centro/);
		const prepared = await prepare_layaway_rules(store, apartado(4));
		const layaway = await store.insert('pos-tickets', { ...prepared, _id: 'ap-1' });
		await register_layaway_effects(store, layaway);
		const apartada = (codigo: string) =>
			store.data['inventory-stock-quant'].find((row) => row.ubicacion_codigo === codigo)?.cantidad_apartada;
		expect(apartada('CEN-A1')).toBe(2);
		expect(apartada('CEN-A2')).toBe(2);
		expect(apartada('GEN')).toBe(0);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(4);
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(57);
		const holds = store.data['inventory-movement'].filter((row) => row.tipo_movimiento === 'apartado_logistica');
		expect(holds.map((row) => row.ubicacion_origen).sort()).toEqual([ALM_CENTRO_A1, ALM_CENTRO_A2]);
		const scope = await warehouse_scope(store, ALM_CENTRO);
		expect(await scope_stock(store, (await store.find_id('products', PRODUCTO))!, scope!, { libre: true })).toBe(3);
		await expect(assert_pos_ticket_stock(store, {
			ticket_type: 'VENTA',
			pos_session: SESION_CENTRO,
			items: [{ item_id: PRODUCTO, quantity: 4 }],
		})).rejects.toThrow(/Almacén Centro/);
		await cancel_layaway(store, 'ap-1');
		expect(apartada('CEN-A1')).toBe(0);
		expect(apartada('CEN-A2')).toBe(0);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(0);
	});

	test('liquidar el apartado saca la mercancía del mismo almacén', async () => {
		const store = store_con([quant(ALM_CENTRO_A1, 2), quant(ALM_CENTRO_A2, 5), quant(GENERAL, 50)]);
		const prepared = await prepare_layaway_rules(store, {
			ticket_type: 'APARTADO',
			ticket_sequence: 'CAJA-2',
			pos_session: SESION_CENTRO,
			created_by: CAJERO,
			client_id: 'cli-1',
			subtotal: 10,
			items: [{ item_id: PRODUCTO, quantity: 4 }],
			payments: [{ method: 'efectivo', amount: 1 }],
		});
		const layaway = await store.insert('pos-tickets', { ...prepared, _id: 'ap-2' });
		await register_layaway_effects(store, layaway);
		const abono = await store.insert('pos-tickets', {
			_id: 'ab-2',
			ticket_type: 'ABONO_APARTADO',
			original_ticket: 'ap-2',
			subtotal: 9,
			pos_session: SESION_NORTE,
			created_by: VENDEDOR,
		});
		await register_layaway_effects(store, abono);
		expect(cantidades(store)).toEqual({ 'CEN-A1': 0, 'CEN-A2': 3, GEN: 50 });
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(53);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(0);
		const salidas = store.data['inventory-movement'].filter((row) => row.tipo_movimiento === 'salida_entrega');
		expect(salidas.map((row) => [row.ubicacion_origen, row.cantidad])).toEqual([
			[ALM_CENTRO_A1, 2],
			[ALM_CENTRO_A2, 2],
		]);
	});

	test('sin almacén de sucursal aparta el del vendedor', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		const prepared = await prepare_layaway_rules(store, {
			ticket_type: 'APARTADO',
			pos_session: SESION_NORTE,
			created_by: VENDEDOR,
			client_id: 'cli-1',
			subtotal: 10,
			items: [{ item_id: PRODUCTO, quantity: 2 }],
			payments: [{ method: 'efectivo', amount: 1 }],
		});
		const layaway = await store.insert('pos-tickets', { ...prepared, _id: 'ap-3' });
		await register_layaway_effects(store, layaway);
		const ruta = store.data['inventory-stock-quant'].find((row) => row.ubicacion === ALM_RUTA);
		expect(ruta?.cantidad_apartada).toBe(2);
		expect(ruta?.cantidad).toBe(3);
		const scope = await warehouse_scope(store, ALM_RUTA);
		expect(await scope_stock_snapshot(store, scope!)).toEqual([
			{ producto: PRODUCTO, cantidad: 1, apartada: 2, disponible: 1 },
		]);
		await expect(prepare_layaway_rules(store, {
			ticket_type: 'APARTADO',
			pos_session: SESION_NORTE,
			created_by: VENDEDOR,
			client_id: 'cli-1',
			subtotal: 10,
			items: [{ item_id: PRODUCTO, quantity: 2 }],
			payments: [{ method: 'efectivo', amount: 1 }],
		})).rejects.toThrow(/Camioneta ruta 1/);
	});

	test('sin almacén configurado sigue la existencia global', async () => {
		const store = store_con([quant(GENERAL, 5)]);
		const ticket = { ticket_type: 'VENTA', items: [{ item_id: PRODUCTO, quantity: 5 }] };
		await assert_pos_ticket_stock(store, ticket);
		await register_pos_ticket_exit(store, ticket);
		expect(cantidades(store)).toEqual({ GEN: 0 });
		expect(store.data['inventory-movement'][0].ubicacion_origen).toBe(GENERAL);
	});
});

describe('pedidos del vendedor: salen de su almacén', () => {
	const vendedor = { _id: VENDEDOR, almacen: ALM_RUTA } as ImperiumDoc;

	test('el pedido toma el almacén del vendedor', async () => {
		const store = store_con([]);
		const pedido = await prepare_pedido_create(store, { articulos: [] }, vendedor);
		expect(pedido.almacen).toBe(ALM_RUTA);
		const otro = await prepare_pedido_create(store, { articulos: [], almacen: GENERAL }, vendedor);
		expect(otro.almacen).toBe(GENERAL);
	});

	test('sync offline: si su almacén no alcanza queda en borrador aunque haya en otros', async () => {
		const store = store_con([quant(ALM_RUTA, 2), quant(GENERAL, 50)]);
		const sync = async (cantidad: number, uuid: string) => {
			const res = await pedidos_sync_offline({
				store,
				actor: vendedor,
				body: {
					pedidos: [
						{
							offline_uuid: uuid,
							folio: uuid,
							estado: 'confirmado',
							articulos: [{ product: PRODUCTO, cantidad, precio: 1 }],
						},
					],
				},
			} as never);
			return (await res.json()) as { resultados: Array<{ estado?: string; aviso?: string }> };
		};
		const corto = await sync(3, 'u-1');
		expect(corto.resultados[0].estado).toBe('borrador');
		expect(corto.resultados[0].aviso).toContain('Codo (pide 3, hay 2)');
		const alcanza = await sync(2, 'u-2');
		expect(alcanza.resultados[0].estado).toBe('confirmado');
		expect(store.data.pedidos.map((p) => p.almacen)).toEqual([ALM_RUTA, ALM_RUTA]);
	});

	test('sync offline: el lote acumula contra el almacén del vendedor', async () => {
		const store = store_con([quant(ALM_RUTA, 5), quant(GENERAL, 50)]);
		const res = await pedidos_sync_offline({
			store,
			actor: vendedor,
			body: {
				pedidos: [
					{
						offline_uuid: 'u-a',
						folio: 'F-a',
						estado: 'confirmado',
						articulos: [{ product: PRODUCTO, cantidad: 3, precio: 1 }],
					},
					{
						offline_uuid: 'u-b',
						folio: 'F-b',
						estado: 'confirmado',
						articulos: [{ product: PRODUCTO, cantidad: 3, precio: 1 }],
					},
				],
			},
		} as never);
		const out = (await res.json()) as { resultados: Array<{ estado?: string; aviso?: string }> };
		expect(out.resultados.map((r) => r.estado)).toEqual(['confirmado', 'borrador']);
		expect(out.resultados[1].aviso).toContain('Codo (pide 3, hay 2)');
		expect(out.resultados[1].aviso).not.toContain('50');
	});

	test('surtir: bloquea con la existencia de su almacén y la salida sale de ahí', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		const articulos = [{ product: PRODUCTO, cantidad: 4 }];
		await expect(assert_surtido_sin_negativos(store, articulos, ALM_RUTA)).rejects.toThrow(
			'No se puede surtir',
		);
		await assert_surtido_sin_negativos(store, articulos);
		await register_order_fulfillment_exit(store, {
			_id: PEDIDO,
			folio: 'F-1',
			almacen: ALM_RUTA,
			articulos: [{ product: PRODUCTO, cantidad: 3 }],
		});
		expect(cantidades(store)).toEqual({ RUT: 0, GEN: 50 });
		expect(store.data['inventory-movement'][0]).toMatchObject({
			tipo_movimiento: 'salida_entrega',
			ubicacion_origen: ALM_RUTA,
			ubicacion_destino: CLIENTE,
			cantidad: 3,
		});
	});

	test('con existencia negativa permitida el surtido no se bloquea', async () => {
		const store = store_con([quant(ALM_RUTA, 1)], { negativos: true });
		await assert_surtido_sin_negativos(store, [{ product: PRODUCTO, cantidad: 4 }], ALM_RUTA);
	});

	test('un pedido viejo sin almacén se surte del almacén actual del vendedor', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		const mucho = [{ product: PRODUCTO, cantidad: 4 }];
		await expect(
			prepare_pedido_update(
				store,
				{ estado: 'surtido', articulos: mucho },
				ADMIN,
				{ _id: PEDIDO, estado: 'surtiendo', articulos: mucho, usuario: VENDEDOR },
			),
		).rejects.toThrow(/hay 3/);
		const articulos = [{ product: PRODUCTO, cantidad: 2 }];
		const out = await prepare_pedido_update(
			store,
			{ estado: 'surtido', articulos },
			ADMIN,
			{ _id: PEDIDO, estado: 'surtiendo', articulos, usuario: VENDEDOR },
		);
		expect(out.almacen).toBe(ALM_RUTA);
		await register_order_fulfillment_exit(store, { ...out, _id: PEDIDO, articulos, usuario: VENDEDOR });
		expect(cantidades(store)).toEqual({ RUT: 1, GEN: 50 });
		expect(store.data['inventory-movement'][0].ubicacion_origen).toBe(ALM_RUTA);
	});

	test('un pedido viejo sigue global si el vendedor no tiene almacén', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		const articulos = [{ product: PRODUCTO, cantidad: 4 }];
		const out = await prepare_pedido_update(
			store,
			{ estado: 'surtido', articulos },
			ADMIN,
			{ _id: PEDIDO, estado: 'surtiendo', articulos, usuario: CAJERO },
		);
		expect(out.almacen).toBeUndefined();
		await register_order_fulfillment_exit(store, { ...out, _id: PEDIDO, articulos, usuario: CAJERO });
		expect(store.data['inventory-movement'][0].ubicacion_origen).toBe(GENERAL);
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(49);
	});

	test('entregar un bulto de un pedido viejo sin almacén sale del almacén del vendedor', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		store.data.products[0].existenciaApartada = 4;
		store.data.pedidos.push({
			_id: PEDIDO,
			estado: 'confirmado',
			usuario: VENDEDOR,
		});
		await register_package_delivery_exit(
			store,
			{
				_id: BULTO,
				name: 'BULTO-1',
				pedido: PEDIDO,
				contenido: [{ product: PRODUCTO, quantity: 4 }],
			},
			'evento-1',
			'2026-11-05T12:00:00.000Z',
		);
		expect(cantidades(store)).toEqual({ RUT: -1, GEN: 50 });
	});
});

describe('apartados POS anteriores a 13.119', () => {
	const APARTADO = '507f1f77bcf86cd799439081';

	function apartado_viejo(store: ReturnType<typeof store_con>, created_by: string) {
		store.data.products[0].existenciaApartada = 2;
		const ruta = store.data['inventory-stock-quant'].find((row) => row.ubicacion === ALM_RUTA);
		if (ruta) {
			ruta.cantidad_apartada = 2;
			ruta.cantidad_disponible = 1;
		}
		store.data['pos-tickets'] = [
			{
				_id: APARTADO,
				ticket_type: 'APARTADO',
				ticket_sequence: 'VIEJO-1',
				layaway_status: 'abierto',
				created_by,
				client_id: 'cli-1',
				subtotal: 10,
				total_paid: 1,
				items: [{ item_id: PRODUCTO, quantity: 2 }],
				is_active: true,
			},
		];
		store.data['inventory-movement'].push({
			documento_id: APARTADO,
			documento_tipo: 'pos-ticket',
			tipo_movimiento: 'apartado_logistica',
			producto: PRODUCTO,
			cantidad: 2,
			dedupe_key: `pos-layaway:${APARTADO}:reserve:${PRODUCTO}`,
		});
	}

	test('cancelar suelta lo apartado en el almacén del vendedor aunque el movimiento no traiga @ubicacion', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		apartado_viejo(store, VENDEDOR);
		await cancel_layaway(store, APARTADO);
		const ruta = store.data['inventory-stock-quant'].find((row) => row.ubicacion === ALM_RUTA);
		const general = store.data['inventory-stock-quant'].find((row) => row.ubicacion === GENERAL);
		expect(ruta?.cantidad_apartada).toBe(0);
		expect(ruta?.cantidad).toBe(3);
		expect(general?.cantidad_apartada ?? 0).toBe(0);
		expect(general?.cantidad).toBe(50);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(0);
	});

	test('liquidar descuenta el almacén del vendedor y suelta su apartado', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		apartado_viejo(store, VENDEDOR);
		const abono = await store.insert('pos-tickets', {
			_id: '507f1f77bcf86cd799439082',
			ticket_type: 'ABONO_APARTADO',
			original_ticket: APARTADO,
			subtotal: 9,
			created_by: CAJERO,
		});
		await register_layaway_effects(store, abono);
		expect(cantidades(store)).toEqual({ RUT: 1, GEN: 50 });
		const ruta = store.data['inventory-stock-quant'].find((row) => row.ubicacion === ALM_RUTA);
		expect(ruta?.cantidad_apartada).toBe(0);
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(51);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(0);
	});

	test('sin almacén de vendedor ni de sucursal, cancelar no reescribe ubicaciones', async () => {
		const store = store_con([quant(ALM_RUTA, 3), quant(GENERAL, 50)]);
		apartado_viejo(store, CAJERO);
		await cancel_layaway(store, APARTADO);
		const ruta = store.data['inventory-stock-quant'].find((row) => row.ubicacion === ALM_RUTA);
		expect(ruta?.cantidad_apartada).toBe(2);
		expect(ruta?.cantidad).toBe(3);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(0);
	});
});

describe('existencia offline del almacén del vendedor', () => {
	test('trae lo libre de su almacén y la regla de negativos', async () => {
		const store = store_con([quant(ALM_RUTA, 7), quant(GENERAL, 50)]);
		const res = await read_offline_stock({ store, actor: { _id: VENDEDOR } } as never);
		expect(await res.json()).toEqual({
			almacen: { _id: ALM_RUTA, name: 'Camioneta ruta 1', codigo: 'RUT' },
			permitir_negativos: false,
			existencias: [{ producto: PRODUCTO, cantidad: 7, apartada: 0, disponible: 7 }],
		});
	});

	test('el disponible del almacén no baja de cero y la apartada es la de ahí', async () => {
		const fila = quant(ALM_RUTA, 1);
		fila.cantidad_apartada = 4;
		fila.cantidad_disponible = -3;
		const store = store_con([fila, quant(GENERAL, 5)]);
		const res = await read_offline_stock({ store, actor: { _id: VENDEDOR } } as never);
		const body = await res.json();
		expect(body.almacen._id).toBe(ALM_RUTA);
		expect(body.existencias).toEqual([
			{ producto: PRODUCTO, cantidad: -3, apartada: 4, disponible: 0 },
		]);
	});

	test('sin almacén asignado no restringe (existencias null)', async () => {
		const store = store_con([quant(GENERAL, 5)]);
		const res = await read_offline_stock({ store, actor: { _id: CAJERO } } as never);
		expect(await res.json()).toEqual({ almacen: null, permitir_negativos: false, existencias: null });
	});

	test('el almacén general incluye productos sin filas por ubicación', async () => {
		const store = store_con([], { existencia: 9 });
		const scope = await warehouse_scope(store, GENERAL);
		expect(await scope_stock_snapshot(store, scope!)).toEqual([
			{ producto: PRODUCTO, cantidad: 9, apartada: 0, disponible: 9 },
		]);
	});
});

describe('apartado al pasar a Por surtir', () => {
	test('confirma a Por surtir aparta las líneas del pedido', async () => {
		const store = store_con([quant(ALM_RUTA, 5), quant(GENERAL, 20)]);
		const pedido = {
			_id: PEDIDO,
			estado: 'por_surtir',
			almacen: ALM_RUTA,
			folio: 'F-A',
			articulos: [{ product: PRODUCTO, cantidad: 3 }],
		};
		store.data.pedidos = [{ ...pedido }];
		await after_pedido_mutate(store, 'update', pedido, { ...pedido, estado: 'confirmado' });
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(3);
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(25);
		const holds = store.data['inventory-movement'].filter((row) => row.tipo_movimiento === 'apartado_logistica');
		expect(holds).toHaveLength(1);
		expect(holds[0]).toMatchObject({
			cantidad: 3,
			documento_id: PEDIDO,
			description: 'Apartado automático al pasar a Por surtir',
		});
	});

	test('al cancelar se libera el apartado', async () => {
		const store = store_con([quant(ALM_RUTA, 5)]);
		store.data.products[0].existenciaApartada = 3;
		const previo = {
			_id: PEDIDO,
			estado: 'por_surtir',
			almacen: ALM_RUTA,
			articulos: [{ product: PRODUCTO, cantidad: 3 }],
		};
		store.data['inventory-movement'] = [
			{
				_id: 'mov-apart',
				tipo_movimiento: 'apartado_logistica',
				documento_tipo: 'pedido',
				documento_id: PEDIDO,
				producto: PRODUCTO,
				cantidad: 3,
			},
		];
		await after_pedido_mutate(store, 'update', { ...previo, estado: 'cancelado' }, previo);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(0);
		expect(
			store.data['inventory-movement'].some((row) => row.tipo_movimiento === 'liberacion_logistica'),
		).toBe(true);
	});

	test('pasar a surtido libera el apartado y luego descuenta la existencia', async () => {
		const store = store_con([quant(ALM_RUTA, 5)]);
		store.data.products[0].existenciaApartada = 3;
		const previo = {
			_id: PEDIDO,
			estado: 'por_surtir',
			almacen: ALM_RUTA,
			folio: 'F-A',
			articulos: [{ product: PRODUCTO, cantidad: 3 }],
			usuario: VENDEDOR,
		};
		store.data['inventory-movement'] = [
			{
				_id: 'mov-apart',
				tipo_movimiento: 'apartado_logistica',
				documento_tipo: 'pedido',
				documento_id: PEDIDO,
				producto: PRODUCTO,
				cantidad: 3,
			},
		];
		await after_pedido_mutate(store, 'update', { ...previo, estado: 'surtido' }, previo);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBe(0);
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(2);
		expect(cantidades(store)).toEqual({ RUT: 2 });
	});

	test('sin existencia suficiente no deja pasar a Por surtir', async () => {
		const store = store_con([quant(ALM_RUTA, 1)]);
		const pedido = {
			_id: PEDIDO,
			estado: 'por_surtir',
			almacen: ALM_RUTA,
			articulos: [{ product: PRODUCTO, cantidad: 3 }],
		};
		await expect(
			after_pedido_mutate(store, 'update', pedido, { ...pedido, estado: 'confirmado' }),
		).rejects.toThrow(/No hay inventario suficiente/);
		expect((await store.find_id('products', PRODUCTO))?.existenciaApartada).toBeUndefined();
	});
});

