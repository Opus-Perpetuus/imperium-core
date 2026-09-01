import { describe, expect, test } from "bun:test";
import DOMPurify from "isomorphic-dompurify";
import {
  apply_landing_code,
  default_home_document,
  plan_landing_document,
  sanitize_page_document_html,
} from "./landing.js";
import {
  is_allowed_ui_component,
  plan_ui_node,
  validate_page_descriptor,
} from "./ui-descriptor.js";
import {
  sanitize_nox_html,
  type NoxHtmlPurifier,
} from "../html/sanitize-html.js";

const purifier = DOMPurify as unknown as NoxHtmlPurifier;
const clean_html = (html: string) => sanitize_nox_html(html, purifier);

function sample_document(children: unknown[]) {
  return {
    id: "portal.home",
    owner: "portal",
    title: "Inicio",
    page: {
      component: "nox.page",
      children,
    },
  };
}

describe("default_home_document", () => {
  test("is a valid page descriptor with at least one child", () => {
    const doc = default_home_document();
    const check = validate_page_descriptor(doc);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(typeof doc["id"]).toBe("string");
    expect(String(doc["id"]).length).toBeGreaterThan(0);
    expect(typeof doc["title"]).toBe("string");
    expect(check.page.page.component).toBe("nox.page");
    expect((check.page.page.children ?? []).length).toBeGreaterThan(0);
  });
});

describe("apply_landing_code", () => {
  test("accepts a tree with a non-MVP allowlisted id and an HTML node", () => {
    expect(is_allowed_ui_component("nox.wizard")).toBe(true);
    const r = apply_landing_code(
      JSON.stringify(
        sample_document([
          { component: "nox.wizard", props: { steps: [] } },
          { component: "nox.html", props: { html: "<p>hola</p>" } },
        ]),
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.document["title"]).toBe("Inicio");
    const page = r.document["page"] as {
      children: Array<{ component: string }>;
    };
    expect(page.children.map((c) => c.component)).toEqual([
      "nox.wizard",
      "nox.html",
    ]);
  });

  test("invalid JSON returns not-ok and does not yield a document", () => {
    const r = apply_landing_code("{ not json");
    expect(r.ok).toBe(false);
    expect("document" in r).toBe(false);
  });

  test("unknown component id evil.widget is rejected", () => {
    const r = apply_landing_code(
      JSON.stringify(
        sample_document([{ component: "evil.widget" }]),
      ),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(
      r.issues.some((i) => i.message.includes("evil.widget")),
    ).toBe(true);
  });
});

describe("sanitize_page_document_html", () => {
  test("strips script and keeps safe markup via the shipped sanitizer", () => {
    const doc = sample_document([
      {
        component: "nox.stack",
        children: [
          {
            component: "nox.html",
            props: { html: "<script>alert(1)</script><p>ok</p>" },
          },
        ],
      },
    ]);
    const out = sanitize_page_document_html(doc, clean_html) as typeof doc;
    const html = (
      out.page.children[0] as {
        children: Array<{ props: { html: string } }>;
      }
    ).children[0]!.props.html;
    expect(html).not.toContain("script");
    expect(html).toContain("ok");
    expect(
      (
        doc.page.children[0] as {
          children: Array<{ props: { html: string } }>;
        }
      ).children[0]!.props.html,
    ).toContain("script");
  });
});

describe("plan_landing_document", () => {
  test("does not reject an allowlisted catalog id and sanitizes HTML", () => {
    const planned = plan_landing_document(
      sample_document([
        { component: "nox.wizard", props: { steps: [] } },
        {
          component: "nox.html",
          props: { html: "<script>alert(1)</script><p>ok</p>" },
        },
      ]),
      { sanitize: clean_html },
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const wizard = plan_ui_node({
      component: "nox.wizard",
      props: { steps: [] },
    });
    expect(wizard.kind).toBe("node");
    if (wizard.kind === "node") {
      expect(wizard.component).toBe("nox.wizard");
    }
    const html_child = planned.page.page.children?.find(
      (c) => c.component === "nox.html",
    );
    expect(html_child).toBeDefined();
    const html = String(html_child?.props?.["html"] ?? "");
    expect(html).not.toContain("script");
    expect(html).toContain("ok");
  });
});
