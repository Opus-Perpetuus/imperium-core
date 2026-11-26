import { as_array, as_object, type ImperiumDoc } from './envelope.ts';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

/** Máximo de letras del prefijo del turno (AP0001 → «AP»). Odoo #232. */
export const TURN_PREFIX_MAX_LETTERS = 3;

/**
 * Prefijo del turno a partir de la «letra» del servicio o tipo de cliente:
 * mayúsculas, solo letras (incluye Ñ), de 1 a TURN_PREFIX_MAX_LETTERS. Lo
 * que no tenga letras usa `fallback` ('M' como siempre).
 */
export function turn_code_prefix(value: unknown, fallback = 'M'): string {
	const letters = text(value)
		.normalize('NFD')
		.replace(/N\u0303/g, 'Ñ')
		.replace(/n\u0303/g, 'ñ')
		.replace(/[\u0300-\u036f]/g, '')
		.toUpperCase()
		.replace(/[^A-ZÑ]/g, '');
	return letters.slice(0, TURN_PREFIX_MAX_LETTERS) || fallback;
}

/**
 * Administrador de cajas: junta a cada servicio permitido su letra (la misma que
 * lleva el folio del turno) y arma `services_letters` («Agua Potable (AP), General (G)»).
 */
export function with_box_service_letters(
	boxes: ImperiumDoc[],
	services_by_id: Map<string, ImperiumDoc>,
): ImperiumDoc[] {
	return boxes.map((box) => {
		const entries = as_array(box.allowed_services);
		if (!entries.length) return { ...box, services_letters: '' };
		const labels: string[] = [];
		const allowed = entries.map((entry) => {
			const id = ref_id(entry);
			const own = as_object(entry);
			const full = services_by_id.get(id);
			const name = text(own.name) || text(full?.name);
			const letter = turn_code_prefix(full?.letter ?? own.letter);
			labels.push(name ? `${name} (${letter})` : letter);
			return typeof entry === 'object' && entry !== null ? { ...own, letter } : entry;
		});
		return { ...box, allowed_services: allowed, services_letters: labels.join(', ') };
	});
}
