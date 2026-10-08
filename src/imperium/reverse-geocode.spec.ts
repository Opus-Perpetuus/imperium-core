import { describe, expect, test } from 'bun:test';
import {
	lookup_reverse_geocode,
	REVERSE_GEOCODE_UNAVAILABLE_MESSAGE,
} from './reverse-geocode.ts';

const address = {
	display_name: 'Calle Hidalgo 10, Centro',
	address: { road: 'Calle Hidalgo', house_number: '10' },
};

describe('lookup_reverse_geocode', () => {
	test('devuelve la dirección cuando Nominatim responde', async () => {
		const result = await lookup_reverse_geocode('20.62', '-103.07', {
			fetch: async () => ({
				ok: true,
				json: async () => address,
			}),
		});
		expect(result.status).toBe(200);
		expect(result.body).toEqual(address);
	});

	test('no es 500 si la red falla', async () => {
		const result = await lookup_reverse_geocode('20.62', '-103.07', {
			fetch: async () => {
				throw new TypeError('fetch failed');
			},
		});
		expect(result.status).not.toBe(500);
		expect(result.status).toBe(200);
		expect(result.body.display_name).toBe('');
		expect(result.body.message).toBe(REVERSE_GEOCODE_UNAVAILABLE_MESSAGE);
	});

	test('no es 500 si Nominatim responde con error', async () => {
		const result = await lookup_reverse_geocode('20.62', '-103.07', {
			fetch: async () => ({
				ok: false,
				json: async () => ({ error: 'upstream' }),
			}),
		});
		expect(result.status).toBe(200);
		expect(result.body.display_name).toBe('');
		expect(result.body.address).toEqual({});
	});

	test('corta la espera y responde sin dirección', async () => {
		const result = await lookup_reverse_geocode('20.62', '-103.07', {
			timeout_ms: 30,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(init.signal?.reason ?? new Error('aborted'));
					});
				}),
		});
		expect(result.status).toBe(200);
		expect(result.body.message).toBe(REVERSE_GEOCODE_UNAVAILABLE_MESSAGE);
	});

	test('pide lat y lon', async () => {
		let called = false;
		const result = await lookup_reverse_geocode(' ', '', {
			fetch: async () => {
				called = true;
				return { ok: true, json: async () => address };
			},
		});
		expect(called).toBe(false);
		expect(result.status).toBe(400);
	});
});
