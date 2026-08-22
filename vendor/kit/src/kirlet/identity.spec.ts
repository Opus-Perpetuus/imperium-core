import { describe, expect, test } from "bun:test";
import {
  ANONYMOUS_USER_ID,
  kirlet_identity_can,
  sign_kirlet_identity,
  sign_kirlet_identity_v2,
  verify_kirlet_identity,
  type KirletIdentity,
} from "./identity.js";

const secret = "test-gateway-secret-32chars-min!!";

const base_identity: KirletIdentity = {
  user_id: "u1",
  email: "admin@kirel.local",
  is_admin: false,
  kirlet_id: "KIRLET-hr",
  grants: [
    { resource: "kirlet.hr.employees", c: true, r: true, u: true, d: false },
    { resource: "kirlet.hr.departments", c: false, r: true, u: false, d: false },
  ],
};

describe("kirlet identity", () => {
  test("sign→verify roundtrip", () => {
    const headers = sign_kirlet_identity(base_identity, secret, 1_700_000_000);
    const result = verify_kirlet_identity(headers, secret, {
      now_s: 1_700_000_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.user_id).toBe("u1");
      expect(result.identity.email).toBe("admin@kirel.local");
      expect(result.identity.grants).toHaveLength(2);
      expect(result.identity.grants[0].resource).toBe("kirlet.hr.employees");
    }
  });

  test("rechaza firma alterada", () => {
    const headers = sign_kirlet_identity(base_identity, secret, 1_700_000_000);
    headers["x-nox-identity-sig"] = "0".repeat(64);
    const result = verify_kirlet_identity(headers, secret, {
      now_s: 1_700_000_000,
    });
    expect(result.ok).toBe(false);
  });

  test("rechaza ts ±300s", () => {
    const headers = sign_kirlet_identity(base_identity, secret, 1_700_000_000);
    const result = verify_kirlet_identity(headers, secret, {
      now_s: 1_700_000_000 + 301,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("skew");
    }
  });

  test("kirlet_identity_can respeta rwcd y admin", () => {
    expect(
      kirlet_identity_can(base_identity, "kirlet.hr.employees", "read"),
    ).toBe(true);
    expect(
      kirlet_identity_can(base_identity, "kirlet.hr.employees", "delete"),
    ).toBe(false);
    expect(
      kirlet_identity_can(base_identity, "kirlet.hr.departments", "create"),
    ).toBe(false);
    expect(
      kirlet_identity_can(base_identity, "kirlet.hr.missing", "read"),
    ).toBe(false);

    const admin: KirletIdentity = { ...base_identity, is_admin: true, grants: [] };
    expect(kirlet_identity_can(admin, "kirlet.hr.anything", "delete")).toBe(true);
  });

  test("v2 sign→verify roundtrip with user_type and realm", () => {
    const id: KirletIdentity = {
      ...base_identity,
      user_type: "external",
      realm: "public",
      grants: [],
    };
    const headers = sign_kirlet_identity_v2(id, secret, 1_700_000_000);
    expect(headers["x-nox-identity-v"]).toBe("2");
    expect(headers["x-nox-user-type"]).toBe("external");
    expect(headers["x-nox-realm"]).toBe("public");
    const result = verify_kirlet_identity(headers, secret, {
      now_s: 1_700_000_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.user_type).toBe("external");
      expect(result.identity.realm).toBe("public");
    }
  });

  test("v2 anonymous principal", () => {
    const id: KirletIdentity = {
      user_id: ANONYMOUS_USER_ID,
      email: ANONYMOUS_USER_ID,
      is_admin: false,
      kirlet_id: "KIRLET-tienda",
      grants: [],
      user_type: "anonymous",
      realm: "public",
    };
    const headers = sign_kirlet_identity_v2(id, secret, 1_700_000_000);
    const result = verify_kirlet_identity(headers, secret, {
      now_s: 1_700_000_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.user_type).toBe("anonymous");
    }
  });

  test("v2 downgrade attack: strip identity-v fails verify on v1 path", () => {
    const id: KirletIdentity = {
      ...base_identity,
      user_type: "external",
      realm: "public",
      grants: [],
    };
    const headers = sign_kirlet_identity_v2(id, secret, 1_700_000_000);
    delete headers["x-nox-identity-v"];
    const result = verify_kirlet_identity(headers, secret, {
      now_s: 1_700_000_000,
    });
    expect(result.ok).toBe(false);
  });
});
