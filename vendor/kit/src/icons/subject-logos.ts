/**
 * Named SVG logos for Imperium catalog subjects (Kirel `brand:` / `kirlet:` pattern).
 * Refs: `subject:<slug>` e.g. `subject:almacen`.
 *
 * Pictogramas rellenos en viewBox 64×64. El degradado de 3 paradas usa tokens
 * de tema (mismo contrato que la corona de Imperium). Huecos `evenodd` van en
 * el **mismo** `<path>` que el sólido; hermanos se pintan encima, no recortan.
 * Autoría: `docs/subject-logos/` + `subject-logo-geometry.mjs`.
 */

import glyphs_json from './subject-logo-glyphs.json';

export const SUBJECT_SLUGS = [
	'almacen',
	'configuraciones-de-vista',
	'configuracion',
	'control-hospitalario',
	'control-emergencias',
	'control-escolar',
	'control-municipal',
	'dispositivos-fisicos',
	'facturacion-electronica',
	'logistica',
	'pos',
	'pagos',
	'rh',
	'reportes',
	'planeacion',
	'tableros-dinamicos',
	'turnos',
	'vehiculos',
	'ventas',
	'tienda',
] as const;

export type SubjectSlug = (typeof SUBJECT_SLUGS)[number];

const GLYPHS: Record<string, string> = glyphs_json;

/** Paint-server ids must be unique per inlined SVG: the header mounts a
 *  desktop + mobile twin, and `url(#subject-grad-<slug>)` resolves to the
 *  first match — often the `display:none` desktop copy on phone. */
let logo_instance = 0;

function wrap_logo(slug: string, inner: string): string {
	const safe = slug.replace(/[^a-z0-9-]/g, '') || 'x';
	const id = `subject-grad-${safe}-${++logo_instance}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-hidden="true"><defs><linearGradient id="${id}" x1="32" y1="4" x2="32" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--imperium-primary)"/><stop offset="0.45" stop-color="color-mix(in srgb, var(--imperium-primary) 55%, var(--imperium-primary-alt))"/><stop offset="1" stop-color="var(--imperium-primary-alt)"/></linearGradient></defs><g fill="url(#${id})" fill-rule="evenodd">${inner}</g></svg>`;
}

export function subject_logo_ref(slug: string): string {
	return `subject:${slug}`;
}

export function is_subject_logo_ref(ref: string): boolean {
	return /^subject:[a-z][a-z0-9-]*$/.test(ref);
}

export function subject_logo_svg(slug: string): string {
	const glyph = GLYPHS[slug];
	const inner =
		glyph ??
		`<text x="32" y="42" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="700">${(slug[0] ?? '?').toUpperCase()}</text>`;
	return wrap_logo(slug, inner);
}

export function resolve_subject_logo(ref_or_slug: string): string | null {
	const slug = ref_or_slug.startsWith('subject:')
		? ref_or_slug.slice('subject:'.length)
		: ref_or_slug;
	if (!/^[a-z][a-z0-9-]*$/.test(slug)) return null;
	return subject_logo_svg(slug);
}
