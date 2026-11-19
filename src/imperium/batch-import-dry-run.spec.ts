import { describe, expect, test } from 'bun:test';
import { run_batch_import } from './batch-import.ts';

const existing = [
	{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Ana', email: 'ana@x.mx' },
	{ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Beto', email: 'beto@x.mx' },
];

function fake_store() {
	return {
		field_refs: () => ({}),
		column_names: () => new Set(['email']),
		find_id: async (_r: string, id: string) => existing.find((row) => row._id === id) ?? null,
		find_many: async (_r: string, opts: { where: Record<string, unknown> }) => {
			const [[field, value]] = Object.entries(opts.where);
			return { rows: existing.filter((row) => (row as Record<string, unknown>)[field] === value) };
		},
	};
}

const rows = [
	{ name: 'Ana', telefono: '1' },
	{ name: 'Carla' },
	{ name: 'Otra', email: 'beto@x.mx' },
	{ name: 'Ana', email: 'beto@x.mx' },
	{ is_active: 'quizá' },
];

describe('importación en lote: simulación (#458)', () => {
	test('marca crear, actualizar y error sin persistir nada', async () => {
		const writes: string[] = [];
		const result = (await run_batch_import({
			store: fake_store() as never,
			resource: 'contacto',
			rows,
			match_field: 'email',
			dry_run: true,
			persist_create: async (doc) => {
				writes.push('create');
				return doc;
			},
			persist_update: async (id, doc) => {
				writes.push(`update ${id}`);
				return doc;
			},
		})) as Record<string, any>;
		expect(writes).toEqual([]);
		expect(result.dry_run).toBe(true);
		expect(result.success.map((r: any) => [r.row, r.operation, r._id])).toEqual([
			[1, 'update', 'aaaaaaaaaaaaaaaaaaaaaaaa'],
			[2, 'create', null],
			[3, 'update', 'bbbbbbbbbbbbbbbbbbbbbbbb'],
		]);
		expect(result.errors.map((r: any) => r.row)).toEqual([4, 5]);
		expect(result.summary).toMatchObject({ created: 1, updated: 2, failed: 2 });
	});

	test('la simulación coincide con la importación real fila por fila', async () => {
		const params = {
			store: fake_store() as never,
			resource: 'contacto',
			rows,
			match_field: 'email',
			persist_create: async (doc: Record<string, unknown>) => ({ ...doc, _id: 'nuevo' }),
			persist_update: async (id: string, doc: Record<string, unknown>) => ({ ...doc, _id: id }),
		};
		const dry = (await run_batch_import({ ...params, dry_run: true })) as Record<string, any>;
		const real = (await run_batch_import(params)) as Record<string, any>;
		const ops = (r: any) => r.success.map((s: any) => [s.row, s.operation]);
		expect(ops(dry)).toEqual(ops(real));
		expect(dry.errors.map((e: any) => e.row)).toEqual(real.errors.map((e: any) => e.row));
		expect(real.summary).toMatchObject({ created: 1, updated: 2 });
	});
});
