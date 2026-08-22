import { describe, expect, test } from "bun:test";
import { define_module, define_routes } from "./define-module.js";

describe("define_module", () => {
  test("rejects routes outside resource prefix", () => {
    expect(() =>
      define_module({
        resource: "employees",
        labels: { singular: "E", plural: "Es" },
        routes: define_routes({
          "GET /departments": async () => ({ data: [] }),
        }),
      }),
    ).toThrow(/must start with/);
  });

  test("allows aliases", () => {
    const mod = define_module({
      resource: "leave",
      aliases: ["leave-requests"],
      labels: { singular: "Leave", plural: "Leave" },
      routes: define_routes({
        "GET /leave-requests": async () => ({ data: [] }),
        "POST /leave-requests/:id/decide": async () => ({ data: { ok: true } }),
      }),
    });
    expect(mod.aliases).toContain("leave-requests");
    expect(mod.routes.length).toBe(2);
  });

  test("raw routes skip prefix check", () => {
    const mod = define_module({
      resource: "store",
      labels: { singular: "Store", plural: "Store" },
      routes: define_routes({
        "POST /store/webhooks/:gateway": {
          raw: true,
          handler: async () => new Response("ok"),
        },
      }),
    });
    expect(mod.routes[0]?.raw).toBe(true);
  });
});
