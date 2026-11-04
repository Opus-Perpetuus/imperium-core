//   #region DEFINE CRUD (standard resource routes)

import { new_id, now_iso } from "./http.js";
import { KirletHttpError } from "./errors.js";
import { field_name_access, type FieldValuesAccess } from "./field-values-rule.js";
import { ANONYMOUS_USER_ID, type KirletIdentity } from "./identity.types.js";
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
  /** Credencial o dato sensible: `field-values` no lo lista. */
  secret?: boolean;
  /**
   * Permite `GET /<recurso>/field-values/<campo>` en un campo que por defecto
   * se niega (json, secret, o nombre de credencial). Solo si sus valores
   * distintos se pueden mostrar a cualquiera con lectura del recurso.
   */
  field_values?: boolean;
  /**
   * `false` = el campo no viaja en la lista (`GET /recurso`): fotos, firmas y
   * adjuntos en base64. El detalle (`GET /recurso/:id`) lo sigue entregando.
   */
  list?: boolean;
  /**
   * PII aunque el nombre no lo diga (`llamadas.numero` = teléfono): field-values
   * solo con sesión interna válida.
   */
  pii?: boolean;
  /**
   * FK real: recurso/tabla al que apunta. Un `_id`/`_ref` con nombre sensible
   * (`domicilio_id`) solo admite field-values si lo declara.
   */
  ref?: string;
};

export {
  field_name_access,
  field_name_denied,
  JSON_BLOB_FIELDS,
  snake_field_name,
  type FieldNameOptions,
  type FieldValuesAccess,
} from "./field-values-rule.js";

/**
 * Sesión interna válida: usuario firmado por el núcleo, no anónimo ni del realm
 * público. Es la condición para listar valores de un campo PII.
 */
export function field_values_session(identity: KirletIdentity | null | undefined): boolean {
  if (!identity || !identity.user_id || identity.user_id === ANONYMOUS_USER_ID) return false;
  if ((identity.user_type ?? "internal") !== "internal") return false;
  return (identity.realm ?? "internal") === "internal";
}

/** Clase de acceso de un campo de `define_crud` (ver `field_name_access`). */
export function field_values_access(
  field: string,
  spec: CrudFieldSpec | undefined,
  resource?: string,
): FieldValuesAccess {
  if (spec?.field_values === true) return "open";
  // `list: false` marca fotos, firmas y adjuntos: tampoco salen por field-values.
  if (spec?.secret === true || spec?.list === false || spec?.type === "json") return "denied";
  const by_name = field_name_access(field, {
    is_reference: Boolean(spec?.ref),
    is_boolean: spec?.type === "boolean",
    resource,
  });
  if (by_name === "open" && spec?.pii === true) return "session";
  return by_name;
}

/**
 * `field-values` devuelve los valores distintos de una columna a quien tenga
 * lectura del recurso. Credenciales, firmas y json no salen nunca; la PII solo
 * con sesión interna (`identity`). Sin `identity` se evalúa como sin sesión.
 * `field_values: true` abre el campo.
 */
export function field_values_denied(
  field: string,
  spec: CrudFieldSpec | undefined,
  identity?: KirletIdentity | null,
  resource?: string,
): boolean {
  const access = field_values_access(field, spec, resource);
  if (access === "open") return false;
  if (access === "denied") return true;
  return !field_values_session(identity);
}

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
  if (spec.type === "json" && typeof v === "string") v = parse_json_text(v);
  return v;
}

/**
 * El editor JSON de un formulario manda texto. En un campo `json` se guarda
 * el objeto; el texto que no es JSON se queda como vino.
 */
function parse_json_text(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  /** Columnas sin field-values: el filtro de la lista pasa a texto libre. */
  const fv_denied_for = (identity: KirletIdentity | null) =>
    Object.keys(fields).filter((name) => field_values_denied(name, fields[name], identity, resource));

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

  /** Actualización con hooks e historia: la usan `PATCH /:id` y los alias Imperium. */
  async function update_row(
    ctx: KirletCtx,
    id: string,
    existing: DomainRow,
    body: Record<string, unknown>,
  ): Promise<DomainRow> {
    let patch = pick_body(fields, body, "update", unknown_to_payload);
    patch = { ...patch, updated_at: now_iso() };
    if (opts.hooks?.before_update) {
      patch = await opts.hooks.before_update(ctx, id, patch, existing);
    }
    const updated = await ctx.data.update(table, { id }, patch);
    if (!updated) throw new KirletHttpError(404, "not_found", "not found");
    if (opts.hooks?.after_update) {
      await opts.hooks.after_update(ctx, updated, existing);
    }
    await append_history(ctx, "update", id, { before: existing, after: updated });
    return updated;
  }

  /** Baja con hooks e historia: la usan `DELETE /:id` y `DELETE /id/:id`. */
  async function delete_row(
    ctx: KirletCtx,
    id: string,
  ): Promise<{ existing: DomainRow; updated: DomainRow | null }> {
    const existing = await ctx.data.findOne(table, { id });
    if (!existing) throw new KirletHttpError(404, "not_found", "not found");
    if (opts.hooks?.before_delete) await opts.hooks.before_delete(ctx, existing);
    if (soft) {
      const updated = await ctx.data.update(
        table,
        { id },
        { [soft_field]: inactive_val, updated_at: now_iso() },
      );
      if (opts.hooks?.after_delete) {
        await opts.hooks.after_delete(ctx, updated ?? existing);
      }
      await append_history(ctx, "delete", id, { before: existing, after: updated });
      return { existing, updated };
    }
    await ctx.data.delete(table, { id });
    if (opts.hooks?.after_delete) await opts.hooks.after_delete(ctx, existing);
    await append_history(ctx, "delete", id, { before: existing, after: null });
    return { existing, updated: null };
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
      const omit = Object.entries(fields).filter(([, spec]) => spec.list === false).map(([name]) => name);
      const data = omit.length
        ? rows.map((row) => {
            const copy = { ...row };
            for (const name of omit) delete copy[name];
            return copy;
          })
        : rows;
      return { data, total_elementos: total, message: "Ruta encontrada", fv_denied: fv_denied_for(ctx.identity) };
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
            if (!/^[a-z_][a-z0-9_]*$/i.test(field)) {
              throw new KirletHttpError(400, "validation_error", "Campo inválido");
            }
            // Un campo que la tabla no tiene llegaba al SQL y salía 500.
            const columna_base = field === "id" || field === "created_at" || field === "updated_at" || field === soft_field;
            if (!columna_base && !fields[field]) {
              throw new KirletHttpError(400, "validation_error", `Campo desconocido: ${field}`, { field });
            }
            if (!columna_base && field_values_denied(field, fields[field], ctx.identity, resource)) {
              const access = field_values_access(field, fields[field], resource);
              throw new KirletHttpError(
                400,
                "validation_error",
                access === "session"
                  ? `El campo ${field} solo admite field-values con sesión`
                  : `El campo ${field} no admite field-values`,
                { field },
              );
            }
            const termino = String(ctx.query.get("termino") ?? "");
            // Igual que la lista: sin `include_inactive`, solo filas activas.
            const include_inactive = ctx.query.get("include_inactive") === "1" ||
              ctx.query.get("include_inactive") === "true" ||
              ctx.query.get("show_archived") === "true";
            const where: FindManyOptions["where"] = soft && !include_inactive
              ? { [soft_field]: active_val as string | number | boolean }
              : undefined;
            const values = await ctx.data.distinct(table, field, termino, where);
            const data = values.map((value) => ({
              value,
              label: String(value),
            }));
            return { data, total_elementos: data.length, message: "Valores de campo" };
          },
          [`POST /${resource}/mass-query`]: async (ctx: KirletCtx) => {
            const body = (await ctx.body<{ ids?: string[] }>()) ?? {};
            const ids = (body.ids ?? []).map(String).filter(Boolean).slice(0, 500);
            const rows = ids.length
              ? await ctx.data.findMany(table, {
                  where: { id: { in: ids } },
                  limit: ids.length,
                })
              : [];
            return { data: rows, total_elementos: rows.length, message: "Consulta masiva" };
          },
          [`PUT /${resource}`]: async (ctx: KirletCtx) => {
            const body = (await ctx.body<Record<string, unknown>>()) ?? {};
            const id = String(body._id ?? body.id ?? "");
            if (!id) throw new KirletHttpError(400, "validation_error", "Se necesita un id para actualizar");
            const existing = await ctx.data.findOne(table, { id });
            if (!existing) throw new KirletHttpError(404, "not_found", "not found");
            await update_row(ctx, id, existing, body);
            return { data: null, total_elementos: 1, message: "Actualizado correctamente" };
          },
          [`PUT /${resource}/batch`]: async (ctx: KirletCtx) => {
            const body = (await ctx.body<unknown>()) ?? [];
            const items = Array.isArray(body) ? body : [];
            const data = [];
            for (const raw of items) {
              const row = raw as Record<string, unknown>;
              const id = String(row._id ?? row.id ?? "");
              if (!id) continue;
              const existing = await ctx.data.findOne(table, { id });
              if (existing) data.push(await update_row(ctx, id, existing, row));
            }
            return { data, total_elementos: data.length, message: "Lote aplicado" };
          },
          [`DELETE /${resource}/id/:id`]: async (ctx: KirletCtx) => {
            const { existing, updated } = await delete_row(ctx, ctx.params.id);
            return { data: updated ?? existing, total_elementos: 1, message: "Eliminado correctamente" };
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
      return { data: await update_row(ctx, ctx.params.id, existing, body) };
    },

    [`DELETE /${resource}/:id`]: async (ctx) => {
      const { updated } = await delete_row(ctx, ctx.params.id);
      return soft ? { data: updated } : null;
    },
  });
}

//   #endregion DEFINE CRUD
