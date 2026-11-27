import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import type { ImperiumDoc } from './envelope.ts';
import { handle_mcp, MCP_RATE } from './mcp-server.ts';
import type { ImperiumStore } from './store.ts';

const USER: ImperiumDoc = {
	_id: 'u1',
	name: 'Ana',
	email: 'ana@test',
	_ref: 'user-ana',
	is_active: true,
};

function token_of(label: string): string {
	return `isic_${label}_${'a'.repeat(24)}`;
}

type WorldOpts = {
	read_contacto?: boolean;
	gate?: boolean;
	rules?: boolean;
	contacto_installed?: boolean;
	contacto_exists?: boolean;
	contacts?: ImperiumDoc[];
	modules?: ImperiumDoc[];
	logs?: ImperiumDoc[];
};

function world(plaintext: string, opts: WorldOpts = {}) {
	const hash = createHash('sha256').update(plaintext).digest('hex');
	const looked: string[] = [];
	const rights: ImperiumDoc[] = [];
	if (opts.gate !== false) {
		rights.push({ _id: 'ar-mcp', model_id: 'McpAgent', allow_read: true, group_id: 'g1' });
	}
	if (opts.read_contacto) {
		rights.push({ _id: 'ar-contacto', model_id: 'contacto', allow_read: true, group_id: 'g1' });
	}
	const group: ImperiumDoc = {
		_id: 'g1',
		_ref: 'g1',
		name: opts.read_contacto ? 'Con contactos' : 'Sin contactos',
		user_ids: [USER._id],
		access_rights_ids: rights.map((right) => String(right._id)),
		record_rules_ids: opts.rules ? ['rr1'] : [],
	};
	const rules: ImperiumDoc[] = opts.rules
		? [
				{
					_id: 'rr1',
					name: 'Solo los míos',
					model_id: 'contacto',
					group_id: 'g1',
					allow_read: true,
					domain: { created_by: '$current_user_id' },
				},
			]
		: [];
	const modules =
		opts.modules ??
		(opts.read_contacto
			? [{ model_id: 'contacto', name: 'Contacto', is_enable: true, description: 'Personas' }]
			: []);
	const contacts = opts.contacts ?? [];
	const exists = opts.contacto_exists !== false;
	const installed = opts.contacto_installed !== false;
	const store = {
		all_locs: exists
			? [
					{
						resource: 'contacto',
						name: 'Contacto',
						collection: 'contacto',
						columns: [],
						slug: 'base',
						technical_id: 't',
						table: 'contacto',
					},
				]
			: [],
		has(resource: string) {
			if (resource === 'contacto') return exists;
			if (resource === 'debug-log') return Boolean(opts.logs);
			return ['mcp-user-token', 'user', 'user-group', 'access-rights', 'record-rules', 'module-management'].includes(
				resource,
			);
		},
		is_model_installed: () => true,
		is_resource_installed: (resource: string) => resource !== 'contacto' || (exists && installed),
		available_mongoose_models: () => [],
		resource_for_model: (model: string) => (exists && model.toLowerCase() === 'contacto' ? 'contacto' : null),
		loc(resource: string) {
			return {
				resource,
				collection: resource,
				name: resource,
				columns: [],
				slug: 'base',
				technical_id: 't',
				table: resource,
			};
		},
		async find_where(resource: string, query: Record<string, unknown>) {
			looked.push(resource);
			if (resource === 'mcp-user-token' && query.token_hash === hash) {
				return {
					_id: 'tok1',
					user_id: USER._id,
					token_hash: hash,
					token_prefix: plaintext.slice(0, 12),
					is_active: true,
				};
			}
			return null;
		},
		async find_id(resource: string, id: string) {
			if (resource === 'user' && id === USER._id) return USER;
			return null;
		},
		async update() {
			return {};
		},
		async *scan(resource: string) {
			if (resource === 'user-group') yield [group];
			else if (resource === 'access-rights') yield rights;
			else if (resource === 'record-rules') yield rules;
			else if (resource === 'module-management') yield modules;
			else yield [];
		},
		async find_many(
			_resource: string,
			query: {
				q?: string;
				take?: number;
				mongo_match?: Record<string, unknown> | null;
				where?: Record<string, unknown>;
			},
		) {
			let rows = contacts.filter((row) => mongo_ok(row, query.mongo_match ?? null));
			if (query.where) {
				rows = rows.filter((row) => Object.entries(query.where ?? {}).every(([key, value]) => row[key] === value));
			}
			const q = String(query.q ?? '').trim().toLowerCase();
			if (q) rows = rows.filter((row) => String(row.name ?? '').toLowerCase().includes(q));
			const take = query.take ?? rows.length;
			return { rows: rows.slice(0, take), total: rows.length };
		},
		async insert(resource: string, doc: ImperiumDoc) {
			if (resource === 'debug-log') opts.logs?.push(doc);
			return { ...doc, _id: 'log' };
		},
	} as unknown as ImperiumStore;
	return { store, looked };
}

function mongo_ok(row: ImperiumDoc, match: Record<string, unknown> | null): boolean {
	if (!match) return true;
	if (Array.isArray(match.$and)) {
		return match.$and.every((part) => mongo_ok(row, part as Record<string, unknown>));
	}
	if (Array.isArray(match.$or)) {
		return match.$or.some((part) => mongo_ok(row, part as Record<string, unknown>));
	}
	return Object.entries(match).every(([key, value]) => key.startsWith('$') || row[key] === value);
}

type Rpc = {
	status: number;
	text: string;
	body: {
		ok?: boolean;
		error?: { code?: number; message?: string } | string;
		result?: {
			protocolVersion?: string;
			serverInfo?: { name?: string };
			tools?: Array<{ name: string; inputSchema?: { properties?: { modelo?: { enum?: string[] } } } }>;
			content?: Array<{ text?: string }>;
			isError?: boolean;
		};
		id?: unknown;
	} | null;
	headers: Headers;
};

async function rpc(
	store: ImperiumStore,
	plaintext: string | null,
	method: string,
	params?: unknown,
	extra?: { url?: string; headers?: Record<string, string>; ip?: string; raw?: string; method_http?: string },
): Promise<Rpc> {
	const headers: Record<string, string> = { 'content-type': 'application/json', ...(extra?.headers ?? {}) };
	if (plaintext) headers.authorization = `Bearer ${plaintext}`;
	const req = new Request(extra?.url ?? 'http://127.0.0.1:3100/api/mcp', {
		method: extra?.method_http ?? 'POST',
		headers,
		body: extra?.method_http === 'GET' ? undefined : (extra?.raw ?? JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: params ?? {} })),
	});
	if (extra?.ip) remember_socket_ip(req, extra.ip);
	const res = await handle_mcp(store, req, new URL(req.url));
	const text = await res.text();
	return {
		status: res.status,
		text,
		headers: res.headers,
		body: text ? (JSON.parse(text) as Rpc['body']) : null,
	};
}

function tool_names(body: Rpc['body']): string[] {
	return (body?.result?.tools ?? []).map((tool) => tool.name);
}

describe('POST /api/mcp', () => {
	test('quien no lee contactos no ve la herramienta y llamarla es error', async () => {
		const tok = token_of('sin');
		const { store } = world(tok, { read_contacto: false });
		const listed = await rpc(store, tok, 'tools/list');
		expect(listed.status).toBe(200);
		expect(tool_names(listed.body)).not.toContain('contactos_buscar');
		expect(tool_names(listed.body)).toEqual(['imperium_quien_soy', 'imperium_modelos', 'imperium_buscar']);
		const called = await rpc(store, tok, 'tools/call', { name: 'contactos_buscar', arguments: {} });
		expect(called.body?.error?.code).toBe(-32602);
	});

	test('el mismo usuario con otro grupo ve otra lista', async () => {
		const with_contacts = world(token_of('con'), { read_contacto: true });
		const without = world(token_of('otro'), { read_contacto: false });
		const yes = tool_names((await rpc(with_contacts.store, token_of('con'), 'tools/list')).body);
		const no = tool_names((await rpc(without.store, token_of('otro'), 'tools/list')).body);
		expect(yes).toContain('contactos_buscar');
		expect(no).not.toContain('contactos_buscar');
		expect(yes).not.toEqual(no);
	});

	test('el token en la URL se rechaza sin autenticar', async () => {
		const tok = token_of('url');
		const hidden = world(tok, { read_contacto: true });
		for (const query of ['tk', 'token']) {
			const res = await rpc(hidden.store, tok, 'ping', {}, {
				url: `http://127.0.0.1:3100/api/mcp?${query}=${tok}`,
			});
			expect(res.status).toBe(400);
			expect(res.body?.error).toBe('token_in_url');
			expect(res.text).not.toContain(tok.slice(12));
		}
		expect(hidden.looked).not.toContain('mcp-user-token');
	});

	test('la cookie de sesión no autentica', async () => {
		const tok = token_of('cookie');
		const { store, looked } = world(tok);
		const res = await rpc(store, null, 'ping', {}, { headers: { cookie: 'connect.sid=sesion-falsa' } });
		expect(res.status).toBe(401);
		expect(looked).not.toContain('mcp-user-token');
		const header = await rpc(store, null, 'ping', {}, { headers: { 'x-imperium-sic-token': tok } });
		expect(header.status).toBe(401);
		expect(looked).not.toContain('mcp-user-token');
		const other = await rpc(store, null, 'ping', {}, { headers: { authorization: 'Bearer icli_otro' } });
		expect(other.status).toBe(401);
		expect(looked).not.toContain('mcp-user-token');
	});

	test('un origen ajeno recibe 403 y el del propio núcleo pasa', async () => {
		const tok = token_of('origen');
		const { store } = world(tok);
		const evil = await rpc(store, tok, 'ping', {}, { headers: { origin: 'https://evil.test' } });
		expect(evil.status).toBe(403);
		expect(evil.body?.error).toBe('origin_denied');
		const same = await rpc(store, tok, 'ping', {}, { headers: { origin: 'http://127.0.0.1:3100' } });
		expect(same.status).toBe(200);
		const dev = await rpc(store, tok, 'ping', {}, { headers: { origin: 'http://localhost:4213' } });
		expect(dev.status).toBe(200);
		const spoof = await rpc(store, tok, 'ping', {}, {
			headers: { origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' },
		});
		expect(spoof.status).toBe(403);
		const previous = process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS;
		process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS = 'https://panel.mcp-fase1.test/';
		try {
			const allowed = await rpc(store, tok, 'ping', {}, { headers: { origin: 'https://panel.mcp-fase1.test' } });
			expect(allowed.status).toBe(200);
		} finally {
			if (previous === undefined) delete process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS;
			else process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS = previous;
		}
	});

	test('no hay herramientas de escritura y llamarlas es error', async () => {
		const tok = token_of('lectura');
		const { store } = world(tok, { read_contacto: true });
		const names = tool_names((await rpc(store, tok, 'tools/list')).body);
		expect(names.some((name) => /crear|editar|borrar|comentario|write/i.test(name))).toBe(false);
		const called = await rpc(store, tok, 'tools/call', { name: 'imperium_crear', arguments: {} });
		expect(called.body?.error?.code).toBe(-32602);
	});

	test('un registro fuera de las record-rules no sale en la búsqueda', async () => {
		const tok = token_of('reglas');
		const { store } = world(tok, {
			read_contacto: true,
			rules: true,
			contacts: [
				{ _id: 'mio', name: 'Visible', created_by: 'u1', password: 'sekret-mcp' },
				{ _id: 'ajeno', name: 'Oculto', created_by: 'otro' },
			],
		});
		const res = await rpc(store, tok, 'tools/call', {
			name: 'imperium_buscar',
			arguments: { modelo: 'contacto' },
		});
		expect(res.status).toBe(200);
		expect(res.body?.result?.isError).toBe(false);
		const text = res.body?.result?.content?.[0]?.text ?? '';
		expect(text).toContain('Visible');
		expect(text).not.toContain('Oculto');
		expect(text).not.toContain('sekret-mcp');
	});

	test('GET no abre un flujo de servidor y el protocolo responde ping, initialize y el aviso', async () => {
		const tok = token_of('proto');
		const { store } = world(tok);
		const got = await rpc(store, tok, 'ping', {}, { method_http: 'GET' });
		expect(got.status).toBe(405);
		expect(got.headers.get('allow')).toBe('POST');
		const init = await rpc(store, tok, 'initialize', { protocolVersion: '2025-03-26' });
		expect(init.body?.result?.protocolVersion).toBe('2025-03-26');
		expect(init.body?.result?.serverInfo?.name).toBe('imperium');
		expect(init.body?.id).toBe(7);
		const pong = await rpc(store, tok, 'ping');
		expect(pong.body?.result).toEqual({});
		const note = await rpc(store, tok, 'notifications/initialized', {}, {
			raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		});
		expect(note.status).toBe(202);
		expect(note.text).toBe('');
		const missing = await rpc(store, tok, 'resources/list');
		expect(missing.body?.error?.code).toBe(-32601);
	});

	test('sin la puerta MCP la llamada no entra', async () => {
		const tok = token_of('puerta');
		const { store } = world(tok, { gate: false, read_contacto: true });
		const res = await rpc(store, tok, 'tools/list');
		expect(res.status).toBe(403);
		expect(res.body?.error).toBe('mcp_gate_denied');
	});

	test('el esquema de búsqueda solo enumera modelos legibles y el recurso instalado', async () => {
		const tok = token_of('enum');
		const { store } = world(tok, {
			read_contacto: true,
			modules: [
				{ model_id: 'contacto', name: 'Contacto', is_enable: true },
				{ model_id: 'McpAgent', name: 'Agente', is_enable: true },
				{ model_id: 'products', name: 'Productos', is_enable: true },
			],
		});
		const listed = await rpc(store, tok, 'tools/list');
		const buscar = listed.body?.result?.tools?.find((tool) => tool.name === 'imperium_buscar');
		expect(buscar?.inputSchema?.properties?.modelo?.enum).toEqual(['contacto']);
		const off = world(token_of('apagado'), { read_contacto: true, contacto_installed: false });
		const hidden = tool_names((await rpc(off.store, token_of('apagado'), 'tools/list')).body);
		expect(hidden).not.toContain('contactos_buscar');
	});

	test('la cubeta es por token e IP', async () => {
		const tok = token_of('cupo');
		const other = token_of('cupo-b');
		const { store } = world(tok);
		const ip = '203.0.113.50';
		for (let i = 0; i < MCP_RATE.capacity; i++) {
			expect((await rpc(store, tok, 'ping', {}, { ip })).status).toBe(200);
		}
		const blocked = await rpc(store, tok, 'ping', {}, { ip });
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get('retry-after')).toBeTruthy();
		expect((await rpc(store, tok, 'ping', {}, { ip: '203.0.113.51' })).status).toBe(200);
		const second = world(other);
		expect((await rpc(second.store, other, 'ping', {}, { ip })).status).toBe(200);
	});

	test('la bitácora lleva el prefijo del token y no el secreto', async () => {
		const tok = token_of('bitacora');
		const logs: ImperiumDoc[] = [];
		const { store } = world(tok, { logs, read_contacto: true });
		const res = await rpc(store, tok, 'tools/call', {
			name: 'imperium_quien_soy',
			arguments: {},
		});
		expect(res.status).toBe(200);
		const line = String(logs[0]?.message ?? '');
		expect(line).toContain('usuario=u1');
		expect(line).toContain(`token=${tok.slice(0, 12)}`);
		expect(line).toContain('herramienta=imperium_quien_soy');
		expect(line).toContain('resultado=ok');
		expect(line).not.toContain(tok.slice(12));
	});
});
