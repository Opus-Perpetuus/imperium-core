// (o==================================================================o)
//   #region KIRLET DATA CLIENT (kit-mediated, no direct DB in kirlets)
// (o-----------------------------------------------------------\/-----o)

/**
 * Filter DSL for domain table access. Kirlet authors use this instead of SQL.
 */
export type WhereValue =
  | string
  | number
  | boolean
  | null
  | { in: Array<string | number> }
  | { ne: string | number | boolean | null }
  | { gt: number | string }
  | { gte: number | string }
  | { lt: number | string }
  | { lte: number | string }
  | { like: string }
  | { isNull: true }
  | { isNotNull: true };

export type WhereClause = Record<string, WhereValue>;

export interface FindManyOptions {
  where?: WhereClause;
  /** Case-insensitive substring match across fields (OR). */
  search?: { fields: string[]; q: string };
  orderBy?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
}

export type DomainRow = Record<string, unknown>;

/**
 * Abstract data client. Production: HTTP to NOX data API.
 * Tests / offline: MemoryKirletDataClient.
 * Kirlets never open Postgres or SQLite for domain tables.
 */
export abstract class KirletDataClient {
  abstract findMany(table: string, opts?: FindManyOptions): Promise<DomainRow[]>;
  abstract findOne(table: string, where: WhereClause): Promise<DomainRow | null>;
  abstract insert(table: string, row: DomainRow): Promise<DomainRow>;
  abstract update(
    table: string,
    where: WhereClause,
    patch: DomainRow,
  ): Promise<DomainRow | null>;
  abstract delete(table: string, where: WhereClause): Promise<number>;
  /**
   * `search` takes the same shape as in `findMany` so a paginated list can
   * compute its total under the identical filter. Counting only `where` is
   * what made the storefront paginator offer pages the query could not fill.
   */
  abstract count(
    table: string,
    where?: WhereClause,
    search?: { fields: string[]; q: string },
  ): Promise<number>;

  /**
   * Run multiple mutations atomically when the backend supports it.
   * Memory client applies sequentially; HTTP client uses a single request.
   */
  abstract transaction<T>(fn: (tx: KirletDataClient) => Promise<T>): Promise<T>;

  /**
   * Execute a batch of ops (server may wrap in a single transaction).
   * Default: sequential; HTTP client overrides with `{op:"batch"}`.
   */
  async batch(ops: Array<Record<string, unknown>>): Promise<unknown[]> {
    void ops;
    throw new Error("batch not implemented on this client");
  }

  /** Convenience: upsert by primary key field (default `id`). */
  async upsert(
    table: string,
    row: DomainRow,
    pk = "id",
  ): Promise<DomainRow> {
    const key = row[pk];
    if (key === undefined || key === null) {
      return this.insert(table, row);
    }
    const existing = await this.findOne(table, { [pk]: key as string | number });
    if (existing) {
      const { [pk]: _drop, ...patch } = row;
      const updated = await this.update(table, { [pk]: key as string | number }, patch);
      return updated ?? existing;
    }
    return this.insert(table, row);
  }
}

/**
 * Typed repository for a single domain table — preferred authoring surface.
 */
export class KirletRepository<T extends DomainRow = DomainRow> {
  constructor(
    protected readonly client: KirletDataClient,
    protected readonly table: string,
    protected readonly pk: string = "id",
  ) {}

  findMany(opts?: FindManyOptions): Promise<T[]> {
    return this.client.findMany(this.table, opts) as Promise<T[]>;
  }

  findOne(where: WhereClause): Promise<T | null> {
    return this.client.findOne(this.table, where) as Promise<T | null>;
  }

  findById(id: string | number): Promise<T | null> {
    return this.findOne({ [this.pk]: id });
  }

  insert(row: T): Promise<T> {
    return this.client.insert(this.table, row) as Promise<T>;
  }

  async updateById(id: string | number, patch: Partial<T>): Promise<T | null> {
    return this.client.update(this.table, { [this.pk]: id }, patch as DomainRow) as Promise<T | null>;
  }

  update(where: WhereClause, patch: Partial<T>): Promise<T | null> {
    return this.client.update(this.table, where, patch as DomainRow) as Promise<T | null>;
  }

  delete(where: WhereClause): Promise<number> {
    return this.client.delete(this.table, where);
  }

  deleteById(id: string | number): Promise<number> {
    return this.delete({ [this.pk]: id });
  }

  count(
    where?: WhereClause,
    search?: { fields: string[]; q: string },
  ): Promise<number> {
    return this.client.count(this.table, where, search);
  }

  upsert(row: T): Promise<T> {
    return this.client.upsert(this.table, row, this.pk) as Promise<T>;
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET DATA CLIENT
// (o==================================================================o)
