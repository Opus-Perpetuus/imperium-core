import { describe, expect, test } from 'bun:test';
import {
	claim_turn_confirm,
	create_turn_confirm_gate,
	normalize_client_request_id,
	schedule_ticketing_room_notice,
	TURN_CONFIRM_WINDOW_MS,
} from './ticketing-turn-create-guard.ts';

describe('confirmación de turno idempotente', () => {
	test('acepta un uuid y rechaza un id vacío o raro', () => {
		expect(normalize_client_request_id('  abc-123_DEF  ')).toBe('abc-123_DEF');
		expect(normalize_client_request_id('')).toBe('');
		expect(normalize_client_request_id('con espacio')).toBe('');
		expect(normalize_client_request_id('a'.repeat(81))).toBe('');
	});

	test('la misma clave, dentro de la ventana, devuelve el turno ya creado', async () => {
		const gate = create_turn_confirm_gate<{ name: string }>(TURN_CONFIRM_WINDOW_MS);
		const first = gate.claim('req-1', 1_000);
		expect(first.status).toBe('new');
		if (first.status !== 'new') return;
		first.settle({ name: 'A001' });

		const second = gate.claim('req-1', 1_000 + 30_000);
		expect(second.status).toBe('replay');
		if (second.status !== 'replay') return;
		expect(await second.turn).toEqual({ name: 'A001' });
	});

	test('dos peticiones a la vez comparten el mismo turno', async () => {
		const gate = create_turn_confirm_gate<{ name: string }>();
		const first = gate.claim('req-2', 5_000);
		const second = gate.claim('req-2', 5_001);
		expect(second.status).toBe('replay');
		if (first.status !== 'new' || second.status !== 'replay') return;
		const pending = second.turn;
		first.settle({ name: 'B004' });
		expect(await pending).toEqual({ name: 'B004' });
	});

	test('si el alta falla, la misma clave puede intentar otra vez', () => {
		const gate = create_turn_confirm_gate<{ name: string }>();
		const first = gate.claim('req-3', 0);
		if (first.status !== 'new') return;
		first.fail(new Error('sin servicio'));
		expect(gate.claim('req-3', 10).status).toBe('new');
	});

	test('pasada la ventana, la misma clave crea otro turno', () => {
		const gate = create_turn_confirm_gate<{ name: string }>(1_000);
		const first = gate.claim('req-4', 0);
		if (first.status === 'new') first.settle({ name: 'C001' });
		expect(gate.claim('req-4', 1_001).status).toBe('new');
	});
});

describe('aviso a las cajas después de guardar', () => {
	test('un aviso que falla no sale hacia quien creó el turno', async () => {
		const logs: string[] = [];
		schedule_ticketing_room_notice(
			async () => {
				throw new Error('resumen colgado');
			},
			(message) => logs.push(message),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(logs).toEqual([
			'[ticketing-system-turn] el turno ya se guardó; no se avisó a las cajas: resumen colgado',
		]);
	});

	test('la clave del asistente se reclama una sola vez en el proceso', () => {
		const id = `spec-${Date.now()}`;
		const first = claim_turn_confirm(id, 50);
		const second = claim_turn_confirm(id, 51);
		expect(first.status).toBe('new');
		expect(second.status).toBe('replay');
		if (first.status === 'new') first.settle({ _id: 'turn-1', name: 'A001' });
	});
});
