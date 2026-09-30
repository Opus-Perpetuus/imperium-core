//   #region KIRLET RUNTIME AUTH

import {
  verify_kirlet_identity,
  kirlet_identity_can,
  type KirletIdentity,
} from "./identity.js";
import { error_response } from "./http.js";

export type AuthAction = "create" | "read" | "update" | "delete";

/**
 * Meta paths that never require a signed identity. `/seed` y `/pages` no lo
 * son: siembran y construyen con datos reales, así que piden identidad como
 * cualquier ruta (el núcleo firma una anónima en `/api/p/m`).
 */
export function is_meta_path(path: string): boolean {
  if (path === "/" || path === "") return true;
  if (path === "/health") return true;
  if (path === "/manifest") return true;
  if (path === "/schema") return true;
  if (path === "/menu") return true;
  return false;
}

export function method_to_action(method: string): AuthAction {
  switch (method.toUpperCase()) {
    case "POST":
      return "create";
    case "PATCH":
    case "PUT":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return "read";
  }
}

/**
 * Map HTTP method → permission action id used by automatic grants:
 * GET → read, POST|PATCH|PUT|DELETE → write (coarse).
 * Fine-grained CRUD still uses method_to_action for grant flags c/r/u/d.
 */
export function method_to_permission_suffix(method: string): "read" | "write" {
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD"
    ? "read"
    : "write";
}

export type ResolveIdentityOptions = {
  /** Kirlet technical id: the signed `kirlet_id` must match it (also used for the dev identity). */
  technical_id: string;
  /** Gateway HMAC secret. */
  gateway_secret: string;
  /** When true, non-meta paths get a synthetic admin identity. */
  auth_disabled: boolean;
  /** Optional warn logger (default console.warn once). */
  on_auth_off?: () => void;
};

let auth_off_warned = false;

function headers_to_record(
  req: Request,
): Record<string, string | null | undefined> {
  const out: Record<string, string | null | undefined> = {};
  req.headers.forEach((v, k) => {
    out[k] = v;
    out[k.toLowerCase()] = v;
  });
  return out;
}

/**
 * Firma válida *para esta app*: una identidad firmada para otra (que esa app
 * reenvía dentro de la ventana de tiempo) no cuenta.
 */
function verify_for_app(
  req: Request,
  secret: string,
  technical_id: string,
): { ok: true; identity: KirletIdentity } | { ok: false; error: string } {
  const verified = verify_kirlet_identity(headers_to_record(req), secret);
  if (!verified.ok) return verified;
  if (verified.identity.kirlet_id !== technical_id) {
    return { ok: false, error: "identity signed for another app" };
  }
  return verified;
}

function dev_identity(technical_id: string): KirletIdentity {
  return {
    user_id: "dev",
    email: "dev@local",
    is_admin: true,
    kirlet_id: technical_id,
    grants: [],
  };
}

/**
 * Resolve identity for a request.
 * Meta paths: optional identity (null ok).
 * Non-meta: requires valid signature unless auth_disabled.
 *
 * `verified` says the identity came from a signature, not from the dev
 * fallback. With `auth_disabled` the app still honours a signed identity when
 * the gateway sends one: a núcleo that signs gets real users and real grants
 * without every app having to flip `KIRLET_AUTH` in the same deploy. Only when
 * nothing is signed for this app does the synthetic admin take over — that is
 * what keeps an app runnable standalone.
 */
export function resolve_identity(
  req: Request,
  path: string,
  opts: ResolveIdentityOptions,
):
  | { ok: true; identity: KirletIdentity | null; verified: boolean }
  | { ok: false; response: Response } {
  const secret = opts.gateway_secret;

  if (is_meta_path(path)) {
    if (!secret) {
      return { ok: true, identity: null, verified: false };
    }
    const verified = verify_for_app(req, secret, opts.technical_id);
    return {
      ok: true,
      identity: verified.ok ? verified.identity : null,
      verified: verified.ok,
    };
  }

  if (opts.auth_disabled) {
    if (secret) {
      const signed = verify_for_app(req, secret, opts.technical_id);
      if (signed.ok) {
        return { ok: true, identity: signed.identity, verified: true };
      }
    }
    if (opts.on_auth_off) {
      opts.on_auth_off();
    } else if (!auth_off_warned) {
      console.warn(
        `[${opts.technical_id}] KIRLET_AUTH=off — identity signature checks disabled (standalone dev)`,
      );
      auth_off_warned = true;
    }
    return {
      ok: true,
      identity: dev_identity(opts.technical_id),
      verified: false,
    };
  }

  if (!secret) {
    return {
      ok: false,
      response: error_response(
        "auth_misconfigured",
        "NOX_KIRLET_GATEWAY_SECRET is required when KIRLET_AUTH is on",
        500,
      ),
    };
  }

  const verified = verify_for_app(req, secret, opts.technical_id);
  if (!verified.ok) {
    return {
      ok: false,
      response: error_response("unauthorized", verified.error, 401),
    };
  }
  return { ok: true, identity: verified.identity, verified: true };
}

/**
 * Require grant on `kirlet.<slug>.<module>` for action.
 * Returns Response on failure, null when allowed.
 */
export function require_access(
  identity: KirletIdentity | null,
  slug: string,
  module: string,
  action: AuthAction,
  opts?: { auth_disabled?: boolean },
): Response | null {
  if (opts?.auth_disabled) return null;
  if (!identity) {
    return error_response("unauthorized", "missing identity", 401);
  }
  const resource = `kirlet.${slug}.${module}`;
  if (!kirlet_identity_can(identity, resource, action)) {
    return error_response(
      "forbidden",
      `missing grant ${resource} ${action}`,
      403,
    );
  }
  return null;
}

/**
 * Any read grant under kirlet.<slug>.* (or admin) may list history.
 */
export function can_read_history(
  identity: KirletIdentity | null,
  slug: string,
  opts?: { auth_disabled?: boolean },
): boolean {
  if (opts?.auth_disabled) return true;
  if (!identity) return false;
  if (identity.is_admin) return true;
  const prefix = `kirlet.${slug}.`;
  return identity.grants.some(
    (g) =>
      g.r === true &&
      (g.resource === `kirlet.${slug}.*` || g.resource.startsWith(prefix)),
  );
}

export function actor_from(identity: KirletIdentity | null): string | null {
  return identity?.email ?? null;
}

/** Reset one-shot auth-off warning (tests). */
export function _reset_auth_off_warned_for_tests(): void {
  auth_off_warned = false;
}

//   #endregion KIRLET RUNTIME AUTH
