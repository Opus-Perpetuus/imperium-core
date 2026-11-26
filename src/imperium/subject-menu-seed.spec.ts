import { describe, expect, test } from 'bun:test';
import {
	model_id_from_resource,
	plan_subject_access_rights,
	plan_stale_subject_menus,
	plan_subject_menus,
	plan_menu_repaths,
	plan_hidden_empty_folders,
	ensure_installed_subject_menus,
	existing_menu_twins,
} from './subject-menu-seed.ts';
import type { ImperiumStore, SubjectInfo } from './store.ts';

const ce = {
	slug: 'control-emergencias',
	name: 'Control de emergencias',
	path: '/control-emergencias',
	menu_ref: 'control-emergencias-menu-root',
	modules: [
		{
			resource: 'asociaciones',
			path: '/asociaciones',
			menu_ref: 'asociaciones-menu-management-0',
			name: 'Gestión de asociaciones',
			icon: 'fa-users',
		},
		{
			resource: 'base-volcanica',
			path: '/base-volcanica',
			menu_ref: 'base-volcanica-menu-management-0',
			name: 'Base Volcánica',
			icon: 'fa-mountain',
		},
	],
};

describe('siembra de menús de apps instaladas', () => {
	test('crea raíz CE y submenús cuando Manejo de menús solo tiene Escritorio', () => {
		const planned = plan_subject_menus(ce, [
			{ _id: 'desk', _ref: 'escritorio-menu-management-0' },
		]);
		expect(planned.map((row) => row._ref)).toEqual([
			'control-emergencias-menu-root',
			'asociaciones-menu-management-0',
			'base-volcanica-menu-management-0',
		]);
		expect(planned[0]?.parent_ref).toBeNull();
		expect(planned[0]?.model).toBe('');
		expect(planned[0]?.icon).toBe('fa-ambulance');
		expect(planned[1]?.parent_ref).toBe('control-emergencias-menu-root');
		expect(planned[1]?.path).toBe('/asociaciones');
	});

	test('no duplica _ref que ya existen', () => {
		const planned = plan_subject_menus(ce, [
			{ _id: 'root', _ref: 'control-emergencias-menu-root' },
			{ _id: 'aso', _ref: 'asociaciones-menu-management-0' },
		]);
		expect(planned.map((row) => row._ref)).toEqual([
			'base-volcanica-menu-management-0',
		]);
		expect(planned[0]?.parent_ref).toBe('control-emergencias-menu-root');
	});

	test('siembra AccessRights con model_id del núcleo (Asociaciones, BaseVolcanica)', () => {
		expect(model_id_from_resource('control-emergencias')).toBe(
			'ControlEmergencias',
		);
		expect(model_id_from_resource('base-volcanica')).toBe('BaseVolcanica');
		const planned = plan_subject_access_rights(ce, []);
		expect(planned.map((row) => row._ref)).toEqual([
			'control-emergencias-access-rights-0',
			'asociaciones-access-rights-0',
			'base-volcanica-access-rights-0',
		]);
		expect(planned[1]?.model_id).toBe('Asociaciones');
	});

	test('no duplica AccessRights existentes', () => {
		const planned = plan_subject_access_rights(ce, [
			{ _ref: 'asociaciones-access-rights-0' },
		]);
		expect(planned.map((row) => row._ref)).not.toContain(
			'asociaciones-access-rights-0',
		);
	});
});

describe('plan_subject_menus: un ref, una fila', () => {
	/**
	 * El catálogo repite a propósito el mismo `menu_ref` en `modules[]` y en
	 * `menus[]` cuando ese nodo del menú **es** el del módulo. Con una app ya
	 * sembrada no se nota: la base filtra el segundo. Con una app nueva se
	 * planeaban dos INSERT del mismo `_ref` y Postgres respondía
	 * `duplicate key value violates unique constraint "menu_management_ref_key"`,
	 * dejando `POST /module-management/seed-default-data` en 500.
	 */
	const app_nueva = {
		slug: 'database-manager',
		name: 'Gestor de base de datos',
		path: '/database-manager/health',
		menu_ref: 'database-manager-menu-root',
		modules: [
			{
				resource: 'policies',
				path: '/dbm-policies',
				menu_ref: 'database-manager-policies',
				name: 'Programación',
				icon: 'fa-calendar-check',
			},
		],
		menus: [
			{
				name: 'Programación',
				menu_ref: 'database-manager-policies',
				path: '/dbm-policies',
				icon: 'fa-calendar-check',
				parent_ref: 'database-manager-menu-root',
			},
			{
				name: 'Consola SQL',
				menu_ref: 'database-manager-console',
				path: '/database-manager/console',
				icon: 'fa-terminal',
				parent_ref: 'database-manager-menu-root',
			},
		],
	};

	test('no planea dos veces el mismo _ref', () => {
		const planned = plan_subject_menus(app_nueva, []);
		const refs = planned.map((row) => row._ref);
		expect(new Set(refs).size).toBe(refs.length);
		expect(refs).toContain('database-manager-menu-root');
		expect(refs).toContain('database-manager-policies');
		expect(refs).toContain('database-manager-console');
		// El de `modules[]` gana: llega primero y es el que lleva el recurso.
		expect(refs.filter((r) => r === 'database-manager-policies')).toHaveLength(1);
	});

	test('sigue respetando lo que ya está sembrado', () => {
		const planned = plan_subject_menus(app_nueva, [
			{ _ref: 'database-manager-menu-root' },
			{ _ref: 'database-manager-policies' },
		]);
		expect(planned.map((row) => row._ref)).toEqual([
			'database-manager-console',
		]);
	});
});

describe('plan_stale_subject_menus: solo lo que la app retira (incidente G85 tanda 1)', () => {
	const dbm = {
		slug: 'database-manager',
		menu_ref: 'database-manager-menu-root',
		modules: [
			{ resource: 'policies', path: '/dbm-policies', menu_ref: 'database-manager-policies', name: 'Programación', icon: '' },
		],
		menus: [],
	};
	const rows = [
		{ _id: 'root', _ref: 'database-manager-menu-root', path: '/database-manager/health', is_active: true, model: '' },
		{ _id: 'cat', _ref: 'database-manager-policies', path: '/dbm-policies', parent_id: 'root', is_active: true, model: '' },
		// Alias por recurso: ruta válida, el G85 la usa. No se apaga.
		{ _id: 'alias', _ref: 'database-manager-policies-2', path: '/policies', parent_id: 'root', is_active: true, model: '' },
		// Carpeta sin hijos activos: tampoco.
		{ _id: 'vacia', _ref: 'database-manager-nav-vacia', path: '', parent_id: 'root', is_active: true, model: '' },
	];
	const wanted = new Set(['database-manager-menu-root', 'database-manager-policies']);

	test('sin retired_menu_paths no apaga nada: ni alias de recurso ni carpetas vacías', () => {
		expect(plan_stale_subject_menus(dbm, wanted, rows)).toEqual([]);
	});

	test('un alias con ruta válida no cae aunque otra fila retire otra ruta', () => {
		const ids = plan_stale_subject_menus({ ...dbm, retired_menu_paths: ['/otra'] }, wanted, rows);
		expect(ids).toEqual([]);
	});

	const conf = {
		slug: 'configuracion',
		retired_menu_paths: ['/model-tracker/'],
	};
	const conf_rows = [
		{ _id: 'mt', _ref: 'configuracion-model-tracker', path: '/model-tracker', is_active: true, model: '' },
		{ _id: 'mine', _ref: 'mi-tracker', path: '/model-tracker', is_active: true, model: '' },
		{ _id: 'fold', _ref: 'configuracion-nav-x', path: '', is_active: true, model: '' },
	];

	test('retired_menu_paths: la fila sembrada ahí se apaga; ajena, carpeta o ya apagada, no', () => {
		expect(plan_stale_subject_menus(conf, new Set(), conf_rows).map((r) => r._id)).toEqual(['mt']);
		const off = conf_rows.map((r) => ({ ...r, is_active: false }));
		expect(plan_stale_subject_menus(conf, new Set(), off)).toEqual([]);
	});

	test('guardas: asignada a un grupo, declarada por la app o _ref repetido, no se apaga', () => {
		expect(plan_stale_subject_menus(conf, new Set(), conf_rows, new Set(['mt']))).toEqual([]);
		expect(plan_stale_subject_menus(conf, new Set(['configuracion-model-tracker']), conf_rows)).toEqual([]);
		const twice = [...conf_rows, { ...conf_rows[0]!, _id: 'mt2' }];
		expect(plan_stale_subject_menus(conf, new Set(), twice)).toEqual([]);
	});
});

describe('reiniciar el núcleo no vuelve a sembrar menús al final (incidente G85)', () => {
	type Row = Record<string, unknown>;
	function fake_store(rows: Row[]) {
		const inserts: Row[] = [];
		const updates: Array<{ id: string; patch: Row }> = [];
		let n = 0;
		const store = {
			has: (resource: string) => resource === 'menu-management',
			async *scan(resource: string) {
				if (resource === 'menu-management') yield rows.map((row) => ({ ...row }));
			},
			async insert(_resource: string, doc: Row) {
				const row = { ...doc, _id: `new-${++n}` };
				rows.push(row);
				inserts.push(row);
				return row;
			},
			async update(_resource: string, id: string, patch: Row) {
				updates.push({ id, patch });
				const row = rows.find((r) => r._id === id);
				if (row) Object.assign(row, patch);
				return row;
			},
		} as unknown as ImperiumStore;
		return { store, inserts, updates };
	}
	const sub = {
		...ce,
		technical_id: 'subject-control-emergencias',
		image: '',
		menus: [
			{ name: 'Catálogos', menu_ref: 'control-emergencias-nav-catalogos', icon: 'fa-folder' },
			{
				name: 'Categorías',
				menu_ref: 'control-emergencias-categorias',
				path: '/categoria-base-volcanica',
				icon: 'fa-tags',
				parent_ref: 'control-emergencias-nav-catalogos',
			},
		],
	} as SubjectInfo;

	test('dos arranques seguidos: el segundo no inserta ni toca nada', async () => {
		const rows: Row[] = [];
		const first = fake_store(rows);
		await ensure_installed_subject_menus(first.store, [sub]);
		expect(first.inserts.length).toBe(5);
		const before = JSON.stringify(rows);
		const second = fake_store(rows);
		await ensure_installed_subject_menus(second.store, [sub]);
		expect(second.inserts).toEqual([]);
		expect(second.updates).toEqual([]);
		expect(JSON.stringify(rows)).toBe(before);
	});

	test('una fila con otro _ref (mismo path o misma carpeta) se respeta con su orden', async () => {
		const rows: Row[] = [
			{ _id: 'root', _ref: 'control-emergencias-menu-root', path: '/control-emergencias', order: 50, is_active: true },
			{ _id: 'aso', _ref: 'mi-asociaciones', path: '/asociaciones', parent_id: 'root', order: 5, is_active: true },
			{ _id: 'cat', _ref: '', name: 'Catálogos', path: '', parent_id: 'root', order: 7, is_active: true },
			{ _id: 'c1', _ref: 'viejo-categorias', path: '/categoria-base-volcanica/', parent_id: 'cat', order: 1, is_active: true },
		];
		expect([...existing_menu_twins(sub, rows)]).toEqual([
			['asociaciones-menu-management-0', 'aso'],
			['control-emergencias-nav-catalogos', 'cat'],
			['control-emergencias-categorias', 'c1'],
		]);
		const before = JSON.parse(JSON.stringify(rows));
		const run = fake_store(rows);
		await ensure_installed_subject_menus(run.store, [sub]);
		// Solo falta Base Volcánica; cuelga de la raíz que ya existe.
		expect(run.inserts.map((row) => row._ref)).toEqual(['base-volcanica-menu-management-0']);
		expect(run.inserts[0]?.parent_id).toBe('root');
		expect(run.updates).toEqual([]);
		expect(rows.slice(0, 4)).toEqual(before);
	});

	test('el mismo path en otra app no cuenta como gemelo', () => {
		const rows = [
			{ _id: 'conf', _ref: 'module-management-menu-root-settings', path: '/configuracion', is_active: true },
			{ _id: 'muni', _ref: 'municipality-menu-0', path: '/asociaciones', parent_id: 'conf', is_active: true },
		];
		expect(existing_menu_twins(sub, rows).size).toBe(0);
	});
});

describe('rutas renombradas y carpetas vacías marcadas por el catálogo (G85 tanda 3)', () => {
	const almacen = { slug: 'almacen', renamed_menu_paths: { '/pedidos-surtir': '/pedidos/surtir' } };
	const surtido = [
		{ _id: 'fold', _ref: 'almacen-folder-x', path: '', is_active: true },
		{ _id: 'kid', _ref: 'almacen-pedidos-surtir', path: '/pedidos-surtir', parent_id: 'fold', order: 30, is_active: true },
		// La fila buena en la raíz y una ajena con la ruta vieja no se tocan.
		{ _id: 'good', _ref: 'surtir-pedidos-menu-0', path: '/pedidos/surtir', is_active: true },
		{ _id: 'alien', _ref: 'mio-surtir', path: '/pedidos-surtir', is_active: true },
	];

	test('repath: solo la fila de la app con la ruta vieja, al path nuevo', () => {
		const out = plan_menu_repaths(almacen, surtido);
		expect(out.map(({ row, path }) => [row._id, path])).toEqual([['kid', '/pedidos/surtir']]);
	});

	test('repath: idempotente, y con _ref repetido no toca nada', () => {
		const done = surtido.map((r) => (r._id === 'kid' ? { ...r, path: '/pedidos/surtir' } : r));
		expect(plan_menu_repaths(almacen, done)).toEqual([]);
		expect(plan_menu_repaths(almacen, [...surtido, { ...surtido[1]!, _id: 'kid2' }])).toEqual([]);
		expect(plan_menu_repaths({ slug: 'almacen' }, surtido)).toEqual([]);
	});

	const herr = {
		slug: 'herramientas',
		hidden_empty_menu_refs: ['herramientas-nav-reparto', 'herramientas-nav-menu', 'herramientas-nav-movil', 'herramientas-nav-ruta'],
	};
	const tree = [
		{ _id: 'root', _ref: 'herramientas-menu-root', path: '', is_active: true },
		{ _id: 'rep', _ref: 'herramientas-nav-reparto', path: '', parent_id: 'root', is_active: true },
		{ _id: 'men', _ref: 'herramientas-nav-menu', path: '', parent_id: 'rep', is_active: true },
		{ _id: 'mov', _ref: 'herramientas-nav-movil', path: '', parent_id: 'root', is_active: true },
		{ _id: 'tel', _ref: 'herramientas-movil-telefono', path: '/herramientas/telefono', parent_id: 'mov', is_active: true },
		// Hijo apagado: la carpeta cuenta como vacía.
		{ _id: 'rut', _ref: 'herramientas-nav-ruta', path: '', parent_id: 'root', is_active: true },
		{ _id: 'old', _ref: 'herramientas-x', path: '/x', parent_id: 'rut', is_active: false },
		// Vacía pero no marcada: no se toca.
		{ _id: 'otra', _ref: 'herramientas-nav-otra', path: '', parent_id: 'root', is_active: true },
	];

	test('carpetas vacías marcadas: se apagan, también la que solo contiene otra vacía', () => {
		const ids = plan_hidden_empty_folders(herr, tree).map((r) => r._id).sort();
		expect(ids).toEqual(['men', 'rep', 'rut']);
	});

	test('con un hijo activo, asignada a un grupo, ya apagada o con ruta: no se apaga', () => {
		expect(plan_hidden_empty_folders(herr, tree).some((r) => r._id === 'mov')).toBe(false);
		const granted = plan_hidden_empty_folders(herr, tree, new Set(['men'])).map((r) => r._id);
		expect(granted).toEqual(['rut']);
		const off = tree.map((r) => (r._id === 'rut' ? { ...r, is_active: false } : r));
		expect(plan_hidden_empty_folders(herr, off).map((r) => r._id).sort()).toEqual(['men', 'rep']);
		const with_path = tree.map((r) => (r._id === 'rut' ? { ...r, path: '/ruta' } : r));
		expect(plan_hidden_empty_folders(herr, with_path).map((r) => r._id).sort()).toEqual(['men', 'rep']);
	});
});
