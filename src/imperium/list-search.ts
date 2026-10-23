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
	'delivery-return': ['pedido_folio', 'contacto_nombre'],
	products: ['codigo'],
	pedidos: ['folio', 'folio_interno'],
};

const BASE_SEARCH = ['name', 'description', 'ref', 'search_field', 'code'] as const;

/**
 * Columnas base que un recurso no debe usar al buscar. En usuarios el `ref`
 * es interno (p. ej. «user-menu-management-0») y hacía que «ana» trajera a
 * admin por «management» (#179).
 */
const EXCLUDE_SEARCH: Record<string, readonly string[]> = {
	user: ['ref'],
};

export function list_search_columns(
	resource: string,
	cols: Iterable<string>,
): string[] {
	const have = cols instanceof Set ? cols : new Set(cols);
	const excluded = EXCLUDE_SEARCH[resource] ?? [];
	const base = BASE_SEARCH.filter(
		(column) => have.has(column) && !excluded.includes(column),
	);
	const extra = (EXTRA_SEARCH[resource] ?? []).filter(
		(column) => have.has(column) && !base.includes(column),
	);
	return [...base, ...extra];
}
