import { describe, expect, test } from 'bun:test';
import { plan_reuniones_menu, REUNIONES_MENU_PATH, REUNIONES_MENU_REF } from './reuniones-menu-seed.ts';

describe('menú de Reuniones', () => {
	test('crea la entrada del menú principal cuando falta', () => {
		const plan = plan_reuniones_menu([]);
		expect(plan.insert).toBe(true);
		if (plan.insert) {
			expect(plan.row).toMatchObject({ _ref: REUNIONES_MENU_REF, name: 'Reuniones', path: REUNIONES_MENU_PATH, model: '' });
			expect(plan.row.parent_id).toBeUndefined();
		}
	});

	test('no duplica una entrada que ya existe', () => {
		expect(plan_reuniones_menu([{ _id: 'x', _ref: REUNIONES_MENU_REF }]).insert).toBe(false);
	});
});
