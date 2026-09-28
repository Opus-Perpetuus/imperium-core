import { describe, expect, test } from 'bun:test';
import { run_default_seed_steps } from './module-data.ts';

describe('seed-default-data', () => {
	test('suma lo creado por cada paso', async () => {
		const r = await run_default_seed_steps([
			{ module: 'Configuración', run: async () => 2 },
			{ module: 'Menús de apps', run: async () => 3 },
		]);
		expect(r.data[0]).toEqual({ modules_reviewed: 2, documents_created: 5, errors: [] });
		expect(r.message).toContain('5');
	});

	test('un paso que falla no aborta el resto y queda reportado', async () => {
		const r = await run_default_seed_steps([
			{ module: 'Roto', run: async () => { throw new Error('tabla ausente'); } },
			{ module: 'Sano', run: async () => 1 },
		]);
		expect(r.data[0]).toEqual({
			modules_reviewed: 2,
			documents_created: 1,
			errors: [{ module: 'Roto', message: 'tabla ausente' }],
		});
		expect(r.message).toContain('1 módulo(s) con error');
	});

	test('informa cuando no faltaba nada', async () => {
		const r = await run_default_seed_steps([{ module: 'Configuración', run: async () => 0 }]);
		expect(r.data[0].documents_created).toBe(0);
		expect(r.message).toContain('No faltaba ningún documento');
	});
});
