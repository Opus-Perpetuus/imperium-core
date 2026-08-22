// (o==================================================================o)
//   #region KIRLET IDENTITY TYPES (browser-safe)
// (o-----------------------------------------------------------\/-----o)

/**
 * Pure types + grant check — no Node crypto.
 * Safe to import from browser / Angular UI graph.
 */

export type KirletGrant = {
  resource: string;
  c: boolean;
  r: boolean;
  u: boolean;
  d: boolean;
};

/** Principal for gateway → kirlet hop. Absent fields default to internal v1. */
export type KirletPrincipalType = "internal" | "external" | "anonymous";

export type KirletIdentity = {
  user_id: string;
  email: string;
  is_admin: boolean;
  kirlet_id: string;
  grants: KirletGrant[];
  /** Absent ⇒ "internal" (v1 path). */
  user_type?: KirletPrincipalType;
  /** Absent ⇒ "internal" (v1 path). */
  realm?: "internal" | "public";
};

export const ANONYMOUS_USER_ID = "anonymous";

/**
 * Check whether identity may perform action on resource.
 * Admins always pass. Grants match exact resource.
 */
export function kirlet_identity_can(
  identity: KirletIdentity,
  resource: string,
  action: "create" | "read" | "update" | "delete",
): boolean {
  if (identity.is_admin) return true;
  const grant = identity.grants.find((g) => g.resource === resource);
  if (!grant) return false;
  switch (action) {
    case "create":
      return grant.c;
    case "read":
      return grant.r;
    case "update":
      return grant.u;
    case "delete":
      return grant.d;
    default:
      return false;
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET IDENTITY TYPES (browser-safe)
// (o==================================================================o)
