import { describe, expect, test } from 'bun:test';
import { is_public_extra_action } from './auth.ts';
import extra_routes from './extra-routes.json';

type ExtraRoute = { resource: string; method: string; path: string; action: string };
const EXTRAS = extra_routes as ExtraRoute[];

describe('extras públicos', () => {
	test('la lista se indexa por recurso:acción, no por la acción suelta', () => {
		// `stripe_webhook` existe en dos recursos; solo son públicos los dos
		// declarados. Un tercer recurso con el mismo nombre de acción no lo es.
		expect(is_public_extra_action('payments', 'stripe_webhook')).toBe(true);
		expect(is_public_extra_action('cobranza', 'stripe_webhook')).toBe(true);
		expect(is_public_extra_action('tickets', 'stripe_webhook')).toBe(false);
	});

	test('generar PDF exige sesión', () => {
		// Renderiza HTML del cuerpo en un Chromium con --no-sandbox: sin sesión
		// es SSRF desde dentro de la red del tenant, con el cuerpo de la
		// respuesta interna dibujado en el PDF que se devuelve.
		for (const accion of [
			'generate_pdf',
			'generate_full_report_pdf',
			'process_preview',
			'print_pdf_direct',
		]) {
			expect(is_public_extra_action('reports', accion)).toBe(false);
		}
	});

	test('leer modelos arbitrarios exige sesión', () => {
		for (const accion of [
			'get_model_records',
			'get_model_record_by_id',
			'get_model_fields',
			'get_model_fields_detailed',
			'get_first_record',
			'validate_template',
			'get_pdf_direct_target',
		]) {
			expect(is_public_extra_action('reports', accion)).toBe(false);
		}
	});

	test('las imágenes del render siguen abiertas', () => {
		// El Chromium que arma el PDF las pide por `<img src=…>` y no lleva
		// cookie. Lee un adjunto por id y nada más.
		expect(is_public_extra_action('reports', 'get_image_base64')).toBe(true);
	});

	test('sin recurso o sin acción nunca es público', () => {
		expect(is_public_extra_action(undefined, 'generate_pdf')).toBe(false);
		expect(is_public_extra_action('reports', undefined)).toBe(false);
		expect(is_public_extra_action('', '')).toBe(false);
	});

	test('toda clave pública corresponde a una ruta declarada', () => {
		const declaradas = new Set(EXTRAS.map((e) => `${e.resource}:${e.action}`));
		const publicas = [
			'tickets:read_public_metadata',
			'tickets:create_public_ticket',
			'payments:public_catalog',
			'agua:public_contrato',
			'messages:receive_interinstance_message',
			'reports:get_image_base64',
		];
		for (const clave of publicas) expect(declaradas.has(clave)).toBe(true);
	});
});
