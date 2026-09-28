/**
 * Llamada app → app por el gateway interno (`/api/m/<target>/…`).
 *
 * Una app se presenta con su technical id en `x-imperium-subject` y con su
 * secreto de gateway; el núcleo no le pide sesión y le firma hacia el destino
 * una identidad de servicio. Aquí solo va el candado, sin Postgres, para poder
 * probarlo: quién puede llamar y con qué respuesta se le corta.
 */
import { SUBJECT_CALLER_HEADER } from '@opus-perpetuus/imperium-core-kit';
import type { SubjectIdentityRealm } from './subject-identity.ts';

/**
 * Plazo del salto núcleo → destino en una llamada app → app. Mayor que el de
 * una petición del navegador y que el `CALL_SUBJECT_TIMEOUT_MS` del kit, para
 * que el plazo que manda sea el del remitente.
 */
export const SUBJECT_CALL_PROXY_TIMEOUT_MS = 15_000;

export type SubjectCallerDeps = {
	/** Sin maestro no hay secretos que comprobar: 503 como `proxy_subject`. */
	master_configured: () => boolean;
	catalog_tids: ReadonlySet<string>;
	is_subject_request: (req: Request, technical_id: string) => boolean;
	installed: (technical_id: string) => Promise<boolean>;
};

function refuse(status: number, code: string, message: string): Response {
	return Response.json({ error: message, message, code }, { status });
}

/**
 * `null` si la petición no trae remitente (una sesión de usuario normal). En el
 * realm público la ruta no existe: 404 sin más pistas. Sin maestro configurado,
 * 503 (un fallo de configuración, no de credenciales). El remitente tiene que
 * estar en el catálogo —en compat el maestro vale para cualquier tid— y
 * presentar su propio secreto, no ser el destino y estar instalado.
 */
export async function resolve_subject_caller(
	req: Request,
	target: string,
	realm: SubjectIdentityRealm,
	deps: SubjectCallerDeps,
): Promise<null | { ok: true; caller: string } | { ok: false; response: Response }> {
	const caller = req.headers.get(SUBJECT_CALLER_HEADER)?.trim() ?? '';
	if (!caller) return null;
	if (realm === 'public') {
		return { ok: false, response: refuse(404, 'not_found', 'not found') };
	}
	if (!deps.master_configured()) {
		return {
			ok: false,
			response: refuse(
				503,
				'gateway_secret_missing',
				'El secreto de gateway del núcleo no está configurado',
			),
		};
	}
	if (!deps.catalog_tids.has(caller) || !deps.is_subject_request(req, caller)) {
		return { ok: false, response: refuse(403, 'forbidden', 'Prohibido') };
	}
	if (caller === target) {
		return {
			ok: false,
			response: refuse(400, 'self_call', 'Una app no puede llamarse a sí misma por el gateway'),
		};
	}
	if (!(await deps.installed(caller))) {
		return {
			ok: false,
			response: refuse(403, 'caller_not_installed', `${caller} no está instalada`),
		};
	}
	return { ok: true, caller };
}
