/**
 * Identidad firmada del núcleo hacia las apps.
 *
 * Hasta ahora `proxy_subject` reenviaba la petición con el secreto de gateway y
 * nada más: la app nunca supo quién preguntaba, así que corría con
 * `SUBJECT_AUTH=off` y el kit le entregaba un admin sintético (`user_id: "dev"`).
 * Todo lo que una app indexa por usuario — carritos, favoritos, pedidos — caía
 * en el mismo cajón para todo el personal.
 *
 * Aquí se resuelve la sesión Imperium y se firma una identidad v2 (kit) por
 * salto. Los grants salen del mismo ACL que decide qué pinta el lanzador: si al
 * usuario no se le asignó el menú del módulo, tampoco tiene el grant.
 */
import {
	ANONYMOUS_USER_ID,
	sign_kirlet_identity_v2,
	type KirletGrant,
	type KirletIdentity,
	type KirletPrincipalType,
} from '@opus-perpetuus/imperium-core-kit';
import { build_access, build_menus, current_user } from './auth.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { GATEWAY_SECRET_HEADERS, signing_secret_for } from './subject-secret.ts';

export type SubjectModuleRef = {
	resource: string;
	menu_ref?: string;
	/** Solo lectura: un menú declarado que consulta un recurso sin administrarlo. */
	read_only?: boolean;
};

/**
 * Qué menú habilita qué recurso de la app. Los `modules` del catálogo traen el
 * suyo; un menú declarado (`menus[]`) lo dice con `resources` — así una pantalla
 * de la app cuya tabla no está en el catálogo (tipos de incidencia, exámenes…)
 * también se puede asignar a un grupo. `recurso:read` da solo lectura.
 */
export function subject_grant_refs(sub: {
	modules: SubjectModuleRef[];
	menus?: Array<{ menu_ref: string; resources?: string[] }>;
}): SubjectModuleRef[] {
	const refs: SubjectModuleRef[] = [...sub.modules];
	for (const menu of sub.menus ?? []) {
		for (const raw of menu.resources ?? []) {
			const [resource, mode] = String(raw).split(':');
			if (!resource) continue;
			refs.push({ resource, menu_ref: menu.menu_ref, read_only: mode === 'read' });
		}
	}
	return refs;
}

export type SubjectIdentityRealm = 'internal' | 'public';

/** Cabeceras de identidad que el núcleo impone; nunca las del cliente. */
export const SUBJECT_IDENTITY_HEADERS = [
	'x-nox-user-id',
	'x-nox-user-email',
	'x-nox-is-admin',
	'x-nox-user-grants',
	'x-nox-identity-ts',
	'x-nox-identity-sig',
	'x-nox-identity-v',
	'x-nox-user-type',
	'x-nox-realm',
] as const;

/**
 * Grants de una app a partir de los menús que el lanzador le pinta al usuario.
 *
 * `visible_menu_refs` son los `_ref` de los menús que ese usuario ve de verdad,
 * ya materializados y filtrados por el ACL. La fuente importa: los menús de una
 * app **no existen como filas** — `reshape_subject_menus` los crea en memoria a
 * partir del catálogo con ids sintéticos, así que buscarlos en la base por `_ref`
 * no encuentra ninguno y dejaría sin un solo grant a todo el que no sea admin.
 *
 * Tomarlos de la misma materialización que pinta el lanzador hace imposible que
 * las dos respuestas se separen: lo que se ve es lo que se puede llamar. Admin
 * efectivo no lleva grants — `is_admin` abre todo en el kit.
 *
 * `dependent_read` (ver `sees_dependent_of`) da además lectura sobre todos los
 * recursos: una app que depende de esta la consulta desde el navegador.
 */
export function subject_grants_from_menus(input: {
	slug: string;
	modules: SubjectModuleRef[];
	has_full_access: boolean;
	visible_menu_refs: string[];
	dependent_read?: boolean;
}): KirletGrant[] {
	if (input.has_full_access) return [];
	const visible = new Set(input.visible_menu_refs.map(String).filter(Boolean));
	const grants = new Map<string, KirletGrant>();
	for (const mod of input.modules) {
		const ref = String(mod.menu_ref ?? '');
		const own = !!ref && visible.has(ref);
		if (!own && !input.dependent_read) continue;
		const resource = `kirlet.${input.slug}.${mod.resource}`;
		const write = own && !mod.read_only;
		// Varios menús pueden dar el mismo recurso: gana el permiso más amplio.
		const prev = grants.get(resource);
		grants.set(resource, {
			resource,
			c: write || prev?.c === true,
			r: true,
			u: write || prev?.u === true,
			d: write || prev?.d === true,
		});
	}
	return [...grants.values()];
}

/**
 * True si el usuario ve algún menú de una app que declara `depends_on` hacia
 * `technical_id`. Cada menú visible de una app conserva su raíz, marcada con
 * `subject_slug`, y `build_menus` ya quitó las apps desinstaladas.
 */
export function sees_dependent_of(input: {
	technical_id: string;
	subjects: ReadonlyArray<{ slug: string; technical_id: string; depends_on?: string[] }>;
	visible_menus: ReadonlyArray<{ subject_slug?: unknown }>;
}): boolean {
	const visible = new Set(
		input.visible_menus.map((row) => String(row.subject_slug ?? '')).filter(Boolean),
	);
	return input.subjects.some(
		(sub) =>
			sub.technical_id !== input.technical_id &&
			(sub.depends_on ?? []).includes(input.technical_id) &&
			visible.has(sub.slug),
	);
}

/**
 * Identidad de un visitante sin sesión.
 *
 * El kit exige el centinela `anonymous` en `user_id` y `email` para un
 * principal anónimo: firmando cadenas vacías la verificación fallaba y la app
 * se quedaba **sin identidad**, así que no veía el realm y construía sus
 * enlaces como si la hubiera pintado el lanzador interno — un cliente del
 * escaparate acababa mandado a `/internal`.
 */
export function anonymous_subject_identity(
	technical_id: string,
	realm: SubjectIdentityRealm,
): KirletIdentity {
	return {
		user_id: ANONYMOUS_USER_ID,
		email: ANONYMOUS_USER_ID,
		is_admin: false,
		kirlet_id: technical_id,
		grants: [],
		user_type: 'anonymous',
		realm,
	};
}

/**
 * Identidad de servicio con la que una app llama a otra por el gateway.
 *
 * No hay usuario: el principal es la app remitente (`subject:<caller>`), con un
 * grant por recurso del destino —los `:read` de sus menús se respetan— y sin
 * `is_admin`, así que `/seed` sigue cerrado en el kit.
 */
export function service_subject_identity(input: {
	caller: string;
	target: {
		technical_id: string;
		slug: string;
		modules?: SubjectModuleRef[];
		menus?: Array<{ menu_ref: string; resources?: string[] }>;
	};
}): KirletIdentity {
	const grants = new Map<string, KirletGrant>();
	const refs = subject_grant_refs({
		modules: input.target.modules ?? [],
		menus: input.target.menus,
	});
	for (const ref of refs) {
		const resource = `kirlet.${input.target.slug}.${ref.resource}`;
		const write = !ref.read_only || grants.get(resource)?.c === true;
		grants.set(resource, { resource, c: write, r: true, u: write, d: write });
	}
	return {
		user_id: `subject:${input.caller}`,
		email: input.caller,
		is_admin: false,
		kirlet_id: input.target.technical_id,
		grants: [...grants.values()],
		user_type: 'internal',
		realm: 'internal',
	};
}

/** Tipo de principal de una sesión Imperium, en el vocabulario del kit. */
export function principal_type_of(user: ImperiumDoc | null): KirletPrincipalType {
	if (!user) return 'anonymous';
	return String(user.type ?? '') === 'external' ? 'external' : 'internal';
}

type CacheEntry = { at: number; grants: KirletGrant[]; is_admin: boolean };

const GRANTS_TTL_MS = 15_000;
const grants_cache = new Map<string, CacheEntry>();

/** Vaciar la memoria de grants (tests, o tras cambiar grupos). */
export function reset_subject_identity_cache(): void {
	grants_cache.clear();
}

async function grants_for_user(
	store: ImperiumStore,
	sql: Bun.SQL,
	user: ImperiumDoc,
	subject: { technical_id: string; slug: string; modules: SubjectModuleRef[] },
): Promise<{ grants: KirletGrant[]; is_admin: boolean }> {
	const access = await build_access(store, user);
	if (access.has_full_access === true) return { grants: [], is_admin: true };
	const menus = await build_menus(store, sql, access);
	return {
		grants: subject_grants_from_menus({
			slug: subject.slug,
			modules: subject.modules,
			has_full_access: false,
			visible_menu_refs: menus.map((row) => String(row._ref ?? '')),
			dependent_read: sees_dependent_of({
				technical_id: subject.technical_id,
				subjects: store.subjects,
				visible_menus: menus,
			}),
		}),
		is_admin: false,
	};
}

/**
 * Identidad firmada para un salto núcleo → app.
 *
 * `authenticated` distingue "no hay sesión" de "hay sesión": el gateway interno
 * lo usa para cortar con 401 y el público para dejar pasar como anónimo.
 */
export async function resolve_subject_identity(input: {
	store: ImperiumStore;
	sql: Bun.SQL;
	req: Request;
	technical_id: string;
	slug: string;
	modules: SubjectModuleRef[];
	realm: SubjectIdentityRealm;
	session_key: string;
}): Promise<{
	identity: KirletIdentity;
	user: ImperiumDoc | null;
	authenticated: boolean;
}> {
	const user = await current_user(input.sql, input.req).catch(() => null);
	const user_type = principal_type_of(user);
	if (!user) {
		return {
			identity: anonymous_subject_identity(
				input.technical_id,
				input.realm,
			),
			user: null,
			authenticated: false,
		};
	}

	// Un externo (cliente de tienda) no tiene grupos ni menús del lanzador: su
	// permiso es el que la app declare como `public_access`, no un grant.
	let grants: KirletGrant[] = [];
	let is_admin = false;
	if (user_type === 'internal') {
		const key = `${input.session_key}::${input.technical_id}`;
		const hit = grants_cache.get(key);
		if (hit && Date.now() - hit.at < GRANTS_TTL_MS) {
			grants = hit.grants;
			is_admin = hit.is_admin;
		} else {
			const built = await grants_for_user(input.store, input.sql, user, {
				technical_id: input.technical_id,
				slug: input.slug,
				modules: input.modules,
			});
			grants = built.grants;
			is_admin = built.is_admin;
			grants_cache.set(key, { at: Date.now(), grants, is_admin });
		}
	}

	return {
		identity: {
			user_id: String(user._id ?? ''),
			email: String(user.email ?? ''),
			is_admin,
			kirlet_id: input.technical_id,
			grants,
			user_type,
			realm: input.realm,
		},
		user,
		authenticated: true,
	};
}

/**
 * Cabeceras de identidad sobre las del cliente.
 *
 * `proxy_subject` clona las cabeceras de la petición original, así que sin
 * borrar primero un cliente podría mandar `x-nox-is-admin: true` y colarse por
 * una ruta donde el núcleo no firmara. Se borran siempre y se firma siempre.
 */
export function apply_subject_identity_headers(
	headers: Headers,
	identity: KirletIdentity,
	secret: string,
): void {
	for (const name of SUBJECT_IDENTITY_HEADERS) headers.delete(name);
	if (!secret) return;
	const signed = sign_kirlet_identity_v2(identity, secret);
	for (const [k, v] of Object.entries(signed)) headers.set(k, v);
}

/** Cookie de sesión del núcleo (`auth.ts`). */
const CORE_SESSION_COOKIE = 'connect.sid';
/** El token MCP del núcleo viaja en cualquiera de las dos (`mcp-agent.ts`). */
const CORE_TOKEN_HEADERS = ['authorization', 'x-imperium-sic-token'] as const;

/**
 * Cabeceras con las que `proxy_subject` llama a una app: las del cliente sin
 * secretos de gateway (ninguna app los lee, y reenviar el maestro se lo daba a
 * todas) ni credenciales del usuario ante el núcleo (su cookie de sesión y su
 * token: una app hostil las reusaría contra `/api/*`), el tid destino y la
 * identidad firmada con la clave de esa app. Las demás cookies pasan.
 */
/**
 * Respuesta de una app hacia el navegador sin los Set-Cookie de la sesión del
 * núcleo: la app no debe poder fijar ni borrar la sesión en el origen del
 * núcleo. Sin cookie de sesión se devuelve tal cual (fetch ya decodificó el
 * cuerpo y rehacerla sin motivo arriesga el content-encoding).
 */
export function subject_proxy_response(res: Response): Response {
	const cookies = res.headers.getSetCookie();
	const keep = cookies.filter((c) => c.split('=')[0]!.trim() !== CORE_SESSION_COOKIE);
	if (keep.length === cookies.length) return res;
	const headers = new Headers(res.headers);
	headers.delete('set-cookie');
	headers.delete('content-encoding');
	headers.delete('content-length');
	for (const c of keep) headers.append('set-cookie', c);
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function subject_proxy_headers(
	client_headers: HeadersInit,
	technical_id: string,
	identity: KirletIdentity,
): Headers {
	const headers = new Headers(client_headers);
	for (const name of GATEWAY_SECRET_HEADERS) headers.delete(name);
	for (const name of CORE_TOKEN_HEADERS) headers.delete(name);
	const cookie = (headers.get('cookie') ?? '')
		.split(';')
		.map((pair) => pair.trim())
		.filter((pair) => pair && pair.split('=')[0]!.trim() !== CORE_SESSION_COOKIE)
		.join('; ');
	if (cookie) headers.set('cookie', cookie);
	else headers.delete('cookie');
	headers.set('x-nox-kirlet-id', technical_id);
	apply_subject_identity_headers(headers, identity, signing_secret_for(technical_id));
	return headers;
}
