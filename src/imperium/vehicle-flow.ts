/**
 * Vehículos: misma normalización que el service original
 * (nombre, placas, chofer + chofer_nombre, tipos y estado).
 */
import { type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const VEHICLE_TYPES = new Set(['pickup', 'van', 'camion', 'motocicleta', 'otro']);
const VEHICLE_STATES = new Set(['disponible', 'asignado', 'mantenimiento', 'inactivo']);

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function normalize_number(value: unknown, field_name: string): number {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n)) throw new Error(`El campo ${field_name} debe ser numérico`);
	return n;
}

function build_name(payload: ImperiumDoc): string {
	const provided = text(payload.name);
	if (provided) return provided;
	const placas = text(payload.placas).toUpperCase();
	const marca = text(payload.marca);
	const modelo = text(payload.modelo);
	return [placas, marca, modelo].filter(Boolean).join(' - ') || 'Vehículo';
}

export function decorate_vehicle(doc: ImperiumDoc): ImperiumDoc {
	const chofer = doc.chofer;
	if (chofer && typeof chofer === 'object') {
		const id = ref_id(chofer);
		const name = text((chofer as { name?: unknown }).name) || text(doc.chofer_nombre);
		if (!id) {
			return { ...doc, chofer: null, chofer_nombre: name };
		}
		return {
			...doc,
			chofer: { ...(chofer as object), _id: id, name },
			chofer_nombre: text(doc.chofer_nombre) || name,
		};
	}
	const id = ref_id(chofer);
	if (!id) {
		return { ...doc, chofer: null, chofer_nombre: text(doc.chofer_nombre) };
	}
	return {
		...doc,
		chofer: { _id: id, name: text(doc.chofer_nombre) },
		chofer_nombre: text(doc.chofer_nombre),
	};
}

export async function prepare_vehicle_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	previous?: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const payload: ImperiumDoc = { ...(previous ?? {}), ...incoming };
	const chofer_id = ref_id(payload.chofer);
	let chofer: string | undefined;
	let chofer_nombre = '';
	if (chofer_id) {
		const employee = await store.find_id('employee', chofer_id);
		if (!employee || employee.is_active === false) {
			throw new Error('No se encontró el chofer seleccionado');
		}
		chofer = chofer_id;
		chofer_nombre = text(employee.name);
	}

	const tipo_unidad = VEHICLE_TYPES.has(text(payload.tipo_unidad))
		? text(payload.tipo_unidad)
		: 'otro';
	const estado_operativo = VEHICLE_STATES.has(text(payload.estado_operativo))
		? text(payload.estado_operativo)
		: 'disponible';
	const placas = text(payload.placas).toUpperCase();
	if (!placas) throw new Error('Debes definir las placas');
	const { rows } = await store.find_many('vehicle', {
		where: { placas },
		take: 5,
		include_inactive: true,
		populate: false,
	});
	const id = text(payload._id ?? incoming._id);
	if (rows.some((row) => text(row._id) && text(row._id) !== id)) {
		throw new Error('Ya existe un vehículo con esas placas');
	}

	return {
		...payload,
		name: build_name(payload),
		description: text(payload.description),
		foto: text(payload.foto),
		placas,
		numero_economico: text(payload.numero_economico),
		marca: text(payload.marca),
		modelo: text(payload.modelo),
		color: text(payload.color),
		anio: payload.anio ? normalize_number(payload.anio, 'anio') : undefined,
		capacidad_carga_kg: normalize_number(payload.capacidad_carga_kg, 'capacidad_carga_kg'),
		tipo_unidad,
		estado_operativo,
		chofer: chofer ?? null,
		chofer_nombre,
	};
}

export async function vehicle_by_status(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<Array<{ _id: string; count: number }>> {
	const { rows } = await store.find_many('vehicle', {
		take: 5000,
		include_inactive: true,
		populate: false,
		mongo_match,
	});
	const counts = new Map<string, number>();
	for (const row of rows) {
		const key = text(row.estado_operativo) || 'disponible';
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].map(([_id, count]) => ({ _id, count }));
}
