// (o==================================================================o)
//   #region KIRLET / NOX MOBILE WIDGETS
// (o-----------------------------------------------------------\/-----o)

/** In-app grid span. Launcher Glance maps sm→2×1, md→2×2, lg→4×2. */
export type KirletWidgetSize = "sm" | "md" | "lg";

/**
 * `embedded` survives 100% local (kit + SQLDelight).
 * `backend-only` is stripped in local mode (payments, Meili, n8n, Docker).
 */
export type KirletWidgetCapability = "embedded" | "backend-only";

export type KirletWidgetPlacement = "in-app" | "launcher" | "both";

export type NoxRuntimeMode = "local" | "offline" | "cloud";

export type KirletWidgetBindMetric = "count" | "sum" | "latest" | "list";

export interface KirletWidgetBind {
  resource?: string;
  metric?: KirletWidgetBindMetric;
  field?: string;
  limit?: number;
}

export interface KirletManifestWidget {
  /** Unique within the kirlet. Host id = `${technicalId}.${id}`. */
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  size?: KirletWidgetSize;
  capability?: KirletWidgetCapability;
  placement?: KirletWidgetPlacement;
  pageId?: string;
  permission?: string;
  bind?: KirletWidgetBind;
}

export const KIRLET_WIDGET_SIZES: readonly KirletWidgetSize[] = [
  "sm",
  "md",
  "lg",
];

export const KIRLET_WIDGET_CAPABILITIES: readonly KirletWidgetCapability[] = [
  "embedded",
  "backend-only",
];

export const NOX_DEFAULT_WIDGETS: readonly KirletManifestWidget[] = [
  {
    id: "health",
    title: "Salud del núcleo",
    subtitle: "Modo, cola y conexión",
    icon: "pulse",
    size: "md",
    capability: "embedded",
    placement: "both",
  },
  {
    id: "shortcuts",
    title: "Atajos",
    subtitle: "Acciones del núcleo",
    icon: "grid",
    size: "md",
    capability: "embedded",
    placement: "in-app",
  },
  {
    id: "activity",
    title: "Actividad",
    subtitle: "Últimos registros",
    icon: "history",
    size: "lg",
    capability: "embedded",
    placement: "in-app",
    bind: { metric: "list", limit: 5 },
  },
  {
    id: "inbox",
    title: "Bandeja",
    subtitle: "Avisos del dispositivo",
    icon: "inbox",
    size: "sm",
    capability: "embedded",
    placement: "both",
  },
];

export const BACKEND_ONLY_PLATFORM: readonly string[] = [
  "docker-install",
  "meilisearch",
  "n8n",
  "mailer",
  "public-portal",
  "payment-webhooks",
  "external-catalog-sync",
];

export function widget_host_id(technical_id: string, widget_id: string): string {
  return `${technical_id}.${widget_id}`;
}

export function widget_visible_in_mode(
  capability: KirletWidgetCapability | undefined,
  mode: NoxRuntimeMode,
): boolean {
  if (mode === "local" && capability === "backend-only") return false;
  return true;
}

export function filter_widgets_for_mode(
  widgets: readonly KirletManifestWidget[],
  mode: NoxRuntimeMode,
): KirletManifestWidget[] {
  return widgets.filter((w) => widget_visible_in_mode(w.capability, mode));
}

export function parse_runtime_mode(value: unknown): NoxRuntimeMode | null {
  if (value === "local" || value === "offline" || value === "cloud") return value;
  return null;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET / NOX MOBILE WIDGETS
// (o==================================================================o)
