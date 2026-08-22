// (o==================================================================o)
//   #region KIRLET IDENTITY (Node — HMAC)
// (o-----------------------------------------------------------\/-----o)

/**
 * Node-only HMAC identity for the gateway → kirlet hop.
 * Do NOT import this module from browser / Angular UI graphs.
 * Import from `@opus-perpetuus/kirel-nox-kit/identity` or
 * re-exported kit main (Node packages only).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { KirletGrant, KirletIdentity } from "./identity.types.js";
import { ANONYMOUS_USER_ID } from "./identity.types.js";

export type { KirletGrant, KirletIdentity, KirletPrincipalType } from "./identity.types.js";
export { kirlet_identity_can, ANONYMOUS_USER_ID } from "./identity.types.js";

const DEFAULT_MAX_SKEW_S = 300;

function b64url_encode(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64url_decode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

function now_seconds(now_s?: number): number {
  return now_s ?? Math.floor(Date.now() / 1000);
}

function hmac_hex(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

function safe_equal_hex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * v1 canonical — BYTE-IDENTICAL to historic implementation.
 * Do not add fields here.
 */
function build_canonical(
  ts: number,
  identity: Pick<
    KirletIdentity,
    "user_id" | "email" | "is_admin" | "kirlet_id"
  >,
  grants_b64url: string,
): string {
  return [
    "v1",
    String(ts),
    identity.user_id,
    identity.email,
    identity.is_admin ? "true" : "false",
    identity.kirlet_id,
    grants_b64url,
  ].join("\n");
}

/** v2 canonical for public realm (user_type + realm). */
function build_canonical_v2(
  ts: number,
  identity: Pick<
    KirletIdentity,
    "user_id" | "email" | "is_admin" | "kirlet_id" | "user_type" | "realm"
  >,
  grants_b64url: string,
): string {
  const user_type = identity.user_type ?? "internal";
  const realm = identity.realm ?? "internal";
  return [
    "v2",
    String(ts),
    identity.user_id,
    identity.email,
    identity.is_admin ? "true" : "false",
    user_type,
    realm,
    identity.kirlet_id,
    grants_b64url,
  ].join("\n");
}

/**
 * Sign identity for the gateway → kirlet hop (v1).
 * Returns headers to attach to the upstream request.
 */
export function sign_kirlet_identity(
  identity: KirletIdentity,
  secret: string,
  now_s?: number,
): Record<string, string> {
  if (!secret) throw new Error("sign_kirlet_identity: secret is required");
  const ts = now_seconds(now_s);
  const grants_b64url = b64url_encode(JSON.stringify(identity.grants ?? []));
  const canonical = build_canonical(ts, identity, grants_b64url);
  const sig = hmac_hex(secret, canonical);
  return {
    "x-nox-user-id": identity.user_id,
    "x-nox-user-email": identity.email,
    "x-nox-is-admin": identity.is_admin ? "true" : "false",
    "x-nox-kirlet-id": identity.kirlet_id,
    "x-nox-user-grants": grants_b64url,
    "x-nox-identity-ts": String(ts),
    "x-nox-identity-sig": sig,
  };
}

/**
 * Sign identity v2 for the public gateway (adds user_type + realm headers).
 */
export function sign_kirlet_identity_v2(
  identity: KirletIdentity,
  secret: string,
  now_s?: number,
): Record<string, string> {
  if (!secret) throw new Error("sign_kirlet_identity_v2: secret is required");
  const ts = now_seconds(now_s);
  const grants_b64url = b64url_encode(JSON.stringify(identity.grants ?? []));
  const user_type = identity.user_type ?? "internal";
  const realm = identity.realm ?? "public";
  const canonical = build_canonical_v2(
    ts,
    { ...identity, user_type, realm },
    grants_b64url,
  );
  const sig = hmac_hex(secret, canonical);
  return {
    "x-nox-user-id": identity.user_id,
    "x-nox-user-email": identity.email,
    "x-nox-is-admin": identity.is_admin ? "true" : "false",
    "x-nox-kirlet-id": identity.kirlet_id,
    "x-nox-user-grants": grants_b64url,
    "x-nox-identity-ts": String(ts),
    "x-nox-identity-sig": sig,
    "x-nox-identity-v": "2",
    "x-nox-user-type": user_type,
    "x-nox-realm": realm,
  };
}

function parse_grants(
  grants_b64url: string,
): { ok: true; grants: KirletGrant[] } | { ok: false; error: string } {
  let grants: KirletGrant[] = [];
  if (grants_b64url) {
    try {
      const parsed: unknown = JSON.parse(b64url_decode(grants_b64url));
      if (!Array.isArray(parsed)) {
        return { ok: false, error: "grants must be a JSON array" };
      }
      grants = parsed.map((raw: unknown) => {
        const g =
          raw && typeof raw === "object"
            ? (raw as Record<string, unknown>)
            : {};
        return {
          resource: String(g["resource"] ?? ""),
          c: Boolean(g["c"]),
          r: Boolean(g["r"]),
          u: Boolean(g["u"]),
          d: Boolean(g["d"]),
        };
      });
    } catch {
      return { ok: false, error: "invalid grants encoding" };
    }
  }
  return { ok: true, grants };
}

/**
 * Verify signed identity headers from the nox gateway.
 * Reads x-nox-identity-v: "2" → v2 path; otherwise exact v1 path.
 */
export function verify_kirlet_identity(
  headers: Record<string, string | null | undefined>,
  secret: string,
  opts?: { now_s?: number; max_skew_s?: number },
): { ok: true; identity: KirletIdentity } | { ok: false; error: string } {
  if (!secret) return { ok: false, error: "secret is required" };

  const get = (k: string): string => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return v == null ? "" : String(v);
  };

  const version = get("x-nox-identity-v");
  if (version === "2") {
    return verify_v2(get, secret, opts);
  }
  return verify_v1(get, secret, opts);
}

function verify_v1(
  get: (k: string) => string,
  secret: string,
  opts?: { now_s?: number; max_skew_s?: number },
): { ok: true; identity: KirletIdentity } | { ok: false; error: string } {
  const user_id = get("x-nox-user-id");
  const email = get("x-nox-user-email");
  const is_admin_raw = get("x-nox-is-admin");
  const kirlet_id = get("x-nox-kirlet-id");
  const grants_b64url = get("x-nox-user-grants");
  const ts_raw = get("x-nox-identity-ts");
  const sig = get("x-nox-identity-sig");

  if (!user_id || !email || !kirlet_id || !ts_raw || !sig) {
    return { ok: false, error: "missing identity headers" };
  }

  const ts = Number(ts_raw);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "invalid identity timestamp" };
  }

  const max_skew = opts?.max_skew_s ?? DEFAULT_MAX_SKEW_S;
  const now = now_seconds(opts?.now_s);
  if (Math.abs(now - ts) > max_skew) {
    return { ok: false, error: "identity timestamp outside allowed skew" };
  }

  const is_admin = is_admin_raw === "true" || is_admin_raw === "1";
  const canonical = build_canonical(
    ts,
    { user_id, email, is_admin, kirlet_id },
    grants_b64url || b64url_encode("[]"),
  );
  const expected = hmac_hex(secret, canonical);
  if (!safe_equal_hex(expected, sig)) {
    return { ok: false, error: "invalid identity signature" };
  }

  const parsed = parse_grants(grants_b64url);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    identity: {
      user_id,
      email,
      is_admin,
      kirlet_id,
      grants: parsed.grants,
      user_type: "internal",
      realm: "internal",
    },
  };
}

function verify_v2(
  get: (k: string) => string,
  secret: string,
  opts?: { now_s?: number; max_skew_s?: number },
): { ok: true; identity: KirletIdentity } | { ok: false; error: string } {
  const user_id = get("x-nox-user-id");
  const email = get("x-nox-user-email");
  const is_admin_raw = get("x-nox-is-admin");
  const kirlet_id = get("x-nox-kirlet-id");
  const grants_b64url = get("x-nox-user-grants");
  const ts_raw = get("x-nox-identity-ts");
  const sig = get("x-nox-identity-sig");
  const user_type = get("x-nox-user-type");
  const realm = get("x-nox-realm");

  if (!user_id || !email || !kirlet_id || !ts_raw || !sig) {
    return { ok: false, error: "missing identity headers" };
  }
  if (!user_type || !realm) {
    return { ok: false, error: "missing v2 identity headers (user_type/realm)" };
  }
  if (
    user_type !== "internal" &&
    user_type !== "external" &&
    user_type !== "anonymous"
  ) {
    return { ok: false, error: "invalid user_type" };
  }
  if (realm !== "internal" && realm !== "public") {
    return { ok: false, error: "invalid realm" };
  }

  // Anonymous sentinel
  if (user_type === "anonymous") {
    if (user_id !== ANONYMOUS_USER_ID || email !== ANONYMOUS_USER_ID) {
      return { ok: false, error: "anonymous principal must use sentinel ids" };
    }
  }

  const ts = Number(ts_raw);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: "invalid identity timestamp" };
  }

  const max_skew = opts?.max_skew_s ?? DEFAULT_MAX_SKEW_S;
  const now = now_seconds(opts?.now_s);
  if (Math.abs(now - ts) > max_skew) {
    return { ok: false, error: "identity timestamp outside allowed skew" };
  }

  const is_admin = is_admin_raw === "true" || is_admin_raw === "1";
  const canonical = build_canonical_v2(
    ts,
    {
      user_id,
      email,
      is_admin,
      kirlet_id,
      user_type,
      realm,
    },
    grants_b64url || b64url_encode("[]"),
  );
  const expected = hmac_hex(secret, canonical);
  if (!safe_equal_hex(expected, sig)) {
    return { ok: false, error: "invalid identity signature" };
  }

  const parsed = parse_grants(grants_b64url);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    identity: {
      user_id,
      email,
      is_admin,
      kirlet_id,
      grants: parsed.grants,
      user_type,
      realm,
    },
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET IDENTITY (Node — HMAC)
// (o==================================================================o)
