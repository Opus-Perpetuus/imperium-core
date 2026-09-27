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
