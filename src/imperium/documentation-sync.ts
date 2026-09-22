/**
 * Reconciliación de la sincronización de páginas de documentación.
 *
 * `store.remove` es borrado lógico (`is_active: false`), así que la fila sigue
 * en la tabla. El único compuesto de `documentation-page`
 * (`UNIQUE_COMPOSITES`, `['slug', 'folder_path']`) no es parcial: también ve
 * las filas inactivas. Por eso un sync que borraba todo y reinsertaba chocaba
 * con `uq_documentation_page_slug_folder_path` a partir de la segunda corrida.
 *
 * Reutilizar la fila existente evita el choque y, además, no deja filas
 * inactivas acumulándose en cada sincronización.
 */
import type { ImperiumDoc } from './envelope.ts';

/** Clave del único compuesto, normalizada como la calcula Postgres. */
export function documentation_page_key(doc: Record<string, unknown>): string {
	const slug = String(doc.slug ?? '');
	const folder_path = String(doc.folder_path ?? '');
	return `${slug}\u0000${folder_path}`;
}

export type DocumentationSyncPlan = {
	/** Fila existente que se reaprovecha para un documento entrante. */
	update: { id: string; doc: Record<string, unknown> }[];
	/** Documento entrante sin fila previa. */
	insert: Record<string, unknown>[];
	/** Fila existente que ya no viene en el lote: se desactiva. */
	deactivate: string[];
};

/**
 * Empareja lo que ya hay con lo que llega por `(slug, folder_path)`.
 * Las filas existentes se buscan incluyendo las inactivas: son justo las que
 * ocupan la clave única y hay que reactivar en vez de insertar de nuevo.
 */
export function plan_documentation_sync(
	existing: ImperiumDoc[],
	incoming: Record<string, unknown>[],
): DocumentationSyncPlan {
	const by_key = new Map<string, string>();
	for (const row of existing) {
		const key = documentation_page_key(row as Record<string, unknown>);
		// Ante duplicados previos (los que dejó el bug) gana el primero; el
		// resto se desactiva por no quedar emparejado.
		if (!by_key.has(key)) by_key.set(key, String(row._id));
	}

	const plan: DocumentationSyncPlan = { update: [], insert: [], deactivate: [] };
	const used = new Set<string>();

	for (const doc of incoming) {
		const key = documentation_page_key(doc);
		const id = by_key.get(key);
		if (id !== undefined && !used.has(id)) {
			used.add(id);
			plan.update.push({ id, doc });
			continue;
		}
		plan.insert.push(doc);
	}

	for (const row of existing) {
		const id = String(row._id);
		if (!used.has(id)) plan.deactivate.push(id);
	}

	return plan;
}
