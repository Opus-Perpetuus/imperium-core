import { as_array, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export type ContactoRuta = { _id: string; name: string };

const MAX_ROUTES = 5000;

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') {
		const rec = value as { _id?: unknown; $oid?: unknown };
		if (rec._id != null) return ref_id(rec._id);
		if (rec.$oid != null) return String(rec.$oid).trim();
	}
	return String(value).trim();
}

export async function routes_by_contact(
	store: ImperiumStore,
): Promise<Map<string, ContactoRuta[]>> {
	const out = new Map<string, ContactoRuta[]>();
	if (!store.has('delivery-route') || !store.is_resource_installed('delivery-route')) return out;
	const { rows } = await store.find_many('delivery-route', {
		take: MAX_ROUTES,
		populate: false,
		skip_total: true,
		scan_fields: ['name', 'contacts'],
	});
	const routes = rows
		.map((row) => ({ _id: ref_id(row._id), name: String(row.name ?? '').trim(), contacts: row.contacts }))
		.sort((a, b) => a.name.localeCompare(b.name, 'es') || a._id.localeCompare(b._id));
	for (const route of routes) {
		const ruta = { _id: route._id, name: route.name };
		for (const contact_id of new Set(as_array(route.contacts).map(ref_id).filter(Boolean))) {
			const list = out.get(contact_id);
			if (list) list.push(ruta);
			else out.set(contact_id, [ruta]);
		}
	}
	return out;
}

export function ruta_names(rutas: ContactoRuta[] | undefined): string {
	return (rutas ?? []).map((ruta) => ruta.name).filter(Boolean).join(', ');
}

export async function decorate_contacto_rutas(
	store: ImperiumStore,
	rows: ImperiumDoc[],
): Promise<ImperiumDoc[]> {
	const by_contact = rows.length ? await routes_by_contact(store) : new Map<string, ContactoRuta[]>();
	return rows.map((row) => {
		const rutas = by_contact.get(ref_id(row._id)) ?? [];
		return { ...row, rutas: rutas.map((ruta) => ruta._id), ruta: ruta_names(rutas) };
	});
}

export function strip_contacto_rutas(doc: ImperiumDoc): ImperiumDoc {
	const { rutas: _rutas, ruta: _ruta, ...rest } = doc;
	return rest;
}

/**
 * Pedidos con `ruta` (nombres de las rutas de entrega de su cliente), como los
 * ve la lista y el detalle (#275). La ruta no se guarda en el pedido: la hoja
 * impresa (`{{ruta}}`) salía en blanco porque el reporte leía el pedido crudo
 * (#292).
 */
export async function pedidos_con_ruta(store: ImperiumStore, rows: ImperiumDoc[]): Promise<ImperiumDoc[]> {
	if (!rows.length) return rows;
	const by_contact = await routes_by_contact(store);
	return rows.map((row) => {
		const contact_id = ref_id(row.contacto_id) || ref_id(row.contacto);
		return { ...row, ruta: ruta_names(by_contact.get(contact_id)) };
	});
}
