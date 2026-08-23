/**
 * Devoluciones: create/update/recibir como el service original.
 * Recibir en almacén reingresa líneas (`recepcion_devolucion` + quants)
 * y deja el manifiesto en `recibido_almacen`.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const STATE_DRAFT = 'borrador';
const STATE_SIGNED = 'firmado';
const STATE_RECEIVED = 'recibido_almacen';
const DOMAIN_EVENT = 'devolucion-recibida-almacen';
const OBJECT_ID = /^[a-fA-F0-9]{24}$/;

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

export async function prepare_delivery_return_create(doc: ImperiumDoc): Promise<ImperiumDoc> {
	const out = { ...doc };
	delete out._id;
	const folio = text(out.pedido_folio);
	out.name = text(out.name) || `Devolución ${folio}`.trim();
	out.estado = text(out.firma_conformidad_attachment_id) ? STATE_SIGNED : STATE_DRAFT;
	if (!out.fecha) out.fecha = new Date().toISOString();
	return out;
}

export async function prepare_delivery_return_update(
	doc: ImperiumDoc,
	previous: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró la devolución indicada');
	if (text(previous.estado) === STATE_RECEIVED) {
		throw new Error('Una devolución recibida en almacén no se puede modificar');
	}
	return { ...doc };
}

export async function recibir_delivery_return(
	store: ImperiumStore,
	return_id: string,
	ubicacion_id: string,
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const id = text(return_id);
	if (!id || !OBJECT_ID.test(id)) throw new Error('Debes indicar una devolución válida');
	const devolucion = await store.find_id('delivery-return', id);
	if (!devolucion) throw new Error('No se encontró la devolución indicada');
	if (text(devolucion.estado) === STATE_RECEIVED) {
		throw new Error('Esta devolución ya fue recibida en almacén');
	}
	const location_id = text(ubicacion_id);
	if (!location_id || !OBJECT_ID.test(location_id)) {
		throw new Error('Debes indicar la ubicación de recepción');
	}
	const ubicacion = await store.find_id('inventory-internal-location', location_id);
	if (!ubicacion) throw new Error('No se encontró la ubicación indicada');
	if (
		!ubicacion.permite_almacenaje ||
		ubicacion.permite_almacenaje === 'false' ||
		ubicacion.permite_almacenaje === 0
	) {
		throw new Error('La ubicación de recepción debe permitir almacenaje');
	}
	const fecha = new Date();
	await register_return_receipt(store, devolucion, location_id, text(ubicacion.codigo), fecha);
	const updated = await store.update('delivery-return', id, {
		estado: STATE_RECEIVED,
		ubicacion_recepcion: location_id,
		ubicacion_recepcion_codigo: text(ubicacion.codigo),
	});
	if (!updated) throw new Error('No se encontró la devolución indicada');
	try {
		await post_return_received_comments(store, updated, text(ubicacion.codigo), actor);
	} catch {
		/* fail-soft: la recepción de almacén ya quedó persistida */
	}
	return updated;
}

async function register_return_receipt(
	store: ImperiumStore,
	devolucion: ImperiumDoc,
	ubicacion_id: string,
	ubicacion_codigo: string,
	fecha: Date,
) {
	if (!store.has('inventory-movement')) return;
	const lines = as_array(devolucion.lineas)
		.map(as_object)
		.filter((line) => ref_id(line.producto) && Number(line.cantidad ?? 0) > 0);
	const running = new Map<string, number>();
	const affected = new Set<string>();
	for (const line of lines) {
		const product_id = ref_id(line.producto);
		const product = await store.find_id('products', product_id);
		if (!product) continue;
		const cantidad = round_qty(Number(line.cantidad ?? 0));
		const stock_total_previo = round_qty(
			running.get(product_id) ?? Number(product.existencia ?? 0),
		);
		const stock_apartado = round_qty(Number(product.existenciaApartada ?? 0));
		const stock_total_resultante = round_qty(stock_total_previo + cantidad);
		running.set(product_id, stock_total_resultante);
		await store.insert('inventory-movement', {
			name: `Recepción ${text(product.name) || product_id}`,
			producto: product_id,
			producto_id: product_id,
			producto_nombre: text(product.name) || text(line.producto_nombre),
			producto_codigo: text(product.codigo) || text(line.producto_codigo),
			tipo_movimiento: 'recepcion_devolucion',
			ubicacion_destino: ubicacion_id,
			ubicacion_destino_id: ubicacion_id,
			ubicacion_destino_nombre: ubicacion_codigo,
			documento_tipo: 'delivery-return',
			documento_id: String(devolucion._id ?? ''),
			documento_modelo: 'DeliveryReturn',
			documento_nombre: text(devolucion.name),
			documento_referencia: text(devolucion.pedido_folio),
			description: 'Recepción de devolución en almacén',
			cantidad,
			stock_total_previo,
			stock_total_resultante,
			stock_apartado_previo: stock_apartado,
			stock_apartado_resultante: stock_apartado,
			fecha_movimiento: fecha.toISOString(),
		});
		await apply_quant_delta(store, {
			producto: product_id,
			producto_nombre: text(product.name) || text(line.producto_nombre),
			producto_codigo: text(product.codigo) || text(line.producto_codigo),
			ubicacion: ubicacion_id,
			ubicacion_codigo,
			delta: cantidad,
		});
		affected.add(product_id);
	}
	for (const product_id of affected) {
		if (store.has('inventory-stock-quant')) {
			await recompute_product_existencia(store, product_id);
		} else {
			await store.update('products', product_id, {
				existencia: running.get(product_id),
			});
		}
	}
}

export async function find_quant_for_pair(
	store: ImperiumStore,
	producto: string,
	ubicacion: string,
	ubicacion_codigo?: string,
): Promise<ImperiumDoc | null> {
	if (!store.has('inventory-stock-quant') || !producto) return null;
	const codigo = String(ubicacion_codigo ?? '').trim().toUpperCase();
	if (ubicacion) {
		const { rows } = await store.find_many('inventory-stock-quant', {
			where: { producto, ubicacion },
			take: 1,
			include_inactive: true,
			populate: false,
		});
		if (rows[0]) return rows[0];
	}
	if (codigo) {
		const { rows } = await store.find_many('inventory-stock-quant', {
			where: { producto, ubicacion_codigo: codigo },
			take: 1,
			include_inactive: true,
			populate: false,
		});
		if (rows[0]) return rows[0];
	}
	return null;
}

export async function apply_quant_delta(
	store: ImperiumStore,
	params: {
		producto: string;
		producto_nombre: string;
		producto_codigo: string;
		ubicacion: string;
		ubicacion_codigo: string;
		delta: number;
	},
) {
	if (!store.has('inventory-stock-quant')) return;
	const current = await find_quant_for_pair(
		store,
		params.producto,
		params.ubicacion,
		params.ubicacion_codigo,
	);
	const cantidad = round_qty(Number(current?.cantidad ?? 0) + params.delta);
	const apartada = round_qty(Number(current?.cantidad_apartada ?? 0));
	const disponible = round_qty(cantidad - apartada);
	const name = `${params.producto_codigo || params.producto_nombre} @ ${params.ubicacion_codigo}`;
	const patch = {
		name,
		producto: params.producto,
		producto_id: params.producto,
		producto_nombre: params.producto_nombre,
		producto_codigo: params.producto_codigo,
		ubicacion: params.ubicacion,
		ubicacion_id: params.ubicacion,
		ubicacion_codigo: params.ubicacion_codigo,
		cantidad,
		cantidad_apartada: apartada,
		cantidad_disponible: disponible,
		is_active: true,
	};
	if (current?._id) await store.update('inventory-stock-quant', String(current._id), patch);
	else await store.insert('inventory-stock-quant', patch);
}

export async function recompute_product_existencia(store: ImperiumStore, product_id: string) {
	if (!store.has('products')) return;
	let total = 0;
	if (store.has('inventory-stock-quant')) {
		const { rows } = await store.find_many('inventory-stock-quant', {
			where: { producto: product_id },
			take: 5000,
			include_inactive: true,
			populate: false,
		});
		for (const row of rows) total += Number(row.cantidad ?? 0);
	}
	await store.update('products', product_id, { existencia: round_qty(total) });
}

async function post_return_received_comments(
	store: ImperiumStore,
	devolucion: ImperiumDoc,
	ubicacion_codigo: string,
	actor: ImperiumDoc | null,
) {
	if (!store.has('document-change-history')) return;
	const comment_text = build_return_received_comment_text(devolucion, ubicacion_codigo);
	const targets: Array<{ document_id: string; model_name: string }> = [];
	const return_id = text(devolucion._id);
	if (return_id) targets.push({ document_id: return_id, model_name: 'DeliveryReturn' });
	const pedido_id = ref_id(devolucion.pedido);
	if (pedido_id) {
		targets.push({ document_id: pedido_id, model_name: 'Pedidos' });
		const pedido = await store.find_id('pedidos', pedido_id);
		const invoice_id = text(pedido?.invoice_request_id);
		if (invoice_id) targets.push({ document_id: invoice_id, model_name: 'InvoiceRequest' });
	}
	const actor_id = text(actor?._id);
	for (const target of targets) {
		await store.insert('document-change-history', {
			name: 'comentario',
			entryType: 'comment',
			comment: comment_text,
			commentText: comment_text,
			actionName: 'Devolución recibida en almacén',
			actionDescription: comment_text,
			model: target.model_name,
			modelName: target.model_name,
			collectionName: target.model_name,
			documentId: target.document_id,
			record_id: target.document_id,
			operationType: 'domain_event',
			created_by: actor_id,
			actor: actor
				? { _id: actor_id, name: actor.name, email: actor.email }
				: undefined,
		});
	}
}

function build_return_received_comment_text(devolucion: ImperiumDoc, ubicacion_codigo: string) {
	const lineas = as_array(devolucion.lineas).map(as_object);
	const total_unidades = lineas.reduce((acc, line) => acc + Number(line.cantidad ?? 0), 0);
	const detalle = lineas
		.map((line) => {
			const codigo = text(line.producto_codigo);
			const nombre = text(line.producto_nombre);
			const cantidad = Number(line.cantidad ?? 0);
			const estado = text(line.estado_producto);
			const motivo = text(line.motivo);
			const head = [codigo, nombre, `×${cantidad}`, estado ? `(${estado})` : '']
				.filter(Boolean)
				.join(' ');
			return motivo ? `- ${head} — motivo: ${motivo}` : `- ${head}`;
		})
		.join('\n');
	const folio = text(devolucion.pedido_folio);
	const nombre_dev = text(devolucion.name);
	const id_dev = text(devolucion._id);
	return [
		`[${DOMAIN_EVENT}] Devolución de ${lineas.length} línea(s) / ${total_unidades} unidad(es) recibida en almacén.`,
		folio ? `Pedido: ${folio}.` : null,
		`Ubicación de recepción: ${ubicacion_codigo || 'N/D'}.`,
		nombre_dev || id_dev
			? `Documento de devolución: ${nombre_dev || id_dev}${id_dev ? ` (${id_dev})` : ''}.`
			: null,
		detalle ? `Detalle:\n${detalle}` : null,
		'Acción requerida: revisar factura / generar nota de crédito o ajuste si aplica.',
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * El original proyecta `producto_id`/`ubicacion_id` con `$toString` y nombres
 * denormalizados. En SQL esas columnas llegan vacías; el id vive en `producto`.
 */
export async function decorate_inventory_stock_quant_list(
	store: ImperiumStore,
	rows: ImperiumDoc[],
): Promise<ImperiumDoc[]> {
	const product_ids = new Set<string>();
	const location_ids = new Set<string>();
	for (const row of rows) {
		const producto_id = text(row.producto_id) || ref_id(row.producto);
		if (OBJECT_ID.test(producto_id)) product_ids.add(producto_id);
		const ubicacion_id = text(row.ubicacion_id) || ref_id(row.ubicacion);
		if (OBJECT_ID.test(ubicacion_id)) location_ids.add(ubicacion_id);
	}
	const products = new Map<string, ImperiumDoc>();
	if (product_ids.size && store.has('products')) {
		const { rows: found } = await store.find_many('products', {
			ids: [...product_ids],
			take: product_ids.size,
			include_inactive: true,
			populate: false,
		});
		for (const product of found) products.set(String(product._id), product);
	}
	const locations = new Map<string, ImperiumDoc>();
	if (location_ids.size && store.has('inventory-internal-location')) {
		const { rows: found } = await store.find_many('inventory-internal-location', {
			ids: [...location_ids],
			take: location_ids.size,
			include_inactive: true,
			populate: false,
		});
		for (const location of found) locations.set(String(location._id), location);
	}
	return rows.map((row) => {
		const producto_id = text(row.producto_id) || ref_id(row.producto);
		const raw_ubicacion = ref_id(row.ubicacion);
		const ubicacion_id =
			text(row.ubicacion_id) || (OBJECT_ID.test(raw_ubicacion) ? raw_ubicacion : '');
		const product = products.get(producto_id);
		const location = ubicacion_id ? locations.get(ubicacion_id) : undefined;
		const cantidad = Number(row.cantidad ?? 0);
		const cantidad_apartada = Number(row.cantidad_apartada ?? 0);
		const cantidad_disponible =
			row.cantidad_disponible != null && row.cantidad_disponible !== ''
				? Number(row.cantidad_disponible)
				: round_qty(cantidad - cantidad_apartada);
		const ubicacion_codigo =
			text(row.ubicacion_codigo) ||
			text(location?.codigo) ||
			text(location?.name) ||
			(!OBJECT_ID.test(raw_ubicacion) ? raw_ubicacion : '');
		return {
			...row,
			producto_id: producto_id || row.producto_id,
			producto_nombre: text(row.producto_nombre) || text(product?.name) || row.producto_nombre,
			producto_codigo:
				text(row.producto_codigo) || text(product?.codigo) || row.producto_codigo,
			ubicacion_id: ubicacion_id || row.ubicacion_id,
			ubicacion_codigo: ubicacion_codigo || row.ubicacion_codigo,
			cantidad_apartada,
			cantidad_disponible,
		};
	});
}

/** `__get_statistics` original: `by_state` como `{ state, count }`. */
export async function delivery_return_by_state(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<Array<{ state: string | null; count: number }>> {
	const { rows } = await store.find_many('delivery-return', {
		take: 20000,
		include_inactive: true,
		populate: false,
		mongo_match,
	});
	const counts = new Map<string | null, number>();
	for (const row of rows) {
		const raw = text(row.estado ?? row.state);
		const key = raw || null;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')))
		.map(([state, count]) => ({ state, count }));
}
