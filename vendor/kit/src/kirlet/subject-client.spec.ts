//   #region SUBJECT CLIENT (app → app)

import { describe, expect, test } from "bun:test";
import { KirletHttpError } from "./errors.js";
import { SUBJECT_CALLER_HEADER, call_subject } from "./subject-client.js";

const ENV = {
  CORE_DATA_URL: "http://core:3100/",
  SUBJECT_TECHNICAL_ID: "subject-pos",
  CORE_SUBJECT_GATEWAY_SECRET: "derivado-de-pos",
};

type Seen = { url: string; init: RequestInit; headers: Headers };

function fake_fetch(status: number, body: unknown) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {}, headers: new Headers(init?.headers) });
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("call_subject", () => {
  test("URL, cabeceras de gateway y remitente; sin cuerpo no hay content-type", async () => {
    const { fetchImpl, seen } = fake_fetch(200, { data: { ok: 1 } });
    const out = await call_subject<{ ok: number }>(
      "subject-herramientas",
      "GET /herr-utilidades/ping",
      { env: ENV, fetchImpl },
    );
    expect(out).toEqual({ ok: 1 });
    expect(seen[0]!.url).toBe("http://core:3100/api/m/subject-herramientas/herr-utilidades/ping");
    expect(seen[0]!.init.method).toBe("GET");
    expect(seen[0]!.headers.get("x-core-subject-gateway-secret")).toBe("derivado-de-pos");
    expect(seen[0]!.headers.get(SUBJECT_CALLER_HEADER)).toBe("subject-pos");
    expect(seen[0]!.headers.get("content-type")).toBeNull();
    expect(seen[0]!.init.body).toBeUndefined();
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("query y cuerpo JSON", async () => {
    const { fetchImpl, seen } = fake_fetch(200, { data: [] });
    await call_subject("subject-herramientas", "post /herr-utilidades/formula", {
      env: ENV,
      fetchImpl,
      query: { q: "a b", limit: "5" },
      body: { expr: "1+1" },
    });
    expect(seen[0]!.url).toBe(
      "http://core:3100/api/m/subject-herramientas/herr-utilidades/formula?q=a+b&limit=5",
    );
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.init.body).toBe('{"expr":"1+1"}');
  });

  test("las cabeceras extra pasan, pero no pisan secreto ni remitente", async () => {
    const { fetchImpl, seen } = fake_fetch(200, {});
    await call_subject("subject-herramientas", "GET /x", {
      env: ENV,
      fetchImpl,
      headers: {
        accept: "application/json",
        "X-Imperium-Subject": "subject-intrusa",
        "x-core-subject-gateway-secret": "otro",
      },
    });
    expect(seen[0]!.headers.get("accept")).toBe("application/json");
    expect(seen[0]!.headers.get(SUBJECT_CALLER_HEADER)).toBe("subject-pos");
    expect(seen[0]!.headers.get("x-core-subject-gateway-secret")).toBe("derivado-de-pos");
  });

  test("sin `data` en el sobre devuelve el cuerpo entero; 204 devuelve undefined", async () => {
    const whole = fake_fetch(200, { total: 3 });
    expect(await call_subject("subject-a", "GET /x", { env: ENV, fetchImpl: whole.fetchImpl })).toEqual({
      total: 3,
    });
    const empty = fake_fetch(204, undefined);
    expect(
      await call_subject("subject-a", "DELETE /x/1", { env: ENV, fetchImpl: empty.fetchImpl }),
    ).toBeUndefined();
  });

  test("nombres NOX_* y NOX_DATA_URL legado con la ruta del plano de datos", async () => {
    const { fetchImpl, seen } = fake_fetch(200, {});
    await call_subject("subject-a", "GET /x", {
      fetchImpl,
      env: {
        NOX_DATA_URL: "http://nox:3000/api/kirlets/data/kirlet-hr",
        KIRLET_TECHNICAL_ID: "kirlet-hr",
        NOX_KIRLET_GATEWAY_SECRET: "s",
      },
    });
    expect(seen[0]!.url).toBe("http://nox:3000/api/m/subject-a/x");
    expect(seen[0]!.headers.get(SUBJECT_CALLER_HEADER)).toBe("kirlet-hr");
  });

  test("error con sobre del núcleo y con sobre del kit", async () => {
    const core = fake_fetch(403, {
      error: "Prohibido",
      message: "Prohibido",
      code: "caller_not_installed",
    });
    let err = await call_subject("subject-a", "GET /x", { env: ENV, fetchImpl: core.fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(KirletHttpError);
    expect(err as KirletHttpError).toMatchObject({
      status: 403,
      code: "caller_not_installed",
      message: "Prohibido",
    });

    const kit = fake_fetch(404, { error: "not_found", message: "no existe" });
    err = await call_subject("subject-a", "GET /x", { env: ENV, fetchImpl: kit.fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err as KirletHttpError).toMatchObject({ status: 404, code: "not_found", message: "no existe" });

    const plain = fake_fetch(502, undefined);
    err = await call_subject("subject-a", "GET /x", { env: ENV, fetchImpl: plain.fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err as KirletHttpError).toMatchObject({ status: 502, code: "subject_call_failed" });
  });

  test("un `error` de texto libre no se toma como código", async () => {
    const texto = fake_fetch(502, { error: "subject unreachable: subject-a", detail: "x" });
    const err = await call_subject("subject-a", "GET /x", { env: ENV, fetchImpl: texto.fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err as KirletHttpError).toMatchObject({
      status: 502,
      code: "subject_call_failed",
      message: "subject unreachable: subject-a",
    });
  });

  test("2xx sin JSON → 502 subject_bad_response", async () => {
    const fetchImpl = (async () =>
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const err = await call_subject("subject-a", "GET /x", { env: ENV, fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KirletHttpError);
    expect(err as KirletHttpError).toMatchObject({ status: 502, code: "subject_bad_response" });
  });

  test("CORE_DATA_URL vacío cae a NOX_DATA_URL; una base que no es URL → misconfigured", async () => {
    const { fetchImpl, seen } = fake_fetch(200, { data: 1 });
    await call_subject("subject-a", "GET /x", {
      env: { ...ENV, CORE_DATA_URL: " ", NOX_DATA_URL: "http://nox:3000" },
      fetchImpl,
    });
    expect(seen[0]!.url).toBe("http://nox:3000/api/m/subject-a/x");
    const err = await call_subject("subject-a", "GET /x", {
      env: { ...ENV, CORE_DATA_URL: "sin esquema" },
      fetchImpl,
    }).catch((e: unknown) => e);
    expect(err as KirletHttpError).toMatchObject({ status: 500, code: "subject_client_misconfigured" });
  });

  test("timeout configurable: la señal aborta al plazo dado", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const started = Date.now();
    const err = await call_subject("subject-a", "GET /x", {
      env: ENV,
      fetchImpl,
      timeout_ms: 30,
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("sin base, remitente o secreto → 500 subject_client_misconfigured", async () => {
    const { fetchImpl, seen } = fake_fetch(200, {});
    for (const missing of ["CORE_DATA_URL", "SUBJECT_TECHNICAL_ID", "CORE_SUBJECT_GATEWAY_SECRET"]) {
      const env: Record<string, string | undefined> = { ...ENV, [missing]: "" };
      const err = await call_subject("subject-a", "GET /x", { env, fetchImpl }).catch((e: unknown) => e);
      expect(err as KirletHttpError).toMatchObject({ status: 500, code: "subject_client_misconfigured" });
    }
    expect(seen).toEqual([]);
  });

  test("target y ruta inválidos → 400 sin llamar", async () => {
    const { fetchImpl, seen } = fake_fetch(200, {});
    const bad_target = await call_subject("pos", "GET /x", { env: ENV, fetchImpl }).catch((e: unknown) => e);
    expect(bad_target as KirletHttpError).toMatchObject({ status: 400, code: "invalid_subject_target" });
    const bad_route = await call_subject("subject-a", "/x", { env: ENV, fetchImpl }).catch((e: unknown) => e);
    expect(bad_route as KirletHttpError).toMatchObject({ status: 400, code: "invalid_subject_route" });
    expect(seen).toEqual([]);
  });
});

//   #endregion SUBJECT CLIENT
