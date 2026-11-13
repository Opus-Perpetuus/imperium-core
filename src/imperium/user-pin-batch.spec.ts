import { describe, expect, test } from 'bun:test';
import { prepare_user_pin_batch_update } from './crud.ts';
import { diff_docs } from './history.ts';

const previous = {
	_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	name: 'PIN SES-6-MATRIZ-1',
	document_id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
	document_model: 'PosSession',
	document_collection: 'pos-session',
	pin_hash: '$argon2id$v=19$m=65536,t=3,p=4$viejo$viejo',
	pin_type: 'numeric',
	pin_length: 4,
	pin_version: 1,
	assigned_users: ['cccccccccccccccccccccccc'],
	protected_routes: [],
};

const store = {
	find_id: async () => previous,
	available_mongoose_models: () => [{ model_name: 'PosSession', collection: 'pos-session' }],
} as never;

describe('PUT /user-pin/batch', () => {
	test('un PIN nuevo se guarda como hash y sube la versión, sin texto plano', async () => {
		const out = await prepare_user_pin_batch_update(store, previous._id, {
			_id: previous._id,
			plain_pin: '4321',
		});
		expect(out.plain_pin).toBeUndefined();
		expect(out.regenerate_pin).toBeUndefined();
		expect(String(out.pin_hash)).toStartWith('$argon2');
		expect(out.pin_hash).not.toBe(previous.pin_hash);
		expect(out.pin_version).toBe(2);
		const argon2 = await import('argon2');
		expect(await argon2.verify(String(out.pin_hash), '4321')).toBe(true);
	});

	test('regenerar sin PIN escrito también cambia el hash', async () => {
		const out = await prepare_user_pin_batch_update(store, previous._id, {
			regenerate_pin: true,
		});
		expect(out.pin_hash).not.toBe(previous.pin_hash);
		expect(out.pin_version).toBe(2);
	});

	test('el historial nunca registra el PIN ni su hash', () => {
		const changes = diff_docs(
			{ pin_hash: 'a' },
			{ pin_hash: 'b', plain_pin: '4321', regenerate_pin: true },
		);
		expect(changes).toEqual([]);
	});
});
