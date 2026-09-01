import { describe, expect, test } from 'bun:test';
import {
	access_has_full_admin_scope,
	collect_group_menu_ids,
} from './group-access.ts';

describe('group-access menus and admin scope', () => {
	test('collect_group_menu_ids lee menus_ids de los grupos del usuario', () => {
		expect(
			collect_group_menu_ids([
				{ menus_ids: ['menu-a', { _id: 'menu-b' }] },
				{ menus_ids: ['menu-a'] },
			]),
		).toEqual(['menu-a', 'menu-b']);
	});

	test('un no-admin no tiene has_full_access', () => {
		expect(access_has_full_admin_scope({ has_full_access: false })).toBe(false);
		expect(access_has_full_admin_scope({ has_full_access: true })).toBe(true);
		expect(access_has_full_admin_scope(null)).toBe(false);
	});
});
