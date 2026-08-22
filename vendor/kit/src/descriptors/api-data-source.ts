// (o==================================================================o)
//   #region TYPES
// (o-----------------------------------------------------------\/-----o)

/**
 * Phase 9 — `api://` data-source binding for UI descriptors.
 * Format: `api://<path>[?query]` where path is relative to the NOX API root
 * (no leading slash required). Examples:
 *   api://tags
 *   api://tags?take=20
 *   api://search?q=core&index=nox_tags
 */

export type ApiDataSourceRef = {
  /** Original raw string (trimmed). */
  raw: string;
  /** Scheme always `api` when parse succeeds. */
  scheme: "api";
  /** Path without leading slash, e.g. `tags` or `search`. */
  path: string;
  /** Query string without `?`, or empty. */
  query: string;
  /** Parsed query params (first value wins per key). */
  params: Record<string, string>;
  /**
   * Absolute path for HTTP under the API global prefix.
   * e.g. `/api/tags` when prefix is `/api`.
   */
  http_path: string;
};

export type ApiDataSourceParseResult =
  | { ok: true; ref: ApiDataSourceRef }
  | { ok: false; error: string };

// (o-----------------------------------------------------------/\-----o)
//   #endregion TYPES
// (o==================================================================o)

// (o==================================================================o)
//   #region PARSE / RESOLVE
// (o-----------------------------------------------------------\/-----o)

const API_SCHEME = "api://";

/**
 * True when value looks like an `api://` data-source reference.
 */
export function is_api_data_source(value: unknown): value is string {
  return typeof value === "string" && value.trim().toLowerCase().startsWith(API_SCHEME);
}

/**
 * Parse an `api://…` data-source string into a structured ref.
 * Rejects empty path, non-api schemes, and path traversal (`..`).
 */
export function parse_api_data_source(
  raw_input: unknown,
  options?: { api_prefix?: string },
): ApiDataSourceParseResult {
  if (typeof raw_input !== "string" || !raw_input.trim()) {
    return { ok: false, error: "api data source must be a non-empty string" };
  }
  const raw = raw_input.trim();
  if (!raw.toLowerCase().startsWith(API_SCHEME)) {
    return {
      ok: false,
      error: `Expected api:// scheme, got: ${raw.slice(0, 32)}`,
    };
  }
  const rest = raw.slice(API_SCHEME.length);
  if (!rest || rest.startsWith("?")) {
    return { ok: false, error: "api:// requires a non-empty path" };
  }
  const q_idx = rest.indexOf("?");
  const path_part = (q_idx >= 0 ? rest.slice(0, q_idx) : rest).replace(/^\/+/, "");
  const query = q_idx >= 0 ? rest.slice(q_idx + 1) : "";
  if (!path_part) {
    return { ok: false, error: "api:// path is empty" };
  }
  if (path_part.split("/").some((seg) => seg === ".." || seg === ".")) {
    return { ok: false, error: "api:// path must not contain . or .. segments" };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path_part)) {
    return { ok: false, error: "api:// path must not embed another scheme" };
  }

  const params: Record<string, string> = {};
  if (query) {
    for (const pair of query.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair).trim();
      const v = decodeURIComponent(eq >= 0 ? pair.slice(eq + 1) : "");
      if (k && !(k in params)) params[k] = v;
    }
  }

  const prefix = (options?.api_prefix ?? "/api").replace(/\/$/, "") || "/api";
  const http_path = `${prefix}/${path_part}${query ? `?${query}` : ""}`;

  return {
    ok: true,
    ref: {
      raw,
      scheme: "api",
      path: path_part,
      query,
      params,
      http_path,
    },
  };
}

/**
 * Resolve `api://` to an HTTP path under the API prefix.
 * @throws Error with a clear message when invalid.
 */
export function resolve_api_data_source(
  raw: unknown,
  options?: { api_prefix?: string },
): ApiDataSourceRef {
  const result = parse_api_data_source(raw, options);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.ref;
}

/**
 * Walk a descriptor props bag and collect every `api://` string value
 * found under common keys (`source`, `dataSource`, `href`, or any string value).
 */
export function collect_api_data_sources(
  node: { props?: Record<string, unknown>; children?: unknown[] },
): string[] {
  const found: string[] = [];
  const visit_value = (v: unknown) => {
    if (is_api_data_source(v)) {
      if (!found.includes(v.trim())) found.push(v.trim());
      return;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const child of Object.values(v as Record<string, unknown>)) {
        visit_value(child);
      }
    }
    if (Array.isArray(v)) {
      for (const item of v) visit_value(item);
    }
  };
  visit_value(node.props);
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (c && typeof c === "object") {
        collect_api_data_sources(
          c as { props?: Record<string, unknown>; children?: unknown[] },
        ).forEach((s) => {
          if (!found.includes(s)) found.push(s);
        });
      }
    }
  }
  return found;
}

/**
 * Bind resolved JSON data into a table props bag.
 * When `props.source` is `api://…` and `rows` is missing/empty, sets `rows`
 * from `payload.data` (array) or `payload` if array.
 * Pure helper — does not fetch.
 */
export function bind_api_payload_to_props(
  props: Record<string, unknown>,
  payload: unknown,
): Record<string, unknown> {
  const next = { ...props };
  let rows: unknown[] | null = null;
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (payload && typeof payload === "object") {
    const data = (payload as Record<string, unknown>)["data"];
    if (Array.isArray(data)) rows = data;
  }
  if (rows) {
    next["rows"] = rows;
    next["bound"] = true;
    next["bound_count"] = rows.length;
  } else {
    next["bound"] = false;
    next["bound_error"] = "Payload has no array data";
  }
  return next;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion PARSE / RESOLVE
// (o==================================================================o)
