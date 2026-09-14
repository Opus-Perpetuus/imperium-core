import { describe, expect, test } from "bun:test";
import { define_module, define_routes } from "./define-module.js";
import { define_kirlet } from "./define-kirlet.js";
import { create_kirlet_test_context } from "./serve.js";
import type { KirletTableDecl } from "./schema.js";

// (o==================================================================o)
//   #region FIXTURE
// (o-----------------------------------------------------------\/-----o)

const ITEMS_TABLE: KirletTableDecl = {
  name: "items",
  columns: [
    { name: "id", type: "text", primaryKey: true },
    { name: "title", type: "text", notNull: true },
    { name: "created_at", type: "text", notNull: true },
  ],
};

/**
 * Two pages: one synchronous (legacy signature) and one async that reads the
 * kirlet's own table. Both must serve correctly from `GET /pages/:id`.
 */
function build_definition() {
  return define_kirlet({
    id: "kirlet-pagebuild",
    name: "Page Build",
    version: "0.1.0",
    compat: { nox: ">=0.5.0", kit: "^0.5.0" },
    modules: [
      define_module({
        resource: "items",
        labels: { singular: "Item", plural: "Items" },
        tables: [ITEMS_TABLE],
        routes: define_routes({
          "GET /items": async (ctx) => ({
            data: await ctx.data.findMany("items", {}),
          }),
        }),
        pages: [
          {
            id: "items.sync",
            path: "items-sync",
            build: () => ({
              page: { component: "nox.stack", props: { direction: "column" } },
            }),
          },
          {
            id: "items.async",
            path: "items-async",
            build: async ({ data, url }) => {
              const rows = (await data.findMany("items", {})) as Array<{
                title?: string;
              }>;
              const q = url?.searchParams.get("q") ?? "";
              return {
                page: {
                  component: "nox.stack",
                  props: {
                    direction: "column",
                    children: rows
                      .filter((r) => !q || (r.title ?? "").includes(q))
                      .map((r) => ({
                        component: "nox.card",
                        props: { title: r.title },
                      })),
                  },
                },
              };
            },
          },
        ],
        menu: [],
      }),
    ],
  });
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion FIXTURE
// (o==================================================================o)

// (o==================================================================o)
//   #region ASYNC PAGE BUILD
// (o-----------------------------------------------------------\/-----o)

describe("page build", () => {
  test("synchronous build still serves (backwards compatible)", async () => {
    const ctx = create_kirlet_test_context(build_definition());
    const res = await ctx.fetch(
      new Request("http://k/pages/items.sync"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: { component: string } };
    expect(body.page.component).toBe("nox.stack");
    ctx.stop();
  });

  test("async build reads the kirlet's own tables", async () => {
    const def = build_definition();
    const ctx = create_kirlet_test_context(def);
    await ctx.data.insert("items", {
      id: "i1",
      title: "Router AX",
      created_at: new Date().toISOString(),
    });
    await ctx.data.insert("items", {
      id: "i2",
      title: "Switch 24",
      created_at: new Date().toISOString(),
    });

    const res = await ctx.fetch(new Request("http://k/pages/items.async"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      page: { props: { children: Array<{ props: { title: string } }> } };
    };
    const titles = body.page.props.children.map((c) => c.props.title);
    expect(titles).toEqual(["Router AX", "Switch 24"]);
    ctx.stop();
  });

  test("async build receives the request URL for query params", async () => {
    const ctx = create_kirlet_test_context(build_definition());
    await ctx.data.insert("items", {
      id: "i1",
      title: "Router AX",
      created_at: new Date().toISOString(),
    });
    await ctx.data.insert("items", {
      id: "i2",
      title: "Switch 24",
      created_at: new Date().toISOString(),
    });

    const res = await ctx.fetch(
      new Request("http://k/pages/items.async?q=Switch"),
    );
    const body = (await res.json()) as {
      page: { props: { children: Array<{ props: { title: string } }> } };
    };
    expect(body.page.props.children.map((c) => c.props.title)).toEqual([
      "Switch 24",
    ]);
    ctx.stop();
  });

  test("unknown page id is a 404", async () => {
    const ctx = create_kirlet_test_context(build_definition());
    const res = await ctx.fetch(new Request("http://k/pages/nope"));
    expect(res.status).toBe(404);
    ctx.stop();
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion ASYNC PAGE BUILD
// (o==================================================================o)
