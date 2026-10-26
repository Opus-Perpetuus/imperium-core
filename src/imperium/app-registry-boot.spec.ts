import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { APP_REGISTRY_ENABLED_REF } from './app-registry.ts';
import {
	ensure_app_registry_enabled,
	start_registry_cold_sync,
} from './app-registry-boot.ts';
import type { ImperiumStore } from './store.ts';

const PREVIOUS = process.env.IMPERIUM_APP_REGISTRY;

afterEach(() => {
	if (PREVIOUS == null) delete process.env.IMPERIUM_APP_REGISTRY;
	else process.env.IMPERIUM_APP_REGISTRY = PREVIOUS;
});

type Row = { _id?: string; _ref?: string; value?: unknown; id?: string };

function memory_store(initial: Row | null): ImperiumStore & {
	rows: Map<string, Row>;
	updates: Array<{ id: string; patch: Record<string, unknown> }>;
	inserts: Row[];
} {
	const rows = new Map<string, Row>();
	if (initial?._ref) rows.set(initial._ref, { ...initial });
	const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const inserts: Row[] = [];
	return {
		rows,
		updates,
		inserts,
		has: (resource: string) => resource === 'configuration',
		find_where: async (_resource: string, where: { _ref?: string }) => {
			const ref = String(where._ref ?? '');
			return rows.get(ref) ?? null;
		},
		update: async (_resource: string, id: string, patch: Record<string, unknown>) => {
			updates.push({ id, patch });
			for (const [ref, row] of rows) {
				if (String(row._id ?? row.id) === id) {
					rows.set(ref, { ...row, ...patch });
				}
			}
			return { _id: id, ...patch };
		},
		insert: async (_resource: string, doc: Row) => {
			inserts.push(doc);
			const ref = String(doc._ref ?? '');
			const saved = { _id: doc._id ?? `cfg-${rows.size + 1}`, ...doc };
			rows.set(ref, saved);
			return saved;
		},
	} as unknown as ImperiumStore & {
		rows: Map<string, Row>;
		updates: Array<{ id: string; patch: Record<string, unknown> }>;
		inserts: Row[];
	};
}

describe('ensure_app_registry_enabled (migración estática→dynamic)', () => {
	test('enciende flag false → true (idempotente; no toca otras colecciones)', async () => {
		const store = memory_store({
			_id: 'cfg-1',
			_ref: APP_REGISTRY_ENABLED_REF,
			value: false,
		});
		const first = await ensure_app_registry_enabled(store);
		expect(first.enabled).toBe(true);
		expect(first.flipped).toBe(true);
		expect(store.updates).toEqual([{ id: 'cfg-1', patch: { value: true } }]);
		expect(store.inserts).toEqual([]);

		const second = await ensure_app_registry_enabled(store);
		expect(second.enabled).toBe(true);
		expect(second.flipped).toBe(false);
		expect(store.updates).toHaveLength(1);
	});

	test('inserta la fila si falta', async () => {
		const store = memory_store(null);
		const result = await ensure_app_registry_enabled(store);
		expect(result.enabled).toBe(true);
		expect(result.flipped).toBe(true);
		expect(store.inserts[0]).toMatchObject({
			_ref: APP_REGISTRY_ENABLED_REF,
			value: true,
			type: 'switch',
		});
	});

	test('IMPERIUM_APP_REGISTRY=0 no escribe y deja off', async () => {
		process.env.IMPERIUM_APP_REGISTRY = '0';
		const store = memory_store({
			_id: 'cfg-1',
			_ref: APP_REGISTRY_ENABLED_REF,
			value: false,
		});
		const result = await ensure_app_registry_enabled(store);
		expect(result.enabled).toBe(false);
		expect(result.flipped).toBe(false);
		expect(store.updates).toEqual([]);
		expect(store.inserts).toEqual([]);
	});
});

describe('start_registry_cold_sync', () => {
	test('enciende flag y luego invoca sync de manifiestos instalados', async () => {
		const store = memory_store({
			_id: 'cfg-1',
			_ref: APP_REGISTRY_ENABLED_REF,
			value: false,
		});
		const queries: string[] = [];
		const sql = {
			unsafe: async (query: string) => {
				queries.push(query);
				// sin installs → sync no escribe snapshots; valida que se consultó subject_installs
				return [];
			},
		} as unknown as Bun.SQL;

		await start_registry_cold_sync(store, sql);
		expect(store.updates).toEqual([{ id: 'cfg-1', patch: { value: true } }]);
		expect(queries.some((q) => q.includes('subject_installs'))).toBe(true);
	});

	test('con env=0 no consulta installs', async () => {
		process.env.IMPERIUM_APP_REGISTRY = '0';
		const store = memory_store({
			_id: 'cfg-1',
			_ref: APP_REGISTRY_ENABLED_REF,
			value: false,
		});
		const queries: string[] = [];
		const sql = {
			unsafe: async (query: string) => {
				queries.push(query);
				return [];
			},
		} as unknown as Bun.SQL;
		await start_registry_cold_sync(store, sql);
		expect(queries).toEqual([]);
		expect(store.updates).toEqual([]);
	});
});

describe('enganche router + seed', () => {
	test('el arranque sigue disparando cold-sync (que ahora migra el flag)', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		expect(src).toContain('start_registry_cold_sync');
		const boot = readFileSync(new URL('./app-registry-boot.ts', import.meta.url), 'utf8');
		expect(boot).toContain('ensure_app_registry_enabled');
	});

	test('seed default del registro es true', () => {
		const seeds = JSON.parse(
			readFileSync(new URL('./configuration-parameter-seeds.json', import.meta.url), 'utf8'),
		) as Array<{ _ref: string; value: unknown }>;
		expect(
			seeds.find((row) => row._ref === 'configuration-app-registry-enabled')?.value,
		).toBe(true);
	});
});
