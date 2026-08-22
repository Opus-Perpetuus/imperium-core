import { describe, expect, test } from "bun:test";
import {
  collect_component_ids,
  is_allowed_ui_component,
  is_mvp_render_component,
  normalize_page_preloader,
  NOX_UI_MVP_RENDER_IDS,
  plan_ui_node,
  validate_page_descriptor,
  validate_page_descriptor_renderable,
  validate_ui_tree,
  walk_ui_tree,
} from "./ui-descriptor";

// (o==================================================================o)
//   #region TESTS
// (o-----------------------------------------------------------\/-----o)

describe("is_allowed_ui_component", () => {
  test("accepts catalog ids and rejects unknown", () => {
    expect(is_allowed_ui_component("nox.page")).toBe(true);
    expect(is_allowed_ui_component("nox.table")).toBe(true);
    expect(is_allowed_ui_component("evil.raw-html")).toBe(false);
    expect(is_allowed_ui_component("nox.not-a-real-one")).toBe(false);
  });
});

describe("validate_ui_tree", () => {
  test("accepts a valid MVP tree", () => {
    const tree = {
      component: "nox.stack",
      children: [
        {
          component: "nox.alert",
          props: { tone: "info", title: "Hi" },
          text: "Hello",
        },
        {
          component: "nox.badge",
          props: { tone: "success" },
          text: "ok",
        },
      ],
    };
    const result = validate_ui_tree(tree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.component).toBe("nox.stack");
      expect(result.node.children?.length).toBe(2);
    }
  });

  test("rejects unknown component ids with path", () => {
    const result = validate_ui_tree({
      component: "nox.stack",
      children: [{ component: "bootstrap.modal" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.component === "bootstrap.modal")).toBe(
        true,
      );
      expect(
        result.issues.some((i) => i.path.includes("children[0]")),
      ).toBe(true);
    }
  });

  test("rejects non-object roots", () => {
    const result = validate_ui_tree("not-a-tree");
    expect(result.ok).toBe(false);
  });
});

describe("validate_page_descriptor", () => {
  test("accepts a minimal valid page descriptor", () => {
    const result = validate_page_descriptor({
      id: "sample.page",
      owner: "nox",
      title: "Sample",
      page: {
        component: "nox.page",
        children: [
          {
            component: "nox.table",
            props: {
              columns: [{ key: "name", label: "Name" }],
              rows: [{ id: "1", name: "a" }],
            },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.id).toBe("sample.page");
      expect(result.page.page.component).toBe("nox.page");
    }
  });

  test("validate_page_descriptor_renderable rejects non-MVP ids", () => {
    expect(NOX_UI_MVP_RENDER_IDS).toContain("nox.collapsible");
    expect(NOX_UI_MVP_RENDER_IDS).toContain("nox.input-choice");
    const ok = validate_page_descriptor_renderable({
      id: "home",
      owner: "portal",
      title: "Home",
      page: {
        component: "nox.page",
        children: [{ component: "nox.markdown-view", props: { content: "Hi" } }],
      },
    });
    expect(ok.ok).toBe(true);
    // nox.wizard is allowlisted but not MVP-bound
    const bad = validate_page_descriptor_renderable({
      id: "home",
      owner: "portal",
      title: "Home",
      page: {
        component: "nox.page",
        children: [{ component: "nox.wizard" }],
      },
    });
    expect(bad.ok).toBe(false);
  });

  test("rejects page with unknown nested component", () => {
    const result = validate_page_descriptor({
      id: "bad",
      owner: "nox",
      title: "Bad",
      page: {
        component: "nox.page",
        children: [{ component: "evil.widget" }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.message.includes("evil.widget")),
      ).toBe(true);
    }
  });
});

describe("walk / plan_ui_node", () => {
  test("walk_ui_tree visits every node via shipped helper", () => {
    const root = {
      component: "nox.page" as const,
      children: [
        {
          component: "nox.stack" as const,
          children: [
            { component: "nox.alert" as const, text: "Hi" },
            {
              component: "nox.table" as const,
              props: { columns: [], rows: [] },
            },
          ],
        },
      ],
    };
    const seen: string[] = [];
    walk_ui_tree(root, (n) => {
      seen.push(n.component);
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen).toContain("nox.page");
    expect(seen).toContain("nox.table");
    expect(collect_component_ids(root)).toEqual(seen);
  });

  test("plan_ui_node maps known mvp nodes and isolates unknown", () => {
    const ok = plan_ui_node({
      component: "nox.button",
      props: { variant: "primary" },
      text: "Go",
    });
    expect(ok.kind).toBe("node");
    if (ok.kind === "node") {
      expect(ok.component).toBe("nox.button");
      expect(ok.mvp_bound).toBe(true);
      expect(ok.text).toBe("Go");
      expect(is_mvp_render_component(ok.component)).toBe(true);
    }

    const unknown = plan_ui_node({ component: "not.in.catalog" });
    expect(unknown.kind).toBe("unknown");
    if (unknown.kind === "unknown") {
      expect(unknown.component).toBe("not.in.catalog");
      expect(unknown.message.length).toBeGreaterThan(0);
    }

    const invalid = plan_ui_node(null);
    expect(invalid.kind).toBe("invalid");
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion TESTS
// (o==================================================================o)

describe("storefront mvp components", () => {
  test("catalog-grid / markdown-view / search / paginator / carousel are MVP-bound", () => {
    for (const id of [
      "nox.catalog-grid",
      "nox.markdown-view",
      "nox.search",
      "nox.paginator",
      "nox.carousel",
    ]) {
      expect(is_mvp_render_component(id)).toBe(true);
      const plan = plan_ui_node({ component: id, props: {} });
      expect(plan.kind).toBe("node");
      if (plan.kind === "node") expect(plan.mvp_bound).toBe(true);
    }
  });
});

// (o==================================================================o)
//   #region LOADING OVERLAY CONTRACT
// (o-----------------------------------------------------------\/-----o)

describe("nox.loading-overlay", () => {
  test("is allowlisted and MVP-bound so kirlets can drive the overlay", () => {
    expect(is_allowed_ui_component("nox.loading-overlay")).toBe(true);
    expect(is_mvp_render_component("nox.loading-overlay")).toBe(true);
  });

  test("plans as a bound node with its props intact", () => {
    const plan = plan_ui_node({
      component: "nox.loading-overlay",
      props: {
        visible: true,
        message: "Importando empleados…",
        bars: [{ id: "val", label: "Validando", percent: 40 }],
      },
    });
    expect(plan.kind).toBe("node");
    if (plan.kind !== "node") return;
    expect(plan.mvp_bound).toBe(true);
    expect(plan.props["message"]).toBe("Importando empleados…");
    expect(Array.isArray(plan.props["bars"])).toBe(true);
  });

  test("does not disturb the existing nox.preloader skeleton block", () => {
    expect(is_allowed_ui_component("nox.preloader")).toBe(true);
  });
});

describe("normalize_page_preloader", () => {
  test("boolean shorthand", () => {
    expect(normalize_page_preloader(false)).toEqual({ enabled: false });
    expect(normalize_page_preloader(true)).toEqual({ enabled: true });
  });

  test("keeps only understood fields", () => {
    expect(
      normalize_page_preloader({
        enabled: true,
        message: "  Cargando nómina…  ",
        rogue: "drop me",
      }),
    ).toEqual({ enabled: true, message: "Cargando nómina…" });
  });

  test("null when there is nothing usable", () => {
    expect(normalize_page_preloader(undefined)).toBeNull();
    expect(normalize_page_preloader({})).toBeNull();
    expect(normalize_page_preloader({ message: "   " })).toBeNull();
    expect(normalize_page_preloader("yes")).toBeNull();
    expect(normalize_page_preloader([])).toBeNull();
  });
});

describe("validate_page_descriptor — preloader passthrough", () => {
  const base = {
    id: "hr.employees",
    owner: "kirlet-hr",
    title: "Empleados",
    page: { component: "nox.page", children: [] },
  };

  test("carries a page preloader through validation", () => {
    const result = validate_page_descriptor({
      ...base,
      preloader: { message: "Cargando empleados…" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.preloader).toEqual({ message: "Cargando empleados…" });
  });

  test("a page can opt out entirely", () => {
    const result = validate_page_descriptor({ ...base, preloader: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.preloader).toEqual({ enabled: false });
  });

  test("omits the field when the page says nothing", () => {
    const result = validate_page_descriptor(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.preloader).toBeUndefined();
  });

  test("junk is dropped rather than failing the page", () => {
    const result = validate_page_descriptor({ ...base, preloader: "sí" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.preloader).toBeUndefined();
  });
});

// (o-----------------------------------------------------------/\-----o)
//   #endregion LOADING OVERLAY CONTRACT
// (o==================================================================o)
