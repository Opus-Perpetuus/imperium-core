// (o==================================================================o)
//   #region LANDING DOCUMENT (pure default / apply / sanitize)
// (o-----------------------------------------------------------\/-----o)

import { PUBLIC_SESSION_START_PATH } from "../auth/principal.js";
import {
  plan_ui_node,
  validate_page_descriptor,
  type NoxPageValidationResult,
  type NoxUiRenderPlan,
  type NoxUiValidationIssue,
} from "./ui-descriptor.js";

export type LandingCodeApplyResult =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; issues: NoxUiValidationIssue[] };

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structured_clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Default published home so the public root is never blank on a fresh install.
 * Valid against the full `nox.*` allowlist (not the MVP bind set).
 */
export function default_home_document(): Record<string, unknown> {
  return {
    id: "portal.home",
    owner: "portal",
    title: "Inicio",
    page: {
      component: "nox.page",
      children: [
        {
          component: "nox.markdown-view",
          props: {
            block: "hero",
            content:
              "# Bienvenido\n\nConfigura esta landing desde el administrador.",
          },
        },
        {
          component: "nox.stack",
          props: { gap: 1 },
          children: [
            {
              component: "nox.button",
              text: "Entrar",
              props: { href: `/${PUBLIC_SESSION_START_PATH}` },
            },
          ],
        },
      ],
    },
  };
}

/**
 * Parse landing JSON. Invalid JSON or unknown component ids never return a
 * partial document — the caller keeps the last good one.
 *
 * Unlike Kirel's MVP bind set, this accepts every catalog `nox.*` id.
 */
export function apply_landing_code(text: string): LandingCodeApplyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          message: e instanceof Error ? e.message : "JSON inválido",
        },
      ],
    };
  }
  const check = validate_page_descriptor(parsed);
  if (check.ok === false) {
    return { ok: false, issues: check.issues };
  }
  return { ok: true, document: parsed as Record<string, unknown> };
}

/**
 * Walk a draft/published page document and sanitize every `nox.html` node's
 * `props.html` before persist. Returns a deep-cloned document.
 */
export function sanitize_page_document_html(
  document: unknown,
  sanitize: (html: string) => string,
): unknown {
  if (!is_plain_object(document)) return document;
  const clone = structured_clone_json(document);
  const page = clone["page"];
  if (is_plain_object(page)) {
    walk_and_sanitize(page, sanitize);
  }
  return clone;
}

function walk_and_sanitize(
  node: Record<string, unknown>,
  sanitize: (html: string) => string,
): void {
  if (node["component"] === "nox.html") {
    const props = node["props"];
    if (is_plain_object(props) && typeof props["html"] === "string") {
      props["html"] = sanitize(props["html"]);
    }
  }
  const children = node["children"];
  if (Array.isArray(children)) {
    for (const child of children) {
      if (is_plain_object(child)) walk_and_sanitize(child, sanitize);
    }
  }
}

/**
 * Validate + optionally sanitize a landing descriptor, then plan the root
 * node with the shipped `plan_ui_node`. Allowlisted catalog ids are not
 * rejected (unbound nodes stay `kind: "node"` with `mvp_bound: false`).
 */
export function plan_landing_document(
  input: unknown,
  opts?: { sanitize?: (html: string) => string },
): NoxPageValidationResult & { root?: NoxUiRenderPlan } {
  const prepared = opts?.sanitize
    ? sanitize_page_document_html(input, opts.sanitize)
    : input;
  const check = validate_page_descriptor(prepared);
  if (check.ok === false) return check;
  return {
    ...check,
    root: plan_ui_node(check.page.page),
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion LANDING DOCUMENT
// (o==================================================================o)
