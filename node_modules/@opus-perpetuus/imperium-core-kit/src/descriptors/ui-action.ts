// (o==================================================================o)
//   #region UI ACTION (botón que escribe)
// (o-----------------------------------------------------------\/-----o)

import { parse_api_data_source } from "./api-data-source.js";

/**
 * Una acción de escritura declarada por un nodo del descriptor.
 *
 * Reusa la forma que `feature-shell` ya declara (`{ method, action }` con
 * `action` en `api://`) en vez de inventar un segundo dialecto: el catálogo de
 * componentes es uno solo y lo pintan el mismo renderer el lanzador interno y
 * el sitio público. Lo único que añade es `body`, porque un botón suelto —a
 * diferencia de un formulario— lleva su carga escrita en el propio descriptor.
 */
export type NoxUiAction = {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  /** Ruta relativa a la raíz de la API de la app, sin barra inicial. */
  path: string;
  /** Query tal como la escribió la app, sin `?`. */
  query: string;
  body: Record<string, unknown>;
  /** Texto a confirmar antes de disparar; vacío = sin confirmación. */
  confirm: string;
  /** Página a la que ir tras el éxito; vacío = recargar la actual. */
  then: string;
};

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text_of(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Lee la acción de las props de un nodo. Devuelve null cuando el nodo no
 * declara ninguna, o cuando la que declara no es utilizable.
 *
 * El descriptor lo escribe la app, pero llega por HTTP: una acción que apunte
 * fuera de `api://` —o que trepe con `..`— no se dispara. Sin este filtro, una
 * app comprometida podría hacer que el navegador de un cliente escriba en
 * cualquier origen con sus cookies.
 */
export function parse_ui_action(props: unknown): NoxUiAction | null {
  if (!is_plain_object(props)) return null;
  /**
   * Dos formas, una sola semántica: anidada bajo `invoke` —la que ya declara
   * `feature-shell`— y plana sobre las props, que es como la escriben las
   * páginas de tienda heredadas de Kirel. Aceptar ambas evita reescribir
   * descriptores que ya funcionan solo por gusto.
   */
  const invoke = is_plain_object(props["invoke"]) ? props["invoke"] : props;

  const method = text_of(invoke["method"]).toUpperCase();
  if (!WRITE_METHODS.has(method)) return null;

  const parsed = parse_api_data_source(invoke["action"]);
  if (!parsed.ok) return null;

  return {
    method: method as NoxUiAction["method"],
    path: parsed.ref.path,
    query: parsed.ref.query,
    body: is_plain_object(props["body"]) ? props["body"] : {},
    confirm: text_of(props["confirm"]),
    then: text_of(props["then"]),
  };
}

/**
 * Ruta HTTP de la acción bajo la base de la app que sirvió la página.
 *
 * La base la pone el anfitrión, no el descriptor: la misma página se sirve por
 * `/api/m/<app>` desde el lanzador interno y por `/api/p/m/<app>` desde el
 * sitio público, y la app no tiene por qué saber por cuál de las dos entró.
 */
export function ui_action_http_path(
  action: NoxUiAction,
  api_base: string,
): string {
  const base = api_base.replace(/\/+$/, "");
  return `${base}/${action.path}${action.query ? `?${action.query}` : ""}`;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion UI ACTION
// (o==================================================================o)
