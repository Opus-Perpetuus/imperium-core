/**
 * Apartados del POS sobre los tickets, sin tablas nuevas:
 *
 * - `APARTADO`: cliente, artículos, total (`subtotal`) y un anticipo en
 *   `payments`. Aparta la existencia (`existenciaApartada`) sin sacarla.
 * - `ABONO_APARTADO`: pago ligado al apartado (`original_ticket`); no pasa
 *   del saldo. Cuando el saldo llega a 0 el apartado se liquida: se libera lo
 *   apartado y sale del inventario como una venta.
 * - Cancelar libera lo apartado; el dinero ya cobrado se regresa aparte.
 *   También si se cancela por el CRUD (estado cancelado, inactivo o borrado).
 * - Kits: se valida y se aparta la existencia de sus componentes. Al liberar se
 *   regresa exactamente lo que se apartó (según sus movimientos).
 * - Al liquidar se crea un ticket `VENTA` (forma de pago `apartado`, sin efecto
 *   en caja) y la salida de inventario queda ligada a esa venta, así se puede
 *   devolver como cualquier venta.
 *
 * `layaway_status`: abierto → liquidado | cancelado.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { find_warehouse_location } from './delivery-return-flow.ts';
import { register_pos_ticket_exit } from './inventory-exit.ts';
import { round_quantity } from './inventory-picking.ts';
import { expand_kit_quantities } from './pos-product-rules.ts';
import { PAYMENT_CASH, PAYMENT_METHODS, read_payments } from './pos-payments.ts';
import type { ImperiumStore } from './store.ts';

export const TICKET_APARTADO = 'APARTADO';
export const TICKET_ABONO_APARTADO = 'ABONO_APARTADO';
export const LAYAWAY_OPEN = 'abierto';
export const LAYAWAY_PAID = 'liquidado';
export const LAYAWAY_CANCELLED = 'cancelado';
const CANCELLED = new Set(['cancelado', 'canceled', 'cancelled']);
const METHODS = new Set<string>(PAYMENT_METHODS);

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

function money(n: number): number {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function live(t: ImperiumDoc): boolean {
	return t.is_active !== false && !CANCELLED.has(text(t.state ?? t.estado).toLowerCase());
}

function type_of(t: ImperiumDoc): string {
	return text(t.ticket_type).toUpperCase();
}

export function is_layaway(t: ImperiumDoc): boolean {
	return type_of(t) === TICKET_APARTADO;
}

function qty_by_product(items: unknown): Map<string, { qty: number; name: string }> {
	const out = new Map<string, { qty: number; name: string }>();
	for (const item of as_array(typeof items === 'string' ? safe_json(items) : items).map(as_object)) {
		const id = text(item.item_id ?? item.producto ?? item.product_id);
		const qty = Number(item.quantity ?? item.cantidad ?? 0);
		if (!id || !(qty > 0)) continue;
		const prev = out.get(id);
		out.set(id, { qty: round_quantity((prev?.qty ?? 0) + qty), name: text(item.item_name) || prev?.name || id });
	}
	return out;
}

function safe_json(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

function validate_payments(doc: ImperiumDoc): { amount: number; payment_method: string } {
	const raw = as_array(doc.payments).map(as_object);
	for (const p of raw) {
		const method = text(p.method).toLowerCase();
		if (!METHODS.has(method)) throw new Error(`Forma de pago no válida: ${method || '(vacía)'}`);
		if (!(Number(p.amount) > 0)) throw new Error('Cada forma de pago necesita un monto mayor a 0');
	}
	const payments = read_payments(doc);
	const methods = [...new Set(payments.map((p) => p.method))];
	return {
		amount: money(payments.reduce((s, p) => s + p.amount, 0)),
		payment_method: methods.length === 1 ? methods[0] : methods.length ? 'mixto' : PAYMENT_CASH,
	};
}

/** Pagado del apartado: anticipo más abonos vivos. */
export async function layaway_paid(store: ImperiumStore, layaway: ImperiumDoc, except = ''): Promise<number> {
	let paid = money(Number(layaway.total_paid ?? 0));
	for await (const page of store.scan('pos-tickets', { where: { original_ticket: String(layaway._id ?? '') } })) {
		for (const t of page) {
			if (String(t._id ?? '') === except || !live(t) || type_of(t) !== TICKET_ABONO_APARTADO) continue;
			paid = money(paid + Number(t.subtotal ?? 0));
		}
	}
	return paid;
}

async function load_layaway(store: ImperiumStore, id: string): Promise<ImperiumDoc> {
	const layaway = id ? await store.find_id('pos-tickets', id) : null;
	if (!layaway || !is_layaway(layaway)) throw new Error('El apartado no existe');
	if (!live(layaway)) throw new Error('El apartado está cancelado o inactivo');
	return layaway;
}

/** Reglas al crear un apartado o un abono a apartado; otros tickets pasan intactos. */
export async function prepare_layaway_rules(store: ImperiumStore, doc: ImperiumDoc): Promise<ImperiumDoc> {
	const type = type_of(doc);
	if (type === TICKET_APARTADO) {
		if (!text(doc.client_id)) throw new Error('El apartado requiere un cliente');
		const total = money(Number(doc.subtotal ?? 0));
		if (!(total > 0)) throw new Error('El apartado requiere artículos con importe');
		const items = qty_by_product(doc.items);
		if (!items.size) throw new Error('El apartado no tiene artículos');
		const { amount, payment_method } = validate_payments(doc);
		if (!(amount > 0)) throw new Error('El apartado requiere un anticipo mayor a 0');
		if (amount - total > 0.005) throw new Error('El anticipo no puede pasar del total del apartado');
		if (store.has('products')) {
			for (const [id, qty] of await reserve_quantities(store, doc)) {
				const product = await store.find_id('products', id);
				if (!product) continue;
				const name = text(product.name) || items.get(id)?.name || id;
				const free = round_quantity(Number(product.existencia ?? 0) - Math.max(Number(product.existenciaApartada ?? 0), 0));
				if (qty > free) throw new Error(`No hay existencia libre para apartar ${qty} de ${name} (libre ${free})`);
			}
		}
		return {
			...doc,
			payments: read_payments(doc),
			payment_method,
			total_paid: amount,
			change: 0,
			layaway_status: LAYAWAY_OPEN,
		};
	}
	if (type === TICKET_ABONO_APARTADO) {
		const layaway = await load_layaway(store, text(doc.original_ticket));
		if (text(layaway.layaway_status) !== LAYAWAY_OPEN) {
			throw new Error(`El apartado ya está ${text(layaway.layaway_status) || 'cerrado'}`);
		}
		const amount = money(Number(doc.subtotal ?? 0));
		if (!(amount > 0)) throw new Error('El abono requiere un importe mayor a 0');
		if (as_array(doc.payments).length) {
			const paid = validate_payments(doc);
			if (Math.abs(paid.amount - amount) > 0.005) throw new Error('Las formas de pago deben sumar el abono');
		}
		const balance = money(Number(layaway.subtotal ?? 0) - (await layaway_paid(store, layaway, String(doc._id ?? ''))));
		if (amount - balance > 0.005) throw new Error(`El abono pasa del saldo del apartado (${balance.toFixed(2)})`);
		const payments = read_payments(doc);
		const methods = [...new Set(payments.map((p) => p.method))];
		return {
			...doc,
			...(payments.length
				? { payments, payment_method: methods.length === 1 ? methods[0] : 'mixto' }
				: {}),
			client_id: text(doc.client_id) || text(layaway.client_id),
			client_name: text(doc.client_name) || text(layaway.client_name),
			total_paid: amount,
			change: 0,
			items: [],
		};
	}
	return doc;
}

/** Lo que aparta un apartado: sus artículos, con los kits cambiados por sus componentes. */
async function reserve_quantities(store: ImperiumStore, layaway: ImperiumDoc): Promise<Map<string, number>> {
	const plain = new Map([...qty_by_product(layaway.items)].map(([id, v]) => [id, v.qty]));
	return expand_kit_quantities(store, plain);
}

/** Lo que sigue apartado según los movimientos del apartado; null si no hay bitácora. */
async function reserved_by_movements(store: ImperiumStore, layaway: ImperiumDoc): Promise<Map<string, number> | null> {
	if (!store.has('inventory-movement')) return null;
	const out = new Map<string, number>();
	let seen = false;
	for await (const page of store.scan('inventory-movement', {
		where: { documento_id: String(layaway._id ?? ''), documento_tipo: 'pos-ticket' },
	})) {
		for (const m of page) {
			const tipo = text(m.tipo_movimiento);
			if (tipo !== 'apartado_logistica' && tipo !== 'liberacion_logistica') continue;
			seen = true;
			const id = text(m.producto ?? m.producto_id);
			const q = Number(m.cantidad ?? 0) * (tipo === 'apartado_logistica' ? 1 : -1);
			if (id) out.set(id, round_quantity((out.get(id) ?? 0) + q));
		}
	}
	if (!seen) return null;
	for (const [id, q] of out) if (q <= 0) out.delete(id);
	return out;
}

async function move_reserved(
	store: ImperiumStore,
	layaway: ImperiumDoc,
	sign: 1 | -1,
	reason: string,
): Promise<void> {
	if (!store.has('products')) return;
	const warehouse = store.has('inventory-movement') ? await find_warehouse_location(store) : null;
	const quantities =
		sign > 0
			? await reserve_quantities(store, layaway)
			: ((await reserved_by_movements(store, layaway)) ?? (await reserve_quantities(store, layaway)));
	for (const [id, qty] of quantities) {
		const product = await store.find_id('products', id);
		if (!product) continue;
		const previo = round_quantity(Math.max(Number(product.existenciaApartada ?? 0), 0));
		const resultante = round_quantity(Math.max(previo + sign * qty, 0));
		await store.update('products', id, { existenciaApartada: resultante });
		if (!store.has('inventory-movement')) continue;
		const total = round_quantity(Number(product.existencia ?? 0));
		await store.insert('inventory-movement', {
			name: `${sign > 0 ? 'Apartado' : 'Liberación'} POS ${text(product.name) || id}`,
			producto: id,
			producto_id: id,
			producto_nombre: product.name,
			producto_codigo: product.codigo,
			tipo_movimiento: sign > 0 ? 'apartado_logistica' : 'liberacion_logistica',
			ubicacion_origen: warehouse?._id,
			ubicacion_origen_id: warehouse?._id,
			ubicacion_origen_nombre: warehouse?.name,
			documento_tipo: 'pos-ticket',
			documento_id: String(layaway._id ?? ''),
			documento_modelo: 'PosTickets',
			documento_nombre: text(layaway.ticket_sequence),
			documento_referencia: text(layaway.ticket_sequence),
			description: reason,
			cantidad: qty,
			stock_total_previo: total,
			stock_total_resultante: total,
			stock_apartado_previo: previo,
			stock_apartado_resultante: resultante,
			fecha_movimiento: new Date().toISOString(),
			dedupe_key: `pos-layaway:${String(layaway._id ?? '')}:${sign > 0 ? 'reserve' : 'release'}:${id}`,
		});
	}
}

/** Efectos después de crear: aparta existencia, o liquida el apartado cuando el abono cubre el saldo. */
export async function register_layaway_effects(store: ImperiumStore, created: ImperiumDoc): Promise<ImperiumDoc | null> {
	const type = type_of(created);
	if (type === TICKET_APARTADO) {
		await move_reserved(store, created, 1, 'Existencia apartada desde el punto de venta');
		return null;
	}
	if (type !== TICKET_ABONO_APARTADO) return null;
	const layaway = await store.find_id('pos-tickets', text(created.original_ticket));
	if (!layaway || !is_layaway(layaway) || text(layaway.layaway_status) !== LAYAWAY_OPEN) return null;
	const balance = money(Number(layaway.subtotal ?? 0) - (await layaway_paid(store, layaway)));
	if (balance > 0.005) return null;
	await move_reserved(store, layaway, -1, 'Apartado liquidado: se entrega al cliente');
	const sale = await insert_layaway_sale(store, layaway, created);
	await register_pos_ticket_exit(store, sale);
	return store.update('pos-tickets', String(layaway._id), { layaway_status: LAYAWAY_PAID });
}

export const PAYMENT_LAYAWAY = 'apartado';

/** Ticket de venta del apartado liquidado. Ya se cobró en anticipo y abonos: no mueve la caja. */
async function insert_layaway_sale(store: ImperiumStore, layaway: ImperiumDoc, abono: ImperiumDoc): Promise<ImperiumDoc> {
	const total = money(Number(layaway.subtotal ?? 0));
	const folio = `${text(layaway.ticket_sequence) || String(layaway._id ?? '')}-V`;
	return store.insert('pos-tickets', {
		name: folio,
		ticket_sequence: folio,
		ticket_type: 'VENTA',
		state: 'confirmado',
		pos_session: text(abono.pos_session) || text(layaway.pos_session),
		original_ticket: String(layaway._id ?? ''),
		client_id: layaway.client_id,
		client_name: layaway.client_name,
		client_lastname: layaway.client_lastname,
		client_home: layaway.client_home,
		items: as_array(typeof layaway.items === 'string' ? safe_json(layaway.items) : layaway.items),
		subtotal: total,
		total_paid: total,
		change: 0,
		payments: [{ method: PAYMENT_LAYAWAY, amount: total }],
		payment_method: PAYMENT_LAYAWAY,
		withdrawal_amount: 0,
		withdrawal_reason: '',
		withdrawal_signature: '',
	});
}

/** Apartado cancelado por el CRUD (estado, inactivo o borrado) estando abierto: libera lo apartado. */
export async function release_layaway_on_cancel(
	store: ImperiumStore,
	previous: ImperiumDoc | null,
	current: ImperiumDoc | null,
): Promise<boolean> {
	if (!previous || !is_layaway(previous) || !live(previous)) return false;
	if (text(previous.layaway_status || LAYAWAY_OPEN) !== LAYAWAY_OPEN) return false;
	if (current && live(current) && text(current.layaway_status || LAYAWAY_OPEN) !== LAYAWAY_CANCELLED) return false;
	await move_reserved(store, previous, -1, 'Apartado cancelado: se libera la existencia');
	await store.update('pos-tickets', String(previous._id), { layaway_status: LAYAWAY_CANCELLED });
	return true;
}

/** Cancela un apartado abierto: libera lo apartado. Lo cobrado se regresa con un retiro. */
export async function cancel_layaway(store: ImperiumStore, id: string) {
	const layaway = await load_layaway(store, id);
	if (text(layaway.layaway_status) !== LAYAWAY_OPEN) {
		throw new Error(`El apartado ya está ${text(layaway.layaway_status) || 'cerrado'}`);
	}
	await move_reserved(store, layaway, -1, 'Apartado cancelado: se libera la existencia');
	await store.update('pos-tickets', String(layaway._id), { layaway_status: LAYAWAY_CANCELLED });
	return { ...(await layaway_lookup(store, { id })), por_regresar: await layaway_paid(store, layaway) };
}

/** Apartado por id o folio con lo pagado, el saldo y sus abonos. */
export async function layaway_lookup(store: ImperiumStore, q: { id?: string | null; folio?: string | null }) {
	let layaway: ImperiumDoc | null = null;
	if (text(q.id)) layaway = await store.find_id('pos-tickets', text(q.id));
	else if (text(q.folio)) {
		for await (const page of store.scan('pos-tickets', { where: { ticket_sequence: text(q.folio) } })) {
			layaway = page.find((t) => is_layaway(t)) ?? layaway;
		}
	} else throw new Error('Indica el folio del apartado');
	if (!layaway || !is_layaway(layaway)) throw new Error('No se encontró el apartado');
	const abonos: ImperiumDoc[] = [];
	let venta = '';
	for await (const page of store.scan('pos-tickets', { where: { original_ticket: String(layaway._id ?? '') } })) {
		for (const t of page) {
			if (live(t) && type_of(t) === 'VENTA') venta = text(t.ticket_sequence);
			if (live(t) && type_of(t) === TICKET_ABONO_APARTADO) {
				abonos.push({ _id: t._id, folio: t.ticket_sequence, importe: money(Number(t.subtotal ?? 0)), fecha: t.createdAt ?? t.created_at });
			}
		}
	}
	const total = money(Number(layaway.subtotal ?? 0));
	const pagado = await layaway_paid(store, layaway);
	return {
		_id: String(layaway._id ?? ''),
		folio: text(layaway.ticket_sequence),
		cliente_id: text(layaway.client_id),
		cliente_nombre: `${text(layaway.client_name)} ${text(layaway.client_lastname)}`.trim(),
		estado: text(layaway.layaway_status) || LAYAWAY_OPEN,
		items: [...qty_by_product(layaway.items)].map(([item_id, v]) => ({ item_id, item_name: v.name, quantity: v.qty })),
		total,
		anticipo: money(Number(layaway.total_paid ?? 0)),
		pagado,
		saldo: money(Math.max(total - pagado, 0)),
		abonos,
		...(venta ? { venta } : {}),
	};
}
