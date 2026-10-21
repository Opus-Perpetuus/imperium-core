/**
 * Subida por trozos de un respaldo que no está en el servidor.
 *
 * Por qué por trozos y no un `multipart` de una vez: Bun corta los cuerpos de
 * más de 128 MB, nginx los de más de 700 MB, y un respaldo con adjuntos pasa
 * de eso con facilidad. Además un corte de red a los 3 GB de 4 no debe obligar
 * a empezar de nuevo. Cada trozo trae su `offset`; el servidor solo acepta el
 * que sigue (o repite uno ya recibido, que se ignora), así que reintentar es
 * seguro y reanudar es preguntar cuántos bytes hay.
 *
 * La subida vive en `_respaldos/.subidas/<id>.part` + `<id>.json`. Al cerrar
 * se **importa**: se inspecciona como cualquier archivo de fuera y, si pasa,
 * queda como un respaldo más de la lista (`trigger: 'subido' | 'drive'`).
 */
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
	ARCHIVE_SUFFIX,
	BackupError,
	SIDECAR_SUFFIX,
	backup_dir,
	backup_tooling,
	free_bytes,
	run,
	sanitize_id,
	sha256_of,
	type BackupActor,
	type BackupManifest,
} from './db-admin-backup.ts';
import {
	parse_manifest,
	sniff_format,
	unexpected_members,
	unsafe_tar_listing,
	type ArchiveCheck,
} from './db-admin-archive.ts';
import { write_audit } from './db-admin-setup.ts';
import { start_task, type Task, type TaskHandle } from './db-admin-tasks.ts';

/** Tamaño de trozo que se anuncia al navegador: 8 MiB. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Un trozo más grande que esto se rechaza (el doble del anunciado). */
const MAX_CHUNK_BYTES = UPLOAD_CHUNK_BYTES * 2;
/** Subidas sin tocar en este tiempo se borran solas. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
/** Margen que se deja libre además del archivo (la importación extrae el volcado). */
const SPACE_MARGIN_BYTES = 512 * 1024 * 1024;

export type UploadOrigin = 'subido' | 'drive';

export type UploadMeta = {
	id: string;
	file_name: string;
	bytes: number;
	received: number;
	origin: UploadOrigin;
	created_at: string;
	updated_at: string;
	created_by: string | null;
	status: 'subiendo' | 'importando' | 'importado' | 'fallo';
	backup_id: string | null;
	error: string | null;
};

export function max_upload_bytes(): number {
	const env = Number(process.env.DB_ADMIN_UPLOAD_MAX_BYTES);
	// 50 GiB por omisión: más que eso no es un respaldo que se suba por web.
	return Number.isFinite(env) && env > 0 ? env : 50 * 1024 ** 3;
}

function uploads_dir(): string {
	const dir = join(backup_dir(), '.subidas');
	mkdirSync(dir, { recursive: true });
	return dir;
}

function paths(id: string): { part: string; meta: string } {
	const dir = uploads_dir();
	return { part: join(dir, `${id}.part`), meta: join(dir, `${id}.json`) };
}

function read_meta(id: string): UploadMeta | null {
	const safe = sanitize_id(id);
	if (!safe) return null;
	const { meta } = paths(safe);
	if (!existsSync(meta)) return null;
	try {
		return JSON.parse(readFileSync(meta, 'utf8')) as UploadMeta;
	} catch {
		return null;
	}
}

function write_meta(meta: UploadMeta): void {
	meta.updated_at = new Date().toISOString();
	writeFileSync(paths(meta.id).meta, JSON.stringify(meta, null, 2));
}

/** El nombre que eligió el usuario solo sirve de etiqueta, nunca de ruta. */
function clean_file_name(raw: unknown): string {
	const name = basename(String(raw ?? '').replace(/\\/g, '/')).trim();
	return name.replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 160) || 'respaldo';
}

export async function upload_limits(): Promise<{
	chunk_bytes: number;
	max_bytes: number;
	free_bytes: number | null;
}> {
	return {
		chunk_bytes: UPLOAD_CHUNK_BYTES,
		max_bytes: max_upload_bytes(),
		free_bytes: await free_bytes(backup_dir()),
	};
}

export async function start_upload(
	input: { file_name?: unknown; bytes?: unknown; origin?: unknown },
	actor: BackupActor,
): Promise<UploadMeta & { chunk_bytes: number; max_bytes: number }> {
	cleanup_stale_uploads();
	const bytes = Math.trunc(Number(input.bytes));
	if (!Number.isFinite(bytes) || bytes <= 0) {
		throw new BackupError('Falta el tamaño del archivo.', 400);
	}
	const max = max_upload_bytes();
	if (bytes > max) {
		throw new BackupError(
			`El archivo pesa ${(bytes / 1024 ** 3).toFixed(2)} GB; el máximo es ${(max / 1024 ** 3).toFixed(2)} GB.`,
			413,
		);
	}
	const free = await free_bytes(backup_dir());
	if (free != null && free < bytes + SPACE_MARGIN_BYTES) {
		throw new BackupError(
			`No cabe: quedan ${(free / 1024 ** 2).toFixed(0)} MB libres en el volumen de respaldos.`,
			507,
		);
	}
	const id = `subida-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const origin: UploadOrigin = input.origin === 'drive' ? 'drive' : 'subido';
	const now = new Date().toISOString();
	const meta: UploadMeta = {
		id,
		file_name: clean_file_name(input.file_name),
		bytes,
		received: 0,
		origin,
		created_at: now,
		updated_at: now,
		created_by: actor.label ?? actor.id ?? null,
		status: 'subiendo',
		backup_id: null,
		error: null,
	};
	writeFileSync(paths(id).part, '');
	write_meta(meta);
	return { ...meta, chunk_bytes: UPLOAD_CHUNK_BYTES, max_bytes: max };
}

export function upload_status(id: string): UploadMeta {
	const meta = read_meta(id);
	if (!meta) throw new BackupError('No existe esa subida (o ya caducó).', 404);
	return meta;
}

/**
 * Agrega un trozo. Reglas:
 * - `offset` = lo recibido: se agrega.
 * - el trozo ya estaba completo (`offset + len <= recibido`): se ignora (reintento).
 * - `offset` < recibido pero el trozo se sale: se recorta a `offset` y se agrega.
 * - `offset` > recibido: 409 con lo recibido, para que el cliente reanude.
 */
export function append_chunk(id: string, offset: number, chunk: Uint8Array): UploadMeta {
	const meta = upload_status(id);
	if (meta.status !== 'subiendo') {
		throw new BackupError('Esa subida ya se cerró.', 409);
	}
	if (!Number.isInteger(offset) || offset < 0) {
		throw new BackupError('offset inválido.', 400);
	}
	if (chunk.byteLength === 0) throw new BackupError('Trozo vacío.', 400);
	if (chunk.byteLength > MAX_CHUNK_BYTES) {
		throw new BackupError(`Trozo de más de ${MAX_CHUNK_BYTES} bytes.`, 413);
	}
	if (offset + chunk.byteLength > meta.bytes) {
		throw new BackupError('El trozo se pasa del tamaño anunciado del archivo.', 400);
	}
	const { part } = paths(meta.id);
	const on_disk = existsSync(part) ? statSync(part).size : 0;
	// El tamaño en disco manda sobre el JSON: un corte entre escribir el trozo y
	// el JSON no debe dejar bytes duplicados.
	meta.received = on_disk;
	if (offset > meta.received) {
		throw new BackupError(
			`Falta lo de en medio: el servidor tiene ${meta.received} bytes y el trozo empieza en ${offset}.`,
			409,
		);
	}
	if (offset + chunk.byteLength <= meta.received) {
		write_meta(meta);
		return meta;
	}
	if (offset < meta.received) truncateSync(part, offset);
	appendFileSync(part, chunk);
	meta.received = statSync(part).size;
	write_meta(meta);
	return meta;
}

export function abort_upload(id: string): void {
	const meta = upload_status(id);
	const { part, meta: meta_path } = paths(meta.id);
	rmSync(part, { force: true });
	rmSync(meta_path, { force: true });
}

/** Borra subidas abandonadas. Devuelve los ids borrados. */
export function cleanup_stale_uploads(now = Date.now(), max_age_ms = STALE_UPLOAD_MS): string[] {
	const dir = uploads_dir();
	const removed: string[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith('.json')) continue;
		const id = name.slice(0, -5);
		const meta = read_meta(id);
		const touched = meta ? Date.parse(meta.updated_at) : statSync(join(dir, name)).mtimeMs;
		if (meta?.status === 'importando') continue;
		if (Number.isFinite(touched) && now - touched < max_age_ms) continue;
		rmSync(join(dir, `${id}.part`), { force: true });
		rmSync(join(dir, name), { force: true });
		removed.push(id);
	}
	return removed;
}

/**
 * Cierra la subida e importa el archivo como respaldo. Tarda (suma de varios
 * GB, `pg_restore --list`), así que corre como trabajo del núcleo.
 */
export function complete_upload(
	sql: Bun.SQL,
	id: string,
	input: { sha256?: unknown; label?: unknown },
	actor: BackupActor,
): Task {
	const meta = upload_status(id);
	if (meta.status !== 'subiendo') throw new BackupError('Esa subida ya se cerró.', 409);
	const { part } = paths(meta.id);
	const size = existsSync(part) ? statSync(part).size : 0;
	if (size !== meta.bytes) {
		throw new BackupError(
			`Faltan bytes: llegaron ${size} de ${meta.bytes}. Reanuda la subida.`,
			409,
		);
	}
	meta.status = 'importando';
	write_meta(meta);
	const expected_sha = String(input.sha256 ?? '').trim().toLowerCase();
	const label = String(input.label ?? '').trim();
	return start_task('importacion', `Importar ${meta.file_name}`, async (handle) => {
		try {
			if (expected_sha) {
				handle.log('Comprobando la suma que calculó el navegador…');
				const actual = await sha256_of(part);
				if (actual !== expected_sha) {
					throw new BackupError(
						`La suma no coincide: el archivo se dañó al subir (esperado ${expected_sha}, llegó ${actual}).`,
						422,
					);
				}
			}
			const manifest = await import_archive(
				sql,
				part,
				{ origin: meta.origin, original_name: meta.file_name, label },
				actor,
				handle,
			);
			meta.status = 'importado';
			meta.backup_id = manifest.id;
			write_meta(meta);
			rmSync(paths(meta.id).meta, { force: true });
			return manifest;
		} catch (err) {
			meta.status = 'fallo';
			meta.error = err instanceof Error ? err.message : String(err);
			write_meta(meta);
			rmSync(part, { force: true });
			throw err;
		}
	});
}

function stamp(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Inspecciona un archivo de fuera y, si pasa, lo deja como respaldo de la
 * lista. `source` se **mueve** (no se copia): es la subida, ya no hace falta.
 */
export async function import_archive(
	sql: Bun.SQL,
	source: string,
	info: { origin: UploadOrigin; original_name: string; label?: string },
	actor: BackupActor,
	handle: TaskHandle,
): Promise<BackupManifest & { checks: ArchiveCheck[] }> {
	const started = Date.now();
	const tooling = await backup_tooling();
	if (!tooling.available) throw new BackupError(tooling.reason ?? 'Sin herramientas de Postgres.', 503);
	const dir = backup_dir();
	const work = join(dir, `.importar-${Date.now().toString(36)}`);
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	const checks: ArchiveCheck[] = [];
	try {
		const format = sniff_format(source);
		handle.log(
			format === 'pg_custom'
				? 'Es un volcado pg_dump suelto; se envuelve como respaldo de Imperium sin adjuntos.'
				: format === 'tar'
					? 'Es un artefacto .imperium-backup.tar; revisando su contenido…'
					: 'Formato desconocido.',
		);
		if (format === 'desconocido') {
			throw new BackupError(
				'No es un respaldo de Imperium (.imperium-backup.tar) ni un volcado pg_dump --format=custom.',
				415,
			);
		}

		let manifest: BackupManifest;
		let archive_path: string;
		const base_id =
			sanitize_id(
				info.original_name
					.replace(new RegExp(`${ARCHIVE_SUFFIX.replace(/\./g, '\\.')}$`), '')
					.replace(/\.(dump|tar)$/i, '')
					.replace(/[^A-Za-z0-9._-]/g, '-')
					.replace(/^[^A-Za-z0-9]+/, '')
					.slice(0, 60),
			) ?? 'respaldo';
		const id = `${info.origin}-${stamp()}-${base_id}`.slice(0, 120);

		if (format === 'pg_custom') {
			const dump = join(work, 'database.dump');
			renameSync(source, dump);
			await check_dump(dump, checks, handle);
			writeFileSync(join(work, 'globals.sql'), '');
			const parts = [];
			for (const name of ['globals.sql', 'database.dump']) {
				const full = join(work, name);
				parts.push({ name, bytes: statSync(full).size, sha256: await sha256_of(full) });
			}
			manifest = {
				id,
				label: info.label || `Volcado importado (${info.original_name})`,
				created_at: new Date(statSync(dump).mtimeMs).toISOString(),
				created_by: actor.label ?? actor.id ?? null,
				trigger: info.origin,
				database: '',
				server_version: '',
				dump_tool_version: dump_version_from_list(checks) ?? '',
				core_version: '',
				instance_id: null,
				format_version: 1,
				includes_attachments: false,
				attachment_count: 0,
				parts,
				archive_bytes: 0,
				archive_sha256: '',
				duration_ms: 0,
			};
			writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
			archive_path = join(work, `bundle${ARCHIVE_SUFFIX}`);
			const bundle = await run(['tar', '-cf', archive_path, '-C', work, 'manifest.json', 'globals.sql', 'database.dump']);
			if (bundle.code !== 0) throw new BackupError(`No se pudo armar el artefacto: ${bundle.stderr.trim()}`, 500);
		} else {
			const inner = await inspect_tar(source, work, checks, handle);
			manifest = {
				...inner,
				id,
				label: info.label || inner.label || info.original_name,
				trigger: info.origin,
			};
			archive_path = source;
		}

		const final = join(dir, `${id}${ARCHIVE_SUFFIX}`);
		renameSync(archive_path, final);
		manifest.archive_bytes = statSync(final).size;
		manifest.archive_sha256 = await sha256_of(final);
		manifest.imported_from = info.original_name;
		manifest.imported_at = new Date().toISOString();
		manifest.duration_ms = manifest.duration_ms || 0;
		writeFileSync(join(dir, `${id}${SIDECAR_SUFFIX}`), JSON.stringify(manifest, null, 2));
		handle.log(`Importado como «${manifest.label}» (${(manifest.archive_bytes / 1024 ** 2).toFixed(1)} MB).`);
		await write_audit(sql, {
			actor_id: actor.id ?? null,
			actor_label: actor.label ?? null,
			origin: actor.origin,
			source_ip: actor.source_ip ?? null,
			operation: info.origin === 'drive' ? 'respaldo.importar_drive' : 'respaldo.subir',
			target: id,
			statement: info.original_name,
			duration_ms: Date.now() - started,
			succeeded: true,
		});
		return { ...manifest, checks };
	} catch (err) {
		await write_audit(sql, {
			actor_id: actor.id ?? null,
			actor_label: actor.label ?? null,
			origin: actor.origin,
			source_ip: actor.source_ip ?? null,
			operation: info.origin === 'drive' ? 'respaldo.importar_drive' : 'respaldo.subir',
			target: info.original_name,
			duration_ms: Date.now() - started,
			succeeded: false,
			error: err instanceof Error ? err.message : String(err),
		});
		throw err;
	} finally {
		rmSync(work, { recursive: true, force: true });
		if (existsSync(source)) unlinkSync(source);
	}
}

function dump_version_from_list(checks: ArchiveCheck[]): string | null {
	const found = checks.find((c) => c.name === 'Versión del volcado');
	return found?.ok ? found.detail : null;
}

/** `pg_restore --list` del volcado: objetos > 0 y la versión de pg_dump. */
export async function check_dump(
	dump: string,
	checks: ArchiveCheck[],
	handle?: TaskHandle,
): Promise<number> {
	handle?.log('Abriendo el volcado con pg_restore --list…');
	const list = await run(['pg_restore', '--list', dump]);
	const lines = list.stdout.split('\n');
	const entries = lines.filter((l) => l && !l.startsWith(';')).length;
	checks.push({
		name: 'Volcado legible',
		ok: list.code === 0 && entries > 0,
		detail: list.code === 0 ? `${entries} objetos en el volcado.` : list.stderr.trim(),
	});
	const version = lines.find((l) => /Dumped by pg_dump version/i.test(l));
	checks.push({
		name: 'Versión del volcado',
		ok: Boolean(version),
		detail: version ? `pg_dump ${version.split(':').pop()?.trim() ?? ''}` : 'Sin versión.',
	});
	if (list.code !== 0 || entries === 0) {
		throw new BackupError(`El volcado no se puede abrir: ${list.stderr.trim() || 'vacío'}`, 422);
	}
	return entries;
}

/**
 * Revisa un `.imperium-backup.tar` de fuera: miembros permitidos, sin rutas
 * raras, manifiesto válido, sumas de cada pieza, volcado legible y adjuntos
 * sin enlaces ni rutas que salgan de la carpeta. Extrae en `work`.
 */
export async function inspect_tar(
	archive: string,
	work: string,
	checks: ArchiveCheck[],
	handle?: TaskHandle,
): Promise<BackupManifest> {
	const listing = await run(['tar', '-tvf', archive]);
	if (listing.code !== 0) {
		throw new BackupError(`No es un tar legible: ${listing.stderr.trim()}`, 422);
	}
	const bad = unsafe_tar_listing(listing.stdout);
	const names = (await run(['tar', '-tf', archive])).stdout
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
	const extra = unexpected_members(names);
	checks.push({
		name: 'Contenido del artefacto',
		ok: bad.length === 0 && extra.length === 0 && names.includes('manifest.json'),
		detail: bad.length
			? `Miembros no permitidos: ${bad.join(', ')}`
			: extra.length
				? `Sobran: ${extra.join(', ')}`
				: names.join(', '),
	});
	if (bad.length || extra.length) {
		throw new BackupError('El tar trae archivos que no son de un respaldo de Imperium.', 422);
	}
	if (!names.includes('manifest.json')) {
		throw new BackupError('El tar no trae manifest.json; no es un respaldo de Imperium.', 422);
	}
	const extract = await run(['tar', '-xf', archive, '-C', work, '--no-same-owner', ...names]);
	if (extract.code !== 0) {
		throw new BackupError(`No se pudo extraer: ${extract.stderr.trim()}`, 422);
	}
	const manifest = parse_manifest(readFileSync(join(work, 'manifest.json'), 'utf8'));
	for (const part of manifest.parts) {
		const full = join(work, part.name);
		const ok = existsSync(full) && (await sha256_of(full)) === part.sha256;
		checks.push({
			name: `Suma de ${part.name}`,
			ok,
			detail: ok ? 'Coincide con el manifiesto.' : 'No coincide o falta: archivo dañado o alterado.',
		});
		if (!ok) throw new BackupError(`La pieza ${part.name} no coincide con su suma.`, 422);
	}
	await check_dump(join(work, 'database.dump'), checks, handle);
	if (manifest.parts.some((p) => p.name === 'attachments.tar.gz')) {
		handle?.log('Revisando la lista de adjuntos…');
		const inner = await run(['tar', '-tvzf', join(work, 'attachments.tar.gz')]);
		const unsafe = inner.code === 0 ? unsafe_tar_listing(inner.stdout) : ['(no legible)'];
		checks.push({
			name: 'Adjuntos',
			ok: unsafe.length === 0,
			detail: unsafe.length ? `No permitidos: ${unsafe.slice(0, 10).join(', ')}` : 'Solo archivos y carpetas.',
		});
		if (unsafe.length) throw new BackupError('Los adjuntos traen enlaces o rutas que salen de la carpeta.', 422);
	}
	manifest.includes_attachments = manifest.parts.some((p) => p.name === 'attachments.tar.gz');
	return manifest;
}
