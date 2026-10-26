//   #region MANIFEST VALIDATE

import {
  type KirletManifest,
  type KirletManifestLeaf,
  type KirletManifestMenuItem,
  type KirletManifestPage,
  type KirletManifestPublic,
  type KirletManifestRepository,
  type KirletManifestVersionChannel,
  type KirletPublicAccess,
  KIRLET_MANIFEST_SCHEMA_URI,
  KIRLET_MANIFEST_VERSION,
  is_kirlet_catalog_id,
  is_kirlet_technical_id,
  kirlet_slug_from_id,
  leaf_segment_is_reserved,
} from "./manifest.js";
import type { KirletManifestWidget } from "./widgets.js";
import { KIRLET_WIDGET_CAPABILITIES, KIRLET_WIDGET_SIZES } from "./widgets.js";
import { semver_satisfies } from "./semver-lite.js";

export type KirletManifestValidation =
  | { ok: true; manifest: KirletManifest }
  | { ok: false; issues: Array<{ path: string; message: string }> };

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_nonempty_string(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function permission_pattern(slug: string): RegExp {
  return new RegExp(
    `^(?:kirlet|subject)\\.${slug}\\.[a-z][a-z0-9-]*\\.(read|write)$`,
  );
}

function collect_menu_page_ids(
  items: KirletManifestMenuItem[],
  out: string[],
): void {
  for (const item of items) {
    if (item.pageId) out.push(item.pageId);
    if (item.children?.length) collect_menu_page_ids(item.children, out);
  }
}

function validate_menu_items(
  items: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
  page_ids: Set<string>,
): KirletManifestMenuItem[] | undefined {
  if (!Array.isArray(items)) {
    issues.push({ path, message: "menu must be an array" });
    return undefined;
  }
  const result: KirletManifestMenuItem[] = [];
  items.forEach((raw, i) => {
    const p = `${path}[${i}]`;
    if (!is_plain_object(raw)) {
      issues.push({ path: p, message: "menu item must be an object" });
      return;
    }
    if (!is_nonempty_string(raw["id"])) {
      issues.push({ path: `${p}.id`, message: "id is required" });
    }
    if (!is_nonempty_string(raw["label"])) {
      issues.push({ path: `${p}.label`, message: "label is required" });
    }
    const has_children =
      Array.isArray(raw["children"]) && raw["children"].length > 0;
    // Leaves need a pageId; group parents (sidebar sections) may omit it.
    if (!has_children && !is_nonempty_string(raw["pageId"])) {
      issues.push({ path: `${p}.pageId`, message: "pageId is required" });
    } else if (
      is_nonempty_string(raw["pageId"]) &&
      page_ids.size > 0 &&
      !page_ids.has(String(raw["pageId"]))
    ) {
      issues.push({
        path: `${p}.pageId`,
        message: `pageId "${raw["pageId"]}" not found in pages[]`,
      });
    }
    const item: KirletManifestMenuItem = {
      id: String(raw["id"] ?? ""),
      label: String(raw["label"] ?? ""),
    };
    if (is_nonempty_string(raw["pageId"])) {
      item.pageId = String(raw["pageId"]);
    }
    if (typeof raw["order"] === "number") item.order = raw["order"];
    if (raw["realm"] === "internal" || raw["realm"] === "public") {
      item.realm = raw["realm"];
    }
    if (is_nonempty_string(raw["path"])) item.path = raw["path"];
    if (is_nonempty_string(raw["permission"])) item.permission = raw["permission"];
    if (is_nonempty_string(raw["icon"])) item.icon = raw["icon"];
    if (raw["children"] !== undefined) {
      const children = validate_menu_items(
        raw["children"],
        `${p}.children`,
        issues,
        page_ids,
      );
      if (children) item.children = children;
    }
    result.push(item);
  });
  return result;
}

/**
 * Validate an unknown JSON value as a full KirletManifest v1.
 */
export function validate_kirlet_manifest(input: unknown): KirletManifestValidation {
  const issues: Array<{ path: string; message: string }> = [];
  if (!is_plain_object(input)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "Manifest must be an object" }],
    };
  }

  if (!is_nonempty_string(input["id"])) {
    issues.push({ path: "$.id", message: "id is required" });
  } else if (!is_kirlet_catalog_id(input["id"])) {
    issues.push({
      path: "$.id",
      message: 'id must match KIRLET-<slug> (e.g. KIRLET-hr)',
    });
  }

  if (!is_nonempty_string(input["technicalId"])) {
    issues.push({ path: "$.technicalId", message: "technicalId is required" });
  } else if (!is_kirlet_technical_id(input["technicalId"])) {
    issues.push({
      path: "$.technicalId",
      message: "technicalId must match kirlet-<slug>",
    });
  }

  const slug_from_id = is_nonempty_string(input["id"])
    ? kirlet_slug_from_id(input["id"])
    : null;
  const slug_from_tech = is_nonempty_string(input["technicalId"])
    ? kirlet_slug_from_id(input["technicalId"])
    : null;
  if (
    slug_from_id &&
    slug_from_tech &&
    slug_from_id !== slug_from_tech
  ) {
    issues.push({
      path: "$.technicalId",
      message: `technicalId slug "${slug_from_tech}" does not match id slug "${slug_from_id}"`,
    });
  }
  const slug = slug_from_id ?? slug_from_tech ?? "";

  for (const key of ["name", "version", "image"] as const) {
    if (!is_nonempty_string(input[key])) {
      issues.push({ path: `$.${key}`, message: `${key} is required` });
    }
  }

  if (!is_plain_object(input["compat"])) {
    issues.push({ path: "$.compat", message: "compat is required" });
  } else {
    if (!is_nonempty_string(input["compat"]["nox"])) {
      issues.push({ path: "$.compat.nox", message: "compat.nox is required" });
    }
    if (!is_nonempty_string(input["compat"]["kit"])) {
      issues.push({ path: "$.compat.kit", message: "compat.kit is required" });
    }
  }

  if (!is_plain_object(input["api"])) {
    issues.push({ path: "$.api", message: "api is required" });
  } else {
    if (!is_nonempty_string(input["api"]["basePath"])) {
      issues.push({ path: "$.api.basePath", message: "api.basePath is required" });
    }
    if (!is_nonempty_string(input["api"]["healthPath"])) {
      issues.push({
        path: "$.api.healthPath",
        message: "api.healthPath is required",
      });
    }
    const port = input["api"]["port"];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      issues.push({
        path: "$.api.port",
        message: "api.port must be an integer 1–65535",
      });
    }
  }

  const page_ids = new Set<string>();
  const page_id_counts = new Map<string, number>();
  const leaf_segments = new Set<string>();
  let declares_leaf = false;
  let pages: KirletManifest["pages"];
  if (input["pages"] !== undefined) {
    if (!Array.isArray(input["pages"])) {
      issues.push({ path: "$.pages", message: "pages must be an array" });
    } else {
      pages = [];
      input["pages"].forEach((raw, i) => {
        const p = `$.pages[${i}]`;
        if (!is_plain_object(raw)) {
          issues.push({ path: p, message: "page must be an object" });
          return;
        }
        if (!is_nonempty_string(raw["id"])) {
          issues.push({ path: `${p}.id`, message: "id is required" });
        } else {
          const id = String(raw["id"]);
          page_ids.add(id);
          page_id_counts.set(id, (page_id_counts.get(id) ?? 0) + 1);
        }
        if (!is_nonempty_string(raw["path"])) {
          issues.push({ path: `${p}.path`, message: "path is required" });
        }
        const page: KirletManifestPage = {
          id: String(raw["id"] ?? ""),
          path: String(raw["path"] ?? ""),
          permission: is_nonempty_string(raw["permission"])
            ? raw["permission"]
            : undefined,
        };
        if (raw["leaf"] !== undefined) {
          declares_leaf = true;
          const leaf = parse_page_leaf(
            raw["leaf"],
            page.path,
            page.permission,
            slug,
            `${p}.leaf`,
            issues,
          );
          if (leaf) page.leaf = leaf;
          if (
            leaf &&
            relative_resource_issue(page.path) == null &&
            !leaf_segment_is_reserved(page.path)
          ) {
            if (leaf_segments.has(page.path)) {
              issues.push({
                path: `${p}.path`,
                message: `duplicate leaf segment "${page.path}"`,
              });
            } else {
              leaf_segments.add(page.path);
            }
          }
        }
        pages!.push(page);
      });
    }
  }

  if (declares_leaf) {
    if (input["manifestVersion"] === undefined) {
      issues.push({
        path: "$.manifestVersion",
        message: "manifestVersion is required when a page declares a leaf",
      });
    }
    if (input["$schema"] === undefined) {
      issues.push({
        path: "$.$schema",
        message: "$schema is required when a page declares a leaf",
      });
    }
    for (const [id, count] of page_id_counts) {
      if (count > 1) {
        issues.push({
          path: "$.pages",
          message: `duplicate page id "${id}"`,
        });
      }
    }
  }

  if (input["permissions"] !== undefined) {
    if (!Array.isArray(input["permissions"])) {
      issues.push({ path: "$.permissions", message: "permissions must be an array" });
    } else {
      const pat = slug ? permission_pattern(slug) : null;
      input["permissions"].forEach((raw, i) => {
        const p = `$.permissions[${i}]`;
        if (!is_plain_object(raw)) {
          issues.push({ path: p, message: "permission must be an object" });
          return;
        }
        if (!is_nonempty_string(raw["id"])) {
          issues.push({ path: `${p}.id`, message: "id is required" });
        } else if (pat && !pat.test(raw["id"])) {
          issues.push({
            path: `${p}.id`,
            message: `permission id must match kirlet.${slug}.<module>.(read|write)`,
          });
        }
        if (!is_nonempty_string(raw["label"])) {
          issues.push({ path: `${p}.label`, message: "label is required" });
        }
      });
    }
  }

  let menu: KirletManifest["menu"];
  if (input["menu"] !== undefined) {
    menu = validate_menu_items(input["menu"], "$.menu", issues, page_ids);
  }

  let icon: KirletManifest["icon"];
  if (input["icon"] !== undefined) {
    if (!is_plain_object(input["icon"])) {
      issues.push({ path: "$.icon", message: "icon must be an object" });
    } else if (!Array.isArray(input["icon"]["paths"])) {
      issues.push({ path: "$.icon.paths", message: "icon.paths must be an array" });
    } else {
      icon = {
        label: is_nonempty_string(input["icon"]["label"])
          ? input["icon"]["label"]
          : undefined,
        paths: (input["icon"]["paths"] as unknown[]).map((pp) => {
          if (!is_plain_object(pp)) {
            issues.push({ path: "$.icon.paths", message: "path entry must be object" });
            return { d: "", paint: "stroke" as const };
          }
          if (!is_nonempty_string(pp["d"])) {
            issues.push({ path: "$.icon.paths", message: "path.d is required" });
          }
          const paint = pp["paint"] === "fill" ? "fill" : "stroke";
          return { d: String(pp["d"] ?? ""), paint: paint as "stroke" | "fill" };
        }),
      };
    }
  }

  // public block must be parsed before issues gate — validate reconstructs object
  let public_block: KirletManifestPublic | undefined;
  if (input["public"] !== undefined) {
    public_block = parse_public_block(
      input["public"],
      page_ids,
      issues,
      typeof input["technicalId"] === "string" ? input["technicalId"] : "",
    );
  }

  // storage: shared NOX Postgres only; private domain DB (storage.data) forbidden
  let storage: KirletManifest["storage"];
  if (is_plain_object(input["storage"])) {
    const st = input["storage"] as Record<string, unknown>;
    if (st["data"] === true && st["domain"] !== "shared-nox-postgres") {
      issues.push({
        path: "$.storage.data",
        message:
          'storage.data (private domain DB) is forbidden; use storage.domain: "shared-nox-postgres"',
      });
    }
    if (
      st["domain"] !== undefined &&
      st["domain"] !== "shared-nox-postgres"
    ) {
      issues.push({
        path: "$.storage.domain",
        message: 'storage.domain must be "shared-nox-postgres"',
      });
    }
    if (
      st["domain"] === "shared-nox-postgres" ||
      (st["domain"] === undefined && st["data"] !== true)
    ) {
      storage = {
        domain: "shared-nox-postgres",
        files: st["files"] === true,
      };
    }
  }

  if (input["resources"] !== undefined) {
    if (!is_plain_object(input["resources"])) {
      issues.push({
        path: "$.resources",
        message: "resources must be an object of alias→resource strings",
      });
    } else {
      for (const [k, v] of Object.entries(input["resources"])) {
        if (!/^[a-z][a-z0-9-]*$/.test(k)) {
          issues.push({
            path: `$.resources.${k}`,
            message: "resource alias must be kebab-case",
          });
        }
        if (typeof v !== "string" || !/^[a-z][a-z0-9-]*$/.test(v)) {
          issues.push({
            path: `$.resources.${k}`,
            message: "resource value must be a kebab-case string",
          });
        }
      }
    }
  }

  let depends_on: string[] | undefined;
  if (input["dependsOn"] !== undefined && input["dependsOn"] !== null) {
    depends_on = validate_depends_on(
      input["dependsOn"],
      typeof input["technicalId"] === "string" ? input["technicalId"] : "",
      issues,
    );
  }

  let requires: { core: string } | undefined;
  if (input["requires"] !== undefined && input["requires"] !== null) {
    const core = (input["requires"] as { core?: unknown }).core;
    if (typeof core === "string" && /^\d+\.\d+\.\d+$/.test(core.trim())) {
      requires = { core: core.trim() };
    } else {
      issues.push({ path: "$.requires.core", message: "requires.core must be a version X.Y.Z" });
    }
  }

  let widgets: KirletManifestWidget[] | undefined;
  if (input["widgets"] !== undefined) {
    widgets = validate_widgets(input["widgets"], page_ids, slug, issues);
  }

  let localFunctions: KirletManifest["localFunctions"];
  if (is_plain_object(input["localFunctions"])) {
    const lf_widgets = input["localFunctions"]["widgets"];
    if (lf_widgets !== undefined) {
      const parsed = validate_widgets(lf_widgets, page_ids, slug, issues);
      if (parsed) localFunctions = { widgets: parsed };
    }
  }

  const registry_meta = parse_registry_metadata(input, issues);

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const manifest: KirletManifest = {
    id: String(input["id"]),
    technicalId: String(input["technicalId"]),
    name: String(input["name"]),
    version: String(input["version"]),
    image: String(input["image"]),
    compat: {
      nox: String((input["compat"] as Record<string, unknown>)["nox"]),
      kit: String((input["compat"] as Record<string, unknown>)["kit"]),
    },
    api: {
      basePath: String((input["api"] as Record<string, unknown>)["basePath"]),
      port: Number((input["api"] as Record<string, unknown>)["port"]),
      healthPath: String((input["api"] as Record<string, unknown>)["healthPath"]),
    },
  };

  if (Array.isArray(input["permissions"])) {
    manifest.permissions = input["permissions"].map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r["id"]), label: String(r["label"]) };
    });
  }
  if (menu) manifest.menu = menu;
  if (pages) manifest.pages = pages;
  if (localFunctions?.widgets.length) manifest.localFunctions = localFunctions;
  if (icon) manifest.icon = icon;
  if (storage) manifest.storage = storage;
  if (is_plain_object(input["search"])) {
    manifest.search = {
      indexes: Array.isArray(input["search"]["indexes"])
        ? (input["search"]["indexes"] as unknown[])
        : [],
    };
  }
  if (is_plain_object(input["logging"])) {
    manifest.logging = {
      defaultLevel: is_nonempty_string(input["logging"]["defaultLevel"])
        ? input["logging"]["defaultLevel"]
        : undefined,
    };
  }
  if (public_block) manifest.public = public_block;

  if (input["resources"] !== undefined) {
    if (!is_plain_object(input["resources"])) {
      // already past issues gate only if valid — validate earlier
    } else {
      const resources: Record<string, string> = {};
      for (const [k, v] of Object.entries(input["resources"])) {
        if (typeof v === "string" && v.trim()) resources[k] = v;
      }
      if (Object.keys(resources).length) manifest.resources = resources;
    }
  }
  if (widgets?.length) manifest.widgets = widgets;
  if (depends_on?.length) manifest.dependsOn = depends_on;
  if (requires) manifest.requires = requires;
  if (input["manifestVersion"] === KIRLET_MANIFEST_VERSION) {
    manifest.manifestVersion = KIRLET_MANIFEST_VERSION;
  }
  if (input["$schema"] === KIRLET_MANIFEST_SCHEMA_URI) {
    manifest.$schema = KIRLET_MANIFEST_SCHEMA_URI;
  }
  if (registry_meta.imageDigest) manifest.imageDigest = registry_meta.imageDigest;
  if (registry_meta.repository) manifest.repository = registry_meta.repository;
  if (registry_meta.versionChannel) manifest.versionChannel = registry_meta.versionChannel;

  return { ok: true, manifest };
}

const RELATIVE_RESOURCE = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;

function relative_resource_issue(value: string): string | null {
  if (
    value.startsWith("/") ||
    value.startsWith("m/") ||
    value.includes("..") ||
    value.includes("://") ||
    value.includes("\\")
  ) {
    return "must be a relative resource without a leading slash, m/, .. or a URL";
  }
  if (!RELATIVE_RESOURCE.test(value)) {
    return "must use only [a-z0-9/-] and no empty segments";
  }
  return null;
}

function is_leaf_read_permission(id: string, slug: string): boolean {
  if (!slug) return false;
  return new RegExp(
    `^(?:kirlet|subject)\\.${slug}\\.[a-z][a-z0-9-]*\\.read$`,
  ).test(id);
}

function parse_page_leaf(
  raw: unknown,
  page_path: string,
  page_permission: string | undefined,
  slug: string,
  path: string,
  issues: Array<{ path: string; message: string }>,
): KirletManifestLeaf | undefined {
  if (!is_plain_object(raw)) {
    issues.push({ path, message: "leaf must be an object" });
    return undefined;
  }
  const segment_issue = relative_resource_issue(page_path);
  if (!is_nonempty_string(page_path) || segment_issue) {
    issues.push({
      path: path.replace(/\.leaf$/, ".path"),
      message: segment_issue ?? "leaf page path is required",
    });
  } else if (leaf_segment_is_reserved(page_path)) {
    issues.push({
      path: path.replace(/\.leaf$/, ".path"),
      message: `segment "${page_path.split("/")[0]}" is reserved`,
    });
  }

  const kind = raw["kind"];
  if (kind !== "crud" && kind !== "page") {
    issues.push({
      path: `${path}.kind`,
      message: 'kind must be "crud" or "page"',
    });
  }

  let app_base: string | undefined;
  if (raw["appBase"] !== undefined) {
    if (!is_nonempty_string(raw["appBase"])) {
      issues.push({ path: `${path}.appBase`, message: "appBase must be a string" });
    } else {
      const problem = relative_resource_issue(raw["appBase"]);
      if (problem) issues.push({ path: `${path}.appBase`, message: problem });
      else app_base = raw["appBase"];
    }
  } else if (kind === "crud") {
    issues.push({
      path: `${path}.appBase`,
      message: "appBase is required for kind crud",
    });
  }

  let app_create: string | undefined;
  if (raw["appCreate"] !== undefined) {
    if (!is_nonempty_string(raw["appCreate"])) {
      issues.push({ path: `${path}.appCreate`, message: "appCreate must be a string" });
    } else {
      const problem = relative_resource_issue(raw["appCreate"]);
      if (problem) issues.push({ path: `${path}.appCreate`, message: problem });
      else app_create = raw["appCreate"];
    }
  }

  const permission = is_nonempty_string(raw["permission"])
    ? raw["permission"]
    : page_permission;
  if (!permission || !is_leaf_read_permission(permission, slug)) {
    issues.push({
      path: `${path}.permission`,
      message: slug
        ? `permission must match subject.${slug}.<resource>.read or kirlet.${slug}.<resource>.read`
        : "permission is required",
    });
  }

  let icon: string | undefined;
  if (raw["icon"] !== undefined) {
    if (typeof raw["icon"] !== "string" || !/^[a-z0-9-]{1,64}$/.test(raw["icon"])) {
      issues.push({
        path: `${path}.icon`,
        message: "icon must be a short kebab-case id",
      });
    } else {
      icon = raw["icon"];
    }
  }

  let list_only: boolean | undefined;
  if (raw["listOnly"] !== undefined) {
    if (typeof raw["listOnly"] !== "boolean") {
      issues.push({ path: `${path}.listOnly`, message: "listOnly must be a boolean" });
    } else {
      list_only = raw["listOnly"];
    }
  }

  let min_shell: string | undefined;
  if (raw["minShellVersion"] !== undefined) {
    if (
      typeof raw["minShellVersion"] !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(raw["minShellVersion"])
    ) {
      issues.push({
        path: `${path}.minShellVersion`,
        message: "minShellVersion must be a version X.Y.Z",
      });
    } else {
      min_shell = raw["minShellVersion"];
    }
  }

  const list_headers =
    raw["listHeaders"] === undefined
      ? undefined
      : parse_label_map(raw["listHeaders"], `${path}.listHeaders`, issues);
  const form_labels =
    raw["formLabels"] === undefined
      ? undefined
      : parse_label_map(raw["formLabels"], `${path}.formLabels`, issues);

  if (kind !== "crud" && kind !== "page") return undefined;
  const leaf: KirletManifestLeaf = { kind };
  if (app_base) leaf.appBase = app_base;
  if (app_create) leaf.appCreate = app_create;
  if (icon) leaf.icon = icon;
  if (list_headers) leaf.listHeaders = list_headers;
  if (form_labels) leaf.formLabels = form_labels;
  if (list_only !== undefined) leaf.listOnly = list_only;
  if (min_shell) leaf.minShellVersion = min_shell;
  if (permission && is_leaf_read_permission(permission, slug)) {
    leaf.permission = permission;
  }
  return leaf;
}

const LABEL_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function parse_label_map(
  raw: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): Record<string, Record<string, string>> | undefined {
  if (!is_plain_object(raw)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const entries = Object.entries(raw);
  if (!entries.length) return undefined;
  const flat = entries.every(([, value]) => typeof value === "string");
  const nested = entries.every(
    ([, value]) =>
      is_plain_object(value) &&
      Object.values(value).every((item) => typeof item === "string"),
  );
  if (flat) {
    const es: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!LABEL_FIELD.test(key)) {
        issues.push({ path: `${path}.${key}`, message: "field name is invalid" });
        continue;
      }
      es[key] = value as string;
    }
    return { es };
  }
  if (!nested) {
    issues.push({
      path,
      message: "must be a locale map or a flat field→label map",
    });
    return undefined;
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [locale, fields] of entries) {
    if (!LABEL_LOCALE.test(locale)) {
      issues.push({
        path: `${path}.${locale}`,
        message: "locale must look like es or es-MX",
      });
      continue;
    }
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
      if (!LABEL_FIELD.test(key) || typeof value !== "string") {
        issues.push({
          path: `${path}.${locale}.${key}`,
          message: "field name is invalid",
        });
        continue;
      }
      labels[key] = value;
    }
    out[locale] = labels;
  }
  return out;
}

function parse_registry_metadata(
  input: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): {
  repository?: KirletManifestRepository;
  versionChannel?: KirletManifestVersionChannel;
  imageDigest?: string;
} {
  const out: {
    repository?: KirletManifestRepository;
    versionChannel?: KirletManifestVersionChannel;
    imageDigest?: string;
  } = {};
  if (
    input["manifestVersion"] !== undefined &&
    input["manifestVersion"] !== KIRLET_MANIFEST_VERSION
  ) {
    issues.push({ path: "$.manifestVersion", message: "manifestVersion must be 1" });
  }
  if (
    input["$schema"] !== undefined &&
    input["$schema"] !== KIRLET_MANIFEST_SCHEMA_URI
  ) {
    issues.push({
      path: "$.$schema",
      message: `$schema must be ${KIRLET_MANIFEST_SCHEMA_URI}`,
    });
  }
  if (input["imageDigest"] !== undefined) {
    if (
      typeof input["imageDigest"] !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(input["imageDigest"])
    ) {
      issues.push({
        path: "$.imageDigest",
        message: "imageDigest must be sha256:<64 hex>",
      });
    } else {
      out.imageDigest = input["imageDigest"];
    }
  }
  if (input["repository"] !== undefined) {
    const repository = parse_repository(input["repository"], issues);
    if (repository) out.repository = repository;
  }
  if (input["versionChannel"] !== undefined) {
    const channel = parse_version_channel(input["versionChannel"], issues);
    if (channel) out.versionChannel = channel;
  }
  return out;
}

function parse_repository(
  raw: unknown,
  issues: Array<{ path: string; message: string }>,
): KirletManifestRepository | undefined {
  if (!is_plain_object(raw)) {
    issues.push({ path: "$.repository", message: "repository must be an object" });
    return undefined;
  }
  const repository: KirletManifestRepository = {};
  if (raw["git"] !== undefined) {
    if (typeof raw["git"] !== "string" || !/^https:\/\/\S+$/.test(raw["git"])) {
      issues.push({
        path: "$.repository.git",
        message: "git must be an https URL",
      });
    } else {
      repository.git = raw["git"];
    }
  }
  if (raw["github"] !== undefined) {
    if (
      typeof raw["github"] !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw["github"])
    ) {
      issues.push({
        path: "$.repository.github",
        message: "github must be owner/repo",
      });
    } else {
      repository.github = raw["github"];
    }
  }
  if (!repository.git && !repository.github) {
    issues.push({
      path: "$.repository",
      message: "repository needs git or github",
    });
    return undefined;
  }
  return repository;
}

function parse_version_channel(
  raw: unknown,
  issues: Array<{ path: string; message: string }>,
): KirletManifestVersionChannel | undefined {
  if (!is_plain_object(raw)) {
    issues.push({
      path: "$.versionChannel",
      message: "versionChannel must be an object",
    });
    return undefined;
  }
  let failed = false;
  if (raw["kind"] !== "oci") {
    issues.push({ path: "$.versionChannel.kind", message: 'kind must be "oci"' });
    failed = true;
  }
  if (
    typeof raw["registry"] !== "string" ||
    !/^[a-z0-9.-]+(?::\d+)?$/.test(raw["registry"]) ||
    raw["registry"].includes("://")
  ) {
    issues.push({
      path: "$.versionChannel.registry",
      message: "registry must be a host such as ghcr.io",
    });
    failed = true;
  }
  if (
    typeof raw["repository"] !== "string" ||
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(raw["repository"]) ||
    raw["repository"].includes("..")
  ) {
    issues.push({
      path: "$.versionChannel.repository",
      message: "repository must be org/name",
    });
    failed = true;
  }
  if (raw["policy"] !== "same-major-auto-patch") {
    issues.push({
      path: "$.versionChannel.policy",
      message: 'policy must be "same-major-auto-patch"',
    });
    failed = true;
  }
  let releases: "github" | undefined;
  if (raw["releases"] !== undefined) {
    if (raw["releases"] !== "github") {
      issues.push({
        path: "$.versionChannel.releases",
        message: 'releases must be "github"',
      });
      failed = true;
    } else {
      releases = "github";
    }
  }
  let min_age: number | undefined;
  if (raw["minAgeHours"] !== undefined) {
    if (
      typeof raw["minAgeHours"] !== "number" ||
      !Number.isFinite(raw["minAgeHours"]) ||
      raw["minAgeHours"] < 0
    ) {
      issues.push({
        path: "$.versionChannel.minAgeHours",
        message: "minAgeHours must be a number >= 0",
      });
      failed = true;
    } else {
      min_age = raw["minAgeHours"];
    }
  }
  if (failed) return undefined;
  const channel: KirletManifestVersionChannel = {
    kind: "oci",
    registry: String(raw["registry"]),
    repository: String(raw["repository"]),
    policy: "same-major-auto-patch",
  };
  if (releases) channel.releases = releases;
  if (min_age !== undefined) channel.minAgeHours = min_age;
  return channel;
}

/**
 * `dependsOn`: ids técnicos de otras apps, sin repetir y sin la propia. El
 * núcleo instala en ese orden, así que un slug suelto o una auto-referencia
 * tienen que fallar aquí y no al instalar.
 */
function validate_depends_on(
  raw: unknown,
  technical_id: string,
  issues: Array<{ path: string; message: string }>,
): string[] | undefined {
  if (!Array.isArray(raw)) {
    issues.push({
      path: "$.dependsOn",
      message: "dependsOn must be an array of technical ids",
    });
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  raw.forEach((entry, i) => {
    const p = `$.dependsOn[${i}]`;
    if (typeof entry !== "string" || !is_kirlet_technical_id(entry)) {
      issues.push({
        path: p,
        message: "dependency must be a technical id (subject-<slug>)",
      });
      return;
    }
    if (entry === technical_id) {
      issues.push({ path: p, message: "an app cannot depend on itself" });
      return;
    }
    if (seen.has(entry)) {
      issues.push({ path: p, message: `duplicate dependency "${entry}"` });
      return;
    }
    seen.add(entry);
    result.push(entry);
  });
  return result;
}

const PUBLIC_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function parse_public_block(
  raw: unknown,
  page_ids: Set<string>,
  issues: Array<{ path: string; message: string }>,
  technical_id: string,
): KirletManifestPublic | undefined {
  if (!is_plain_object(raw)) {
    issues.push({ path: "$.public", message: "public must be an object" });
    return undefined;
  }
  const result: KirletManifestPublic = {};

  if (raw["pages"] !== undefined) {
    if (!Array.isArray(raw["pages"])) {
      issues.push({ path: "$.public.pages", message: "pages must be an array" });
    } else {
      result.pages = [];
      raw["pages"].forEach((entry, i) => {
        const p = `$.public.pages[${i}]`;
        if (!is_plain_object(entry)) {
          issues.push({ path: p, message: "entry must be an object" });
          return;
        }
        const id = entry["id"];
        const access = entry["access"];
        if (!is_nonempty_string(id)) {
          issues.push({ path: `${p}.id`, message: "id is required" });
          return;
        }
        if (page_ids.size > 0 && !page_ids.has(id)) {
          issues.push({
            path: `${p}.id`,
            message: `page id "${id}" not found in pages[]`,
          });
        }
        if (access !== "anonymous" && access !== "external") {
          issues.push({
            path: `${p}.access`,
            message: 'access must be "anonymous" or "external"',
          });
          return;
        }
        const page: NonNullable<KirletManifestPublic["pages"]>[number] = {
          id,
          access: access as KirletPublicAccess,
        };
        // El segmento acaba en la URL del sitio público: solo minúsculas,
        // dígitos y guiones. Vacío es legítimo — es el inicio del escaparate.
        const segment = entry["segment"];
        if (segment !== undefined) {
          if (typeof segment !== "string" || !/^[a-z0-9-]*$/.test(segment)) {
            issues.push({
              path: `${p}.segment`,
              message: "segment must be lowercase letters, digits or hyphens",
            });
            return;
          }
          page.segment = segment;
        }
        const label = entry["label"];
        if (label !== undefined) {
          if (!is_nonempty_string(label)) {
            issues.push({
              path: `${p}.label`,
              message: "label must be a non-empty string",
            });
            return;
          }
          page.label = label;
        }
        result.pages!.push(page);
      });
    }
  }

  if (raw["api"] !== undefined) {
    if (!Array.isArray(raw["api"])) {
      issues.push({ path: "$.public.api", message: "api must be an array" });
    } else {
      result.api = [];
      raw["api"].forEach((entry, i) => {
        const p = `$.public.api[${i}]`;
        if (!is_plain_object(entry)) {
          issues.push({ path: p, message: "entry must be an object" });
          return;
        }
        const pathPrefix = entry["pathPrefix"];
        const access = entry["access"];
        if (!is_nonempty_string(pathPrefix)) {
          issues.push({
            path: `${p}.pathPrefix`,
            message: "pathPrefix is required",
          });
          return;
        }
        if (!pathPrefix.startsWith("/") || pathPrefix === "/") {
          issues.push({
            path: `${p}.pathPrefix`,
            message: "pathPrefix must start with / and not be bare /",
          });
          return;
        }
        if (access !== "anonymous" && access !== "external") {
          issues.push({
            path: `${p}.access`,
            message: 'access must be "anonymous" or "external"',
          });
          return;
        }
        const item: {
          pathPrefix: string;
          access: KirletPublicAccess;
          methods?: string[];
        } = {
          pathPrefix,
          access: access as KirletPublicAccess,
        };
        if (entry["methods"] !== undefined) {
          if (!Array.isArray(entry["methods"])) {
            issues.push({
              path: `${p}.methods`,
              message: "methods must be an array",
            });
          } else {
            const methods: string[] = [];
            for (const m of entry["methods"]) {
              const up = String(m).toUpperCase();
              if (!PUBLIC_METHODS.has(up)) {
                issues.push({
                  path: `${p}.methods`,
                  message: `invalid method ${m}`,
                });
              } else {
                methods.push(up);
              }
            }
            item.methods = methods;
          }
        }
        result.api!.push(item);
      });
    }
  }

  if (raw["files"] !== undefined) {
    if (!Array.isArray(raw["files"])) {
      issues.push({ path: "$.public.files", message: "files must be an array" });
    } else {
      result.files = [];
      raw["files"].forEach((entry, i) => {
        const p = `$.public.files[${i}]`;
        if (!is_plain_object(entry)) {
          issues.push({ path: p, message: "entry must be an object" });
          return;
        }
        const resourcePrefix = entry["resourcePrefix"];
        const access = entry["access"];
        if (!is_nonempty_string(resourcePrefix)) {
          issues.push({
            path: `${p}.resourcePrefix`,
            message: "resourcePrefix is required",
          });
          return;
        }
        // A bare "kirlet." would open every kirlet's attachments at once.
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(resourcePrefix)) {
          issues.push({
            path: `${p}.resourcePrefix`,
            message:
              "resourcePrefix must be a dotted resource name (letters, digits, . _ -)",
          });
          return;
        }
        // A kirlet may only publish resources it owns. Without this a manifest
        // could name another kirlet's namespace and expose its attachments.
        const namespace = `kirlet.${technical_id.replace(/^(?:kirlet|subject)-/, "")}.`;
        if (
          !resourcePrefix.startsWith(namespace) ||
          resourcePrefix.length === namespace.length
        ) {
          issues.push({
            path: `${p}.resourcePrefix`,
            message: `resourcePrefix must name a resource under ${namespace}`,
          });
          return;
        }
        if (access !== "anonymous" && access !== "external") {
          issues.push({
            path: `${p}.access`,
            message: 'access must be "anonymous" or "external"',
          });
          return;
        }
        result.files!.push({
          resourcePrefix,
          access: access as KirletPublicAccess,
        });
      });
    }
  }

  return result;
}

/**
 * Gate a validated manifest against the host nox/kit versions.
 */
export function check_kirlet_compat(
  manifest: KirletManifest,
  env: { nox_version: string; kit_version: string },
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!semver_satisfies(env.nox_version, manifest.compat.nox)) {
    issues.push(
      `nox ${env.nox_version} does not satisfy compat.nox "${manifest.compat.nox}"`,
    );
  }
  if (!semver_satisfies(env.kit_version, manifest.compat.kit)) {
    issues.push(
      `kit ${env.kit_version} does not satisfy compat.kit "${manifest.compat.kit}"`,
    );
  }
  return { ok: issues.length === 0, issues };
}

function validate_widgets(
  raw: unknown,
  page_ids: Set<string>,
  slug: string,
  issues: Array<{ path: string; message: string }>,
): KirletManifestWidget[] | undefined {
  if (!Array.isArray(raw)) {
    issues.push({ path: "$.widgets", message: "widgets must be an array" });
    return undefined;
  }
  const seen = new Set<string>();
  const result: KirletManifestWidget[] = [];
  raw.forEach((item, i) => {
    const p = `$.widgets[${i}]`;
    if (!is_plain_object(item)) {
      issues.push({ path: p, message: "widget must be an object" });
      return;
    }
    if (!is_nonempty_string(item["id"]) || !/^[a-z][a-z0-9-]*$/.test(item["id"])) {
      issues.push({ path: `${p}.id`, message: "id must be kebab-case" });
    } else if (seen.has(item["id"])) {
      issues.push({ path: `${p}.id`, message: `duplicate widget id "${item["id"]}"` });
    } else {
      seen.add(item["id"]);
    }
    if (!is_nonempty_string(item["title"])) {
      issues.push({ path: `${p}.title`, message: "title is required" });
    }
    if (
      item["size"] !== undefined &&
      !KIRLET_WIDGET_SIZES.includes(item["size"] as never)
    ) {
      issues.push({ path: `${p}.size`, message: "size must be sm|md|lg" });
    }
    if (
      item["capability"] !== undefined &&
      !KIRLET_WIDGET_CAPABILITIES.includes(item["capability"] as never)
    ) {
      issues.push({
        path: `${p}.capability`,
        message: "capability must be embedded|backend-only",
      });
    }
    if (
      item["placement"] !== undefined &&
      item["placement"] !== "in-app" &&
      item["placement"] !== "launcher" &&
      item["placement"] !== "both"
    ) {
      issues.push({
        path: `${p}.placement`,
        message: "placement must be in-app|launcher|both",
      });
    }
    if (
      is_nonempty_string(item["pageId"]) &&
      page_ids.size > 0 &&
      !page_ids.has(item["pageId"])
    ) {
      issues.push({
        path: `${p}.pageId`,
        message: `pageId "${item["pageId"]}" not found in pages[]`,
      });
    }
    if (
      is_nonempty_string(item["permission"]) &&
      slug &&
      !item["permission"].startsWith(`kirlet.${slug}.`) &&
      !item["permission"].startsWith(`subject.${slug}.`)
    ) {
      issues.push({
        path: `${p}.permission`,
        message: `permission must be namespaced kirlet.${slug}.* or subject.${slug}.*`,
      });
    }
    const widget: KirletManifestWidget = {
      id: String(item["id"] ?? ""),
      title: String(item["title"] ?? ""),
    };
    if (is_nonempty_string(item["subtitle"])) widget.subtitle = item["subtitle"];
    if (is_nonempty_string(item["icon"])) widget.icon = item["icon"];
    if (item["size"] === "sm" || item["size"] === "md" || item["size"] === "lg") {
      widget.size = item["size"];
    }
    if (item["capability"] === "embedded" || item["capability"] === "backend-only") {
      widget.capability = item["capability"];
    }
    if (
      item["placement"] === "in-app" ||
      item["placement"] === "launcher" ||
      item["placement"] === "both"
    ) {
      widget.placement = item["placement"];
    }
    if (is_nonempty_string(item["pageId"])) widget.pageId = item["pageId"];
    if (is_nonempty_string(item["permission"])) widget.permission = item["permission"];
    if (is_plain_object(item["bind"])) {
      const b = item["bind"];
      widget.bind = {};
      if (is_nonempty_string(b["resource"])) widget.bind.resource = b["resource"];
      if (
        b["metric"] === "count" ||
        b["metric"] === "sum" ||
        b["metric"] === "latest" ||
        b["metric"] === "list"
      ) {
        widget.bind.metric = b["metric"];
      }
      if (is_nonempty_string(b["field"])) widget.bind.field = b["field"];
      if (typeof b["limit"] === "number") widget.bind.limit = b["limit"];
    }
    result.push(widget);
  });
  return result;
}

//   #endregion MANIFEST VALIDATE
