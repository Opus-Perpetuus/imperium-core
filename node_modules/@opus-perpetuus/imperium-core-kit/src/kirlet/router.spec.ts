import { describe, expect, test } from "bun:test";
import {
  compile_route,
  match_route,
  match_route_table,
  type ExtractParams,
  type ParamsOfPattern,
} from "./router.js";

describe("compile_route / match_route", () => {
  test("literal path match", () => {
    const r = match_route("GET /employees", "GET", "/employees");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toEqual({});
  });

  test("param extraction", () => {
    const r = match_route("GET /employees/:id", "GET", "/employees/emp_abc");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toEqual({ id: "emp_abc" });
  });

  test("multi param", () => {
    const r = match_route(
      "GET /employees/:id/team/:year",
      "GET",
      "/employees/e1/team/2026",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toEqual({ id: "e1", year: "2026" });
  });

  test("method_mismatch vs miss", () => {
    const miss = match_route("GET /employees/:id", "GET", "/departments/x");
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.reason).toBe("miss");

    const mm = match_route("GET /employees/:id", "POST", "/employees/x");
    expect(mm.ok).toBe(false);
    if (!mm.ok) {
      expect(mm.reason).toBe("method_mismatch");
      expect(mm.allowed).toEqual(["GET"]);
    }
  });

  test("wildcard only final", () => {
    const r = match_route("GET /files/*", "GET", "/files/a/b/c");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.wildcard).toBe("a/b/c");

    expect(() => compile_route("GET /files/*/x")).toThrow(/final/);
  });

  test("trailing slash and query ignored", () => {
    const r = match_route("GET /health", "GET", "/health/?x=1");
    expect(r.ok).toBe(true);
  });

  test("decodeURIComponent on params", () => {
    const r = match_route("GET /p/:name", "GET", "/p/hello%20world");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.name).toBe("hello world");
  });
});

describe("match_route_table aggregates Allow", () => {
  test("405 allowed methods sorted", () => {
    const table = [
      { compiled: compile_route("GET /items/:id") },
      { compiled: compile_route("PATCH /items/:id") },
      { compiled: compile_route("DELETE /items/:id") },
      { compiled: compile_route("GET /items") },
    ];
    const hit = match_route_table(table, "GET", "/items/1");
    expect(hit.ok).toBe(true);

    const mm = match_route_table(table, "POST", "/items/1");
    expect(mm.ok).toBe(false);
    if (!mm.ok) {
      expect(mm.reason).toBe("method_mismatch");
      expect(mm.allowed).toEqual(["DELETE", "GET", "PATCH"]);
    }

    const miss = match_route_table(table, "GET", "/nope");
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.reason).toBe("miss");
  });
});

describe("ExtractParams type contract", () => {
  test("runtime shape matches typed expectation", () => {
    // Type-level: ParamsOfPattern<"GET /employees/:id"> has { id: string }
    type P = ParamsOfPattern<"GET /employees/:id">;
    const params: P = { id: "x" };
    expect(params.id).toBe("x");

    type Nested = ExtractParams<"/a/:b/c/:d">;
    const n: Nested = { b: "1", d: "2" };
    expect(n.b).toBe("1");

    // @ts-expect-error — missing required param id
    const _bad: ParamsOfPattern<"GET /employees/:id"> = {};
    void _bad;

    // @ts-expect-error — unknown param key
    const _bad2: ParamsOfPattern<"GET /employees/:id"> = { id: "x", extra: "y" };
    void _bad2;
  });
});
