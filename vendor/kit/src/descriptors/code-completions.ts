//   #region CODE COMPLETIONS

/**
 * Autocompletado de un `input-code-editor` (`code_editor_completions`): el
 * lenguaje de fórmulas o plantillas de una app, cada sugerencia con firma y
 * documentación. El lanzador lo pinta con Monaco: sugerencias al escribir,
 * ayuda al pasar el cursor, firma de la función en curso y la documentación
 * completa bajo el editor.
 *
 * Ámbitos: dentro de `funcion("argumento", …)` los nombres pueden significar
 * otra cosa (en `tabla_suma("Ventas", {Monto})`, `{Monto}` es de Ventas). Cada
 * elemento dice en qué ámbitos se ofrece; `""` es fuera de todos.
 */

export type CodeCompletionKind =
  | "function"
  | "variable"
  | "field"
  | "reference"
  | "keyword"
  | "operator"
  | "constant"
  | "snippet"
  | "module";

export type CodeCompletionParameter = {
  label: string;
  documentation?: string;
};

export type CodeCompletionItem = {
  /** Lo que se ve en la lista: `sub_suma(…)`, `{Precio}`. */
  label: string;
  /** Lo que se escribe; sin él, `label`. Con `snippet`, admite `${1:texto}`. */
  insert_text?: string;
  snippet?: boolean;
  kind?: CodeCompletionKind;
  /** Firma o resumen de una línea. */
  detail?: string;
  /** Markdown: qué es, cómo se usa, un ejemplo. */
  documentation?: string;
  filter_text?: string;
  sort_text?: string;
  /** Ids de `scopes` donde se ofrece (`""` = fuera de todos). Sin él, en todas partes. */
  scopes?: string[];
  /** Texto exacto que muestra su ayuda al pasar el cursor. */
  hover_key?: string;
  /** Regex (fuente) para la ayuda al pasar el cursor. */
  hover_pattern?: string;
  /** Valor de cadena: se ofrece como primer argumento de las funciones que casan con esta regex. */
  argument_of?: string;
  /** Funciones: sus parámetros (cada `label` aparece tal cual en `detail`). */
  parameters?: CodeCompletionParameter[];
};

export type CodeCompletionScope = {
  id: string;
  /** Regex (fuente, sin distinguir mayúsculas) del nombre de la función. */
  function_pattern: string;
  /** El primer argumento de cadena que debe llevar la función. */
  argument?: string;
  /** Solo dentro de este otro ámbito (`""` = fuera de todos). */
  parent?: string;
  label?: string;
};

export type CodeCompletionCatalog = {
  items: CodeCompletionItem[];
  scopes?: CodeCompletionScope[];
  trigger_characters?: string[];
  /** Markdown con la documentación completa, a la mano bajo el editor. */
  documentation?: string;
  documentation_title?: string;
  /** Enter no agrega renglones (plantillas de una línea). */
  single_line?: boolean;
};

/** Problemas de forma de un catálogo (vacío si está bien). */
export function code_completions_issues(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["code_editor_completions must be an object"];
  }
  const catalog = raw as Record<string, unknown>;
  const issues: string[] = [];
  const items = catalog["items"];
  if (!Array.isArray(items)) issues.push("code_editor_completions.items must be an array");
  else {
    items.forEach((item, i) => {
      const label = (item as Record<string, unknown> | null)?.["label"];
      if (typeof label !== "string" || !label) {
        issues.push(`code_editor_completions.items[${i}].label must be a non-empty string`);
      }
    });
  }
  const scopes = catalog["scopes"];
  if (scopes !== undefined) {
    if (!Array.isArray(scopes)) issues.push("code_editor_completions.scopes must be an array");
    else {
      scopes.forEach((scope, i) => {
        const s = (scope ?? {}) as Record<string, unknown>;
        if (typeof s["id"] !== "string" || typeof s["function_pattern"] !== "string") {
          issues.push(`code_editor_completions.scopes[${i}] needs id and function_pattern`);
        }
      });
    }
  }
  return issues;
}

//   #endregion
