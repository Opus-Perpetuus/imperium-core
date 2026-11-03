import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegistrySql } from './app-registry.ts';
import {
	subject_info_from_catalog,
	type CatalogSubject,
	type ImperiumDoc,
	type ImperiumStore,
} from './store.ts';
import { ensure_installed_subject_menus } from './subject-menu-seed.ts';

/**
 * Menú, permisos y grupos del G85 antes de la tanda 1 (2026-11-02). En ese
 * arranque el núcleo apagó 21 páginas con ruta y 10 carpetas y movió
 * «Paqueterías» de carpeta. El arranque solo puede apagar lo que una app
 * retira a propósito, y un segundo arranque no escribe nada.
 *
 * Tanda 3: el catálogo retira las rutas que dan 404 en la SPA (planeación×3,
 * delivery×2), apaga 7 carpetas sin hijos (herramientas nav-*×6, emergencias
 * nav-categorias) y corrige la ruta de los hijos de Surtido y Agua potable.
 * Las 4 de database-manager (/policies, /runs…) enrutan: no se tocan.
 */
type Fixture = {
	installed_technical_ids: string[];
	group_menus_ids: string[][];
	access_right_refs: string[];
	menus: Array<Record<string, unknown> & { _id: string }>;
	snapshots: Array<Record<string, unknown> & { slug: string }>;
	tienda_1143d7e: Record<string, unknown> & { slug: string };
};

const fixture: Fixture = JSON.parse(
	readFileSync(join(import.meta.dir, 'fixtures/g85-menu-snapshot.json'), 'utf8'),
);
const catalog = JSON.parse(
	readFileSync(join(import.meta.dir, '../../catalog.json'), 'utf8'),
) as { subjects: CatalogSubject[] };
const installed_ids = new Set(fixture.installed_technical_ids);
const installed = catalog.subjects
	.map(subject_info_from_catalog)
	.filter((sub) => installed_ids.has(sub.technical_id));

type Write = { op: 'insert' | 'update'; resource: string; id?: string; doc: ImperiumDoc };

function fake_store(menus: ImperiumDoc[], writes: Write[]): ImperiumStore {
	const tables: Record<string, ImperiumDoc[]> = {
		'menu-management': menus,
		'access-rights': fixture.access_right_refs.map((ref, i) => ({ _id: `ar-${i}`, _ref: ref })),
		'user-group': fixture.group_menus_ids.map((ids, i) => ({ _id: `ug-${i}`, menus_ids: ids })),
	};
	let n = 0;
	return {
		has: (resource: string) => resource in tables,
		async *scan(resource: string) {
			yield tables[resource] ?? [];
		},
		async insert(resource: string, doc: ImperiumDoc) {
			const row = { ...doc, _id: `new-${++n}` };
			tables[resource]?.push(row);
			writes.push({ op: 'insert', resource, doc });
			return row;
		},
		async update(resource: string, id: string, patch: ImperiumDoc) {
			const row = tables[resource]?.find((r) => r._id === id);
			if (row) Object.assign(row, patch);
			writes.push({ op: 'update', resource, id, doc: patch });
			return row;
		},
	} as unknown as ImperiumStore;
}

function fake_sql(snapshots: Fixture['snapshots']): RegistrySql {
	return {
		unsafe: async () =>
			snapshots.map((manifest) => ({
				slug: manifest.slug,
				manifest_hash: `fixture-${manifest.slug}`,
				manifest,
			})),
	};
}

async function boot_twice(snapshots: Fixture['snapshots']) {
	const menus = fixture.menus.map((row) => ({ ...row }) as ImperiumDoc);
	const first: Write[] = [];
	const second: Write[] = [];
	await ensure_installed_subject_menus(fake_store(menus, first), installed, fake_sql(snapshots));
	await ensure_installed_subject_menus(fake_store(menus, second), installed, fake_sql(snapshots));
	return { menus, first, second };
}

const by_id = new Map(fixture.menus.map((row) => [row._id, row]));
const retired_refs = (writes: Write[]) =>
	writes
		.filter((w) => w.doc.is_active === false)
		.map((w) => String(by_id.get(w.id ?? '')?._ref))
		.sort();
const repaths = (writes: Write[]) =>
	writes
		.filter((w) => 'path' in w.doc)
		.map((w) => [String(by_id.get(w.id ?? '')?._ref), w.doc.path])
		.sort();

/** Lo que apaga el arranque con el catálogo actual, además de lo que la app retire. */
const TANDA3_OFF = [
	'control-emergencias-nav-categorias',
	'herramientas-nav-agenda',
	'herramientas-nav-menu',
	'herramientas-nav-reparto',
	'herramientas-nav-tablas',
	'herramientas-nav-telefono',
	'herramientas-nav-voz',
	'logistica-delivery-package-manifiesto',
	'logistica-delivery-route-mapa',
	'planeacion-planeacion-mis-tareas',
	'planeacion-planeacion-proyectos',
	'planeacion-planeacion-proyectos-task',
];
const TANDA3_REPATHS = [
	['almacen-pedidos-surtir', '/pedidos/surtir'],
	['control-municipal-lectura-campo', '/lectura/campo'],
];

/** Fuera de lo esperado, ninguna fila cambia de carpeta, ruta, nombre, orden ni estado. */
function expect_rest_untouched(menus: ImperiumDoc[], off: string[]) {
	const renamed = new Map(TANDA3_REPATHS as Array<[string, string]>);
	for (const row of menus) {
		const before = by_id.get(String(row._id))!;
		const ref = String(before._ref);
		expect([row._ref, row.parent_id, row.path, row.name, row.order]).toEqual([
			before._ref,
			before.parent_id,
			renamed.get(ref) ?? before.path,
			before.name,
			before.order,
		]);
		const was_on = before.is_active !== false;
		expect(row.is_active !== false).toBe(was_on && !off.includes(ref));
	}
}

describe('arranque contra el menú del G85 (incidente tanda 1)', () => {
	test('el catálogo trae retired_menu_paths hasta SubjectInfo', () => {
		const conf = installed.find((sub) => sub.slug === 'configuracion');
		expect(conf?.retired_menu_paths).toEqual(['/model-tracker']);
	});

	test('con los snapshots del G85: /model-tracker, las rutas rotas y las carpetas vacías; 2 rutas corregidas', async () => {
		const { menus, first, second } = await boot_twice(fixture.snapshots);
		expect(first.filter((w) => w.op === 'insert')).toEqual([]);
		for (const w of first) expect(w.resource).toBe('menu-management');
		const off = ['configuracion-model-tracker', ...TANDA3_OFF].sort();
		expect(retired_refs(first)).toEqual(off);
		expect(repaths(first)).toEqual(TANDA3_REPATHS);
		expect(first).toHaveLength(off.length + TANDA3_REPATHS.length);
		expect_rest_untouched(menus, off);
		// Surtido y Agua potable siguen activas, con su hijo dentro.
		for (const folder of ['almacen-folder-menu-management-inventory-picking', 'control-municipal-folder-agua-menu-root']) {
			expect(menus.find((row) => row._ref === folder)?.is_active).toBe(true);
		}
		// database-manager: los alias /policies, /runs… enrutan y siguen.
		for (const ref of ['database-manager-policies-2', 'database-manager-destinations-2', 'database-manager-runs-2', 'database-manager-saved-queries-2']) {
			expect(menus.find((row) => row._ref === ref)?.is_active).toBe(true);
		}
		expect(second).toEqual([]);
	});

	test('con tienda 1143d7e re-registrada: además las 4 «Tienda pública», nada más', async () => {
		const snapshots = fixture.snapshots.map((snap) =>
			snap.slug === 'tienda' ? fixture.tienda_1143d7e : snap,
		);
		const { menus, first, second } = await boot_twice(snapshots);
		expect(first.filter((w) => w.op === 'insert')).toEqual([]);
		const off = [
			'configuracion-model-tracker',
			'tienda-store-checkout',
			'tienda-store-checkout-result',
			'tienda-store-order-detail',
			'tienda-store-product',
			...TANDA3_OFF,
		].sort();
		expect(retired_refs(first)).toEqual(off);
		expect(repaths(first)).toEqual(TANDA3_REPATHS);
		expect(first).toHaveLength(off.length + TANDA3_REPATHS.length);
		expect_rest_untouched(menus, off);
		const folder = menus.find((row) => row._ref === 'tienda-nav-store');
		expect(folder?.is_active).toBe(true);
		expect(second).toEqual([]);
	});
});
