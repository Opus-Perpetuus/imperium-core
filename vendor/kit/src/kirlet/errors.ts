// (o==================================================================o)
//   #region KIRLET HTTP ERRORS
// (o-----------------------------------------------------------\/-----o)

import { error_response } from "./http.js";

/**
 * Throw from handlers; serve_kirlet / to_error_response map to JSON envelopes.
 */
export class KirletHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KirletHttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Map thrown values to Response. Non-KirletHttpError → 500 internal_error. */
export function to_error_response(err: unknown): Response {
  if (err instanceof KirletHttpError) {
    return error_response(err.code, err.message, err.status, err.extra);
  }
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "internal error";
  // Do not leak internal messages as client-facing detail in production paths;
  // handlers may log separately. Envelope stays stable.
  void message;
  return error_response("internal_error", "internal error", 500);
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET HTTP ERRORS
// (o==================================================================o)
