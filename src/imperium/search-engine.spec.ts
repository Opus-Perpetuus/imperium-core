import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SearchEngine } from './search-engine.ts';

const original_fetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
	process.env.MEILI_URL = 'http://meili.test';
	calls = [];
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		calls.push(`${init?.method ?? 'GET'} ${path}`);
		if (path.startsWith('/tasks/')) {
			return new Response(JSON.stringify({ status: 'succeeded' }), { status: 200 });
		}
		return new Response(JSON.stringify({ taskUid: 7 }), { status: 202 });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = original_fetch;
	delete process.env.MEILI_URL;
});

describe('SearchEngine.index_documents', () => {
	it('con wait:false encola el documento y no consulta la tarea', async () => {
		await SearchEngine.index_documents('pedidos', [{ id: 'a', search_text: 'x' }], { wait: false });
		expect(calls).toContain('POST /indexes/imp_pedidos/documents');
		expect(calls.some((c) => c.startsWith('GET /tasks/'))).toBe(false);
	});

	it('por defecto espera la tarea (reindexado)', async () => {
		await SearchEngine.index_documents('pedidos', [{ id: 'a', search_text: 'x' }]);
		expect(calls).toContain('GET /tasks/7');
	});
});
