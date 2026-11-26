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

/**
 * Cuándo se activa una fuente: tras uno de `characters` (`{`, `.`, `@`…) o
 * cuando el texto antes del cursor casa con `pattern` (regex, se ancla al final).
 * Lo que va escrito desde el disparador es el «prefijo»: el grupo con nombre
 * `prefix` del patrón o, si no hay, su último grupo. Sin disparador, la fuente
 * se consulta siempre con la palabra a medio escribir.
 */
export type CodeCompletionTrigger = {
  characters?: string[];
  pattern?: string;
  /** Caracteres mínimos de prefijo antes de consultar (por defecto 0). */
  min_chars?: number;
};

/** De qué campo de cada resultado sale cada parte (ruta con puntos o plantilla `"{nombre} ({tipo})"`). */
export type CodeCompletionFieldMap = {
  label?: string;
  insert_text?: string;
  detail?: string;
  documentation?: string;
  kind?: string;
  filter_text?: string;
  sort_text?: string;
  hover_key?: string;
};

type CodeCompletionSourceBase = {
  id?: string;
  trigger?: CodeCompletionTrigger;
  /** Solo dentro de estos ámbitos (`""` = fuera de todos). */
  scopes?: string[];
};

/** Lista fija de sugerencias. */
export type CodeCompletionStaticSource = CodeCompletionSourceBase & {
  type: "static";
  items: CodeCompletionItem[];
};

/**
 * Consulta a un endpoint. En `url`, `params`, `body` y `headers` se sustituyen
 * `{prefix}`, `{word}`, `{line}`, `{text_before}`, `{text_after}`, `{value}`,
 * `{line_number}`, `{column}`, `{trigger}`, `{scope}`, `{function}`,
 * `{arg_index}` (codificados en la URL). Una URL relativa (`herr-tablas/sugerencias`)
 * se resuelve contra la API de la app; `/api/...` y `https://...` van tal cual.
 */
export type CodeCompletionApiSource = CodeCompletionSourceBase & {
  type: "api";
  url: string;
  method?: "GET" | "POST";
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Espera tras la última tecla antes de consultar (ms, por defecto 200). */
  debounce_ms?: number;
  /** Cuánto se reutiliza una respuesta igual (ms, por defecto 30000; 0 = sin caché). */
  cache_ttl_ms?: number;
  /** Tiempo máximo de la consulta (ms, por defecto 8000). */
  timeout_ms?: number;
  /** Ruta con puntos a la lista en la respuesta (`data.items`); sin ella, la respuesta o su `data`. */
  items_path?: string;
  map?: CodeCompletionFieldMap;
  /** `kind` de los resultados sin `map.kind`. */
  kind?: CodeCompletionKind;
  /** `snippet` de los resultados. */
  snippet?: boolean;
};

export type CodeCompletionSource = CodeCompletionStaticSource | CodeCompletionApiSource;

export type CodeCompletionCatalog = {
  /** Sugerencias con ámbitos, firma y documentación (el lenguaje de la app). */
  items?: CodeCompletionItem[];
  scopes?: CodeCompletionScope[];
  /** Fuentes extra, combinables: listas fijas o consultas a la API. */
  sources?: CodeCompletionSource[];
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
  const sources = catalog["sources"];
  if (items === undefined && sources === undefined) issues.push("code_editor_completions needs items or sources");
  if (items !== undefined) {
    if (!Array.isArray(items)) issues.push("code_editor_completions.items must be an array");
    else items_issues(items, "code_editor_completions.items", issues);
  }
  if (sources !== undefined) {
    if (!Array.isArray(sources)) issues.push("code_editor_completions.sources must be an array");
    else sources.forEach((raw_source, i) => source_issues(raw_source, `code_editor_completions.sources[${i}]`, issues));
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

function items_issues(items: unknown[], path: string, issues: string[]): void {
  items.forEach((item, i) => {
    const label = (item as Record<string, unknown> | null)?.["label"];
    if (typeof label !== "string" || !label) issues.push(`${path}[${i}].label must be a non-empty string`);
  });
}

function regex_ok(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

function source_issues(raw: unknown, path: string, issues: string[]): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const source = raw as Record<string, unknown>;
  const trigger = source["trigger"] as Record<string, unknown> | undefined;
  if (trigger !== undefined) {
    if (!trigger || typeof trigger !== "object") issues.push(`${path}.trigger must be an object`);
    else {
      const chars = trigger["characters"];
      if (chars !== undefined && (!Array.isArray(chars) || chars.some((c) => typeof c !== "string" || !c))) {
        issues.push(`${path}.trigger.characters must be non-empty strings`);
      }
      const pattern = trigger["pattern"];
      if (pattern !== undefined && (typeof pattern !== "string" || !regex_ok(pattern))) {
        issues.push(`${path}.trigger.pattern must be a valid regex`);
      }
    }
  }
  if (source["type"] === "static") {
    if (!Array.isArray(source["items"])) issues.push(`${path}.items must be an array`);
    else items_issues(source["items"], `${path}.items`, issues);
  } else if (source["type"] === "api") {
    if (typeof source["url"] !== "string" || !source["url"]) issues.push(`${path}.url must be a non-empty string`);
    const method = source["method"];
    if (method !== undefined && method !== "GET" && method !== "POST") issues.push(`${path}.method must be GET or POST`);
  } else {
    issues.push(`${path}.type must be "static" or "api"`);
  }
}

//   #endregion
