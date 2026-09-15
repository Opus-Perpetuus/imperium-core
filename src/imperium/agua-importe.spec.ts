import { expect, test } from 'bun:test';
import {
	after_lectura_create,
	calcular_importe,
	prepare_lectura_write,
} from './agua-importe.ts';
import type { ImperiumStore } from './store.ts';

function mock_store(opts: {
	tarifas?: Record<string, unknown>[];
	contratos?: Record<string, unknown>[];
}): ImperiumStore {
	const tarifas = opts.tarifas ?? [];
	const contratos = opts.contratos ?? [];
	return {
		has(resource: string) {
			return resource === 'tarifa' || resource === 'contrato';
		},
		async *scan(resource: string, opts?: { where?: Record<string, unknown> }) {
			if (resource !== 'tarifa') {
				yield [];
				return;
			}
			const id = opts?.where?.id_tarifa;
			yield tarifas.filter((row) => !id || row.id_tarifa === id);
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			if (resource !== 'contrato') return null;
			return (
				contratos.find((row) =>
					Object.entries(where).every(([key, value]) => row[key] === value),
				) ?? null
			);
		},
		async update(_resource: string, id: string, patch: Record<string, unknown>) {
			const row = contratos.find((c) => String(c._id) === String(id));
			if (!row) return null;
			Object.assign(row, patch);
			return row;
		},
	} as unknown as ImperiumStore;
}

test('calcular_importe uses the matching tariff bracket', async () => {
	const store = mock_store({
		tarifas: [
			{
				id_tarifa: 'T-DOM',
				consumo_minimo: 0,
				consumo_maximo: 20,
				cuota_minima: 85.5,
				costo_mt3_excedente: 12.3,
			},
		],
	});
	expect(await calcular_importe(store, 135, 120, 'T-DOM')).toEqual({
		consumo_mts3: 15,
		importe: 270,
	});
});

test('prepare_lectura_write overwrites client consumo and importe', async () => {
	const store = mock_store({
		tarifas: [
			{
				id_tarifa: 'T-DOM',
				consumo_minimo: 0,
				consumo_maximo: 20,
				cuota_minima: 85.5,
				costo_mt3_excedente: 12.3,
			},
		],
	});
	const prepared = await prepare_lectura_write(store, {
		contrato: 'A-1001',
		lectura_anterior: 120,
		lectura_actual: 135,
		id_tarifa: 'T-DOM',
		consumo_mts3: 0,
		importe: 0,
	});
	expect(prepared.consumo_mts3).toBe(15);
	expect(prepared.importe).toBe(270);
});

test('after_lectura_create marks the contract taken and adds adeudo', async () => {
	const contratos = [
		{
			_id: 'c1',
			contrato: 'A-1001',
			tomada: false,
			sincronizada: false,
			adeudo: 10,
		},
	];
	const store = mock_store({ contratos });
	await after_lectura_create(store, {
		contrato: 'A-1001',
		importe: 85.5,
	});
	expect(contratos[0]).toMatchObject({
		tomada: true,
		sincronizada: true,
		adeudo: 95.5,
	});
});
