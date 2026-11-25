import { createHash, randomBytes } from 'node:crypto';
import {
	GENERIC_CREDENTIALS_MESSAGE,
	authenticate_for_surface,
	can_enter_internal,
} from '@opus-perpetuus/imperium-core-kit';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { destroy_sessions_for_user, dummy_verify } from './auth.ts';
import { consume_badge_login_limits, request_ip } from './auth-rate-limit.ts';
import { record_auth_attempt } from './auth-attempts.ts';
import { safe_equal_hex } from './cli-token.ts';
import { hash_pin, verify_pin_hash } from './user-pin.ts';

export const BADGE_RESOURCE = 'user-badge';
export const BADGE_TOKEN_PREFIX = 'igb1_';
export const BADGE_PIN_MAX_FAILURES = 5;
export const BADGE_SESSION = {
	ttl_ms: 12 * 3600 * 1000,
	idle_kiosk_ms: 30 * 60 * 1000,
	idle_unregistered_ms: 15 * 60 * 1000,
};

const TOKEN_RE = /^igb1_[A-Za-z0-9_-]{43}$/;
const PIN_RE = /^\d{4,6}$/;
const GENERIC_BODY = { message: GENERIC_CREDENTIALS_MESSAGE, error: GENERIC_CREDENTIALS_MESSAGE };

export type BadgeAuth =
	| { ok: true; user: ImperiumDoc; badge: ImperiumDoc; destination: string }
	| { ok: false; status: number; body: Record<string, unknown> };

export function hash_badge_token(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

async function badges_of(store: ImperiumStore, user_id: string): Promise<ImperiumDoc[]> {
	const rows: ImperiumDoc[] = [];
	for await (const page of store.scan(BADGE_RESOURCE, {
		mongo_match: { user_id },
		include_inactive: true,
	})) {
		rows.push(...page);
	}
	return rows;
}

export async function revoke_badge(
	store: ImperiumStore,
	sql: Bun.SQL,
	actor_id: string,
	badge_id: string,
	motivo: string,
): Promise<ImperiumDoc | null> {
	const row = await store.find_id(BADGE_RESOURCE, badge_id);
	if (!row) return null;
	const updated = await store.update(BADGE_RESOURCE, badge_id, {
		estado: 'revocado',
		revocado_por: actor_id,
		revocado_at: new Date().toISOString(),
		motivo,
	});
	await destroy_sessions_for_user(sql, String(row.user_id ?? ''), badge_id);
	return updated;
}

export async function issue_badge(
	store: ImperiumStore,
	sql: Bun.SQL,
	actor_id: string,
	user_id: string,
): Promise<{ token: string; token_prefix: string; serie: number; id: string }> {
	const user = await store.find_id('user', user_id);
	if (!user || user.is_active === false || !can_enter_internal(user)) {
		throw new Error('El usuario no puede recibir gafete');
	}
	const previous = await badges_of(store, user_id);
	for (const row of previous) {
		if (row.estado !== 'revocado') {
			await revoke_badge(store, sql, actor_id, String(row._id), 'reemplazado');
		}
	}
	const serie = previous.reduce((max, row) => Math.max(max, Number(row.serie ?? 0)), 0) + 1;
	const token = `${BADGE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
	const token_prefix = token.slice(0, 12);
	const row = await store.insert(BADGE_RESOURCE, {
		name: `Gafete ${serie}`,
		user_id,
		employee_id: String(user.employee ?? ''),
		serie,
		token_hash: hash_badge_token(token),
		token_prefix,
		pin_hash: null,
		pin_fallos: 0,
		estado: 'activo',
		emitido_por: actor_id,
		emitido_at: new Date().toISOString(),
		revocado_por: null,
		revocado_at: null,
		motivo: null,
		ultimo_uso_at: null,
		ultimo_dispositivo: null,
	});
	return { token, token_prefix, serie, id: String(row._id ?? '') };
}

export async function reset_badge_pin(
	store: ImperiumStore,
	badge_id: string,
	pin: string | null,
): Promise<ImperiumDoc | null> {
	if (pin !== null && !PIN_RE.test(pin)) throw new Error('El PIN debe tener de 4 a 6 dígitos');
	const row = await store.find_id(BADGE_RESOURCE, badge_id);
	if (!row) return null;
	return store.update(BADGE_RESOURCE, badge_id, {
		pin_hash: pin ? await hash_pin(pin) : null,
		pin_fallos: 0,
		estado: row.estado === 'bloqueado' ? 'activo' : row.estado,
	});
}

export async function authenticate_badge(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	body: Record<string, unknown>,
): Promise<BadgeAuth> {
	const token = typeof body.token === 'string' ? body.token.trim() : '';
	const pin = String(body.pin ?? '').trim();
	const well_formed = TOKEN_RE.test(token);
	const badge_prefix = well_formed ? token.slice(0, 12) : '';
	const ip = request_ip(req);
	const attempt = {
		method: 'badge' as const,
		badge_prefix,
		ip,
		user_agent: req.headers.get('user-agent') ?? '',
	};
	const fail = async (
		reason: string,
		user_id = '',
		extra: Record<string, unknown> = {},
	): Promise<BadgeAuth> => {
		await record_auth_attempt(sql, { ...attempt, result: 'fail', reason, user_id });
		return { ok: false, status: 401, body: { ...GENERIC_BODY, ...extra } };
	};

	const limited = await consume_badge_login_limits(sql, ip, badge_prefix);
	if (limited) {
		await record_auth_attempt(sql, { ...attempt, result: 'blocked', reason: 'limitador' });
		return { ok: false, status: 429, body: limited };
	}
	if (!well_formed) return fail('formato');
	const token_hash = hash_badge_token(token);
	const found = store.has(BADGE_RESOURCE)
		? await store.find_where(BADGE_RESOURCE, { token_hash })
		: null;
	const badge = found && safe_equal_hex(String(found.token_hash ?? ''), token_hash) ? found : null;
	if (!badge) {
		await dummy_verify();
		return fail('no_existe');
	}
	const badge_id = String(badge._id);
	const user_id = String(badge.user_id ?? '');
	if (badge.estado !== 'activo') return fail(`estado_${String(badge.estado ?? '')}`, user_id);
	const user = user_id ? await store.find_id('user', user_id) : null;
	if (!user || user.is_active === false || !can_enter_internal(user)) return fail('usuario', user_id);
	if (String(user.employee ?? '') !== String(badge.employee_id ?? '')) {
		return fail('reasignado', user_id);
	}
	const gate = authenticate_for_surface('staff', user, true);
	if (!gate.ok) return fail('superficie', user_id);
	if (!pin) return fail('pin_requerido', user_id, { pin_required: true });

	const pin_hash = String(badge.pin_hash ?? '');
	const now = new Date().toISOString();
	if (!pin_hash) {
		if (!PIN_RE.test(pin)) return fail('pin_formato', user_id, { pin_required: true });
		await store.update(BADGE_RESOURCE, badge_id, {
			pin_hash: await hash_pin(pin),
			pin_fallos: 0,
			ultimo_uso_at: now,
		});
	} else if (await verify_pin_hash(pin_hash, pin)) {
		await store.update(BADGE_RESOURCE, badge_id, { pin_fallos: 0, ultimo_uso_at: now });
	} else {
		const fallos = Number(badge.pin_fallos ?? 0) + 1;
		const bloqueado = fallos >= BADGE_PIN_MAX_FAILURES;
		await store.update(BADGE_RESOURCE, badge_id, {
			pin_fallos: fallos,
			...(bloqueado ? { estado: 'bloqueado' } : {}),
		});
		return fail(bloqueado ? 'pin_bloqueo' : 'pin', user_id);
	}
	await record_auth_attempt(sql, { ...attempt, result: 'ok', reason: 'ok', user_id });
	return { ok: true, user, badge, destination: gate.destination };
}
