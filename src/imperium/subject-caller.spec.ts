import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { CALL_SUBJECT_TIMEOUT_MS, SUBJECT_CALLER_HEADER } from '@opus-perpetuus/imperium-core-kit';
import {
	resolve_subject_caller,
	SUBJECT_CALL_PROXY_TIMEOUT_MS,
	type SubjectCallerDeps,
} from './subject-caller.ts';

const POS = 'subject-pos';
const HERR = 'subject-herramientas';
const secret_of = (tid: string) => `derivado-de-${tid}`;

const deps: SubjectCallerDeps = {
	master_configured: () => true,
	catalog_tids: new Set([POS, HERR, 'subject-almacen']),
	is_subject_request: (req, tid) =>
		req.headers.get('x-core-subject-gateway-secret') === secret_of(tid),
	installed: async (tid) => tid !== 'subject-almacen',
};

function call(caller: string | null, secret: string): Request {
	const headers: Record<string, string> = { 'x-core-subject-gateway-secret': secret };
	if (caller !== null) headers[SUBJECT_CALLER_HEADER] = caller;
	return new Request('http://core/api/m/subject-herramientas/x', { headers });
}

async function body(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe('resolve_subject_caller', () => {
	test('sin remitente no es una llamada app → app', async () => {
		expect(await resolve_subject_caller(call(null, secret_of(POS)), HERR, 'internal', deps)).toBeNull();
		expect(await resolve_subject_caller(call('  ', secret_of(POS)), HERR, 'internal', deps)).toBeNull();
	});

	test('en el realm público la ruta no existe: 404 aunque el secreto sea bueno', async () => {
		const out = await resolve_subject_caller(call(POS, secret_of(POS)), HERR, 'public', deps);
		expect(out?.ok).toBe(false);
		if (out && !out.ok) {
			expect(out.response.status).toBe(404);
			expect(await body(out.response)).toEqual({
				error: 'not found',
				message: 'not found',
				code: 'not_found',
			});
		}
	});

	test('sin maestro configurado → 503 gateway_secret_missing, no 403', async () => {
		const out = await resolve_subject_caller(call(POS, secret_of(POS)), HERR, 'internal', {
			...deps,
			master_configured: () => false,
		});
		expect(out?.ok).toBe(false);
		if (out && !out.ok) {
			expect(out.response.status).toBe(503);
			expect((await body(out.response)).code).toBe('gateway_secret_missing');
		}
	});

	test('el plazo del kit queda por debajo del que el núcleo da al salto', () => {
		expect(CALL_SUBJECT_TIMEOUT_MS).toBeLessThan(SUBJECT_CALL_PROXY_TIMEOUT_MS);
	});

	test('remitente fuera del catálogo o con el secreto de otra app → 403 forbidden', async () => {
		for (const req of [
			call('subject-inventada', secret_of('subject-inventada')),
			call(POS, secret_of(HERR)),
			call(POS, ''),
		]) {
			const out = await resolve_subject_caller(req, HERR, 'internal', deps);
			expect(out?.ok).toBe(false);
			if (out && !out.ok) {
				expect(out.response.status).toBe(403);
				expect((await body(out.response)).code).toBe('forbidden');
			}
		}
	});

	test('una app no se llama a sí misma → 400 self_call', async () => {
		const out = await resolve_subject_caller(call(POS, secret_of(POS)), POS, 'internal', deps);
		expect(out?.ok).toBe(false);
		if (out && !out.ok) {
			expect(out.response.status).toBe(400);
			expect((await body(out.response)).code).toBe('self_call');
		}
	});

	test('remitente sin instalar → 403 caller_not_installed', async () => {
		const req = call('subject-almacen', secret_of('subject-almacen'));
		const out = await resolve_subject_caller(req, HERR, 'internal', deps);
		expect(out?.ok).toBe(false);
		if (out && !out.ok) {
			expect(out.response.status).toBe(403);
			expect((await body(out.response)).code).toBe('caller_not_installed');
		}
	});

	test('remitente del catálogo, con su secreto e instalado → ok', async () => {
		expect(
			await resolve_subject_caller(call(POS, secret_of(POS)), HERR, 'internal', deps),
		).toEqual({ ok: true, caller: POS });
	});
});

describe('server.ts: cableado', () => {
	const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

	test('el remitente se resuelve tras comprobar el destino y antes de pedir sesión', () => {
		const installed = src.indexOf('!(await technical_id_is_installed(');
		const caller = src.indexOf('await resolve_subject_caller(req, technical_id, realm, {');
		const session = src.indexOf('const gate = await gateway_identity(technical_id, req, realm);');
		expect(installed).toBeGreaterThan(0);
		expect(caller).toBeGreaterThan(installed);
		expect(session).toBeGreaterThan(caller);
		const branch = src.slice(caller, session);
		expect(branch).toContain('service_subject_identity({');
		expect(branch).toContain('technical_id_is_installed(imperium.store, sql, caller)');
		expect(branch).toContain('master_configured: () => Boolean(master_secret())');
		expect(branch).toContain('SUBJECT_CALL_PROXY_TIMEOUT_MS');
		expect(branch.indexOf('accepted_caller = call.caller')).toBeGreaterThan(
			branch.indexOf('if (!call.ok)'),
		);
		expect(src).not.toContain('req.headers.get(SUBJECT_CALLER_HEADER)');
	});
});
