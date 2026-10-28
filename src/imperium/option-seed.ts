/**
 * Siembra que solo agrega opciones ausentes.
 * La identidad es el valor (y, en estatus, el campo). Una opción ya
 * guardada no se reescribe: ni etiqueta, ni color, ni bandera de usuario.
 */

export type SeedIdentity = {
	value?: unknown;
	field_name?: unknown;
};

/** Valor de opción para guardar: limpia basura, conserva mayúsculas (SAT, USD/MXN). */
export function sanitize_option_value(value: unknown): string {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return '';
	return raw.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function option_keys(value: unknown): string[] {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return [];
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	const ident = raw
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '_')
		.replace(/[^a-z0-9_]/g, '')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	return [...new Set([raw, raw.toLowerCase(), slug, ident].filter(Boolean))];
}

function field_of(item: SeedIdentity) {
	const raw = typeof item.field_name === 'string' ? item.field_name.trim() : '';
	return raw || 'state';
}

export function same_option(a: SeedIdentity, b: SeedIdentity, field_scoped: boolean) {
	if (field_scoped && field_of(a) !== field_of(b)) return false;
	const keys = new Set(option_keys(a.value));
	if (!keys.size) return false;
	return option_keys(b.value).some((key) => keys.has(key));
}

/**
 * Conserva las referencias del arreglo existente y solo empuja las nuevas.
 * `skipped` cuenta las que ya estaban (no se tocan) y las que llegaron sin valor.
 */
export function insert_missing<T extends SeedIdentity>(
	existing: readonly T[],
	incoming: readonly T[],
	field_scoped: boolean,
): { options: T[]; inserted: number; skipped: number } {
	const options = [...existing];
	let inserted = 0;
	let skipped = 0;
	for (const item of incoming) {
		if (!option_keys(item.value).length) {
			skipped += 1;
			continue;
		}
		if (options.some((have) => same_option(have, item, field_scoped))) {
			skipped += 1;
			continue;
		}
		options.push(item);
		inserted += 1;
	}
	return { options, inserted, skipped };
}

export type PresentationSeed = SeedIdentity & {
	color?: unknown;
	icon?: unknown;
};

function blank(value: unknown) {
	return !(typeof value === 'string' && value.trim());
}

/**
 * Rellena color/icon solo cuando el guardado los trae vacíos.
 * No toca etiqueta, valor, type ni banderas. Devuelve copia superficial.
 */
export function fill_empty_presentation<T extends PresentationSeed>(
	existing: readonly T[],
	incoming: readonly T[],
	field_scoped: boolean,
): { options: T[]; filled: number } {
	let filled = 0;
	const options = existing.map((have) => {
		const donor = incoming.find((item) => same_option(have, item, field_scoped));
		if (!donor) return have;
		let next: T | null = null;
		if (blank(have.color) && !blank(donor.color)) {
			next = { ...(next ?? have), color: donor.color };
		}
		if (blank(have.icon) && !blank(donor.icon)) {
			next = { ...(next ?? have), icon: donor.icon };
		}
		if (!next) return have;
		filled += 1;
		return next;
	});
	return { options, filled };
}

