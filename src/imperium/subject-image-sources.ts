import type { ImperiumStore } from './store.ts';
import { compare_semver, parse_semver, read_config_value, type Semver } from './subject-versions.ts';

/**
 * Fuentes de apps. Dos tipos:
 * - `github:org` / `github:org/repo`: repositorios Git. Cada repo
 *   `imperium-subject-*` / `subject-*` es una app; su `manifest.json` (rama por
 *   defecto) da nombre, versión, imagen y dependencias. Sin versión en el
 *   manifest se usa el tag semver más alto del repo.
 * - `ghcr:org`: paquetes de contenedor de la organización en GHCR (la imagen
 *   es solo el artefacto de la app; complementa a los repos).
 * El parámetro de sistema lo edita Odoo (modo odoo) o Módulos (modo self). El
 * token no se guarda: sale del entorno y solo entra como argumento del escaneo.
 */
export const IMAGE_SOURCES_CONFIG_REF = 'configuration-subject-image-sources';

export type ImageSourceKind = 'ghcr' | 'github';

export type ImageSourceSpec = {
	org: string;
	/** Privada: sin token el escaneo falla y no devuelve paquetes. */
	private: boolean;
	/** Sin tipo = `ghcr` (lo que mandaba Odoo antes de los repos Git). */
	kind?: ImageSourceKind;
	/** Solo `github:org/repo`: un repo concreto en vez de toda la organización. */
	repo?: string;
};

export type ScannedPackage = {
	name: string;
	org: string;
	version: string | null;
	/** Repo de la imagen sin tag (`ghcr.io/org/subject-x`); sin él, `ghcr.io/<org>/<name>`. */
	image_repo?: string;
	/** Del `manifest.json` del repo Git: así el autoescaneo no baja la imagen para leerlo. */
	display_name?: string;
	depends_on?: string[];
	/** De dónde salió: `github.com/org/repo` o `ghcr.io/org/name`. */
	source_ref?: string;
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
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Repos Git que son apps: `imperium-subject-x` o `subject-x`. */
const APP_REPO = /^(?:imperium-)?(subject-[a-z0-9-]+)$/;

export function source_kind(source: ImageSourceSpec): ImageSourceKind {
	return source.kind === 'github' ? 'github' : 'ghcr';
}

/** `ghcr:org`, `github:org` o `github:org/repo` (sin «private»). */
export function source_label(source: ImageSourceSpec): string {
	const kind = source_kind(source);
	return `${kind}:${source.org}${kind === 'github' && source.repo ? `/${source.repo}` : ''}`;
}

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

/** Una fuente suelta (`ghcr:org`, `github:org`, `github:org/repo`) o `null` si no es legible. */
export function parse_image_source(token: string, is_private = false): ImageSourceSpec | null {
	const match = /^(ghcr|github):(.+)$/.exec(token.trim());
	if (!match) return null;
	const kind = match[1] as ImageSourceKind;
	const rest = match[2]!.trim();
	if (kind === 'ghcr') {
		return ORG_RE.test(rest) ? { org: rest, private: is_private } : null;
	}
	const [org, repo, extra] = rest.split('/');
	if (!org || !ORG_RE.test(org) || extra !== undefined) return null;
	if (repo !== undefined && !REPO_RE.test(repo)) return null;
	return repo
		? { org, private: is_private, kind: 'github', repo }
		: { org, private: is_private, kind: 'github' };
}

/**
 * Lee «ghcr:org [private]», «github:org [private]» y «github:org/repo»
 * separadas por «;» o renglón, sin tocar la lista vigente.
 */
export function parse_image_sources(payload: string): ImageSourceSpec[] {
	const parsed: ImageSourceSpec[] = [];
	const seen = new Set<string>();
	for (const raw of payload.split(/[;\n]/)) {
		const parts = raw.trim().split(/\s+/).filter(Boolean);
		if (!parts.length) continue;
		const is_private = parts.slice(1).some((part) => part === 'private' || part === 'privado');
		const source = parse_image_source(parts[0]!, is_private);
		if (!source) continue;
		const key = source_label(source).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		parsed.push(source);
	}
	return parsed;
}

export function format_image_sources(list: readonly ImageSourceSpec[]): string {
	return list.map((source) => `${source_label(source)}${source.private ? ' private' : ''}`).join('; ');
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
	/** Ya pedida: solo se valida. */
	prefetched?: PackageListResponse,
): Promise<PackageListResponse> {
	const response = prefetched ?? (await client({ url, headers }));
	const label = source_label(source);
	if (response.status === 401 || response.status === 403) {
		const hint =
			source_kind(source) === 'github' && !headers.Authorization
				? '; sin token GitHub limita las consultas: define IMPERIUM_GITHUB_TOKEN'
				: '';
		throw new Error(`el registro negó el listado de ${label} (${response.status})${hint}`);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`el registro falló al listar ${label} (${response.status})`);
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

const REPO_PAGE_CAP = 10;
const MAX_REPOS_PER_SOURCE = 200;

function github_headers(token: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	return headers;
}

type GithubRepoRow = { name: string; full_name: string; default_branch: string };

function repo_rows(body: unknown): GithubRepoRow[] {
	const rows = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
	const out: GithubRepoRow[] = [];
	for (const row of rows) {
		if (!row || typeof row !== 'object') continue;
		const r = row as Record<string, unknown>;
		if (r.archived === true || r.disabled === true) continue;
		const name = String(r.name ?? '');
		const full_name = String(r.full_name ?? '');
		if (!name || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(full_name)) continue;
		out.push({ name, full_name, default_branch: String(r.default_branch || 'main') });
	}
	return out;
}

/** Repos de la fuente: uno (`github:org/repo`) o todos los de la org (o usuario). */
async function list_github_repos(
	client: PackageClient,
	source: ImageSourceSpec,
	headers: Record<string, string>,
): Promise<GithubRepoRow[]> {
	if (source.repo) {
		const response = await request_source(
			client,
			source,
			`https://api.github.com/repos/${source.org}/${source.repo}`,
			headers,
		);
		return repo_rows(response.body);
	}
	let url: string | null = `https://api.github.com/orgs/${source.org}/repos?per_page=100&type=all`;
	let response = await client({ url, headers });
	// Una cuenta de usuario no tiene `/orgs/<x>/repos`.
	if (response.status === 404) {
		url = `https://api.github.com/users/${source.org}/repos?per_page=100&type=owner`;
		response = await request_source(client, source, url, headers);
	} else {
		response = await request_source(client, source, url, headers, response);
	}
	const rows: GithubRepoRow[] = [];
	const seen = new Set<string>();
	for (let page = 0; url && page < REPO_PAGE_CAP && !seen.has(url); page++) {
		seen.add(url);
		if (page > 0) response = await request_source(client, source, url, headers);
		rows.push(...repo_rows(response.body));
		if (rows.length >= MAX_REPOS_PER_SOURCE) break;
		url = next_link(response.headers?.link, url);
	}
	return rows;
}

function parse_json_body(body: unknown): Record<string, unknown> | null {
	let value = body;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return null;
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * `manifest.json` de la rama por defecto. Con token, por la API (sirve para
 * repos privados); sin token, por raw.githubusercontent.com, que no gasta el
 * cupo de 60 consultas por hora de la API anónima. `null` si no hay.
 */
async function read_repo_manifest(
	client: PackageClient,
	repo: GithubRepoRow,
	token: string,
): Promise<Record<string, unknown> | null> {
	const response = token
		? await client({
				url: `https://api.github.com/repos/${repo.full_name}/contents/manifest.json?ref=${encodeURIComponent(repo.default_branch)}`,
				headers: { ...github_headers(token), Accept: 'application/vnd.github.raw+json' },
			}).catch(() => null)
		: await client({
				url: `https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(repo.default_branch)}/manifest.json`,
				headers: { Accept: 'application/json' },
			}).catch(() => null);
	if (!response || response.status < 200 || response.status >= 300) return null;
	return parse_json_body(response.body);
}

/** Tag semver más alto del repo (`v1.2.3` o `1.2.3`), sin la «v». */
async function highest_repo_tag(
	client: PackageClient,
	repo: GithubRepoRow,
	headers: Record<string, string>,
): Promise<string | null> {
	const response = await client({
		url: `https://api.github.com/repos/${repo.full_name}/tags?per_page=100`,
		headers,
	}).catch(() => null);
	if (!response || response.status < 200 || response.status >= 300 || !Array.isArray(response.body)) {
		return null;
	}
	const names = response.body
		.map((row) => String((row as { name?: unknown })?.name ?? '').replace(/^v/i, ''))
		.filter(Boolean);
	return highest_semver(names);
}

/** `ghcr.io/org/subject-x:1.2.3` o `…@sha256:…` → `ghcr.io/org/subject-x`. */
function image_repo_of(image: unknown): string | null {
	const text = String(image ?? '').trim().toLowerCase();
	if (!text) return null;
	const no_digest = text.split('@')[0]!;
	const slash = no_digest.lastIndexOf('/');
	const colon = no_digest.lastIndexOf(':');
	const repo = colon > slash ? no_digest.slice(0, colon) : no_digest;
	return /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/.test(repo) ? repo : null;
}

/**
 * Apps de repos Git: cada repo `imperium-subject-*` / `subject-*` (no
 * archivado). El manifest da id técnico, nombre, versión, imagen y
 * dependencias; la imagen de GHCR es solo el artefacto. Un repo sin manifest
 * ni tags semver se informa sin versión (como un paquete sin tags).
 */
async function scan_github(
	client: PackageClient,
	source: ImageSourceSpec,
	token: string,
): Promise<ScannedPackage[]> {
	const headers = github_headers(token);
	const repos = await list_github_repos(client, source, headers);
	const found: ScannedPackage[] = [];
	const seen = new Set<string>();
	for (const repo of repos) {
		const match = APP_REPO.exec(repo.name.toLowerCase());
		if (!match) continue;
		const manifest = await read_repo_manifest(client, repo, token);
		const declared = String(manifest?.technicalId ?? manifest?.technical_id ?? '').trim().toLowerCase();
		const name = APP_NAME.test(declared) ? declared : match[1]!;
		if (seen.has(name)) continue;
		seen.add(name);
		const declared_version = String(manifest?.version ?? '').trim().replace(/^v/i, '');
		const version = parse_semver(declared_version)
			? declared_version
			: await highest_repo_tag(client, repo, headers);
		const org = repo.full_name.split('/')[0]!.toLowerCase();
		const display = typeof manifest?.name === 'string' && manifest.name.trim() ? manifest.name.trim().slice(0, 120) : undefined;
		const raw_deps = manifest?.dependsOn ?? manifest?.depends_on;
		const depends_on = Array.isArray(raw_deps)
			? raw_deps.map((dep) => String(dep)).filter((dep) => APP_NAME.test(dep))
			: undefined;
		found.push({
			name,
			org,
			version,
			image_repo: image_repo_of(manifest?.image) ?? `ghcr.io/${org}/${name}`,
			...(display ? { display_name: display } : {}),
			...(depends_on ? { depends_on } : {}),
			source_ref: `github.com/${repo.full_name}`,
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
			throw new Error(`token requerido para ${source_label(source)}`);
		}
		const rows =
			source_kind(source) === 'github'
				? await scan_github(input.client, source, token)
				: source.private
					? await scan_private(input.client, source, token)
					: await scan_public(input.client, source);
		found.push(...rows);
	}
	// La app de un repo Git manda sobre el mismo paquete visto en GHCR (la
	// imagen solo es su artefacto): así no se pisa nombre, imagen ni dependencias.
	const from_git = new Set(found.filter((pkg) => pkg.source_ref?.startsWith('github.com/')).map((pkg) => pkg.name));
	return found.filter((pkg) => !from_git.has(pkg.name) || pkg.source_ref?.startsWith('github.com/'));
}

export type CatalogImageScan = {
	client: PackageClient;
	token?: string | null;
	/** Un GET repetido no vuelve a pedir el registro durante un minuto. */
	cache?: boolean;
};

/**
 * Escaneo que pide un administrador (`POST /subjects/catalog/scan`).
 * El token de GitHub sale solo del entorno (`IMPERIUM_GITHUB_TOKEN`,
 * `GITHUB_TOKEN` o `GH_TOKEN`),
 * nunca de la lista de fuentes.
 */
export function live_catalog_scan(): CatalogImageScan {
	return { client: fetch_package_client(), token: github_token(), cache: true };
}

/** `IMPERIUM_GITHUB_TOKEN` (el del `.env` del deploy), `GITHUB_TOKEN` o `GH_TOKEN`. */
export function github_token(env: Record<string, string | undefined> = process.env): string {
	return (env.IMPERIUM_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
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

function image_repo_for(pkg: ScannedPackage): string {
	return pkg.image_repo || `ghcr.io/${pkg.org}/${pkg.name}`;
}

function image_of(pkg: ScannedPackage): string {
	const repo = image_repo_for(pkg);
	return pkg.version ? `${repo}:${pkg.version}` : repo;
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
				name: pkg.display_name || pkg.name.replace(/^subject-/, ''),
				image: image_of(pkg),
				active: true,
				depends_on: pkg.depends_on ? [...pkg.depends_on] : [],
			} as T;
			next.push(created);
			by_tid.set(pkg.name, created);
			continue;
		}
		if (!pkg.version && previous.image.includes(':')) {
			const tag = previous.image.split(':').pop();
			previous.image = `${image_repo_for(pkg)}:${tag}`;
		} else {
			previous.image = image_of(pkg);
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
