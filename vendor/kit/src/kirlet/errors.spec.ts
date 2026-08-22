import { describe, expect, test } from "bun:test";
import { KirletHttpError, to_error_response } from "./errors.js";

describe("KirletHttpError / to_error_response", () => {
  test("maps KirletHttpError to envelope", async () => {
    const res = to_error_response(
      new KirletHttpError(409, "conflict", "dup", { id: "1" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "conflict",
      message: "dup",
      id: "1",
    });
  });

  test("unknown errors become 500 internal_error", async () => {
    const res = to_error_response(new Error("secret stack"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error", message: "internal error" });
  });
});
