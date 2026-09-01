import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	GENERIC_CREDENTIALS_MESSAGE,
	authenticate_for_surface,
	can_enter_internal,
} from '@opus-perpetuus/imperium-core-kit';
import { is_auth_login_post, is_public_login_post } from './auth.ts';

const auth_src = readFileSync(join(import.meta.dir, 'auth.ts'), 'utf8');
const crud_src = readFileSync(join(import.meta.dir, 'crud.ts'), 'utf8');

describe('auth.ts wires shipped surface helpers', () => {
	test('staff and public login paths call authenticate_for_surface', () => {
		expect(auth_src).toContain('authenticate_for_surface');
		expect(auth_src).toContain("'/public/login'");
		expect(auth_src).toContain('GENERIC_CREDENTIALS_MESSAGE');
		expect(auth_src).toContain('can_enter_internal');
	});

	test('user writes force public type through apply_public_user_create', () => {
		expect(crud_src).toContain('apply_public_user_create');
	});

	test('public login POST is recognized on the /api/auth/public/login path', () => {
		expect(
			is_public_login_post(
				new Request('http://t/api/auth/public/login', { method: 'POST' }),
			),
		).toBe(true);
		expect(
			is_public_login_post(
				new Request('http://t/api/auth/login', { method: 'POST' }),
			),
		).toBe(false);
		expect(
			is_auth_login_post(
				new Request('http://t/api/auth/login', { method: 'POST' }),
			),
		).toBe(true);
	});

	test('generic credentials match the shipped helper', () => {
		expect(GENERIC_CREDENTIALS_MESSAGE).toBe(
			'Usuario o contraseña incorrectos',
		);
		const denied = authenticate_for_surface(
			'staff',
			{ type: 'external', is_active: true },
			true,
		);
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.message).toBe(GENERIC_CREDENTIALS_MESSAGE);
		expect(can_enter_internal({ type: 'external' })).toBe(false);
	});
});
