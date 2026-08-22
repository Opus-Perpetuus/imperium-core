// (o==================================================================o)
//   #region DEFINE CRUD (standard resource routes)
// (o-----------------------------------------------------------\/-----o)

import { new_id, now_iso } from "./http.js";
import { KirletHttpError } from "./errors.js";
import { define_routes, type KirletRouteTable, type KirletCtx } from "./define-module.js";
import type { DomainRow, FindManyOptions } from "./data-client.js";

export type CrudFieldSpec = {
  type?: "string" | "number" | "boolean" | "json";
  required?: boolean;
  /** Allow on create (default true). */
  create?: boolean;
  /** Allow on update (default true). */
  update?: boolean;
  /** Include in list search (default false). */
  search?: boolean;
  /** Allow as sort field (default true for string/number). */
  sortable?: boolean;
  normalize?: (value: unknown) => unknown;
  validate?: (value: unknown) => string | null;
};

export type CrudHooks = {
  before_create?: (ctx: KirletCtx, row: DomainRow) => Promise<DomainRow> | DomainRow;
  after_create?: (ctx: KirletCtx, row: DomainRow) => Promise<void> | void;
  before_update?: (
    ctx: KirletCtx,
    id: string,
    patch: DomainRow,
    existing: DomainRow,
  ) => Promise<DomainRow> | DomainRow;
  after_update?: (
    ctx: KirletCtx,
    row: DomainRow,
    before: DomainRow,
  ) => Promise<void> | void;
  before_delete?: (ctx: KirletCtx, row: DomainRow) => Promise<void> | void;
  after_delete?: (ctx: KirletCtx, row: DomainRow) => Promise<void> | void;
};

export type DefineCrudOptions = {
  resource: string;
  table?: string;
  fields: Record<string, CrudFieldSpec>;
  soft_delete?: boolean;
  /**
   * Soft-delete column (default `active` boolean true/false).
   * Use `is_active` with active_value/inactive_value for integer 1/0 schemas (HR).
   */
  soft_delete_field?: string;
  active_value?: unknown;
  inactive_value?: unknown;
  history?: boolean;
  /**
   * Rewrite rows before they land in the audit history (mask secrets, drop
   * blobs). Applied to the `before`/`after` payloads only — storage and API
   * responses are never touched.
   */
  redact_history?: (row: DomainRow) => DomainRow;
  default_sort?: string;
  /** Map list `?as=options` → { value, label } using these field names. */
  options_map?: { value: string; label: string };
  hooks?: CrudHooks;
  id_prefix?: string;
  /** Campos desconocidos van a `payload` (contrato Imperium / Angular). */
  unknown_to_payload?: boolean;
  /** Alias HTTP de Imperium: PUT /, DELETE /id/:id, statistics, field-values. */
  imperium?: boolean;
};

function apply_field(
  fields: Record<string, CrudFieldSpec>,
  key: string,
  value: unknown,
  mode: "create" | "update",
): unknown {
  const spec = fields[key];
  if (!spec) {
    throw new KirletHttpError(400, "validation_error", `unknown field: ${key}`, {
      field: key,
    });
  }
  if (mode === "create" && spec.create === false) {
    throw new KirletHttpError(400, "validation_error", `field not creatable: ${key}`, {
      field: key,
    });
  }
  if (mode === "update" && spec.update === false) {
    throw new KirletHttpError(400, "validation_error", `field not updatable: ${key}`, {
      field: key,
    });
  }
  let v = value;
  if (spec.normalize) v = spec.normalize(v);
  if (spec.validate) {
    const err = spec.validate(v);
    if (err) {
      throw new KirletHttpError(400, "validation_error", err, { field: key });
    }
  }
  if (spec.type === "string" && v != null && typeof v !== "string") {
    v = String(v);
  }
  if (spec.type === "number" && v != null && typeof v !== "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) {
      throw new KirletHttpError(400, "validation_error", `invalid number: ${key}`, {
        field: key,
      });
    }
    v = n;
  }
  if (spec.type === "boolean" && v != null && typeof v !== "boolean") {
    v = v === "true" || v === true || v === 1 || v === "1";
  }
  return v;
}

function pick_body(
  fields: Record<string, CrudFieldSpec>,
  body: Record<string, unknown>,
  mode: "create" | "update",
  unknown_to_payload = false,
): DomainRow {
  const out: DomainRow = {};
  const extra: DomainRow = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "id" || key === "_id") continue;
    const mapped = key === "_ref" ? "ref" : key === "createdAt" ? "created_at" : key === "updatedAt" ? "updated_at" : key;
    if (!(mapped in fields) && mapped !== "payload") {
      if (unknown_to_payload) {
        extra[key] = value;
        continue;
      }
      throw new KirletHttpError(400, "validation_error", `unknown field: ${key}`, {
        field: key,
      });
    }
    if (mapped === "payload") continue;
    if (mapped in fields) out[mapped] = apply_field(fields, mapped, value, mode);
  }
  if (unknown_to_payload && Object.keys(extra).length) {
    const prev = (body.payload && typeof body.payload === "object" && !Array.isArray(body.payload))
      ? (body.payload as DomainRow)
      : {};
    out.payload = { ...prev, ...extra };
  }
  if (mode === "create") {
    for (const [key, spec] of Object.entries(fields)) {
      if (spec.required && (out[key] === undefined || out[key] === null || out[key] === "")) {
        throw new KirletHttpError(400, "validation_error", `required: ${key}`, {
          field: key,
        });
      }
    }
  }
  return out;
}

function parse_sort(
  sort: string | undefined,
  fields: Record<string, CrudFieldSpec>,
  default_sort?: string,
): Record<string, "asc" | "desc"> | undefined {
  const raw = sort ?? default_sort;
  if (!raw) return undefined;
  const m = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(asc|desc)$/);
  if (!m) return undefined;
  const field = m[1]!;
  const dir = m[2] as "asc" | "desc";
  if (field !== "id" && field !== "created_at" && field !== "updated_at") {
    const spec = fields[field];
    if (!spec || spec.sortable === false) return undefined;
  }
  return { [field]: dir };
}

/**
 * Generate standard CRUD route table for a resource.
 * Paths: GET/POST /resource, GET/PATCH/DELETE /resource/:id
 */
export function define_crud(opts: DefineCrudOptions): KirletRouteTable {
  const table = opts.table ?? opts.resource;
  const resource = opts.resource;
  const fields = opts.fields;
  const search_fields = Object.entries(fields)
    .filter(([, s]) => s.search)
    .map(([k]) => k);
  const history = opts.history !== false;
  const soft = opts.soft_delete === true;
  const soft_field = opts.soft_delete_field ?? "active";
  const active_val = opts.active_value ?? true;
  const inactive_val = opts.inactive_value ?? false;
  const id_prefix = opts.id_prefix ?? resource.replace(/s$/, "").slice(0, 8);
  const unknown_to_payload = opts.unknown_to_payload === true || opts.imperium === true;
  const imperium = opts.imperium !== false;

  const history_resource = (ctx: KirletCtx) => {
    // full resource id filled by serve layer via slug; here use relative name
    return resource;
  };

  async function append_history(
    ctx: KirletCtx,
    action: string,
    entity_id: string,
    payload: Record<string, unknown>,
  ) {
    if (!history) return;
    const redact = opts.redact_history;
    const redacted = redact
      ? Object.fromEntries(
          Object.entries(payload).map(([key, value]) => [
            key,
            value && typeof value === "object" && !Array.isArray(value)
              ? redact({ ...(value as DomainRow) })
              : value,
          ]),
        )
      : payload;
    await ctx.nox.history.append({
      resource: history_resource(ctx),
      action,
      entity_id,
      actor_id: ctx.identity?.user_id ?? null,
      actor_label: ctx.actor,
      payload: redacted,
    });
  }

  return define_routes({
    [`GET /${resource}`]: async (ctx) => {
      const lq = ctx.list_query();
      const as_options = ctx.query.get("as") === "options";
      const include_inactive = ctx.query.get("include_inactive") === "1" ||
        ctx.query.get("include_inactive") === "true";

      const where: FindManyOptions["where"] = {};
      if (soft && !include_inactive) {
        where[soft_field] = active_val as string | number | boolean;
      }

      const orderBy = parse_sort(lq.sort, fields, opts.default_sort);
      const find_opts: FindManyOptions = {
        where: Object.keys(where).length ? where : undefined,
        orderBy,
        limit: lq.take,
        offset: lq.skip,
      };
      if (lq.q && search_fields.length) {
        find_opts.search = { fields: search_fields, q: lq.q };
      }

      const rows = await ctx.data.findMany(table, find_opts);
      if (as_options && opts.options_map) {
        const { value, label } = opts.options_map;
        return {
          data: rows.map((r) => ({
            value: r[value],
            label: r[label],
          })),
        };
      }
      const total = await ctx.data.count(table, find_opts.where, find_opts.search);
      return { data: rows, total_elementos: total, message: "Ruta encontrada" };
    },

    ...(imperium
      ? {
          [`GET /${resource}/statistics`]: async (ctx: KirletCtx) => {
            const total = await ctx.data.count(table);
            return {
              data: [
                {
                  total_records: total,
                  last_updated: new Date().toISOString(),
                },
              ],
              total_elementos: 1,
              message: "Estadísticas obtenidas correctamente",
            };
          },
          [`GET /${resource}/field-values/:field`]: async (ctx: KirletCtx) => {
            const field = ctx.params.field;
            const rows = await ctx.data.findMany(table, { limit: 500 });
            const seen = new Set<string>();
            const data = [];
            for (const r of rows) {
              const v = r[field];
              if (v == null) continue;
              const k = String(v);
              if (seen.has(k)) continue;
              seen.add(k);
              data.push({ value: v, label: k });
            }
            return { data, total_elementos: data.length, message: "Valores de campo" };
          },
          [`POST /${resource}/mass-query`]: async (ctx: KirletCtx) => {
            const body = (await ctx.body<{ ids?: string[] }>()) ?? {};
            const ids = body.ids ?? [];
            const rows = [];
            for (const id of ids) {
              const row = await ctx.data.findOne(table, { id });
              if (row) rows.push(row);
            }
            return { data: rows, total_elementos: rows.length, message: "Consulta masiva" };
          },
          [`PUT /${resource}`]: async (ctx: KirletCtx) => {
            const body = (await ctx.body<Record<string, unknown>>()) ?? {};
            const id = String(body._id ?? body.id ?? "");
            if (!id) throw new KirletHttpError(400, "validation_error", "Se necesita un id para actualizar");
            const existing = await ctx.data.findOne(table, { id });
            if (!existing) throw new KirletHttpError(404, "not_found", "not found");
            let patch = pick_body(fields, body, "update", unknown_to_payload);
            patch = { ...patch, updated_at: now_iso() };
            await ctx.data.update(table, { id }, patch);
            return { data: null, total_elementos: 1, message: "Actualizado correctamente" };
          },
          [`PUT /${resource}/batch`]: async (ctx: KirletCtx) => {
            const body = (await ctx.body<unknown>()) ?? [];
            const items = Array.isArray(body) ? body : [];
            const data = [];
            for (const raw of items) {
              const row = raw as Record<string, unknown>;
              const id = String(row._id ?? row.id ?? "");
              if (id) {
                const existing = await ctx.data.findOne(table, { id });
                if (existing) {
                  const patch = pick_body(fields, row, "update", unknown_to_payload);
                  const updated = await ctx.data.update(table, { id }, { ...patch, updated_at: now_iso() });
                  if (updated) data.push(updated);
                  continue;
                }
              }
            }
            return { data, total_elementos: data.length, message: "Lote aplicado" };
          },
          [`DELETE /${resource}/id/:id`]: async (ctx: KirletCtx) => {
            const existing = await ctx.data.findOne(table, { id: ctx.params.id });
            if (!existing) throw new KirletHttpError(404, "not_found", "not found");
            if (soft) {
              const updated = await ctx.data.update(
                table,
                { id: ctx.params.id },
                { [soft_field]: inactive_val, updated_at: now_iso() },
              );
              return { data: updated, total_elementos: 1, message: "Eliminado correctamente" };
            }
            await ctx.data.delete(table, { id: ctx.params.id });
            return { data: existing, total_elementos: 1, message: "Eliminado correctamente" };
          },
        }
      : {}),

    [`GET /${resource}/:id`]: async (ctx) => {
      const raw_id = ctx.params.id;
      const row = raw_id.startsWith("ref----")
        ? await ctx.data.findOne(table, { ref: raw_id.slice(7) })
        : await ctx.data.findOne(table, { id: raw_id });
      if (!row) throw new KirletHttpError(404, "not_found", "not found");
      if (soft && row[soft_field] === inactive_val) {
        throw new KirletHttpError(404, "not_found", "not found");
      }
      return { data: row };
    },

    [`POST /${resource}`]: async (ctx) => {
      const body = (await ctx.body<Record<string, unknown>>()) ?? {};
      let row = pick_body(fields, body, "create", unknown_to_payload);
      const id =
        typeof body.id === "string" && body.id ? body.id : new_id(id_prefix);
      const ts = now_iso();
      row = {
        ...row,
        id,
        created_at: ts,
        updated_at: ts,
      };
      if (soft && row[soft_field] === undefined) row[soft_field] = active_val;
      if (opts.hooks?.before_create) {
        row = await opts.hooks.before_create(ctx, row);
      }
      try {
        const created = await ctx.data.insert(table, row);
        if (opts.hooks?.after_create) await opts.hooks.after_create(ctx, created);
        await append_history(ctx, "create", String(created.id), {
          before: null,
          after: created,
        });
        return ctx.created(created);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/unique|duplicate/i.test(msg)) {
          throw new KirletHttpError(409, "conflict", "duplicate resource");
        }
        throw e;
      }
    },

    [`PATCH /${resource}/:id`]: async (ctx) => {
      const existing = await ctx.data.findOne(table, { id: ctx.params.id });
      if (!existing) throw new KirletHttpError(404, "not_found", "not found");
      const body = (await ctx.body<Record<string, unknown>>()) ?? {};
      let patch = pick_body(fields, body, "update", unknown_to_payload);
      patch = { ...patch, updated_at: now_iso() };
      if (opts.hooks?.before_update) {
        patch = await opts.hooks.before_update(
          ctx,
          ctx.params.id,
          patch,
          existing,
        );
      }
      const updated = await ctx.data.update(
        table,
        { id: ctx.params.id },
        patch,
      );
      if (!updated) throw new KirletHttpError(404, "not_found", "not found");
      if (opts.hooks?.after_update) {
        await opts.hooks.after_update(ctx, updated, existing);
      }
      await append_history(ctx, "update", ctx.params.id, {
        before: existing,
        after: updated,
      });
      return { data: updated };
    },

    [`DELETE /${resource}/:id`]: async (ctx) => {
      const existing = await ctx.data.findOne(table, { id: ctx.params.id });
      if (!existing) throw new KirletHttpError(404, "not_found", "not found");
      if (opts.hooks?.before_delete) await opts.hooks.before_delete(ctx, existing);
      if (soft) {
        const updated = await ctx.data.update(
          table,
          { id: ctx.params.id },
          { [soft_field]: inactive_val, updated_at: now_iso() },
        );
        if (opts.hooks?.after_delete) {
          await opts.hooks.after_delete(ctx, updated ?? existing);
        }
        await append_history(ctx, "delete", ctx.params.id, {
          before: existing,
          after: updated,
        });
        return { data: updated };
      }
      await ctx.data.delete(table, { id: ctx.params.id });
      if (opts.hooks?.after_delete) await opts.hooks.after_delete(ctx, existing);
      await append_history(ctx, "delete", ctx.params.id, {
        before: existing,
        after: null,
      });
      return null;
    },
  });
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion DEFINE CRUD
// (o==================================================================o)
