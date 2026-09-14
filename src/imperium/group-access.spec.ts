import { describe, expect, test } from 'bun:test';
import {
	access_has_full_admin_scope,
	can_manage_user_groups,
	collect_group_menu_ids,
	filter_menus_for_access,
	keep_reshaped_menus_for_access,
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

	test('con grupos solo se listan menus_ids, no todos los del modelo', () => {
		const rows = [
			{ _id: 'menu-reports', model: 'CitizenReport', parent_id: 'folder' },
			{ _id: 'menu-users', model: 'User', parent_id: 'folder' },
			{ _id: 'folder', model: '', parent_id: null },
		];
		const shown = filter_menus_for_access(rows, {
			has_user_groups: true,
			menu_ids: ['menu-reports'],
			models: ['CitizenReport', 'User'],
		});
		const ids = shown.map((row) => row._id).sort();
		expect(ids).toEqual(['folder', 'menu-reports']);
	});

	test('grupos sin menus_ids no heredan el catálogo entero', () => {
		expect(
			filter_menus_for_access([{ _id: 'menu-users', model: 'User' }], {
				has_user_groups: true,
				menu_ids: [],
				models: ['User', 'CitizenReport', 'MenuManagement'],
			}),
		).toEqual([]);
	});

	test('quien actualiza UserGroup puede gestionar el picker', () => {
		expect(
			can_manage_user_groups({
				has_full_access: false,
				permissions_by_model: { UserGroup: { allow_update: true } },
			}),
		).toBe(true);
		expect(
			can_manage_user_groups({
				has_full_access: false,
				permissions_by_model: { User: { allow_update: true } },
			}),
		).toBe(false);
	});

	test('sin filas permitidas no deja raíces sintéticas del catálogo', () => {
		expect(
			keep_reshaped_menus_for_access(
				[],
				[
					{
						_id: 'subject-root-configuraciones-de-vista',
						parent_id: null,
					},
					{ _id: 'subject-root-rh', parent_id: null },
				],
			),
		).toEqual([]);
	});

	test('un hijo permitido arrastra su carpeta padre, no otras apps', () => {
		const allowed = [{ _id: 'leaf-contrato', parent_id: 'root-cm' }];
		const reshaped = [
			{ _id: 'root-cm', parent_id: null },
			{ _id: 'leaf-contrato', parent_id: 'root-cm' },
			{ _id: 'subject-root-configuraciones-de-vista', parent_id: null },
			{
				_id: 'subject-mod-vista',
				parent_id: 'subject-root-configuraciones-de-vista',
			},
		];
		const shown = keep_reshaped_menus_for_access(allowed, reshaped);
		expect(shown.map((row) => row._id).sort()).toEqual([
			'leaf-contrato',
			'root-cm',
		]);
	});
});
