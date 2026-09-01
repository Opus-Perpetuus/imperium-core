import { describe, expect, test } from 'bun:test';
import {
	menu_is_under_root,
	menu_path_is_disabled,
	reshape_subject_menus,
} from './auth.ts';

describe('menu_path_is_disabled', () => {
	const disabled = new Set(['/turnos', '/vehicle']);

	test('hides the subject root and nested paths', () => {
		expect(menu_path_is_disabled('/turnos', disabled)).toBe(true);
		expect(menu_path_is_disabled('/turnos/shift', disabled)).toBe(true);
		expect(menu_path_is_disabled('/vehicle/maintenance', disabled)).toBe(
			true,
		);
	});

	test('keeps unrelated menus', () => {
		expect(menu_path_is_disabled('/almacen', disabled)).toBe(false);
		expect(menu_path_is_disabled('/turnos-extra', disabled)).toBe(false);
		expect(menu_path_is_disabled('', disabled)).toBe(false);
	});
});

describe('reshape_subject_menus hierarchy', () => {
	const store = {
		subjects: [
			{
				slug: 'control-municipal',
				name: 'Control municipal',
				path: '/control-municipal',
				menu_ref: 'control-municipal-menu-root',
				technical_id: 'subject-control-municipal',
				image: '',
				modules: [
					{
						resource: 'contrato',
						path: '/contrato',
						menu_ref: 'contrato-menu-management-0',
						name: 'Contratos',
					},
					{
						resource: 'violation',
						path: '/violation',
						menu_ref: 'violation-menu-management-0',
						name: 'Infracciones',
					},
					{
						resource: 'orphan',
						path: '/cobranza',
						menu_ref: 'cobranza-menu-management-root',
						name: 'Cobranza',
					},
				],
			},
		],
	};

	test('walks folder parents up to the subject root', () => {
		const folder = { _id: 'folder-agua', parent_id: 'root-cm' };
		const leaf = { _id: 'leaf-contrato', parent_id: 'folder-agua' };
		const by_id = new Map<string, typeof folder | typeof leaf>([
			['root-cm', { _id: 'root-cm', parent_id: null }],
			['folder-agua', folder],
			['leaf-contrato', leaf],
		]);
		expect(menu_is_under_root(leaf, 'root-cm', by_id)).toBe(true);
		expect(menu_is_under_root(folder, 'root-cm', by_id)).toBe(true);
		expect(menu_is_under_root(leaf, 'other-root', by_id)).toBe(false);
	});

	test('keeps seeded folders as the first level; only orphans attach to root', () => {
		const rows = [
			{
				_id: 'root-cm',
				name: 'Control municipal',
				path: '',
				parent_id: null,
				_ref: 'control-municipal-menu-root',
			},
			{
				_id: 'folder-agua',
				name: 'Agua potable',
				path: '',
				parent_id: 'root-cm',
				_ref: 'agua-menu-root',
				icon: 'fa-tint',
			},
			{
				_id: 'folder-infracciones',
				name: 'Infracciones',
				path: '',
				parent_id: 'root-cm',
				_ref: 'violation-menu-management-root',
				icon: 'fa-receipt',
			},
			{
				_id: 'leaf-contrato',
				name: 'Contratos',
				path: '/contrato',
				parent_id: 'folder-agua',
				_ref: 'contrato-menu-management-0',
				icon: 'fa-file-contract',
			},
			{
				_id: 'leaf-violation',
				name: 'Infracciones',
				path: '/violation',
				parent_id: 'folder-infracciones',
				_ref: 'violation-menu-management-0',
				icon: 'fa-file-signature',
			},
			{
				_id: 'leaf-orphan',
				name: 'Cobranza',
				path: '/cobranza',
				parent_id: '',
				_ref: 'cobranza-menu-management-root',
				icon: 'fa-cash-register',
			},
		];
		const out = reshape_subject_menus(store, rows);
		const by_id = Object.fromEntries(out.map((m) => [String(m._id), m]));
		expect(by_id['leaf-contrato']?.parent_id).toBe('folder-agua');
		expect(by_id['leaf-violation']?.parent_id).toBe('folder-infracciones');
		expect(by_id['leaf-orphan']?.parent_id).toBe('root-cm');
		expect(by_id['folder-agua']?.parent_id).toBe('root-cm');
		const first_level = out.filter(
			(m) => String(m.parent_id ?? '') === 'root-cm',
		);
		expect(first_level.map((m) => String(m.name)).sort()).toEqual([
			'Agua potable',
			'Cobranza',
			'Infracciones',
		]);
	});
});
