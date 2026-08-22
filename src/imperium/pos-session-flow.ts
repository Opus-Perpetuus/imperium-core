/**
 * Sesión POS y tickets: create/update, consecutivo y cierre como el service original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const TICKET_TYPES = new Set(['VENTA', 'DEVOLUCION', 'RETIRO_MANUAL_CAJA']);
const INVALID_SIGNATURES = new Set([
	'null',
	'undefined',
	'[object object]',
	'[object file]',
	'[object blob]',
]);

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function round_money(value: number): number {
	return Number((Number(value) || 0).toFixed(2));
}

function actor_id(actor: ImperiumDoc | null): string {
	return text(actor?._id);
}

function normalize_branch_slug(name: string): string {
	const normalized = String(name ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-zA-Z0-9 ]+/g, ' ')
		.trim()
		.replace(/\s+/g, '-')
		.toUpperCase();
	return normalized || 'SIN-SUCURSAL';
}

function normalize_signature(value: unknown): string {
	if (typeof value !== 'string') return '';
	const normalized = value.trim();
	if (!normalized) return '';
	if (INVALID_SIGNATURES.has(normalized.toLowerCase())) return '';
	return normalized;
}

function usage_entry(params: {
	started_at?: string;
	used_by_user?: string;
	cashier?: unknown;
	cashier_name?: string;
	release_reason?: string;
	ended_at?: string;
}): ImperiumDoc {
	return {
		started_at: params.started_at ?? new Date().toISOString(),
		used_by_user: params.used_by_user ?? null,
		cashier: params.cashier ?? null,
		cashier_name: params.cashier_name ?? '',
		release_reason: params.release_reason ?? '',
		...(params.ended_at ? { ended_at: params.ended_at } : {}),
	};
}

function release_usage_history(session: ImperiumDoc, reason: string): ImperiumDoc[] {
	const history = as_array(session.usage_history).map(as_object);
	const last = history[history.length - 1];
	if (last && !last.ended_at) {
		last.ended_at = new Date().toISOString();
		last.release_reason = reason;
	}
	return history;
}

function activate_usage_history(
	session: ImperiumDoc,
	actor: ImperiumDoc | null,
	cashier: unknown,
	cashier_name: string,
): ImperiumDoc[] {
	const history = as_array(session.usage_history).map(as_object);
	const last = history[history.length - 1];
	if (last && !last.ended_at) {
		last.used_by_user = actor_id(actor) || text(last.used_by_user);
		last.cashier = cashier || last.cashier;
		last.cashier_name = cashier_name || text(last.cashier_name);
		return history;
	}
	history.push(
		usage_entry({
			used_by_user: actor_id(actor) || text(session.created_by),
			cashier,
			cashier_name,
		}),
	);
	return history;
}

async function resolve_branch_name(store: ImperiumStore, branch_id: string): Promise<string> {
	if (!branch_id) return 'SIN-SUCURSAL';
	const branch = store.has('branchoffice')
		? await store.find_id('branchoffice', branch_id)
		: null;
	return text(branch?.name ?? branch?._name) || 'SIN-SUCURSAL';
}

async function resolve_cashier_name(store: ImperiumStore, cashier_id: string): Promise<string> {
	if (!cashier_id || !store.has('employee')) return '';
	const employee = await store.find_id('employee', cashier_id);
	return text(employee?.name);
}

export function is_pos_session_open(doc: ImperiumDoc): boolean {
	const raw = text(doc.status ?? doc.estado).toLowerCase();
	return raw === 'abierta' || raw === 'open';
}

export async function preview_pos_consecutive(store: ImperiumStore): Promise<number> {
	let floor = 0;
	if (store.has('pos-session')) {
		const { rows } = await store.find_many('pos-session', {
			take: 5000,
			include_inactive: true,
			populate: false,
		});
		for (const row of rows) {
			const n = Number(row.consecutivo ?? 0);
			if (Number.isFinite(n)) floor = Math.max(floor, n);
		}
	}
	if (store.has('auto-increment-control')) {
		const { rows } = await store.find_many('auto-increment-control', {
			where: { increment_field: 'consecutivo' },
			take: 20,
			include_inactive: true,
			populate: false,
		});
		const hit =
			rows.find((row) => text(row.model_name) === 'PosSession') ??
			rows.find((row) => text(row.name) === 'PosSession.consecutivo');
		const current = Number(hit?.current_sequence ?? hit?.current ?? hit?.valor ?? 0);
		if (Number.isFinite(current)) floor = Math.max(floor, current);
	}
	return floor + 1;
}

export async function prepare_pos_session_create(
	store: ImperiumStore,
	doc: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const out = { ...doc };
	delete out._id;
	delete out.name;
	delete out.consecutivo;
	const opening = out.opening_date ?? new Date().toISOString();
	const branch_id = ref_id(out.branch_office) || text(out.branch_office);
	const opening_money = round_money(Number(out.cash_register_opening_money ?? 0));
	if (branch_id && Number.isFinite(opening_money)) {
		const last = await build_last_closure_reference(store, branch_id);
		const suggested = round_money(Number(last.suggested_opening_money ?? 0));
		const difference = round_money(opening_money - suggested);
		const reason = text(out.razon_de_diferencia_con_ultimo_cierre);
		if (difference !== 0 && !reason) {
			throw new Error('Debes especificar la razón de diferencia con el último cierre');
		}
		out.diferencia_de_ultimo_cierre = difference;
		out.razon_de_diferencia_con_ultimo_cierre = difference === 0 ? '' : reason;
	} else {
		out.diferencia_de_ultimo_cierre = 0;
		out.razon_de_diferencia_con_ultimo_cierre = '';
	}
	const consecutivo = await store.next_auto_increment('PosSession', 'consecutivo', {
		resource: 'pos-session',
	});
	const unix = Math.floor(new Date(String(opening)).getTime() / 1000);
	const slug = normalize_branch_slug(await resolve_branch_name(store, branch_id));
	const cashier = out.cashier ? ref_id(out.cashier) || out.cashier : undefined;
	const cashier_name = text(out.cashier_name) || (await resolve_cashier_name(store, text(cashier)));
	const uid = actor_id(actor);
	const on_use = out.on_use !== false;
	const history = on_use
		? [
				usage_entry({
					started_at: new Date().toISOString(),
					used_by_user: uid || text(out.created_by),
					cashier,
					cashier_name,
				}),
			]
		: [];
	return {
		...out,
		consecutivo,
		name: `SES-${consecutivo}-${slug}-${unix}`,
		status: 'abierta',
		estado: 'abierta',
		state: 'abierta',
		on_use,
		opening_date: opening,
		created_by: out.created_by ?? uid,
		cashier,
		cashier_name,
		cash_register_opening_money: opening_money,
		usage_history: history,
		branch_office: branch_id || out.branch_office,
	};
}

export async function prepare_pos_session_update(
	store: ImperiumStore,
	doc: ImperiumDoc,
	previous: ImperiumDoc | null,
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	if (!previous) throw new Error('No se encontró la sesión a actualizar');
	const out = { ...previous, ...doc };
	delete out.name;
	delete out.consecutivo;
	out.name = previous.name;
	out.consecutivo = previous.consecutivo;
	const cashier = out.cashier ? ref_id(out.cashier) || out.cashier : previous.cashier;
	const cashier_name =
		text(out.cashier_name) ||
		text(previous.cashier_name) ||
		(await resolve_cashier_name(store, text(cashier)));
	if (doc.on_use === true) {
		out.usage_history = activate_usage_history(previous, actor, cashier, cashier_name);
	}
	if (doc.on_use === false) {
		out.usage_history = release_usage_history(previous, text(doc.release_reason) || 'VIEW_EXIT');
	}
	out.cashier = cashier;
	out.cashier_name = cashier_name;
	return out;
}

export async function prepare_pos_ticket_create(
	store: ImperiumStore,
	doc: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	const session_id = text(doc.pos_session);
	if (!session_id) {
		throw new Error('Se requiere el id de la sesión POS para generar el ticket');
	}
	const current_user_id = actor_id(actor);
	if (!current_user_id) {
		throw new Error('No se pudo validar el usuario que intenta generar el ticket');
	}
	const session = await store.find_id('pos-session', session_id);
	if (!session) throw new Error('La sesión POS especificada no existe');
	if (session.is_active === false) {
		throw new Error('No se puede generar el ticket porque la sesión POS está inactiva');
	}
	if (!is_pos_session_open(session)) {
		throw new Error('No se puede generar el ticket porque la sesión POS no está abierta');
	}
	if (session.on_use === false) {
		throw new Error('No se puede generar el ticket porque la sesión POS no está en uso');
	}
	const history = as_array(session.usage_history).map(as_object);
	const active = [...history].reverse().find((entry) => !entry.ended_at);
	const usage_user = text(active?.used_by_user);
	const created_by = text(session.created_by);
	if (created_by !== current_user_id && usage_user !== current_user_id) {
		throw new Error(
			'No se puede generar el ticket porque la sesión POS no pertenece al usuario actual',
		);
	}
	const ticket_type = text(doc.ticket_type).toUpperCase() || 'VENTA';
	if (!TICKET_TYPES.has(ticket_type)) {
		throw new Error('El tipo de ticket especificado no es válido');
	}
	const out = {
		...doc,
		ticket_type,
		state: 'confirmado',
		pos_session: session_id,
		name: text(doc.name) || text(doc.ticket_sequence) || `Ticket ${new Date().toISOString()}`,
	};
	if (ticket_type !== 'RETIRO_MANUAL_CAJA') {
		out.withdrawal_amount = 0;
		out.withdrawal_reason = '';
		out.withdrawal_signature = '';
		return out;
	}
	const withdrawal_amount = Number(out.withdrawal_amount ?? 0);
	const withdrawal_reason = text(out.withdrawal_reason);
	const withdrawal_signature = normalize_signature(out.withdrawal_signature);
	if (!Number.isFinite(withdrawal_amount) || withdrawal_amount <= 0) {
		throw new Error('El retiro manual de caja requiere una cantidad mayor a 0');
	}
	if (!withdrawal_reason) {
		throw new Error('El retiro manual de caja requiere especificar un motivo');
	}
	if (!withdrawal_signature) {
		throw new Error('El retiro manual de caja requiere una firma válida');
	}
	out.withdrawal_amount = withdrawal_amount;
	out.withdrawal_reason = withdrawal_reason;
	out.withdrawal_signature = withdrawal_signature;
	return out;
}

export async function build_last_closure_reference(
	store: ImperiumStore,
	branch_office_id: string,
): Promise<ImperiumDoc> {
	const branch = text(branch_office_id);
	if (!branch) {
		throw new Error('Se necesita la sucursal para consultar el último cierre');
	}
	const { rows } = await store.find_many('pos-session', {
		take: 500,
		include_inactive: false,
		populate: false,
	});
	const closed = rows
		.filter((row) => ref_id(row.branch_office) === branch || text(row.branch_office) === branch)
		.filter((row) => {
			const status = text(row.status ?? row.estado).toLowerCase();
			return status === 'cerrada' || status === 'closed';
		})
		.sort((a, b) =>
			String(b.closing_date ?? b.fecha_cierre ?? '').localeCompare(
				String(a.closing_date ?? a.fecha_cierre ?? ''),
			),
		);
	const last = closed[0];
	if (!last) {
		return {
			found: false,
			branch_office_id: branch,
			total_sales: 0,
			last_closure_amount: 0,
			suggested_opening_money: 0,
		};
	}
	const tickets = store.has('pos-tickets')
		? (
				await store.find_many('pos-tickets', {
					where: { pos_session: String(last._id) },
					take: 2000,
					populate: false,
				})
			).rows
		: [];
	let total_sales = 0;
	let withdrawals = 0;
	for (const ticket of tickets) {
		const type = text(ticket.ticket_type).toUpperCase();
		if (type.includes('RETIRO')) {
			withdrawals += Math.abs(Number(ticket.withdrawal_amount || ticket.subtotal || 0));
		} else {
			total_sales += Number(ticket.subtotal ?? ticket.total ?? 0);
		}
	}
	const opening = round_money(Number(last.cash_register_opening_money ?? 0));
	return {
		found: true,
		branch_office_id: branch,
		last_session_id: last._id,
		last_session_name: last.name,
		closing_date: last.closing_date ?? last.fecha_cierre,
		total_sales: round_money(total_sales),
		last_closure_amount: round_money(opening + total_sales - withdrawals),
		suggested_opening_money: opening,
	};
}

export function conclude_pos_session_patch(session: ImperiumDoc): ImperiumDoc {
	const closed_at = new Date().toISOString();
	return {
		status: 'cerrada',
		estado: 'cerrada',
		on_use: false,
		closing_date: closed_at,
		fecha_cierre: closed_at,
		usage_history: release_usage_history(session, 'CIERRE_CAJA'),
	};
}

export function cancel_pos_session_patch(session: ImperiumDoc): ImperiumDoc {
	const closed_at = new Date().toISOString();
	return {
		status: 'cancelada',
		estado: 'cancelada',
		on_use: false,
		closing_date: closed_at,
		fecha_cancelacion: closed_at,
		usage_history: release_usage_history(session, 'SESSION_CANCELED'),
	};
}
