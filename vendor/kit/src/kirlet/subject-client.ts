//   #region SUBJECT CLIENT (llamadas app → app por el gateway del núcleo)

import { KirletHttpError } from "./errors.js";
import { is_subject_technical_id } from "./manifest.js";

/**
 * Cabecera con la que una app se presenta ante el gateway al llamar a otra:
 * su technical id. El núcleo la exige junto con el secreto de gateway de esa
 * misma app y la deja pasar al destino.
 */
export const SUBJECT_CALLER_HEADER = "x-imperium-subject";

/**
 * Plazo por defecto de una llamada app → app. Queda por debajo del que el
 * núcleo da al salto hacia el destino (15 s): un `timeout_ms` mayor no alarga
 * la llamada, el núcleo corta antes con 502.
 */
export const CALL_SUBJECT_TIMEOUT_MS = 12_000;

export type CallSubjectOptions = {
  /** Se serializa como JSON y fija `content-type: application/json`. */
  body?: unknown;
  query?: Record<string, string>;
  /** Cabeceras extra; las de secreto y remitente las pone siempre el cliente. */
  headers?: Record<string, string>;
  timeout_ms?: number;
  fetchImpl?: typeof fetch;
  /** Por defecto `process.env`. */
  env?: Record<string, string | undefined>;
};

async function subject_call_error(res: Response): Promise<KirletHttpError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* sin sobre JSON: solo el estado */
  }
  // Sobre del kit: `{ error: <código>, message }`; del núcleo: `{ error: <texto>, message, code }`.
  const code =
    typeof body.code === "string"
      ? body.code
      : typeof body.error === "string" && /^[a-z_]+$/.test(body.error)
        ? body.error
        : "subject_call_failed";
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : res.statusText || `HTTP ${res.status}`;
  return new KirletHttpError(res.status, code, message);
}

/**
 * Llama en servidor a una ruta de otra app a través del gateway interno del
 * núcleo (`/api/m/<target>/…`). `route` es `"METHOD /ruta"`, p. ej.
 * `"POST /herr-utilidades/formula"`.
 *
 * Lee del env la base (`CORE_DATA_URL` / `NOX_DATA_URL`), el remitente
 * (`SUBJECT_TECHNICAL_ID` / `KIRLET_TECHNICAL_ID`) y el secreto
 * (`CORE_SUBJECT_GATEWAY_SECRET` / `NOX_KIRLET_GATEWAY_SECRET`): los mismos
 * nombres que `resolve_kirlet_config`.
 *
 * Respuesta: con estado 2xx devuelve `data` si el sobre lo trae y, si no, el
 * cuerpo entero (204 → `undefined`). Con otro estado lanza `KirletHttpError`
 * con el `code`/`message` del sobre.
 */
export async function call_subject<T = unknown>(
  target: string,
  route: string,
  opts: CallSubjectOptions = {},
): Promise<T> {
  if (!is_subject_technical_id(target)) {
    throw new KirletHttpError(400, "invalid_subject_target", `target inválido: ${target}`);
  }
  const parsed = route.match(/^([A-Za-z]+)\s+(\/\S*)$/);
  if (!parsed) {
    throw new KirletHttpError(
      400,
      "invalid_subject_route",
      `ruta inválida: ${route} (se espera "METHOD /ruta")`,
    );
  }
  const env = opts.env ?? (typeof process !== "undefined" ? process.env : {});
  // Misma normalización que serve.ts: un NOX_DATA_URL legado trae la ruta del plano de datos.
  const base = (env.CORE_DATA_URL?.trim() || env.NOX_DATA_URL?.trim() || "")
    .replace(/\/api\/kirlets\/data\/.*$/, "")
    .replace(/\/+$/, "");
  const caller = env.SUBJECT_TECHNICAL_ID?.trim() || env.KIRLET_TECHNICAL_ID?.trim() || "";
  const secret =
    env.CORE_SUBJECT_GATEWAY_SECRET?.trim() || env.NOX_KIRLET_GATEWAY_SECRET?.trim() || "";
  if (!base || !caller || !secret) {
    throw new KirletHttpError(
      500,
      "subject_client_misconfigured",
      "call_subject necesita CORE_DATA_URL, SUBJECT_TECHNICAL_ID y CORE_SUBJECT_GATEWAY_SECRET",
    );
  }

  let url: URL;
  try {
    url = new URL(`${base}/api/m/${target}${parsed[2]}`);
  } catch {
    throw new KirletHttpError(
      500,
      "subject_client_misconfigured",
      `CORE_DATA_URL no es una URL: ${base}`,
    );
  }
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers = new Headers(opts.headers);
  headers.set("x-core-subject-gateway-secret", secret);
  headers.set(SUBJECT_CALLER_HEADER, caller);
  const has_body = opts.body !== undefined;
  if (has_body) headers.set("content-type", "application/json");

  const res = await (opts.fetchImpl ?? fetch)(url.toString(), {
    method: parsed[1]!.toUpperCase(),
    headers,
    body: has_body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout_ms ?? CALL_SUBJECT_TIMEOUT_MS),
  });
  if (!res.ok) throw await subject_call_error(res);
  if (res.status === 204) return undefined as T;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new KirletHttpError(
      502,
      "subject_bad_response",
      `${target} respondió ${res.status} sin JSON`,
    );
  }
  if (json && typeof json === "object" && "data" in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

//   #endregion SUBJECT CLIENT
