/**
 * Superadministrador de la semilla (`user-menu-management-0`).
 *
 * Una base v13 nueva no trae ningún usuario: la fila solo llegaba migrando
 * desde Mongo, así que un tenant instalado de cero no tenía con quién entrar.
 * Sembrar lo crea si falta y, si existe, le restablece correo, contraseña e
 * imagen (el logo de Codice Progressio) a los de la semilla.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { print_console_log } from './debug-request-log.ts';
import { SEED_ADMIN_REF } from './group-access.ts';
import type { ImperiumStore } from './store.ts';

export const SUPERADMIN_EMAIL = 'admin@admin.com';
/** La misma de la semilla de v12 (`backend/src/components/user/module.data.ts`). */
const SUPERADMIN_PASSWORD_HASH =
	'$argon2id$v=19$m=65536,t=3,p=1$xEdCf/oCqtu2nWgIhgKsBA$j85XcijYv/AI1y7yv0ezshARZMjODd7X8bZOVSCXrm0';
export const CODICE_LOGO_REF = 'attachment-management-codice-progressio-logo';
const CODICE_LOGO_PATH = join(import.meta.dir, 'assets', 'codice-progressio-logo.png');

/**
 * `img` de un usuario es el id de un adjunto. Los bytes van en el propio
 * registro (`/api/media` los sirve desde `base64`): no dependen de que el
 * volumen de uploads exista o se pueda escribir.
 */
async function ensure_codice_logo(store: ImperiumStore): Promise<string> {
	const existing = await store.find_where('attachment-management', {
		_ref: CODICE_LOGO_REF,
	});
	if (existing?._id) return String(existing._id);
	const bytes = readFileSync(CODICE_LOGO_PATH);
	const created = await store.insert('attachment-management', {
		_ref: CODICE_LOGO_REF,
		name: 'Codice Progressio',
		name_stored: 'codice-progressio-logo.png',
		description: 'Logo del superadministrador',
		mimetype: 'image/png',
		file_ext: 'png',
		size_in_kb: String(Math.ceil(bytes.length / 1024)),
		related_model: 'User',
		field: 'img',
		base64: bytes.toString('base64'),
	});
	return String(created._id);
}

/** Devuelve cuántos documentos creó (0 si solo restableció). */
export async function seed_superadmin(store: ImperiumStore): Promise<number> {
	if (!store.has('user') || !store.has('attachment-management')) return 0;
	const had_logo = Boolean(
		await store.find_where('attachment-management', { _ref: CODICE_LOGO_REF }),
	);
	// Sin logo el superadministrador se crea igual: una instalación nueva sin
	// él se queda sin nadie con quien entrar.
	let img = '';
	try {
		img = await ensure_codice_logo(store);
	} catch (err) {
		print_console_log(
			'warning',
			`No se pudo sembrar el logo del superadministrador: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const reset = {
		email: SUPERADMIN_EMAIL,
		password: SUPERADMIN_PASSWORD_HASH,
		img,
		is_active: true,
	};
	const current = await store.find_where('user', { _ref: SEED_ADMIN_REF });
	if (current?._id) {
		await store.update('user', String(current._id), reset);
		return had_logo || !img ? 0 : 1;
	}
	await store.insert('user', {
		_ref: SEED_ADMIN_REF,
		name: 'admin',
		enabled_dashboard_components: [],
		...reset,
	});
	return had_logo || !img ? 1 : 2;
}

/**
 * `SELECT 1` y no `find_where`: se consulta justo después de crear las tablas
 * y antes de que `ensure_defaults` les añada las columnas del catálogo. Un
 * `SELECT *` preparado aquí quedaba muerto tras ese DDL («cached plan must
 * not change result type») y tumbaba la siembra.
 */
export async function superadmin_exists(
	store: ImperiumStore,
	sql: Bun.SQL,
): Promise<boolean> {
	if (!store.has('user')) return false;
	const rows = await sql.unsafe(
		`SELECT 1 FROM ${store.qt('user')} WHERE ref = $1 LIMIT 1`,
		[SEED_ADMIN_REF],
	);
	return rows.length > 0;
}
