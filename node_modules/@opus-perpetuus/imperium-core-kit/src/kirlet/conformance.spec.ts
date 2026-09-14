import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { define_module, define_routes } from "./define-module.js";
import { define_kirlet } from "./define-kirlet.js";
import { assert_kirlet_conformance } from "./conformance.js";

describe("assert_kirlet_conformance", () => {
  test("passes for valid trio layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "kirlet-conf-"));
    try {
      const src = join(root, "src");
      const mod_dir = join(src, "modules", "items");
      await mkdir(mod_dir, { recursive: true });
      await writeFile(join(mod_dir, "items.routes.ts"), "export {}");
      await writeFile(join(mod_dir, "items.controller.ts"), "export {}");
      await writeFile(join(mod_dir, "items.tables.ts"), "export {}");
      await writeFile(join(mod_dir, "items.pages.ts"), "export {}");

      const def = define_kirlet({
        id: "kirlet-items",
        name: "Items",
        version: "0.1.0",
        image: "kirel/kirlet-items:0.1.0",
        compat: { nox: ">=0.5.0", kit: "^0.5.0" },
        modules: [
          define_module({
            resource: "items",
            labels: { singular: "Item", plural: "Items" },
            routes: define_routes({
              "GET /items": async () => ({ data: [] }),
            }),
            pages: [
              {
                id: "items-list",
                path: "/items",
                build: () => ({
                  page: {
                    component: "nox.stack",
                    props: { gap: 1, children: [] },
                  },
                }),
              },
            ],
          }),
        ],
      });

      expect(() =>
        assert_kirlet_conformance({ definition: def, src_dir: src }),
      ).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails on *.module.ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "kirlet-conf-bad-"));
    try {
      const src = join(root, "src");
      await mkdir(join(src, "modules", "items"), { recursive: true });
      await writeFile(join(src, "modules", "items", "items.module.ts"), "x");
      await writeFile(join(src, "modules", "items", "items.routes.ts"), "x");

      const def = define_kirlet({
        id: "KIRLET-x",
        name: "X",
        version: "0.1.0",
        image: "kirel/kirlet-x:0.1.0",
        compat: { nox: ">=0.5.0", kit: "^0.5.0" },
        modules: [
          define_module({
            resource: "items",
            labels: { singular: "I", plural: "Is" },
            routes: define_routes({
              "GET /items": async () => ({ data: [] }),
            }),
          }),
        ],
      });

      expect(() =>
        assert_kirlet_conformance({ definition: def, src_dir: src }),
      ).toThrow(/no_module_ts|module class/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
