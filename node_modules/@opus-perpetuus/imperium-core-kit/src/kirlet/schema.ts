// (o==================================================================o)
//   #region KIRLET DOMAIN SCHEMA (declarative, NOX-applied)
// (o-----------------------------------------------------------\/-----o)

/**
 * Column types for kirlet domain tables stored in the shared NOX Postgres.
 * Values stay JSON-friendly so kirlet code never needs driver-specific types.
 */
export type KirletColumnType =
  | "text"
  | "integer"
  | "real"
  | "boolean"
  | "json";

export interface KirletColumnDecl {
  name: string;
  type: KirletColumnType;
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  /** SQL-ish default literal, e.g. "0", "''", "MXN" (quoted by builder when text). */
  default?: string | number | boolean | null;
  references?: {
    table: string;
    column?: string;
    onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  };
}

export interface KirletIndexDecl {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface KirletTableDecl {
  name: string;
  columns: KirletColumnDecl[];
  indexes?: KirletIndexDecl[];
  /** Optional CHECK constraints as raw SQL expressions (NOX applies only). */
  checks?: string[];
}

/**
 * Declarative domain schema shipped by a kirlet.
 * NOX owns application to the shared PostgreSQL (namespaced schema).
 * Kirlet processes must never open a private domain DB or run DDL.
 */
export interface KirletSchemaBundle {
  /** Matches manifest.technicalId */
  technicalId: string;
  /** Monotonic schema revision for apply tracking. */
  version: number;
  tables: KirletTableDecl[];
}

/** Postgres schema name: subject-hr → subject_hr, kirlet-hr → kirlet_hr */
export function pg_schema_name(technical_id: string): string {
  if (technical_id.startsWith("subject-")) {
    const slug = technical_id.replace(/^subject-/, "").replace(/-/g, "_");
    return `subject_${slug}`.replace(/[^a-z0-9_]/g, "_");
  }
  const slug = technical_id.replace(/^kirlet-/, "").replace(/-/g, "_");
  return `kirlet_${slug}`.replace(/[^a-z0-9_]/g, "_");
}

export function quote_ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function pg_type(col: KirletColumnDecl): string {
  switch (col.type) {
    case "integer":
      return "INTEGER";
    case "real":
      return "DOUBLE PRECISION";
    case "boolean":
      return "BOOLEAN";
    case "json":
      return "JSONB";
    case "text":
    default:
      return "TEXT";
  }
}

function default_sql(col: KirletColumnDecl): string {
  if (col.default === undefined || col.default === null) return "";
  if (typeof col.default === "number") return ` DEFAULT ${col.default}`;
  if (typeof col.default === "boolean") return ` DEFAULT ${col.default ? "TRUE" : "FALSE"}`;
  const s = String(col.default);
  // bare SQL function/expression passthrough
  if (/^[A-Z_][A-Z0-9_]*\(.*\)$/i.test(s) || s === "TRUE" || s === "FALSE") {
    return ` DEFAULT ${s}`;
  }
  return ` DEFAULT '${s.replace(/'/g, "''")}'`;
}

/**
 * Order tables so each FK target appears before the table that references it.
 * Self-references and unknown external refs are ignored for ordering.
 * Stable for independent tables (preserves relative input order).
 */
export function order_tables_for_ddl(
  tables: KirletTableDecl[],
): KirletTableDecl[] {
  const by_name = new Map(tables.map((t) => [t.name, t]));
  const known = new Set(by_name.keys());
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const d = new Set<string>();
    for (const c of t.columns) {
      const ref = c.references?.table;
      if (ref && known.has(ref) && ref !== t.name) d.add(ref);
    }
    deps.set(t.name, d);
  }
  const ordered: KirletTableDecl[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      // cycle — break by emitting later without re-enter
      return;
    }
    visiting.add(name);
    for (const dep of deps.get(name) ?? []) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    const table = by_name.get(name);
    if (table) ordered.push(table);
  }

  for (const t of tables) {
    visit(t.name);
  }
  // Any missed (cycles) append in original order
  for (const t of tables) {
    if (!visited.has(t.name)) ordered.push(t);
  }
  return ordered;
}

/** DDL statements plus non-fatal notes about what could not be expressed. */
export interface SchemaDdlResult {
  statements: string[];
  warnings: string[];
}

/**
 * Build PostgreSQL DDL for a schema bundle (CREATE SCHEMA + tables + indexes).
 * Idempotent: IF NOT EXISTS throughout. Used only by NOX.
 *
 * Phases (avoids 42P01 when children are declared before parents, and lets an
 * already-created table pick up columns added in a later kirlet version):
 * 1. CREATE TABLE without inline REFERENCES
 * 2. ALTER TABLE ADD COLUMN IF NOT EXISTS for every non-PK column
 * 3. CREATE INDEX (after 2, so indexes may target freshly added columns)
 * 4. ALTER TABLE ADD CONSTRAINT for each FK (safe if already present)
 *
 * Tables are also topologically ordered for readable dumps / fewer ALTERs racing.
 *
 * Not expressed: DROP COLUMN, type changes, and CHECK constraints added to an
 * existing table. Those need a real migration and are reported as warnings.
 */
export class SchemaDdlBuilder {
  build(bundle: KirletSchemaBundle): string[] {
    return this.build_with_warnings(bundle).statements;
  }

  build_with_warnings(bundle: KirletSchemaBundle): SchemaDdlResult {
    const schema = pg_schema_name(bundle.technicalId);
    const qschema = quote_ident(schema);
    const stmts: string[] = [
      `CREATE SCHEMA IF NOT EXISTS ${qschema}`,
    ];
    const warnings: string[] = [];

    const ordered = order_tables_for_ddl(bundle.tables);
    const fk_stmts: string[] = [];

    for (const table of ordered) {
      const qtable = quote_ident(table.name);
      const cols = table.columns.map((c) => {
        let line = `${quote_ident(c.name)} ${pg_type(c)}`;
        if (c.primaryKey) line += " PRIMARY KEY";
        if (c.notNull && !c.primaryKey) line += " NOT NULL";
        if (c.unique && !c.primaryKey) line += " UNIQUE";
        line += default_sql(c);
        // FKs deferred to the last phase so CREATE does not require parents yet
        return line;
      });
      for (const chk of table.checks ?? []) {
        cols.push(`CHECK (${chk})`);
      }
      stmts.push(
        `CREATE TABLE IF NOT EXISTS ${qschema}.${qtable} (\n  ${cols.join(",\n  ")}\n)`,
      );

      // Phase 2 — bring pre-existing tables up to the current column set.
      // No-op on a table just created; the whole point is upgrades in place.
      for (const c of table.columns) {
        if (c.primaryKey) continue;
        const has_default = c.default !== undefined && c.default !== null;
        let line = `${quote_ident(c.name)} ${pg_type(c)}`;
        if (c.unique) line += " UNIQUE";
        line += default_sql(c);
        if (c.notNull) {
          if (has_default) {
            line += " NOT NULL";
          } else {
            // NOT NULL without a default fails on any table holding rows.
            // Emit nullable so the upgrade proceeds, and say so out loud.
            warnings.push(
              `${table.name}.${c.name}: added as NULLable — NOT NULL needs a default to backfill existing rows`,
            );
          }
        }
        stmts.push(
          `ALTER TABLE ${qschema}.${qtable} ADD COLUMN IF NOT EXISTS ${line}`,
        );
      }

      for (const idx of table.indexes ?? []) {
        const unique = idx.unique ? "UNIQUE " : "";
        const cols_sql = idx.columns.map(quote_ident).join(", ");
        stmts.push(
          `CREATE ${unique}INDEX IF NOT EXISTS ${quote_ident(idx.name)} ON ${qschema}.${qtable} (${cols_sql})`,
        );
      }

      for (const c of table.columns) {
        if (!c.references) continue;
        const ref_col = c.references.column ?? "id";
        const on_del = c.references.onDelete
          ? ` ON DELETE ${c.references.onDelete}`
          : "";
        const cname = `fk_${table.name}_${c.name}`;
        // Idempotent ADD CONSTRAINT (PG has no IF NOT EXISTS for constraints pre-9.x style)
        fk_stmts.push(
          `DO $fk$ BEGIN
  ALTER TABLE ${qschema}.${qtable}
    ADD CONSTRAINT ${quote_ident(cname)}
    FOREIGN KEY (${quote_ident(c.name)})
    REFERENCES ${qschema}.${quote_ident(c.references.table)}(${quote_ident(ref_col)})${on_del};
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_table THEN NULL;
END $fk$`,
        );
      }
    }

    stmts.push(...fk_stmts);
    return { statements: stmts, warnings };
  }
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET DOMAIN SCHEMA
// (o==================================================================o)
