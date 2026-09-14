// (o==================================================================o)
//   #region SEMVER LITE
// (o-----------------------------------------------------------\/-----o)

/**
 * Minimal semver helpers for kirlet compat gates.
 * Supports only `^X.Y.Z` and `>=A <B` (space-separated). Zero deps.
 */

export type SemverParts = { major: number; minor: number; patch: number };

export function parse_semver(version: string): SemverParts | null {
  const raw = version.trim().replace(/^v/i, "");
  const m = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function cmp(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function gte(a: SemverParts, b: SemverParts): boolean {
  return cmp(a, b) >= 0;
}

function lt(a: SemverParts, b: SemverParts): boolean {
  return cmp(a, b) < 0;
}

/**
 * Check whether `version` satisfies a simple range.
 * - exact `X.Y.Z`
 * - caret `^X.Y.Z` → >=X.Y.Z <(X+1).0.0  (for 0.Y.Z: >=0.Y.Z <0.(Y+1).0)
 * - compound `>=A <B` (space-separated; optional on either side alone)
 */
export function semver_satisfies(version: string, range: string): boolean {
  const v = parse_semver(version);
  if (!v) return false;
  const r = range.trim();
  if (!r) return false;

  if (r.startsWith("^")) {
    const base = parse_semver(r.slice(1));
    if (!base) return false;
    if (!gte(v, base)) return false;
    if (base.major > 0) {
      return v.major === base.major;
    }
    // 0.Y.Z caret: only same minor
    return v.major === 0 && v.minor === base.minor;
  }

  // compound: >=A <B or just >=A or <B
  if (r.includes(" ") || r.startsWith(">=") || r.startsWith("<") || r.startsWith(">")) {
    const tokens = r.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      if (tok.startsWith(">=")) {
        const base = parse_semver(tok.slice(2));
        if (!base || !gte(v, base)) return false;
      } else if (tok.startsWith(">")) {
        const base = parse_semver(tok.slice(1));
        if (!base || !(cmp(v, base) > 0)) return false;
      } else if (tok.startsWith("<=")) {
        const base = parse_semver(tok.slice(2));
        if (!base || cmp(v, base) > 0) return false;
      } else if (tok.startsWith("<")) {
        const base = parse_semver(tok.slice(1));
        if (!base || !lt(v, base)) return false;
      } else {
        // bare version in compound — treat as exact
        const base = parse_semver(tok);
        if (!base || cmp(v, base) !== 0) return false;
      }
    }
    return true;
  }

  // exact
  const exact = parse_semver(r);
  if (!exact) return false;
  return cmp(v, exact) === 0;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion SEMVER LITE
// (o==================================================================o)
