import type { ImperiumStore } from './store.ts';
import { compare_semver, parse_semver, read_config_value, type Semver } from './subject-versions.ts';

/**
 * Fuentes de imágenes de apps. El parámetro de sistema lo edita el mismo
 * control que el resto de la configuración (Odoo / Módulos). El token no se
 * guarda: solo entra como argumento del escaneo.
 */
export const IMAGE_SOURCES_CONFIG_REF = 'configuration-subject-image-sources';

export type ImageSourceSpec = {
	org: string;
	/** Privada: sin token el escaneo falla y no devuelve paquetes. */
	private: boolean;
};

export type ScannedPackage = {
	name: string;
	org: string;
	version: string | null;
};

export type RegisteredSubject = {
	technical_id: string;
	slug: string;
	name?: string;
	image: string;
	active?: boolean;
	depends_on?: string[];
};

export type PackageListResponse = {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
};

export type PackageClient = (input: {
	url: string;
	headers: Record<string, string>;
}) => Promise<PackageListResponse>;

const APP_NAME = /^subject-[a-z0-9-]+$/;
const ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export const DEFAULT_IMAGE_SOURCES: readonly ImageSourceSpec[] = [
	{ org: 'opus-perpetuus', private: false },
	{ org: 'codice-progressio', private: false },
];

let sources: ImageSourceSpec[] = DEFAULT_IMAGE_SOURCES.map((source) => ({ ...source }));

function clone_sources(list: readonly ImageSourceSpec[]): ImageSourceSpec[] {
	return list.map((source) => ({ ...source }));
}

export function current_image_sources(): ImageSourceSpec[] {
	return clone_sources(sources);
}

/**
 * Lista que escribe el control. Vacío: las dos organizaciones públicas.
 * Un segundo payload reemplaza la lista; no se le suma.
 */
export function apply_odoo_image_sources(payload: unknown): ImageSourceSpec[] {
	if (typeof payload !== 'string' || !payload.trim()) {
		sources = clone_sources(DEFAULT_IMAGE_SOURCES);
		return current_image_sources();
	}
	const parsed = parse_image_sources(payload);
	if (!parsed.length) {
		throw new Error('fuente de imágenes ilegible');
	}
	sources = parsed;
	return current_image_sources();
}

/** Lee «ghcr:org [private]» separadas por «;» o renglón, sin tocar la lista vigente. */
export function parse_image_sources(payload: string): ImageSourceSpec[] {
	const parsed: ImageSourceSpec[] = [];
	const seen = new Set<string>();
	for (const raw of payload.split(/[;\n]/)) {
		const parts = raw.trim().split(/\s+/).filter(Boolean);
		if (!parts.length) continue;
		const token = parts[0]!;
		if (!token.startsWith('ghcr:')) continue;
		const org = token.slice('ghcr:'.length).trim();
		if (!ORG_RE.test(org) || seen.has(org.toLowerCase())) continue;
		seen.add(org.toLowerCase());
		const is_private = parts.slice(1).some((part) => part === 'private' || part === 'privado');
		parsed.push({ org, private: is_private });
	}
	return parsed;
}

export function format_image_sources(list: readonly ImageSourceSpec[]): string {
	return list.map((source) => `ghcr:${source.org}${source.private ? ' private' : ''}`).join('; ');
}

export async function apply_image_sources_from_store(
	store: ImperiumStore,
): Promise<ImageSourceSpec[]> {
	// Inactivo = Odoo apagó el autoescaneo: «Buscar» vuelve a las dos públicas.
	if (store.has('configuration')) {
		const row = await store.find_where('configuration', { _ref: IMAGE_SOURCES_CONFIG_REF }).catch(() => null);
		if (row && row.is_active === false) return apply_odoo_image_sources('');
	}
	return apply_odoo_image_sources(await read_config_value(store, IMAGE_SOURCES_CONFIG_REF));
}

const INDEX_PAGE_CAP = 10;
const TAG_PAGE_CAP = 10;
const PACKAGE_HREF = /\/packages\/container\/package\/([A-Za-z0-9._-]+)/g;

function index_url(org: string): string {
	return `https://github.com/orgs/${org}/packages?ecosystem=container`;
}

function registry_token_url(org: string, name: string): string {
	return `https://ghcr.io/token?service=ghcr.io&scope=repository:${org}/${name}:pull`;
}

function tags_url(org: string, name: string): string {
	return `https://ghcr.io/v2/${org}/${name}/tags/list?n=1000`;
}

function private_packages_url(org: string): string {
	return `https://api.github.com/orgs/${org}/packages?package_type=container`;
}

async function request_source(
	client: PackageClient,
	source: ImageSourceSpec,
	url: string,
	headers: Record<string, string>,
): Promise<PackageListResponse> {
	const response = await client({ url, headers });
	if (response.status === 401 || response.status === 403) {
		throw new Error(`el registro negó el listado de ghcr:${source.org} (${response.status})`);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`el registro falló al listar ghcr:${source.org} (${response.status})`);
	}
	return response;
}

function subject_names(body: unknown): string[] {
	if (typeof body !== 'string') return [];
	const names: string[] = [];
	const seen = new Set<string>();
	for (const match of body.matchAll(PACKAGE_HREF)) {
		const name = match[1]!.toLowerCase();
		if (!APP_NAME.test(name) || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names;
}

function next_index_url(body: unknown, current: string): string | null {
	if (typeof body !== 'string') return null;
	for (const tag of body.match(/<a\b[^>]*>/gi) ?? []) {
		if (!/\brel="[^"]*\bnext\b/i.test(tag)) continue;
		const href = /\bhref="([^"]+)"/i.exec(tag)?.[1]?.replaceAll('&amp;', '&');
		if (!href) return null;
		try {
			const next = new URL(href, current).href;
			return next === current ? null : next;
		} catch {
			return null;
		}
	}
	return null;
}

function registry_bearer(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const token = (body as { token?: unknown }).token;
	return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function tag_list(body: unknown): string[] {
	if (!body || typeof body !== 'object') return [];
	const tags = (body as { tags?: unknown }).tags;
	return Array.isArray(tags) ? tags.map((tag) => String(tag)) : [];
}

function next_link(header: string | undefined, current: string): string | null {
	if (!header) return null;
	const match = /<([^>]+)>;\s*rel="next"/i.exec(header);
	if (!match?.[1]) return null;
	try {
		const next = new URL(match[1], current).href;
		return next === current ? null : next;
	} catch {
		return null;
	}
}

function highest_semver(tags: readonly string[]): string | null {
	let best: { tag: string; sem: Semver } | null = null;
	for (const tag of tags) {
		const sem = parse_semver(tag);
		if (!sem) continue;
		if (!best || compare_semver(sem, best.sem) > 0) best = { tag, sem };
	}
	return best?.tag ?? null;
}

/**
 * Índice HTML público (sin token de GitHub) y, por cada app, el token anónimo
 * que GHCR exige para leer tags. El bearer de ese token no es el de GitHub.
 */
async function scan_public(
	client: PackageClient,
	source: ImageSourceSpec,
): Promise<ScannedPackage[]> {
	const names: string[] = [];
	const seen = new Set<string>();
	const seen_pages = new Set<string>();
	let url: string | null = index_url(source.org);
	for (let page = 0; url && page < INDEX_PAGE_CAP && !seen_pages.has(url); page++) {
		seen_pages.add(url);
		const response = await request_source(client, source, url, { Accept: 'text/html' });
		for (const name of subject_names(response.body)) {
			if (seen.has(name)) continue;
			seen.add(name);
			names.push(name);
		}
		url = next_index_url(response.body, url);
	}
	const found: ScannedPackage[] = [];
	for (const name of names) {
		const token_response = await request_source(
			client,
			source,
			registry_token_url(source.org, name),
			{ Accept: 'application/json' },
		);
		const bearer = registry_bearer(token_response.body);
		if (!bearer) {
			throw new Error(`el registro falló al listar ghcr:${source.org} (token vacío)`);
		}
		const tags: string[] = [];
		const seen_tags = new Set<string>();
		let tags_page: string | null = tags_url(source.org, name);
		for (let page = 0; tags_page && page < TAG_PAGE_CAP && !seen_tags.has(tags_page); page++) {
			seen_tags.add(tags_page);
			const response = await request_source(client, source, tags_page, {
				Accept: 'application/json',
				Authorization: `Bearer ${bearer}`,
			});
			tags.push(...tag_list(response.body));
			tags_page = next_link(response.headers?.link, tags_page);
		}
		found.push({ name, org: source.org, version: highest_semver(tags) });
	}
	return found;
}

async function scan_private(
	client: PackageClient,
	source: ImageSourceSpec,
	token: string,
): Promise<ScannedPackage[]> {
	const response = await request_source(client, source, private_packages_url(source.org), {
		Accept: 'application/vnd.github+json',
		Authorization: `Bearer ${token}`,
	});
	const rows = Array.isArray(response.body) ? response.body : [];
	const found: ScannedPackage[] = [];
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue;
		const name = String((row as { name?: unknown }).name ?? '');
		if (!APP_NAME.test(name)) continue;
		const version = (row as { version?: unknown }).version;
		found.push({
			name,
			org: source.org,
			version: typeof version === 'string' && version.trim() ? version.trim() : null,
		});
	}
	return found;
}

/**
 * Lista paquetes de las fuentes vigentes. Una pública no manda el token de
 * GitHub. Si el registro niega el listado, el error queda aquí y no hay
 * paquetes que mezclar. Una privada sin token falla antes de llamar.
 */
export async function scan_image_sources(input: {
	client: PackageClient;
	token?: string | null;
	sources?: readonly ImageSourceSpec[];
}): Promise<ScannedPackage[]> {
	const list = input.sources ?? current_image_sources();
	const token = String(input.token ?? '').trim();
	const found: ScannedPackage[] = [];
	for (const source of list) {
		if (source.private && !token) {
			throw new Error(`token requerido para ghcr:${source.org}`);
		}
		const rows = source.private
			? await scan_private(input.client, source, token)
			: await scan_public(input.client, source);
		found.push(...rows);
	}
	return found;
}

export type CatalogImageScan = {
	client: PackageClient;
	token?: string | null;
	/** Un GET repetido no vuelve a pedir el registro durante un minuto. */
	cache?: boolean;
};

/**
 * Escaneo que pide un administrador (`POST /subjects/catalog/scan`).
 * El token de GitHub sale solo del entorno (`GITHUB_TOKEN` o `GH_TOKEN`),
 * nunca de la lista de fuentes.
 */
export function live_catalog_scan(): CatalogImageScan {
	const token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
	return { client: fetch_package_client(), token, cache: true };
}

/** El índice público es HTML; el token y los tags de GHCR son JSON. */
export function fetch_package_client(fetch_impl: typeof fetch = fetch): PackageClient {
	return async ({ url, headers }) => {
		const response = await fetch_impl(url, {
			headers,
			signal: AbortSignal.timeout(20_000),
		});
		const text = await response.text();
		const trimmed = text.trim();
		let body: unknown = text;
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				body = JSON.parse(trimmed) as unknown;
			} catch {
				body = text;
			}
		}
		const link = response.headers.get('link');
		return { status: response.status, body, headers: link ? { link } : {} };
	};
}

function image_of(org: string, name: string, version: string | null): string {
	return version ? `ghcr.io/${org}/${name}:${version}` : `ghcr.io/${org}/${name}`;
}

/**
 * Incorpora o refresca apps Imperium. Lo que el escaneo no ve sigue registrado
 * y activo: un listado no desinstala. Sin tag nuevo se conserva el tag que ya
 * tenía la imagen y se actualiza el repositorio.
 */
export function merge_scanned_subjects<T extends RegisteredSubject>(
	existing: readonly T[],
	scanned: readonly ScannedPackage[],
): T[] {
	const next = existing.map((subject) => ({ ...subject }));
	const by_tid = new Map(next.map((subject) => [subject.technical_id, subject]));
	for (const pkg of scanned) {
		if (!APP_NAME.test(pkg.name)) continue;
		const previous = by_tid.get(pkg.name);
		if (!previous) {
			const created = {
				technical_id: pkg.name,
				slug: pkg.name.replace(/^subject-/, ''),
				name: pkg.name.replace(/^subject-/, ''),
				image: image_of(pkg.org, pkg.name, pkg.version),
				active: true,
				depends_on: [],
			} as T;
			next.push(created);
			by_tid.set(pkg.name, created);
			continue;
		}
		if (!pkg.version && previous.image.includes(':')) {
			const tag = previous.image.split(':').pop();
			previous.image = `ghcr.io/${pkg.org}/${pkg.name}:${tag}`;
		} else {
			previous.image = image_of(pkg.org, pkg.name, pkg.version);
		}
	}
	return next;
}

/**
 * Escanea y, solo si el listado respondió, mezcla. Un fallo no toca el registro.
 */
export async function refresh_subjects_from_image_sources<T extends RegisteredSubject>(
	existing: readonly T[],
	input: {
		client: PackageClient;
		token?: string | null;
		sources?: readonly ImageSourceSpec[];
	},
): Promise<T[]> {
	const scanned = await scan_image_sources(input);
	return merge_scanned_subjects(existing, scanned);
}
