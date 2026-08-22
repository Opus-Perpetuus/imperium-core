import { describe, expect, test } from "bun:test";
import {
  bind_api_payload_to_props,
  collect_api_data_sources,
  is_api_data_source,
  parse_api_data_source,
  resolve_api_data_source,
} from "./api-data-source";

// (o==================================================================o)
//   #region TESTS
// (o-----------------------------------------------------------\/-----o)

describe("parse_api_data_source", () => {
  test("parses path and query into http_path under /api", () => {
    const r = parse_api_data_source("api://tags?take=10");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ref.path).toBe("tags");
    expect(r.ref.params.take).toBe("10");
    expect(r.ref.http_path).toBe("/api/tags?take=10");
    expect(r.ref.scheme).toBe("api");
  });

  test("rejects empty path and path traversal", () => {
    expect(parse_api_data_source("api://").ok).toBe(false);
    expect(parse_api_data_source("api://?q=1").ok).toBe(false);
    expect(parse_api_data_source("api://../secret").ok).toBe(false);
    expect(parse_api_data_source("https://evil.com").ok).toBe(false);
  });

  test("resolve_api_data_source throws on invalid", () => {
    expect(() => resolve_api_data_source("nope")).toThrow(/api:\/\//);
    expect(resolve_api_data_source("api://search?q=x").http_path).toBe(
      "/api/search?q=x",
    );
  });
});

describe("is_api_data_source / collect", () => {
  test("detects api:// strings", () => {
    expect(is_api_data_source("api://tags")).toBe(true);
    expect(is_api_data_source("  API://Tags  ")).toBe(true);
    expect(is_api_data_source("/api/tags")).toBe(false);
  });

  test("collect_api_data_sources walks nested props", () => {
    const found = collect_api_data_sources({
      props: {
        source: "api://tags",
        nested: { href: "api://users" },
      },
      children: [
        {
          props: { dataSource: "api://search?q=a" },
          children: [],
        },
      ],
    });
    expect(found).toContain("api://tags");
    expect(found).toContain("api://users");
    expect(found).toContain("api://search?q=a");
  });
});

describe("bind_api_payload_to_props", () => {
  test("binds envelope data array to rows", () => {
    const props = bind_api_payload_to_props(
      { source: "api://tags", columns: [] },
      { data: [{ id: "1", name: "core" }], total: 1 },
    );
    expect(props.bound).toBe(true);
    expect(props.bound_count).toBe(1);
    expect((props.rows as { name: string }[])[0]!.name).toBe("core");
  });

  test("marks unbound when payload is not array-shaped", () => {
    const props = bind_api_payload_to_props({ source: "api://x" }, { ok: true });
    expect(props.bound).toBe(false);
    expect(String(props.bound_error)).toMatch(/no array/i);
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion TESTS
// (o==================================================================o)
