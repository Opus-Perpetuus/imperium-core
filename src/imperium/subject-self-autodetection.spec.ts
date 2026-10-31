import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { management_mode } from './management-mode.ts';
import { create_imperium_layer } from './router.ts';
import type { ImperiumStore } from './store.ts';
import { remove_manual_entry } from './subject-catalog.ts';
import {
	odoo_sources_value,
	read_autoscan_state,
	run_image_autoscan_pass,
	seed_self_autoscan_from_env,
	trigger_image_autoscan,
} from './subject-image-autoscan.ts';
import {
	IMAGE_SOURCES_CONFIG_REF,
	apply_odoo_image_sources,
	format_image_sources,
	github_token,
	parse_image_sources,
	scan_image_sources,
	type PackageClient,
} from './subject-image-sources.ts';

/**
 * Autodetección de apps sin Odoo (IMPERIUM_MANAGEMENT_MODE=self): el núcleo
 * lee los repos Git `imperium-subject-*` de las fuentes, los deja en el
 * catálogo y Módulos lo administra. En modo odoo todo sigue igual (lo cubre
 * `subject-image-autoscan.spec.ts`).
 */

const previous_runtime = process.env.SUBJECT_RUNTIME;
const previous_master = process.env.CORE_SUBJECT_GATEWAY_SECRET;
const previous_mode = process.env.IMPERIUM_MANAGEMENT_MODE;
const original_fetch = globalThis.fetch;
beforeAll(() => {
	process.env.SUBJECT_RUNTIME = 'off';
	if (!previous_master?.trim()) process.env.CORE_SUBJECT_GATEWAY_SECRET = 'maestro-de-prueba';
	globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
});
afterEach(() => {
	if (previous_mode == null) delete process.env.IMPERIUM_MANAGEMENT_MODE;
	else process.env.IMPERIUM_MANAGEMENT_MODE = previous_mode;
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

type Repo = {
	name: string;
	archived?: boolean;
	manifest?: Record<string, unknown> | null;
	tags?: string[];
};

/**
 * GitHub falso: `/orgs/<org>/repos` en dos páginas (Link), manifest por
 * raw.githubusercontent.com (sin token) o por la API de contenidos (con token).
 */
function github_client(org: string, repos: Repo[], opts: { private_only?: boolean } = {}) {
	const urls: string[] = [];
	const auth: string[] = [];
	const row = (repo: Repo) => ({
		name: repo.name,
		full_name: `${org}/${repo.name}`,
		default_branch: 'main',
		archived: repo.archived === true,
	});
	const client: PackageClient = async (input) => {
		urls.push(input.url);
		if (input.headers?.Authorization) auth.push(input.url);
		const url = new URL(input.url);
		if (opts.private_only && !input.headers?.Authorization) return { status: 404, body: '' };
		if (url.pathname === `/orgs/${org}/repos`) {
			const half = Math.ceil(repos.length / 2);
			if (url.searchParams.get('page') === '2') return { status: 200, body: repos.slice(half).map(row) };
			return {
				status: 200,
				body: repos.slice(0, half).map(row),
				headers: { link: `<https://api.github.com/orgs/${org}/repos?per_page=100&type=all&page=2>; rel="next"` },
			};
		}
		const single = url.pathname.match(new RegExp(`^/repos/${org}/([^/]+)$`));
		if (single) {
			const repo = repos.find((r) => r.name === single[1]);
			return repo ? { status: 200, body: row(repo) } : { status: 404, body: '' };
		}
		const raw = url.host === 'raw.githubusercontent.com' && url.pathname.match(new RegExp(`^/${org}/([^/]+)/main/manifest.json$`));
		const api = url.pathname.match(new RegExp(`^/repos/${org}/([^/]+)/contents/manifest.json$`));
		const manifest_of = (raw || api) ? repos.find((r) => r.name === (raw || api)![1]) : undefined;
		if (raw || api) {
			return manifest_of?.manifest ? { status: 200, body: JSON.stringify(manifest_of.manifest) } : { status: 404, body: '' };
		}
		const tags = url.pathname.match(new RegExp(`^/repos/${org}/([^/]+)/tags$`));
		if (tags) {
			const repo = repos.find((r) => r.name === tags[1]);
			return { status: 200, body: (repo?.tags ?? []).map((name) => ({ name })) };
		}
		return { status: 404, body: '' };
	};
	return { client, urls, auth };
}

const OPUS: Repo[] = [
	{
		name: 'imperium-subject-vehiculos',
		manifest: {
			technicalId: 'subject-vehiculos',
			name: 'Vehículos',
			version: '0.8.0',
			image: 'ghcr.io/opus-perpetuus/subject-vehiculos:0.8.0',
			dependsOn: ['subject-rh'],
		},
	},
	{ name: 'imperium-subject-turnos', manifest: null, tags: ['v1.2.0', 'v1.10.1', 'nightly'] },
	{ name: 'imperium-subject-viejo', archived: true, manifest: { technicalId: 'subject-viejo', version: '1.0.0' } },
	{ name: 'imperium-sic-deploy' },
	{ name: 'subject-zz-prueba', manifest: { name: 'Prueba', version: 'v2.0.0', dependsOn: ['subject-rh', 'no-es-app'] } },
];

describe('modo de administración', () => {
	test('self y sus alias; cualquier otra cosa es odoo', () => {
		expect(management_mode({ IMPERIUM_MANAGEMENT_MODE: 'self' })).toBe('self');
		expect(management_mode({ IMPERIUM_MANAGEMENT_MODE: ' Self-Managed ' })).toBe('self');
		expect(management_mode({ IMPERIUM_MANAGEMENT_MODE: 'standalone' })).toBe('self');
		expect(management_mode({ IMPERIUM_MANAGEMENT_MODE: 'odoo' })).toBe('odoo');
		expect(management_mode({})).toBe('odoo');
	});

	test('el token sale de IMPERIUM_GITHUB_TOKEN antes que de GITHUB_TOKEN', () => {
		expect(github_token({ IMPERIUM_GITHUB_TOKEN: ' a ', GITHUB_TOKEN: 'b' })).toBe('a');
		expect(github_token({ GH_TOKEN: 'c' })).toBe('c');
		expect(github_token({})).toBe('');
	});
});

describe('fuentes de repos Git', () => {
	test('«github:org», «github:org/repo» y «ghcr:org» conviven; se quitan repetidas', () => {
		const list = parse_image_sources(
			'github:Opus-Perpetuus; github:acme/imperium-subject-x private\nghcr:opus-perpetuus; github:opus-perpetuus; github:a/b/c; nada:x',
		);
		expect(list).toEqual([
			{ org: 'Opus-Perpetuus', private: false, kind: 'github' },
			{ org: 'acme', private: true, kind: 'github', repo: 'imperium-subject-x' },
			{ org: 'opus-perpetuus', private: false },
		]);
		expect(format_image_sources(list)).toBe(
			'github:Opus-Perpetuus; github:acme/imperium-subject-x private; ghcr:opus-perpetuus',
		);
		expect(odoo_sources_value([{ kind: 'github', org: 'acme', repo: 'subject-y', private: true }])).toBe(
			'github:acme/subject-y private',
		);
		// Módulos avisa de una fuente mal escrita; Odoo la sigue filtrando.
		expect(() => odoo_sources_value(['github:acme', 'github:-mal-'], true)).toThrow();
		expect(odoo_sources_value(['github:acme', 'github:-mal-'])).toBe('github:acme');
	});

	test('cada repo imperium-subject-* es una app: manifest, o el tag semver más alto', async () => {
		const { client, urls } = github_client('opus-perpetuus', OPUS);
		const found = await scan_image_sources({
			client,
			token: null,
			sources: [{ org: 'opus-perpetuus', private: false, kind: 'github' }],
		});
		expect(found).toEqual([
			{
				name: 'subject-vehiculos',
				org: 'opus-perpetuus',
				version: '0.8.0',
				image_repo: 'ghcr.io/opus-perpetuus/subject-vehiculos',
				display_name: 'Vehículos',
				depends_on: ['subject-rh'],
				source_ref: 'github.com/opus-perpetuus/imperium-subject-vehiculos',
			},
			{
				name: 'subject-turnos',
				org: 'opus-perpetuus',
				version: '1.10.1',
				image_repo: 'ghcr.io/opus-perpetuus/subject-turnos',
				source_ref: 'github.com/opus-perpetuus/imperium-subject-turnos',
			},
			{
				name: 'subject-zz-prueba',
				org: 'opus-perpetuus',
				version: '2.0.0',
				image_repo: 'ghcr.io/opus-perpetuus/subject-zz-prueba',
				display_name: 'Prueba',
				depends_on: ['subject-rh'],
				source_ref: 'github.com/opus-perpetuus/subject-zz-prueba',
			},
		]);
		// Sin token: manifest por raw (no gasta el cupo de la API) y la página 2 del listado.
		expect(urls.some((url) => url.includes('page=2'))).toBe(true);
		expect(urls.some((url) => url.startsWith('https://raw.githubusercontent.com/'))).toBe(true);
		expect(urls.some((url) => url.includes('imperium-subject-viejo/'))).toBe(false);
	});

	test('una fuente privada exige token y lo usa en la API (listado y manifest)', async () => {
		const { client, auth } = github_client('acme', [OPUS[0]!], { private_only: true });
		const sources = [{ org: 'acme', private: true, kind: 'github' as const, repo: 'imperium-subject-vehiculos' }];
		await expect(scan_image_sources({ client, token: null, sources })).rejects.toThrow(
			'token requerido para github:acme/imperium-subject-vehiculos',
		);
		const found = await scan_image_sources({ client, token: 'tok', sources });
		expect(found.map((pkg) => [pkg.name, pkg.version])).toEqual([['subject-vehiculos', '0.8.0']]);
		expect(auth.some((url) => url.includes('/contents/manifest.json'))).toBe(true);
	});

	test('GitHub sin token que niega el listado sugiere IMPERIUM_GITHUB_TOKEN', async () => {
		await expect(
			scan_image_sources({
				client: async () => ({ status: 403, body: '' }),
				token: null,
				sources: [{ org: 'acme', private: false, kind: 'github' }],
			}),
		).rejects.toThrow('IMPERIUM_GITHUB_TOKEN');
	});

	test('el repo Git manda sobre el mismo paquete visto en GHCR', async () => {
		const git = github_client('opus-perpetuus', [OPUS[0]!]);
		const client: PackageClient = async (input) => {
			if (input.url.includes('github.com/orgs/opus-perpetuus/packages')) {
				return { status: 200, body: '<a href="/orgs/opus-perpetuus/packages/container/package/subject-vehiculos">x</a>' };
			}
			if (input.url.includes('/token?')) return { status: 200, body: { token: 'anon' } };
			if (input.url.includes('/tags/list')) return { status: 200, body: { tags: ['0.9.0'] } };
			return git.client(input);
		};
		const found = await scan_image_sources({
			client,
			token: null,
			sources: [
				{ org: 'opus-perpetuus', private: false, kind: 'github' },
				{ org: 'opus-perpetuus', private: false },
			],
		});
		expect(found).toHaveLength(1);
		expect(found[0]!.source_ref).toBe('github.com/opus-perpetuus/imperium-subject-vehiculos');
	});
});

describe('modo self: Módulos administra la autodetección sin Odoo', () => {
	test('un administrador la enciende, edita fuentes y escanea; managed_by refleja el modo', async () => {
		process.env.IMPERIUM_MANAGEMENT_MODE = 'self';
		const { layer, sql, store, catalog, config } = harness();
		const before = await call(layer, 'GET', '/subjects/catalog/image-sources', { cookie: 'admin-autoscan' });
		expect(before.json.data).toMatchObject({ enabled: false, managed_by: 'self', editable: true });

		const put = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			cookie: 'admin-autoscan',
			body: { enabled: true, sources: ['github:opus-perpetuus', 'ghcr:opus-perpetuus'] },
		});
		expect(put.status).toBe(200);
		expect(put.json.data).toMatchObject({ enabled: true, managed_by: 'self', configured_by: 'gui' });
		const param = [...config.values()].find((doc) => doc._ref === IMAGE_SOURCES_CONFIG_REF);
		expect(param?.value).toBe('github:opus-perpetuus; ghcr:opus-perpetuus');
		expect(String(param?.description)).toContain('Módulos');
		await trigger_image_autoscan(store, sql);

		const bad = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			cookie: 'admin-autoscan',
			body: { enabled: true, sources: ['github:-mal-'] },
		});
		expect(bad.status).toBe(400);

		const git = github_client('opus-perpetuus', OPUS);
		const read: string[] = [];
		const pass = await run_image_autoscan_pass(store, sql, {
			scan: {
				token: null,
				// GHCR (complemento) no tiene paquetes extra: solo cuentan los repos Git.
				client: async (input) =>
					input.url.includes('/packages')
						? { status: 200, body: '<html></html>' }
						: git.client(input),
			},
			read_manifest: async (slug) => {
				read.push(slug);
				return null;
			},
			discover: false,
		});
		expect(pass.ok).toBe(true);
		expect(pass.added.sort()).toEqual(['turnos', 'vehiculos', 'zz-prueba']);
		expect(catalog.get('subject-vehiculos')).toMatchObject({
			source: 'image-source',
			name: 'Vehículos',
			image: 'ghcr.io/opus-perpetuus/subject-vehiculos:0.8.0',
			repo: 'github.com/opus-perpetuus/imperium-subject-vehiculos',
		});
		// El manifest ya vino del repo: no se baja la imagen para leerlo.
		expect(read).not.toContain('vehiculos');
		// Una app que el núcleo no conocía toma sus dependencias del manifest del repo.
		const nueva = store.subjects.find((sub) => sub.technical_id === 'subject-zz-prueba');
		expect(nueva?.depends_on).toEqual(['subject-rh']);

		const install = await call(layer, 'POST', '/subjects/subject-turnos/install', {
			cookie: 'admin-autoscan',
			body: {},
		});
		expect(install.json.code).not.toBe('subject_not_authorized');

		const scan = await call(layer, 'POST', '/subjects/catalog/image-sources/scan', { cookie: 'admin-autoscan' });
		expect(scan.status).toBe(200);

		const off = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			cookie: 'admin-autoscan',
			body: { enabled: false },
		});
		expect(off.status).toBe(200);
		expect(catalog.has('subject-vehiculos')).toBe(false);
		const disabled = await call(layer, 'POST', '/subjects/catalog/image-sources/scan', { cookie: 'admin-autoscan' });
		expect(disabled.status).toBe(409);
		expect(String(disabled.json.message)).toContain('Módulos');
	});

	test('el .env solo siembra: lo editado en Módulos no se pisa', async () => {
		process.env.IMPERIUM_MANAGEMENT_MODE = 'self';
		const { layer, sql, store, config } = harness();
		const seeded = await seed_self_autoscan_from_env(store, sql, {
			IMPERIUM_MANAGEMENT_MODE: 'self',
			IMPERIUM_IMAGE_AUTOSCAN: 'on',
			IMPERIUM_IMAGE_SOURCES: 'github:opus-perpetuus',
		});
		expect(seeded).toMatchObject({ enabled: true, configured_by: 'env' });
		const value = () => [...config.values()].find((doc) => doc._ref === IMAGE_SOURCES_CONFIG_REF)?.value;
		expect(value()).toBe('github:opus-perpetuus');

		// El deploy (maestro) vuelve a sembrar mientras nadie lo edite en Módulos.
		const master = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			master: true,
			body: { enabled: true, sources: ['github:opus-perpetuus', 'ghcr:opus-perpetuus'] },
		});
		expect(master.status).toBe(200);
		expect(value()).toBe('github:opus-perpetuus; ghcr:opus-perpetuus');

		await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			cookie: 'admin-autoscan',
			body: { enabled: true, sources: ['github:acme'] },
		});
		const again = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			master: true,
			body: { enabled: true, sources: ['github:opus-perpetuus'] },
		});
		expect(again.json.data).toMatchObject({ seed_ignored: true, configured_by: 'gui' });
		expect(value()).toBe('github:acme');
		const boot = await seed_self_autoscan_from_env(store, sql, {
			IMPERIUM_MANAGEMENT_MODE: 'self',
			IMPERIUM_IMAGE_AUTOSCAN: 'off',
		});
		expect(boot).toMatchObject({ enabled: true, seed_ignored: true });
		// En modo odoo el .env no siembra nada.
		expect(await seed_self_autoscan_from_env(store, sql, { IMPERIUM_IMAGE_AUTOSCAN: 'on' })).toBeNull();
	});

	test('un solo administrador: Odoo ya no fija las apps autorizadas', async () => {
		process.env.IMPERIUM_MANAGEMENT_MODE = 'self';
		const { layer, sql, catalog } = harness();
		const put = await call(layer, 'PUT', '/subjects/catalog/authorized', {
			master: true,
			body: { slugs: ['rh'] },
		});
		expect(put.status).toBe(409);
		expect(put.json.code).toBe('self_managed');
		// Lo que autorizó Odoo antes de pasar a self se puede quitar aquí.
		catalog.set('subject-rh', {
			technical_id: 'subject-rh',
			slug: 'rh',
			name: 'RH',
			image: null,
			repo: null,
			source: 'odoo',
			created_at: 'hoy',
			updated_at: 'hoy',
		});
		await expect(remove_manual_entry(sql, 'subject-rh', 'odoo')).rejects.toThrow();
		expect(await remove_manual_entry(sql, 'subject-rh', 'self')).toBe(true);
	});

	test('en modo odoo el estado sigue diciendo que lo administra Odoo y no se edita', async () => {
		process.env.IMPERIUM_MANAGEMENT_MODE = 'odoo';
		const { store, sql, layer } = harness();
		const state = await read_autoscan_state(store, sql);
		expect(state).toMatchObject({ managed_by: 'odoo', editable: false });
		const put = await call(layer, 'PUT', '/subjects/catalog/image-sources', {
			cookie: 'admin-autoscan',
			body: { enabled: true, sources: ['github:acme'] },
		});
		expect(put.status).toBe(403);
		expect(put.json.code).toBe('master_required');
	});
});
