import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { verify_kirlet_identity } from '@opus-perpetuus/imperium-core-kit';
import { handle_service_plane, service_plane_match } from '../service-plane.ts';
import {
	db_admin_gateway_access,
	db_admin_gateway_actor,
	MANAGER_TECHNICAL_ID,
} from './db-admin.ts';
import { subject_proxy_headers, subject_proxy_response } from './subject-identity.ts';
import { handle_operator_http } from './subject-runtime.ts';
import {
	apply_subject_schema_from_url,
	schema_bundle_mismatch,
} from './subject-schema.ts';
import {
	authorize_subject_plane,
	derive_subject_secret,
	dev_attach_enabled,
	gateway_secret_warnings,
	is_subject_request,
	signing_secret_for,
	subject_secret_mode,
} from './subject-secret.ts';

const MASTER = 'maestro-de-prueba-0123456789';
const POS = 'subject-pos';
const TIENDA = 'subject-tienda';
const CATALOG = new Set([POS, TIENDA, MANAGER_TECHNICAL_ID]);

const ENV_KEYS = [
	'CORE_SUBJECT_GATEWAY_SECRET',
	'CORE_SUBJECT_SECRET_MODE',
	'CORE_SUBJECT_DEV_ATTACH',
] as const;
let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	process.env.CORE_SUBJECT_GATEWAY_SECRET = MASTER;
	delete process.env.CORE_SUBJECT_SECRET_MODE;
	delete process.env.CORE_SUBJECT_DEV_ATTACH;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

function strict() {
	process.env.CORE_SUBJECT_SECRET_MODE = 'strict';
}

function with_secret(secret: string, extra: Record<string, string> = {}): Request {
	return new Request('http://core/x', {
		method: 'POST',
		headers: { 'x-nox-kirlet-gateway-secret': secret, ...extra },
	});
}

const derived = (tid: string, master = MASTER) => derive_subject_secret(master, tid);

describe('plano de datos: authorize_subject_plane', () => {
	test('el derivado de otra app no entra', () => {
		const res = authorize_subject_plane(with_secret(derived(TIENDA)), POS, CATALOG);
		expect(res?.status).toBe(403);
	});

	test('el derivado propio pasa, en compat y en strict', () => {
		expect(authorize_subject_plane(with_secret(derived(POS)), POS, CATALOG)).toBeNull();
		strict();
		expect(authorize_subject_plane(with_secret(derived(POS)), POS, CATALOG)).toBeNull();
	});

	test('también por la cabecera x-core-subject-gateway-secret', () => {
		const req = new Request('http://core/x', {
			method: 'POST',
			headers: { 'x-core-subject-gateway-secret': derived(POS) },
		});
		expect(authorize_subject_plane(req, POS, CATALOG)).toBeNull();
	});

	test('el maestro pasa en compat y en strict da 403', () => {
		expect(authorize_subject_plane(with_secret(MASTER), POS, CATALOG)).toBeNull();
		strict();
		expect(authorize_subject_plane(with_secret(MASTER), POS, CATALOG)?.status).toBe(403);
	});

	test('un tid fuera del catálogo da 404, aunque traiga su derivado o el maestro', () => {
		const fake = 'subject-inventada';
		expect(authorize_subject_plane(with_secret(derived(fake)), fake, CATALOG)?.status).toBe(404);
		expect(authorize_subject_plane(with_secret(MASTER), fake, CATALOG)?.status).toBe(404);
	});

	test('sin maestro se rechaza todo', () => {
		const old_derived = derived(POS);
		process.env.CORE_SUBJECT_GATEWAY_SECRET = '';
		// Con clave vacía el HMAC también da un hex: no debe valer.
		expect(authorize_subject_plane(with_secret(derived(POS, '')), POS, CATALOG)?.status).toBe(403);
		expect(authorize_subject_plane(with_secret(old_derived), POS, CATALOG)?.status).toBe(403);
		expect(authorize_subject_plane(with_secret(''), POS, CATALOG)?.status).toBe(403);
		delete process.env.CORE_SUBJECT_GATEWAY_SECRET;
		expect(authorize_subject_plane(with_secret(derived(POS, '')), POS, CATALOG)?.status).toBe(403);
		expect(signing_secret_for(POS)).toBe('');
		strict();
		expect(signing_secret_for(POS)).toBe('');
	});
});

describe('plano de servicios con el verificador por app', () => {
	const sql = { unsafe: async () => [] } as unknown as Bun.SQL;

	async function svc(secret: string, tid: string): Promise<number> {
		const req = new Request(`http://core/api/kirlets/svc/${tid}/html/to-text`, {
			method: 'POST',
			headers: {
				'x-nox-kirlet-gateway-secret': secret,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ html: '<b>hola</b>' }),
		});
		const res = await handle_service_plane(
			sql,
			is_subject_request,
			req,
			tid,
			'/html/to-text',
			new URL(req.url),
		);
		return res.status;
	}

	test('derivado de otra app → 403, propio → 200', async () => {
		expect(await svc(derived(TIENDA), POS)).toBe(403);
		expect(await svc(derived(POS), POS)).toBe(200);
	});

	test('el maestro solo vale en compat', async () => {
		expect(await svc(MASTER, POS)).toBe(200);
		strict();
		expect(await svc(MASTER, POS)).toBe(403);
	});
});

describe('proxy hacia la app', () => {
	const identity = {
		user_id: 'u1',
		email: 'a@b.co',
		is_admin: true,
		kirlet_id: POS,
		grants: [],
		user_type: 'internal' as const,
		realm: 'internal' as const,
	};

	function record(headers: Headers): Record<string, string> {
		const out: Record<string, string> = {};
		headers.forEach((v, k) => {
			out[k] = v;
		});
		return out;
	}

	test('no reenvía secretos de gateway ni el tid que mandó el cliente', () => {
		const headers = subject_proxy_headers(
			{
				'x-core-subject-gateway-secret': MASTER,
				'x-nox-kirlet-gateway-secret': MASTER,
				'x-nox-kirlet-id': TIENDA,
				cookie: 'connect.sid=abc',
			},
			POS,
			identity,
		);
		expect(headers.get('x-core-subject-gateway-secret')).toBeNull();
		expect(headers.get('x-nox-kirlet-gateway-secret')).toBeNull();
		expect(headers.get('x-nox-kirlet-id')).toBe(POS);
		expect(headers.get('cookie')).toBeNull();
	});

	test('no reenvía la sesión del núcleo ni su token MCP; las demás cookies pasan', () => {
		const headers = subject_proxy_headers(
			{
				cookie: 'carrito=7; connect.sid=s%3Aabc.def;tema=oscuro; a=connect.sid=x',
				authorization: 'Bearer token-mcp',
				'x-imperium-sic-token': 'token-mcp',
				accept: 'application/json',
			},
			POS,
			identity,
		);
		expect(headers.get('cookie')).toBe('carrito=7; tema=oscuro; a=connect.sid=x');
		expect(headers.get('authorization')).toBeNull();
		expect(headers.get('x-imperium-sic-token')).toBeNull();
		expect(headers.get('accept')).toBe('application/json');
	});

	test('sin cookie de sesión la cabecera cookie llega igual', () => {
		const headers = subject_proxy_headers({ cookie: 'carrito=7' }, POS, identity);
		expect(headers.get('cookie')).toBe('carrito=7');
	});

	test('la respuesta de la app no puede fijar la sesión del núcleo', async () => {
		const headers = new Headers({ 'content-type': 'application/json' });
		headers.append('set-cookie', 'connect.sid=robada; Path=/; HttpOnly');
		headers.append('set-cookie', 'carrito=7; Path=/');
		const res = subject_proxy_response(new Response('{"ok":1}', { status: 201, headers }));
		expect(res.status).toBe(201);
		expect(res.headers.getSetCookie()).toEqual(['carrito=7; Path=/']);
		expect(await res.text()).toBe('{"ok":1}');
		const plain = new Response('x', { headers: { 'set-cookie': 'carrito=7' } });
		expect(subject_proxy_response(plain)).toBe(plain);
	});

	test('en compat firma con el maestro', () => {
		const headers = record(subject_proxy_headers({}, POS, identity));
		expect(verify_kirlet_identity(headers, MASTER).ok).toBe(true);
		expect(verify_kirlet_identity(headers, derived(POS)).ok).toBe(false);
	});

	test('en strict firma con el derivado de esa app', () => {
		strict();
		const headers = record(subject_proxy_headers({}, POS, identity));
		expect(verify_kirlet_identity(headers, derived(POS)).ok).toBe(true);
		expect(verify_kirlet_identity(headers, MASTER).ok).toBe(false);
		expect(verify_kirlet_identity(headers, derived(TIENDA)).ok).toBe(false);
	});

	test('sin maestro no queda identidad firmada', () => {
		process.env.CORE_SUBJECT_GATEWAY_SECRET = '';
		const headers = subject_proxy_headers({ 'x-nox-is-admin': 'true' }, POS, identity);
		expect(headers.get('x-nox-identity-sig')).toBeNull();
		expect(headers.get('x-nox-is-admin')).toBeNull();
	});
});

describe('install-schemas valida el technicalId del bundle', () => {
	const bundle_of = (technicalId: string) => ({ technicalId, version: 3, tables: [] });

	test('schema_bundle_mismatch', () => {
		expect(schema_bundle_mismatch(bundle_of(POS), POS)).toBeNull();
		expect(schema_bundle_mismatch(bundle_of(TIENDA), POS)).toContain(TIENDA);
		expect(
			schema_bundle_mismatch({} as unknown as ReturnType<typeof bundle_of>, POS),
		).toContain('sin technicalId');
	});

	let served = bundle_of(TIENDA);
	const app = Bun.serve({
		port: 0,
		fetch: (req) =>
			new URL(req.url).pathname === '/schema'
				? Response.json(served)
				: new Response('no', { status: 404 }),
	});
	afterAll(() => app.stop(true));

	function spy_sql() {
		const calls: Array<{ text: string; params?: unknown[] }> = [];
		const sql = {
			unsafe: async (text: string, params?: unknown[]) => {
				calls.push({ text, params });
				return [];
			},
		} as unknown as Bun.SQL;
		return { sql, calls };
	}

	test('un bundle de otra app no aplica DDL ni se reintenta', async () => {
		served = bundle_of(TIENDA);
		const { sql, calls } = spy_sql();
		const started = Date.now();
		const out = await apply_subject_schema_from_url(sql, POS, `http://127.0.0.1:${app.port}`);
		expect(out.ok).toBe(false);
		expect(out.error).toContain(TIENDA);
		expect(calls).toEqual([]);
		expect(Date.now() - started).toBeLessThan(900);
	});

	test('el bundle propio se aplica y tables va como arreglo, no como texto JSON', async () => {
		served = bundle_of(POS);
		const { sql, calls } = spy_sql();
		const out = await apply_subject_schema_from_url(sql, POS, `http://127.0.0.1:${app.port}`);
		expect(out.ok).toBe(true);
		const insert = calls.find((c) => c.text.includes('INSERT INTO public.subject_schema_versions'));
		expect(insert?.params).toEqual([POS, 3, []]);
		expect(Array.isArray(insert?.params?.[2])).toBe(true);
	});
});

describe('db-admin', () => {
	const req = (secret: string, claim?: string) =>
		with_secret(secret, claim ? { 'x-imperium-subject': claim } : {});

	test('el derivado del gestor reclamando al gestor pasa, también en strict', () => {
		expect(db_admin_gateway_access(req(derived(MANAGER_TECHNICAL_ID), MANAGER_TECHNICAL_ID))).toBe('manager');
		strict();
		expect(db_admin_gateway_access(req(derived(MANAGER_TECHNICAL_ID), MANAGER_TECHNICAL_ID))).toBe('manager');
	});

	test('también con x-nox-kirlet-technical-id', () => {
		const r = with_secret(derived(MANAGER_TECHNICAL_ID), {
			'x-nox-kirlet-technical-id': MANAGER_TECHNICAL_ID,
		});
		expect(db_admin_gateway_access(r)).toBe('manager');
	});

	test('el derivado de otra app reclamando al gestor → 403', () => {
		expect(db_admin_gateway_access(req(derived(TIENDA), MANAGER_TECHNICAL_ID))).toBe('forbidden');
	});

	test('tid falso: el derivado del gestor reclamando otra app, o una app reclamándose a sí misma → 403', () => {
		expect(db_admin_gateway_access(req(derived(MANAGER_TECHNICAL_ID), TIENDA))).toBe('forbidden');
		expect(db_admin_gateway_access(req(derived(TIENDA), TIENDA))).toBe('forbidden');
		expect(db_admin_gateway_access(req(derived(MANAGER_TECHNICAL_ID)))).toBe('forbidden');
	});

	test('el maestro vale en cualquier modo (herramientas del host)', () => {
		expect(db_admin_gateway_access(req(MASTER))).toBe('master');
		strict();
		expect(db_admin_gateway_access(req(MASTER))).toBe('master');
	});

	test('auditoría: el maestro sin reclamar al gestor no se registra como el gestor', () => {
		const host = db_admin_gateway_actor(req(MASTER), '10.0.0.9');
		expect(host).toEqual({
			id: 'gateway-master',
			label: 'Herramienta del servidor (maestro)',
			origin: 'app',
			source_ip: '10.0.0.9',
		});
		expect(db_admin_gateway_actor(req(MASTER, TIENDA), null).id).toBe('gateway-master');
		const src = readFileSync(new URL('./db-admin.ts', import.meta.url), 'utf8');
		expect(src).toContain('actor: db_admin_gateway_actor(req, source_ip)');
		expect(src.match(/Gestor de base de datos \(programado\)/g)?.length).toBe(1);
	});

	test('auditoría: el gestor, con su derivado o con el maestro en compat, sigue siendo el gestor', () => {
		for (const secret of [derived(MANAGER_TECHNICAL_ID), MASTER]) {
			const actor = db_admin_gateway_actor(req(secret, MANAGER_TECHNICAL_ID), null);
			expect(actor.id).toBe(MANAGER_TECHNICAL_ID);
			expect(actor.label).toBe('Gestor de base de datos (programado)');
		}
	});

	test('sin secreto no hay credencial de gateway; sin maestro nada vale', () => {
		expect(db_admin_gateway_access(new Request('http://core/x'))).toBeNull();
		process.env.CORE_SUBJECT_GATEWAY_SECRET = '';
		expect(
			db_admin_gateway_access(req(derived(MANAGER_TECHNICAL_ID, ''), MANAGER_TECHNICAL_ID)),
		).toBe('forbidden');
	});
});

describe('operador: solo el maestro', () => {
	// Una ruta desconocida: pasa el candado y responde 404 sin tocar Docker.
	const call = (secret: string) =>
		handle_operator_http(
			new Request('http://operator/runtime/pos/desconocida', {
				headers: { 'x-core-subject-gateway-secret': secret },
			}),
		);

	test('el derivado de una app → 403, el maestro pasa el candado', async () => {
		expect((await call(derived(POS))).status).toBe(403);
		expect((await call(MASTER)).status).toBe(404);
	});

	test('sin maestro → 403', async () => {
		process.env.CORE_SUBJECT_GATEWAY_SECRET = '';
		expect((await call('')).status).toBe(403);
	});
});

/** Lo que imprime el operador hasta que escucha; se le mata enseguida. */
async function operator_boot_log(master: string): Promise<string> {
	const proc = Bun.spawn([process.execPath, 'src/subject-operator.ts'], {
		cwd: new URL('../..', import.meta.url).pathname,
		env: { ...process.env, SUBJECT_OPERATOR_PORT: '0', CORE_SUBJECT_GATEWAY_SECRET: master },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let out = '';
	try {
		while (!out.includes('listening')) {
			const { value, done } = await reader.read();
			if (done) break;
			out += decoder.decode(value);
		}
	} finally {
		proc.kill();
		await proc.exited;
	}
	return out;
}

describe('arranque y dev-attach', () => {
	test('el operador avisa al arrancar si falta el maestro', async () => {
		const without = await operator_boot_log('');
		expect(without).toContain('subject-operator listening');
		expect(without).toContain('CORE_SUBJECT_GATEWAY_SECRET no está definido');
		const with_master = await operator_boot_log(MASTER);
		expect(with_master).toContain('subject-operator listening');
		expect(with_master).not.toContain('CORE_SUBJECT_GATEWAY_SECRET');
	}, 60_000);

	test('dev-attach solo con CORE_SUBJECT_DEV_ATTACH=1', () => {
		expect(dev_attach_enabled()).toBe(false);
		process.env.CORE_SUBJECT_DEV_ATTACH = 'true';
		expect(dev_attach_enabled()).toBe(false);
		process.env.CORE_SUBJECT_DEV_ATTACH = '1';
		expect(dev_attach_enabled()).toBe(true);
	});

	test('avisos: sin maestro, compat y strict', () => {
		process.env.CORE_SUBJECT_GATEWAY_SECRET = '';
		expect(gateway_secret_warnings().join(' ')).toContain('no está definido');
		process.env.CORE_SUBJECT_GATEWAY_SECRET = MASTER;
		expect(gateway_secret_warnings().join(' ')).toContain('compat');
		strict();
		expect(gateway_secret_warnings()).toEqual([]);
	});

	test('un modo mal escrito avisa de que cae en compat', () => {
		process.env.CORE_SUBJECT_SECRET_MODE = 'strcit';
		expect(is_subject_request(with_secret(MASTER), POS)).toBe(true);
		const warnings = gateway_secret_warnings().join(' ');
		expect(warnings).toContain('"strcit" no se reconoce');
		expect(warnings).toContain('compat');
	});
});

describe('server.ts: cableado', () => {
	const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
	const between = (from: string, to: string) => {
		const start = src.indexOf(from);
		expect(start).toBeGreaterThan(0);
		return src.slice(start, src.indexOf(to, start));
	};

	test('un tid mal codificado es 404, no 500: se decodifica dentro de un try', () => {
		const bad = '%E0%A4%A';
		expect(() => decodeURIComponent(bad)).toThrow();
		expect(() => service_plane_match(`/api/kirlets/svc/${bad}/html/to-text`)).toThrow();
		expect(authorize_subject_plane(with_secret(MASTER), '', CATALOG)?.status).toBe(404);

		const svc = between('let svc: ReturnType<typeof service_plane_match> = null;', 'if (svc) {');
		expect(svc).toMatch(/try \{\s*svc = service_plane_match\(path\);\s*\} catch \{/);
		expect(svc).toContain('status: 404');
		const data = between("let technical_id = '';", 'if (denied) return denied;');
		expect(data).toMatch(/try \{\s*technical_id = decodeURIComponent\(data_m\[1\]!\);\s*\} catch/);
		expect(data).toContain('authorize_subject_plane(');
	});

	test('install-schemas: maestro o administrador, como las mutaciones de /subjects', () => {
		const gate = between("path === '/api/subjects/install-schemas'", 'const only =');
		expect(gate).toContain('if (!is_master_request(req)) {');
		expect(gate).toContain('await ensure_session_table(sql);');
		expect(gate).toContain('subjects_access_denied(req.method, actor, false)');
		expect(gate).not.toContain('can_enter_internal');
		expect(src).not.toContain('subject_gateway_ok');
		expect(src).toMatch(/is_master_request,[^}]*\} from '.\/imperium\/subject-secret.ts'/);
	});

	test('un rechazo o una excepción sin atender se registran y no tumban el núcleo', () => {
		const rejection = between("process.on('unhandledRejection'", 'const sql = open_core_sql');
		expect(rejection).toContain("print_console_log('error'");
		expect(rejection).not.toContain('process.exit');
		expect(src.indexOf("process.on('unhandledRejection'")).toBeLessThan(
			src.indexOf('create_imperium_layer(sql)'),
		);
		const exception = between("process.on('uncaughtException'", 'start_subject_auto_update(');
		expect(exception).toContain("print_console_log('error'");
		expect(exception).not.toContain('process.exit');
	});

	test('un fallo de arranque sigue tumbando el proceso: uncaughtException va tras escuchar', () => {
		// Registrada antes de `Bun.serve`, un puerto ocupado dejaba el núcleo
		// vivo sin servir y salía con 0.
		expect(src.indexOf("process.on('uncaughtException'")).toBeGreaterThan(
			src.indexOf('imperium-core listening on'),
		);
	});

	test('una página pública con el id mal codificado se sirve sin vestir, no 500', () => {
		const dress = between('async function dress_public_page(', 'let override');
		expect(dress).toMatch(/try \{\s*page_id = decodeURIComponent\(page\[1\]!\);\s*\} catch \{\s*return res;/);
	});

	test('/health dice el modo del secreto y nada del secreto', () => {
		const health = between("path === '/health'", 'dev-attach');
		expect(health).toContain('secret_mode: subject_secret_mode()');
		expect(health).not.toMatch(/master_secret|signing_secret_for|derive_subject_secret|GATEWAY_SECRET/);
		expect(subject_secret_mode()).toBe('compat');
		strict();
		expect(subject_secret_mode()).toBe('strict');
	});
});
