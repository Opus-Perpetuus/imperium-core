// (o==================================================================o)
//   #region DEFINE MODULE / ROUTES (typed authorship)
// (o-----------------------------------------------------------\/-----o)

import type { NoxPageDescriptor } from "../descriptors/ui-descriptor.js";
import type { KirletIdentity } from "./identity.types.js";
import type { KirletDataClient, KirletRepository, DomainRow } from "./data-client.js";
import { KirletRepository as Repo } from "./data-client.js";
import type { KirletTableDecl } from "./schema.js";
import type { NoxServices } from "./nox-services.js";
import type { KirletFileStore } from "./file-store.js";
import type { MultipartResult } from "./http.js";
import {
  json_response,
  error_response,
  not_found_response,
  read_multipart,
} from "./http.js";
import { parse_list_query } from "../descriptors/feature-shell.js";
import {
  compile_route,
  match_route_table,
  type CompiledRoute,
  type ParamsOfPattern,
} from "./router.js";
import type { KirletPublicAccess } from "./manifest.js";

export type KirletCtx<P extends Record<string, string> = Record<string, string>> = {
  req: Request;
  url: URL;
  path: string;
  method: string;
  params: P;
  query: URLSearchParams;
  list_query: () => ReturnType<typeof parse_list_query>;
  body: <T = unknown>() => Promise<T>;
  multipart: () => Promise<MultipartResult>;
  identity: KirletIdentity | null;
  actor: string | null;
  data: KirletDataClient;
  repo: <T extends DomainRow = DomainRow>(
    table: string,
    pk?: string,
  ) => KirletRepository<T>;
  nox: NoxServices;
  files: KirletFileStore;
  json: (data: unknown, status?: number) => Response;
  created: (data: unknown) => Response;
  fail: (code: string, message: string, status?: number, extra?: Record<string, unknown>) => Response;
  not_found: (path?: string) => Response;
};

export type RouteHandlerResult =
  | Response
  | null
  | undefined
  | Record<string, unknown>
  | unknown;

export type TypedRouteHandler<P extends Record<string, string>> = (
  ctx: KirletCtx<P>,
) => Promise<RouteHandlerResult> | RouteHandlerResult;

export type RouteEntryConfig<P extends Record<string, string>> =
  | TypedRouteHandler<P>
  | {
      handler: TypedRouteHandler<P>;
      access?: string;
      public_access?: KirletPublicAccess;
    }
  | {
      raw: true;
      handler: (
        req: Request,
        meta: {
          url: URL;
          params: P;
          identity: KirletIdentity | null;
          path: string;
          method: string;
          data: KirletDataClient;
          nox: NoxServices;
          files: KirletFileStore;
        },
      ) => Promise<Response> | Response;
      access?: string;
      public_access?: KirletPublicAccess;
    };

export type KirletRouteTable = Array<{
  pattern: string;
  compiled: CompiledRoute;
  access?: string;
  public_access?: KirletPublicAccess;
  raw?: boolean;
  handler: unknown;
}>;

/**
 * Build a typed route table from `"METHOD /path": handler` map.
 */
export function define_routes<
  const T extends Record<string, RouteEntryConfig<Record<string, string>>>,
>(routes: T): KirletRouteTable {
  const table: KirletRouteTable = [];
  for (const [pattern, entry] of Object.entries(routes)) {
    const compiled = compile_route(pattern);
    if (typeof entry === "function") {
      table.push({ pattern, compiled, handler: entry });
    } else if (entry && typeof entry === "object" && "raw" in entry && entry.raw) {
      table.push({
        pattern,
        compiled,
        raw: true,
        access: entry.access,
        public_access: entry.public_access,
        handler: entry.handler,
      });
    } else if (entry && typeof entry === "object" && "handler" in entry) {
      table.push({
        pattern,
        compiled,
        access: entry.access,
        public_access: entry.public_access,
        handler: entry.handler,
      });
    } else {
      throw new Error(`Invalid route entry for ${pattern}`);
    }
  }
  return table;
}

/**
 * Arguments handed to `KirletPageDecl.build`.
 *
 * `data`, `nox` and `files` are the same clients a route handler receives via
 * `KirletCtx`, so a page can read its own domain tables while assembling the
 * descriptor instead of emitting a placeholder for the client to fill in.
 */
export type KirletPageBuildArgs = {
  url: URL | null;
  identity: KirletIdentity | null;
  data: KirletDataClient;
  nox: NoxServices;
  files: KirletFileStore;
};

export type KirletPageDecl = {
  id: string;
  path: string;
  permission?: string;
  /** When set, page is listed under manifest.public.pages. */
  public_access?: KirletPublicAccess;
  /**
   * Unique page build signature (HR/tienda divergence resolved).
   * May be async: `serve_kirlet` awaits the result, so synchronous builds
   * written against the previous signature keep working unchanged.
   */
  build: (args: KirletPageBuildArgs) => NoxPageDescriptor | Promise<NoxPageDescriptor>;
};

export type KirletMenuDecl = {
  id: string;
  label: string;
  order?: number;
  pageId?: string;
  path?: string;
  permission?: string;
  icon?: string;
  realm?: "internal" | "public";
  children?: KirletMenuDecl[];
};

export type KirletModuleDef = {
  resource: string;
  aliases?: string[];
  labels: { singular: string; plural: string; read?: string; write?: string };
  routes: KirletRouteTable;
  tables?: KirletTableDecl[];
  pages?: KirletPageDecl[];
  menu?: KirletMenuDecl[];
};

function path_of_pattern(pattern: string): string {
  const space = pattern.indexOf(" ");
  return space >= 0 ? pattern.slice(space + 1) : pattern;
}

/**
 * Define a module: validates route paths start with /resource or aliases.
 */
export function define_module(def: {
  resource: string;
  aliases?: string[];
  labels: KirletModuleDef["labels"];
  routes: KirletRouteTable;
  tables?: KirletTableDecl[];
  pages?: KirletPageDecl[];
  menu?: KirletMenuDecl[];
}): KirletModuleDef {
  if (!/^[a-z][a-z0-9-]*$/.test(def.resource)) {
    throw new Error(`Invalid module resource: ${def.resource}`);
  }
  const prefixes = [def.resource, ...(def.aliases ?? [])].map((r) => `/${r}`);
  const seen_patterns = new Set<string>();
  for (const route of def.routes) {
    if (seen_patterns.has(route.pattern)) {
      throw new Error(`Duplicate route pattern: ${route.pattern}`);
    }
    seen_patterns.add(route.pattern);
    if (route.raw) continue;
    const path = path_of_pattern(route.pattern);
    const ok = prefixes.some(
      (p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}:`),
    );
    // also allow /resource:id style? No — params use /resource/:id
    const ok2 = prefixes.some(
      (p) => path === p || path.startsWith(`${p}/`),
    );
    if (!ok2) {
      throw new Error(
        `Route "${route.pattern}" must start with /${def.resource} or an alias (${prefixes.join(", ")})`,
      );
    }
    void ok;
  }
  const page_ids = new Set<string>();
  for (const p of def.pages ?? []) {
    if (page_ids.has(p.id)) throw new Error(`Duplicate page id: ${p.id}`);
    page_ids.add(p.id);
  }
  return {
    resource: def.resource,
    aliases: def.aliases,
    labels: def.labels,
    routes: def.routes,
    tables: def.tables,
    pages: def.pages,
    menu: def.menu,
  };
}

export type BuildCtxOptions = {
  req: Request;
  url: URL;
  path: string;
  method: string;
  params: Record<string, string>;
  identity: KirletIdentity | null;
  data: KirletDataClient;
  nox: NoxServices;
  files: KirletFileStore;
};

export function build_kirlet_ctx(opts: BuildCtxOptions): KirletCtx {
  const { req, url, path, method, params, identity, data, nox, files } = opts;
  return {
    req,
    url,
    path,
    method,
    params,
    query: url.searchParams,
    list_query: () => parse_list_query(url.searchParams),
    body: async <T = unknown>() => {
      const text = await req.text();
      if (!text) return {} as T;
      return JSON.parse(text) as T;
    },
    multipart: () => read_multipart(req),
    identity,
    actor: identity?.email ?? null,
    data,
    repo: <T extends DomainRow = DomainRow>(table: string, pk = "id") =>
      new Repo<T>(data, table, pk),
    nox,
    files,
    json: (d, status = 200) => json_response(d, status),
    created: (d) => json_response({ data: d }, 201),
    fail: (code, message, status = 400, extra) =>
      error_response(code, message, status, extra),
    not_found: (p) => not_found_response(p ?? path),
  };
}

/** Normalize handler return to Response. */
export function normalize_handler_result(
  result: RouteHandlerResult,
  path: string,
): Response {
  if (result instanceof Response) return result;
  if (result === null || result === undefined) {
    return new Response(null, { status: 204 });
  }
  if (
    typeof result === "object" &&
    result !== null &&
    ("data" in result || "error" in result)
  ) {
    return json_response(result);
  }
  return json_response({ data: result });
}

export function match_module_routes(
  modules: KirletModuleDef[],
  method: string,
  path: string,
):
  | {
      ok: true;
      module: KirletModuleDef;
      route: KirletRouteTable[number];
      params: Record<string, string>;
      wildcard?: string;
    }
  | { ok: false; reason: "miss" }
  | { ok: false; reason: "method_mismatch"; allowed: string[] } {
  const all: Array<{
    compiled: CompiledRoute;
    module: KirletModuleDef;
    route: KirletRouteTable[number];
  }> = [];
  for (const mod of modules) {
    for (const route of mod.routes) {
      all.push({ compiled: route.compiled, module: mod, route });
    }
  }
  const hit = match_route_table(all, method, path);
  if (!hit.ok) return hit;
  const entry = all[hit.index]!;
  return {
    ok: true,
    module: entry.module,
    route: entry.route,
    params: hit.params,
    wildcard: hit.wildcard,
  };
}

/** Helper for typed handlers when inference is weak. */
export type ParamsOf<P extends string> = ParamsOfPattern<P>;

// (o-----------------------------------------------------------/\-----o)
//   #endregion DEFINE MODULE / ROUTES
// (o==================================================================o)
