/**
 * Orden de folio de pedidos. `folio` y `folio_interno` son texto: el ORDER BY
 * lexicográfico mete `…-29` antes de `…-3` y entierra el folio interno reciente.
 */
export function pedido_order_sql(
	column_sql: string,
	dir: 'ASC' | 'DESC',
	campo: 'folio' | 'folio_interno',
): string {
	if (campo === 'folio_interno') {
		return ` ORDER BY CASE WHEN ${column_sql} ~ '^[0-9]+$' THEN ${column_sql}::numeric END ${dir} NULLS LAST, ${column_sql} ${dir} NULLS LAST`;
	}
	return ` ORDER BY regexp_replace(COALESCE(${column_sql}, ''), '[0-9]+$', '') ${dir}, CASE WHEN substring(COALESCE(${column_sql}, '') from '([0-9]+)$') ~ '^[0-9]+$' THEN substring(COALESCE(${column_sql}, '') from '([0-9]+)$')::numeric END ${dir} NULLS LAST, ${column_sql} ${dir} NULLS LAST`;
}

/**
 * `fecha` no es la fecha de alta. Si viene vacía, el orden usa `created_at`.
 */
export function pedido_fecha_order_sql(
	fecha_sql: string,
	created_sql: string,
	dir: 'ASC' | 'DESC',
): string {
	return ` ORDER BY COALESCE(NULLIF(btrim(${fecha_sql}), ''), ${created_sql}) ${dir} NULLS LAST`;
}

const PAYLOAD_OBJECT = `CASE WHEN jsonb_typeof(payload) = 'object' THEN payload WHEN jsonb_typeof(payload) = 'string' THEN COALESCE((payload #>> '{}')::jsonb, '{}'::jsonb) ELSE '{}'::jsonb END`;

export function pedido_search_predicates(
	like_param: string,
	opts: { contacto_table?: string | null; contacto_columns?: readonly string[] } = {},
): string[] {
	const articulos = `CASE WHEN jsonb_typeof((${PAYLOAD_OBJECT}) -> 'articulos') = 'array' THEN (${PAYLOAD_OBJECT}) -> 'articulos' ELSE '[]'::jsonb END`;
	const parts = [
		`COALESCE((${PAYLOAD_OBJECT}) ->> 'observaciones', '') ILIKE ${like_param}`,
		`EXISTS (SELECT 1 FROM jsonb_array_elements(${articulos}) AS linea WHERE COALESCE(linea ->> 'observaciones', '') ILIKE ${like_param})`,
	];
	const columns = (opts.contacto_columns ?? []).filter((column) =>
		/^[a-z_][a-z0-9_]*$/i.test(column),
	);
	if (opts.contacto_table && columns.length) {
		const match = columns.map((column) => `c.id = "${column.replace(/"/g, '""')}"`).join(' OR ');
		parts.push(
			`EXISTS (SELECT 1 FROM ${opts.contacto_table} c WHERE (${match}) AND COALESCE(c.name, '') ILIKE ${like_param})`,
		);
	}
	return parts;
}
