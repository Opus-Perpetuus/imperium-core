/**
 * Restauración: piezas que no necesitan Postgres (candado, subida por trozos,
 * inspección de artefactos, compatibilidad, nombres). Lo que sí lo necesita
 * está en `db-admin-restore-live.spec.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restore_gate, restore_gate_state, set_restore_gate } from './db-admin-restore-gate.ts';
import {
	check_compatibility,
	compare_versions,
	major_of,
	parse_manifest,
	safe_member_name,
	sniff_format,
	unexpected_members,
	unsafe_tar_listing,
} from './db-admin-archive.ts';
import {
	UPLOAD_CHUNK_BYTES,
	abort_upload,
	append_chunk,
	cleanup_stale_uploads,
	start_upload,
	upload_status,
} from './db-admin-upload.ts';
import { derived_db_name, quote_ident, recent_preview, remember_preview, start_restore } from './db-admin-restore.ts';
import { CORE_VERSION } from './health.ts';

const actor = { id: 'u', label: 'admin@prueba', origin: 'session' as const };

describe('candado de mantenimiento', () => {
	afterAll(() => set_restore_gate('libre'));

	test('libre: deja pasar todo', () => {
		set_restore_gate('libre');
		expect(restore_gate('POST', '/api/pedidos')).toBeNull();
	});

	test('escrituras bloqueadas: lecturas, login y gestor pasan; escrituras 503', async () => {
		set_restore_gate('escrituras_bloqueadas', 'r1');
		expect(restore_gate('GET', '/api/pedidos')).toBeNull();
		expect(restore_gate('POST', '/api/auth/login')).toBeNull();
		expect(restore_gate('GET', '/api/db-admin/restores/r1')).toBeNull();
		const blocked = restore_gate('POST', '/api/pedidos');
		expect(blocked?.status).toBe(503);
		expect(blocked?.headers.get('retry-after')).toBe('30');
		const body = (await blocked!.json()) as Record<string, unknown>;
		expect(body.code).toBe('restauracion_en_curso');
		expect(body.restore_id).toBe('r1');
		expect(restore_gate('DELETE', '/api/m/subject-turnos/x')?.status).toBe(503);
	});

	test('intercambio: solo la sonda y el seguimiento de la restauración', () => {
		set_restore_gate('intercambio', 'r1');
		expect(restore_gate('GET', '/health')).toBeNull();
		expect(restore_gate('GET', '/api/health')).toBeNull();
		expect(restore_gate('GET', '/api/db-admin/restores')).toBeNull();
		expect(restore_gate('GET', '/api/pedidos')?.status).toBe(503);
		expect(restore_gate('POST', '/api/auth/login')?.status).toBe(503);
		expect(restore_gate('POST', '/api/db-admin/restores/r1/undo')?.status).toBe(503);
		expect(restore_gate_state().restore_id).toBe('r1');
	});
});

describe('inspección de artefactos', () => {
	test('nombres de miembro: nada absoluto ni con ..', () => {
		expect(safe_member_name('./fotos/a.jpg')).toBe(true);
		expect(safe_member_name('database.dump')).toBe(true);
		expect(safe_member_name('/etc/passwd')).toBe(false);
		expect(safe_member_name('../../etc/passwd')).toBe(false);
		expect(safe_member_name('fotos/../../x')).toBe(false);
		expect(safe_member_name('a\\b')).toBe(false);
	});

	test('listado de tar: rechaza enlaces y rutas que salen', () => {
		const listing = [
			'drwxr-xr-x root/root         0 2026-10-20 10:00 ./',
			'-rw-r--r-- root/root      1234 2026-10-20 10:00 ./foto.jpg',
			'lrwxrwxrwx root/root         0 2026-10-20 10:00 ./malo -> /etc',
			'hrw-r--r-- root/root         0 2026-10-20 10:00 ./duro link to /etc/shadow',
			'-rw-r--r-- root/root         5 2026-10-20 10:00 ../fuera.txt',
		].join('\n');
		const bad = unsafe_tar_listing(listing);
		expect(bad.length).toBe(3);
		expect(bad.join(' ')).toContain('../fuera.txt');
	});

	test('tar exterior: solo las piezas de un respaldo', () => {
		expect(unexpected_members(['manifest.json', 'database.dump', './globals.sql'])).toEqual([]);
		expect(unexpected_members(['manifest.json', 'database.dump', 'script.sh'])).toEqual(['script.sh']);
	});

	test('manifiesto: exige piezas conocidas con suma y el volcado', () => {
		const good = parse_manifest(
			JSON.stringify({ id: 'x', parts: [{ name: 'database.dump', bytes: 1, sha256: 'a' }] }),
		);
		expect(good.id).toBe('x');
		expect(() => parse_manifest('{no')).toThrow(/JSON/);
		expect(() => parse_manifest(JSON.stringify({ parts: [] }))).toThrow(/database.dump/);
		expect(() =>
			parse_manifest(JSON.stringify({ parts: [{ name: '../x', sha256: 'a' }, { name: 'database.dump', sha256: 'b' }] })),
		).toThrow(/desconocida/);
	});

	test('firma del archivo: volcado custom, tar o desconocido', () => {
		const dir = mkdtempSync(join(tmpdir(), 'sniff-'));
		try {
			writeFileSync(join(dir, 'a.dump'), Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(100)]));
			const tar = Buffer.alloc(1024);
			tar.write('ustar', 257, 'latin1');
			writeFileSync(join(dir, 'b.tar'), tar);
			writeFileSync(join(dir, 'c.sql'), 'SELECT 1;');
			expect(sniff_format(join(dir, 'a.dump'))).toBe('pg_custom');
			expect(sniff_format(join(dir, 'b.tar'))).toBe('tar');
			expect(sniff_format(join(dir, 'c.sql'))).toBe('desconocido');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('compatibilidad', () => {
	const base = { database: 'imperium_core', dump_tool_version: 'pg_dump (PostgreSQL) 16.4', instance_id: 'i-1' };

	test('versiones', () => {
		expect(major_of('pg_dump (PostgreSQL) 17.2 (Debian 17.2-1)')).toBe(17);
		expect(major_of('13.91.0')).toBe(13);
		expect(compare_versions('13.91.0', '13.92.0')).toBe(-1);
		expect(compare_versions('13.92.1', '13.92.0')).toBe(1);
		expect(compare_versions('13.92.0', '13.92.0')).toBe(0);
	});

	test('misma instalación y mismo núcleo: sin bloqueos ni casillas', () => {
		const c = check_compatibility({
			manifest: { ...base, core_version: '13.91.0' },
			current_database: 'imperium_core',
			current_instance_id: 'i-1',
			pg_restore_version: 'pg_restore (PostgreSQL) 17.2',
			core_version: '13.91.0',
		});
		expect(c.blockers).toEqual([]);
		expect(c.needs_foreign_ack).toBe(false);
		expect(c.needs_version_ack).toBe(false);
	});

	test('pg_dump más nuevo que pg_restore: bloquea', () => {
		const c = check_compatibility({
			manifest: { ...base, dump_tool_version: 'pg_dump (PostgreSQL) 18.0', core_version: '13.91.0' },
			current_database: 'imperium_core',
			pg_restore_version: 'pg_restore (PostgreSQL) 17.2',
			core_version: '13.91.0',
		});
		expect(c.blockers.length).toBe(1);
	});

	test('otra instalación o núcleo más nuevo: pide casilla', () => {
		const foreign = check_compatibility({
			manifest: { ...base, core_version: '13.91.0' },
			current_database: 'imperium_core',
			current_instance_id: 'i-2',
			pg_restore_version: '17.2',
			core_version: '13.91.0',
		});
		expect(foreign.needs_foreign_ack).toBe(true);
		const newer = check_compatibility({
			manifest: { ...base, core_version: '13.95.0' },
			current_database: 'imperium_core',
			current_instance_id: 'i-1',
			pg_restore_version: '17.2',
			core_version: '13.91.0',
		});
		expect(newer.needs_version_ack).toBe(true);
		const other_major = check_compatibility({
			manifest: { ...base, core_version: '12.0.0' },
			current_database: 'imperium_core',
			current_instance_id: 'i-1',
			pg_restore_version: '17.2',
			core_version: '13.91.0',
		});
		expect(other_major.needs_version_ack).toBe(true);
	});

	test('respaldo viejo sin identidad: compara por nombre de base y avisa', () => {
		const c = check_compatibility({
			manifest: { database: 'otra_base', dump_tool_version: '16', core_version: '' },
			current_database: 'imperium_core',
			current_instance_id: 'i-1',
			pg_restore_version: '17',
			core_version: CORE_VERSION,
		});
		expect(c.needs_foreign_ack).toBe(true);
		expect(c.warnings.join(' ')).toMatch(/identidad/);
		expect(c.warnings.join(' ')).toMatch(/13\.92/);
	});
});

describe('nombres de bases derivadas', () => {
	test('caben en 63 bytes y conservan el sufijo', () => {
		const long = 'b'.repeat(70);
		const name = derived_db_name(long, 'restaurando', 'mh2x9a1b');
		expect(name.length).toBeLessThanOrEqual(63);
		expect(name.endsWith('__restaurando_mh2x9a1b')).toBe(true);
		expect(derived_db_name('imperium_core', 'previa', 'abc')).toBe('imperium_core__previa_abc');
	});

	test('comillas de identificador', () => {
		expect(quote_ident('a"b')).toBe('"a""b"');
	});
});

describe('subida por trozos', () => {
	let dir = '';
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'uploads-'));
		process.env.DB_ADMIN_BACKUP_DIR = dir;
	});
	afterAll(() => {
		delete process.env.DB_ADMIN_BACKUP_DIR;
		delete process.env.DB_ADMIN_UPLOAD_MAX_BYTES;
		rmSync(dir, { recursive: true, force: true });
	});

	test('anuncia el trozo y rechaza tamaños inválidos o mayores al máximo', async () => {
		await expect(start_upload({ file_name: 'x.tar', bytes: 0 }, actor)).rejects.toThrow(/tamaño/);
		process.env.DB_ADMIN_UPLOAD_MAX_BYTES = '100';
		await expect(start_upload({ file_name: 'x.tar', bytes: 101 }, actor)).rejects.toThrow(/máximo/);
		delete process.env.DB_ADMIN_UPLOAD_MAX_BYTES;
		const meta = await start_upload({ file_name: '../../etc/passwd', bytes: 10 }, actor);
		expect(meta.chunk_bytes).toBe(UPLOAD_CHUNK_BYTES);
		expect(meta.file_name).toBe('passwd');
		expect(meta.origin).toBe('subido');
		abort_upload(meta.id);
		expect(() => upload_status(meta.id)).toThrow(/No existe/);
	});

	test('agrega en orden, ignora reintentos, rechaza huecos y excesos', async () => {
		const meta = await start_upload({ file_name: 'r.tar', bytes: 10 }, actor);
		const enc = (s: string) => new TextEncoder().encode(s);
		expect(append_chunk(meta.id, 0, enc('abcd')).received).toBe(4);
		// Reintento del mismo trozo: no duplica.
		expect(append_chunk(meta.id, 0, enc('abcd')).received).toBe(4);
		// Hueco: 409 con lo recibido.
		expect(() => append_chunk(meta.id, 6, enc('gh'))).toThrow(/tiene 4 bytes/);
		// Reescribe desde un offset ya recibido.
		expect(append_chunk(meta.id, 2, enc('CDEF')).received).toBe(6);
		expect(() => append_chunk(meta.id, 6, enc('ghijk'))).toThrow(/se pasa/);
		expect(append_chunk(meta.id, 6, enc('ghij')).received).toBe(10);
		const part = join(dir, '.subidas', `${meta.id}.part`);
		expect(readFileSync(part, 'utf8')).toBe('abCDEFghij');
		expect(() => append_chunk(meta.id, 3, new Uint8Array())).toThrow(/vacío/);
		expect(() => append_chunk(meta.id, -1, enc('x'))).toThrow(/offset/);
		abort_upload(meta.id);
	});

	test('las subidas abandonadas se limpian', async () => {
		const meta = await start_upload({ file_name: 'vieja.tar', bytes: 5 }, actor);
		const json = join(dir, '.subidas', `${meta.id}.json`);
		const old = JSON.parse(readFileSync(json, 'utf8'));
		old.updated_at = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
		writeFileSync(json, JSON.stringify(old));
		utimesSync(json, new Date(0), new Date(0));
		expect(cleanup_stale_uploads()).toContain(meta.id);
		expect(existsSync(json)).toBe(false);
		expect(statSync(dir).isDirectory()).toBe(true);
	});
});

describe('arranque de la restauración', () => {
	test('desde el plano de apps no se restaura', async () => {
		await expect(
			start_restore(null as unknown as Bun.SQL, 'x', {}, 'imperium_core', { ...actor, origin: 'app' }),
		).rejects.toThrow(/sesión/);
	});

	test('la vista previa caduca', () => {
		const preview = { confirm_phrase: 'imperium_core' } as never;
		remember_preview('r-ttl', preview, Date.now() - 31 * 60 * 1000);
		expect(recent_preview('r-ttl')).toBeNull();
		remember_preview('r-ttl', preview);
		expect(recent_preview('r-ttl')).not.toBeNull();
	});
});
