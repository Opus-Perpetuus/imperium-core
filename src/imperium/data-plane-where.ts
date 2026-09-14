/**
 * Cláusula WHERE del plano de datos de las apps (`POST /subjects/data`).
 * Vive aparte de `server.ts` porque ese módulo arranca `Bun.serve` al
 * importarse y no se puede probar.
 */

/**
 * Identificador de columna admitido por el plano de datos. Estaba copiado en
 * cada `op` y una de las copias escribía `[a-z0-9-]` (guion en vez de guion
 * bajo), así que `update` descartaba en silencio toda columna con `_`:
 * `updated_at` nunca se movía y `config_json` no se podía cambiar.
 */
export function is_column_name(name: string): boolean {
	return /^[a-z_][a-z0-9_]*$/i.test(name);
}

export function qident(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad ident ${name}`);
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Comparaciones del DSL del kit (`data-client.ts`), en el orden en que se
 * prueban. Faltaban las cuatro: un `{ gte: … }` caía en la igualdad de abajo y
 * Postgres recibía el objeto como valor, así que la consulta no fallaba —
 * devolvía otra cosa.
 */
const COMPARISONS = [
	{ key: 'gte', sql: '>=' },
	{ key: 'gt', sql: '>' },
	{ key: 'lte', sql: '<=' },
	{ key: 'lt', sql: '<' },
] as const;

export function where_sql(
	where: Record<string, unknown> | undefined,
	start = 1,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [];
	const clauses: string[] = [];
	if (!where) return { sql: '', params };
	let i = start;
	for (const [k, v] of Object.entries(where)) {
		if (!is_column_name(k)) continue;
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const o = v as Record<string, unknown>;
			if ('in' in o && Array.isArray(o.in)) {
				// Bun.SQL manda un array JS como texto unido por comas, que
				// Postgres no lee como literal de arreglo (`= ANY($1)` truena
				// con "malformed array literal", y `::text[]` tampoco lo salva).
				// Un placeholder por valor deja que Postgres infiera el tipo.
				if (!o.in.length) {
					clauses.push('FALSE');
					continue;
				}
				const marks = o.in.map((value) => {
					params.push(value);
					return `$${i++}`;
				});
				clauses.push(`${qident(k)} IN (${marks.join(', ')})`);
				continue;
			}
			if ('ne' in o) {
				params.push(o.ne);
				clauses.push(`${qident(k)} IS DISTINCT FROM $${i++}`);
				continue;
			}
			if ('isNull' in o) {
				clauses.push(`${qident(k)} IS NULL`);
				continue;
			}
			if ('isNotNull' in o) {
				clauses.push(`${qident(k)} IS NOT NULL`);
				continue;
			}
			// `like` viene del cliente en memoria del kit, que lo compara
			// anclado y sin distinguir mayúsculas (`^patrón$`, `%`→`.*`).
			// ILIKE ya ancla el patrón completo, así que dice lo mismo.
			if ('like' in o) {
				params.push(o.like);
				clauses.push(`${qident(k)} ILIKE $${i++}`);
				continue;
			}
			const cmp = COMPARISONS.find((entry) => entry.key in o);
			if (cmp) {
				params.push((o as Record<string, unknown>)[cmp.key]);
				clauses.push(`${qident(k)} ${cmp.sql} $${i++}`);
				continue;
			}
		}
		// Igualdad. Un objeto que no sea uno de los operadores de arriba llega
		// aquí como valor: es como se compara una columna jsonb.
		params.push(v);
		clauses.push(`${qident(k)} = $${i++}`);
	}
	return {
		sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
		params,
	};
}

/**
 * Filtro de búsqueda por término (ILIKE sobre varias columnas). Vive junto a
 * `where_sql` porque `findMany` lo armaba en línea y `count` no lo armaba en
 * absoluto: el total de una lista buscada salía como si no hubiera búsqueda.
 */
export function search_sql(
	search: { fields?: string[]; q?: string } | undefined,
	has_where: boolean,
	start: number,
): { sql: string; params: unknown[] } {
	const params: unknown[] = [];
	if (!search?.q || !search.fields?.length) return { sql: '', params };
	let i = start;
	const likes = search.fields.filter(is_column_name).map((field) => {
		params.push(`%${search.q}%`);
		return `${qident(field)} ILIKE $${i++}`;
	});
	if (!likes.length) return { sql: '', params: [] };
	return {
		sql: `${has_where ? ' AND' : ' WHERE'} (${likes.join(' OR ')})`,
		params,
	};
}
