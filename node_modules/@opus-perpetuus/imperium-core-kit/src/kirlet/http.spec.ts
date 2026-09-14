import { describe, expect, test } from "bun:test";
import {
  error_response,
  json_response,
  method_not_allowed_response,
  new_id,
  not_found_response,
  now_iso,
  today_iso,
} from "./http.js";

describe("http helpers", () => {
  test("json_response status and content-type", async () => {
    const res = json_response({ data: [1] }, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ data: [1] });
  });

  test("error_response envelope", async () => {
    const res = error_response("bad_request", "nope", 400, { field: "x" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "bad_request",
      message: "nope",
      field: "x",
    });
  });

  test("not_found and method_not_allowed", async () => {
    const nf = not_found_response("/x");
    expect(nf.status).toBe(404);
    expect(await nf.json()).toEqual({ error: "not_found", path: "/x" });

    const mna = method_not_allowed_response(["GET", "POST"]);
    expect(mna.status).toBe(405);
    expect(mna.headers.get("allow")).toBe("GET, POST");
    expect(await mna.json()).toEqual({
      error: "method_not_allowed",
      allowed: ["GET", "POST"],
    });
  });

  test("new_id / now_iso / today_iso", () => {
    const id = new_id("emp");
    expect(id.startsWith("emp_")).toBe(true);
    expect(id.length).toBeGreaterThan(10);
    expect(now_iso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(today_iso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
