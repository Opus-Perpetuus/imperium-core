import { describe, expect, test } from 'bun:test';
import { request_is_https, session_set_cookie } from './auth.ts';

describe('session cookie for mobile HTTPS', () => {
	test('HTTPS login sets Secure so Chrome móvil keeps SameSite=Lax', () => {
		const cookie = session_set_cookie('abc', { https: true });
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('connect.sid=abc');
	});

	test('HTTP local does not set Secure', () => {
		expect(session_set_cookie('abc', { https: false })).not.toContain(
			'Secure',
		);
	});

	test('x-forwarded-proto https counts as HTTPS behind the proxy', () => {
		const req = new Request('http://127.0.0.1/auth/login', {
			headers: { 'x-forwarded-proto': 'https' },
		});
		expect(request_is_https(req)).toBe(true);
	});
});
