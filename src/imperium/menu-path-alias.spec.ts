import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { rewrite_menu_api_path, type MenuPathSubject } from './menu-path-alias.ts';

const catalog = JSON.parse(
	readFileSync(new URL('../../../catalog.json', import.meta.url), 'utf8'),
) as { subjects: MenuPathSubject[] };

const subjects = catalog.subjects;
const known = new Set<string>();
for (const subject of subjects) {
	for (const mod of subject.modules ?? []) {
		if (mod.resource) known.add(mod.resource);
	}
}
const has = (resource: string) => known.has(resource);
const rewrite = (path: string) => rewrite_menu_api_path(path, subjects, has);

describe('alias de path de menú al recurso que sí existe', () => {
	test('clase A: los siete paths del menú caen en la colección que responde', () => {
		expect(rewrite('/dbm-destinations')).toBe('/destinations');
		expect(rewrite('/dbm-policies')).toBe('/policies');
		expect(rewrite('/dbm-runs')).toBe('/runs');
		expect(rewrite('/dbm-saved-queries')).toBe('/saved-queries');
		expect(rewrite('/planeacion/mis-tareas')).toBe('/planeacion-mis-tareas');
		expect(rewrite('/planeacion/proyectos')).toBe('/planeacion-proyectos');
		expect(rewrite('/planeacion/proyectos-task')).toBe('/planeacion-proyectos-task');
	});

	test('el tramo de más largo gana y el id sigue pegado', () => {
		expect(rewrite('/planeacion/proyectos-task/abc')).toBe('/planeacion-proyectos-task/abc');
		expect(rewrite('/planeacion/proyectos/abc')).toBe('/planeacion-proyectos/abc');
		expect(rewrite('/api/dbm-runs')).toBe('/api/dbm-runs');
		expect(rewrite('/dbm-runs/')).toBe('/runs');
	});

	test('clase C y padrón: el path del catálogo no es el resource', () => {
		expect(rewrite('/pedidos/surtir')).toBe('/pedidos-surtir');
		expect(rewrite('/lectura/campo')).toBe('/lectura-campo');
		expect(rewrite('/delivery-package/manifiesto')).toBe('/delivery-package-manifiesto');
		expect(rewrite('/delivery-route/mapa')).toBe('/delivery-route-mapa');
		expect(rewrite('/padron-vehiculos')).toBe('/vehicle');
		expect(rewrite('/padron-vehiculos/xyz')).toBe('/vehicle/xyz');
	});

	test('el gestor: el menú apunta a /database-manager y el núcleo escucha /db-admin', () => {
		expect(rewrite('/database-manager/audit')).toBe('/db-admin/audit');
		expect(rewrite('/database-manager/backups')).toBe('/db-admin/backups');
		expect(rewrite('/database-manager/health')).toBe('/db-admin/health');
		expect(rewrite('/database-manager/audit/1')).toBe('/db-admin/audit/1');
		expect(rewrite('/database-manager/console')).toBe('/database-manager/console');
	});

	test('no toca la tienda de Marketo, raíces de app ni rutas de núcleo que no son colecciones', () => {
		for (const path of [
			'/store-home',
			'/store-cart',
			'/store-orders',
			'/connectors',
			'/reportes-comerciales',
			'/almacen',
			'/ventas',
			'/login',
			'/openapi.json',
			'/subjects/install-schemas',
			'/inventory-movement/traslado',
			'/herr-agenda-dia',
			'/destinations',
			'/vehicle',
		]) {
			expect(rewrite(path)).toBe(path);
		}
	});


	test('páginas vehiculos: recordatorios y costos-flota van al listPath real', () => {
		expect(rewrite('/recordatorios')).toBe('/servicio-programado/recordatorios');
		expect(rewrite('/recordatorios/')).toBe('/servicio-programado/recordatorios');
		expect(rewrite('/costos-flota')).toBe('/vehicle/reporte-costos');
		expect(rewrite('/costos-flota/xyz')).toBe('/vehicle/reporte-costos/xyz');
	});

	test('sin la colección no reescribe: el 404 sigue siendo 404', () => {
		expect(rewrite_menu_api_path('/dbm-destinations', subjects, () => false)).toBe(
			'/dbm-destinations',
		);
		expect(rewrite_menu_api_path('/database-manager/audit', subjects, () => false)).toBe(
			'/db-admin/audit',
		);
	});
});
