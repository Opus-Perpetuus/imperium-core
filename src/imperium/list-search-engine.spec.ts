import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ImperiumStore, load_catalog_path } from './store.ts';

/**
 * PROFESA, Ventas → Contactos: «ABICAY» daba 0 aunque «ABICAY JAERO CARRILLO»
 * es la primera fila. Meilisearch devolvía ids de un índice viejo que ya no
 * existen en la tabla y el listado se quedaba con esos ids en vez del ILIKE.
 */
describe('búsqueda de listado con índice de Meilisearch viejo', () => {
	const queries: string[] = [];
	let meili: ReturnType<typeof Bun.serve>;
	let hits: string[] = [];
	const live = [{ id: 'contacto-vivo', name: 'ABICAY JAERO CARRILLO', is_active: true }];

	const sql = {
		unsafe(query: string, params: unknown[]) {
			queries.push(query);
			const by_ids = query.includes('id IN (');
			const by_like = query.includes('ILIKE');
			const rows = by_ids
				? live.filter((row) => params.includes(row.id))
				: by_like
					? live.filter((row) => params.some((p) => typeof p === 'string' && p.startsWith('%') && row.name.toLowerCase().includes(p.slice(1, -1).toLowerCase())))
					: live;
			if (query.startsWith('SELECT count(*)')) return Promise.resolve([{ n: rows.length }]);
			return Promise.resolve(rows);
		},
	} as unknown as Bun.SQL;
	const store = new ImperiumStore(sql, load_catalog_path());

	beforeAll(() => {
		meili = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname.endsWith('/search')) {
					return Response.json({ hits: hits.map((id) => ({ id })) });
				}
				return Response.json({ taskUid: null });
			},
		});
		process.env.MEILI_URL = `http://127.0.0.1:${meili.port}`;
	});

	afterAll(() => {
		delete process.env.MEILI_URL;
		meili.stop(true);
	});

	test('si ningún id del motor existe en la tabla, busca con ILIKE', async () => {
		hits = ['contacto-borrado-1', 'contacto-borrado-2'];
		queries.length = 0;
		const found = await store.find_many('contacto', { q: 'ABICAY', take: 25, populate: false });
		expect(found.total).toBe(1);
		expect(found.rows.map((row) => row.name)).toEqual(['ABICAY JAERO CARRILLO']);
		expect(queries.some((q) => q.includes('ILIKE'))).toBe(true);
	});

	test('si los ids del motor existen, no corre el ILIKE', async () => {
		hits = ['contacto-vivo'];
		queries.length = 0;
		const found = await store.find_many('contacto', { q: 'ABICAY', take: 25, populate: false });
		expect(found.total).toBe(1);
		expect(queries.some((q) => q.includes('ILIKE'))).toBe(false);
	});

	test('si el motor no da hits, busca con ILIKE (parcial «ABI»)', async () => {
		hits = [];
		const found = await store.find_many('contacto', { q: 'ABI', take: 25, populate: false });
		expect(found.rows.map((row) => row.name)).toEqual(['ABICAY JAERO CARRILLO']);
	});
});
