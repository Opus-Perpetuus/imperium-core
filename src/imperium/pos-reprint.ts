/** Ticket POS por folio para reimprimirlo (o imprimirlo como remisión). */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export async function pos_ticket_by_folio(store: ImperiumStore, folio: string | null): Promise<ImperiumDoc> {
	const wanted = String(folio ?? '').trim();
	if (!wanted) throw new Error('Indica el folio del ticket');
	let found: ImperiumDoc | null = null;
	for await (const page of store.scan('pos-tickets', { where: { ticket_sequence: wanted } })) {
		found = page[0] ?? found;
		if (found) break;
	}
	if (!found) throw new Error(`No se encontró el ticket ${wanted}`);
	let items: unknown = found.items;
	if (typeof items === 'string') {
		try {
			items = JSON.parse(items);
		} catch {
			items = [];
		}
	}
	return { ...found, items: Array.isArray(items) ? items : [] };
}

export const REPRINT_TICKET = 'ticket';
export const REPRINT_REMISION = 'remision';

function actor_name(actor: ImperiumDoc | null): string {
	if (!actor) return '';
	return String(actor.name ?? actor.nombre ?? actor.username ?? actor.email ?? '').trim();
}

function log_of(ticket: ImperiumDoc): ImperiumDoc[] {
	let raw: unknown = ticket.reprint_log;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			raw = [];
		}
	}
	return Array.isArray(raw) ? (raw as ImperiumDoc[]) : [];
}

/**
 * Registra una reimpresión (quién y cuándo) y, si es remisión, le asigna su
 * consecutivo propio la primera vez (`remision_numero`, `remision_folio`
 * REM-000001). Devuelve el ticket listo para imprimir con `copia`.
 */
export async function register_pos_reprint(
	store: ImperiumStore,
	body: { id?: unknown; folio?: unknown; tipo?: unknown },
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const tipo = String(body.tipo ?? REPRINT_TICKET).trim().toLowerCase();
	if (tipo !== REPRINT_TICKET && tipo !== REPRINT_REMISION) throw new Error('tipo debe ser "ticket" o "remision"');
	const id = String(body.id ?? '').trim();
	const ticket = id ? await store.find_id('pos-tickets', id) : await pos_ticket_by_folio(store, String(body.folio ?? ''));
	if (!ticket) throw new Error('No se encontró el ticket');
	const ticket_id = String(ticket._id ?? '');
	const patch: ImperiumDoc = {};
	let remision_numero = Number(ticket.remision_numero ?? 0) || 0;
	let remision_folio = String(ticket.remision_folio ?? '').trim();
	const first_remision = tipo === REPRINT_REMISION && !remision_folio;
	if (first_remision) {
		remision_numero = await store.next_auto_increment('PosTickets', 'remision_numero', { resource: 'pos-tickets' });
		remision_folio = `REM-${String(remision_numero).padStart(6, '0')}`;
		patch.remision_numero = remision_numero;
		patch.remision_folio = remision_folio;
	}
	const log = log_of(ticket);
	// La primera remisión de un ticket es original; todo lo demás es copia.
	const copia = !first_remision;
	log.push({
		tipo,
		copia,
		fecha: new Date().toISOString(),
		usuario_id: actor ? String(actor._id ?? '') : '',
		usuario: actor_name(actor),
	});
	patch.reprint_log = log;
	await store.update('pos-tickets', ticket_id, patch);
	const fresh = (await store.find_id('pos-tickets', ticket_id)) ?? { ...ticket, ...patch };
	const items = typeof fresh.items === 'string' ? safe_items(fresh.items) : fresh.items;
	return {
		...fresh,
		items: Array.isArray(items) ? items : [],
		reprint_log: log,
		remision_folio,
		remision_numero: remision_numero || undefined,
		copia,
	};
}

function safe_items(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}
