import { describe, expect, test } from 'bun:test';
import { load_state_fields_metadata } from './state-fields.ts';

/** Tenant sin tracker ni `status-options-by-module`: solo cuentan los defaults. */
const store_without_config = { has: () => false } as never;

describe('load_state_fields_metadata', () => {
	test('Control de emergencias publica sus estatus sin configuración persistida', async () => {
		const expected: Record<string, Record<string, string[]>> = {
			'registro-emergencias': {
				prioridad: ['alta', 'media', 'baja'],
				resultado: ['activa', 'pendiente', 'resuelta', 'derivada', 'falsa_alarma', 'informacion'],
			},
			'rescate-animal': {
				estado: ['rescatado', 'desaparecido', 'en_acogida', 'adoptado', 'fallecido'],
			},
			'despensa-solidaria': { estado: ['ok', 'stock_bajo', 'por_caducar', 'caducado'] },
			'inventario-sanitario': { estado: ['ok', 'stock_bajo', 'por_caducar', 'caducado'] },
			voluntariado: { estado: ['alta', 'ausencia', 'baja'] },
		};
		for (const [resource, fields] of Object.entries(expected)) {
			const metadata = await load_state_fields_metadata(store_without_config, resource);
			const got = Object.fromEntries(
				metadata.fields.map((field) => [field.field_name, field.values.map((value) => value.value)]),
			);
			expect({ resource, fields: got }).toEqual({ resource, fields });
		}
	});
});
