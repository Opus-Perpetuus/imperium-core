import { describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import { assert_http_access, is_public_extra_action } from './auth.ts';
import type { ImperiumDoc } from './envelope.ts';
import extra_routes from './extra-routes.json';
import {
	sign_realtime_token,
	SOCKET_TICKET_TTL_S,
	verify_realtime_token,
} from './realtime-tokens.ts';
import type { ImperiumStore } from './store.ts';

const in_s = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

function user_ticket_claims() {
	return { t: 'socket' as const, sub: 'ana', sid: 'sesion-ana', n: crypto.randomUUID(), exp: in_s(60) };
}

describe('tokens de tiempo real', () => {
	test('un ticket firmado se verifica y devuelve sus datos', () => {
		const claims = user_ticket_claims();
		expect(verify_realtime_token(sign_realtime_token(claims), 'socket')).toEqual(claims);
	});

	test('el formato es v1.<cuerpo>.<firma> y cualquier cambio lo invalida', () => {
		const token = sign_realtime_token(user_ticket_claims());
		const [version, body, signature] = token.split('.') as [string, string, string];
		expect(version).toBe('v1');
		const forged = Buffer.from(JSON.stringify({ ...user_ticket_claims(), sub: 'beto' })).toString('base64url');
		const flipped = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
		expect(verify_realtime_token(`v1.${forged}.${signature}`, 'socket')).toBeNull();
		expect(verify_realtime_token(`v1.${body}.${flipped}`, 'socket')).toBeNull();
		expect(verify_realtime_token(`v1.${body}.${signature}x`, 'socket')).toBeNull();
		expect(verify_realtime_token(`v2.${body}.${signature}`, 'socket')).toBeNull();
		expect(verify_realtime_token(`${token}.extra`, 'socket')).toBeNull();
		expect(verify_realtime_token('', 'socket')).toBeNull();
		expect(verify_realtime_token(token, 'socket')).not.toBeNull();
	});

	test('vence con su exp', () => {
		const claims = user_ticket_claims();
		const token = sign_realtime_token(claims);
		expect(verify_realtime_token(token, 'socket', claims.exp * 1000)).toBeNull();
		expect(verify_realtime_token(token, 'socket', claims.exp * 1000 - 1)).toEqual(claims);
	});

	test('el ticket del socket sirve una sola vez', () => {
		const token = sign_realtime_token(user_ticket_claims());
		expect(verify_realtime_token(token, 'socket')).not.toBeNull();
		expect(verify_realtime_token(token, 'socket')).toBeNull();
	});

	test('el ticket de invitado para el socket también es de un solo uso y lleva su reunión', () => {
		const token = sign_realtime_token({
			t: 'socket',
			gid: 'g-1',
			mid: 'reunion-1',
			name: 'Invitada',
			n: crypto.randomUUID(),
			exp: in_s(60),
		});
		const claims = verify_realtime_token(token, 'socket');
		expect(claims && 'gid' in claims ? [claims.gid, claims.mid] : null).toEqual(['g-1', 'reunion-1']);
		expect(verify_realtime_token(token, 'socket')).toBeNull();
	});

	test('un token solo vale para su tipo', () => {
		const media = sign_realtime_token({ t: 'media', sub: 'u:ana', aid: 'adjunto-1', exp: in_s(600) });
		const guest = sign_realtime_token({ t: 'guest', gid: 'g-2', mid: 'reunion-2', name: 'Invitado', exp: in_s(3600) });
		expect(verify_realtime_token(media, 'socket')).toBeNull();
		expect(verify_realtime_token(media, 'guest')).toBeNull();
		expect(verify_realtime_token(guest, 'socket')).toBeNull();
		expect(verify_realtime_token(guest, 'media')).toBeNull();
	});

	test('el acceso de invitado y el de medios se reusan dentro de su vida, con su alcance', () => {
		const guest = sign_realtime_token({ t: 'guest', gid: 'g-3', mid: 'reunion-3', name: 'Invitado', exp: in_s(3600) });
		const media = sign_realtime_token({ t: 'media', sub: 'g:g-3', aid: 'adjunto-3', exp: in_s(120) });
		for (let i = 0; i < 3; i++) {
			expect(verify_realtime_token(guest, 'guest')?.mid).toBe('reunion-3');
			const claims = verify_realtime_token(media, 'media');
			expect([claims?.sub, claims?.aid]).toEqual(['g:g-3', 'adjunto-3']);
		}
	});
});

describe('POST /api/messages/socket-ticket', () => {
	type Route = { resource: string; method: string; path: string; action: string };

	async function issue(actor: ImperiumDoc, session_id: string) {
		const url = new URL('http://core/api/messages/socket-ticket');
		const req = new Request(url, { method: 'POST', headers: { cookie: `connect.sid=${session_id}` } });
		return handle_action({} as ImperiumStore, {} as Bun.SQL, req, url, 'messages', 'issue_socket_ticket', {}, actor);
	}

	test('la ruta existe, pide sesión interna y no es pública', async () => {
		expect((extra_routes as Route[]).find((r) => r.action === 'issue_socket_ticket')).toEqual({
			resource: 'messages',
			method: 'post',
			path: '/socket-ticket',
			action: 'issue_socket_ticket',
		});
		expect(is_public_extra_action('messages', 'issue_socket_ticket')).toBe(false);
		const opts = { extra: true, action: 'issue_socket_ticket' };
		await assert_http_access({} as ImperiumStore, { _id: 'ana', email: 'ana@empresa.com' }, 'messages', 'POST', opts);
		await expect(assert_http_access({} as ImperiumStore, null, 'messages', 'POST', opts)).rejects.toThrow();
	});

	test('emite un ticket de 60 s ligado al usuario y a su sesión HTTP', async () => {
		const res = await issue({ _id: 'ticket-ana' }, 'sesion-http-1');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Array<{ ticket: string; expires_in: number }> };
		expect(body.data[0]!.expires_in).toBe(SOCKET_TICKET_TTL_S);
		const claims = verify_realtime_token(body.data[0]!.ticket, 'socket');
		expect(claims && 'sub' in claims ? [claims.sub, claims.sid] : null).toEqual(['ticket-ana', 'sesion-http-1']);
		expect(claims!.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(SOCKET_TICKET_TTL_S);
	});

	test('30 por minuto por usuario; después 429 con Retry-After', async () => {
		const actor = { _id: 'ticket-beto' };
		for (let i = 0; i < 30; i++) expect((await issue(actor, 'sesion-http-2')).status).toBe(200);
		const res = await issue(actor, 'sesion-http-2');
		expect(res.status).toBe(429);
		const body = (await res.json()) as { code: string; details: { retry_after_s: number } };
		expect(body.code).toBe('rate_limited');
		expect(body.details.retry_after_s).toBeGreaterThan(0);
		expect(res.headers.get('retry-after')).toBe(String(body.details.retry_after_s));
		expect((await issue({ _id: 'ticket-carla' }, 'sesion-http-3')).status).toBe(200);
	});
});
