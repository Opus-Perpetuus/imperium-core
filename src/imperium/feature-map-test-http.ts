/**
 * `GET  /api/feature-map-test`        → filas marcadas por tabla (resumen).
 * `POST /api/feature-map-test/purge`  → borra en masa lo marcado (`feature_map_test = true`).
 *
 * Solo el superadministrador semilla. Lo usan `yarn flow` al terminar una
 * corrida y `imperium feature-map-test` (CLI).
 */
import { pg_schema_name } from '@opus-perpetuus/imperium-core-kit';
import { current_user } from './auth.ts';
import { feature_map_test_summary, purge_feature_map_test } from './feature-map-test.ts';
import { is_seed_admin } from './group-access.ts';
import { SearchEngine } from './search-engine.ts';
import type { ImperiumStore } from './store.ts';
import type { ImperiumDoc } from './envelope.ts';

export function is_feature_map_test_path(path: string): boolean {
	return path === '/feature-map-test' || path.startsWith('/feature-map-test/');
}

/** `schema.tabla` → colección del buscador del recurso del núcleo (si la hay). */
export function search_collections_by_table(store: Pick<ImperiumStore, 'all_locs'>): Map<string, string> {
	const out = new Map<string, string>();
	for (const loc of store.all_locs) {
		out.set(`${pg_schema_name(loc.technical_id)}.${loc.table}`, loc.collection);
	}
	return out;
}

/** Tablas de cuentas de usuario (solo se purgan las de correo de prueba). */
export function account_tables(store: Pick<ImperiumStore, 'all_locs'>): string[] {
	return store.all_locs
		.filter((loc) => loc.resource === 'user')
		.map((loc) => `${pg_schema_name(loc.technical_id)}.${loc.table}`);
}

export async function handle_feature_map_test(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	path: string,
	deps: { actor?: (req: Request) => Promise<ImperiumDoc | null> } = {},
): Promise<Response> {
	const actor = await (deps.actor ?? ((r: Request) => current_user(sql, r).catch(() => null)))(req);
	if (!actor) {
		return Response.json({ ok: false, error: 'unauthorized', message: 'No has iniciado sesión' }, { status: 401 });
	}
	if (!is_seed_admin(actor)) {
		return Response.json(
			{ ok: false, error: 'access_denied', message: 'Solo el superadministrador puede ver o borrar los datos de prueba.' },
			{ status: 403 },
		);
	}
	const rest = path.slice('/feature-map-test'.length).replace(/^\/+|\/+$/g, '');
	if (req.method === 'GET' && rest === '') {
		return Response.json({ ok: true, ...(await feature_map_test_summary(sql)) });
	}
	if (req.method === 'POST' && rest === 'purge') {
		const collections = search_collections_by_table(store);
		const result = await purge_feature_map_test(sql, {
			account_tables: account_tables(store),
			on_deleted: async (table, ids) => {
				const collection = collections.get(table);
				if (collection) await SearchEngine.delete_documents(collection, ids);
			},
		});
		return Response.json({ ok: result.blocked.length === 0, ...result });
	}
	return Response.json({ ok: false, error: 'not_found', message: 'Ruta no encontrada' }, { status: 404 });
}
