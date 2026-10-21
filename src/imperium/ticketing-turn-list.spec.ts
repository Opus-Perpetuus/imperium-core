import { describe, expect, test } from 'bun:test';
import { list_instance_type, project_list_docs } from './list-projection.ts';

describe('lista de turnos: columna «Tiempo» (#180, PR 418)', () => {
	test('muestra la fecha del último movimiento, no el arreglo', () => {
		const [row] = project_list_docs('ticketing-system-turn', [
			{
				_id: 't1',
				name: 'A001',
				time: ['2026-10-20T15:00:00.000Z', '2026-10-20T15:04:00.000Z'],
				time_box: ['2026-10-20T15:00:00.000Z'],
			},
		]);
		expect(row?.time).toBe('2026-10-20T15:04:00.000Z');
		expect(row?.time_box).toBeUndefined();
	});

	test('acepta el arreglo guardado como texto y el turno sin movimientos', () => {
		const rows = project_list_docs('ticketing-system-turn', [
			{ _id: 't2', time: JSON.stringify(['2026-10-20T16:00:00.000Z', '2026-10-20T16:06:00.000Z']) },
			{ _id: 't3', time: [] },
		]);
		expect(rows.map((row) => row.time)).toEqual(['2026-10-20T16:06:00.000Z', null]);
	});

	test('la tabla la pinta como fecha', () => {
		expect(list_instance_type('ticketing-system-turn')?.time?.tipo).toBe('Date');
		expect(list_instance_type('ticketing-system-turn')?.name?.tipo).toBe('string');
	});
});
