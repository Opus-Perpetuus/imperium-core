import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	prepare_delivery_return_create,
	prepare_delivery_return_update,
	recibir_delivery_return,
} from './delivery-return-flow.ts';

const PEDIDO = '507f1f77bcf86cd799439011';
const DEVOLUCION = '507f1f77bcf86cd799439012';
const PRODUCTO = '507f1f77bcf86cd799439013';
const UBICACION = '507f1f77bcf86cd799439014';
const FACTURA = '507f1f77bcf86cd799439015';
const FOLIO = 'admin-20260922-012808';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => row[key] === value);
	};
	const store = {
		data,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_many(
			resource: string,
			opts: { where?: Record<string, unknown>; take?: number } = {},
		) {
			const rows = (data[resource] ?? []).filter((row) => matches(row, opts.where));
			const take = opts.take ?? rows.length;
			return { rows: rows.slice(0, take), total: rows.length };
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
		},
		async insert(resource: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${crypto.randomUUID()}` };
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

function devolucion_firmada(extra: Row = {}): Row {
	return {
		_id: DEVOLUCION,
		name: `Devolución ${FOLIO}`,
		pedido_folio: FOLIO,
		estado: 'firmado',
		lineas: [
			{
				producto: PRODUCTO,
				producto_nombre: 'FE329',
				producto_codigo: 'FE329',
				cantidad: 1,
				motivo: 'no lo quiso',
				estado_producto: 'bueno',
			},
		],
		...extra,
	};
}

describe('delivery-return pedido link', () => {
	test('guardar con folio deja el vínculo al pedido', async () => {
		const store = memory_store({
			pedidos: [{ _id: PEDIDO, folio: FOLIO, name: `PEDIDO-${FOLIO}` }],
		});
		const saved = await prepare_delivery_return_create(store, {
			pedido_folio: FOLIO,
			firma_conformidad_attachment_id: '507f1f77bcf86cd799439099',
			lineas: [],
		});
		expect(saved.pedido).toBe(PEDIDO);
		expect(saved.pedido_folio).toBe(FOLIO);
		expect(saved.estado).toBe('firmado');
	});

	test('un folio sin pedido no bloquea el guardado', async () => {
		const store = memory_store({ pedidos: [] });
		const saved = await prepare_delivery_return_create(store, {
			pedido_folio: 'no-existe',
			lineas: [],
		});
		expect(saved.pedido).toBeUndefined();
		expect(saved.estado).toBe('borrador');
	});

	test('actualizar una firmada completa el vínculo que faltaba', async () => {
		const store = memory_store({
			pedidos: [{ _id: PEDIDO, name: `PEDIDO-${FOLIO}` }],
		});
		const saved = await prepare_delivery_return_update(
			store,
			{ pedido_folio: FOLIO },
			devolucion_firmada(),
		);
		expect(saved.pedido).toBe(PEDIDO);
	});

	test('una recibida sigue sin poder modificarse', async () => {
		const store = memory_store({ pedidos: [] });
		await expect(
			prepare_delivery_return_update(
				store,
				{ pedido_folio: FOLIO },
				devolucion_firmada({ estado: 'recibido_almacen' }),
			),
		).rejects.toThrow('no se puede modificar');
	});
});

describe('delivery-return recepción', () => {
	test('recibir publica el comentario en el pedido y no frena existencia negativa', async () => {
		const store = memory_store({
			'delivery-return': [devolucion_firmada()],
			pedidos: [
				{
					_id: PEDIDO,
					folio: FOLIO,
					name: `PEDIDO-${FOLIO}`,
					invoice_request_id: FACTURA,
				},
			],
			products: [{ _id: PRODUCTO, name: 'FE329', codigo: 'FE329', existencia: -10 }],
			'inventory-internal-location': [
				{ _id: UBICACION, codigo: 'REC', permite_almacenaje: true },
			],
			'inventory-movement': [],
			'document-change-history': [],
		});
		const received = await recibir_delivery_return(store, DEVOLUCION, UBICACION, {
			_id: '507f1f77bcf86cd799439016',
			name: 'Prueba Chofer',
		});
		expect(received.estado).toBe('recibido_almacen');
		expect(received.pedido).toBe(PEDIDO);
		expect(store.data.products[0]?.existencia).toBe(-9);
		expect(store.data['inventory-movement'][0]?.tipo_movimiento).toBe(
			'recepcion_devolucion',
		);
		const comments = store.data['document-change-history'];
		const on_pedido = comments.find((row) => row.documentId === PEDIDO);
		expect(on_pedido?.modelName).toBe('Pedidos');
		expect(String(on_pedido?.commentText)).toContain('devolucion-recibida-almacen');
		expect(String(on_pedido?.commentText)).toContain(FOLIO);
		expect(comments.some((row) => row.documentId === FACTURA)).toBe(true);
		expect(comments.some((row) => row.documentId === DEVOLUCION)).toBe(true);
	});
});

describe('ticket de devolución', () => {
	test('el slug ticket-devolucion está escrito en un solo archivo', () => {
		const slug_file = readFileSync(
			new URL(
				'../../../../frontend/src/app/components/delivery-return/delivery-return-ticket.ts',
				import.meta.url,
			),
			'utf8',
		);
		const form = readFileSync(
			new URL(
				'../../../../frontend/src/app/components/delivery-return/devolucion.component.ts',
				import.meta.url,
			),
			'utf8',
		);
		expect(slug_file.match(/ticket-devolucion/g)).toEqual(['ticket-devolucion']);
		expect(form).toContain('TICKET_DEVOLUCION_SLUG');
		expect(form).not.toContain('ticket-devolucion');
	});
});
