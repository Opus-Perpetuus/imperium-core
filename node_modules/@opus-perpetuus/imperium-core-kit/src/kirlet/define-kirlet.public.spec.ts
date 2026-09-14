import { describe, expect, test } from "bun:test";
import { define_module, define_routes } from "./define-module.js";
import { define_app, define_kirlet, define_subject } from "../index.js";

function notes_module(opts?: {
  page_public?: "anonymous";
  route_public?: "anonymous";
}) {
  return define_module({
    resource: "notes",
    labels: { singular: "Nota", plural: "Notas" },
    routes: define_routes({
      "GET /notes": opts?.route_public
        ? {
            public_access: opts.route_public,
            handler: async () => ({ data: [] }),
          }
        : async () => ({ data: [] }),
      "POST /notes": async () => ({ data: { id: "1" } }),
    }),
    pages: [
      {
        id: "notes-list",
        path: "/notes",
        public_access: opts?.page_public,
        build: () => ({
          page: { component: "nox.stack", props: { gap: 1 } },
        }),
      },
      {
        id: "notes-admin",
        path: "/notes/admin",
        build: () => ({
          page: { component: "nox.stack", props: { gap: 1 } },
        }),
      },
    ],
  });
}

const compat = { nox: ">=0.5.0", kit: "^0.5.0" };

describe("define_kirlet public opt-in", () => {
  test("an app with only internal pages has a valid manifest without public", () => {
    const def = define_kirlet({
      id: "KIRLET-notes",
      name: "Notas",
      version: "0.1.0",
      image: "kirel/kirlet-notes:0.1.0",
      compat,
      modules: [notes_module()],
    });
    const manifest = def.manifest();
    expect(manifest.pages?.some((p) => p.id === "notes-list")).toBe(true);
    expect(manifest.public).toBeUndefined();
  });

  test("public_access on a page is ignored unless the app opts into public", () => {
    const def = define_kirlet({
      id: "KIRLET-notes",
      name: "Notas",
      version: "0.1.0",
      image: "kirel/kirlet-notes:0.1.0",
      compat,
      modules: [
        notes_module({ page_public: "anonymous", route_public: "anonymous" }),
      ],
    });
    expect(def.manifest().public).toBeUndefined();
  });

  test("opt-in app lists only pages marked public_access on manifest.public", () => {
    const def = define_kirlet({
      id: "KIRLET-notes",
      name: "Notas",
      version: "0.1.0",
      image: "kirel/kirlet-notes:0.1.0",
      compat,
      public: true,
      modules: [
        notes_module({ page_public: "anonymous", route_public: "anonymous" }),
      ],
    });
    const manifest = def.manifest();
    expect(manifest.public?.pages?.map((p) => p.id)).toEqual(["notes-list"]);
    expect(manifest.public?.pages?.some((p) => p.id === "notes-admin")).toBe(
      false,
    );
    expect(manifest.pages?.some((p) => p.id === "notes-admin")).toBe(true);
    expect(manifest.public?.api?.some((a) => a.pathPrefix === "/notes")).toBe(
      true,
    );
  });
});

describe("define_subject public opt-in", () => {
  test("is the same authoring entry as define_kirlet", () => {
    expect(define_subject).toBe(define_kirlet);
    expect(define_app).toBe(define_subject);
    const def = define_subject({
      id: "SUBJECT-notes",
      name: "Notas",
      version: "0.1.0",
      image: "ghcr.io/opus-perpetuus/subject-notes:0.1.0",
      compat,
      modules: [notes_module()],
    });
    expect(def.manifest().public).toBeUndefined();
    expect(def.technical_id).toBe("subject-notes");
  });
});

describe("una página pública puede nombrar su sección", () => {
  test("la app decide el segmento y la etiqueta que ve el visitante", () => {
    const def = define_kirlet({
      id: "KIRLET-notes",
      name: "Notas",
      version: "0.1.0",
      image: "kirel/kirlet-notes:0.1.0",
      compat,
      public: true,
      modules: [
        define_module({
          resource: "notes",
          labels: { singular: "Nota", plural: "Notas" },
          routes: define_routes({
            "GET /notes": async () => ({ data: [] }),
          }),
          pages: [
            {
              id: "notes-list",
              path: "/notes",
              public_access: "anonymous",
              public_segment: "avisos",
              public_label: "Avisos",
              build: () => ({
                page: { component: "nox.stack", props: { gap: 1 } },
              }),
            },
          ],
        }),
      ],
    });
    const page = def.manifest().public?.pages?.[0];
    expect(page?.segment).toBe("avisos");
    expect(page?.label).toBe("Avisos");
  });

  test("sin declararlo, el manifiesto no inventa sección", () => {
    const def = define_kirlet({
      id: "KIRLET-notes",
      name: "Notas",
      version: "0.1.0",
      image: "kirel/kirlet-notes:0.1.0",
      compat,
      public: true,
      modules: [notes_module({ page_public: "anonymous" })],
    });
    const page = def.manifest().public?.pages?.[0];
    expect(page?.id).toBe("notes-list");
    expect(page?.segment).toBeUndefined();
    expect(page?.label).toBeUndefined();
  });
});
