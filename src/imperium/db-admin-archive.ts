/**
 * Inspección de un artefacto de respaldo antes de confiar en él.
 *
 * Se usa al importar (subida o Drive) y antes de restaurar. Un archivo que
 * llega de fuera puede ser cualquier cosa: truncado, de otra versión, de otro
 * cliente, o un tar armado para escribir fuera de su carpeta (`../../etc`).
 * Todo eso se rechaza aquí, antes de extraer nada en el volumen real.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { CORE_VERSION } from './health.ts';
import type { BackupManifest } from './db-admin-backup.ts';

/** Piezas que puede traer un `.imperium-backup.tar`, y nada más. */
export const ARCHIVE_MEMBERS = new Set([
	'manifest.json',
	'globals.sql',
	'database.dump',
	'attachments.tar.gz',
]);

export type ArchiveCheck = { name: string; ok: boolean; detail: string };

/** Formato por la firma: `PGDMP` = `pg_dump --format=custom`; si no, tar. */
export function sniff_format(path: string): 'pg_custom' | 'tar' | 'desconocido' {
	const fd = openSync(path, 'r');
	try {
		const head = Buffer.alloc(512);
		const n = readSync(fd, head, 0, 512, 0);
		if (n >= 5 && head.subarray(0, 5).toString('latin1') === 'PGDMP') return 'pg_custom';
		// ustar: "ustar" en el byte 257.
		if (n >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') return 'tar';
		return 'desconocido';
	} finally {
		closeSync(fd);
	}
}

/**
 * Un miembro de tar que se puede extraer sin salir de la carpeta: relativo,
 * sin `..`, sin barras invertidas ni bytes de control.
 */
export function safe_member_name(raw: string): boolean {
	const name = raw.replace(/^\.\//, '');
	if (!name || name === '.') return true;
	if (name.startsWith('/') || name.includes('\\')) return false;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f]/.test(name)) return false;
	return !name.split('/').some((part) => part === '..');
}

/**
 * Revisa la salida de `tar -tv`: solo archivos y carpetas. Un enlace
 * simbólico o duro dentro de los adjuntos puede apuntar fuera del volumen y
 * convertir la siguiente escritura en una escritura arbitraria.
 */
export function unsafe_tar_listing(verbose_listing: string): string[] {
	const bad: string[] = [];
	for (const line of verbose_listing.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const type = trimmed[0];
		// GNU tar: `-rw-r--r-- user/group size fecha hora nombre`.
		const parts = trimmed.split(/\s+/);
		const name = parts.slice(5).join(' ');
		if (type !== '-' && type !== 'd') {
			bad.push(`${name || trimmed} (tipo ${type})`);
			continue;
		}
		if (!safe_member_name(name)) bad.push(name);
	}
	return bad;
}

/** Miembros del tar exterior que sobran o están mal nombrados. */
export function unexpected_members(members: string[]): string[] {
	return members
		.map((m) => m.replace(/^\.\//, ''))
		.filter((m) => m && !ARCHIVE_MEMBERS.has(m));
}

export function parse_manifest(text: string): BackupManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error('manifest.json no es JSON válido.');
	}
	const m = raw as Partial<BackupManifest>;
	if (!m || typeof m !== 'object' || !Array.isArray(m.parts)) {
		throw new Error('manifest.json no tiene la lista de piezas.');
	}
	for (const part of m.parts) {
		if (!part || typeof part.name !== 'string' || typeof part.sha256 !== 'string') {
			throw new Error('manifest.json trae una pieza sin nombre o sin suma.');
		}
		if (!ARCHIVE_MEMBERS.has(part.name) || part.name === 'manifest.json') {
			throw new Error(`manifest.json declara una pieza desconocida: ${part.name}`);
		}
	}
	if (!m.parts.some((p) => p.name === 'database.dump')) {
		throw new Error('El respaldo no trae database.dump.');
	}
	return m as BackupManifest;
}

/** Mayor de una versión `13.91.0` o de `pg_dump (PostgreSQL) 17.2 (Debian…)`. */
export function major_of(version: string | null | undefined): number | null {
	const match = String(version ?? '').match(/(\d+)(?:\.(\d+))?/);
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isFinite(n) ? n : null;
}

function semver_parts(version: string): number[] {
	return String(version)
		.split(/[.+-]/)
		.slice(0, 3)
		.map((p) => Number(p) || 0);
}

/** -1, 0, 1 como `a` < = > `b` en mayor.menor.parche. */
export function compare_versions(a: string, b: string): number {
	const pa = semver_parts(a);
	const pb = semver_parts(b);
	for (let i = 0; i < 3; i += 1) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
}

export type Compatibility = {
	blockers: string[];
	warnings: string[];
	/** Requiere la casilla «Entiendo la diferencia de versión». */
	needs_version_ack: boolean;
	/** Requiere la casilla «viene de otra base». */
	needs_foreign_ack: boolean;
};

/**
 * ¿Se puede restaurar este respaldo en este núcleo y esta base?
 *
 * - `pg_restore` no lee volcados de un `pg_dump` más nuevo: bloquea.
 * - Núcleo de otra versión mayor, o más nuevo que el actual: las migraciones
 *   van hacia adelante; restaurar datos de un núcleo más nuevo en uno viejo
 *   deja columnas que este no conoce. Pide confirmación explícita.
 * - Otra base (otro cliente): pide confirmación explícita.
 */
export function check_compatibility(input: {
	manifest: Pick<
		BackupManifest,
		'core_version' | 'dump_tool_version' | 'database' | 'instance_id'
	>;
	current_database: string;
	current_instance_id?: string | null;
	pg_restore_version: string | null;
	core_version?: string;
}): Compatibility {
	const core = input.core_version ?? CORE_VERSION;
	const out: Compatibility = {
		blockers: [],
		warnings: [],
		needs_version_ack: false,
		needs_foreign_ack: false,
	};
	const dump_major = major_of(input.manifest.dump_tool_version);
	const restore_major = major_of(input.pg_restore_version);
	if (dump_major != null && restore_major != null && dump_major > restore_major) {
		out.blockers.push(
			`El respaldo se hizo con pg_dump ${dump_major} y este núcleo tiene pg_restore ${restore_major}: no lo puede leer.`,
		);
	}
	const backup_core = String(input.manifest.core_version ?? '').trim();
	if (!backup_core) {
		out.warnings.push(
			'El respaldo no dice con qué versión del núcleo se hizo (es anterior a 13.92).',
		);
	} else {
		const cmp = compare_versions(backup_core, core);
		if (major_of(backup_core) !== major_of(core)) {
			out.needs_version_ack = true;
			out.warnings.push(`El respaldo es del núcleo ${backup_core} y este es ${core} (otra versión mayor).`);
		} else if (cmp > 0) {
			out.needs_version_ack = true;
			out.warnings.push(
				`El respaldo es de un núcleo más nuevo (${backup_core}) que este (${core}); actualiza el núcleo antes si puedes.`,
			);
		} else if (cmp < 0) {
			out.warnings.push(
				`El respaldo es del núcleo ${backup_core}; este es ${core}. Al arrancar se aplican las migraciones que falten.`,
			);
		}
	}
	const backup_instance = String(input.manifest.instance_id ?? '').trim();
	const current_instance = String(input.current_instance_id ?? '').trim();
	if (backup_instance && current_instance) {
		if (backup_instance !== current_instance) {
			out.needs_foreign_ack = true;
			out.warnings.push(
				'El respaldo es de otra instalación de Imperium (otro cliente o una base reinstalada).',
			);
		}
		return out;
	}
	const source = String(input.manifest.database ?? '').trim();
	if (source && source !== input.current_database) {
		out.needs_foreign_ack = true;
		out.warnings.push(
			`El respaldo viene de la base «${source}» y esta es «${input.current_database}» (¿otro cliente?).`,
		);
	}
	if (!backup_instance && !source) {
		// Volcado suelto: no dice de dónde viene, así que se trata como ajeno.
		out.needs_foreign_ack = true;
	}
	if (!backup_instance) {
		out.warnings.push(
			'El respaldo no trae la identidad de la instalación: no se puede comprobar que sea de este cliente.',
		);
	}
	return out;
}
