import { describe, expect, test } from 'bun:test';
import { project_list_docs } from './list-projection.ts';
import { with_box_service_letters } from './ticketing-turn-flow.ts';

const services = new Map([
	['s1', { _id: 's1', name: 'Agua Potable', letter: 'ap' }],
	['s2', { _id: 's2', name: 'General', letter: 'G' }],
	['s3', { _id: 's3', name: 'Sin letra', letter: '' }],
]);

describe('administrador de cajas: letra del consecutivo de cada servicio (Odoo #377)', () => {
	test('cada servicio permitido trae la letra del folio y la lista las resume', () => {
		const [box] = with_box_service_letters(
			[{ _id: 'b1', name: 'Caja 1', allowed_services: [{ _id: 's1', name: 'Agua Potable' }, 's2'] }],
			services,
		);
		expect(box?.services_letters).toBe('Agua Potable (AP), General (G)');
		expect((box?.allowed_services as Array<{ letter?: string }>)[0]?.letter).toBe('AP');
	});

	test('sin letra usa M, igual que el folio del turno', () => {
		const [box] = with_box_service_letters([{ _id: 'b2', allowed_services: [{ _id: 's3', name: 'Sin letra' }] }], services);
		expect(box?.services_letters).toBe('Sin letra (M)');
	});

	test('caja sin servicios queda con la columna vacía', () => {
		const [box] = with_box_service_letters([{ _id: 'b3', allowed_services: [] }], services);
		expect(box?.services_letters).toBe('');
	});

	test('la tabla de cajas incluye la columna services_letters', () => {
		const [row] = project_list_docs('ticketing-system-box-config', [{ _id: 'b1', name: 'Caja 1', services_letters: 'A (A)', extra: 1 }]);
		expect(row?.services_letters).toBe('A (A)');
		expect(row?.extra).toBeUndefined();
	});
});
