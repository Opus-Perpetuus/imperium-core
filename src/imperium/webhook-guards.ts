/**
 * Los webhooks de pago son públicos (sin sesión): lo único que prueba que el
 * aviso viene del proveedor es la firma (Stripe) o el cifrado con la llave
 * compartida (Mitec). Sin secreto o sin cifrado no se aplica ningún pago.
 */
import { mitec_decrypt_payload } from './mitec.ts';

export class WebhookRejected extends Error {}

/** Stripe: sin secreto configurado el aviso no se puede comprobar, así que no vale. */
export function assert_stripe_webhook(
	secret: string,
	verify: () => boolean,
): void {
	if (!String(secret ?? '').trim()) {
		throw new WebhookRejected('Webhook de Stripe sin secreto configurado: no se aplica ningún pago.');
	}
	if (!verify()) throw new WebhookRejected('Firma de webhook Stripe inválida.');
}

/** Mitec: la respuesta llega cifrada con la llave del comercio; XML en claro no se acepta. */
export function mitec_callback_xml(encoded: string, key_hex: string): string {
	if (encoded.trim().startsWith('<')) {
		throw new WebhookRejected('Respuesta de Mitec sin cifrar: no se aplica ningún pago.');
	}
	if (!String(key_hex ?? '').trim()) {
		throw new WebhookRejected('Mitec sin llave configurada: no se aplica ningún pago.');
	}
	return mitec_decrypt_payload(encoded, key_hex);
}
