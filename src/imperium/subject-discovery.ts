/**
 * Descubre en el registro (GHCR) la versión más nueva de cada app instalada.
 *
 * El pin del catálogo ya lo mueve n8n en el repo en cuanto una app publica,
 * pero un servidor sigue con el catálogo con el que arrancó su núcleo hasta el
 * siguiente update de Odoo. Aquí el núcleo pregunta al registro y guarda la
 * versión más nueva del mismo major que el pin; cuál se instala y cuándo lo
 * decide subject-versions.ts (el pin queda como mínimo y respaldo).
 *
 * Sin Docker no se consulta nada: no habría cómo instalar lo que se encuentre.
 * Un registro caído o sin red deja lo que ya se sabía: nunca es un error.
 */
import type { ImperiumStore } from './store.ts';
import { docker_runtime_wanted } from './subject-runtime.ts';
import {
	discovered_versions,
	record_discovered_version,
} from './subjects-admin.ts';
import {
	APPS_AL_PIN,
	image_parts,
	image_with_tag,
	is_newer_same_major,
	newest_same_major,
} from './subject-versions.ts';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `SUBJECT_REGISTRY_URL`: otro registro con la API de GHCR (`/token` anónimo y
 * repos `ghcr.io/…`), o uno falso en pruebas. Un `registry:2` de espejo no la
 * tiene.
 */
function registry_base(): string {
	return (process.env.SUBJECT_REGISTRY_URL || 'https://ghcr.io').replace(/\/+$/, '');
}
const TIMEOUT_MS = 10_000;
/** Tope de páginas de `tags/list`: con 1000 por página, una app tendría que publicar a diario durante años. */
const MAX_PAGES = 10;

const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function host_arch(): string {
	return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

/**
 * Sin red hacia el registro (no un HTTP de error): un servidor que descarta la
 * salida en silencio esperaría el tope por cada app, y «Buscar» tardaría minutos.
 */
export class RegistryUnreachableError extends Error {}

type IndexEntry = {
	digest?: string;
	platform?: { os?: string; architecture?: string };
};

/**
 * Cliente anónimo de GHCR (los paquetes de las apps son públicos aunque haya
 * repos privados). Un token por repo, que el registro exige aun sin cuenta.
 */
export function registry_client(fetch_impl: FetchLike = fetch) {
	const tokens = new Map<string, string>();
	const reach = (url: string, init: RequestInit) =>
		fetch_impl(url, init).catch((err) => {
			throw new RegistryUnreachableError(err instanceof Error ? err.message : String(err));
		});

	async function token(repo: string): Promise<string> {
		const cached = tokens.get(repo);
		if (cached) return cached;
		const res = await reach(
			`${registry_base()}/token?scope=repository:${repo}:pull`,
			{ signal: AbortSignal.timeout(TIMEOUT_MS) },
		);
		if (!res.ok) throw new Error(`token http ${res.status}`);
		const json = (await res.json()) as { token?: string };
		if (!json.token) throw new Error('token vacío');
		tokens.set(repo, json.token);
		return json.token;
	}

	async function get(repo: string, path: string, accept?: string): Promise<Response> {
		const res = await reach(`${registry_base()}${path}`, {
			headers: {
				authorization: `Bearer ${await token(repo)}`,
				...(accept ? { accept } : {}),
			},
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`${path}: http ${res.status}`);
		return res;
	}

	return {
		async list_tags(repo: string): Promise<string[]> {
			const tags: string[] = [];
			let path: string | null = `/v2/${repo}/tags/list?n=1000`;
			for (let page = 0; path && page < MAX_PAGES; page++) {
				const res = await get(repo, path);
				const json = (await res.json()) as { tags?: unknown };
				if (Array.isArray(json.tags)) tags.push(...json.tags.map(String));
				const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '');
				path = next ? next[1]! : null;
			}
			return tags;
		},

		/**
		 * Cuándo se construyó la imagen (`created` de su config). Las apps se
		 * publican como índice OCI con una atestación: se toma la de esta
		 * arquitectura.
		 */
		async created(repo: string, tag: string): Promise<string | null> {
			let manifest = (await (
				await get(repo, `/v2/${repo}/manifests/${tag}`, MANIFEST_ACCEPT)
			).json()) as { manifests?: IndexEntry[]; config?: { digest?: string } };
			if (Array.isArray(manifest.manifests)) {
				const entry = manifest.manifests.find(
					(m) => m.platform?.os === 'linux' && m.platform.architecture === host_arch(),
				);
				if (!entry?.digest) return null;
				manifest = (await (
					await get(repo, `/v2/${repo}/manifests/${entry.digest}`, MANIFEST_ACCEPT)
				).json()) as typeof manifest;
			}
			const digest = manifest.config?.digest;
			if (!digest) return null;
			const config = (await (await get(repo, `/v2/${repo}/blobs/${digest}`)).json()) as {
				created?: string;
			};
			return typeof config.created === 'string' ? config.created : null;
		},
	};
}

export type RegistryClient = ReturnType<typeof registry_client>;

export type DiscoveryResult = {
	checked: number;
	/** `slug→X.Y.Z` de las apps con una versión más nueva que su pin. */
	found: string[];
	errors: Array<{ slug: string; error: string }>;
};

/**
 * Una pasada: para cada app instalada (menos las que el deploy recrea al pin)
 * guarda la versión más nueva del registro si supera al pin, o borra la que
 * hubiera si ya no la supera. `created` solo se pide cuando la candidata
 * cambia; la nota `needs_catalog` la conserva SQL mientras la candidata sea la
 * misma.
 */
export async function discover_subject_versions(
	store: ImperiumStore,
	sql: Bun.SQL,
	client: RegistryClient = registry_client(),
): Promise<DiscoveryResult> {
	const out: DiscoveryResult = { checked: 0, found: [], errors: [] };
	if (!docker_runtime_wanted()) return out;
	const known = await discovered_versions(sql);
	for (const sub of store.subjects) {
		if (APPS_AL_PIN.has(sub.slug)) continue;
		const rec = known.get(sub.technical_id);
		if (!rec?.installed) continue;
		const pin = image_parts(sub.image);
		if (!pin) continue;
		out.checked += 1;
		let tags: string[];
		try {
			tags = await client.list_tags(pin.repo);
		} catch (err) {
			out.errors.push({ slug: sub.slug, error: String(err) });
			if (err instanceof RegistryUnreachableError) break;
			continue;
		}
		const newest = newest_same_major(tags, pin.tag);
		if (!newest || !is_newer_same_major(newest, pin.tag)) {
			if (rec.discovered_image) {
				await record_discovered_version(sql, sub.technical_id, null, null);
			}
			continue;
		}
		const image = image_with_tag(sub.image, newest)!;
		const same = rec.discovered_image === image;
		let created = same ? rec.discovered_created_at : null;
		if (!created) {
			created = await client.created(pin.repo, newest).catch(() => null);
		}
		await record_discovered_version(sql, sub.technical_id, image, created);
		out.found.push(`${sub.slug}→${newest}`);
	}
	return out;
}
