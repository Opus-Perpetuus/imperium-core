import { describe, expect, test } from 'bun:test';
import type { ImperiumStore } from './store.ts';
import {
	CODICE_LOGO_REF,
	SUPERADMIN_EMAIL,
	seed_superadmin,
} from './superadmin-seed.ts';

type Row = Record<string, unknown>;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = { user: [], 'attachment-management': [], ...seed };
	let next = 1;
	const store = {
		data,
		has: (resource: string) => resource in data,
		find_where: async (resource: string, where: Row) =>
			data[resource]!.find((row) =>
				Object.entries(where).every(([k, v]) => row[k] === v),
			) ?? null,
		insert: async (resource: string, doc: Row) => {
			const row = { _id: `id-${next++}`, ...doc };
			data[resource]!.push(row);
			return row;
		},
		update: async (resource: string, id: string, patch: Row) => {
			const row = data[resource]!.find((r) => r._id === id)!;
			Object.assign(row, patch);
			return row;
		},
	};
	return store as typeof store & ImperiumStore;
}

describe('seed_superadmin', () => {
	test('base nueva: crea el superadministrador con el logo de Codice', async () => {
		const store = memory_store({});
		expect(await seed_superadmin(store)).toBe(2);
		const [logo] = store.data['attachment-management']!;
		const [admin] = store.data.user!;
		expect(logo!._ref).toBe(CODICE_LOGO_REF);
		expect(String(logo!.base64).length).toBeGreaterThan(1000);
		expect(admin!._ref).toBe('user-menu-management-0');
		expect(admin!.email).toBe(SUPERADMIN_EMAIL);
		expect(admin!.img).toBe(logo!._id);
		expect(String(admin!.password)).toStartWith('$argon2id$');
	});

	test('ya existe: restablece correo, contraseña e imagen sin duplicar el logo', async () => {
		const store = memory_store({
			user: [
				{
					_id: 'admin',
					_ref: 'user-menu-management-0',
					name: 'Yael',
					email: 'otro@correo.com',
					password: 'otra',
					img: 'foto-propia',
					is_active: false,
				},
			],
		});
		await seed_superadmin(store);
		expect(await seed_superadmin(store)).toBe(0);
		const [admin] = store.data.user!;
		expect(store.data['attachment-management']).toHaveLength(1);
		expect(store.data.user).toHaveLength(1);
		expect(admin!.name).toBe('Yael');
		expect(admin!.email).toBe(SUPERADMIN_EMAIL);
		expect(admin!.img).toBe(store.data['attachment-management']![0]!._id);
		expect(String(admin!.password)).toStartWith('$argon2id$');
		expect(admin!.is_active).toBe(true);
	});
});
