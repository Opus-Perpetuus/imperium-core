import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	APP_REGISTRY_ENABLED_REF,
	APP_REGISTRY_SCHEMA_STATEMENTS,
	dispatch_app_registry,
	app_registry_env_override,
	read_app_registry_enabled,
	type RegistrySql,
} from './app-registry.ts';
import { memory_app_registry } from './app-registry-store.ts';
import { GRANDFATHER_SEGMENTS } from './app-registry-grandfather.ts';
import {
	colliding_segments,
	project_registry_snapshot,
} from './app-registry-manifest.ts';
import { is_denied_path } from './shares.ts';
import type { ImperiumStore } from './store.ts';
import { apply_odoo_image_sources } from './subject-image-sources.ts';

const SCHEMA_URI = 'https://schemas.opus-perpetuus.dev/imperium/kirlet-manifest/1.0.json';
const ADMIN = { _ref: 'user-menu-management-0' };
const PREVIOUS_FLAG = process.env.IMPERIUM_APP_REGISTRY;

afterEach(() => {
	if (PREVIOUS_FLAG == null) delete process.env.IMPERIUM_APP_REGISTRY;
	else process.env.IMPERIUM_APP_REGISTRY = PREVIOUS_FLAG;
});

function leaf_manifest(patch: Record<string, unknown> = {}) {
	return {
		$schema: SCHEMA_URI,
		manifestVersion: 1,
		id: 'SUBJECT-vehiculos',
		technicalId: 'subject-vehiculos',
		name: 'Vehículos',
		version: '0.10.0',
		image: 'ghcr.io/opus-perpetuus/subject-vehiculos:0.10.0',
		compat: { nox: '>=0.2.0 <2.0.0', kit: '^0.2.0' },
		api: { basePath: '/api/m/subject-vehiculos', port: 3000, healthPath: '/health' },
		permissions: [
			{ id: 'subject.vehiculos.envio-revision.read', label: 'Ver envíos a revisión' },
			{ id: 'subject.vehiculos.envio-revision.write', label: 'Editar envíos a revisión' },
		],
		pages: [
			{
				id: 'vehiculos.envio-revision',
				path: 'envio-revision',
				permission: 'subject.vehiculos.envio-revision.read',
				leaf: {
					kind: 'crud',
					appBase: 'envio-revision',
					appCreate: 'providers/connectors',
					icon: 'fa-file-signature',
					listHeaders: { es: { name: 'Título' } },
					minShellVersion: '13.102.0',
				},
			},
		],
		...patch,
	};
}

function recording_sql(): RegistrySql & { queries: string[] } {
	const queries: string[] = [];
	return {
		queries,
		unsafe: async (query: string) => {
			queries.push(query);
			return [];
		},
	};
}

function store_with(value: unknown): ImperiumStore {
	return {
		has: () => true,
		find_where: async () => (value === undefined ? null : { value }),
	} as unknown as ImperiumStore;
}

describe('esquema del registro', () => {
	test('declara snapshot, registry y auditoría', () => {
		const sql = APP_REGISTRY_SCHEMA_STATEMENTS.join('\n');
		expect(sql).toContain('public.app_manifest_snapshot');
		expect(sql).toContain('manifest_hash');
		expect(sql).toContain('previous_manifest');
		expect(sql).toContain('public.app_registry');
		expect(sql).toContain('installed_digest');
		expect(sql).toContain('previous_tag');
		expect(sql).toContain('public.app_registry_audit');
		expect(sql).toContain('actor_user_id');
		expect(sql).toContain("action IN ('install', 'sync', 'policy', 'reject')");
	});
});

describe('proyección del manifiesto', () => {
	test('reescribe appBase al gateway del slug instalado', () => {
		const result = project_registry_snapshot(leaf_manifest(), 'vehiculos');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.snapshot.leaves).toEqual([
			expect.objectContaining({
				segment: 'envio-revision',
				permission: 'subject.vehiculos.envio-revision.read',
				appBase: 'envio-revision',
				appBaseEffective: 'm/subject-vehiculos/envio-revision',
				appCreate: 'providers/connectors',
				appCreateEffective: 'm/subject-vehiculos/providers/connectors',
			}),
		]);
		expect(result.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
		const again = project_registry_snapshot(leaf_manifest(), 'vehiculos');
		expect(again.ok && again.manifest_hash).toBe(result.manifest_hash);
	});

	test('no acepta el prefijo declarado si no es el del slug instalado', () => {
		const declared = leaf_manifest();
		const page = (declared.pages as Array<Record<string, unknown>>)[0]!;
		page.permission = 'kirlet.vehiculos.envio-revision.read';
		(page.leaf as Record<string, unknown>).permission = 'kirlet.vehiculos.envio-revision.read';
		(declared.permissions as Array<{ id: string }>)[0]!.id = 'kirlet.vehiculos.envio-revision.read';
		const result = project_registry_snapshot(declared, 'vehiculos');
		expect(result.ok).toBe(false);
	});

	test('no acepta un technicalId de otro slug', () => {
		const result = project_registry_snapshot(
			leaf_manifest({
				id: 'SUBJECT-otros',
				technicalId: 'subject-otros',
				permissions: [
					{ id: 'subject.otros.envio-revision.read', label: 'Ver' },
				],
				pages: [
					{
						id: 'otros.envio-revision',
						path: 'envio-revision',
						permission: 'subject.otros.envio-revision.read',
						leaf: { kind: 'crud', appBase: 'envio-revision' },
					},
				],
			}),
			'vehiculos',
		);
		expect(result.ok).toBe(false);
	});

	test('un segmento de otro slug es colisión; el mismo slug no', () => {
		expect(
			colliding_segments(
				[{ slug: '__shell__', segments: ['tienda', 'pos'] }],
				{ slug: 'vehiculos', segments: ['envio-revision', 'tienda'] },
			),
		).toEqual(['tienda']);
		expect(
			colliding_segments(
				[{ slug: 'vehiculos', segments: ['envio-revision'] }],
				{ slug: 'vehiculos', segments: ['envio-revision', 'bitacora'] },
			),
		).toEqual([]);
	});
});

describe('interruptor', () => {
	test('apagado si nadie lo pidió', async () => {
		delete process.env.IMPERIUM_APP_REGISTRY;
		expect(app_registry_env_override()).toBeNull();
		expect(await read_app_registry_enabled(store_with(undefined))).toBe(false);
		expect(await read_app_registry_enabled(store_with(false))).toBe(false);
		expect(await read_app_registry_enabled(store_with(true))).toBe(true);
	});

	test('el entorno gana al parámetro', async () => {
		process.env.IMPERIUM_APP_REGISTRY = '0';
		expect(await read_app_registry_enabled(store_with(true))).toBe(false);
		process.env.IMPERIUM_APP_REGISTRY = '1';
		expect(await read_app_registry_enabled(store_with(false))).toBe(true);
		process.env.IMPERIUM_APP_REGISTRY = 'quizas';
		expect(await read_app_registry_enabled(store_with(true))).toBe(false);
	});

	test('la semilla nace en SI (migración estática→dynamic)', () => {
		const seeds = JSON.parse(
			readFileSync(new URL('./configuration-parameter-seeds.json', import.meta.url), 'utf8'),
		) as Array<{ _ref: string; value: unknown }>;
		const row = seeds.find((item) => item._ref === APP_REGISTRY_ENABLED_REF);
		expect(row?.value).toBe(true);
	});
});

describe('superficie HTTP', () => {
	test('con el flag apagado la ruta no existe y no toca el esquema', async () => {
		const sql: RegistrySql = {
			unsafe: async () => {
				throw new Error('no debía consultar');
			},
		};
		const res = await dispatch_app_registry(
			{ sql, enabled: false, user: ADMIN },
			new Request('http://core/api/registry/bootstrap'),
			'/registry/bootstrap',
		);
		expect(res.status).toBe(404);
		expect(res.headers.get('X-Imperium-Registry-Api')).toBeNull();
		expect(await res.json()).toEqual({ error: 'not found' });
	});

	test('sin sesión 401 y sin ser administrador 403', async () => {
		const sql = recording_sql();
		const anon = await dispatch_app_registry(
			{ sql, enabled: true, user: null },
			new Request('http://core/api/registry'),
			'/registry',
		);
		expect(anon.status).toBe(401);
		expect(anon.headers.get('X-Imperium-Registry-Api')).toBe('1');
		const other = await dispatch_app_registry(
			{ sql, enabled: true, user: { _ref: 'user-x' } },
			new Request('http://core/api/registry'),
			'/registry',
		);
		expect(other.status).toBe(403);
		expect(sql.queries).toEqual([]);
	});

	test('el administrador ve el esquema listo y el bootstrap de usuario responde', async () => {
		const sql = recording_sql();
		const repo = memory_app_registry();
		const status = await dispatch_app_registry(
			{ sql, enabled: true, user: ADMIN, repo },
			new Request('http://core/api/registry'),
			'/registry',
		);
		expect(status.status).toBe(200);
		const body = (await status.json()) as {
			registryApiVersion: number;
			enabled: boolean;
			userBootstrap: string;
			tables: string[];
			envWrite: boolean;
		};
		expect(body.registryApiVersion).toBe(1);
		expect(body.enabled).toBe(true);
		expect(body.userBootstrap).toBe('ready');
		expect(body.envWrite).toBe(false);
		expect(body.tables).toContain('app_manifest_snapshot');
		expect(sql.queries.join('\n')).toContain('app_manifest_snapshot');
		expect(sql.queries.join('\n')).not.toContain('INSERT');

		const bootstrap = await dispatch_app_registry(
			{ sql, enabled: true, user: ADMIN, repo },
			new Request('http://core/api/registry/bootstrap'),
			'/registry/bootstrap',
		);
		expect(bootstrap.status).toBe(200);
		const payload = (await bootstrap.json()) as { leaves: unknown[]; registryApiVersion: number };
		expect(payload.registryApiVersion).toBe(1);
		expect(payload.leaves).toEqual([]);
		expect(bootstrap.headers.get('Cache-Control')).toBe('private');

		const policy = await dispatch_app_registry(
			{ sql, enabled: true, user: ADMIN, repo },
			new Request('http://core/api/registry/apps/vehiculos/version-policy', { method: 'PUT' }),
			'/registry/apps/vehiculos/version-policy',
		);
		expect(policy.status).toBe(501);
		expect(((await policy.json()) as { envWrite: boolean }).envWrite).toBe(false);
	});

	test('un slug inválido no llega al 501', async () => {
		const res = await dispatch_app_registry(
			{ sql: recording_sql(), enabled: true, user: ADMIN },
			new Request('http://core/api/registry/apps/..%2Fadmin/install', { method: 'POST' }),
			'/registry/apps/..%2Fadmin/install',
		);
		expect(res.status).toBe(404);
	});
});

describe('enganche', () => {
	test('el router crea el esquema y despacha /registry', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		expect(src).toContain('ensure_app_registry_schema');
		expect(src).toContain('is_app_registry_path');
	});

	test('un enlace público no alcanza el registro', () => {
		expect(is_denied_path('/api/registry')).toBe(true);
		expect(is_denied_path('/api/registry/bootstrap')).toBe(true);
	});

	test('el arranque dispara el sync en frío sin esperarlo', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		expect(src).toContain('start_registry_cold_sync');
		expect(src).toContain('void start_registry_cold_sync');
	});
});

describe('bootstrap de usuario', () => {
	const catalog = [
		{
			slug: 'vehiculos',
			name: 'Vehículos',
			technical_id: 'subject-vehiculos',
			image: 'ghcr.io/opus-perpetuus/subject-vehiculos:0.10.0',
		},
	];

	async function synced(manifest: Record<string, unknown> = leaf_manifest()) {
		const repo = memory_app_registry();
		const sync = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog,
				read_manifest: async () => ({ ok: true, manifest }),
			},
			new Request('http://core/api/registry/apps/vehiculos/sync-manifest', { method: 'POST' }),
			'/registry/apps/vehiculos/sync-manifest',
		);
		return { repo, sync };
	}

	test('filtra por permiso, aplana el idioma y el ETag cambia con el usuario', async () => {
		const { repo } = await synced();
		const denied = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: { _ref: 'user-x' },
				repo,
				access: { full: false, allow_read: () => false },
			},
			new Request('http://core/api/registry/bootstrap', { headers: { 'accept-language': 'en' } }),
			'/registry/bootstrap',
		);
		expect(denied.status).toBe(200);
		const hidden = (await denied.json()) as { leaves: unknown[]; etag: string };
		expect(hidden.leaves).toEqual([]);

		const allowed = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: { _ref: 'user-y' },
				repo,
				access: { full: false, allow_read: (model) => model === 'EnvioRevision' },
			},
			new Request('http://core/api/registry/bootstrap'),
			'/registry/bootstrap',
		);
		const body = (await allowed.json()) as {
			leaves: Array<Record<string, unknown>>;
			etag: string;
			versionDiscovered?: unknown;
			repository?: unknown;
		};
		expect(body.versionDiscovered).toBeUndefined();
		expect(body.repository).toBeUndefined();
		expect(body.leaves).toEqual([
			expect.objectContaining({
				segment: 'envio-revision',
				path: '/envio-revision',
				app_base: 'm/subject-vehiculos/envio-revision',
				list_headers: { name: 'Título' },
				permission: 'subject.vehiculos.envio-revision.read',
			}),
		]);
		expect(body.etag).not.toBe(hidden.etag);

		const again = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: { _ref: 'user-y' },
				repo,
				access: { full: false, allow_read: (model) => model === 'EnvioRevision' },
			},
			new Request('http://core/api/registry/bootstrap', { headers: { 'if-none-match': body.etag } }),
			'/registry/bootstrap',
		);
		expect(again.status).toBe(304);
		expect(again.headers.get('ETag')).toBe(body.etag);
	});

	test('un manifiesto inválido o un segmento ajeno no pisan el snapshot', async () => {
		const { repo, sync } = await synced();
		expect(sync.status).toBe(200);
		const before = await repo.get_snapshot('vehiculos');
		const broken = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog,
				read_manifest: async () => ({ ok: true, manifest: { nope: true } }),
			},
			new Request('http://core/api/registry/apps/vehiculos/sync-manifest', { method: 'POST' }),
			'/registry/apps/vehiculos/sync-manifest',
		);
		expect(broken.status).toBe(422);
		expect((await repo.get_snapshot('vehiculos'))?.manifest_hash).toBe(before?.manifest_hash);

		const steal = leaf_manifest({
			pages: [
				{
					id: 'vehiculos.providers',
					path: 'providers',
					permission: 'subject.vehiculos.envio-revision.read',
					leaf: { kind: 'crud', appBase: 'envio-revision' },
				},
			],
		});
		const collision = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog,
				read_manifest: async () => ({ ok: true, manifest: steal }),
			},
			new Request('http://core/api/registry/apps/vehiculos/sync-manifest', { method: 'POST' }),
			'/registry/apps/vehiculos/sync-manifest',
		);
		expect(collision.status).toBe(409);
		expect(GRANDFATHER_SEGMENTS.tienda).toContain('providers');
		expect((await repo.get_snapshot('vehiculos'))?.manifest.leaves[0]?.segment).toBe('envio-revision');
	});

	test('sin docker no borra el snapshot y la instalación no escribe el entorno', async () => {
		const { repo } = await synced();
		const skipped = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog,
				read_manifest: async () => ({ ok: false, skipped: true }),
			},
			new Request('http://core/api/registry/apps/vehiculos/sync-manifest', { method: 'POST' }),
			'/registry/apps/vehiculos/sync-manifest',
		);
		expect(skipped.status).toBe(200);
		expect((await skipped.json()) as { skipped: boolean }).toMatchObject({ skipped: true });
		expect(await repo.get_snapshot('vehiculos')).not.toBeNull();

		const env_before = process.env.IMPERIUM_SUBJECT_TAG_VEHICULOS;
		const install = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog,
				read_manifest: async () => ({ ok: true, manifest: leaf_manifest() }),
				run_install: async () => ({ ok: true, skipped: true, image: null }),
			},
			new Request('http://core/api/registry/apps/vehiculos/install', {
				method: 'POST',
				body: JSON.stringify({ tag: '0.11.0' }),
			}),
			'/registry/apps/vehiculos/install',
		);
		const installed = (await install.json()) as { applied: boolean; envWrite: boolean };
		expect(install.status).toBe(200);
		expect(installed.applied).toBe(false);
		expect(installed.envWrite).toBe(false);
		expect(process.env.IMPERIUM_SUBJECT_TAG_VEHICULOS).toBe(env_before);
		expect((await repo.get_registry('vehiculos'))?.installed_tag ?? null).toBeNull();

		const applied = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog,
				read_manifest: async () => ({ ok: true, manifest: leaf_manifest() }),
				run_install: async () => ({
					ok: true,
					skipped: false,
					image: 'ghcr.io/opus-perpetuus/subject-vehiculos:0.11.0',
				}),
			},
			new Request('http://core/api/registry/apps/vehiculos/install', {
				method: 'POST',
				body: JSON.stringify({ tag: '0.11.0' }),
			}),
			'/registry/apps/vehiculos/install',
		);
		expect(applied.status).toBe(200);
		expect((await repo.get_registry('vehiculos'))?.installed_tag).toBe('0.11.0');
		expect(process.env.IMPERIUM_SUBJECT_TAG_VEHICULOS).toBe(env_before);

		const versions = await dispatch_app_registry(
			{ sql: recording_sql(), enabled: true, user: ADMIN, repo, catalog },
			new Request('http://core/api/registry/apps/vehiculos/versions'),
			'/registry/apps/vehiculos/versions',
		);
		const view = (await versions.json()) as { envWrite: boolean; installed_tag: string };
		expect(view.envWrite).toBe(false);
		expect(view.installed_tag).toBe('0.11.0');
	});
});

describe('catálogo GHCR M4a', () => {
	afterEach(() => {
		apply_odoo_image_sources('');
	});

	const installed_row = {
		slug: 'vehiculos',
		name: 'Vehículos',
		technical_id: 'subject-vehiculos',
		image: 'ghcr.io/opus-perpetuus/subject-vehiculos:0.10.0',
	};

	test('GET /apps lista paquetes del escaneo y filas instaladas; no escribe env', async () => {
		apply_odoo_image_sources('ghcr:opus-perpetuus');
		const repo = memory_app_registry();
		await repo.upsert_registry({
			slug: 'vehiculos',
			technical_id: 'subject-vehiculos',
			install_status: 'ok',
			installed_tag: '0.10.0',
			image_repo: 'ghcr.io/opus-perpetuus/subject-vehiculos',
		});
		const env_before = process.env.IMPERIUM_SUBJECT_TAG_VEHICULOS;
		const calls: string[] = [];
		const res = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog: [installed_row],
				scan: {
					client: async (input) => {
						calls.push(input.url);
						if (input.url.includes('/packages?ecosystem=container')) {
							return {
								status: 200,
								body: `<a href="/orgs/Opus-Perpetuus/packages/container/package/subject-pos">subject-pos</a>
<a href="/orgs/Opus-Perpetuus/packages/container/package/nginx">nginx</a>`,
							};
						}
						if (input.url.includes('/token?')) {
							return { status: 200, body: { token: 'anon' } };
						}
						if (input.url.includes('/tags/list')) {
							return { status: 200, body: { tags: ['1.2.3', '1.0.0'] } };
						}
						return { status: 404, body: '' };
					},
					token: null,
				},
			},
			new Request('http://core/api/registry/apps'),
			'/registry/apps',
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: Array<{ slug: string; installed: boolean; image: string; envWrite: boolean }>;
			envWrite: boolean;
			next_cursor: string | null;
		};
		expect(body.envWrite).toBe(false);
		const by_slug = new Map(body.items.map((item) => [item.slug, item]));
		expect(by_slug.has('vehiculos')).toBe(true);
		expect(by_slug.get('vehiculos')?.installed).toBe(true);
		expect(by_slug.has('pos')).toBe(true);
		expect(by_slug.get('pos')?.installed).toBe(false);
		expect(by_slug.get('pos')?.image).toContain('subject-pos:1.2.3');
		expect(by_slug.has('nginx')).toBe(false);
		expect(process.env.IMPERIUM_SUBJECT_TAG_VEHICULOS).toBe(env_before);
		expect(calls.some((url) => url.includes('opus-perpetuus'))).toBe(true);
	});

	test('si el escaneo falla, fail-open al baseline + instaladas', async () => {
		const repo = memory_app_registry();
		await repo.upsert_registry({
			slug: 'vehiculos',
			technical_id: 'subject-vehiculos',
			install_status: 'ok',
			installed_tag: '0.10.0',
		});
		const res = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo,
				catalog: [installed_row],
				scan: {
					client: async () => {
						throw new Error('ghcr down');
					},
				},
			},
			new Request('http://core/api/registry/apps?installed=1'),
			'/registry/apps',
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ slug: string }> };
		expect(body.items.map((item) => item.slug)).toEqual(['vehiculos']);
	});

	test('GET /registry expone fuentes y el config ref editable', async () => {
		apply_odoo_image_sources('ghcr:codice-progressio private');
		const status = await dispatch_app_registry(
			{ sql: recording_sql(), enabled: true, user: ADMIN, repo: memory_app_registry() },
			new Request('http://core/api/registry'),
			'/registry',
		);
		const body = (await status.json()) as {
			imageSources: Array<{ kind: string; org: string; private: boolean }>;
			imageSourcesConfigRef: string;
			envWrite: boolean;
		};
		expect(body.imageSourcesConfigRef).toBe('configuration-subject-image-sources');
		expect(body.imageSources).toEqual([
			{ kind: 'oci-ghcr', org: 'codice-progressio', private: true },
		]);
		expect(body.envWrite).toBe(false);
	});

	test('scan:false no llama a la red aunque haya store', async () => {
		const store = {
			has: () => true,
			find_where: async () => ({ value: 'ghcr:opus-perpetuus' }),
			subjects: [installed_row],
		} as unknown as ImperiumStore;
		const res = await dispatch_app_registry(
			{
				sql: recording_sql(),
				enabled: true,
				user: ADMIN,
				repo: memory_app_registry(),
				store,
				scan: false,
			},
			new Request('http://core/api/registry/apps'),
			'/registry/apps',
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ slug: string }> };
		expect(body.items.map((i) => i.slug)).toEqual(['vehiculos']);
	});
});
