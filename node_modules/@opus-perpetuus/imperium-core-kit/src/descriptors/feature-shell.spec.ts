import { describe, expect, test } from "bun:test";
import {
  build_feature_shell_page,
  parse_list_query,
  validate_feature_shell_props,
} from "./feature-shell.js";
import { validate_page_descriptor } from "./ui-descriptor.js";

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
});
