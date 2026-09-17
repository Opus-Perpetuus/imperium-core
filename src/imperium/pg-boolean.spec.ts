import { describe, expect, test } from 'bun:test';
import { pg_boolean } from './store.ts';

describe('pg_boolean', () => {
	test('SWITCH 0/1 del formulario se vuelven boolean', () => {
		expect(pg_boolean(0)).toBe(false);
		expect(pg_boolean(1)).toBe(true);
		expect(pg_boolean(false)).toBe(false);
		expect(pg_boolean(true)).toBe(true);
		expect(pg_boolean('0')).toBe(false);
		expect(pg_boolean('1')).toBe(true);
	});
});
