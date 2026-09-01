/**
 * Contrato que el Angular real consume. Arranca el layer que monta :3100
 * (`create_imperium_layer`) y compara status + forma con el backend original.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { create_imperium_layer } from './router.ts';

const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';
const EMAIL = process.env.E2E_EMAIL ?? 'admin@admin.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'lr92*JCaa';

const sql = new Bun.SQL(DATABASE_URL);
const layer = create_imperium_layer(sql);

afterAll(async () => {
	await sql.close();
});

type Call = {
	status: number;
	json: Record<string, unknown> | null;
	text: string;
	set_cookie: string | null;
};

async function call(
	method: string,
	api_path: string,
	opts?: { body?: unknown; cookie?: string },
): Promise<Call> {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (opts?.cookie) headers.cookie = opts.cookie;
	if (opts?.body !== undefined) headers['content-type'] = 'application/json';
	const req = new Request(`http://imperium.test/api${api_path}`, {
		method,
		headers,
		body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
	});
	const res = await layer.handle(req);
	if (!res) throw new Error(`null response for ${method} ${api_path}`);
	const text = await res.text();
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* raw */
	}
	return {
		status: res.status,
		json,
		text,
		set_cookie: res.headers.get('set-cookie'),
	};
}

async function wait_subject(
	cookie: string,
	technical_id: string,
	pred: (row: Record<string, unknown>) => boolean,
	timeout_ms = 15_000,
) {
	const start = Date.now();
	while (Date.now() - start < timeout_ms) {
		const listed = await call('GET', '/subjects', { cookie });
		const subjects = (listed.json?.data as Record<string, unknown>[]) ?? [];
		const row = subjects.find((item) => item.technical_id === technical_id);
		if (row && pred(row)) return row;
		await Bun.sleep(50);
	}
	throw new Error(`timeout waiting for ${technical_id}`);
}

function sid_from(set_cookie: string | null): string {
	const m = String(set_cookie ?? '').match(/connect\.sid=([^;]+)/);
	if (!m) throw new Error(`no session cookie: ${set_cookie}`);
	return `connect.sid=${m[1]}`;
}

function secret_keys(obj: Record<string, unknown> | null): string[] {
	if (!obj) return [];
	return [
		'password',
		'reset_password_token_hash',
		'reset_password_expires',
		'reset_password_kind',
		'recovery_token',
		'recovery_expires',
	].filter((k) => k in obj && obj[k] != null && obj[k] !== '');
}

describe('front-used Imperium contract via shipped create_imperium_layer', () => {
	test('GET /auth without session is 401 JSON, not 500 HTML', async () => {
		const r = await call('GET', '/auth');
		expect(r.status).toBe(401);
		expect(String(r.text ?? '').toLowerCase()).not.toContain('<!doctype');
		expect(String(r.json?.message ?? r.json?.error ?? '')).toContain(
			'autenticado',
		);
	});

	test('GET /auth/branding is public and uses the original list envelope', async () => {
		const r = await call('GET', '/auth/branding');
		expect(r.status).toBe(200);
		expect(r.json).not.toBeNull();
		expect(Array.isArray(r.json?.data)).toBe(true);
		expect(typeof r.json?.total_elementos).toBe('number');
		const row = (r.json?.data as Record<string, unknown>[])[0];
		expect(row).toBeTruthy();
		expect('branding_mode' in (row ?? {})).toBe(true);
		expect('company_logo' in (row ?? {})).toBe(true);
	});

	test('POST /auth/login returns user._id, L1 menus only for installed subjects, no recovery hashes', async () => {
		const r = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		expect(r.status).toBe(200);
		const user = r.json?.user as Record<string, unknown> | undefined;
		const menus = r.json?.menus as Record<string, unknown>[] | undefined;
		expect(user).toBeTruthy();
		expect(String(user?._id ?? '')).not.toBe('');
		expect(secret_keys(user ?? null)).toEqual([]);
		expect(Array.isArray(menus)).toBe(true);
		const cookie = sid_from(r.set_cookie);
		const catalog = await call('GET', '/subjects', { cookie });
		const subjects =
			(catalog.json?.data as Record<string, unknown>[]) ?? [];
		const installed_names = new Set(
			subjects
				.filter((s) => s.installed)
				.map((s) => String(s.name ?? '')),
		);
		const tops = (menus ?? []).filter((m) => !m.parent_id);
		expect(tops.length).toBe(installed_names.size);
		for (const name of tops.map((m) => String(m.name ?? ''))) {
			expect(installed_names.has(name)).toBe(true);
		}
		expect(r.json).toHaveProperty('access_rights');
		expect(sid_from(r.set_cookie).startsWith('connect.sid=')).toBe(true);
		const models = ((r.json?.access_rights as Record<string, unknown>)
			?.models ?? []) as string[];
		// El dashboard (`is_model_available('Pedidos')`) usa nombres mongoose,
		// no slugs kebab del catálogo modular.
		for (const name of [
			'Pedidos',
			'PosSession',
			'Products',
			'Ticket',
			'MisTareas',
			'Proyectos',
		]) {
			expect(models).toContain(name);
		}
		expect(models.includes('pedidos')).toBe(false);
		const paths = (menus ?? []).map((m) =>
			String(m.path ?? '').replace(/\/+$/, ''),
		);
		expect(paths.includes('/model-tracker')).toBe(false);
		expect(
			(menus ?? []).some(
				(m) =>
					String(m._ref ?? '') === 'model-tracker-menu-management-0',
			),
		).toBe(false);
	});

	test('GET /auth (session) is the original public user, not hashes', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('GET', '/auth', { cookie });
		expect(r.status).toBe(200);
		expect(String(r.json?._id ?? '')).not.toBe('');
		expect(secret_keys(r.json)).toEqual([]);
	});

	test('GET /user?limite=1 list envelope matches original (_id, data, total)', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('GET', '/user?limite=1', { cookie });
		expect(r.status).toBe(200);
		expect(Array.isArray(r.json?.data)).toBe(true);
		expect(typeof r.json?.total_elementos).toBe('number');
		const row = (r.json?.data as Record<string, unknown>[])[0];
		expect(row).toBeTruthy();
		expect(String(row?._id ?? '')).not.toBe('');
	});

	test('GET /notifications/my-notifications is the original session extra, not 404', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('GET', '/notifications/my-notifications', {
			cookie,
		});
		expect(r.status).not.toBe(404);
		expect(r.status).toBe(200);
	});

	test('GET reports-pdf-setting/:id is public like the original (list stays 403)', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const listed = await call('GET', '/reports-pdf-setting?limite=1', {
			cookie,
		});
		expect([200, 403]).toContain(listed.status);
		const anon_list = await call('GET', '/reports-pdf-setting?limite=1');
		expect(anon_list.status).toBe(403);
		const row = (
			listed.json?.data as Record<string, unknown>[] | undefined
		)?.[0];
		if (!row?._id) return;
		const anon = await call('GET', `/reports-pdf-setting/${row._id}`);
		expect(anon.status).toBe(200);
	});

	test('GET /subjects lists catalog L1; uninstall/install mutates menus', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const listed = await call('GET', '/subjects', { cookie });
		expect(listed.status).toBe(200);
		const subjects = (listed.json?.data as Record<string, unknown>[]) ?? [];
		expect(subjects.length).toBe(20);
		const turnos = subjects.find(
			(s) => s.technical_id === 'subject-turnos',
		);
		expect(turnos).toBeTruthy();
		expect(typeof turnos?.installed).toBe('boolean');
		const vista_install = await call(
			'POST',
			'/subjects/subject-configuraciones-de-vista/install',
			{ cookie, body: {} },
		);
		expect([200, 202]).toContain(vista_install.status);
		expect(vista_install.json?.accepted).toBe(true);
		await wait_subject(
			cookie,
			'subject-configuraciones-de-vista',
			(row) => row.installed === true && row.busy !== true,
		);
		const vista_detail = await call(
			'GET',
			'/subjects/subject-configuraciones-de-vista',
			{ cookie },
		);
		expect(vista_detail.status).toBe(200);
		const vista_info = vista_detail.json?.data as Record<string, unknown>;
		expect(vista_info?.installed).toBe(true);
		expect(vista_info).toHaveProperty('permissions');
		expect(vista_info).toHaveProperty('menus');
		expect(vista_info).toHaveProperty('collections');
		expect(vista_info).toHaveProperty('health');
		expect(vista_info).toHaveProperty('version');
		expect(vista_info).toHaveProperty('data_bytes');
		expect(vista_info).toHaveProperty('install_bytes');
		expect(vista_info).toHaveProperty('status');
		const off = await call('POST', '/subjects/subject-turnos/uninstall', {
			cookie,
			body: {},
		});
		expect([200, 202]).toContain(off.status);
		await wait_subject(
			cookie,
			'subject-turnos',
			(row) => row.installed === false && row.status !== 'uninstalling',
		);
		const after_off = await call('GET', '/auth/menus', { cookie });
		expect(after_off.status).toBe(200);
		const menus_off =
			(after_off.json?.menus as Record<string, unknown>[]) ?? [];
		const l1_off = menus_off
			.filter((m) => !m.parent_id)
			.map((m) => String(m.name ?? ''));
		expect(l1_off.includes('Turnos')).toBe(false);
		const blocked = await call('GET', '/ticketing-system-turn?limite=1', {
			cookie,
		});
		expect(blocked.status).toBe(404);
		expect(blocked.json?.code).toBe('subject_not_installed');
		expect(
			(blocked.json?.details as { slug?: string } | undefined)?.slug,
		).toBe('turnos');
		const models = ((
			after_off.json?.access_rights as Record<string, unknown>
		)?.models ?? []) as string[];
		expect(models).toContain('Pedidos');
		const on = await call('POST', '/subjects/subject-turnos/install', {
			cookie,
			body: {},
		});
		expect([200, 202]).toContain(on.status);
		await wait_subject(
			cookie,
			'subject-turnos',
			(row) => row.installed === true && row.busy !== true,
		);
		const notes = await call('GET', '/notifications/my-summary', { cookie });
		const unread =
			(
				(notes.json?.data as Array<{ unread_notifications?: Array<Record<string, unknown>> }>) ??
				[]
			)[0]?.unread_notifications ?? [];
		expect(
			unread.some(
				(item) =>
					item.type === 'background_job' ||
					(item.payload as { kind?: string } | undefined)?.kind ===
						'background_job',
			),
		).toBe(true);
		const after_on = await call('GET', '/auth/menus', { cookie });
		expect(after_on.status).toBe(200);
		const l1_on = (
			(after_on.json?.menus as Record<string, unknown>[]) ?? []
		)
			.filter((m) => !m.parent_id)
			.map((m) => String(m.name ?? ''));
		expect(l1_on.includes('Turnos')).toBe(true);
		const allowed = await call('GET', '/ticketing-system-turn?limite=1', {
			cookie,
		});
		expect(allowed.status).not.toBe(404);
	});

	test('GET /products schema uses catalog checkbox/number widgets; user list partial search', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const products = await call('GET', '/products?limite=1', { cookie });
		expect(products.status).toBe(200);
		const props = (
			products.json?.schema_validation as {
				properties?: Record<
					string,
					{ type?: string; 'x-component'?: string }
				>;
			}
		)?.properties;
		expect(props?.puedoProducirlo?.type).toBe('boolean');
		expect(props?.puedoProducirlo?.['x-component']).toBe('input-checkbox');
		const users = await call('GET', '/user?termino=adm&limite=25', {
			cookie,
		});
		expect(users.status).toBe(200);
		expect(Array.isArray(users.json?.data)).toBe(true);
		expect(Number(users.json?.total_elementos ?? 0)).toBeGreaterThan(0);
	});
});
