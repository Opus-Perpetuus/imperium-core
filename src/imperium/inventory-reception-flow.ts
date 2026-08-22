/**
 * Recepciones de almacén: acomodar y reservar como el service original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import {
	apply_quant_delta,
	recompute_product_existencia,
} from './delivery-return-flow.ts';
import { resolve_reception_location } from './purchase-order-flow.ts';
import type { ImperiumStore } from './store.ts';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function pending_of(item: ImperiumDoc): number {
	return round_qty(Number(item.cantidad_esperada ?? 0) - Number(item.cantidad_recibida ?? 0));
}

function reserved_of(item: ImperiumDoc): number {
	return round_qty(
		as_array(item.reservas).reduce((acc, raw) => acc + Number(as_object(raw).cantidad ?? 0), 0),
	);
}

function allows_storage(loc: ImperiumDoc | null): boolean {
	if (!loc) return false;
	return Boolean(loc.permite_almacenaje) && loc.permite_almacenaje !== 'false';
}

async function location_by_codigo(store: ImperiumStore, codigo: string) {
	const wanted = text(codigo).toUpperCase();
	if (!wanted || !store.has('inventory-internal-location')) return null;
	const exact = await store.find_where('inventory-internal-location', { codigo: wanted });
	if (exact) return exact;
	const { rows } = await store.find_many('inventory-internal-location', {
		take: 2000,
		include_inactive: true,
		populate: false,
	});
	return rows.find((row) => text(row.codigo).toUpperCase() === wanted) ?? null;
}

async function quant_disponible(store: ImperiumStore, producto: string, ubicacion: string) {
	if (!store.has('inventory-stock-quant')) return 0;
	const { rows } = await store.find_many('inventory-stock-quant', {
		where: { producto, ubicacion },
		take: 8,
		include_inactive: true,
		populate: false,
	});
	const current = rows[0];
	if (!current) return 0;
	if (current.cantidad_disponible != null) return round_qty(Number(current.cantidad_disponible));
	return round_qty(Number(current.cantidad ?? 0) - Number(current.cantidad_apartada ?? 0));
}

export async function register_internal_transfer(
	store: ImperiumStore,
	params: {
		producto: string;
		ubicacion_origen: string;
		ubicacion_destino: string;
		cantidad: number;
	},
): Promise<void> {
	const cantidad = round_qty(params.cantidad);
	if (!(cantidad > 0)) throw new Error('La cantidad a trasladar debe ser mayor a cero');
	const producto_id = text(params.producto);
	if (!producto_id) throw new Error('Debes indicar un producto válido');
	const origen = await store.find_id('inventory-internal-location', params.ubicacion_origen);
	const destino = await store.find_id('inventory-internal-location', params.ubicacion_destino);
	if (!origen || !destino) throw new Error('La ubicación de origen o destino no existe');
	if (!allows_storage(origen) || !allows_storage(destino)) {
		throw new Error('Origen y destino deben ser ubicaciones que permiten almacenaje');
	}
	if (String(origen._id) === String(destino._id)) {
		throw new Error('El origen y el destino no pueden ser la misma ubicación');
	}
	const product = await store.find_id('products', producto_id);
	if (!product) throw new Error('No se encontró el producto indicado');
	const disponible = await quant_disponible(store, producto_id, String(origen._id));
	if (cantidad > disponible) {
		throw new Error(
			`No hay existencia disponible suficiente en ${text(origen.codigo)} (disponible ${disponible})`,
		);
	}
	const stock_total = round_qty(Number(product.existencia ?? 0));
	const stock_apartado = round_qty(Number(product.existenciaApartada ?? 0));
	if (store.has('inventory-movement')) {
		await store.insert('inventory-movement', {
			name: `Traslado ${text(product.name)}`,
			producto: producto_id,
			producto_id,
			producto_nombre: text(product.name),
			producto_codigo: text(product.codigo),
			tipo_movimiento: 'transferencia_interna',
			ubicacion_origen: String(origen._id),
			ubicacion_origen_id: String(origen._id),
			ubicacion_origen_nombre: text(origen.name),
			ubicacion_destino: String(destino._id),
			ubicacion_destino_id: String(destino._id),
			ubicacion_destino_nombre: text(destino.name),
			documento_tipo: 'traslado',
			description: `Traslado interno ${text(origen.codigo)} → ${text(destino.codigo)}`,
			cantidad,
			stock_total_previo: stock_total,
			stock_total_resultante: stock_total,
			stock_apartado_previo: stock_apartado,
			stock_apartado_resultante: stock_apartado,
			fecha_movimiento: new Date().toISOString(),
		});
	}
	await apply_quant_delta(store, {
		producto: producto_id,
		producto_nombre: text(product.name),
		producto_codigo: text(product.codigo),
		ubicacion: String(origen._id),
		ubicacion_codigo: text(origen.codigo),
		delta: -cantidad,
	});
	await apply_quant_delta(store, {
		producto: producto_id,
		producto_nombre: text(product.name),
		producto_codigo: text(product.codigo),
		ubicacion: String(destino._id),
		ubicacion_codigo: text(destino.codigo),
		delta: cantidad,
	});
	await recompute_product_existencia(store, producto_id);
}

export async function acomodar_reception(
	store: ImperiumStore,
	reception_id: string,
	body: ImperiumDoc,
): Promise<ImperiumDoc> {
	const id = text(reception_id);
	const producto_id = text(body.producto);
	let codigo = text(body.ubicacion_destino_codigo).toUpperCase();
	const cantidad = round_qty(Number(body.cantidad ?? 0));
	if (!producto_id) throw new Error('Se necesita un producto válido');
	if (!(cantidad > 0)) throw new Error('La cantidad a acomodar debe ser mayor que cero');
	if (!codigo) {
		const product = await store.find_id('products', producto_id);
		codigo = text(product?.ubicacion_preferida_codigo).toUpperCase();
	}
	if (!codigo) {
		throw new Error(
			'Escanea o captura el código de la ubicación destino (o define ubicación preferida en el producto)',
		);
	}
	const record = await store.find_id('inventory-reception', id);
	if (!record || record.is_active === false) throw new Error('No se encontró la recepción indicada');
	const articulos = as_array(record.articulos).map(as_object);
	const item = articulos.find((line) => ref_id(line.producto) === producto_id);
	if (!item) throw new Error('El producto no pertenece a esta recepción');
	const por_acomodar = round_qty(
		Number(item.cantidad_recibida ?? 0) - Number(item.cantidad_acomodada ?? 0),
	);
	if (cantidad > por_acomodar) {
		throw new Error(`Solo hay ${por_acomodar} por acomodar de ${item.producto_nombre}`);
	}
	const origen = await resolve_reception_location(store);
	if (!origen) throw new Error('No hay ubicación de recepciones configurada como origen');
	const destino = await location_by_codigo(store, codigo);
	if (!destino) throw new Error(`No existe una ubicación con el código ${codigo}`);
	await register_internal_transfer(store, {
		producto: producto_id,
		ubicacion_origen: origen.id,
		ubicacion_destino: String(destino._id),
		cantidad,
	});
	item.cantidad_acomodada = round_qty(Number(item.cantidad_acomodada ?? 0) + cantidad);
	const updated = await store.update('inventory-reception', id, { articulos });
	if (!updated) throw new Error('No se encontró la recepción indicada');
	return updated;
}

export async function reservar_reception(
	store: ImperiumStore,
	reception_id: string,
	body: ImperiumDoc,
): Promise<ImperiumDoc> {
	const id = text(reception_id);
	const producto_id = text(body.producto);
	const cantidad = round_qty(Number(body.cantidad ?? 0));
	const documento_tipo = text(body.documento_tipo);
	const documento_id = text(body.documento_id);
	const documento_nombre = text(body.documento_nombre);
	if (!producto_id) throw new Error('Se necesita un producto válido');
	if (!(cantidad > 0)) throw new Error('La cantidad a reservar debe ser mayor que cero');
	if (!documento_tipo || !documento_id) {
		throw new Error('Se necesita el documento que reserva la mercancía');
	}
	const record = await store.find_id('inventory-reception', id);
	if (!record || record.is_active === false) throw new Error('No se encontró la recepción indicada');
	const articulos = as_array(record.articulos).map(as_object);
	const item = articulos.find((line) => ref_id(line.producto) === producto_id);
	if (!item) throw new Error('El producto no pertenece a esta recepción');
	const disponible = round_qty(pending_of(item) - reserved_of(item));
	if (cantidad > disponible) {
		throw new Error(`Solo hay ${disponible} en camino disponible de ${item.producto_nombre}`);
	}
	item.reservas = [
		...as_array(item.reservas),
		{ documento_tipo, documento_id, documento_nombre, cantidad },
	];
	const updated = await store.update('inventory-reception', id, { articulos });
	if (!updated) throw new Error('No se encontró la recepción indicada');
	return updated;
}

export async function in_transit_for_product(
	store: ImperiumStore,
	producto_id: string,
): Promise<ImperiumDoc> {
	const id = text(producto_id);
	if (!id) throw new Error('Se necesita el id del producto');
	const { rows } = await store.find_many('inventory-reception', {
		take: 500,
		populate: false,
	});
	let en_camino = 0;
	let recepciones = 0;
	for (const record of rows) {
		if (record.is_active === false) continue;
		if (!['pendiente', 'parcial'].includes(text(record.estado))) continue;
		const item = as_array(record.articulos)
			.map(as_object)
			.find((line) => ref_id(line.producto) === id);
		if (!item) continue;
		recepciones += 1;
		en_camino += Math.max(0, round_qty(pending_of(item) - reserved_of(item)));
	}
	return {
		producto: id,
		en_camino: round_qty(en_camino),
		recepciones,
	};
}

export async function list_pending_for_product(
	store: ImperiumStore,
	producto_id: string,
): Promise<ImperiumDoc[]> {
	const id = text(producto_id);
	if (!id) throw new Error('Se necesita el id del producto');
	const { rows } = await store.find_many('inventory-reception', {
		take: 500,
		populate: false,
	});
	return rows
		.filter((record) => record.is_active !== false)
		.filter((record) => ['pendiente', 'parcial'].includes(text(record.estado)))
		.map((record) => {
			const item = as_array(record.articulos)
				.map(as_object)
				.find((line) => ref_id(line.producto) === id);
			if (!item) return null;
			const disponible = round_qty(pending_of(item) - reserved_of(item));
			if (!(disponible > 0)) return null;
			return {
				_id: record._id,
				name: record.name,
				purchase_order_nombre: record.purchase_order_nombre ?? record.orden_compra_nombre,
				disponible,
			};
		})
		.filter((row): row is ImperiumDoc => Boolean(row));
}
