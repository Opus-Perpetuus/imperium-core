// (o==================================================================o)
//   #region KIRLET ROUTE MATCHER (typed params, no deps)
// (o-----------------------------------------------------------\/-----o)

/**
 * Route pattern: `"METHOD /path/:param"` or `"METHOD /path/*"` (wildcard only final).
 * Params are extracted as template-literal types when the pattern is a const string.
 */
export type RoutePattern = `${string} /${string}`;

/** Extract `:param` names from a path template into a param record type. */
export type ExtractParams<Path extends string> =
  Path extends `${string}:${infer Rest}`
    ? Rest extends `${infer Name}/${infer After}`
      ? { [K in Name | keyof ExtractParams<`/${After}`>]: string }
      : Rest extends `${infer Name}`
        ? { [K in Name]: string }
        : {}
    : {};

/** Params object type for a full `"METHOD /path"` pattern. */
export type ParamsOfPattern<P extends string> = P extends `${string} ${infer Path}`
  ? ExtractParams<Path>
  : Record<string, string>;

export type CompiledRoute = {
  method: string;
  /** Path segments; `:name` for params, `*` for trailing wildcard (final only). */
  segments: Array<{ kind: "lit"; value: string } | { kind: "param"; name: string } | { kind: "wild" }>;
  /** Original pattern for debugging. */
  pattern: string;
};

export type RouteMatchOk<P extends Record<string, string> = Record<string, string>> = {
  ok: true;
  params: P;
  /** Remainder after `*` segment (no leading slash), empty if no wildcard. */
  wildcard?: string;
};

export type RouteMatchMiss = { ok: false; reason: "miss" };
export type RouteMatchMethodMismatch = {
  ok: false;
  reason: "method_mismatch";
  /** HTTP methods that would match this path. */
  allowed: string[];
};

export type RouteMatchResult<P extends Record<string, string> = Record<string, string>> =
  | RouteMatchOk<P>
  | RouteMatchMiss
  | RouteMatchMethodMismatch;

function split_path(path: string): string[] {
  const clean = path.split("?")[0] ?? path;
  const trimmed = clean.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return [];
  return trimmed.split("/").filter((s) => s.length > 0);
}

/**
 * Compile a route pattern into a matcher structure.
 * Throws if `*` is not the final segment or pattern is malformed.
 */
export function compile_route(pattern: string): CompiledRoute {
  const space = pattern.indexOf(" ");
  if (space <= 0) {
    throw new Error(`Invalid route pattern (missing METHOD): ${pattern}`);
  }
  const method = pattern.slice(0, space).toUpperCase();
  const path_part = pattern.slice(space + 1).trim();
  if (!path_part.startsWith("/")) {
    throw new Error(`Invalid route pattern (path must start with /): ${pattern}`);
  }
  const raw_segs = split_path(path_part);
  const segments: CompiledRoute["segments"] = [];
  for (let i = 0; i < raw_segs.length; i++) {
    const seg = raw_segs[i]!;
    if (seg === "*") {
      if (i !== raw_segs.length - 1) {
        throw new Error(`Wildcard * must be final segment: ${pattern}`);
      }
      segments.push({ kind: "wild" });
      continue;
    }
    if (seg.startsWith(":")) {
      const name = seg.slice(1);
      if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`Invalid param name in route: ${pattern}`);
      }
      segments.push({ kind: "param", name });
      continue;
    }
    segments.push({ kind: "lit", value: seg });
  }
  return { method, segments, pattern };
}

/**
 * Match a single compiled route against method + path.
 */
export function match_compiled(
  compiled: CompiledRoute,
  method: string,
  path: string,
): RouteMatchResult {
  const path_segs = split_path(path);
  const params: Record<string, string> = {};
  let pi = 0;
  for (let i = 0; i < compiled.segments.length; i++) {
    const seg = compiled.segments[i]!;
    if (seg.kind === "wild") {
      const rest = path_segs.slice(pi).join("/");
      if (compiled.method !== method.toUpperCase()) {
        return { ok: false, reason: "method_mismatch", allowed: [compiled.method] };
      }
      return { ok: true, params, wildcard: rest };
    }
    if (pi >= path_segs.length) {
      return { ok: false, reason: "miss" };
    }
    const actual = path_segs[pi]!;
    if (seg.kind === "lit") {
      if (seg.value !== actual) return { ok: false, reason: "miss" };
    } else if (seg.kind === "param") {
      params[seg.name] = decodeURIComponent(actual);
    }
    pi++;
  }
  if (pi !== path_segs.length) {
    return { ok: false, reason: "miss" };
  }
  if (compiled.method !== method.toUpperCase()) {
    return { ok: false, reason: "method_mismatch", allowed: [compiled.method] };
  }
  return { ok: true, params };
}

/**
 * Compile + match a single pattern (convenience).
 */
export function match_route(
  pattern: string,
  method: string,
  path: string,
): RouteMatchResult {
  return match_compiled(compile_route(pattern), method, path);
}

export type RouteTableEntry<P extends Record<string, string> = Record<string, string>> = {
  pattern: string;
  compiled: CompiledRoute;
  /** Opaque handler payload stored by authoring layer. */
  handler: unknown;
  access?: string;
  public_access?: "anonymous" | "external";
  raw?: boolean;
  _params?: P;
};

/**
 * Match method+path against a table of compiled routes.
 * Aggregates Allow methods on method_mismatch when path would match another method.
 */
export function match_route_table(
  table: Array<{ compiled: CompiledRoute }>,
  method: string,
  path: string,
):
  | { ok: true; index: number; params: Record<string, string>; wildcard?: string }
  | { ok: false; reason: "miss" }
  | { ok: false; reason: "method_mismatch"; allowed: string[] } {
  const allowed = new Set<string>();
  let path_matched = false;

  for (let i = 0; i < table.length; i++) {
    const entry = table[i]!;
    const result = match_compiled(entry.compiled, method, path);
    if (result.ok) {
      return {
        ok: true,
        index: i,
        params: result.params,
        wildcard: result.wildcard,
      };
    }
    if (result.reason === "method_mismatch") {
      path_matched = true;
      for (const m of result.allowed) allowed.add(m);
    }
  }

  if (path_matched) {
    return {
      ok: false,
      reason: "method_mismatch",
      allowed: [...allowed].sort(),
    };
  }
  return { ok: false, reason: "miss" };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET ROUTE MATCHER
// (o==================================================================o)
