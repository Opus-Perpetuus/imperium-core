import { describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import {
	format_console_log,
	is_noisy_path,
	persist_app_log,
	persist_request_log,
	request_result,
	should_read_response_body,
} from './debug-request-log.ts';
import type { ImperiumDoc } from './envelope.ts';
import { bind_socket_identity_resolver, emit_to_room, handle_socket_io } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

describe('is_noisy_path', () => {
	test('skips subject log ingestion and socket.io under /api', () => {
		expect(
			is_noisy_path('/api/kirlets/svc/subject-turnos/logs'),
		).toBe(true);
		expect(
			is_noisy_path('/kirlets/svc/subject-ventas/logs'),
		).toBe(true);
		expect(is_noisy_path('/api/socket.io/?EIO=4')).toBe(true);
		expect(is_noisy_path('/socket.io/?EIO=4')).toBe(true);
		expect(is_noisy_path('/health')).toBe(true);
		expect(is_noisy_path('/api/health')).toBe(true);
	});

	test('keeps real API traffic', () => {
		expect(is_noisy_path('/api/products')).toBe(false);
		expect(is_noisy_path('/auth/menus')).toBe(false);
		expect(is_noisy_path('/subjects')).toBe(false);
		expect(is_noisy_path('/api/media/abc')).toBe(false);
	});

	test('las rutas calientes del chat y su búsqueda no van a la bitácora', () => {
		for (const path of [
			'/api/messages/search?q=contrase%C3%B1a',
			'/api/messages/search?term=hola&participant_id=u1',
			'/api/messages/socket-ticket',
			'/api/messages/media-tokens',
			'/api/messages/history/c1?before_seq=40',
			'/api/messages/sync/c1?after_seq=3&changed_since=2026-10-06T17:04:05.123Z',
			'/api/messages/conversation/u-beto?size=250',
			'/api/chat-conversations/mine?changed_since=2026-10-06T17:04:05.123Z',
			'/api/chat-conversations/c1/read',
			'/api/chat-calls/ice-servers',
		]) {
			expect(is_noisy_path(path)).toBe(true);
		}
		for (const path of ['/api/messages/chat', '/api/messages/conversations', '/api/chat-conversations/c1', '/api/chat-conversations/group', '/api/messages/searches']) {
			expect(is_noisy_path(path)).toBe(false);
		}
	});

	test('el código de la reunión y las descargas de la reunión no van a la bitácora', () => {
		for (const path of [
			'/api/chat-meetings/code/abc-defg-hjk',
			'/api/chat-meetings/code/abc-defg-hjk/guest',
			'/api/chat-meetings/code/abc-defg-hjk/join',
			'/api/chat-meetings/m1/attendance.csv?call_id=c1',
			'/api/chat-meetings/m1/transcript.vtt?call_id=c1',
		]) {
			expect(is_noisy_path(path)).toBe(true);
		}
		for (const path of ['/api/chat-meetings/mine', '/api/chat-meetings/m1/attendance', '/api/chat-meetings/m1', '/api/chat-meetings/guest/ticket']) {
			expect(is_noisy_path(path)).toBe(false);
		}
	});

	test('un adjunto pedido con token de medios no deja el token en la bitácora', () => {
		expect(is_noisy_path('/api/media/abc?mt=v1.x.y')).toBe(true);
		expect(is_noisy_path('/api/media/abc?v=2&mt=v1.x.y')).toBe(true);
		expect(is_noisy_path('/api/media/abc?format=mt')).toBe(false);
	});
});

describe('format_console_log', () => {
	test('emits ANSI colors for success and error', () => {
		const ok = format_console_log('success', 'GET /products 200 3ms');
		const err = format_console_log('error', 'GET /missing 404 1ms');
		expect(ok).toContain('\x1b[');
		expect(ok).toContain('[SUCCESS]');
		expect(ok).toContain('GET /products');
		expect(err).toContain('[ERROR');
		expect(err).toContain('\x1b[0m');
	});
});

describe('should_read_response_body', () => {
	test('skips PDF and other binary types so logging cannot corrupt the clone', () => {
		expect(should_read_response_body('application/pdf')).toBe(false);
		expect(should_read_response_body('application/pdf; charset=binary')).toBe(
			false,
		);
		expect(should_read_response_body('image/png')).toBe(false);
		expect(should_read_response_body('application/json')).toBe(true);
		expect(should_read_response_body('text/html; charset=utf-8')).toBe(true);
	});
});

describe('request_result', () => {
	test('adjunto sin bytes no se trata como error fatal', () => {
		expect(request_result(404, 'attachment_bytes_missing')).toBe('warning');
		expect(request_result(404, 'attachment_not_found')).toBe('warning');
		expect(request_result(404, '')).toBe('error');
	});
});

describe('bitácora en vivo (new_log)', () => {
	const POLLING = 'http://imperium.test/api/socket.io/?EIO=4&transport=polling';
	bind_socket_identity_resolver(async (session_id) => (session_id === 'sesion-bitacora' ? 'lector' : null));

	/** Socket por polling ya conectado y unido a una sala pública que sirve de testigo. */
	async function socket(headers: Record<string, string>, ip: string): Promise<string> {
		const req = new Request(POLLING, { headers });
		remember_socket_ip(req, ip);
		const sid = (JSON.parse((await (handle_socket_io(req) as Response).text()).slice(1)) as { sid: string }).sid;
		const post = (body: string) => handle_socket_io(new Request(`${POLLING}&sid=${sid}`, { method: 'POST', body }));
		await post('40');
		await post(`42${JSON.stringify(['joinRoom', 'subjects'])}`);
		return sid;
	}

	async function poll(sid: string): Promise<string> {
		return ((await handle_socket_io(new Request(`${POLLING}&sid=${sid}`))) as Response).text();
	}

	test('solo la reciben las sesiones internas: un socket anónimo de otro origen no', async () => {
		const anonymous = await socket({ origin: 'https://evil.example' }, '192.0.2.71');
		const internal = await socket({ cookie: 'connect.sid=sesion-bitacora' }, '192.0.2.72');
		const store = {
			has: (resource: string) => resource === 'debug-log',
			insert: async (_resource: string, doc: ImperiumDoc) => ({ ...doc, _id: crypto.randomUUID() }),
		} as unknown as ImperiumStore;
		const req = new Request('http://imperium.test/api/media/adjunto-del-chat', {
			headers: { 'user-agent': 'navegador', 'x-forwarded-for': '198.51.100.7' },
		});
		const actor = { _id: 'u-ana', name: 'Ana', email: 'ana@empresa.test' };
		await persist_request_log(store, req, Response.json({ data: [] }), actor, Date.now());
		await persist_app_log('warning', ['Tiempo real: se negó la sala "user:u-beto" al usuario u-ana'], store);
		emit_to_room('subjects', 'update', { action: 'testigo', data: [] });

		const seen = await poll(anonymous);
		expect(seen).toContain('testigo');
		expect(seen).not.toContain('new_log');
		const logs = await poll(internal);
		expect(logs).toContain('/api/media/adjunto-del-chat');
		expect(logs).toContain('se negó la sala');
	});
});
