/**
 * Restaurar un respaldo desde la GUI.
 *
 * Diseño completo en `docs/restauracion-respaldos.md`. En corto:
 *
 * 1. Se valida el artefacto (sumas, contenido, `pg_restore --list`,
 *    versiones, de qué instalación viene).
 * 2. Se bloquean las escrituras y se hace un respaldo de seguridad.
 * 3. Se restaura en una base **temporal** `<base>__restaurando_<ts>`; la real
 *    no se toca. Si falla, se borra la temporal y no pasó nada.
 * 4. Swap: la real pasa a `<base>__previa_<ts>` y la temporal toma su nombre.
 *    Si algo falla a media, se deshace el renombrado.
 * 5. Adjuntos: mismo patrón con carpetas (`.restaurando-*` → lugar, lo de
 *    antes a `.previa-*`).
 * 6. Se olvidan las sesiones (memoria y tabla) y el núcleo se reinicia para
 *    soltar cachés y conexiones viejas.
 *
 * El estado se guarda en disco en cada fase (`_respaldos/restauraciones`):
 * el núcleo se reinicia al final y la bitácora de la base se reemplaza, así
 * que ninguno de los dos sirve para contar qué pasó.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { forget_all_sessions } from './auth.ts';
import {
	BACKUP_FOLDER_NAME,
	BackupError,
	RESTORE_TASK_KIND,
	backup_dir,
	backup_tooling,
	create_backup,
	find_backup,
	free_bytes,
	pg_env,
	run,
	sanitize_id,
	sha256_of,
	type BackupActor,
	type BackupManifest,
} from './db-admin-backup.ts';
import { check_compatibility, type ArchiveCheck } from './db-admin-archive.ts';
import { inspect_tar } from './db-admin-upload.ts';
import {
	ensure_db_admin_objects,
	read_instance_id,
	reset_db_admin_capabilities,
	write_audit,
} from './db-admin-setup.ts';
import { get_task, is_running, start_task, type Task, type TaskHandle } from './db-admin-tasks.ts';
import { set_restore_gate } from './db-admin-restore-gate.ts';
import { CORE_VERSION } from './health.ts';
import { writable_upload_folder } from './uploads.ts';

export type RestorePhase =
	| 'validando'
	| 'respaldo_seguridad'
	| 'restaurando_temporal'
	| 'validando_temporal'
	| 'intercambio'
	| 'adjuntos'
	| 'limpieza'
	| 'listo';

export type RestoreStatus = 'corriendo' | 'listo' | 'fallo' | 'revertido' | 'interrumpido';

export type RestoreRecord = {
	id: string;
	kind: 'restaurar' | 'deshacer';
	task_id: string | null;
	backup_id: string | null;
	backup_label: string | null;
	/** Para `deshacer`: la restauración que se deshace. */
	undo_of: string | null;
	status: RestoreStatus;
	phase: RestorePhase;
	started_at: string;
	finished_at: string | null;
	actor_label: string | null;
	options: { restore_attachments: boolean; allow_foreign: boolean; allow_version_mismatch: boolean };
	database: string;
	safety_backup_id: string | null;
	temp_database: string | null;
	previous_database: string | null;
	previous_attachments_dir: string | null;
	swapped: boolean;
	attachments_swapped: boolean;
	restart_scheduled: boolean;
	logs: Array<{ at: string; message: string }>;
	error: string | null;
};

export type RestoreOptions = {
	restore_attachments?: boolean;
	allow_foreign?: boolean;
	allow_version_mismatch?: boolean;
	/** Solo pruebas: no reiniciar el proceso al final. */
	skip_restart?: boolean;
};

const MAX_RECORD_LOGS = 400;

//   #region Registro en disco

function restores_dir(): string {
	const dir = join(backup_dir(), 'restauraciones');
	mkdirSync(dir, { recursive: true });
	return dir;
}

function save_record(record: RestoreRecord): void {
	if (record.logs.length > MAX_RECORD_LOGS) {
		record.logs.splice(0, record.logs.length - MAX_RECORD_LOGS);
	}
	const path = join(restores_dir(), `${record.id}.json`);
	writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2));
	renameSync(`${path}.tmp`, path);
}

function load_record(id: string): RestoreRecord | null {
	const safe = sanitize_id(id);
	if (!safe) return null;
	const path = join(restores_dir(), `${safe}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as RestoreRecord;
	} catch {
		return null;
	}
}

/**
 * Una restauración que dice «corriendo» pero cuyo trabajo ya no está en este
 * proceso se cortó (reinicio, caída). Se marca con la fase en que iba.
 */
function settle(record: RestoreRecord): RestoreRecord {
	if (record.status !== 'corriendo') return record;
	const task = record.task_id ? get_task(record.task_id) : null;
	if (task && task.status === 'running') return record;
	record.status = 'interrumpido';
	record.finished_at = record.finished_at ?? new Date().toISOString();
	record.error =
		record.error ??
		(record.swapped
			? `Se cortó en la fase «${record.phase}», después del cambio de base: la base activa ya es la restaurada.`
			: `Se cortó en la fase «${record.phase}», antes del cambio de base: la base activa no se tocó.`);
	save_record(record);
	return record;
}

export function list_restores(): RestoreRecord[] {
	const out: RestoreRecord[] = [];
	for (const name of readdirSync(restores_dir())) {
		if (!name.endsWith('.json')) continue;
		const record = load_record(name.slice(0, -5));
		if (record) out.push(settle(record));
	}
	return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function get_restore(id: string): RestoreRecord | null {
	const record = load_record(id);
	return record ? settle(record) : null;
}

//   #endregion

//   #region Conexiones y nombres

/** Identificador de Postgres entre comillas, sin inyección. */
export function quote_ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** Nombre derivado de la base activa que cabe en los 63 bytes de Postgres. */
export function derived_db_name(base: string, tag: string, stamp: string): string {
	const suffix = `__${tag}_${stamp}`;
	return `${base.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
}

function url_for_database(database: string): string {
	const raw = process.env.DATABASE_URL?.trim();
	if (!raw) throw new BackupError('No hay DATABASE_URL en el núcleo.', 500);
	const url = new URL(raw);
	url.pathname = `/${encodeURIComponent(database)}`;
	return url.toString();
}

/** Conexión aparte a la base de mantenimiento `postgres`, para renombrar. */
function maintenance_sql(): Bun.SQL {
	return new Bun.SQL(url_for_database(process.env.DB_ADMIN_MAINTENANCE_DB?.trim() || 'postgres'), {
		max: 1,
	});
}

async function close(sql: Bun.SQL | null): Promise<void> {
	if (!sql) return;
	try {
		await sql.end();
	} catch {
		/* ya cerrada */
	}
}

async function database_exists(admin: Bun.SQL, name: string): Promise<boolean> {
	const rows = (await admin.unsafe('SELECT 1 FROM pg_database WHERE datname = $1', [name])) as unknown[];
	return rows.length > 0;
}

async function terminate_connections(admin: Bun.SQL, name: string): Promise<void> {
	await admin.unsafe(
		'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
		[name],
	);
}

/**
 * Renombra una base con conexiones vivas: las corta y reintenta, porque el
 * pool del núcleo (o una app) puede reconectar entre el corte y el `RENAME`.
 */
async function rename_database(admin: Bun.SQL, from: string, to: string, log?: (m: string) => void): Promise<void> {
	let last: unknown = null;
	for (let attempt = 1; attempt <= 8; attempt += 1) {
		try {
			await terminate_connections(admin, from);
			await admin.unsafe(`ALTER DATABASE ${quote_ident(from)} RENAME TO ${quote_ident(to)}`);
			return;
		} catch (err) {
			last = err;
			log?.(`Reintento ${attempt} al renombrar ${from}: ${err instanceof Error ? err.message : String(err)}`);
			await Bun.sleep(250 * attempt);
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

async function set_allow_connections(admin: Bun.SQL, name: string, allow: boolean): Promise<void> {
	await admin.unsafe(`ALTER DATABASE ${quote_ident(name)} WITH ALLOW_CONNECTIONS ${allow ? 'true' : 'false'}`);
}

//   #endregion

//   #region Vista previa

export type RestorePreview = {
	backup: BackupManifest;
	current: {
		database: string;
		core_version: string;
		server_version: string;
		pg_restore_version: string | null;
		database_bytes: number | null;
		free_backup_bytes: number | null;
		instance_id: string | null;
	};
	checks: ArchiveCheck[];
	blockers: string[];
	warnings: string[];
	needs_version_ack: boolean;
	needs_foreign_ack: boolean;
	/** Lo que hay que escribir para confirmar. */
	confirm_phrase: string;
	can_restore_attachments: boolean;
};

async function privileges_problem(sql: Bun.SQL): Promise<string | null> {
	try {
		const [row] = (await sql.unsafe(
			`SELECT r.rolsuper AS super, r.rolcreatedb AS createdb,
			        pg_get_userbyid(d.datdba) = current_user AS owner
			   FROM pg_roles r, pg_database d
			  WHERE r.rolname = current_user AND d.datname = current_database()`,
		)) as Array<{ super: boolean; createdb: boolean; owner: boolean }>;
		if (!row) return 'No se pudieron leer los privilegios de la conexión.';
		if (row.super) return null;
		if (!row.createdb) return 'El usuario de la base no puede crear bases (CREATEDB); no se puede restaurar en una temporal.';
		if (!row.owner) return 'El usuario de la base no es dueño de la base activa; no puede renombrarla.';
		return null;
	} catch (err) {
		return `No se pudieron leer los privilegios: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/** Vistas previas recientes por respaldo: restaurar exige haber visto una. */
const previews = new Map<string, { at: number; preview: RestorePreview }>();
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

/**
 * La vista previa lee el artefacto entero (suma, extracción, `pg_restore
 * --list`): con varios GB no cabe en el plazo de una petición HTTP. Corre como
 * trabajo y su resultado queda guardado para `start_restore`.
 */
export function start_restore_preview(sql: Bun.SQL, backup_id: string): Task {
	const found = find_backup(backup_id);
	if (!found) throw new BackupError(`No existe el respaldo "${backup_id}".`, 404);
	return start_task('vista_previa', `Revisar ${found.manifest.label}`, async (handle) => {
		handle.log('Revisando el respaldo antes de restaurar…');
		const preview = await restore_preview(sql, backup_id);
		previews.set(found.manifest.id, { at: Date.now(), preview });
		handle.log(
			preview.blockers.length
				? `No se puede restaurar: ${preview.blockers.join(' ')}`
				: 'Se puede restaurar.',
		);
		return preview;
	});
}

export function recent_preview(backup_id: string, now = Date.now()): RestorePreview | null {
	const hit = previews.get(backup_id);
	if (!hit || now - hit.at > PREVIEW_TTL_MS) return null;
	return hit.preview;
}

/** Solo pruebas. */
export function remember_preview(backup_id: string, preview: RestorePreview, at = Date.now()): void {
	previews.set(backup_id, { at, preview });
}

export async function restore_preview(sql: Bun.SQL, backup_id: string): Promise<RestorePreview> {
	const found = find_backup(backup_id);
	if (!found) throw new BackupError(`No existe el respaldo "${backup_id}".`, 404);
	const tooling = await backup_tooling();
	const restore_version = (await run(['pg_restore', '--version']).catch(() => null))?.stdout.trim() || null;
	const [server] = (await sql.unsafe(
		'SELECT version() AS v, current_database() AS db, pg_database_size(current_database()) AS bytes',
	)) as Array<{ v: string; db: string; bytes: number | string }>;
	const current_database = String(server?.db ?? pg_env().PGDATABASE ?? '');
	const instance_id = await read_instance_id(sql);
	const checks: ArchiveCheck[] = [];
	const blockers: string[] = [];

	if (!tooling.available || !restore_version) {
		blockers.push(tooling.reason ?? 'No hay pg_restore en la imagen del núcleo.');
	}
	const actual = await sha256_of(found.path);
	const sum_ok = actual === found.manifest.archive_sha256;
	checks.push({
		name: 'Suma de verificación del artefacto',
		ok: sum_ok,
		detail: sum_ok ? 'Coincide.' : `Esperado ${found.manifest.archive_sha256}, encontrado ${actual}.`,
	});
	if (!sum_ok) blockers.push('El artefacto cambió desde que se registró: no se restaura.');

	let inner: BackupManifest | null = null;
	const work = join(backup_dir(), `.previa-${Date.now().toString(36)}`);
	mkdirSync(work, { recursive: true });
	try {
		if (sum_ok && restore_version) inner = await inspect_tar(found.path, work, checks);
	} catch (err) {
		blockers.push(err instanceof Error ? err.message : String(err));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	const manifest = { ...found.manifest, ...(inner ? { includes_attachments: inner.includes_attachments } : {}) };
	const compat = check_compatibility({
		manifest,
		current_database,
		current_instance_id: instance_id,
		pg_restore_version: restore_version,
	});
	blockers.push(...compat.blockers);
	const privileges = await privileges_problem(sql);
	if (privileges) blockers.push(privileges);
	if (is_running(RESTORE_TASK_KIND)) blockers.push('Ya hay una restauración en curso.');
	if (is_running('respaldo')) blockers.push('Hay un respaldo en curso; espera a que termine.');

	const free = await free_bytes(backup_dir());
	const db_bytes = server?.bytes != null ? Number(server.bytes) : null;
	if (free != null && db_bytes != null && free < db_bytes + 512 * 1024 ** 2) {
		blockers.push(
			`No hay espacio para el respaldo de seguridad: quedan ${(free / 1024 ** 2).toFixed(0)} MB y la base pesa ${(db_bytes / 1024 ** 2).toFixed(0)} MB.`,
		);
	}
	const warnings = [...compat.warnings];
	warnings.push(
		'Postgres necesita espacio para tener las dos bases a la vez durante el cambio (la activa y la restaurada).',
	);
	if (!manifest.includes_attachments) {
		warnings.push('Este respaldo no trae adjuntos: los archivos actuales se quedan como están.');
	}
	return {
		backup: manifest,
		current: {
			database: current_database,
			core_version: CORE_VERSION,
			server_version: String(server?.v ?? ''),
			pg_restore_version: restore_version,
			database_bytes: db_bytes,
			free_backup_bytes: free,
			instance_id,
		},
		checks,
		blockers,
		warnings,
		needs_version_ack: compat.needs_version_ack,
		needs_foreign_ack: compat.needs_foreign_ack,
		confirm_phrase: current_database,
		can_restore_attachments: Boolean(manifest.includes_attachments),
	};
}

//   #endregion

//   #region Restaurar

function new_record(
	kind: RestoreRecord['kind'],
	actor: BackupActor,
	database: string,
	extra: Partial<RestoreRecord>,
): RestoreRecord {
	const stamp = Date.now().toString(36);
	return {
		id: `${kind === 'restaurar' ? 'restauracion' : 'deshacer'}-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
		kind,
		task_id: null,
		backup_id: null,
		backup_label: null,
		undo_of: null,
		status: 'corriendo',
		phase: 'validando',
		started_at: new Date().toISOString(),
		finished_at: null,
		actor_label: actor.label ?? actor.id ?? null,
		options: { restore_attachments: false, allow_foreign: false, allow_version_mismatch: false },
		database,
		safety_backup_id: null,
		temp_database: null,
		previous_database: null,
		previous_attachments_dir: null,
		swapped: false,
		attachments_swapped: false,
		restart_scheduled: false,
		logs: [],
		error: null,
		...extra,
	};
}

/**
 * Arranca la restauración sobre la vista previa reciente (la que vio la
 * persona). La contraseña se revisa en la ruta. Lo pesado —suma, contenido,
 * compatibilidad— se repite dentro del trabajo, en la fase `validando`, para
 * no confiar en lo que se vio hace veinte minutos.
 */
export async function start_restore(
	sql: Bun.SQL,
	backup_id: string,
	options: RestoreOptions,
	confirm: string,
	actor: BackupActor,
): Promise<RestoreRecord> {
	if (actor.origin !== 'session') {
		throw new BackupError('Restaurar solo se puede desde la sesión de un administrador.', 403);
	}
	if (is_running(RESTORE_TASK_KIND)) throw new BackupError('Ya hay una restauración en curso.', 409);
	const preview = recent_preview(find_backup(backup_id)?.manifest.id ?? backup_id);
	if (!preview) {
		throw new BackupError('Primero revisa el respaldo (vista previa); la última caducó o no existe.', 409);
	}
	const privileges = await privileges_problem(sql);
	if (privileges) throw new BackupError(privileges, 409);
	if (is_running('respaldo')) throw new BackupError('Hay un respaldo en curso; espera a que termine.', 409);
	if (confirm.trim() !== preview.confirm_phrase) {
		throw new BackupError(`Para confirmar escribe el nombre de la base: ${preview.confirm_phrase}`, 400);
	}
	if (preview.blockers.length) throw new BackupError(preview.blockers.join(' '), 409);
	if (preview.needs_foreign_ack && !options.allow_foreign) {
		throw new BackupError('El respaldo es de otra instalación: marca que lo sabes para seguir.', 409);
	}
	if (preview.needs_version_ack && !options.allow_version_mismatch) {
		throw new BackupError('La versión del núcleo del respaldo no coincide: marca que lo entiendes para seguir.', 409);
	}
	const restore_attachments = Boolean(options.restore_attachments) && preview.can_restore_attachments;
	const found = find_backup(backup_id);
	if (!found) throw new BackupError(`No existe el respaldo "${backup_id}".`, 404);
	const record = new_record('restaurar', actor, preview.current.database, {
		backup_id: found.manifest.id,
		backup_label: found.manifest.label,
		options: {
			restore_attachments,
			allow_foreign: Boolean(options.allow_foreign),
			allow_version_mismatch: Boolean(options.allow_version_mismatch),
		},
	});
	save_record(record);
	await audit(sql, actor, 'respaldo.restaurar.inicio', found.manifest.id, true, null, record.id);
	const task = start_task(RESTORE_TASK_KIND, `Restaurar ${found.manifest.label}`, (handle) =>
		run_restore(sql, record, found.path, options, actor, handle),
	);
	record.task_id = task.id;
	save_record(record);
	return record;
}

function logger(record: RestoreRecord, handle: TaskHandle): (message: string) => void {
	return (message: string) => {
		handle.log(message);
		record.logs.push({ at: new Date().toISOString(), message });
		save_record(record);
	};
}

function enter(record: RestoreRecord, phase: RestorePhase, log: (m: string) => void, message: string): void {
	record.phase = phase;
	log(message);
}

async function audit(
	sql: Bun.SQL,
	actor: BackupActor,
	operation: string,
	target: string,
	succeeded: boolean,
	error: string | null,
	statement: string | null = null,
): Promise<void> {
	// El pool puede tener conexiones cortadas por el swap, y la base restaurada
	// puede no tener aún `db_admin` (respaldo de antes del gestor): se asegura
	// con un par de intentos antes de escribir.
	for (let i = 0; i < 4; i += 1) {
		try {
			await ensure_db_admin_objects(sql);
			await write_audit(sql, {
				actor_id: actor.id ?? null,
				actor_label: actor.label ?? null,
				origin: actor.origin,
				source_ip: actor.source_ip ?? null,
				operation,
				target,
				statement,
				succeeded,
				error,
			});
			return;
		} catch {
			await Bun.sleep(300);
		}
	}
}

async function run_restore(
	sql: Bun.SQL,
	record: RestoreRecord,
	archive: string,
	options: RestoreOptions,
	actor: BackupActor,
	handle: TaskHandle,
): Promise<RestoreRecord> {
	const log = logger(record, handle);
	const live = record.database;
	const stamp = Date.now().toString(36);
	const work = join(backup_dir(), `.restaurar-${stamp}`);
	let admin: Bun.SQL | null = null;
	let attachments_state: AttachmentSwap | null = null;
	try {
		enter(record, 'validando', log, 'Comprobando la suma y el contenido del respaldo…');
		mkdirSync(work, { recursive: true });
		const found = record.backup_id ? find_backup(record.backup_id) : null;
		if (!found) throw new BackupError('El respaldo ya no existe.', 404);
		if ((await sha256_of(archive)) !== found.manifest.archive_sha256) {
			throw new BackupError('El artefacto cambió desde la vista previa: no se restaura.', 409);
		}
		const checks: ArchiveCheck[] = [];
		await inspect_tar(archive, work, checks, handle);
		const compat = check_compatibility({
			manifest: found.manifest,
			current_database: live,
			current_instance_id: await read_instance_id(sql),
			pg_restore_version: (await run(['pg_restore', '--version'])).stdout.trim() || null,
		});
		if (compat.blockers.length) throw new BackupError(compat.blockers.join(' '), 409);
		if (compat.needs_foreign_ack && !record.options.allow_foreign) {
			throw new BackupError('El respaldo es de otra instalación y no se confirmó.', 409);
		}
		if (compat.needs_version_ack && !record.options.allow_version_mismatch) {
			throw new BackupError('La versión del núcleo no coincide y no se confirmó.', 409);
		}
		log('Respaldo íntegro y compatible.');

		set_restore_gate('escrituras_bloqueadas', record.id, 'Restaurando respaldo');
		enter(record, 'respaldo_seguridad', log, 'Escrituras bloqueadas. Haciendo el respaldo de seguridad de la base actual…');
		const safety = await create_backup(
			sql,
			{
				label: `Antes de restaurar «${record.backup_label ?? record.backup_id}»`,
				include_attachments: record.options.restore_attachments,
				trigger: 'seguridad',
				id: `seguridad-${new Date().toISOString().replace(/[:.]/g, '-')}`,
			},
			actor,
			handle,
		);
		record.safety_backup_id = safety.id;
		log(`Respaldo de seguridad listo: ${safety.id}.`);

		admin = maintenance_sql();
		const temp = derived_db_name(live, 'restaurando', stamp);
		const previous = derived_db_name(live, 'previa', stamp);
		enter(record, 'restaurando_temporal', log, `Creando la base temporal ${temp}…`);
		const [enc] = (await admin.unsafe(
			`SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype FROM pg_database WHERE datname = $1`,
			[live],
		)) as Array<{ encoding: string; datcollate: string; datctype: string }>;
		if (await database_exists(admin, temp)) await admin.unsafe(`DROP DATABASE ${quote_ident(temp)}`);
		await admin.unsafe(
			`CREATE DATABASE ${quote_ident(temp)} TEMPLATE template0` +
				(enc
					? ` ENCODING '${enc.encoding.replace(/'/g, '')}' LC_COLLATE '${enc.datcollate.replace(/'/g, '')}' LC_CTYPE '${enc.datctype.replace(/'/g, '')}'`
					: ''),
		);
		record.temp_database = temp;
		save_record(record);
		log('Restaurando el volcado en la base temporal (la base activa sigue intacta)…');
		const restored = await run(
			[
				'pg_restore',
				'--no-owner',
				'--no-acl',
				'--exit-on-error',
				'--single-transaction',
				`--dbname=${temp}`,
				join(work, 'database.dump'),
			],
			{ ...pg_env(), PGDATABASE: temp },
		);
		if (restored.code !== 0) {
			throw new BackupError(`pg_restore falló: ${restored.stderr.trim().slice(0, 2000)}`, 500);
		}

		enter(record, 'validando_temporal', log, 'Revisando la base restaurada…');
		const temp_sql = new Bun.SQL(url_for_database(temp), { max: 1 });
		try {
			const [tables] = (await temp_sql.unsafe(
				`SELECT count(*)::int AS n FROM information_schema.tables
				  WHERE table_schema NOT IN ('pg_catalog','information_schema')`,
			)) as Array<{ n: number }>;
			if (!tables || Number(tables.n) === 0) throw new BackupError('La base restaurada quedó sin tablas.', 500);
			log(`${tables.n} tablas en la base restaurada.`);
			const [users] = (await temp_sql.unsafe(
				`SELECT to_regclass('subject_configuracion."user"') IS NOT NULL AS has_users`,
			)) as Array<{ has_users: boolean }>;
			if (users?.has_users) {
				const [count] = (await temp_sql.unsafe(
					'SELECT count(*)::int AS n FROM subject_configuracion."user"',
				)) as Array<{ n: number }>;
				if (!count || Number(count.n) === 0) {
					throw new BackupError('La base restaurada no tiene usuarios: nadie podría entrar.', 500);
				}
				log(`${count.n} usuarios en la base restaurada.`);
			}
			const [sessions] = (await temp_sql.unsafe(
				`SELECT to_regclass('public.imperium_sessions') IS NOT NULL AS has`,
			)) as Array<{ has: boolean }>;
			if (sessions?.has) {
				await temp_sql.unsafe('TRUNCATE public.imperium_sessions');
				log('Sesiones del respaldo invalidadas.');
			}
		} finally {
			await close(temp_sql);
		}

		set_restore_gate('intercambio', record.id, 'Cambiando a la base restaurada');
		enter(record, 'intercambio', log, 'Cambiando a la base restaurada…');
		await swap_databases(admin, { live, incoming: temp, outgoing: previous }, log);
		record.swapped = true;
		record.previous_database = previous;
		record.temp_database = null;
		save_record(record);
		log(`La base activa ya es la restaurada. La anterior quedó como ${previous}.`);

		if (record.options.restore_attachments) {
			enter(record, 'adjuntos', log, 'Restaurando los adjuntos…');
			attachments_state = await swap_attachments(join(work, 'attachments.tar.gz'), stamp, log);
			record.attachments_swapped = true;
			record.previous_attachments_dir = attachments_state.previous_dir;
			save_record(record);
		}

		enter(record, 'limpieza', log, 'Limpiando…');
		const dropped = await drop_old_previous(admin, live, previous);
		if (dropped.length) log(`Se borraron bases previas viejas: ${dropped.join(', ')}.`);
		clean_old_attachment_dirs(record.previous_attachments_dir);
		const forgotten = forget_all_sessions();
		log(`Sesiones en memoria olvidadas: ${forgotten}. Todos deben iniciar sesión otra vez.`);
		reset_db_admin_capabilities();
		set_restore_gate('libre');

		record.status = 'listo';
		record.phase = 'listo';
		record.finished_at = new Date().toISOString();
		log('Restauración terminada.');
		await audit(sql, actor, 'respaldo.restaurar', record.backup_id ?? '', true, null, record.id);
		record.restart_scheduled = schedule_core_restart(options, log);
		save_record(record);
		return record;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		record.error = message;
		log(`Falló: ${message}`);
		try {
			await rollback(admin, record, attachments_state, log);
		} catch (rollback_err) {
			log(
				`¡No se pudo deshacer! Revisar a mano: ${rollback_err instanceof Error ? rollback_err.message : String(rollback_err)}`,
			);
		}
		set_restore_gate('libre');
		record.status = 'fallo';
		record.finished_at = new Date().toISOString();
		save_record(record);
		await audit(sql, actor, 'respaldo.restaurar', record.backup_id ?? '', false, message, record.id);
		throw err;
	} finally {
		await close(admin);
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * El cambio de base. `ALLOW_CONNECTIONS false` primero: sin eso el pool del
 * núcleo reconecta entre el corte y el renombrado y el `RENAME` falla con
 * "is being accessed by other users".
 */
export async function swap_databases(
	admin: Bun.SQL,
	names: { live: string; incoming: string; outgoing: string },
	log: (m: string) => void = () => undefined,
): Promise<void> {
	await set_allow_connections(admin, names.live, false);
	try {
		await rename_database(admin, names.live, names.outgoing, log);
	} catch (err) {
		await set_allow_connections(admin, names.live, true).catch(() => undefined);
		throw err;
	}
	try {
		await rename_database(admin, names.incoming, names.live, log);
		await set_allow_connections(admin, names.live, true);
	} catch (err) {
		log('No se pudo poner la base restaurada en su lugar; regresando la anterior…');
		await rename_database(admin, names.outgoing, names.live, log);
		await set_allow_connections(admin, names.live, true);
		throw err;
	}
}

async function rollback(
	admin: Bun.SQL | null,
	record: RestoreRecord,
	attachments: AttachmentSwap | null,
	log: (m: string) => void,
): Promise<void> {
	if (attachments) {
		log('Regresando los adjuntos de antes…');
		attachments.undo();
		record.attachments_swapped = false;
	}
	if (!admin) return;
	if (record.swapped && record.previous_database) {
		log('Regresando la base de antes…');
		const discarded = derived_db_name(record.database, 'fallida', Date.now().toString(36));
		await swap_databases(admin, { live: record.database, incoming: record.previous_database, outgoing: discarded }, log);
		record.swapped = false;
		record.temp_database = discarded;
		record.previous_database = null;
		record.status = 'revertido';
		log(`La base activa volvió a ser la de antes. La restaurada quedó como ${discarded} para revisar.`);
		return;
	}
	if (record.temp_database && (await database_exists(admin, record.temp_database))) {
		log(`Borrando la base temporal ${record.temp_database}; la activa no se tocó.`);
		await terminate_connections(admin, record.temp_database);
		await admin.unsafe(`DROP DATABASE IF EXISTS ${quote_ident(record.temp_database)}`);
		record.temp_database = null;
	}
}

/** Conserva las `keep` previas más nuevas (por omisión 1: la de esta vez). */
async function drop_old_previous(admin: Bun.SQL, live: string, keep_name: string): Promise<string[]> {
	const keep = Math.max(1, Number(process.env.DB_ADMIN_RESTORE_KEEP_PREVIOUS ?? 1) || 1);
	// Mismo prefijo que `derived_db_name(live, 'previa', …)`, sin la marca de tiempo.
	const prefix = keep_name.replace(/[^_]+$/, '');
	void live;
	const rows = (await admin.unsafe(
		`SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname DESC`,
		[prefix],
	)) as Array<{ datname: string }>;
	const names = rows.map((r) => r.datname).filter((n) => n !== keep_name);
	const doomed = names.slice(Math.max(0, keep - 1));
	for (const name of doomed) {
		await terminate_connections(admin, name);
		await admin.unsafe(`DROP DATABASE IF EXISTS ${quote_ident(name)}`);
	}
	return doomed;
}

/**
 * Reiniciar el núcleo al final suelta las cachés por proceso (catálogo, apps
 * instaladas, permisos, el pool con conexiones cortadas). Docker
 * (`restart: always`) lo levanta de nuevo.
 */
function schedule_core_restart(options: RestoreOptions, log: (m: string) => void): boolean {
	if (options.skip_restart || process.env.DB_ADMIN_RESTART_AFTER_RESTORE === '0') {
		log('El núcleo NO se reinicia solo (DB_ADMIN_RESTART_AFTER_RESTORE=0): reinícialo para soltar cachés.');
		return false;
	}
	log('El núcleo se reinicia en 3 s para empezar limpio con la base restaurada.');
	setTimeout(() => process.exit(0), 3000).unref?.();
	return true;
}

//   #endregion

//   #region Adjuntos

type AttachmentSwap = { previous_dir: string; undo: () => void };

/** Lo que no son adjuntos y se queda donde está. */
function kept_entries(uploads: string): Set<string> {
	const keep = new Set<string>([BACKUP_FOLDER_NAME]);
	const backups = resolve(backup_dir());
	if (dirname(backups) === resolve(uploads)) keep.add(basename(backups));
	return keep;
}

function is_work_dir(name: string): boolean {
	return /^\.(restaurando|previa|deshecha|fallida)-/.test(name);
}

export async function swap_attachments(
	tarball: string,
	stamp: string,
	log: (m: string) => void,
	uploads = writable_upload_folder(),
): Promise<AttachmentSwap> {
	const staging = join(uploads, `.restaurando-${stamp}`);
	const previous = join(uploads, `.previa-${stamp}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const extract = await run(['tar', '-xzf', tarball, '-C', staging, '--no-same-owner', '--no-same-permissions']);
	if (extract.code !== 0) {
		rmSync(staging, { recursive: true, force: true });
		throw new BackupError(`No se pudieron extraer los adjuntos: ${extract.stderr.trim()}`, 500);
	}
	const keep = kept_entries(uploads);
	mkdirSync(previous, { recursive: true });
	const moved_out: string[] = [];
	const moved_in: string[] = [];
	const undo = () => {
		for (const name of moved_in) rmSync(join(uploads, name), { recursive: true, force: true });
		for (const name of moved_out) {
			if (existsSync(join(previous, name))) renameSync(join(previous, name), join(uploads, name));
		}
		rmSync(staging, { recursive: true, force: true });
	};
	try {
		for (const name of readdirSync(uploads)) {
			if (keep.has(name) || is_work_dir(name)) continue;
			renameSync(join(uploads, name), join(previous, name));
			moved_out.push(name);
		}
		for (const name of readdirSync(staging)) {
			if (keep.has(name) || is_work_dir(name)) continue;
			renameSync(join(staging, name), join(uploads, name));
			moved_in.push(name);
		}
		rmSync(staging, { recursive: true, force: true });
		log(`Adjuntos: ${moved_in.length} entradas restauradas; las ${moved_out.length} de antes quedaron en ${basename(previous)}.`);
		return { previous_dir: previous, undo };
	} catch (err) {
		undo();
		throw err;
	}
}

function clean_old_attachment_dirs(keep_dir: string | null, uploads = writable_upload_folder()): void {
	if (!existsSync(uploads)) return;
	const keep = keep_dir ? basename(keep_dir) : null;
	for (const name of readdirSync(uploads)) {
		if (!/^\.(previa|deshecha|fallida|restaurando)-/.test(name)) continue;
		if (name === keep) continue;
		rmSync(join(uploads, name), { recursive: true, force: true });
	}
}

//   #endregion

//   #region Deshacer

/**
 * Vuelve a la base (y adjuntos) que había antes de la última restauración.
 * La base restaurada no se borra: queda como `<base>__deshecha_<ts>`.
 */
export async function start_undo(
	sql: Bun.SQL,
	restore_id: string,
	confirm: string,
	actor: BackupActor,
	options: { skip_restart?: boolean } = {},
): Promise<RestoreRecord> {
	if (actor.origin !== 'session') {
		throw new BackupError('Deshacer solo se puede desde la sesión de un administrador.', 403);
	}
	if (is_running(RESTORE_TASK_KIND)) throw new BackupError('Ya hay una restauración en curso.', 409);
	const target = get_restore(restore_id);
	if (!target) throw new BackupError('No existe esa restauración.', 404);
	const latest = list_restores().find((r) => r.status === 'listo');
	if (!latest || latest.id !== target.id || target.kind !== 'restaurar' || !target.previous_database) {
		throw new BackupError('Solo se puede deshacer la última restauración terminada.', 409);
	}
	if (confirm.trim() !== target.database) {
		throw new BackupError(`Para confirmar escribe el nombre de la base: ${target.database}`, 400);
	}
	const admin = maintenance_sql();
	try {
		if (!(await database_exists(admin, target.previous_database))) {
			throw new BackupError(`Ya no existe la base previa ${target.previous_database}.`, 409);
		}
	} finally {
		await close(admin);
	}
	const record = new_record('deshacer', actor, target.database, {
		undo_of: target.id,
		backup_id: target.backup_id,
		backup_label: target.backup_label,
		previous_database: target.previous_database,
		previous_attachments_dir: target.previous_attachments_dir,
	});
	save_record(record);
	const task = start_task(RESTORE_TASK_KIND, 'Deshacer restauración', async (handle) => {
		const log = logger(record, handle);
		const stamp = Date.now().toString(36);
		const undone = derived_db_name(target.database, 'deshecha', stamp);
		const conn = maintenance_sql();
		try {
			set_restore_gate('intercambio', record.id, 'Deshaciendo restauración');
			enter(record, 'intercambio', log, `Regresando a ${target.previous_database}…`);
			await swap_databases(conn, { live: target.database, incoming: target.previous_database!, outgoing: undone }, log);
			record.swapped = true;
			record.temp_database = undone;
			save_record(record);
			const prev_dir = target.previous_attachments_dir;
			if (prev_dir && existsSync(prev_dir)) {
				enter(record, 'adjuntos', log, 'Regresando los adjuntos de antes…');
				restore_attachment_dir(prev_dir, `.deshecha-${stamp}`);
				record.attachments_swapped = true;
			}
			target.status = 'revertido';
			target.previous_database = null;
			target.previous_attachments_dir = null;
			save_record(target);
			forget_all_sessions();
			reset_db_admin_capabilities();
			set_restore_gate('libre');
			record.status = 'listo';
			record.phase = 'listo';
			record.finished_at = new Date().toISOString();
			log(`Listo. La base restaurada quedó como ${undone}.`);
			await audit(sql, actor, 'respaldo.deshacer', target.id, true, null, record.id);
			record.restart_scheduled = schedule_core_restart(options, log);
			save_record(record);
			return record;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			record.status = 'fallo';
			record.error = message;
			record.finished_at = new Date().toISOString();
			log(`Falló: ${message}`);
			set_restore_gate('libre');
			save_record(record);
			await audit(sql, actor, 'respaldo.deshacer', target.id, false, message, record.id);
			throw err;
		} finally {
			await close(conn);
		}
	});
	record.task_id = task.id;
	save_record(record);
	return record;
}

/** Pone de vuelta una carpeta `.previa-*` y aparta lo actual a `aside`. */
function restore_attachment_dir(previous_dir: string, aside_name: string, uploads = writable_upload_folder()): void {
	const aside = join(uploads, aside_name);
	mkdirSync(aside, { recursive: true });
	const keep = kept_entries(uploads);
	for (const name of readdirSync(uploads)) {
		if (keep.has(name) || is_work_dir(name)) continue;
		renameSync(join(uploads, name), join(aside, name));
	}
	for (const name of readdirSync(previous_dir)) {
		renameSync(join(previous_dir, name), join(uploads, name));
	}
	rmSync(previous_dir, { recursive: true, force: true });
}

//   #endregion
