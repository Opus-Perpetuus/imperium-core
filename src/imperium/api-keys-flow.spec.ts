import { describe, expect, it } from 'bun:test';
import {
	API_KEY_PREFIX,
	new_api_key_candidate,
	prepare_api_key_create,
	prepare_api_key_update,
} from './api-keys-flow.ts';

const store_with = (taken: string[]) => ({
	find_where: async (_r: string, w: Record<string, unknown>) =>
		taken.includes(String(w.api_key)) ? { _id: 'x', api_key: w.api_key } : null,
});

describe('api-keys-flow', () => {
	it('la llave nueva lleva el prefijo y 48 hex', () => {
		expect(new_api_key_candidate()).toMatch(new RegExp(`^${API_KEY_PREFIX}[0-9a-f]{48}$`));
	});

	it('el alta genera la llave e ignora la que mande el cliente', async () => {
		const doc = await prepare_api_key_create(store_with([]) as never, {
			name: 'Remota',
			api_key: 'elegida-por-el-cliente',
		});
		expect(String(doc.api_key)).toStartWith(API_KEY_PREFIX);
		expect(doc.name).toBe('Remota');
	});

	it('si la llave ya existe, prueba otra', async () => {
		const seq = ['imperium_iak_a', 'imperium_iak_b'];
		const doc = await prepare_api_key_create(store_with(['imperium_iak_a']) as never, {}, () => seq.shift()!);
		expect(doc.api_key).toBe('imperium_iak_b');
	});

	it('la edición conserva la llave guardada', () => {
		const doc = prepare_api_key_update({ name: 'X', api_key: '' }, { _id: '1', api_key: 'imperium_iak_ok' });
		expect(doc.api_key).toBe('imperium_iak_ok');
		expect(doc.name).toBe('X');
	});
});
