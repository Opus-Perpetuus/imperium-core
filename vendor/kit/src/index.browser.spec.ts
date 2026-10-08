import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

// Un cliente que importa `./browser` desde el paquete publicado solo tiene lo
// que el kit declara en `dependencies`: un devDependency ahí lo rompería.
describe("entrada ./browser", () => {
  test("no importa paquetes que el kit no declare en dependencies", async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "index.browser.ts")],
      target: "browser",
      packages: "external",
    });
    expect(built.success).toBe(true);
    const code = await built.outputs[0]!.text();
    const imported = [...code.matchAll(/from\s*["']([^"'./][^"']*)["']/g)].map(
      (m) => m[1]!.replace(/^(@[^/]+\/[^/]+|[^/]+).*$/, "$1"),
    );
    const declared = Object.keys(
      (pkg as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(imported.filter((name) => !declared.includes(name))).toEqual([]);
  });
});
