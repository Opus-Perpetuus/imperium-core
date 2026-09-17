/**
 * Respaldos: volcado de Postgres + los adjuntos, en un solo artefacto.
 *
 * Por qué van juntos: los adjuntos no viven en la base, viven en el volumen
 * (`MULTER_UPLOAD_FOLDER`). Respaldarlos por separado y con otro horario
 * produce el fallo que nadie ve hasta que restaura — filas que apuntan a
 * archivos que en ese respaldo todavía no existían, o que ya se habían
 * borrado. Un artefacto, un manifiesto, una suma de verificación.
 *
 * El artefacto es un `.tar` con:
 *   manifest.json        qué es, de cuándo, y el sha256 de cada pieza
 *   globals.sql          roles y privilegios del clúster (pg_dump NO los trae)
 *   database.dump        pg_dump --format=custom (restaurable pieza a pieza)
 *   attachments.tar.gz   el volumen de adjuntos, sin la propia carpeta de
 *                        respaldos (si no, cada respaldo se comería al anterior)
 *
 * Se escribe en `<destino>.part` y solo al terminar bien se renombra: un corte
 * de luz a media faena deja basura reconocible, no un respaldo que miente.
 */
import { createHash } from 'node:crypto';
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writable_upload_folder } from './uploads.ts';
import { write_audit } from './db-admin-setup.ts';
import { start_task, is_running, type Task, type TaskHandle } from './db-admin-tasks.ts';

/** Nombre de la carpeta de respaldos dentro del volumen de adjuntos. */
const BACKUP_FOLDER_NAME = '_respaldos';

export const ARCHIVE_SUFFIX = '.imperium-backup.tar';
const SIDECAR_SUFFIX = '.manifest.json';

export type BackupManifest = {
	id: string;
	label: string;
	created_at: string;
	created_by: string | null;
	trigger: 'manual' | 'programado';
	database: string;
	server_version: string;
	dump_tool_version: string;
	includes_attachments: boolean;
	attachment_count: number;
	parts: Array<{ name: string; bytes: number; sha256: string }>;
	archive_bytes: number;
	archive_sha256: string;
	duration_ms: number;
};

export class BackupError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export function backup_dir(): string {
	const env = process.env.DB_ADMIN_BACKUP_DIR?.trim();
	const dir = env || join(writable_upload_folder(), BACKUP_FOLDER_NAME);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Conexión desglosada en variables `PG*` para no poner la contraseña en `ps`. */
function pg_env(): Record<string, string> {
	const raw = process.env.DATABASE_URL?.trim();
	if (!raw) throw new BackupError('No hay DATABASE_URL en el núcleo.', 500);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BackupError('DATABASE_URL no es una URL válida.', 500);
	}
	const env: Record<string, string> = {
		PGHOST: decodeURIComponent(url.hostname),
		PGPORT: url.port || '5432',
		PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
	};
	if (url.username) env.PGUSER = decodeURIComponent(url.username);
	if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
	return env;
}

type RunResult = { code: number; stdout: string; stderr: string };

async function run(cmd: string[], extra_env: Record<string, string> = {}): Promise<RunResult> {
	const proc = Bun.spawn(cmd, {
		env: { ...process.env, ...extra_env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

/** ¿Están las herramientas de Postgres en esta imagen? */
export async function backup_tooling(): Promise<{
	available: boolean;
	pg_dump_version: string | null;
	reason: string | null;
}> {
	try {
		const out = await run(['pg_dump', '--version']);
		if (out.code !== 0) {
			return { available: false, pg_dump_version: null, reason: out.stderr.trim() };
		}
		return {
			available: true,
			pg_dump_version: out.stdout.trim(),
			reason: null,
		};
	} catch (err) {
		return {
			available: false,
			pg_dump_version: null,
			reason:
				'No hay pg_dump en la imagen del núcleo. ' +
				(err instanceof Error ? err.message : String(err)),
		};
	}
}

/** Espacio libre en el punto de montaje del destino, en bytes. */
async function free_bytes(dir: string): Promise<number | null> {
	const out = await run(['df', '-Pk', dir]);
	if (out.code !== 0) return null;
	const line = out.stdout.trim().split('\n')[1];
	const available = line?.trim().split(/\s+/)[3];
	return available ? Number(available) * 1024 : null;
}

async function sha256_of(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest('hex');
}

function count_files(dir: string): number {
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === BACKUP_FOLDER_NAME) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) total += count_files(full);
		else total += 1;
	}
	return total;
}

export type BackupRequest = {
	label?: string;
	include_attachments?: boolean;
	trigger?: 'manual' | 'programado';
	/**
	 * Nombre fijo del artefacto. El programador lo deriva de
	 * `(política, momento programado)` para que un reintento sobrescriba el
	 * mismo archivo en vez de dejar dos respaldos "buenos" distintos.
	 */
	id?: string;
};

export type BackupActor = {
	id?: string | null;
	label?: string | null;
	origin: 'session' | 'app';
	source_ip?: string | null;
};

export function start_backup(
	sql: Bun.SQL,
	request: BackupRequest,
	actor: BackupActor,
): Task {
	if (is_running('respaldo')) {
		throw new BackupError(
			'Ya hay un respaldo en curso. Espera a que termine.',
			409,
		);
	}
	const label = String(request.label ?? '').trim() || 'Respaldo';
	return start_task('respaldo', label, (handle) =>
		create_backup(sql, request, actor, handle),
	);
}

async function create_backup(
	sql: Bun.SQL,
	request: BackupRequest,
	actor: BackupActor,
	handle: TaskHandle,
): Promise<BackupManifest> {
	const started = Date.now();
	const tooling = await backup_tooling();
	if (!tooling.available) {
		throw new BackupError(tooling.reason ?? 'Sin pg_dump.', 503);
	}

	const dir = backup_dir();
	const uploads = writable_upload_folder();
	const include_attachments = request.include_attachments !== false;
	const id = sanitize_id(request.id) ?? new Date().toISOString().replace(/[:.]/g, '-');
	const work = join(dir, `.tmp-${id}`);
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });

	const env = pg_env();
	const free = await free_bytes(dir);
	if (free != null && free < 512 * 1024 * 1024) {
		throw new BackupError(
			`Quedan ${(free / 1024 / 1024).toFixed(0)} MB libres en el destino; ` +
				'no se arranca un respaldo con tan poco espacio.',
			507,
		);
	}

	try {
		handle.log('Volcando roles y privilegios del clúster…');
		const globals = await run(['pg_dumpall', '--globals-only'], env);
		if (globals.code !== 0) {
			// Sin superusuario no hay globals; el volcado de datos sí sirve.
			handle.log(`Aviso: no se pudieron volcar los roles (${globals.stderr.trim()}).`);
		}
		writeFileSync(join(work, 'globals.sql'), globals.code === 0 ? globals.stdout : '');

		handle.log('Volcando la base de datos…');
		const dump = await run(
			[
				'pg_dump',
				'--format=custom',
				'--compress=6',
				// Sin esto un `bytea` grande o un objeto grande se queda fuera
				// cuando alguien filtra por esquema.
				'--large-objects',
				`--file=${join(work, 'database.dump')}`,
			],
			env,
		);
		if (dump.code !== 0) {
			throw new BackupError(`pg_dump falló: ${dump.stderr.trim()}`, 500);
		}

		let attachment_count = 0;
		if (include_attachments) {
			handle.log('Empaquetando los adjuntos…');
			attachment_count = count_files(uploads);
			const tar = await run([
				'tar',
				'-czf',
				join(work, 'attachments.tar.gz'),
				'-C',
				uploads,
				`--exclude=./${BACKUP_FOLDER_NAME}`,
				'.',
			]);
			if (tar.code !== 0) {
				throw new BackupError(
					`No se pudieron empaquetar los adjuntos: ${tar.stderr.trim()}`,
					500,
				);
			}
			handle.log(`${attachment_count} archivos adjuntos.`);
		}

		const [server_row] = (await sql.unsafe(
			'SELECT version() AS v, current_database() AS db',
		)) as Array<Record<string, unknown>>;

		const part_names = ['globals.sql', 'database.dump'];
		if (include_attachments) part_names.push('attachments.tar.gz');
		const parts = [];
		for (const name of part_names) {
			const full = join(work, name);
			parts.push({
				name,
				bytes: statSync(full).size,
				sha256: await sha256_of(full),
			});
		}

		const manifest: BackupManifest = {
			id,
			label: String(request.label ?? '').trim() || 'Respaldo',
			created_at: new Date().toISOString(),
			created_by: actor.label ?? actor.id ?? null,
			trigger: request.trigger ?? 'manual',
			database: String(server_row?.db ?? ''),
			server_version: String(server_row?.v ?? ''),
			dump_tool_version: tooling.pg_dump_version ?? '',
			includes_attachments: include_attachments,
			attachment_count,
			parts,
			archive_bytes: 0,
			archive_sha256: '',
			duration_ms: 0,
		};
		writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

		handle.log('Sellando el artefacto…');
		const final = join(dir, `${id}${ARCHIVE_SUFFIX}`);
		const partial = `${final}.part`;
		const bundle = await run([
			'tar',
			'-cf',
			partial,
			'-C',
			work,
			'manifest.json',
			...part_names,
		]);
		if (bundle.code !== 0) {
			throw new BackupError(`No se pudo sellar: ${bundle.stderr.trim()}`, 500);
		}

		manifest.archive_bytes = statSync(partial).size;
		manifest.archive_sha256 = await sha256_of(partial);
		manifest.duration_ms = Date.now() - started;
		// El renombrado es el commit: hasta aquí nada en la lista.
		renameSync(partial, final);
		writeFileSync(
			join(dir, `${id}${SIDECAR_SUFFIX}`),
			JSON.stringify(manifest, null, 2),
		);

		handle.log(
			`Respaldo listo: ${(manifest.archive_bytes / 1024 / 1024).toFixed(1)} MB ` +
				`en ${Math.round(manifest.duration_ms / 1000)} s.`,
		);
		await write_audit(sql, {
			actor_id: actor.id ?? null,
			actor_label: actor.label ?? null,
			origin: actor.origin,
			source_ip: actor.source_ip ?? null,
			operation: 'respaldo.crear',
			target: id,
			duration_ms: manifest.duration_ms,
			succeeded: true,
		});
		return manifest;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await write_audit(sql, {
			actor_id: actor.id ?? null,
			actor_label: actor.label ?? null,
			origin: actor.origin,
			source_ip: actor.source_ip ?? null,
			operation: 'respaldo.crear',
			target: id,
			duration_ms: Date.now() - started,
			succeeded: false,
			error: message,
		});
		throw err;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

export function list_backups(): BackupManifest[] {
	const dir = backup_dir();
	const out: BackupManifest[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(SIDECAR_SUFFIX)) continue;
		const id = name.slice(0, -SIDECAR_SUFFIX.length);
		if (!existsSync(join(dir, `${id}${ARCHIVE_SUFFIX}`))) continue;
		try {
			out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as BackupManifest);
		} catch {
			/* un manifiesto ilegible no debe esconder los demás */
		}
	}
	return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function find_backup(id: string): { manifest: BackupManifest; path: string } | null {
	const safe = sanitize_id(id);
	if (!safe) return null;
	const dir = backup_dir();
	const path = join(dir, `${safe}${ARCHIVE_SUFFIX}`);
	const sidecar = join(dir, `${safe}${SIDECAR_SUFFIX}`);
	if (!existsSync(path) || !existsSync(sidecar)) return null;
	return {
		manifest: JSON.parse(readFileSync(sidecar, 'utf8')) as BackupManifest,
		path,
	};
}

/**
 * Comprueba que el artefacto sigue siendo el que se escribió y que el volcado
 * se puede abrir. `pg_restore --list` lee el índice del archivo: si está
 * truncado o corrompido, falla aquí y no el día de la restauración.
 */
export async function verify_backup(
	sql: Bun.SQL,
	id: string,
	actor: BackupActor,
): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> }> {
	const found = find_backup(id);
	if (!found) throw new BackupError(`No existe el respaldo "${id}".`, 404);
	const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

	const actual = await sha256_of(found.path);
	checks.push({
		name: 'Suma de verificación del artefacto',
		ok: actual === found.manifest.archive_sha256,
		detail: actual === found.manifest.archive_sha256 ? 'Coincide.' : `Esperado ${found.manifest.archive_sha256}, encontrado ${actual}.`,
	});

	const listing = await run(['tar', '-tf', found.path]);
	const members = listing.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
	const expected = ['manifest.json', ...found.manifest.parts.map((p) => p.name)];
	const missing = expected.filter((name) => !members.includes(name));
	checks.push({
		name: 'Contenido del artefacto',
		ok: listing.code === 0 && missing.length === 0,
		detail: missing.length ? `Faltan: ${missing.join(', ')}` : members.join(', '),
	});

	const work = join(backup_dir(), `.verify-${found.manifest.id}`);
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	try {
		const extract = await run(['tar', '-xf', found.path, '-C', work, 'database.dump']);
		if (extract.code !== 0) {
			checks.push({
				name: 'Volcado legible',
				ok: false,
				detail: extract.stderr.trim() || 'No se pudo extraer.',
			});
		} else {
			const list = await run(['pg_restore', '--list', join(work, 'database.dump')]);
			const entries = list.stdout.split('\n').filter((l) => l && !l.startsWith(';')).length;
			checks.push({
				name: 'Volcado legible',
				ok: list.code === 0 && entries > 0,
				detail:
					list.code === 0
						? `${entries} objetos en el volcado.`
						: list.stderr.trim(),
			});
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	const ok = checks.every((c) => c.ok);
	await write_audit(sql, {
		actor_id: actor.id ?? null,
		actor_label: actor.label ?? null,
		origin: actor.origin,
		source_ip: actor.source_ip ?? null,
		operation: 'respaldo.verificar',
		target: id,
		succeeded: ok,
		error: ok ? null : checks.filter((c) => !c.ok).map((c) => c.name).join('; '),
	});
	return { ok, checks };
}

export async function delete_backup(
	sql: Bun.SQL,
	id: string,
	actor: BackupActor,
): Promise<void> {
	const found = find_backup(id);
	if (!found) throw new BackupError(`No existe el respaldo "${id}".`, 404);
	unlinkSync(found.path);
	const sidecar = join(backup_dir(), `${found.manifest.id}${SIDECAR_SUFFIX}`);
	if (existsSync(sidecar)) unlinkSync(sidecar);
	await write_audit(sql, {
		actor_id: actor.id ?? null,
		actor_label: actor.label ?? null,
		origin: actor.origin,
		source_ip: actor.source_ip ?? null,
		operation: 'respaldo.borrar',
		target: id,
		succeeded: true,
	});
}

/**
 * Aplica la retención: deja los `keep` más recientes.
 *
 * Nunca borra el más reciente aunque `keep` venga en 0, y nunca toca un `.part`
 * ni una carpeta de trabajo (no están en la lista). Devuelve lo que borró.
 */
export async function prune_backups(
	sql: Bun.SQL,
	keep: number,
	actor: BackupActor,
): Promise<string[]> {
	const all = list_backups();
	const limit = Math.max(1, Math.trunc(keep));
	const doomed = all.slice(limit);
	const removed: string[] = [];
	for (const manifest of doomed) {
		try {
			await delete_backup(sql, manifest.id, actor);
			removed.push(manifest.id);
		} catch {
			/* que uno no se deje borrar no debe frenar a los demás */
		}
	}
	return removed;
}

/** Solo `A-Za-z0-9._-`: el id acaba siendo parte de una ruta. */
function sanitize_id(raw: string | undefined | null): string | null {
	const value = String(raw ?? '').trim();
	if (!value) return null;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value)) return null;
	if (value.includes('..')) return null;
	return value;
}
