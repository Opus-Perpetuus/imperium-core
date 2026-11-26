//   #region SUBTABLE (nested table input)

/**
 * Subtable: a form field whose value is a list of rows, each with its own
 * columns. Generic building block for any subject app — the app decides which
 * column types it allows; the kit owns the wire contract, the row storage
 * rules, path/aggregate reads, element references and the scan-append merge.
 *
 * Wire value: an array of rows (or its JSON text). Every cell is a string, like
 * any other form value; `_id` is stable per row so another record can point
 * at one row as `<record_id>~<row_id>` (see {@link subtable_element_id}).
 *
 * UI node: `nox.input-subtable` (see {@link subtable_input}). Its `columns`
 * are ordinary `nox.input-*` nodes (`props.name` = column key); the host
 * renders one of them per cell, so a column can be any input the host knows.
 * A column with `props.computed: true` is read-only (the app recalculates it).
 */

import type { NoxUiNode } from "./ui-descriptor.js";

export const NOX_SUBTABLE_COMPONENT = "nox.input-subtable";

/** Hard cap on rows per subtable value (keeps one record bounded). */
export const SUBTABLE_MAX_ROWS = 500;

/** Separates record and row in a reference to one row: `<record>~<row>`. */
export const SUBTABLE_ELEMENT_SEPARATOR = "~";

export type SubtableRow = { _id: string } & Record<string, string>;

/**
 * What a reference to another record's subtable selects:
 * - `whole`: the record (and with it the entire subtable).
 * - `element`: one row of it (`<record>~<row>`).
 */
export type SubtableRefMode = "whole" | "element";
export const SUBTABLE_REF_MODES: readonly SubtableRefMode[] = ["whole", "element"];

export type SubtableInputProps = {
  name: string;
  label?: string;
  help?: string;
  required?: boolean;
  read_only?: boolean;
  /** Rows (array or JSON text). */
  value?: readonly SubtableRow[] | string;
  /** One `nox.input-*` node per column; `props.name` is the column key. */
  columns: NoxUiNode[];
  min_rows?: number;
  max_rows?: number;
  add_label?: string;
  empty_text?: string;
};

/** Builds the `nox.input-subtable` node. */
export function subtable_input(props: SubtableInputProps): NoxUiNode {
  const value =
    typeof props.value === "string" ? parse_subtable_rows(props.value) : [...(props.value ?? [])];
  return {
    component: NOX_SUBTABLE_COMPONENT,
    props: { ...props, value },
  } as NoxUiNode;
}

const ROW_ID = /^[A-Za-z0-9_-]{1,40}$/;

function cell_text(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(cell_text).filter(Boolean).join("|");
  if (typeof v === "object") {
    const o = v as { _id?: unknown; value?: unknown };
    const id = o._id ?? o.value;
    return id == null ? "" : String(id).trim();
  }
  return String(v).trim();
}

function raw_rows(raw: unknown): Record<string, unknown>[] {
  let v = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try {
      v = JSON.parse(t);
    } catch {
      return [];
    }
  }
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
    : [];
}

const PARSE_CACHE = new Map<string, readonly SubtableRow[]>();
const PARSE_CACHE_MAX = 1000;

/**
 * Stored rows (JSON text or array) → rows. Tolerant: non-rows are dropped and
 * a row without a valid/unique `_id` gets one from its position. Do not mutate
 * the result: text input is served from a shared cache.
 */
export function parse_subtable_rows(raw: unknown, max_rows = SUBTABLE_MAX_ROWS): readonly SubtableRow[] {
  const key = typeof raw === "string" ? `${max_rows}\u0000${raw}` : null;
  if (key !== null) {
    const hit = PARSE_CACHE.get(key);
    if (hit) return hit;
  }
  const seen = new Set<string>();
  const rows = raw_rows(raw)
    .slice(0, max_rows)
    .map((o, i) => {
      let id = cell_text(o._id);
      if (!ROW_ID.test(id) || seen.has(id)) id = `f${i + 1}`;
      while (seen.has(id)) id = `${id}_`;
      seen.add(id);
      const row: SubtableRow = { _id: id };
      for (const [k, v] of Object.entries(o)) if (k !== "_id") row[k] = cell_text(v);
      return row;
    });
  if (key !== null) {
    if (PARSE_CACHE.size >= PARSE_CACHE_MAX) PARSE_CACHE.delete(PARSE_CACHE.keys().next().value!);
    PARSE_CACHE.set(key, rows);
  }
  return rows;
}

/** Rows → stored text; no rows is the empty string. */
export function serialize_subtable_rows(rows: readonly SubtableRow[]): string {
  return rows.length ? JSON.stringify(rows) : "";
}

/** A row `_id` not in `existing`. */
export function new_subtable_row_id(existing: Iterable<string>): string {
  const used = new Set(existing);
  for (;;) {
    const id = `f${Math.random().toString(36).slice(2, 10)}`;
    if (!used.has(id)) return id;
  }
}

export type SubtableColumnRule = { key: string; computed?: boolean };

/**
 * Form value → storable rows: each captured cell goes through `normalize_cell`
 * (the app's per-type rule; it may throw to reject), computed columns are not
 * stored, empty rows are dropped and every row keeps or gets a unique `_id`.
 */
export function normalize_subtable_rows<C extends SubtableColumnRule>(
  raw: unknown,
  columns: readonly C[],
  normalize_cell: (column: C, value: unknown) => string,
  max_rows = SUBTABLE_MAX_ROWS,
): SubtableRow[] {
  const list = raw_rows(raw);
  if (list.length > max_rows) throw new Error(`At most ${max_rows} rows`);
  const captured = columns.filter((c) => !c.computed);
  const seen = new Set<string>();
  const out: SubtableRow[] = [];
  for (const o of list) {
    const row: Record<string, string> = {};
    for (const c of captured) {
      const v = normalize_cell(c, o[c.key]);
      if (v !== "") row[c.key] = v;
    }
    if (!Object.keys(row).length) continue;
    let id = cell_text(o._id);
    if (!ROW_ID.test(id) || seen.has(id)) id = "";
    if (id) seen.add(id);
    out.push({ ...row, _id: id } as SubtableRow);
  }
  for (const r of out) {
    if (!r._id) {
      r._id = new_subtable_row_id(seen);
      seen.add(r._id);
    }
  }
  return out;
}

//   #region paths & aggregates

/** Which rows a path reads: all, first, last or the n-th (1-based). */
export type SubtablePath = { row: "all" | "first" | "last" | number; column: string };

/**
 * `qty` → all rows; `2.qty` → second row; `first.qty` / `last.qty` (also the
 * Spanish `primera` / `ultima`) → one row.
 */
export function parse_subtable_path(path: string): SubtablePath {
  const dot = path.indexOf(".");
  if (dot > 0) {
    const head = path
      .slice(0, dot)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .trim()
      .toLowerCase();
    const column = path.slice(dot + 1);
    if (/^[0-9]+$/.test(head)) return { row: Number(head), column };
    if (head === "first" || head === "primera") return { row: "first", column };
    if (head === "last" || head === "ultima") return { row: "last", column };
  }
  return { row: "all", column: path };
}

export function rows_for_path<T>(rows: readonly T[], path: SubtablePath): T[] {
  if (path.row === "all") return [...rows];
  const i = path.row === "first" ? 0 : path.row === "last" ? rows.length - 1 : path.row - 1;
  const r = rows[i];
  return r === undefined ? [] : [r];
}

export type SubtableScalar = string | number | null;

/** Many cells as one value: the sum if all are numbers, otherwise joined with `, `. */
export function combine_subtable_values(values: readonly (SubtableScalar | undefined)[]): SubtableScalar {
  const full = values.filter((v): v is string | number => v !== undefined && v !== null && v !== "");
  if (!full.length) return null;
  if (full.length === 1) return full[0]!;
  if (full.every((v) => typeof v === "number")) return (full as number[]).reduce((a, b) => a + b, 0);
  return full.map((v) => String(v)).filter(Boolean).join(", ");
}

//   #endregion paths & aggregates

//   #region element references

export function subtable_element_id(record_id: string, row_id: string): string {
  return `${record_id}${SUBTABLE_ELEMENT_SEPARATOR}${row_id}`;
}

/** `<record>~<row>` → parts; without the separator it is a whole record. */
export function split_subtable_element(value: string): { record: string; row: string | null } {
  const i = value.indexOf(SUBTABLE_ELEMENT_SEPARATOR);
  return i > 0 ? { record: value.slice(0, i), row: value.slice(i + 1) || null } : { record: value, row: null };
}

//   #endregion element references

//   #region scan-append

export type SubtableQuantityOp = "add" | "subtract" | "set";

export type SubtableScanAppend = {
  /** Column compared against `match_value`; without it every scan appends a row. */
  match_column?: string | null;
  match_value?: string;
  /** `merge`: bump the matching row; `append`: always a new row. */
  mode?: "merge" | "append";
  /** Numeric column that receives `quantity`. */
  quantity_column?: string | null;
  quantity?: number;
  op?: SubtableQuantityOp;
  /** Cells written on a NEW row (match column included automatically). */
  fill?: Record<string, string>;
  /** Cell comparison; default: trimmed, case-insensitive, or any of `|`-separated ids. */
  matches?: (cell: string, value: string) => boolean;
  max_rows?: number;
};

export type SubtableScanResult = {
  rows: SubtableRow[];
  row: SubtableRow;
  created: boolean;
};

function default_matches(cell: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return cell.split("|").some((part) => part.trim().toLowerCase() === v);
}

function apply_quantity(current: string, op: SubtableQuantityOp, qty: number): string {
  const base = Number(String(current ?? "").replace(",", "."));
  const b = Number.isFinite(base) && String(current ?? "").trim() !== "" ? base : 0;
  const r = op === "add" ? b + qty : op === "subtract" ? b - qty : qty;
  return String(Math.round(r * 1e6) / 1e6);
}

/**
 * A scanned item into a subtable: in `merge` mode the row whose `match_column`
 * matches gets its quantity changed; otherwise (or when none matches) a new
 * row is appended with `fill`, the match value and the signed quantity.
 * Pure: returns new rows, never mutates the input.
 */
export function subtable_scan_append(rows: readonly SubtableRow[], o: SubtableScanAppend): SubtableScanResult {
  const op = o.op ?? "add";
  const qty = o.quantity ?? 1;
  const matches = o.matches ?? default_matches;
  const value = o.match_value ?? "";
  const copy = rows.map((r) => ({ ...r }));
  if ((o.mode ?? "merge") === "merge" && o.match_column && value) {
    const i = copy.findIndex((r) => matches(r[o.match_column!] ?? "", value));
    if (i >= 0) {
      const row = copy[i]!;
      if (o.quantity_column) row[o.quantity_column] = apply_quantity(row[o.quantity_column] ?? "", op, qty);
      return { rows: copy, row, created: false };
    }
  }
  if (copy.length >= (o.max_rows ?? SUBTABLE_MAX_ROWS)) throw new Error("The subtable is full");
  const row: SubtableRow = { ...(o.fill ?? {}), _id: new_subtable_row_id(copy.map((r) => r._id)) };
  if (o.match_column && value && !row[o.match_column]) row[o.match_column] = value;
  if (o.quantity_column) row[o.quantity_column] = apply_quantity("", op === "subtract" ? "subtract" : op === "set" ? "set" : "add", qty);
  copy.push(row);
  return { rows: copy, row, created: true };
}

//   #endregion scan-append

/** One line for lists, prints and search: `3 rows: Water × 2 · Bread × 1 · …`. */
export function subtable_summary(
  rows: readonly SubtableRow[],
  columns: readonly string[],
  present: (column: string, raw: string) => string,
  o: { max?: number; one?: string; many?: string } = {},
): string {
  if (!rows.length) return "";
  const max = o.max ?? 3;
  const lines = rows.slice(0, max).map((r) =>
    columns
      .map((c) => present(c, r[c] ?? ""))
      .filter(Boolean)
      .join(" × "),
  );
  const count = `${rows.length} ${rows.length === 1 ? (o.one ?? "row") : (o.many ?? "rows")}`;
  const detail = lines.filter(Boolean).join(" · ");
  return detail ? `${count}: ${detail}${rows.length > max ? " · …" : ""}` : count;
}

/** Every cell's text, for full-text search. */
export function subtable_search_text(raw: unknown): string {
  return parse_subtable_rows(raw)
    .flatMap((r) => Object.entries(r).filter(([k]) => k !== "_id").map(([, v]) => v))
    .filter(Boolean)
    .join(" ");
}

//   #endregion SUBTABLE
