// (o==================================================================o)
//   #region FEATURE SHELL DESCRIPTOR
// (o-----------------------------------------------------------\/-----o)

import type {
  NoxPageDescriptor,
  NoxUiValidationIssue,
} from "./ui-descriptor.js";
import { validate_page_descriptor } from "./ui-descriptor.js";

export type FeatureShellFieldDescriptor = {
  name: string;
  component:
    | "input-text"
    | "input-password"
    | "input-textarea"
    | "input-json"
    | "input-number"
    | "input-date"
    | "input-checkbox"
    | "input-menu"
    | "input-file";
  label?: string;
  placeholder?: string;
  required?: boolean;
  type?: "text" | "email" | "search" | "url" | "tel";
  options?: Array<{ value: string | number | boolean; label: string }>;
  optionsSource?: string;
  min?: number;
  max?: number;
  step?: number;
  accept?: string;
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

const FIELD_COMPONENTS = new Set([
  "input-text",
  "input-password",
  "input-textarea",
  "input-json",
  "input-number",
  "input-date",
  "input-checkbox",
  "input-menu",
  "input-file",
]);

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const q_raw = search_params.get("q");
  const q = q_raw && q_raw.trim() ? q_raw.trim() : undefined;

  let take = Number(search_params.get("take") ?? 100);
  if (!Number.isFinite(take) || take < 1) take = 100;
  if (take > max_take) take = max_take;

  let skip = Number(search_params.get("skip") ?? 0);
  if (!Number.isFinite(skip) || skip < 0) skip = 0;
  skip = Math.floor(skip);

  const sort_raw = search_params.get("sort");
  const sort =
    sort_raw && /^[a-zA-Z_][a-zA-Z0-9_]*:(asc|desc)$/.test(sort_raw)
      ? sort_raw
      : sort_raw && sort_raw.trim()
        ? sort_raw.trim()
        : undefined;

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
