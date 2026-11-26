import { describe, expect, test } from "bun:test";
import { is_allowed_ui_component } from "./ui-descriptor.js";
import { nox_view_list, nox_view_list_page, nox_view_list_query } from "./view-list.js";

describe("nox.view-list", () => {
  test("está en el catálogo", () => {
    expect(is_allowed_ui_component("nox.view-list")).toBe(true);
  });

  test("el respaldo viaja como hijos solo si hay", () => {
    expect(nox_view_list({ columns: [] }).children).toBeUndefined();
    const fallback = [{ component: "nox.table", props: {} }];
    expect(nox_view_list({ columns: [{ key: "a", label: "A" }] }, fallback)).toEqual({
      component: "nox.view-list",
      props: { columns: [{ key: "a", label: "A" }] },
      children: fallback,
    });
  });

  test("la consulta acota página y tamaño", () => {
    expect(nox_view_list_query(new URLSearchParams("q=%20foco%20&page=3&page_size=20"))).toEqual({ q: "foco", page: 3, page_size: 20 });
    expect(nox_view_list_query(new URLSearchParams("page=-1&page_size=99999"))).toEqual({ q: "", page: 1, page_size: 500 });
    expect(nox_view_list_query(new URLSearchParams(""))).toEqual({ q: "", page: 1, page_size: 50 });
  });

  test("la página pedida de más cae en la última", () => {
    const filas = Array.from({ length: 7 }, (_, i) => i);
    expect(nox_view_list_page(filas, 2, 3)).toEqual({ data: [3, 4, 5], total: 7 });
    expect(nox_view_list_page(filas, 9, 3)).toEqual({ data: [6], total: 7 });
    expect(nox_view_list_page([], 1, 3)).toEqual({ data: [], total: 0 });
  });
});
