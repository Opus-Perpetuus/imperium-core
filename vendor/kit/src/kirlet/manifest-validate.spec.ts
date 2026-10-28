import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  check_kirlet_compat,
  validate_kirlet_manifest,
} from "./manifest-validate.js";
import { KIRLET_MANIFEST_SCHEMA_URI } from "./manifest.js";
import { semver_satisfies } from "./semver-lite.js";
import { define_kirlet } from "./define-kirlet.js";
import { define_module, define_routes } from "./define-module.js";

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

describe("sección pública declarada", () => {
  function manifest_with_segment(segment: unknown) {
    return {
      ...hr_manifest_0_3,
      public: {
        pages: [{ id: "hr.employees", access: "anonymous", segment }],
      },
    };
  }

  test("una sección normal pasa y llega al manifiesto", () => {
    const result = validate_kirlet_manifest(manifest_with_segment("vacantes"));
    expect(result.ok).toBe(true);
    expect(result.manifest?.public?.pages?.[0]?.segment).toBe("vacantes");
  });

  test("vacía es el inicio del escaparate, no un error", () => {
    const result = validate_kirlet_manifest(manifest_with_segment(""));
    expect(result.ok).toBe(true);
    expect(result.manifest?.public?.pages?.[0]?.segment).toBe("");
  });

  test("una sección que se sale de su tramo de URL se rechaza", () => {
    // El manifiesto lo escribe la app pero lo consume el sitio público al
    // construir rutas: una barra o un `..` saldría del escaparate.
    for (const bad of ["../admin", "a/b", "Catálogo", "con espacio"]) {
      const result = validate_kirlet_manifest(manifest_with_segment(bad));
      expect(result.ok).toBe(false);
    }
  });
});

describe("dependsOn", () => {
  function issues_of(depends_on: unknown) {
    const result = validate_kirlet_manifest({ ...hr_manifest_0_3, dependsOn: depends_on });
    return result.ok ? [] : result.issues;
  }

  test("ids técnicos válidos llegan al manifiesto validado", () => {
    const result = validate_kirlet_manifest({
      ...hr_manifest_0_3,
      dependsOn: ["subject-almacen", "kirlet-vehiculos"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.dependsOn).toEqual(["subject-almacen", "kirlet-vehiculos"]);
    }
  });

  test("sin dependsOn el manifiesto no trae la clave", () => {
    const result = validate_kirlet_manifest(hr_manifest_0_3);
    expect(result.ok).toBe(true);
    if (result.ok) expect("dependsOn" in result.manifest).toBe(false);
  });

  test("un slug suelto o un id de catálogo se rechazan", () => {
    expect(issues_of(["almacen"]).some((i) => i.path === "$.dependsOn[0]")).toBe(true);
    expect(issues_of(["SUBJECT-almacen"]).some((i) => i.path === "$.dependsOn[0]")).toBe(true);
    expect(issues_of([42]).some((i) => i.path === "$.dependsOn[0]")).toBe(true);
  });

  test("duplicados y la propia app se rechazan", () => {
    expect(
      issues_of(["subject-almacen", "subject-almacen"]).some((i) => i.path === "$.dependsOn[1]"),
    ).toBe(true);
    expect(issues_of(["kirlet-hr"]).some((i) => i.path === "$.dependsOn[0]")).toBe(true);
  });

  test("dependsOn null cuenta como ausente, igual que en el núcleo", () => {
    const result = validate_kirlet_manifest({ ...hr_manifest_0_3, dependsOn: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect("dependsOn" in result.manifest).toBe(false);
  });

  test("dependsOn que no es arreglo se rechaza", () => {
    expect(issues_of("subject-almacen").some((i) => i.path === "$.dependsOn")).toBe(true);
  });

  test("define_kirlet ya no cuela dependencias sin validar", () => {
    const def = (depends_on: string[]) =>
      define_kirlet({
        id: "SUBJECT-ventas",
        name: "Ventas",
        compat: { nox: ">=0.5.0", kit: "^0.5.0" },
        dependsOn: depends_on,
        modules: [
          define_module({
            resource: "orders",
            labels: { singular: "Pedido", plural: "Pedidos" },
            routes: define_routes({ "GET /orders": async () => ({ data: [] }) }),
          }),
        ],
      });
    expect(def(["subject-almacen"]).manifest().dependsOn).toEqual(["subject-almacen"]);
    expect(() => def(["almacen"]).manifest()).toThrow(/dependsOn/);
    expect(() => def(["subject-ventas"]).manifest()).toThrow(/dependsOn/);
  });
});

describe("requires.core", () => {
  test("una versión X.Y.Z pasa al manifiesto", () => {
    const result = validate_kirlet_manifest({ ...hr_manifest_0_3, requires: { core: "13.80.0" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.requires).toEqual({ core: "13.80.0" });
  });

  test("sin requires el manifiesto no trae la clave", () => {
    const result = validate_kirlet_manifest({ ...hr_manifest_0_3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect("requires" in result.manifest).toBe(false);
  });

  test("una versión que no es X.Y.Z se rechaza", () => {
    const result = validate_kirlet_manifest({ ...hr_manifest_0_3, requires: { core: "latest" } });
    expect(result.ok).toBe(false);
  });
});

const LEAF_SCHEMA = KIRLET_MANIFEST_SCHEMA_URI;

function vehiculos_leaf(leaf: Record<string, unknown>, page_path = "envio-revision") {
  return {
    $schema: LEAF_SCHEMA,
    manifestVersion: 1,
    id: "SUBJECT-vehiculos",
    technicalId: "subject-vehiculos",
    name: "Vehículos",
    version: "0.10.0",
    image: "ghcr.io/opus-perpetuus/subject-vehiculos:0.10.0",
    compat: { nox: ">=0.2.0 <2.0.0", kit: "^0.2.0" },
    api: { basePath: "/api/m/subject-vehiculos", port: 3000, healthPath: "/health" },
    permissions: [
      { id: "subject.vehiculos.envio-revision.read", label: "Ver envíos a revisión" },
      { id: "subject.vehiculos.envio-revision.write", label: "Editar envíos a revisión" },
    ],
    repository: {
      git: "https://github.com/Opus-Perpetuus/imperium-subject-vehiculos",
      github: "Opus-Perpetuus/imperium-subject-vehiculos",
    },
    versionChannel: {
      kind: "oci",
      registry: "ghcr.io",
      repository: "opus-perpetuus/subject-vehiculos",
      policy: "same-major-auto-patch",
      releases: "github",
      minAgeHours: 24,
    },
    pages: [
      {
        id: "vehiculos.envio-revision",
        path: page_path,
        permission: "subject.vehiculos.envio-revision.read",
        leaf,
      },
    ],
  };
}

describe("leaf del manifiesto", () => {
  test("un crud con appBase relativo pasa y normaliza etiquetas planas a es", () => {
    const result = validate_kirlet_manifest(
      vehiculos_leaf({
        kind: "crud",
        appBase: "envio-revision",
        appCreate: "providers/connectors",
        icon: "fa-file-signature",
        listHeaders: { name: "Título", estado: "Estado" },
        listOnly: false,
        minShellVersion: "13.102.0",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.manifestVersion).toBe(1);
    expect(result.manifest.repository?.github).toBe(
      "Opus-Perpetuus/imperium-subject-vehiculos",
    );
    expect(result.manifest.pages?.[0]?.leaf).toMatchObject({
      kind: "crud",
      appBase: "envio-revision",
      appCreate: "providers/connectors",
      listHeaders: { es: { name: "Título", estado: "Estado" } },
      minShellVersion: "13.102.0",
    });
  });

  test("appBase ilegal no pasa", () => {
    for (const appBase of [
      "../etc",
      "/envio-revision",
      "m/subject-vehiculos/envio-revision",
      "http://evil.example/envio",
      "Envio",
      "envio/../../admin",
    ]) {
      const result = validate_kirlet_manifest(
        vehiculos_leaf({ kind: "crud", appBase }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.some((issue) => issue.path.endsWith("appBase"))).toBe(true);
    }
  });

  test("un segmento reservado o con / inicial no es hoja", () => {
    for (const path of ["login", "tienda", "m", "/envio-revision", "api/health"]) {
      const result = validate_kirlet_manifest(
        vehiculos_leaf({ kind: "crud", appBase: "envio-revision" }, path),
      );
      expect(result.ok).toBe(false);
    }
  });

  test("kind desconocido y leaf sin contrato 1.0 se rechazan", () => {
    const unknown = validate_kirlet_manifest(
      vehiculos_leaf({ kind: "widget-host", appBase: "envio-revision" }),
    );
    expect(unknown.ok).toBe(false);
    const bare = validate_kirlet_manifest({
      ...vehiculos_leaf({ kind: "crud", appBase: "envio-revision" }),
      manifestVersion: undefined,
      $schema: undefined,
    });
    expect(bare.ok).toBe(false);
  });

  test("un manifiesto viejo sin leaf sigue valiendo", () => {
    const result = validate_kirlet_manifest(hr_manifest_0_3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.pages?.[0]?.leaf).toBeUndefined();
  });

  test("define_kirlet conserva leaf de crud y de page en manifest().pages", () => {
    const build = () => ({ page: { component: "nox.stack", props: { gap: 1 } } });
    const def = define_kirlet({
      id: "KIRLET-notas",
      name: "Notas",
      version: "0.1.0",
      image: "kirel/kirlet-notas:0.1.0",
      compat: { nox: ">=0.5.0", kit: "^0.5.0" },
      modules: [
        define_module({
          resource: "notas",
          labels: { singular: "Nota", plural: "Notas" },
          routes: define_routes({
            "GET /notas": async () => ({ data: [] }),
          }),
          pages: [
            {
              id: "notas-crud",
              path: "notas",
              leaf: { kind: "crud", appBase: "notas", appCreate: "notas/nueva" },
              build,
            },
            {
              id: "notas-page",
              path: "notas-ficha",
              leaf: { kind: "page", icon: "cart", listOnly: true },
              build,
            },
            {
              id: "notas-plain",
              path: "/notas/interna",
              build,
            },
          ],
        }),
      ],
    });
    const manifest = def.manifest();
    const read = "kirlet.notas.notas.read";
    expect(manifest.pages?.find((p) => p.id === "notas-crud")?.leaf).toEqual({
      kind: "crud",
      appBase: "notas",
      appCreate: "notas/nueva",
      permission: read,
    });
    expect(manifest.pages?.find((p) => p.id === "notas-page")?.leaf).toEqual({
      kind: "page",
      icon: "cart",
      listOnly: true,
      permission: read,
    });
    expect(manifest.pages?.find((p) => p.id === "notas-plain")?.leaf).toBeUndefined();
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.$schema).toBe(LEAF_SCHEMA);
  });

  test("sin leaf el manifiesto derivado no gana contrato 1.0", () => {
    const def = define_kirlet({
      id: "KIRLET-notas",
      name: "Notas",
      version: "0.1.0",
      image: "kirel/kirlet-notas:0.1.0",
      compat: { nox: ">=0.5.0", kit: "^0.5.0" },
      modules: [
        define_module({
          resource: "notas",
          labels: { singular: "Nota", plural: "Notas" },
          routes: define_routes({
            "GET /notas": async () => ({ data: [] }),
          }),
          pages: [
            {
              id: "notas-plain",
              path: "/notas",
              build: () => ({ page: { component: "nox.stack", props: { gap: 1 } } }),
            },
          ],
        }),
      ],
    });
    const manifest = def.manifest();
    expect(manifest.pages?.[0]?.leaf).toBeUndefined();
    expect(manifest.manifestVersion).toBeUndefined();
    expect(manifest.$schema).toBeUndefined();
  });

  test("el esquema vendored publica el mismo URI y el patrón de appBase", () => {
    const schema = JSON.parse(
      readFileSync(new URL("./kirlet-manifest-1.0.schema.json", import.meta.url), "utf8"),
    ) as {
      $id?: string;
      properties?: {
        pages?: {
          items?: {
            properties?: { leaf?: { properties?: { appBase?: { pattern?: string } } } };
          };
        };
      };
    };
    expect(schema.$id).toBe(LEAF_SCHEMA);
    expect(schema.properties?.pages?.items?.properties?.leaf?.properties?.appBase?.pattern).toBe(
      "^[a-z0-9]+(?:[/-][a-z0-9]+)*$",
    );
  });
});
