/**
 * Qué versión de una app toca instalar: el pin del catálogo, la que el núcleo
 * descubrió en el registro (subject-discovery.ts) o la que fija el servidor.
 *
 * Sin estado ni red: todo lo que decide cuándo se actualiza una app vive aquí
 * para poder probarlo sin Docker ni Postgres.
 */
import type { ImperiumStore, SubjectInfo } from './store.ts';

/** Nota de una versión descubierta que trae dependencias o recursos que el catálogo no conoce. */
export const NEEDS_CATALOG = 'needs_catalog';

export const SUBJECT_VERSION_HOLD_REF = 'configuration-subject-version-hold';
export const SUBJECT_AUTO_UPDATE_DISCOVERED_REF =
	'configuration-subject-auto-update-discovered';
export const SUBJECT_AUTO_UPDATE_MIN_AGE_REF =
	'configuration-subject-auto-update-min-age-hours';

/** Horas que una versión descubierta espera antes de instalarse sola: da tiempo a retirarla si sale rota. */
export const DEFAULT_MIN_AGE_HOURS = 24;

/**
 * Apps que el deploy recrea al pin en cada update de producto (update-v13.sh
 * no les conserva el tag): una versión descubierta o fijada se perdería en el
 * siguiente update y SQL seguiría diciendo otra. Siguen al pin y nada más.
 * `reportes` es base para el núcleo pero no para el deploy: esa sí se descubre.
 */
export const APPS_AL_PIN: ReadonlySet<string> = new Set([
	'configuracion',
	'configuraciones-de-vista',
	'planeacion',
]);

const IMAGE_RE = /^(ghcr\.io\/opus-perpetuus\/subject-[a-z0-9-]+):([A-Za-z0-9._-]+)$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export type Semver = [number, number, number];

/** Solo `X.Y.Z`: `latest`, prereleases y tags sueltos no son versiones que se ofrezcan. */
export function parse_semver(tag: string | null | undefined): Semver | null {
	const m = SEMVER_RE.exec(String(tag ?? '').trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare_semver(a: Semver, b: Semver): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** `ghcr.io/opus-perpetuus/subject-pos:0.3.1` → repo y tag; `null` si no es una imagen de app. */
export function image_parts(
	image: string | null | undefined,
): { repo: string; tag: string } | null {
	const m = IMAGE_RE.exec(String(image ?? '').trim());
	return m ? { repo: m[1]!, tag: m[2]! } : null;
}

export function image_with_tag(image: string, tag: string): string | null {
	const parts = image_parts(image);
	return parts ? `${parts.repo}:${tag}` : null;
}

/**
 * ¿`candidate` es más nueva que `current` sin cambiar de major? Un cambio de
 * major (o un tag que no es semver) no se decide aquí: lo decide el pin.
 */
export function is_newer_same_major(
	candidate: string | null | undefined,
	current: string | null | undefined,
): boolean {
	const a = parse_semver(candidate);
	const b = parse_semver(current);
	return Boolean(a && b && a[0] === b[0] && compare_semver(a, b) > 0);
}

/** El tag `X.Y.Z` más alto con el mismo major que `base`; `null` si no hay ninguno. */
export function newest_same_major(
	tags: readonly string[],
	base: string,
): string | null {
	const major = parse_semver(base)?.[0];
	if (major == null) return null;
	let best: { tag: string; v: Semver } | null = null;
	for (const tag of tags) {
		const v = parse_semver(tag);
		if (!v || v[0] !== major) continue;
		if (!best || compare_semver(v, best.v) > 0) best = { tag, v };
	}
	return best?.tag ?? null;
}

// #region Versión fijada por servidor

/** `congelada`: no se toca; `tag`: esa versión exacta, aunque sea más vieja (así se regresa una app). */
export type VersionHold = { freeze: true } | { tag: string };

/**
 * `configuration-subject-version-hold`: `tienda; pos=0.3.1`. Separado por
 * `;`, `,` o renglón. Lo que no se entiende se ignora: un error de dedo no debe
 * congelar ni mover nada.
 */
export function parse_version_holds(value: unknown): Map<string, VersionHold> {
	const out = new Map<string, VersionHold>();
	if (typeof value !== 'string') return out;
	for (const raw of value.split(/[;,\n]/)) {
		const [slug_raw, tag_raw] = raw.split('=').map((x) => x.trim());
		const slug = String(slug_raw ?? '')
			.toLowerCase()
			.replace(/^subject-/, '');
		if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) continue;
		if (tag_raw === undefined) out.set(slug, { freeze: true });
		else if (parse_semver(tag_raw)) out.set(slug, { tag: tag_raw });
	}
	return out;
}

export function describe_hold(hold: VersionHold | undefined): string | null {
	if (!hold) return null;
	return 'tag' in hold ? hold.tag : 'congelada';
}

// #endregion

// #region Objetivo de una actualización

export type UpdateSource = 'catalog' | 'registry' | 'hold';

/** `running`: volver a bajar lo que ya corre (un tag republicado); no se revisa ni se compara. */
export type ImageSource = UpdateSource | 'running';

export type UpdateTarget = {
	image: string;
	source: UpdateSource;
	/** Cuándo se construyó la imagen descubierta (reloj del registro, igual en todos los servidores). */
	created_at: string | null;
};

export type DiscoveredVersion = {
	image: string | null;
	created_at: string | null;
	note: string | null;
};

/**
 * La imagen a la que debe ir una app. La descubierta gana al pin solo si es
 * más nueva en el mismo major, no está marcada como `needs_catalog` y
 * `accept_discovered` la acepta (la pasada automática exige su espera; la
 * pantalla y el botón la aceptan siempre).
 */
export function subject_update_target(input: {
	pin: string | null | undefined;
	discovered?: DiscoveredVersion | null;
	hold?: VersionHold | null;
	accept_discovered?: (created_at: string | null) => boolean;
}): UpdateTarget | null {
	const pin = String(input.pin ?? '').trim() || null;
	const hold = input.hold;
	if (hold && 'freeze' in hold) return null;
	if (hold && 'tag' in hold) {
		const image = pin ? image_with_tag(pin, hold.tag) : null;
		return image ? { image, source: 'hold', created_at: null } : null;
	}
	const found = input.discovered;
	if (
		pin &&
		found?.image &&
		found.note !== NEEDS_CATALOG &&
		image_parts(found.image)?.repo === image_parts(pin)?.repo &&
		is_newer_same_major(image_parts(found.image)?.tag, image_parts(pin)?.tag) &&
		(input.accept_discovered?.(found.created_at) ?? true)
	) {
		return { image: found.image, source: 'registry', created_at: found.created_at };
	}
	return pin ? { image: pin, source: 'catalog', created_at: null } : null;
}

/**
 * ¿Hay que mover la app de `installed` a `target`? Dentro del mismo major
 * solo hacia arriba: un catálogo más viejo que lo que ya corre (una tarjeta de
 * Odoo anterior, un pin rezagado) no la regresa. Entre majors distintos o con
 * tags que no son semver manda el pin, como siempre. Regresar a propósito es
 * una versión fijada (`hold`).
 */
export function update_wanted(
	installed_image: string | null | undefined,
	target: UpdateTarget | null,
): boolean {
	const have = String(installed_image ?? '').trim();
	const want = String(target?.image ?? '').trim();
	if (!target || !have || !want || have === want) return false;
	if (target.source === 'hold') return true;
	const a = parse_semver(image_parts(have)?.tag ?? have.split(':').pop());
	const b = parse_semver(image_parts(want)?.tag ?? want.split(':').pop());
	if (a && b && a[0] === b[0]) return compare_semver(b, a) > 0;
	return true;
}

/** La pasada automática instala una versión descubierta solo tras su espera. */
export function soaked(
	created_at: string | null,
	min_age_hours: number,
	now: number,
): boolean {
	const built = Date.parse(String(created_at ?? ''));
	if (!Number.isFinite(built)) return false;
	return now - built >= Math.max(0, min_age_hours) * 3_600_000;
}

// #endregion

// #region ¿Cabe la versión nueva en el catálogo que tiene este servidor?

export type SubjectManifestLite = {
	dependsOn?: unknown;
	resources?: unknown;
};

function resource_keys(value: unknown): Set<string> {
	if (Array.isArray(value)) return new Set(value.map(String));
	if (value && typeof value === 'object') return new Set(Object.keys(value));
	return new Set();
}

function dependency_ids(value: unknown, is_base: (tid: string) => boolean): Set<string> {
	if (!Array.isArray(value)) return new Set();
	return new Set(value.map(String).filter((tid) => !is_base(tid)));
}

/**
 * Lo que la versión nueva AGREGA respecto a la que corre tiene que estar ya en
 * el catálogo: una dependencia nueva que el catálogo no nombra no se instala
 * en cascada, y un recurso nuevo sin módulo en el catálogo no tiene tabla ni
 * permisos en el núcleo. Lo que ya declaraba la versión instalada no cuenta
 * (tienda publica recursos del escaparate que el catálogo nunca lista). Sin el
 * manifiesto de lo instalado se compara todo contra el catálogo.
 */
export function manifest_fits_catalog(
	sub: Pick<SubjectInfo, 'depends_on' | 'modules' | 'menus'>,
	next: SubjectManifestLite,
	current: SubjectManifestLite | null,
	is_base: (technical_id: string) => boolean,
): { ok: true } | { ok: false; dependencies: string[]; resources: string[] } {
	const known_deps = new Set(sub.depends_on ?? []);
	const had_deps = dependency_ids(current?.dependsOn, is_base);
	const dependencies = [...dependency_ids(next.dependsOn, is_base)].filter(
		(tid) => !had_deps.has(tid) && !known_deps.has(tid),
	);
	const known_resources = new Set(sub.modules.map((m) => m.resource));
	for (const menu of sub.menus ?? []) {
		for (const r of menu.resources ?? []) known_resources.add(r.split(':')[0]!);
	}
	const had_resources = resource_keys(current?.resources);
	const resources = [...resource_keys(next.resources)].filter(
		(r) => !had_resources.has(r) && !known_resources.has(r),
	);
	return dependencies.length || resources.length
		? { ok: false, dependencies, resources }
		: { ok: true };
}

// #endregion

// #region Parámetros del servidor

/**
 * `value` es JSONB y hay filas migradas de Mongo que vuelven envueltas
 * (`'"false"'`, a veces dos veces): se desenvuelve hasta el fondo.
 */
export function unwrap_config_value(value: unknown): unknown {
	let current = value;
	for (let i = 0; i < 5; i++) {
		if (typeof current !== 'string') break;
		const text = current.trim();
		if (
			text.length > 1 &&
			((text.startsWith('"') && text.endsWith('"')) ||
				(text.startsWith("'") && text.endsWith("'")))
		) {
			current = text.slice(1, -1);
			continue;
		}
		break;
	}
	return current;
}

/** Solo un SÍ explícito cuenta como SÍ: un interruptor nunca se enciende solo. */
export function coerce_flag(value: unknown): boolean {
	const current = unwrap_config_value(value);
	if (typeof current === 'boolean') return current;
	if (typeof current === 'number') return current === 1;
	if (typeof current !== 'string') return false;
	const text = current.trim().toLowerCase();
	return text === 'true' || text === 'si' || text === 'sí' || text === '1';
}

/** Valor de un parámetro de sistema; `undefined` ante cualquier problema. */
export async function read_config_value(
	store: ImperiumStore,
	ref: string,
): Promise<unknown> {
	try {
		if (!store.has('configuration')) return undefined;
		const doc = await store.find_where('configuration', { _ref: ref });
		return doc ? unwrap_config_value(doc.value) : undefined;
	} catch {
		return undefined;
	}
}

export async function read_version_holds(
	store: ImperiumStore,
): Promise<Map<string, VersionHold>> {
	return parse_version_holds(await read_config_value(store, SUBJECT_VERSION_HOLD_REF));
}

/**
 * Lo que decide este servidor sobre versiones: qué fija por app y si toma las
 * del registro. Con el interruptor en NO las descubiertas solo se enseñan: ni
 * el botón ni «Actualizar todas» ni la pasada van a ellas.
 */
export type UpdatePolicy = {
	holds: ReadonlyMap<string, VersionHold>;
	take_discovered: boolean;
};

export async function read_update_policy(store: ImperiumStore): Promise<UpdatePolicy> {
	return {
		holds: await read_version_holds(store),
		take_discovered: coerce_flag(
			await read_config_value(store, SUBJECT_AUTO_UPDATE_DISCOVERED_REF),
		),
	};
}

export function coerce_hours(value: unknown, fallback = DEFAULT_MIN_AGE_HOURS): number {
	const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
	return Number.isFinite(n) && n >= 0 && String(value ?? '').trim() !== '' ? n : fallback;
}

// #endregion
