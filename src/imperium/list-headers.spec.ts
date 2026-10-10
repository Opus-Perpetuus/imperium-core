import { describe, expect, test } from 'bun:test';
import { decorate_list_instance_type } from './list-headers.ts';

const raw = (...keys: string[]) =>
	Object.fromEntries(keys.map((key) => [key, { nombre_encabezado: key.replace(/_/g, ' '), tipo: 'string' }]));

describe('decorate_list_instance_type', () => {
	test('Permisos de acceso: encabezados en español y Sí/No', () => {
		const out = decorate_list_instance_type('access-rights', raw('allow_create', 'model_id', 'name'));
		expect(out.allow_create).toEqual({ nombre_encabezado: 'Crear', tipo: 'Boolean' });
		expect(out.model_id?.nombre_encabezado).toBe('Modelo');
		expect(out.name).toEqual({ nombre_encabezado: 'name', tipo: 'string' });
	});

	test('Pedidos: fechas como fecha y factura en español', () => {
		const out = decorate_list_instance_type('pedidos', raw('fecha', 'init_time', 'end_time', 'invoice_request_id'));
		expect(out.fecha?.tipo).toBe('Date');
		expect(out.init_time).toEqual({ nombre_encabezado: 'Hora de inicio', tipo: 'Date' });
		expect(out.end_time?.tipo).toBe('Date');
		expect(out.invoice_request_id?.nombre_encabezado).toBe('Id de solicitud de factura');
	});

	test('Fechas de auditoría en cualquier lista', () => {
		const out = decorate_list_instance_type('epson-ticket-template', raw('updatedAt', 'template_key'));
		expect(out.updatedAt).toEqual({ nombre_encabezado: 'Fecha de actualización', tipo: 'Date' });
		expect(out.template_key?.nombre_encabezado).toBe('Clave de plantilla');
	});

	test('No pisa un encabezado o tipo que ya venía definido', () => {
		const out = decorate_list_instance_type('pedidos', {
			fecha: { nombre_encabezado: 'Fecha del pedido', tipo: 'Number' },
		});
		expect(out.fecha).toEqual({ nombre_encabezado: 'Fecha del pedido', tipo: 'Number' });
	});
});
