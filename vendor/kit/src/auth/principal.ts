// (o==================================================================o)
//   #region PRINCIPAL TYPE (staff vs public)
// (o-----------------------------------------------------------\/-----o)

/** Same copy staff login uses for unknown users — never leak “wrong type”. */
export const GENERIC_CREDENTIALS_MESSAGE =
  "Usuario o contraseña incorrectos";

export type PrincipalKind = "internal" | "external";
export type AuthSurface = "staff" | "public";

export type PrincipalUser = {
  type?: unknown;
  is_active?: unknown;
  is_admin?: unknown;
};

export type SurfaceAuthResult =
  | { ok: true; kind: PrincipalKind; destination: string }
  | { ok: false; message: string };

/** Product staff shell. Not kit `NOX_REALM_PATH.internal` (`i`). */
export const INTERNAL_HOME_PATH = "/internal";
/** Public layout after a public-user session starts. */
export const PUBLIC_LOGIN_DESTINATION = "/";
/** Public session-start route (distinct from staff `/login`). */
export const PUBLIC_SESSION_START_PATH = "cuenta/entrar";

/**
 * Absent type on a legacy user is staff.
 */
export function principal_kind(
  user: PrincipalUser | null | undefined,
): PrincipalKind {
  if (!user) return "internal";
  return user.type === "external" ? "external" : "internal";
}

export function can_enter_internal(
  user: PrincipalUser | null | undefined,
): boolean {
  if (!user) return false;
  return principal_kind(user) !== "external";
}

export function session_home_path(
  user: PrincipalUser | null | undefined,
): string {
  return can_enter_internal(user) ? INTERNAL_HOME_PATH : PUBLIC_LOGIN_DESTINATION;
}

/**
 * Staff vs public login. Password check is the caller's; this only
 * discriminates principal type with the generic credentials message.
 */
export function authenticate_for_surface(
  surface: AuthSurface,
  user: PrincipalUser | null | undefined,
  password_ok: boolean,
): SurfaceAuthResult {
  if (!password_ok || !user || user.is_active === false) {
    return { ok: false, message: GENERIC_CREDENTIALS_MESSAGE };
  }
  const kind = principal_kind(user);
  if (surface === "staff") {
    if (kind === "external") {
      return { ok: false, message: GENERIC_CREDENTIALS_MESSAGE };
    }
    return { ok: true, kind: "internal", destination: INTERNAL_HOME_PATH };
  }
  if (kind !== "external") {
    return { ok: false, message: GENERIC_CREDENTIALS_MESSAGE };
  }
  return {
    ok: true,
    kind: "external",
    destination: PUBLIC_LOGIN_DESTINATION,
  };
}

/**
 * Creating a public user forces `type: external` and not-admin.
 * Other users are left unchanged.
 */
export function apply_public_user_create<T extends Record<string, unknown>>(
  doc: T,
): T {
  if (doc["type"] !== "external") return doc;
  return { ...doc, type: "external", is_admin: false };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion PRINCIPAL TYPE
// (o==================================================================o)
