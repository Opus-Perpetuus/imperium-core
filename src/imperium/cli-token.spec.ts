import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bind_cli_user_lookup, build_access, current_user } from './auth.ts';
import {
	authenticate_cli_user,
	CLI_ACCESS_REF,
	CLI_MODEL_ID,
	CLI_TOKEN_PREFIX,
	CLI_TOKEN_RESOURCE,
	handle_cli_token,
	hash_cli_token,
	has_cli_gate,
	seed_cli_access,
} from './cli-token.ts';
import type { ImperiumDoc } from './envelope.ts';
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
const CAJERO: Row = {
	_id: 'cajero-1',
	name: 'Cajero',
	email: 'cajero@local',
	type: 'internal',
	is_active: true,
};
const SIN_PERMISO: Row = {
	_id: 'sin-1',
	name: 'IA Sin permiso',
	email: 'ia.sinpermiso@local',
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

function bind(store: ImperiumStore) {
	bind_cli_user_lookup((req) => authenticate_cli_user(store, req));
}

afterEach(() => {
	bind_cli_user_lookup(null);
});

const empty_sql = {} as Bun.SQL;

async function call(
	store: ImperiumStore,
	method: string,
	path: string,
	opts: { body?: unknown; cookie?: string; token?: string } = {},
) {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (opts.cookie) headers.set('cookie', opts.cookie);
	if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
	const url = new URL(`http://core/api${path}`);
	const req = new Request(url, {
		method,
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
	});
	const res = await handle_cli_token(store, empty_sql, req, url);
	const json = (await res.json()) as Record<string, unknown>;
	return { status: res.status, json };
}

describe('tokens de la CLI', () => {
	test('la siembra del permiso ImperiumCli es idempotente y va al grupo administrador', async () => {
		const store = memory_store({ 'access-rights': [], user: [ADMIN] });
		await seed_cli_access(store);
		await seed_cli_access(store);
		const rows = store.data['access-rights'] ?? [];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			_ref: CLI_ACCESS_REF,
			model_id: CLI_MODEL_ID,
			group_id: 'user-group-0',
			allow_read: true,
		});
	});

	test('el administrador y un cajero interno tienen la puerta; un usuario público no', async () => {
		const store = memory_store({
			user: [ADMIN, CAJERO, PUBLICO],
			'access-rights': [],
			'user-group': [],
		});
		expect(await has_cli_gate(store, ADMIN)).toBe(true);
		expect(await has_cli_gate(store, CAJERO)).toBe(true);
		expect(await has_cli_gate(store, SIN_PERMISO)).toBe(true);
		expect(await has_cli_gate(store, PUBLICO)).toBe(false);
	});

	test('generar un token CLI no exige sesión MCP y no revoca un token MCP previo', async () => {
		const store = memory_store({
			user: [ADMIN],
			[CLI_TOKEN_RESOURCE]: [],
			'mcp-user-token': [
				{
					_id: 'mcp-1',
					user_id: ADMIN._id,
					token_hash: hash_cli_token('isic_previo'),
					is_active: true,
					name: 'MCP',
				},
			],
		});
		bind(store);
		// Sin cookie: no hay actor
		const denied = await call(store, 'POST', '/cli/token/generate', { body: { name: 'laptop' } });
		expect(denied.status).toBe(401);

		// Simulamos actor inyectando un token tras un primer generate vía lookup de usuario en handle
		// con un “actor de sesión”: current_user no tiene cookie aquí, así que insertamos el token
		// a través de authenticate después de un issue directo usando el usuario del store.
		// Para generar con “sesión”, apeamos un stub de lookup que devuelve al admin sin Bearer.
		bind_cli_user_lookup(async (req) => {
			if (req.headers.get('x-session-user') === ADMIN._id) return ADMIN;
			return authenticate_cli_user(store, req);
		});
		const first = await call(store, 'POST', '/cli/token/generate', {
			body: { name: 'laptop', device_name: 'kyostenas' },
		});
		// 401 because we didn't set the header. Set it:
		const req_headers = { 'x-session-user': ADMIN._id };
		const url = new URL('http://core/api/cli/token/generate');
		const req = new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...req_headers },
			body: JSON.stringify({ name: 'laptop', device_name: 'kyostenas' }),
		});
		const res = await handle_cli_token(store, empty_sql, req, url);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<{ token: string; token_prefix: string; name: string }> };
		const token = body.data[0]!.token;
		expect(token.startsWith(CLI_TOKEN_PREFIX)).toBe(true);
		expect(body.data[0]!.name).toBe('laptop');

		const second_req = new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...req_headers },
			body: JSON.stringify({ name: 'moto', device_name: 'Moto G85' }),
		});
		const second = await handle_cli_token(store, empty_sql, second_req, url);
		expect(second.status).toBe(200);
		const token2 = ((await second.json()) as { data: Array<{ token: string }> }).data[0]!.token;
		expect(token2).not.toBe(token);

		const mcp = store.data['mcp-user-token']![0]!;
		expect(mcp.is_active).toBe(true);
		expect(mcp.revoked_at).toBeUndefined();
		expect(store.data[CLI_TOKEN_RESOURCE]!.filter((r) => r.is_active !== false && !r.revoked_at)).toHaveLength(2);
	});

	test('el Bearer icli_ autentica como el usuario de la GUI y construye el mismo acceso', async () => {
		const store = memory_store({
			user: [ADMIN, CAJERO],
			[CLI_TOKEN_RESOURCE]: [],
			'access-rights': [],
			'user-group': [],
		});
		const plaintext = `${CLI_TOKEN_PREFIX}abc123token`;
		await store.insert(CLI_TOKEN_RESOURCE, {
			name: 'laptop',
			user_id: CAJERO._id,
			token_hash: hash_cli_token(plaintext),
			token_prefix: plaintext.slice(0, 12),
			is_active: true,
		});
		bind(store);
		const req = new Request('http://core/api/meta', {
			headers: { authorization: `Bearer ${plaintext}`, 'x-imperium-client': 'imperium-cli' },
		});
		const actor = await current_user(empty_sql, req);
		expect(actor?._id).toBe(CAJERO._id);
		expect(actor?.email).toBe(CAJERO.email);
		const via_token = await build_access(store, actor!);
		const via_gui = await build_access(store, CAJERO);
		expect(via_token).toEqual(via_gui);
	});

	test('un isic_ MCP o un icli_ revocado no autentican en current_user', async () => {
		const store = memory_store({
			user: [ADMIN],
			[CLI_TOKEN_RESOURCE]: [
				{
					_id: 't-rev',
					user_id: ADMIN._id,
					token_hash: hash_cli_token(`${CLI_TOKEN_PREFIX}revocado`),
					is_active: false,
					revoked_at: new Date().toISOString(),
				},
			],
			'mcp-user-token': [
				{
					_id: 'mcp-1',
					user_id: ADMIN._id,
					token_hash: createHash('sha256').update('isic_sigue', 'utf8').digest('hex'),
					is_active: true,
				},
			],
		});
		bind(store);
		const mcp = await current_user(
			empty_sql,
			new Request('http://core/api/meta', { headers: { authorization: 'Bearer isic_sigue' } }),
		);
		expect(mcp).toBeNull();
		const revoked = await current_user(
			empty_sql,
			new Request('http://core/api/meta', { headers: { authorization: `Bearer ${CLI_TOKEN_PREFIX}revocado` } }),
		);
		expect(revoked).toBeNull();
	});

	test('cerrar o revocar un token no apaga los demás ni el MCP', async () => {
		const store = memory_store({
			user: [ADMIN],
			[CLI_TOKEN_RESOURCE]: [],
			'mcp-user-token': [
				{ _id: 'mcp-1', user_id: ADMIN._id, token_hash: 'abc', is_active: true },
			],
		});
		bind_cli_user_lookup(async (req) => {
			if (req.headers.get('x-session-user') === ADMIN._id) return ADMIN;
			return authenticate_cli_user(store, req);
		});
		const issue = async (name: string) => {
			const url = new URL('http://core/api/cli/token/generate');
			const res = await handle_cli_token(
				store,
				empty_sql,
				new Request(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'x-session-user': ADMIN._id },
					body: JSON.stringify({ name }),
				}),
				url,
			);
			return ((await res.json()) as { data: Array<{ token: string; id: string }> }).data[0]!;
		};
		const a = await issue('laptop');
		const b = await issue('moto');
		const url = new URL('http://core/api/cli/token/revoke');
		const res = await handle_cli_token(
			store,
			empty_sql,
			new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
				body: JSON.stringify({}),
			}),
			url,
		);
		expect(res.status).toBe(200);
		const still = store.data[CLI_TOKEN_RESOURCE]!;
		const a_row = still.find((r) => String(r._id) === a.id)!;
		const b_row = still.find((r) => String(r._id) === b.id)!;
		expect(a_row.revoked_at).toBeTruthy();
		expect(b_row.is_active).not.toBe(false);
		expect(b_row.revoked_at).toBeFalsy();
		expect(store.data['mcp-user-token']![0]!.is_active).toBe(true);

		bind(store);
		expect(await current_user(empty_sql, new Request('http://c', { headers: { authorization: `Bearer ${a.token}` } }))).toBeNull();
		expect((await current_user(empty_sql, new Request('http://c', { headers: { authorization: `Bearer ${b.token}` } })))?._id).toBe(ADMIN._id);
	});

	test('ia.sinpermiso obtiene token pero su ACL no concede modelos (como en la GUI)', async () => {
		const store = memory_store({
			user: [SIN_PERMISO],
			[CLI_TOKEN_RESOURCE]: [],
			'access-rights': [],
			'user-group': [],
		});
		bind_cli_user_lookup(async (req) => {
			if (req.headers.get('x-session-user') === SIN_PERMISO._id) return SIN_PERMISO;
			return authenticate_cli_user(store, req);
		});
		const url = new URL('http://core/api/cli/token/generate');
		const res = await handle_cli_token(
			store,
			empty_sql,
			new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-session-user': SIN_PERMISO._id },
				body: JSON.stringify({ name: 'pruebas' }),
			}),
			url,
		);
		expect(res.status).toBe(200);
		const token = ((await res.json()) as { data: Array<{ token: string }> }).data[0]!.token;
		bind(store);
		const actor = await current_user(
			empty_sql,
			new Request('http://core/api/products', { headers: { authorization: `Bearer ${token}` } }),
		);
		expect(actor?._id).toBe(SIN_PERMISO._id);
		const access = await build_access(store, actor!);
		expect(access.has_full_access).toBeFalsy();
		expect(access.models).not.toContain('Products');
	});

	test('un usuario público no puede generar token CLI', async () => {
		const store = memory_store({ user: [PUBLICO], [CLI_TOKEN_RESOURCE]: [] });
		bind_cli_user_lookup(async (req) =>
			req.headers.get('x-session-user') === PUBLICO._id ? PUBLICO : null,
		);
		const url = new URL('http://core/api/cli/token/generate');
		const res = await handle_cli_token(
			store,
			empty_sql,
			new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-session-user': PUBLICO._id },
				body: JSON.stringify({ name: 'x' }),
			}),
			url,
		);
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe('cli_gate_denied');
	});

	test('status lista los tokens activos sin el secreto', async () => {
		const store = memory_store({ user: [ADMIN], [CLI_TOKEN_RESOURCE]: [] });
		const plaintext = `${CLI_TOKEN_PREFIX}${'s'.repeat(40)}`;
		await store.insert(CLI_TOKEN_RESOURCE, {
			name: 'laptop',
			device_name: 'kyostenas',
			user_id: ADMIN._id,
			token_hash: hash_cli_token(plaintext),
			token_prefix: plaintext.slice(0, 12),
			is_active: true,
		});
		bind(store);
		const url = new URL('http://core/api/cli/token/status');
		const res = await handle_cli_token(
			store,
			empty_sql,
			new Request(url, { headers: { authorization: `Bearer ${plaintext}` } }),
			url,
		);
		expect(res.status).toBe(200);
		const payload = (await res.json()) as { data: Array<{ tokens: Array<Record<string, unknown>> }> };
		expect(payload.data[0]!.tokens).toHaveLength(1);
		expect(payload.data[0]!.tokens[0]).toMatchObject({ name: 'laptop', device_name: 'kyostenas' });
		expect(JSON.stringify(payload)).not.toContain(plaintext);
		expect(JSON.stringify(payload)).not.toContain(hash_cli_token(plaintext));
		expect(JSON.stringify(payload)).not.toContain('token_hash');
	});
});
