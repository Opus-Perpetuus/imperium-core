import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { register_pos_ticket_exit } from './inventory-exit.ts';
import { list_instance_type, project_list_docs } from './list-projection.ts';
import {
	kit_components_of,
	normalize_price_scales,
	normalize_product_rules,
	normalize_promotions,
	normalize_unit_conversions,
} from './pos-product-rules.ts';
import { prepare_product_write } from './products-flow.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = seed;
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where || Object.entries(where).every(([k, v]) => row[k] === v);
	return {
		data,
		has: (r: string) => Object.hasOwn(data, r),
		async find_id(r: string, id: string) {
			return (data[r] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async find_where(r: string, where: Record<string, unknown>) {
			return (data[r] ?? []).find((row) => matches(row, where)) ?? null;
		},
		async find_many(r: string, o: { where?: Record<string, unknown>; take?: number } = {}) {
			const rows = (data[r] ?? []).filter((row) => matches(row, o.where));
			return { rows: rows.slice(0, o.take ?? rows.length), total: rows.length };
		},
		async *scan(r: string, o: { where?: Record<string, unknown> } = {}) {
			yield (data[r] ?? []).filter((row) => matches(row, o.where));
		},
		async insert(r: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${(data[r] ?? []).length + 1}` };
			(data[r] ??= []).push(row);
			return row;
		},
		async update(r: string, id: string, patch: Row) {
			const rows = data[r] ?? [];
			const i = rows.findIndex((row) => String(row._id) === String(id));
			if (i < 0) return null;
			rows[i] = { ...rows[i], ...patch, _id: id };
			return rows[i];
		},
	} as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

describe('reglas de venta por producto', () => {
	test('precios por escala: ordenados, sin repetir, desde > 1', () => {
		expect(normalize_price_scales([{ desde: 12, precio: 8 }, { desde: '6', precio: '9.005' }])).toEqual([
			{ desde: 6, precio: 9.01 },
			{ desde: 12, precio: 8 },
		]);
		expect(() => normalize_price_scales([{ desde: 1, precio: 5 }])).toThrow(/mayor a 1/);
		expect(() => normalize_price_scales([{ desde: 3, precio: 5 }, { desde: 3, precio: 4 }])).toThrow(/repetido/);
		expect(normalize_price_scales(null)).toEqual([]);
		expect(normalize_price_scales('')).toEqual([]);
	});

	test('promociones: porcentaje, precio y NxM con vigencia', () => {
		expect(
			normalize_promotions([
				{ tipo: 'porcentaje', valor: 10, desde: '2026-10-01', hasta: '2026-10-31T00:00:00Z' },
				{ tipo: 'NXM', n: 3, m: 2, nombre: '3x2' },
			]),
		).toEqual([
			{ nombre: 'porcentaje', tipo: 'porcentaje', valor: 10, desde: '2026-10-01', hasta: '2026-10-31' },
			{ nombre: '3x2', tipo: 'nxm', n: 3, m: 2, desde: '', hasta: '' },
		]);
		expect(() => normalize_promotions([{ tipo: 'regalo' }])).toThrow(/inválido/);
		expect(() => normalize_promotions([{ tipo: 'porcentaje', valor: 100 }])).toThrow(/entre 0 y 100/);
		expect(() => normalize_promotions([{ tipo: 'nxm', n: 2, m: 2 }])).toThrow(/N mayor que M/);
		expect(() => normalize_promotions([{ tipo: 'precio', valor: 5, desde: '2026-10-10', hasta: '2026-10-01' }])).toThrow(/antes de empezar/);
	});

	test('conversiones: unidad, factor distinto de 1 y códigos únicos', () => {
		expect(normalize_unit_conversions([{ unidad: 'caja', factor: '12', codigo: ' 750123 ' }])).toEqual([
			{ unidad: 'caja', factor: 12, codigo: '750123' },
		]);
		expect(() => normalize_unit_conversions([{ unidad: 'caja', factor: 1 }])).toThrow(/factor/);
		expect(() => normalize_unit_conversions([{ factor: 2 }])).toThrow(/unidad/);
		expect(() =>
			normalize_unit_conversions([
				{ unidad: 'caja', factor: 12, codigo: 'X' },
				{ unidad: 'paquete', factor: 6, codigo: 'X' },
			]),
		).toThrow(/repetido/);
	});

	test('kits: componentes existentes, sin sí mismo ni kits dentro de kits; suma repetidos', async () => {
		const store = memory_store({
			products: [
				{ _id: 'a', name: 'Tornillo' },
				{ _id: 'b', name: 'Taquete' },
				{ _id: 'k2', name: 'Otro kit', kit_componentes: [{ producto: 'a', cantidad: 1 }] },
			],
		});
		const out = await normalize_product_rules(store, { kit_componentes: [{ producto: 'a', cantidad: 4 }, { producto: { _id: 'a' }, cantidad: 2 }, { producto: 'b', cantidad: 6 }] }, 'k1');
		expect(out.kit_componentes).toEqual([
			{ producto: 'a', producto_nombre: 'Tornillo', cantidad: 6 },
			{ producto: 'b', producto_nombre: 'Taquete', cantidad: 6 },
		]);
		await expect(normalize_product_rules(store, { kit_componentes: [{ producto: 'k1', cantidad: 1 }] }, 'k1')).rejects.toThrow(/sí mismo/);
		await expect(normalize_product_rules(store, { kit_componentes: [{ producto: 'k2', cantidad: 1 }] }, 'k1')).rejects.toThrow(/kits dentro de kits/);
		await expect(normalize_product_rules(store, { kit_componentes: [{ producto: 'zz', cantidad: 1 }] }, 'k1')).rejects.toThrow(/no existe/);
		const plain = { name: 'Sin reglas' };
		expect(await prepare_product_write(store, plain)).toEqual(plain);
	});

	test('vender un kit descuenta sus componentes y no el kit', async () => {
		const store = memory_store({
			products: [
				{ _id: 'a', name: 'Tornillo', existencia: 100 },
				{ _id: 'b', name: 'Taquete', existencia: 10 },
				{ _id: 'k', name: 'Kit', existencia: 0, kit_componentes: [{ producto: 'a', cantidad: 6 }, { producto: 'b', cantidad: 6 }] },
				{ _id: 'c', name: 'Clavo', existencia: 5 },
			],
			'inventory-movement': [],
			'inventory-stock-quant': [],
			'inventory-internal-location': [{ _id: 'alm', name: 'Almacén', _ref: 'inventory-internal-location-warehouse' }],
		});
		await register_pos_ticket_exit(store, {
			_id: 't1',
			ticket_type: 'VENTA',
			items: [
				{ item_id: 'k', quantity: 2 },
				{ item_id: 'c', quantity: 1 },
			],
		});
		expect(store.data.products.map((p) => p.existencia)).toEqual([88, 0, 0, 4]);
		expect(store.data['inventory-movement'].map((m) => [m.producto, m.cantidad])).toEqual([
			['a', 12],
			['b', 12],
			['c', 1],
		]);
		expect(kit_components_of({ kit_componentes: 'no-json' })).toEqual([]);
	});

	test('el listado de productos trae las reglas sin agregar columnas a la tabla', () => {
		const [row] = project_list_docs('products', [{ _id: 'p', name: 'X', precios_escala: [{ desde: 6, precio: 9 }], payload: {} }]);
		expect(row).toEqual({ _id: 'p', name: 'X', precios_escala: [{ desde: 6, precio: 9 }] });
		const tipo = Object.keys(list_instance_type('products') ?? {});
		expect(tipo).toContain('codigo');
		expect(tipo).not.toContain('precios_escala');
		expect(tipo).not.toContain('kit_componentes');
	});
});
