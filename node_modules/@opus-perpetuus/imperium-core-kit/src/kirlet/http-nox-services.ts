// (o==================================================================o)
//   #region HTTP NOX SERVICES (service plane client)
// (o-----------------------------------------------------------\/-----o)

import type {
  CounterNextOptions,
  HistoryAppendInput,
  HistoryEntry,
  HistoryListQuery,
  LogRecord,
  NoxFileRef,
  NoxServices,
  NotifyInput,
} from "./nox-services.js";

/** Base64 without assuming Node's Buffer — the kit also runs under Bun/Deno. */
function to_base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // chunked so large files do not blow the argument list
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Default deadline for service-plane HTTP calls. */
export const HTTP_NOX_SERVICES_TIMEOUT_MS = 30_000;

export type HttpNoxServicesOptions = {
  /** NOX API origin, e.g. http://kirel-nox-api:3000 */
  baseUrl: string;
  technicalId: string;
  gatewaySecret: string;
  fetchImpl?: typeof fetch;
  /** Max log records before auto-flush (default 100). */
  log_batch_size?: number;
  /** Auto-flush interval ms (default 5000). */
  log_flush_ms?: number;
  /**
   * Per-request deadline. Without this a hung service-plane call can pin a
   * kirlet job forever. Default 30s; `0` disables.
   */
  timeout_ms?: number;
};

/**
 * HTTP client for NOX kirlet service plane (`/api/kirlets/svc/:tid/...`).
 * Buffers logs and flushes in batches ≤100 every 5s (or on overflow).
 */
export class HttpNoxServices implements NoxServices {
  private readonly baseUrl: string;
  private readonly technicalId: string;
  private readonly gatewaySecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log_batch_size: number;
  private readonly timeout_ms: number;
  private readonly log_buffer: LogRecord[] = [];
  private flush_timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HttpNoxServicesOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.technicalId = opts.technicalId;
    this.gatewaySecret = opts.gatewaySecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log_batch_size = opts.log_batch_size ?? 100;
    this.timeout_ms = opts.timeout_ms ?? HTTP_NOX_SERVICES_TIMEOUT_MS;
    const flush_ms = opts.log_flush_ms ?? 5_000;
    if (flush_ms > 0) {
      this.flush_timer = setInterval(() => {
        void this.logs.flush();
      }, flush_ms);
      // Allow process exit in Node/Bun without hanging on the timer
      if (
        this.flush_timer &&
        typeof this.flush_timer === "object" &&
        "unref" in this.flush_timer
      ) {
        (this.flush_timer as { unref: () => void }).unref();
      }
    }
  }

  private svc_url(suffix: string): string {
    return `${this.baseUrl}/api/kirlets/svc/${encodeURIComponent(this.technicalId)}${suffix}`;
  }

  private async call<T>(
    method: string,
    suffix: string,
    body?: unknown,
  ): Promise<T> {
    const controller =
      this.timeout_ms > 0 ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline =
      controller && this.timeout_ms > 0
        ? new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new Error(
                  `Kirlet service plane timeout after ${this.timeout_ms}ms`,
                ),
              );
            }, this.timeout_ms);
          })
        : null;

    try {
      const work = (async () => {
        const res = await this.fetchImpl(this.svc_url(suffix), {
          method,
          headers: {
            "content-type": "application/json",
            "x-nox-kirlet-gateway-secret": this.gatewaySecret,
            "x-nox-kirlet-id": this.technicalId,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller?.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Kirlet service plane ${res.status}: ${text.slice(0, 500) || res.statusText}`,
          );
        }
        if (res.status === 204) return undefined as T;
        const json = (await res.json()) as { data?: T; error?: string } & T;
        if (json && typeof json === "object" && "error" in json && json.error) {
          throw new Error(String(json.error));
        }
        if (json && typeof json === "object" && "data" in json) {
          return json.data as T;
        }
        return json as T;
      })();
      return deadline ? await Promise.race([work, deadline]) : await work;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  readonly history: NoxServices["history"] = {
    append: (entry: HistoryAppendInput) =>
      this.call<HistoryEntry>("POST", "/history", entry),
    list: async (query?: HistoryListQuery) => {
      const q = new URLSearchParams();
      if (query?.resource) q.set("resource", query.resource);
      if (query?.resource_prefix) q.set("resource_prefix", query.resource_prefix);
      if (query?.entity_id) q.set("entity_id", query.entity_id);
      if (query?.limit != null) q.set("limit", String(query.limit));
      if (query?.offset != null) q.set("offset", String(query.offset));
      const qs = q.toString();
      return this.call<HistoryEntry[]>(
        "GET",
        `/history${qs ? `?${qs}` : ""}`,
      );
    },
  };

  readonly counters: NoxServices["counters"] = {
    next: (name: string, opts?: CounterNextOptions) =>
      this.call<string>("POST", `/counters/${encodeURIComponent(name)}/next`, {
        prefix: opts?.prefix,
        pad_length: opts?.pad_length,
      }),
  };

  readonly params: NoxServices["params"] = {
    get: (key: string) =>
      this.call<unknown>("GET", `/params/${encodeURIComponent(key)}`),
    set: async (key: string, value: unknown) => {
      await this.call<void>("PUT", `/params/${encodeURIComponent(key)}`, {
        value,
      });
    },
  };

  readonly notify: NoxServices["notify"] = {
    create: (input: NotifyInput) =>
      this.call<{ id: string }>("POST", "/notify", input),
  };

  readonly logs: NoxServices["logs"] = {
    record: (entry: LogRecord): void => {
      this.log_buffer.push(entry);
      if (this.log_buffer.length >= this.log_batch_size) {
        void this.logs.flush();
      }
    },
    flush: async (): Promise<void> => {
      if (this.log_buffer.length === 0) return;
      const batch = this.log_buffer.splice(0, this.log_batch_size);
      try {
        await this.call<void>("POST", "/logs", { entries: batch });
      } catch {
        // Re-queue on failure (best-effort); drop if buffer explodes
        this.log_buffer.unshift(...batch);
        if (this.log_buffer.length > this.log_batch_size * 5) {
          this.log_buffer.length = this.log_batch_size * 5;
        }
      }
    },
  };

  readonly files: NoxServices["files"] = {
    save: async (input) => {
      // Base64 keeps the service plane on plain JSON, which is worth more here
      // than the ~33% overhead: no multipart handling on either side.
      const res = await this.call<NoxFileRef>("POST", "/files", {
        resource: input.resource,
        record_id: input.record_id,
        filename: input.filename ?? "file",
        content_type: input.content_type ?? "application/octet-stream",
        data_base64: to_base64(input.data),
      });
      return res;
    },
    list: async (query) => {
      const qs = new URLSearchParams({ resource: query.resource });
      if (query.record_id) qs.set("record_id", query.record_id);
      const res = await this.call<NoxFileRef[]>("GET", `/files?${qs.toString()}`);
      return Array.isArray(res) ? res : [];
    },
    remove: async (id: string) => {
      const res = await this.call<{ removed: boolean }>(
        "DELETE",
        `/files/${encodeURIComponent(id)}`,
      );
      return res?.removed === true;
    },
  };

  readonly html: NoxServices["html"] = {
    sanitize: async (html: string | null | undefined): Promise<string> => {
      if (!html) return "";
      const res = await this.call<{ html: string }>("POST", "/html/sanitize", {
        html: String(html),
      });
      return res?.html ?? "";
    },
    to_text: async (
      html: string | null | undefined,
      max_length?: number,
    ): Promise<string> => {
      if (!html) return "";
      const res = await this.call<{ text: string }>("POST", "/html/to-text", {
        html: String(html),
        max_length,
      });
      return res?.text ?? "";
    },
  };

  /** Stop flush timer (tests / shutdown). */
  dispose(): void {
    if (this.flush_timer) {
      clearInterval(this.flush_timer);
      this.flush_timer = null;
    }
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion HTTP NOX SERVICES
// (o==================================================================o)
