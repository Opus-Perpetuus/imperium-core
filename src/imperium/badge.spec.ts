import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { GENERIC_CREDENTIALS_MESSAGE } from '@opus-perpetuus/imperium-core-kit';
import { handle_auth, user_for_session_id } from './auth.ts';
import {
	BADGE_PIN_MAX_FAILURES,
	BADGE_RESOURCE,
	BADGE_SESSION,
	issue_badge,
	reset_badge_pin,
	revoke_badge,
} from './badge.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc & { _id: string };

afterEach(() => setSystemTime());

function fixture() {
	const data: Record<string, Row[]> = {
		user: [
			{
				_id: 'u-1',
				_ref: 'user-menu-management-0',
				email: 'admin@local',
				type: 'internal',
				is_active: true,
				employee: 'e-1',
			},
		],
		[BADGE_RESOURCE]: [],
	};
	let seq = 1;
	const rows = (resource: string) => (data[resource] ??= []);
	const matches = (row: Row, where: Record<string, unknown>) =>
		Object.entries(where).every(([k, v]) => row[k] === v);
	const store = {
		has: (resource: string) => resource in data,
		available_mongoose_models: () => [],
		is_model_installed: () => true,
		async find_where(resource: string, where: Record<string, unknown>) {
			return rows(resource).find((row) => matches(row, where)) ?? null;
		},
		async find_id(resource: string, id: string) {
			return rows(resource).find((row) => row._id === id) ?? null;
		},
		async insert(resource: string, doc: Record<string, unknown>) {
			const row = { ...doc, _id: `${resource}-${seq++}` } as Row;
			rows(resource).push(row);
			return row;
		},
		async update(resource: string, id: string, patch: Record<string, unknown>) {
			const row = rows(resource).find((r) => r._id === id);
			if (!row) return null;
			Object.assign(row, patch);
			return row;
		},
		async *scan(resource: string, opts: { mongo_match?: Record<string, unknown> }) {
			yield rows(resource).filter((row) => matches(row, opts.mongo_match ?? {}));
		},
	};
	const sessions = new Map<string, { payload: ImperiumDoc; exp: number }>();
	const attempts: unknown[][] = [];
	const params_seen: unknown[][] = [];
	const sql = {
		async unsafe(q: string, params: unknown[] = []) {
			params_seen.push(params);
			if (q.includes('INSERT INTO public.imperium_sessions')) {
				sessions.set(String(params[0]), {
					payload: JSON.parse(String(params[1])) as ImperiumDoc,
					exp: Number(params[2]),
				});
				return [];
			}
			if (q.includes('DELETE FROM public.imperium_sessions WHERE payload')) {
				const out = [...sessions]
					.filter(
						([, s]) =>
							s.payload._id === params[0] &&
							(params.length < 2 || s.payload.badge_id === params[1]),
					)
					.map(([id]) => ({ id }));
				for (const { id } of out) sessions.delete(id);
				return out;
			}
			if (q.includes('DELETE FROM public.imperium_sessions WHERE id')) {
				sessions.delete(String(params[0]));
				return [];
			}
			if (q.includes('SELECT payload')) {
				const s = sessions.get(String(params[0]));
				return s ? [{ payload: s.payload, exp: s.exp }] : [];
			}
			if (q.includes('UPDATE public.imperium_sessions')) {
				const s = sessions.get(String(params[0]));
				if (s) s.payload.last_seen = params[1];
				return [];
			}
			if (q.includes('INSERT INTO public.imperium_auth_attempts')) {
				attempts.push(params);
				return [];
			}
			return [];
		},
	};
	return {
		data,
		store: store as unknown as ImperiumStore,
		sql: sql as unknown as Bun.SQL,
		sessions,
		attempts,
		params_seen,
	};
}

type Fixture = ReturnType<typeof fixture>;

async function login(f: Fixture, body: Record<string, unknown>) {
	const req = new Request('http://core/auth/badge/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const res = await handle_auth(f.store, f.sql, req, new URL(req.url));
	const cookie = res?.headers.get('set-cookie') ?? '';
	const sid = decodeURIComponent(cookie.match(/connect\.sid=([^;]*)/)?.[1] ?? '');
	return {
		status: res?.status ?? 0,
		body: (await res?.json()) as Record<string, unknown>,
		sid,
		cookie,
	};
}

async function expect_generic_401(f: Fixture, body: Record<string, unknown>) {
	const res = await login(f, body);
	expect(res.status).toBe(401);
	expect(res.body.message).toBe(GENERIC_CREDENTIALS_MESSAGE);
	expect(res.body.pin_required).toBeUndefined();
	expect(res.sid).toBe('');
}

describe('POST /auth/badge/login', () => {
	test('token válido entra; la sesión dura 12 h y cierra por inactividad de no registrado', async () => {
		const f = fixture();
		const badge = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		expect(badge.token).toMatch(/^igb1_[A-Za-z0-9_-]{43}$/);

		const sin_pin = await login(f, { token: badge.token });
		expect(sin_pin.status).toBe(401);
		expect(sin_pin.body).toMatchObject({ pin_required: true, message: GENERIC_CREDENTIALS_MESSAGE });

		const start = Date.now();
		const ok = await login(f, { token: badge.token, pin: '1234' });
		expect(ok.status).toBe(200);
		expect(ok.cookie).toContain(`Max-Age=${BADGE_SESSION.ttl_ms / 1000}`);
		const row = f.sessions.get(ok.sid);
		expect(row?.payload).toMatchObject({
			_id: 'u-1',
			auth_method: 'badge',
			badge_id: badge.id,
			badge_serie: 1,
			idle_ms: BADGE_SESSION.idle_unregistered_ms,
		});
		expect(row!.exp - start).toBeGreaterThanOrEqual(BADGE_SESSION.ttl_ms - 1000);
		expect(row!.exp - start).toBeLessThanOrEqual(BADGE_SESSION.ttl_ms + 1000);
		expect((await user_for_session_id(f.sql, ok.sid))?._id).toBe('u-1');

		expect((await login(f, { token: badge.token, pin: '1234' })).status).toBe(200);
	});

	test('revocado, reemplazado, reasignado o usuario inactivo dan el 401 genérico', async () => {
		const f = fixture();
		const first = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		await reset_badge_pin(f.store, first.id, '4321');
		const second = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		expect(second.serie).toBe(2);
		await expect_generic_401(f, { token: first.token, pin: '4321' });

		await revoke_badge(f.store, f.sql, 'u-1', second.id, 'perdido');
		await expect_generic_401(f, { token: second.token, pin: '4321' });

		const third = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		await reset_badge_pin(f.store, third.id, '4321');
		expect((await login(f, { token: third.token, pin: '4321' })).status).toBe(200);
		const user = f.data.user![0]!;
		user.employee = 'e-9';
		await expect_generic_401(f, { token: third.token, pin: '4321' });
		user.employee = 'e-1';
		user.is_active = false;
		await expect_generic_401(f, { token: third.token, pin: '4321' });

		await expect_generic_401(f, { token: 'igb1_corto', pin: '4321' });
		await expect_generic_401(f, { token: `igb1_${'A'.repeat(43)}`, pin: '4321' });
	});

	test('5 fallos de PIN bloquean el gafete hasta que se reinicia', async () => {
		const f = fixture();
		const badge = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		await reset_badge_pin(f.store, badge.id, '4321');
		for (let i = 0; i < BADGE_PIN_MAX_FAILURES; i++) {
			await expect_generic_401(f, { token: badge.token, pin: '0000' });
		}
		expect(f.data[BADGE_RESOURCE]![0]!.estado).toBe('bloqueado');
		await expect_generic_401(f, { token: badge.token, pin: '4321' });

		await reset_badge_pin(f.store, badge.id, '5678');
		expect((await login(f, { token: badge.token, pin: '5678' })).status).toBe(200);
	});

	test('revocar cierra la sesión en memoria y en la tabla', async () => {
		const f = fixture();
		const badge = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		const { sid } = await login(f, { token: badge.token, pin: '1234' });
		expect(await user_for_session_id(f.sql, sid)).not.toBeNull();

		await revoke_badge(f.store, f.sql, 'u-1', badge.id, 'perdido');
		expect(f.sessions.has(sid)).toBe(false);
		expect(await user_for_session_id(f.sql, sid)).toBeNull();
	});

	test('la sesión de gafete se revalida contra la tabla cada 60 s', async () => {
		const f = fixture();
		const badge = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		const { sid } = await login(f, { token: badge.token, pin: '1234' });
		f.sessions.delete(sid);
		expect(await user_for_session_id(f.sql, sid)).not.toBeNull();
		setSystemTime(new Date(Date.now() + 61_000));
		expect(await user_for_session_id(f.sql, sid)).toBeNull();
	});

	test('la sesión de gafete cierra tras la inactividad', async () => {
		const f = fixture();
		const badge = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
		const { sid } = await login(f, { token: badge.token, pin: '1234' });
		setSystemTime(new Date(Date.now() + BADGE_SESSION.idle_unregistered_ms + 61_000));
		expect(await user_for_session_id(f.sql, sid)).toBeNull();
		expect(f.sessions.has(sid)).toBe(false);
	});

	test('el token no aparece en logs, bitácora ni en lo que va a la base', async () => {
		const f = fixture();
		const logged: unknown[] = [];
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
			spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(...args);
			}),
		);
		try {
			const badge = await issue_badge(f.store, f.sql, 'u-1', 'u-1');
			await login(f, { token: badge.token });
			await login(f, { token: badge.token, pin: '1234' });
			await login(f, { token: badge.token, pin: '9999' });
			await revoke_badge(f.store, f.sql, 'u-1', badge.id, 'perdido');
			await login(f, { token: badge.token, pin: '1234' });

			const secret = badge.token.slice(12);
			expect(f.attempts.length).toBe(4);
			expect(f.attempts.every((row) => row.includes(badge.token_prefix))).toBe(true);
			expect(JSON.stringify(f.attempts)).not.toContain(secret);
			expect(JSON.stringify(f.params_seen)).not.toContain(secret);
			expect(JSON.stringify(logged)).not.toContain(secret);
			expect(JSON.stringify(f.data)).not.toContain(secret);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
