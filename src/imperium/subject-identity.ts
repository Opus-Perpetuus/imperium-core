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

export type SubjectModuleRef = { resource: string; menu_ref?: string };

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
 */
export function subject_grants_from_menus(input: {
	slug: string;
	modules: SubjectModuleRef[];
	has_full_access: boolean;
	visible_menu_refs: string[];
}): KirletGrant[] {
	if (input.has_full_access) return [];
	const visible = new Set(input.visible_menu_refs.map(String).filter(Boolean));
	const grants: KirletGrant[] = [];
	for (const mod of input.modules) {
		const ref = String(mod.menu_ref ?? '');
		if (!ref || !visible.has(ref)) continue;
		grants.push({
			resource: `kirlet.${input.slug}.${mod.resource}`,
			c: true,
			r: true,
			u: true,
			d: true,
		});
	}
	return grants;
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
	subject: { slug: string; modules: SubjectModuleRef[] },
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
