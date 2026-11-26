import { describe, expect, test } from "bun:test";
import { define_kirlet } from "./define-kirlet.js";
import { define_module, define_routes } from "./define-module.js";
import {
  FEATURE_MAP_TEST_HEADER,
  feature_map_test_headers,
  feature_map_test_requested,
  in_feature_map_test,
  run_with_feature_map_test,
} from "./feature-map-test.js";
import { MemoryKirletFileStore } from "./file-store.js";
import { HttpKirletDataClient } from "./http-data-client.js";
import { sign_kirlet_identity } from "./identity.js";
import { SchemaDdlBuilder } from "./schema.js";
import { serve_kirlet } from "./serve.js";

const SECRET = "test-gateway-secret-32chars-min!!";

describe("feature_map_test en la app", () => {
  test("la cabecera activa la marca solo dentro de la petición", async () => {
    expect(feature_map_test_requested(new Headers({ [FEATURE_MAP_TEST_HEADER]: "1" }))).toBe(true);
    expect(feature_map_test_requested(new Headers())).toBe(false);
    expect(feature_map_test_headers()).toEqual({});
    await run_with_feature_map_test(true, async () => {
      await Promise.resolve();
      expect(feature_map_test_headers()).toEqual({ [FEATURE_MAP_TEST_HEADER]: "1" });
    });
    expect(in_feature_map_test()).toBe(false);
  });

  test("el cliente del plano de datos reenvía la marca al núcleo", async () => {
    const seen: Array<string | null> = [];
    const client = new HttpKirletDataClient({
      baseUrl: "http://nox.test",
      technicalId: "subject-demo",
      gatewaySecret: "s",
      fetchImpl: (async (_url, init) => {
        seen.push(new Headers(init?.headers).get(FEATURE_MAP_TEST_HEADER));
        return Response.json({ data: { id: "1" } });
      }) as typeof fetch,
    });
    await client.insert("notes", { id: "1" });
    await run_with_feature_map_test(true, () => client.insert("notes", { id: "2" }));
    expect(seen).toEqual([null, "1"]);
  });

  test("serve_kirlet corre cada petición con la marca de su cabecera", async () => {
    const vistos: boolean[] = [];
    const app = define_kirlet({
      id: "SUBJECT-demo",
      name: "Demo",
      compat: { nox: ">=0.5.0", kit: "^0.5.0" },
      modules: [
        define_module({
          resource: "notes",
          labels: { singular: "Nota", plural: "Notas" },
          routes: define_routes({
            "GET /notes": async () => {
              await Promise.resolve();
              vistos.push(in_feature_map_test());
              return { data: [] };
            },
          }),
        }),
      ],
    });
    const server = serve_kirlet(app, {
      no_listen: true,
      files: new MemoryKirletFileStore(),
      config: { env: { CORE_SUBJECT_GATEWAY_SECRET: SECRET, KIRLET_SEED_DEMO: "0" } },
    });
    const identity = sign_kirlet_identity(
      {
        user_id: "u1",
        email: "ia.admin@qa.imperium.test",
        is_admin: true,
        kirlet_id: "subject-demo",
        grants: [{ resource: "kirlet.demo.notes", c: true, r: true, u: true, d: true }],
      },
      SECRET,
    );
    const r1 = await server.fetch(new Request("http://app/notes", { headers: identity }));
    const r2 = await server.fetch(
      new Request("http://app/notes", { headers: { ...identity, [FEATURE_MAP_TEST_HEADER]: "1" } }),
    );
    server.stop();
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(vistos).toEqual([false, true]);
  });

  test("toda tabla de la app nace (o se actualiza) con la columna feature_map_test", () => {
    const stmts = new SchemaDdlBuilder().build({
      technicalId: "subject-demo",
      version: 1,
      tables: [{ name: "notes", columns: [{ name: "id", type: "text", primaryKey: true }] }],
    });
    const create = stmts.find((s) => s.startsWith("CREATE TABLE"))!;
    expect(create).toContain("\"feature_map_test\" BOOLEAN NOT NULL DEFAULT COALESCE(current_setting('imperium.feature_map_test', true) = 'on', false)");
    expect(stmts).toContain(
      `ALTER TABLE "subject_demo"."notes" ADD COLUMN IF NOT EXISTS "feature_map_test" BOOLEAN NOT NULL DEFAULT COALESCE(current_setting('imperium.feature_map_test', true) = 'on', false)`,
    );
  });

  test("si la app ya la declara, no se duplica", () => {
    const stmts = new SchemaDdlBuilder().build({
      technicalId: "subject-demo",
      version: 1,
      tables: [
        {
          name: "notes",
          columns: [
            { name: "id", type: "text", primaryKey: true },
            { name: "feature_map_test", type: "boolean", notNull: true, default: false },
          ],
        },
      ],
    });
    expect(stmts.join("\n").match(/feature_map_test/g)!.length).toBe(2);
  });
});
