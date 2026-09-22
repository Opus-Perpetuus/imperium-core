import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import {
	documentation_page_key,
	plan_documentation_sync,
} from './documentation-sync.ts';

const row = (
	id: string,
	slug: string,
	folder_path = '',
	is_active = true,
): ImperiumDoc =>
	({ _id: id, slug, folder_path, is_active }) as unknown as ImperiumDoc;

describe('plan_documentation_sync', () => {
	test('la primera corrida inserta todo', () => {
		const plan = plan_documentation_sync([], [
			{ slug: 'bienvenida', folder_path: '' },
			{ slug: 'guia', folder_path: 'manual' },
		]);
		expect(plan.insert.length).toBe(2);
		expect(plan.update.length).toBe(0);
		expect(plan.deactivate.length).toBe(0);
	});

	test('reutiliza la fila existente en vez de reinsertar la misma clave', () => {
		const plan = plan_documentation_sync(
			[row('1', 'bienvenida')],
			[{ slug: 'bienvenida', folder_path: '' }],
		);
		expect(plan.update).toEqual([
			{ id: '1', doc: { slug: 'bienvenida', folder_path: '' } },
		]);
		expect(plan.insert.length).toBe(0);
		expect(plan.deactivate.length).toBe(0);
	});

	/*
	 * El caso que rompía: `remove` es lógico, así que la fila inactiva sigue
	 * ocupando la clave del único compuesto. Insertar de nuevo daba
	 * "duplicate key value violates unique constraint
	 * uq_documentation_page_slug_folder_path".
	 */
	test('una fila desactivada se reaprovecha, no se vuelve a insertar', () => {
		const plan = plan_documentation_sync(
			[row('1', 'bienvenida', '', false)],
			[{ slug: 'bienvenida', folder_path: '' }],
		);
		expect(plan.insert.length).toBe(0);
		expect(plan.update.map((u) => u.id)).toEqual(['1']);
	});

	test('lo que ya no viene en el lote se desactiva', () => {
		const plan = plan_documentation_sync(
			[row('1', 'bienvenida'), row('2', 'vieja')],
			[{ slug: 'bienvenida', folder_path: '' }],
		);
		expect(plan.update.map((u) => u.id)).toEqual(['1']);
		expect(plan.deactivate).toEqual(['2']);
	});

	test('distingue mismo slug en carpetas distintas', () => {
		const plan = plan_documentation_sync(
			[row('1', 'guia', 'manual')],
			[
				{ slug: 'guia', folder_path: 'manual' },
				{ slug: 'guia', folder_path: 'anexos' },
			],
		);
		expect(plan.update.map((u) => u.id)).toEqual(['1']);
		expect(plan.insert).toEqual([{ slug: 'guia', folder_path: 'anexos' }]);
	});

	test('duplicados heredados: solo uno se reaprovecha, el resto se desactiva', () => {
		const plan = plan_documentation_sync(
			[row('1', 'bienvenida'), row('2', 'bienvenida', '', false)],
			[{ slug: 'bienvenida', folder_path: '' }],
		);
		expect(plan.update.map((u) => u.id)).toEqual(['1']);
		expect(plan.deactivate).toEqual(['2']);
		expect(plan.insert.length).toBe(0);
	});

	test('la clave separa slug de folder_path sin ambigüedad', () => {
		expect(documentation_page_key({ slug: 'a', folder_path: 'b' })).not.toBe(
			documentation_page_key({ slug: 'ab', folder_path: '' }),
		);
	});
});
