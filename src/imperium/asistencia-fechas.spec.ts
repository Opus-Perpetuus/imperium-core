import { describe, expect, test } from 'bun:test';
import { prepare_registro_asistencia_write } from './lista-asistencia-flow.ts';
import { prepare_incidencia_write } from './registro-incidencias-flow.ts';

describe('fechas de asistencia sin hora', () => {
	test('el pase guarda AAAA-MM-DD aunque llegue con hora', () => {
		for (const fecha of ['2026-09-27', '2026-09-27T00:00:00.000Z', '2026-09-27T18:30:00.000Z']) {
			const doc = prepare_registro_asistencia_write(
				{ grupo_id: 'g1', fecha_asistencia: fecha },
				null,
				true,
			);
			expect(doc.fecha_asistencia).toBe('2026-09-27');
		}
		const hoy = prepare_registro_asistencia_write({ grupo_id: 'g1' }, null, true);
		expect(String(hoy.fecha_asistencia)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	test('la incidencia guarda AAAA-MM-DD o nada', () => {
		expect(prepare_incidencia_write({ fecha_asistencia: '2026-09-27T00:00:00.000Z' }, true).fecha_asistencia).toBe('2026-09-27');
		expect(prepare_incidencia_write({ fecha_asistencia: 'no es fecha' }, true).fecha_asistencia).toBeNull();
	});
});

describe('referencias a filas de una app', () => {
	test('un id del kit cuenta como referencia válida; un texto cualquiera no', async () => {
		const { is_record_id } = await import('./store.ts');
		expect(is_record_id('507f1f77bcf86cd799439011')).toBe(true);
		expect(is_record_id('registro_42c14311f4a3401e')).toBe(true);
		expect(is_record_id('lista-as_a5a55f3d63f0475a')).toBe(true);
		expect(is_record_id('Tercero A')).toBe(false);
		expect(is_record_id('registro_42c1')).toBe(false);
	});
});
