import { describe, expect, test } from "bun:test";
import { code_completions_issues } from "./code-completions.ts";

describe("code_editor_completions", () => {
  test("un catálogo con items etiquetados no tiene problemas", () => {
    expect(
      code_completions_issues({
        items: [{ label: "sub_suma(…)", kind: "function", detail: 'sub_suma("Subtabla", valor)' }],
        scopes: [{ id: "sub:productos", function_pattern: "^sub_", argument: "Productos" }],
        documentation: "# Ayuda",
      }),
    ).toEqual([]);
  });

  test("avisa de items sin etiqueta y ámbitos incompletos", () => {
    const issues = code_completions_issues({ items: [{ label: "" }], scopes: [{ id: "x" }] });
    expect(issues.length).toBe(2);
    expect(code_completions_issues([])).toEqual(["code_editor_completions must be an object"]);
  });
});
