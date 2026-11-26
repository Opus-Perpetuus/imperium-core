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
	'inventory-internal-location': ['codigo'],
	'inventory-movement': ['producto_codigo', 'producto_nombre', 'lote_codigo', 'documento_referencia'],
	pedidos: ['folio', 'folio_interno'],
	contacto: ['codigo', 'rfc'],
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

/**
 * Recursos donde el término se busca por palabras, sin acentos ni mayúsculas:
 * cada palabra debe aparecer en alguna columna, en cualquier orden. En
 * contactos el vendedor escribe «maria gonzalez» y el cliente se llama
 * «GONZÁLEZ MARÍA CECILIA» (#291); el ILIKE de la frase completa no lo hallaba.
 */
const WORD_SEARCH = new Set(['contacto']);

const ACCENTED = 'áàäâãéèëêíìïîóòöôõúùüûñç';
const PLAIN = 'aaaaaeeeeiiiiooooouuuunc';

export function fold_search_text(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '');
}

function escape_like(value: string): string {
	return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function uses_word_search(resource: string): boolean {
	return WORD_SEARCH.has(resource);
}

/**
 * `(palabra1 en alguna columna) AND (palabra2 en alguna columna) ...`, con las
 * columnas y el término sin acentos. `push` agrega el parámetro y devuelve su
 * marcador (`$n`). `quote` cita el identificador de columna.
 */
export function word_search_sql(
	columns: string[],
	q: string,
	push: (value: string) => string,
	quote: (column: string) => string,
): string {
	const words = fold_search_text(q).split(/\s+/).filter(Boolean).slice(0, 8);
	if (!words.length || !columns.length) return '';
	const clauses = words.map((word) => {
		const mark = push(`%${escape_like(word)}%`);
		const parts = columns.map(
			(column) => `translate(lower(${quote(column)}::text), '${ACCENTED}', '${PLAIN}') LIKE ${mark}`,
		);
		return `(${parts.join(' OR ')})`;
	});
	return `(${clauses.join(' AND ')})`;
}
