/**
 * Autoescaneo de fuentes de apps (varios repos Git y/o repos de imágenes).
 *
 * El catálogo de Módulos siempre es dinámico («Buscar» lee las fuentes). El
 * autoescaneo recorre cada cierto tiempo las N fuentes de
 * `configuration-subject-image-sources` (`github:org`, `github:org/repo`,
 * `ghcr:org`), lee el manifest de cada app nueva (del repo Git, o de la imagen
 * si la fuente es GHCR), la deja en el catálogo del tenant
 * (`source = 'image-source'`, autoriza instalar) y consulta versiones nuevas
 * de las instaladas.
 *
 * Quién lo enciende depende del modo de administración (`management-mode.ts`),
 * con un solo administrador a la vez:
 * - `odoo`: solo Odoo (secreto maestro, «Aplicar súbditos»). Módulos lo muestra.
 * - `self`: un administrador del núcleo desde Módulos (o la API). La fuente de
 *   verdad es el núcleo (`subject_catalog_settings` + el parámetro). El `.env`
 *   del deploy (`IMPERIUM_IMAGE_AUTOSCAN` / `IMPERIUM_IMAGE_SOURCES`) solo
 *   siembra la configuración mientras nadie la haya editado en Módulos.
 *
 * El interruptor vive en `subject_catalog_settings`, no en un parámetro.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { print_console_log } from './debug-request-log.ts';
import { make_module_id_resolver } from './reconcile-configuration-seeds.ts';
import { discover_subject_versions } from './subject-discovery.ts';
import {
	SubjectCatalogError,
	ensure_catalog_table,
	list_catalog_entries,
	upsert_catalog_entry,
} from './subject-catalog.ts';
import {
	DEFAULT_IMAGE_SOURCES,
	IMAGE_SOURCES_CONFIG_REF,
	apply_image_sources_from_store,
	format_image_sources,
	github_token,
	live_catalog_scan,
	merge_scanned_subjects,
	parse_image_source,
	parse_image_sources,
	scan_image_sources,
	type CatalogImageScan,
	type ImageSourceSpec,
} from './subject-image-sources.ts';
import { is_base_subject_slug, read_subject_image_manifest } from './subject-runtime.ts';
import { apply_scanned_subjects, registered_from } from './subjects-admin.ts';
import { management_mode, type ManagementMode } from './management-mode.ts';

export const AUTOSCAN_SETTING_KEY = 'image_sources_autoscan';

const SOURCES_SYNTAX =
	'«github:org» (repos Git imperium-subject-* de la organización), «github:org/repo» o «ghcr:org» (paquetes de imagen), por línea o separadas por «;»; «private» si es privada (usa IMPERIUM_GITHUB_TOKEN).';

export function image_sources_param_description(mode: ManagementMode = management_mode()): string {
	return mode === 'self'
		? `Fuentes de apps que recorre el autoescaneo: ${SOURCES_SYNTAX} Servidor autoadministrado: se edita en Módulos › Autodetección de apps. Cada escaneo agrega al catálogo las apps nuevas y busca versiones nuevas.`
		: `Fuentes de apps que recorre el autoescaneo: ${SOURCES_SYNTAX} Lo habilita y lo llena Odoo (ficha del servidor › Autoescaneo de repos de imágenes); no se puede crear desde Imperium. Cada escaneo agrega al catálogo las apps nuevas y busca versiones nuevas.`;
}

const IMAGE_SOURCES_PARAM = {
	name: 'Fuentes de apps (repos Git e imágenes)',
	type: 'text',
	is_system: true,
};

/** Cada hora: un paquete nuevo tarda minutos en publicarse, no segundos. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_FIRST_DELAY_MS = 2 * 60 * 1000;
/** Cada manifest es un `docker pull`: un repo grande no debe bajar todo de golpe. */
const MAX_MANIFESTS_PER_PASS = 8;

export type AutoscanLastRun = {
	at: string;
	ok: boolean;
	error: string | null;
	scanned: number;
	added: string[];
	removed: string[];
	discovered: string[];
};

/** Quién dejó la configuración vigente: Odoo, Módulos (`gui`) o el `.env` del deploy. */
export type AutoscanOrigin = 'odoo' | 'gui' | 'env';

export type AutoscanState = {
	enabled: boolean;
	/** El modo real del servidor (`IMPERIUM_MANAGEMENT_MODE`). */
	managed_by: ManagementMode;
	/** `true` = Módulos puede encenderlo, editar fuentes y escanear (modo self). */
	editable: boolean;
	configured_by: AutoscanOrigin | null;
	/** Hay token de GitHub en el entorno (necesario para fuentes privadas). */
	token_configured: boolean;
	config_ref: string;
	sources: ImageSourceSpec[];
	last_run: AutoscanLastRun | null;
	updated_at: string | null;
	/** Siembra del `.env` que no se aplicó porque ya se editó en Módulos. */
	seed_ignored?: boolean;
};

export async function ensure_settings_table(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.subject_catalog_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

type SettingValue = {
	enabled: boolean;
	last_run: AutoscanLastRun | null;
	configured_by: AutoscanOrigin | null;
};
type StoredSetting = SettingValue & { updated_at: string | null; exists: boolean };

function parse_origin(raw: unknown): AutoscanOrigin | null {
	return raw === 'odoo' || raw === 'gui' || raw === 'env' ? raw : null;
}

function parse_setting(raw: unknown): SettingValue {
	let value = raw;
	for (let i = 0; i < 3 && typeof value === 'string'; i++) {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			break;
		}
	}
	if (!value || typeof value !== 'object') return { enabled: false, last_run: null, configured_by: null };
	const obj = value as { enabled?: unknown; last_run?: unknown; configured_by?: unknown };
	const last = obj.last_run && typeof obj.last_run === 'object' ? (obj.last_run as AutoscanLastRun) : null;
	return { enabled: obj.enabled === true, last_run: last, configured_by: parse_origin(obj.configured_by) };
}

async function read_setting(sql: Bun.SQL): Promise<StoredSetting> {
	await ensure_settings_table(sql);
	const rows = (await sql.unsafe(
		`SELECT value, updated_at FROM public.subject_catalog_settings WHERE key = $1`,
		[AUTOSCAN_SETTING_KEY],
	)) as Array<{ value: unknown; updated_at: unknown }>;
	const row = rows[0];
	if (!row) return { enabled: false, last_run: null, configured_by: null, updated_at: null, exists: false };
	return { ...parse_setting(row.value), updated_at: row.updated_at ? String(row.updated_at) : null, exists: true };
}

async function write_setting(sql: Bun.SQL, value: SettingValue): Promise<void> {
	await ensure_settings_table(sql);
	await sql.unsafe(
		`INSERT INTO public.subject_catalog_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		[AUTOSCAN_SETTING_KEY, value],
	);
}

export async function read_autoscan_enabled(sql: Bun.SQL): Promise<boolean> {
	try {
		return (await read_setting(sql)).enabled;
	} catch {
		return false;
	}
}

async function image_sources_row(store: ImperiumStore): Promise<ImperiumDoc | null> {
	if (!store.has('configuration')) return null;
	return store.find_where('configuration', { _ref: IMAGE_SOURCES_CONFIG_REF });
}

async function configuration_module_id(store: ImperiumStore): Promise<string | null> {
	if (!store.has('module-management')) return null;
	const modules: ImperiumDoc[] = [];
	for await (const page of store.scan('module-management', { include_inactive: true })) {
		modules.push(...page);
	}
	return make_module_id_resolver(modules)('NA');
}

/** Crea o reactiva el parámetro; con `value` lo reemplaza (lo manda Odoo o Módulos). */
async function enable_image_sources_param(store: ImperiumStore, value: string | null) {
	if (!store.has('configuration')) return;
	const row = await image_sources_row(store);
	const description = image_sources_param_description();
	if (!row?._id) {
		await store.insert('configuration', {
			_ref: IMAGE_SOURCES_CONFIG_REF,
			...IMAGE_SOURCES_PARAM,
			description,
			module_id: (await configuration_module_id(store)) ?? 'NA',
			value: value ?? format_image_sources(DEFAULT_IMAGE_SOURCES),
			is_active: true,
		} as ImperiumDoc);
		return;
	}
	const patch: Record<string, unknown> = { is_active: true, name: IMAGE_SOURCES_PARAM.name, description };
	if (value != null) patch.value = value;
	await store.update('configuration', String(row._id), patch as never);
}

/** Lo esconde (inactivo) sin perder su valor: si Odoo lo vuelve a encender, reaparece. */
async function disable_image_sources_param(store: ImperiumStore) {
	const row = await image_sources_row(store);
	if (row?._id && row.is_active !== false) {
		await store.update('configuration', String(row._id), { is_active: false } as never);
	}
}

async function drop_image_source_entries(sql: Bun.SQL, keep: ReadonlySet<string>): Promise<string[]> {
	await ensure_catalog_table(sql);
	const rows = (await sql.unsafe(
		`DELETE FROM public.subject_catalog
      WHERE source = 'image-source'
        AND technical_id NOT IN (SELECT jsonb_array_elements_text($1::jsonb))
      RETURNING technical_id`,
		[[...keep]],
	)) as Array<{ technical_id: string }>;
	return rows.map((row) => String(row.technical_id));
}

/**
 * Normaliza una lista de fuentes (de Odoo, de Módulos o del `.env`):
 * «ghcr:org [private]», «github:org[/repo] [private]», una org suelta (= ghcr)
 * u objetos `{org, private, kind?, repo?}`. `undefined` = no mandó lista (se
 * deja la vigente).
 */
export function odoo_sources_value(raw: unknown, strict = false): string | null | undefined {
	if (raw === undefined || raw === null) return undefined;
	const lines: string[] = [];
	const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[;\n]/) : null;
	if (!items) {
		throw new SubjectCatalogError('«sources» debe ser una lista', 400, 'invalid_sources');
	}
	for (const item of items) {
		if (item && typeof item === 'object') {
			const obj = item as { org?: unknown; private?: unknown; kind?: unknown; repo?: unknown };
			const org = String(obj.org ?? '').trim();
			const priv = obj.private === true;
			const kind = obj.kind === 'github' ? 'github' : 'ghcr';
			const repo = kind === 'github' ? String(obj.repo ?? '').trim() : '';
			if (org) lines.push(`${kind}:${org}${repo ? `/${repo}` : ''}${priv ? ' private' : ''}`);
			continue;
		}
		const text = String(item ?? '').trim();
		if (text) lines.push(/^(ghcr|github):/.test(text) ? text : `ghcr:${text}`);
	}
	if (!lines.length) return null;
	// Módulos avisa de una fuente mal escrita; lo de Odoo se sigue filtrando como antes.
	for (const line of strict ? lines : []) {
		const [token, ...flags] = line.split(/[;\s]+/).filter(Boolean);
		if (!token || !parse_image_source(token, flags.includes('private'))) {
			throw new SubjectCatalogError(`Fuente ilegible: «${line}»`, 400, 'invalid_sources');
		}
	}
	const parsed = parse_image_sources(lines.join('; '));
	if (!parsed.length) {
		throw new SubjectCatalogError('Ninguna fuente de apps es legible', 400, 'invalid_sources');
	}
	return format_image_sources(parsed.slice(0, 50));
}

/** Enciende o apaga y deja las fuentes; quien lo hizo queda en `configured_by`. */
async function apply_autoscan(
	store: ImperiumStore,
	sql: Bun.SQL,
	body: { enabled?: unknown; sources?: unknown },
	origin: AutoscanOrigin,
): Promise<AutoscanState> {
	if (typeof body.enabled !== 'boolean') {
		throw new SubjectCatalogError('Se esperaba { "enabled": true|false }', 400, 'invalid_payload');
	}
	const value = body.enabled ? odoo_sources_value(body.sources, origin === 'gui') : undefined;
	const prev = await read_setting(sql);
	if (body.enabled) {
		await enable_image_sources_param(store, value ?? null);
	} else {
		await disable_image_sources_param(store);
		await drop_image_source_entries(sql, new Set());
	}
	await write_setting(sql, { enabled: body.enabled, last_run: prev.last_run, configured_by: origin });
	return read_autoscan_state(store, sql);
}

/**
 * `PUT /subjects/catalog/image-sources` (solo Odoo, con el secreto maestro).
 * Encender crea o reactiva el parámetro; apagar lo esconde y saca del
 * catálogo lo que solo había puesto el autoescaneo.
 */
export async function apply_odoo_autoscan(
	store: ImperiumStore,
	sql: Bun.SQL,
	body: { enabled?: unknown; sources?: unknown },
): Promise<AutoscanState> {
	return apply_autoscan(store, sql, body, 'odoo');
}

/**
 * Modo self. `gui`: un administrador desde Módulos; manda siempre. `env`: la
 * siembra del `.env` del deploy (`subjects-sync --image-sources` o el
 * arranque del núcleo); solo aplica mientras nadie lo haya editado en Módulos,
 * para que un update no pise lo que se cambió en la GUI.
 */
export async function apply_self_autoscan(
	store: ImperiumStore,
	sql: Bun.SQL,
	body: { enabled?: unknown; sources?: unknown },
	origin: 'gui' | 'env',
): Promise<AutoscanState> {
	if (origin === 'env') {
		const prev = await read_setting(sql);
		if (prev.configured_by === 'gui') {
			if (typeof body.enabled !== 'boolean') {
				throw new SubjectCatalogError('Se esperaba { "enabled": true|false }', 400, 'invalid_payload');
			}
			return { ...(await read_autoscan_state(store, sql)), seed_ignored: true };
		}
	}
	return apply_autoscan(store, sql, body, origin);
}

/**
 * Al arrancar en modo self: siembra desde el entorno del núcleo
 * (`IMPERIUM_IMAGE_AUTOSCAN` / `IMPERIUM_IMAGE_SOURCES`, que el compose copia
 * del `.env`) si nadie lo editó en Módulos. Sin esas variables no hace nada.
 */
export async function seed_self_autoscan_from_env(
	store: ImperiumStore,
	sql: Bun.SQL,
	env: Record<string, string | undefined> = process.env,
): Promise<AutoscanState | null> {
	if (management_mode(env) !== 'self') return null;
	const raw_enabled = String(env.IMPERIUM_IMAGE_AUTOSCAN ?? '').trim().toLowerCase();
	const raw_sources = String(env.IMPERIUM_IMAGE_SOURCES ?? '').trim();
	if (!raw_enabled && !raw_sources) return null;
	const enabled = !['off', 'false', '0', 'no'].includes(raw_enabled);
	const body = enabled
		? { enabled, sources: raw_sources ? raw_sources.split(/[;,\n]/).map((s) => s.trim()).filter(Boolean) : undefined }
		: { enabled };
	return apply_self_autoscan(store, sql, body, 'env');
}

export async function read_autoscan_state(store: ImperiumStore, sql: Bun.SQL): Promise<AutoscanState> {
	const setting = await read_setting(sql);
	let sources: ImageSourceSpec[];
	try {
		sources = await apply_image_sources_from_store(store);
	} catch {
		sources = DEFAULT_IMAGE_SOURCES.map((source) => ({ ...source }));
	}
	const mode = management_mode();
	return {
		enabled: setting.enabled,
		managed_by: mode,
		editable: mode === 'self',
		configured_by: setting.configured_by,
		token_configured: Boolean(github_token()),
		config_ref: IMAGE_SOURCES_CONFIG_REF,
		sources,
		last_run: setting.last_run,
		updated_at: setting.updated_at,
	};
}

/**
 * Las apps que dejó el autoescaneo viven solo en el catálogo del tenant; tras
 * reiniciar el núcleo vuelven a la lista en memoria para poder instalarse sin
 * esperar a la próxima pasada.
 */
export async function hydrate_image_source_subjects(store: ImperiumStore, sql: Bun.SQL): Promise<void> {
	let entries;
	try {
		entries = await list_catalog_entries(sql);
	} catch {
		return;
	}
	const known = new Set(store.subjects.map((sub) => sub.technical_id));
	const extra = entries.filter(
		(entry) => entry.source === 'image-source' && entry.image && !known.has(entry.technical_id),
	);
	if (!extra.length) return;
	apply_scanned_subjects(store, [
		...registered_from(store.subjects),
		...extra.map((entry) => ({
			technical_id: entry.technical_id,
			slug: entry.slug,
			name: entry.name,
			image: entry.image!,
			active: true,
			depends_on: [],
		})),
	]);
}

type ManifestRead = (slug: string, image: string) => Promise<Record<string, unknown> | null>;

async function default_manifest_read(slug: string, image: string) {
	const result = await read_subject_image_manifest(slug, image);
	return result.ok && !result.skipped ? result.manifest : null;
}

function manifest_name(manifest: Record<string, unknown> | null): string | null {
	const name = manifest?.name;
	return typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
}

function manifest_depends(manifest: Record<string, unknown> | null): string[] {
	const raw = manifest?.depends_on ?? manifest?.dependsOn;
	return Array.isArray(raw) ? raw.map(String).filter((tid) => /^subject-[a-z0-9-]+$/.test(tid)) : [];
}

export type AutoscanPass = AutoscanLastRun & { enabled: boolean };

/**
 * Una pasada. Fallo del registro: no toca el catálogo (un listado a medias no
 * debe borrar apps). Las apps que Odoo o un alta manual ya pusieron solo
 * refrescan su imagen; las nuevas entran como `image-source`.
 */
export async function run_image_autoscan_pass(
	store: ImperiumStore,
	sql: Bun.SQL,
	deps: { scan?: CatalogImageScan; read_manifest?: ManifestRead; discover?: boolean } = {},
): Promise<AutoscanPass> {
	const setting = await read_setting(sql);
	const out: AutoscanPass = {
		enabled: setting.enabled,
		at: new Date().toISOString(),
		ok: false,
		error: null,
		scanned: 0,
		added: [],
		removed: [],
		discovered: [],
	};
	if (!setting.enabled) return out;
	const scan = deps.scan ?? live_catalog_scan();
	const read_manifest = deps.read_manifest ?? default_manifest_read;
	try {
		await hydrate_image_source_subjects(store, sql);
		await apply_image_sources_from_store(store);
		const packages = await scan_image_sources({ client: scan.client, token: scan.token });
		out.scanned = packages.length;
		const before = new Map(store.subjects.map((sub) => [sub.technical_id, sub]));
		const merged = merge_scanned_subjects(registered_from(store.subjects), packages);
		const entries = new Map((await list_catalog_entries(sql)).map((e) => [e.technical_id, e]));
		const seen = new Set<string>();
		let manifests = 0;
		for (const pkg of packages) {
			const sub = merged.find((item) => item.technical_id === pkg.name);
			if (!sub || is_base_subject_slug(sub.slug)) continue;
			seen.add(sub.technical_id);
			const prev = entries.get(sub.technical_id);
			if (prev && prev.source !== 'image-source' && prev.source !== 'registry') {
				// Odoo o alta manual: solo la imagen.
				await upsert_catalog_entry(sql, { ...prev, image: sub.image || prev.image });
				continue;
			}
			const changed = !prev || prev.image !== sub.image;
			let name = prev?.name || before.get(sub.technical_id)?.name || sub.name || sub.slug;
			if (pkg.display_name || pkg.depends_on) {
				// El repo Git ya trajo su manifest: no hace falta bajar la imagen.
				name = pkg.display_name ?? name;
				if (pkg.depends_on?.length && !before.has(sub.technical_id)) sub.depends_on = [...pkg.depends_on];
			} else if (changed && manifests < MAX_MANIFESTS_PER_PASS && sub.image.includes(':')) {
				manifests += 1;
				const manifest = await read_manifest(sub.slug, sub.image).catch(() => null);
				name = manifest_name(manifest) ?? name;
				const deps_on = manifest_depends(manifest);
				if (deps_on.length && !before.has(sub.technical_id)) sub.depends_on = deps_on;
			}
			sub.name = name;
			await upsert_catalog_entry(sql, {
				technical_id: sub.technical_id,
				slug: sub.slug,
				name,
				image: sub.image,
				repo: pkg.source_ref ?? `ghcr.io/${pkg.org}/${pkg.name}`,
				source: 'image-source',
			});
			if (!prev || prev.source === 'registry') out.added.push(sub.slug);
		}
		apply_scanned_subjects(store, merged);
		out.removed = await drop_image_source_entries(sql, seen);
		if (deps.discover !== false) {
			const discovery = await discover_subject_versions(store, sql).catch(() => null);
			out.discovered = discovery?.found ?? [];
		}
		out.ok = true;
	} catch (err) {
		out.error = err instanceof Error ? err.message : String(err);
	}
	const { enabled: _enabled, ...last_run } = out;
	await write_setting(sql, { enabled: setting.enabled, last_run, configured_by: setting.configured_by }).catch(() => {});
	return out;
}

/**
 * Al arrancar: sin autoescaneo, el parámetro no se ve (un servidor viejo lo
 * tenía sembrado). Con él, se reactiva si alguien lo hubiera desactivado.
 */
export async function reconcile_image_sources_param(store: ImperiumStore, sql: Bun.SQL): Promise<void> {
	await seed_self_autoscan_from_env(store, sql).catch((err) => {
		print_console_log('warning', `autoescaneo (self): la siembra del .env no se aplicó: ${err}`);
	});
	const enabled = await read_autoscan_enabled(sql);
	if (enabled) await enable_image_sources_param(store, null);
	else await disable_image_sources_param(store);
}

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<AutoscanPass> | null = null;

/** Una sola pasada a la vez: el botón y el reloj comparten esta puerta. */
export function trigger_image_autoscan(
	store: ImperiumStore,
	sql: Bun.SQL,
	deps?: Parameters<typeof run_image_autoscan_pass>[2],
): Promise<AutoscanPass> {
	if (running) return running;
	running = run_image_autoscan_pass(store, sql, deps).finally(() => {
		running = null;
	});
	return running;
}

export function start_image_autoscan(store: ImperiumStore, sql: Bun.SQL): void {
	if (timer) return;
	const from_env = Number(process.env.SUBJECT_IMAGE_AUTOSCAN_INTERVAL_MS);
	const interval_ms = Number.isFinite(from_env) && from_env > 0 ? from_env : DEFAULT_INTERVAL_MS;
	const pass = async () => {
		try {
			const result = await trigger_image_autoscan(store, sql);
			if (result.enabled && !result.ok) {
				print_console_log('warning', `autoescaneo de imágenes: ${result.error}`);
			} else if (result.added.length || result.discovered.length) {
				print_console_log(
					'info',
					`autoescaneo de imágenes: nuevas=${result.added.join(',') || '-'} versiones=${result.discovered.join(',') || '-'}`,
				);
			}
		} catch (err) {
			print_console_log('error', `autoescaneo de imágenes falló: ${err}`);
		}
	};
	setTimeout(() => {
		void reconcile_image_sources_param(store, sql)
			.then(() => hydrate_image_source_subjects(store, sql))
			.catch(() => {})
			.finally(() => void pass());
		timer = setInterval(() => void pass(), interval_ms);
		timer.unref?.();
	}, DEFAULT_FIRST_DELAY_MS).unref?.();
}

export function stop_image_autoscan(): void {
	if (timer) clearInterval(timer);
	timer = null;
}
