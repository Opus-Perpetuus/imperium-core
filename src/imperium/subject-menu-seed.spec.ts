import { describe, expect, test } from 'bun:test';
import {
	model_id_from_resource,
	plan_subject_access_rights,
	plan_subject_menus,
} from './subject-menu-seed.ts';

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
