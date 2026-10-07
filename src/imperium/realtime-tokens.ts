/**
 * Tokens firmados del tiempo real: ticket del socket (usuario o invitado),
 * acceso de invitado a su reunión y acceso a un adjunto.
 * Formato `v1.<b64url(json)>.<b64url(HMAC-SHA256)>`; `exp` en segundos Unix.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type RealtimeClaims =
	| { t: 'socket'; sub: string; sid: string; n: string; exp: number }
	| { t: 'socket'; gid: string; mid: string; name: string; n: string; exp: number }
	| { t: 'guest'; gid: string; mid: string; name: string; exp: number }
	| { t: 'media'; sub: `u:${string}` | `g:${string}`; aid: string; exp: number };

export const SOCKET_TICKET_TTL_S = 60;

// Nunca SESSION_SECRET: el instalador lo siembra con un valor conocido. Sin la
// variable, la llave es del proceso y un reinicio invalida todos los tokens.
const KEY = process.env.IMPERIUM_REALTIME_SECRET
	? Buffer.from(process.env.IMPERIUM_REALTIME_SECRET)
	: randomBytes(32);

/** Nonce de un ticket de socket ya usado → su `exp`. */
const used_nonces = new Map<string, number>();

function signature_of(body: string): string {
	return createHmac('sha256', KEY).update(`imperium-realtime:v1:${body}`).digest('base64url');
}

export function sign_realtime_token(claims: RealtimeClaims): string {
	const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
	return `v1.${body}.${signature_of(body)}`;
}

export function verify_realtime_token<T extends RealtimeClaims['t']>(
	token: string,
	t: T,
	now = Date.now(),
): Extract<RealtimeClaims, { t: T }> | null {
	const parts = token.split('.');
	if (parts.length !== 3 || parts[0] !== 'v1') return null;
	const [, body, signature] = parts as [string, string, string];
	const expected = Buffer.from(signature_of(body));
	const given = Buffer.from(signature);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RealtimeClaims;
	if (claims.t !== t || claims.exp * 1000 <= now) return null;
	if (claims.t === 'socket' && !consume_nonce(claims.n, claims.exp, now)) return null;
	return claims as Extract<RealtimeClaims, { t: T }>;
}

function consume_nonce(nonce: string, exp: number, now: number): boolean {
	for (const [used, until] of used_nonces) {
		if (until * 1000 <= now) used_nonces.delete(used);
	}
	if (used_nonces.has(nonce)) return false;
	used_nonces.set(nonce, exp);
	return true;
}
