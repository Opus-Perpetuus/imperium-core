import { describe, expect, test } from "bun:test";
import {
  check_kirlet_compat,
  validate_kirlet_manifest,
} from "./manifest-validate.js";
import { semver_satisfies } from "./semver-lite.js";

const hr_manifest_0_3 = {
  id: "KIRLET-hr",
  technicalId: "kirlet-hr",
  name: "Recursos Humanos",
  version: "0.3.0",
  image: "kyostenas/kirlet-hr:0.3.0",
  compat: { nox: ">=0.2.0 <2.0.0", kit: "^0.2.0" },
  api: { basePath: "/api/m/kirlet-hr", port: 3000, healthPath: "/health" },
  permissions: [
    { id: "kirlet.hr.employees.read", label: "Leer empleados" },
    { id: "kirlet.hr.employees.write", label: "Escribir empleados" },
  ],
  pages: [
    { id: "hr.employees", path: "/pages/hr.employees", permission: "kirlet.hr.employees" },
  ],
  menu: [
    {
      id: "employees",
      label: "Empleados",
      pageId: "hr.employees",
      permission: "kirlet.hr.employees.read",
    },
  ],
  storage: { domain: "shared-nox-postgres", files: true },
};

describe("validate_kirlet_manifest", () => {
  test("acepta manifest HR con shared-nox-postgres", () => {
    const result = validate_kirlet_manifest(hr_manifest_0_3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("KIRLET-hr");
      expect(result.manifest.storage?.domain).toBe("shared-nox-postgres");
      expect(result.manifest.storage?.files).toBe(true);
    }
  });

  test("rechaza storage.data (private domain DB)", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      storage: { data: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === "$.storage.data")).toBe(true);
    }
  });

  test("rechaza id sin prefijo KIRLET-", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      id: "hr",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === "$.id")).toBe(true);
    }
  });

  test("rechaza permiso de otro slug", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      permissions: [{ id: "kirlet.other.employees.read", label: "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.path.includes("permissions")),
      ).toBe(true);
    }
  });

  test("rechaza menú con pageId inexistente", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      menu: [{ id: "x", label: "X", pageId: "missing.page" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.message.includes("not found in pages")),
      ).toBe(true);
    }
  });

  test("acepta grupo de menú sin pageId cuando trae children", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      menu: [
        {
          id: "hr.nav",
          label: "RR.HH.",
          children: [
            {
              id: "employees",
              label: "Empleados",
              pageId: "hr.employees",
              permission: "kirlet.hr.employees.read",
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.menu?.[0]?.pageId).toBeUndefined();
      expect(result.manifest.menu?.[0]?.children?.length).toBe(1);
    }
  });

  test("rechaza grupo de menú sin pageId ni children", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      menu: [{ id: "orphan", label: "Huérfano" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path.includes("pageId"))).toBe(true);
    }
  });

  test("manifest sin public es válido y no trae la clave", () => {
    const result = validate_kirlet_manifest(hr_manifest_0_3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.public).toBeUndefined();
    }
  });

  test("public válido se conserva íntegro en el objeto validado", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: {
        pages: [{ id: "hr.employees", access: "anonymous" }],
        api: [
          {
            pathPrefix: "/store/catalog",
            access: "anonymous",
            methods: ["GET"],
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.public?.pages?.[0].id).toBe("hr.employees");
      expect(result.manifest.public?.api?.[0].pathPrefix).toBe(
        "/store/catalog",
      );
      expect(result.manifest.public?.api?.[0].methods).toEqual(["GET"]);
    }
  });

  test("public.files válido se conserva íntegro", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: {
        files: [
          { resourcePrefix: "kirlet.hr.employee-photo", access: "anonymous" },
          { resourcePrefix: "kirlet.hr.payslip", access: "external" },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.public?.files?.length).toBe(2);
      expect(result.manifest.public?.files?.[0].resourcePrefix).toBe(
        "kirlet.hr.employee-photo",
      );
      expect(result.manifest.public?.files?.[1].access).toBe("external");
    }
  });

  test("public.files con resourcePrefix vacío → issue", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: { files: [{ resourcePrefix: "", access: "anonymous" }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.path.includes("public.files[0].resourcePrefix")),
      ).toBe(true);
    }
  });

  test("public.files con prefijo tipo path (barras) → issue", () => {
    // Un prefijo con barras o comodines abriría más de lo declarado; solo se
    // acepta un nombre de recurso punteado.
    for (const bad of ["kirlet/hr", "kirlet.*", "../etc"]) {
      const result = validate_kirlet_manifest({
        ...hr_manifest_0_3,
        public: { files: [{ resourcePrefix: bad, access: "anonymous" }] },
      });
      expect(result.ok).toBe(false);
    }
  });

  test("public.files nombrando el namespace de otro kirlet → issue", () => {
    // Sin esto, el manifest de un kirlet podría publicar los attachments
    // privados de otro. El validador solo comprobaba la forma del string.
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: {
        files: [{ resourcePrefix: "kirlet.tienda.product", access: "anonymous" }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) =>
          i.message.includes("must name a resource under kirlet.hr."),
        ),
      ).toBe(true);
    }
  });

  test("public.files con el namespace pelado → issue", () => {
    // `kirlet.hr.` abriría de golpe todo lo que el kirlet posee.
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: { files: [{ resourcePrefix: "kirlet.hr.", access: "anonymous" }] },
    });
    expect(result.ok).toBe(false);
  });

  test("public.files con access inválido → issue", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: { files: [{ resourcePrefix: "kirlet.hr.employee-photo", access: "todos" }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((i) => i.path.includes("public.files[0].access")),
      ).toBe(true);
    }
  });

  test("public page id inexistente → issue", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: { pages: [{ id: "missing", access: "anonymous" }] },
    });
    expect(result.ok).toBe(false);
  });

  test("public pathPrefix bare / → issue", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      public: { api: [{ pathPrefix: "/", access: "anonymous" }] },
    });
    expect(result.ok).toBe(false);
  });

  test("acepta widgets embebidos y conserva bind", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      widgets: [
        {
          id: "headcount",
          title: "Plantilla",
          icon: "users",
          size: "sm",
          capability: "embedded",
          pageId: "hr.employees",
          permission: "kirlet.hr.employees.read",
          bind: { resource: "employees", metric: "count" },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.widgets?.[0]?.id).toBe("headcount");
      expect(result.manifest.widgets?.[0]?.bind?.metric).toBe("count");
    }
  });

  test("acepta localFunctions.widgets embebidos", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      localFunctions: {
        widgets: [
          {
            id: "headcount",
            title: "Plantilla",
            capability: "embedded",
            pageId: "hr.employees",
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.localFunctions?.widgets?.[0]?.id).toBe("headcount");
    }
  });

  test("rechaza widget duplicado o pageId huérfano", () => {
    const dup = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      widgets: [
        { id: "headcount", title: "A" },
        { id: "headcount", title: "B" },
      ],
    });
    expect(dup.ok).toBe(false);
    const orphan = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      widgets: [{ id: "x", title: "X", pageId: "missing" }],
    });
    expect(orphan.ok).toBe(false);
  });
});

describe("semver_satisfies", () => {
  test("maneja ^0.3.0 y >=0.1.0 <2.0.0", () => {
    expect(semver_satisfies("0.3.0", "^0.3.0")).toBe(true);
    expect(semver_satisfies("0.3.5", "^0.3.0")).toBe(true);
    expect(semver_satisfies("0.4.0", "^0.3.0")).toBe(false);
    expect(semver_satisfies("0.5.0", ">=0.1.0 <2.0.0")).toBe(true);
    expect(semver_satisfies("2.0.0", ">=0.1.0 <2.0.0")).toBe(false);
    expect(semver_satisfies("1.9.9", ">=0.1.0 <2.0.0")).toBe(true);
  });
});

describe("check_kirlet_compat", () => {
  test("rechaza nox fuera de rango", () => {
    const v = validate_kirlet_manifest(hr_manifest_0_3);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const bad = check_kirlet_compat(v.manifest, {
      nox_version: "0.1.0",
      kit_version: "0.2.0",
    });
    expect(bad.ok).toBe(false);
    expect(bad.issues.some((i) => i.includes("nox"))).toBe(true);

    const good = check_kirlet_compat(v.manifest, {
      nox_version: "0.2.0",
      kit_version: "0.2.5",
    });
    expect(good.ok).toBe(true);
  });
});
