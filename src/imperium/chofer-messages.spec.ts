import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CHOFER_SIN_EMPLEADO_MESSAGE } from './chofer-messages.ts';

describe('Cola chofer sin empleado vinculado', () => {
	test('el aviso le habla al chofer y no le pide configurar Usuarios', () => {
		expect(CHOFER_SIN_EMPLEADO_MESSAGE).toStartWith('Tu usuario');
		expect(CHOFER_SIN_EMPLEADO_MESSAGE).toContain('administrador');
		expect(CHOFER_SIN_EMPLEADO_MESSAGE).not.toContain('Configúralo');
	});

	test('la cola y las rutas del chofer usan el mismo aviso', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		for (const fn of ['async function read_chofer_queue', 'async function delivery_chofer_routes']) {
			const start = src.indexOf(fn);
			expect(start).toBeGreaterThan(-1);
			const body = src.slice(start, src.indexOf('\n}\n', start));
			expect(body).toContain('CHOFER_SIN_EMPLEADO_MESSAGE');
			expect(body).not.toContain('Configúralo en Usuarios');
		}
	});
});
