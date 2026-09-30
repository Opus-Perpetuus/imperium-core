/**
 * Instalar / desinstalar apps del catálogo: SQL is_enable, menús y permisos,
 * corte de acceso inmediato y ciclo Docker (imagen/contenedor) vía el operador.
 */
import { pg_schema_name } from '@opus-perpetuus/imperium-core-kit';
import {
	background_job_progress,
	create_background_job_notification,
	merge_background_job_payload,
	notify_background_job_refresh,
	persist_background_job,
	read_background_job_payload,
	type BackgroundJobKind,
	type BackgroundJobLevel,
} from './background-job.ts';
import { broadcast_event } from './socket-stub.ts';
import { print_console_log } from './debug-request-log.ts';
import { apply_subject_schema_from_url } from './subject-schema.ts';
import {
	resolve_running_subject_image,
	docker_runtime_wanted,
	is_base_subject_slug,
	read_subject_image_manifest,
	run_subject_docker,
	type SubjectRuntimeResult,
} from './subject-runtime.ts';
import {
	APPS_AL_PIN,
	describe_hold,
	image_with_tag,
	manifest_fits_catalog,
	NEEDS_CATALOG,
	read_update_policy,
	subject_update_target,
	update_wanted,
	type ImageSource,
	type UpdatePolicy,
	type UpdateSource,
	type UpdateTarget,
} from './subject-versions.ts';
import {
	blocking_dependents,
	missing_dependencies,
	plan_subject_install,
	SubjectDependencyError,
	type DependencyNode,
} from './subject-deps.ts';
import type { ImperiumDoc } from './envelope.ts';
import { is_seed_admin } from './group-access.ts';
import {
	catalog_visible,
	list_catalog_entries,
	type CatalogEntry,
} from './subject-catalog.ts';
import { PREFER_OWNER, type ImperiumStore, type SubjectInfo } from './store.ts';

type JobCtx = {
	store: ImperiumStore;
	notification_id?: string;
	recipient_id?: string;
};

export type LifecycleOp = 'install' | 'uninstall' | 'update';

type InFlightJob = { op: LifecycleOp; done: Promise<unknown> };

/**
 * Trabajos en curso de este proceso, por app. `done` resuelve cuando ese
 * trabajo se asienta (nunca rechaza): quien lo espere debe releer el estado.
 */
const in_flight = new Map<string, InFlightJob>();

let admission: Promise<unknown> = Promise.resolve();

/**
 * Serializa la admisión (comprobaciones, registro en `in_flight` y `begin`):
 * entre mirar `in_flight` y registrar el trabajo hay `await`s, y dos peticiones
 * a la vez pasaban las dos. Solo la admisión: Docker y las esperas corren
 * después, en la cadena, para no bloquear al resto durante un pull.
 */
function admit<T>(fn: () => Promise<T>): Promise<T> {
	const run = admission.then(fn, fn);
	admission = run.catch(() => null);
	return run;
}

/** Registra un trabajo; `settle` lo retira (si sigue siendo el suyo) y despierta a quien lo espera. */
function claim(technical_id: string, op: LifecycleOp) {
	let resolve!: () => void;
	const entry: InFlightJob = {
		op,
		done: new Promise<void>((r) => (resolve = r)),
	};
	in_flight.set(technical_id, entry);
	return {
		settle() {
			if (in_flight.get(technical_id) === entry) in_flight.delete(technical_id);
			resolve();
		},
	};
}

/** Una app que se está instalando o actualizando cuenta como viva para sus dependencias. */
function is_live_job(job: InFlightJob | undefined): boolean {
	return job?.op === 'install' || job?.op === 'update';
}

async function collect_resource(
	store: ImperiumStore,
	resource: string,
): Promise<ImperiumDoc[]> {
	if (!store.has(resource)) return [];
	const rows: ImperiumDoc[] = [];
	for await (const page of store.scan(resource, { include_inactive: true })) {
		rows.push(...page);
	}
	return rows;
}

function actor_uid(actor: ImperiumDoc | null | undefined) {
	return String(actor?._id ?? actor?.id ?? '').trim();
}

function norm(path: unknown) {
	return String(path ?? '').replace(/\/+$/, '');
}

function is_disabled_flag(value: unknown) {
	return value === false || value === 'false';
}

/** ModuleManagement.name exige ≥3 caracteres; acrónimos de catálogo como "RH" no pasan. */
const MODULE_MANAGEMENT_NAME_MIN = 3;

export function subject_marker_display_name(sub: {
	name?: string;
	slug?: string;
}): string {
	const name = String(sub.name ?? '').trim();
	if (name.length >= MODULE_MANAGEMENT_NAME_MIN) return name;
	const slug = String(sub.slug ?? '')
		.replace(/[-_]+/g, ' ')
		.trim();
	if (slug.length >= MODULE_MANAGEMENT_NAME_MIN) return slug;
	const fallback = [name || slug, 'app'].filter(Boolean).join(' ');
	return fallback.length >= MODULE_MANAGEMENT_NAME_MIN
		? fallback
		: `app ${fallback}`.trim();
}

export function subject_paths(sub: SubjectInfo): Set<string> {
	const out = new Set<string>();
	if (sub.path) out.add(norm(sub.path));
	for (const mod of sub.modules) {
		if (mod.path) out.add(norm(mod.path));
	}
	return out;
}

export function subject_base_url(technical_id: string): string {
	const slug = technical_id.replace(/^subject-/, '');
	const host = process.env.SUBJECT_HOST_PREFIX ?? 'subject-';
	const domain = process.env.SUBJECT_NETWORK_DOMAIN ?? '';
	if (process.env[`SUBJECT_URL_${slug}`]) {
		return process.env[`SUBJECT_URL_${slug}`]!;
	}
	if (domain) {
		return `http://${host}${slug}:${process.env.SUBJECT_PORT ?? 3000}`;
	}
	return `http://127.0.0.1:${process.env.SUBJECT_PORT ?? 3000}`;
}

function token_key(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resource_matches(model_id: string, resource: string) {
	const a = token_key(model_id);
	const b = token_key(resource);
	return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

export async function ensure_install_table(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.subject_installs (
      technical_id TEXT PRIMARY KEY,
      installed BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'not_installed',
      installed_at TIMESTAMPTZ,
      uninstalled_at TIMESTAMPTZ,
      version INTEGER
    )
  `);
	await sql.unsafe(`
    ALTER TABLE public.subject_installs
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'not_installed'
  `);
	// Imagen con la que quedó el contenedor. Sin esto el sistema no sabía qué
	// versión corría y anunciaba la del catálogo, que es la DESEADA. NULL =
	// instalada antes de que existiera la columna (desconocida), no "ninguna".
	await sql.unsafe(`
    ALTER TABLE public.subject_installs
      ADD COLUMN IF NOT EXISTS installed_image TEXT
  `);
	// Versión más nueva que el pin encontrada en el registro (subject-discovery.ts).
	await sql.unsafe(`
    ALTER TABLE public.subject_installs
      ADD COLUMN IF NOT EXISTS discovered_image TEXT,
      ADD COLUMN IF NOT EXISTS discovered_created_at TEXT,
      ADD COLUMN IF NOT EXISTS discovered_note TEXT,
      ADD COLUMN IF NOT EXISTS discovered_checked_at TIMESTAMPTZ
  `);
	await sql.unsafe(`
    UPDATE public.subject_installs
       SET status = 'installed'
     WHERE installed IS TRUE AND status = 'not_installed'
  `);
}

/**
 * Misma regla que el catálogo: si hay fila en `subject_installs`, esa es la
 * verdad; si no, una app cuenta como instalada solo si algún
 * `module-management` emparejado sigue habilitado.
 */
export function subject_is_installed(
	rec: { installed: boolean } | undefined,
	module_rows: Array<{ is_enable?: unknown }>,
): boolean {
	if (rec != null) return rec.installed;
	return modules_enabled(module_rows);
}

/**
 * Filas que hay que materializar en `subject_installs` para que un
 * install/uninstall posterior no dependa del fallback a module-management.
 */
export function planned_missing_install_rows(
	subjects: Array<{ technical_id: string }>,
	existing: Iterable<string>,
	fallback_installed: (subject: { technical_id: string }) => boolean,
): Array<{ technical_id: string; installed: boolean }> {
	const have = new Set(existing);
	const out: Array<{ technical_id: string; installed: boolean }> = [];
	for (const sub of subjects) {
		if (have.has(sub.technical_id)) continue;
		out.push({
			technical_id: sub.technical_id,
			installed: fallback_installed(sub),
		});
	}
	return out;
}

export async function disabled_subject_slugs(
	store: ImperiumStore,
	sql: Bun.SQL,
): Promise<Set<string>> {
	const disabled = new Set<string>();
	const recs = await install_records(sql);
	const all_modules = await collect_resource(store, 'module-management');
	for (const sub of store.subjects) {
		const rows = filter_module_rows(all_modules, sub);
		const rec = recs.get(sub.technical_id);
		if (!subject_is_installed(rec, rows)) disabled.add(sub.slug);
	}
	return disabled;
}

function filter_module_rows(
	rows: ImperiumDoc[],
	sub: SubjectInfo,
): ImperiumDoc[] {
	const paths = subject_paths(sub);
	return rows.filter((row) => {
		const ref = String(row._ref ?? row.ref ?? '');
		const path = norm(row.path);
		const module_name = String(row.module_name ?? '');
		const name = String(row.name ?? '');
		return (
			ref === sub.technical_id ||
			module_name === sub.slug ||
			name === sub.name ||
			(path && (paths.has(path) || path.startsWith(`${norm(sub.path)}/`)))
		);
	});
}

async function matching_module_rows(
	store: ImperiumStore,
	sub: SubjectInfo,
): Promise<ImperiumDoc[]> {
	return filter_module_rows(await collect_resource(store, 'module-management'), sub);
}

function modules_enabled(rows: ImperiumDoc[]) {
	return rows.some((row) => !is_disabled_flag(row.is_enable));
}

type InstallRec = {
	technical_id: string;
	installed: boolean;
	status: string;
	installed_at: string | null;
	uninstalled_at: string | null;
	version: number | null;
	installed_image: string | null;
	discovered_image: string | null;
	discovered_created_at: string | null;
	discovered_note: string | null;
};

async function install_records(sql: Bun.SQL): Promise<Map<string, InstallRec>> {
	await ensure_install_table(sql);
	const rows = (await sql.unsafe(
		`SELECT technical_id, installed, status, installed_at, uninstalled_at, version, installed_image,
            discovered_image, discovered_created_at, discovered_note
     FROM public.subject_installs`,
	)) as Array<{
		technical_id: string;
		installed: boolean;
		status: string;
		installed_at: Date | string | null;
		uninstalled_at: Date | string | null;
		version: number | null;
		installed_image: string | null;
		discovered_image?: string | null;
		discovered_created_at?: string | null;
		discovered_note?: string | null;
	}>;
	const out = new Map<string, InstallRec>();
	for (const row of rows) {
		out.set(row.technical_id, {
			technical_id: row.technical_id,
			installed: Boolean(row.installed),
			status: String(row.status ?? ''),
			installed_at: row.installed_at ? String(row.installed_at) : null,
			uninstalled_at: row.uninstalled_at
				? String(row.uninstalled_at)
				: null,
			version: row.version == null ? null : Number(row.version),
			installed_image: row.installed_image
				? String(row.installed_image)
				: null,
			discovered_image: row.discovered_image ? String(row.discovered_image) : null,
			discovered_created_at: row.discovered_created_at
				? String(row.discovered_created_at)
				: null,
			discovered_note: row.discovered_note ? String(row.discovered_note) : null,
		});
	}
	return out;
}

/** Imagen con la que quedó una app según `subject_installs`. */
export async function installed_image_of(
	sql: Bun.SQL,
	technical_id: string,
): Promise<string | null> {
	return (await install_records(sql)).get(technical_id)?.installed_image ?? null;
}

/** Filas de `subject_installs` para el descubrimiento de versiones. */
export async function discovered_versions(
	sql: Bun.SQL,
): Promise<Map<string, InstallRec>> {
	return install_records(sql);
}

/**
 * Guarda (o borra, con `image` nulo) la versión descubierta de una app. La
 * nota se decide en SQL: si la candidata es la misma se conserva (un update
 * pudo marcarla `needs_catalog` mientras el descubrimiento consultaba el
 * registro); si cambia, se limpia.
 */
export async function record_discovered_version(
	sql: Bun.SQL,
	technical_id: string,
	image: string | null,
	created_at: string | null,
): Promise<void> {
	await ensure_install_table(sql);
	await sql.unsafe(
		`UPDATE public.subject_installs
        SET discovered_note = CASE
              WHEN discovered_image IS NOT DISTINCT FROM $2 THEN discovered_note
              ELSE NULL
            END,
            discovered_image = $2, discovered_created_at = $3,
            discovered_checked_at = NOW()
      WHERE technical_id = $1`,
		[technical_id, image, created_at],
	);
}

/** Marca una imagen descubierta; si la candidata ya cambió, no toca nada. */
async function mark_discovered_note(
	sql: Bun.SQL,
	technical_id: string,
	image: string,
	note: string,
): Promise<void> {
	await sql.unsafe(
		`UPDATE public.subject_installs SET discovered_note = $3
      WHERE technical_id = $1 AND discovered_image = $2`,
		[technical_id, image, note],
	);
}

/**
 * Objetivo de actualización de una app con lo que hay en su fila y lo que
 * decide el servidor. `accept_discovered` añade una condición (la espera de la
 * pasada automática) a la del interruptor.
 */
export function target_for(
	sub: SubjectInfo,
	rec: InstallRec | undefined,
	policy: UpdatePolicy,
	accept_discovered: (created_at: string | null) => boolean = () => true,
): UpdateTarget | null {
	const al_pin = APPS_AL_PIN.has(sub.slug);
	return subject_update_target({
		pin: sub.image,
		discovered:
			rec && !al_pin
				? {
						image: rec.discovered_image,
						created_at: rec.discovered_created_at,
						note: rec.discovered_note,
					}
				: null,
		hold: al_pin ? null : (policy.holds.get(sub.slug) ?? null),
		accept_discovered: (created_at) =>
			policy.take_discovered && accept_discovered(created_at),
	});
}

/**
 * Imagen al reinstalar una app que ya está instalada («Sincronizar» de Odoo
 * pide instalar todas las deseadas): la que corre, salvo que el pin sea más
 * nuevo o el servidor fije otra. Ir siempre al pin regresaba las apps que
 * tomaron una versión descubierta o fijada.
 */
function reinstall_image(sub: SubjectInfo, rec: InstallRec | undefined, policy: UpdatePolicy): string {
	if (APPS_AL_PIN.has(sub.slug)) return sub.image;
	const hold = policy.holds.get(sub.slug);
	if (hold && 'tag' in hold) return image_with_tag(sub.image, hold.tag) ?? sub.image;
	const running = rec?.installed_image;
	if (!running) return sub.image;
	if (hold) return running;
	const pin: UpdateTarget = { image: sub.image, source: 'catalog', created_at: null };
	return update_wanted(running, pin) ? sub.image : running;
}

/** Misma regla que `technical_id_is_installed`, para todo el catálogo de una vez. */
async function installed_from(
	store: ImperiumStore,
	recs: Map<string, InstallRec>,
	all_modules?: ImperiumDoc[],
): Promise<Set<string>> {
	const out = new Set<string>();
	let modules = all_modules;
	for (const sub of store.subjects) {
		const rec = recs.get(sub.technical_id);
		if (!rec && !is_base_subject_slug(sub.slug)) {
			modules ??= await collect_resource(store, 'module-management');
		}
		if (
			is_base_subject_slug(sub.slug) ||
			subject_is_installed(rec, rec ? [] : filter_module_rows(modules!, sub))
		) {
			out.add(sub.technical_id);
		}
	}
	return out;
}

/**
 * Technical ids de las apps instaladas ahora mismo (las base, siempre). Es lo
 * que el ciclo de vida usa para resolver dependencias.
 */
export async function installed_technical_ids(
	store: ImperiumStore,
	sql: Bun.SQL,
): Promise<Set<string>> {
	return installed_from(store, await install_records(sql));
}

/**
 * Estado visible del catálogo: `installing`/`uninstalling` solo es busy
 * mientras hay un job en vuelo.
 */
export function visible_lifecycle_status(
	status: string | undefined,
	installed: boolean,
	has_in_flight_job: boolean,
): { status: string; busy: boolean } {
	const raw = status || (installed ? 'installed' : 'not_installed');
	const transitional =
		raw === 'installing' || raw === 'uninstalling' || raw === 'updating';
	if (transitional && has_in_flight_job) {
		return { status: raw, busy: true };
	}
	if (transitional) {
		// Un installing huérfano sobre una app que YA estaba instalada vuelve a
		// instalada: era un reintento, no una primera instalación. Un updating
		// huérfano siempre vuelve a instalada: actualizar nunca desinstala, así
		// que la app sigue ahí aunque el contenedor se quedara a medias.
		const settled = installed ? 'installed' : 'not_installed';
		return {
			status:
				raw === 'uninstalling'
					? 'uninstalled'
					: raw === 'updating'
						? 'installed'
						: settled,
			busy: false,
		};
	}
	return { status: raw, busy: false };
}

/**
 * Corrección a persistir si SQL sigue en installing/uninstalling
 * y este proceso ya no tiene un job para esa app.
 */
export function stale_lifecycle_write(
	rec:
		| { technical_id: string; status: string; installed: boolean }
		| undefined,
	has_in_flight_job: boolean,
): { technical_id: string; installed: boolean; status: string } | null {
	if (!rec || has_in_flight_job) return null;
	const view = visible_lifecycle_status(rec.status, rec.installed, false);
	if (view.status === rec.status) return null;
	return {
		technical_id: rec.technical_id,
		installed: view.status === 'installed',
		status: view.status,
	};
}

/** `ghcr.io/…/subject-pos:0.1.2` → `0.1.2`; vacío si no hay imagen. */
export function subject_image_tag(image: string | null | undefined): string {
	const raw = String(image ?? '').trim();
	if (!raw.includes(':')) return '';
	return raw.split(':').pop() ?? '';
}

/**
 * Hay actualización si la app está instalada, se sabe con qué imagen quedó y
 * el objetivo es otra imagen más nueva (ver `update_wanted`: dentro del mismo
 * major nunca se baja sola). Sin `installed_image` no se compara nada: una app
 * instalada antes de que existiera la columna no debe salir como
 * "actualizable" solo porque no sepamos qué corre.
 */
export function subject_update_available(
	installed: boolean,
	installed_image: string | null | undefined,
	available_image: string | null | undefined,
	source: UpdateSource = 'catalog',
): boolean {
	if (!installed) return false;
	const want = String(available_image ?? '').trim();
	return update_wanted(installed_image, want ? { image: want, source, created_at: null } : null);
}

/** Lo que una fila del catálogo necesita saber del resto para sus dependencias. */
export type DependencyView = {
	subjects: readonly DependencyNode[];
	/** Instaladas ahora mismo, base incluidas. */
	installed: ReadonlySet<string>;
};

/** Un grafo roto (lo vigila el spec del catálogo) no debe tumbar el listado. */
function missing_or_empty(
	subjects: readonly DependencyNode[],
	technical_id: string,
	is_ready: (technical_id: string) => boolean,
): string[] {
	try {
		return missing_dependencies(subjects, technical_id, is_ready);
	} catch (err) {
		if (err instanceof SubjectDependencyError) return [];
		throw err;
	}
}

/**
 * Fila de `GET /subjects`. `depends_on`, `required_by` (dependientes vivas) y
 * `missing_dependencies` van en technical ids.
 */
export function catalog_row(
	sub: SubjectInfo,
	installed: boolean,
	rec: InstallRec | undefined,
	deps: DependencyView,
	running: ReadonlySet<string> = new Set(),
	policy: UpdatePolicy = { holds: new Map(), take_discovered: false },
) {
	const is_ready = (tid: string) => deps.installed.has(tid);
	const is_live = (tid: string) =>
		is_ready(tid) || is_live_job(in_flight.get(tid));
	// `running` es la foto tomada antes de leer `rec`: si el trabajo asentó entre
	// la lectura y aquí, la fila vieja (installing) no debe salir como huérfana.
	const view = visible_lifecycle_status(
		rec?.status,
		installed,
		running.has(sub.technical_id) || in_flight.has(sub.technical_id),
	);
	const installed_image = rec?.installed_image ?? null;
	const target = target_for(sub, rec, policy);
	const available_image = target?.image ?? sub.image ?? null;
	return {
		slug: sub.slug,
		name: sub.name,
		path: sub.path,
		menu_ref: sub.menu_ref,
		technical_id: sub.technical_id,
		image: sub.image,
		icon: `subject:${sub.slug}`,
		installed,
		status: view.status,
		busy: view.busy,
		base: is_base_subject_slug(sub.slug),
		installed_at: rec?.installed_at ?? null,
		// Lo que corre vs. lo que el catálogo pide. `installed_image` en NULL
		// es "no se sabe" (instalada antes de que existiera la columna), y eso
		// NO se anuncia como actualización pendiente: se avisaría de algo que
		// no se puede comparar.
		installed_image: installed_image,
		available_image: available_image,
		installed_tag: subject_image_tag(installed_image),
		available_tag: subject_image_tag(available_image),
		update_available: installed && update_wanted(installed_image, target),
		// De dónde sale `available_image`: el pin, el registro o la versión que fija el servidor.
		available_source: target?.source ?? null,
		version_hold: APPS_AL_PIN.has(sub.slug) ? null : describe_hold(policy.holds.get(sub.slug)),
		// Lo más nuevo del registro, se tome o no (con el interruptor en NO solo se enseña).
		discovered_tag: subject_image_tag(rec?.discovered_image),
		discovered_note: rec?.discovered_note ?? null,
		depends_on: [...(sub.depends_on ?? [])],
		required_by: blocking_dependents(
			deps.subjects,
			sub.technical_id,
			is_live,
		),
		missing_dependencies: missing_or_empty(
			deps.subjects,
			sub.technical_id,
			is_ready,
		),
		// Un recurso compartido (`/pedidos`, `/products`) se atribuye a su dueña,
		// igual que en el menú (`reshape_subject_menus`): si no, el front casaba
		// el recurso con la primera app que lo declarara.
		modules: sub.modules
			.filter(
				(m) =>
					!PREFER_OWNER[m.resource] ||
					PREFER_OWNER[m.resource] === sub.slug,
			)
			.map((m) => ({
				resource: m.resource,
				path: m.path,
				name: m.name,
			})),
	};
}

export async function seed_missing_install_rows(
	store: ImperiumStore,
	sql: Bun.SQL,
): Promise<void> {
	const recs = await install_records(sql);
	const all_modules = await collect_resource(store, 'module-management');
	const planned = planned_missing_install_rows(
		store.subjects,
		recs.keys(),
		(sub) => {
			const info = store.subjects.find(
				(item) => item.technical_id === sub.technical_id,
			);
			if (!info) return false;
			if (is_base_subject_slug(info.slug)) return true;
			return subject_is_installed(
				undefined,
				filter_module_rows(all_modules, info),
			);
		},
	);
	for (const row of planned) {
		await write_install_row(
			sql,
			row.technical_id,
			row.installed,
			null,
			row.installed ? 'installed' : 'not_installed',
		);
	}
}

export async function list_catalog_subjects(
	store: ImperiumStore,
	sql: Bun.SQL,
) {
	await seed_missing_install_rows(store, sql);
	// Foto ANTES de leer: si un trabajo asentaba entre la lectura y la
	// comprobación, la reconciliación pisaba su fila recién escrita.
	const running = new Set(in_flight.keys());
	const recs = await install_records(sql);
	for (const rec of recs.values()) {
		const write = stale_lifecycle_write(
			rec,
			running.has(rec.technical_id) || in_flight.has(rec.technical_id),
		);
		if (!write) continue;
		await write_install_row(
			sql,
			write.technical_id,
			write.installed,
			rec.version,
			write.status,
		);
		rec.status = write.status;
		rec.installed = write.installed;
	}
	const all_modules = await collect_resource(store, 'module-management');
	const installed = await installed_from(store, recs, all_modules);
	const deps: DependencyView = { subjects: store.subjects, installed };
	const entries = new Map(
		(await list_catalog_entries(sql)).map((entry) => [entry.technical_id, entry]),
	);
	const policy = await read_update_policy(store);
	const out = [];
	for (const sub of store.subjects) {
		const rows = filter_module_rows(all_modules, sub);
		const rec = recs.get(sub.technical_id);
		const row = catalog_row(sub, subject_is_installed(rec, rows), rec, deps, running, policy);
		const entry = entries.get(sub.technical_id);
		if (
			!catalog_visible({
				slug: sub.slug,
				installed: row.installed,
				busy: row.busy,
				status: row.status,
				authorized: Boolean(entry),
			})
		) {
			continue;
		}
		out.push({ ...row, external: false, catalog_source: entry?.source ?? null });
	}
	for (const entry of entries.values()) {
		if (store.subjects.some((sub) => sub.technical_id === entry.technical_id)) continue;
		out.push(external_catalog_row(entry));
	}
	return out;
}

/**
 * Fila de `GET /subjects` para una app del catálogo que este núcleo no conoce
 * (externa): se ve, pero no se puede instalar desde aquí.
 */
function external_catalog_row(entry: CatalogEntry) {
	return {
		slug: entry.slug,
		name: entry.name,
		path: '',
		menu_ref: '',
		technical_id: entry.technical_id,
		image: entry.image ?? '',
		icon: `subject:${entry.slug}`,
		installed: false,
		status: 'not_installed',
		busy: false,
		base: false,
		installed_at: null,
		installed_image: null,
		available_image: entry.image,
		installed_tag: '',
		available_tag: subject_image_tag(entry.image),
		update_available: false,
		depends_on: [] as string[],
		required_by: [] as string[],
		missing_dependencies: [] as string[],
		modules: [] as Array<{ resource: string; path: string; name: string }>,
		external: true,
		catalog_source: entry.source,
	};
}

async function upsert_subject_marker(
	store: ImperiumStore,
	sub: SubjectInfo,
	enabled: boolean,
) {
	if (!store.has('module-management')) return;
	const rows = await matching_module_rows(store, sub);
	if (!rows.length) {
		await store.insert('module-management', {
			name: subject_marker_display_name(sub),
			description: `App ${sub.slug}`,
			path: sub.path,
			_ref: sub.technical_id,
			is_enable: enabled,
			is_active: true,
			module_name: sub.slug,
			module_location: 'components',
		});
		return;
	}
	for (const row of rows) {
		await store.update('module-management', String(row._id), {
			is_enable: enabled,
		});
	}
}

/**
 * `image` va al final y es opcional a propósito: hay siete llamadores
 * posicionales y casi ninguno sabe la imagen. Los que no la pasan NO deben
 * borrar la guardada, de ahí el `COALESCE` — el mismo patrón que `version`.
 */
async function write_install_row(
	sql: Bun.SQL,
	technical_id: string,
	installed: boolean,
	version: number | null,
	status?: string,
	image?: string | null,
) {
	await ensure_install_table(sql);
	const next_status =
		status || (installed ? 'installed' : 'uninstalled');
	const image_value = image ? String(image) : null;
	if (installed) {
		await sql.unsafe(
			`INSERT INTO public.subject_installs
        (technical_id, installed, status, installed_at, uninstalled_at, version, installed_image)
       VALUES ($1, TRUE, $3, NOW(), NULL, $2, $4)
       ON CONFLICT (technical_id) DO UPDATE SET
         installed = TRUE,
         status = EXCLUDED.status,
         installed_at = COALESCE(public.subject_installs.installed_at, NOW()),
         uninstalled_at = NULL,
         version = COALESCE(EXCLUDED.version, public.subject_installs.version),
         installed_image = COALESCE(
           EXCLUDED.installed_image,
           public.subject_installs.installed_image
         )`,
			[technical_id, version, next_status, image_value],
		);
		return;
	}
	const stamp_uninstall =
		next_status === 'uninstalled' || next_status === 'uninstalling';
	// Desinstalada de verdad: ya no corre ninguna imagen, así que se olvida.
	// Mientras está `uninstalling` se conserva, por si el Docker falla y hay
	// que dejar la fila como estaba.
	await sql.unsafe(
		`INSERT INTO public.subject_installs
      (technical_id, installed, status, installed_at, uninstalled_at, version, installed_image)
     VALUES ($1, FALSE, $3, NULL, CASE WHEN $4 THEN NOW() ELSE NULL END, $2, NULL)
     ON CONFLICT (technical_id) DO UPDATE SET
       installed = FALSE,
       status = EXCLUDED.status,
       uninstalled_at = CASE
         WHEN $4 THEN NOW()
         ELSE public.subject_installs.uninstalled_at
       END,
       installed_image = CASE
         WHEN $3 = 'uninstalled' THEN NULL
         ELSE public.subject_installs.installed_image
       END`,
		[technical_id, version, next_status, stamp_uninstall],
	);
}

/**
 * `subject_schema_versions.tables` es jsonb: normalmente llega como arreglo,
 * pero una fila escrita como texto ya serializado vuelve como string JSON (a
 * veces envuelto dos veces).
 */
export function read_schema_tables(raw: unknown): string[] {
	let value = raw;
	for (let i = 0; i < 3 && typeof value === 'string'; i++) {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	return Array.isArray(value) ? value.map((t) => String(t)) : [];
}

async function schema_version(
	sql: Bun.SQL,
	technical_id: string,
): Promise<{
	version: number | null;
	applied_at: string | null;
	tables: string[];
}> {
	try {
		const rows = (await sql.unsafe(
			`SELECT version, applied_at, tables
       FROM public.subject_schema_versions WHERE technical_id = $1`,
			[technical_id],
		)) as Array<{
			version: number;
			applied_at: Date | string;
			tables: unknown;
		}>;
		const row = rows[0];
		if (!row) return { version: null, applied_at: null, tables: [] };
		return {
			version: Number(row.version),
			applied_at: row.applied_at ? String(row.applied_at) : null,
			tables: read_schema_tables(row.tables),
		};
	} catch {
		return { version: null, applied_at: null, tables: [] };
	}
}

async function schema_weights(
	sql: Bun.SQL,
	technical_id: string,
): Promise<{ data_bytes: number; install_bytes: number; tables: string[] }> {
	const schema = pg_schema_name(technical_id);
	if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) {
		return { data_bytes: 0, install_bytes: 0, tables: [] };
	}
	try {
		const sizes = (await sql.unsafe(
			`SELECT
        COALESCE(SUM(pg_table_size(c.oid)), 0)::bigint AS data_bytes,
        COALESCE(SUM(pg_total_relation_size(c.oid) - pg_table_size(c.oid)), 0)::bigint AS install_bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'm', 'p')`,
			[schema],
		)) as Array<{
			data_bytes: string | number;
			install_bytes: string | number;
		}>;
		const tables = (await sql.unsafe(
			`SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r'
       ORDER BY 1`,
			[schema],
		)) as Array<{ name: string }>;
		return {
			data_bytes: Number(sizes[0]?.data_bytes ?? 0),
			install_bytes: Number(sizes[0]?.install_bytes ?? 0),
			tables: tables.map((t) => t.name),
		};
	} catch {
		return { data_bytes: 0, install_bytes: 0, tables: [] };
	}
}

async function probe_health(
	technical_id: string,
): Promise<{ health: string; reachable: boolean }> {
	const base = subject_base_url(technical_id).replace(/\/$/, '');
	try {
		const res = await fetch(`${base}/schema`, {
			signal: AbortSignal.timeout(800),
		});
		if (res.ok) return { health: 'ok', reachable: true };
		return { health: `http_${res.status}`, reachable: false };
	} catch {
		return { health: 'unreachable', reachable: false };
	}
}

export type SubjectNotInstalledDetails = {
	slug: string;
	name: string;
	technical_id: string;
	resource?: string;
};

export class SubjectNotInstalledError extends Error {
	status = 404;
	code = 'subject_not_installed';
	details?: SubjectNotInstalledDetails;
	constructor(
		details?: SubjectNotInstalledDetails,
		message = details?.name
			? `${details.name} no está instalada`
			: 'Esta app no está instalada',
	) {
		super(message);
		this.name = 'SubjectNotInstalledError';
		this.details = details;
	}
}

export function subject_not_installed_body(err: SubjectNotInstalledError) {
	return {
		message: err.message,
		error: err.message,
		code: err.code,
		details: err.details,
	};
}

export class SubjectLifecycleError extends Error {
	status = 400;
	code = 'subject_lifecycle';
	details?: Record<string, unknown>;
	constructor(
		message: string,
		status = 400,
		code = 'subject_lifecycle',
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = 'SubjectLifecycleError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

/**
 * Candado de `/subjects`: leer basta con una sesión interna o el maestro de
 * gateway; todo lo que no sea lectura (instalar, desinstalar, actualizar, el
 * interruptor de auto-actualización) exige administrador o el maestro.
 */
export function subjects_access_denied(
	method: string,
	actor: ImperiumDoc | null,
	master: boolean,
): Response | null {
	if (master) return null;
	if (!actor) {
		return Response.json(
			{ error: 'No estás autenticado', message: 'No estás autenticado' },
			{ status: 401 },
		);
	}
	const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
	if (read || is_seed_admin(actor)) return null;
	return Response.json(
		{
			error: 'admin_required',
			code: 'admin_required',
			message: 'Solo un administrador puede instalar o desinstalar apps',
		},
		{ status: 403 },
	);
}

/** Cuerpo HTTP de un `SubjectLifecycleError`: `code` y `details` para el front. */
export function subject_lifecycle_body(err: SubjectLifecycleError) {
	return {
		error: err.code,
		code: err.code,
		message: err.message,
		details: err.details,
	};
}

function subject_ref(subjects: readonly DependencyNode[], technical_id: string) {
	const sub = subjects.find((s) => s.technical_id === technical_id);
	return {
		technical_id,
		slug: sub?.slug ?? technical_id.replace(/^subject-/, ''),
		name: sub?.name ?? sub?.slug ?? technical_id,
	};
}

/**
 * 409 si quitar `target` rompería apps vivas que dependen de ella (directa o
 * transitivamente); `null` si se puede desinstalar.
 */
export function uninstall_dependents_error(
	subjects: readonly DependencyNode[],
	target: string,
	is_live: (technical_id: string) => boolean,
): SubjectLifecycleError | null {
	const dependents = blocking_dependents(subjects, target, is_live).map(
		(tid) => subject_ref(subjects, tid),
	);
	if (!dependents.length) return null;
	const sub = subject_ref(subjects, target);
	return new SubjectLifecycleError(
		`No se puede desinstalar ${sub.name}: la usan ${dependents.map((d) => d.name).join(', ')}`,
		409,
		'subject_has_dependents',
		{ ...sub, dependents },
	);
}

export type InstallChainStep = {
	technical_id: string;
	/** `wait`: otro trabajo ya la está instalando; se espera, no se relanza. */
	kind: 'install' | 'update' | 'wait';
	/**
	 * Solo en la actualización de la app pedida: la imagen elegida en la
	 * admisión. Si se recalculara al correr, una versión recién descubierta
	 * que aún no cumple su espera podría colarse entre admitir y ejecutar.
	 */
	image?: string;
	/** De dónde salió `image`: decide si se revisa y si puede caer al pin. */
	image_source?: ImageSource;
};

/**
 * Pasos para instalar (o actualizar) `target`: sus dependencias faltantes en
 * orden y `target` al final. Lanza `SubjectLifecycleError` 409 si el grafo está
 * roto o si una dependencia se está desinstalando.
 */
export function build_install_chain(
	subjects: readonly DependencyNode[],
	target: string,
	op: 'install' | 'update',
	is_ready: (technical_id: string) => boolean,
	busy_op: (technical_id: string) => LifecycleOp | undefined,
): InstallChainStep[] {
	let plan: string[];
	try {
		plan = plan_subject_install(subjects, target, is_ready);
	} catch (err) {
		if (!(err instanceof SubjectDependencyError)) throw err;
		throw new SubjectLifecycleError(err.message, 409, err.code, err.details);
	}
	return plan.map((tid): InstallChainStep => {
		if (tid === target) return { technical_id: tid, kind: op };
		const busy = busy_op(tid);
		if (busy === 'uninstall') {
			const sub = subject_ref(subjects, target);
			const dependency = subject_ref(subjects, tid);
			throw new SubjectLifecycleError(
				`No se puede ${op === 'install' ? 'instalar' : 'actualizar'} ${sub.name}: ${dependency.name} se está desinstalando`,
				409,
				'dependency_busy',
				{ ...sub, dependency },
			);
		}
		return { technical_id: tid, kind: busy ? 'wait' : 'install' };
	});
}

/** Pone la imagen elegida en el paso que actualiza `target`. */
function with_target_image(
	steps: InstallChainStep[],
	target: string,
	image: string | null | undefined,
	image_source: ImageSource,
): InstallChainStep[] {
	if (!image) return steps;
	return steps.map((step) =>
		step.technical_id === target && step.kind === 'update'
			? { ...step, image, image_source }
			: step,
	);
}

export type InstallChainGroup = {
	target: string;
	steps: InstallChainStep[];
	/** Dependencias que instala un grupo anterior: si falla, este no corre. */
	needs: string[];
};

/**
 * Cadena de "Actualizar todas": un grupo por app, cada uno con las
 * dependencias que le falten y que ningún grupo anterior ya instale. Un fallo
 * corta su grupo y los que lo necesitan, no el resto. Las apps con un problema
 * de dependencias se saltan y se informan.
 */
export function build_update_all_chain(
	subjects: readonly DependencyNode[],
	targets: readonly string[],
	is_ready: (technical_id: string) => boolean,
	busy_op: (technical_id: string) => LifecycleOp | undefined,
): {
	groups: InstallChainGroup[];
	skipped: Array<{ technical_id: string; code: string; message: string }>;
} {
	const queued = new Set<string>();
	const groups: InstallChainGroup[] = [];
	const skipped: Array<{ technical_id: string; code: string; message: string }> = [];
	for (const target of targets) {
		let steps: InstallChainStep[];
		try {
			steps = build_install_chain(
				subjects,
				target,
				'update',
				(tid) => is_ready(tid) || queued.has(tid),
				busy_op,
			);
		} catch (err) {
			if (!(err instanceof SubjectLifecycleError)) throw err;
			skipped.push({ technical_id: target, code: err.code, message: err.message });
			continue;
		}
		const needs = missing_dependencies(subjects, target, is_ready).filter((tid) =>
			queued.has(tid),
		);
		for (const step of steps) queued.add(step.technical_id);
		groups.push({ target, steps, needs });
	}
	return { groups, skipped };
}

function emit_subject_event(
	payload: Record<string, unknown>,
	job?: JobCtx | null,
) {
	const phase = String(payload.phase ?? '');
	const status = String(payload.status ?? '');
	const progress = background_job_progress(
		phase,
		status === 'error' || phase === 'error'
			? 'error'
			: phase === 'done'
				? 'success'
				: 'running',
	);
	const data = { ...payload, progress };
	broadcast_event('update', {
		action: 'subjects_changed',
		data: [data],
	});
	if (job?.store && job.notification_id) {
		// Bun termina el proceso ante un rechazo sin atender: un fallo al
		// guardar el progreso no puede tumbar el núcleo a mitad de la cadena.
		void persist_job_from_event(job, data).catch((err) =>
			print_console_log(
				'warning',
				`No se guardó el progreso del trabajo de ${String(payload.slug ?? '')}: ${error_text(err)}`,
			),
		);
	}
}

async function persist_job_from_event(
	job: JobCtx,
	event: Record<string, unknown>,
) {
	if (!job.notification_id) return;
	const doc = await job.store.find_id('notifications', job.notification_id);
	if (!doc) return;
	const current = read_background_job_payload(doc);
	if (!current) return;
	const next = merge_background_job_payload(current, {
		phase: String(event.phase ?? ''),
		status: String(event.status ?? ''),
		level: (event.level as BackgroundJobLevel) || 'info',
		message: String(event.message ?? ''),
		progress: Number(event.progress ?? 0) || undefined,
		name: String(event.name ?? current.name),
		slug: String(event.slug ?? current.slug),
	});
	await persist_background_job(
		job.store,
		job.notification_id,
		next,
		String(event.message ?? current.logs.at(-1)?.message ?? ''),
	);
	if (next.status !== 'running' && job.recipient_id) {
		notify_background_job_refresh(
			job.recipient_id,
			job.notification_id,
			'background_job_done',
		);
	}
}

export async function technical_id_is_installed(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_id: string,
): Promise<boolean> {
	const sub = store.subjects.find((s) => s.technical_id === technical_id);
	if (!sub) return false;
	if (is_base_subject_slug(sub.slug)) return true;
	const recs = await install_records(sql);
	const rec = recs.get(technical_id);
	if (rec != null) return rec.installed;
	const rows = await matching_module_rows(store, sub);
	return subject_is_installed(undefined, rows);
}

export async function assert_subject_resource_access(
	store: ImperiumStore,
	sql: Bun.SQL,
	resource: string,
): Promise<void> {
	const loc = store.locs.get(resource);
	if (!loc) return;
	if (is_base_subject_slug(loc.slug)) return;
	if (await technical_id_is_installed(store, sql, loc.technical_id)) return;
	const sub = store.subjects.find((item) => item.technical_id === loc.technical_id);
	throw new SubjectNotInstalledError({
		slug: sub?.slug ?? loc.slug,
		name: sub?.name ?? loc.name,
		technical_id: loc.technical_id,
		resource: loc.resource,
	});
}

async function begin_subject_lifecycle(
	store: ImperiumStore,
	sql: Bun.SQL,
	sub: SubjectInfo,
	installed: boolean,
	job?: JobCtx | null,
) {
	const technical_id = sub.technical_id;
	const ver = await schema_version(sql, technical_id);
	const busy_status = installed ? 'installing' : 'uninstalling';
	/**
	 * Si la app ya estaba instalada, un reintento que falle no debe dejarla
	 * desinstalada: el acceso se decide por este booleano, no por el estado.
	 * Solo al instalar: una desinstalación que falle sí deja `installed=false`,
	 * que es lo correcto —el contenedor ya no está y el marcador va deshabilitado.
	 */
	const was_installed =
		installed &&
		((await install_records(sql)).get(technical_id)?.installed ?? false);
	if (!installed) {
		await upsert_subject_marker(store, sub, false);
		await write_install_row(
			sql,
			technical_id,
			false,
			ver.version,
			busy_status,
		);
		// Corta también los flujos internos que cruzan apps.
		store.mark_subject_installed(technical_id, false);
		emit_subject_event(
			{
				technical_id: sub.technical_id,
				slug: sub.slug,
				name: sub.name,
				installed: false,
				status: busy_status,
				phase: 'sql',
				level: 'info',
				message: `Desinstalando ${sub.name}…`,
			},
			job,
		);
	} else {
		await write_install_row(
			sql,
			technical_id,
			was_installed,
			ver.version,
			busy_status,
		);
		emit_subject_event(
			{
				technical_id: sub.technical_id,
				slug: sub.slug,
				name: sub.name,
				installed: was_installed,
				status: busy_status,
				phase: 'sql',
				level: 'info',
				message: `Instalando ${sub.name}…`,
			},
			job,
		);
	}
	return { ver, busy_status, was_installed };
}

async function finish_subject_lifecycle(
	store: ImperiumStore,
	sql: Bun.SQL,
	sub: SubjectInfo,
	installed: boolean,
	ver: { version: number | null },
	busy_status: string,
	was_installed: boolean,
	job?: JobCtx | null,
) {
	const technical_id = sub.technical_id;
	const op = installed ? 'install' : 'uninstall';
	// Desinstalar borra la imagen que corre (con versiones descubiertas ya no
	// suele ser el pin) y reinstalar una app instalada no la regresa al pin.
	const rec = (await install_records(sql)).get(technical_id);
	let image = !installed
		? (rec?.installed_image ?? sub.image)
		: was_installed
			? reinstall_image(sub, rec, await read_update_policy(store))
			: sub.image;
	if (installed && image !== sub.image && image !== rec?.installed_image) {
		// Una versión fijada por «Sincronizar» pasa la misma revisión que por el botón.
		const fits = await check_image_fits_catalog(sub, image, rec?.installed_image);
		if (!fits.ok) {
			image = rec?.installed_image ?? sub.image;
			emit_subject_event(
				{
					technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: was_installed,
					status: busy_status,
					phase: 'check',
					level: 'warning',
					message: `${fits.message}; se conserva ${subject_image_tag(image)}`,
				},
				job,
			);
		}
	}
	const docker = await run_subject_docker(
		op,
		{ slug: sub.slug, image },
		(event) => {
			emit_subject_event(
				{
					technical_id: sub.technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: false,
					status: busy_status,
					phase: event.phase,
					level: event.level,
					message: event.message,
				},
				job,
			);
		},
	);

	if (installed && !docker.ok && !docker.skipped) {
		await write_install_row(
			sql,
			technical_id,
			was_installed,
			ver.version,
			'error',
		);
		emit_subject_event(
			{
				technical_id: sub.technical_id,
				slug: sub.slug,
				name: sub.name,
				installed: was_installed,
				status: 'error',
				phase: 'error',
				level: 'error',
				message: `No se pudo instalar ${sub.name}: ${docker.error}`,
			},
			job,
		);
		throw new SubjectLifecycleError(
			docker.error || 'Falló Docker al instalar la app',
			502,
			'docker_failed',
		);
	}

	if (installed && !docker.skipped) {
		const schema = await apply_subject_schema_from_url(
			sql,
			technical_id,
			subject_base_url(technical_id),
		);
		if (!schema.ok) {
			emit_subject_event(
				{
					technical_id: sub.technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: false,
					status: 'installing',
					phase: 'schema',
					level: 'warning',
					message: `El contenedor arrancó, pero no se alcanzó /schema (${schema.error})`,
				},
				job,
			);
		}
	}

	await upsert_subject_marker(store, sub, installed);
	if (installed) {
		try {
			const { ensure_installed_subject_menus } = await import(
				'./subject-menu-seed.ts'
			);
			await ensure_installed_subject_menus(store, [sub]);
		} catch {
			/* menú-management ausente */
		}
	}
	await write_install_row(
		sql,
		technical_id,
		installed,
		ver.version,
		installed ? 'installed' : 'uninstalled',
		// Queda registrado CON QUÉ imagen se instaló. Si el operador se saltó
		// Docker no se inventa nada: sin contenedor no hay imagen que anotar.
		installed && !docker.skipped ? docker.image : null,
	);
	store.mark_subject_installed(technical_id, installed);
	// Sin esperar al próximo arranque: el empleado predeterminado del admin.
	if (installed && technical_id === 'subject-rh') await store.seed_default_employee();
	const wanted_docker = docker_runtime_wanted();
	const docker_note =
		installed && docker.skipped && wanted_docker
			? 'instalada en SQL, pero no hay operador Docker'
			: !installed && !docker.ok && !docker.skipped
				? `acceso cortado; Docker: ${docker.error}`
				: installed
					? `${sub.name} instalada`
					: `${sub.name} desinstalada. La base de datos se conserva.`;
	emit_subject_event(
		{
			technical_id: sub.technical_id,
			slug: sub.slug,
			name: sub.name,
			installed,
			status: installed ? 'installed' : 'uninstalled',
			phase: 'done',
			level: !docker.ok && !docker.skipped ? 'warning' : 'success',
			message: docker_note,
		},
		job,
	);
	return {
		technical_id: sub.technical_id,
		slug: sub.slug,
		path: sub.path,
		name: sub.name,
		installed,
		status: installed ? 'installed' : 'uninstalled',
		docker,
	};
}

export async function set_subject_installed(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_id: string,
	installed: boolean,
	job?: JobCtx | null,
) {
	const sub = store.subjects.find((s) => s.technical_id === technical_id);
	if (!sub) return null;
	if (!installed && is_base_subject_slug(sub.slug)) {
		throw new SubjectLifecycleError(
			'Las apps base no se pueden desinstalar',
			400,
			'base_subject',
		);
	}
	if (!installed) {
		const busy = new Map(in_flight);
		const ready = await installed_technical_ids(store, sql);
		const blocked = uninstall_dependents_error(
			store.subjects,
			technical_id,
			(tid) => ready.has(tid) || is_live_job(busy.get(tid)),
		);
		if (blocked) throw blocked;
	}
	const started = await begin_subject_lifecycle(
		store,
		sql,
		sub,
		installed,
		job,
	);
	return finish_subject_lifecycle(
		store,
		sql,
		sub,
		installed,
		started.ver,
		started.busy_status,
		started.was_installed,
		job,
	);
}

const JOB_KIND: Record<LifecycleOp, BackgroundJobKind> = {
	install: 'subject_install',
	uninstall: 'subject_uninstall',
	update: 'subject_update',
};

const JOB_VERB: Record<LifecycleOp, string> = {
	install: 'Instalando',
	uninstall: 'Desinstalando',
	update: 'Actualizando',
};

/** Un paso de la cadena en ejecución. */
type ChainRun = {
	sub: SubjectInfo;
	kind: LifecycleOp | 'wait';
	job: JobCtx | null;
	notification: ImperiumDoc | null;
	/** Solo en los pasos propios; un `wait` es trabajo de otro. */
	settle?: () => void;
	/** `begin` de instalar/desinstalar: con qué dejar la fila si se corta. */
	started?: Awaited<ReturnType<typeof begin_subject_lifecycle>>;
	/** Actualización ya marcada `updating` en la admisión: si se corta, vuelve a `installed`. */
	queued_update?: boolean;
	wait?: Promise<unknown>;
	/** Imagen elegida en la admisión (`InstallChainStep.image`) y de dónde salió. */
	image?: string;
	image_source?: ImageSource;
};

type ChainRunGroup = { target: string; runs: ChainRun[]; needs: string[] };

function error_text(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Cierra con error un paso propio que no llegó a correr; la app queda como estaba. */
async function cut_run(sql: Bun.SQL, run: ChainRun, message: string) {
	try {
		if (run.kind === 'install' && run.started) {
			await write_install_row(
				sql,
				run.sub.technical_id,
				run.started.was_installed,
				run.started.ver.version,
				'error',
			);
		}
		if (run.kind === 'update' && run.queued_update) {
			await write_install_row(sql, run.sub.technical_id, true, null, 'installed');
		}
	} catch {
		// Sin job en vuelo, el listado reconcilia la fila transitoria que quede.
	}
	emit_subject_event(
		{
			technical_id: run.sub.technical_id,
			slug: run.sub.slug,
			name: run.sub.name,
			installed:
				run.kind === 'update' || (run.started?.was_installed ?? false),
			status: run.kind === 'update' ? 'installed' : 'error',
			phase: 'error',
			level: 'error',
			message,
		},
		run.job,
	);
	run.settle?.();
}

/**
 * Abre un paso propio antes del 202: lo registra en `in_flight`, le da su
 * propia notificación (un job por app: mezclar eventos de varias le cambiaba
 * el nombre y lo daba por terminado con el primer `done`) y, al instalar o
 * desinstalar, hace el `begin` para que el listado ya lo vea ocupado.
 */
async function open_run(
	store: ImperiumStore,
	sql: Bun.SQL,
	sub: SubjectInfo,
	kind: LifecycleOp,
	actor: ImperiumDoc | null,
): Promise<ChainRun> {
	const run: ChainRun = {
		sub,
		kind,
		job: null,
		notification: null,
		settle: claim(sub.technical_id, kind).settle,
	};
	try {
		const uid = actor_uid(actor);
		run.notification = await create_background_job_notification(store, {
			recipient_id: uid,
			actor,
			job_kind: JOB_KIND[kind],
			technical_id: sub.technical_id,
			slug: sub.slug,
			name: sub.name,
			message: `${JOB_VERB[kind]} ${sub.name}…`,
		});
		run.job = {
			store,
			notification_id: run.notification?._id
				? String(run.notification._id)
				: undefined,
			recipient_id: uid,
		};
		if (uid && run.job.notification_id) {
			notify_background_job_refresh(
				uid,
				run.job.notification_id,
				'background_job_start',
			);
		}
		if (kind !== 'update') {
			run.started = await begin_subject_lifecycle(
				store,
				sql,
				sub,
				kind === 'install',
				run.job,
			);
		} else {
			// Ocupada desde el 202: mientras espera su turno (o a sus
			// dependencias) el listado la daba por terminada y el front
			// anunciaba "actualizada" antes de tiempo. Sigue instalada.
			await write_install_row(sql, sub.technical_id, true, null, 'updating');
			run.queued_update = true;
			emit_subject_event(
				{
					technical_id: sub.technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: true,
					status: 'updating',
					phase: 'sql',
					level: 'info',
					message: `${JOB_VERB.update} ${sub.name}…`,
				},
				run.job,
			);
		}
		return run;
	} catch (err) {
		await cut_run(sql, run, `No se pudo preparar ${sub.name}: ${error_text(err)}`);
		throw err;
	}
}

/**
 * Abre todos los pasos propios de la cadena. Los `wait` guardan la promesa
 * del trabajo ajeno que vieron en `busy`. Si uno falla, los ya abiertos se
 * cierran con error y se relanza.
 */
async function open_chain(
	store: ImperiumStore,
	sql: Bun.SQL,
	groups: readonly InstallChainGroup[],
	busy: ReadonlyMap<string, InFlightJob>,
	actor: ImperiumDoc | null,
): Promise<ChainRunGroup[]> {
	const opened: ChainRun[] = [];
	const out: ChainRunGroup[] = [];
	try {
		for (const group of groups) {
			const runs: ChainRun[] = [];
			for (const step of group.steps) {
				const sub = store.subjects.find(
					(s) => s.technical_id === step.technical_id,
				)!;
				if (step.kind === 'wait') {
					runs.push({
						sub,
						kind: 'wait',
						job: null,
						notification: null,
						wait: busy.get(sub.technical_id)?.done,
					});
					continue;
				}
				const run = await open_run(store, sql, sub, step.kind, actor);
				run.image = step.image;
				run.image_source = step.image_source;
				opened.push(run);
				runs.push(run);
			}
			out.push({ target: group.target, runs, needs: group.needs });
		}
		return out;
	} catch (err) {
		for (const run of opened) {
			await cut_run(
				sql,
				run,
				`No se ${run.kind === 'update' ? 'actualizó' : 'instaló'} ${run.sub.name}: ${error_text(err)}`,
			);
		}
		throw err;
	}
}

/** Corre un paso y devuelve su error (texto) o `null`. Nunca lanza. */
async function run_step(
	store: ImperiumStore,
	sql: Bun.SQL,
	run: ChainRun,
): Promise<string | null> {
	const technical_id = run.sub.technical_id;
	try {
		if (run.kind === 'wait') {
			// La promesa ajena siempre resuelve: el resultado se relee.
			await run.wait;
			const installed = await installed_technical_ids(store, sql);
			return installed.has(technical_id)
				? null
				: `${run.sub.name} no quedó instalada`;
		}
		if (run.kind === 'update') {
			await run_subject_update(store, sql, run.sub, run.job, run.image, run.image_source);
			return null;
		}
		const started = run.started!;
		await finish_subject_lifecycle(
			store,
			sql,
			run.sub,
			run.kind === 'install',
			started.ver,
			started.busy_status,
			started.was_installed,
			run.job,
		);
		return null;
	} catch (err) {
		// Un fallo de Docker ya dejó su fila y su evento; el resto no. Una
		// espera nunca escribe: la fila es de otro trabajo. Actualizar nunca
		// desinstala: vuelve a `installed` con su imagen anterior.
		if (run.kind !== 'wait' && !(err instanceof SubjectLifecycleError)) {
			const update = run.kind === 'update';
			const installed = update || (run.started?.was_installed ?? false);
			await write_install_row(
				sql,
				technical_id,
				installed,
				run.started?.ver.version ?? null,
				update ? 'installed' : 'error',
			).catch(() => null);
			emit_subject_event(
				{
					technical_id,
					slug: run.sub.slug,
					name: run.sub.name,
					installed,
					status: update ? 'installed' : 'error',
					phase: 'error',
					level: 'error',
					message: update
						? `No se pudo actualizar ${run.sub.name}: ${error_text(err)}`
						: error_text(err),
				},
				run.job,
			);
		}
		return error_text(err);
	} finally {
		run.settle?.();
	}
}

/**
 * Corre la cadena en orden, en segundo plano. Un paso que falla corta lo que
 * queda de su grupo y los grupos que lo necesitan: cada paso cortado queda en
 * error con su `was_installed` y un aviso que nombra la dependencia. Nunca
 * rechaza; devuelve el error (o `null`) de cada paso propio.
 */
async function run_chain(
	store: ImperiumStore,
	sql: Bun.SQL,
	groups: readonly ChainRunGroup[],
): Promise<Map<string, string | null>> {
	const results = new Map<string, string | null>();
	const failed = new Set<string>();
	try {
		for (const group of groups) {
			let blocker = group.needs.find((tid) => failed.has(tid));
			for (const run of group.runs) {
				const technical_id = run.sub.technical_id;
				if (blocker) {
					if (run.kind === 'wait') continue;
					const dependency = subject_ref(store.subjects, blocker).name;
					const verb = run.kind === 'update' ? 'actualizó' : 'instaló';
					await cut_run(
						sql,
						run,
						`No se ${verb} ${run.sub.name}: falló su dependencia ${dependency}`,
					);
					results.set(technical_id, `falló su dependencia ${dependency}`);
					continue;
				}
				const error = await run_step(store, sql, run);
				if (run.kind !== 'wait') results.set(technical_id, error);
				if (error) {
					failed.add(technical_id);
					blocker = technical_id;
				}
			}
		}
	} finally {
		for (const group of groups) {
			for (const run of group.runs) run.settle?.();
		}
	}
	return results;
}

async function catalog_rows(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_ids: readonly string[],
) {
	const running = new Set(in_flight.keys());
	const recs = await install_records(sql);
	const installed = await installed_from(store, recs);
	const deps: DependencyView = { subjects: store.subjects, installed };
	const policy = await read_update_policy(store);
	return technical_ids.map((tid) =>
		catalog_row(
			store.subjects.find((s) => s.technical_id === tid)!,
			installed.has(tid),
			recs.get(tid),
			deps,
			running,
			policy,
		),
	);
}

/** Respuesta de una cadena de una sola app: su fila primero y luego las de sus dependencias. */
async function chain_accepted(
	store: ImperiumStore,
	sql: Bun.SQL,
	group: ChainRunGroup,
) {
	const deps = group.runs.filter((run) => run.sub.technical_id !== group.target);
	return {
		accepted: true,
		already_running: false,
		rows: await catalog_rows(store, sql, [
			group.target,
			...deps.map((run) => run.sub.technical_id),
		]),
		dependencies: deps.map((run) =>
			subject_ref(store.subjects, run.sub.technical_id),
		),
		notification:
			group.runs.find((run) => run.sub.technical_id === group.target)
				?.notification ?? null,
	};
}

/**
 * Instalar: primero las dependencias que falten, en cadena, y la app al final.
 * Desinstalar: 409 si alguna app viva la usa. Todo se admite bajo el mismo
 * candado y el trabajo Docker sigue en segundo plano.
 */
export async function accept_subject_lifecycle(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_id: string,
	installed: boolean,
	actor: ImperiumDoc | null,
) {
	const sub = store.subjects.find((s) => s.technical_id === technical_id);
	if (!sub) return null;
	if (!installed && is_base_subject_slug(sub.slug)) {
		throw new SubjectLifecycleError(
			'Las apps base no se pueden desinstalar',
			400,
			'base_subject',
		);
	}
	return admit(async () => {
		// La foto de `in_flight` va ANTES de leer la base: un trabajo que
		// termine entre medias sigue contando como vivo, nunca se pierde.
		const busy = new Map(in_flight);
		const ready = await installed_technical_ids(store, sql);
		if (!installed) {
			// Antes de `begin`: el begin de desinstalar corta el acceso al momento.
			const blocked = uninstall_dependents_error(
				store.subjects,
				technical_id,
				(tid) => ready.has(tid) || is_live_job(busy.get(tid)),
			);
			if (blocked) throw blocked;
		}
		if (in_flight.has(technical_id)) {
			return {
				accepted: true,
				already_running: true,
				rows: await catalog_rows(store, sql, [technical_id]),
				dependencies: [] as ReturnType<typeof subject_ref>[],
				notification: null as ImperiumDoc | null,
			};
		}
		if (!installed) {
			const run = await open_run(store, sql, sub, 'uninstall', actor);
			void run_chain(store, sql, [
				{ target: technical_id, runs: [run], needs: [] },
			]);
			return {
				accepted: true,
				already_running: false,
				rows: await catalog_rows(store, sql, [technical_id]),
				dependencies: [] as ReturnType<typeof subject_ref>[],
				notification: run.notification,
			};
		}
		const steps = build_install_chain(
			store.subjects,
			technical_id,
			'install',
			(tid) => ready.has(tid),
			(tid) => busy.get(tid)?.op,
		);
		const groups = await open_chain(
			store,
			sql,
			[{ target: technical_id, steps, needs: [] }],
			busy,
			actor,
		);
		void run_chain(store, sql, groups);
		return chain_accepted(store, sql, groups[0]!);
	});
}

/**
 * Rellena `installed_image` en las apps instaladas que no lo tienen,
 * preguntando al operador qué imagen corre su contenedor.
 *
 * Hace falta porque la columna llegó después: sin esto, una instancia ya
 * montada no vería NINGUNA actualización hasta reinstalar app por app. No es
 * adivinar — es `docker inspect` del contenedor vivo. Si no hay contenedor
 * (app parada, o sin operador), se deja en NULL: sigue siendo "no se sabe".
 */
export async function backfill_installed_images(
	store: ImperiumStore,
	sql: Bun.SQL,
): Promise<{ filled: number; unknown: number }> {
	const recs = await install_records(sql);
	let filled = 0;
	let unknown = 0;
	for (const sub of store.subjects) {
		const rec = recs.get(sub.technical_id);
		if (!rec?.installed || rec.installed_image) continue;
		const running = await resolve_running_subject_image(sub.slug);
		if (!running) {
			unknown += 1;
			continue;
		}
		await write_install_row(
			sql,
			sub.technical_id,
			true,
			rec.version,
			rec.status || 'installed',
			running,
		);
		filled += 1;
	}
	return { filled, unknown };
}

/**
 * Apps con actualización pendiente: instaladas, con imagen conocida y con un
 * objetivo más nuevo (pin, versión descubierta o fijada). Es la lista que
 * alimenta "Actualizar todas" y el trabajo automático; este último pasa
 * `accept_discovered` para exigir la espera de las descubiertas (sin ella, la
 * app va al pin si el pin es más nuevo que lo instalado).
 */
export async function list_subject_updates(
	store: ImperiumStore,
	sql: Bun.SQL,
	options?: { accept_discovered?: (created_at: string | null) => boolean },
): Promise<
	Array<{
		technical_id: string;
		slug: string;
		name: string;
		installed_image: string | null;
		available_image: string | null;
		installed_tag: string;
		available_tag: string;
		available_source: UpdateSource;
		available_created_at: string | null;
	}>
> {
	const recs = await install_records(sql);
	const policy = await read_update_policy(store);
	const out = [];
	for (const sub of store.subjects) {
		const rec = recs.get(sub.technical_id);
		if (!rec?.installed) continue;
		const target = target_for(sub, rec, policy, options?.accept_discovered);
		if (!target || !update_wanted(rec.installed_image, target)) continue;
		out.push({
			technical_id: sub.technical_id,
			slug: sub.slug,
			name: sub.name,
			installed_image: rec.installed_image,
			available_image: target.image,
			installed_tag: subject_image_tag(rec.installed_image),
			available_tag: subject_image_tag(target.image),
			available_source: target.source,
			available_created_at: target.created_at,
		});
	}
	return out;
}

/**
 * Antes de ir a una imagen que no es el pin, se lee su manifiesto (el
 * operador la baja) y se comprueba que lo que agrega ya está en el catálogo de
 * este servidor. Sin Docker no hay nada que comprobar ni que instalar.
 */
async function check_image_fits_catalog(
	sub: SubjectInfo,
	image: string,
	running_image: string | null | undefined,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
	const tag = subject_image_tag(image);
	const next = await read_subject_image_manifest(sub.slug, image);
	if (next.skipped) return { ok: true };
	if (!next.ok) {
		return {
			ok: false,
			code: 'manifest_unreadable',
			message: `No se pudo revisar la versión ${tag} de ${sub.name}: ${next.error}`,
		};
	}
	let current = await fetch(`${subject_base_url(sub.technical_id)}/manifest`, {
		signal: AbortSignal.timeout(10_000),
	})
		.then((res) => (res.ok ? (res.json() as Promise<Record<string, unknown>>) : null))
		.catch(() => null);
	// Una app caída (justo cuando se la quiere regresar) no contesta: su
	// manifiesto se lee entonces de la imagen que corre.
	if (!current && running_image) {
		const from_image = await read_subject_image_manifest(sub.slug, running_image);
		if (from_image.ok && !from_image.skipped) current = from_image.manifest;
	}
	const fits = manifest_fits_catalog(sub, next.manifest, current, is_base_subject_slug);
	if (fits.ok) return { ok: true };
	if (!current) {
		// Sin el manifiesto de lo que corre no se sabe qué AGREGA la versión
		// nueva (tienda declara recursos que el catálogo nunca lista): un
		// reinicio de la app no debe marcarla `needs_catalog` para siempre.
		return {
			ok: false,
			code: 'live_manifest_unreadable',
			message: `No se pudo leer el manifiesto de ${sub.name} en ejecución para revisar la versión ${tag}`,
		};
	}
	const falta = [
		fits.dependencies.length ? `dependencias ${fits.dependencies.join(', ')}` : '',
		fits.resources.length ? `recursos ${fits.resources.join(', ')}` : '',
	]
		.filter(Boolean)
		.join(' y ');
	return {
		ok: false,
		code: NEEDS_CATALOG,
		message: `La versión ${tag} de ${sub.name} necesita un catálogo más nuevo (${falta}); sigue en la actual`,
	};
}

/**
 * Actualiza una app instalada a la imagen que pide el catálogo.
 *
 * A diferencia de instalar/desinstalar, la app NO cambia de estado: sigue
 * instalada de principio a fin. Por eso aquí no se toca el marcador de
 * `module-management` — apagarlo cortaría el acceso a mitad de un pull que
 * puede durar minutos, y si el pull falla la app se queda como estaba.
 *
 * Tras recrear el contenedor se reaplica el esquema: una versión nueva puede
 * traer tablas o columnas nuevas y sin esto la app arrancaría contra una base
 * vieja.
 */
export async function run_subject_update(
	store: ImperiumStore,
	sql: Bun.SQL,
	sub: SubjectInfo,
	job?: JobCtx | null,
	image?: string | null,
	image_source: ImageSource = 'catalog',
): Promise<SubjectRuntimeResult> {
	const technical_id = sub.technical_id;
	let target_image = image || sub.image;
	const ver = await schema_version(sql, technical_id);
	const running = (await install_records(sql)).get(technical_id)?.installed_image;
	// Regresar a una versión más vieja que la que corre no agrega nada que el
	// catálogo no conociera: no se revisa (y la app rota puede estar caída).
	const rollback =
		image_source === 'hold' &&
		Boolean(running) &&
		update_wanted(target_image, { image: running!, source: 'catalog', created_at: null });
	if (
		target_image !== sub.image &&
		(image_source === 'registry' || image_source === 'hold') &&
		!rollback
	) {
		const fits = await check_image_fits_catalog(sub, target_image, running);
		if (!fits.ok) {
			if (fits.code === NEEDS_CATALOG) {
				await mark_discovered_note(sql, technical_id, target_image, NEEDS_CATALOG);
			}
			// Una descubierta que no se pudo revisar no deja a la app sin el
			// pin, si el pin es más nuevo (operador viejo, app reiniciándose).
			// Una versión fijada no cae: se fijó a propósito.
			const to_pin =
				image_source === 'registry' &&
				update_wanted(running, { image: sub.image, source: 'catalog', created_at: null });
			emit_subject_event(
				{
					technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: true,
					status: to_pin ? 'updating' : 'installed',
					phase: to_pin ? 'check' : 'error',
					level: 'warning',
					message: to_pin
						? `${fits.message}; se instala la del catálogo (${subject_image_tag(sub.image)})`
						: fits.message,
				},
				job,
			);
			if (!to_pin) {
				await write_install_row(sql, technical_id, true, ver.version, 'installed');
				throw new SubjectLifecycleError(fits.message, 409, fits.code);
			}
			target_image = sub.image;
		}
	}
	await write_install_row(sql, technical_id, true, ver.version, 'updating');
	emit_subject_event(
		{
			technical_id,
			slug: sub.slug,
			name: sub.name,
			installed: true,
			status: 'updating',
			phase: 'start',
			level: 'info',
			message: `Actualizando ${sub.name}…`,
		},
		job,
	);
	const docker = await run_subject_docker(
		'update',
		{ slug: sub.slug, image: target_image },
		(event) => {
			emit_subject_event(
				{
					technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: true,
					status: 'updating',
					phase: event.phase,
					level: event.level,
					message: event.message,
				},
				job,
			);
		},
	);
	if (!docker.ok && !docker.skipped) {
		// La app sigue instalada con su imagen anterior: solo se deshace el
		// estado transitorio.
		await write_install_row(
			sql,
			technical_id,
			true,
			ver.version,
			'installed',
		);
		emit_subject_event(
			{
				technical_id,
				slug: sub.slug,
				name: sub.name,
				installed: true,
				status: 'installed',
				phase: 'error',
				level: 'error',
				message: `No se pudo actualizar ${sub.name}: ${docker.error}`,
			},
			job,
		);
		throw new SubjectLifecycleError(
			docker.error || 'Falló Docker al actualizar la app',
			502,
			'docker_failed',
		);
	}
	if (!docker.skipped) {
		const schema = await apply_subject_schema_from_url(
			sql,
			technical_id,
			subject_base_url(technical_id),
		);
		if (!schema.ok) {
			emit_subject_event(
				{
					technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: true,
					status: 'updating',
					phase: 'schema',
					level: 'warning',
					message: `${sub.name} actualizada, pero su esquema no se pudo aplicar`,
				},
				job,
			);
		}
	}
	const applied = await schema_version(sql, technical_id);
	await write_install_row(
		sql,
		technical_id,
		true,
		applied.version,
		'installed',
		docker.skipped ? null : docker.image,
	);
	store.mark_subject_installed(technical_id, true);
	emit_subject_event(
		{
			technical_id,
			slug: sub.slug,
			name: sub.name,
			installed: true,
			status: 'installed',
			phase: 'done',
			level: 'success',
			message: docker.skipped
				? `${sub.name}: no hay operador Docker, no se actualizó el contenedor`
				: `${sub.name} actualizada a ${subject_image_tag(docker.image)}`,
		},
		job,
	);
	return docker;
}

/**
 * Encola la actualización de TODAS las apps con versión nueva y devuelve al
 * momento con la lista de lo que va a tocar.
 *
 * Secuencial dentro de una única cadena: disparar veinte `docker pull` a la
 * vez satura la red del host y deja varias apps a medias. Cada app lleva su
 * propio job y queda `updating` desde que se admite, así que la pantalla las
 * va viendo terminar una por una. Si a una le falta una dependencia, se
 * instala antes, en la misma cadena.
 */
export async function accept_subject_update_all(
	store: ImperiumStore,
	sql: Bun.SQL,
	actor: ImperiumDoc | null,
) {
	return admit(async () => {
		const busy = new Map(in_flight);
		const pending = await list_subject_updates(store, sql);
		const ready = await installed_technical_ids(store, sql);
		const plan = build_update_all_chain(
			store.subjects,
			pending
				.filter((item) => !in_flight.has(item.technical_id))
				.map((item) => item.technical_id),
			(tid) => ready.has(tid),
			(tid) => busy.get(tid)?.op,
		);
		const targets = new Map(pending.map((item) => [item.technical_id, item]));
		for (const group of plan.groups) {
			const item = targets.get(group.target);
			group.steps = with_target_image(
				group.steps,
				group.target,
				item?.available_image,
				item?.available_source ?? 'catalog',
			);
		}
		const idle = {
			accepted: true,
			total: 0,
			slugs: [] as string[],
			dependencies: [] as ReturnType<typeof subject_ref>[],
			skipped: plan.skipped,
			notification: null as ImperiumDoc | null,
			notifications: [] as ImperiumDoc[],
		};
		if (!plan.groups.length) return idle;
		const groups = await open_chain(store, sql, plan.groups, busy, actor);
		void run_chain(store, sql, groups);
		const runs = groups.flatMap((group) => group.runs);
		return {
			...idle,
			total: groups.length,
			slugs: groups.map((group) => subject_ref(store.subjects, group.target).slug),
			dependencies: runs
				.filter((run) => run.kind !== 'update')
				.map((run) => subject_ref(store.subjects, run.sub.technical_id)),
			notification:
				groups[0]!.runs.find(
					(run) => run.sub.technical_id === groups[0]!.target,
				)?.notification ?? null,
			notifications: runs.flatMap((run) =>
				run.notification ? [run.notification] : [],
			),
		};
	});
}

/**
 * Encola la actualización de una app y devuelve al momento, igual que
 * instalar: el pull puede tardar minutos y la petición no se queda esperando.
 * Si le falta una dependencia (un catálogo nuevo puede añadirla), se instala
 * antes en la misma cadena. `done` resuelve con el error de la app (o `null`)
 * para quien sí quiera esperar, como la actualización automática.
 */
export async function accept_subject_update(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_id: string,
	actor: ImperiumDoc | null,
	options?: {
		/** Condición extra para tomar una versión descubierta (la espera de la pasada). */
		accept_discovered?: (created_at: string | null) => boolean;
		/** La pasada automática: sin una versión más nueva no se hace nada (devuelve `null`). */
		only_if_newer?: boolean;
	},
) {
	const sub = store.subjects.find((s) => s.technical_id === technical_id);
	if (!sub) return null;
	return admit(async () => {
		const busy = new Map(in_flight);
		const recs = await install_records(sql);
		if (!recs.get(technical_id)?.installed) {
			throw new SubjectLifecycleError(
				`${sub.name} no está instalada`,
				400,
				'not_installed',
			);
		}
		if (in_flight.has(technical_id)) {
			return {
				accepted: true,
				already_running: true,
				rows: await catalog_rows(store, sql, [technical_id]),
				dependencies: [] as ReturnType<typeof subject_ref>[],
				notification: null as ImperiumDoc | null,
				done: Promise.resolve<string | null>(null),
				image: null as string | null,
			};
		}
		// El objetivo se calcula aquí, con las filas recién leídas: elegido
		// antes (al listar) podía regresar una app que otro trabajo acababa de
		// subir, o ignorar una versión fijada entre medias.
		const rec = recs.get(technical_id);
		const policy = await read_update_policy(store);
		const hold = APPS_AL_PIN.has(sub.slug) ? undefined : policy.holds.get(sub.slug);
		const target = target_for(sub, rec, policy, options?.accept_discovered);
		const newer = Boolean(target && update_wanted(rec?.installed_image, target));
		if (options?.only_if_newer && !newer) return null;
		if (hold && 'freeze' in hold) {
			throw new SubjectLifecycleError(
				`${sub.name} está congelada en este servidor (configuration-subject-version-hold)`,
				409,
				'version_hold',
			);
		}
		// Sin una versión más nueva, «Actualizar» vuelve a bajar lo que corre
		// (un tag republicado), nunca un pin más viejo que lo instalado.
		const running = APPS_AL_PIN.has(sub.slug) ? null : (rec?.installed_image ?? null);
		// Una versión fijada se aplica aunque no se sepa qué corre (fila vieja).
		const forced = !newer && target?.source === 'hold' && target.image !== running;
		const image = newer || forced ? target!.image : (running ?? sub.image);
		const image_source: ImageSource =
			newer || forced ? target!.source : image === sub.image ? 'catalog' : 'running';
		const ready = await installed_from(store, recs);
		const steps = with_target_image(
			build_install_chain(
				store.subjects,
				technical_id,
				'update',
				(tid) => ready.has(tid),
				(tid) => busy.get(tid)?.op,
			),
			technical_id,
			image,
			image_source,
		);
		const groups = await open_chain(
			store,
			sql,
			[{ target: technical_id, steps, needs: [] }],
			busy,
			actor,
		);
		const done = run_chain(store, sql, groups).then(
			(results) => results.get(technical_id) ?? null,
		);
		return { ...(await chain_accepted(store, sql, groups[0]!)), done, image };
	});
}

export type SubjectDockerResult = SubjectRuntimeResult;


export async function get_subject_details(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_id: string,
) {
	const sub = store.subjects.find((s) => s.technical_id === technical_id);
	if (!sub) return null;
	const running = new Set(in_flight.keys());
	const [recs, module_pack, ver, weights, menu_pack, permission_pack] =
		await Promise.all([
			install_records(sql),
			collect_resource(store, 'module-management').then((rows) => ({ rows })),
			schema_version(sql, technical_id),
			schema_weights(sql, technical_id),
			collect_resource(store, 'menu-management').then((rows) => ({ rows })),
			collect_resource(store, 'access-rights').then((rows) => ({ rows })),
		]);
	const rec = recs.get(technical_id);
	const module_rows = filter_module_rows(module_pack.rows, sub);
	const installed = subject_is_installed(rec, module_rows);
	const deps: DependencyView = {
		subjects: store.subjects,
		installed: await installed_from(store, recs, module_pack.rows),
	};
	const health = installed
		? await probe_health(technical_id)
		: { health: 'not_installed', reachable: false };
	const paths = subject_paths(sub);
	const menus = menu_pack.rows
		.filter((row) => {
			const path = norm(row.path);
			const ref = String(row._ref ?? '');
			return (
				ref === sub.menu_ref ||
				(path &&
					(paths.has(path) ||
						path.startsWith(`${norm(sub.path)}/`)))
			);
		})
		.map((row) => ({
			name: String(row.name ?? ''),
			path: String(row.path ?? ''),
			icon: String(row.icon ?? ''),
		}));
	const resources = new Set(sub.modules.map((m) => m.resource));
	const permissions = permission_pack.rows
		.filter((row) => {
			const model = String(row.model_id ?? row.model ?? '');
			const name = String(row.name ?? '');
			return [...resources].some(
				(resource) =>
					resource_matches(model, resource) ||
					resource_matches(name, resource),
			);
		})
		.map((row) => ({
			name: String(row.name ?? ''),
			model_id: String(row.model_id ?? row.model ?? ''),
			allow_read: !is_disabled_flag(row.allow_read),
			allow_create: !is_disabled_flag(row.allow_create),
			allow_update: !is_disabled_flag(row.allow_update),
			allow_delete: !is_disabled_flag(row.allow_delete),
		}));
	const collections = [
		...new Set([
			...sub.modules.map((m) => m.resource),
			...ver.tables,
			...weights.tables,
		]),
	];
	const image_tag =
		String(sub.image ?? '')
			.split(':')
			.pop() || null;
	const status = !installed
		? rec?.status || 'not_installed'
		: health.reachable
			? 'ok'
			: health.health;
	return {
		...catalog_row(sub, installed, rec, deps, running, await read_update_policy(store)),
		permissions,
		menus,
		collections,
		health: health.health,
		reachable: health.reachable,
		version: ver.version ?? rec?.version ?? image_tag,
		image: sub.image,
		installed_at: rec?.installed_at ?? ver.applied_at,
		data_bytes: weights.data_bytes,
		install_bytes: weights.install_bytes,
		status,
		modules_enabled: modules_enabled(module_rows),
	};
}
