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
	type BackgroundJobLevel,
} from './background-job.ts';
import { broadcast_event } from './socket-stub.ts';
import { apply_subject_schema_from_url } from './subject-schema.ts';
import {
	docker_runtime_wanted,
	is_base_subject_slug,
	run_subject_docker,
	type SubjectRuntimeResult,
} from './subject-runtime.ts';
import type { ImperiumDoc, ImperiumStore, SubjectInfo } from './store.ts';

type JobCtx = {
	store: ImperiumStore;
	notification_id?: string;
	recipient_id?: string;
};

const in_flight = new Map<string, Promise<unknown>>();

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
};

async function install_records(sql: Bun.SQL): Promise<Map<string, InstallRec>> {
	await ensure_install_table(sql);
	const rows = (await sql.unsafe(
		`SELECT technical_id, installed, status, installed_at, uninstalled_at, version
     FROM public.subject_installs`,
	)) as Array<{
		technical_id: string;
		installed: boolean;
		status: string;
		installed_at: Date | string | null;
		uninstalled_at: Date | string | null;
		version: number | null;
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
		});
	}
	return out;
}

function catalog_row(sub: SubjectInfo, installed: boolean, rec?: InstallRec) {
	const status = rec?.status || (installed ? 'installed' : 'not_installed');
	return {
		slug: sub.slug,
		name: sub.name,
		path: sub.path,
		menu_ref: sub.menu_ref,
		technical_id: sub.technical_id,
		image: sub.image,
		icon: `subject:${sub.slug}`,
		installed,
		status,
		busy: status === 'installing' || status === 'uninstalling',
		base: is_base_subject_slug(sub.slug),
		installed_at: rec?.installed_at ?? null,
		modules: sub.modules.map((m) => ({
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
	const recs = await install_records(sql);
	const all_modules = await collect_resource(store, 'module-management');
	const out = [];
	for (const sub of store.subjects) {
		const rows = filter_module_rows(all_modules, sub);
		const rec = recs.get(sub.technical_id);
		const installed = subject_is_installed(rec, rows);
		out.push(catalog_row(sub, installed, rec));
	}
	return out;
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

async function write_install_row(
	sql: Bun.SQL,
	technical_id: string,
	installed: boolean,
	version: number | null,
	status?: string,
) {
	await ensure_install_table(sql);
	const next_status =
		status || (installed ? 'installed' : 'uninstalled');
	if (installed) {
		await sql.unsafe(
			`INSERT INTO public.subject_installs
        (technical_id, installed, status, installed_at, uninstalled_at, version)
       VALUES ($1, TRUE, $3, NOW(), NULL, $2)
       ON CONFLICT (technical_id) DO UPDATE SET
         installed = TRUE,
         status = EXCLUDED.status,
         installed_at = COALESCE(public.subject_installs.installed_at, NOW()),
         uninstalled_at = NULL,
         version = COALESCE(EXCLUDED.version, public.subject_installs.version)`,
			[technical_id, version, next_status],
		);
		return;
	}
	const stamp_uninstall =
		next_status === 'uninstalled' || next_status === 'uninstalling';
	await sql.unsafe(
		`INSERT INTO public.subject_installs
      (technical_id, installed, status, installed_at, uninstalled_at, version)
     VALUES ($1, FALSE, $3, NULL, CASE WHEN $4 THEN NOW() ELSE NULL END, $2)
     ON CONFLICT (technical_id) DO UPDATE SET
       installed = FALSE,
       status = EXCLUDED.status,
       uninstalled_at = CASE
         WHEN $4 THEN NOW()
         ELSE public.subject_installs.uninstalled_at
       END`,
		[technical_id, version, next_status, stamp_uninstall],
	);
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
		const tables = Array.isArray(row.tables)
			? row.tables.map((t) => String(t))
			: [];
		return {
			version: Number(row.version),
			applied_at: row.applied_at ? String(row.applied_at) : null,
			tables,
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
	constructor(message: string, status = 400, code = 'subject_lifecycle') {
		super(message);
		this.name = 'SubjectLifecycleError';
		this.status = status;
		this.code = code;
	}
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
		void persist_job_from_event(job, data);
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
	if (!installed) {
		await upsert_subject_marker(store, sub, false);
		await write_install_row(
			sql,
			technical_id,
			false,
			ver.version,
			busy_status,
		);
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
			false,
			ver.version,
			busy_status,
		);
		emit_subject_event(
			{
				technical_id: sub.technical_id,
				slug: sub.slug,
				name: sub.name,
				installed: false,
				status: busy_status,
				phase: 'sql',
				level: 'info',
				message: `Instalando ${sub.name}…`,
			},
			job,
		);
	}
	return { ver, busy_status };
}

async function finish_subject_lifecycle(
	store: ImperiumStore,
	sql: Bun.SQL,
	sub: SubjectInfo,
	installed: boolean,
	ver: { version: number | null },
	busy_status: string,
	job?: JobCtx | null,
) {
	const technical_id = sub.technical_id;
	const op = installed ? 'install' : 'uninstall';
	const docker = await run_subject_docker(
		op,
		{ slug: sub.slug, image: sub.image },
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
		await write_install_row(sql, technical_id, false, ver.version, 'error');
		emit_subject_event(
			{
				technical_id: sub.technical_id,
				slug: sub.slug,
				name: sub.name,
				installed: false,
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
	await write_install_row(
		sql,
		technical_id,
		installed,
		ver.version,
		installed ? 'installed' : 'uninstalled',
	);
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
		job,
	);
}

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
	if (in_flight.has(technical_id)) {
		const recs = await install_records(sql);
		return {
			accepted: true,
			already_running: true,
			row: catalog_row(sub, false, recs.get(technical_id)),
			notification: null as ImperiumDoc | null,
		};
	}
	const uid = actor_uid(actor);
	const job_kind = installed ? 'subject_install' : 'subject_uninstall';
	const message = installed
		? `Instalando ${sub.name}…`
		: `Desinstalando ${sub.name}…`;
	const notification = await create_background_job_notification(store, {
		recipient_id: uid,
		actor,
		job_kind,
		technical_id,
		slug: sub.slug,
		name: sub.name,
		message,
	});
	const job: JobCtx = {
		store,
		notification_id: notification?._id
			? String(notification._id)
			: undefined,
		recipient_id: uid,
	};
	if (uid && job.notification_id) {
		notify_background_job_refresh(
			uid,
			job.notification_id,
			'background_job_start',
		);
	}
	const started = await begin_subject_lifecycle(
		store,
		sql,
		sub,
		installed,
		job,
	);
	const work = finish_subject_lifecycle(
		store,
		sql,
		sub,
		installed,
		started.ver,
		started.busy_status,
		job,
	)
		.catch((err) => {
			if (err instanceof SubjectLifecycleError) return null;
			emit_subject_event(
				{
					technical_id: sub.technical_id,
					slug: sub.slug,
					name: sub.name,
					installed: false,
					status: 'error',
					phase: 'error',
					level: 'error',
					message: String(err),
				},
				job,
			);
			return null;
		})
		.finally(() => {
			in_flight.delete(technical_id);
		});
	in_flight.set(technical_id, work);
	const recs = await install_records(sql);
	return {
		accepted: true,
		already_running: false,
		row: catalog_row(sub, false, recs.get(technical_id)),
		notification,
	};
}

export type SubjectDockerResult = SubjectRuntimeResult;


export async function get_subject_details(
	store: ImperiumStore,
	sql: Bun.SQL,
	technical_id: string,
) {
	const sub = store.subjects.find((s) => s.technical_id === technical_id);
	if (!sub) return null;
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
		...catalog_row(sub, installed, rec),
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
