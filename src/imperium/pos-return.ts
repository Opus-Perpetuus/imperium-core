/**
 * Devoluciones de POS ligadas a la venta original (`original_ticket`).
 *
 * - Sin `original_ticket` un ticket DEVOLUCION se comporta como siempre: no
 *   se valida contra ninguna venta y no mueve inventario.
 * - Con `original_ticket`: lo devuelto por producto no puede pasar de lo
 *   vendido menos lo ya devuelto en otras devoluciones de esa venta, el
 *   importe sale de los precios de la venta y el subtotal queda negativo
 *   (la caja esperada baja lo reembolsado).
 * - Reingreso: solo lo que la venta realmente restó (sus movimientos
 *   `salida_entrega`) menos lo ya reingresado. `restock_mode: 'none'` no
 *   reingresa nada; sin modo explícito, un ajuste manual positivo del producto
 *   posterior a la venta se toma como reingreso ya hecho y ese producto se omite.
 * - Kits: se reingresan sus componentes (la venta sacó componentes, no el kit).
 * - Cancelar la devolución revierte su reingreso (`revert_pos_return_entry`).
 * - Dos devoluciones simultáneas de la misma venta: la posterior que exceda lo
 *   vendido se cancela sola (`assert_return_within_sale`).
 */
import { apply_quant_delta, find_warehouse_location } from './delivery-return-flow.ts';
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { round_quantity } from './inventory-picking.ts';
import { CREDIT_METHOD, credit_refund_for_return } from './pos-credit.ts';
import { expand_kit_quantities } from './pos-product-rules.ts';
import { STORE_CREDIT_METHOD } from './pos-store-credit.ts';
import type { ImperiumStore } from './store.ts';

export const RESTOCK_AUTO = 'auto';
export const RESTOCK_NONE = 'none';
const RESTOCK_MODES = new Set([RESTOCK_AUTO, RESTOCK_NONE]);
const CANCELLED = new Set(['cancelado', 'canceled', 'cancelled']);

export type ReturnLine = {
	item_id: string;
	item_name: string;
	unit_price: number;
	vendido: number;
	devuelto: number;
	disponible: number;
};

export type RestockResult = {
	producto: string;
	devuelto: number;
	reingresado: number;
	motivo: 'reingresado' | 'sin_reingreso' | 'ajuste_manual_detectado' | 'sin_salida_registrada' | 'ya_reingresado';
};

function text(value: unknown): string {
	return value == null ? '' : String(value).trim();
}

function money(n: number): number {
	return Math.round(n * 100) / 100;
}

function item_product(item: ImperiumDoc): string {
	return text(item.item_id ?? item.producto ?? item.product_id);
}

function item_qty(item: ImperiumDoc): number {
	const n = Number(item.quantity ?? item.cantidad ?? 0);
	return Number.isFinite(n) ? n : 0;
}

function is_live(ticket: ImperiumDoc): boolean {
	if (ticket.is_active === false) return false;
	return !CANCELLED.has(text(ticket.state ?? ticket.estado).toLowerCase());
}

export function is_linked_return(ticket: ImperiumDoc): boolean {
	return text(ticket.ticket_type).toUpperCase() === 'DEVOLUCION' && !!text(ticket.original_ticket);
}

/** Devoluciones vivas ligadas a la venta, opcionalmente sin contar una. */
async function returns_of(store: ImperiumStore, original_id: string, except = ''): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan('pos-tickets', { where: { original_ticket: original_id } })) {
		for (const row of page) {
			if (String(row._id ?? '') === except) continue;
			if (text(row.ticket_type).toUpperCase() !== 'DEVOLUCION' || !is_live(row)) continue;
			out.push(row);
		}
	}
	return out;
}

function qty_by_product(items: unknown): Map<string, number> {
	const map = new Map<string, number>();
	for (const raw of as_array(items)) {
		const item = as_object(raw);
		const pid = item_product(item);
		const q = item_qty(item);
		if (!pid || q <= 0) continue;
		map.set(pid, round_quantity((map.get(pid) ?? 0) + q));
	}
	return map;
}

/** Lo vendido, lo devuelto y lo que aún se puede devolver por producto. */
export async function return_availability(
	store: ImperiumStore,
	original: ImperiumDoc,
	except = '',
): Promise<ReturnLine[]> {
	const original_id = String(original._id ?? '');
	const returned = new Map<string, number>();
	for (const ret of await returns_of(store, original_id, except)) {
		for (const [pid, q] of qty_by_product(ret.items)) {
			returned.set(pid, round_quantity((returned.get(pid) ?? 0) + q));
		}
	}
	const lines = new Map<string, ReturnLine>();
	for (const raw of as_array(original.items)) {
		const item = as_object(raw);
		const pid = item_product(item);
		const q = item_qty(item);
		if (!pid || q <= 0) continue;
		const line = lines.get(pid) ?? {
			item_id: pid,
			item_name: text(item.item_name ?? item.name),
			unit_price: Number(item.unit_price ?? 0) || 0,
			vendido: 0,
			devuelto: returned.get(pid) ?? 0,
			disponible: 0,
		};
		line.vendido = round_quantity(line.vendido + q);
		lines.set(pid, line);
	}
	return [...lines.values()].map((line) => ({
		...line,
		disponible: Math.max(round_quantity(line.vendido - line.devuelto), 0),
	}));
}

export async function load_original_sale(store: ImperiumStore, original_id: string): Promise<ImperiumDoc> {
	const original = await store.find_id('pos-tickets', original_id);
	if (!original) throw new Error('La venta original de la devolución no existe');
	if (text(original.ticket_type || 'VENTA').toUpperCase() !== 'VENTA') {
		throw new Error('Solo se puede devolver un ticket de venta');
	}
	if (!is_live(original)) throw new Error('La venta original está cancelada o inactiva');
	return original;
}

/**
 * Valida y normaliza una devolución ligada antes de crearla. Sin
 * `original_ticket` regresa el documento intacto (comportamiento previo).
 */
export async function prepare_pos_return(store: ImperiumStore, doc: ImperiumDoc): Promise<ImperiumDoc> {
	if (!is_linked_return(doc)) return doc;
	const original_id = text(doc.original_ticket);
	const original = await load_original_sale(store, original_id);
	const mode = text(doc.restock_mode).toLowerCase();
	if (mode && !RESTOCK_MODES.has(mode)) {
		throw new Error('restock_mode debe ser "auto" o "none"');
	}
	const available = new Map(
		(await return_availability(store, original, String(doc._id ?? ''))).map((l) => [l.item_id, l]),
	);
	const requested = qty_by_product(doc.items);
	if (!requested.size) throw new Error('La devolución no tiene artículos con cantidad mayor a 0');
	const items: ImperiumDoc[] = [];
	let refund = 0;
	for (const [pid, q] of requested) {
		const line = available.get(pid);
		if (!line) throw new Error(`El artículo ${pid} no está en la venta original`);
		if (q > line.disponible) {
			throw new Error(
				`No se puede devolver ${q} de «${line.item_name || pid}»: vendidos ${line.vendido}, ya devueltos ${line.devuelto}`,
			);
		}
		const total = money(q * line.unit_price);
		refund += total;
		items.push({
			item_id: pid,
			item_name: line.item_name,
			unit_price: line.unit_price,
			quantity: q,
			total,
			price_origin: 'devolucion',
		});
	}
	const credit_refund = await credit_refund_for_return(store, original, money(refund), String(doc._id ?? ''));
	const refund_lines: ImperiumDoc[] = credit_refund > 0 ? [{ method: CREDIT_METHOD, amount: credit_refund }] : [];
	// Saldo a favor: lo que no regresa a la cuenta de crédito queda como vale del cliente, sin salir efectivo.
	const wants_store_credit = text(doc.refund_method).toLowerCase() === STORE_CREDIT_METHOD;
	const store_credit = wants_store_credit ? money(refund - credit_refund) : 0;
	if (wants_store_credit && !(text(doc.client_id) || text(original.client_id))) {
		throw new Error('El saldo a favor requiere un cliente en la venta o en la devolución');
	}
	if (store_credit > 0) refund_lines.push({ method: STORE_CREDIT_METHOD, amount: store_credit });
	const methods = [...new Set(refund_lines.map((p) => String(p.method)))];
	const credit = refund_lines.length
		? { payments: refund_lines, payment_method: methods.length === 1 ? methods[0] : 'mixto' }
		: {};
	const { refund_method: _refund_method, ...rest } = doc;
	return {
		...rest,
		...credit,
		original_ticket: original_id,
		...(mode ? { restock_mode: mode } : {}),
		items,
		subtotal: money(-refund),
		total_paid: 0,
		change: 0,
		client_id: text(doc.client_id) || text(original.client_id),
		client_name: text(doc.client_name) || text(original.client_name),
		client_lastname: text(doc.client_lastname) || text(original.client_lastname),
	};
}

function delta_of(row: ImperiumDoc): number {
	return Number(row.stock_total_resultante ?? 0) - Number(row.stock_total_previo ?? 0);
}

async function movements_for(
	store: ImperiumStore,
	where: Record<string, unknown>,
): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan('inventory-movement', { where })) out.push(...page);
	return out;
}

/**
 * Reingresa al inventario lo devuelto, topado a lo que la venta restó.
 * Idempotente: si la devolución ya tiene movimientos, no hace nada.
 */
export async function register_pos_return_entry(
	store: ImperiumStore,
	ticket: ImperiumDoc,
): Promise<RestockResult[]> {
	if (!is_linked_return(ticket)) return [];
	const return_id = String(ticket._id ?? '');
	const requested = await expand_kit_quantities(store, qty_by_product(ticket.items));
	const mode = text(ticket.restock_mode).toLowerCase();
	if (mode === RESTOCK_NONE || !store.has('products') || !store.has('inventory-movement')) {
		return [...requested].map(([producto, devuelto]) => ({
			producto,
			devuelto,
			reingresado: 0,
			motivo: 'sin_reingreso',
		}));
	}
	if (return_id && (await movements_for(store, { documento_id: return_id, documento_tipo: 'pos-ticket' })).length) {
		return [...requested].map(([producto, devuelto]) => ({
			producto,
			devuelto,
			reingresado: 0,
			motivo: 'ya_reingresado',
		}));
	}
	const original_id = text(ticket.original_ticket);
	const sale_moves = (await movements_for(store, { documento_id: original_id, documento_tipo: 'pos-ticket' })).filter(
		(m) => text(m.tipo_movimiento) === 'salida_entrega',
	);
	const prior_ids = (await returns_of(store, original_id, return_id)).map((r) => String(r._id ?? ''));
	const prior_moves = prior_ids.length
		? (await movements_for(store, { documento_id: { in: prior_ids } })).filter(
				(m) => text(m.tipo_movimiento) === 'recepcion_devolucion',
			)
		: [];
	const warehouse = await find_warehouse_location(store);
	const results: RestockResult[] = [];
	for (const [producto, devuelto] of requested) {
		const mine = sale_moves.filter((m) => text(m.producto ?? m.producto_id) === producto);
		const subtracted = round_quantity(mine.reduce((s, m) => s + Math.max(-delta_of(m), 0), 0));
		const already = round_quantity(
			prior_moves
				.filter((m) => text(m.producto ?? m.producto_id) === producto)
				.reduce((s, m) => s + Math.max(delta_of(m), 0), 0),
		);
		if (subtracted <= 0) {
			results.push({ producto, devuelto, reingresado: 0, motivo: 'sin_salida_registrada' });
			continue;
		}
		if (!mode && (await manual_adjustment_after(store, producto, mine))) {
			results.push({ producto, devuelto, reingresado: 0, motivo: 'ajuste_manual_detectado' });
			continue;
		}
		const amount = round_quantity(Math.min(devuelto, Math.max(subtracted - already, 0)));
		if (amount <= 0) {
			results.push({ producto, devuelto, reingresado: 0, motivo: 'ya_reingresado' });
			continue;
		}
		const product = await store.find_id('products', producto);
		if (!product) {
			results.push({ producto, devuelto, reingresado: 0, motivo: 'sin_salida_registrada' });
			continue;
		}
		const previa = Number(product.existencia ?? 0);
		const next = round_quantity(previa + amount);
		await store.update('products', producto, { existencia: next });
		if (warehouse?._id) {
			await apply_quant_delta(store, {
				producto,
				producto_nombre: text(product.name),
				producto_codigo: text(product.codigo),
				ubicacion: String(warehouse._id),
				ubicacion_codigo: text(warehouse.codigo ?? warehouse.name),
				delta: amount,
			});
		}
		const apartado = round_quantity(Number(product.existenciaApartada ?? 0));
		await store.insert('inventory-movement', {
			name: `Devolución POS ${text(product.name) || producto}`,
			producto,
			producto_id: producto,
			producto_nombre: product.name,
			producto_codigo: product.codigo,
			tipo_movimiento: 'recepcion_devolucion',
			ubicacion_destino: warehouse?._id,
			ubicacion_destino_id: warehouse?._id,
			ubicacion_destino_nombre: warehouse?.name,
			documento_tipo: 'pos-ticket',
			documento_id: return_id,
			documento_modelo: 'PosTickets',
			documento_nombre: text(ticket.name ?? ticket.ticket_sequence),
			documento_referencia: text(ticket.ticket_sequence),
			description: 'Reingreso por devolución en punto de venta',
			cantidad: amount,
			stock_total_previo: round_quantity(previa),
			stock_total_resultante: next,
			stock_apartado_previo: apartado,
			stock_apartado_resultante: apartado,
			fecha_movimiento: new Date().toISOString(),
		});
		results.push({ producto, devuelto, reingresado: amount, motivo: 'reingresado' });
	}
	return results;
}

function moment_of(row: ImperiumDoc): number {
	const raw = row.fecha_movimiento ?? row.createdAt ?? row.created_at;
	const t = new Date(String(raw ?? '')).getTime();
	return Number.isFinite(t) ? t : 0;
}

/** ¿Hubo un ajuste manual que subió la existencia del producto después de la venta? */
async function manual_adjustment_after(
	store: ImperiumStore,
	producto: string,
	sale_moves: ImperiumDoc[],
): Promise<boolean> {
	const since = Math.min(...sale_moves.map(moment_of));
	const adjustments = await movements_for(store, { producto, tipo_movimiento: 'ajuste_manual' });
	return adjustments.some((m) => moment_of(m) > since && delta_of(m) > 0);
}

/** Venta a devolver (por id o por folio) con lo disponible por artículo. */
export async function pos_return_lookup(
	store: ImperiumStore,
	query: { id?: string | null; folio?: string | null },
): Promise<ImperiumDoc> {
	let id = text(query.id);
	const folio = text(query.folio);
	if (!id && folio) {
		const found =
			(await store.find_where('pos-tickets', { ticket_sequence: folio })) ??
			(await store.find_where('pos-tickets', { name: folio }));
		id = found ? String(found._id ?? '') : '';
		if (!id) throw new Error(`No hay un ticket con folio ${folio}`);
	}
	if (!id) throw new Error('Indica el id o el folio de la venta');
	const original = await load_original_sale(store, id);
	const lineas = await return_availability(store, original);
	return {
		_id: String(original._id ?? ''),
		ticket_sequence: text(original.ticket_sequence),
		createdAt: original.createdAt ?? original.created_at ?? null,
		client_name: `${text(original.client_name)} ${text(original.client_lastname)}`.trim(),
		subtotal: Number(original.subtotal ?? 0),
		lineas,
		disponible_total: lineas.reduce((s, l) => s + l.disponible, 0),
	};
}

/**
 * Revierte el reingreso de una devolución cancelada: resta lo reingresado.
 * Idempotente (no repite si ya hay movimientos de reversión).
 */
export async function revert_pos_return_entry(store: ImperiumStore, ticket: ImperiumDoc): Promise<number> {
	if (!is_linked_return(ticket) || !store.has('products') || !store.has('inventory-movement')) return 0;
	const return_id = String(ticket._id ?? '');
	if (!return_id) return 0;
	const moves = await movements_for(store, { documento_id: return_id, documento_tipo: 'pos-ticket' });
	if (moves.some((m) => text(m.dedupe_key).startsWith(`pos-return-revert:${return_id}:`))) return 0;
	const by_product = new Map<string, number>();
	for (const m of moves) {
		if (text(m.tipo_movimiento) !== 'recepcion_devolucion') continue;
		const pid = text(m.producto ?? m.producto_id);
		const q = Math.max(delta_of(m), 0);
		if (pid && q > 0) by_product.set(pid, round_quantity((by_product.get(pid) ?? 0) + q));
	}
	const warehouse = by_product.size ? await find_warehouse_location(store) : null;
	let count = 0;
	for (const [producto, amount] of by_product) {
		const product = await store.find_id('products', producto);
		if (!product) continue;
		const previa = round_quantity(Number(product.existencia ?? 0));
		const next = round_quantity(Math.max(previa - amount, 0));
		await store.update('products', producto, { existencia: next });
		if (warehouse?._id && previa - next > 0) {
			await apply_quant_delta(store, {
				producto,
				producto_nombre: text(product.name),
				producto_codigo: text(product.codigo),
				ubicacion: String(warehouse._id),
				ubicacion_codigo: text(warehouse.codigo ?? warehouse.name),
				delta: -round_quantity(previa - next),
			});
		}
		const apartado = round_quantity(Number(product.existenciaApartada ?? 0));
		await store.insert('inventory-movement', {
			name: `Cancelación de devolución POS ${text(product.name) || producto}`,
			producto,
			producto_id: producto,
			producto_nombre: product.name,
			producto_codigo: product.codigo,
			tipo_movimiento: 'ajuste_manual',
			ubicacion_origen: warehouse?._id,
			ubicacion_origen_id: warehouse?._id,
			ubicacion_origen_nombre: warehouse?.name,
			documento_tipo: 'pos-ticket',
			documento_id: return_id,
			documento_modelo: 'PosTickets',
			documento_nombre: text(ticket.name ?? ticket.ticket_sequence),
			documento_referencia: text(ticket.ticket_sequence),
			description: 'Devolución POS cancelada: se revierte su reingreso',
			cantidad: amount,
			stock_total_previo: previa,
			stock_total_resultante: next,
			stock_apartado_previo: apartado,
			stock_apartado_resultante: apartado,
			fecha_movimiento: new Date().toISOString(),
			dedupe_key: `pos-return-revert:${return_id}:${producto}`,
		});
		count++;
	}
	return count;
}

function created_order(t: ImperiumDoc): [number, string] {
	const at = new Date(String(t.createdAt ?? t.created_at ?? '')).getTime();
	return [Number.isFinite(at) ? at : 0, String(t._id ?? '')];
}

function is_before(a: ImperiumDoc, b: ImperiumDoc): boolean {
	const [ta, ia] = created_order(a);
	const [tb, ib] = created_order(b);
	return ta < tb || (ta === tb && ia < ib);
}

/**
 * Después de crear una devolución ligada: si junto con las devoluciones
 * anteriores (por fecha de creación e id) excede lo vendido, se cancela y
 * se rechaza. Cubre dos devoluciones simultáneas de la misma venta.
 */
export async function assert_return_within_sale(store: ImperiumStore, created: ImperiumDoc): Promise<void> {
	if (!is_linked_return(created)) return;
	const original = await store.find_id('pos-tickets', text(created.original_ticket));
	if (!original) return;
	const sold = qty_by_product(original.items);
	const used = qty_by_product(created.items);
	for (const other of await returns_of(store, String(original._id ?? ''), String(created._id ?? ''))) {
		if (!is_before(other, created)) continue;
		for (const [pid, q] of qty_by_product(other.items)) used.set(pid, round_quantity((used.get(pid) ?? 0) + q));
	}
	const over = [...used].find(([pid, q]) => q - (sold.get(pid) ?? 0) > 0.0001);
	if (!over) return;
	await store.update('pos-tickets', String(created._id), {
		state: 'cancelado',
		is_active: false,
	});
	throw new Error('Otra devolución de esta venta se registró al mismo tiempo y ya no queda cantidad por devolver; vuelve a consultar el ticket.');
}
