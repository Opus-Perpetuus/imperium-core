import { afterAll, describe, expect, test } from 'bun:test';
import { create_imperium_layer } from './router.ts';
import { apply_odoo_image_sources } from './subject-image-sources.ts';
import { list_catalog_subjects } from './subjects-admin.ts';
import type { ImperiumStore } from './store.ts';

/**
 * El ciclo de vida, si el candado fallara, no debe hablar con Docker.
 * El proceso de este archivo restaura el valor al terminar.
 */
const previous_runtime = process.env.SUBJECT_RUNTIME;
process.env.SUBJECT_RUNTIME = 'off';
const previous_master = process.env.CORE_SUBJECT_GATEWAY_SECRET;
if (!previous_master?.trim()) process.env.CORE_SUBJECT_GATEWAY_SECRET = 'maestro-de-prueba';

afterAll(() => {
	if (previous_runtime == null) delete process.env.SUBJECT_RUNTIME;
	else process.env.SUBJECT_RUNTIME = previous_runtime;
	if (previous_master == null) delete process.env.CORE_SUBJECT_GATEWAY_SECRET;
	else process.env.CORE_SUBJECT_GATEWAY_SECRET = previous_master;
});

const SEEN = 'subject-escaneo-solo';
const STALE = 'subject-pagos';
const ADMIN = {
	_id: 'admin-catalogo',
	_ref: 'user-menu-management-0',
	email: 'admin@admin.com',
	type: 'internal',
	is_active: true,
};
const USER = {
	_id: 'usuario-catalogo',
	_ref: 'user-empleado-1',
	email: 'usuario@admin.com',
	type: 'internal',
	is_active: true,
};

type CatalogRow = {
	technical_id: string;
	slug: string;
	name: string;
	image: string | null;
	repo: string | null;
	source: string;
	created_at: string;
	updated_at: string;
};

type InstallRow = {
	technical_id: string;
	installed: boolean;
	status: string;
	installed_at: null;
	uninstalled_at: null;
	version: null;
	installed_image: null;
	discovered_image: null;
	discovered_created_at: null;
	discovered_note: null;
	last_error: null;
	last_error_at: null;
};

function authorizes(query: string, source: string): boolean {
	const restricts =
		query.includes("'odoo'") ||
		query.includes("'manual'") ||
		query.includes("'registry'");
	if (!restricts) return true;
	if (query.includes("<> 'registry'") || query.includes("!= 'registry'")) {
		return source !== 'registry';
	}
	const named = ['odoo', 'manual', 'registry'].filter((item) => query.includes(`'${item}'`));
	if (query.includes('NOT IN') || query.includes('!=')) {
		return !named.includes(source);
	}
	return named.includes(source);
}

function harness() {
	const catalog = new Map<string, CatalogRow>();
	const installs = new Map<string, InstallRow>();
	const sessions = new Map<string, { payload: unknown; exp: number }>([
		['admin-catalogo', { payload: ADMIN, exp: Date.now() + 3_600_000 }],
		['usuario-catalogo', { payload: USER, exp: Date.now() + 3_600_000 }],
	]);
	const sql = {
		async unsafe(query: string, params: unknown[] = []) {
			if (query.includes('imperium_sessions')) {
				const row = sessions.get(String(params[0] ?? ''));
				return row ? [row] : [];
			}
			if (query.includes('INSERT INTO public.subject_catalog')) {
				const [technical_id, slug, name, image, repo, source] = params as string[];
				const prev = catalog.get(technical_id!);
				catalog.set(technical_id!, {
					technical_id: technical_id!,
					slug: slug!,
					name: name!,
					image: image ?? null,
					repo: repo ?? prev?.repo ?? null,
					source: source!,
					created_at: prev?.created_at ?? 'hoy',
					updated_at: 'hoy',
				});
				return [];
			}
			if (query.includes('subject_catalog') && query.includes('DELETE') && query.includes("source = 'odoo'")) {
				const keep = new Set((params[0] as string[]) ?? []);
				const gone = [...catalog.values()].filter(
					(row) => row.source === 'odoo' && !keep.has(row.slug),
				);
				for (const row of gone) catalog.delete(row.technical_id);
				return gone.map((row) => ({ slug: row.slug }));
			}
			if (query.includes('subject_catalog') && query.includes('DELETE')) {
				catalog.delete(String(params[0]));
				return [];
			}
			if (query.includes('SELECT source') && query.includes('subject_catalog')) {
				const row = catalog.get(String(params[0]));
				return row ? [{ source: row.source }] : [];
			}
			if (query.includes('SELECT 1') && query.includes('subject_catalog')) {
				const row = catalog.get(String(params[0]));
				if (!row || !authorizes(query, row.source)) return [];
				return [{ ok: 1 }];
			}
			if (query.includes('SELECT technical_id') && query.includes('subject_catalog')) {
				return [...catalog.values()];
			}
			if (query.includes('INSERT INTO public.subject_installs')) {
				const technical_id = String(params[0]);
				const installed = /VALUES\s*\(\$1,\s*TRUE/i.test(query);
				installs.set(technical_id, {
					technical_id,
					installed,
					status: String(params[2] ?? (installed ? 'installed' : 'not_installed')),
					installed_at: null,
					uninstalled_at: null,
					version: null,
					installed_image: null,
					discovered_image: null,
					discovered_created_at: null,
					discovered_note: null,
					last_error: null,
					last_error_at: null,
				});
				return [];
			}
			if (query.includes('public.subject_installs')) return [...installs.values()];
			return [];
		},
	} as unknown as Bun.SQL;
	const layer = create_imperium_layer(sql);
	layer.store.scan = async function* () {} as ImperiumStore['scan'];
	return { layer, sql, catalog };
}

function index_html(names: readonly string[]): string {
	return `<html>${names
		.map((name) => `<a href="/orgs/Opus-Perpetuus/packages/container/package/${name}">${name}</a>`)
		.join('')}</html>`;
}

function registry_client(names: readonly string[], calls: string[]) {
	return async (input: { url: string }) => {
		calls.push(input.url);
		if (input.url.includes('github.com/orgs/') && input.url.includes('packages')) {
			const org = input.url.includes('opus-perpetuus') ? names : [];
			return { status: 200, body: index_html(org) };
		}
		if (input.url.includes('/token?')) return { status: 200, body: { token: 'anon-registry' } };
		if (input.url.includes('/tags/list')) return { status: 200, body: { tags: ['1.2.3'] } };
		return { status: 404, body: '' };
	};
}

async function call(
	layer: ReturnType<typeof create_imperium_layer>,
	method: string,
	path: string,
	opts?: { cookie?: string; body?: unknown; master?: boolean },
) {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (opts?.cookie) headers.cookie = `connect.sid=${opts.cookie}`;
	if (opts?.master) {
		headers['x-core-subject-gateway-secret'] = String(process.env.CORE_SUBJECT_GATEWAY_SECRET);
	}
	if (opts?.body !== undefined) headers['content-type'] = 'application/json';
	const res = await layer.handle(
		new Request(`http://imperium.test/api${path}`, {
			method,
			headers,
			body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
		}),
	);
	const text = await res!.text();
	return { status: res!.status, json: JSON.parse(text) as Record<string, unknown> };
}

describe('el escaneo no autoriza instalar', () => {
	test('una app que solo vio el registro sigue en subject_not_authorized', async () => {
		const { layer, sql, catalog } = harness();
		apply_odoo_image_sources('');
		const calls: string[] = [];
		const rows = await list_catalog_subjects(layer.store, sql, {
			cache: false,
			client: registry_client([SEEN], calls),
		});
		expect(calls.some((url) => url.includes('subject-escaneo-solo'))).toBe(true);
		expect(rows.some((row) => row.technical_id === SEEN)).toBe(false);
		expect(rows.find((row) => row.technical_id === STALE)?.catalog_source).not.toBe('registry');
		catalog.set(STALE, {
			technical_id: STALE,
			slug: 'pagos',
			name: 'Pagos',
			image: 'ghcr.io/opus-perpetuus/subject-pagos:1.2.3',
			repo: null,
			source: 'registry',
			created_at: 'hoy',
			updated_at: 'hoy',
		});
		const listed = await list_catalog_subjects(layer.store, sql);
		expect(listed.some((row) => row.technical_id === SEEN)).toBe(false);
		expect(listed.some((row) => row.technical_id === STALE)).toBe(false);
		const seen = await call(layer, 'POST', `/subjects/${SEEN}/install`, {
			cookie: 'admin-catalogo',
			body: {},
		});
		expect(seen.status).toBe(403);
		expect(seen.json.code).toBe('subject_not_authorized');
		const stale = await call(layer, 'POST', `/subjects/${STALE}/install`, {
			cookie: 'admin-catalogo',
			body: {},
		});
		expect(stale.status).toBe(403);
		expect(stale.json.code).toBe('subject_not_authorized');
	}, 20_000);

	test('revocar en Odoo gana al escaneo; lo manual y lo que sigue en Odoo se quedan', async () => {
		const { layer, sql, catalog } = harness();
		apply_odoo_image_sources('');
		const granted = await call(layer, 'PUT', '/subjects/catalog/authorized', {
			master: true,
			body: { slugs: ['pos', 'turnos'] },
		});
		expect(granted.status).toBe(200);
		const manual = await call(layer, 'POST', '/subjects/catalog', {
			cookie: 'admin-catalogo',
			body: { slug: 'rh' },
		});
		expect(manual.status).toBe(201);
		const revoked = await call(layer, 'PUT', '/subjects/catalog/authorized', {
			master: true,
			body: { slugs: ['turnos'] },
		});
		expect(revoked.status).toBe(200);
		const calls: string[] = [];
		await list_catalog_subjects(layer.store, sql, {
			cache: false,
			client: registry_client(['subject-pos', 'subject-turnos', 'subject-rh', SEEN], calls),
		});
		expect(catalog.get('subject-pos')?.source).not.toBe('registry');
		expect(catalog.get('subject-rh')?.source).toBe('manual');
		expect(catalog.get('subject-turnos')).toMatchObject({ source: 'odoo' });
		expect(catalog.get('subject-turnos')?.image).toBe('ghcr.io/opus-perpetuus/subject-turnos:1.2.3');
		const pos = await call(layer, 'POST', '/subjects/subject-pos/install', {
			cookie: 'admin-catalogo',
			body: {},
		});
		expect(pos.status).toBe(403);
		expect(pos.json.code).toBe('subject_not_authorized');
		const rh = await call(layer, 'POST', '/subjects/subject-rh/install', {
			cookie: 'admin-catalogo',
			body: {},
		});
		expect(rh.json.code).not.toBe('subject_not_authorized');
		const turnos = await call(layer, 'POST', '/subjects/subject-turnos/install', {
			cookie: 'admin-catalogo',
			body: {},
		});
		expect(turnos.json.code).not.toBe('subject_not_authorized');
		expect(catalog.get('subject-rh')?.source).toBe('manual');
		expect(catalog.get('subject-turnos')?.source).toBe('odoo');
	}, 20_000);

	test('GET /subjects no llama al registro ni escribe el catálogo', async () => {
		const { layer, catalog } = harness();
		apply_odoo_image_sources('');
		const calls: string[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url.includes('github.com/orgs/')) {
				return new Response(index_html([SEEN]), { status: 200 });
			}
			if (url.includes('/token?')) {
				return new Response(JSON.stringify({ token: 'anon-registry' }), { status: 200 });
			}
			if (url.includes('/tags/list')) {
				return new Response(JSON.stringify({ tags: ['1.2.3'] }), { status: 200 });
			}
			return new Response('', { status: 404 });
		}) as typeof fetch;
		try {
			const listed = await call(layer, 'GET', '/subjects', { cookie: 'usuario-catalogo' });
			expect(listed.status).toBe(200);
			const rows = (listed.json.data as Array<{ technical_id?: string }>) ?? [];
			expect(rows.some((row) => row.technical_id === SEEN)).toBe(false);
			expect(catalog.has(SEEN)).toBe(false);
			expect(calls.some((url) => url.includes('github.com/orgs/') || url.includes('ghcr.io'))).toBe(
				false,
			);
		} finally {
			globalThis.fetch = original;
		}
	}, 20_000);
});
