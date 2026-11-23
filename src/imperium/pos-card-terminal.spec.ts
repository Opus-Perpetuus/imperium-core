import { describe, expect, test } from 'bun:test';
import {
	amount_string,
	build_card_terminal,
	charge_amount,
	charge_to_pos_payment,
	create_manual_terminal,
	create_simulated_terminal,
	is_final_status,
	mask_terminal_row,
	SECRET_MASK,
	TERMINAL_STATUSES,
	valid_external_reference,
	type TerminalResult,
} from './pos-card-terminal.ts';
import { prepare_pos_payments } from './pos-payments.ts';

const input = { amount: 80, external_reference: 'TCK-1_a1', idempotency_key: 'k-1' };

function charge_of(r: TerminalResult) {
	if (!r.ok) throw new Error(r.error);
	return r.charge;
}

describe('terminal de cobro POS', () => {
	test('solo aprobado, rechazado, cancelado, expirado y reembolsado son finales', () => {
		expect(TERMINAL_STATUSES.filter(is_final_status)).toEqual(['aprobado', 'rechazado', 'cancelado', 'expirado', 'reembolsado']);
	});

	test('valida la referencia externa', () => {
		expect(valid_external_reference(' TCK-1_a ')).toBe('TCK-1_a');
		expect(valid_external_reference('a'.repeat(64))).toHaveLength(64);
		for (const bad of ['', 'a'.repeat(65), 'ticket 1', 'tck#1', 'ñu', 'a.b', null]) {
			expect(() => valid_external_reference(bad)).toThrow(/referencia externa/);
		}
	});

	test('el monto se redondea a centavos y sale con 2 decimales', () => {
		expect(charge_amount(12.345)).toBe(12.35);
		expect(amount_string(100)).toBe('100.00');
		expect(amount_string('7.5')).toBe('7.50');
		expect(amount_string(0.1 + 0.2)).toBe('0.30');
		for (const bad of [0, -5, 0.004, 'abc', Infinity, null]) expect(() => charge_amount(bad)).toThrow(/mayor a 0/);
	});

	test('un cobro aprobado entra a payments como tarjeta y prepare_pos_payments lo acepta', () => {
		const payment = charge_to_pos_payment({ id: 'ORD01', status: 'aprobado', provider_status: 'processed', amount: 60, external_reference: 'TCK-1' });
		expect(payment).toEqual({ method: 'tarjeta', amount: 60, reference: 'ORD01' });
		expect(prepare_pos_payments({ subtotal: 100, payments: [payment, { method: 'efectivo', amount: 50 }] })).toMatchObject({
			payments: [{ method: 'tarjeta', amount: 60, reference: 'ORD01' }, { method: 'efectivo', amount: 50 }],
			payment_method: 'mixto',
			change: 10,
		});
		expect(() => charge_to_pos_payment({ id: 'ORD02', status: 'en_terminal', provider_status: 'at_terminal', amount: 60, external_reference: 'TCK-1' })).toThrow(
			/aprobado/,
		);
	});

	test('manual: aprueba con la referencia que captura el cajero', async () => {
		const manual = create_manual_terminal();
		expect(manual.slug).toBe('manual');
		expect(charge_of(await manual.create_charge({ ...input, reference: ' 4521 aut 99 ' }))).toMatchObject({ id: '4521 aut 99', status: 'aprobado', amount: 80 });
		expect(charge_of(await manual.create_charge(input)).id).toBe('TCK-1_a1');
		expect(await manual.fetch_charge('x')).toMatchObject({ ok: false });
		await expect(manual.create_charge({ ...input, external_reference: 'con espacio' })).rejects.toThrow(/referencia externa/);
	});

	test('simulado: determinista, idempotente y con estado final forzable', async () => {
		const sim = create_simulated_terminal();
		const created = charge_of(await sim.create_charge(input));
		expect(created).toMatchObject({ id: 'sim-1', status: 'en_terminal', amount: 80 });
		expect(charge_of(await sim.create_charge(input)).id).toBe('sim-1');
		expect(charge_of(await sim.fetch_charge('sim-1')).status).toBe('aprobado');
		expect(charge_of(await sim.refund_charge('sim-1', 'r-1')).status).toBe('reembolsado');

		const second = charge_of(await sim.create_charge({ ...input, idempotency_key: 'k-2' }));
		expect(second.id).toBe('sim-2');
		sim.force_status('sim-2', 'requiere_accion');
		expect(charge_of(await sim.cancel_charge('sim-2', 'c-1')).status).toBe('cancelado');
		expect(await sim.cancel_charge('sim-1', 'c-2')).toMatchObject({ ok: false, status_code: 409 });
		expect(await sim.fetch_charge('nada')).toMatchObject({ ok: false, status_code: 404 });

		const rejecting = create_simulated_terminal({ final_status: 'rechazado' });
		const r = charge_of(await rejecting.create_charge(input));
		expect(charge_of(await rejecting.fetch_charge(r.id)).status).toBe('rechazado');
	});

	test('la fábrica arma manual, simulado y mercadopago_point; desconocido es null', async () => {
		expect(build_card_terminal({ adapter: 'manual' })?.slug).toBe('manual');
		const sim = build_card_terminal({ adapter: 'simulado', config_json: '{"final_status":"expirado"}' });
		expect(sim?.slug).toBe('simulado');
		const c = charge_of(await sim!.create_charge(input));
		expect(charge_of(await sim!.fetch_charge(c.id)).status).toBe('expirado');
		expect(build_card_terminal({ adapter: 'mercadopago_point', label: 'Caja 1', config_json: { access_token: 'TEST-x', terminal_id: 'T1' } })).toMatchObject({
			slug: 'mercadopago_point',
			label: 'Caja 1',
		});
		expect(build_card_terminal({ adapter: 'stripe' })).toBeNull();
		expect(build_card_terminal({})).toBeNull();
	});

	test('enmascara los secretos de la fila sin tocar el resto', () => {
		const row = { adapter: 'mercadopago_point', config_json: { access_token: 'APP_USR-secreto', webhook_secret: 'wh', terminal_id: 'T1', test_mode: false } };
		expect(mask_terminal_row(row)).toEqual({
			adapter: 'mercadopago_point',
			config_json: { access_token: SECRET_MASK, webhook_secret: SECRET_MASK, terminal_id: 'T1', test_mode: false },
		});
		expect(row.config_json.access_token).toBe('APP_USR-secreto');
		const masked = mask_terminal_row({ config_json: JSON.stringify({ access_token: 'APP_USR-secreto' }) });
		expect(masked.config_json).toBe(JSON.stringify({ access_token: SECRET_MASK }));
	});
});
