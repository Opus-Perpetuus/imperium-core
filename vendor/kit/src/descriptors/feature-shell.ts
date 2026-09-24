// (o==================================================================o)
//   #region FEATURE SHELL DESCRIPTOR
// (o-----------------------------------------------------------\/-----o)

import type {
  NoxPageDescriptor,
  NoxUiValidationIssue,
} from "./ui-descriptor.js";
import { validate_page_descriptor } from "./ui-descriptor.js";

/**
 * Un tipo de campo por cada tipo del input canónico de Imperium
 * (`imperium-sic-input`). El comentario dice qué valor escribe, para elegir
 * la columna: un tipo cuyo valor no cabe en la columna rompe el guardado.
 */
export const FEATURE_SHELL_FIELD_COMPONENTS = [
  /** Texto de una línea → `text`. */
  "input-text",
  /** Texto oculto con botón de mostrar → `text`. */
  "input-password",
  /** Texto largo (descripción, comentarios, observaciones) → `text`. */
  "input-textarea",
  /** Objeto o arreglo editado como JSON → `json`. */
  "input-json",
  /** Número → `real` / `integer`. */
  "input-number",
  /** Importe con formato de moneda → `real` / `numeric`. */
  "input-money",
  /** Texto con máscara (`mask`: RFC, CURP, CP, teléfono) → `text`. */
  "input-mask",
  /** Fecha (ISO) → `text` / `timestamptz`. */
  "input-date",
  /** Fecha y hora (ISO) → `text` / `timestamptz`. */
  "input-datetime",
  /** Hora `HH:mm` → `text`. */
  "input-time",
  /** Rango `{ start, end, unit }` → `json`. */
  "input-date-range",
  /** Lunes de la semana elegida (ISO) → `text`. */
  "input-week",
  /** Primer día del mes elegido (ISO) → `text`. */
  "input-month",
  /** 1 de enero del año elegido (ISO) → `text`. Un año numérico es `input-number`. */
  "input-year",
  /** Día de la semana 0–6 → `integer`. */
  "input-weekday",
  /** Sí/no → `boolean`. */
  "input-checkbox",
  /** Selector de una opción de `options` con apariencia de interruptor → tipo del `value`. */
  "input-switch",
  /** Varias opciones de `options` → `json` (arreglo de valores). */
  "input-checkbox-group",
  /** Una opción de `options` (switch, radio o segmentado) → tipo del `value`. */
  "input-choice",
  /** Una opción de `options` como botones → tipo del `value`. */
  "input-radio-buttons",
  /** Una opción de `options` como grupo de radios → tipo del `value`. */
  "input-radio-group",
  /** Lista desplegable de `options` / `optionsSource` → tipo del `value`. */
  "input-menu",
  /** Búsqueda con autocompletado sobre `options` / `optionsSource` → tipo del `value`. */
  "input-datalist",
  /** Nombre(s) del archivo elegido → `text`. */
  "input-file",
  /** Imagen (data URL; con `multiple`, arreglo) → `text` (o `json` si `multiple`). */
  "input-image",
  /** Firma dibujada (data URL PNG) → `text`. */
  "input-signature",
  /** `{ latitude, longitude }` con mapa → `json`. */
  "input-coordinates",
  /** Color `#rrggbb` → `text`. */
  "input-color",
  /** Clase de ícono Font Awesome → `text`. */
  "input-icon",
  /** Markdown → `text`. */
  "input-markdown",
  /** Código con resaltado (`code_editor_language`) → `text`. */
  "input-code-editor",
  /** Plantilla HTML con vista previa en PDF → `text`. */
  "input-editor-html-pdf",
  /** Objeto con inspector (solo lectura o editor) → `json`. */
  "input-object",
  /** Cronómetro de solo lectura sobre `[inicio, fin]` (ISO) → `json`. */
  "input-timer",
  /** Estado con badge a partir de `options` → `text`. */
  "input-status",
  /** Valor que viaja sin pintarse → cualquiera. */
  "input-hidden",
] as const;

export type FeatureShellFieldComponent =
  (typeof FEATURE_SHELL_FIELD_COMPONENTS)[number];

export type FeatureShellFieldOption = {
  value: string | number | boolean;
  label: string;
  /** Texto secundario de la opción. */
  description?: string;
  /** Color de la opción en `input-switch` / `input-choice` (tema o CSS). */
  color?: string;
};

export type FeatureShellFieldColumnSpan = number | "full";

export type FeatureShellDateRangeConstraints = {
  min_date?: string;
  max_date?: string;
  min_span?: number;
  max_span?: number;
  blocked_dates?: string[];
  blocked_weekdays?: number[];
  allowed_dates?: string[];
};

/**
 * Campo de formulario de una app. Las opciones son las del input canónico
 * (`GenericFormField` del lanzador); cada una aplica solo a los tipos que la
 * nombran y el resto la ignora.
 */
export type FeatureShellFieldDescriptor = {
  name: string;
  component: FeatureShellFieldComponent;
  label?: string;
  placeholder?: string;
  /** Texto de ayuda bajo el campo. */
  help?: string;
  required?: boolean;
  read_only?: boolean;
  /** Muestra los errores sin esperar a que el campo se toque. */
  validate_always?: boolean;
  /** Columnas que ocupa en la rejilla del formulario (`full` = todo el ancho). */
  column_span?: FeatureShellFieldColumnSpan;
  min_width?: string;
  /** `input-text`: teclado y validación del navegador. */
  type?: "text" | "email" | "search" | "url" | "tel";
  /** Opciones fijas de los tipos de selección. */
  options?: FeatureShellFieldOption[];
  /** Opciones desde el API (`api://…?as=options` → `{ value, label }[]`). */
  optionsSource?: string;
  /** `input-number` / `input-money`. */
  min?: number;
  max?: number;
  step?: number;
  /** `input-mask`: patrón de ngx-mask (`0` dígito, `S` letra, `A` alfanumérico). */
  mask?: string;
  /** `input-money` / `input-mask`: admite negativos. */
  mask_allow_negative_numbers?: boolean;
  /** `input-image` / `input-file`: varios archivos. */
  multiple?: boolean;
  /** `input-image` con `multiple`: cuántas imágenes como máximo. */
  image_selection_limit?: number;
  /** `input-file`: tipos que acepta el selector (`.pdf,image/*`). */
  accept?: string;
  /** `input-choice`: cómo se pinta. */
  choice_appearance?: "switch" | "radio" | "segmented";
  /** `input-switch`: valor si el registro no trae ninguno. */
  switch_default_value?: string | boolean;
  /** `input-markdown`. */
  markdown_initial_mode?: "visual" | "write" | "split" | "preview";
  markdown_single_line?: boolean;
  markdown_hide_expand_button?: boolean;
  markdown_expanded_title?: string;
  /** `input-code-editor` (`json`, `html`, `javascript`, `sql`…). */
  code_editor_language?: string;
  code_editor_min_lines?: number;
  code_editor_max_lines?: number;
  /** `input-code-editor`: autocompletado de plantillas de impresión. */
  code_editor_completion_kind?: "dsl" | "zpl";
  /** `input-date-range`. */
  date_range_placeholder?: string;
  date_range_show_quick_presets?: boolean;
  date_range_initial_selection_unit?: "day" | "week" | "month" | "year";
  date_range_constraints?: FeatureShellDateRangeConstraints;
  /** `input-coordinates`: campo de texto del mismo formulario que recibe la calle. */
  coordinates_street_field?: string;
  coordinates_autofill_street?: boolean;
  coordinates_allow_map_toggle?: boolean;
  coordinates_initial_map_visible?: boolean;
  coordinates_geocode_proxy_url?: string;
  /** `input-password`: barra de complejidad. */
  show_password_strength?: boolean;
  /** `input-object`: solo inspector, sin editor. */
  object_read_only?: boolean;
  /** `input-object`: claves internas de solo lectura. */
  object_field_overrides?: string[];
  /** `input-datalist`. */
  datalist_search_on_empty_focus?: boolean;
  datalist_allow_create_from_search_term?: boolean;
};

export type FeatureShellActionInvoke = {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  action: string;
};

export type FeatureShellHeaderActionDescriptor = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "default";
  confirm?: string;
  invoke?: FeatureShellActionInvoke;
  refresh?: "record" | "list";
};

export type FeatureShellColumnDescriptor = {
  key: string;
  label: string;
  sortable?: boolean;
  cell?: "text" | "badge";
  badgeToneKey?: string;
  priority?: 1 | 2 | 3;
};

export type FeatureShellDescriptorProps = {
  basePath: string;
  idKey?: string;
  nameKey?: string;
  view: {
    title: string;
    subtitle?: string;
    pluralLabel?: string;
    singularLabel?: string;
    emptyTitle?: string;
    emptyDescription?: string;
  };
  data: {
    list: string;
    record?: string;
    create?: FeatureShellActionInvoke;
    update?: FeatureShellActionInvoke;
    delete?: FeatureShellActionInvoke;
  };
  table: {
    columns: FeatureShellColumnDescriptor[];
    fillHeight?: boolean;
    mobileCards?: boolean;
    serverQuery?: boolean;
  };
  form?: { fields: FeatureShellFieldDescriptor[] };
  headerActions?: Partial<
    Record<"list" | "detail" | "edit" | "new", FeatureShellHeaderActionDescriptor[]>
  >;
  permission?: string;
};

export type NoxListQuery = {
  q?: string;
  take?: number;
  skip?: number;
  sort?: string;
};

const FIELD_COMPONENTS: ReadonlySet<string> = new Set(
  FEATURE_SHELL_FIELD_COMPONENTS,
);

/** Opciones con valor de catálogo: fuera de él el input caería a su default sin avisar. */
const FIELD_ENUM_OPTIONS: Record<string, readonly string[]> = {
  type: ["text", "email", "search", "url", "tel"],
  choice_appearance: ["switch", "radio", "segmented"],
  markdown_initial_mode: ["visual", "write", "split", "preview"],
  code_editor_completion_kind: ["dsl", "zpl"],
  date_range_initial_selection_unit: ["day", "week", "month", "year"],
};

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate_field_options(
  field: Record<string, unknown>,
  path: string,
  issues: NoxUiValidationIssue[],
): void {
  for (const [key, allowed] of Object.entries(FIELD_ENUM_OPTIONS)) {
    const value = field[key];
    if (value !== undefined && !allowed.includes(value as string)) {
      issues.push({
        path: `${path}.${key}`,
        message: `${key} must be one of ${allowed.join("|")}`,
      });
    }
  }

  const span = field["column_span"];
  if (
    span !== undefined &&
    span !== "full" &&
    !(typeof span === "number" && Number.isInteger(span) && span > 0)
  ) {
    issues.push({
      path: `${path}.column_span`,
      message: 'column_span must be a positive integer or "full"',
    });
  }

  const options = field["options"];
  if (options === undefined) return;
  if (!Array.isArray(options)) {
    issues.push({ path: `${path}.options`, message: "options must be an array" });
    return;
  }
  options.forEach((option, i) => {
    if (!is_plain_object(option)) {
      issues.push({ path: `${path}.options[${i}]`, message: "option must be object" });
      return;
    }
    if (typeof option["label"] !== "string") {
      issues.push({
        path: `${path}.options[${i}].label`,
        message: "option label is required",
      });
    }
  });
}

function is_api_url(value: string): boolean {
  return value.startsWith("api://");
}

/**
 * Validate feature-shell props (schema-only, no embedded data).
 */
export function validate_feature_shell_props(
  input: unknown,
):
  | { ok: true; props: FeatureShellDescriptorProps }
  | { ok: false; issues: NoxUiValidationIssue[] } {
  const issues: NoxUiValidationIssue[] = [];
  if (!is_plain_object(input)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "props must be an object" }],
    };
  }

  if (typeof input["basePath"] !== "string" || !input["basePath"].trim()) {
    issues.push({ path: "$.basePath", message: "basePath is required" });
  }

  if (!is_plain_object(input["view"]) || typeof input["view"]["title"] !== "string") {
    issues.push({ path: "$.view.title", message: "view.title is required" });
  }

  if (!is_plain_object(input["data"])) {
    issues.push({ path: "$.data", message: "data is required" });
  } else {
    const list = input["data"]["list"];
    if (typeof list !== "string" || !is_api_url(list)) {
      issues.push({
        path: "$.data.list",
        message: "data.list must be an api:// URL",
      });
    }
    for (const key of ["record"] as const) {
      const v = input["data"][key];
      if (v !== undefined && (typeof v !== "string" || !is_api_url(v))) {
        issues.push({
          path: `$.data.${key}`,
          message: `data.${key} must be an api:// URL`,
        });
      }
    }
    for (const key of ["create", "update", "delete"] as const) {
      const inv = input["data"][key];
      if (inv === undefined) continue;
      if (!is_plain_object(inv)) {
        issues.push({ path: `$.data.${key}`, message: "must be an invoke object" });
        continue;
      }
      if (typeof inv["action"] !== "string" || !is_api_url(inv["action"])) {
        issues.push({
          path: `$.data.${key}.action`,
          message: "action must be an api:// URL",
        });
      }
      const method = inv["method"];
      if (
        method !== "POST" &&
        method !== "PATCH" &&
        method !== "PUT" &&
        method !== "DELETE"
      ) {
        issues.push({
          path: `$.data.${key}.method`,
          message: "method must be POST|PATCH|PUT|DELETE",
        });
      }
    }
  }

  if (!is_plain_object(input["table"]) || !Array.isArray(input["table"]["columns"])) {
    issues.push({
      path: "$.table.columns",
      message: "table.columns must be an array",
    });
  }

  if (input["form"] !== undefined) {
    if (!is_plain_object(input["form"]) || !Array.isArray(input["form"]["fields"])) {
      issues.push({
        path: "$.form.fields",
        message: "form.fields must be an array",
      });
    } else {
      (input["form"]["fields"] as unknown[]).forEach((f, i) => {
        if (!is_plain_object(f)) {
          issues.push({ path: `$.form.fields[${i}]`, message: "field must be object" });
          return;
        }
        if (typeof f["name"] !== "string" || !f["name"]) {
          issues.push({
            path: `$.form.fields[${i}].name`,
            message: "name is required",
          });
        }
        if (
          typeof f["component"] !== "string" ||
          !FIELD_COMPONENTS.has(f["component"])
        ) {
          issues.push({
            path: `$.form.fields[${i}].component`,
            message: `unknown field component "${String(f["component"])}"`,
          });
        }
        validate_field_options(f, `$.form.fields[${i}]`, issues);
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, props: input as unknown as FeatureShellDescriptorProps };
}

/**
 * Build a page descriptor whose root is `nox.feature-shell`.
 */
export function build_feature_shell_page(input: {
  id: string;
  owner: string;
  title?: string;
  props: FeatureShellDescriptorProps;
}): NoxPageDescriptor {
  const validated = validate_feature_shell_props(input.props);
  if (!validated.ok) {
    throw new Error(
      `Invalid feature-shell props: ${validated.issues.map((i) => i.message).join("; ")}`,
    );
  }
  const page: NoxPageDescriptor = {
    id: input.id,
    owner: input.owner,
    title: input.title ?? input.props.view.title,
    page: {
      component: "nox.feature-shell",
      props: validated.props as unknown as Record<string, unknown>,
    },
  };
  const check = validate_page_descriptor(page);
  if (!check.ok) {
    throw new Error(
      `feature-shell page failed validation: ${check.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return check.page;
}

export function is_feature_shell_page(page: NoxPageDescriptor): boolean {
  return page.page?.component === "nox.feature-shell";
}

/**
 * Parse list query params with caps (default max_take=100).
 */
export function parse_list_query(
  search_params: URLSearchParams,
  opts?: { max_take?: number },
): Required<Pick<NoxListQuery, "take" | "skip">> & NoxListQuery {
  const max_take = opts?.max_take ?? 100;
  const q_raw = search_params.get("q") ?? search_params.get("termino");
  const q = q_raw && q_raw.trim() ? q_raw.trim() : undefined;

  let take = Number(search_params.get("take") ?? search_params.get("limite") ?? 100);
  if (!Number.isFinite(take) || take < 1) take = 100;
  const effective_max = search_params.has("limite") ? Math.max(max_take, 10000) : max_take;
  if (take > effective_max) take = effective_max;

  let skip = Number(search_params.get("skip") ?? search_params.get("desde") ?? 0);
  if (!Number.isFinite(skip) || skip < 0) skip = 0;
  skip = Math.floor(skip);

  // La lista compartida de Angular manda el orden en dos parámetros
  // (`campoSort=titulo` + `sort=1|-1`), igual que ya manda `limite`/`desde`/
  // `termino`. Sin traducirlo, el `sort` numérico no casa con `campo:dir` y el
  // CRUD no solo ignoraba la columna pedida: también se quedaba sin el
  // `default_sort` de la app, porque un valor inválido pisa al de por defecto.
  const sort_raw = search_params.get("sort");
  const campo_sort = search_params.get("campoSort")?.trim();
  const sort_is_direction = !!sort_raw && /^-?\d+$/.test(sort_raw.trim());
  let sort: string | undefined;
  if (campo_sort) {
    const dir = sort_is_direction && Number(sort_raw) < 0 ? "desc" : "asc";
    sort = `${campo_sort}:${dir}`;
  } else if (sort_is_direction) {
    sort = undefined;
  } else {
    sort =
      sort_raw && /^[a-zA-Z_][a-zA-Z0-9_]*:(asc|desc)$/.test(sort_raw)
        ? sort_raw
        : sort_raw && sort_raw.trim()
          ? sort_raw.trim()
          : undefined;
  }

  const result: Required<Pick<NoxListQuery, "take" | "skip">> & NoxListQuery = {
    take: Math.floor(take),
    skip,
  };
  if (q !== undefined) result.q = q;
  if (sort !== undefined) result.sort = sort;
  return result;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion FEATURE SHELL DESCRIPTOR
// (o==================================================================o)
