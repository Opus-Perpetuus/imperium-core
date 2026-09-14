import { describe, expect, test } from 'bun:test';
import {
	menu_is_under_root,
	menu_path_is_disabled,
	reshape_subject_menus,
} from './auth.ts';
import {
	filter_menus_for_access,
	keep_reshaped_menus_for_access,
} from './group-access.ts';

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

describe('reshape_subject_menus tienda icons', () => {
	const store = {
		subjects: [
			{
				slug: 'tienda',
				name: 'Tienda',
				path: '/tienda',
				menu_ref: 'tienda-menu-root',
				technical_id: 'subject-tienda',
				image: '',
				modules: [
					{
						resource: 'providers',
						path: '/providers',
						menu_ref: 'tienda-providers',
						name: 'Proveedores',
						icon: 'fa-truck',
					},
					{
						resource: 'catalog',
						path: '/catalog',
						menu_ref: 'tienda-catalog',
						name: 'Catálogo',
						icon: 'fa-boxes-stacked',
					},
					{
						resource: 'pricing',
						path: '/pricing',
						menu_ref: 'tienda-pricing',
						name: 'Precios',
						icon: 'fa-coins',
					},
					{
						resource: 'sync',
						path: '/sync',
						menu_ref: 'tienda-sync',
						name: 'Sincronización',
						icon: 'fa-rotate',
					},
					{
						resource: 'orders',
						path: '/orders',
						menu_ref: 'tienda-orders',
						name: 'Pedidos',
						icon: 'fa-clipboard-list',
					},
				],
				menus: [
					{
						name: 'Administración',
						menu_ref: 'tienda-nav-admin',
						path: '',
						icon: 'fa-cogs',
						parent_ref: 'tienda-menu-root',
					},
					{
						name: 'Tienda pública',
						menu_ref: 'tienda-nav-store',
						path: '',
						icon: 'fa-store',
						parent_ref: 'tienda-menu-root',
					},
					{
						name: 'Proveedores',
						menu_ref: 'tienda-providers',
						path: '/providers',
						icon: 'fa-truck',
						parent_ref: 'tienda-nav-admin',
					},
					{
						name: 'Conectores',
						menu_ref: 'tienda-connectors',
						path: '/connectors',
						icon: 'fa-plug',
						parent_ref: 'tienda-nav-admin',
					},
					{
						name: 'Catálogo',
						menu_ref: 'tienda-catalog',
						path: '/catalog',
						icon: 'fa-boxes-stacked',
						parent_ref: 'tienda-nav-admin',
					},
					{
						name: 'Precios',
						menu_ref: 'tienda-pricing',
						path: '/pricing',
						icon: 'fa-coins',
						parent_ref: 'tienda-nav-admin',
					},
					{
						name: 'Sincronización',
						menu_ref: 'tienda-sync',
						path: '/sync',
						icon: 'fa-rotate',
						parent_ref: 'tienda-nav-admin',
					},
					{
						name: 'Pedidos',
						menu_ref: 'tienda-orders',
						path: '/orders',
						icon: 'fa-clipboard-list',
						parent_ref: 'tienda-nav-admin',
					},
					{
						name: 'Inicio',
						menu_ref: 'tienda-store-home',
						path: '/store-home',
						icon: 'fa-house',
						parent_ref: 'tienda-nav-store',
					},
					{
						name: 'Catálogo público',
						menu_ref: 'tienda-store-catalog',
						path: '/store-catalog',
						icon: 'fa-shop',
						parent_ref: 'tienda-nav-store',
					},
					{
						name: 'Carrito',
						menu_ref: 'tienda-store-cart',
						path: '/store-cart',
						icon: 'fa-cart-shopping',
						parent_ref: 'tienda-nav-store',
					},
					{
						name: 'Listas',
						menu_ref: 'tienda-store-lists',
						path: '/store-lists',
						icon: 'fa-list',
						parent_ref: 'tienda-nav-store',
					},
					{
						name: 'Favoritos',
						menu_ref: 'tienda-store-favorites',
						path: '/store-favorites',
						icon: 'fa-heart',
						parent_ref: 'tienda-nav-store',
					},
					{
						name: 'Mis pedidos',
						menu_ref: 'tienda-store-orders',
						path: '/store-orders',
						icon: 'fa-bag-shopping',
						parent_ref: 'tienda-nav-store',
					},
					{
						name: 'Direcciones',
						menu_ref: 'tienda-store-addresses',
						path: '/store-addresses',
						icon: 'fa-location-dot',
						parent_ref: 'tienda-nav-store',
					},
					{
						name: 'Formas de pago',
						menu_ref: 'tienda-store-payment-methods',
						path: '/store-payment-methods',
						icon: 'fa-credit-card',
						parent_ref: 'tienda-nav-store',
					},
				],
			},
		],
	};

	test('root is subject:tienda and every child has a distinct paintable icon', () => {
		const out = reshape_subject_menus(store, []);
		const by_ref = Object.fromEntries(
			out.map((m) => [String(m._ref), m]),
		);
		const root = by_ref['tienda-menu-root'];
		expect(root?.icon).toBe('subject:tienda');
		const admin = by_ref['tienda-nav-admin'];
		const storefront = by_ref['tienda-nav-store'];
		expect(String(admin?.parent_id)).toBe(String(root?._id));
		expect(String(storefront?.parent_id)).toBe(String(root?._id));
		const first_level = out.filter(
			(m) => String(m.parent_id ?? '') === String(root?._id),
		);
		expect(first_level.map((m) => String(m.name)).sort()).toEqual([
			'Administración',
			'Tienda pública',
		]);
		const children = out.filter(
			(m) => String(m._id) !== String(root?._id),
		);
		expect(children.length).toBeGreaterThanOrEqual(16);
		const icons = children.map((m) => String(m.icon ?? '').trim());
		for (const icon of icons) {
			expect(icon).not.toBe('');
			expect(icon).not.toBe('fa-circle');
			expect(icon).not.toBe('package');
			expect(icon).not.toBe('home');
		}
		expect(new Set(icons).size).toBe(icons.length);
		expect(icons.some((icon) => icon === 'package')).toBe(false);
		expect(by_ref['tienda-providers']?.icon).toBe('fa-truck');
		expect(by_ref['tienda-store-cart']?.icon).toBe('fa-cart-shopping');
		expect(String(by_ref['tienda-providers']?.parent_id)).toBe(
			String(admin?._id),
		);
		expect(String(by_ref['tienda-store-home']?.parent_id)).toBe(
			String(storefront?._id),
		);
	});

	test('catalog.json tienda tree is the same contract', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const catalog = JSON.parse(
			readFileSync(join(import.meta.dir, '../../catalog.json'), 'utf8'),
		) as {
			subjects: Array<{
				slug: string;
				name: string;
				path: string;
				menu_ref: string;
				technical_id: string;
				image?: string;
				modules: Array<{
					resource: string;
					path: string;
					menu_ref: string;
					name: string;
					icon?: string;
				}>;
				menus?: Array<{
					menu_ref: string;
					name: string;
					path?: string;
					icon: string;
					parent_ref?: string;
				}>;
			}>;
		};
		const tienda = catalog.subjects.find((s) => s.slug === 'tienda');
		expect(tienda).toBeTruthy();
		const out = reshape_subject_menus(
			{
				subjects: [
					{
						slug: tienda!.slug,
						name: tienda!.name,
						path: tienda!.path,
						menu_ref: tienda!.menu_ref,
						technical_id: tienda!.technical_id,
						image: tienda!.image ?? '',
						modules: tienda!.modules.map((m) => ({
							resource: m.resource,
							path: m.path,
							menu_ref: m.menu_ref,
							name: m.name,
							icon: m.icon,
						})),
						menus: tienda!.menus,
					},
				],
			},
			[],
		);
		const root = out.find((m) => String(m._ref) === 'tienda-menu-root');
		expect(root?.icon).toBe('subject:tienda');
		const children = out.filter(
			(m) => String(m._id) !== String(root?._id),
		);
		const names = new Set(children.map((m) => String(m.name)));
		for (const name of [
			'Administración',
			'Tienda pública',
			'Proveedores',
			'Conectores',
			'Catálogo',
			'Precios',
			'Sincronización',
			'Pedidos',
			'Inicio',
			'Catálogo público',
			'Carrito',
			'Listas',
			'Favoritos',
			'Mis pedidos',
			'Direcciones',
			'Formas de pago',
		]) {
			expect(names.has(name)).toBe(true);
		}
		const icons = children.map((m) => String(m.icon ?? '').trim());
		expect(icons.every((icon) => icon && icon !== 'fa-circle')).toBe(true);
		expect(new Set(icons).size).toBe(icons.length);
	});
});

describe('launcher menus respect access after catalog reshape', () => {
	const store = {
		subjects: [
			{
				slug: 'configuraciones-de-vista',
				name: 'Configuraciones de vista',
				path: '/view-config-preset',
				menu_ref: 'view-config-preset-menu-management-0',
				technical_id: 'subject-configuraciones-de-vista',
				image: '',
				modules: [
					{
						resource: 'view-config-preset',
						path: '/view-config-preset',
						menu_ref: 'view-config-preset-menu-management-0',
						name: 'Configuraciones de vista',
					},
				],
			},
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
				],
			},
		],
	};

	function launcher_menus(
		rows: Array<Record<string, unknown>>,
		access: {
			has_user_groups?: boolean;
			menu_ids?: string[];
			models?: string[];
			has_full_access?: boolean;
		},
	) {
		const filtered = filter_menus_for_access(rows, access);
		return keep_reshaped_menus_for_access(
			filtered,
			reshape_subject_menus(store, filtered),
		);
	}

	test('reshape solo no oculta Configuraciones de vista; el recorte ACL sí', () => {
		const leaked = reshape_subject_menus(store, []);
		expect(
			leaked.some(
				(m) => String(m._ref) === 'view-config-preset-menu-management-0',
			),
		).toBe(true);
		expect(launcher_menus([], { has_user_groups: true, menu_ids: [] })).toEqual(
			[],
		);
	});

	test('COORDINACIONES sin ViewConfigPreset no ve esa app', () => {
		const rows = [
			{
				_id: 'vista-1',
				name: 'Configuraciones de vista',
				path: '/view-config-preset',
				parent_id: null,
				_ref: 'view-config-preset-menu-management-0',
				model: 'ViewConfigPreset',
			},
			{
				_id: 'leaf-contrato',
				name: 'Contratos',
				path: '/contrato',
				parent_id: null,
				_ref: 'contrato-menu-management-0',
				model: 'Contrato',
			},
		];
		const out = launcher_menus(rows, {
			has_user_groups: true,
			menu_ids: ['vista-1', 'leaf-contrato'],
			models: ['Contrato'],
		});
		const refs = out.map((m) => String(m._ref ?? ''));
		expect(refs).toContain('contrato-menu-management-0');
		expect(refs).not.toContain('view-config-preset-menu-management-0');
		expect(
			out.some((m) =>
				String(m.path ?? '').includes('/view-config-preset'),
			),
		).toBe(false);
		expect(
			out.some(
				(m) => String(m.subject_slug ?? '') === 'configuraciones-de-vista',
			),
		).toBe(false);
	});
});
