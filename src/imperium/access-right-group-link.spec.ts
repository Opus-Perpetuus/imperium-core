import { describe, expect, test } from 'bun:test';
import {
	access_right_group_for_form,
	link_access_right_to_group,
} from './access-right-group-link.ts';
import type { ImperiumDoc } from './envelope.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

function store_with(groups: ImperiumDoc[]): { store: ImperiumStore; groups: ImperiumDoc[] } {
	const rows = groups.map((g) => ({ ...g }));
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.has = (resource: string) => resource === 'user-group';
	store.find_id = async (_resource: string, id: string) =>
		rows.find((g) => String(g._id) === String(id)) ?? null;
	store.find_where = (async (_resource: string, where: Record<string, unknown>) =>
		rows.find((g) => g._ref === where._ref) ?? null) as ImperiumStore['find_where'];
	store.update = async (_resource: string, id: string, patch: ImperiumDoc) => {
		const index = rows.findIndex((g) => String(g._id) === String(id));
		if (index < 0) return null;
		rows[index] = { ...rows[index], ...patch };
		return rows[index]!;
	};
	return { store, groups: rows };
}

describe('permiso con grupo queda en la lista del grupo (#157)', () => {
	test('lo agrega a access_rights_ids del grupo por _id', async () => {
		const { store, groups } = store_with([
			{ _id: 'g-ventas', name: 'Ventas', access_rights_ids: ['ar-1'] },
		]);
		await link_access_right_to_group(store, { _id: 'ar-pr', group_id: 'g-ventas' });
		expect(groups[0]?.access_rights_ids).toEqual(['ar-1', 'ar-pr']);
	});

	test('acepta el _ref del grupo y no duplica', async () => {
		const { store, groups } = store_with([
			{ _id: 'g-1', _ref: 'user-group-ventas', access_rights_ids: [{ _id: 'ar-pr' }] },
		]);
		const changed = await link_access_right_to_group(store, {
			_id: 'ar-pr',
			group_id: 'user-group-ventas',
		});
		expect(changed).toBeNull();
		expect(groups[0]?.access_rights_ids).toEqual([{ _id: 'ar-pr' }]);
	});

	test('sin grupo o con grupo inexistente no toca nada', async () => {
		const { store, groups } = store_with([{ _id: 'g-1', access_rights_ids: [] }]);
		expect(await link_access_right_to_group(store, { _id: 'ar-x', group_id: '' })).toBeNull();
		expect(await link_access_right_to_group(store, { _id: 'ar-x', group_id: 'nope' })).toBeNull();
		expect(groups[0]?.access_rights_ids).toEqual([]);
	});

	test('acepta group_id poblado y una lista guardada como JSON', async () => {
		const { store, groups } = store_with([
			{ _id: 'g-ventas', name: 'Ventas', access_rights_ids: '["ar-1"]' },
		]);
		await link_access_right_to_group(store, {
			_id: 'ar-pr',
			group_id: { _id: 'g-ventas', name: 'Ventas' },
		});
		expect(groups[0]?.access_rights_ids).toEqual(['ar-1', 'ar-pr']);
	});

	test('el formulario recibe el _id aunque el permiso guarde el _ref del grupo', async () => {
		const { store } = store_with([
			{ _id: 'g-1', _ref: 'user-group-ventas', name: 'Ventas' },
		]);
		const shown = await access_right_group_for_form(store, {
			_id: 'ar-pr',
			group_id: 'user-group-ventas',
		});
		expect(shown.group_id).toBe('g-1');
	});
});
