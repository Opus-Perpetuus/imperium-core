import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { is_public_auth_get } from './auth.ts';

describe('is_public_auth_get', () => {
	test('cubre GET /auth y branding, no login ni menus', () => {
		const get = (path: string, method = 'GET') =>
			is_public_auth_get(new Request(`http://core${path}`, { method }));
		expect(get('/api/auth')).toBe(true);
		expect(get('/auth')).toBe(true);
		expect(get('/api/auth/branding')).toBe(true);
		expect(get('/api/auth/branding/logo')).toBe(true);
		expect(get('/api/auth/menus')).toBe(false);
		expect(get('/api/auth/login', 'POST')).toBe(false);
		expect(get('/api/auth', 'POST')).toBe(false);
	});

	test('el router despacha esos GET sin esperar boot()', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		expect(src).toContain('is_public_auth_get(req)');
		expect(src).toContain('is_auth_login_post(req) || is_public_auth_get(req)');
	});
});
