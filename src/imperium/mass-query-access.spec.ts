import { describe, expect, test } from 'bun:test';
import { assert_http_access, HttpAccessDeniedError } from './auth.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const LECTOR = '507f1f77bcf86cd7994390c1';
const SIN_LECTURA = '507f1f77bcf86cd7994390c2';

function memory_store(): ImperiumStore {
	const data: Record<string, ImperiumDoc[]> = {
		user: [],
		'user-group': [
			{
				_id: '507f1f77bcf86cd7994390d1',
				_ref: 'user-group-it',
				name: 'IT Administrador',
				user_ids: [LECTOR],
				is_active: true,
			},
			{
				_id: '507f1f77bcf86cd7994390d2',
				_ref: 'user-group-otro',
				name: 'Otro',
				user_ids: [SIN_LECTURA],
				is_active: true,
			},
		],
		'access-rights': [
			{
				_id: 'ar-ug-read',
				model_id: 'UserGroup',
				group_id: 'user-group-it',
				allow_read: true,
				allow_create: false,
				allow_update: false,
				allow_delete: false,
				is_active: true,
			},
			{
				_id: 'ar-ug-create',
				model_id: 'UserGroup',
				group_id: 'user-group-otro',
				allow_read: false,
				allow_create: true,
				allow_update: false,
				allow_delete: false,
				is_active: true,
			},
		],
	};
	return {
		has: (resource: string) => Object.hasOwn(data, resource),
		loc: (resource: string) => ({ resource }),
		is_model_installed: () => true,
		available_mongoose_models: () => [],
		async *scan(resource: string) {
			yield data[resource] ?? [];
		},
		async find_many() {
			return { rows: [], total: 0 };
		},
	} as unknown as ImperiumStore;
}

const lector: ImperiumDoc = { _id: LECTOR, name: 'Lector', email: 'lector@local.test' };
const sin_lectura: ImperiumDoc = { _id: SIN_LECTURA, name: 'Sin lectura', email: 'otro@local.test' };

describe('POST /:recurso/mass-query exige leer, no crear', () => {
	test('con solo permiso de leer pasa', async () => {
		await expect(
			assert_http_access(memory_store(), lector, 'user-group', 'POST', { rest: '/mass-query' }),
		).resolves.toBeUndefined();
	});

	test('con crear pero sin leer es 403 y el mensaje habla de leer', async () => {
		const err = await assert_http_access(memory_store(), sin_lectura, 'user-group', 'POST', {
			rest: '/mass-query',
		}).catch((e) => e);
		expect(err).toBeInstanceOf(HttpAccessDeniedError);
		expect(err.status).toBe(403);
		expect(err.message).toContain('No puedes leer registros de UserGroup');
	});

	test('el POST de alta sigue exigiendo crear', async () => {
		const err = await assert_http_access(memory_store(), lector, 'user-group', 'POST', {
			rest: '/',
		}).catch((e) => e);
		expect(err).toBeInstanceOf(HttpAccessDeniedError);
		expect(err.message).toContain('No puedes crear registros de UserGroup');
	});
});
