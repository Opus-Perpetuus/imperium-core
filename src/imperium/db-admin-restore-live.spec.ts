/**
 * Restauración contra un Postgres de verdad (no va en `bun run test`).
 *
 *   DB_ADMIN_TEST_URL=postgres://imperium:imperium@127.0.0.1:5434/imperium_restore_prueba \
 *     bun test src/imperium/db-admin-restore-live.spec.ts
 *
 * La base de `DB_ADMIN_TEST_URL` se crea y se destruye aquí: no apuntes a una
 * base con datos. El usuario debe poder crear bases (en el compose lo es).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create_backup, find_backup, list_backups } from './db-admin-backup.ts';
import { append_chunk, complete_upload, start_upload } from './db-admin-upload.ts';
import { reset_db_admin_capabilities } from './db-admin-setup.ts';
import { get_task, reset_tasks } from './db-admin-tasks.ts';
import {
	get_restore,
	list_restores,
	remember_preview,
	restore_preview,
	start_restore,
	start_undo,
} from './db-admin-restore.ts';
import { restore_gate_state } from './db-admin-restore-gate.ts';

const URL_BASE = process.env.DB_ADMIN_TEST_URL ?? '';
const suite = URL_BASE ? describe : describe.skip;
const actor = { id: 'prueba', label: 'prueba@imperium', origin: 'session' as const, source_ip: '127.0.0.1' };
const handle = { id: 'h', log: () => undefined };

function db_name(): string {
	return decodeURIComponent(new URL(URL_BASE).pathname.slice(1));
}

function url_for(name: string): string {
	const url = new URL(URL_BASE);
	url.pathname = `/${name}`;
	return url.toString();
}

async function admin<T>(fn: (sql: Bun.SQL) => Promise<T>): Promise<T> {
	const sql = new Bun.SQL(url_for('postgres'), { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

async function fresh<T>(fn: (sql: Bun.SQL) => Promise<T>): Promise<T> {
	const sql = new Bun.SQL(URL_BASE, { max: 1 });
	try {
		return await fn(sql);
	} finally {
		await sql.end();
	}
}

async function wait_task(id: string | null): Promise<void> {
	for (let i = 0; i < 600; i += 1) {
		const task = id ? get_task(id) : null;
		if (task && task.status !== 'running') {
			if (task.status === 'error') throw new Error(task.error ?? 'falló');
			return;
		}
		await Bun.sleep(100);
	}
	throw new Error('el trabajo no terminó');
}

async function drop_derived(): Promise<void> {
	await admin(async (sql) => {
		const rows = (await sql.unsafe(`SELECT datname FROM pg_database WHERE starts_with(datname, $1)`, [
			`${db_name()}__`,
		])) as Array<{ datname: string }>;
		for (const { datname } of rows) {
			await sql.unsafe(`ALTER DATABASE "${datname}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
			await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
		}
	});
}

async function upload_file(path: string, name: string): Promise<string | null> {
	const bytes = readFileSync(path);
	const meta = await start_upload({ file_name: name, bytes: bytes.byteLength }, actor);
	const chunk = 64 * 1024;
	for (let offset = 0; offset < bytes.byteLength; offset += chunk) {
		append_chunk(meta.id, offset, bytes.subarray(offset, offset + chunk));
	}
	const task = complete_upload(sql, meta.id, { sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') }, actor);
	await wait_task(task.id);
	return (get_task(task.id)?.result as { id?: string } | null)?.id ?? null;
}

let sql: Bun.SQL;
let root: string;
let uploads: string;

suite('restaurar contra Postgres real', () => {
	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), 'imperium-restore-'));
		uploads = join(root, 'uploads');
		mkdirSync(uploads, { recursive: true });
		process.env.MULTER_UPLOAD_FOLDER = uploads;
		process.env.DATABASE_URL = URL_BASE;
		process.env.DB_ADMIN_RESTART_AFTER_RESTORE = '0';
		reset_tasks();
		reset_db_admin_capabilities();
		await drop_derived();
		await admin(async (a) => {
			await a.unsafe(`DROP DATABASE IF EXISTS "${db_name()}" WITH (FORCE)`);
			await a.unsafe(`CREATE DATABASE "${db_name()}"`);
		});
		sql = new Bun.SQL(URL_BASE);
		await sql.unsafe('CREATE SCHEMA subject_configuracion');
		await sql.unsafe('CREATE TABLE subject_configuracion."user" (id text primary key, email text)');
		await sql.unsafe(`INSERT INTO subject_configuracion."user" VALUES ('u1','admin@prueba')`);
		await sql.unsafe('CREATE TABLE public.imperium_sessions (id text primary key, payload jsonb, expires_at timestamptz)');
		await sql.unsafe(`INSERT INTO public.imperium_sessions VALUES ('s-vieja','{}', now() + interval '1 day')`);
		await sql.unsafe('CREATE TABLE prueba (id int primary key, nota text)');
		await sql.unsafe(`INSERT INTO prueba VALUES (1,'uno'),(2,'dos')`);
		writeFileSync(join(uploads, 'foto.jpg'), 'original');
	});

	afterAll(async () => {
		await sql.end().catch(() => undefined);
		await drop_derived();
		await admin((a) => a.unsafe(`DROP DATABASE IF EXISTS "${db_name()}" WITH (FORCE)`));
		rmSync(root, { recursive: true, force: true });
	});

	let backup_id = '';
	let restore_id = '';

	it('respalda, cambia datos y restaura: vuelven datos y adjuntos; la previa queda', async () => {
		const manifest = await create_backup(
			sql,
			{ label: 'prueba', include_attachments: true, trigger: 'manual', id: 'prueba-restore' },
			actor,
			handle,
		);
		backup_id = manifest.id;
		expect(manifest.core_version).toBeTruthy();
		expect(manifest.instance_id).toBeTruthy();

		await sql.unsafe(`DELETE FROM prueba WHERE id = 1`);
		await sql.unsafe(`INSERT INTO prueba VALUES (3,'tres')`);
		writeFileSync(join(uploads, 'foto.jpg'), 'cambiada');
		writeFileSync(join(uploads, 'nueva.pdf'), 'nueva');

		const preview = await restore_preview(sql, backup_id);
		expect(preview.blockers).toEqual([]);
		expect(preview.needs_foreign_ack).toBe(false);
		expect(preview.confirm_phrase).toBe(db_name());
		expect(preview.can_restore_attachments).toBe(true);
		remember_preview(backup_id, preview);

		await expect(start_restore(sql, backup_id, {}, 'otra', actor)).rejects.toThrow(/nombre de la base/);
		await expect(
			start_restore(sql, backup_id, {}, db_name(), { ...actor, origin: 'app' }),
		).rejects.toThrow(/sesión/);

		const record = await start_restore(
			sql,
			backup_id,
			{ restore_attachments: true, skip_restart: true },
			db_name(),
			actor,
		);
		restore_id = record.id;
		await wait_task(record.task_id);
		const done = get_restore(record.id)!;
		expect(done.status).toBe('listo');
		expect(done.safety_backup_id).toMatch(/^seguridad-/);
		expect(find_backup(done.safety_backup_id!)).not.toBeNull();
		expect(done.previous_database).toContain('__previa_');
		expect(restore_gate_state().phase).toBe('libre');

		const rows = await fresh((s) => s.unsafe('SELECT id FROM prueba ORDER BY id') as Promise<Array<{ id: number }>>);
		expect(rows.map((r) => r.id)).toEqual([1, 2]);
		const sessions = await fresh(
			(s) => s.unsafe('SELECT count(*)::int AS n FROM public.imperium_sessions') as Promise<Array<{ n: number }>>,
		);
		expect(sessions[0]!.n).toBe(0);
		expect(readFileSync(join(uploads, 'foto.jpg'), 'utf8')).toBe('original');
		expect(existsSync(join(uploads, 'nueva.pdf'))).toBe(false);
		const previous_exists = await admin(
			(a) => a.unsafe('SELECT 1 FROM pg_database WHERE datname = $1', [done.previous_database]) as Promise<unknown[]>,
		);
		expect(previous_exists.length).toBe(1);

		// El pool principal sobrevive al swap (reconecta) y la bitácora de la
		// base restaurada registra la restauración.
		let pool_ok = false;
		for (let i = 0; i < 3 && !pool_ok; i += 1) {
			pool_ok = await sql.unsafe('SELECT 1').then(() => true, () => false);
		}
		expect(pool_ok).toBe(true);
		const audit = await fresh(
			(s) =>
				s.unsafe(
					`SELECT operation, succeeded FROM db_admin.audit_log WHERE operation = 'respaldo.restaurar'`,
				) as Promise<Array<{ operation: string; succeeded: boolean }>>,
		);
		expect(audit.some((a) => a.succeeded)).toBe(true);

		// La base restaurada conserva la identidad del respaldo: el mismo
		// respaldo no se ve como «de otra instalación».
		const again = await restore_preview(sql, backup_id);
		expect(again.needs_foreign_ack).toBe(false);
	}, 120_000);

	it('deshacer regresa la base y los adjuntos de antes de restaurar', async () => {
		const record = await start_undo(sql, restore_id, db_name(), actor, { skip_restart: true });
		await wait_task(record.task_id);
		expect(get_restore(record.id)!.status).toBe('listo');
		expect(get_restore(restore_id)!.status).toBe('revertido');
		const rows = await fresh((s) => s.unsafe('SELECT id FROM prueba ORDER BY id') as Promise<Array<{ id: number }>>);
		expect(rows.map((r) => r.id)).toEqual([2, 3]);
		expect(readFileSync(join(uploads, 'foto.jpg'), 'utf8')).toBe('cambiada');
		expect(existsSync(join(uploads, 'nueva.pdf'))).toBe(true);
	}, 120_000);

	it('si pg_restore falla, la base activa no se toca y la temporal se borra', async () => {
		const bin = join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		const real = Bun.which('pg_restore')!;
		writeFileSync(
			join(bin, 'pg_restore'),
			`#!/bin/sh\ncase "$*" in *--dbname=*) echo "error simulado" >&2; exit 1;; esac\nexec "${real}" "$@"\n`,
		);
		chmodSync(join(bin, 'pg_restore'), 0o755);
		const old_path = process.env.PATH;
		process.env.PATH = `${bin}:${old_path}`;
		try {
			fresh_sql_reset();
			const preview = await restore_preview(sql, backup_id);
			remember_preview(backup_id, preview);
			const record = await start_restore(sql, backup_id, { skip_restart: true }, db_name(), actor);
			await expect(wait_task(record.task_id)).rejects.toThrow(/pg_restore falló/);
			const failed = get_restore(record.id)!;
			expect(failed.status).toBe('fallo');
			expect(failed.swapped).toBe(false);
			expect(failed.temp_database).toBeNull();
			expect(restore_gate_state().phase).toBe('libre');
			const rows = await fresh((s) => s.unsafe('SELECT id FROM prueba ORDER BY id') as Promise<Array<{ id: number }>>);
			expect(rows.map((r) => r.id)).toEqual([2, 3]);
			const temps = await admin(
				(a) =>
					a.unsafe(`SELECT datname FROM pg_database WHERE datname LIKE $1`, [
						`${db_name()}__restaurando_%`,
					]) as Promise<unknown[]>,
			);
			expect(temps.length).toBe(0);
			expect(list_restores().length).toBeGreaterThanOrEqual(3);
		} finally {
			process.env.PATH = old_path;
		}
	}, 120_000);

	it('un .imperium-backup.tar subido por trozos queda en la lista y se puede revisar', async () => {
		fresh_sql_reset();
		const manifest = await create_backup(
			sql,
			{ label: 'para subir', include_attachments: true, trigger: 'manual', id: 'para-subir' },
			actor,
			handle,
		);
		const copy = join(root, 'copia.imperium-backup.tar');
		writeFileSync(copy, readFileSync(find_backup(manifest.id)!.path));
		const id = await upload_file(copy, 'copia.imperium-backup.tar');
		expect(id).toMatch(/^subido-.*copia$/);
		const imported = list_backups().find((b) => b.id === id)!;
		expect(imported.trigger).toBe('subido');
		expect(imported.imported_from).toBe('copia.imperium-backup.tar');
		expect(imported.instance_id).toBe(manifest.instance_id);
		const preview = await restore_preview(sql, id!);
		expect(preview.blockers).toEqual([]);
		expect(preview.can_restore_attachments).toBe(true);
	}, 120_000);

	it('un volcado pg_dump suelto se envuelve como respaldo sin adjuntos', async () => {
		const dump = join(root, 'suelto.dump');
		const env = { ...process.env, PGDATABASE: db_name() };
		const url = new URL(URL_BASE);
		Object.assign(env, {
			PGHOST: url.hostname,
			PGPORT: url.port,
			PGUSER: decodeURIComponent(url.username),
			PGPASSWORD: decodeURIComponent(url.password),
		});
		const out = Bun.spawnSync(['pg_dump', '--format=custom', `--file=${dump}`], { env });
		expect(out.exitCode).toBe(0);
		const id = await upload_file(dump, 'suelto.dump');
		const imported = list_backups().find((b) => b.id === id)!;
		expect(imported.includes_attachments).toBe(false);
		const preview = await restore_preview(sql, id!);
		expect(preview.blockers).toEqual([]);
		// Sin identidad: se pide la casilla de «otra instalación».
		expect(preview.needs_foreign_ack).toBe(true);
	}, 120_000);

	it('un tar con piezas ajenas se rechaza y no queda en la lista', async () => {
		const evil_dir = join(root, 'evil');
		mkdirSync(evil_dir, { recursive: true });
		writeFileSync(join(evil_dir, 'manifest.json'), '{}');
		writeFileSync(join(evil_dir, 'script.sh'), 'rm -rf /');
		const evil = join(root, 'evil.tar');
		expect(Bun.spawnSync(['tar', '-cf', evil, '-C', evil_dir, 'manifest.json', 'script.sh']).exitCode).toBe(0);
		const before = list_backups().length;
		await expect(upload_file(evil, 'evil.tar')).rejects.toThrow(/no son de un respaldo/);
		expect(list_backups().length).toBe(before);
	}, 120_000);

});

/** El pool principal quedó con conexiones cortadas por los swaps. */
function fresh_sql_reset(): void {
	void sql.end().catch(() => undefined);
	sql = new Bun.SQL(URL_BASE);
}
