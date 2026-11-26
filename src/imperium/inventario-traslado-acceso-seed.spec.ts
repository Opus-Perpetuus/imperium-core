import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	ALMACEN_INVENTARIO_ACCESS_RIGHTS,
	ensure_almacen_traslado_access,
} from './inventario-traslado-acceso-seed.ts';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]> = {}) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	const inserts: Array<{ resource: string; doc: Row }> = [];
	const updates: Array<{ resource: string; id: string; patch: Row }> = [];
	const store = {
		data,
		inserts,
		updates,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async *scan(resource: string) {
			yield (data[resource] ?? []).map((row) => ({ ...row }));
		},
		async insert(resource: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${crypto.randomUUID()}` };
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			inserts.push({ resource, doc: row });
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch, _id: id };
			updates.push({ resource, id, patch });
			return rows[index];
		},
	};
	return store as unknown as ImperiumStore & {
		data: Record<string, Row[]>;
		inserts: Array<{ resource: string; doc: Row }>;
		updates: Array<{ resource: string; id: string; patch: Row }>;
	};
}

describe('permisos de traslado del grupo Almacén', () => {
	test('siembra las filas que faltan', async () => {
		const store = memory_store({ 'access-rights': [] });
		const result = await ensure_almacen_traslado_access(store);
		expect(result.rights).toEqual(ALMACEN_INVENTARIO_ACCESS_RIGHTS.map((row) => row._ref));
		expect(result.patched).toEqual([]);
		const movimiento = store.data['access-rights'].find(
			(row) => row._ref === 'almacen-access-rights-inventory-movement',
		);
		expect(movimiento).toMatchObject({
			group_id: 'user-group-almacen',
			allow_read: true,
			allow_create: true,
			allow_update: true,
		});
	});

	test('es idempotente si las banderas ya están bien', async () => {
		const store = memory_store({ 'access-rights': [] });
		await ensure_almacen_traslado_access(store);
		store.inserts.length = 0;
		const second = await ensure_almacen_traslado_access(store);
		expect(second.rights).toEqual([]);
		expect(second.patched).toEqual([]);
		expect(store.inserts).toHaveLength(0);
		expect(store.updates).toHaveLength(0);
	});

	test('corrige una fila existente que no deja trasladar', async () => {
		const store = memory_store({
			'access-rights': [
				{
					_id: 'ar-mov',
					_ref: 'almacen-access-rights-inventory-movement',
					model_id: 'InventoryMovement',
					group_id: 'user-group-almacen',
					allow_read: true,
					allow_create: false,
					allow_update: false,
					allow_delete: false,
					is_active: true,
				},
			],
		});
		const result = await ensure_almacen_traslado_access(store);
		expect(result.rights).toEqual(['almacen-access-rights-inventory-stock-quant']);
		expect(result.patched).toEqual(['almacen-access-rights-inventory-movement']);
		expect(store.data['access-rights'][0]).toMatchObject({
			allow_create: true,
			allow_update: true,
		});
	});

	test('configuration-seed-sync llama esta siembra sin tumbar el resto', () => {
		const src = readFileSync(new URL('./configuration-seed-sync.ts', import.meta.url), 'utf8');
		const devoluciones = src.indexOf('await ensure_devoluciones_access(store)');
		const traslado = src.indexOf('await ensure_almacen_traslado_access(store)');
		const subjects = src.indexOf('await ensure_installed_subject_menus(');
		expect(traslado).toBeGreaterThan(devoluciones);
		expect(subjects).toBeGreaterThan(traslado);
		expect(src.slice(traslado - 80, subjects)).toContain('try {');
		expect(src).toContain('No se pudieron sembrar los permisos de traslados de Almacén');
	});
});
