import { describe, expect, test } from 'bun:test';
import { fetch_subject_schemas } from './install-schemas.ts';

const bundle = (id: string) => ({ technicalId: id, version: 1, tables: [] });

describe('install-schemas: pedir /schema a las apps del catálogo', () => {
	test('una app que nunca responde no bloquea a las demás y el orden es el del catálogo', async () => {
		const ids = ['subject-almacen', 'subject-turnos', 'subject-pos', 'subject-tienda'];
		const fake = (async (url: string) => {
			if (url.includes('turnos')) return new Promise<Response>(() => {});
			if (url.includes('tienda')) throw new TypeError('Unable to connect. Is the computer able to access the url?');
			const id = url.match(/\/\/(subject-[a-z-]+)\//)![1]!;
			await Bun.sleep(id === 'subject-almacen' ? 60 : 5);
			return Response.json(bundle(id));
		}) as unknown as typeof fetch;

		const timeout_ms = 200;
		const started = performance.now();
		const results = await fetch_subject_schemas(ids, (id) => `http://${id}`, {
			fetch: fake,
			timeout_ms,
		});
		const elapsed = performance.now() - started;

		expect(elapsed).toBeLessThan(timeout_ms + 300);
		expect(results.map((r) => [r.id, r.ok])).toEqual([
			['subject-almacen', true],
			['subject-turnos', false],
			['subject-pos', true],
			['subject-tienda', false],
		]);
		expect(results[1]).toMatchObject({ ok: false, error: 'unreachable' });
		expect(results[3]).toMatchObject({ ok: false, error: 'unreachable' });
		expect(results[0]).toMatchObject({ bundle: bundle('subject-almacen') });
	});
});
