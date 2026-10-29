import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImperiumStore, SubjectInfo } from './store.ts';
import { list_catalog_subjects } from './subjects-admin.ts';
import {
	apply_image_sources_from_store,
	apply_odoo_image_sources,
	IMAGE_SOURCES_CONFIG_REF,
	live_catalog_scan,
	merge_scanned_subjects,
	refresh_subjects_from_image_sources,
	scan_image_sources,
	type PackageClient,
	type RegisteredSubject,
} from './subject-image-sources.ts';

const index_of = (org: string) =>
	`https://github.com/orgs/${org}/packages?ecosystem=container`;
const token_of = (org: string, name: string) =>
	`https://ghcr.io/token?service=ghcr.io&scope=repository:${org}/${name}:pull`;
const tags_of = (org: string, name: string) =>
	`https://ghcr.io/v2/${org}/${name}/tags/list?n=1000`;
const PRIVATE = 'https://api.github.com/orgs/secreta/packages?package_type=container';

function index_html(org: string, names: readonly string[], next?: string): string {
	const links = names
		.map((name) => `<a href="/orgs/${org}/packages/container/package/${name}">${name}</a>`)
		.join('');
	const more = next ? `<a rel="next" href="${next}">Next</a>` : '';
	return `<html>${links}${more}</html>`;
}

function client_of(
	body: unknown,
	calls: Array<{ url: string; headers: Record<string, string> }>,
	status = 200,
): PackageClient {
	return async (input) => {
		calls.push(input);
		return { status, body };
	};
}

const registered: RegisteredSubject[] = [
	{
		technical_id: 'subject-almacen',
		slug: 'almacen',
		image: 'ghcr.io/opus-perpetuus/subject-almacen:1.0.0',
		active: true,
		depends_on: [],
	},
	{
		technical_id: 'subject-pos',
		slug: 'pos',
		image: 'ghcr.io/opus-perpetuus/subject-pos:0.1.0',
		active: true,
	},
];

describe('fuentes de imágenes', () => {
	test('una org pública no pide token y solo devuelve apps Imperium', async () => {
		apply_odoo_image_sources('');
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const pages: Record<string, string> = {
			[index_of('opus-perpetuus')]: index_html('Opus-Perpetuus', [
				'subject-pos',
				'nginx',
				'imperium-core',
			]),
			[index_of('codice-progressio')]: index_html('codice-progressio', ['subject-pos']),
		};
		const packages = await scan_image_sources({
			token: 'ghp_test',
			client: async (input) => {
				calls.push(input);
				if (pages[input.url] != null) return { status: 200, body: pages[input.url] };
				if (input.url.includes('/token?')) return { status: 200, body: { token: 'anon-registry' } };
				if (input.url.includes('/tags/list')) {
					return { status: 200, body: { tags: ['latest', '1.0.0', '1.2.3'] } };
				}
				return { status: 500, body: '' };
			},
		});
		expect(calls.map((call) => call.url)).toEqual([
			index_of('opus-perpetuus'),
			token_of('opus-perpetuus', 'subject-pos'),
			tags_of('opus-perpetuus', 'subject-pos'),
			index_of('codice-progressio'),
			token_of('codice-progressio', 'subject-pos'),
			tags_of('codice-progressio', 'subject-pos'),
		]);
		const open = calls.filter((call) => !call.url.includes('/tags/list'));
		expect(open.every((call) => call.headers.Authorization == null)).toBe(true);
		expect(calls.filter((call) => call.url.includes('/tags/list')).map((call) => call.headers.Authorization)).toEqual([
			'Bearer anon-registry',
			'Bearer anon-registry',
		]);
		expect(calls.some((call) => JSON.stringify(call.headers).includes('ghp_test'))).toBe(false);
		expect(packages).toEqual([
			{ name: 'subject-pos', org: 'opus-perpetuus', version: '1.2.3' },
			{ name: 'subject-pos', org: 'codice-progressio', version: '1.2.3' },
		]);
	});

	test('una página pública vacía no es un listado negado', async () => {
		apply_odoo_image_sources('ghcr:codice-progressio');
		const calls: string[] = [];
		const packages = await scan_image_sources({
			client: async (input) => {
				calls.push(input.url);
				return { status: 200, body: '<html>0 packages. No results matched your search.</html>' };
			},
		});
		expect(calls).toEqual([index_of('codice-progressio')]);
		expect(packages).toEqual([]);
	});

	test('sigue la página siguiente del índice y de los tags', async () => {
		apply_odoo_image_sources('ghcr:opus-perpetuus');
		const page2 = `${index_of('opus-perpetuus')}&page=2`;
		const tags2 = `${tags_of('opus-perpetuus', 'subject-almacen')}&last=1.0.0`;
		const calls: string[] = [];
		const packages = await scan_image_sources({
			client: async (input) => {
				calls.push(input.url);
				if (input.url === index_of('opus-perpetuus')) {
					return {
						status: 200,
						body: index_html('Opus-Perpetuus', ['subject-almacen'], page2),
					};
				}
				if (input.url === page2) {
					return { status: 200, body: index_html('Opus-Perpetuus', ['subject-pos']) };
				}
				if (input.url.includes('/token?')) return { status: 200, body: { token: 'anon-registry' } };
				if (input.url === tags_of('opus-perpetuus', 'subject-almacen')) {
					return {
						status: 200,
						body: { tags: ['1.0.0', 'latest'] },
						headers: { link: `<${tags2}>; rel="next"` },
					};
				}
				if (input.url === tags2) return { status: 200, body: { tags: ['1.4.0'] } };
				if (input.url === tags_of('opus-perpetuus', 'subject-pos')) {
					return { status: 200, body: { tags: ['0.3.2'] } };
				}
				return { status: 500, body: '' };
			},
		});
		expect(calls).toContain(page2);
		expect(calls).toContain(tags2);
		expect(packages).toEqual([
			{ name: 'subject-almacen', org: 'opus-perpetuus', version: '1.4.0' },
			{ name: 'subject-pos', org: 'opus-perpetuus', version: '0.3.2' },
		]);
	});

	test('una fuente privada sin token falla y no devuelve paquetes', async () => {
		apply_odoo_image_sources('ghcr:secreta private');
		let called = false;
		try {
			await scan_image_sources({
				client: async () => {
					called = true;
					return { status: 200, body: [{ name: 'subject-pos', version: '1.0.0' }] };
				},
			});
			throw new Error('no lanzó');
		} catch (err) {
			expect((err as Error).message).toContain('token requerido');
		}
		expect(called).toBe(false);
	});

	test('una fuente privada con token envía el bearer y devuelve paquetes', async () => {
		apply_odoo_image_sources('ghcr:secreta privado');
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const packages = await scan_image_sources({
			client: client_of([{ name: 'subject-pos', version: '0.9.0' }], calls),
			token: 'ghp_test',
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(PRIVATE);
		expect(calls[0]?.headers.Accept).toBe('application/vnd.github+json');
		expect(calls[0]?.headers.Authorization).toBe('Bearer ghp_test');
		expect(packages).toEqual([
			{ name: 'subject-pos', org: 'secreta', version: '0.9.0' },
		]);
	});

	test('el payload de Odoo cambia las URLs que el escaneo lee', async () => {
		apply_odoo_image_sources('ghcr:opus-perpetuus');
		const first: string[] = [];
		await scan_image_sources({
			client: async (input) => {
				first.push(input.url);
				return { status: 200, body: [] };
			},
		});
		expect(first).toEqual([index_of('opus-perpetuus')]);
		apply_odoo_image_sources('ghcr:codice-progressio');
		const second: string[] = [];
		await scan_image_sources({
			client: async (input) => {
				second.push(input.url);
				return { status: 200, body: [] };
			},
		});
		expect(second).toEqual([index_of('codice-progressio')]);
	});

	test('el parámetro de fuentes no se siembra: solo lo crea Odoo al encender el autoescaneo', () => {
		const seed = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				'../../../../backend/src/components/configuration/module.data.ts',
			),
			'utf8',
		);
		expect(seed).not.toContain(`_ref: "${IMAGE_SOURCES_CONFIG_REF}"`);
		const json = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), 'configuration-parameter-seeds.json'),
			'utf8',
		);
		expect(json).not.toContain(IMAGE_SOURCES_CONFIG_REF);
	});

	test('el parámetro de sistema es el payload que el control de Odoo escribe', async () => {
		const store = {
			has: () => true,
			find_where: async (_collection: string, where: { _ref?: string }) =>
				where._ref === IMAGE_SOURCES_CONFIG_REF
					? { value: 'ghcr:codice-progressio' }
					: null,
		};
		await apply_image_sources_from_store(store as unknown as ImperiumStore);
		const calls: string[] = [];
		await scan_image_sources({
			client: async (input) => {
				calls.push(input.url);
				expect(input.headers.Authorization).toBeUndefined();
				return { status: 200, body: [] };
			},
		});
		expect(calls).toEqual([index_of('codice-progressio')]);
	});

	test('un listado negado no mezcla y no borra lo registrado', async () => {
		apply_odoo_image_sources('ghcr:opus-perpetuus');
		const before = registered.map((subject) => ({ ...subject }));
		try {
			await refresh_subjects_from_image_sources(registered, {
				client: async () => ({ status: 401, body: {} }),
			});
			throw new Error('no lanzó');
		} catch (err) {
			expect((err as Error).message).toContain('negó el listado');
		}
		expect(registered).toEqual(before);
	});

	test('un 401 al leer tags no mezcla y no cuenta como catálogo vacío', async () => {
		apply_odoo_image_sources('ghcr:opus-perpetuus');
		const before = registered.map((subject) => ({ ...subject }));
		try {
			await refresh_subjects_from_image_sources(registered, {
				client: async (input) => {
					if (input.url === index_of('opus-perpetuus')) {
						return { status: 200, body: index_html('Opus-Perpetuus', ['subject-pos']) };
					}
					return { status: 401, body: { message: 'authentication required' } };
				},
			});
			throw new Error('no lanzó');
		} catch (err) {
			expect((err as Error).message).toContain('negó el listado');
		}
		expect(registered).toEqual(before);
	});
});

describe('merge del escaneo', () => {
	test('conserva la app que no vio, refresca la que vio y solo agrega subject-*', () => {
		const merged = merge_scanned_subjects(registered, [
			{ name: 'subject-pos', org: 'opus-perpetuus', version: '0.4.0' },
			{ name: 'subject-nueva', org: 'codice-progressio', version: '0.1.0' },
			{ name: 'not-an-app', org: 'opus-perpetuus', version: '1.0.0' },
		]);
		expect(merged.find((subject) => subject.technical_id === 'subject-almacen')).toMatchObject({
			active: true,
			image: 'ghcr.io/opus-perpetuus/subject-almacen:1.0.0',
		});
		expect(merged.find((subject) => subject.technical_id === 'subject-pos')?.image).toBe(
			'ghcr.io/opus-perpetuus/subject-pos:0.4.0',
		);
		expect(merged.find((subject) => subject.technical_id === 'subject-nueva')?.image).toBe(
			'ghcr.io/codice-progressio/subject-nueva:0.1.0',
		);
		expect(merged.some((subject) => subject.technical_id === 'not-an-app')).toBe(false);
	});

	test('sin tag nuevo conserva el tag y actualiza el repositorio', () => {
		const merged = merge_scanned_subjects(registered, [
			{ name: 'subject-pos', org: 'codice-progressio', version: null },
		]);
		expect(merged.find((subject) => subject.technical_id === 'subject-pos')?.image).toBe(
			'ghcr.io/codice-progressio/subject-pos:0.1.0',
		);
	});
});

function listed_subject(slug: string, tag: string): SubjectInfo {
	return {
		slug,
		name: slug,
		path: `/${slug}`,
		menu_ref: `${slug}-menu`,
		technical_id: `subject-${slug}`,
		image: `ghcr.io/opus-perpetuus/subject-${slug}:${tag}`,
		depends_on: [],
		modules: [],
	};
}

function catalog_store(
	sources: string,
	options?: { subjects?: SubjectInfo[]; installed?: boolean; seed_odoo?: boolean },
) {
	const subjects = options?.subjects ?? [
		listed_subject('almacen', '1.0.0'),
		listed_subject('pos', '0.1.0'),
	];
	const mark_installed = options?.installed !== false;
	const seed_odoo = options?.seed_odoo !== false;
	const store = {
		subjects,
		has: (resource: string) => resource === 'configuration',
		find_where: async (_resource: string, where: { _ref?: string }) =>
			where._ref === IMAGE_SOURCES_CONFIG_REF ? { value: sources } : null,
		scan: async function* () {},
	} as unknown as ImperiumStore;
	const installs = new Map(
		mark_installed
			? subjects.map((sub) => [
					sub.technical_id,
					{
						technical_id: sub.technical_id,
						installed: true,
						status: 'installed',
						installed_at: null,
						uninstalled_at: null,
						version: null,
						installed_image: sub.image,
						discovered_image: null,
						discovered_created_at: null,
						discovered_note: null,
						last_error: null,
						last_error_at: null,
					},
				])
			: [],
	);
	const catalog = new Map<string, { technical_id: string; source: string; image: string | null }>();
	const almacen = subjects.find((sub) => sub.technical_id === 'subject-almacen');
	if (seed_odoo && almacen) {
		catalog.set('subject-almacen', {
			technical_id: 'subject-almacen',
			source: 'odoo',
			image: almacen.image,
		});
	}
	const sql = {
		async unsafe(query: string, params: unknown[] = []) {
			if (query.includes('CREATE TABLE')) return [];
			if (query.includes('INSERT INTO public.subject_installs')) return [];
			if (query.includes('public.subject_installs')) return [...installs.values()];
			if (query.includes('INSERT INTO public.subject_catalog')) {
				const [technical_id, slug, name, image, repo, source] = params as string[];
				catalog.set(technical_id!, {
					technical_id: technical_id!,
					slug: slug!,
					name: name!,
					image: image ?? null,
					repo: repo ?? null,
					source: source!,
				} as { technical_id: string; source: string; image: string | null });
				return [];
			}
			if (query.includes('public.subject_catalog')) {
				return [...catalog.values()].map((row) => ({
					...row,
					slug: (row as { slug?: string }).slug ?? row.technical_id.replace(/^subject-/, ''),
					name: (row as { name?: string }).name ?? row.technical_id,
					repo: null,
					created_at: 'hoy',
					updated_at: 'hoy',
				}));
			}
			return [];
		},
	} as unknown as Bun.SQL;
	return { store, sql, catalog };
}

describe('el listado que sirve el producto', () => {
	test('GET /subjects no escanea; lo pide el administrador', () => {
		const router = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'router.ts'), 'utf8');
		const get_branch = router.slice(
			router.indexOf("if (req.method === 'GET' && (path === '/subjects'"),
			router.indexOf("if (path === '/subjects/catalog'"),
		);
		expect(get_branch).toContain('list_catalog_subjects(store, sql)');
		expect(get_branch).not.toContain('live_catalog_scan');
		expect(router).toContain('list_catalog_subjects(store, sql, live_catalog_scan())');
	});

	test('el token de GitHub sale del entorno, no de la lista de fuentes', () => {
		const previous = process.env.GITHUB_TOKEN;
		const previous_gh = process.env.GH_TOKEN;
		process.env.GITHUB_TOKEN = 'ghp_env';
		delete process.env.GH_TOKEN;
		try {
			expect(live_catalog_scan().token).toBe('ghp_env');
			expect(live_catalog_scan().cache).toBe(true);
		} finally {
			if (previous == null) delete process.env.GITHUB_TOKEN;
			else process.env.GITHUB_TOKEN = previous;
			if (previous_gh == null) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = previous_gh;
		}
	});

	test('refresca la imagen vista, conserva la que no vio y agrega la app nueva', async () => {
		const { store, sql, catalog } = catalog_store('ghcr:opus-perpetuus');
		const calls: string[] = [];
		const rows = await list_catalog_subjects(store, sql, {
			client: async (input) => {
				calls.push(input.url);
				if (input.url === index_of('opus-perpetuus')) {
					return {
						status: 200,
						body: index_html('Opus-Perpetuus', ['subject-pos', 'subject-nueva', 'nginx']),
					};
				}
				if (input.url.includes('/token?')) return { status: 200, body: { token: 'anon-registry' } };
				if (input.url.includes('/tags/list')) return { status: 200, body: { tags: ['latest', '0.4.0'] } };
				return { status: 500, body: '' };
			},
		});
		expect(calls).toContain(tags_of('opus-perpetuus', 'subject-pos'));
		expect(calls.some((url) => url.includes('/nginx'))).toBe(false);
		expect(rows.find((row) => row.technical_id === 'subject-pos')?.image).toBe(
			'ghcr.io/opus-perpetuus/subject-pos:0.4.0',
		);
		expect(rows.find((row) => row.technical_id === 'subject-almacen')?.image).toBe(
			'ghcr.io/opus-perpetuus/subject-almacen:1.0.0',
		);
		expect(catalog.get('subject-almacen')?.source).toBe('odoo');
		expect(rows.some((row) => row.technical_id === 'subject-nueva')).toBe(false);
		expect(catalog.has('subject-nueva')).toBe(false);
		expect(rows.some((row) => row.technical_id === 'nginx')).toBe(false);
		expect(store.subjects.some((sub) => sub.technical_id === 'subject-nueva')).toBe(true);
	});

	test('un listado vacío no registra apps no instaladas que no vio', async () => {
		const { store, sql, catalog } = catalog_store('ghcr:nadie', {
			subjects: [listed_subject('rh', '1.0.0'), listed_subject('pos', '0.1.0')],
			installed: false,
			seed_odoo: false,
		});
		let calls = 0;
		const scan = {
			cache: true,
			client: async () => {
				calls += 1;
				return { status: 200, body: '<html>0 packages</html>' };
			},
		};
		const rows = await list_catalog_subjects(store, sql, scan);
		expect(calls).toBe(1);
		expect(rows.map((row) => row.technical_id)).not.toContain('subject-rh');
		expect(rows.map((row) => row.technical_id)).not.toContain('subject-pos');
		expect(catalog.has('subject-rh')).toBe(false);
		expect(catalog.has('subject-pos')).toBe(false);
		const again = await list_catalog_subjects(store, sql, scan);
		expect(calls).toBe(1);
		expect(again.map((row) => row.technical_id)).not.toContain('subject-rh');
		expect(again.map((row) => row.technical_id)).not.toContain('subject-pos');
		expect(catalog.has('subject-rh')).toBe(false);
		expect(catalog.has('subject-pos')).toBe(false);
	});

	test('una app no vista ni instalada no entra aunque el listado traiga otra', async () => {
		const { store, sql, catalog } = catalog_store('ghcr:opus-perpetuus', {
			subjects: [listed_subject('rh', '1.0.0'), listed_subject('pos', '0.1.0')],
			installed: false,
			seed_odoo: false,
		});
		const rows = await list_catalog_subjects(store, sql, {
			client: async (input) => {
				if (input.url === index_of('opus-perpetuus')) {
					return { status: 200, body: index_html('Opus-Perpetuus', ['subject-pos']) };
				}
				if (input.url.includes('/token?')) return { status: 200, body: { token: 'anon-registry' } };
				if (input.url.includes('/tags/list')) return { status: 200, body: { tags: ['0.4.0'] } };
				return { status: 500, body: '' };
			},
		});
		expect(rows.some((row) => row.technical_id === 'subject-pos')).toBe(false);
		expect(catalog.has('subject-pos')).toBe(false);
		expect(store.subjects.find((sub) => sub.technical_id === 'subject-pos')?.image).toBe(
			'ghcr.io/opus-perpetuus/subject-pos:0.4.0',
		);
		expect(rows.some((row) => row.technical_id === 'subject-rh')).toBe(false);
		expect(catalog.has('subject-rh')).toBe(false);
	});

	test('un listado negado no cambia el catálogo que ya se sirve', async () => {
		const { store, sql } = catalog_store('ghcr:opus-perpetuus');
		const before = store.subjects.map((sub) => sub.image);
		const rows = await list_catalog_subjects(store, sql, {
			client: async () => ({ status: 401, body: {} }),
		});
		expect(store.subjects.map((sub) => sub.image)).toEqual(before);
		expect(rows.some((row) => row.technical_id === 'subject-nueva')).toBe(false);
		expect(rows.find((row) => row.technical_id === 'subject-pos')?.image).toBe(
			'ghcr.io/opus-perpetuus/subject-pos:0.1.0',
		);
	});

	test('una fuente privada sin token no llama al registro ni borra apps', async () => {
		const { store, sql } = catalog_store('ghcr:secreta private ghp_from_config');
		let called = false;
		const rows = await list_catalog_subjects(store, sql, {
			client: async () => {
				called = true;
				return { status: 200, body: [] };
			},
		});
		expect(called).toBe(false);
		expect(rows.find((row) => row.technical_id === 'subject-pos')?.image).toBe(
			'ghcr.io/opus-perpetuus/subject-pos:0.1.0',
		);
	});

	test('una fuente privada usa el token del argumento, no el texto de la lista', async () => {
		const { store, sql } = catalog_store('ghcr:secreta private ghp_from_config');
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await list_catalog_subjects(store, sql, {
			token: 'ghp_test',
			client: async (input) => {
				calls.push(input);
				return { status: 200, body: [{ name: 'subject-pos', version: '0.9.0' }] };
			},
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.Authorization).toBe('Bearer ghp_test');
		expect(JSON.stringify(calls[0]?.headers)).not.toContain('ghp_from_config');
		expect(store.subjects.find((sub) => sub.technical_id === 'subject-pos')?.image).toBe(
			'ghcr.io/secreta/subject-pos:0.9.0',
		);
	});
});
