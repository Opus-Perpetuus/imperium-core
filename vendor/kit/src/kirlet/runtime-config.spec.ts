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
    expect(c.auth_disabled).toBe(true);
    expect(c.port).toBe(4100);
    expect(c.files_dir).toBe("/tmp/x/files");
    expect(c.seed_demo).toBe(false);
  });
});
