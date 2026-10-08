import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { define_password_with_grant, handle_auth, is_password_define_post } from './auth.ts';
import { assert_required_fields } from './required-fields.ts';
import {
	PASSWORD_DEFINE_KIND,
	PASSWORD_DEFINE_TTL_MS,
	find_user_by_define_token,
	find_user_by_reset_token,
	hash_reset_token,
	issue_password_define_grant,
} from './password-reset.ts';

const LARGA = 'una frase larga y facil';

function memory_user_store(
	user: ImperiumDoc,
	before_write?: (patch: ImperiumDoc) => void,
) {
	const users = [user];
	const store = {
		has(resource: string) {
			return resource === 'user';
		},
		async find_where(_resource: string, where: Record<string, unknown>) {
			return (
				users.find(
					(row) =>
						row.reset_password_token_hash === where.reset_password_token_hash,
				) ?? null
			);
		},
		async update(resource: string, id: string, patch: ImperiumDoc) {
			const row = users.find((item) => item._id === id);
			if (!row) return null;
			assert_required_fields(resource, { ...row, ...patch }, Object.keys(patch));
			before_write?.(patch);
			Object.assign(row, patch);
			return row;
		},
	};
	return { store: store as unknown as ImperiumStore, user };
}

describe('definir contraseña tras el enlace', () => {
	test('el login por enlace emite un token que no vuelve a abrir sesión', async () => {
		const { store, user } = memory_user_store({
			_id: 'u1',
			is_active: true,
			reset_password_kind: 'recovery',
			password: 'hash-viejo',
		});
		const grant = await issue_password_define_grant(store, user);
		expect(grant.token.length).toBeGreaterThan(20);
		expect(user.reset_password_kind).toBe(PASSWORD_DEFINE_KIND);
		const expires = Date.parse(String(user.reset_password_expires));
		expect(expires).toBeGreaterThan(Date.now());
		expect(expires).toBeLessThanOrEqual(Date.now() + PASSWORD_DEFINE_TTL_MS + 1000);

		const opened = await find_user_by_reset_token(store, grant.token);
		expect(opened?.reset_password_kind).toBe(PASSWORD_DEFINE_KIND);
		expect(await find_user_by_define_token(store, grant.token)).toBeTruthy();
	});

	test('guardar hashea, consume el token y un segundo uso falla', async () => {
		const { store, user } = memory_user_store({
			_id: 'u1',
			is_active: true,
		});
		const grant = await issue_password_define_grant(store, user);
		const first = await define_password_with_grant(store, grant.token, LARGA);
		expect(first.ok).toBe(true);
		expect(String(user.password)).toStartWith('$argon2id$');
		expect(await argon2.verify(String(user.password), LARGA)).toBe(true);
		expect(user.reset_password_token_hash).toBeNull();
		expect(user.reset_password_kind).toBeNull();

		const again = await define_password_with_grant(store, grant.token, LARGA + ' otra');
		expect(again.ok).toBe(false);
		expect(await argon2.verify(String(user.password), LARGA)).toBe(true);
	});

	test('token inválido, de recuperación o clave corta no escriben la contraseña', async () => {
		const { store, user } = memory_user_store({
			_id: 'u1',
			is_active: true,
			password: 'hash-viejo',
			reset_password_kind: 'invitation',
			reset_password_token_hash: hash_reset_token('invitacion'),
			reset_password_expires: new Date(Date.now() + 60_000).toISOString(),
		});
		const as_invitation = await define_password_with_grant(store, 'invitacion', LARGA);
		expect(as_invitation.ok).toBe(false);
		expect(user.password).toBe('hash-viejo');
		expect(user.reset_password_kind).toBe('invitation');

		const missing = await define_password_with_grant(store, 'no-existe', LARGA);
		expect(missing.ok).toBe(false);

		const grant = await issue_password_define_grant(store, user);
		const short = await define_password_with_grant(store, grant.token, 'corta');
		expect(short.ok).toBe(false);
		if (!short.ok) expect(short.message).toContain('12');
		expect(user.password).toBe('hash-viejo');
		expect(user.reset_password_kind).toBe(PASSWORD_DEFINE_KIND);
		const retry = await define_password_with_grant(store, grant.token, LARGA);
		expect(retry.ok).toBe(true);
	});

	test('el schema del usuario admite kind definir', () => {
		const check = (kind: string) => () =>
			assert_required_fields('user', { reset_password_kind: kind }, ['reset_password_kind']);
		expect(check(PASSWORD_DEFINE_KIND)).not.toThrow();
		expect(check('otro')).toThrow();
	});

	test('un fallo del grant no quema el enlace', async () => {
		const codigo = 'enlace-original';
		const hash = hash_reset_token(codigo);
		const expires = new Date(Date.now() + 60_000).toISOString();
		const patches: ImperiumDoc[] = [];
		const { store, user } = memory_user_store(
			{
				_id: 'u1',
				is_active: true,
				reset_password_kind: 'recovery',
				reset_password_token_hash: hash,
				reset_password_expires: expires,
				recovery_token: 'legacy',
				recovery_expires: '2020-01-01T00:00:00.000Z',
			},
			(patch) => {
				patches.push({ ...patch });
				if (patch.reset_password_kind === PASSWORD_DEFINE_KIND) {
					throw new Error('grant failed');
				}
			},
		);
		const req = new Request('http://core/auth/password-reset/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ codigo }),
		});
		await expect(
			handle_auth(
				store,
				{ unsafe: async () => [] } as unknown as Bun.SQL,
				req,
				new URL(req.url),
			),
		).rejects.toThrow('grant failed');

		expect(patches).toHaveLength(1);
		expect(patches[0]?.reset_password_kind).toBe(PASSWORD_DEFINE_KIND);
		expect(patches[0]?.recovery_token).toBeNull();
		expect(patches[0]?.recovery_expires).toBeNull();
		expect(String(patches[0]?.reset_password_token_hash ?? '')).not.toBe('');
		expect(patches[0]?.reset_password_token_hash).not.toBe(hash);
		expect(user.reset_password_token_hash).toBe(hash);
		expect(user.reset_password_expires).toBe(expires);
		expect(user.reset_password_kind).toBe('recovery');
		expect(user.recovery_token).toBe('legacy');
		expect((await find_user_by_reset_token(store, codigo))?._id).toBe('u1');
	});

	test('definir no exige sesión de personal', () => {
		const post = (path: string) =>
			is_password_define_post(new Request(`http://core${path}`, { method: 'POST' }));
		expect(post('/api/auth/password-reset/definir')).toBe(true);
		expect(post('/auth/password-reset/definir/')).toBe(true);
		expect(post('/api/auth/password-reset/login')).toBe(false);
		expect(
			is_password_define_post(
				new Request('http://core/api/auth/password-reset/definir', { method: 'GET' }),
			),
		).toBe(false);

		const auth_src = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
		const definir = auth_src.indexOf("rest.startsWith('/password-reset/definir')");
		const sesion = auth_src.indexOf('const session = await load_session(');
		expect(definir).toBeGreaterThan(0);
		expect(definir).toBeLessThan(sesion);
		expect(auth_src).toContain('puede_definir_contrasena');

		const router_src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		expect(router_src).toContain('!is_password_define_post(req)');
	});
});
