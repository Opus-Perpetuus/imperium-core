/**
 * Filtros de columnas de lista que no coinciden con lo guardado en la fila.
 *
 * El view-list no configura esto por app: el núcleo reescribe el `where` y
 * arma los valores del menú. Cubre campos derivados (p. ej. `ruta`, que se
 * pinta al leer y se borra al guardar) y relacionales mostrados por nombre
 * (p. ej. Vendedor: `?usuario=IA Vendedor` → ids).
 *
 * `field-values` / el `WHERE` de SQL miran la columna o `payload ->> campo`.
 * En `ruta` esa columna existe pero queda vacía, así que sin este resolver
 * el menú sale vacío y filtrar no recorta la lista (#358).
 */
import { routes_by_contact } from './contacto-rutas.ts';
import { list_instance_type } from './list-projection.ts';
import {
	is_pedido_resource,
	resolve_pedidos_usuario_filter,
} from './pedidos-flow.ts';
import type { ImperiumStore } from './store.ts';

export type DistinctCount = { v: unknown; n: number };

export type ComputedFilterOpts = {
	q?: string;
	mongo_match?: Record<string, unknown> | null;
	where?: Record<string, unknown>;
	include_inactive?: boolean;
};

/** Campos que el núcleo pinta en la lista y no deben filtrarse por la columna/payload crudos. */
export const DECORATED_LIST_FIELDS: ReadonlyArray<{ resources: readonly string[]; field: string }> = [
	{ resources: ['pedidos', 'pedidos-surtir', 'contacto'], field: 'ruta' },
];

const NO_MATCH = '__no_match__';

function applies_to(resource: string, resources: readonly string[]): boolean {
	return resources.includes(resource);
}

export function is_decorated_list_field(resource: string, field: string): boolean {
	return DECORATED_LIST_FIELDS.some((entry) => entry.field === field && applies_to(resource, entry.resources));
}

function filter_values(raw: unknown): string[] {
	if (raw == null || raw === '') return [];
	if (Array.isArray((raw as { in?: unknown[] }).in)) {
		return (raw as { in: unknown[] }).in.map((item) => String(item ?? '').trim()).filter(Boolean);
	}
	const value = String(raw ?? '').trim();
	return value ? [value] : [];
}

function constrain_ids(current: unknown, ids: string[]): unknown {
	if (!ids.length) return NO_MATCH;
	if (current == null || current === '') return { in: [...new Set(ids)] };
	const current_ids = filter_values(current);
	if (current_ids.length === 1 && current_ids[0] === NO_MATCH) return NO_MATCH;
	const wanted = new Set(ids);
	const next = current_ids.filter((id) => wanted.has(id));
	return next.length ? { in: [...new Set(next)] } : NO_MATCH;
}

async function contact_ids_for_ruta_names(store: ImperiumStore, names: string[]): Promise<string[]> {
	const wanted = new Set(names.map((name) => name.trim()).filter(Boolean));
	if (!wanted.size) return [];
	const by_contact = await routes_by_contact(store);
	const ids: string[] = [];
	for (const [contact_id, rutas] of by_contact) {
		if (rutas.some((ruta) => wanted.has(ruta.name))) ids.push(contact_id);
	}
	return ids;
}

async function apply_ruta_filter(
	store: ImperiumStore,
	resource: string,
	where: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (where.ruta == null || where.ruta === '') return where;
	const names = filter_values(where.ruta);
	const ids = names.length ? await contact_ids_for_ruta_names(store, names) : [];
	const next = { ...where };
	delete next.ruta;
	if (is_pedido_resource(resource)) {
		const current = next.contacto_id ?? next.contacto;
		delete next.contacto;
		next.contacto_id = constrain_ids(current, ids);
		return next;
	}
	if (resource === 'contacto') {
		const current = next._id ?? next.id;
		delete next.id;
		next._id = constrain_ids(current, ids);
		return next;
	}
	return where;
}

async function id_counts(
	store: ImperiumStore,
	resource: string,
	fields: readonly string[],
	opts: ComputedFilterOpts,
): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	if (typeof store.distinct_counts !== 'function') return out;
	for (const field of fields) {
		const rows = await store.distinct_counts(resource, field, {
			mongo_match: opts.mongo_match,
			where: opts.where,
			include_inactive: opts.include_inactive,
		});
		for (const row of rows) {
			const id = String(row.v ?? '').trim();
			if (!id) continue;
			out.set(id, (out.get(id) ?? 0) + (Number(row.n ?? 0) || 0));
		}
	}
	return out;
}

async function ruta_distinct_counts(
	store: ImperiumStore,
	resource: string,
	opts: ComputedFilterOpts = {},
): Promise<DistinctCount[]> {
	const by_contact = await routes_by_contact(store);
	const contacts_by_name = new Map<string, Set<string>>();
	for (const [contact_id, rutas] of by_contact) {
		for (const ruta of rutas) {
			const name = ruta.name.trim();
			if (!name) continue;
			const set = contacts_by_name.get(name) ?? new Set<string>();
			set.add(contact_id);
			contacts_by_name.set(name, set);
		}
	}
	const fields = is_pedido_resource(resource)
		? (['contacto_id', 'contacto'] as const)
		: (['_id', 'id'] as const);
	const weights = await id_counts(store, resource, fields, opts);
	const term = String(opts.q ?? '').trim().toLocaleLowerCase();
	const out: DistinctCount[] = [];
	for (const [name, contacts] of contacts_by_name) {
		if (term && !name.toLocaleLowerCase().includes(term)) continue;
		let n = 0;
		for (const contact_id of contacts) n += weights.get(contact_id) ?? 0;
		if (n > 0) out.push({ v: name, n });
	}
	return out.sort((left, right) =>
		String(left.v).localeCompare(String(right.v), 'es', { sensitivity: 'base', numeric: true }),
	);
}

/**
 * Reescritura genérica de filtros de lista: campos derivados + refs por nombre.
 * Hoy el único ref por nombre especial es Vendedor en pedidos (#270); el resto
 * de FKs ya filtran por id cuando el menú manda el id.
 */
export async function resolve_list_filters(
	store: ImperiumStore,
	resource: string,
	where: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (!where || !Object.keys(where).length) return where;
	let next = { ...where };
	if (is_pedido_resource(resource)) {
		next = await resolve_pedidos_usuario_filter(store, next);
	}
	if (is_decorated_list_field(resource, 'ruta') && next.ruta != null) {
		next = await apply_ruta_filter(store, resource, next);
	}
	return next;
}

export async function computed_distinct_counts(
	store: ImperiumStore,
	resource: string,
	field: string,
	opts: ComputedFilterOpts = {},
): Promise<DistinctCount[] | null> {
	if (!is_decorated_list_field(resource, field)) return null;
	if (field === 'ruta') return ruta_distinct_counts(store, resource, opts);
	return null;
}

/**
 * Columnas visibles de la proyección que están decoradas y no tienen resolver.
 * El guard del test falla si esta lista no está vacía.
 */
export function undecorated_filter_gaps(resource?: string): Array<{ resource: string; field: string }> {
	const gaps: Array<{ resource: string; field: string }> = [];
	for (const entry of DECORATED_LIST_FIELDS) {
		for (const item of entry.resources) {
			if (resource && item !== resource) continue;
			if (!is_decorated_list_field(item, entry.field)) {
				gaps.push({ resource: item, field: entry.field });
			}
			const tipo = list_instance_type(item);
			if (tipo && !(entry.field in tipo)) {
				gaps.push({ resource: item, field: entry.field });
			}
		}
	}
	return gaps;
}

/** Recursos/columnas de la proyección que el menú de filtro debe poder abrir. */
export function visible_list_filter_columns(resource: string): string[] {
	const tipo = list_instance_type(resource) ?? {};
	return Object.keys(tipo).filter((key) => key !== '_id' && !key.endsWith('_id'));
}

