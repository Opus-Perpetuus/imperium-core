// (o==================================================================o)
//   #region PUBLIC LANDING SWITCH
// (o-----------------------------------------------------------\/-----o)

/** Configuration `_ref` for the SI/NO switch that shows or hides `/`. */
export const PUBLIC_LANDING_ENABLED_REF =
  "configuration-public-landing-enabled";

/** `imperium-sic-switch-input` type stored on the configuration record. */
export const PUBLIC_LANDING_ENABLED_TYPE = "switch";

/**
 * Missing or unreadable values hide the landing (root goes to login).
 * An admin turns the switch on when the public page is ready.
 */
export const PUBLIC_LANDING_ENABLED_DEFAULT = false;

/**
 * Coerce a configuration `value` (boolean, 0/1, or SI/NO-like string) to the
 * landing switch. Unknown values fall back to {@link PUBLIC_LANDING_ENABLED_DEFAULT}.
 */
export function is_public_landing_enabled(value: unknown): boolean {
  if (value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return PUBLIC_LANDING_ENABLED_DEFAULT;
  const trimmed = value.trim();
  if (!trimmed) return PUBLIC_LANDING_ENABLED_DEFAULT;
  const normalized = trimmed.toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "si" ||
    normalized === "sí" ||
    normalized === "yes"
  ) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === trimmed) return PUBLIC_LANDING_ENABLED_DEFAULT;
    return is_public_landing_enabled(parsed);
  } catch {
    return PUBLIC_LANDING_ENABLED_DEFAULT;
  }
}

/**
 * Fields for a new configuration row. `value` is boolean true/false (SI/NO).
 */
export function public_landing_configuration_seed(): {
  _ref: string;
  name: string;
  description: string;
  is_system: boolean;
  module_id: string;
  type: string;
  value: boolean;
  is_active: boolean;
} {
  return {
    _ref: PUBLIC_LANDING_ENABLED_REF,
    name: "Mostrar landing pública",
    description:
      "Si está en SI, la raíz del sitio muestra la landing. Si está en NO, redirige al inicio de sesión.",
    is_system: true,
    module_id: "NA",
    type: PUBLIC_LANDING_ENABLED_TYPE,
    value: PUBLIC_LANDING_ENABLED_DEFAULT,
    is_active: true,
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion PUBLIC LANDING SWITCH
// (o==================================================================o)
