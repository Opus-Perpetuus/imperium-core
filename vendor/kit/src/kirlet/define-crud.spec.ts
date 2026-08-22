import { describe, expect, test } from "bun:test";
import { define_module } from "./define-module.js";
import { define_crud } from "./define-crud.js";
import { define_kirlet } from "./define-kirlet.js";
import { create_kirlet_test_context } from "./serve.js";
import { sign_kirlet_identity, type KirletIdentity } from "./identity.js";
import { MemoryNoxServices } from "./memory-nox-services.js";

const notes_table = {
  name: "notes",
  columns: [
    { name: "id", type: "text" as const, primaryKey: true },
    { name: "title", type: "text" as const, notNull: true },
    { name: "body", type: "text" as const },
    { name: "active", type: "boolean" as const, default: true },
    { name: "created_at", type: "text" as const },
    { name: "updated_at", type: "text" as const },
  ],
};

function build_notes_kirlet() {
  const routes = define_crud({
    resource: "notes",
    table: "notes",
    soft_delete: true,
    history: true,
    default_sort: "title:asc",
    fields: {
      title: { type: "string", required: true, search: true },
      body: { type: "string", search: true },
      active: { type: "boolean", create: true, update: true },
    },
    options_map: { value: "id", label: "title" },
  });
  const mod = define_module({
    resource: "notes",
    labels: { singular: "Note", plural: "Notes" },
    routes,
    tables: [notes_table],
    pages: [
      {
        id: "notes-list",
        path: "/notes",
        build: () => ({
          page: { component: "nox.stack", props: { gap: 1, children: [] } },
        }),
      },
    ],
  });
  return define_kirlet({
    id: "KIRLET-demo",
    name: "Demo",
    version: "0.2.0",
    image: "kirel/kirlet-demo:0.2.0",
    compat: { nox: ">=0.5.0", kit: "^0.5.0" },
    modules: [mod],
    schema_version: 2,
  });
}

describe("define_crud e2e (memory)", () => {
  test("list/search/sort/create/patch/soft-delete/history", async () => {
    const def = build_notes_kirlet();
    const nox = new MemoryNoxServices();
    const server = create_kirlet_test_context(def, { nox, auth_disabled: true });

    const create = await server.fetch(
      new Request("http://t/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Alpha", body: "a" }),
      }),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { id: string; title: string } };
    expect(created.data.title).toBe("Alpha");

    await server.fetch(
      new Request("http://t/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Beta", body: "search-me" }),
      }),
    );

    const list = await server.fetch(new Request("http://t/notes?sort=title:asc"));
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: Array<{ title: string }> };
    expect(listed.data.map((r) => r.title)).toEqual(["Alpha", "Beta"]);

    const search = await server.fetch(new Request("http://t/notes?q=search-me"));
    const found = (await search.json()) as { data: unknown[] };
    expect(found.data.length).toBe(1);

    const patch = await server.fetch(
      new Request(`http://t/notes/${created.data.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Alpha2" }),
      }),
    );
    expect(patch.status).toBe(200);

    const del = await server.fetch(
      new Request(`http://t/notes/${created.data.id}`, { method: "DELETE" }),
    );
    expect(del.status).toBe(200);

    const after = await server.fetch(new Request("http://t/notes"));
    const remaining = (await after.json()) as { data: unknown[] };
    expect(remaining.data.length).toBe(1);

    // history via nox (qualified)
    const hist = await nox.history.list({ resource_prefix: "kirlet.demo." });
    expect(hist.length).toBeGreaterThanOrEqual(3);
    expect(hist.some((h) => h.action === "create")).toBe(true);
    expect(hist.some((h) => h.resource === "kirlet.demo.notes")).toBe(true);

    server.stop();
  });

  test("unknown field → 400; method mismatch → 405", async () => {
    const def = build_notes_kirlet();
    const server = create_kirlet_test_context(def);

    const bad = await server.fetch(
      new Request("http://t/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x", nope: 1 }),
      }),
    );
    expect(bad.status).toBe(400);

    const mm = await server.fetch(
      new Request("http://t/notes/x", { method: "PUT" }),
    );
    expect(mm.status).toBe(405);
    expect(mm.headers.get("allow")).toContain("GET");

    server.stop();
  });

  test("auth on → 401 without signature; 403 without grant", async () => {
    const def = build_notes_kirlet();
    const secret = "test-gateway-secret-32chars-min!!";
    const server = create_kirlet_test_context(def, {
      auth_disabled: false,
      gateway_secret: secret,
    });

    const unauth = await server.fetch(new Request("http://t/notes"));
    expect(unauth.status).toBe(401);

    const weak: KirletIdentity = {
      user_id: "u",
      email: "u@x",
      is_admin: false,
      kirlet_id: "kirlet-demo",
      grants: [
        {
          resource: "kirlet.demo.other",
          c: false,
          r: true,
          u: false,
          d: false,
        },
      ],
    };
    const headers = sign_kirlet_identity(
      weak,
      secret,
      Math.floor(Date.now() / 1000),
    );
    const forbidden = await server.fetch(
      new Request("http://t/notes", {
        headers: headers as Record<string, string>,
      }),
    );
    expect(forbidden.status).toBe(403);

    server.stop();
  });

  test("meta routes health/manifest", async () => {
    const def = build_notes_kirlet();
    const server = create_kirlet_test_context(def);
    const health = await server.fetch(new Request("http://t/health"));
    expect(health.status).toBe(200);
    const h = (await health.json()) as { status: string };
    expect(h.status).toBe("ok");

    const man = await server.fetch(new Request("http://t/manifest"));
    expect(man.status).toBe(200);
    const m = (await man.json()) as {
      id: string;
      resources: Record<string, string>;
      permissions: Array<{ id: string }>;
    };
    expect(m.id).toBe("KIRLET-demo");
    expect(m.resources.notes).toBe("notes");
    expect(m.permissions.some((p) => p.id === "kirlet.demo.notes.read")).toBe(
      true,
    );

    server.stop();
  });
});

describe("define_crud redact_history", () => {
  const vaults_table = {
    name: "vaults",
    columns: [
      { name: "id", type: "text" as const, primaryKey: true },
      { name: "name", type: "text" as const, notNull: true },
      { name: "secret", type: "text" as const },
      { name: "created_at", type: "text" as const },
      { name: "updated_at", type: "text" as const },
    ],
  };

  function build_vaults_kirlet() {
    const routes = define_crud({
      resource: "vaults",
      table: "vaults",
      history: true,
      fields: {
        name: { type: "string", required: true },
        secret: { type: "string" },
      },
      redact_history: (row) => ({
        ...row,
        secret: row.secret == null ? row.secret : "•••",
      }),
    });
    const mod = define_module({
      resource: "vaults",
      labels: { singular: "Vault", plural: "Vaults" },
      routes,
      tables: [vaults_table],
    });
    return define_kirlet({
      id: "KIRLET-demo",
      name: "Demo",
      version: "0.2.0",
      image: "kirel/kirlet-demo:0.2.0",
      compat: { nox: ">=0.5.0", kit: "^0.5.0" },
      modules: [mod],
      schema_version: 2,
    });
  }

  test("history payloads are redacted; stored rows keep the real value", async () => {
    const def = build_vaults_kirlet();
    const nox = new MemoryNoxServices();
    const server = create_kirlet_test_context(def, { nox, auth_disabled: true });

    const create = await server.fetch(
      new Request("http://t/vaults", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "syscom", secret: "super-secreto" }),
      }),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { id: string } };

    await server.fetch(
      new Request(`http://t/vaults/${created.data.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "otro-secreto" }),
      }),
    );

    // Storage untouched: the API still returns the real value.
    const read = await server.fetch(
      new Request(`http://t/vaults/${created.data.id}`),
    );
    const row = (await read.json()) as { data: { secret: string } };
    expect(row.data.secret).toBe("otro-secreto");

    await server.fetch(
      new Request(`http://t/vaults/${created.data.id}`, { method: "DELETE" }),
    );

    const hist = await nox.history.list({ resource_prefix: "kirlet.demo." });
    expect(hist.length).toBeGreaterThanOrEqual(3);
    const dumped = JSON.stringify(hist);
    expect(dumped).not.toContain("super-secreto");
    expect(dumped).not.toContain("otro-secreto");
    expect(dumped).toContain("•••");

    server.stop();
  });
});
