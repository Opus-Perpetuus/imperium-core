// (o==================================================================o)
//   #region UI DESCRIPTOR TYPES
// (o-----------------------------------------------------------\/-----o)

/** Canonical catalog: docs/contracts/ui-components.md */
export type NoxUiComponentId =
  | "nox.alert"
  | "nox.attachments"
  | "nox.badge"
  | "nox.breadcrumb"
  | "nox.button"
  | "nox.card"
  | "nox.catalog-grid"
  | "nox.carousel"
  | "nox.chart"
  | "nox.input-checkbox-group"
  | "nox.input-choice"
  | "nox.code"
  | "nox.collapsible"
  | "nox.color"
  | "nox.comments"
  | "nox.context-menu"
  | "nox.coordinates"
  | "nox.input-date-range"
  | "nox.input-datetime"
  | "nox.detail"
  | "nox.empty"
  | "nox.error-page"
  | "nox.excel-import"
  | "nox.input-file"
  | "nox.file-preview"
  | "nox.filters"
  | "nox.floating"
  | "nox.feature-shell"
  | "nox.form"
  | "nox.global-search"
  | "nox.header-actions"
  | "nox.history"
  | "nox.html"
  | "nox.icon-picker"
  | "nox.input-image"
  | "nox.image-viewer"
  | "nox.input-text"
  | "nox.input-password"
  | "nox.input-textarea"
  | "nox.input-json"
  | "nox.input-number"
  | "nox.input-date"
  | "nox.input-checkbox"
  | "nox.input-hidden"
  | "nox.input-menu"
  | "nox.link"
  | "nox.loading-overlay"
  | "nox.login"
  | "nox.markdown"
  | "nox.markdown-view"
  | "nox.mask"
  | "nox.menu-button"
  | "nox.input-money"
  | "nox.month"
  | "nox.numpad"
  | "nox.object"
  | "nox.page"
  | "nox.paginator"
  | "nox.pdf-preview"
  | "nox.preloader"
  | "nox.progress"
  | "nox.scanner"
  | "nox.search"
  | "nox.share-banner"
  | "nox.shell"
  | "nox.sidebar"
  | "nox.signature"
  | "nox.smart-actions"
  | "nox.sort"
  | "nox.spinner"
  | "nox.split"
  | "nox.stack"
  | "nox.stats"
  | "nox.status"
  | "nox.status-history"
  | "nox.status-progress"
  | "nox.table"
  | "nox.tabs"
  | "nox.tag"
  | "nox.input-time"
  | "nox.timeline"
  | "nox.timer"
  | "nox.toolbar"
  | "nox.topbar"
  | "nox.validation"
  | "nox.week"
  | "nox.wizard"
  | "nox.year";

export const NOX_UI_COMPONENT_ALLOWLIST: readonly NoxUiComponentId[] = [
  "nox.alert",
  "nox.attachments",
  "nox.badge",
  "nox.breadcrumb",
  "nox.button",
  "nox.card",
  "nox.catalog-grid",
  "nox.carousel",
  "nox.chart",
  "nox.input-checkbox-group",
  "nox.input-choice",
  "nox.code",
  "nox.collapsible",
  "nox.color",
  "nox.comments",
  "nox.context-menu",
  "nox.coordinates",
  "nox.input-date-range",
  "nox.input-datetime",
  "nox.detail",
  "nox.empty",
  "nox.error-page",
  "nox.excel-import",
  "nox.input-file",
  "nox.file-preview",
  "nox.filters",
  "nox.floating",
  "nox.feature-shell",
  "nox.form",
  "nox.global-search",
  "nox.header-actions",
  "nox.history",
  "nox.html",
  "nox.icon-picker",
  "nox.input-image",
  "nox.image-viewer",
  "nox.input-text",
  "nox.input-password",
  "nox.input-textarea",
  "nox.input-json",
  "nox.input-number",
  "nox.input-date",
  "nox.input-checkbox",
  "nox.input-hidden",
  "nox.input-menu",
  "nox.link",
  "nox.loading-overlay",
  "nox.login",
  "nox.markdown",
  "nox.markdown-view",
  "nox.mask",
  "nox.menu-button",
  "nox.input-money",
  "nox.month",
  "nox.numpad",
  "nox.object",
  "nox.page",
  "nox.paginator",
  "nox.pdf-preview",
  "nox.preloader",
  "nox.progress",
  "nox.scanner",
  "nox.search",
  "nox.share-banner",
  "nox.shell",
  "nox.sidebar",
  "nox.signature",
  "nox.smart-actions",
  "nox.sort",
  "nox.spinner",
  "nox.split",
  "nox.stack",
  "nox.stats",
  "nox.status",
  "nox.status-history",
  "nox.status-progress",
  "nox.table",
  "nox.tabs",
  "nox.tag",
  "nox.input-time",
  "nox.timeline",
  "nox.timer",
  "nox.toolbar",
  "nox.topbar",
  "nox.validation",
  "nox.week",
  "nox.wizard",
  "nox.year",
] as const;

/**
 * Subset the Phase 6 MVP host maps to real Kirita components.
 * Full allowlist still rejects non-catalog ids at validation time.
 */
export const NOX_UI_MVP_RENDER_IDS: readonly NoxUiComponentId[] = [
  "nox.page",
  "nox.stack",
  "nox.card",
  "nox.alert",
  "nox.badge",
  "nox.button",
  "nox.empty",
  "nox.table",
  "nox.tag",
  /** Phase 9 — form shell + text field for bound pages / HR registration. */
  "nox.form",
  "nox.input-text",
  "nox.toolbar",
  /** Feature-shell parity + full input/stats set for kirlets. */
  "nox.feature-shell",
  "nox.stats",
  "nox.input-date",
  "nox.input-menu",
  "nox.input-number",
  "nox.input-textarea",
  "nox.input-json",
  "nox.input-checkbox",
  "nox.input-password",
  "nox.input-file",
  /** Public storefront (catalog grid, copy, search, pagination, multi-image). */
  "nox.catalog-grid",
  "nox.markdown-view",
  "nox.search",
  "nox.paginator",
  "nox.carousel",
  /** Declarative control of the global loading overlay (long kirlet jobs). */
  "nox.loading-overlay",
  /**
   * Navigation. Without these a descriptor page is a dead end: `nox.button`
   * had no click handler at all, so the only way to move between kirlet pages
   * was a plain `<a>` smuggled through markdown, which reloads the whole SPA.
   */
  "nox.link",
  "nox.input-hidden",
  /** Sanitized rich text (Kirtexto). See docs/contracts/ui-descriptor.md. */
  "nox.html",
  /** Detail/record views and tabbed layouts for real product + admin pages. */
  "nox.detail",
  "nox.tabs",
  "nox.input-money",
  "nox.image-viewer",
  "nox.input-image",
  /**
   * Storefront catalogue layout: a sidebar of facet filters next to the
   * product grid. Both were allowlisted but unbound, so every catalogue page
   * rendered its filters stacked above the products with a warning banner.
   */
  "nox.filters",
  "nox.split",
  /** Storefront facet sidebar: exclusive open group + radio/switch filters. */
  "nox.collapsible",
  "nox.input-choice",
] as const;

/** Single node in a declarative UI tree (no raw HTML). */
export type NoxUiNode = {
  component: string;
  props?: Record<string, unknown>;
  /** Nested composition */
  children?: NoxUiNode[];
  /** Projected text content for leaf-ish nodes (button label, badge text, …) */
  text?: string;
};

export type NoxPageRealmInternal = {
  path: string;
  permission?: string;
};

/**
 * Loading overlay policy for a kirlet page.
 *
 * NOX already shows the overlay automatically for gateway calls that outlast
 * the threshold, so this only exists to opt a page *out* or to give its waits
 * a better sentence than the generic catalog entry.
 */
export type NoxPagePreloader = {
  /** Default true — set false for pages that render their own progress. */
  enabled?: boolean;
  /** Line logged while this page loads. */
  message?: string;
};

export type NoxPageDescriptor = {
  id: string;
  owner: string;
  title: string;
  realms?: {
    internal?: NoxPageRealmInternal;
    public?: { enabled?: boolean; path?: string };
  };
  menu?: {
    label: string;
    order?: number;
    realm?: string;
    permission?: string;
  };
  /** Loading overlay behaviour while this page loads. */
  preloader?: NoxPagePreloader;
  /** Root of the declarative tree (typically nox.page). */
  page: NoxUiNode;
};

export type NoxUiValidationIssue = {
  path: string;
  message: string;
  component?: string;
};

export type NoxUiValidationResult =
  | { ok: true; node: NoxUiNode }
  | { ok: false; issues: NoxUiValidationIssue[] };

export type NoxPageValidationResult =
  | { ok: true; page: NoxPageDescriptor }
  | { ok: false; issues: NoxUiValidationIssue[] };

/** Plan for the host renderer — never throws on bad input. */
export type NoxUiRenderPlan =
  | {
      kind: "node";
      component: NoxUiComponentId;
      props: Record<string, unknown>;
      children: NoxUiNode[];
      text: string | null;
      mvp_bound: boolean;
      path: string;
    }
  | {
      kind: "unknown";
      component: string;
      path: string;
      message: string;
    }
  | {
      kind: "invalid";
      path: string;
      message: string;
    };

// (o-----------------------------------------------------------/\-----o)
//   #endregion UI DESCRIPTOR TYPES
// (o==================================================================o)

// (o==================================================================o)
//   #region ALLOWLIST / VALIDATION
// (o-----------------------------------------------------------\/-----o)

export function is_allowed_ui_component(id: string): id is NoxUiComponentId {
  return (NOX_UI_COMPONENT_ALLOWLIST as readonly string[]).includes(id);
}

export function is_mvp_render_component(id: string): id is NoxUiComponentId {
  return (NOX_UI_MVP_RENDER_IDS as readonly string[]).includes(id);
}

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a UI tree against the full `nox.*` allowlist.
 * Unknown component ids are rejected with path-qualified issues.
 */
export function validate_ui_tree(
  input: unknown,
  path = "$",
): NoxUiValidationResult {
  const issues: NoxUiValidationIssue[] = [];
  const node = validate_ui_node_collect(input, path, issues);
  if (issues.length > 0 || !node) {
    return {
      ok: false,
      issues:
        issues.length > 0
          ? issues
          : [{ path, message: "Invalid UI node" }],
    };
  }
  return { ok: true, node };
}

function validate_ui_node_collect(
  input: unknown,
  path: string,
  issues: NoxUiValidationIssue[],
): NoxUiNode | null {
  if (!is_plain_object(input)) {
    issues.push({ path, message: "Node must be an object" });
    return null;
  }
  const component = input["component"];
  if (typeof component !== "string" || !component.trim()) {
    issues.push({ path, message: "Missing or empty component id" });
    return null;
  }
  if (!is_allowed_ui_component(component)) {
    issues.push({
      path: `${path}.component`,
      message: `Unknown component id "${component}" — not in nox.* allowlist`,
      component,
    });
  }

  let props: Record<string, unknown> | undefined;
  if (input["props"] !== undefined) {
    if (!is_plain_object(input["props"])) {
      issues.push({ path: `${path}.props`, message: "props must be an object" });
    } else {
      props = input["props"];
    }
  }

  let text: string | undefined;
  if (input["text"] !== undefined) {
    if (typeof input["text"] !== "string") {
      issues.push({ path: `${path}.text`, message: "text must be a string" });
    } else {
      text = input["text"];
    }
  }

  const children: NoxUiNode[] = [];
  if (input["children"] !== undefined) {
    if (!Array.isArray(input["children"])) {
      issues.push({
        path: `${path}.children`,
        message: "children must be an array",
      });
    } else {
      input["children"].forEach((child, i) => {
        const c = validate_ui_node_collect(
          child,
          `${path}.children[${i}]`,
          issues,
        );
        if (c) children.push(c);
      });
    }
  }

  // Still return a structural node so callers can inspect even when issues exist
  return {
    component,
    props,
    text,
    children: children.length ? children : undefined,
  };
}

/**
 * Validate a page descriptor is renderable by the MVP host: full allowlist
 * first, then every component id must be in the MVP bind set (or custom list).
 */
export function validate_page_descriptor_renderable(
  input: unknown,
  allowed: readonly string[] = NOX_UI_MVP_RENDER_IDS,
): NoxPageValidationResult {
  const base = validate_page_descriptor(input);
  if (!base.ok) return base;
  const issues: NoxUiValidationIssue[] = [];
  const allowed_set = new Set(allowed);
  walk_ui_tree(base.page.page, (node, path) => {
    if (!allowed_set.has(node.component)) {
      issues.push({
        path,
        component: node.component,
        message: `Component "${node.component}" is not in the renderable MVP set`,
      });
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return base;
}

/**
 * Validate a full page descriptor (metadata + tree).
 */
export function validate_page_descriptor(
  input: unknown,
): NoxPageValidationResult {
  const issues: NoxUiValidationIssue[] = [];
  if (!is_plain_object(input)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "Page descriptor must be an object" }],
    };
  }
  if (typeof input["id"] !== "string" || !(input["id"] as string).trim()) {
    issues.push({ path: "$.id", message: "id is required" });
  }
  if (
    typeof input["owner"] !== "string" ||
    !(input["owner"] as string).trim()
  ) {
    issues.push({ path: "$.owner", message: "owner is required" });
  }
  if (
    typeof input["title"] !== "string" ||
    !(input["title"] as string).trim()
  ) {
    issues.push({ path: "$.title", message: "title is required" });
  }
  if (!("page" in input)) {
    issues.push({ path: "$.page", message: "page tree is required" });
  }

  let page_node: NoxUiNode | null = null;
  if ("page" in input) {
    const tree = validate_ui_tree(input["page"], "$.page");
    if (!tree.ok) {
      issues.push(...tree.issues);
    } else {
      page_node = tree.node;
    }
  }

  if (issues.length > 0 || !page_node) {
    return { ok: false, issues };
  }

  const page: NoxPageDescriptor = {
    id: String(input["id"]),
    owner: String(input["owner"]),
    title: String(input["title"]),
    page: page_node,
  };
  if (is_plain_object(input["realms"])) {
    page.realms = input["realms"] as NoxPageDescriptor["realms"];
  }
  if (is_plain_object(input["menu"])) {
    page.menu = input["menu"] as NoxPageDescriptor["menu"];
  }
  const preloader = normalize_page_preloader(input["preloader"]);
  if (preloader) page.preloader = preloader;
  return { ok: true, page };
}

/**
 * Keep only the fields we understand from a page's `preloader`.
 * Returns null when there is nothing usable, so the page stays on the default
 * (overlay enabled, generic message).
 */
export function normalize_page_preloader(
  input: unknown,
): NoxPagePreloader | null {
  if (input === false) return { enabled: false };
  if (input === true) return { enabled: true };
  if (!is_plain_object(input)) return null;

  const out: NoxPagePreloader = {};
  if (typeof input["enabled"] === "boolean") out.enabled = input["enabled"];
  const message = input["message"];
  if (typeof message === "string" && message.trim()) {
    out.message = message.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion ALLOWLIST / VALIDATION
// (o==================================================================o)

// (o==================================================================o)
//   #region WALK / RENDER PLAN
// (o-----------------------------------------------------------\/-----o)

/** Depth-first walk; visitor may short-circuit by returning false. */
export function walk_ui_tree(
  node: NoxUiNode,
  visitor: (node: NoxUiNode, path: string) => boolean | void,
  path = "$",
): void {
  const cont = visitor(node, path);
  if (cont === false) return;
  const children = node.children ?? [];
  children.forEach((child, i) => {
    walk_ui_tree(child, visitor, `${path}.children[${i}]`);
  });
}

/** Collect every component id in the tree (including unknown). */
export function collect_component_ids(node: NoxUiNode): string[] {
  const ids: string[] = [];
  walk_ui_tree(node, (n) => {
    ids.push(n.component);
  });
  return ids;
}

/**
 * Build a render plan for one node. Safe for bad input — never throws.
 * Unknown / non-allowlisted ids → kind "unknown" (host shows error node).
 * Allowlisted but not MVP-bound → kind "node" with mvp_bound false.
 */
export function plan_ui_node(input: unknown, path = "$"): NoxUiRenderPlan {
  if (!is_plain_object(input)) {
    return { kind: "invalid", path, message: "Node must be an object" };
  }
  const component = input["component"];
  if (typeof component !== "string" || !component.trim()) {
    return {
      kind: "invalid",
      path,
      message: "Missing or empty component id",
    };
  }
  if (!is_allowed_ui_component(component)) {
    return {
      kind: "unknown",
      component,
      path,
      message: `Unknown component id "${component}"`,
    };
  }

  const props = is_plain_object(input["props"]) ? input["props"] : {};
  const text = typeof input["text"] === "string" ? input["text"] : null;
  const children: NoxUiNode[] = [];
  if (Array.isArray(input["children"])) {
    for (const child of input["children"]) {
      if (is_plain_object(child) && typeof child["component"] === "string") {
        children.push({
          component: child["component"] as string,
          props: is_plain_object(child["props"])
            ? (child["props"] as Record<string, unknown>)
            : undefined,
          text:
            typeof child["text"] === "string"
              ? (child["text"] as string)
              : undefined,
          children: Array.isArray(child["children"])
            ? (child["children"] as NoxUiNode[])
            : undefined,
        });
      }
    }
  }

  return {
    kind: "node",
    component,
    props,
    children,
    text,
    mvp_bound: is_mvp_render_component(component),
    path,
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion WALK / RENDER PLAN
// (o==================================================================o)
