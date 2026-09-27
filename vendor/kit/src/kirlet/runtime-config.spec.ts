import { describe, expect, test } from "bun:test";
import { resolve_kirlet_config } from "./runtime-config.js";

describe("resolve_kirlet_config", () => {
  test("defaults", () => {
    const c = resolve_kirlet_config({
      env: {},
      default_technical_id: "kirlet-hr",
    });
    expect(c.technical_id).toBe("kirlet-hr");
    expect(c.port).toBe(3000);
    expect(c.data_dir).toBe("/data");
    expect(c.files_dir).toBe("/data/files");
    expect(c.auth_disabled).toBe(false);
    expect(c.data_mode).toBe("memory");
    expect(c.api_base).toBe("api://m/kirlet-hr");
    expect(c.seed_demo).toBe(true);
  });

  test("http data mode when url+secret", () => {
    const c = resolve_kirlet_config({
      env: {
        NOX_DATA_URL: "http://nox:3000/api/kirlets/data/kirlet-hr",
        NOX_KIRLET_GATEWAY_SECRET: "sekrit",
        KIRLET_AUTH: "off",
        PORT: "4100",
        DATA_DIR: "/tmp/x",
        KIRLET_SEED_DEMO: "0",
      },
    });
    expect(c.data_mode).toBe("http");
    // Hay secreto: "off" ya no desactiva la firma.
    expect(c.auth_disabled).toBe(false);
    expect(c.kirlet_auth).toBe("off");
    expect(c.port).toBe(4100);
    expect(c.files_dir).toBe("/tmp/x/files");
    expect(c.seed_demo).toBe(false);
  });

  test("off sin secreto conserva el admin sintético (arranque suelto)", () => {
    const c = resolve_kirlet_config({ env: { SUBJECT_AUTH: "off" } });
    expect(c.auth_disabled).toBe(true);
    expect(c.data_mode).toBe("memory");
  });

  test("off con secreto solo da el admin sintético con SUBJECT_DEV_ADMIN", () => {
    const base = { SUBJECT_AUTH: "off", CORE_SUBJECT_GATEWAY_SECRET: "sekrit" };
    expect(resolve_kirlet_config({ env: base }).auth_disabled).toBe(false);
    expect(
      resolve_kirlet_config({ env: { ...base, SUBJECT_DEV_ADMIN: "1" } }).auth_disabled,
    ).toBe(true);
    expect(
      resolve_kirlet_config({ env: { ...base, KIRLET_DEV_ADMIN: "true" } }).auth_disabled,
    ).toBe(true);
    expect(
      resolve_kirlet_config({ env: { ...base, SUBJECT_DEV_ADMIN: "0" } }).auth_disabled,
    ).toBe(false);
  });

  test("on nunca desactiva la firma, ni con SUBJECT_DEV_ADMIN", () => {
    const c = resolve_kirlet_config({
      env: { SUBJECT_AUTH: "on", SUBJECT_DEV_ADMIN: "1" },
    });
    expect(c.auth_disabled).toBe(false);
  });
});
