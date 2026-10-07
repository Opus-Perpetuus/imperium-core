import { describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { sign_realtime_token } from './realtime-tokens.ts';
import {
	bind_socket_identity_resolver,
	disconnect_sockets_for_auth_sid,
	emit_to_room,
	handle_socket_io,
	last_driver_location,
	realtime_tick,
	SOCKET_IO_IDLE_TIMEOUT_SECONDS,
	SOCKET_IO_PING_MS,
} from './socket-stub.ts';

const POLLING = 'http://imperium.test/api/socket.io/?EIO=4&transport=polling';
const ANA = { cookie: 'connect.sid=sesion-ana' };
const BETO = { cookie: 'connect.sid=sesion-beto' };

bind_socket_identity_resolver(async (session_id) =>
	session_id === 'sesion-ana' ? 'ana' : session_id === 'sesion-beto' ? 'beto' : null,
);

let handshakes = 0;

/** Cada handshake desde su propia IP: el límite por IP no es lo que se prueba aquí. */
async function open_session(
	headers: Record<string, string> = {},
	url = POLLING,
): Promise<string> {
	const req = new Request(url, { headers });
	remember_socket_ip(req, `10.0.0.${++handshakes}`);
	const res = handle_socket_io(req);
	expect(res).toBeInstanceOf(Response);
	const body = await (res as Response).text();
	expect(body.startsWith('0')).toBe(true);
	const open = JSON.parse(body.slice(1)) as { sid: string; pingInterval: number };
	expect(open.sid).toBeTruthy();
	expect(open.pingInterval).toBe(SOCKET_IO_PING_MS);
	return open.sid;
}

async function send(sid: string, ...packets: string[]): Promise<void> {
	await handle_socket_io(
		new Request(`${POLLING}&sid=${sid}`, { method: 'POST', body: packets.join('\x1e') }),
	);
}

/** Solo con algo ya encolado: un poll vacío espera `SOCKET_IO_PING_MS`. */
async function poll(sid: string): Promise<string> {
	const res = await handle_socket_io(new Request(`${POLLING}&sid=${sid}`));
	return (res as Response).text();
}

function event(name: string, data: unknown): string {
	return `42${JSON.stringify([name, data])}`;
}

async function connect(headers: Record<string, string> = {}, url = POLLING): Promise<string> {
	const sid = await open_session(headers, url);
	await send(sid, '40');
	expect(await poll(sid)).toStartWith('40');
	return sid;
}

/** ¿El servidor la unió a `user:<id>`? Una sala pública sirve de testigo. */
async function identified_as(sid: string, user_id: string): Promise<boolean> {
	const marker = crypto.randomUUID();
	await send(sid, event('joinRoom', 'subjects'));
	emit_to_room(`user:${user_id}`, 'update', { action: 'probe', data: [marker] });
	emit_to_room('subjects', 'update', { action: 'testigo', data: [] });
	return (await poll(sid)).includes(marker);
}

describe('socket.io stub', () => {
	test('idleTimeout outlives the long-poll ping so Bun does not hang up', () => {
		expect(SOCKET_IO_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(
			SOCKET_IO_PING_MS,
		);
	});

	test('core Bun.serve wires that idleTimeout (default 10s kills polling)', async () => {
		const src = await Bun.file(new URL('../server.ts', import.meta.url)).text();
		expect(src).toContain('idleTimeout: SOCKET_IO_IDLE_TIMEOUT_SECONDS');
	});

	test('el Bun.serve del núcleo monta el WebSocket y sube antes de atender la petición', async () => {
		const src = await Bun.file(new URL('../server.ts', import.meta.url)).text();
		expect(src).toContain('websocket: socket_websocket_handler');
		const fetch_body = src.slice(src.indexOf('async fetch(req, server)'));
		expect(fetch_body.indexOf('upgrade_socket_io(req, server)')).toBeGreaterThan(-1);
		// Sube antes de leer el cuerpo: la petición de upgrade no lo tiene y después ya no se puede subir.
		expect(fetch_body.indexOf('request_with_received_body(req)')).toBeGreaterThan(-1);
		expect(fetch_body.indexOf('upgrade_socket_io(req, server)')).toBeLessThan(
			fetch_body.indexOf('request_with_received_body(req)'),
		);
		expect(fetch_body).toContain("if (upgraded === 'upgraded') return undefined;");
	});

	test('handshake returns sid', async () => {
		const sid = await open_session();
		expect(sid.length).toBeGreaterThan(8);
	});

	test('GET poll with a queued packet returns immediately', async () => {
		const sid = await open_session();
		await (
			handle_socket_io(
				new Request(
					`http://imperium.test/api/socket.io/?EIO=4&transport=polling&sid=${sid}`,
					{ method: 'POST', body: '40' },
				)
			) as Promise<Response>
		);
		const poll = handle_socket_io(
			new Request(
				`http://imperium.test/api/socket.io/?EIO=4&transport=polling&sid=${sid}`,
			),
		);
		const body = await (poll as Promise<Response> | Response).then((r) =>
			r instanceof Response ? r.text() : Promise.resolve(''),
		);
		expect(body.startsWith('40')).toBe(true);
	});

	test('client abort releases the held poll instead of writing later', async () => {
		const sid = await open_session();
		const controller = new AbortController();
		const held = handle_socket_io(
			new Request(
				`http://imperium.test/api/socket.io/?EIO=4&transport=polling&sid=${sid}`,
				{ signal: controller.signal },
			),
		);
		expect(held).toBeInstanceOf(Promise);
		controller.abort();
		const res = await (held as Promise<Response>);
		expect(res.status).toBe(499);
		expect(await res.text()).toBe('');
	});
});

describe('latido del polling', () => {
	/** Socket por polling en una sala pública: con tráfico, un poll nunca pasa 25 s vacío. */
	async function busy_session(): Promise<string> {
		const sid = await connect();
		await send(sid, event('joinRoom', 'subjects'));
		emit_to_room('subjects', 'update', { action: 'trafico', data: [] });
		await poll(sid);
		return sid;
	}

	test('aunque haya tráfico, recibe 2 cada 25 s; si contesta 3 sigue viva', async () => {
		const sid = await busy_session();
		realtime_tick(Date.now() + 26_000);
		emit_to_room('subjects', 'update', { action: 'trafico', data: [] });
		expect((await poll(sid)).split('\x1e')).toContain('2');
		await send(sid, '3');
		realtime_tick(Date.now() + 40_000);
		emit_to_room('subjects', 'update', { action: 'sigue-viva', data: [] });
		expect(await poll(sid)).toContain('sigue-viva');
	});

	test('sin 3 en 45 s se cierra', async () => {
		const sid = await busy_session();
		realtime_tick(Date.now() + 26_000);
		realtime_tick(Date.now() + 46_000);
		emit_to_room('subjects', 'update', { action: 'trafico', data: [] });
		const late = (await handle_socket_io(new Request(`${POLLING}&sid=${sid}`))) as Response;
		expect(late.status).toBe(400);
	});
});

describe('salas del socket', () => {
	test('server.ts inyecta la identidad por sesión sin que el stub importe auth.ts', async () => {
		const src = await Bun.file(new URL('../server.ts', import.meta.url)).text();
		expect(src).toContain('bind_socket_identity_resolver(');
		expect(src).toContain('user_for_session_id(sql, session_id)');
		expect(src).toContain('can_enter_internal(user)');
	});

	test('una sala privada ajena se niega y las propias llegan sin pedirlas', async () => {
		const ana = await connect(ANA);
		await send(
			ana,
			event('joinRoom', 'messages:user:beto'),
			event('joinRoom', 'notifications:user:beto'),
			event('joinRoom', 'user:beto'),
			event('joinRoom', 'messages:user:ana'),
		);
		emit_to_room('messages:user:beto', 'update', { action: 'messages_refresh', data: ['ajeno-1'] });
		emit_to_room('notifications:user:beto', 'update', { action: 'notifications_refresh', data: ['ajeno-2'] });
		emit_to_room('user:beto', 'update', { action: 'chat_delta', data: ['ajeno-3'] });
		emit_to_room('notifications:user:ana', 'update', { action: 'notifications_refresh', data: ['propio-1'] });
		emit_to_room('messages:user:ana', 'update', { action: 'messages_refresh', data: ['propio-2'] });
		const body = await poll(ana);
		expect(body).not.toContain('ajeno');
		expect(body).toContain('propio-1');
		expect(body).toContain('propio-2');
	});

	test('sin sesión solo entra a las salas públicas', async () => {
		const anon = await connect();
		await send(
			anon,
			event('joinRoom', 'ticketing_system_turns'),
			event('joinRoom', 'module-management'),
			event('joinRoom', 'messages:user:ana'),
			event('joinRoom', 'notifications:user:ana'),
			event('joinRoom', 'user:ana'),
			event('joinRoom', 'route:r-anon:driver'),
			event('joinRoom', 'sala-inventada'),
		);
		for (const room of ['messages:user:ana', 'notifications:user:ana', 'user:ana', 'route:r-anon:driver', 'sala-inventada']) {
			emit_to_room(room, 'update', { action: 'x', data: [`privado ${room}`] });
		}
		emit_to_room('module-management', 'update', { action: 'x', data: ['publico-1'] });
		emit_to_room('ticketing_system_turns', 'update', { action: 'x', data: ['publico-2'] });
		const body = await poll(anon);
		expect(body).not.toContain('privado');
		expect(body).toContain('publico-1');
		expect(body).toContain('publico-2');
	});

	test('con sesión entra a la sala del chofer de una ruta', async () => {
		const ana = await connect(ANA);
		await send(ana, event('joinRoom', 'route:r-ana:driver'));
		emit_to_room('route:r-ana:driver', 'driver_location', { route_id: 'r-ana' });
		expect(await poll(ana)).toContain('r-ana');
	});

	test('la cookie solo identifica desde el origen propio, local o permitido', async () => {
		expect(await identified_as(await connect(ANA), 'ana')).toBe(true);
		expect(
			await identified_as(await connect({ ...ANA, origin: 'http://imperium.test' }), 'ana'),
		).toBe(true);
		expect(
			await identified_as(
				await connect({ ...ANA, origin: 'https://imperium.example.com', 'x-forwarded-host': 'imperium.example.com' }),
				'ana',
			),
		).toBe(true);
		expect(
			await identified_as(
				await connect(
					{ ...ANA, origin: 'http://localhost:4213' },
					'http://127.0.0.1:3100/api/socket.io/?EIO=4&transport=polling',
				),
				'ana',
			),
		).toBe(true);
		expect(
			await identified_as(await connect({ ...ANA, origin: 'https://hermano.imperium.test' }), 'ana'),
		).toBe(false);
		expect(await identified_as(await connect({ ...ANA, origin: 'null' }), 'ana')).toBe(false);
		process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS = 'https://panel.otro.test/, https://hermano.imperium.test';
		try {
			expect(
				await identified_as(await connect({ ...ANA, origin: 'https://hermano.imperium.test' }), 'ana'),
			).toBe(true);
		} finally {
			delete process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS;
		}
		expect(await identified_as(await connect({ cookie: 'connect.sid=sesion-vencida' }), 'ana')).toBe(false);
	});

	test('messageToRoom exige sesión y una sala unida que no sea privada; el remitente lo pone el servidor', async () => {
		const ana = await connect(ANA);
		const anon = await connect();
		await send(ana, event('joinRoom', 'subjects'));
		await send(anon, event('joinRoom', 'subjects'), event('joinRoom', 'module-management'));
		await send(anon, event('messageToRoom', { room: 'subjects', msg: 'de-anonimo' }));
		await send(
			ana,
			event('messageToRoom', { room: 'messages:user:ana', msg: 'a-sala-privada' }),
			event('messageToRoom', { room: 'module-management', msg: 'a-sala-no-unida' }),
			event('messageToRoom', { room: 'subjects', msg: 'x'.repeat(5000) }),
			event('messageToRoom', { room: 'subjects', msg: 'hola', from: 'beto' }),
		);
		const seen_by_anon = await poll(anon);
		expect(seen_by_anon).not.toContain('de-anonimo');
		expect(seen_by_anon).not.toContain('a-sala-no-unida');
		expect(seen_by_anon).not.toContain('xxxxx');
		expect(seen_by_anon).toContain(JSON.stringify(['message', { room: 'subjects', msg: 'hola', from: 'ana' }]));
		expect(await poll(ana)).not.toContain('a-sala-privada');
	});

	test('driverLocation exige sesión y el chofer es quien la manda', async () => {
		const despacho = await connect(ANA);
		const anon = await connect();
		const beto = await connect(BETO);
		await send(despacho, event('joinRoom', 'route:r-1:driver'));
		await send(anon, event('driverLocation', { route_id: 'r-1', latitude: 1, longitude: 2 }));
		expect(last_driver_location('r-1')).toBeNull();
		await send(beto, event('driverLocation', { route_id: 'r-1', latitude: 1, longitude: 2, user_id: 'ana' }));
		expect(last_driver_location('r-1')?.user_id).toBe('beto');
		expect(await poll(despacho)).toContain('"user_id":"beto"');
	});
});

describe('ticket del socket', () => {
	const ELECTRON = { origin: 'app://imperium' };
	const INVALID = `44${JSON.stringify({ message: 'Sesión de tiempo real no válida' })}`;

	function ticket(sub: string, sid: string) {
		return sign_realtime_token({
			t: 'socket',
			sub,
			sid,
			n: crypto.randomUUID(),
			exp: Math.floor(Date.now() / 1000) + 60,
		});
	}

	async function connect_with(headers: Record<string, string>, auth: Record<string, unknown>) {
		const sid = await open_session(headers);
		await send(sid, `40${JSON.stringify(auth)}`);
		return { sid, reply: await poll(sid) };
	}

	test('identifica fuera del mismo origen, donde la cookie no cuenta', async () => {
		const { sid, reply } = await connect_with(ELECTRON, { ticket: ticket('ana', 'sesion-ana') });
		expect(reply).toStartWith('40{"sid"');
		expect(await identified_as(sid, 'ana')).toBe(true);
	});

	test('un ticket inválido, usado o de una sesión cerrada responde 44 y no cae a la cookie', async () => {
		const used = ticket('ana', 'sesion-ana');
		expect((await connect_with(ELECTRON, { ticket: used })).reply).toStartWith('40{"sid"');
		expect((await connect_with(ELECTRON, { ticket: used })).reply).toBe(INVALID);
		expect((await connect_with(ELECTRON, { ticket: `${ticket('ana', 'sesion-ana')}x` })).reply).toBe(INVALID);
		expect((await connect_with(ELECTRON, { ticket: ticket('ana', 'sesion-vencida') })).reply).toBe(INVALID);
		expect((await connect_with(ELECTRON, { ticket: ticket('ana', 'sesion-beto') })).reply).toBe(INVALID);
		const with_cookie = await connect_with(ANA, { ticket: 'basura' });
		expect(with_cookie.reply).toBe(INVALID);
		emit_to_room('messages:user:ana', 'update', { action: 'messages_refresh', data: ['privado'] });
		await send(with_cookie.sid, event('joinRoom', 'subjects'));
		emit_to_room('subjects', 'update', { action: 'testigo', data: [] });
		expect(await poll(with_cookie.sid)).not.toContain('privado');
	});

	test('el ticket de invitado conecta sin salas de usuario', async () => {
		const guest = sign_realtime_token({
			t: 'socket',
			gid: 'g-1',
			mid: 'reunion-1',
			name: 'Invitada',
			n: crypto.randomUUID(),
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const { sid, reply } = await connect_with(ELECTRON, { ticket: guest });
		expect(reply).toStartWith('40{"sid"');
		await send(
			sid,
			event('joinRoom', 'messages:user:ana'),
			event('joinRoom', 'route:r-g:driver'),
			event('joinRoom', 'ticketing_system_turns'),
		);
		emit_to_room('messages:user:ana', 'update', { action: 'x', data: ['privado'] });
		emit_to_room('route:r-g:driver', 'update', { action: 'x', data: ['privado'] });
		emit_to_room('ticketing_system_turns', 'update', { action: 'x', data: ['publico'] });
		const body = await poll(sid);
		expect(body).not.toContain('privado');
		expect(body).toContain('publico');
	});

	test('cerrar sesión cierra sus sockets, también los que entraron con su ticket', async () => {
		const by_cookie = await connect(ANA);
		const by_ticket = (await connect_with(ELECTRON, { ticket: ticket('ana', 'sesion-ana') })).sid;
		const other = await connect(BETO);
		const held = handle_socket_io(new Request(`${POLLING}&sid=${by_cookie}`)) as Promise<Response>;
		disconnect_sockets_for_auth_sid('sesion-ana');
		expect(await (await held).text()).toBe('41\x1e1');
		const late = (await handle_socket_io(new Request(`${POLLING}&sid=${by_ticket}`))) as Response;
		expect(late.status).toBe(400);
		emit_to_room('messages:user:beto', 'update', { action: 'x', data: ['sigue'] });
		expect(await poll(other)).toContain('sigue');
	});

	test('un segundo CONNECT no cambia la identidad: cerrar sesión sigue cortando el socket', async () => {
		const sid = await connect(ANA);
		await send(sid, `40${JSON.stringify({ ticket: ticket('beto', 'sesion-beto') })}`);
		disconnect_sockets_for_auth_sid('sesion-ana');
		emit_to_room('messages:user:ana', 'update', { action: 'messages_refresh', data: ['privado'] });
		const late = (await handle_socket_io(new Request(`${POLLING}&sid=${sid}`))) as Response;
		expect(late.status).toBe(400);
		expect(await late.text()).not.toContain('privado');
	});

	test('destroy_session de auth.ts cierra los sockets de esa sesión', async () => {
		const src = await Bun.file(new URL('./auth.ts', import.meta.url)).text();
		const destroy = src.slice(src.indexOf('async function destroy_session'));
		expect(destroy.slice(0, destroy.indexOf('\n}'))).toContain('disconnect_sockets_for_auth_sid(id)');
	});
});
