// (o==================================================================o)
//   #region KIRTEXTO — SANITIZE (the security boundary)
// (o-----------------------------------------------------------\/-----o)

import { NOX_HTML_PURIFY_CONFIG } from "./html-profile.js";
import { normalize_provider_html } from "./normalize-html.js";

/**
 * The subset of DOMPurify this kit needs. Callers inject a real implementation
 * — `dompurify` in the browser, `isomorphic-dompurify` on the server — so the
 * kit itself stays DOM-free and dependency-free.
 */
export interface NoxHtmlPurifier {
  sanitize(dirty: string, config: Record<string, unknown>): string;
}

/**
 * Sanitize untrusted HTML for display anywhere in NOX.
 *
 * Purify → normalize → purify. The sandwich is deliberate:
 * - The first pass is the security boundary and runs on the raw input, so the
 *   cosmetic regex pass never touches hostile markup.
 * - The second pass is cheap insurance against anything normalization could
 *   have reassembled into a tag.
 *
 * The purifier is a required argument on purpose. An optional one invites a
 * fallback path that returns unsanitized HTML, which is exactly the bug that
 * `sanitize_schema_html` shipped with.
 */
export function sanitize_nox_html(
  input: string | null | undefined,
  purifier: NoxHtmlPurifier,
): string {
  if (!input) return "";
  const config = NOX_HTML_PURIFY_CONFIG as unknown as Record<string, unknown>;
  const first = purifier.sanitize(String(input), config);
  if (!first.trim()) return "";
  const normalized = normalize_provider_html(first);
  if (!normalized.trim()) return "";
  return purifier.sanitize(normalized, config).trim();
}

/**
 * Plain-text projection of HTML, for search indexes, meta descriptions and
 * card excerpts. Sanitizes first so stripped tags cannot leak script bodies.
 */
export function html_to_text(
  input: string | null | undefined,
  purifier: NoxHtmlPurifier,
  max_length?: number,
): string {
  const safe = sanitize_nox_html(input, purifier);
  if (!safe) return "";
  const text = safe
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!max_length || text.length <= max_length) return text;
  return `${text.slice(0, max_length).replace(/\s+\S*$/, "")}…`;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRTEXTO — SANITIZE
// (o==================================================================o)
