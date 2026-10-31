import { describe, expect, test } from "bun:test";
import {
  NOX_SUBTABLE_COMPONENT,
  combine_subtable_values,
  normalize_subtable_rows,
  parse_subtable_path,
  parse_subtable_rows,
  rows_for_path,
  serialize_subtable_rows,
  split_subtable_element,
  subtable_element_id,
  subtable_input,
  subtable_scan_append,
  subtable_search_text,
  subtable_summary,
} from "./subtable.js";
import { NOX_UI_COMPONENT_ALLOWLIST, NOX_UI_MVP_RENDER_IDS } from "./ui-descriptor.js";

describe("subtable", () => {
  test("is a renderable nox component", () => {
    expect(NOX_UI_COMPONENT_ALLOWLIST).toContain(NOX_SUBTABLE_COMPONENT);
    expect(NOX_UI_MVP_RENDER_IDS).toContain(NOX_SUBTABLE_COMPONENT);
    const node = subtable_input({
      name: "items",
      value: '[{"_id":"a","qty":"2"}]',
      columns: [{ component: "nox.input-number", props: { name: "qty" } }],
    });
    expect(node.component).toBe("nox.input-subtable");
    expect(node.props?.value).toEqual([{ _id: "a", qty: "2" }]);
  });

  test("parse is tolerant and gives every row a unique id", () => {
    const rows = parse_subtable_rows('[{"_id":"a","x":1},{"x":["p","q"]},{"_id":"a","x":{"_id":"r1"}},5,null]');
    expect(rows.map((r) => r._id)).toEqual(["a", "f2", "f3"]);
    expect(rows[1]!.x).toBe("p|q");
    expect(rows[2]!.x).toBe("r1");
    expect(parse_subtable_rows("not json")).toEqual([]);
    expect(serialize_subtable_rows([])).toBe("");
  });

  test("normalize drops computed columns and empty rows, keeps ids", () => {
    const rows = normalize_subtable_rows(
      [{ _id: "keep", name: " A ", total: "9" }, { name: "" }, { name: "B" }],
      [{ key: "name" }, { key: "total", computed: true }],
      (_c, v) => String(v ?? "").trim(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ _id: "keep", name: "A" });
    expect(rows[1]!._id).toMatch(/^f[a-z0-9]+$/);
    expect(rows[1]!.total).toBeUndefined();
  });

  test("paths and combine", () => {
    const rows = ["a", "b", "c"];
    expect(rows_for_path(rows, parse_subtable_path("qty"))).toEqual(rows);
    expect(rows_for_path(rows, parse_subtable_path("2.qty"))).toEqual(["b"]);
    expect(rows_for_path(rows, parse_subtable_path("ultima.qty"))).toEqual(["c"]);
    expect(rows_for_path(rows, parse_subtable_path("first.qty"))).toEqual(["a"]);
    expect(rows_for_path(rows, parse_subtable_path("9.qty"))).toEqual([]);
    expect(combine_subtable_values([1, 2, null, undefined])).toBe(3);
    expect(combine_subtable_values(["x", 2])).toBe("x, 2");
    expect(combine_subtable_values([])).toBeNull();
  });

  test("element ids", () => {
    expect(subtable_element_id("r1", "f2")).toBe("r1~f2");
    expect(split_subtable_element("r1~f2")).toEqual({ record: "r1", row: "f2" });
    expect(split_subtable_element("r1")).toEqual({ record: "r1", row: null });
  });

  test("scan-append merges or appends", () => {
    const base = parse_subtable_rows('[{"_id":"a","product":"P1","qty":"1"}]');
    const merged = subtable_scan_append(base, { match_column: "product", match_value: "p1", quantity_column: "qty", quantity: 2 });
    expect(merged.created).toBe(false);
    expect(merged.rows[0]!.qty).toBe("3");
    expect(base[0]!.qty).toBe("1");
    const added = subtable_scan_append(merged.rows, {
      match_column: "product",
      match_value: "P2",
      quantity_column: "qty",
      quantity: 1,
      fill: { price: "10" },
    });
    expect(added.created).toBe(true);
    expect(added.rows).toHaveLength(2);
    expect(added.row).toMatchObject({ product: "P2", qty: "1", price: "10" });
    const always = subtable_scan_append(added.rows, { match_column: "product", match_value: "P2", mode: "append" });
    expect(always.rows).toHaveLength(3);
    const minus = subtable_scan_append(base, { match_column: "product", match_value: "P1", quantity_column: "qty", op: "subtract", quantity: 1 });
    expect(minus.row.qty).toBe("0");
  });

  test("summary and search text", () => {
    const rows = parse_subtable_rows([
      { _id: "a", n: "Agua", q: "2" },
      { _id: "b", n: "Pan", q: "1" },
    ]);
    expect(subtable_summary(rows, ["n", "q"], (_c, v) => v, { max: 1, one: "fila", many: "filas" })).toBe("2 filas: Agua × 2 · …");
    expect(subtable_search_text(rows)).toBe("Agua 2 Pan 1");
  });
});
