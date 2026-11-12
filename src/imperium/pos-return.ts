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
 *   `salida_entrega`) menos lo ya reingresado, a la misma ubicación. Si la
 *   salida registró lote, la pieza vuelve a ese lote y a su caducidad; si
 *   salió de varios, cada pieza vuelve al suyo. `restock_mode: 'none'` no
 *   reingresa nada; sin modo explícito, un ajuste manual positivo del producto
 *   posterior a la venta se toma como reingreso ya hecho y ese producto se omite.
 * - Kits: se reingresan sus componentes (la venta sacó componentes, no el kit).
 * - Cancelar la devolución revierte su reingreso (`revert_pos_return_entry`).
 * - Dos devoluciones simultáneas de la misma venta: la posterior que exceda lo
 *   vendido se cancela sola (`assert_return_within_sale`).
 */
import { allow_negative_stock, assert_salida_sin_negativos } from './negative-stock.ts';
import { apply_quant_delta, find_warehouse_location } from './delivery-return-flow.ts';
import { ref_id } from './warehouse-scope.ts';
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
	const general = await find_warehouse_location(store);
	const results: RestockResult[] = [];
	for (const [producto, devuelto] of requested) {
		const mine = sale_moves.filter((m) => text(m.producto ?? m.producto_id) === producto);
		const subtracted = round_quantity(mine.reduce((s, m) => s + Math.max(-delta_of(m), 0), 0));
		const prior_of_product = prior_moves.filter((m) => text(m.producto ?? m.producto_id) === producto);
		const already = round_quantity(prior_of_product.reduce((s, m) => s + Math.max(delta_of(m), 0), 0));
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
		const slots = sale_slots(mine);
		await hydrate_slot_lots(store, producto, slots);
		for (const prior of prior_of_product) {
			const back = round_quantity(Math.max(delta_of(prior), 0));
			const dest = move_location_id(prior, 'ubicacion_destino');
			const lote = ref_id(prior.lote);
			const codigo = text(prior.lote_codigo);
			const unmatched = consume_slots(slots, back, dest, lote, codigo);
			if (unmatched > 0) consume_slots(slots, unmatched, '', lote, codigo);
		}
		const plan = plan_restock(slots, amount, general);
		const apartado = round_quantity(Number(product.existenciaApartada ?? 0));
		let running = round_quantity(previa);
		for (const [i, parte] of plan.entries()) {
			const resultante = i === plan.length - 1 ? next : round_quantity(running + parte.cantidad);
			const lot = lot_patch(parte.lote, parte.lote_codigo, parte.fecha_caducidad);
			if (parte.ubicacion) {
				const loc = store.has('inventory-internal-location')
					? await store.find_id('inventory-internal-location', parte.ubicacion)
					: null;
				await apply_quant_delta(store, {
					producto,
					producto_nombre: text(product.name),
					producto_codigo: text(product.codigo),
					ubicacion: parte.ubicacion,
					ubicacion_codigo: text(loc?.codigo ?? loc?.name) || parte.codigo,
					delta: parte.cantidad,
					...lot,
				});
			}
			await store.insert('inventory-movement', {
				name: `Devolución POS ${text(product.name) || producto}`,
				producto,
				producto_id: producto,
				producto_nombre: product.name,
				producto_codigo: product.codigo,
				tipo_movimiento: 'recepcion_devolucion',
				ubicacion_destino: parte.ubicacion || undefined,
				ubicacion_destino_id: parte.ubicacion || undefined,
				ubicacion_destino_nombre: parte.nombre,
				...lot,
				documento_tipo: 'pos-ticket',
				documento_id: return_id,
				documento_modelo: 'PosTickets',
				documento_nombre: text(ticket.name ?? ticket.ticket_sequence),
				documento_referencia: text(ticket.ticket_sequence),
				description: 'Reingreso por devolución en punto de venta',
				cantidad: parte.cantidad,
				stock_total_previo: running,
				stock_total_resultante: resultante,
				stock_apartado_previo: apartado,
				stock_apartado_resultante: apartado,
				fecha_movimiento: new Date().toISOString(),
			});
			running = resultante;
		}
		results.push({ producto, devuelto, reingresado: amount, motivo: 'reingresado' });
	}
	return results;
}

type LotSlice = { lote: string; lote_codigo: string; fecha_caducidad: string; left: number };

type RestockSlot = { ubicacion: string; left: number; codigo: string; nombre: string; lots: LotSlice[] };

type RestockPart = {
	ubicacion: string;
	cantidad: number;
	codigo: string;
	nombre: string;
	lote: string;
	lote_codigo: string;
	fecha_caducidad: string;
};

function lot_patch(lote: string, lote_codigo: string, fecha_caducidad: string): ImperiumDoc {
	const fecha = fecha_caducidad.slice(0, 10);
	if (!lote) return {};
	return {
		lote,
		...(lote_codigo ? { lote_codigo } : {}),
		...(fecha ? { fecha_caducidad: fecha } : {}),
	};
}

const LOTE_PARTE = /([^,()]+?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)/g;

function lot_slices(move: ImperiumDoc, taken: number): LotSlice[] {
	const lote = ref_id(move.lote);
	const fecha = text(move.fecha_caducidad).slice(0, 10);
	if (lote) return [{ lote, lote_codigo: text(move.lote_codigo), fecha_caducidad: fecha, left: taken }];
	const source = text(move.description);
	const mark = source.toLowerCase().lastIndexOf('lotes:');
	const parts: LotSlice[] = [];
	if (mark >= 0) {
		LOTE_PARTE.lastIndex = 0;
		for (const match of source.slice(mark + 'lotes:'.length).matchAll(LOTE_PARTE)) {
			const qty = round_quantity(Number(match[2]));
			const code = match[1].trim();
			if (!code || qty <= 0) continue;
			parts.push({ lote: '', lote_codigo: code, fecha_caducidad: '', left: qty });
		}
	}
	const sum = round_quantity(parts.reduce((total, part) => total + part.left, 0));
	if (parts.length && sum <= taken + 0.0001) {
		if (taken - sum > 0.0001) {
			parts.push({ lote: '', lote_codigo: '', fecha_caducidad: '', left: round_quantity(taken - sum) });
		}
		return parts;
	}
	return [{ lote: '', lote_codigo: '', fecha_caducidad: '', left: taken }];
}

function move_location_id(move: ImperiumDoc, field: 'ubicacion_origen' | 'ubicacion_destino'): string {
	return ref_id(move[`${field}_id`]) || ref_id(move[field]);
}

function sale_slots(moves: ImperiumDoc[]): RestockSlot[] {
	const slots: RestockSlot[] = [];
	for (const move of moves) {
		const taken = round_quantity(Math.max(-delta_of(move), 0));
		if (taken <= 0) continue;
		slots.push({
			ubicacion: move_location_id(move, 'ubicacion_origen'),
			left: taken,
			codigo: text(move.ubicacion_origen_nombre),
			nombre: text(move.ubicacion_origen_nombre),
			lots: lot_slices(move, taken),
		});
	}
	return slots;
}

async function hydrate_slot_lots(store: ImperiumStore, producto: string, slots: RestockSlot[]): Promise<void> {
	const pending = slots.some((slot) =>
		slot.lots.some((slice) => slice.lote_codigo && (!slice.lote || !slice.fecha_caducidad)),
	);
	if (!pending || !store.has('inventory-stock-quant')) return;
	const { rows } = await store.find_many('inventory-stock-quant', { where: { producto }, take: 500 });
	for (const slot of slots) {
		for (const slice of slot.lots) {
			if ((slice.lote && slice.fecha_caducidad) || !slice.lote_codigo) continue;
			const want = slice.lote_codigo.toUpperCase();
			const row = rows.find((candidate) => {
				const here = ref_id(candidate.ubicacion_id) || ref_id(candidate.ubicacion);
				if (slot.ubicacion && here && here !== slot.ubicacion) return false;
				return text(candidate.lote_codigo).toUpperCase() === want && !!text(candidate.lote);
			});
			if (!row) continue;
			if (!slice.lote) slice.lote = text(row.lote);
			if (!slice.fecha_caducidad) slice.fecha_caducidad = text(row.fecha_caducidad).slice(0, 10);
		}
	}
}

function lot_hit(slice: LotSlice, lote: string, codigo: string): boolean {
	if (lote && slice.lote === lote) return true;
	return !!codigo && slice.lote_codigo.toUpperCase() === codigo.toUpperCase();
}

function take_lots(lots: LotSlice[], qty: number, lote = '', codigo = ''): Array<LotSlice & { cantidad: number }> {
	let rest = round_quantity(qty);
	const ranked = [...lots].reverse();
	if (lote || codigo) {
		ranked.sort((a, b) => Number(lot_hit(b, lote, codigo)) - Number(lot_hit(a, lote, codigo)));
	}
	const out: Array<LotSlice & { cantidad: number }> = [];
	for (const slice of ranked) {
		if (rest <= 0) break;
		const use = round_quantity(Math.min(slice.left, rest));
		if (use <= 0) continue;
		slice.left = round_quantity(slice.left - use);
		rest = round_quantity(rest - use);
		out.push({ ...slice, cantidad: use });
	}
	return out;
}

function consume_slots(slots: RestockSlot[], qty: number, ubicacion = '', lote = '', codigo = ''): number {
	let rest = round_quantity(qty);
	for (const slot of [...slots].reverse()) {
		if (rest <= 0) break;
		if (ubicacion && slot.ubicacion !== ubicacion) continue;
		const use = round_quantity(Math.min(slot.left, rest));
		if (use <= 0) continue;
		take_lots(slot.lots, use, lote, codigo);
		slot.left = round_quantity(slot.left - use);
		rest = round_quantity(rest - use);
	}
	return rest;
}

function plan_restock(slots: RestockSlot[], amount: number, general: ImperiumDoc | null): RestockPart[] {
	const plan: RestockPart[] = [];
	let rest = round_quantity(amount);
	for (const slot of [...slots].reverse()) {
		if (rest <= 0) break;
		const use = round_quantity(Math.min(slot.left, rest));
		if (use <= 0) continue;
		for (const part of take_lots(slot.lots, use)) {
			plan.push({
				ubicacion: slot.ubicacion,
				cantidad: part.cantidad,
				codigo: slot.codigo,
				nombre: slot.nombre,
				lote: part.lote,
				lote_codigo: part.lote_codigo,
				fecha_caducidad: part.fecha_caducidad,
			});
		}
		slot.left = round_quantity(slot.left - use);
		rest = round_quantity(rest - use);
	}
	if (rest > 0) {
		plan.push({
			ubicacion: general?._id ? String(general._id) : '',
			cantidad: rest,
			codigo: text(general?.codigo ?? general?.name),
			nombre: text(general?.name),
			lote: '',
			lote_codigo: '',
			fecha_caducidad: '',
		});
	}
	return plan;
}

/** Ubicación registrada en un movimiento (la venta salió de ahí; ahí reingresa). */
async function movement_location(
	store: ImperiumStore,
	move: ImperiumDoc | undefined,
	field: 'ubicacion_origen' | 'ubicacion_destino',
): Promise<ImperiumDoc | null> {
	const id = ref_id(move?.[`${field}_id`]) || ref_id(move?.[field]);
	if (!id || !store.has('inventory-internal-location')) return null;
	return (await store.find_id('inventory-internal-location', id)) ?? null;
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
	// Revertir el reingreso es una salida: misma regla de negativos.
	await assert_salida_sin_negativos(store, 'cancelar la devolución', by_product);
	const negativos = await allow_negative_stock(store);
	const general = by_product.size ? await find_warehouse_location(store) : null;
	let count = 0;
	for (const [producto, amount] of by_product) {
		const entries = moves.filter(
			(m) => text(m.tipo_movimiento) === 'recepcion_devolucion' && text(m.producto ?? m.producto_id) === producto,
		);
		const product = await store.find_id('products', producto);
		if (!product) continue;
		const previa = round_quantity(Number(product.existencia ?? 0));
		const next = round_quantity(negativos ? previa - amount : Math.max(previa - amount, 0));
		await store.update('products', producto, { existencia: next });
		let removal_left = round_quantity(previa - next);
		let running = previa;
		const apartado = round_quantity(Number(product.existenciaApartada ?? 0));
		for (const [index, entry] of entries.entries()) {
			const want = round_quantity(Math.min(Math.max(delta_of(entry), 0), removal_left));
			if (want <= 0) continue;
			const resultante = round_quantity(running - want);
			const warehouse = (await movement_location(store, entry, 'ubicacion_destino')) ?? general;
			const lot = lot_patch(ref_id(entry.lote), text(entry.lote_codigo), text(entry.fecha_caducidad));
			if (warehouse?._id) {
				await apply_quant_delta(store, {
					producto,
					producto_nombre: text(product.name),
					producto_codigo: text(product.codigo),
					ubicacion: String(warehouse._id),
					ubicacion_codigo: text(warehouse.codigo ?? warehouse.name),
					delta: -want,
					...lot,
				});
			}
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
				...lot,
				documento_tipo: 'pos-ticket',
				documento_id: return_id,
				documento_modelo: 'PosTickets',
				documento_nombre: text(ticket.name ?? ticket.ticket_sequence),
				documento_referencia: text(ticket.ticket_sequence),
				description: 'Devolución POS cancelada: se revierte su reingreso',
				cantidad: want,
				stock_total_previo: running,
				stock_total_resultante: resultante,
				stock_apartado_previo: apartado,
				stock_apartado_resultante: apartado,
				fecha_movimiento: new Date().toISOString(),
				dedupe_key: `pos-return-revert:${return_id}:${producto}@${text(warehouse?._id) || 'global'}:${index}`,
			});
			running = resultante;
			removal_left = round_quantity(removal_left - want);
		}
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
