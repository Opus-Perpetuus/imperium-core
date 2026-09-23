/**
 * El esquema que el plano de datos tiene cacheado ya no es el real.
 *
 * Son dos errores distintos por la misma causa — alguien movió las columnas
 * mientras el núcleo estaba caliente:
 *
 * - `0A000` «cached plan must not change result type»: había un `SELECT *` y
 *   apareció una columna. Postgres invalida el plan preparado, y como Bun guarda
 *   el statement por **texto** de la consulta, reintentar el mismo texto reusa el
 *   statement muerto y falla igual hasta reiniciar (medido).
 * - `42703` «column … does not exist»: la lista de columnas en caché nombra una
 *   que ya se borró.
 * - «bind message has N result formats but query has M columns»: el statement
 *   guardado se preparó con N columnas y la consulta ya devuelve M. Es el mismo
 *   statement muerto, visto desde el protocolo en vez de desde el planner, y
 *   sin SQLSTATE propio. Se ve al aplicar el esquema de una app con el núcleo
 *   caliente — que es justo lo que hace actualizar una app.
 *
 * En ambos la salida es la misma: olvidar las columnas, releerlas y reintentar.
 * No se puede prevenir vaciando la caché al aplicar el DDL: el DDL puede venir de
 * otra réplica del núcleo o de una migración a mano, y esas conexiones no son
 * nuestras.
 */
export function is_stale_schema_cache(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;
	const e = err as { code?: unknown; errno?: unknown; message?: unknown };
	const sqlstate = String(e.errno ?? '') || String(e.code ?? '');
	const message = String(e.message ?? '');
	if (sqlstate === '42703') return true;
	if (sqlstate === '0A000' && /cached plan/i.test(message)) return true;
	if (/cached plan must not change result type/i.test(message)) return true;
	if (/bind message has \d+ result formats but query has \d+ columns/i.test(message))
		return true;
	return /column .* does not exist/i.test(message);
}
