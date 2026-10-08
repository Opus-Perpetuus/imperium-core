/**
 * Superficie de invitados (contrato §0.4 y §6.5), por el texto fuente: lo único público de llamadas
 * y reuniones son las acciones aptas para invitados, y cada una exige al principal de su reunión
 * en su handler, salvo el resumen por código y el alta del invitado, que lo crean.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { is_public_extra_action } from './auth.ts';
import extra_routes from './extra-routes.json';

type ExtraRoute = { resource: string; method: string; path: string; action: string };
const EXTRAS = extra_routes as ExtraRoute[];

const GUEST_CAPABLE = new Set([
	'chat-calls:ice_servers',
	'chat-calls:leave_call',
	'chat-calls:sfu_token',
	'chat-meetings:public_summary',
	'chat-meetings:guest_join',
	'chat-meetings:join_meeting',
	'chat-meetings:guest_ticket',
	'chat-meetings:guest_read_chat',
	'chat-meetings:guest_chat_message',
	'chat-meetings:read_questions',
	'chat-meetings:create_question',
	'chat-meetings:vote_question',
]);
const CREATES_PRINCIPAL = new Set(['chat-meetings:public_summary', 'chat-meetings:guest_join']);
/** Sin principal: el handler exige la firma de quien llama. */
const SIGNED = new Set(['chat-calls:sfu_webhook']);
const FLOWS: Record<string, string> = { 'chat-calls': 'calls-flow.ts', 'chat-meetings': 'meetings-flow.ts' };

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
const actions = source('actions.ts');

/** El cuerpo del handler exportado que atiende `recurso:acción`, siguiendo los alias de actions.ts. */
function handler_body(resource: string, action: string): string {
	const aliases = new Map<string, string>();
	for (const [, list] of actions.matchAll(new RegExp(`import \\{([^}]*)\\} from '\\./${FLOWS[resource]}';`, 'g'))) {
		for (const item of list!.split(',').map((part) => part.trim()).filter(Boolean)) {
			const [original, alias] = item.split(/\s+as\s+/) as [string, string | undefined];
			aliases.set(alias ?? original, original);
		}
	}
	const called = actions.match(new RegExp(`case '${resource}:${action}':\\s*return (\\w+)\\(ctx\\);`))?.[1] ?? '';
	const name = aliases.get(called) ?? '';
	const flow = source(FLOWS[resource]!);
	const start = flow.indexOf(`export async function ${name}(`);
	if (!name || start < 0) return '';
	const end = flow.indexOf('\nexport ', start + 1);
	return flow.slice(start, end < 0 ? undefined : end);
}

const ROUTES = EXTRAS.filter((route) => route.resource in FLOWS);

describe('superficie de invitados en llamadas y reuniones', () => {
	test('cada acción apta para invitados tiene ruta y es pública', () => {
		const declared = new Set(ROUTES.map((route) => `${route.resource}:${route.action}`));
		for (const key of GUEST_CAPABLE) {
			const [resource, action] = key.split(':') as [string, string];
			expect({ key, declared: declared.has(key), public: is_public_extra_action(resource, action) }).toEqual({
				key,
				declared: true,
				public: true,
			});
		}
	});

	test('ninguna otra acción de llamadas o reuniones es pública', () => {
		const open = ROUTES.filter((route) => is_public_extra_action(route.resource, route.action)).map(
			(route) => `${route.resource}:${route.action}`,
		);
		expect(open.filter((key) => !GUEST_CAPABLE.has(key) && !SIGNED.has(key))).toEqual([]);
	});

	test('el webhook del SFU es público y su handler exige la firma del servidor de medios', () => {
		expect(is_public_extra_action('chat-calls', 'sfu_webhook')).toBe(true);
		expect(handler_body('chat-calls', 'sfu_webhook')).toContain('sfu_webhook_event(');
	});

	test('el handler de cada acción pública exige al principal de su reunión', () => {
		for (const key of GUEST_CAPABLE) {
			if (CREATES_PRINCIPAL.has(key)) continue;
			const [resource, action] = key.split(':') as [string, string];
			const body = handler_body(resource, action);
			expect({ key, found: body.length > 0, principal: body.includes('meeting_principal(') }).toEqual({
				key,
				found: true,
				principal: true,
			});
		}
	});

	test('el resumen y el alta del invitado llevan su tope por IP; el alta exige invitados encendidos', () => {
		expect(handler_body('chat-meetings', 'public_summary')).toContain('take_meeting_code_ip(ctx.req)');
		const join = handler_body('chat-meetings', 'guest_join');
		expect(join).toContain('take_meeting_guest_ip(ctx.req)');
		expect(join).toContain('settings.guests_enabled');
		expect(join).toContain('doc.settings.guests_allowed');
	});
});
