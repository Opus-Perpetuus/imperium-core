//   #region NOX VIEW-LIST DESCRIPTOR

import type { FeatureShellScannerConfig } from "./feature-shell.js";
import type { NoxUiNode } from "./ui-descriptor.js";

/**
 * Un componente dentro de una celda de `nox.view-list`. El lanzador trae de
 * fábrica `text`, `image` (miniatura que abre la galería), `code` (código de
 * barras/QR dibujado con su nota), `links` y `badge`; cualquier otro `kind` es
 * un componente registrado en el lanzador (`register_view_list_cell`).
 */
export type NoxViewListCell = {
  kind: "text" | "image" | "code" | "links" | "badge" | (string & {});
  /** Llave de la fila que lee; por defecto la de la columna. */
  key?: string;
  label?: string;
  /** `image`: llave con la imagen completa o la lista de la galería. */
  full_key?: string;
  /** `code`: dibujar solo el código o código y texto (por defecto, ambos). */
  display?: "codigo" | "ambos";
  /** `code`: llave con la metadata de cada código (formato, nota…). */
  meta_key?: string;
  /** `code`: llave con los códigos tal cual (lista o uno solo). */
  values_key?: string;
  /** `code`: formato para lo que no trae metadata (por defecto QR). */
  format?: string;
  props?: Record<string, unknown>;
};

export type NoxViewListColumn = {
  key: string;
  label: string;
  /** Uno o varios componentes en la celda; sin ellos, el view-list decide por el valor. */
  cells?: NoxViewListCell[];
  mono?: boolean;
  /** Se ve en la tarjeta móvil. */
  mobile?: boolean;
};

export type NoxViewListProps = {
  columns: NoxViewListColumn[];
  /** Filas ya armadas (paginación en el navegador). Cada una con `_id` y, si se abre, `_href`. */
  rows?: Record<string, unknown>[];
  /**
   * `api://…` que responde `{ data, total }` a `q`, `page` (desde 1) y
   * `page_size`: paginación y búsqueda en el servidor.
   */
  source?: string;
  page_size?: number;
  q?: string;
  page?: number;
  /** `false` quita el buscador; un texto es su etiqueta. */
  search?: boolean | string;
  /** Escáner: lo leído busca en la lista; `open_single` abre el registro si solo uno coincide. */
  scanner?: {
    label?: string;
    help?: string;
    config?: FeatureShellScannerConfig;
    open_single?: boolean;
  };
  /** Llave con el título de la fila (visor de imágenes). */
  title_key?: string;
  empty?: string;
  anchor?: string;
};

/**
 * Nodo `nox.view-list`. `fallback` son los hijos que pinta un lanzador que
 * aún no conoce `nox.view-list` (p. ej. el `nox.table` de antes); el que sí lo
 * conoce los ignora.
 */
export function nox_view_list(props: NoxViewListProps, fallback: NoxUiNode[] = []): NoxUiNode {
  return {
    component: "nox.view-list",
    props: props as unknown as Record<string, unknown>,
    ...(fallback.length ? { children: fallback } : {}),
  };
}

/** Lo que pide `source`: `q`, página desde 1 y tamaño acotado (1–500, 50 por defecto). */
export function nox_view_list_query(params: URLSearchParams): { q: string; page: number; page_size: number } {
  const n = (raw: string | null, fallback: number, max: number) => {
    const v = Math.trunc(Number(raw));
    return Number.isFinite(v) && v >= 1 ? Math.min(v, max) : fallback;
  };
  return {
    q: (params.get("q") ?? "").trim(),
    page: n(params.get("page"), 1, Number.MAX_SAFE_INTEGER),
    page_size: n(params.get("page_size"), 50, 500),
  };
}

/** Una página de `filas` como la espera `source`. */
export function nox_view_list_page<T>(filas: readonly T[], page: number, page_size: number): { data: T[]; total: number } {
  const paginas = Math.max(1, Math.ceil(filas.length / page_size));
  const actual = Math.min(Math.max(1, page), paginas);
  const desde = (actual - 1) * page_size;
  return { data: filas.slice(desde, desde + page_size), total: filas.length };
}

//   #endregion NOX VIEW-LIST DESCRIPTOR
