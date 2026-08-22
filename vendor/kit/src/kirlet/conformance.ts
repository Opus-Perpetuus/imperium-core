// (o==================================================================o)
//   #region KIRLET CONFORMANCE ASSERTIONS
// (o-----------------------------------------------------------\/-----o)

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { KirletDefinition } from "./define-kirlet.js";
import { validate_kirlet_manifest } from "./manifest-validate.js";

export type ConformanceOptions = {
  definition: KirletDefinition;
  /** Absolute or relative path to kirlet `src/` directory. */
  src_dir: string;
};

export type ConformanceIssue = { code: string; message: string };

function list_files(dir: string, acc: string[] = [], base = dir): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) list_files(full, acc, base);
    else acc.push(full.slice(base.length + 1).replace(/\\/g, "/"));
  }
  return acc;
}

/**
 * Structural + definition checks for v2 kirlets.
 * Throws Error with aggregated issues, or returns void when ok.
 */
export function assert_kirlet_conformance(opts: ConformanceOptions): void {
  const issues: ConformanceIssue[] = [];
  const { definition, src_dir } = opts;
  const files = list_files(src_dir);

  // no *.module.ts
  for (const f of files) {
    if (f.endsWith(".module.ts") || f.endsWith(".module.js")) {
      issues.push({
        code: "no_module_ts",
        message: `forbidden module class file: ${f}`,
      });
    }
  }

  // kebab-case under modules/
  for (const f of files) {
    if (!f.startsWith("modules/")) continue;
    const parts = f.split("/");
    for (const part of parts) {
      if (part === "modules") continue;
      if (part.includes(".")) {
        // file name
        const base = part.replace(/\.(ts|js|tsx)$/, "");
        if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*$/.test(base) && base !== "index") {
          // allow resource.routes etc.
          if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(part.replace(/\.(ts|js)$/, "") + ".x")) {
            /* loose check below */
          }
        }
        if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(base) && base !== "index") {
          // e.g. employees.routes, employees.controller
          if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(base)) {
            issues.push({
              code: "kebab_case",
              message: `non-kebab module file: ${f}`,
            });
          }
        }
      } else if (!/^[a-z][a-z0-9-]*$/.test(part)) {
        issues.push({
          code: "kebab_case",
          message: `non-kebab module dir: ${f}`,
        });
      }
    }
  }

  // trio: for each module resource, expect routes + (controller or routes-only with crud)
  for (const mod of definition.modules) {
    const res = mod.resource;
    const prefix = `modules/${res}/`;
    const mod_files = files.filter((f) => f.startsWith(prefix));
    if (mod_files.length === 0) {
      // allow flat or alternate layout when only definition is tested without files
      // only error if modules/ exists at all
      if (files.some((f) => f.startsWith("modules/"))) {
        issues.push({
          code: "module_dir",
          message: `missing modules/${res}/ directory`,
        });
      }
      continue;
    }
    const has_routes = mod_files.some(
      (f) => f.endsWith(`${res}.routes.ts`) || f.endsWith(`${res}.routes.js`),
    );
    if (!has_routes) {
      issues.push({
        code: "trio_routes",
        message: `module ${res} missing ${res}.routes.ts`,
      });
    }
  }

  // permissions pattern
  const m = definition.manifest();
  for (const p of m.permissions ?? []) {
    const re = new RegExp(
      `^(?:kirlet|subject)\\.${definition.slug}\\.[a-z][a-z0-9-]*\\.(read|write)$`,
    );
    if (!re.test(p.id)) {
      issues.push({
        code: "permission_id",
        message: `invalid permission id: ${p.id}`,
      });
    }
  }

  const validated = validate_kirlet_manifest(m);
  if (!validated.ok) {
    for (const i of validated.issues) {
      issues.push({
        code: "manifest",
        message: `${i.path}: ${i.message}`,
      });
    }
  }

  if (issues.length) {
    throw new Error(
      `kirlet conformance failed:\n${issues.map((i) => `- [${i.code}] ${i.message}`).join("\n")}`,
    );
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET CONFORMANCE
// (o==================================================================o)
