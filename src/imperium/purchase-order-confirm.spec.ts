import { describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import { in_transit_for_product } from './inventory-reception-flow.ts';
import type { ImperiumStore } from './store.ts';

const PO = '507f1f77bcf86cd799439011';
const PO2 = '507f1f77bcf86cd799439012';
const CODO = '507f1f77bcf86cd799439013';
const TUBO = '507f1f77bcf86cd799439014';
const SUERO = '507f1f77bcf86cd799439015';
const REC = '507f1f77bcf86cd799439021';
const REC2 = '507f1f77bcf86cd799439022';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => {
			const copy: Row = { ...row };
			for (const [field, value] of Object.entries(copy)) {
				if (!Array.isArray(value)) continue;
				copy[field] = value.map((item) =>
					item && typeof item === 'object' ? { ...(item as Row) } : item,
				);
			}
			return copy;
		});
	}
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => {
			if (value && typeof value === 'object' && 'in' in value) {
				return (value as { in: unknown[] }).in.map(String).includes(String(row[key] ?? ''));
			}
			return row[key] === value;
		});
	};
	let n = 0;
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
			opts: { where?: Record<string, unknown>; take?: number } = {},
		) {
			const rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			return { rows: rows.slice(0, opts.take ?? rows.length), total: rows.length };
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = { ...doc, _id: doc._id ?? `507f1f77bcf86cd79944${String(n).padStart(4, '0')}` };
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
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

function product(id: string, name: string, extra: Row = {}): Row {
	return {
		_id: id,
		name,
		codigo: name.slice(0, 4).toUpperCase(),
		existencia: 0,
		puedoComprarlo: true,
		...extra,
	};
}

function line(producto: string, nombre: string, cantidad: number, recibida = 0): Row {
	return {
		producto,
		producto_nombre: nombre,
		cantidad,
		cantidad_recibida: recibida,
		costo_unitario: 5,
	};
}

function reception(
	id: string,
	po: string,
	lines: Array<{ producto: string; nombre: string; esperada: number; recibida?: number }>,
): Row {
	const articulos = lines.map((item) => ({
		producto: item.producto,
		producto_nombre: item.nombre,
		cantidad_esperada: item.esperada,
		cantidad_recibida: item.recibida ?? 0,
		reservas: [],
	}));
	const total_esperado = articulos.reduce((sum, item) => sum + item.cantidad_esperada, 0);
	const total_recibido = articulos.reduce((sum, item) => sum + item.cantidad_recibida, 0);
	const estado =
		total_recibido <= 0
			? 'pendiente'
			: total_recibido + 1e-6 >= total_esperado
				? 'recibida'
				: 'parcial';
	return {
		_id: id,
		name: `Recepción ${po}`,
		estado,
		purchase_order: po,
		orden_compra: po,
		articulos,
		total_esperado,
		total_recibido,
		is_active: true,
	};
}

function orden(id: string, estado: string, articulos: Row[]): Row {
	return { _id: id, name: `OC ${id.slice(-4)}`, estado, articulos, is_active: true };
}

const ACTOR = { _id: '507f1f77bcf86cd799439099', name: 'Almacén' };

async function receive(
	store: ImperiumStore,
	id: string,
	action: 'confirm' | 'register_receipt',
	body: Record<string, unknown> = {},
) {
	const path = action === 'confirm' ? 'confirm' : 'register-receipt';
	const req = new Request(`http://local/api/purchase-order/${id}/${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			referencia: '',
			fecha_recepcion: '2026-10-08',
			notas: '',
			...body,
		}),
	});
	return handle_action(
		store,
		null as never,
		req,
		new URL(req.url),
		'purchase-order',
		action,
		{ id },
		ACTOR,
	);
}

function confirm(store: ImperiumStore, id: string, body: Record<string, unknown> = {}) {
	return receive(store, id, 'confirm', body);
}

function received_of(row: Row | null, producto: string): number {
	const item = (row?.articulos as Row[] | undefined)?.find((line) => line.producto === producto);
	return Number(item?.cantidad_recibida ?? 0);
}

describe('POST /purchase-order/:id/confirm', () => {
	test('confirma la orden, cierra la recepción y deja en camino solo la otra OC', async () => {
		const store = memory_store({
			products: [product(CODO, 'Codo')],
			'purchase-order': [
				orden(PO, 'aprobada', [line(CODO, 'Codo', 10)]),
				orden(PO2, 'aprobada', [line(CODO, 'Codo', 10)]),
			],
			'inventory-reception': [
				reception(REC, PO, [{ producto: CODO, nombre: 'Codo', esperada: 10 }]),
				reception(REC2, PO2, [{ producto: CODO, nombre: 'Codo', esperada: 10 }]),
			],
			'inventory-movement': [],
		});
		const res = await confirm(store, PO);
		const body = await res.json();
		expect(res.status).toBe(200);
		expect(body.data[0].estado).toBe('confirmada');
		expect(received_of(body.data[0], CODO)).toBe(10);
		expect((await store.find_id('products', CODO))?.existencia).toBe(10);
		const closed = await store.find_id('inventory-reception', REC);
		expect(closed?.estado).toBe('recibida');
		expect(received_of(closed, CODO)).toBe(10);
		expect((await store.find_id('inventory-reception', REC2))?.estado).toBe('pendiente');
		expect(await in_transit_for_product(store, CODO)).toMatchObject({
			en_camino: 10,
			recepciones: 1,
		});
	});

	test('registrar una parte deja la recepción parcial y en camino solo lo que falta', async () => {
		const store = memory_store({
			products: [product(CODO, 'Codo')],
			'purchase-order': [
				orden(PO, 'aprobada', [line(CODO, 'Codo', 10)]),
				orden(PO2, 'aprobada', [line(CODO, 'Codo', 10)]),
			],
			'inventory-reception': [
				reception(REC, PO, [{ producto: CODO, nombre: 'Codo', esperada: 10 }]),
				reception(REC2, PO2, [{ producto: CODO, nombre: 'Codo', esperada: 10 }]),
			],
			'inventory-movement': [],
		});
		const res = await receive(store, PO, 'register_receipt', {
			articulos: [{ producto: CODO, cantidad: 4, costo_unitario: 5 }],
		});
		expect(res.status).toBe(200);
		expect((await store.find_id('purchase-order', PO))?.estado).toBe('parcialmente_recibida');
		const open = await store.find_id('inventory-reception', REC);
		expect(open?.estado).toBe('parcial');
		expect(received_of(open, CODO)).toBe(4);
		expect((await store.find_id('products', CODO))?.existencia).toBe(4);
		expect(await in_transit_for_product(store, CODO)).toMatchObject({ en_camino: 16 });
	});

	test('una orden en borrador no se puede recibir', async () => {
		const store = memory_store({
			products: [product(CODO, 'Codo', { existencia: 3 })],
			'purchase-order': [orden(PO, 'borrador', [line(CODO, 'Codo', 10)])],
			'inventory-reception': [
				reception(REC, PO, [{ producto: CODO, nombre: 'Codo', esperada: 10 }]),
			],
			'inventory-movement': [],
		});
		await expect(confirm(store, PO)).rejects.toThrow(
			'Solo puedes recibir una orden aprobada o con recepción parcial',
		);
		expect((await store.find_id('products', CODO))?.existencia).toBe(3);
		expect((await store.find_id('purchase-order', PO))?.estado).toBe('borrador');
		expect((await store.find_id('inventory-reception', REC))?.estado).toBe('pendiente');
		expect(store.data['inventory-movement']).toEqual([]);
	});

	test('un producto con lote pide recibirlo desde Recepciones y no mueve existencia', async () => {
		const store = memory_store({
			products: [product(SUERO, 'Suero', { maneja_lote: true, tiene_caducidad: true })],
			'purchase-order': [orden(PO, 'aprobada', [line(SUERO, 'Suero', 10)])],
			'inventory-reception': [
				reception(REC, PO, [{ producto: SUERO, nombre: 'Suero', esperada: 10 }]),
			],
			'inventory-movement': [],
		});
		await expect(confirm(store, PO)).rejects.toThrow(
			'Los productos con lote o número de serie se reciben desde Recepciones',
		);
		expect((await store.find_id('products', SUERO))?.existencia).toBe(0);
		expect((await store.find_id('inventory-reception', REC))?.estado).toBe('pendiente');
		expect(received_of(await store.find_id('inventory-reception', REC), SUERO)).toBe(0);
		expect(store.data['inventory-movement']).toEqual([]);
	});

	test('no genera movimientos de cero y omite la partida que ya se recibió', async () => {
		const store = memory_store({
			products: [
				product(CODO, 'Codo', { existencia: 5 }),
				product(TUBO, 'Tubo', { existencia: 1 }),
			],
			'purchase-order': [
				orden(PO, 'parcialmente_recibida', [
					line(CODO, 'Codo', 5, 5),
					line(TUBO, 'Tubo', 4, 0),
				]),
			],
			'inventory-reception': [
				reception(REC, PO, [
					{ producto: CODO, nombre: 'Codo', esperada: 5, recibida: 5 },
					{ producto: TUBO, nombre: 'Tubo', esperada: 4, recibida: 0 },
				]),
			],
			'inventory-movement': [],
		});
		const res = await confirm(store, PO);
		expect(res.status).toBe(200);
		expect((await store.find_id('purchase-order', PO))?.estado).toBe('confirmada');
		expect((await store.find_id('products', CODO))?.existencia).toBe(5);
		expect((await store.find_id('products', TUBO))?.existencia).toBe(5);
		const closed = await store.find_id('inventory-reception', REC);
		expect(closed?.estado).toBe('recibida');
		expect(received_of(closed, CODO)).toBe(5);
		expect(received_of(closed, TUBO)).toBe(4);
		expect(store.data['inventory-movement'].map((row) => [row.producto, row.cantidad])).toEqual([
			[TUBO, 4],
		]);
		expect(await in_transit_for_product(store, TUBO)).toMatchObject({ en_camino: 0 });
	});

	test('el lote ya recibido no bloquea confirmar el resto', async () => {
		const store = memory_store({
			products: [
				product(SUERO, 'Suero', { maneja_lote: true, tiene_caducidad: true, existencia: 2 }),
				product(CODO, 'Codo', { existencia: 0 }),
			],
			'purchase-order': [
				orden(PO, 'parcialmente_recibida', [
					line(SUERO, 'Suero', 2, 2),
					line(CODO, 'Codo', 3, 0),
				]),
			],
			'inventory-reception': [
				reception(REC, PO, [
					{ producto: SUERO, nombre: 'Suero', esperada: 2, recibida: 2 },
					{ producto: CODO, nombre: 'Codo', esperada: 3, recibida: 0 },
				]),
			],
			'inventory-movement': [],
		});
		const res = await confirm(store, PO);
		expect(res.status).toBe(200);
		expect((await store.find_id('products', SUERO))?.existencia).toBe(2);
		expect((await store.find_id('products', CODO))?.existencia).toBe(3);
		expect((await store.find_id('inventory-reception', REC))?.estado).toBe('recibida');
		expect(store.data['inventory-movement'].map((row) => row.producto)).toEqual([CODO]);
	});
});
