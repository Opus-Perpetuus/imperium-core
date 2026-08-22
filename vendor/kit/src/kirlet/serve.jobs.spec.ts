// (o==================================================================o)
//   #region SERVE JOB WATCHDOG
// (o-----------------------------------------------------------\/-----o)

import { describe, expect, test } from "bun:test";
import { define_kirlet } from "./define-kirlet.js";
import { define_module, define_routes } from "./define-module.js";
import { serve_kirlet } from "./serve.js";

describe("serve job watchdog (H2)", () => {
  test("hung tick frees job_running so the next interval can run", async () => {
    let entries = 0;
    const hangers: Array<() => void> = [];

    const mod = define_module({
      resource: "noop",
      labels: { singular: "Noop", plural: "Noops" },
      routes: define_routes({}),
      tables: [],
      pages: [],
    });

    const def = define_kirlet({
      id: "KIRLET-watchdog",
      name: "Watchdog",
      version: "0.0.1",
      image: "kirel/kirlet-watchdog:0.0.1",
      compat: { nox: ">=0.5.0", kit: "^0.5.0" },
      modules: [mod],
      schema_version: 1,
      jobs: [
        {
          id: "tick",
          every_ms: 40,
          run: async () => {
            entries += 1;
            if (entries === 1) {
              await new Promise<void>((resolve) => {
                hangers.push(resolve);
              });
            }
          },
        },
      ],
    });

    const server = serve_kirlet(def, {
      no_listen: true,
      job_timeout_ms: 80,
      config: {
        auth_disabled: true,
        gateway_secret: "",
        technical_id: def.technical_id,
        data_mode: "memory",
        port: 0,
        data_dir: "/tmp",
        files_dir: "/tmp/files",
        kirlet_auth: "off",
        nox_data_url: null,
        seed_demo: false,
        api_base: `api://m/${def.technical_id}`,
      },
    });

    const deadline = Date.now() + 3_000;
    while (entries < 1 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(entries).toBeGreaterThanOrEqual(1);

    while (entries < 2 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(entries).toBeGreaterThanOrEqual(2);

    for (const release of hangers) release();
    server.stop();
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion SERVE JOB WATCHDOG
// (o==================================================================o)
