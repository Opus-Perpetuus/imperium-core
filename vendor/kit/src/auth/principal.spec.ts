import { describe, expect, test } from "bun:test";
import {
  GENERIC_CREDENTIALS_MESSAGE,
  INTERNAL_HOME_PATH,
  PUBLIC_LOGIN_DESTINATION,
  PUBLIC_SESSION_START_PATH,
  apply_public_user_create,
  authenticate_for_surface,
  can_enter_internal,
  principal_kind,
  session_home_path,
} from "./principal.js";

const public_user = { type: "external", is_active: true, is_admin: false };
const staff_user = { type: "internal", is_active: true, is_admin: true };
const legacy_user = { is_active: true, is_admin: true };

describe("principal_kind", () => {
  test("absent type is staff", () => {
    expect(principal_kind(legacy_user)).toBe("internal");
    expect(principal_kind({ type: "internal" })).toBe("internal");
    expect(principal_kind(public_user)).toBe("external");
  });
});

describe("authenticate_for_surface", () => {
  test("staff login rejects a public user with the generic credentials message", () => {
    const r = authenticate_for_surface("staff", public_user, true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe(GENERIC_CREDENTIALS_MESSAGE);
    expect(r.message).not.toMatch(/tipo|type|external|público/i);
  });

  test("the same public user is accepted by public login with public type", () => {
    const r = authenticate_for_surface("public", public_user, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("external");
    expect(r.destination).toBe(PUBLIC_LOGIN_DESTINATION);
    expect(r.destination).not.toBe(INTERNAL_HOME_PATH);
    expect(r.destination).not.toContain("internal");
  });

  test("an internal user is rejected by public login", () => {
    const r = authenticate_for_surface("public", staff_user, true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe(GENERIC_CREDENTIALS_MESSAGE);
  });

  test("a user with no type still authenticates as staff", () => {
    const r = authenticate_for_surface("staff", legacy_user, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe("internal");
    expect(r.destination).toBe(INTERNAL_HOME_PATH);
  });

  test("unknown user uses the same generic message as a type mismatch", () => {
    const missing = authenticate_for_surface("staff", null, false);
    const mismatch = authenticate_for_surface("staff", public_user, true);
    expect(missing.ok).toBe(false);
    expect(mismatch.ok).toBe(false);
    if (missing.ok || mismatch.ok) return;
    expect(missing.message).toBe(mismatch.message);
    expect(missing.message).toBe(GENERIC_CREDENTIALS_MESSAGE);
  });
});

describe("can_enter_internal", () => {
  test("public-typed session is denied; staff and absent type are allowed", () => {
    expect(can_enter_internal(public_user)).toBe(false);
    expect(can_enter_internal(staff_user)).toBe(true);
    expect(can_enter_internal(legacy_user)).toBe(true);
    expect(can_enter_internal(null)).toBe(false);
  });

  test("public login success does not yield an /internal destination", () => {
    const r = authenticate_for_surface("public", public_user, true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(can_enter_internal(public_user)).toBe(false);
    expect(session_home_path(public_user)).toBe(PUBLIC_LOGIN_DESTINATION);
    expect(session_home_path(public_user)).not.toBe("/internal");
    expect(PUBLIC_SESSION_START_PATH).not.toBe("login");
  });
});

describe("apply_public_user_create", () => {
  test("forces public type and not-admin", () => {
    const out = apply_public_user_create({
      email: "a@b.c",
      type: "external",
      is_admin: true,
      name: "Cliente",
    });
    expect(out.type).toBe("external");
    expect(out.is_admin).toBe(false);
  });

  test("leaves staff creates alone", () => {
    const doc = { email: "s@b.c", is_admin: true, name: "Staff" };
    expect(apply_public_user_create(doc)).toEqual(doc);
  });
});
