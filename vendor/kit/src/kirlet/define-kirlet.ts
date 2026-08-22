// (o==================================================================o)
//   #region DEFINE KIRLET (single source of truth → manifest)
// (o-----------------------------------------------------------\/-----o)

import type { KirletManifest, KirletManifestIcon, KirletManifestMenuItem, KirletPublicAccess } from "./manifest.js";
import { kirlet_slug_from_id, is_kirlet_catalog_id } from "./manifest.js";
import type { KirletManifestWidget } from "./widgets.js";
import { validate_kirlet_manifest } from "./manifest-validate.js";
import type { KirletSchemaBundle, KirletTableDecl } from "./schema.js";
import type { KirletModuleDef } from "./define-module.js";
import type { DomainRow } from "./data-client.js";
import type { KirletDataClient } from "./data-client.js";
import type { NoxServices } from "./nox-services.js";

export type KirletJobDef = {
  id: string;
  every_ms: number;
  run: (ctx: {
    data: KirletDataClient;
    nox: NoxServices;
    technical_id: string;
  }) => Promise<void> | void;
};

export type KirletDefinitionInput = {
  /** Catalog id `KIRLET-slug` or technical `kirlet-slug`. */
  id: string;
  name: string;
  version?: string;
  image?: string;
  compat: { nox: string; kit: string };
  icon?: KirletManifestIcon;
  menu_root?: { id: string; label: string; icon?: string; order?: number };
  modules: KirletModuleDef[];
  seed?: (ctx: {
    data: KirletDataClient;
    nox: NoxServices;
    technical_id: string;
  }) => Promise<void> | void;
  jobs?: KirletJobDef[];
  schema_version?: number;
  /** Optional port advertised in manifest (default 3000). */
  port?: number;
  storage_files?: boolean;
  /**
   * Attachment resources to expose for public read via `GET /api/p/files/:id`.
   *
   * `resource` may be written bare (`"product"`) — it is namespaced to
   * `kirlet.<slug>.` automatically, which is also the only namespace NOX will
   * accept, so a kirlet cannot publish another's files by mistake.
   */
  public_files?: Array<{ resource: string; access?: KirletPublicAccess }>;
  /** Other kirlets that must be installed first (technical ids). */
  dependsOn?: string[];
  /** Mobile widgets this kirlet contributes when installed. */
  widgets?: KirletManifestWidget[];
};

export type KirletDefinition = {
  input: KirletDefinitionInput;
  catalog_id: string;
  technical_id: string;
  slug: string;
  modules: KirletModuleDef[];
  schema_version: number;
  /** Derived + validated manifest. */
  manifest: () => KirletManifest;
  /** Schema bundle from module tables. */
  schema: () => KirletSchemaBundle;
  /** alias → resource map for gateway grants. */
  resources_map: () => Record<string, string>;
  seed?: KirletDefinitionInput["seed"];
  jobs?: KirletJobDef[];
};

function to_catalog_and_tech(id: string): {
  catalog_id: string;
  technical_id: string;
  slug: string;
} {
  const slug = kirlet_slug_from_id(id);
  if (!slug) {
    throw new Error(`Invalid kirlet id: ${id}`);
  }
  const as_subject = id.startsWith("SUBJECT-") || id.startsWith("subject-");
  const catalog_id = is_kirlet_catalog_id(id)
    ? id.startsWith("subject-")
      ? `SUBJECT-${slug}`
      : id
    : as_subject
      ? `SUBJECT-${slug}`
      : `KIRLET-${slug}`;
  const technical_id = as_subject || catalog_id.startsWith("SUBJECT-")
    ? `subject-${slug}`
    : `kirlet-${slug}`;
  return { catalog_id, technical_id, slug };
}

function map_menu_item(m: {
  id: string;
  label: string;
  order?: number;
  pageId?: string;
  path?: string;
  permission?: string;
  icon?: string;
  realm?: "internal" | "public";
  children?: Array<{
    id: string;
    label: string;
    order?: number;
    pageId?: string;
    path?: string;
    permission?: string;
    icon?: string;
    realm?: "internal" | "public";
    children?: unknown[];
  }>;
}): KirletManifestMenuItem {
  return {
    id: m.id,
    label: m.label,
    order: m.order,
    pageId: m.pageId,
    path: m.path,
    permission: m.permission,
    icon: m.icon,
    realm: m.realm,
    children: m.children?.map((c) =>
      map_menu_item(c as Parameters<typeof map_menu_item>[0]),
    ),
  };
}

function flatten_menu(
  modules: KirletModuleDef[],
  menu_root?: KirletDefinitionInput["menu_root"],
): KirletManifestMenuItem[] {
  const children: KirletManifestMenuItem[] = [];
  for (const mod of modules) {
    // Explicit menu array (even empty) opts out of auto leaf generation
    if (mod.menu !== undefined) {
      for (const m of mod.menu) {
        children.push(map_menu_item(m));
      }
    } else if (mod.pages?.length) {
      const page = mod.pages[0]!;
      children.push({
        id: `menu-${mod.resource}`,
        label: mod.labels.plural,
        pageId: page.id,
        path: page.path,
        permission: page.permission,
        order: children.length * 10,
      });
    }
  }
  if (menu_root) {
    return [
      {
        id: menu_root.id,
        label: menu_root.label,
        icon: menu_root.icon,
        order: menu_root.order ?? 0,
        children,
      },
    ];
  }
  return children;
}

/** Static path prefix for public.api: strip trailing `/:param` segments. */
export function public_path_prefix(route_path: string): string {
  const segs = route_path.split("/").filter(Boolean);
  const static_segs: string[] = [];
  for (const s of segs) {
    if (s.startsWith(":")) break;
    static_segs.push(s);
  }
  if (!static_segs.length) return "/";
  return `/${static_segs.join("/")}`;
}

/**
 * Single source of truth for a kirlet. `manifest()` is auto-validated.
 */
export function define_kirlet(def: KirletDefinitionInput): KirletDefinition {
  const { catalog_id, technical_id, slug } = to_catalog_and_tech(def.id);
  if (!def.modules.length) {
    throw new Error("define_kirlet requires at least one module");
  }
  const resource_names = new Set<string>();
  for (const mod of def.modules) {
    if (resource_names.has(mod.resource)) {
      throw new Error(`Duplicate module resource: ${mod.resource}`);
    }
    resource_names.add(mod.resource);
    for (const a of mod.aliases ?? []) {
      if (resource_names.has(a)) {
        throw new Error(`Duplicate alias/resource: ${a}`);
      }
      resource_names.add(a);
    }
  }

  const resources_map = (): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const mod of def.modules) {
      map[mod.resource] = mod.resource;
      for (const a of mod.aliases ?? []) {
        map[a] = mod.resource;
      }
    }
    return map;
  };

  const schema = (): KirletSchemaBundle => {
    const tables: KirletTableDecl[] = [];
    const seen = new Set<string>();
    for (const mod of def.modules) {
      for (const t of mod.tables ?? []) {
        if (seen.has(t.name)) {
          throw new Error(`Duplicate table: ${t.name}`);
        }
        seen.add(t.name);
        tables.push(t);
      }
    }
    return {
      technicalId: technical_id,
      version: def.schema_version ?? 1,
      tables,
    };
  };

  const manifest = (): KirletManifest => {
    const version = def.version ?? "0.0.0";
    const image =
      def.image ??
      (technical_id.startsWith("subject-")
        ? `ghcr.io/opus-perpetuus/${technical_id}:${version}`
        : `kirel/${technical_id}:${version}`);
    const permissions: Array<{ id: string; label: string }> = [];
    const pages: KirletManifest["pages"] = [];
    const public_pages: Array<{ id: string; access: KirletPublicAccess }> = [];
    const public_api: Array<{
      pathPrefix: string;
      access: KirletPublicAccess;
      methods?: string[];
    }> = [];

    for (const mod of def.modules) {
      const perm_ns = technical_id.startsWith("subject-") ? "subject" : "kirlet";
      const read_id = `${perm_ns}.${slug}.${mod.resource}.read`;
      const write_id = `${perm_ns}.${slug}.${mod.resource}.write`;
      permissions.push({
        id: read_id,
        label: mod.labels.read ?? `${mod.labels.plural}: read`,
      });
      permissions.push({
        id: write_id,
        label: mod.labels.write ?? `${mod.labels.plural}: write`,
      });
      for (const p of mod.pages ?? []) {
        pages.push({
          id: p.id,
          path: p.path,
          permission: p.permission ?? read_id,
        });
      }
      // Derive public.api from route public_access (static path prefix)
      const by_prefix = new Map<
        string,
        { access: KirletPublicAccess; methods: Set<string> }
      >();
      for (const route of mod.routes) {
        if (!route.public_access) continue;
        const path = route.pattern.slice(route.pattern.indexOf(" ") + 1);
        const prefix = public_path_prefix(path);
        if (prefix === "/") continue;
        let entry = by_prefix.get(prefix);
        if (!entry) {
          entry = { access: route.public_access, methods: new Set() };
          by_prefix.set(prefix, entry);
        }
        // Prefer external over anonymous if mixed on same prefix
        if (route.public_access === "external") entry.access = "external";
        entry.methods.add(route.compiled.method);
      }
      for (const [pathPrefix, entry] of by_prefix) {
        public_api.push({
          pathPrefix,
          access: entry.access,
          methods: [...entry.methods].sort(),
        });
      }
      // Explicit page public_access (page paths often differ from API prefixes)
      for (const p of mod.pages ?? []) {
        if (!p.public_access) continue;
        if (!public_pages.some((x) => x.id === p.id)) {
          public_pages.push({ id: p.id, access: p.public_access });
        }
      }
    }

    const raw: KirletManifest = {
      id: catalog_id,
      technicalId: technical_id,
      name: def.name,
      version,
      image,
      compat: def.compat,
      api: {
        basePath: "/",
        port: def.port ?? 3000,
        healthPath: "/health",
      },
      permissions,
      pages,
      menu: flatten_menu(def.modules, def.menu_root),
      icon: def.icon,
      storage: {
        domain: "shared-nox-postgres",
        files: def.storage_files === true,
      },
    };

    if (def.dependsOn?.length) {
      raw.dependsOn = [...def.dependsOn];
    }
    if (def.widgets?.length) {
      raw.widgets = def.widgets.map((w) => ({ ...w }));
      const local_widgets = raw.widgets.filter((w) => w.capability !== "backend-only");
      if (local_widgets.length) {
        raw.localFunctions = { widgets: local_widgets.map((w) => ({ ...w })) };
      }
    }

    const public_files = (def.public_files ?? []).map((entry) => ({
      // Namespace it for the author: a bare "product" is what a kirlet means,
      // and the validator (rightly) demands the fully-qualified resource.
      resourcePrefix: entry.resource.startsWith(`kirlet.${slug}.`)
        ? entry.resource
        : `kirlet.${slug}.${entry.resource}`,
      access: entry.access ?? ("anonymous" as KirletPublicAccess),
    }));

    if (public_pages.length || public_api.length || public_files.length) {
      raw.public = {};
      if (public_pages.length) raw.public.pages = public_pages;
      if (public_api.length) raw.public.api = public_api;
      if (public_files.length) raw.public.files = public_files;
    }

    // resources map for gateway (extension field)
    (raw as KirletManifest & { resources?: Record<string, string> }).resources =
      resources_map();

    const validated = validate_kirlet_manifest(raw);
    if (!validated.ok) {
      throw new Error(
        `Invalid derived manifest: ${validated.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
      );
    }
    // Preserve resources + dependsOn (validator may strip extension fields)
    const out = {
      ...validated.manifest,
      resources: resources_map(),
    } as KirletManifest & { resources: Record<string, string> };
    if (def.dependsOn?.length) {
      out.dependsOn = [...def.dependsOn];
    }
    return out;
  };

  return {
    input: def,
    catalog_id,
    technical_id,
    slug,
    modules: def.modules,
    schema_version: def.schema_version ?? 1,
    manifest,
    schema,
    resources_map,
    seed: def.seed,
    jobs: def.jobs,
  };
}

/** Prefix history resource names with kirlet.<slug>. when relative. */
export function qualify_history_resource(
  slug: string,
  resource: string,
): string {
  if (resource.startsWith("kirlet.")) return resource;
  return `kirlet.${slug}.${resource}`;
}

// silence unused DomainRow in case of future seed typing
export type { DomainRow };

// (o-----------------------------------------------------------/\-----o)
//   #endregion DEFINE KIRLET
// (o==================================================================o)
