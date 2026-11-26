import { describe, expect, test } from 'bun:test';
import { mitec_encrypt_xml } from './mitec.ts';
import { assert_stripe_webhook, mitec_callback_xml, WebhookRejected } from './webhook-guards.ts';

const KEY = '00112233445566778899aabbccddeeff';
const XML = '<CENTEROFPAYMENTS><response>approved</response><reference>C-1</reference></CENTEROFPAYMENTS>';

describe('webhooks de pago públicos: sin prueba del proveedor no se aplica nada', () => {
	test('Stripe sin secreto configurado se rechaza aunque el cuerpo parezca un pago', () => {
		expect(() => assert_stripe_webhook('', () => true)).toThrow(WebhookRejected);
	});

	test('Stripe con secreto exige firma válida', () => {
		expect(() => assert_stripe_webhook('whsec_x', () => false)).toThrow('Firma de webhook Stripe inválida.');
		expect(() => assert_stripe_webhook('whsec_x', () => true)).not.toThrow();
	});

	test('Mitec con XML en claro se rechaza', () => {
		expect(() => mitec_callback_xml(XML, KEY)).toThrow(WebhookRejected);
	});

	test('Mitec sin llave se rechaza', () => {
		expect(() => mitec_callback_xml(mitec_encrypt_xml(XML, KEY), '')).toThrow(WebhookRejected);
	});

	test('Mitec cifrado con la llave del comercio se descifra', () => {
		expect(mitec_callback_xml(mitec_encrypt_xml(XML, KEY), KEY)).toBe(XML);
	});
});
