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

  test("fuentes: lista fija y consulta a la API, con disparadores", () => {
    expect(
      code_completions_issues({
        sources: [
          { type: "static", trigger: { characters: ["@"] }, items: [{ label: "@yael" }] },
          {
            type: "api",
            url: "herr-tablas/sugerencias",
            params: { q: "{prefix}" },
            trigger: { pattern: "\\$(?<prefix>\\w*)$" },
            map: { label: "nombre", documentation: "**{nombre}**: {descripcion}" },
          },
        ],
      }),
    ).toEqual([]);
  });

  test("avisa de fuentes mal formadas", () => {
    const issues = code_completions_issues({
      sources: [{ type: "api" }, { type: "x" }, { type: "static", items: [{}] }, { type: "api", url: "u", trigger: { pattern: "(" } }],
    });
    expect(issues).toEqual([
      "code_editor_completions.sources[0].url must be a non-empty string",
      'code_editor_completions.sources[1].type must be "static" or "api"',
      "code_editor_completions.sources[2].items[0].label must be a non-empty string",
      "code_editor_completions.sources[3].trigger.pattern must be a valid regex",
    ]);
    expect(code_completions_issues({})).toEqual(["code_editor_completions needs items or sources"]);
  });
});
