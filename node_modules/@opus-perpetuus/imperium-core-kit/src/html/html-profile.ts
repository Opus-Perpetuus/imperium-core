// (o==================================================================o)
//   #region KIRTEXTO — HTML PROFILE (single source of policy)
// (o-----------------------------------------------------------\/-----o)

/**
 * Kirtexto is NOX's HTML pipeline for untrusted rich text — chiefly product
 * descriptions that suppliers hand over as raw HTML.
 *
 * The policy lives here, in the kit, so the API, the Angular renderer and any
 * kirlet all enforce exactly the same thing. The kit stays DOM-free: callers
 * inject a DOMPurify-compatible sanitizer (see `sanitize-html.ts`).
 *
 * Two deliberate omissions, both in service of "siempre se ve bien":
 * - `class` and `id` are dropped. Supplier markup that borrows Kirita class
 *   names would either look broken or impersonate our own chrome.
 * - `style` is dropped entirely (see `normalize-html.ts`). Inline styling is
 *   the single biggest reason pasted supplier HTML looks wrong in a dark
 *   theme. Kirita's stylesheet owns presentation.
 */

/** Structural + inline elements Kirtexto keeps. */
export const NOX_HTML_ALLOWED_TAGS: readonly string[] = [
  // flow
  "p", "br", "hr", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6",
  // inline emphasis
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins",
  "mark", "small", "sub", "sup",
  // lists
  "ul", "ol", "li", "dl", "dt", "dd",
  // quotes and code
  "blockquote", "pre", "code", "kbd", "samp", "var",
  // links and media
  "a", "img", "figure", "figcaption",
  // tables
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "caption", "colgroup", "col",
  // misc semantic
  "abbr", "cite", "q", "time", "address",
];

/** Attributes Kirtexto keeps. Note the absence of `class`, `id` and `style`. */
export const NOX_HTML_ALLOWED_ATTR: readonly string[] = [
  "href", "src", "alt", "title", "target", "rel", "loading", "decoding",
  "colspan", "rowspan", "scope", "headers", "span",
  "datetime", "cite", "dir", "lang",
];

/**
 * Never allowed, listed explicitly rather than relied upon by omission.
 * `svg` and `math` are excluded because their foreign-content parsing is a
 * recurring source of mutation-XSS.
 */
export const NOX_HTML_FORBIDDEN_TAGS: readonly string[] = [
  "script", "style", "iframe", "object", "embed", "applet",
  "form", "input", "button", "select", "textarea", "option", "label",
  "link", "meta", "base", "title", "head", "body", "html",
  "svg", "math", "template", "noscript", "slot",
  "frame", "frameset", "noframes",
  "audio", "video", "source", "track", "canvas", "map", "area",
];

export const NOX_HTML_FORBIDDEN_ATTR: readonly string[] = [
  "style", "class", "id", "srcset", "sizes", "ping", "formaction",
  "background", "bgcolor", "color", "align", "valign", "border",
  "cellpadding", "cellspacing", "width", "height", "hspace", "vspace",
];

/**
 * Permitted URL schemes. `data:` is allowed for images only — suppliers do
 * embed thumbnails that way — and is matched narrowly.
 */
export const NOX_HTML_URI_REGEXP =
  /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$)|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i;

/**
 * DOMPurify-shaped config. Kept as a plain object so both `dompurify` (browser)
 * and `isomorphic-dompurify` (server) accept it without adaptation.
 *
 * `USE_PROFILES` is deliberately absent: setting it makes DOMPurify **ignore**
 * `ALLOWED_TAGS` / `ALLOWED_ATTR` in favour of its own built-in profile, which
 * silently reduces this policy to just the FORBID_* lists. The allowlists above
 * are the policy, so they must be the ones in force.
 */
export const NOX_HTML_PURIFY_CONFIG = {
  ALLOWED_TAGS: [...NOX_HTML_ALLOWED_TAGS],
  ALLOWED_ATTR: [...NOX_HTML_ALLOWED_ATTR],
  FORBID_TAGS: [...NOX_HTML_FORBIDDEN_TAGS],
  FORBID_ATTR: [...NOX_HTML_FORBIDDEN_ATTR],
  ALLOWED_URI_REGEXP: NOX_HTML_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  WHOLE_DOCUMENT: false,
  SANITIZE_DOM: true,
} as const;

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRTEXTO — HTML PROFILE
// (o==================================================================o)
