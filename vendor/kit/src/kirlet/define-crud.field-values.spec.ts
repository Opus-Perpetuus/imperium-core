import { describe, expect, test } from "bun:test";
import { define_crud, field_values_denied } from "./define-crud.js";
import { define_kirlet } from "./define-kirlet.js";
import { define_module } from "./define-module.js";
import { create_kirlet_test_context } from "./serve.js";
import { sign_kirlet_identity, sign_kirlet_identity_v2 } from "./identity.js";
import type { KirletIdentity } from "./identity.types.js";

const SECRET = "test-gateway-secret-32chars-min!!";

/** Quién pide: sin sesión (anónimo o externo del realm público) o con sesión interna. */
type Who = "anonymous" | "external" | "internal";

function as_who(who: Who, technical_id: string): Record<string, string> {
  const base: KirletIdentity = { user_id: "u-1", email: "u@x.mx", is_admin: true, kirlet_id: technical_id, grants: [] };
  const now = Math.floor(Date.now() / 1000);
  if (who === "internal") return sign_kirlet_identity(base, SECRET, now);
  if (who === "external") {
    return sign_kirlet_identity_v2({ ...base, user_type: "external", realm: "public" }, SECRET, now);
  }
  return sign_kirlet_identity_v2(
    { ...base, user_id: "anonymous", email: "anonymous", user_type: "anonymous", realm: "public" },
    SECRET,
    now,
  );
}

const gateways_table = {
  name: "gateways",
  columns: [
    { name: "id", type: "text" as const, primaryKey: true },
    { name: "name", type: "text" as const, notNull: true },
    { name: "config_json", type: "jsonb" as const },
    { name: "api_token", type: "text" as const },
    { name: "webhook_key", type: "text" as const },
    { name: "tags", type: "jsonb" as const },
    { name: "active", type: "boolean" as const },
    { name: "created_at", type: "timestamptz" as const },
    { name: "updated_at", type: "timestamptz" as const },
  ],
};

function gateways() {
  const routes = define_crud({
    resource: "gateways",
    table: "gateways",
    soft_delete: true,
    fields: {
      name: { type: "string", required: true },
      config_json: { type: "json" },
      api_token: { type: "string" },
      webhook_key: { type: "string", secret: true },
      tags: { type: "json", field_values: true },
      active: { type: "boolean" },
    },
  });
  return define_kirlet({
    id: "KIRLET-gw",
    name: "Gateways",
    version: "0.1.0",
    image: "kirel/kirlet-gw:0.1.0",
    compat: { nox: ">=0.5.0", kit: "^0.5.0" },
    schema_version: 2,
    modules: [
      define_module({
        resource: "gateways",
        labels: { singular: "Gateway", plural: "Gateways" },
        routes,
        tables: [gateways_table],
        pages: [],
      }),
    ],
  });
}

describe("field-values no lista credenciales ni blobs json", () => {
  test("la regla por defecto y la opción explícita", () => {
    expect(field_values_denied("config_json", { type: "json" })).toBe(true);
    expect(field_values_denied("custom_data", { type: "string" })).toBe(true);
    expect(field_values_denied("payload", undefined)).toBe(true);
    expect(field_values_denied("spec_json", { type: "string" })).toBe(true);
    expect(field_values_denied("password", { type: "string" })).toBe(true);
    expect(field_values_denied("client_secret", { type: "string" })).toBe(true);
    expect(field_values_denied("access_token", { type: "string" })).toBe(true);
    expect(field_values_denied("api_key", { type: "string" })).toBe(true);
    expect(field_values_denied("pin_hash", { type: "string" })).toBe(true);
    expect(field_values_denied("webhook_key", { type: "string", secret: true })).toBe(true);
    expect(field_values_denied("tags", { type: "json", field_values: true })).toBe(false);
    expect(field_values_denied("estado", { type: "string" })).toBe(false);
    expect(field_values_denied("tokenizer_model", { type: "string" })).toBe(false);
  });

  test("camelCase y PII caen en la regla; field_values: true los abre", () => {
    for (const field of ["clientSecret", "accessToken", "apiKey", "APIKey", "pinHash", "passwordHash", "secretKey", "smtp_pass"]) {
      expect(field_values_denied(field, { type: "string" })).toBe(true);
    }
    for (const field of ["rfc", "proveedor_rfc", "emisorRfc", "curp", "nss", "clabe", "firma", "firma_digital", "img_signature_owner"]) {
      expect(field_values_denied(field, { type: "string" })).toBe(true);
    }
    expect(field_values_denied("rfc", { type: "string", field_values: true })).toBe(false);
    for (const field of ["firma", "firmas", "firma_digital", "firmaDigital", "signature", "withdrawalSignature", "delivery_signature", "img_signature_owner"]) {
      expect(field_values_denied(field, { type: "string" })).toBe(true);
    }
    expect(field_values_denied("foto", { type: "string", list: false })).toBe(true);
    expect(field_values_denied("foto", { type: "string", list: false, field_values: true })).toBe(false);
    expect(field_values_denied("foto", { type: "string" })).toBe(false);
    // `_id`/`_ref` con nombre sensible: solo pasa si el spec declara la FK.
    expect(field_values_denied("domicilio_id", { type: "string" })).toBe(true);
    expect(field_values_denied("domicilio_id", { type: "string", ref: "herr-domicilios" })).toBe(false);
    for (const field of ["firmado_at", "rfcs_count_x", "nssa", "passenger_no", "client_id", "pinned"]) {
      expect(field_values_denied(field, { type: "string" })).toBe(false);
    }
  });

  test("HTTP: 400 validation_error sin filtrar el valor; el resto sigue igual", async () => {
    const server = create_kirlet_test_context(gateways(), { auth_disabled: true });
    const created = await server.fetch(
      new Request("http://t/gateways", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Stripe",
          config_json: { secret_key: "sk_live_x" },
          api_token: "tok_x",
          webhook_key: "whk_x",
          tags: ["pagos"],
        }),
      }),
    );
    expect(created.status).toBeLessThan(300);

    for (const field of ["config_json", "api_token", "webhook_key"]) {
      const res = await server.fetch(new Request(`http://t/gateways/field-values/${field}`));
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("validation_error");
      expect(text).not.toContain("sk_live_x");
      expect(text).not.toContain("tok_x");
      expect(text).not.toContain("whk_x");
    }

    const name = await server.fetch(new Request("http://t/gateways/field-values/name"));
    expect(name.status).toBe(200);
    const tags = await server.fetch(new Request("http://t/gateways/field-values/tags"));
    expect(tags.status).toBe(200);
    server.stop();
  });
});

describe("field-values: misma vista que la lista", () => {
  test("la lista anuncia fv_denied y field-values no enseña filas dadas de baja", async () => {
    const server = create_kirlet_test_context(gateways(), { auth_disabled: true });
    const post = (name: string) =>
      server.fetch(
        new Request("http://t/gateways", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        }),
      );
    await post("Viva");
    const archived = (await (await post("Archivada")).json()) as { data?: { id?: string }; id?: string };
    const id = String(archived.data?.id ?? archived.id ?? "");
    expect(id).not.toBe("");
    const del = await server.fetch(new Request(`http://t/gateways/${id}`, { method: "DELETE" }));
    expect(del.status).toBeLessThan(300);

    const list = (await (await server.fetch(new Request("http://t/gateways"))).json()) as {
      data: Array<{ name: string }>;
      fv_denied: string[];
    };
    expect(list.data.map((row) => row.name)).toEqual(["Viva"]);
    expect([...list.fv_denied].sort()).toEqual(["api_token", "config_json", "webhook_key"]);

    const values = (await (await server.fetch(new Request("http://t/gateways/field-values/name"))).json()) as {
      data: Array<{ value: string }>;
    };
    expect(values.data.map((option) => option.value)).toEqual(["Viva"]);
    const all = (await (
      await server.fetch(new Request("http://t/gateways/field-values/name?include_inactive=1"))
    ).json()) as { data: Array<{ value: string }> };
    expect(all.data.map((option) => option.value).sort()).toEqual(["Archivada", "Viva"]);
    server.stop();
  });
});

describe("define_crud: campos fuera de la lista", () => {
  test("list: false no viaja en GET /recurso pero sí en el detalle", async () => {
    const { define_crud: crud } = await import("./define-crud.ts");
    const routes = crud({
      resource: "cosa",
      table: "cosa",
      fields: { name: { type: "string" }, foto: { type: "string", list: false } },
    });
    const row = { id: "c1", name: "Una", foto: "data:image/png;base64,AAAA" };
    const ctx = (params: Record<string, string> = {}) =>
      ({
        params,
        query: new URLSearchParams(),
        list_query: () => ({ take: 25, skip: 0 }),
        data: {
          findMany: async () => [row],
          count: async () => 1,
          findOne: async () => row,
        },
      }) as never;
    const list = routes.find((r) => r.pattern === "GET /cosa")!;
    const detail = routes.find((r) => r.pattern === "GET /cosa/:id")!;
    const body = (await (list.handler as (c: never) => Promise<{ data: Record<string, unknown>[] }>)(ctx())) as {
      data: Record<string, unknown>[];
    };
    expect(body.data[0]).toEqual({ id: "c1", name: "Una" });
    const one = (await (detail.handler as (c: never) => Promise<{ data: Record<string, unknown> }>)(ctx({ id: "c1" }))) as {
      data: Record<string, unknown>;
    };
    expect(one.data.foto).toBe("data:image/png;base64,AAAA");
  });
});

describe("field-values: FK real y booleanos por todos los caminos del kit", () => {
  const envios_table = {
    name: "envios",
    columns: [
      { name: "id", type: "text" as const, primaryKey: true },
      { name: "domicilio_id", type: "text" as const },
      { name: "cliente_domicilio_id", type: "text" as const },
      { name: "home", type: "boolean" as const },
      { name: "zip_file", type: "text" as const },
      { name: "created_at", type: "timestamptz" as const },
      { name: "updated_at", type: "timestamptz" as const },
    ],
  };
  function envios() {
    return define_kirlet({
      id: "KIRLET-envios",
      name: "Envios",
      version: "0.1.0",
      image: "kirel/kirlet-envios:0.1.0",
      compat: { nox: ">=0.5.0", kit: "^0.5.0" },
      schema_version: 2,
      modules: [
        define_module({
          resource: "envios",
          labels: { singular: "Envío", plural: "Envíos" },
          routes: define_crud({
            resource: "envios",
            table: "envios",
            fields: {
              domicilio_id: { type: "string", ref: "herr-domicilios" },
              cliente_domicilio_id: { type: "string" },
              home: { type: "boolean" },
              zip_file: { type: "string" },
            },
          }),
          tables: [envios_table],
          pages: [],
        }),
      ],
    });
  }

  test("la lista (fv_denied) y el endpoint respetan ref y booleano", async () => {
    const server = create_kirlet_test_context(envios(), { auth_disabled: true, gateway_secret: SECRET });
    const created = await server.fetch(
      new Request("http://t/envios", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domicilio_id: "domic-1", cliente_domicilio_id: "Calle 1", home: true, zip_file: "a.zip" }),
      }),
    );
    expect(created.status).toBeLessThan(300);
    const tid = envios().technical_id;
    const ext = as_who("external", tid);
    const list = (await (await server.fetch(new Request("http://t/envios", { headers: ext }))).json()) as { fv_denied: string[] };
    expect(list.fv_denied).toEqual(["cliente_domicilio_id"]);
    for (const [field, status] of [["domicilio_id", 200], ["home", 200], ["zip_file", 200], ["cliente_domicilio_id", 400]] as const) {
      const res = await server.fetch(new Request(`http://t/envios/field-values/${field}`, { headers: ext }));
      expect([field, res.status]).toEqual([field, status]);
    }
    // Con sesión interna el domicilio sí se lista (PII, no credencial).
    const int = as_who("internal", tid);
    const list_int = (await (await server.fetch(new Request("http://t/envios", { headers: int }))).json()) as { fv_denied: string[] };
    expect(list_int.fv_denied).toEqual([]);
    expect((await server.fetch(new Request("http://t/envios/field-values/cliente_domicilio_id", { headers: int }))).status).toBe(200);
    server.stop();
  });

  test("todo caller del kit pasa el spec del campo (ref/type) a la regla", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = import.meta.dir;
    const calls: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/\bfield_name_denied\(([^\n]*)/g)) {
        if (/export function/.test(src.slice(Math.max(0, (m.index ?? 0) - 20), m.index))) continue;
        calls.push(`${file}: field_name_denied(${m[1]})`);
      }
      for (const m of src.matchAll(/\bfield_name_access\((\w+, (?:opts|\{[\s\S]*?\}))\)/g)) {
        if (/export function/.test(src.slice(Math.max(0, (m.index ?? 0) - 20), m.index))) continue;
        const args = (m[1] ?? "").replace(/\s+/g, " ");
        // field_name_denied delega en field_name_access con las mismas opciones.
        if (args === "field, opts") continue;
        calls.push(`${file}: field_name_denied(${args})`);
      }
      for (const m of src.matchAll(/\bfield_values_denied\(([^\n]*)/g)) {
        if (/export function/.test(src.slice(Math.max(0, (m.index ?? 0) - 20), m.index))) continue;
        calls.push(`${file}: field_values_denied(${m[1]})`);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const ok = /field_name_denied\(.*is_reference.*is_boolean/.test(call) || /field_values_denied\(\w+, fields\[\w+\], (ctx\.)?identity, resource\)/.test(call);
      expect([call, ok]).toEqual([call, true]);
    }
  });
});

describe("field-values: PII de las apps (orden de Yael 2026-11-04)", () => {
  // Un campo por cada dato que pidió bloquear: rh, hospital, emergencias,
  // ciudadanos, clientes, usuarios y logística.
  const PII_FIELDS = [
    "cuenta", "clabe", "salario_diario", "fecha_nacimiento",
    "telefono_paciente", "telefono_familiar", "domicilio_completo",
    "telefono", "alertante_telefono", "direccion_exacta", "direccion_postal",
    "citizen_email", "citizen_phone", "citizen_street", "building_number_external", "building_number_internal", "neighborhood",
    "email", "customer_email", "email_contacto",
    "pedido_contacto_domicilio", "pedido_contacto_url_maps", "delivery_address_coordinates",
    "street", "exterior_number", "interior_number", "postal_code", "boroughs", "exterior", "interior", "urlMaps",
    // Fase 5: nombres, datos clínicos, ciudad, placas.
    "contacto_nombre", "firmante", "nombre_paciente", "apellido_paterno",
    "alergias", "enfermedad", "impresion_diagnostica", "edad", "sexo", "estado_civil",
    "localidad", "ciudad", "plates", "placa",
  ];
  const personas_table = {
    name: "personas",
    columns: [
      { name: "id", type: "text" as const, primaryKey: true },
      { name: "name", type: "text" as const, notNull: true },
      ...PII_FIELDS.map((name) => ({ name, type: "text" as const })),
      { name: "created_at", type: "timestamptz" as const },
      { name: "updated_at", type: "timestamptz" as const },
    ],
  };
  function personas() {
    const fields: Record<string, { type: "string"; required?: boolean }> = { name: { type: "string", required: true } };
    for (const f of PII_FIELDS) fields[f] = { type: "string" };
    return define_kirlet({
      id: "KIRLET-personas",
      name: "Personas",
      version: "0.1.0",
      image: "kirel/kirlet-personas:0.1.0",
      compat: { nox: ">=0.5.0", kit: "^0.5.0" },
      schema_version: 1,
      modules: [
        define_module({
          resource: "personas",
          labels: { singular: "Persona", plural: "Personas" },
          routes: define_crud({ resource: "personas", table: "personas", fields }),
          tables: [personas_table],
          pages: [],
        }),
      ],
    });
  }

  test("sin sesión: GET /personas/field-values/<campo PII> es 400 y no devuelve el dato; la lista lo anuncia en fv_denied", async () => {
    const server = create_kirlet_test_context(personas(), { auth_disabled: true, gateway_secret: SECRET });
    const row: Record<string, string> = { name: "Ana" };
    for (const f of PII_FIELDS) row[f] = `SECRETO_${f}`;
    const created = await server.fetch(
      new Request("http://t/personas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      }),
    );
    expect(created.status).toBeLessThan(300);
    const tid = personas().technical_id;
    for (const who of ["anonymous", "external"] as const) {
      const headers = as_who(who, tid);
      for (const f of PII_FIELDS) {
        const res = await server.fetch(new Request(`http://t/personas/field-values/${f}`, { headers }));
        const text = await res.text();
        expect([who, f, res.status]).toEqual([who, f, 400]);
        expect(text).toContain("validation_error");
        expect(text).not.toContain("SECRETO_");
      }
      // En un recurso de personas el nombre también es PII.
      const name = await server.fetch(new Request("http://t/personas/field-values/name", { headers }));
      expect([who, name.status]).toEqual([who, 400]);
      const list = (await (await server.fetch(new Request("http://t/personas", { headers }))).json()) as { fv_denied: string[] };
      expect([who, [...list.fv_denied].sort()]).toEqual([who, [...PII_FIELDS, "name"].sort()]);
    }
    server.stop();
  });

  test("con sesión interna: los mismos campos PII sí listan sus valores y la lista no los niega", async () => {
    const server = create_kirlet_test_context(personas(), { auth_disabled: true, gateway_secret: SECRET });
    const row: Record<string, string> = { name: "Ana" };
    for (const f of PII_FIELDS) row[f] = `valor_${f}`;
    await server.fetch(
      new Request("http://t/personas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      }),
    );
    const headers = as_who("internal", personas().technical_id);
    for (const f of [...PII_FIELDS, "name"]) {
      const res = await server.fetch(new Request(`http://t/personas/field-values/${f}`, { headers }));
      expect([f, res.status]).toEqual([f, 200]);
      expect(await res.text()).toContain(f === "name" ? "Ana" : `valor_${f}`);
    }
    const list = (await (await server.fetch(new Request("http://t/personas", { headers }))).json()) as { fv_denied: string[] };
    expect(list.fv_denied).toEqual([]);
    server.stop();
  });

});
