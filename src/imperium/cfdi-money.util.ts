/**
 * Money helpers for CFDI amounts (2 decimals for currency, 6 for QR total).
 */

/**
 * Rounds half-up to `decimals` places (SAT-style monetary rounding).
 */
export function cfdi_round(value: number, decimals = 2): number {
    if (!Number.isFinite(value)) return 0;
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Formats a total for the SAT QR `tt` parameter:
 * up to 18 integer digits + optional fractional part with up to 6 decimals,
 * without trailing non-significant zeros.
 */
export function format_total_for_qr(total: number): string {
    const rounded = cfdi_round(total, 6);
    const fixed = rounded.toFixed(6);
    // Strip trailing zeros and optional trailing dot.
    return fixed.replace(/\.?0+$/, "") || "0";
}

/**
 * Safe sum of amounts rounded to 2 decimals.
 */
export function sum_amounts(values: number[]): number {
    return cfdi_round(
        values.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0),
        2,
    );
}
