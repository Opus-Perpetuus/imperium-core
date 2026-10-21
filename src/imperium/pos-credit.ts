/**
 * Crédito a clientes y cuentas por cobrar del POS, sin tablas nuevas:
 *
 * - Términos: en el contacto, campos personalizados `credito_limite` y
 *   `credito_dias` (`custom_data`). Sin límite mayor a 0 no hay crédito.
 * - Cargo: venta con una parte pagada con `credito` (requiere cliente y cabe
 *   en el límite disponible).
 * - Abono: ticket `ABONO_CREDITO` del cliente; no puede pasar del saldo.
 * - Devolución de una venta a crédito: el reembolso baja primero el saldo de
 *   esa venta y solo el resto sale de la caja.
 * - Antigüedad: los abonos se aplican a los cargos más viejos (FIFO) y cada
 *   cargo vence a `credito_dias` de la venta.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import { read_payments } from './pos-payments.ts';
import { AGING_BUCKETS, aging_bucket, type AgingBucket } from './supplier-aging.ts';
import type { ImperiumStore } from './store.ts';

export const CREDIT_METHOD = 'credito';
export const TICKET_ABONO = 'ABONO_CREDITO';
const CANCELLED = new Set(['cancelado', 'canceled', 'cancelled']);
const DAY = 86_400_000;

function text(v: unknown): string {
	return v == null ? '' : String(v).trim();
}

function money(n: number): number {
	return Math.round((Number(n) || 0) * 100) / 100;
}

function live(t: ImperiumDoc): boolean {
	return t.is_active !== false && !CANCELLED.has(text(t.state ?? t.estado).toLowerCase());
}

function custom_data(doc: ImperiumDoc): ImperiumDoc {
	const raw = doc.custom_data;
	if (typeof raw === 'string') {
		try {
			return as_object(JSON.parse(raw));
		} catch {
			return {};
		}
	}
	return as_object(raw);
}

export type CreditTerms = { limite: number; dias: number };

export async function client_credit_terms(store: ImperiumStore, client_id: string): Promise<CreditTerms | null> {
	if (!client_id || !store.has('contacto')) return null;
	const contact = await store.find_id('contacto', client_id);
	if (!contact) return null;
	const data = custom_data(contact);
	const limite = Number(data.credito_limite ?? contact.credito_limite ?? 0);
	const dias = Number(data.credito_dias ?? contact.credito_dias ?? 0);
	if (!Number.isFinite(limite) || limite <= 0) return null;
	return { limite: money(limite), dias: Number.isFinite(dias) && dias > 0 ? Math.trunc(dias) : 0 };
}

export function credit_amount(ticket: ImperiumDoc): number {
	return money(read_payments(ticket).filter((p) => p.method === CREDIT_METHOD).reduce((s, p) => s + p.amount, 0));
}

function ticket_time(t: ImperiumDoc): number {
	const v = new Date(String(t.createdAt ?? t.created_at ?? '')).getTime();
	return Number.isFinite(v) ? v : 0;
}

export type LedgerEntry = {
	_id: string;
	folio: string;
	fecha: string;
	tipo: 'cargo' | 'abono' | 'devolucion';
	importe: number;
	original_ticket?: string;
};

async function client_tickets(store: ImperiumStore, client_id: string): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	if (!store.has('pos-tickets')) return out;
	for await (const page of store.scan('pos-tickets', { where: { client_id } })) {
		for (const t of page) if (live(t)) out.push(t);
	}
	return out.sort((a, b) => ticket_time(a) - ticket_time(b));
}

export function ledger_of(tickets: ImperiumDoc[]): LedgerEntry[] {
	const out: LedgerEntry[] = [];
	for (const t of tickets) {
		const type = text(t.ticket_type).toUpperCase() || 'VENTA';
		const base = {
			_id: String(t._id ?? ''),
			folio: text(t.ticket_sequence),
			fecha: new Date(ticket_time(t)).toISOString(),
		};
		if (type === 'VENTA') {
			const amount = credit_amount(t);
			if (amount > 0) out.push({ ...base, tipo: 'cargo', importe: amount });
		} else if (type === 'DEVOLUCION') {
			const amount = credit_amount(t);
			if (amount > 0) out.push({ ...base, tipo: 'devolucion', importe: -amount, original_ticket: text(t.original_ticket) });
		} else if (type === TICKET_ABONO) {
			const amount = money(Number(t.subtotal ?? 0));
			if (amount > 0) out.push({ ...base, tipo: 'abono', importe: -amount });
		}
	}
	return out;
}

export function balance_of(ledger: LedgerEntry[]): number {
	return money(ledger.reduce((s, e) => s + e.importe, 0));
}

export async function client_balance(store: ImperiumStore, client_id: string): Promise<number> {
	return balance_of(ledger_of(await client_tickets(store, client_id)));
}

/**
 * Reglas de crédito al crear un ticket (después de validar las formas de pago):
 * venta con parte a crédito y abonos. Devuelve el documento sin cambios si no aplica.
 */
export async function prepare_credit_rules(store: ImperiumStore, doc: ImperiumDoc): Promise<ImperiumDoc> {
	const type = text(doc.ticket_type).toUpperCase();
	const client_id = text(doc.client_id);
	if (type === 'VENTA') {
		const amount = credit_amount(doc);
		if (amount <= 0) return doc;
		if (!client_id) throw new Error('La venta a crédito requiere un cliente');
		const terms = await client_credit_terms(store, client_id);
		if (!terms) throw new Error('El cliente no tiene crédito autorizado (credito_limite)');
		const balance = await client_balance(store, client_id);
		const available = money(terms.limite - balance);
		if (amount - available > 0.005) {
			throw new Error(`Crédito insuficiente: disponible ${available.toFixed(2)} de ${terms.limite.toFixed(2)}`);
		}
		return doc;
	}
	if (type === TICKET_ABONO) {
		if (!client_id) throw new Error('El abono requiere un cliente');
		const amount = money(Number(doc.subtotal ?? 0));
		if (!(amount > 0)) throw new Error('El abono requiere un importe mayor a 0');
		if (read_payments(doc).some((p) => p.method === CREDIT_METHOD)) {
			throw new Error('Un abono no se puede pagar con crédito');
		}
		const balance = await client_balance(store, client_id);
		if (amount - balance > 0.005) {
			throw new Error(`El abono pasa del saldo del cliente (${balance.toFixed(2)})`);
		}
		return { ...doc, items: [] };
	}
	return doc;
}

/**
 * Parte del reembolso de una devolución que baja el saldo a crédito de la
 * venta original (lo que quedaba a crédito de esa venta, menos lo ya devuelto a crédito).
 */
export async function credit_refund_for_return(
	store: ImperiumStore,
	original: ImperiumDoc,
	refund: number,
	except = '',
): Promise<number> {
	const original_credit = credit_amount(original);
	if (original_credit <= 0 || refund <= 0) return 0;
	let already = 0;
	for await (const page of store.scan('pos-tickets', { where: { original_ticket: String(original._id ?? '') } })) {
		for (const t of page) {
			if (String(t._id ?? '') === except || !live(t)) continue;
			if (text(t.ticket_type).toUpperCase() !== 'DEVOLUCION') continue;
			already += credit_amount(t);
		}
	}
	return money(Math.max(Math.min(refund, original_credit - already), 0));
}

function day_start(raw: unknown): number | null {
	const value = text(raw);
	if (!value) return null;
	const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
	if (Number.isNaN(d.getTime())) return null;
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function local_day(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type OpenCharge = {
	_id: string;
	folio: string;
	fecha: string;
	vence: string;
	importe: number;
	saldo: number;
	dias_vencida: number;
	tramo: AgingBucket;
};

/** Cargos con saldo tras aplicar abonos y devoluciones (las devoluciones a su venta, los abonos FIFO). */
export function open_charges(ledger: LedgerEntry[], dias: number, corte: number): OpenCharge[] {
	const charges = ledger
		.filter((e) => e.tipo === 'cargo')
		.map((e) => ({ ...e, saldo: e.importe }));
	for (const ret of ledger.filter((e) => e.tipo === 'devolucion')) {
		const target = charges.find((c) => c._id === ret.original_ticket);
		let rest = -ret.importe;
		for (const c of target ? [target, ...charges] : charges) {
			if (rest <= 0) break;
			const take = Math.min(c.saldo, rest);
			c.saldo = money(c.saldo - take);
			rest = money(rest - take);
		}
	}
	let pool = money(-ledger.filter((e) => e.tipo === 'abono').reduce((s, e) => s + e.importe, 0));
	for (const c of charges) {
		const take = Math.min(c.saldo, pool);
		c.saldo = money(c.saldo - take);
		pool = money(pool - take);
	}
	return charges
		.filter((c) => c.saldo > 0)
		.map((c) => {
			const start = day_start(c.fecha) ?? 0;
			const due = start + dias * DAY;
			const dias_vencida = Math.floor((corte - due) / DAY);
			return {
				_id: c._id,
				folio: c.folio,
				fecha: c.fecha,
				vence: local_day(due),
				importe: c.importe,
				saldo: c.saldo,
				dias_vencida,
				tramo: aging_bucket(dias_vencida),
			};
		});
}

/** Estado de cuenta de un cliente: movimientos con saldo corrido, cargos abiertos y términos. */
export async function client_statement(store: ImperiumStore, client_id: string, corte?: string | null) {
	if (!text(client_id)) throw new Error('Indica el cliente');
	const cut = day_start(corte || new Date().toISOString());
	if (cut == null) throw new Error(`Fecha de corte inválida: ${String(corte)}`);
	const tickets = await client_tickets(store, client_id);
	const ledger = ledger_of(tickets);
	const terms = await client_credit_terms(store, client_id);
	let running = 0;
	const movimientos = ledger.map((e) => {
		running = money(running + e.importe);
		return { ...e, saldo: running };
	});
	const saldo = balance_of(ledger);
	return {
		cliente: client_id,
		corte: local_day(cut),
		limite: terms?.limite ?? 0,
		dias: terms?.dias ?? 0,
		saldo,
		disponible: terms ? money(terms.limite - saldo) : 0,
		movimientos,
		cargos_abiertos: open_charges(ledger, terms?.dias ?? 0, cut),
	};
}

/**
 * Antigüedad de saldos de todos los clientes con crédito usado en el POS.
 * Con `pagina`/`por_pagina` regresa solo esa página de clientes (los totales
 * siguen siendo de todos); sin ellos, todos los clientes como antes.
 */
export async function clients_aging(
	store: ImperiumStore,
	corte?: string | null,
	paging: { pagina?: string | number | null; por_pagina?: string | number | null } = {},
) {
	const cut = day_start(corte || new Date().toISOString());
	if (cut == null) throw new Error(`Fecha de corte inválida: ${String(corte)}`);
	const by_client = new Map<string, { nombre: string; tickets: ImperiumDoc[] }>();
	if (store.has('pos-tickets')) {
		for await (const page of store.scan('pos-tickets', {})) {
			for (const t of page) {
				const id = text(t.client_id);
				if (!id || !live(t)) continue;
				const entry = by_client.get(id) ?? {
					nombre: `${text(t.client_name)} ${text(t.client_lastname)}`.trim(),
					tickets: [],
				};
				entry.tickets.push(t);
				by_client.set(id, entry);
			}
		}
	}
	const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
	const clientes = [];
	for (const [id, { nombre, tickets }] of by_client) {
		const ledger = ledger_of(tickets.sort((a, b) => ticket_time(a) - ticket_time(b)));
		if (!ledger.length) continue;
		const terms = await client_credit_terms(store, id);
		const open = open_charges(ledger, terms?.dias ?? 0, cut);
		const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
		for (const c of open) buckets[c.tramo] = money(buckets[c.tramo] + c.saldo);
		const saldo = money(open.reduce((s, c) => s + c.saldo, 0));
		if (saldo <= 0) continue;
		for (const b of AGING_BUCKETS) totals[b] = money(totals[b] + buckets[b]);
		clientes.push({ cliente_id: id, cliente_nombre: nombre, limite: terms?.limite ?? 0, saldo, ...buckets });
	}
	clientes.sort((a, b) => b.saldo - a.saldo);
	const size = Math.floor(Number(paging.por_pagina ?? 0));
	const paged = Number.isFinite(size) && size > 0;
	const page = paged ? Math.max(Math.floor(Number(paging.pagina ?? 1)) || 1, 1) : 1;
	return {
		corte: local_day(cut),
		saldo: money(clientes.reduce((s, c) => s + c.saldo, 0)),
		...totals,
		clientes: paged ? clientes.slice((page - 1) * size, page * size) : clientes,
		...(paged ? { pagina: page, por_pagina: size, total_clientes: clientes.length } : {}),
	};
}
