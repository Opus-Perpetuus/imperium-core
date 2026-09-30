import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	discover_subject_versions,
	registry_client,
	RegistryUnreachableError,
	type RegistryClient,
} from './subject-discovery.ts';
import type { ImperiumStore, SubjectInfo } from './store.ts';

const REPO = 'opus-perpetuus/subject-herramientas';

/** Respuestas de GHCR tal como llegan (índice OCI con la imagen y su atestación). */
function fake_ghcr(routes: Record<string, { body: unknown; headers?: Record<string, string> }>) {
	const calls: Array<{ url: string; auth: string | null; accept: string | null }> = [];
	const fetch_impl = async (url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({ url, auth: headers.get('authorization'), accept: headers.get('accept') });
		const path = url.replace('https://ghcr.io', '');
		const hit = routes[path];
		if (!hit) return new Response('{}', { status: 404 });
		return new Response(JSON.stringify(hit.body), { status: 200, headers: hit.headers });
	};
	return { fetch_impl, calls };
}

describe('cliente anónimo de GHCR', () => {
	test('pide token, pagina los tags y lee created de la imagen de esta arquitectura', async () => {
		const ghcr = fake_ghcr({
			[`/token?scope=repository:${REPO}:pull`]: { body: { token: 'T' } },
			[`/v2/${REPO}/tags/list?n=1000`]: {
				body: { tags: ['0.1.0', 'latest'] },
				headers: { link: `</v2/${REPO}/tags/list?last=latest&n=1000>; rel="next"` },
			},
			[`/v2/${REPO}/tags/list?last=latest&n=1000`]: { body: { tags: ['0.1.1', '0.2.0'] } },
			[`/v2/${REPO}/manifests/0.2.0`]: {
				body: {
					mediaType: 'application/vnd.oci.image.index.v1+json',
					manifests: [
						{ digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
						{ digest: 'sha256:img', platform: { os: 'linux', architecture: process.arch === 'arm64' ? 'arm64' : 'amd64' } },
					],
				},
			},
			[`/v2/${REPO}/manifests/sha256:img`]: { body: { config: { digest: 'sha256:cfg' } } },
			[`/v2/${REPO}/blobs/sha256:cfg`]: { body: { created: '2026-09-30T18:50:50Z' } },
		});
		const client = registry_client(ghcr.fetch_impl);
		expect(await client.list_tags(REPO)).toEqual(['0.1.0', 'latest', '0.1.1', '0.2.0']);
		expect(await client.created(REPO, '0.2.0')).toBe('2026-09-30T18:50:50Z');
		// Un solo token por repo, y va en cada petición al registro.
		expect(ghcr.calls.filter((c) => c.url.includes('/token')).length).toBe(1);
		expect(ghcr.calls.filter((c) => c.url.includes('/v2/')).every((c) => c.auth === 'Bearer T')).toBe(true);
		expect(ghcr.calls.find((c) => c.url.endsWith('/manifests/0.2.0'))!.accept).toContain(
			'application/vnd.oci.image.index.v1+json',
		);
	});

	test('un paquete privado o caído es un error, no una lista vacía', async () => {
		const ghcr = fake_ghcr({ [`/token?scope=repository:${REPO}:pull`]: { body: { token: 'T' } } });
		await expect(registry_client(ghcr.fetch_impl).list_tags(REPO)).rejects.toThrow('http 404');
	});
});

// ---- La pasada contra un Postgres en memoria.

type Row = {
	technical_id: string;
	installed: boolean;
	status: string;
	installed_image: string | null;
	discovered_image: string | null;
	discovered_created_at: string | null;
	discovered_note: string | null;
};

function fake_sql(rows: Row[]) {
	const by = new Map(rows.map((r) => [r.technical_id, { ...r }]));
	const sql = {
		async unsafe(query: string, params: unknown[] = []) {
			if (query.includes('SELECT') && query.includes('public.subject_installs')) {
				return [...by.values()].map((r) => ({ ...r }));
			}
			if (query.includes('discovered_image = $2')) {
				// La nota la decide SQL: se conserva si la candidata no cambia.
				const row = by.get(String(params[0]));
				if (row) {
					if (row.discovered_image !== params[1]) row.discovered_note = null;
					row.discovered_image = params[1] as string | null;
					row.discovered_created_at = params[2] as string | null;
				}
			}
			return [];
		},
	} as unknown as Bun.SQL;
	return { sql, by };
}

function sub(slug: string, tag: string): SubjectInfo {
	return {
		slug,
		name: slug,
		path: `/${slug}`,
		menu_ref: `${slug}-menu-root`,
		technical_id: `subject-${slug}`,
		image: `ghcr.io/opus-perpetuus/subject-${slug}:${tag}`,
		modules: [],
	};
}

function row(slug: string, extra: Partial<Row> = {}): Row {
	return {
		technical_id: `subject-${slug}`,
		installed: true,
		status: 'installed',
		installed_image: null,
		discovered_image: null,
		discovered_created_at: null,
		discovered_note: null,
		...extra,
	};
}

function client(tags: Record<string, string[] | Error>, created = '2026-09-30T00:00:00Z') {
	const asked: string[] = [];
	const c: RegistryClient = {
		async list_tags(repo) {
			const slug = repo.split('subject-')[1]!;
			const t = tags[slug];
			if (t instanceof Error) throw t;
			return t ?? [];
		},
		async created(repo, tag) {
			asked.push(`${repo.split('subject-')[1]}:${tag}`);
			return created;
		},
	};
	return { c, asked };
}

describe('descubrir versiones', () => {
	const ORIGINAL = process.env.SUBJECT_RUNTIME;
	beforeEach(() => {
		process.env.SUBJECT_RUNTIME = 'docker';
	});
	afterEach(() => {
		if (ORIGINAL == null) delete process.env.SUBJECT_RUNTIME;
		else process.env.SUBJECT_RUNTIME = ORIGINAL;
	});

	test('guarda la más nueva que el pin; salta base, no instaladas y el registro caído', async () => {
		const db = fake_sql([
			row('herramientas'),
			row('configuracion'),
			row('tienda', { installed: false }),
			row('pos'),
		]);
		const store = {
			subjects: [sub('herramientas', '0.1.1'), sub('configuracion', '0.1.2'), sub('tienda', '0.10.3'), sub('pos', '0.3.1')],
		} as unknown as ImperiumStore;
		const { c } = client({
			herramientas: ['0.1.0', 'latest', '0.1.1', '0.2.0', '1.0.0'],
			configuracion: ['0.1.2', '13.26.0'],
			tienda: ['0.10.4'],
			pos: new Error('http 503'),
		});
		const result = await discover_subject_versions(store, db.sql, c);
		expect(result.found).toEqual(['herramientas→0.2.0']);
		expect(result.errors).toEqual([{ slug: 'pos', error: 'Error: http 503' }]);
		expect(db.by.get('subject-herramientas')).toMatchObject({
			discovered_image: 'ghcr.io/opus-perpetuus/subject-herramientas:0.2.0',
			discovered_created_at: '2026-09-30T00:00:00Z',
		});
		expect(db.by.get('subject-configuracion')!.discovered_image).toBeNull();
		expect(db.by.get('subject-tienda')!.discovered_image).toBeNull();
	});

	test('la misma candidata conserva su nota y su fecha sin volver a preguntar', async () => {
		const image = 'ghcr.io/opus-perpetuus/subject-pos:0.4.0';
		const db = fake_sql([
			row('pos', { discovered_image: image, discovered_created_at: '2026-09-01T00:00:00Z', discovered_note: 'needs_catalog' }),
		]);
		const store = { subjects: [sub('pos', '0.3.1')] } as unknown as ImperiumStore;
		const { c, asked } = client({ pos: ['0.3.1', '0.4.0'] });
		await discover_subject_versions(store, db.sql, c);
		expect(asked).toEqual([]);
		expect(db.by.get('subject-pos')).toMatchObject({
			discovered_image: image,
			discovered_created_at: '2026-09-01T00:00:00Z',
			discovered_note: 'needs_catalog',
		});
	});

	test('una candidata nueva limpia la nota; si el pin la alcanza se borra', async () => {
		const db = fake_sql([
			row('pos', { discovered_image: 'ghcr.io/opus-perpetuus/subject-pos:0.4.0', discovered_note: 'needs_catalog' }),
			row('rh', { discovered_image: 'ghcr.io/opus-perpetuus/subject-rh:0.2.3' }),
		]);
		const store = { subjects: [sub('pos', '0.3.1'), sub('rh', '0.2.3')] } as unknown as ImperiumStore;
		const { c, asked } = client({ pos: ['0.4.0', '0.4.1'], rh: ['0.2.2', '0.2.3'] });
		await discover_subject_versions(store, db.sql, c);
		expect(asked).toEqual(['pos:0.4.1']);
		expect(db.by.get('subject-pos')).toMatchObject({
			discovered_image: 'ghcr.io/opus-perpetuus/subject-pos:0.4.1',
			discovered_note: null,
		});
		expect(db.by.get('subject-rh')!.discovered_image).toBeNull();
	});

	test('sin red hacia el registro deja de preguntar a la primera', async () => {
		const db = fake_sql([row('pos'), row('rh'), row('ventas')]);
		const store = { subjects: [sub('pos', '0.3.1'), sub('rh', '0.2.2'), sub('ventas', '0.3.1')] } as unknown as ImperiumStore;
		let calls = 0;
		const c: RegistryClient = {
			async list_tags() {
				calls += 1;
				throw new RegistryUnreachableError('Unable to connect');
			},
			async created() {
				return null;
			},
		};
		const result = await discover_subject_versions(store, db.sql, c);
		expect(calls).toBe(1);
		expect(result.errors.length).toBe(1);
	});

	test('un fallo de red del cliente real es RegistryUnreachableError; un HTTP de error no', async () => {
		const offline = registry_client(async () => {
			throw new TypeError('Unable to connect');
		});
		await expect(offline.list_tags(REPO)).rejects.toBeInstanceOf(RegistryUnreachableError);
		const ghcr = fake_ghcr({ [`/token?scope=repository:${REPO}:pull`]: { body: { token: 'T' } } });
		const err = await registry_client(ghcr.fetch_impl).list_tags(REPO).catch((e) => e);
		expect(err).not.toBeInstanceOf(RegistryUnreachableError);
	});

	test('sin Docker no pregunta al registro', async () => {
		process.env.SUBJECT_RUNTIME = 'off';
		const db = fake_sql([row('pos')]);
		const store = { subjects: [sub('pos', '0.3.1')] } as unknown as ImperiumStore;
		const { c } = client({ pos: new Error('no debió preguntar') });
		expect(await discover_subject_versions(store, db.sql, c)).toEqual({ checked: 0, found: [], errors: [] });
	});
});
