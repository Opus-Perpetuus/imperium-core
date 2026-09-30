//   #region API ENVELOPE

/**
 * Standard JSON envelope for NOX HTTP responses.
 */
export interface NoxApiEnvelope<T = unknown> {
  ok: boolean;
  message?: string;
  data?: T;
  total?: number;
  error?: {
    code: string;
    details?: unknown;
  };
}

export function ok_envelope<T>(
  data: T,
  options?: { message?: string; total?: number },
): NoxApiEnvelope<T> {
  return {
    ok: true,
    data,
    message: options?.message,
    total: options?.total,
  };
}

export function error_envelope(
  code: string,
  message: string,
  details?: unknown,
): NoxApiEnvelope<null> {
  return {
    ok: false,
    message,
    data: null,
    error: { code, details },
  };
}

//   #endregion API ENVELOPE
