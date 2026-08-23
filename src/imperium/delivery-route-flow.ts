/**
 * Rutas de entrega: `vehicle` + `vehicle_name` como `delivery-route.service.ts`.
 * El listado original solo proyecta nombre, descripción, vehículo y activo.
 */
import { type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const LIST_KEYS = ['_id', 'name', 'description', 'vehicle_name', 'is_active'] as const;

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

export function delivery_route_list_instance_type(): Record<
	string,
	{ nombre_encabezado: string; tipo: string }
> {
	const out: Record<string, { nombre_encabezado: string; tipo: string }> = {};
	for (const key of LIST_KEYS) {
		out[key] = { nombre_encabezado: key.replace(/_/g, ' '), tipo: 'string' };
	}
	return out;
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
	return rows.map((row) => {
		const vehicle = ref_id(row.vehicle) || null;
		const vehicle_name =
			text(row.vehicle_name) || (vehicle ? names.get(vehicle) ?? '' : '');
		if (mode === 'list') {
			return {
				_id: row._id,
				name: row.name,
				description: row.description,
				vehicle_name,
				is_active: row.is_active,
			};
		}
		return { ...row, vehicle, vehicle_name };
	});
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
