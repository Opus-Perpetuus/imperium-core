import { describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import { rate_limited_response, take_token } from './rate-bucket.ts';
import type { ImperiumStore } from './store.ts';

describe('límites de tasa', () => {
	test('gasta la ráfaga, dice cuánto esperar y recarga con el tiempo', () => {
		const rule = { capacity: 2, refill_per_s: 0.5 };
		const t0 = Date.now();
		expect(take_token('cubeta-rafaga', rule, t0)).toEqual({ ok: true });
		expect(take_token('cubeta-rafaga', rule, t0)).toEqual({ ok: true });
		expect(take_token('cubeta-rafaga', rule, t0)).toEqual({ ok: false, retry_after_s: 2 });
		expect(take_token('cubeta-rafaga', rule, t0 + 1000)).toEqual({ ok: false, retry_after_s: 1 });
		expect(take_token('cubeta-rafaga', rule, t0 + 2000)).toEqual({ ok: true });
		expect(take_token('cubeta-rafaga', rule, t0 + 2000)).toEqual({ ok: false, retry_after_s: 2 });
	});

	test('la recarga no pasa de la capacidad', () => {
		const rule = { capacity: 3, refill_per_s: 10 };
		const t0 = Date.now();
		for (let i = 0; i < 3; i++) take_token('cubeta-tope', rule, t0);
		for (let i = 0; i < 3; i++) expect(take_token('cubeta-tope', rule, t0 + 60_000).ok).toBe(true);
		expect(take_token('cubeta-tope', rule, t0 + 60_000).ok).toBe(false);
	});

	test('cada llave tiene su propia cubeta', () => {
		const rule = { capacity: 1, refill_per_s: 1 };
		const t0 = Date.now();
		expect(take_token('cubeta-a', rule, t0).ok).toBe(true);
		expect(take_token('cubeta-a', rule, t0).ok).toBe(false);
		expect(take_token('cubeta-b', rule, t0).ok).toBe(true);
	});

	test('responde 429 con Retry-After, el código estable y los segundos en details', async () => {
		const res = rate_limited_response(7);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('7');
		expect(await res.json()).toEqual({
			message: 'Demasiadas solicitudes; intenta de nuevo en 7 s.',
			error: 'Demasiadas solicitudes; intenta de nuevo en 7 s.',
			code: 'rate_limited',
			details: { retry_after_s: 7 },
		});
	});
});

describe('límites del chat', () => {
	const store = {
		has: (resource: string) => resource === 'user',
		chat_search: async () => [],
		chat_users_brief: async () => [],
	} as unknown as ImperiumStore;

	function call(action: string, actor: ImperiumDoc, init: RequestInit = {}, query = '') {
		const url = new URL(`http://core/api/messages/${action}${query}`);
		return handle_action(store, {} as Bun.SQL, new Request(url, init), url, 'messages', action, {}, actor);
	}

	/** Estados hasta el primer 429: la recarga corre mientras el bucle avanza. */
	async function statuses_until_limited(run: () => Promise<Response>, max: number): Promise<number[]> {
		const seen: number[] = [];
		while (seen.length < max && seen.at(-1) !== 429) seen.push((await run()).status);
		return seen;
	}

	test('buscar: 30 por minuto por usuario y después 429', async () => {
		const search = (actor: ImperiumDoc) => call('search_chat_messages', actor, {}, '?term=hola');
		const seen = await statuses_until_limited(() => search({ _id: 'busca-rafaga' }), 40);
		expect(seen.slice(0, 30)).toEqual(Array(30).fill(200));
		expect(seen.at(-1)).toBe(429);
		expect((await search({ _id: 'busca-otra' })).status).toBe(200);
	});
});
