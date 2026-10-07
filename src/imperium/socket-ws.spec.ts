import { afterAll, describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { ChatError } from './chat-access.ts';
import { sign_realtime_token } from './realtime-tokens.ts';
import {
	bind_socket_identity_resolver,
	emit_to_room,
	emit_to_session,
	emit_to_users,
	handle_socket_io,
	join_room_server,
	on_socket_close,
	on_socket_event,
	online_user_ids,
	realtime_tick,
	socket_websocket_handler,
	upgrade_socket_io,
} from './socket-stub.ts';

const USERS: Record<string, string> = { 'sesion-ana': 'ana', 'sesion-beto': 'beto', 'sesion-carla': 'carla' };

bind_socket_identity_resolver(async (session_id) => USERS[session_id] ?? null);

const server = Bun.serve({
	port: 0,
	websocket: socket_websocket_handler,
	fetch(req, srv) {
		remember_socket_ip(req, srv.requestIP(req)?.address ?? null);
		const upgraded = upgrade_socket_io(req, srv);
		if (upgraded === 'upgraded') return undefined;
		if (upgraded) return upgraded;
		return handle_socket_io(req) ?? new Response('no', { status: 404 });
	},
});

afterAll(() => {
	void server.stop(true);
});

const HOST = `127.0.0.1:${server.port}`;
const POLLING = `http://${HOST}/api/socket.io/?EIO=4&transport=polling`;
const ANA = { cookie: 'connect.sid=sesion-ana' };

type Client = {
	ws: WebSocket;
	next: () => Promise<string>;
	send: (packet: string) => void;
	closed: Promise<void>;
};

function open_ws(query = '', headers: Record<string, string> = {}): Promise<Client> {
	const ws = new WebSocket(`ws://${HOST}/api/socket.io/?EIO=4&transport=websocket${query}`, { headers });
	const inbox: string[] = [];
	const waiting: ((packet: string) => void)[] = [];
	ws.onmessage = (ev) => {
		const packet = String(ev.data);
		const take = waiting.shift();
		if (take) take(packet);
		else inbox.push(packet);
	};
	const closed = new Promise<void>((resolve) => {
		ws.addEventListener('close', () => resolve());
	});
	const next = () =>
		inbox.length
			? Promise.resolve(inbox.shift()!)
			: new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('sin paquete del servidor')), 2000);
					waiting.push((packet) => {
						clearTimeout(timer);
						resolve(packet);
					});
				});
	return new Promise((resolve, reject) => {
		ws.onopen = () => resolve({ ws, next, send: (packet) => ws.send(packet), closed });
		ws.onerror = () => reject(new Error('no abrió el WebSocket'));
	});
}

/** WS directo ya conectado (`40`); devuelve el `sid` del socket. */
async function connected(headers: Record<string, string> = {}, auth?: Record<string, unknown>) {
	const client = await open_ws('', headers);
	const open = await client.next();
	client.send(auth ? `40${JSON.stringify(auth)}` : '40');
	const reply = await client.next();
	return { ...client, sid: (JSON.parse(open.slice(1)) as { sid: string }).sid, reply };
}

function ticket(sub: string, sid: string) {
	return sign_realtime_token({
		t: 'socket',
		sub,
		sid,
		n: crypto.randomUUID(),
		exp: Math.floor(Date.now() / 1000) + 60,
	});
}

function ack_of(packet: string, id: number): Record<string, unknown> {
	expect(packet.startsWith(`43${id}[`)).toBe(true);
	return (JSON.parse(packet.slice(`43${id}`.length)) as Record<string, unknown>[])[0]!;
}

describe('socket por WebSocket', () => {
	test('WS directo recibe 0{…} sin mejoras y conecta con 40', async () => {
		const client = await open_ws();
		const open = JSON.parse((await client.next()).slice(1)) as Record<string, unknown>;
		expect(open.sid).toBeTruthy();
		expect(open.upgrades).toEqual([]);
		expect(open.pingInterval).toBe(25_000);
		expect(open.pingTimeout).toBe(20_000);
		client.send('40');
		expect(await client.next()).toBe(`40${JSON.stringify({ sid: open.sid })}`);
		client.ws.close();
	});

	test('el polling anuncia la mejora a websocket', async () => {
		const open = JSON.parse((await (await fetch(POLLING)).text()).slice(1)) as Record<string, unknown>;
		expect(open.upgrades).toEqual(['websocket']);
	});

	test('40{ticket} identifica fuera del mismo origen; un ticket malo responde 44', async () => {
		const ana = await connected({ origin: 'app://imperium' }, { ticket: ticket('ana', 'sesion-ana') });
		expect(ana.reply).toStartWith('40{"sid"');
		emit_to_users(['ana'], 'update', { action: 'prueba', data: ['para-ana'] });
		expect(await ana.next()).toContain('para-ana');
		const bad = await connected({ origin: 'app://imperium' }, { ticket: 'no-es-un-ticket' });
		expect(bad.reply).toBe(`44${JSON.stringify({ message: 'Sesión de tiempo real no válida' })}`);
		ana.ws.close();
		bad.ws.close();
	});

	test('la cookie del mismo origen identifica por WS y une las salas propias', async () => {
		const carla = await connected({ cookie: 'connect.sid=sesion-carla' });
		emit_to_room('messages:user:carla', 'update', { action: 'messages_refresh', data: ['propio'] });
		expect(await carla.next()).toContain('propio');
		expect(online_user_ids().has('carla')).toBe(true);
		carla.ws.close();
		await carla.closed;
		await Bun.sleep(20);
		expect(online_user_ids().has('carla')).toBe(false);
	});

	test('sonda desde polling: 3probe, el poll se libera con 6 y con 5 todo sigue por WS', async () => {
		const open = JSON.parse((await (await fetch(POLLING)).text()).slice(1)) as { sid: string };
		const polled = `${POLLING}&sid=${open.sid}`;
		await fetch(polled, { method: 'POST', body: '40' });
		expect(await (await fetch(polled)).text()).toStartWith('40');
		await fetch(polled, { method: 'POST', body: `42${JSON.stringify(['joinRoom', 'subjects'])}` });
		const held = fetch(polled).then((res) => res.text());
		await Bun.sleep(20);
		const probe = await open_ws(`&sid=${open.sid}`);
		probe.send('2probe');
		expect(await probe.next()).toBe('3probe');
		expect(await held).toBe('6');
		emit_to_room('subjects', 'update', { action: 'en-la-mejora', data: [] });
		probe.send('5');
		expect(await probe.next()).toContain('en-la-mejora');
		expect((await fetch(polled)).status).toBe(400);
		emit_to_room('subjects', 'update', { action: 'ya-por-ws', data: [] });
		expect(await probe.next()).toContain('ya-por-ws');
		probe.ws.close();
	});

	test('acks: 42<n> → 43<n>[{ok, …}]; los errores del chat salen con su código', async () => {
		on_socket_event('prueba:eco', (ctx, data) => ({
			eco: data,
			user_id: ctx.identity.kind === 'user' ? ctx.identity.user_id : null,
		}));
		on_socket_event('prueba:falla', () => {
			throw new ChatError(403, 'not_member', 'No participas en esta conversación.');
		});
		on_socket_event('prueba:corto', () => ({}), { max_bytes: 64 });
		on_socket_event('prueba:lento', () => ({}), { per_second: 2 });
		const ana = await connected(ANA);
		ana.send(`421${JSON.stringify(['prueba:eco', { a: 1 }])}`);
		expect(ack_of(await ana.next(), 1)).toEqual({ eco: { a: 1 }, user_id: 'ana', ok: true });
		ana.send(`422${JSON.stringify(['prueba:falla', {}])}`);
		expect(ack_of(await ana.next(), 2)).toEqual({
			ok: false,
			code: 'not_member',
			message: 'No participas en esta conversación.',
		});
		ana.send(`423${JSON.stringify(['prueba:corto', 'x'.repeat(100)])}`);
		expect(ack_of(await ana.next(), 3)).toMatchObject({ ok: false, code: 'event_too_large' });
		for (const id of [4, 5, 6]) ana.send(`42${id}${JSON.stringify(['prueba:lento', {}])}`);
		expect(ack_of(await ana.next(), 4).ok).toBe(true);
		expect(ack_of(await ana.next(), 5).ok).toBe(true);
		expect(ack_of(await ana.next(), 6)).toMatchObject({ ok: false, code: 'socket_rate_limited' });
		ana.send(`427${JSON.stringify(['prueba:inexistente', {}])}`);
		expect(ack_of(await ana.next(), 7)).toMatchObject({ ok: false, code: 'invalid_request' });
		ana.send(`428${JSON.stringify(['joinRoom', 'messages:user:beto'])}`);
		expect(ack_of(await ana.next(), 8)).toMatchObject({ ok: false, code: 'forbidden' });

		const anon = await connected();
		anon.send(`421${JSON.stringify(['prueba:eco', {}])}`);
		expect(ack_of(await anon.next(), 1)).toMatchObject({ ok: false, code: 'unauthenticated' });
		ana.ws.close();
		anon.ws.close();
	});

	test('un invitado solo llega a los eventos que lo admiten', async () => {
		on_socket_event('prueba:sala', (ctx) => ({ kind: ctx.identity.kind }), { allow_guest: true });
		on_socket_event('prueba:interno', () => ({}));
		const guest_ticket = sign_realtime_token({
			t: 'socket',
			gid: 'g-1',
			mid: 'reunion-1',
			name: 'Invitada',
			n: crypto.randomUUID(),
			exp: Math.floor(Date.now() / 1000) + 60,
		});
		const guest = await connected({ origin: 'app://imperium' }, { ticket: guest_ticket });
		guest.send(`421${JSON.stringify(['prueba:sala', {}])}`);
		expect(ack_of(await guest.next(), 1)).toEqual({ kind: 'guest', ok: true });
		guest.send(`422${JSON.stringify(['prueba:interno', {}])}`);
		expect(ack_of(await guest.next(), 2)).toMatchObject({ ok: false, code: 'forbidden' });
		guest.ws.close();
	});

	test('el servidor une a salas que el cliente no puede pedir; except salta al emisor', async () => {
		const ana = await connected(ANA);
		const beto = await connected({ cookie: 'connect.sid=sesion-beto' });
		ana.send(`421${JSON.stringify(['joinRoom', 'call:c-1'])}`);
		expect(ack_of(await ana.next(), 1)).toMatchObject({ ok: false, code: 'forbidden' });
		join_room_server(ana.sid, 'call:c-1');
		join_room_server(beto.sid, 'call:c-1');
		emit_to_room('call:c-1', 'call:roster', { call_id: 'c-1', from: 'ana' }, ana.sid);
		expect(await beto.next()).toContain('"from":"ana"');
		emit_to_session(ana.sid, 'update', { action: 'solo-ana', data: [] });
		expect(await ana.next()).toContain('solo-ana');
		ana.ws.close();
		beto.ws.close();
	});

	test('on_socket_close avisa con la identidad de la sesión que se fue', async () => {
		const gone: string[] = [];
		on_socket_close(({ identity }) => {
			if (identity?.kind === 'user') gone.push(identity.user_id);
		});
		const beto = await connected({ cookie: 'connect.sid=sesion-beto' });
		beto.ws.close();
		await beto.closed;
		await Bun.sleep(20);
		expect(gone).toContain('beto');
	});
});

describe('latido', () => {
	test('con 3 a tiempo la sesión sigue viva', async () => {
		const ana = await connected(ANA);
		realtime_tick(Date.now() + 26_000);
		expect(await ana.next()).toBe('2');
		ana.send('3');
		ana.send(`421${JSON.stringify(['joinRoom', 'subjects'])}`);
		expect(ack_of(await ana.next(), 1).ok).toBe(true);
		realtime_tick(Date.now() + 40_000);
		emit_to_room('subjects', 'update', { action: 'sigue-viva', data: [] });
		expect(await ana.next()).toContain('sigue-viva');
		ana.ws.close();
	});

	test('sin 3 en 45 s se cierra', async () => {
		const ana = await connected(ANA);
		realtime_tick(Date.now() + 26_000);
		expect(await ana.next()).toBe('2');
		realtime_tick(Date.now() + 46_000);
		await ana.closed;
		expect(ana.ws.readyState).toBe(WebSocket.CLOSED);
	});
});

describe('límites del socket', () => {
	test('60 eventos por segundo por sesión; si el exceso sigue, se desconecta', async () => {
		on_socket_event('prueba:rafaga', () => ({}));
		const ana = await connected(ANA);
		for (let i = 1; i <= 61; i++) ana.send(`42${i}${JSON.stringify(['prueba:rafaga', {}])}`);
		const acks = [];
		for (let i = 1; i <= 61; i++) acks.push(ack_of(await ana.next(), i));
		expect(acks.filter((ack) => ack.ok === true).length).toBeGreaterThanOrEqual(60);
		expect(acks.at(-1)).toMatchObject({ ok: false, code: 'socket_rate_limited' });
		for (let i = 0; i < 200; i++) ana.send(`42${JSON.stringify(['prueba:rafaga', {}])}`);
		await ana.closed;
	});

	test('60 handshakes por minuto por IP', async () => {
		const handshake = () => {
			const req = new Request(POLLING);
			remember_socket_ip(req, '203.0.113.9');
			return handle_socket_io(req) as Response;
		};
		for (let i = 0; i < 60; i++) expect(handshake().status).toBe(200);
		const limited = handshake();
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		expect(((await limited.json()) as Record<string, unknown>).code).toBe('rate_limited');
	});

	describe('detrás de un proxy', () => {
		const declared = process.env.TRUST_PROXY_HEADERS;
		afterAll(() => {
			if (declared === undefined) delete process.env.TRUST_PROXY_HEADERS;
			else process.env.TRUST_PROXY_HEADERS = declared;
		});
		const handshake = (cookie: string, headers: Record<string, string> = {}) => {
			const req = new Request(POLLING, { headers: { ...headers, cookie: `connect.sid=${cookie}` } });
			remember_socket_ip(req, '172.18.0.5');
			return handle_socket_io(req) as Response;
		};

		test('sin cabeceras declaradas, la IP es la del proxy: el límite va por sesión y no castiga a todo el tenant', () => {
			delete process.env.TRUST_PROXY_HEADERS;
			const tenant = crypto.randomUUID();
			for (let i = 0; i < 61; i++) expect(handshake(`${tenant}-${i}`).status).toBe(200);
			for (let i = 0; i < 60; i++) expect(handshake(`${tenant}-reconecta`).status).toBe(200);
			expect(handshake(`${tenant}-reconecta`).status).toBe(429);
		});

		test('con cabeceras declaradas, cuenta la IP del cliente que reenvía el proxy', () => {
			process.env.TRUST_PROXY_HEADERS = '1';
			const tenant = crypto.randomUUID();
			const from = { 'x-forwarded-for': '198.51.100.23' };
			for (let i = 0; i < 60; i++) expect(handshake(`${tenant}-${i}`, from).status).toBe(200);
			expect(handshake(`${tenant}-otra`, from).status).toBe(429);
			expect(handshake(`${tenant}-otra`, { 'x-forwarded-for': '198.51.100.24' }).status).toBe(200);
		});
	});

	test('la cola del polling descarta primero lo efímero y, si sigue llena, cierra', async () => {
		const open = (await (handle_socket_io(new Request(POLLING)) as Response).text()).slice(1);
		const sid = (JSON.parse(open) as { sid: string }).sid;
		const polled = `${POLLING}&sid=${sid}`;
		await handle_socket_io(new Request(polled, { method: 'POST', body: '40' }));
		await handle_socket_io(
			new Request(polled, { method: 'POST', body: `42${JSON.stringify(['joinRoom', 'module-management'])}` }),
		);
		expect(await ((await handle_socket_io(new Request(polled))) as Response).text()).toStartWith('40');
		for (let i = 0; i < 500; i++) emit_to_room('module-management', 'driver_location', { i });
		emit_to_room('module-management', 'update', { action: 'durable', data: [] });
		const body = await ((await handle_socket_io(new Request(polled))) as Response).text();
		expect(body).toContain('durable');
		expect(body).not.toContain('driver_location');
		for (let i = 0; i <= 500; i++) emit_to_room('module-management', 'update', { action: 'lleno', data: [i] });
		expect(((await handle_socket_io(new Request(polled))) as Response).status).toBe(400);
	});
});
