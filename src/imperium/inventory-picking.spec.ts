import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { compute_picking_route } from './inventory-picking.ts';
import type { ImperiumStore } from './store.ts';

const PRODUCTO = '507f1f77bcf86cd799439011';
const ALMACEN_1A = '507f1f77bcf86cd799439021';
const ALMACEN_VENDEDOR = '507f1f77bcf86cd799439022';

function memory_store(seed: Record<string, ImperiumDoc[]>): ImperiumStore {
	const data: Record<string, ImperiumDoc[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	const matches = (row: ImperiumDoc, where?: Record<string, unknown>) =>
		!where ||
		Object.entries(where).every(([key, value]) => row[key] === value);
	return {
		has: (resource: string) => Object.hasOwn(data, resource),
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === id) ?? null;
		},
		async find_many(
			resource: string,
			opts: { where?: Record<string, unknown>; ids?: string[]; include_inactive?: boolean } = {},
		) {
			const rows = (data[resource] ?? []).filter((row) => {
				if (opts.include_inactive === false && row.is_active === false) return false;
				if (opts.ids && !opts.ids.includes(String(row._id))) return false;
				return matches(row, opts.where);
			});
			return { rows, total: rows.length };
		},
		async *scan(
			resource: string,
			opts: { where?: Record<string, unknown>; include_inactive?: boolean } = {},
		) {
			yield (data[resource] ?? []).filter((row) => {
				if (!opts.include_inactive && row.is_active === false) return false;
				return matches(row, opts.where);
			});
		},
	} as unknown as ImperiumStore;
}

function store_dos_almacenes(extra: ImperiumDoc[] = []) {
	return memory_store({
		'inventory-stock-quant': [
			{
				_id: 'q-1a',
				producto: PRODUCTO,
				ubicacion: ALMACEN_1A,
				ubicacion_codigo: 'ALMACEN1A',
				cantidad: 4,
				cantidad_disponible: 4,
			},
			{
				_id: 'q-vend',
				producto: PRODUCTO,
				ubicacion: ALMACEN_VENDEDOR,
				ubicacion_codigo: 'ALMACENPRUEBAALBAALMACEN',
				cantidad: 1,
				cantidad_disponible: 1,
				lote: 'lot-a',
				lote_codigo: 'PRUEBA-A',
				fecha_caducidad: '2027-06-01',
			},
			...extra,
		],
		'inventory-internal-location': [
			{ _id: ALMACEN_1A, codigo: 'ALMACEN1A', secuencia_surtido: 0 },
			{ _id: ALMACEN_VENDEDOR, codigo: 'ALMACENPRUEBAALBAALMACEN', secuencia_surtido: 0 },
		],
	});
}

describe('ruta de surtido del almacén del pedido', () => {
	test('sin almacén elige ALMACEN1A, que tiene más existencia', async () => {
		const ruta = await compute_picking_route(store_dos_almacenes(), PRODUCTO, 1);
		expect(ruta.renglones[0]?.ubicacion_codigo).toBe('ALMACEN1A');
		expect(ruta.renglones[0]?.lote_codigo ?? '').toBe('');
	});

	test('con el almacén del pedido muestra su ubicación y el lote PRUEBA-A', async () => {
		const ruta = await compute_picking_route(store_dos_almacenes(), PRODUCTO, 1, {
			ubicaciones: new Set([ALMACEN_VENDEDOR]),
		});
		expect(ruta.renglones).toEqual([
			{
				ubicacion: ALMACEN_VENDEDOR,
				ubicacion_codigo: 'ALMACENPRUEBAALBAALMACEN',
				disponible: 1,
				tomar: 1,
				lote: 'lot-a',
				lote_codigo: 'PRUEBA-A',
				fecha_caducidad: '2027-06-01',
			},
		]);
		expect(ruta.faltante).toBe(0);
	});

	test('en la misma ubicación sale primero la fila sin lote y luego la caducidad', async () => {
		const ruta = await compute_picking_route(
			store_dos_almacenes([
				{
					_id: 'q-sin',
					producto: PRODUCTO,
					ubicacion: ALMACEN_VENDEDOR,
					ubicacion_codigo: 'ALMACENPRUEBAALBAALMACEN',
					cantidad: 1,
					cantidad_disponible: 1,
					lote: '',
					lote_codigo: '',
					fecha_caducidad: '',
				},
				{
					_id: 'q-tarde',
					producto: PRODUCTO,
					ubicacion: ALMACEN_VENDEDOR,
					ubicacion_codigo: 'ALMACENPRUEBAALBAALMACEN',
					cantidad: 1,
					cantidad_disponible: 1,
					lote: 'lot-b',
					lote_codigo: 'TARDE',
					fecha_caducidad: '2028-01-01',
				},
			]),
			PRODUCTO,
			3,
			{ ubicaciones: new Set([ALMACEN_VENDEDOR]) },
		);
		expect(ruta.renglones.map((row) => row.lote_codigo)).toEqual(['', 'PRUEBA-A', 'TARDE']);
	});
});
