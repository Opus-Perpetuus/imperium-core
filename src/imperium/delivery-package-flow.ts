/**
 * Bultos (delivery-package): create/update/cancel como el service original.
 * Folio global `BULTO-######`, snapshots del pedido, anulación pre-cierre
 * y sincronización del estado del pedido (surtido / enviado).
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { sync_order_logistics_reservation } from './inventory-logistics-flow.ts';
import type { ImperiumStore } from './store.ts';
import { format_model_field_value } from './custom-pattern-render.ts';

const PACKAGE_STATES = [
	'pendiente',
	'asignado',
	'cargado',
	'en_ruta',
	'entregado',
	'incidencia',
	'cancelado',
] as const;

const LOGISTICS_STATES = new Set(['cargado', 'en_ruta', 'entregado']);
const CANCELABLE_STATES = new Set(['pendiente', 'incidencia']);

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function number_field(value: unknown, field_name: string): number {
	const n = Number(value ?? 0);
	if (!Number.isFinite(n)) throw new Error(`El campo ${field_name} debe ser numérico`);
	return n;
}

function format_codigo_bulto(sequence: number): string {
	return `BULTO-${String(sequence).padStart(6, '0')}`;
}

function build_address_line(contacto: ImperiumDoc | null): string {
	if (!contacto) return '';
	const calle_numero = [
		text(contacto.calle),
		text(contacto.numeroExterior),
		contacto.numeroInterior ? `Int. ${text(contacto.numeroInterior)}` : '',
	]
		.filter(Boolean)
		.join(' ');
	return [
		calle_numero,
		text(contacto.colonia),
		text(contacto.ciudad),
		text(contacto.estado),
		text(contacto.codigoPostal) ? `C.P. ${text(contacto.codigoPostal)}` : '',
		text(contacto.pais),
	]
		.filter(Boolean)
		.join(', ');
}

function resolve_address_coordinates(
	...sources: Array<Record<string, unknown> | null | undefined>
): { latitude: number; longitude: number } | undefined {
	for (const source of sources) {
		if (!source) continue;
		const latitude = Number(source.latitud ?? source.latitude);
		const longitude = Number(source.longitud ?? source.longitude);
		if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
			return { latitude, longitude };
		}
	}
	return undefined;
}

function ids_from(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(ref_id).filter(Boolean);
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return [];
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map(ref_id).filter(Boolean);
		} catch {
			return trimmed
				.split(',')
				.map((part) => part.trim())
				.filter(Boolean);
		}
	}
	return [];
}

async function resolve_order_snapshot(store: ImperiumStore, pedido_id: string) {
	const pedido = await store.find_id('pedidos', pedido_id);
	if (!pedido || pedido.is_active === false) {
		throw new Error('No se encontró el pedido seleccionado');
	}
	const articulos = as_array(pedido.articulos).map(as_object);
	const product_ids = [
		...new Set(articulos.map((articulo) => ref_id(articulo.product)).filter(Boolean)),
	];
	const product_lookup = new Map<string, { name: string; codigo: string }>();
	for (const product_id of product_ids) {
		const product = await store.find_id('products', product_id);
		if (!product) continue;
		product_lookup.set(product_id, {
			name: text(product.name),
			codigo: text(product.codigo),
		});
	}
	const contacto_id = ref_id(pedido.contacto);
	const contacto = contacto_id ? await store.find_id('contacto', contacto_id) : null;
	const snapshots = articulos.map((articulo, articulo_index) => {
		const product_id = ref_id(articulo.product);
		const populated = as_object(articulo.product);
		const meta = product_lookup.get(product_id);
		return {
			articulo_index,
			product_id,
			product_name: text(populated.name) || meta?.name || 'Producto',
			product_code: text(populated.codigo) || meta?.codigo || '',
			quantity: number_field(articulo.cantidad ?? 0, `articulos[${articulo_index}].cantidad`),
			notes: text(articulo.observaciones),
		};
	});
	return {
		pedido,
		pedido_folio: text(pedido.folio),
		pedido_folio_interno: Number(pedido.folio_interno ?? 0),
		pedido_contacto_id: contacto_id,
		pedido_contacto_nombre: text(contacto?.name),
		pedido_contacto_domicilio: build_address_line(contacto),
		pedido_contacto_url_maps: text(contacto?.urlMaps),
		delivery_address_coordinates: resolve_address_coordinates(
			as_object(pedido.ubicacion),
			as_object(contacto?.ubicacion),
		),
		articulos: snapshots,
	};
}

async function resolve_vehicle_snapshot(store: ImperiumStore, vehicle_id: string) {
	const vehicle = await store.find_id('vehicle', vehicle_id);
	if (!vehicle || vehicle.is_active === false) {
		throw new Error('No se encontró el vehículo seleccionado');
	}
	return { vehicle_id, vehicle_nombre: text(vehicle.name) };
}

function map_route_suggestion(route: ImperiumDoc) {
	return {
		delivery_route_id: String(route._id ?? ''),
		delivery_route_nombre: text(route.name),
		vehicle_id: ref_id(route.vehicle),
		vehicle_nombre: text(route.vehicle_name ?? route.vehicle_nombre),
	};
}

async function resolve_route_snapshot(store: ImperiumStore, delivery_route_id: string) {
	const route = await store.find_id('delivery-route', delivery_route_id);
	if (!route || route.is_active === false) {
		throw new Error('No se encontró la ruta seleccionada');
	}
	const suggestion = map_route_suggestion(route);
	if (suggestion.vehicle_id && !suggestion.vehicle_nombre) {
		const vehicle = await store.find_id('vehicle', suggestion.vehicle_id);
		suggestion.vehicle_nombre = text(vehicle?.name);
	}
	return suggestion;
}

async function resolve_route_from_contact(store: ImperiumStore, contact_id: string) {
	if (!contact_id || !store.has('delivery-route')) return null;
	const contact = await store.find_id('contacto', contact_id);
	const route_ids = ids_from(contact?.rutas);
	if (route_ids.length) {
		const { rows } = await store.find_many('delivery-route', {
			ids: route_ids,
			take: route_ids.length,
			populate: false,
		});
		const route = rows.find((row) => row.is_active !== false);
		if (route) return map_route_suggestion(route);
	}
	const { rows } = await store.find_many('delivery-route', {
		take: 20000,
		include_inactive: false,
		populate: false,
	});
	const route = rows.find((row) => ids_from(row.contacts).includes(contact_id));
	return route ? map_route_suggestion(route) : null;
}

function normalize_content_items(
	content_items: unknown,
	order_articles: Array<{
		articulo_index: number;
		product_id: string;
		product_name: string;
		product_code: string;
		quantity: number;
		notes: string;
	}>,
) {
	const order_lookup_by_index = new Map(order_articles.map((item) => [item.articulo_index, item]));
	const order_lookup_by_product = new Map(order_articles.map((item) => [item.product_id, item]));
	return (Array.isArray(content_items) ? content_items : [])
		.map((raw_item, index) => {
			const item = as_object(raw_item);
			const articulo_index_raw = item.articulo_index;
			const articulo_index = Number.isFinite(Number(articulo_index_raw))
				? Number(articulo_index_raw)
				: null;
			const product_id = text(item.product);
			const order_reference =
				(articulo_index !== null ? order_lookup_by_index.get(articulo_index) : null) ??
				order_lookup_by_product.get(product_id);
			const quantity = number_field(item.quantity, `contenido[${index}].quantity`);
			if (quantity <= 0) {
				throw new Error(
					`La cantidad del renglón ${index + 1} del contenido debe ser mayor a cero`,
				);
			}
			return {
				articulo_index: order_reference?.articulo_index ?? articulo_index ?? undefined,
				product: order_reference?.product_id || product_id || undefined,
				product_name: text(item.product_name) || order_reference?.product_name || 'Producto',
				product_code: text(item.product_code) || order_reference?.product_code || '',
				quantity,
				notes: text(item.notes) || order_reference?.notes || '',
			};
		})
		.filter((item) => text(item.product_name));
}

function build_content_summary(
	items: Array<{ product_code?: string; product_name?: string; quantity?: number; notes?: string }>,
) {
	return items
		.map((item) => {
			const product_code = text(item.product_code);
			const product_name = text(item.product_name);
			const notes = text(item.notes);
			const parts = [
				product_code ? `${product_code} · ${product_name}` : product_name,
				`x${number_field(item.quantity, 'quantity')}`,
			];
			if (notes) parts.push(`(${notes})`);
			return parts.join(' ');
		})
		.join(', ');
}

async function resolve_next_package_number(
	store: ImperiumStore,
	pedido_id: string,
	current_record_id?: string,
) {
	const { rows } = await store.find_many('delivery-package', {
		where: { pedido: pedido_id },
		take: 20000,
		include_inactive: true,
		populate: false,
	});
	const count = rows.filter((row) => !current_record_id || String(row._id) !== current_record_id)
		.length;
	return count + 1;
}

async function resolve_package_codigo(
	store: ImperiumStore,
	params: { is_create: boolean; existing_codigo?: string; context?: ImperiumDoc },
) {
	if (!params.is_create) {
		const existing = text(params.existing_codigo).toUpperCase();
		if (!existing) {
			throw new Error('El bulto no tiene código de secuencia; no se puede actualizar');
		}
		return existing;
	}
	const next = await store.next_auto_increment('DeliveryPackage', 'codigo_bulto', {
		resource: 'delivery-package',
		context: params.context,
	});
	const codigo = String(
		await format_model_field_value(
			store,
			'DeliveryPackage',
			'codigo_bulto',
			next,
			params.context,
			format_codigo_bulto(next),
		),
	);
	if (!codigo) throw new Error('No se pudo asignar el folio de secuencia del bulto');
	return codigo;
}

function assert_manual_state_transition(current_state: string, next_state: string) {
	if (LOGISTICS_STATES.has(current_state) || LOGISTICS_STATES.has(next_state)) {
		throw new Error(
			'Los estados operativos del reparto solo pueden cambiarse desde el scanner logístico',
		);
	}
	if (current_state === 'cancelado' || next_state === 'cancelado') {
		throw new Error(
			'Para anular un bulto usa la acción «Anular bulto» (no el cambio manual de estado)',
		);
	}
}

async function normalize_payload(
	store: ImperiumStore,
	payload: ImperiumDoc,
	current_record_id?: string,
	existing_record?: { codigo_bulto?: string | null; name?: string | null } | null,
): Promise<ImperiumDoc> {
	const pedido_id = text(payload.pedido);
	if (!pedido_id) throw new Error('Debes seleccionar un pedido');
	const order_snapshot = await resolve_order_snapshot(store, pedido_id);
	const route_id = text(payload.delivery_route);
	const manual_vehicle_id = text(payload.vehicle);
	let delivery_route = '';
	let delivery_route_nombre = '';
	let vehicle = '';
	let vehicle_nombre = '';
	if (route_id) {
		const route_snapshot = await resolve_route_snapshot(store, route_id);
		delivery_route = route_id;
		delivery_route_nombre = route_snapshot.delivery_route_nombre;
		if (route_snapshot.vehicle_id) {
			vehicle = route_snapshot.vehicle_id;
			vehicle_nombre = route_snapshot.vehicle_nombre;
		}
	} else if (order_snapshot.pedido_contacto_id) {
		const suggested = await resolve_route_from_contact(store, order_snapshot.pedido_contacto_id);
		if (suggested) {
			delivery_route = suggested.delivery_route_id;
			delivery_route_nombre = suggested.delivery_route_nombre;
			if (suggested.vehicle_id) {
				vehicle = suggested.vehicle_id;
				vehicle_nombre = suggested.vehicle_nombre;
			}
		}
	}
	if (!vehicle && manual_vehicle_id) {
		const vehicle_snapshot = await resolve_vehicle_snapshot(store, manual_vehicle_id);
		vehicle = vehicle_snapshot.vehicle_id;
		vehicle_nombre = vehicle_snapshot.vehicle_nombre;
	}
	const numero_bulto =
		payload.numero_bulto && Number(payload.numero_bulto) > 0
			? number_field(payload.numero_bulto, 'numero_bulto')
			: await resolve_next_package_number(store, pedido_id, current_record_id);
	const is_create = !current_record_id;
	const codigo_bulto = await resolve_package_codigo(store, {
		is_create,
		existing_codigo:
			existing_record?.codigo_bulto ?? (is_create ? undefined : text(payload.codigo_bulto)),
		context: payload,
	});
	const requested_estado = text(payload.estado);
	const estado = PACKAGE_STATES.includes(requested_estado as (typeof PACKAGE_STATES)[number])
		? requested_estado
		: 'pendiente';
	const contenido = normalize_content_items(payload.contenido, order_snapshot.articulos);
	const contenido_resumen = text(payload.contenido_resumen) || build_content_summary(contenido);
	return {
		...payload,
		pedido: pedido_id,
		pedido_folio: order_snapshot.pedido_folio,
		pedido_folio_interno: order_snapshot.pedido_folio_interno,
		pedido_contacto_nombre: order_snapshot.pedido_contacto_nombre,
		pedido_contacto_domicilio: order_snapshot.pedido_contacto_domicilio,
		pedido_contacto_url_maps: order_snapshot.pedido_contacto_url_maps,
		delivery_address_coordinates: order_snapshot.delivery_address_coordinates ?? null,
		delivery_route,
		delivery_route_nombre,
		vehicle,
		vehicle_nombre,
		codigo_bulto,
		name: codigo_bulto,
		numero_bulto,
		peso_kg: number_field(payload.peso_kg, 'peso_kg'),
		contenido,
		contenido_resumen,
		pedido_total_bultos: Number(payload.pedido_total_bultos ?? 1),
		estado,
		description: text(payload.description),
	};
}

export async function prepare_delivery_package_create(
	store: ImperiumStore,
	doc: ImperiumDoc,
): Promise<ImperiumDoc> {
	const out = { ...doc };
	delete out._id;
	return normalize_payload(store, out);
}

export async function prepare_delivery_package_update(
	store: ImperiumStore,
	doc: ImperiumDoc,
	previous: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró el bulto indicado');
	if (previous.is_active === false || String(previous.estado) === 'cancelado') {
		throw new Error(
			'No se puede editar un bulto anulado. Crea un bulto nuevo con las cantidades liberadas.',
		);
	}
	const requested_state = text(doc.estado);
	if (requested_state && requested_state !== text(previous.estado)) {
		assert_manual_state_transition(text(previous.estado), requested_state);
	}
	return normalize_payload(
		store,
		{ ...previous, ...doc },
		String(previous._id),
		{ codigo_bulto: text(previous.codigo_bulto), name: text(previous.name) },
	);
}

export async function after_delivery_package_mutate(
	store: ImperiumStore,
	...pedido_ids: Array<string | undefined>
): Promise<void> {
	const unique = [...new Set(pedido_ids.map((id) => text(id)).filter(Boolean))];
	for (const pedido_id of unique) {
		await sync_order_state_from_packages(store, pedido_id);
		await sync_order_logistics_reservation(store, pedido_id);
	}
}

async function sync_order_package_totals(store: ImperiumStore, pedido_id: string) {
	const { rows } = await store.find_many('delivery-package', {
		where: { pedido: pedido_id },
		take: 20000,
		include_inactive: false,
		populate: false,
	});
	const package_records = rows.filter((row) => row.is_active !== false);
	const total_packages = Math.max(package_records.length, 1);
	for (const pack of package_records) {
		if (Number(pack.pedido_total_bultos ?? 0) === total_packages) continue;
		await store.update('delivery-package', String(pack._id), {
			pedido_total_bultos: total_packages,
		});
	}
	return { package_records, total_packages };
}

async function sync_order_state_from_packages(store: ImperiumStore, pedido_id: string) {
	const { package_records } = await sync_order_package_totals(store, pedido_id);
	const pedido = await store.find_id('pedidos', pedido_id);
	if (!pedido || pedido.is_active === false) return;
	const estado = text(pedido.estado);
	if (!package_records.length) {
		if (['surtido', 'enviado', 'por_surtir'].includes(estado)) {
			await store.update('pedidos', pedido_id, { estado: 'surtido' });
		}
		return;
	}
	const next_state = package_records.every((record) => text(record.estado) === 'entregado')
		? 'enviado'
		: 'surtido';
	if (['surtiendo', 'surtido', 'enviado', 'por_surtir'].includes(estado)) {
		await store.update('pedidos', pedido_id, { estado: next_state });
	}
}

export async function cancel_delivery_package(
	store: ImperiumStore,
	package_id: string,
	reason?: string,
): Promise<ImperiumDoc> {
	const id = text(package_id);
	if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
		throw new Error('Debes indicar un bulto válido');
	}
	const current = await store.find_id('delivery-package', id);
	if (!current) throw new Error('No se encontró el bulto indicado');
	if (current.is_active === false) throw new Error('Este bulto ya está anulado');
	if (text(current.estado) === 'cancelado') throw new Error('Este bulto ya está cancelado');
	if (!CANCELABLE_STATES.has(text(current.estado))) {
		throw new Error(
			`No se puede anular un bulto en estado «${current.estado}». Solo pendiente o incidencia (antes de cerrar empaque).`,
		);
	}
	const trimmed_reason = text(reason);
	const prev = text(current.description);
	const description = trimmed_reason
		? prev
			? `${prev} | Anulado: ${trimmed_reason}`
			: `Anulado: ${trimmed_reason}`
		: prev;
	const cancelled = await store.update('delivery-package', id, {
		is_active: false,
		estado: 'cancelado',
		description,
	});
	if (!cancelled) throw new Error('No se encontró el bulto indicado');
	await after_delivery_package_mutate(store, text(current.pedido));
	return cancelled;
}

export async function list_packages_by_pedido(
	store: ImperiumStore,
	pedido_id: string,
	include_cancelled: boolean,
): Promise<{ rows: ImperiumDoc[]; message: string }> {
	const id = text(pedido_id);
	if (!id) throw new Error('Debes indicar el pedido');
	const { rows } = await store.find_many('delivery-package', {
		where: { pedido: id },
		take: 20000,
		include_inactive: true,
		populate: false,
	});
	const filtered = include_cancelled ? rows : rows.filter((row) => row.is_active !== false);
	filtered.sort((a, b) => {
		const active = Number(b.is_active !== false) - Number(a.is_active !== false);
		if (active) return active;
		const by_number = Number(a.numero_bulto ?? 0) - Number(b.numero_bulto ?? 0);
		if (by_number) return by_number;
		return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
	});
	return {
		rows: filtered,
		message: include_cancelled ? 'Bultos del pedido (incl. anulados)' : 'Bultos del pedido',
	};
}

/** `__get_statistics` original: `by_status` agrupa `$estado`. */
export async function delivery_package_by_status(
	store: ImperiumStore,
	mongo_match?: Record<string, unknown> | null,
): Promise<Array<{ _id: string | null; count: number }>> {
	const { rows } = await store.find_many('delivery-package', {
		take: 20000,
		include_inactive: true,
		populate: false,
		mongo_match,
	});
	const counts = new Map<string | null, number>();
	for (const row of rows) {
		const raw = text(row.estado);
		const key = raw || null;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')))
		.map(([_id, count]) => ({ _id, count }));
}
