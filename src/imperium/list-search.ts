/**
 * Columnas ILIKE del listado (`find_many` q). Reportes ciudadanos también
 * buscan folio/nombre/teléfono/descripción, no solo `name`/`search_field`.
 */
const EXTRA_SEARCH: Record<string, readonly string[]> = {
	'citizen-report': [
		'citizen_name',
		'citizen_phone',
		'citizen_email',
		'report_description',
		'citizen_street',
	],
};

const BASE_SEARCH = ['name', 'description', 'ref', 'search_field', 'code'] as const;

export function list_search_columns(
	resource: string,
	cols: Iterable<string>,
): string[] {
	const have = cols instanceof Set ? cols : new Set(cols);
	const base = BASE_SEARCH.filter((column) => have.has(column));
	const extra = (EXTRA_SEARCH[resource] ?? []).filter(
		(column) => have.has(column) && !base.includes(column),
	);
	return [...base, ...extra];
}
