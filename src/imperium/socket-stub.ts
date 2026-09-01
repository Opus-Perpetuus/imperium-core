/**
 * Engine.IO v4 + Socket.IO polling en `/api/socket.io`.
 * El GET se sostiene hasta haber paquete o hasta `pingInterval`; si no, el
 * cliente reintenta en bucle y el shell Angular se queda en «Cargando».
 */

type Waiter = {
	resolve: (packet: string) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Session = {
	id: string;
	queue: string[];
	waiting: Waiter | null;
	expires: number;
	rooms: Set<string>;
};

/** Última posición del chofer, mismo TTL que CacheService del original. */
const DRIVER_LOCATION_TTL_MS = 120_000;

type DriverLocation = {
	route_id: string;
	vehicle_id?: string;
	user_id?: string;
	latitude: number;
	longitude: number;
	heading?: number;
	speed?: number;
	at: string;
};

const driver_positions = new Map<string, { payload: DriverLocation; expires: number }>();

export function remember_driver_location(input: {
	route_id?: string;
	vehicle_id?: string;
	user_id?: string;
	latitude?: unknown;
	longitude?: unknown;
	heading?: unknown;
	speed?: unknown;
	at?: string;
}): DriverLocation | null {
	const route_id = String(input.route_id ?? '').trim();
	const latitude = Number(input.latitude);
	const longitude = Number(input.longitude);
	if (!route_id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
		return null;
	}
	const payload: DriverLocation = {
		route_id,
		vehicle_id: input.vehicle_id ? String(input.vehicle_id) : undefined,
		user_id: input.user_id ? String(input.user_id) : undefined,
		latitude,
		longitude,
		heading: Number.isFinite(Number(input.heading)) ? Number(input.heading) : undefined,
		speed: Number.isFinite(Number(input.speed)) ? Number(input.speed) : undefined,
		at: input.at ?? new Date().toISOString(),
	};
	driver_positions.set(route_id, {
		payload,
		expires: Date.now() + DRIVER_LOCATION_TTL_MS,
	});
	return payload;
}

export function last_driver_location(route_id: string): DriverLocation | null {
	const id = String(route_id ?? '').trim();
	if (!id) return null;
	const entry = driver_positions.get(id);
	if (!entry) return null;
	if (entry.expires < Date.now()) {
		driver_positions.delete(id);
		return null;
	}
	return entry.payload;
}

/** Engine.IO long-poll hold / advertised pingInterval. */
export const SOCKET_IO_PING_MS = 25_000;
/**
 * `Bun.serve` idleTimeout (seconds). Bun's default is 10s; a silent long-poll
 * held for `SOCKET_IO_PING_MS` is then RST. Vite's `/api` proxy surfaces that
 * as `http proxy error … socket hang up`.
 */
export const SOCKET_IO_IDLE_TIMEOUT_SECONDS = 120;
const sessions = new Map<string, Session>();

export function handle_socket_io(
	req: Request,
): Response | Promise<Response> | null {
	const url = new URL(req.url);
	if (
		!url.pathname.startsWith('/api/socket.io') &&
		url.pathname !== '/socket.io/'
	) {
		return null;
	}
	const sid = url.searchParams.get('sid') ?? '';
	const origin = req.headers.get('origin') ?? '*';
	const headers: Record<string, string> = {
		'content-type': 'text/plain; charset=UTF-8',
		'access-control-allow-credentials': 'true',
		'access-control-allow-origin': origin === '*' ? '*' : origin,
		'access-control-allow-headers': 'content-type',
		'cache-control': 'no-store',
	};
	if (req.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers });
	}
	if (req.method === 'GET' && !sid) {
		const id = crypto.randomUUID().replace(/-/g, '');
		sessions.set(id, {
			id,
			queue: [],
			waiting: null,
			expires: Date.now() + 120_000,
			rooms: new Set(),
		});
		const open = `0${JSON.stringify({
			sid: id,
			upgrades: [],
			pingInterval: SOCKET_IO_PING_MS,
			pingTimeout: 20_000,
			maxPayload: 1_000_000,
		})}`;
		return new Response(open, { headers });
	}
	const session = sid ? sessions.get(sid) : undefined;
	if (!session) {
		return new Response('6', { status: 400, headers });
	}
	session.expires = Date.now() + 120_000;
	if (req.method === 'GET') {
		return hold_poll(session, headers, req.signal);
	}
	if (req.method === 'POST') {
		return req.text().then((raw) => {
			handle_client_packets(session, raw);
			return new Response('ok', { headers });
		});
	}
	return new Response('ok', { headers });
}

function hold_poll(
	session: Session,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Response> {
	if (session.queue.length) {
		const packet = session.queue.join('\x1e');
		session.queue = [];
		return Promise.resolve(new Response(packet, { headers }));
	}
	return new Promise((resolve) => {
		if (session.waiting) {
			clearTimeout(session.waiting.timer);
			session.waiting.resolve('2');
		}
		let settled = false;
		const finish = (body: string, status = 200) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', on_abort);
			if (session.waiting?.resolve === deliver) session.waiting = null;
			resolve(new Response(body, { status, headers }));
		};
		const deliver = (packet: string) => finish(packet);
		const timer = setTimeout(() => finish('2'), SOCKET_IO_PING_MS);
		const on_abort = () => finish('', 499);
		if (signal?.aborted) {
			on_abort();
			return;
		}
		signal?.addEventListener('abort', on_abort, { once: true });
		session.waiting = {
			timer,
			resolve: deliver,
		};
	});
}

function enqueue(session: Session, packet: string) {
	if (session.waiting) session.waiting.resolve(packet);
	else session.queue.push(packet);
}

function handle_client_packets(session: Session, raw: string) {
	const chunks = raw.split('\x1e').map((s) => s.trim()).filter(Boolean);
	for (const chunk of chunks.length ? chunks : [raw]) {
		if (chunk === '2') {
			enqueue(session, '3');
			continue;
		}
		if (chunk === '3' || chunk === '') continue;
		if (chunk.startsWith('40')) {
			enqueue(session, `40${JSON.stringify({ sid: session.id })}`);
			continue;
		}
		if (chunk.startsWith('41')) {
			sessions.delete(session.id);
			continue;
		}
		if (chunk.startsWith('42')) {
			handle_socket_event(session, chunk);
			continue;
		}
	}
}

setInterval(() => {
	const now = Date.now();
	for (const [id, s] of sessions) {
		if (s.expires < now) {
			if (s.waiting) {
				clearTimeout(s.waiting.timer);
				s.waiting.resolve('1');
			}
			sessions.delete(id);
		}
	}
}, 60_000).unref?.();

function handle_socket_event(session: Session, chunk: string) {
	const match = chunk.match(/^42\d*(\[.*\])$/);
	if (!match) return;
	let args: unknown[];
	try {
		args = JSON.parse(match[1]!) as unknown[];
	} catch {
		return;
	}
	const event = String(args[0] ?? '');
	if (event === 'joinRoom' && typeof args[1] === 'string') {
		session.rooms.add(args[1]);
		return;
	}
	if (event === 'leaveRoom' && typeof args[1] === 'string') {
		session.rooms.delete(args[1]);
		return;
	}
	if (event === 'messageToRoom' && args[1] && typeof args[1] === 'object') {
		const data = args[1] as { room?: string; msg?: string };
		const room = String(data.room ?? '');
		if (room) emit_to_room(room, 'message', { room, msg: String(data.msg ?? '') });
		return;
	}
	if (event === 'driverLocation' && args[1] && typeof args[1] === 'object') {
		const payload = remember_driver_location(args[1] as Parameters<typeof remember_driver_location>[0]);
		if (payload) emit_to_room(`route:${payload.route_id}:driver`, 'driver_location', payload);
	}
}

function packet_event(event: string, data: unknown): string {
	return `42${JSON.stringify([event, data])}`;
}

export function emit_to_room(room: string, event: string, data: unknown): void {
	if (!room) return;
	const packet = packet_event(event, data);
	for (const session of sessions.values()) {
		if (session.rooms.has(room)) enqueue(session, packet);
	}
}

export function broadcast_event(event: string, data: unknown): void {
	const packet = packet_event(event, data);
	for (const session of sessions.values()) enqueue(session, packet);
}

export function emit_notifications_refresh(
	user_ids: string[],
	payload: {
		reason: string;
		notification_ids?: string[];
	},
): void {
	for (const uid of [...new Set(user_ids)].filter(Boolean)) {
		emit_to_room(`notifications:user:${uid}`, 'update', {
			action: 'notifications_refresh',
			data: [
				{
					recipient_id: uid,
					...payload,
				},
			],
		});
	}
}

export function emit_messages_refresh(
	user_ids: string[],
	payload: {
		reason: string;
		conversation_key?: string;
		message_ids?: string[];
		message?: unknown;
	},
): void {
	for (const uid of [...new Set(user_ids)].filter(Boolean)) {
		emit_to_room(`messages:user:${uid}`, 'update', {
			action: 'messages_refresh',
			data: [
				{
					recipient_id: uid,
					...payload,
				},
			],
		});
	}
}
