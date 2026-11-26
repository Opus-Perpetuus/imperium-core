import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import {
	INTERACTIVE_MANUAL_RESOURCE,
	load_interactive_manual_seeds,
	seed_interactive_manuals,
} from './interactive-manual-seed.ts';
import schema_enum from './schema-enum.json';

function memory_store(rows: ImperiumDoc[] = [], installed = true) {
	const data = rows.map((row) => ({ ...row }));
	return {
		data,
		has: (resource: string) => installed && resource === INTERACTIVE_MANUAL_RESOURCE,
		async *scan(_resource: string, _opts: unknown) {
			yield data.map((row) => ({ ...row }));
		},
		async insert(_resource: string, doc: ImperiumDoc) {
			const row = { ...doc, _id: `id-${data.length + 1}` };
			data.push(row);
			return row;
		},
	};
}

describe('semillas del manual interactivo', () => {
	const seeds = load_interactive_manual_seeds();

	test('trae las guías de los feature maps con _ref único y válidas para el esquema', () => {
		expect(seeds.length).toBeGreaterThanOrEqual(36);
		const refs = seeds.map((s) => String(s._ref));
		expect(new Set(refs).size).toBe(refs.length);
		const enums = (schema_enum as Record<string, Record<string, Record<string, { values: string[] }>>>)
			.enum['interactive-manual']!;
		for (const seed of seeds) {
			expect(String(seed.name).length).toBeGreaterThanOrEqual(4);
			expect(String(seed.description ?? '').length).toBeLessThanOrEqual(500);
			const steps = seed.steps as Record<string, unknown>[];
			expect(steps.length).toBeGreaterThan(0);
			for (const step of steps) {
				expect(enums['steps.action_hint']!.values).toContain(String(step.action_hint));
				expect(enums['steps.placement']!.values).toContain(String(step.placement));
				// Datos de la corrida de prueba (ids, PIN) nunca llegan a una instancia.
				expect(JSON.stringify(step)).not.toContain('{{');
			}
		}
	});

	test('crea las que faltan y no duplica ni pisa en la segunda pasada', async () => {
		const editada = { _id: 'x', _ref: String(seeds[0]!._ref), name: 'Editada', is_active: false };
		const store = memory_store([editada]);
		const created = await seed_interactive_manuals(store, seeds);
		expect(created).toBe(seeds.length - 1);
		expect(store.data.find((r) => r._id === 'x')).toEqual(editada);
		expect(await seed_interactive_manuals(store, seeds)).toBe(0);
		expect(store.data.length).toBe(seeds.length);
	});

	test('reconoce el _ref guardado como columna ref', async () => {
		const store = memory_store([{ _id: 'y', ref: String(seeds[1]!._ref) }]);
		expect(await seed_interactive_manuals(store, seeds.slice(0, 2))).toBe(1);
	});

	test('sin tabla de manuales no hace nada', async () => {
		expect(await seed_interactive_manuals(memory_store([], false), seeds)).toBe(0);
	});
});
