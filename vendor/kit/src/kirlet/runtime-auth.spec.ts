import { describe, expect, test } from "bun:test";
import { sign_kirlet_identity, type KirletIdentity } from "./identity.js";
import {
  _reset_auth_off_warned_for_tests,
  can_read_history,
  is_meta_path,
  method_to_action,
  method_to_permission_suffix,
  require_access,
  resolve_identity,
} from "./runtime-auth.js";

const secret = "test-gateway-secret-32chars-min!!";

const identity: KirletIdentity = {
  user_id: "u1",
  email: "a@b.co",
  is_admin: false,
  kirlet_id: "kirlet-hr",
  grants: [
    { resource: "kirlet.hr.employees", c: true, r: true, u: true, d: false },
  ],
};

function signed_req(id: KirletIdentity = identity): Request {
  const headers = sign_kirlet_identity(id, secret, Math.floor(Date.now() / 1000));
  return new Request("http://local/employees", {
    headers: headers as Record<string, string>,
  });
}

describe("runtime-auth", () => {
  test("is_meta_path", () => {
    expect(is_meta_path("/health")).toBe(true);
    expect(is_meta_path("/pages/x")).toBe(true);
    expect(is_meta_path("/employees")).toBe(false);
  });

  test("method_to_action / permission suffix", () => {
    expect(method_to_action("GET")).toBe("read");
    expect(method_to_action("POST")).toBe("create");
    expect(method_to_action("PATCH")).toBe("update");
    expect(method_to_action("DELETE")).toBe("delete");
    expect(method_to_permission_suffix("GET")).toBe("read");
    expect(method_to_permission_suffix("POST")).toBe("write");
  });

  test("resolve_identity requires signature when auth on", async () => {
    _reset_auth_off_warned_for_tests();
    const bare = resolve_identity(new Request("http://x/employees"), "/employees", {
      technical_id: "kirlet-hr",
      gateway_secret: secret,
      auth_disabled: false,
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.response.status).toBe(401);

    const ok = resolve_identity(signed_req(), "/employees", {
      technical_id: "kirlet-hr",
      gateway_secret: secret,
      auth_disabled: false,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.identity?.email).toBe("a@b.co");
  });

  test("auth_disabled yields dev admin", () => {
    const r = resolve_identity(new Request("http://x/employees"), "/employees", {
      technical_id: "kirlet-hr",
      gateway_secret: "",
      auth_disabled: true,
      on_auth_off: () => {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity?.is_admin).toBe(true);
      expect(r.identity?.user_id).toBe("dev");
    }
  });

  test("require_access 403/401", async () => {
    const denied = require_access(identity, "hr", "departments", "read");
    expect(denied?.status).toBe(403);

    const allowed = require_access(identity, "hr", "employees", "read");
    expect(allowed).toBeNull();

    const no_id = require_access(null, "hr", "employees", "read");
    expect(no_id?.status).toBe(401);
  });

  test("can_read_history", () => {
    expect(can_read_history(identity, "hr")).toBe(true);
    expect(can_read_history(null, "hr")).toBe(false);
    expect(can_read_history(identity, "tienda")).toBe(false);
  });
});
