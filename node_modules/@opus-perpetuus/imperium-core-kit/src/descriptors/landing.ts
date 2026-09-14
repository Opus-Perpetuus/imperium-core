// (o==================================================================o)
//   #region LANDING DOCUMENT (pure default / apply / sanitize)
// (o-----------------------------------------------------------\/-----o)

import { PUBLIC_SESSION_START_PATH } from "../auth/principal.js";
import {
  plan_ui_node,
  validate_page_descriptor,
  type NoxPageValidationResult,
  type NoxUiRenderPlan,
  type NoxUiValidationIssue,
} from "./ui-descriptor.js";

export type LandingCodeApplyResult =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; issues: NoxUiValidationIssue[] };

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structured_clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * La landing que trae el producto.
 *
 * Antes eran dos bloques ("Configura esta landing desde el administrador"), asi
 * que una instalacion nueva abria con un cartel de obra en su pagina publica.
 * Ahora trae una landing completa —portada, cifras, servicios, galeria,
 * preguntas, llamada y pie— armada con las mismas secciones que ofrece el
 * editor, para que el sitio se vea terminado desde el primer arranque y quien
 * lo vaya a ajustar empiece cambiando textos en vez de partiendo de cero.
 *
 * `ensure_home` solo la siembra cuando no hay fila: la landing de una
 * instalacion que ya existe no se toca nunca.
 *
 * Es tambien la plantilla que carga el boton "Cargar plantilla de muestra" del
 * editor, para que no haya dos versiones que se separen.
 *
 * Valida contra el catalogo `nox.*` completo (no el set reducido del MVP).
 */
export function default_home_document(): Record<string, unknown> {
  return {
      "id": "portal.home",
      "owner": "portal",
      "title": "Inicio",
      "page": {
          "component": "nox.page",
          "children": [
              {
                  "component": "nox.stack",
                  "props": {
                      "block": "portada",
                      "title": "Un solo sistema para toda la operación",
                      "subtitle": "Trámites, inventario, ventas y reportes en una plataforma que tu equipo entiende desde el primer día.",
                      "image": "assets/images/landing/portada.jpg"
                  },
                  "children": [
                      {
                          "component": "nox.markdown-view",
                          "props": {
                              "content": "Sin instalaciones complicadas y con soporte en español."
                          }
                      },
                      {
                          "component": "nox.button",
                          "text": "Entrar a mi cuenta",
                          "props": {
                              "href": `/${PUBLIC_SESSION_START_PATH}`,
                              "text": "Entrar a mi cuenta"
                          }
                      }
                  ]
              },
              {
                  "component": "nox.stats",
                  "props": {
                      "title": "Lo que ya sostiene",
                      "items": [
                          {
                              "label": "Años de operación",
                              "value": "15"
                          },
                          {
                              "label": "Trámites al mes",
                              "value": "3 200"
                          },
                          {
                              "label": "Disponibilidad",
                              "value": "99.9 %"
                          },
                          {
                              "label": "Módulos activos",
                              "value": "20"
                          }
                      ]
                  }
              },
              {
                  "component": "nox.catalog-grid",
                  "props": {
                      "title": "Qué puedes hacer",
                      "items": [
                          {
                              "title": "Atiende al ciudadano",
                              "subtitle": "Turnos, citas y seguimiento de reportes en un mismo lugar.",
                              "image_url": "assets/images/landing/servicio-1.jpg",
                              "href": `/${PUBLIC_SESSION_START_PATH}`
                          },
                          {
                              "title": "Controla el inventario",
                              "subtitle": "Entradas, salidas y conteos físicos con folios automáticos.",
                              "image_url": "assets/images/landing/servicio-2.jpg",
                              "href": `/${PUBLIC_SESSION_START_PATH}`
                          },
                          {
                              "title": "Vende en línea",
                              "subtitle": "Catálogo público, carrito y pedidos conectados a tu almacén.",
                              "image_url": "assets/images/landing/servicio-3.jpg",
                              "href": "/tienda"
                          }
                      ]
                  }
              },
              {
                  "component": "nox.markdown-view",
                  "props": {
                      "content": "## Pensado para equipos reales\n\nCada módulo se activa cuando lo necesitas. No pagas por lo que no usas y no obligas a nadie a aprender una pantalla que no le toca."
                  }
              },
              {
                  "component": "nox.carousel",
                  "props": {
                      "title": "Así se ve por dentro",
                      "items": [
                          {
                              "title": "Panel de trabajo",
                              "body": "",
                              "image_url": "assets/images/landing/galeria-1.jpg",
                              "href": ""
                          },
                          {
                              "title": "Reportes al día",
                              "body": "",
                              "image_url": "assets/images/landing/galeria-2.jpg",
                              "href": ""
                          },
                          {
                              "title": "Movilidad",
                              "body": "",
                              "image_url": "assets/images/landing/galeria-3.jpg",
                              "href": ""
                          }
                      ]
                  }
              },
              {
                  "component": "nox.collapsible",
                  "props": {
                      "title": "Preguntas frecuentes",
                      "items": [
                          {
                              "title": "¿Necesito instalar algo?",
                              "body": "No. Se usa desde el navegador, y hay aplicación de escritorio y APK si los prefieres."
                          },
                          {
                              "title": "¿Puedo empezar con un solo módulo?",
                              "body": "Sí. Se activan uno por uno desde Configuración → Módulos."
                          },
                          {
                              "title": "¿Qué pasa con mis datos?",
                              "body": "Viven en tu instancia. Puedes exportarlos cuando quieras."
                          }
                      ]
                  }
              },
              {
                  "component": "nox.card",
                  "props": {
                      "block": "llamada",
                      "title": "¿Listo para empezar?",
                      "description": "Entra con tu cuenta o pide acceso a tu administrador."
                  },
                  "children": [
                      {
                          "component": "nox.button",
                          "text": "Entrar a mi cuenta",
                          "props": {
                              "href": `/${PUBLIC_SESSION_START_PATH}`,
                              "text": "Entrar a mi cuenta"
                          }
                      }
                  ]
              },
              {
                  "component": "nox.stack",
                  "props": {
                      "block": "enlaces",
                      "title": "Enlaces"
                  },
                  "children": [
                      {
                          "component": "nox.link",
                          "text": "Inicio",
                          "props": {
                              "href": "/",
                              "text": "Inicio"
                          }
                      },
                      {
                          "component": "nox.link",
                          "text": "Tienda",
                          "props": {
                              "href": "/tienda",
                              "text": "Tienda"
                          }
                      },
                      {
                          "component": "nox.link",
                          "text": "Entrar",
                          "props": {
                              "href": `/${PUBLIC_SESSION_START_PATH}`,
                              "text": "Entrar"
                          }
                      }
                  ]
              }
          ]
      }
  };
}

/**
 * Parse landing JSON. Invalid JSON or unknown component ids never return a
 * partial document — the caller keeps the last good one.
 *
 * Unlike Kirel's MVP bind set, this accepts every catalog `nox.*` id.
 */
export function apply_landing_code(text: string): LandingCodeApplyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          message: e instanceof Error ? e.message : "JSON inválido",
        },
      ],
    };
  }
  const check = validate_page_descriptor(parsed);
  if (check.ok === false) {
    return { ok: false, issues: check.issues };
  }
  return { ok: true, document: parsed as Record<string, unknown> };
}

/**
 * Walk a draft/published page document and sanitize every `nox.html` node's
 * `props.html` before persist. Returns a deep-cloned document.
 */
export function sanitize_page_document_html(
  document: unknown,
  sanitize: (html: string) => string,
): unknown {
  if (!is_plain_object(document)) return document;
  const clone = structured_clone_json(document);
  const page = clone["page"];
  if (is_plain_object(page)) {
    walk_and_sanitize(page, sanitize);
  }
  return clone;
}

function walk_and_sanitize(
  node: Record<string, unknown>,
  sanitize: (html: string) => string,
): void {
  if (node["component"] === "nox.html") {
    const props = node["props"];
    if (is_plain_object(props) && typeof props["html"] === "string") {
      props["html"] = sanitize(props["html"]);
    }
  }
  const children = node["children"];
  if (Array.isArray(children)) {
    for (const child of children) {
      if (is_plain_object(child)) walk_and_sanitize(child, sanitize);
    }
  }
}

/**
 * Validate + optionally sanitize a landing descriptor, then plan the root
 * node with the shipped `plan_ui_node`. Allowlisted catalog ids are not
 * rejected (unbound nodes stay `kind: "node"` with `mvp_bound: false`).
 */
export function plan_landing_document(
  input: unknown,
  opts?: { sanitize?: (html: string) => string },
): NoxPageValidationResult & { root?: NoxUiRenderPlan } {
  const prepared = opts?.sanitize
    ? sanitize_page_document_html(input, opts.sanitize)
    : input;
  const check = validate_page_descriptor(prepared);
  if (check.ok === false) return check;
  return {
    ...check,
    root: plan_ui_node(check.page.page),
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion LANDING DOCUMENT
// (o==================================================================o)
