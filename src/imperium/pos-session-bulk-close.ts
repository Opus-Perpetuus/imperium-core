/**
 * Cierre masivo de sesiones POS abiertas (ticket #106), portado del backend
 * Mongo (PR 448) al núcleo v13. Solo el superadministrador semilla puede
 * usarlo y no pide el PIN de cada cajero. Omite las sesiones en uso, con
 * pedido abierto o sin conexión salvo `force: true`; con `dry_run: true` solo
 * informa qué se cerraría.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { is_seed_admin } from './group-access.ts';
import {
	expected_cash_of,
	is_pos_session_open,
	release_usage_history,
	round_money,
	session_employee_name,
	ticket_summaries_for_session,
	total_sales_of,
} from './pos-session-flow.ts';
import type { ImperiumStore } from './store.ts';

export const BULK_CLOSE_MAX_SESSIONS = 100;
export const BULK_CLOSE_REASON_MIN = 5;
export const BULK_CLOSE_REASON_MAX = 300;
export const BULK_CLOSE_RELEASE_REASON = 'SUPER_ADMIN_BULK_CLOSE';

export type BulkCloseSkipCode =
	| 'not_found'
	| 'not_open'
	| 'on_use'
	| 'open_order'
	| 'offline'
	| 'changed';

const SKIP_REASONS: Record<BulkCloseSkipCode, string> = {
	not_found: 'No existe',
	not_open: 'No está abierta',
	on_use: 'Un cajero la tiene en uso',
	open_order: 'Tiene un pedido abierto en caja',
	offline: 'Trabaja sin conexión: puede tener tickets sin sincronizar',
	changed: 'Cambió mientras se cerraba',
};

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function http_error(message: string, status: number, code: string): Error {
	return Object.assign(new Error(message), { status, code });
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return text((value as { _id?: unknown })._id);
	return text(value);
}

export function bulk_close_blocker(session: ImperiumDoc): BulkCloseSkipCode | null {
	if (!is_pos_session_open(session)) return 'not_open';
	if (session.on_use === true) return 'on_use';
	const runtime = as_object(session.runtime_state);
	if (as_array(runtime.items).length > 0) return 'open_order';
	if (text(runtime.mode).toUpperCase() === 'OFFLINE') return 'offline';
	return null;
}

function stamp(session: ImperiumDoc): string {
	return text(session.updatedAt ?? session.updated_at);
}

function session_info(session: ImperiumDoc) {
	const history = as_array(session.usage_history).map(as_object);
	const last = history[history.length - 1] ?? {};
	const candidates = [
		as_object(session.runtime_state).updated_at,
		last.ended_at,
		last.started_at,
		session.updatedAt ?? session.updated_at,
	]
		.filter(Boolean)
		.map((value) => new Date(String(value)))
		.filter((value) => !Number.isNaN(value.getTime()));
	const last_activity = candidates.length
		? new Date(Math.max(...candidates.map((d) => d.getTime()))).toISOString()
		: null;
	const employee = session_employee_name(session);
	return {
		_id: text(session._id),
		name: text(session.name),
		cashier_name: employee === 'Sin asignar' ? text(last.cashier_name) : employee,
		last_activity,
	};
}

async function session_summary(store: ImperiumStore, session: ImperiumDoc, until: Date) {
	const summaries = await ticket_summaries_for_session(store, text(session._id), until);
	return {
		ticket_count: summaries.length,
		total_sales: round_money(total_sales_of(summaries)),
		expected_cash: expected_cash_of(
			round_money(Number(session.cash_register_opening_money ?? 0)),
			summaries,
		),
	};
}

export async function bulk_close_pos_sessions(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	body: ImperiumDoc,
) {
	if (!is_seed_admin(actor)) {
		throw http_error(
			'Solo el superadministrador puede cerrar sesiones POS en masa.',
			403,
			'access_denied',
		);
	}
	const ids = [
		...new Set(
			as_array(body?.ids)
				.map((id) => text(id))
				.filter((id) => ID_RE.test(id)),
		),
	];
	if (!ids.length) {
		throw http_error('Selecciona al menos una sesión POS para cerrar.', 400, 'validation_error');
	}
	if (ids.length > BULK_CLOSE_MAX_SESSIONS) {
		throw http_error(
			`Solo se pueden cerrar ${BULK_CLOSE_MAX_SESSIONS} sesiones a la vez.`,
			400,
			'validation_error',
		);
	}
	const dry_run = body?.dry_run === true;
	const force = body?.force === true;
	const reason = text(body?.reason);
	if (!dry_run && (reason.length < BULK_CLOSE_REASON_MIN || reason.length > BULK_CLOSE_REASON_MAX)) {
		throw http_error(
			`Escribe la razón del cierre (entre ${BULK_CLOSE_REASON_MIN} y ${BULK_CLOSE_REASON_MAX} caracteres).`,
			400,
			'validation_error',
		);
	}

	const result = {
		dry_run,
		force,
		cerradas: [] as ImperiumDoc[],
		por_cerrar: [] as ImperiumDoc[],
		omitidas: [] as ImperiumDoc[],
	};
	const actor_user_id = text(actor?._id);

	for (const id of ids) {
		const session = await store.find_id('pos-session', id);
		if (!session || session.is_active === false) {
			result.omitidas.push({
				_id: id,
				name: '',
				cashier_name: '',
				last_activity: null,
				code: 'not_found',
				reason: SKIP_REASONS.not_found,
			});
			continue;
		}
		const info = session_info(session);
		const skip = (code: BulkCloseSkipCode) =>
			result.omitidas.push({ ...info, code, reason: SKIP_REASONS[code] });

		const blocker = bulk_close_blocker(session);
		if (blocker === 'not_open' || (blocker && !force)) {
			skip(blocker);
			continue;
		}
		if (dry_run) {
			result.por_cerrar.push({ ...info, ...(await session_summary(store, session, new Date())) });
			continue;
		}

		// Guarda: si alguien la tocó desde que se leyó, no se cierra.
		const fresh = await store.find_id('pos-session', id);
		const fresh_blocker = fresh ? bulk_close_blocker(fresh) : 'not_open';
		if (
			!fresh ||
			stamp(fresh) !== stamp(session) ||
			fresh_blocker === 'not_open' ||
			(fresh_blocker && !force)
		) {
			skip('changed');
			continue;
		}

		const closed_at = new Date();
		const iso = closed_at.toISOString();
		const usage_history = release_usage_history(fresh, BULK_CLOSE_RELEASE_REASON);
		usage_history.push({
			started_at: iso,
			ended_at: iso,
			used_by_user: actor_user_id || null,
			cashier: ref_id(fresh.cashier) || null,
			cashier_name: info.cashier_name,
			release_reason: `${BULK_CLOSE_RELEASE_REASON}: ${reason}`,
		});
		const updated = await store.update('pos-session', id, {
			status: 'cerrada',
			estado: 'cerrada',
			on_use: false,
			closing_date: iso,
			fecha_cierre: iso,
			usage_history,
		});
		if (!updated) {
			skip('changed');
			continue;
		}
		result.cerradas.push({ ...info, ...(await session_summary(store, fresh, closed_at)) });
	}

	const total = dry_run ? result.por_cerrar.length : result.cerradas.length;
	return ok(
		[result],
		dry_run
			? `Se cerrarían: ${total}. Omitidas: ${result.omitidas.length}.`
			: `Sesiones cerradas: ${total}. Omitidas: ${result.omitidas.length}.`,
		total,
	);
}
