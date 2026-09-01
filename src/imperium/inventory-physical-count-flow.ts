/**
 * Conteo físico: mismo ciclo que inventory-physical-count.service
 * (precarga de quants, recálculo de diferencias, ajuste al aplicar).
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import {
	apply_quant_delta,
	recompute_product_existencia,
} from './delivery-return-flow.ts';
import type { ImperiumStore } from './store.ts';

export const COUNT_DRAFT = 'borrador';
export const COUNT_COUNTED = 'contado';
export const COUNT_APPLIED = 'aplicado';

export function is_physical_count_resource(resource: string) {
	return resource === 'inventory-physical-count';
}

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function round_qty(value: unknown): number {
	const n = Number(value ?? 0);
	return Number((Number.isFinite(n) ? n : 0).toFixed(4));
}

function allows_storage(loc: ImperiumDoc | null): boolean {
	if (!loc) return false;
	return Boolean(loc.permite_almacenaje) && loc.permite_almacenaje !== 'false';
}

function is_object_id(value: string): boolean {
	return /^[a-fA-F0-9]{24}$/.test(value);
}

function count_line(params: {
	producto: string;
	producto_nombre: string;
	producto_codigo: string;
	cantidad_sistema: number;
	cantidad_contada: number;
}): ImperiumDoc {
	const cantidad_sistema = round_qty(params.cantidad_sistema);
	const cantidad_contada = round_qty(params.cantidad_contada);
	return {
		producto: params.producto,
		producto_nombre: params.producto_nombre,
		producto_codigo: params.producto_codigo,
		cantidad_sistema,
		cantidad_contada,
		diferencia: round_qty(cantidad_contada - cantidad_sistema),
	};
}

export function decorate_physical_count(doc: ImperiumDoc): ImperiumDoc {
	const lineas = as_array(doc.lineas);
	return { ...doc, total_lineas: lineas.length };
}

async function find_product(store: ImperiumStore, raw: unknown): Promise<ImperiumDoc | null> {
	if (!store.has('products')) return null;
	const row = as_object(raw);
	const pid = ref_id(row.producto ?? raw);
	if (pid && is_object_id(pid)) {
		const by_id = await store.find_id('products', pid);
		if (by_id) return by_id;
	}
	const codigo = text(row.producto_codigo ?? row.codigo);
	if (codigo) {
		const exact = await store.find_where('products', { codigo });
		if (exact) return exact;
		const { rows } = await store.find_many('products', {
			take: 4000,
			include_inactive: true,
			populate: false,
		});
		const wanted = codigo.toUpperCase();
		return rows.find((item) => text(item.codigo).toUpperCase() === wanted) ?? null;
	}
	return null;
}

async function quants_at_location(store: ImperiumStore, ubicacion_id: string) {
	if (!store.has('inventory-stock-quant')) return [];
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan('inventory-stock-quant', {
		where: { ubicacion: ubicacion_id },
		include_inactive: true,
	})) {
		for (const row of page) {
			if (ref_id(row.ubicacion ?? row.ubicacion_id) === ubicacion_id) out.push(row);
		}
	}
	return out;
}

async function merge_extra_lines(
	store: ImperiumStore,
	lineas: Map<string, ImperiumDoc>,
	extra_lines: unknown[],
) {
	for (const raw of extra_lines) {
		const product = await find_product(store, raw);
		if (!product) continue;
		const id = String(product._id);
		const incoming = as_object(raw);
		if (lineas.has(id)) {
			if (incoming.cantidad_contada === undefined) continue;
			const existing = lineas.get(id)!;
			const counted = round_qty(incoming.cantidad_contada);
			lineas.set(
				id,
				count_line({
					producto: id,
					producto_nombre: String(existing.producto_nombre ?? product.name ?? ''),
					producto_codigo: String(existing.producto_codigo ?? product.codigo ?? ''),
					cantidad_sistema: Number(existing.cantidad_sistema ?? 0),
					cantidad_contada: counted,
				}),
			);
			continue;
		}
		const sistema = 0;
		lineas.set(
			id,
			count_line({
				producto: id,
				producto_nombre: text(product.name),
				producto_codigo: text(product.codigo),
				cantidad_sistema: sistema,
				cantidad_contada: incoming.cantidad_contada ?? sistema,
			}),
		);
	}
}

export async function prepare_physical_count_create(
	store: ImperiumStore,
	incoming: ImperiumDoc,
): Promise<ImperiumDoc> {
	const ubicacion_id = ref_id(incoming.ubicacion);
	if (!ubicacion_id || !is_object_id(ubicacion_id)) {
		throw new Error('Debes seleccionar una ubicación válida');
	}
	const ubicacion = store.has('inventory-internal-location')
		? await store.find_id('inventory-internal-location', ubicacion_id)
		: null;
	if (!ubicacion) throw new Error('No se encontró la ubicación indicada');
	if (!allows_storage(ubicacion)) {
		throw new Error('El conteo solo aplica a ubicaciones que permiten almacenaje (hojas)');
	}
	const lineas = new Map<string, ImperiumDoc>();
	for (const quant of await quants_at_location(store, ubicacion_id)) {
		const pid = ref_id(quant.producto ?? quant.producto_id);
		if (!pid) continue;
		const sistema = round_qty(quant.cantidad);
		lineas.set(
			pid,
			count_line({
				producto: pid,
				producto_nombre: text(quant.producto_nombre) || text(quant.name),
				producto_codigo: text(quant.producto_codigo),
				cantidad_sistema: sistema,
				cantidad_contada: sistema,
			}),
		);
	}
	await merge_extra_lines(store, lineas, as_array(incoming.lineas));
	const codigo = text(ubicacion.codigo).toUpperCase();
	return {
		...incoming,
		name: text(incoming.name) || `Conteo ${codigo || ubicacion.name || 'ubicación'}`,
		description: text(incoming.description),
		ubicacion: ubicacion_id,
		ubicacion_codigo: codigo,
		estado: COUNT_DRAFT,
		lineas: [...lineas.values()],
		contado_por: text(incoming.contado_por),
		fecha: incoming.fecha ?? new Date().toISOString(),
	};
}

export async function prepare_physical_count_update(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	previous?: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró el conteo indicado');
	if (text(previous.estado) === COUNT_APPLIED) {
		throw new Error('Un conteo aplicado no se puede modificar');
	}
	const lineas = new Map<string, ImperiumDoc>();
	for (const raw of as_array(previous.lineas)) {
		const line = as_object(raw);
		const pid = ref_id(line.producto);
		if (!pid) continue;
		lineas.set(
			pid,
			count_line({
				producto: pid,
				producto_nombre: text(line.producto_nombre),
				producto_codigo: text(line.producto_codigo),
				cantidad_sistema: Number(line.cantidad_sistema ?? 0),
				cantidad_contada: Number(line.cantidad_contada ?? 0),
			}),
		);
	}
	const incoming_lines = as_array(incoming.lineas);
	const nuevos: unknown[] = [];
	for (const raw of incoming_lines) {
		const line = as_object(raw);
		const pid = ref_id(line.producto);
		if (pid && lineas.has(pid)) {
			const existing = lineas.get(pid)!;
			lineas.set(
				pid,
				count_line({
					producto: pid,
					producto_nombre: text(existing.producto_nombre),
					producto_codigo: text(existing.producto_codigo),
					cantidad_sistema: Number(existing.cantidad_sistema ?? 0),
					cantidad_contada: line.cantidad_contada ?? existing.cantidad_contada,
				}),
			);
			continue;
		}
		if (pid || text(line.producto_codigo ?? line.codigo)) nuevos.push(raw);
	}
	await merge_extra_lines(store, lineas, nuevos);
	return {
		...incoming,
		ubicacion: previous.ubicacion,
		ubicacion_codigo: previous.ubicacion_codigo,
		lineas: [...lineas.values()],
		estado: COUNT_COUNTED,
		contado_por: text(incoming.contado_por) || previous.contado_por,
		fecha: previous.fecha,
		name: text(incoming.name) || previous.name,
	};
}

export async function apply_physical_count(
	store: ImperiumStore,
	id?: string,
): Promise<ImperiumDoc> {
	const count_id = text(id);
	if (!count_id || !is_object_id(count_id)) {
		throw new Error('Debes indicar un conteo válido');
	}
	const count = await store.find_id('inventory-physical-count', count_id);
	if (!count) throw new Error('No se encontró el conteo indicado');
	if (text(count.estado) === COUNT_APPLIED) {
		throw new Error('Este conteo ya fue aplicado');
	}
	const ubicacion = ref_id(count.ubicacion);
	const ubicacion_codigo = text(count.ubicacion_codigo);
	const fecha = new Date().toISOString();
	const running = new Map<string, number>();
	for (const raw of as_array(count.lineas)) {
		const line = as_object(raw);
		const producto = ref_id(line.producto);
		if (!producto) continue;
		const diferencia = round_qty(
			Number(line.cantidad_contada ?? 0) - Number(line.cantidad_sistema ?? 0),
		);
		if (!diferencia) continue;
		const prod = await store.find_id('products', producto);
		if (!prod) continue;
		const previo =
			running.get(producto) ??
			round_qty(prod.existencia);
		const resultante = round_qty(previo + diferencia);
		running.set(producto, resultante);
		if (ubicacion) {
			await apply_quant_delta(store, {
				producto,
				producto_nombre: text(prod.name),
				producto_codigo: text(prod.codigo),
				ubicacion,
				ubicacion_codigo,
				delta: diferencia,
			});
		}
		await recompute_product_existencia(store, producto);
		if (store.has('inventory-movement')) {
			const apartado = round_qty(prod.existenciaApartada);
			await store.insert('inventory-movement', {
				name: `Ajuste ${count.name ?? producto}`,
				description: 'Ajuste manual de inventario por conteo físico',
				tipo: 'ajuste_manual',
				tipo_movimiento: 'ajuste_manual',
				producto,
				producto_id: producto,
				producto_nombre: text(prod.name),
				producto_codigo: text(prod.codigo),
				cantidad: Math.abs(diferencia),
				ubicacion_origen: diferencia < 0 ? ubicacion : undefined,
				ubicacion_origen_nombre: diferencia < 0 ? ubicacion_codigo : '',
				ubicacion_destino: diferencia > 0 ? ubicacion : undefined,
				ubicacion_destino_nombre: diferencia > 0 ? ubicacion_codigo : '',
				documento_tipo: 'inventory-physical-count',
				documento_id: count_id,
				documento_modelo: 'InventoryPhysicalCount',
				documento_nombre: count.name,
				documento_referencia: ubicacion_codigo,
				stock_total_previo: previo,
				stock_total_resultante: resultante,
				stock_apartado_previo: apartado,
				stock_apartado_resultante: apartado,
				fecha_movimiento: fecha,
			});
		}
	}
	const saved = await store.update('inventory-physical-count', count_id, {
		estado: COUNT_APPLIED,
		fecha_aplicacion: fecha,
	});
	if (!saved) throw new Error('No se encontró el conteo indicado');
	return saved;
}

/** `__get_statistics` original: `by_state` como `{ state, count }`. */
export async function physical_count_by_state(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<Array<{ state: string | null; count: number }>> {
	const counts = new Map<string | null, number>();
	for await (const page of store.scan('inventory-physical-count', {
		include_inactive: true,
		mongo_match,
	})) {
		for (const row of page) {
			const raw = text(row.estado ?? row.state);
			const key = raw || null;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')))
		.map(([state, count]) => ({ state, count }));
}
