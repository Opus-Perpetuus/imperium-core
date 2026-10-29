import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { odoo_only_config_denied } from './odoo-only-config.ts';
import { create_imperium_layer } from './router.ts';
import type { ImperiumStore } from './store.ts';
import {
	odoo_sources_value,
	reconcile_image_sources_param,
	run_image_autoscan_pass,
	trigger_image_autoscan,
} from './subject-image-autoscan.ts';
import { IMAGE_SOURCES_CONFIG_REF, apply_odoo_image_sources } from './subject-image-sources.ts';

const previous_runtime = process.env.SUBJECT_RUNTIME;
const previous_master = process.env.CORE_SUBJECT_GATEWAY_SECRET;
const original_fetch = globalThis.fetch;
beforeAll(() => {
	process.env.SUBJECT_RUNTIME = 'off';
	if (!previous_master?.trim()) process.env.CORE_SUBJECT_GATEWAY_SECRET = 'maestro-de-prueba';
	// La pasada en segundo plano que dispara el PUT no debe salir a la red.
	globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
});
afterAll(() => {
	globalThis.fetch = original_fetch;
	apply_odoo_image_sources('');
	if (previous_runtime == null) delete process.env.SUBJECT_RUNTIME;
	else process.env.SUBJECT_RUNTIME = previous_runtime;
	if (previous_master == null) delete process.env.CORE_SUBJECT_GATEWAY_SECRET;
	else process.env.CORE_SUBJECT_GATEWAY_SECRET = previous_master;
});

const ADMIN = {
	_id: 'admin-autoscan',
	_ref: 'user-menu-management-0',
	email: 'admin@admin.com',
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

function harness() {
	const catalog = new Map<string, CatalogRow>();
	const settings = new Map<string, unknown>();
	const config = new Map<string, ImperiumDoc>();
	const sessions = new Map([['admin-autoscan', { payload: ADMIN, exp: Date.now() + 3_600_000 }]]);
	const sql = {
		async unsafe(query: string, params: unknown[] = []) {
			if (query.includes('imperium_sessions')) {
				const row = sessions.get(String(params[0] ?? ''));
				return row ? [row] : [];
			}
			if (query.includes('subject_catalog_settings')) {
				if (query.includes('INSERT')) {
					settings.set(String(params[0]), params[1]);
					return [];
				}
				if (query.includes('SELECT')) {
					const value = settings.get(String(params[0]));
					return value === undefined ? [] : [{ value, updated_at: 'hoy' }];
				}
				return [];
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
			if (query.includes('subject_catalog') && query.includes("source = 'image-source'") && query.includes('DELETE')) {
				const keep = new Set((params[0] as string[]) ?? []);
				const gone = [...catalog.values()].filter(
					(row) => row.source === 'image-source' && !keep.has(row.technical_id),
				);
				for (const row of gone) catalog.delete(row.technical_id);
				return gone.map((row) => ({ technical_id: row.technical_id }));
			}
			if (query.includes('SELECT 1') && query.includes('subject_catalog')) {
				const row = catalog.get(String(params[0]));
				const allowed = ['odoo', 'manual', 'image-source'].filter((s) => query.includes(`'${s}'`));
				return row && allowed.includes(row.source) ? [{ ok: 1 }] : [];
			}
			if (query.includes('SELECT source') && query.includes('subject_catalog')) {
				const row = catalog.get(String(params[0]));
				return row ? [{ source: row.source }] : [];
			}
			if (query.includes('SELECT technical_id') && query.includes('subject_catalog')) {
				return [...catalog.values()];
			}
			return [];
		},
	} as unknown as Bun.SQL;
	const layer = create_imperium_layer(sql);
	const store = layer.store;
	let seq = 0;
	store.scan = async function* () {} as ImperiumStore['scan'];
	store.has = ((resource: string) => resource === 'configuration') as ImperiumStore['has'];
	store.find_where = (async (_resource: string, where: Record<string, unknown>) =>
		[...config.values()].find((doc) => doc._ref === where._ref) ?? null) as ImperiumStore['find_where'];
	store.find_id = (async (_resource: string, id: string) => config.get(id) ?? null) as ImperiumStore['find_id'];
	store.insert = (async (_resource: string, doc: ImperiumDoc) => {
		const row = { ...doc, _id: `cfg-${++seq}` };
		config.set(row._id, row);
		return row;
	}) as ImperiumStore['insert'];
	store.update = (async (_resource: string, id: string, patch: Record<string, unknown>) => {
		const row = { ...config.get(id)!, ...patch };
		config.set(id, row);
		return row;
	}) as unknown as ImperiumStore['update'];
	return { layer, sql, store, catalog, config };
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

function index_html(org: string, names: readonly string[]): string {
	return `<html>${names
		.map((name) => `<a href="/orgs/${org}/packages/container/package/${name}">${name}</a>`)
		.join('')}</html>`;
}

/** Dos organizaciones: cada una lista sus paquetes; todas las apps van en 2.0.0. */
function two_org_scan(by_org: Record<string, string[]>) {
	return {
		token: null,
		client: async (input: { url: string }) => {
			const org = Object.keys(by_org).find((name) => input.url.includes(`/orgs/${name}/`));
			if (org && input.url.includes('github.com/orgs/')) {
				return { status: 200, body: index_html(org, by_org[org]!) };
			}
			if (input.url.includes('/token?')) return { status: 200, body: { token: 'anon' } };
			if (input.url.includes('/tags/list')) return { status: 200, body: { tags: ['1.0.0', '2.0.0'] } };
			return { status: 404, body: '' };
		},
	};
}

describe('fuentes que manda Odoo', () => {
	test('acepta orgs sueltas, «ghcr:org» y objetos; quita repetidas', () => {
		expect(
			odoo_sources_value(['opus-perpetuus', 'ghcr:codice-progressio', { org: 'acme', private: true }, 'opus-perpetuus']),
		).toBe('ghcr:opus-perpetuus; ghcr:codice-progressio; ghcr:acme private');
		expect(odoo_sources_value(undefined)).toBeUndefined();
		expect(odoo_sources_value([])).toBeNull();
		expect(() => odoo_sources_value(['ghcr:-mal-'])).toThrow();
	});
});

describe('el autoescaneo solo lo enciende Odoo', () => {
	test('un administrador no lo enciende ni escanea mientras esté apagado', async () => {
		const { layer, config } = harness();
		const put = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			cookie: 'admin-autoscan',
			body: { enabled: true, sources: ['acme'] },
		});
		expect(put.status).toBe(403);
		expect(put.json.code).toBe('master_required');
		expect([...config.values()].some((doc) => doc._ref === IMAGE_SOURCES_CONFIG_REF)).toBe(false);
		const scan = await call(layer, 'POST', '/subjects/catalog/image-sources/scan', {
			cookie: 'admin-autoscan',
		});
		expect(scan.status).toBe(409);
		expect(scan.json.code).toBe('autoscan_disabled');
		const state = await call(layer, 'GET', '/subjects/catalog/image-sources', { cookie: 'admin-autoscan' });
		expect(state.status).toBe(200);
		expect((state.json.data as { enabled: boolean }).enabled).toBe(false);
	});

	test('Odoo lo enciende: aparece el parámetro con su lista y el escaneo agrega apps de N repos', async () => {
		const { layer, sql, store, catalog, config } = harness();
		const put = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			master: true,
			body: { enabled: true, sources: ['opus-perpetuus', 'acme-apps'] },
		});
		expect(put.status).toBe(200);
		const param = [...config.values()].find((doc) => doc._ref === IMAGE_SOURCES_CONFIG_REF);
		expect(param?.value).toBe('ghcr:opus-perpetuus; ghcr:acme-apps');
		expect(param?.is_active).toBe(true);
		await trigger_image_autoscan(store, sql);

		const manifests: string[] = [];
		const pass = await run_image_autoscan_pass(store, sql, {
			scan: two_org_scan({ 'opus-perpetuus': ['subject-turnos'], 'acme-apps': ['subject-acme-bodega'] }),
			read_manifest: async (slug) => {
				manifests.push(slug);
				return slug === 'acme-bodega' ? { name: 'Bodega ACME' } : null;
			},
			discover: false,
		});
		expect(pass.ok).toBe(true);
		expect(pass.added).toContain('acme-bodega');
		expect(catalog.get('subject-acme-bodega')).toMatchObject({
			source: 'image-source',
			name: 'Bodega ACME',
			image: 'ghcr.io/acme-apps/subject-acme-bodega:2.0.0',
			repo: 'ghcr.io/acme-apps/subject-acme-bodega',
		});
		expect(store.subjects.some((sub) => sub.technical_id === 'subject-acme-bodega')).toBe(true);
		const listed = await call(layer, 'GET', '/subjects', { cookie: 'admin-autoscan' });
		const rows = listed.json.data as Array<{ technical_id: string; catalog_source: string | null }>;
		expect(rows.find((row) => row.technical_id === 'subject-acme-bodega')?.catalog_source).toBe('image-source');
		const install = await call(layer, 'POST', '/subjects/subject-acme-bodega/install', {
			cookie: 'admin-autoscan',
			body: {},
		});
		expect(install.json.code).not.toBe('subject_not_authorized');

		// La app que ya no está en ningún repo sale del catálogo; un manifest no se vuelve a leer sin imagen nueva.
		manifests.length = 0;
		const again = await run_image_autoscan_pass(store, sql, {
			scan: two_org_scan({ 'opus-perpetuus': ['subject-turnos'], 'acme-apps': [] }),
			read_manifest: async (slug) => {
				manifests.push(slug);
				return null;
			},
			discover: false,
		});
		expect(again.removed).toContain('subject-acme-bodega');
		expect(catalog.has('subject-acme-bodega')).toBe(false);
		expect(manifests).not.toContain('turnos');
	});

	test('un listado que falla no borra lo que ya agregó', async () => {
		const { layer, sql, store, catalog } = harness();
		await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			master: true,
			body: { enabled: true, sources: ['acme-apps'] },
		});
		await trigger_image_autoscan(store, sql);
		await run_image_autoscan_pass(store, sql, {
			scan: two_org_scan({ 'acme-apps': ['subject-acme-bodega'] }),
			read_manifest: async () => null,
			discover: false,
		});
		expect(catalog.has('subject-acme-bodega')).toBe(true);
		const failed = await run_image_autoscan_pass(store, sql, {
			scan: { token: null, client: async () => ({ status: 503, body: '' }) },
			read_manifest: async () => null,
			discover: false,
		});
		expect(failed.ok).toBe(false);
		expect(catalog.has('subject-acme-bodega')).toBe(true);
	});

	test('Odoo lo apaga: el parámetro se esconde y salen las apps del autoescaneo', async () => {
		const { layer, sql, store, catalog, config } = harness();
		await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			master: true,
			body: { enabled: true, sources: ['acme-apps'] },
		});
		await trigger_image_autoscan(store, sql);
		await run_image_autoscan_pass(store, sql, {
			scan: two_org_scan({ 'acme-apps': ['subject-acme-bodega'] }),
			read_manifest: async () => null,
			discover: false,
		});
		catalog.set('subject-rh', {
			technical_id: 'subject-rh',
			slug: 'rh',
			name: 'RH',
			image: null,
			repo: null,
			source: 'manual',
			created_at: 'hoy',
			updated_at: 'hoy',
		});
		const off = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			master: true,
			body: { enabled: false },
		});
		expect(off.status).toBe(200);
		expect(catalog.has('subject-acme-bodega')).toBe(false);
		expect(catalog.get('subject-rh')?.source).toBe('manual');
		const param = [...config.values()].find((doc) => doc._ref === IMAGE_SOURCES_CONFIG_REF);
		expect(param?.is_active).toBe(false);
		const pass = await run_image_autoscan_pass(store, sql, { discover: false });
		expect(pass.enabled).toBe(false);
	});

	test('al arrancar sin autoescaneo, un parámetro sembrado por una versión vieja se esconde', async () => {
		const { sql, store, config } = harness();
		await store.insert('configuration', { _ref: IMAGE_SOURCES_CONFIG_REF, value: 'ghcr:x', is_active: true });
		await reconcile_image_sources_param(store, sql);
		expect([...config.values()][0]?.is_active).toBe(false);
	});

	test('una app del autoescaneo no se quita a mano', async () => {
		const { layer, sql, store, catalog } = harness();
		await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			master: true,
			body: { enabled: true, sources: ['acme-apps'] },
		});
		await trigger_image_autoscan(store, sql);
		await run_image_autoscan_pass(store, sql, {
			scan: two_org_scan({ 'acme-apps': ['subject-acme-bodega'] }),
			read_manifest: async () => null,
			discover: false,
		});
		const del = await call(layer, 'DELETE', '/subjects/catalog/subject-acme-bodega', {
			cookie: 'admin-autoscan',
		});
		expect(del.status).toBe(409);
		expect(del.json.code).toBe('added_by_image_autoscan');
		expect(catalog.has('subject-acme-bodega')).toBe(true);
	});
});

describe('Imperium no crea el parámetro de fuentes', () => {
	function guard_store(rows: ImperiumDoc[]) {
		return {
			find_id: async (_r: string, id: string) => rows.find((row) => row._id === id) ?? null,
		} as unknown as ImperiumStore;
	}
	const json_req = (method: string, body: unknown) =>
		new Request('http://imperium.test/api/configuration', {
			method,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});

	test('crear, renombrar hacia él o borrarlo se niega; editar su valor no', async () => {
		const rows: ImperiumDoc[] = [
			{ _id: 'p1', _ref: IMAGE_SOURCES_CONFIG_REF, value: 'ghcr:a' },
			{ _id: 'p2', _ref: 'configuration-otra', value: 'x' },
		];
		const store = guard_store(rows);
		expect(await odoo_only_config_denied(store, json_req('POST', { _ref: IMAGE_SOURCES_CONFIG_REF }), 'POST', [])).not.toBeNull();
		expect(await odoo_only_config_denied(store, json_req('POST', { _ref: 'configuration-x' }), 'POST', [])).toBeNull();
		expect(
			await odoo_only_config_denied(store, json_req('PUT', { _id: 'p2', _ref: IMAGE_SOURCES_CONFIG_REF }), 'PUT', []),
		).not.toBeNull();
		expect(await odoo_only_config_denied(store, json_req('PUT', { _id: 'p1', _ref: 'configuration-nueva' }), 'PUT', [])).not.toBeNull();
		expect(await odoo_only_config_denied(store, json_req('PUT', { _id: 'p1', value: 'ghcr:b' }), 'PUT', [])).toBeNull();
		expect(
			await odoo_only_config_denied(store, json_req('PUT', { rows: [{ _ref: IMAGE_SOURCES_CONFIG_REF }] }), 'PUT', ['batch']),
		).not.toBeNull();
		expect(await odoo_only_config_denied(store, json_req('PATCH', { _ref: IMAGE_SOURCES_CONFIG_REF }), 'PATCH', ['p2'])).not.toBeNull();
		const del = new Request('http://imperium.test/api/configuration/id/p1', { method: 'DELETE' });
		expect(await odoo_only_config_denied(store, del, 'DELETE', ['id', 'p1'])).not.toBeNull();
		const del_other = new Request('http://imperium.test/api/configuration/id/p2', { method: 'DELETE' });
		expect(await odoo_only_config_denied(store, del_other, 'DELETE', ['id', 'p2'])).toBeNull();
	});
});
