import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { build_access, build_menus } from './auth.ts';
import { project_registry_snapshot } from './app-registry-manifest.ts';
import type { AppManifestSnapshotBody } from './app-registry-manifest.ts';
import type { SnapshotRow } from './app-registry-store.ts';
import {
	ensure_installed_subject_menus,
	plan_subject_menus,
} from './subject-menu-seed.ts';
import {
	subject_grant_refs,
	subject_grants_from_menus,
} from './subject-identity.ts';
import { overlay_snapshot_menus } from './snapshot-menu-overlay.ts';
import type { ImperiumStore, SubjectInfo } from './store.ts';

const SCHEMA = 'https://schemas.opus-perpetuus.dev/imperium/kirlet-manifest/1.0.json';

const vehiculos: SubjectInfo = {
	slug: 'vehiculos',
	name: 'Vehículos',
	path: '/vehicle',
	menu_ref: 'vehicle-menu-management-0',
	technical_id: 'subject-vehiculos',
	image: '',
	modules: [
		{
			resource: 'bitacora',
			path: '/bitacora',
			menu_ref: 'bitacora-menu',
			name: 'Bitácoras de revisión',
			icon: 'fa-book-open',
		},
	],
	menus: [
		{
			name: 'Recordatorios',
			menu_ref: 'vehiculos-recordatorios-menu',
			path: '/recordatorios',
			icon: 'fa-bell',
			parent_ref: 'vehicle-menu-management-0',
		},
	],
};

const reportes: SubjectInfo = {
	slug: 'reportes',
	name: 'Reportes',
	path: '/reportes',
	menu_ref: 'reportes-menu-root',
	technical_id: 'subject-reportes',
	image: '',
	modules: [
		{
			resource: 'reporte',
			path: '/reporte',
			menu_ref: 'reporte-menu',
			name: 'Reportes',
			icon: 'fa-chart-bar',
		},
	],
};

const apagada: SubjectInfo = {
	slug: 'apagada',
	name: 'Apagada',
	path: '/apagada',
	menu_ref: 'apagada-menu-root',
	technical_id: 'subject-apagada',
	image: '',
	modules: [
		{
			resource: 'secreto',
			path: '/secreto-catalogo',
			menu_ref: 'apagada-secreto-menu',
			name: 'Secreto de catálogo',
			icon: 'fa-lock',
		},
	],
};

function manifest(menu: unknown[], pages: unknown[]) {
	return {
		$schema: SCHEMA,
		manifestVersion: 1,
		id: 'SUBJECT-vehiculos',
		technicalId: 'subject-vehiculos',
		name: 'Vehículos',
		version: '0.11.0',
		image: 'ghcr.io/opus-perpetuus/subject-vehiculos:0.11.0',
		compat: { nox: '>=0.2.0 <2.0.0', kit: '^0.2.0' },
		api: { basePath: '/api/m/subject-vehiculos', port: 3000, healthPath: '/health' },
		permissions: [
			{ id: 'subject.vehiculos.bitacora.read', label: 'Ver bitácoras' },
			{ id: 'subject.vehiculos.envio-revision.read', label: 'Ver envíos a revisión' },
			{ id: 'subject.vehiculos.envio-revision.write', label: 'Editar envíos a revisión' },
			{ id: 'subject.vehiculos.escaparate.read', label: 'Ver escaparate' },
		],
		pages,
		menu,
	};
}

function page(id: string, path: string, leaf: Record<string, unknown>) {
	return {
		id,
		path,
		permission: `subject.vehiculos.${path}.read`,
		leaf,
	};
}

function project(body: Record<string, unknown>): AppManifestSnapshotBody {
	const result = project_registry_snapshot(body, 'vehiculos');
	if (!result.ok) {
		throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
	}
	return result.snapshot;
}

const envio_page = page('vehiculos.envio-revision', 'envio-revision', {
	kind: 'crud',
	appBase: 'envio-revision',
	icon: 'fa-file-signature',
});
const bitacora_page = page('vehiculos.bitacora', 'bitacora', { kind: 'page' });
const escaparate_page = page('vehiculos.escaparate', 'escaparate', { kind: 'page' });

const vehiculos_snapshot = project(
	manifest(
		[
			{
				id: 'vehiculos-root',
				label: 'Vehículos',
				children: [
					{
						id: 'vehiculos.bitacora',
						label: 'Bitácoras de revisión',
						path: 'bitacora',
						pageId: 'vehiculos.bitacora',
						permission: 'subject.vehiculos.bitacora.read',
					},
					{
						id: 'vehiculos.envio-revision',
						label: 'Envíos a revisión',
						path: 'envio-revision',
						pageId: 'vehiculos.envio-revision',
						permission: 'subject.vehiculos.envio-revision.read',
						icon: 'fa-file-signature',
					},
					{
						id: 'vehiculos.escaparate',
						label: 'Escaparate',
						path: 'escaparate',
						pageId: 'vehiculos.escaparate',
						permission: 'subject.vehiculos.escaparate.read',
						realm: 'public',
					},
				],
			},
		],
		[bitacora_page, envio_page, escaparate_page],
	),
);

function bare_snapshot(slug: string, label: string, segment: string): AppManifestSnapshotBody {
	return {
		manifestVersion: 1,
		slug,
		technicalId: `subject-${slug}`,
		name: label,
		version: '0.0.1',
		image: 'local',
		permissions: [{ id: `subject.${slug}.${segment}.read`, label }],
		menu: [
			{
				id: `${slug}.${segment}`,
				label,
				path: segment,
				pageId: `${slug}.${segment}`,
				permission: `subject.${slug}.${segment}.read`,
			},
		],
		leaves: [
			{
				segment,
				pageId: `${slug}.${segment}`,
				permission: `subject.${slug}.${segment}.read`,
				kind: 'page',
				listOnly: false,
			},
		],
		widgets: [],
	};
}

function snapshot_row(manifest_body: AppManifestSnapshotBody): SnapshotRow {
	return {
		slug: manifest_body.slug,
		manifest_hash: manifest_body.slug,
		manifest: manifest_body,
		image_digest: null,
		previous_manifest: null,
	};
}

type Access = Awaited<ReturnType<typeof build_access>>;

function sql_of(
	rows: SnapshotRow[],
	opts: { snapshot_error?: boolean } = {},
): Bun.SQL {
	return {
		unsafe: async (query: string) => {
			if (query.includes('app_manifest_snapshot')) {
				if (opts.snapshot_error) throw new Error('undefined_table');
				if (query.includes('SELECT')) return rows;
			}
			if (query.includes('FROM public.subject_installs')) {
				return [
					{ technical_id: 'subject-vehiculos', installed: true, status: 'installed' },
					{ technical_id: 'subject-reportes', installed: true, status: 'installed' },
				];
			}
			return [];
		},
	} as unknown as Bun.SQL;
}

function menu_store(rows: Array<Record<string, unknown>>): ImperiumStore {
	return {
		subjects: [vehiculos, reportes, apagada],
		has: (resource: string) =>
			resource === 'menu-management' || resource === 'module-management',
		scan: async function* (resource: string) {
			yield resource === 'menu-management' ? rows : [];
		},
	} as unknown as ImperiumStore;
}

function path_of(row: { path?: unknown }): string {
	return String(row.path ?? '').replace(/\/+$/, '');
}

describe('menú SIC desde el snapshot instalado', () => {
	const rows = [
		snapshot_row(vehiculos_snapshot),
		snapshot_row(bare_snapshot('apagada', 'Secreto', 'secreto')),
		snapshot_row(bare_snapshot('fantasma', 'Fantasma', 'fantasma')),
	];

	test('el admin ve Envíos a revisión bajo Vehículos y no pierde el catálogo', async () => {
		const menus = await build_menus(menu_store([]), sql_of(rows), {
			has_full_access: true,
		} as Access);
		const envio = menus.find((row) => path_of(row) === '/envio-revision');
		const root = menus.find((row) => String(row._id) === String(envio?.parent_id));
		expect(envio).toMatchObject({
			name: 'Envíos a revisión',
			path: '/envio-revision',
			_ref: 'vehiculos-envio-revision',
			icon: 'fa-file-signature',
		});
		expect(root).toMatchObject({ name: 'Vehículos', subject_slug: 'vehiculos' });
		expect(menus.filter((row) => path_of(row) === '/bitacora')).toHaveLength(1);
		expect(menus.some((row) => path_of(row) === '/recordatorios')).toBe(true);
		expect(menus.some((row) => path_of(row) === '/reporte')).toBe(true);
		expect(menus.some((row) => path_of(row) === '/escaparate')).toBe(false);
		expect(menus.some((row) => String(row.name) === 'Secreto')).toBe(false);
		expect(menus.some((row) => String(row.name) === 'Fantasma')).toBe(false);
		expect(menus.some((row) => path_of(row) === '/apagada')).toBe(false);
	});

	test('ACL asignado ve la hoja; sin asignación no se cuela', async () => {
		const seeded = [
			{
				_id: 'root-id',
				_ref: 'vehicle-menu-management-0',
				name: 'Vehículos',
				path: '/vehicle',
				parent_id: null,
				model: '',
			},
			{
				_id: 'envio-id',
				_ref: 'vehiculos-envio-revision',
				name: 'Envíos a revisión',
				path: '/envio-revision',
				parent_id: 'root-id',
				model: '',
			},
			{
				_id: 'bitacora-id',
				_ref: 'bitacora-menu',
				name: 'Bitácoras de revisión',
				path: '/bitacora',
				parent_id: 'root-id',
				model: '',
			},
		];
		const sql = sql_of(rows);
		const granted = await build_menus(menu_store(seeded), sql, {
			has_full_access: false,
			has_user_groups: true,
			menu_ids: ['envio-id'],
			models: [],
		} as Access);
		expect(granted.map((row) => path_of(row)).sort()).toEqual(['/envio-revision', '/vehicle']);
		expect(
			granted.find((row) => path_of(row) === '/envio-revision'),
		).toMatchObject({ parent_id: 'root-id', _ref: 'vehiculos-envio-revision' });

		const denied = await build_menus(menu_store(seeded), sql_of(rows), {
			has_full_access: false,
			has_user_groups: true,
			menu_ids: [],
			models: [],
		} as Access);
		expect(denied).toEqual([]);
	});

	test('sin tabla de snapshot el catálogo sigue pintándose', async () => {
		const menus = await build_menus(menu_store([]), sql_of([], { snapshot_error: true }), {
			has_full_access: true,
		} as Access);
		expect(menus.some((row) => path_of(row) === '/bitacora')).toBe(true);
		expect(menus.some((row) => path_of(row) === '/recordatorios')).toBe(true);
		expect(menus.some((row) => path_of(row) === '/envio-revision')).toBe(false);
	});

	test('la siembra deja la hoja para asignarla en ACL', async () => {
		const inserted: Array<Record<string, unknown>> = [];
		const store = {
			has: () => true,
			scan: async function* () {
				yield [];
			},
			insert: async (_resource: string, doc: Record<string, unknown>) => {
				const row = { ...doc, _id: `id-${doc._ref}` };
				inserted.push(row);
				return row;
			},
		} as unknown as ImperiumStore;
		await ensure_installed_subject_menus(store, [vehiculos], sql_of([snapshot_row(vehiculos_snapshot)]));
		const envio = inserted.find((row) => row._ref === 'vehiculos-envio-revision');
		expect(envio).toMatchObject({
			name: 'Envíos a revisión',
			path: '/envio-revision',
			parent_id: 'id-vehicle-menu-management-0',
		});
	});
});

describe('overlay del snapshot', () => {
	test('no pisa paths del catálogo ni un subject que no está en el snapshot', () => {
		const input = [reportes, vehiculos];
		const out = overlay_snapshot_menus(input, [vehiculos_snapshot]);
		expect(out[0]).toBe(reportes);
		expect(vehiculos.menus).toHaveLength(1);
		expect(out[1]?.menus?.[0]).toMatchObject({ path: '/recordatorios' });
		expect(out[1]?.menus?.filter((menu) => menu.path === '/bitacora')).toHaveLength(0);
		expect(out[1]?.modules).toBe(vehiculos.modules);
		expect(overlay_snapshot_menus([reportes], [])).toEqual([reportes]);
	});

	test('una carpeta nueva agrupa la hoja; una carpeta de paths ya conocidos no se crea', () => {
		const snap = project(
			manifest(
				[
					{
						id: 'vehiculos-root',
						label: 'Vehículos',
						children: [
							{
								id: 'operacion',
								label: 'Operación',
								children: [
									{
										id: 'vehiculos.envio-revision',
										label: 'Envíos a revisión',
										path: 'envio-revision',
										pageId: 'vehiculos.envio-revision',
										permission: 'subject.vehiculos.envio-revision.read',
										icon: 'fa-file-signature',
									},
								],
							},
							{
								id: 'ya-esta',
								label: 'Ya en catálogo',
								children: [
									{
										id: 'vehiculos.bitacora',
										label: 'Bitácoras de revisión',
										path: 'bitacora',
										pageId: 'vehiculos.bitacora',
										permission: 'subject.vehiculos.bitacora.read',
									},
								],
							},
						],
					},
				],
				[bitacora_page, envio_page],
			),
		);
		const [overlaid] = overlay_snapshot_menus([vehiculos], [snap]);
		expect(overlaid?.menus?.some((menu) => menu.name === 'Ya en catálogo')).toBe(false);
		expect(overlaid?.menus?.find((menu) => menu.name === 'Operación')).toMatchObject({
			parent_ref: 'vehicle-menu-management-0',
			menu_ref: 'vehiculos-operacion',
		});
		expect(overlaid?.menus?.find((menu) => menu.path === '/envio-revision')).toMatchObject({
			parent_ref: 'vehiculos-operacion',
		});
		const planned = plan_subject_menus(overlaid!, []);
		expect(planned.map((row) => row._ref)).toContain('vehiculos-envio-revision');
		expect(planned.map((row) => row._ref)).toContain('vehiculos-operacion');
	});

	test('una hoja sin entrada de menú igual entra, en solo lectura si no hay write', () => {
		const snap = project(
			manifest(
				[],
				[
					page('vehiculos.envio-revision', 'envio-revision', {
						kind: 'page',
						icon: 'fa-file-signature',
					}),
				],
			),
		);
		snap.permissions = snap.permissions.filter((perm) => !perm.id.endsWith('.write'));
		const [overlaid] = overlay_snapshot_menus([vehiculos], [snap]);
		expect(overlaid?.menus?.find((menu) => menu.path === '/envio-revision')).toMatchObject({
			name: 'Ver envíos a revisión',
			menu_ref: 'vehiculos-envio-revision',
			resources: ['envio-revision:read'],
		});
		const refs = subject_grant_refs({
			modules: overlaid!.modules,
			menus: overlaid!.menus,
		});
		expect(refs).toContainEqual({
			resource: 'envio-revision',
			menu_ref: 'vehiculos-envio-revision',
			read_only: true,
		});
		expect(
			subject_grants_from_menus({
				slug: 'vehiculos',
				modules: refs,
				has_full_access: false,
				visible_menu_refs: ['vehiculos-envio-revision'],
			}),
		).toContainEqual({
			resource: 'kirlet.vehiculos.envio-revision',
			c: false,
			r: true,
			u: false,
			d: false,
		});
	});

	test('con write el grant de la hoja visible es completo', () => {
		const [overlaid] = overlay_snapshot_menus([vehiculos], [vehiculos_snapshot]);
		const refs = subject_grant_refs({
			modules: overlaid!.modules,
			menus: overlaid!.menus,
		});
		expect(
			subject_grants_from_menus({
				slug: 'vehiculos',
				modules: refs,
				has_full_access: false,
				visible_menu_refs: ['vehiculos-envio-revision'],
			}),
		).toContainEqual({
			resource: 'kirlet.vehiculos.envio-revision',
			c: true,
			r: true,
			u: true,
			d: true,
		});
	});

	test('un path que se sale del subject no entra al sidebar', () => {
		const snap = structuredClone(vehiculos_snapshot);
		snap.menu = [
			...(snap.menu ?? []),
			{ id: 'bad', label: 'Malo', path: '../admin' },
			{ id: 'login', label: 'Login', path: 'login' },
			{ id: 'gateway', label: 'Gateway', path: 'm/subject-vehiculos/envio-revision' },
		];
		const [overlaid] = overlay_snapshot_menus([vehiculos], [snap]);
		const paths = (overlaid?.menus ?? []).map((menu) => menu.path);
		expect(paths).not.toContain('/../admin');
		expect(paths).not.toContain('../admin');
		expect(paths).not.toContain('/login');
		expect(paths).not.toContain('/m/subject-vehiculos/envio-revision');
		expect(paths).toContain('/envio-revision');
	});

	test('build_menus y el gateway leen el snapshot', () => {
		const auth = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
		const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
		const seed = readFileSync(new URL('./subject-menu-seed.ts', import.meta.url), 'utf8');
		expect(auth).toContain('overlay_snapshot_menus');
		expect(auth).toContain('load_installed_menu_snapshots');
		expect(server).toContain('overlay_snapshot_menus');
		expect(server).toContain('catalog_subject_with_snapshot');
		expect(seed).toContain('overlay_snapshot_menus');
	});
});
