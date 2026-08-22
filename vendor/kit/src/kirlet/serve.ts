// (o==================================================================o)
//   #region SERVE KIRLET (runtime shell)
// (o-----------------------------------------------------------\/-----o)

import type { KirletDefinition } from "./define-kirlet.js";
import { qualify_history_resource } from "./define-kirlet.js";
import {
  build_kirlet_ctx,
  match_module_routes,
  normalize_handler_result,
  type KirletCtx,
} from "./define-module.js";
import { to_error_response, KirletHttpError } from "./errors.js";
import {
  json_response,
  error_response,
  not_found_response,
  method_not_allowed_response,
} from "./http.js";
import { MemoryKirletDataClient } from "./memory-data-client.js";
import { HttpKirletDataClient } from "./http-data-client.js";
import type { KirletDataClient } from "./data-client.js";
import { MemoryNoxServices } from "./memory-nox-services.js";
import { HttpNoxServices } from "./http-nox-services.js";
import type { NoxServices } from "./nox-services.js";
import {
  FsKirletFileStore,
  MemoryKirletFileStore,
  type KirletFileStore,
} from "./file-store.js";
import { resolve_kirlet_config, type KirletRuntimeConfig } from "./runtime-config.js";
import {
  resolve_identity,
  require_access,
  method_to_action,
  is_meta_path,
  actor_from,
} from "./runtime-auth.js";
import type { KirletIdentity } from "./identity.types.js";

/** Default per-job deadline; a hung tick used to pin `job_running` forever. */
export const DEFAULT_JOB_TIMEOUT_MS = 20 * 60_000;

export type ServeKirletOptions = {
  /** Override env-derived config. */
  config?: Partial<KirletRuntimeConfig> & {
    env?: Record<string, string | undefined>;
  };
  data?: KirletDataClient;
  nox?: NoxServices;
  files?: KirletFileStore;
  /** Do not call Bun.serve / listen (tests). */
  no_listen?: boolean;
  /**
   * Watchdog deadline for a single job tick. When exceeded, `job_running` is
   * cleared so the next interval can run. Default 20 min; `0` disables.
   */
  job_timeout_ms?: number;
};

export type KirletServer = {
  definition: KirletDefinition;
  config: KirletRuntimeConfig;
  data: KirletDataClient;
  nox: NoxServices;
  files: KirletFileStore;
  fetch: (req: Request) => Promise<Response>;
  stop: () => void;
  port?: number;
};

type HistoryNox = NoxServices & {
  _slug?: string;
};

function wrap_history_with_slug(nox: NoxServices, slug: string): NoxServices {
  const inner = nox.history;
  return {
    ...nox,
    history: {
      append: (entry) =>
        inner.append({
          ...entry,
          resource: qualify_history_resource(slug, entry.resource),
        }),
      list: (query) => {
        const q = { ...query };
        if (q.resource) {
          q.resource = qualify_history_resource(slug, q.resource);
        }
        if (!q.resource_prefix) {
          q.resource_prefix = `kirlet.${slug}.`;
        }
        return inner.list(q);
      },
    },
  } satisfies HistoryNox;
}

function wire_runtime(
  definition: KirletDefinition,
  opts?: ServeKirletOptions,
): {
  config: KirletRuntimeConfig;
  data: KirletDataClient;
  nox: NoxServices;
  files: KirletFileStore;
} {
  const base = resolve_kirlet_config({
    default_technical_id: definition.technical_id,
    env: opts?.config?.env,
  });
  const config: KirletRuntimeConfig = {
    ...base,
    ...opts?.config,
    technical_id: opts?.config?.technical_id ?? definition.technical_id,
  };
  // drop non-config keys
  delete (config as { env?: unknown }).env;

  let data = opts?.data;
  if (!data) {
    if (config.data_mode === "http" && config.nox_data_url) {
      const origin = config.nox_data_url.replace(/\/api\/kirlets\/data\/.*$/, "");
      data = new HttpKirletDataClient({
        baseUrl: origin || config.nox_data_url,
        technicalId: config.technical_id,
        gatewaySecret: config.gateway_secret,
      });
    } else {
      data = new MemoryKirletDataClient(definition.schema());
    }
  }

  let nox = opts?.nox;
  if (!nox) {
    if (config.data_mode === "http" && config.nox_data_url) {
      const origin = config.nox_data_url.replace(/\/api\/kirlets\/data\/.*$/, "");
      nox = new HttpNoxServices({
        baseUrl: origin || config.nox_data_url,
        technicalId: config.technical_id,
        gatewaySecret: config.gateway_secret,
      });
    } else {
      nox = new MemoryNoxServices();
    }
  }
  nox = wrap_history_with_slug(nox, definition.slug);

  let files = opts?.files;
  if (!files) {
    if (config.auth_disabled && config.data_mode === "memory") {
      files = new MemoryKirletFileStore();
    } else {
      try {
        files = new FsKirletFileStore(config.files_dir);
      } catch {
        files = new MemoryKirletFileStore();
      }
    }
  }

  return { config, data, nox, files };
}

async function handle_meta(
  definition: KirletDefinition,
  path: string,
  method: string,
  req: Request,
  identity: KirletIdentity | null,
  data: KirletDataClient,
  nox: NoxServices,
  files: KirletFileStore,
  seed_state: { promise: Promise<unknown> | null; done: boolean },
): Promise<Response | null> {
  if (path === "/" || path === "") {
    return json_response({
      service: definition.technical_id,
      name: definition.input.name,
      version: definition.manifest().version,
    });
  }
  if (path === "/health" || path === "/health/") {
    return json_response({
      status: "ok",
      service: definition.technical_id,
      ready: true,
      time: new Date().toISOString(),
    });
  }
  if (path === "/manifest" || path === "/manifest/") {
    return json_response(definition.manifest());
  }
  if (path === "/schema" || path === "/schema/") {
    return json_response(definition.schema());
  }
  if (path === "/menu" || path === "/menu/") {
    return json_response({ data: definition.manifest().menu ?? [] });
  }
  if (path === "/pages" || path === "/pages/") {
    const pages = definition.manifest().pages ?? [];
    return json_response({ data: pages });
  }
  if (path.startsWith("/pages/")) {
    const id = decodeURIComponent(path.slice("/pages/".length).split("/")[0] ?? "");
    for (const mod of definition.modules) {
      for (const p of mod.pages ?? []) {
        if (p.id === id) {
          const url = new URL(req.url);
          // Awaited: pages may read their own domain tables while building.
          const page = await p.build({ url, identity, data, nox, files });
          return json_response(page);
        }
      }
    }
    return not_found_response(path);
  }
  if ((path === "/seed" || path === "/seed/") && method === "POST") {
    if (!definition.seed) {
      return json_response({ data: { seeded: false, reason: "no_seed" } });
    }
    if (seed_state.done) {
      return json_response({ data: { seeded: true, idempotent: true } });
    }
    if (!seed_state.promise) {
      seed_state.promise = Promise.resolve(
        definition.seed({
          data,
          nox,
          technical_id: definition.technical_id,
        }),
      )
        .then(() => {
          seed_state.done = true;
        })
        .catch((e) => {
          seed_state.promise = null;
          throw e;
        });
    }
    try {
      await seed_state.promise;
      return json_response({ data: { seeded: true } });
    } catch (e) {
      return to_error_response(e);
    }
  }
  return null;
}

/**
 * Create a kirlet HTTP handler (and optionally listen).
 * Uses globalThis Bun.serve when available and no_listen is false.
 */
export function serve_kirlet(
  definition: KirletDefinition,
  opts?: ServeKirletOptions,
): KirletServer {
  const { config, data, nox, files } = wire_runtime(definition, opts);
  const seed_state = { promise: null as Promise<unknown> | null, done: false };
  const job_running = new Set<string>();
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // boot-seed with retry (non-blocking)
  if (definition.seed && config.seed_demo) {
    void (async () => {
      for (let i = 0; i < 30; i++) {
        try {
          if (!seed_state.done) {
            await definition.seed!({
              data,
              nox,
              technical_id: definition.technical_id,
            });
            seed_state.done = true;
          }
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }

  // jobs — watchdog frees `job_running` if a tick never settles (H2).
  const job_timeout_ms = opts?.job_timeout_ms ?? DEFAULT_JOB_TIMEOUT_MS;
  for (const job of definition.jobs ?? []) {
    const t = setInterval(() => {
      if (job_running.has(job.id)) return;
      job_running.add(job.id);
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const work = Promise.resolve(
        job.run({ data, nox, technical_id: definition.technical_id }),
      );
      const guarded =
        job_timeout_ms > 0
          ? Promise.race([
              work.finally(() => {
                if (watchdog) clearTimeout(watchdog);
              }),
              new Promise<void>((_, reject) => {
                watchdog = setTimeout(() => {
                  reject(
                    new Error(
                      `job ${job.id} watchdog timeout after ${job_timeout_ms}ms`,
                    ),
                  );
                }, job_timeout_ms);
                if (watchdog && typeof watchdog === "object" && "unref" in watchdog) {
                  (watchdog as { unref: () => void }).unref();
                }
              }),
            ])
          : work;
      void guarded
        .catch((e) => {
          console.error(`[${definition.technical_id}] job ${job.id} failed`, e);
        })
        .finally(() => {
          job_running.delete(job.id);
        });
    }, job.every_ms);
    if (t && typeof t === "object" && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
    timers.push(t);
  }

  const fetch_handler = async (req: Request): Promise<Response> => {
    const started = Date.now();
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();
    let status = 500;

    try {
      const id_result = resolve_identity(req, path, {
        technical_id: config.technical_id,
        gateway_secret: config.gateway_secret,
        auth_disabled: config.auth_disabled,
      });
      if (!id_result.ok) {
        status = id_result.response.status;
        return id_result.response;
      }
      const identity = id_result.identity;

      if (is_meta_path(path) || path === "/seed") {
        const meta = await handle_meta(
          definition,
          path,
          method,
          req,
          identity,
          data,
          nox,
          files,
          seed_state,
        );
        if (meta) {
          status = meta.status;
          return meta;
        }
      }

      const match = match_module_routes(definition.modules, method, path);
      if (!match.ok) {
        if (match.reason === "method_mismatch") {
          status = 405;
          return method_not_allowed_response(match.allowed);
        }
        status = 404;
        return not_found_response(path);
      }

      const { module: mod, route, params } = match;

      // access control: public_access routes are allowlisted by the gateway;
      // kirlet skips grant checks (identity still resolved for handlers).
      if (!route.public_access) {
        if (!route.raw || route.access) {
          const action = method_to_action(method);
          const denied = require_access(
            identity,
            definition.slug,
            mod.resource,
            action,
            { auth_disabled: config.auth_disabled },
          );
          if (denied) {
            status = denied.status;
            return denied;
          }
        }
      }

      if (route.raw) {
        const raw_handler = route.handler as (
          req: Request,
          meta: {
            url: URL;
            params: Record<string, string>;
            identity: KirletIdentity | null;
            path: string;
            method: string;
            data: KirletDataClient;
            nox: NoxServices;
            files: KirletFileStore;
          },
        ) => Promise<Response> | Response;
        const res = await raw_handler(req, {
          url,
          params,
          identity,
          path,
          method,
          data,
          nox,
          files,
        });
        status = res.status;
        return res;
      }

      const ctx: KirletCtx = build_kirlet_ctx({
        req,
        url,
        path,
        method,
        params,
        identity,
        data,
        nox,
        files,
      });
      // ensure actor helper consistency
      void actor_from;

      const handler = route.handler as (ctx: KirletCtx) => Promise<unknown>;
      const result = await handler(ctx);
      const res = normalize_handler_result(result as never, path);
      status = res.status;
      return res;
    } catch (e) {
      const res = to_error_response(e);
      status = res.status;
      return res;
    } finally {
      const duration_ms = Date.now() - started;
      nox.logs.record({
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        message: `${method} ${path} ${status}`,
        path,
        method,
        status,
        duration_ms,
      });
      // structured JSON log line
      console.log(
        JSON.stringify({
          msg: "kirlet_request",
          service: definition.technical_id,
          method,
          path,
          status,
          duration_ms,
        }),
      );
    }
  };

  let port: number | undefined;
  let stop_listen: (() => void) | undefined;

  if (!opts?.no_listen) {
    const bun = (globalThis as { Bun?: { serve: (opts: {
      port: number;
      fetch: (req: Request) => Promise<Response>;
    }) => { port: number; stop: () => void } } }).Bun;
    if (bun?.serve) {
      const server = bun.serve({
        port: config.port,
        fetch: fetch_handler,
      });
      port = server.port;
      stop_listen = () => server.stop();
      console.log(
        `${definition.technical_id} listening on http://0.0.0.0:${port}`,
      );
    }
  }

  return {
    definition,
    config,
    data,
    nox,
    files,
    fetch: fetch_handler,
    port,
    stop: () => {
      for (const t of timers) clearInterval(t);
      stop_listen?.();
      if (nox instanceof HttpNoxServices) nox.dispose();
    },
  };
}

/**
 * Test helper: memory data + memory nox, no listen.
 */
export function create_kirlet_test_context(
  definition: KirletDefinition,
  overrides?: {
    data?: KirletDataClient;
    nox?: NoxServices;
    files?: KirletFileStore;
    auth_disabled?: boolean;
    gateway_secret?: string;
  },
): KirletServer {
  const data =
    overrides?.data ?? new MemoryKirletDataClient(definition.schema());
  const nox = overrides?.nox ?? new MemoryNoxServices();
  const files = overrides?.files ?? new MemoryKirletFileStore();
  return serve_kirlet(definition, {
    no_listen: true,
    data,
    nox,
    files,
    config: {
      auth_disabled: overrides?.auth_disabled ?? true,
      gateway_secret: overrides?.gateway_secret ?? "",
      technical_id: definition.technical_id,
      data_mode: "memory",
      port: 0,
      data_dir: "/tmp",
      files_dir: "/tmp/files",
      kirlet_auth: "off",
      nox_data_url: null,
      seed_demo: false,
      api_base: `api://m/${definition.technical_id}`,
    },
  });
}

export { KirletHttpError };

// (o-----------------------------------------------------------/\-----o)
//   #endregion SERVE KIRLET
// (o==================================================================o)
