import { describe, expect, test } from "bun:test";
import { parse_ui_action, ui_action_http_path } from "./ui-action.ts";

describe("parse_ui_action", () => {
  test("reads the same shape feature-shell already declares", () => {
    const action = parse_ui_action({
      invoke: { method: "POST", action: "api://store/cart/items" },
    });
    expect(action).not.toBeNull();
    expect(action!.method).toBe("POST");
    expect(action!.path).toBe("store/cart/items");
    expect(action!.body).toEqual({});
  });

  test("carries a static payload, which is what a button needs", () => {
    const action = parse_ui_action({
      invoke: { method: "POST", action: "api://store/cart/items" },
      body: { product_id: "p1", qty: 2 },
      confirm: "¿Quitar del carrito?",
      then: "tienda.store.cart",
    });
    expect(action!.body).toEqual({ product_id: "p1", qty: 2 });
    expect(action!.confirm).toBe("¿Quitar del carrito?");
    expect(action!.then).toBe("tienda.store.cart");
  });

  test("a node with no invoke is not an action", () => {
    expect(parse_ui_action({})).toBeNull();
    expect(parse_ui_action({ href: "/tienda" })).toBeNull();
    expect(parse_ui_action(null)).toBeNull();
  });

  test("rejects anything that is not an api:// path", () => {
    // Un descriptor lo escribe la app, pero llega por HTTP: una acción que
    // apunte a otro origen no se dispara.
    expect(
      parse_ui_action({
        invoke: { method: "POST", action: "https://evil.example/steal" },
      }),
    ).toBeNull();
    expect(
      parse_ui_action({
        invoke: { method: "POST", action: "api://../../admin" },
      }),
    ).toBeNull();
  });

  test("rejects a method that is not a write", () => {
    expect(
      parse_ui_action({ invoke: { method: "GET", action: "api://store/cart" } }),
    ).toBeNull();
  });

  test("resolves against the base of the app that served the page", () => {
    const action = parse_ui_action({
      invoke: { method: "POST", action: "api://store/checkout" },
    })!;
    expect(ui_action_http_path(action, "/api/p/m/subject-tienda")).toBe(
      "/api/p/m/subject-tienda/store/checkout",
    );
    expect(ui_action_http_path(action, "/api/m/subject-tienda/")).toBe(
      "/api/m/subject-tienda/store/checkout",
    );
  });

  test("keeps the query the app wrote in the action", () => {
    const action = parse_ui_action({
      invoke: { method: "DELETE", action: "api://store/cart/items/abc?reason=user" },
    })!;
    expect(ui_action_http_path(action, "/api/p/m/subject-tienda")).toBe(
      "/api/p/m/subject-tienda/store/cart/items/abc?reason=user",
    );
  });
});

describe("parse_ui_action (forma plana)", () => {
  test("acepta action/method sobre las props, como las páginas de Kirel", () => {
    const action = parse_ui_action({
      action: "api://store/cart/items",
      method: "POST",
    });
    expect(action).not.toBeNull();
    expect(action!.method).toBe("POST");
    expect(action!.path).toBe("store/cart/items");
  });

  test("`invoke` manda cuando vienen las dos", () => {
    const action = parse_ui_action({
      action: "api://store/viejo",
      method: "DELETE",
      invoke: { method: "POST", action: "api://store/nuevo" },
    })!;
    expect(action.method).toBe("POST");
    expect(action.path).toBe("store/nuevo");
  });

  test("un nodo con solo href sigue sin ser acción", () => {
    expect(parse_ui_action({ href: "/tienda/carrito" })).toBeNull();
  });
});
