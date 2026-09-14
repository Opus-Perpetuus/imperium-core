// (o==================================================================o)
//   #region CONSTANTS
// (o-----------------------------------------------------------\/-----o)

/** Dark ink for light chip fills (platform-tag model). */
export const NOX_CHIP_DARK_TEXT = "#1f2937";
/** Light ink for dark chip fills. */
export const NOX_CHIP_LIGHT_TEXT = "#ffffff";

// (o-----------------------------------------------------------/\-----o)
//   #endregion CONSTANTS
// (o==================================================================o)

// (o==================================================================o)
//   #region PUBLIC API
// (o-----------------------------------------------------------\/-----o)

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Pick black-ish or white text for a solid background using WCAG contrast.
 * Light backgrounds → dark text; dark backgrounds → light text.
 */
export function pick_readable_text_color(
  background: string | Rgb | null | undefined,
  options?: { dark_text?: string; light_text?: string },
): string {
  const dark = options?.dark_text ?? NOX_CHIP_DARK_TEXT;
  const light = options?.light_text ?? NOX_CHIP_LIGHT_TEXT;
  const rgb =
    typeof background === "string"
      ? parse_hex_color(background)
      : background ?? null;
  if (!rgb) {
    return light;
  }
  const bg_l = relative_luminance(rgb);
  const dark_l = relative_luminance(parse_hex_color(dark)!);
  const light_l = relative_luminance(parse_hex_color(light)!);
  const c_dark = contrast_ratio(bg_l, dark_l);
  const c_light = contrast_ratio(bg_l, light_l);
  return c_dark >= c_light ? dark : light;
}

/**
 * For a two-stop gradient, bias sampling to the lighter stop so pastel chips
 * never keep white ink.
 */
export function pick_readable_text_color_for_gradient(
  from: string | Rgb,
  to: string | Rgb,
  options?: { dark_text?: string; light_text?: string },
): string {
  const a = typeof from === "string" ? parse_hex_color(from) : from;
  const b = typeof to === "string" ? parse_hex_color(to) : to;
  if (!a && !b) {
    return options?.light_text ?? NOX_CHIP_LIGHT_TEXT;
  }
  if (!a) {
    return pick_readable_text_color(b, options);
  }
  if (!b) {
    return pick_readable_text_color(a, options);
  }
  const sample =
    relative_luminance(a) >= relative_luminance(b) ? a : b;
  if (relative_luminance(sample) >= 0.35) {
    return pick_readable_text_color(sample, options);
  }
  return pick_readable_text_color(mix_rgb(a, b, 0.5), options);
}

export function parse_hex_color(value: string): Rgb | null {
  const match = value.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) {
    return null;
  }
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion PUBLIC API
// (o==================================================================o)

// (o==================================================================o)
//   #region PRIVATE HELPERS
// (o-----------------------------------------------------------\/-----o)

function channel_lum(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relative_luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel_lum(r) + 0.7152 * channel_lum(g) + 0.0722 * channel_lum(b);
}

function contrast_ratio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function mix_rgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: Math.round(a.r * (1 - t) + b.r * t),
    g: Math.round(a.g * (1 - t) + b.g * t),
    b: Math.round(a.b * (1 - t) + b.b * t),
  };
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion PRIVATE HELPERS
// (o==================================================================o)
