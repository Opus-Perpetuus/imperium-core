// (o==================================================================o)
//   #region HTTP DATA CLIENT TIMEOUT
// (o-----------------------------------------------------------\/-----o)

import { describe, expect, test } from "bun:test";
import { HttpKirletDataClient } from "./http-data-client.js";

describe("HttpKirletDataClient AbortSignal (H3)", () => {
  test("passes AbortSignal to fetchImpl", async () => {
    let seen: AbortSignal | undefined;
    const client = new HttpKirletDataClient({
      baseUrl: "http://nox.test",
      technicalId: "t",
      gatewaySecret: "s",
      timeout_ms: 5_000,
      fetchImpl: (async (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    await client.findMany("products");
    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
  });

  test("never-resolving fetch fails by timeout", async () => {
    const client = new HttpKirletDataClient({
      baseUrl: "http://nox.test",
      technicalId: "t",
      gatewaySecret: "s",
      timeout_ms: 50,
      fetchImpl: (() => new Promise(() => {})) as typeof fetch,
    });
    const started = Date.now();
    await expect(client.findMany("products")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion HTTP DATA CLIENT TIMEOUT
// (o==================================================================o)
