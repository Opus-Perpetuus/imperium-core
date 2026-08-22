import { describe, expect, test } from "bun:test";
import {
  SchemaDdlBuilder,
  pg_schema_name,
  type KirletSchemaBundle,
} from "./schema.js";

const sample: KirletSchemaBundle = {
  technicalId: "kirlet-hr",
  version: 1,
  tables: [
    {
      name: "departments",
      columns: [
        { name: "id", type: "text", primaryKey: true },
        { name: "name", type: "text", notNull: true, unique: true },
        { name: "is_active", type: "integer", notNull: true, default: 1 },
      ],
      indexes: [{ name: "idx_departments_active", columns: ["is_active"] }],
    },
    {
      name: "employees",
      columns: [
        { name: "id", type: "text", primaryKey: true },
        {
          name: "department_id",
          type: "text",
          references: { table: "departments", onDelete: "SET NULL" },
        },
      ],
    },
  ],
};

describe("pg_schema_name", () => {
  test("maps technical id to postgres schema", () => {
    expect(pg_schema_name("kirlet-hr")).toBe("kirlet_hr");
    expect(pg_schema_name("kirlet-tienda")).toBe("kirlet_tienda");
    expect(pg_schema_name("subject-products")).toBe("subject_products");
    expect(pg_schema_name("subject-access-rights")).toBe(
      "subject_access_rights",
    );
  });
});

describe("SchemaDdlBuilder", () => {
  test("emits CREATE SCHEMA and namespaced tables", () => {
    const stmts = new SchemaDdlBuilder().build(sample);
    expect(stmts[0]).toContain('CREATE SCHEMA IF NOT EXISTS "kirlet_hr"');
    expect(stmts.some((s) => s.includes('"kirlet_hr"."departments"'))).toBe(
      true,
    );
    // FKs are deferred to DO $$ ALTER … (not inline on CREATE TABLE)
    expect(stmts.some((s) => s.includes("ADD CONSTRAINT"))).toBe(true);
    expect(stmts.some((s) => s.includes("idx_departments_active"))).toBe(true);
  });

  test("CREATE TABLE has no inline REFERENCES (two-phase FK)", () => {
    const reversed: KirletSchemaBundle = {
      technicalId: "kirlet-tienda",
      version: 1,
      tables: [
        {
          name: "cart_items",
          columns: [
            { name: "id", type: "text", primaryKey: true },
            {
              name: "product_id",
              type: "text",
              references: { table: "products", onDelete: "CASCADE" },
            },
          ],
        },
        {
          name: "products",
          columns: [
            { name: "id", type: "text", primaryKey: true },
            { name: "title", type: "text", notNull: true },
          ],
        },
      ],
    };
    const stmts = new SchemaDdlBuilder().build(reversed);
    const creates = stmts.filter((s) => s.startsWith("CREATE TABLE"));
    for (const c of creates) {
      expect(c.includes("REFERENCES")).toBe(false);
    }
    const products_i = stmts.findIndex((s) =>
      s.includes('CREATE TABLE IF NOT EXISTS "kirlet_tienda"."products"'),
    );
    const cart_items_i = stmts.findIndex((s) =>
      s.includes('CREATE TABLE IF NOT EXISTS "kirlet_tienda"."cart_items"'),
    );
    expect(products_i).toBeGreaterThan(0);
    expect(cart_items_i).toBeGreaterThan(0);
    // FK phase after both creates
    const fk_i = stmts.findIndex((s) => s.includes("fk_cart_items_product_id"));
    expect(fk_i).toBeGreaterThan(Math.max(products_i, cart_items_i));
  });
});

describe("SchemaDdlBuilder — ADD COLUMN (in-place upgrades)", () => {
  test("emits ADD COLUMN IF NOT EXISTS for every non-PK column", () => {
    const stmts = new SchemaDdlBuilder().build(sample);
    const alters = stmts.filter((s) => s.includes("ADD COLUMN IF NOT EXISTS"));
    expect(
      alters.some((s) =>
        s.includes('"kirlet_hr"."departments" ADD COLUMN IF NOT EXISTS "name"'),
      ),
    ).toBe(true);
    expect(
      alters.some((s) => s.includes('ADD COLUMN IF NOT EXISTS "is_active"')),
    ).toBe(true);
    // Primary keys belong to CREATE TABLE only — never re-added.
    expect(alters.some((s) => s.includes('ADD COLUMN IF NOT EXISTS "id"'))).toBe(
      false,
    );
  });

  test("ADD COLUMN runs after its CREATE TABLE and before its indexes", () => {
    const stmts = new SchemaDdlBuilder().build(sample);
    const create_i = stmts.findIndex((s) =>
      s.startsWith('CREATE TABLE IF NOT EXISTS "kirlet_hr"."departments"'),
    );
    const alter_i = stmts.findIndex((s) =>
      s.includes('departments" ADD COLUMN IF NOT EXISTS "is_active"'),
    );
    const index_i = stmts.findIndex((s) =>
      s.includes("idx_departments_active"),
    );
    expect(alter_i).toBeGreaterThan(create_i);
    expect(index_i).toBeGreaterThan(alter_i);
  });

  test("carries default and NOT NULL when a default can backfill", () => {
    const stmts = new SchemaDdlBuilder().build(sample);
    const alter = stmts.find((s) =>
      s.includes('ADD COLUMN IF NOT EXISTS "is_active"'),
    );
    expect(alter).toContain("DEFAULT 1");
    expect(alter).toContain("NOT NULL");
  });

  test("drops NOT NULL when there is no default, and warns", () => {
    const bundle: KirletSchemaBundle = {
      technicalId: "kirlet-tienda",
      version: 2,
      tables: [
        {
          name: "products",
          columns: [
            { name: "id", type: "text", primaryKey: true },
            // New in v2, no default: cannot be NOT NULL on a populated table.
            { name: "description_html", type: "text", notNull: true },
          ],
        },
      ],
    };
    const { statements, warnings } = new SchemaDdlBuilder().build_with_warnings(
      bundle,
    );
    const alter = statements.find((s) =>
      s.includes('ADD COLUMN IF NOT EXISTS "description_html"'),
    );
    expect(alter).toBeDefined();
    expect(alter).not.toContain("NOT NULL");
    expect(warnings.some((w) => w.includes("products.description_html"))).toBe(
      true,
    );
  });

  test("no warnings when every NOT NULL column carries a default", () => {
    const bundle: KirletSchemaBundle = {
      technicalId: "kirlet-tienda",
      version: 1,
      tables: [
        {
          name: "carts",
          columns: [
            { name: "id", type: "text", primaryKey: true },
            { name: "name", type: "text", notNull: true, default: "Carrito" },
            { name: "is_default", type: "integer", notNull: true, default: 0 },
            { name: "note", type: "text" },
          ],
        },
      ],
    };
    expect(new SchemaDdlBuilder().build_with_warnings(bundle).warnings).toEqual(
      [],
    );
  });
});
