/**
 * Ubicaciones internas: misma composición que el service original
 * (`codigo` = cadena de segmentos, `parent` como id, `nivel`, bloqueos).
 */
import { type ImperiumDoc } from './envelope.ts';
import { sanitize_location_segment } from './location-path.ts';
import type { ImperiumStore } from './store.ts';

const LOCATION_TYPES = new Set(['almacen', 'logistica', 'transito', 'cliente', 'ajuste']);

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

export function is_location_resource(resource: string) {
	return resource === 'inventory-internal-location';
}

function normalize_type(value: unknown): string {
	const normalized = text(value).toLowerCase();
	if (LOCATION_TYPES.has(normalized)) return normalized;
	return 'almacen';
}

function allows_storage(value: unknown): boolean {
	return Boolean(value) && value !== 'false' && value !== 0 && value !== '0';
}

export async function compose_location_code(
	store: ImperiumStore,
	parent_id: string,
	segmento: string,
): Promise<{ codigo: string; nivel: number; parent: string | null; parent_codigo: string }> {
	const segment = sanitize_location_segment(segmento);
	if (!segment) {
		throw new Error('Debes definir el segmento de código de este nivel');
	}
	if (!parent_id) {
		return { codigo: segment, nivel: 0, parent: null, parent_codigo: '' };
	}
	const parent = await store.find_id('inventory-internal-location', parent_id);
	if (!parent) {
		throw new Error('No se encontró la ubicación padre indicada');
	}
	const parent_codigo = text(parent.codigo);
	return {
		codigo: `${parent_codigo}${segment}`,
		nivel: Number(parent.nivel ?? 0) + 1,
		parent: parent_id,
		parent_codigo,
	};
}

export async function prepare_location_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	previous?: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const payload: ImperiumDoc = previous
		? { ...previous, ...incoming, is_system: previous.is_system }
		: { ...incoming };
	if (previous?.is_system && incoming.is_system === false) {
		throw new Error('No puedes convertir en manual una ubicación del sistema');
	}
	const parent_id = incoming.parent !== undefined || !previous
		? ref_id(payload.parent)
		: ref_id(previous.parent);
	const segmento = sanitize_location_segment(
		incoming.segmento_codigo !== undefined || !previous
			? payload.segmento_codigo
			: previous.segmento_codigo,
	);
	if (previous) {
		const segment_changed =
			segmento !== sanitize_location_segment(previous.segmento_codigo);
		const parent_changed = parent_id !== ref_id(previous.parent);
		if (segment_changed || parent_changed) {
			const { rows } = await store.find_many('inventory-internal-location', {
				where: { parent: String(previous._id) },
				take: 1,
				include_inactive: true,
				populate: false,
			});
			if (rows.length) {
				throw new Error(
					'No puedes cambiar el segmento o el padre de una ubicación que ya tiene sububicaciones',
				);
			}
		}
	}
	const composed = await compose_location_code(store, parent_id, segmento);
	return {
		...payload,
		name: text(payload.name) || `Ubicación ${composed.codigo}`,
		description: text(payload.description),
		codigo: composed.codigo,
		tipo: normalize_type(payload.tipo),
		parent: composed.parent,
		parent_codigo: composed.parent_codigo || null,
		segmento_codigo: segmento,
		nivel: composed.nivel,
		nivel_nombre: text(payload.nivel_nombre),
		permite_almacenaje: allows_storage(payload.permite_almacenaje),
		secuencia_surtido: Number(payload.secuencia_surtido) || 0,
		is_system: Boolean(previous?.is_system ?? payload.is_system),
	};
}

/** `__get_statistics` original: `system_records` + `by_type` (`tipo`). */
export async function location_stats_extras(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<{
	system_records: number;
	by_type: Array<{ type: string | null; count: number }>;
}> {
	let system_records = 0;
	const counts = new Map<string | null, number>();
	for await (const page of store.scan('inventory-internal-location', {
		include_inactive: true,
		mongo_match,
	})) {
		for (const row of page) {
			if (row.is_system) system_records += 1;
			const raw = text(row.tipo);
			const key = raw || null;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return {
		system_records,
		by_type: [...counts.entries()]
			.sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')))
			.map(([type, count]) => ({ type, count })),
	};
}
