import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { is_public_auth_get, login_background_target } from './auth.ts';

describe('is_public_auth_get', () => {
	test('cubre GET /auth y branding, no login ni menus', () => {
		const get = (path: string, method = 'GET') =>
			is_public_auth_get(new Request(`http://core${path}`, { method }));
		expect(get('/api/auth')).toBe(true);
		expect(get('/auth')).toBe(true);
		expect(get('/api/auth/branding')).toBe(true);
		expect(get('/api/auth/branding/logo')).toBe(true);
		expect(get('/api/auth/branding/background/interno')).toBe(true);
		expect(get('/api/auth/branding/background/publico')).toBe(true);
		const interno = login_background_target('/branding/background/interno');
		const publico = login_background_target('/branding/background/publico');
		expect(interno?.ref).toBe('configuration-login-background');
		expect(publico?.ref).toBe('configuration-login-background-publico');
		expect(interno?.ref).not.toBe(publico?.ref);
		expect(
			login_background_target('/branding/background/interno/otro-id')?.ref,
		).toBe(interno?.ref);
		expect(login_background_target('/branding/background')).toBeNull();
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
