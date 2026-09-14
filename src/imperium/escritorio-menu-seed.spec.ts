import { describe, expect, test } from 'bun:test';
import {
	ESCRITORIO_MENU_PATH,
	ESCRITORIO_MENU_REF,
	plan_escritorio_menu,
} from './escritorio-menu-seed.ts';

describe('menú de Escritorio', () => {
	test('crea la entrada cuando falta', () => {
		const plan = plan_escritorio_menu([]);
		expect(plan.insert).toBe(true);
		if (plan.insert) {
			expect(plan.row._ref).toBe(ESCRITORIO_MENU_REF);
			expect(plan.row.path).toBe(ESCRITORIO_MENU_PATH);
			expect(plan.row.model).toBe('');
			expect(plan.row.name).toBe('Escritorio');
		}
	});

	test('no duplica una entrada que ya existe', () => {
		expect(
			plan_escritorio_menu([{ _id: 'x', _ref: ESCRITORIO_MENU_REF }]).insert,
		).toBe(false);
	});
});
