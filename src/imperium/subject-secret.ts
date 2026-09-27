import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Secreto de gateway por app. El núcleo solo guarda el maestro y deriva el de
 * cada app; el host escribe los derivados en su `.env` con la misma fórmula
 * (imperium-sic-deploy/files/update-lib.sh). Cambiar la etiqueta invalida el
 * secreto de todas las apps de todos los servidores.
 */
export const SUBJECT_SECRET_LABEL = 'imperium-subject-gateway:v1:';

export function derive_subject_secret(master: string, technical_id: string): string {
	return createHmac('sha256', master)
		.update(SUBJECT_SECRET_LABEL + technical_id)
		.digest('hex');
}

/** Comparación en tiempo constante; un lado vacío nunca coincide. */
export function secret_equals(got: string, expected: string): boolean {
	if (!got || !expected) return false;
	const a = Buffer.from(got);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export type SubjectSecretMode = 'compat' | 'strict';

/** Maestro del núcleo; vacío = sin configurar y toda ruta con secreto se rechaza. */
export function master_secret(): string {
	return String(process.env.CORE_SUBJECT_GATEWAY_SECRET ?? '').trim();
}

/**
 * `strict`: las apps solo valen con su derivado y el núcleo firma hacia cada app
 * con el suyo. `compat` (por defecto, hosts sin migrar): las apps aún tienen el
 * maestro en su env, así que el núcleo lo sigue aceptando y firma con él.
 */
export function subject_secret_mode(): SubjectSecretMode {
	return String(process.env.CORE_SUBJECT_SECRET_MODE ?? '').trim().toLowerCase() === 'strict'
		? 'strict'
		: 'compat';
}

export function request_gateway_secret(req: Request): string {
	return (
		req.headers.get('x-core-subject-gateway-secret') ??
		req.headers.get('x-nox-kirlet-gateway-secret') ??
		''
	);
}

/** Herramientas del host y el propio núcleo: solo el maestro. */
export function is_master_request(req: Request): boolean {
	return secret_equals(request_gateway_secret(req), master_secret());
}

/** Cabeceras con las que una app o el host presentan el secreto. */
export const GATEWAY_SECRET_HEADERS = [
	'x-core-subject-gateway-secret',
	'x-nox-kirlet-gateway-secret',
] as const;

/**
 * Derivado de una app con el maestro vivo. Sin maestro no hay derivado: el
 * HMAC con clave vacía también da un hex, y cualquiera podría calcularlo.
 */
function subject_secret(technical_id: string): string {
	const master = master_secret();
	return master ? derive_subject_secret(master, technical_id) : '';
}

/** Una app en su plano de datos o de servicios: su derivado; el maestro solo en compat. */
export function is_subject_request(req: Request, technical_id: string): boolean {
	const got = request_gateway_secret(req);
	if (secret_equals(got, subject_secret(technical_id))) return true;
	return subject_secret_mode() === 'compat' && secret_equals(got, master_secret());
}

/**
 * Candado del plano de datos: 404 si el tid no está en el catálogo, 403 si el
 * secreto no es el de ese tid. `null` = pasa.
 */
export function authorize_subject_plane(
	req: Request,
	technical_id: string,
	known_technical_ids: ReadonlySet<string>,
): Response | null {
	if (!known_technical_ids.has(technical_id)) {
		return Response.json({ error: `unknown subject ${technical_id}` }, { status: 404 });
	}
	if (!is_subject_request(req, technical_id)) {
		return Response.json({ error: 'forbidden' }, { status: 403 });
	}
	return null;
}

/**
 * Clave con la que el núcleo firma la identidad hacia una app: la que esa app
 * tiene en su env. En strict es su derivado; en compat, el maestro. Vacía si
 * no hay maestro.
 */
export function signing_secret_for(technical_id: string): string {
	return subject_secret_mode() === 'strict' ? subject_secret(technical_id) : master_secret();
}

/** `POST /api/subjects/dev-attach` solo existe con `CORE_SUBJECT_DEV_ATTACH=1`. */
export function dev_attach_enabled(): boolean {
	return String(process.env.CORE_SUBJECT_DEV_ATTACH ?? '').trim() === '1';
}

/** Avisos de arranque sobre el secreto de gateway. */
export function gateway_secret_warnings(): string[] {
	if (!master_secret()) {
		return [
			'CORE_SUBJECT_GATEWAY_SECRET no está definido: se rechaza toda credencial de gateway (plano de datos y de servicios, db-admin, install-schemas, operador) y /api/m y /api/p/m responden 503. Las sesiones de usuario siguen valiendo donde ya valían.',
		];
	}
	const out: string[] = [];
	// Un valor mal escrito cae en compat sin avisar: el maestro seguiría abriendo todo.
	const raw_mode = String(process.env.CORE_SUBJECT_SECRET_MODE ?? '').trim().toLowerCase();
	if (raw_mode && raw_mode !== 'compat' && raw_mode !== 'strict') {
		out.push(`CORE_SUBJECT_SECRET_MODE="${raw_mode}" no se reconoce (compat|strict); se usa compat.`);
	}
	if (subject_secret_mode() === 'compat') {
		out.push(
			'CORE_SUBJECT_SECRET_MODE=compat: el maestro sigue valiendo para las apps y el núcleo firma con él. Pasar a strict cuando el host tenga los secretos derivados.',
		);
	}
	if (dev_attach_enabled()) {
		out.push('CORE_SUBJECT_DEV_ATTACH=1: dev-attach activo; no usar en producción.');
	}
	return out;
}
