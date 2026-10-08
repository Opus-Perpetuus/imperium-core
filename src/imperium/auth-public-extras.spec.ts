import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
			'tickets:receive_support_comment',
			'chat-calls:ice_servers',
			'chat-calls:leave_call',
			'chat-calls:sfu_token',
			'chat-calls:sfu_webhook',
			'chat-meetings:public_summary',
			'chat-meetings:guest_join',
			'chat-meetings:join_meeting',
			'chat-meetings:guest_ticket',
			'chat-meetings:guest_read_chat',
			'chat-meetings:guest_chat_message',
			'chat-meetings:read_questions',
			'chat-meetings:create_question',
			'chat-meetings:vote_question',
		];
		for (const clave of publicas) expect(declaradas.has(clave)).toBe(true);
	});

	test('las rutas públicas de llamadas y reuniones exigen al principal de la reunión en su handler', () => {
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		// El resumen por código y el alta del invitado crean al principal: no lo pueden exigir. El
		// webhook del SFU no tiene principal: exige la firma del servidor de medios.
		const sin_exigir_principal = new Set(['chat-meetings:public_summary', 'chat-meetings:guest_join', 'chat-calls:sfu_webhook']);
		const publicas = EXTRAS.filter(
			(e) =>
				(e.resource === 'chat-calls' || e.resource === 'chat-meetings') &&
				is_public_extra_action(e.resource, e.action) &&
				!sin_exigir_principal.has(`${e.resource}:${e.action}`),
		);
		expect(publicas.length).toBeGreaterThan(0);
		for (const { resource, action } of publicas) {
			const file = resource === 'chat-calls' ? 'calls-flow.ts' : 'meetings-flow.ts';
			const flows = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
			const aliases = new Map<string, string>();
			for (const [, list] of actions.matchAll(new RegExp(`import \\{([^}]*)\\} from '\\./${file.replace('.', '\\.')}';`, 'g'))) {
				for (const item of list!.split(',').map((part) => part.trim()).filter(Boolean)) {
					const [original, alias] = item.split(/\s+as\s+/) as [string, string | undefined];
					aliases.set(alias ?? original, original);
				}
			}
			const handler = actions.match(new RegExp(`case '${resource}:${action}':\\s*return (\\w+)\\(ctx\\);`))?.[1];
			const name = aliases.get(handler ?? '') ?? '';
			const start = flows.indexOf(`export async function ${name}(`);
			const end = flows.indexOf('\nexport ', start + 1);
			const body = flows.slice(start, end < 0 ? undefined : end);
			expect({ action, has_handler: start > -1, principal: body.includes('meeting_principal(') }).toEqual({
				action,
				has_handler: true,
				principal: true,
			});
		}
	});
});
