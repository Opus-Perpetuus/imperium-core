// (o==================================================================o)
//   #region KIRLET MANIFEST
// (o-----------------------------------------------------------\/-----o)

import type { KirletManifestWidget } from "./widgets.js";

export interface KirletManifestCompat {
  nox: string;
  kit: string;
}

export interface KirletManifestApi {
  basePath: string;
  port: number;
  healthPath: string;
}

export interface KirletManifestMenuItem {
  id: string;
  label: string;
  order?: number;
  realm?: "internal" | "public";
  /**
   * Target page for leaf items. Optional on group parents that only carry
   * `children` (NOX maps each root to one sidebar section).
   */
  pageId?: string;
  path?: string;
  permission?: string;
  /** Optional registry icon id (e.g. `users`, `cart`) for sidebar a11y. */
  icon?: string;
  children?: KirletManifestMenuItem[];
}

export interface KirletManifestPage {
  id: string;
  path: string;
  permission?: string;
}

export interface KirletManifestIcon {
  label?: string;
  paths: Array<{ d: string; paint: "stroke" | "fill" }>;
}

/** Access level for public realm pages/API. Deny-by-default when absent. */
export type KirletPublicAccess = "anonymous" | "external";

/**
 * Attachment resources this kirlet exposes for public read.
 *
 * A storefront has to serve product photos to anonymous visitors, but
 * `/api/attachments/:id/content` is staff-only. Rather than opening every
 * attachment, a kirlet names the resource prefixes it wants readable — e.g.
 * `kirlet.tienda.product` — and only those are served by `GET /api/p/files/:id`.
 * Deny-by-default: an undeclared prefix 404s.
 */
export interface KirletManifestPublicFiles {
  /** Matched against `attachments.resource` as a prefix. */
  resourcePrefix: string;
  access: KirletPublicAccess;
}

export interface KirletManifestPublic {
  pages?: Array<{ id: string; access: KirletPublicAccess }>;
  api?: Array<{
    pathPrefix: string;
    access: KirletPublicAccess;
    methods?: string[];
  }>;
  files?: KirletManifestPublicFiles[];
}

/**
 * Domain storage model for installable kirlets.
 * - `shared-nox-postgres` (required): domain tables live in NOX Postgres; NOX applies schema.
 * - Private/sidecar domain DBs (sqlite files, per-container DB) are **forbidden**.
 * - `files: true` may still mount a volume for blobs only (not domain tables).
 * - Legacy `data: true` is rejected by validation (was private volume DB).
 */
export type KirletDomainStorage = "shared-nox-postgres";

export interface KirletManifestStorage {
  /** Must be shared-nox-postgres. Domain data is never private to the container. */
  domain: KirletDomainStorage;
  /** Optional blob/file volume under DATA_DIR/files — not a domain database. */
  files?: boolean;
  /**
   * @deprecated Forbidden. Private domain DB volumes are no longer allowed.
   * Present only so validators can reject old manifests clearly.
   */
  data?: boolean;
}

export interface KirletManifest {
  id: string;
  technicalId: string;
  name: string;
  version: string;
  image: string;
  compat: KirletManifestCompat;
  api: KirletManifestApi;
  permissions?: Array<{ id: string; label: string }>;
  menu?: KirletManifestMenuItem[];
  pages?: KirletManifestPage[];
  icon?: KirletManifestIcon;
  /** Domain storage: shared NOX Postgres (required for domain-bearing kirlets). */
  storage?: KirletManifestStorage;
  search?: { indexes: unknown[] };
  logging?: { defaultLevel?: string };
  /** Public realm allowlist. Absent ⇒ nothing public (deny by default). */
  public?: KirletManifestPublic;
  /** Other kirlets that must be installed first (technical ids). */
  dependsOn?: string[];
  /**
   * Widgets this kirlet offers the mobile host (in-app + launcher).
   * Absent ⇒ no kirlet widgets (NOX defaults still apply).
   */
  widgets?: KirletManifestWidget[];
  /**
   * Offline / local surface for the mobile host. Widgets here (typically the
   * `embedded` set) can be installed without Docker. Full page descriptors
   * live in `mobile/local-pack.json`.
   */
  localFunctions?: { widgets: KirletManifestWidget[] };
  /**
   * Gateway resource map: path segment (alias) → permission module resource.
   * e.g. `{ "leave-requests": "leave", "employees": "employees" }`.
   * Derived by define_kirlet; optional on hand-written manifests.
   */
  resources?: Record<string, string>;
}

export function is_kirlet_catalog_id(value: string): boolean {
  return /^KIRLET-[a-z][a-z0-9-]*$/.test(value) || /^SUBJECT-[a-z][a-z0-9-]*$/.test(value);
}

export function is_kirlet_technical_id(value: string): boolean {
  return /^kirlet-[a-z][a-z0-9-]*$/.test(value) || /^subject-[a-z][a-z0-9-]*$/.test(value);
}

export function is_subject_catalog_id(value: string): boolean {
  return /^SUBJECT-[a-z][a-z0-9-]*$/.test(value);
}

export function is_subject_technical_id(value: string): boolean {
  return /^subject-[a-z][a-z0-9-]*$/.test(value);
}

/** Extract slug from catalog `SUBJECT-hr` / `KIRLET-hr` or technical `subject-hr` / `kirlet-hr`. */
export function kirlet_slug_from_id(id: string): string | null {
  const catalog = id.match(/^(?:KIRLET|SUBJECT)-([a-z][a-z0-9-]*)$/);
  if (catalog) return catalog[1];
  const tech = id.match(/^(?:kirlet|subject)-([a-z][a-z0-9-]*)$/);
  if (tech) return tech[1];
  return null;
}

export const subject_slug_from_id = kirlet_slug_from_id;

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET MANIFEST
// (o==================================================================o)
