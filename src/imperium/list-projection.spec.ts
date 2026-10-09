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

	test('Es Proveedor de contacto se lista como Boolean y el nombre sigue texto', () => {
		const tipo = list_instance_type('contacto');
		expect(tipo?.esProveedor).toEqual({
			nombre_encabezado: 'esProveedor',
			tipo: 'Boolean',
		});
		expect(tipo?.name.tipo).toBe('string');
		expect(tipo?.esCliente).toBeUndefined();
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

describe('listas de Logística sin la columna del id interno', () => {
	for (const resource of ['delivery-package', 'delivery-route']) {
		test(`${resource}: el id viaja en la fila pero no es columna`, () => {
			const tipo = list_instance_type(resource) ?? {};
			expect(Object.keys(tipo)).not.toContain('_id');
			expect(Object.keys(tipo)).toContain('name');
			expect(list_projection_keys(resource)).toContain('_id');
			const [row] = project_list_docs(resource, [{ _id: 'x1', name: 'B-1' }]);
			expect(row?._id).toBe('x1');
		});
	}

	test('Bultos sigue mostrando vehículo y ruta', () => {
		const tipo = list_instance_type('delivery-package') ?? {};
		expect(Object.keys(tipo)).toContain('vehicle_nombre');
		expect(Object.keys(tipo)).toContain('delivery_route_nombre');
	});
});
