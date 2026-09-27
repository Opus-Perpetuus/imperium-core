import { describe, expect, test } from "bun:test";
import { define_kirlet } from "./define-kirlet.js";
import { define_module, define_routes } from "./define-module.js";
import { MemoryKirletFileStore } from "./file-store.js";
import {
  sign_kirlet_identity,
  sign_kirlet_identity_v2,
  type KirletIdentity,
} from "./identity.js";
import { serve_kirlet } from "./serve.js";

/**
 * La app arrancada desde el entorno, como en el contenedor: `SUBJECT_AUTH=off`
 * con secreto de gateway ya no regala el admin sintético.
 */

const SECRET = "test-gateway-secret-32chars-min!!";

const page = (id: string) => ({
  id,
  owner: "subject-demo",
  title: id,
  page: { component: "nox.stack", props: {} },
});

const DEMO = define_kirlet({
  id: "SUBJECT-demo",
  name: "Demo",
  compat: { nox: ">=0.5.0", kit: "^0.5.0" },
  public: true,
  seed: () => {},
  modules: [
    define_module({
      resource: "notes",
      labels: { singular: "Nota", plural: "Notas" },
      routes: define_routes({
        "GET /notes": (ctx) => ({ data: { user_id: ctx.identity?.user_id ?? null } }),
      }),
      pages: [
        { id: "demo.publica", path: "/publica", public_access: "anonymous", build: () => page("publica") },
        { id: "demo.cliente", path: "/cliente", public_access: "external", build: () => page("cliente") },
        { id: "demo.interna", path: "/interna", build: () => page("interna") },
      ],
    }),
  ],
});

function start(extra_env: Record<string, string> = {}) {
  return serve_kirlet(DEMO, {
    no_listen: true,
    files: new MemoryKirletFileStore(),
    config: {
      env: {
        SUBJECT_AUTH: "off",
        KIRLET_AUTH: "off",
        CORE_SUBJECT_GATEWAY_SECRET: SECRET,
        KIRLET_SEED_DEMO: "0",
        ...extra_env,
      },
    },
  });
}

function internal(over: Partial<KirletIdentity> = {}): Record<string, string> {
  return sign_kirlet_identity(
    {
      user_id: "u1",
      email: "u1@x.mx",
      is_admin: false,
      kirlet_id: "subject-demo",
      grants: [{ resource: "kirlet.demo.notes", c: false, r: true, u: false, d: false }],
      ...over,
    },
    SECRET,
  );
}

function public_principal(user_type: "anonymous" | "external"): Record<string, string> {
  const id = user_type === "anonymous" ? "anonymous" : "cliente-1";
  return sign_kirlet_identity_v2(
    {
      user_id: id,
      email: user_type === "anonymous" ? id : "cliente@x.mx",
      is_admin: false,
      kirlet_id: "subject-demo",
      grants: [],
      user_type,
      realm: "public",
    },
    SECRET,
  );
}

async function call(
  server: ReturnType<typeof start>,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Response> {
  return server.fetch(new Request(`http://app${path}`, { method, headers }));
}

describe("serve_kirlet con SUBJECT_AUTH=off y secreto", () => {
  test("sin firma → 401 en rutas de datos; las meta siguen abiertas", async () => {
    const server = start();
    expect(server.config.auth_disabled).toBe(false);
    expect((await call(server, "/notes")).status).toBe(401);
    expect((await call(server, "/manifest")).status).toBe(200);
    expect((await call(server, "/schema")).status).toBe(200);
    expect((await call(server, "/health")).status).toBe(200);
    server.stop();
  });

  test("con firma de esta app pasa y los grants se comprueban", async () => {
    const server = start();
    const res = await call(server, "/notes", internal());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { user_id: string } }).data.user_id).toBe("u1");
    expect((await call(server, "/notes", internal({ grants: [] }))).status).toBe(403);
    server.stop();
  });

  test("firma para otra app → 401 (aunque sea de admin)", async () => {
    const server = start();
    const res = await call(server, "/notes", internal({ is_admin: true, kirlet_id: "subject-otra" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toBe(
      "identity signed for another app",
    );
    server.stop();
  });

  test("SUBJECT_DEV_ADMIN=1 devuelve el admin sintético sin firma", async () => {
    const server = start({ SUBJECT_DEV_ADMIN: "1" });
    expect(server.config.auth_disabled).toBe(true);
    const res = await call(server, "/notes");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { user_id: string } }).data.user_id).toBe("dev");
    expect((await call(server, "/seed", {}, "POST")).status).toBe(200);
    server.stop();
  });
});

describe("/seed exige admin", () => {
  test("sin firma → 401; firmado sin admin → 403; admin → 200", async () => {
    const server = start();
    expect((await call(server, "/seed", {}, "POST")).status).toBe(401);
    expect((await call(server, "/seed", internal(), "POST")).status).toBe(403);
    expect((await call(server, "/seed", public_principal("anonymous"), "POST")).status).toBe(403);
    expect((await call(server, "/seed", internal({ is_admin: true }), "POST")).status).toBe(200);
    server.stop();
  });
});

describe("/pages exige identidad y, en el realm público, página pública", () => {
  test("sin firma → 401", async () => {
    const server = start();
    expect((await call(server, "/pages")).status).toBe(401);
    expect((await call(server, "/pages/demo.publica")).status).toBe(401);
    server.stop();
  });

  test("anónimo: página no pública → 403; pública → 200 (también la de clientes)", async () => {
    const server = start();
    const anon = public_principal("anonymous");
    expect((await call(server, "/pages/demo.interna", anon)).status).toBe(403);
    expect((await call(server, "/pages/demo.publica", anon)).status).toBe(200);
    // La de clientes le pinta "inicia sesión" al anónimo: no se le cierra.
    expect((await call(server, "/pages/demo.cliente", anon)).status).toBe(200);
    expect((await call(server, "/pages/demo.nada", anon)).status).toBe(404);
    expect((await call(server, "/pages", anon)).status).toBe(200);
    server.stop();
  });

  test("externo: página no pública → 403; pública → 200", async () => {
    const server = start();
    const ext = public_principal("external");
    expect((await call(server, "/pages/demo.interna", ext)).status).toBe(403);
    expect((await call(server, "/pages/demo.cliente", ext)).status).toBe(200);
    server.stop();
  });

  test("usuario interno firmado construye cualquier página", async () => {
    const server = start();
    expect((await call(server, "/pages/demo.interna", internal())).status).toBe(200);
    server.stop();
  });
});
