// (o==================================================================o)
//   #region KIRTEXTO — NORMALIZE (cosmetic, never a security boundary)
// (o-----------------------------------------------------------\/-----o)

/**
 * Cosmetic clean-up of supplier HTML.
 *
 * IMPORTANT: this is **not** a sanitizer. It runs between two DOMPurify passes
 * (see `sanitize-html.ts`) and must never be trusted on its own. Regex over
 * HTML is fine for tidying already-sanitized markup; it is not fine as a
 * security boundary. `sanitize_schema_html` used to make exactly that mistake.
 *
 * Everything here is idempotent: running it twice yields the same string.
 */

/** Elements whose tags we unwrap while keeping their text. */
const UNWRAP_TAGS = ["font", "center", "marquee", "blink", "big", "tt", "nobr"];

/** Presentational attributes that fight the Kirita dark theme. */
const DROP_ATTRS = [
  "style", "class", "id", "bgcolor", "background", "color", "text",
  "link", "vlink", "alink", "align", "valign", "border", "cellpadding",
  "cellspacing", "width", "height", "hspace", "vspace", "face", "size",
  "frame", "rules", "nowrap", "compact", "clear", "srcset", "sizes",
];

/** Block elements that carry no meaning when empty. */
const EMPTIABLE = ["p", "div", "span", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"];

function strip_comments(html: string): string {
  // Includes IE conditional comments, which Word/Outlook exports are full of.
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function strip_document_wrappers(html: string): string {
  // Suppliers routinely send a whole document where a fragment was expected.
  return html
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<\/?(?:html|head|body)(?:\s[^>]*)?>/gi, "");
}

function strip_dangerous_blocks(html: string): string {
  // DOMPurify handles these too; doing it first means the cosmetic passes
  // below never see script/style bodies as if they were text.
  return html
    .replace(
      /<\s*(script|style|iframe|object|embed|applet|noscript|template)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
      "",
    )
    .replace(
      /<\s*(script|style|iframe|object|embed|applet|noscript|template|link|meta|base)\b[^>]*\/?>/gi,
      "",
    );
}

function strip_office_cruft(html: string): string {
  return html
    .replace(/<\/?[a-z]+:[a-z-]+(?:\s[^>]*)?>/gi, "") // <o:p>, <w:WordDocument>
    .replace(/<\s*xml\b[\s\S]*?<\s*\/\s*xml\s*>/gi, "")
    .replace(/\s(?:class|style)\s*=\s*"[^"]*Mso[^"]*"/gi, "");
}

function unwrap_presentational_tags(html: string): string {
  let out = html;
  for (const tag of UNWRAP_TAGS) {
    out = out
      .replace(new RegExp(`<\\s*${tag}(?:\\s[^>]*)?>`, "gi"), "")
      .replace(new RegExp(`<\\s*/\\s*${tag}\\s*>`, "gi"), "");
  }
  return out;
}

function drop_presentational_attributes(html: string): string {
  const pattern = new RegExp(
    `\\s(?:${DROP_ATTRS.join("|")})\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`,
    "gi",
  );
  // Only inside tags, so attribute-looking text in prose survives untouched.
  return html.replace(/<[a-z][^>]*>/gi, (tag) => tag.replace(pattern, ""));
}

function strip_event_handlers(html: string): string {
  return html.replace(/<[a-z][^>]*>/gi, (tag) =>
    tag.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""),
  );
}

function harden_links(html: string): string {
  return html.replace(/<a\b([^>]*)>/gi, (full, attrs: string) => {
    const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const value = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    // Same-document anchors keep their in-page behaviour.
    if (!value || value.startsWith("#")) return full;
    let next = attrs
      .replace(/\starget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\srel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    next += ' target="_blank" rel="noopener noreferrer"';
    return `<a${next}>`;
  });
}

function harden_images(html: string): string {
  return html.replace(/<img\b([^>]*?)\/?>/gi, (_full, attrs: string) => {
    let next = attrs
      .replace(/\sloading\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\sdecoding\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    // An explicit empty alt marks the image decorative, which beats no alt.
    if (!/\balt\s*=/i.test(next)) next += ' alt=""';
    next += ' loading="lazy" decoding="async"';
    return `<img${next}>`;
  });
}

function collapse_breaks(html: string): string {
  // Three or more <br> in a row are a paragraph break written badly.
  return html.replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br><br>");
}

function drop_empty_blocks(html: string): string {
  const pattern = new RegExp(
    `<(${EMPTIABLE.join("|")})(?:\\s[^>]*)?>(?:\\s|&nbsp;|<br\\s*/?>)*<\\/\\1>`,
    "gi",
  );
  let out = html;
  let previous: string;
  // Nested wrappers collapse one layer per pass; loop until stable.
  do {
    previous = out;
    out = out.replace(pattern, "");
  } while (out !== previous);
  return out;
}

function collapse_whitespace(html: string): string {
  return html
    .replace(/&nbsp;(?:\s*&nbsp;)+/gi, "&nbsp;")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Tidy supplier HTML into something that renders predictably.
 *
 * Deliberately *not* done: converting layout tables into divs. Guessing which
 * tables are layout destroys row/column relationships and screen-reader
 * semantics when the guess is wrong. Presentational table attributes are
 * stripped instead, and Kirita's stylesheet handles the rest.
 */
export function normalize_provider_html(input: string | null | undefined): string {
  if (!input) return "";
  let html = String(input);
  html = strip_comments(html);
  html = strip_document_wrappers(html);
  html = strip_dangerous_blocks(html);
  html = strip_office_cruft(html);
  html = unwrap_presentational_tags(html);
  html = strip_event_handlers(html);
  html = drop_presentational_attributes(html);
  html = harden_links(html);
  html = harden_images(html);
  html = collapse_breaks(html);
  html = drop_empty_blocks(html);
  html = collapse_whitespace(html);
  return html;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRTEXTO — NORMALIZE
// (o==================================================================o)
