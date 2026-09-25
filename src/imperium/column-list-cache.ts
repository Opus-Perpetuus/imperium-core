/**
 * Listas de columnas por tabla (`<schema>.<tabla>`) que usa el plano de datos
 * en lugar de `SELECT *`.
 *
 * Una lista vieja no falla: sigue siendo una consulta válida, solo que sin las
 * columnas que se añadieron después. Una app que subía de esquema escribía en
 * ellas y al leer recibía la fila sin esos campos hasta reiniciar el núcleo.
 * Por eso cada lista caduca, y quien aplica un DDL la olvida al momento.
 */
export class ColumnListCache {
	private readonly entries = new Map<string, { cols: string[]; at: number }>();

	constructor(
		private readonly ttl_ms: number,
		private readonly now: () => number = Date.now,
	) {}

	get(key: string): string[] | null {
		const hit = this.entries.get(key);
		if (!hit || this.now() - hit.at >= this.ttl_ms) return null;
		return hit.cols;
	}

	set(key: string, cols: string[]): void {
		this.entries.set(key, { cols, at: this.now() });
	}

	/** Olvida todas las tablas de un schema (el DDL de una app las toca juntas). */
	forget_schema(schema: string): void {
		for (const key of [...this.entries.keys()]) {
			if (key.startsWith(`${schema}.`)) this.entries.delete(key);
		}
	}
}
