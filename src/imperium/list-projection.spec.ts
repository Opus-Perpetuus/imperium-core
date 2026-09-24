import { describe, expect, test } from 'bun:test';
import {
	list_instance_type,
	list_projection_keys,
	project_list_docs,
} from './list-projection.ts';

describe('proyección de lista de turnos', () => {
	test('priority_level viaja en la fila para ordenar «Próximos» del tablero', () => {
		expect(list_projection_keys('ticketing-system-turn')).toContain('priority_level');
		const [row] = project_list_docs('ticketing-system-turn', [
			{
				_id: 't1',
				name: 'D001',
				status: 'pendiente',
				priority_level: 3,
				createdAt: '2026-09-24T10:00:00.000Z',
				time_box: [],
			},
		]);
		expect(row?.priority_level).toBe(3);
		expect(row?.createdAt).toBe('2026-09-24T10:00:00.000Z');
		expect(row).not.toHaveProperty('time_box');
	});

	test('la lista de turnos no gana una columna nueva', () => {
		expect(Object.keys(list_instance_type('ticketing-system-turn') ?? {})).toEqual([
			'_id',
			'name',
			'description',
			'movements',
			'customer_type',
			'assigned_box',
			'services',
			'status',
			'time',
			'createdAt',
		]);
	});
});
