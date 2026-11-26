import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { run_with_history_context } from './history.ts';
import { SearchEngine } from './search-engine.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

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

describe('SearchEngine.in_background', () => {
	it('guardar una caja no espera a Meili; el registro y su historial se indexan en orden (#373)', async () => {
		const meili_ok = globalThis.fetch;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			await gate;
			return meili_ok(url, init);
		}) as typeof fetch;
		const row = { id: 'caja1', name: 'Caja 1', is_active: true, payload: { name: 'Caja 1' } };
		const sql = {
			unsafe(query: string) {
				if (/^(INSERT|UPDATE)/.test(query)) {
					return Promise.resolve([{ ...row, name: 'Caja 2', payload: { name: 'Caja 2' } }]);
				}
				return Promise.resolve(query.includes('WHERE id = $1') ? [row] : []);
			},
		} as unknown as Bun.SQL;
		const store = new ImperiumStore(sql, load_catalog_path());

		const started = performance.now();
		await run_with_history_context({ actor: { _id: 'u1', name: 'Ana' }, method: 'PUT', path: '/ticketing-system-box-config' }, () =>
			store.update('ticketing-system-box-config', 'caja1', { name: 'Caja 2' }),
		);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(calls).toEqual([]);

		release();
		await SearchEngine.in_background(async () => undefined);
		const documents = calls.filter((c) => c.endsWith('/documents'));
		expect(documents).toEqual([
			`POST /indexes/imp_${store.loc('ticketing-system-box-config').collection}/documents`,
			`POST /indexes/imp_${store.loc('document-change-history').collection}/documents`,
		]);
	});

	it('tras un fallo de Meili la cola lo salta mientras dura el TTL', async () => {
		const meili_ok = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error('Meili colgado');
		}) as unknown as typeof fetch;
		await SearchEngine.in_background(() =>
			SearchEngine.index_documents('pedidos', [{ id: 'a', search_text: 'x' }], { wait: false }),
		);
		let ran = false;
		await SearchEngine.in_background(async () => {
			ran = true;
		});
		expect(ran).toBe(false);

		globalThis.fetch = meili_ok;
		await SearchEngine.index_documents('pedidos', [{ id: 'a', search_text: 'x' }], { wait: false });
		await SearchEngine.in_background(async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});
});
