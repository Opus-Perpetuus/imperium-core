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

describe('alta de cliente del sitio público', () => {
	test('la ruta pública de registro está reconocida como anónima', () => {
		// Si no la reconoce, la petición cae al chequeo de sesión y responde
		// 401: nadie podría crearse una cuenta.
		const post = (p: string) =>
			new Request(`http://t${p}`, { method: 'POST' });
		expect(is_public_login_post(post('/api/auth/public/register'))).toBe(true);
		expect(is_public_login_post(post('/api/auth/public/register/'))).toBe(true);
		expect(is_public_login_post(post('/api/auth/public/login'))).toBe(true);
		// Y no abre de más: el alta del personal no es pública.
		expect(is_public_login_post(post('/api/auth/register'))).toBe(false);
		expect(is_public_login_post(post('/api/auth/login'))).toBe(false);
	});

	test('el registro se despacha antes de exigir sesión', () => {
		// El handler tiene que estar en el tramo anónimo de handle_auth; si
		// quedara detrás de load_session, nunca se alcanzaría.
		const registro = auth_src.indexOf("rest === '/public/register'");
		const sesion = auth_src.indexOf('const session = await load_session(');
		expect(registro).toBeGreaterThan(0);
		expect(sesion).toBeGreaterThan(0);
		expect(registro).toBeLessThan(sesion);
	});

	test('el documento se arma con lista blanca, nunca con el cuerpo', () => {
		// El admin de verdad no se decide por is_admin sino por el _ref de la
		// semilla y por los grupos: copiar el cuerpo seria una via de escalada.
		const cuerpo = auth_src.slice(
			auth_src.indexOf('async function register_public_user('),
			auth_src.indexOf('async function login_on_surface('),
		);
		expect(cuerpo).toContain("type: 'external'");
		expect(cuerpo).toContain('prepare_user_write');
		// Ni spread del cuerpo ni campos de privilegio.
		expect(cuerpo).not.toContain('...body');
		expect(cuerpo).not.toContain('_ref');
		expect(cuerpo).not.toContain('groups');
		expect(cuerpo).not.toContain('access_rights');
	});

	test('pasa por su propio limitador y el mensaje de duplicado es genérico', () => {
		// Matiz honesto: el MENSAJE no nombra la cuenta, pero el comportamiento
		// sí difiere (201 si el correo es nuevo, 409 si ya existe). Cualquier
		// alta que además inicie sesión dice eso; lo que acota el abuso es el
		// cubo por IP, y por eso `request_ip` no se fía del cliente.
		const cuerpo = auth_src.slice(
			auth_src.indexOf('async function register_public_user('),
			auth_src.indexOf('async function login_on_surface('),
		);
		expect(cuerpo).toContain('consume_public_register_limits');
		expect(cuerpo).not.toContain('Ya existe');
	});

	test('la contraseña se hashea por el mismo camino que el alta interna', () => {
		expect(crud_src).toContain('export async function prepare_user_write');
		expect(crud_src).toContain('argon2');
	});
});
