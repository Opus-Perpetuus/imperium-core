import { describe, expect, test } from "bun:test";
import {
  build_feature_shell_page,
  FEATURE_SHELL_FIELD_COMPONENTS,
  type FeatureShellFieldDescriptor,
  parse_list_query,
  validate_feature_shell_props,
} from "./feature-shell.js";
import {
  is_allowed_ui_component,
  validate_page_descriptor,
} from "./ui-descriptor.js";

const sample_props = {
  basePath: "employees",
  idKey: "id",
  nameKey: "name",
  view: {
    title: "Empleados",
    pluralLabel: "empleados",
    singularLabel: "empleado",
    emptyTitle: "Sin empleados",
    emptyDescription: "Registra el primer empleado",
  },
  data: {
    list: "api://m/kirlet-hr/employees",
    record: "api://m/kirlet-hr/employees/:id",
    create: { method: "POST" as const, action: "api://m/kirlet-hr/employees" },
    update: {
      method: "PATCH" as const,
      action: "api://m/kirlet-hr/employees/:id",
    },
    delete: {
      method: "DELETE" as const,
      action: "api://m/kirlet-hr/employees/:id",
    },
  },
  table: {
    columns: [
      { key: "name", label: "Nombre", sortable: true, priority: 1 as const },
      { key: "email", label: "Correo", sortable: true, priority: 2 as const },
    ],
    fillHeight: true,
    mobileCards: true,
  },
  form: {
    fields: [
      {
        name: "full_name",
        component: "input-text" as const,
        label: "Nombre completo",
        required: true,
      },
      {
        name: "department_id",
        component: "input-menu" as const,
        label: "Departamento",
        optionsSource: "api://m/kirlet-hr/departments?as=options",
      },
    ],
  },
  permission: "kirlet.hr.employees",
};

describe("feature-shell", () => {
  test("build_feature_shell_page pasa validate_page_descriptor", () => {
    const page = build_feature_shell_page({
      id: "hr.employees",
      owner: "kirlet-hr",
      title: "Empleados",
      props: sample_props,
    });
    const result = validate_page_descriptor(page);
    expect(result.ok).toBe(true);
    expect(page.page.component).toBe("nox.feature-shell");
  });

  test("rechaza field component desconocido", () => {
    const result = validate_feature_shell_props({
      ...sample_props,
      form: {
        fields: [
          { name: "x", component: "input-magic", label: "X" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.message.includes("unknown field component")),
      ).toBe(true);
    }
  });

  test("acepta cada tipo de input del catálogo Imperium", () => {
    expect([...FEATURE_SHELL_FIELD_COMPONENTS].sort()).toEqual(
      [
        "input-checkbox",
        "input-checkbox-group",
        "input-choice",
        "input-code-editor",
        "input-color",
        "input-coordinates",
        "input-datalist",
        "input-date",
        "input-date-range",
        "input-datetime",
        "input-editor-html-pdf",
        "input-file",
        "input-hidden",
        "input-icon",
        "input-image",
        "input-json",
        "input-markdown",
        "input-mask",
        "input-menu",
        "input-money",
        "input-month",
        "input-number",
        "input-object",
        "input-password",
        "input-radio-buttons",
        "input-radio-group",
        "input-signature",
        "input-status",
        "input-switch",
        "input-text",
        "input-textarea",
        "input-time",
        "input-timer",
        "input-week",
        "input-weekday",
        "input-year",
      ].sort(),
    );
    const result = validate_feature_shell_props({
      ...sample_props,
      form: {
        fields: FEATURE_SHELL_FIELD_COMPONENTS.map((component) => ({
          name: component.replace("input-", ""),
          component,
        })),
      },
    });
    expect(result.ok).toBe(true);
  });

  test("cada tipo de input también existe como nodo nox.* de página", () => {
    for (const component of FEATURE_SHELL_FIELD_COMPONENTS) {
      expect(is_allowed_ui_component(`nox.${component}`)).toBe(true);
    }
  });

  test("acepta las opciones de cada input", () => {
    const fields: FeatureShellFieldDescriptor[] = [
      {
        name: "correo",
        component: "input-text",
        type: "email",
        placeholder: "nombre@dominio.mx",
        help: "Se usa para avisos",
        column_span: "full",
        read_only: false,
        validate_always: true,
      },
      { name: "rfc", component: "input-mask", mask: "SSSS000000AAA" },
      {
        name: "saldo",
        component: "input-money",
        min: 0,
        max: 1_000_000,
        mask_allow_negative_numbers: true,
      },
      {
        name: "fotos",
        component: "input-image",
        multiple: true,
        image_selection_limit: 4,
      },
      { name: "pdf", component: "input-file", accept: ".pdf" },
      {
        name: "estado",
        component: "input-choice",
        choice_appearance: "segmented",
        options: [
          { value: "abierto", label: "Abierto", color: "success" },
          { value: "cerrado", label: "Cerrado", description: "Ya no cambia" },
        ],
      },
      { name: "activo", component: "input-switch", switch_default_value: true },
      {
        name: "notas",
        component: "input-markdown",
        markdown_initial_mode: "write",
        markdown_single_line: false,
        markdown_hide_expand_button: true,
        markdown_expanded_title: "Notas",
      },
      {
        name: "plantilla",
        component: "input-code-editor",
        code_editor_language: "html",
        code_editor_min_lines: 5,
        code_editor_max_lines: 40,
        code_editor_completion_kind: "zpl",
      },
      {
        name: "vigencia",
        component: "input-date-range",
        date_range_placeholder: "Del … al …",
        date_range_show_quick_presets: false,
        date_range_initial_selection_unit: "month",
        date_range_constraints: { min_date: "2026-01-01", max_span: 90 },
      },
      {
        name: "ubicacion",
        component: "input-coordinates",
        coordinates_street_field: "direccion",
        coordinates_autofill_street: true,
        coordinates_allow_map_toggle: false,
        coordinates_initial_map_visible: false,
      },
      { name: "clave", component: "input-password", show_password_strength: true },
      {
        name: "meta",
        component: "input-object",
        object_read_only: true,
        object_field_overrides: ["id"],
      },
      {
        name: "cliente_id",
        component: "input-datalist",
        optionsSource: "api://m/subject-ventas/contacto?as=options",
        datalist_search_on_empty_focus: true,
        datalist_allow_create_from_search_term: false,
      },
    ];
    const result = validate_feature_shell_props({
      ...sample_props,
      form: { fields },
    });
    expect(result.ok).toBe(true);
  });

  test("rechaza opciones con valores fuera de catálogo", () => {
    const result = validate_feature_shell_props({
      ...sample_props,
      form: {
        fields: [
          { name: "a", component: "input-choice", choice_appearance: "toggle" },
          { name: "b", component: "input-text", type: "color" },
          { name: "c", component: "input-text", column_span: "half" },
          { name: "d", component: "input-markdown", markdown_initial_mode: "rich" },
          {
            name: "e",
            component: "input-date-range",
            date_range_initial_selection_unit: "decade",
          },
          { name: "f", component: "input-menu", options: [{ value: "x" }] },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((i) => i.path);
      expect(paths).toContain("$.form.fields[0].choice_appearance");
      expect(paths).toContain("$.form.fields[1].type");
      expect(paths).toContain("$.form.fields[2].column_span");
      expect(paths).toContain("$.form.fields[3].markdown_initial_mode");
      expect(paths).toContain(
        "$.form.fields[4].date_range_initial_selection_unit",
      );
      expect(paths).toContain("$.form.fields[5].options[0].label");
    }
  });

  test("rechaza data.list no-api://", () => {
    const result = validate_feature_shell_props({
      ...sample_props,
      data: { ...sample_props.data, list: "/employees" },
    });
    expect(result.ok).toBe(false);
  });

  test("parse_list_query capea take a 100", () => {
    const q = parse_list_query(
      new URLSearchParams("q=ada&take=500&skip=10&sort=name:asc"),
    );
    expect(q.take).toBe(100);
    expect(q.skip).toBe(10);
    expect(q.q).toBe("ada");
    expect(q.sort).toBe("name:asc");
  });

  test("parse_list_query traduce el orden que manda la lista de Angular", () => {
    const asc = parse_list_query(
      new URLSearchParams("desde=0&limite=25&campoSort=title&sort=1&termino="),
    );
    expect(asc.sort).toBe("title:asc");
    expect(asc.skip).toBe(0);
    expect(asc.take).toBe(25);

    const desc = parse_list_query(
      new URLSearchParams("campoSort=title&sort=-1"),
    );
    expect(desc.sort).toBe("title:desc");
  });

  test("un sort numérico suelto no pisa el orden por defecto de la app", () => {
    const q = parse_list_query(new URLSearchParams("sort=1"));
    expect(q.sort).toBeUndefined();
  });

  test("campoSort vacío tampoco: es la primera carga de cualquier lista", () => {
    // view-list manda `campoSort=` vacío con `sort=-1` hasta que el usuario
    // toca una columna. Si esto empezara a devolver ":asc", el CRUD se quedaría
    // sin ORDER BY y la paginación repetiría y perdería filas.
    const q = parse_list_query(new URLSearchParams("campoSort=&sort=-1"));
    expect(q.sort).toBeUndefined();
  });
});
