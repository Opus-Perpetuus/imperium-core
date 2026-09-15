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
