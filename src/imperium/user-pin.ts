/**
 * PIN de sesión POS: mismo contrato que el plugin original (notice + reto + token).
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const USER_PIN_UNLOCK_TOKEN_HEADER = 'x-user-pin-token';
export const USER_PIN_POS_CONFIGURATION_REF = 'configuration-pos-pins-enabled';
export const USER_PIN_POS_FEATURE_TOGGLE_KEY = 'pos-session-pin-enabled';

const POS_PROTECTED_ROUTES = [
	{ method: 'GET', path: '/pos-session/:id', label: 'Restaurar sesion POS' },
	{ method: 'PUT', path: '/pos-session', label: 'Actualizar sesion POS' },
	{ method: 'POST', path: '/pos-tickets', label: 'Crear ticket POS' },
	{ method: 'GET', path: '/pos-session/report/partial/:id', label: 'Reporte parcial POS' },
	{ method: 'POST', path: '/pos-session/report/close/:id', label: 'Reporte de cierre POS' },
	{
		method: 'POST',
		path: '/pos-session/report/close/conclude/:id',
		label: 'Concluir cierre POS',
	},
	{ method: 'POST', path: '/pos-session/cancel/:id', label: 'Cancelar sesion POS' },
].map((route) => ({
	...route,
	route_key: `${route.method} ${route.path}`,
}));

export type UserPinChallenge = {
	pin_id: string;
	document_id: string;
	document_model: string;
	document_collection: string;
	document_label?: string;
	pin_type: string;
	pin_length: number;
	route: { method: string; path: string; route_key: string; label?: string };
	message: string;
};

export class PinChallengeError extends Error {
	code = 'user_pin_required';
	challenge: UserPinChallenge;
	constructor(challenge: UserPinChallenge) {
		super(challenge.message);
		this.challenge = challenge;
	}
}

export type UserPinNotice = {
	pin_id: string;
	document_id: string;
	document_model: string;
	document_collection: string;
	document_label?: string;
	generated_pin: string;
	pin_type: string;
	pin_length: number;
	pin_version: number;
	message: string;
	unlock_token: string;
	unlock_expires_at: string;
};

function pin_secret() {
	return (
		process.env.USER_PIN_TOKEN_SECRET ??
		process.env.SESSION_SECRET ??
		process.env.ORIGIN ??
		'imperium-user-pin-secret'
	);
}

function b64url(value: Buffer) {
	return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sign_payload(encoded: string) {
	return b64url(createHmac('sha256', pin_secret()).update(encoded).digest());
}

export function issue_unlock_token(
	pin: { _id: unknown; document_id?: unknown; document_model?: unknown; pin_version?: unknown },
	user_id?: string,
	ttl_ms = 12 * 60 * 60 * 1000,
) {
	const expires_at = Date.now() + ttl_ms;
	const payload = {
		pin_id: String(pin._id),
		document_id: String(pin.document_id ?? ''),
		document_model: String(pin.document_model ?? 'PosSession'),
		pin_version: Number(pin.pin_version ?? 1),
		user_id: user_id || undefined,
		expires_at,
	};
	const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
	return {
		token: `${encoded}.${sign_payload(encoded)}`,
		expires_at: new Date(expires_at).toISOString(),
	};
}

export function verify_unlock_token(
	token: string,
	pin: ImperiumDoc,
	user_id?: string,
): boolean {
	const [encoded, signature] = String(token ?? '').trim().split('.');
	if (!encoded || !signature) return false;
	const expected = sign_payload(encoded);
	const left = Buffer.from(signature);
	const right = Buffer.from(expected);
	if (left.length !== right.length || !timingSafeEqual(left, right)) return false;
	try {
		const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '===';
		const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
			pin_id?: string;
			document_id?: string;
			document_model?: string;
			pin_version?: number;
			user_id?: string;
			expires_at?: number;
		};
		if (!payload.expires_at || payload.expires_at <= Date.now()) return false;
		if (payload.pin_id !== String(pin._id)) return false;
		if (payload.document_id !== String(pin.document_id ?? '')) return false;
		if (payload.document_model !== String(pin.document_model ?? '')) return false;
		if (Number(payload.pin_version ?? 1) !== Number(pin.pin_version ?? 1)) return false;
		if (payload.user_id && user_id && payload.user_id !== user_id) return false;
		return true;
	} catch {
		return false;
	}
}

function cfg_bool(value: unknown, fallback = true) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	const raw = String(value ?? (fallback ? 'true' : 'false'))
		.trim()
		.toLowerCase()
		.replace(/^"+|"+$/g, '');
	return !['', '0', 'false', 'off', 'no'].includes(raw);
}

export async function pos_pins_enabled(store: ImperiumStore) {
	const doc = await store.find_where('configuration', { ref: USER_PIN_POS_CONFIGURATION_REF });
	return cfg_bool(doc?.value, true);
}

function generate_numeric_pin(length = 4) {
	let out = '';
	for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
	return out;
}

async function hash_pin(plain: string) {
	const argon2 = await import('argon2');
	return argon2.hash(plain);
}

async function verify_pin_hash(hash: string, plain: string) {
	if (!hash) return false;
	try {
		if (hash.startsWith('$argon2')) {
			const argon2 = await import('argon2');
			return await argon2.verify(hash, plain);
		}
		return hash === plain;
	} catch {
		return false;
	}
}

export async function maybe_create_pos_session_pin(
	store: ImperiumStore,
	session: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<UserPinNotice | null> {
	if (!store.has('user-pin')) return null;
	if (!(await pos_pins_enabled(store))) return null;
	const document_id = String(session._id ?? '');
	if (!document_id) return null;
	const existing = await store.find_where('user-pin', { document_id });
	if (existing) return null;
	const generated_pin = generate_numeric_pin(4);
	const pin_hash = await hash_pin(generated_pin);
	const uid = String(actor?._id ?? session.created_by ?? '');
	const label = String(session.name ?? `PIN PosSession ${document_id}`);
	const created = await store.insert('user-pin', {
		name: `PIN ${label}`,
		description: `PIN generado automaticamente para PosSession ${document_id}`,
		document_id,
		document_collection: 'pos-session',
		document_model: 'PosSession',
		document_label: label,
		is_global: false,
		assigned_users: uid ? [uid] : [],
		protected_routes: POS_PROTECTED_ROUTES,
		pin_hash,
		pin_type: 'numeric',
		pin_length: 4,
		pin_version: 1,
		auto_generated: true,
		feature_toggle_key: USER_PIN_POS_FEATURE_TOGGLE_KEY,
		ref: `user-pin-auto-PosSession-${document_id}`,
	});
	const issued = issue_unlock_token(created, uid);
	return {
		pin_id: String(created._id),
		document_id,
		document_model: 'PosSession',
		document_collection: 'pos-session',
		document_label: label,
		generated_pin,
		pin_type: 'numeric',
		pin_length: 4,
		pin_version: 1,
		message:
			'Guarda este PIN en un lugar seguro. El sistema no lo volvera a mostrar en texto plano.',
		unlock_token: issued.token,
		unlock_expires_at: issued.expires_at,
	};
}

export async function find_session_pin(store: ImperiumStore, document_id: string) {
	if (!document_id || !store.has('user-pin')) return null;
	return (
		(await store.find_where('user-pin', { document_id })) ??
		(
			await store.find_many('user-pin', {
				where: { document_id },
				take: 1,
				include_inactive: false,
			})
		).rows[0] ??
		null
	);
}

export async function assert_pos_pin(
	store: ImperiumStore,
	req: Request,
	document_id: string,
	route: { method: string; path: string; label: string },
	actor: ImperiumDoc | null,
) {
	if (!(await pos_pins_enabled(store))) return;
	const pin = await find_session_pin(store, document_id);
	if (!pin) return;
	const uid = String(actor?._id ?? '');
	const assigned = as_array(pin.assigned_users).map((v) =>
		typeof v === 'object' ? String(as_object(v)._id ?? '') : String(v ?? ''),
	);
	if (assigned.length && uid && !assigned.includes(uid)) {
		throw new Error('Este PIN no esta asignado a tu usuario.');
	}
	const token = req.headers.get(USER_PIN_UNLOCK_TOKEN_HEADER) ?? '';
	if (token && verify_unlock_token(token, pin, uid)) return;
	throw new PinChallengeError({
		pin_id: String(pin._id),
		document_id: String(pin.document_id ?? document_id),
		document_model: String(pin.document_model ?? 'PosSession'),
		document_collection: String(pin.document_collection ?? 'pos-session'),
		document_label: String(pin.document_label ?? pin.name ?? ''),
		pin_type: String(pin.pin_type ?? 'numeric'),
		pin_length: Number(pin.pin_length ?? 4),
		route: {
			method: route.method,
			path: route.path,
			route_key: `${route.method} ${route.path}`,
			label: route.label,
		},
		message: 'Se requiere un PIN valido para continuar.',
	});
}

export async function verify_user_pin(
	store: ImperiumStore,
	body: Record<string, unknown>,
	actor: ImperiumDoc | null,
) {
	const pin_id = String(body.pin_id ?? body.challenge_key ?? '').trim();
	const provided = String(body.pin ?? '')
		.trim()
		.replace(/\D/g, '');
	if (!pin_id) throw new Error('Debes indicar el PIN que quieres verificar.');
	const pin = await store.find_id('user-pin', pin_id);
	if (!pin || pin.is_active === false) throw new Error('El PIN solicitado ya no esta disponible.');
	const uid = String(actor?._id ?? '');
	const assigned = as_array(pin.assigned_users).map((v) =>
		typeof v === 'object' ? String(as_object(v)._id ?? '') : String(v ?? ''),
	);
	if (assigned.length && uid && !assigned.includes(uid)) {
		throw new Error('Este PIN no esta asignado a tu usuario.');
	}
	const ok_pin = await verify_pin_hash(String(pin.pin_hash ?? pin.pin ?? pin.value ?? ''), provided);
	if (!ok_pin) throw new Error('El PIN proporcionado no es valido.');
	const issued = issue_unlock_token(pin, uid);
	return {
		data: [
			{
				pin_id: String(pin._id),
				unlock_token: issued.token,
				unlock_expires_at: issued.expires_at,
			},
		],
		total_elementos: 1,
		message: 'PIN verificado correctamente',
	};
}
