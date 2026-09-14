import { describe, expect, test } from 'bun:test';
import {
	plan_portal_menus,
	PORTAL_LANDING_MENU_REF,
	PORTAL_LANDING_PATH,
	PUBLIC_APP_PAGES_MENU_REF,
	PUBLIC_APP_PAGES_PATH,
} from './portal-menu-seed.ts';

describe('menú de páginas públicas de apps', () => {
	const root = { _id: 'root-1', _ref: 'module-management-menu-root-settings' };

	test('se siembra junto al editor de la portada', () => {
		// Sin fila de menú la pantalla existe pero no hay cómo llegar a ella.
		const rows = plan_portal_menus([root]);
		const paths = rows.map((r) => String(r['path']));
		expect(paths).toContain(PORTAL_LANDING_PATH);
		expect(paths).toContain(PUBLIC_APP_PAGES_PATH);
	});

	test('lo ya sembrado no se repite', () => {
		const rows = plan_portal_menus([
			root,
			{ _id: 'm1', _ref: PORTAL_LANDING_MENU_REF },
		]);
		expect(rows.map((r) => String(r['_ref']))).toEqual([
			PUBLIC_APP_PAGES_MENU_REF,
		]);
	});

	test('sin raíz de Configuración no se inventa una entrada suelta', () => {
		expect(plan_portal_menus([])).toEqual([]);
	});

	test('las dos cuelgan de Configuración', () => {
		for (const row of plan_portal_menus([root])) {
			expect(row['parent_id']).toBe('root-1');
			expect(row['is_active']).toBe(true);
		}
	});
});
