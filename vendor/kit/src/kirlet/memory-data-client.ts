// (o==================================================================o)
//   #region MEMORY KIRLET DATA CLIENT
// (o-----------------------------------------------------------\/-----o)

import type { KirletSchemaBundle } from "./schema.js";
import {
  KirletDataClient,
  type DomainRow,
  type FindManyOptions,
  type WhereClause,
  type WhereValue,
} from "./data-client.js";

function match_where(row: DomainRow, where?: WhereClause): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const val = row[key];
    if (!match_value(val, cond)) return false;
  }
  return true;
}

function match_value(val: unknown, cond: WhereValue): boolean {
  if (cond === null) return val === null || val === undefined;
  if (
    typeof cond === "string" ||
    typeof cond === "number" ||
    typeof cond === "boolean"
  ) {
    return val === cond;
  }
  if (typeof cond === "object" && cond !== null) {
    if ("in" in cond) return (cond.in as unknown[]).includes(val as never);
    if ("ne" in cond) return val !== cond.ne;
    if ("gt" in cond) return (val as number | string) > cond.gt;
    if ("gte" in cond) return (val as number | string) >= cond.gte;
    if ("lt" in cond) return (val as number | string) < cond.lt;
    if ("lte" in cond) return (val as number | string) <= cond.lte;
    if ("like" in cond) {
      // Escape regex metacharacters first so a literal `|` in tag delimiters
      // (or any other special char) is not treated as alternation.
      const pattern = String(cond.like)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*")
        .replace(/_/g, ".");
      return new RegExp(`^${pattern}$`, "i").test(String(val ?? ""));
    }
    if ("isNull" in cond) return val === null || val === undefined;
    if ("isNotNull" in cond) return val !== null && val !== undefined;
  }
  return false;
}

function match_search(
  row: DomainRow,
  search?: { fields: string[]; q: string },
): boolean {
  if (!search?.q?.trim()) return true;
  const q = search.q.trim().toLowerCase();
  return search.fields.some((f) =>
    String(row[f] ?? "")
      .toLowerCase()
      .includes(q),
  );
}

/**
 * In-process store for unit tests and standalone kirlet boot without NOX.
 * Applies the same schema tables as empty collections (no SQL, no files).
 */
export class MemoryKirletDataClient extends KirletDataClient {
  private readonly tables = new Map<string, DomainRow[]>();

  constructor(schema?: KirletSchemaBundle) {
    super();
    if (schema) {
      for (const t of schema.tables) {
        this.tables.set(t.name, []);
      }
    }
  }

  ensure_table(name: string): DomainRow[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  /** Test helper: wipe one or all tables. */
  clear(table?: string): void {
    if (table) {
      this.tables.set(table, []);
    } else {
      for (const k of this.tables.keys()) this.tables.set(k, []);
    }
  }

  /** Test helper: seed rows. */
  seed(table: string, rows: DomainRow[]): void {
    this.tables.set(
      table,
      rows.map((r) => ({ ...r })),
    );
  }

  override async findMany(
    table: string,
    opts: FindManyOptions = {},
  ): Promise<DomainRow[]> {
    let rows = this.ensure_table(table).filter(
      (r) => match_where(r, opts.where) && match_search(r, opts.search),
    );
    if (opts.orderBy) {
      const entries = Object.entries(opts.orderBy);
      rows = [...rows].sort((a, b) => {
        for (const [col, dir] of entries) {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av === bv) continue;
          const cmp = av < bv ? -1 : 1;
          return dir === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    }
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? rows.length;
    return rows.slice(offset, offset + limit).map((r) => ({ ...r }));
  }

  override async findOne(
    table: string,
    where: WhereClause,
  ): Promise<DomainRow | null> {
    const rows = await this.findMany(table, { where, limit: 1 });
    return rows[0] ?? null;
  }

  override async insert(table: string, row: DomainRow): Promise<DomainRow> {
    const copy = { ...row };
    this.ensure_table(table).push(copy);
    return { ...copy };
  }

  override async update(
    table: string,
    where: WhereClause,
    patch: DomainRow,
  ): Promise<DomainRow | null> {
    const rows = this.ensure_table(table);
    const idx = rows.findIndex((r) => match_where(r, where));
    if (idx < 0) return null;
    rows[idx] = { ...rows[idx], ...patch };
    return { ...rows[idx] };
  }

  override async delete(table: string, where: WhereClause): Promise<number> {
    const rows = this.ensure_table(table);
    const before = rows.length;
    const kept = rows.filter((r) => !match_where(r, where));
    this.tables.set(table, kept);
    return before - kept.length;
  }

  override async count(
    table: string,
    where?: WhereClause,
    search?: { fields: string[]; q: string },
  ): Promise<number> {
    return this.ensure_table(table).filter(
      (r) => match_where(r, where) && match_search(r, search),
    ).length;
  }

  override async batch(ops: Array<Record<string, unknown>>): Promise<unknown[]> {
    return this.transaction(async (tx) => {
      const results: unknown[] = [];
      for (const op of ops) {
        const o = op as {
          op: string;
          table?: string;
          row?: DomainRow;
          where?: WhereClause;
          patch?: DomainRow;
          opts?: FindManyOptions;
          search?: { fields: string[]; q: string };
        };
        switch (o.op) {
          case "insert":
            results.push(await tx.insert(o.table!, o.row!));
            break;
          case "update":
            results.push(await tx.update(o.table!, o.where!, o.patch!));
            break;
          case "delete":
            results.push(await tx.delete(o.table!, o.where!));
            break;
          case "findMany":
            results.push(await tx.findMany(o.table!, o.opts));
            break;
          case "findOne":
            results.push(await tx.findOne(o.table!, o.where!));
            break;
          case "count":
            results.push(await tx.count(o.table!, o.where, o.search));
            break;
          default:
            throw new Error(`Unknown batch op: ${o.op}`);
        }
      }
      return results;
    });
  }

  override async transaction<T>(
    fn: (tx: KirletDataClient) => Promise<T>,
  ): Promise<T> {
    // Snapshot for rollback
    const snap = new Map<string, DomainRow[]>();
    for (const [k, v] of this.tables) {
      snap.set(
        k,
        v.map((r) => ({ ...r })),
      );
    }
    try {
      return await fn(this);
    } catch (err) {
      this.tables.clear();
      for (const [k, v] of snap) this.tables.set(k, v);
      throw err;
    }
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion MEMORY KIRLET DATA CLIENT
// (o==================================================================o)
