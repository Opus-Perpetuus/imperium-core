/**
 * Rutas de entrega: `vehicle` + `vehicle_name` como `delivery-route.service.ts`.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

export function is_delivery_route_resource(resource: string): boolean {
	return resource === 'delivery-route';
}

async function vehicle_names(
	store: ImperiumStore,
	ids: string[],
): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	if (!ids.length || !store.has('vehicle')) return names;
	const { rows } = await store.find_many('vehicle', {
		ids,
		take: ids.length,
		populate: false,
		include_inactive: true,
	});
	for (const row of rows) {
		const id = String(row._id ?? '');
		if (id) names.set(id, text(row.name));
	}
	return names;
}

export async function decorate_delivery_routes(
	store: ImperiumStore,
	rows: ImperiumDoc[],
	mode: 'list' | 'detail',
): Promise<ImperiumDoc[]> {
	const missing = new Set<string>();
	for (const row of rows) {
		if (text(row.vehicle_name)) continue;
		const id = ref_id(row.vehicle);
		if (id) missing.add(id);
	}
	const names = await vehicle_names(store, [...missing]);
	const decorated = rows.map((row) => {
		const vehicle = ref_id(row.vehicle) || null;
		const vehicle_name =
			text(row.vehicle_name) || (vehicle ? names.get(vehicle) ?? '' : '');
		return { ...row, vehicle, vehicle_name };
	});
	if (mode !== 'detail' || !store.has('contacto')) return decorated;
	return Promise.all(decorated.map((row) => hydrate_route_contacts(store, row)));
}

async function hydrate_route_contacts(
	store: ImperiumStore,
	row: ImperiumDoc,
): Promise<ImperiumDoc> {
	const ids = as_array(row.contacts)
		.map((item) => ref_id(item))
		.filter(Boolean);
	if (!ids.length) return row;
	const contacts: ImperiumDoc[] = [];
	for (const id of ids) {
		const contact = await store.find_id('contacto', id);
		contacts.push(contact ?? { _id: id, name: '' });
	}
	return { ...row, contacts };
}

export async function prepare_delivery_route_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	previous?: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const payload: ImperiumDoc = { ...(previous ?? {}), ...incoming };
	const vehicle_id = ref_id(payload.vehicle);
	let vehicle: string | null = null;
	let vehicle_name = '';
	if (vehicle_id) {
		const record = await store.find_id('vehicle', vehicle_id);
		if (!record || record.is_active === false) {
			throw new Error('No se encontró el vehículo seleccionado');
		}
		vehicle = vehicle_id;
		vehicle_name = text(record.name);
	}
	return { ...payload, vehicle, vehicle_name };
}
