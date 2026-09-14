import { describe, expect, test } from "bun:test";
import DOMPurify from "isomorphic-dompurify";
import { sanitize_nox_html, html_to_text, type NoxHtmlPurifier } from "./sanitize-html.js";
import { normalize_provider_html } from "./normalize-html.js";

// isomorphic-dompurify already carries a jsdom window; its shape matches the
// narrow interface the kit asks for.
const purifier = DOMPurify as unknown as NoxHtmlPurifier;
const clean = (html: string) => sanitize_nox_html(html, purifier);

// (o==================================================================o)
//   #region HOSTILE INPUT
// (o-----------------------------------------------------------\/-----o)

describe("sanitize_nox_html — hostile input", () => {
  const attacks: Array<[string, string]> = [
    ["script tag", '<p>ok</p><script>alert(1)</script>'],
    ["img onerror", '<img src=x onerror="alert(1)">'],
    ["svg script", '<svg><script>alert(1)</script></svg>'],
    ["javascript href", '<a href="javascript:alert(1)">click</a>'],
    ["JaVaScRiPt href", '<a href="JaVaScRiPt:alert(1)">click</a>'],
    ["href with tab", '<a href="java\tscript:alert(1)">click</a>'],
    ["style expression", '<div style="width:expression(alert(1))">x</div>'],
    ["style tag", '<style>body{background:url("javascript:alert(1)")}</style>'],
    ["iframe", '<iframe src="https://evil.test"></iframe>'],
    ["object", '<object data="evil.swf"></object>'],
    ["embed", '<embed src="evil.swf">'],
    ["form", '<form action="/steal"><input name="pw"></form>'],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
    ["base tag", '<base href="https://evil.test/">'],
    ["onload body", '<body onload="alert(1)">hi</body>'],
    ["nested script", '<scr<script>ipt>alert(1)</script>'],
    ["encoded entity", '<a href="&#106;avascript:alert(1)">x</a>'],
    ["data uri html", '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>'],
    ["srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ["mutation xss", '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ];

  for (const [label, payload] of attacks) {
    test(`neutralises ${label}`, () => {
      const out = clean(payload);
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/onerror/i);
      expect(out).not.toMatch(/onload/i);
      expect(out).not.toMatch(/javascript:/i);
      expect(out).not.toMatch(/<iframe/i);
      expect(out).not.toMatch(/<object/i);
      expect(out).not.toMatch(/<embed/i);
      expect(out).not.toMatch(/<form/i);
      expect(out).not.toMatch(/<style/i);
      expect(out).not.toMatch(/<meta/i);
      expect(out).not.toMatch(/<base/i);
      expect(out).not.toMatch(/srcdoc/i);
    });
  }

  test("keeps the safe text around a stripped script", () => {
    expect(clean('<p>Hola</p><script>alert(1)</script>')).toContain("Hola");
  });

  test("strips a tag that is valid HTML but outside our allowlist", () => {
    // Regression guard: `details`/`summary` sit in DOMPurify's built-in html
    // profile but not in NOX_HTML_ALLOWED_TAGS. If USE_PROFILES ever creeps
    // back into the config it overrides ALLOWED_TAGS and these survive —
    // meaning the allowlist silently stopped being the policy.
    const out = clean("<details><summary>Ver más</summary><p>Detalle</p></details>");
    expect(out).not.toContain("<details");
    expect(out).not.toContain("<summary");
    // KEEP_CONTENT means the prose is preserved, only the wrapper goes.
    expect(out).toContain("Detalle");
  });

  test("a forbidden tag leaves nothing behind", () => {
    expect(clean("<script>x</script>")).toBe("");
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion HOSTILE INPUT
// (o==================================================================o)

// (o==================================================================o)
//   #region CONTENT PRESERVATION
// (o-----------------------------------------------------------\/-----o)

describe("sanitize_nox_html — keeps real content", () => {
  test("preserves structure suppliers actually use", () => {
    const out = clean(`
      <h2>Router AX3000</h2>
      <p>Doble banda con <strong>WiFi 6</strong> y <em>MU-MIMO</em>.</p>
      <ul><li>4 puertos gigabit</li><li>2.4 / 5 GHz</li></ul>
      <table><thead><tr><th>Puerto</th><th>Cantidad</th></tr></thead>
      <tbody><tr><td>RJ45</td><td>4</td></tr></tbody></table>
    `);
    expect(out).toContain("<h2>");
    expect(out).toContain("<strong>");
    expect(out).toContain("<li>");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>");
    expect(out).toContain("Router AX3000");
  });

  test("keeps https images and adds lazy loading with an alt", () => {
    const out = clean('<img src="https://cdn.test/p.jpg">');
    expect(out).toContain('src="https://cdn.test/p.jpg"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('alt=""');
  });

  test("keeps base64 image data uris", () => {
    const src =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";
    expect(clean(`<img src="${src}">`)).toContain("data:image/png;base64,");
  });

  test("external links get noopener and a new tab", () => {
    const out = clean('<a href="https://proveedor.test/ficha">Ficha</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  test("in-page anchors keep their behaviour", () => {
    const out = clean('<a href="#specs">Especificaciones</a>');
    expect(out).not.toContain("target=");
  });

  test("drops class, id and style so Kirita owns presentation", () => {
    const out = clean(
      '<p class="MsoNormal" id="x" style="color:#fff;font-size:34px">Texto</p>',
    );
    expect(out).toBe("<p>Texto</p>");
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion CONTENT PRESERVATION
// (o==================================================================o)

// (o==================================================================o)
//   #region MESSY SUPPLIER MARKUP
// (o-----------------------------------------------------------\/-----o)

describe("sanitize_nox_html — messy supplier markup", () => {
  test("unwraps font/center and strips bgcolor", () => {
    const out = clean(
      '<center><font face="Arial" color="#ff0000" size="5">Oferta</font></center>',
    );
    expect(out).not.toContain("<font");
    expect(out).not.toContain("<center");
    expect(out).not.toContain("color=");
    expect(out).toContain("Oferta");
  });

  test("survives a whole HTML document", () => {
    const out = clean(
      '<!DOCTYPE html><html><head><title>x</title></head><body><p>Contenido</p></body></html>',
    );
    expect(out).toBe("<p>Contenido</p>");
  });

  test("removes Word/Outlook cruft", () => {
    const out = clean(
      '<p class="MsoNormal">Texto<o:p></o:p></p><!--[if gte mso 9]><xml><w:X/></xml><![endif]-->',
    );
    expect(out).toBe("<p>Texto</p>");
  });

  test("closes unbalanced tags instead of leaking them", () => {
    const out = clean("<p>Sin cerrar <strong>negrita<p>Otro párrafo");
    expect(out).toContain("Sin cerrar");
    expect(out).toContain("Otro párrafo");
    // jsdom reconstructs a well-formed tree; nothing dangles.
    expect((out.match(/<strong>/g) ?? []).length).toBe(
      (out.match(/<\/strong>/g) ?? []).length,
    );
  });

  test("collapses <br> runs and drops empty blocks", () => {
    const out = clean("<p>A</p><br><br><br><br><p></p><div>&nbsp;</div><p>B</p>");
    expect(out).not.toMatch(/(?:<br\s*\/?>\s*){3,}/i);
    expect(out).toContain("A");
    expect(out).toContain("B");
  });

  test("is idempotent", () => {
    const messy =
      '<center><font color="red"><p class="MsoNormal">Hola<br><br><br></p></font></center>';
    const once = clean(messy);
    expect(clean(once)).toBe(once);
  });

  test("empty and nullish inputs are empty strings", () => {
    expect(clean("")).toBe("");
    expect(sanitize_nox_html(null, purifier)).toBe("");
    expect(sanitize_nox_html(undefined, purifier)).toBe("");
    expect(clean("   ")).toBe("");
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion MESSY SUPPLIER MARKUP
// (o==================================================================o)

// (o==================================================================o)
//   #region NORMALIZE + TEXT PROJECTION
// (o-----------------------------------------------------------\/-----o)

describe("normalize_provider_html", () => {
  test("is idempotent on its own", () => {
    const once = normalize_provider_html('<center><font size="2">x</font></center>');
    expect(normalize_provider_html(once)).toBe(once);
  });

  test("leaves tables intact rather than guessing at layout", () => {
    const out = normalize_provider_html(
      '<table border="1" cellpadding="4"><tr><td>A</td><td>B</td></tr></table>',
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<td>A</td>");
    expect(out).not.toContain("border=");
    expect(out).not.toContain("cellpadding=");
  });
});

describe("html_to_text", () => {
  test("flattens markup into readable text", () => {
    expect(
      html_to_text("<h2>Router</h2><p>WiFi <strong>6</strong></p>", purifier),
    ).toBe("Router WiFi 6");
  });

  test("truncates on a word boundary with an ellipsis", () => {
    const out = html_to_text(
      "<p>Router inalámbrico de doble banda para oficina</p>",
      purifier,
      20,
    );
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("  ");
  });

  test("script bodies never leak into the text projection", () => {
    expect(html_to_text('<p>ok</p><script>alert("secret")</script>', purifier)).toBe(
      "ok",
    );
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion NORMALIZE + TEXT PROJECTION
// (o==================================================================o)
