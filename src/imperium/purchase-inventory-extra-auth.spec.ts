/**
 * Las acciones de compra e inventario que escriben piden el permiso del modelo.
 * Un usuario con solo lectura de Products no aprueba, recibe ni repara existencias.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handle_action } from './actions.ts';
import { assert_http_access, HttpAccessDeniedError } from './auth.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const CAJERO = '507f1f77bcf86cd7994390a1';
const ALMACEN = '507f1f77bcf86cd7994390a2';
const LECTOR = '507f1f77bcf86cd7994390a3';
const PRODUCTO = '507f1f77bcf86cd799439013';
const PO_APROBAR = '507f1f77bcf86cd799439011';
const PO_CONFIRMAR = '507f1f77bcf86cd799439012';
const RECEPCION = '507f1f77bcf86cd799439014';
const CONTEO = '507f1f77bcf86cd799439015';
const ORIGEN = '507f1f77bcf86cd799439021';
const DESTINO = '507f1f77bcf86cd799439022';

type Row = ImperiumDoc;

const cajero: ImperiumDoc = { _id: CAJERO, name: 'Cajero', email: 'cajero@local.test' };
const almacen: ImperiumDoc = { _id: ALMACEN, name: 'Almacén', email: 'almacen@local.test' };
const lector: ImperiumDoc = { _id: LECTOR, name: 'Lector', email: 'lector@local.test' };
const admin: ImperiumDoc = {
	_id: '507f1f77bcf86cd7994390aa',
	_ref: 'user-menu-management-0',
	name: 'Admin',
	email: 'admin@local.test',
};

function derecho(
	id: string,
	model_id: string,
	group_id: string,
	flags: { read?: boolean; create?: boolean; update?: boolean },
): Row {
	return {
		_id: id,
		model_id,
		group_id,
		allow_read: flags.read === true,
		allow_create: flags.create === true,
		allow_update: flags.update === true,
		allow_delete: false,
		is_active: true,
	};
}

function memory_store(): ImperiumStore & { data: Record<string, Row[]> } {
	const data: Record<string, Row[]> = {
		user: [cajero, almacen, lector, admin],
		'user-group': [
			{
				_id: '507f1f77bcf86cd7994390b1',
				_ref: 'user-group-solo-productos',
				name: 'Solo productos',
				user_ids: [CAJERO],
				is_active: true,
			},
			{
				_id: '507f1f77bcf86cd7994390b2',
				_ref: 'user-group-almacen',
				name: 'Almacén',
				user_ids: [ALMACEN],
				is_active: true,
			},
			{
				_id: '507f1f77bcf86cd7994390b3',
				_ref: 'user-group-stock-lectura',
				name: 'Stock lectura',
				user_ids: [LECTOR],
				is_active: true,
			},
		],
		'access-rights': [
			derecho('ar-products', 'Products', 'user-group-solo-productos', { read: true }),
			derecho('ar-po', 'PurchaseOrder', 'user-group-almacen', { read: true, update: true }),
			derecho('ar-rec', 'InventoryReception', 'user-group-almacen', {
				read: true,
				create: true,
				update: true,
			}),
			derecho('ar-count', 'InventoryPhysicalCount', 'user-group-almacen', {
				read: true,
				update: true,
			}),
			derecho('ar-mov', 'InventoryMovement', 'user-group-almacen', { read: true, update: true }),
			derecho('ar-quant', 'InventoryStockQuant', 'user-group-almacen', {
				read: true,
				update: true,
			}),
			derecho('ar-quant-read', 'InventoryStockQuant', 'user-group-stock-lectura', { read: true }),
		],
		products: [
			{
				_id: PRODUCTO,
				name: 'Codo',
				codigo: 'COD-1',
				existencia: 10,
				puedoComprarlo: true,
				is_active: true,
			},
		],
		'purchase-order': [
			{
				_id: PO_APROBAR,
				name: 'OC aprobar',
				estado: 'borrador',
				is_active: true,
				articulos: [
					{
						producto: PRODUCTO,
						producto_nombre: 'Codo',
						cantidad: 3,
						cantidad_recibida: 0,
						costo_unitario: 1,
					},
				],
			},
			{
				_id: PO_CONFIRMAR,
				name: 'OC confirmar',
				estado: 'aprobada',
				is_active: true,
				articulos: [
					{
						producto: PRODUCTO,
						producto_nombre: 'Codo',
						cantidad: 3,
						cantidad_recibida: 0,
						costo_unitario: 1,
					},
				],
			},
		],
		'inventory-reception': [
			{
				_id: RECEPCION,
				name: 'Recepción 1',
				estado: 'pendiente',
				is_active: true,
				articulos: [
					{
						producto: PRODUCTO,
						producto_nombre: 'Codo',
						cantidad_esperada: 3,
						cantidad_recibida: 0,
					},
				],
			},
		],
		'inventory-physical-count': [
			{
				_id: CONTEO,
				name: 'Conteo 1',
				estado: 'contado',
				is_active: true,
				lineas: [
					{
						producto: PRODUCTO,
						cantidad_sistema: 10,
						cantidad_contada: 13,
					},
				],
			},
		],
		'inventory-internal-location': [
			{ _id: ORIGEN, codigo: 'A-01', name: 'A-01', permite_almacenaje: true, is_active: true },
			{ _id: DESTINO, codigo: 'B-01', name: 'B-01', permite_almacenaje: true, is_active: true },
		],
		'inventory-stock-quant': [
			{
				_id: '507f1f77bcf86cd799439031',
				producto: PRODUCTO,
				ubicacion: ORIGEN,
				ubicacion_codigo: 'A-01',
				cantidad: 13,
				cantidad_apartada: 0,
				cantidad_disponible: 13,
				is_active: true,
			},
		],
		'inventory-movement': [],
	};
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
	const active = (row: Row, include_inactive?: boolean) =>
		include_inactive || row.is_active !== false;
	return {
		data,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		loc(resource: string) {
			return { resource };
		},
		is_model_installed() {
			return true;
		},
		available_mongoose_models() {
			return [];
		},
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
			const take = opts.take ?? rows.length;
			return { rows: rows.slice(0, take), total: rows.length };
		},
		async *scan(
			resource: string,
			opts: { where?: Record<string, unknown>; include_inactive?: boolean } = {},
		) {
			yield (data[resource] ?? []).filter(
				(row) => active(row, opts.include_inactive) && matches(row, opts.where),
			);
		},
		async insert(resource: string, doc: Row) {
			const row = {
				...doc,
				_id: doc._id ?? crypto.randomUUID().replace(/-/g, '').slice(0, 24),
				is_active: doc.is_active ?? true,
			};
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
	} as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

type CallSpec = {
	resource: string;
	action: string;
	method: string;
	path: string;
	params?: Record<string, string>;
	body?: Record<string, unknown>;
};

const LLAMADAS: Record<string, CallSpec> = {
	approve: {
		resource: 'purchase-order',
		action: 'approve',
		method: 'POST',
		path: `/purchase-order/${PO_APROBAR}/approve`,
		params: { id: PO_APROBAR },
	},
	confirm: {
		resource: 'purchase-order',
		action: 'confirm',
		method: 'POST',
		path: `/purchase-order/${PO_CONFIRMAR}/confirm`,
		params: { id: PO_CONFIRMAR },
	},
	confirm_reception: {
		resource: 'inventory-reception',
		action: 'confirm_reception',
		method: 'POST',
		path: `/inventory-reception/${RECEPCION}/confirmar-recepcion`,
		params: { id: RECEPCION },
		body: { articulos: [{ producto: PRODUCTO, cantidad: 3 }] },
	},
	aplicar: {
		resource: 'inventory-physical-count',
		action: 'aplicar',
		method: 'POST',
		path: `/inventory-physical-count/${CONTEO}/aplicar`,
		params: { id: CONTEO },
	},
	register_transfer: {
		resource: 'inventory-movement',
		action: 'register_transfer',
		method: 'POST',
		path: '/inventory-movement/traslado',
		body: {
			producto: PRODUCTO,
			ubicacion_origen: ORIGEN,
			ubicacion_destino: DESTINO,
			cantidad: 2,
		},
	},
	reparar: {
		resource: 'inventory-stock-quant',
		action: 'validar_consistencia',
		method: 'GET',
		path: '/inventory-stock-quant/consistencia?reparar=1',
	},
};

async function call(store: ImperiumStore, actor: ImperiumDoc, spec: CallSpec) {
	const url = new URL(`http://core/api${spec.path}`);
	try {
		await assert_http_access(store, actor, spec.resource, spec.method, {
			extra: true,
			action: spec.action,
			search: url.searchParams.toString(),
		});
	} catch (err) {
		if (err instanceof HttpAccessDeniedError) {
			return Response.json(
				{ message: err.message, error: err.message, code: err.code },
				{ status: err.status },
			);
		}
		throw err;
	}
	const req = new Request(url, {
		method: spec.method,
		headers: { 'content-type': 'application/json' },
		body: spec.method === 'GET' ? undefined : JSON.stringify(spec.body ?? {}),
	});
	return handle_action(
		store,
		null as never,
		req,
		url,
		spec.resource,
		spec.action,
		spec.params ?? {},
		actor,
	);
}

describe('permiso de modelo en extras de compra e inventario', () => {
	test('quien solo lee productos recibe 403', async () => {
		for (const spec of Object.values(LLAMADAS)) {
			const store = memory_store();
			const res = await call(store, cajero, spec);
			expect(res.status).toBe(403);
		}
		const store = memory_store();
		await call(store, cajero, LLAMADAS.reparar);
		expect((await store.find_id('products', PRODUCTO))?.existencia).toBe(10);
	});

	test('leer la consistencia sigue pidiendo solo sesión; reparar no', async () => {
		const store = memory_store();
		await expect(
			assert_http_access(store, cajero, 'inventory-stock-quant', 'GET', {
				extra: true,
				action: 'validar_consistencia',
			}),
		).resolves.toBeUndefined();
		await expect(
			assert_http_access(store, lector, 'inventory-stock-quant', 'GET', {
				extra: true,
				action: 'validar_consistencia',
				search: 'reparar=1',
			}),
		).rejects.toMatchObject({ status: 403 });
		for (const [resource, action] of [
			['inventory-reception', 'read_in_transit'],
			['inventory-reception', 'read_pending_for_product'],
			['inventory-stock-quant', 'read_picking_route'],
		] as const) {
			await expect(
				assert_http_access(store, cajero, resource, 'GET', { extra: true, action }),
			).resolves.toBeUndefined();
		}
	});

	test('almacén con actualizar en el modelo recibe 200', async () => {
		const approve = memory_store();
		const approved = await call(approve, almacen, LLAMADAS.approve);
		expect(approved.status).toBe(200);
		expect((await approved.json()).message).toBe('Orden de compra aprobada correctamente');
		expect((await approve.find_id('purchase-order', PO_APROBAR))?.estado).toBe('aprobada');

		const confirm = memory_store();
		const confirmed = await call(confirm, almacen, LLAMADAS.confirm);
		expect(confirmed.status).toBe(200);
		expect((await confirmed.json()).message).toBe('Orden de compra confirmada correctamente');
		expect((await confirm.find_id('products', PRODUCTO))?.existencia).toBe(13);

		const reception = memory_store();
		const received = await call(reception, almacen, LLAMADAS.confirm_reception);
		expect(received.status).toBe(200);
		expect((await received.json()).message).toBe('Recepción confirmada correctamente');

		const count = memory_store();
		const applied = await call(count, almacen, LLAMADAS.aplicar);
		expect(applied.status).toBe(200);
		expect((await applied.json()).message).toBe('Conteo aplicado correctamente');

		const transfer = memory_store();
		const moved = await call(transfer, almacen, LLAMADAS.register_transfer);
		expect(moved.status).toBe(200);
		expect((await moved.json()).message).toBe('Traslado registrado correctamente');

		const repair = memory_store();
		const repaired = await call(repair, almacen, LLAMADAS.reparar);
		expect(repaired.status).toBe(200);
		expect((await repair.find_id('products', PRODUCTO))?.existencia).toBe(13);
	});

	test('el admin de semilla sigue pudiendo', async () => {
		for (const spec of Object.values(LLAMADAS)) {
			const store = memory_store();
			const res = await call(store, admin, spec);
			expect(res.status).toBe(200);
		}
	});

	test('la semilla deja a Almacén y Surtidores el permiso que estas acciones piden', () => {
		const seed = readFileSync(
			join(import.meta.dir, '../../../../backend/src/components/user-group/module.data.ts'),
			'utf8',
		);
		for (const ref of [
			'almacen-access-rights-purchase-order',
			'almacen-access-rights-inventory-reception',
			'almacen-access-rights-inventory-physical-count',
			'almacen-access-rights-inventory-movement',
			'almacen-access-rights-inventory-stock-quant',
			'surtidores-access-rights-inventory-reception',
			'almacen-access-rights-inventory-internal-location',
		]) {
			expect(seed).toContain(ref);
		}
	});
});
