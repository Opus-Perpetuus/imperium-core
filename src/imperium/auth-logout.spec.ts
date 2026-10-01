import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { is_auth_logout } from './router.ts';

describe('is_auth_logout', () => {
	test('reconoce las dos formas de cerrar sesión', () => {
		const req = (path: string, method: string) => new Request(`http://core${path}`, { method });
		expect(is_auth_logout(req('/api/auth', 'DELETE'))).toBe(true);
		expect(is_auth_logout(req('/api/auth/', 'DELETE'))).toBe(true);
		expect(is_auth_logout(req('/auth', 'DELETE'))).toBe(true);
		expect(is_auth_logout(req('/api/auth/logout', 'POST'))).toBe(true);
		expect(is_auth_logout(req('/api/auth', 'GET'))).toBe(false);
		expect(is_auth_logout(req('/api/auth/menus', 'DELETE'))).toBe(false);
		expect(is_auth_logout(req('/api/user/1', 'DELETE'))).toBe(false);
	});

	test('el router lo despacha antes del filtro de solo personal', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		const bypass = src.indexOf('is_public_auth_get(req) || is_auth_logout(req)');
		const gate = src.indexOf("message: 'Solo usuarios internos'");
		expect(bypass).toBeGreaterThan(0);
		expect(bypass).toBeLessThan(gate);
	});
});
