/**
 * Engine.IO v4 + Socket.IO en `/api/socket.io`: long-polling y WebSocket nativo
 * de Bun. El cliente entra por polling y sube a WS (`2probe`/`3probe`, el poll
 * pendiente se libera con `6`, el cambio llega con `5`) o abre el WS directo.
 * El GET se sostiene hasta haber paquete o hasta `pingInterval`; si no, el
 * cliente reintenta en bucle y el shell Angular se queda en «Cargando».
 */
import { request_ip, request_ip_names_client } from './auth-rate-limit.ts';
import { ChatError } from './chat-access.ts';
import { rate_limited_response, take_token } from './rate-bucket.ts';
import { verify_realtime_token } from './realtime-tokens.ts';

type Waiter = {
	resolve: (packet: string) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Queued = { packet: string; ephemeral: boolean };

type Session = {
	id: string;
	/** Con WS ya no hay polls: lo pendiente sale por aquí. */
	ws: Bun.ServerWebSocket<SocketWsData> | null;
	/** Hay una sonda WS abierta: un poll nuevo se libera al momento. */
	probing: boolean;
	queue: Queued[];
	waiting: Waiter | null;
	expires: number;
	rooms: Set<string>;
	/** Vacío si el handshake no traía cookie o venía de un origen ajeno. */
	cookie_sid: string;
	connected: boolean;
	identity: SocketIdentity | null;
	denials_logged: number;
	/** Hay contrapresión en el WS: lo efímero se descarta hasta `drain`. */
	congested: boolean;
	pinged_at: number;
	ponged_at: number;
	over_quota: number;
};

/** `auth_sid`: la sesión HTTP que la respalda; al cerrarla se cierra el socket. */
export type SocketIdentity =
	| { kind: 'user'; user_id: string; auth_sid: string }
	| { kind: 'guest'; guest_id: string; meeting_id: string };

/** `sid` vacío hasta abrir un WS directo; `probe`: sonda de una sesión en polling. */
export type SocketWsData = { sid: string; probe: boolean; cookie_sid: string };

export type SocketEventContext = { session_id: string; identity: SocketIdentity };

export type SocketEventOptions = { allow_guest?: boolean; per_second?: number; max_bytes?: number };

type AckBody = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string };

const PUBLIC_ROOMS = new Set(['ticketing_system_turns', 'module-management', 'subjects']);
const PRIVATE_ROOM = /^(user|messages:user|notifications:user|call|meeting):/;
const DRIVER_ROOM = /^route:[^:\s]+:driver$/;
const MESSAGE_TO_ROOM_MAX_BYTES = 4096;
const MESSAGE_TO_ROOM_RATE = { capacity: 10, refill_per_s: 10 };
const EVENTS_PER_SESSION = { capacity: 60, refill_per_s: 60 };
const HANDSHAKES_PER_CLIENT = { capacity: 60, refill_per_s: 1 };
/**
 * Tope de todo el núcleo, el único que queda si nada identifica al cliente: la
 * reconexión masiva tras un reinicio (un handshake por pestaña) cabe en la
 * ráfaga y lo sostenido acota las sesiones vivas, que vencen a los 120 s.
 */
const HANDSHAKES_TOTAL = { capacity: 2000, refill_per_s: 50 };
const POLL_QUEUE_MAX = 500;
/** `pingInterval + pingTimeout`: el mismo plazo que se da el cliente. */
const PONG_DEADLINE_MS = 45_000;
// Cada negación persiste en la bitácora y se difunde a todos los sockets.
const DENIALS_LOGGED_PER_SESSION = 5;
const EPHEMERAL_UPDATES = new Set(['chat_typing', 'presence']);

const OK: AckBody = { ok: true };
const UNAUTHENTICATED = refusal('unauthenticated', 'Inicia sesión para continuar.');
const FORBIDDEN = refusal('forbidden', 'No tienes permiso para hacer esto.');
const INVALID_REQUEST = refusal('invalid_request', 'La petición no es válida.');
const SOCKET_RATE_LIMITED = refusal('socket_rate_limited', 'Vas demasiado rápido.');
const EVENT_TOO_LARGE = refusal('event_too_large', 'El mensaje en tiempo real es demasiado grande.');

function refusal(code: string, message: string): AckBody {
	return { ok: false, code, message };
}

/** Usuario interno dueño de una sesión HTTP; lo inyecta `server.ts` para no importar `auth.ts`. */
type SessionUserResolver = (session_id: string) => Promise<string | null>;
let resolve_session_user: SessionUserResolver = async () => null;

export function bind_socket_identity_resolver(resolver: SessionUserResolver): void {
	resolve_session_user = resolver;
}

type SocketEventHandler = (ctx: SocketEventContext, data: unknown) => unknown;
type SocketCloseHandler = (ctx: { session_id: string; identity: SocketIdentity | null }) => void;
type SocketConnectHandler = (ctx: SocketEventContext) => void;
type RealtimeTickHandler = (now: number) => void;

const event_handlers = new Map<string, { handler: SocketEventHandler; opts: SocketEventOptions }>();
const close_handlers: SocketCloseHandler[] = [];
const connect_handlers: SocketConnectHandler[] = [];
const tick_handlers: RealtimeTickHandler[] = [];

/** Evento cliente → servidor con identidad; lo que devuelve va en el ack como `{ok: true, …}`. */
export function on_socket_event(
	name: string,
	handler: SocketEventHandler,
	opts: SocketEventOptions = {},
): void {
	event_handlers.set(name, { handler, opts });
}

export function on_socket_close(handler: SocketCloseHandler): void {
	close_handlers.push(handler);
}

/** Una sesión ya conectada con identidad (usuario o invitado). */
export function on_socket_connect(handler: SocketConnectHandler): void {
	connect_handlers.push(handler);
}

/** Corre en cada latido con el mismo `now`. */
export function on_realtime_tick(handler: RealtimeTickHandler): void {
	tick_handlers.push(handler);
}

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

function is_socket_path(pathname: string): boolean {
	return pathname.startsWith('/api/socket.io') || pathname === '/socket.io/';
}

function open_session(cookie_sid: string, ws: Bun.ServerWebSocket<SocketWsData> | null): Session {
	const id = crypto.randomUUID().replace(/-/g, '');
	const now = Date.now();
	const session: Session = {
		id,
		ws,
		probing: false,
		queue: [],
		waiting: null,
		expires: now + 120_000,
		rooms: new Set(),
		cookie_sid,
		connected: false,
		identity: null,
		denials_logged: 0,
		congested: false,
		pinged_at: now,
		ponged_at: now,
		over_quota: 0,
	};
	sessions.set(id, session);
	return session;
}

function open_packet(sid: string, upgrades: string[]): string {
	return `0${JSON.stringify({
		sid,
		upgrades,
		pingInterval: SOCKET_IO_PING_MS,
		pingTimeout: PONG_DEADLINE_MS - SOCKET_IO_PING_MS,
		maxPayload: 1_000_000,
	})}`;
}

/**
 * Sin TRUST_PROXY_HEADERS, detrás del proxy `request_ip` es la IP del proxy: el
 * cubo por IP sería uno para todo el tenant. Ahí cuenta la cookie de sesión. El
 * ticket llega después, en el CONNECT, y su emisión ya tiene cuota por usuario.
 */
function handshake_client(req: Request): string | null {
	if (request_ip_names_client(req)) return `ip:${request_ip(req)}`;
	const sid = session_cookie(req);
	return sid ? `sid:${sid}` : null;
}

function too_many_handshakes(req: Request, headers: Record<string, string>): Response | null {
	const client = handshake_client(req);
	const own = client ? take_token(`socket-handshake:${client}`, HANDSHAKES_PER_CLIENT) : null;
	const verdict = own && !own.ok ? own : take_token('socket-handshake', HANDSHAKES_TOTAL);
	if (verdict.ok) return null;
	const res = rate_limited_response(verdict.retry_after_s);
	for (const [name, value] of Object.entries(headers)) {
		if (name !== 'content-type') res.headers.set(name, value);
	}
	return res;
}

export function handle_socket_io(
	req: Request,
): Response | Promise<Response> | null {
	const url = new URL(req.url);
	if (!is_socket_path(url.pathname)) return null;
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
		const limited = too_many_handshakes(req, headers);
		if (limited) return limited;
		const session = open_session(cookie_origin_allowed(req) ? session_cookie(req) : '', null);
		return new Response(open_packet(session.id, ['websocket']), { headers });
	}
	const session = sid ? sessions.get(sid) : undefined;
	// Ya subida a WS, el polling de esa sesión se terminó.
	if (!session || session.ws) {
		return new Response('6', { status: 400, headers });
	}
	session.expires = Date.now() + 120_000;
	if (req.method === 'GET') {
		return hold_poll(session, headers, req.signal);
	}
	if (req.method === 'POST') {
		return req.text().then(async (raw) => {
			await handle_client_packets(session, raw);
			return new Response('ok', { headers });
		});
	}
	return new Response('ok', { headers });
}

/**
 * Sube a WS una petición del socket. `'upgraded'`: `fetch` devuelve `undefined`;
 * una respuesta: el rechazo; `null`: no era del socket.
 */
export function upgrade_socket_io(
	req: Request,
	server: Bun.Server<SocketWsData>,
): 'upgraded' | Response | null {
	if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null;
	const url = new URL(req.url);
	if (!is_socket_path(url.pathname)) return null;
	const sid = url.searchParams.get('sid') ?? '';
	let data: SocketWsData;
	if (sid) {
		const session = sessions.get(sid);
		if (!session || session.ws) return new Response('6', { status: 400 });
		data = { sid, probe: true, cookie_sid: '' };
	} else {
		const limited = too_many_handshakes(req, {});
		if (limited) return limited;
		data = { sid: '', probe: false, cookie_sid: cookie_origin_allowed(req) ? session_cookie(req) : '' };
	}
	return server.upgrade(req, { data }) ? 'upgraded' : new Response('6', { status: 400 });
}

export const socket_websocket_handler: Bun.WebSocketHandler<SocketWsData> = {
	maxPayloadLength: 1_000_000,
	idleTimeout: SOCKET_IO_IDLE_TIMEOUT_SECONDS,
	open(ws) {
		if (ws.data.probe) return;
		const session = open_session(ws.data.cookie_sid, ws);
		ws.data.sid = session.id;
		ws.send(open_packet(session.id, []));
	},
	message(ws, raw) {
		const packet = typeof raw === 'string' ? raw : raw.toString();
		const session = sessions.get(ws.data.sid);
		if (!session) {
			ws.close();
			return;
		}
		if (ws.data.probe) {
			probe_packet(session, ws, packet);
			return;
		}
		void handle_client_packet(session, packet);
	},
	drain(ws) {
		const session = sessions.get(ws.data.sid);
		if (session) session.congested = false;
	},
	close(ws) {
		const session = sessions.get(ws.data.sid);
		if (!session) return;
		if (session.ws === ws) end_session(session);
		else if (ws.data.probe) session.probing = false;
	},
};

/** Sonda desde polling: `2probe` → `3probe` y se libera el poll; con `5` la sesión pasa al WS. */
function probe_packet(session: Session, ws: Bun.ServerWebSocket<SocketWsData>, packet: string): void {
	if (packet === '2probe') {
		session.probing = true;
		ws.send('3probe');
		session.waiting?.resolve('6');
		return;
	}
	if (packet !== '5') return;
	ws.data.probe = false;
	session.ws = ws;
	session.probing = false;
	session.pinged_at = session.ponged_at = Date.now();
	session.waiting?.resolve('6');
	const pending = session.queue;
	session.queue = [];
	for (const item of pending) deliver(session, item.packet, item.ephemeral);
}

/**
 * Una página de otro origen del mismo sitio también manda la cookie Lax: solo
 * cuenta si el origen es el propio, ambos son locales (proxy de desarrollo) o
 * está en `IMPERIUM_SOCKET_ALLOWED_ORIGINS`.
 */
function cookie_origin_allowed(req: Request): boolean {
	const origin = req.headers.get('origin');
	if (!origin) return true;
	let from: URL;
	try {
		from = new URL(origin);
	} catch {
		return false;
	}
	const hosts = [new URL(req.url).host, req.headers.get('x-forwarded-host')?.split(',')[0]?.trim()]
		.filter((host): host is string => Boolean(host))
		.map((host) => host.toLowerCase());
	if (hosts.includes(from.host)) return true;
	if (is_loopback(from.hostname) && hosts.some((host) => is_loopback(host.replace(/:\d+$/, '')))) {
		return true;
	}
	return String(process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((allowed) => allowed.trim().replace(/\/+$/, ''))
		.includes(from.origin);
}

function is_loopback(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Cookie de sesión del núcleo (`auth.ts`). */
function session_cookie(req: Request): string {
	const m = (req.headers.get('cookie') ?? '').match(/(?:^|;\s*)connect\.sid=([^;]+)/);
	if (!m) return '';
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		return '';
	}
}

function hold_poll(
	session: Session,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<Response> {
	if (session.queue.length) {
		const packet = session.queue.map((item) => item.packet).join('\x1e');
		session.queue = [];
		return Promise.resolve(new Response(packet, { headers }));
	}
	// El cliente no termina la sonda hasta que vuelve el poll en curso.
	if (session.probing) return Promise.resolve(new Response('6', { headers }));
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
		const timer = setTimeout(() => {
			session.pinged_at = Date.now();
			finish('2');
		}, SOCKET_IO_PING_MS);
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

/**
 * Bajo presión se pierde primero lo efímero: el cliente resincroniza lo
 * durable. Si aun así no cabe, se cierra la sesión.
 */
function deliver(session: Session, packet: string, ephemeral: boolean): void {
	if (session.ws) {
		if (ephemeral && session.congested) return;
		const status = session.ws.send(packet);
		if (status === -1) session.congested = true;
		else if (status === 0) end_session(session);
		return;
	}
	if (session.waiting) {
		session.waiting.resolve(packet);
		return;
	}
	if (session.queue.length >= POLL_QUEUE_MAX) {
		if (ephemeral) return;
		session.queue = session.queue.filter((item) => !item.ephemeral);
		if (session.queue.length >= POLL_QUEUE_MAX) {
			end_session(session);
			return;
		}
	}
	session.queue.push({ packet, ephemeral });
}

/** `farewell` sale antes del cierre: `41` corta la reconexión automática del cliente. */
function end_session(session: Session, farewell: string[] = []): void {
	if (!sessions.delete(session.id)) return;
	if (session.waiting) {
		clearTimeout(session.waiting.timer);
		session.waiting.resolve([...farewell, '1'].join('\x1e'));
	}
	if (session.ws) {
		for (const packet of farewell) session.ws.send(packet);
		session.ws.close();
	}
	for (const handler of close_handlers) {
		try {
			handler({ session_id: session.id, identity: session.identity });
		} catch (err) {
			report_handler_error('on_socket_close', err);
		}
	}
}

async function handle_client_packets(session: Session, raw: string) {
	const chunks = raw.split('\x1e').map((s) => s.trim()).filter(Boolean);
	for (const chunk of chunks.length ? chunks : [raw]) {
		await handle_client_packet(session, chunk);
	}
}

async function handle_client_packet(session: Session, packet: string): Promise<void> {
	if (packet === '2') return deliver(session, '3', false);
	if (packet === '3') {
		session.ponged_at = Date.now();
		return;
	}
	if (packet === '1' || packet.startsWith('41')) return end_session(session);
	if (packet.startsWith('40')) return connect_session(session, packet);
	if (packet.startsWith('42')) return handle_socket_event(session, packet);
}

/**
 * Latido de los dos transportes: el cliente solo reinicia su plazo con un `2`, y
 * un polling con tráfico nunca deja un poll vacío 25 s. `now` es inyectable para las pruebas.
 */
export function realtime_tick(now = Date.now()): void {
	for (const session of sessions.values()) {
		if ((!session.ws && session.expires < now) || now - session.ponged_at > PONG_DEADLINE_MS) {
			end_session(session);
			continue;
		}
		if (now - session.pinged_at >= SOCKET_IO_PING_MS) {
			session.pinged_at = now;
			deliver(session, '2', false);
		}
	}
	for (const handler of tick_handlers) {
		try {
			handler(now);
		} catch (err) {
			report_handler_error('on_realtime_tick', err);
		}
	}
}

setInterval(() => realtime_tick(), 1000).unref?.();

/** Ticket, luego cookie, luego anónimo. Un ticket inválido no cae a la cookie: se responde 44. */
async function connect_session(session: Session, chunk: string) {
	// Un cliente conecta una sola vez por sesión: otro 40 cambiaría la identidad, y con ella
	// el auth_sid que corta el cierre de sesión, sin soltar las salas privadas ya unidas.
	if (session.connected) return;
	session.connected = true;
	const ticket = connect_auth(chunk).ticket;
	if (typeof ticket === 'string') {
		const identity = await ticket_identity(ticket);
		if (!identity) {
			deliver(session, `44${JSON.stringify({ message: 'Sesión de tiempo real no válida' })}`, false);
			return;
		}
		session.identity = identity;
	} else if (session.cookie_sid) {
		const user_id = await session_user(session.cookie_sid);
		if (user_id) session.identity = { kind: 'user', user_id, auth_sid: session.cookie_sid };
	}
	const user_id = user_of(session);
	if (user_id) for (const room of own_rooms(user_id)) session.rooms.add(room);
	deliver(session, `40${JSON.stringify({ sid: session.id })}`, false);
	const identity = session.identity;
	if (!identity) return;
	for (const handler of connect_handlers) {
		try {
			handler({ session_id: session.id, identity });
		} catch (err) {
			report_handler_error('on_socket_connect', err);
		}
	}
}

function connect_auth(chunk: string): Record<string, unknown> {
	const raw = chunk.slice(2);
	if (!raw.startsWith('{')) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

async function ticket_identity(ticket: string): Promise<SocketIdentity | null> {
	const claims = verify_realtime_token(ticket, 'socket');
	if (!claims) return null;
	if ('gid' in claims) return { kind: 'guest', guest_id: claims.gid, meeting_id: claims.mid };
	// El ticket no sobrevive a la sesión HTTP que lo pidió: cerrar sesión lo corta.
	return (await session_user(claims.sid)) === claims.sub
		? { kind: 'user', user_id: claims.sub, auth_sid: claims.sid }
		: null;
}

function session_user(session_id: string): Promise<string | null> {
	return resolve_session_user(session_id).catch(() => null);
}

function user_of(session: Session): string | null {
	return session.identity?.kind === 'user' ? session.identity.user_id : null;
}

/** Al cerrar una sesión HTTP; incluye los sockets que entraron con un ticket suyo. */
export function disconnect_sockets_for_auth_sid(auth_sid: string): void {
	for (const session of sessions.values()) {
		if (session.identity?.kind !== 'user' || session.identity.auth_sid !== auth_sid) continue;
		end_session(session, ['41']);
	}
}

function own_rooms(user_id: string): string[] {
	return [`user:${user_id}`, `messages:user:${user_id}`, `notifications:user:${user_id}`];
}

function may_join(session: Session, room: string): boolean {
	if (PUBLIC_ROOMS.has(room)) return true;
	const user_id = user_of(session);
	if (!user_id) return false;
	return own_rooms(user_id).includes(room) || DRIVER_ROOM.test(room);
}

function log_denied_room(session: Session, room: string) {
	if (session.denials_logged >= DENIALS_LOGGED_PER_SESSION) return;
	session.denials_logged += 1;
	const user_id = user_of(session);
	const who = user_id ? `al usuario ${user_id}` : 'a una conexión sin sesión de usuario';
	// Import dinámico: debug-request-log importa este módulo.
	void import('./debug-request-log.ts').then(({ debug_warning }) =>
		debug_warning(`Tiempo real: se negó la sala "${room}" ${who}`),
	);
}

function report_handler_error(event: string, err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	void import('./debug-request-log.ts').then(({ debug_error }) =>
		debug_error(`Tiempo real: falló "${event}": ${message}`),
	);
}

/** `42<n>[…]` pide ack: se contesta `43<n>[{ok, …}]`. Si el exceso de eventos persiste, se desconecta. */
async function handle_socket_event(session: Session, chunk: string): Promise<void> {
	const match = chunk.match(/^42(\d*)(\[.*\])$/s);
	if (!match) return;
	let args: unknown[];
	try {
		args = JSON.parse(match[2]!) as unknown[];
	} catch {
		return;
	}
	const ack_id = match[1];
	const ack = (body: AckBody) => {
		if (ack_id) deliver(session, `43${ack_id}${JSON.stringify([body])}`, false);
	};
	if (!take_token(`socket:${session.id}`, EVENTS_PER_SESSION).ok) {
		session.over_quota += 1;
		if (session.over_quota >= EVENTS_PER_SESSION.capacity) end_session(session);
		else ack(SOCKET_RATE_LIMITED);
		return;
	}
	session.over_quota = 0;
	ack(await run_event(session, String(args[0] ?? ''), args[1], Buffer.byteLength(chunk)));
}

async function run_event(session: Session, event: string, data: unknown, bytes: number): Promise<AckBody> {
	if (event === 'joinRoom' || event === 'leaveRoom') {
		if (typeof data !== 'string') return INVALID_REQUEST;
		if (event === 'leaveRoom') {
			session.rooms.delete(data);
			return OK;
		}
		if (!may_join(session, data)) {
			log_denied_room(session, data);
			return FORBIDDEN;
		}
		session.rooms.add(data);
		return OK;
	}
	if (event === 'messageToRoom') return message_to_room(session, data, bytes);
	if (event === 'driverLocation') return driver_location(session, data);
	const registered = event_handlers.get(event);
	if (!registered) return INVALID_REQUEST;
	const { handler, opts } = registered;
	const identity = session.identity;
	if (!identity) return UNAUTHENTICATED;
	if (identity.kind === 'guest' && !opts.allow_guest) return FORBIDDEN;
	if (opts.max_bytes !== undefined && bytes > opts.max_bytes) return EVENT_TOO_LARGE;
	if (
		opts.per_second !== undefined &&
		!take_token(`socket:${session.id}:${event}`, { capacity: opts.per_second, refill_per_s: opts.per_second }).ok
	) {
		return SOCKET_RATE_LIMITED;
	}
	try {
		const result = await handler({ session_id: session.id, identity }, data);
		return { ...(result && typeof result === 'object' ? result : {}), ok: true };
	} catch (err) {
		if (err instanceof ChatError) return refusal(err.code, err.message);
		report_handler_error(event, err);
		return INVALID_REQUEST;
	}
}

function message_to_room(session: Session, data: unknown, bytes: number): AckBody {
	const user_id = user_of(session);
	if (!user_id) return UNAUTHENTICATED;
	if (!data || typeof data !== 'object') return INVALID_REQUEST;
	if (bytes > MESSAGE_TO_ROOM_MAX_BYTES) return EVENT_TOO_LARGE;
	if (!take_token(`socket:${session.id}:messageToRoom`, MESSAGE_TO_ROOM_RATE).ok) return SOCKET_RATE_LIMITED;
	const { room, msg } = data as { room?: unknown; msg?: unknown };
	const target = String(room ?? '');
	if (!session.rooms.has(target) || PRIVATE_ROOM.test(target)) return FORBIDDEN;
	emit_to_room(target, 'message', { room: target, msg: String(msg ?? ''), from: user_id });
	return OK;
}

function driver_location(session: Session, data: unknown): AckBody {
	const user_id = user_of(session);
	if (!user_id) return UNAUTHENTICATED;
	if (!data || typeof data !== 'object') return INVALID_REQUEST;
	const payload = remember_driver_location({
		...(data as Parameters<typeof remember_driver_location>[0]),
		user_id,
	});
	if (!payload) return INVALID_REQUEST;
	emit_to_room(`route:${payload.route_id}:driver`, 'driver_location', payload);
	return OK;
}

function packet_event(event: string, data: unknown): string {
	return `42${JSON.stringify([event, data])}`;
}

/** Los eventos propios (señalización, sala, ubicación) y la escritura o la presencia se pueden perder. */
function is_ephemeral(event: string, data: unknown): boolean {
	if (event !== 'update') return true;
	return EPHEMERAL_UPDATES.has(String((data as { action?: unknown } | null)?.action));
}

/** `except`: id de la sesión que no lo recibe (quien lo originó). */
export function emit_to_room(room: string, event: string, data: unknown, except?: string): void {
	if (!room) return;
	const packet = packet_event(event, data);
	const ephemeral = is_ephemeral(event, data);
	for (const session of sessions.values()) {
		if (session.id !== except && session.rooms.has(room)) deliver(session, packet, ephemeral);
	}
}

export function emit_to_users(user_ids: Iterable<string>, event: string, data: unknown): void {
	const wanted = new Set(user_ids);
	const packet = packet_event(event, data);
	const ephemeral = is_ephemeral(event, data);
	for (const session of sessions.values()) {
		const user_id = user_of(session);
		if (user_id && wanted.has(user_id)) deliver(session, packet, ephemeral);
	}
}

/** Las sesiones de un invitado, adjuntas o no a una sala (quien espera aún no lo está). */
export function emit_to_guest(guest_id: string, event: string, data: unknown): void {
	const packet = packet_event(event, data);
	const ephemeral = is_ephemeral(event, data);
	for (const session of sessions.values()) {
		if (session.identity?.kind === 'guest' && session.identity.guest_id === guest_id) deliver(session, packet, ephemeral);
	}
}

export function emit_to_session(session_id: string, event: string, data: unknown): void {
	const session = sessions.get(session_id);
	if (session) deliver(session, packet_event(event, data), is_ephemeral(event, data));
}

/** Salas que el cliente no puede pedir (`call:`, `meeting:`): las une el servidor. */
export function join_room_server(session_id: string, room: string): void {
	sessions.get(session_id)?.rooms.add(room);
}

export function leave_room_server(session_id: string, room: string): void {
	sessions.get(session_id)?.rooms.delete(room);
}

export function online_user_ids(): Set<string> {
	const ids = new Set<string>();
	for (const session of sessions.values()) {
		const user_id = user_of(session);
		if (user_id) ids.add(user_id);
	}
	return ids;
}

export function broadcast_event(event: string, data: unknown): void {
	const packet = packet_event(event, data);
	const ephemeral = is_ephemeral(event, data);
	for (const session of sessions.values()) deliver(session, packet, ephemeral);
}

export function emit_notifications_refresh(
	user_ids: string[],
	payload: {
		reason: string;
		notification_ids?: string[];
		activity_ids?: string[];
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
