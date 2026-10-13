import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const routes = JSON.parse(
	readFileSync(new URL('./extra-routes.json', import.meta.url), 'utf8'),
) as Array<{ resource: string; method: string; path: string; action: string }>;
const auth_src = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
const actions_src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');

describe('comercial-envio routes', () => {
	test('extra-routes declares enqueue, claim, report and retry', () => {
		const mine = routes.filter((row) => row.resource === 'comercial-envio');
		expect(mine).toEqual([
			{ resource: 'comercial-envio', method: 'post', path: '/enqueue', action: 'enqueue' },
			{ resource: 'comercial-envio', method: 'post', path: '/claim', action: 'claim' },
			{ resource: 'comercial-envio', method: 'post', path: '/:id/report', action: 'report' },
			{ resource: 'comercial-envio', method: 'post', path: '/:id/retry', action: 'retry' },
		]);
	});

	test('send-to-commercial stays on invoice-request', () => {
		expect(
			routes.some(
				(row) =>
					row.resource === 'invoice-request' &&
					row.method === 'post' &&
					row.path === '/:id/send-to-commercial' &&
					row.action === 'send_to_commercial',
			),
		).toBe(true);
	});

	test('queue actions are not session-scoped; send_to_commercial stays', () => {
		const start = auth_src.indexOf('const SESSION_SCOPED_EXTRAS = new Set([');
		const end = auth_src.indexOf(']);', start);
		const scoped = new Set(
			[...auth_src.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]),
		);
		for (const perm of [
			'comercial-envio:enqueue',
			'comercial-envio:claim',
			'comercial-envio:report',
			'comercial-envio:retry',
		]) {
			expect(scoped.has(perm)).toBe(false);
			expect(auth_src).not.toContain(`'${perm}'`);
			const action = perm.slice('comercial-envio:'.length);
			expect(actions_src).toContain(`case 'comercial-envio:${action}':`);
		}
		expect(scoped.has('invoice-request:send_to_commercial')).toBe(true);
		expect(actions_src).toContain('on_invoice_request_envio_change');
		expect(actions_src).toContain('ComercialEnvioError');
	});
});
