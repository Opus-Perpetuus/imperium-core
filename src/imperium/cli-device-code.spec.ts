import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bind_cli_user_lookup } from './auth.ts';
import {
	bind_device_session_lookup,
	DEVICE_CODE_TTL_S,
	DEVICE_GRANT_TYPE,
	DEVICE_POLL_INTERVAL_S,
	normalize_user_code,
	pin_device_clock,
	reset_device_codes,
} from './cli-device-code.ts';
import {
	authenticate_cli_user,
	CLI_MODEL_ID,
	CLI_TOKEN_PREFIX,
	CLI_TOKEN_RESOURCE,
	handle_cli_token,
} from './cli-token.ts';
import type { ImperiumDoc } from './envelope.ts';
import { drop_rate_bucket } from './rate-bucket.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc & { _id: string };

const ADMIN: Row = {
	_id: 'admin-1',
	_ref: 'user-menu-management-0',
	name: 'Admin',
	email: 'admin@local',
	type: 'internal',
	is_active: true,
};
const PUBLICO: Row = {
	_id: 'pub-1',
	name: 'Público',
	email: 'publico@local',
	type: 'external',
	is_active: true,
};

function memory_store(seed: Record<string, Row[]> = {}) {
	const data: Record<string, Row[]> = Object.fromEntries(
		Object.entries(seed).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]),
	);
	const ensure = (resource: string) => {
		data[resource] ??= [];
		return data[resource]!;
	};
	let seq = 1;
	const store = {
		data,
		has: (resource: string) =>
			resource in data ||
			resource === 'access-rights' ||
			resource === 'user' ||
			resource === CLI_TOKEN_RESOURCE ||
			resource === 'mcp-user-token' ||
			resource === 'user-group' ||
			resource === 'products',
		available_mongoose_models: () => [{ model_name: 'Products' }, { model_name: CLI_MODEL_ID }],
		is_model_installed: () => true,
		is_resource_installed: () => true,
		async find_where(resource: string, where: Record<string, unknown>) {
			const rows = ensure(resource);
			return (
				rows.find((row) => Object.entries(where).every(([k, v]) => String(row[k] ?? '') === String(v))) ??
				null
			);
		},
		async find_id(resource: string, id: string) {
			return ensure(resource).find((row) => String(row._id) === id) ?? null;
		},
		async insert(resource: string, row: Record<string, unknown>) {
			const doc = { ...row, _id: String(row._id ?? `${resource}-${seq++}`), createdAt: new Date().toISOString() } as Row;
			ensure(resource).push(doc);
			return doc;
		},
		async update(resource: string, id: string, patch: Record<string, unknown>) {
			const row = ensure(resource).find((r) => String(r._id) === id);
			if (!row) return null;
			Object.assign(row, patch);
			return row;
		},
		async *scan(resource: string, opts?: { mongo_match?: Record<string, unknown>; include_inactive?: boolean }) {
			let rows = ensure(resource).slice();
			if (!opts?.include_inactive) rows = rows.filter((r) => r.is_active !== false);
			const match = opts?.mongo_match ?? {};
			rows = rows.filter((row) =>
				Object.entries(match).every(([k, v]) => String(row[k] ?? '') === String(v)),
			);
			yield rows;
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

const empty_sql = {} as Bun.SQL;
let clock = 1_800_000_000_000;

async function call(
	store: ImperiumStore,
	method: string,
	path: string,
	opts: { body?: unknown; session?: string; token?: string; headers?: Record<string, string> } = {},
) {
	const headers = new Headers({ 'content-type': 'application/json', ...(opts.headers ?? {}) });
	if (opts.session) headers.set('x-test-session', opts.session);
	if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
	const url = new URL(`http://core/api${path}`);
	const req = new Request(url, {
		method,
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
	});
	const res = await handle_cli_token(store, empty_sql, req, url);
	const type = res.headers.get('content-type') ?? '';
	const json = type.includes('json') ? ((await res.json()) as Record<string, any>) : { html: await res.text() };
	return { status: res.status, json, headers: res.headers };
}

function setup(users: Row[] = [ADMIN, PUBLICO]) {
	const store = memory_store({ user: users, [CLI_TOKEN_RESOURCE]: [], 'access-rights': [], 'user-group': [] });
	bind_cli_user_lookup((req) => authenticate_cli_user(store, req));
	bind_device_session_lookup(async (_sql, req) => {
		const id = req.headers.get('x-test-session');
		return users.find((u) => u._id === id) ?? null;
	});
	return store;
}

const poll = (store: ImperiumStore, device_code: string) =>
	call(store, 'POST', '/cli/device/token', { body: { grant_type: DEVICE_GRANT_TYPE, device_code } });

beforeEach(() => {
	clock += 3_600_000;
	pin_device_clock(clock);
	reset_device_codes();
	drop_rate_bucket('cli-device:code-ip:unknown');
	drop_rate_bucket('cli-device:token-ip:unknown');
	drop_rate_bucket('cli-device:approve-user:admin-1');
});

afterEach(() => {
	pin_device_clock(null);
	bind_device_session_lookup(null);
	bind_cli_user_lookup(null);
});

describe('código de dispositivo de la CLI (RFC 8628)', () => {
	test('flujo completo: pedir, pendiente, aprobar con sesión, canjear un token icli_ de un solo uso', async () => {
		const store = setup();
		const code = await call(store, 'POST', '/cli/device/code', { body: { device_name: 'kyostenas' } });
		expect(code.status).toBe(200);
		expect(code.json.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		expect(code.json.expires_in).toBe(DEVICE_CODE_TTL_S);
		expect(code.json.interval).toBe(DEVICE_POLL_INTERVAL_S);
		expect(code.json.verification_uri).toBe('http://core/api/cli/device');
		expect(code.json.verification_uri_complete).toContain(encodeURIComponent(code.json.user_code));
		expect(code.headers.get('cache-control')).toBe('no-store');

		const pending = await poll(store, code.json.device_code);
		expect(pending.status).toBe(400);
		expect(pending.json.error).toBe('authorization_pending');

		const verify = await call(store, 'GET', `/cli/device/verify?user_code=${code.json.user_code.toLowerCase()}`, {
			session: ADMIN._id,
		});
		expect(verify.status).toBe(200);
		expect(verify.json.device_name).toBe('kyostenas');

		const approve = await call(store, 'POST', '/cli/device/approve', {
			session: ADMIN._id,
			body: { user_code: code.json.user_code.replace('-', ' ') },
		});
		expect(approve.status).toBe(200);
		expect(approve.json.status).toBe('approved');

		clock += DEVICE_POLL_INTERVAL_S * 1000;
		pin_device_clock(clock);
		const granted = await poll(store, code.json.device_code);
		expect(granted.status).toBe(200);
		expect(granted.json.token_type).toBe('Bearer');
		expect(String(granted.json.access_token).startsWith(CLI_TOKEN_PREFIX)).toBe(true);
		expect(granted.json.user).toEqual({ _id: ADMIN._id, name: 'Admin', email: 'admin@local' });
		const rows = (store as any).data[CLI_TOKEN_RESOURCE] as Row[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.device_name).toBe('kyostenas');
		expect(rows[0]!.user_id).toBe(ADMIN._id);
		expect(JSON.stringify(rows[0])).not.toContain(String(granted.json.access_token));

		// El token sirve como el usuario de la GUI.
		const status = await call(store, 'GET', '/cli/token/status', { token: granted.json.access_token });
		expect(status.status).toBe(200);

		// Un solo uso: el mismo device_code ya no canjea otro token.
		const again = await poll(store, code.json.device_code);
		expect(again.status).toBe(400);
		expect(again.json.error).toBe('invalid_grant');
		expect(rows).toHaveLength(1);
	});

	test('preguntar antes del intervalo responde slow_down y sube el intervalo', async () => {
		const store = setup();
		const code = await call(store, 'POST', '/cli/device/code', { body: {} });
		expect((await poll(store, code.json.device_code)).json.error).toBe('authorization_pending');
		const fast = await poll(store, code.json.device_code);
		expect(fast.status).toBe(400);
		expect(fast.json.error).toBe('slow_down');
		expect(fast.json.interval).toBe(DEVICE_POLL_INTERVAL_S + 5);
		clock += (DEVICE_POLL_INTERVAL_S + 5) * 1000;
		pin_device_clock(clock);
		expect((await poll(store, code.json.device_code)).json.error).toBe('authorization_pending');
	});

	test('el código expira a los diez minutos: expired_token y ya no se puede aprobar', async () => {
		const store = setup();
		const code = await call(store, 'POST', '/cli/device/code', { body: {} });
		clock += DEVICE_CODE_TTL_S * 1000 + 1;
		pin_device_clock(clock);
		const approve = await call(store, 'POST', '/cli/device/approve', {
			session: ADMIN._id,
			body: { user_code: code.json.user_code },
		});
		expect(approve.status).toBe(404);
		const expired = await poll(store, code.json.device_code);
		expect(expired.json.error).toBe('expired_token');
		expect((store as any).data[CLI_TOKEN_RESOURCE]).toHaveLength(0);
	});

	test('rechazar en el navegador responde access_denied y no emite token', async () => {
		const store = setup();
		const code = await call(store, 'POST', '/cli/device/code', { body: {} });
		const deny = await call(store, 'POST', '/cli/device/approve', {
			session: ADMIN._id,
			body: { user_code: code.json.user_code, accion: 'rechazar' },
		});
		expect(deny.json.status).toBe('denied');
		const res = await poll(store, code.json.device_code);
		expect(res.json.error).toBe('access_denied');
		expect((store as any).data[CLI_TOKEN_RESOURCE]).toHaveLength(0);
	});

	test('aprobar exige la sesión de la GUI: sin cookie, con Bearer icli_ o con usuario público no aprueba', async () => {
		const store = setup();
		const code = await call(store, 'POST', '/cli/device/code', { body: {} });
		const none = await call(store, 'POST', '/cli/device/approve', { body: { user_code: code.json.user_code } });
		expect(none.status).toBe(401);
		const bearer = await call(store, 'POST', '/cli/device/approve', {
			token: 'icli_falso',
			body: { user_code: code.json.user_code },
		});
		expect(bearer.status).toBe(401);
		const pub = await call(store, 'POST', '/cli/device/approve', {
			session: PUBLICO._id,
			body: { user_code: code.json.user_code },
		});
		expect(pub.status).toBe(403);
		const cross = await call(store, 'POST', '/cli/device/approve', {
			session: ADMIN._id,
			headers: { origin: 'https://otro.example', host: 'core' },
			body: { user_code: code.json.user_code },
		});
		expect(cross.status).toBe(403);
		expect((await poll(store, code.json.device_code)).json.error).toBe('authorization_pending');
	});

	test('grant_type distinto y device_code inventado se rechazan', async () => {
		const store = setup();
		const bad = await call(store, 'POST', '/cli/device/token', { body: { grant_type: 'password', device_code: 'x' } });
		expect(bad.json.error).toBe('unsupported_grant_type');
		const unknown = await poll(store, 'inventado');
		expect(unknown.json.error).toBe('invalid_grant');
	});

	test('pedir códigos tiene límite por IP (429 con retry-after)', async () => {
		const store = setup();
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) statuses.push((await call(store, 'POST', '/cli/device/code', { body: {} })).status);
		expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
		const last = await call(store, 'POST', '/cli/device/code', { body: {} });
		expect(last.status).toBe(429);
		expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
	});

	test('adivinar códigos al aprobar tiene límite por usuario', async () => {
		const store = setup();
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			statuses.push(
				(await call(store, 'POST', '/cli/device/approve', { session: ADMIN._id, body: { user_code: 'BCDF-GHJK' } })).status,
			);
		}
		expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
		expect(statuses.at(-1)).toBe(429);
	});

	test('la página de verificación es HTML sin datos del usuario y no se puede incrustar', async () => {
		const store = setup();
		const page = await call(store, 'GET', '/cli/device');
		expect(page.status).toBe(200);
		expect(page.headers.get('x-frame-options')).toBe('DENY');
		expect(page.json.html).toContain('Conectar la CLI de Imperium');
		expect(page.json.html).toContain('/api/cli/device/approve');
	});

	test('normaliza el código que escribe la persona', () => {
		expect(normalize_user_code('bcdf ghjk')).toBe('BCDF-GHJK');
		expect(normalize_user_code('BCDF-GHJ')).toBe('');
		expect(normalize_user_code('ABCD-EFGH')).toBe('');
		expect(CLI_MODEL_ID).toBe('ImperiumCli');
	});
});
