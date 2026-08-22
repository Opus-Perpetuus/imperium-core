// (o==================================================================o)
//   #region HTTP KIRLET DATA CLIENT (NOX-mediated)
// (o-----------------------------------------------------------\/-----o)

import {
  KirletDataClient,
  type DomainRow,
  type FindManyOptions,
  type WhereClause,
} from "./data-client.js";

export interface HttpKirletDataClientOptions {
  /** Base URL of NOX API, e.g. http://kirel-nox-api:3000 */
  baseUrl: string;
  technicalId: string;
  gatewaySecret: string;
  fetchImpl?: typeof fetch;
  /**
   * Per-request deadline for headers + body. Without this a hung NOX data
   * plane pins the kirlet forever (sync sweeps issue tens of thousands of
   * these calls). Default 30s.
   */
  timeout_ms?: number;
}

/** Default deadline for NOX data-plane calls (headers + body). */
export const HTTP_KIRLET_DATA_TIMEOUT_MS = 30_000;

type DataRequest =
  | { op: "findMany"; table: string; opts?: FindManyOptions }
  | { op: "findOne"; table: string; where: WhereClause }
  | { op: "insert"; table: string; row: DomainRow }
  | { op: "update"; table: string; where: WhereClause; patch: DomainRow }
  | { op: "delete"; table: string; where: WhereClause }
  | {
      op: "count";
      table: string;
      where?: WhereClause;
      search?: { fields: string[]; q: string };
    }
  | { op: "batch"; ops: DataRequest[] };

/**
 * Talks to NOX internal kirlet data API.
 * Auth: shared gateway secret + technical id. Never opens a database.
 */
export class HttpKirletDataClient extends KirletDataClient {
  private readonly baseUrl: string;
  private readonly technicalId: string;
  private readonly gatewaySecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeout_ms: number;

  constructor(opts: HttpKirletDataClientOptions) {
    super();
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.technicalId = opts.technicalId;
    this.gatewaySecret = opts.gatewaySecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeout_ms = opts.timeout_ms ?? HTTP_KIRLET_DATA_TIMEOUT_MS;
  }

  private async call<T>(body: DataRequest): Promise<T> {
    const ns = this.technicalId.startsWith("subject-") ? "subjects" : "kirlets";
    const url = `${this.baseUrl}/api/${ns}/data/${encodeURIComponent(this.technicalId)}`;
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
                  `Kirlet data API timeout after ${this.timeout_ms}ms`,
                ),
              );
            }, this.timeout_ms);
          })
        : null;

    try {
      const work = (async () => {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-nox-kirlet-gateway-secret": this.gatewaySecret,
            "x-nox-kirlet-id": this.technicalId,
          },
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Kirlet data API ${res.status}: ${text.slice(0, 500) || res.statusText}`,
          );
        }
        const json = (await res.json()) as { data?: T; error?: string };
        if (json.error) throw new Error(json.error);
        return json.data as T;
      })();
      return deadline ? await Promise.race([work, deadline]) : await work;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  override findMany(table: string, opts?: FindManyOptions): Promise<DomainRow[]> {
    return this.call({ op: "findMany", table, opts });
  }

  override findOne(table: string, where: WhereClause): Promise<DomainRow | null> {
    return this.call({ op: "findOne", table, where });
  }

  override insert(table: string, row: DomainRow): Promise<DomainRow> {
    return this.call({ op: "insert", table, row });
  }

  override update(
    table: string,
    where: WhereClause,
    patch: DomainRow,
  ): Promise<DomainRow | null> {
    return this.call({ op: "update", table, where, patch });
  }

  override delete(table: string, where: WhereClause): Promise<number> {
    return this.call({ op: "delete", table, where });
  }

  override count(
    table: string,
    where?: WhereClause,
    search?: { fields: string[]; q: string },
  ): Promise<number> {
    return this.call({ op: "count", table, where, search });
  }

  override async batch(ops: Array<Record<string, unknown>>): Promise<unknown[]> {
    return this.call({ op: "batch", ops: ops as DataRequest[] });
  }

  /**
   * Queue write ops inside the callback and flush as a single atomic batch.
   * Reads still go immediately (not transactional across reads).
   */
  override async transaction<T>(
    fn: (tx: KirletDataClient) => Promise<T>,
  ): Promise<T> {
    const queued: DataRequest[] = [];
    const self = this;
    const proxy = new Proxy(this, {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return async (table: string, row: DomainRow) => {
            queued.push({ op: "insert", table, row });
            return row;
          };
        }
        if (prop === "update") {
          return async (
            table: string,
            where: WhereClause,
            patch: DomainRow,
          ) => {
            queued.push({ op: "update", table, where, patch });
            return { ...patch };
          };
        }
        if (prop === "delete") {
          return async (table: string, where: WhereClause) => {
            queued.push({ op: "delete", table, where });
            return 1;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as KirletDataClient;

    const result = await fn(proxy);
    if (queued.length) {
      await self.batch(queued as unknown as Array<Record<string, unknown>>);
    }
    return result;
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion HTTP KIRLET DATA CLIENT
// (o==================================================================o)
