/**
 * Escritura, entregado y presencia del chat por un socket real; el reloj de caducidades se
 * inyecta con `chat_realtime_tick(now)`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { chat_realtime_tick, start_chat_realtime } from './chat-realtime.ts';
import type { ImperiumDoc } from './envelope.ts';
import { bind_socket_identity_resolver, handle_socket_io, socket_websocket_handler, upgrade_socket_io } from './socket-stub.ts';

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

const conversations = new Map<string, ImperiumDoc>();
const members = new Map<string, string[]>();
const names = new Map<string, string>();
const user_settings = new Map<string, { privacy: Record<string, unknown>; presence_status: string }>();
const delivered_marks = new Map<string, number>();
const delivered_writes: Array<{ user_id: string; seq: number }> = [];

const store = {
	has: (resource: string) => resource !== 'configuration',
	async find_id(resource: string, id: string) {
		return resource === 'chat-conversations' ? (conversations.get(id) ?? null) : null;
	},
	async chat_contact_owners(viewer_id: string, owner_ids: string[]) {
		return owner_ids.filter((owner) =>
			[...conversations.values()].some(
				(row) =>
					row.kind === 'direct' &&
					row.conversation_key === [owner, viewer_id].sort().join('::') &&
					(row.written_by as string[]).includes(owner),
			),
		);
	},
	async chat_member_ids(conversation_id: string) {
		return members.get(conversation_id) ?? [];
	},
	async chat_users_brief(ids: string[]) {
		return ids.flatMap((id) => (names.has(id) ? [{ _id: id, name: names.get(id)!, is_active: true }] : []));
	},
	async chat_privacy_many(ids: string[]) {
		return new Map(ids.flatMap((id) => (user_settings.has(id) ? [[id, user_settings.get(id)!] as const] : [])));
	},
	async chat_mark_delivered_up_to(conversation_id: string, user_id: string, seq: number) {
		const upto = Math.min(seq, Number(conversations.get(conversation_id)?.last_seq) || 0);
		const key = `${conversation_id}:${user_id}`;
		if ((delivered_marks.get(key) ?? 0) >= upto) return null;
		delivered_marks.set(key, upto);
		delivered_writes.push({ user_id, seq: upto });
		return upto;
	},
};

start_chat_realtime(store as unknown as Parameters<typeof start_chat_realtime>[0]);

const sessions = new Map<string, string>();
bind_socket_identity_resolver(async (session_id) => sessions.get(session_id) ?? null);

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

type Client = {
	ws: WebSocket;
	/** Espera el ack de ese evento; lo demás que llegue queda en orden para `updates`. */
	emit: (event: string, data: unknown) => Promise<Record<string, unknown>>;
	/** El siguiente `update` recibido, que tiene que ser de esa acción. */
	updates: (action: string) => Promise<ImperiumDoc[]>;
	/** Los `update` recibidos que nadie leyó. */
	pending: () => string[];
	closed: Promise<void>;
};

let ack_ids = 0;

async function connect(user_id: string): Promise<Client> {
	const cookie = `realtime-${hex_id()}`;
	sessions.set(cookie, user_id);
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/socket.io/?EIO=4&transport=websocket`, {
		headers: { cookie: `connect.sid=${cookie}` },
	} as unknown as string[]);
	const inbox: string[] = [];
	let wake = () => {};
	ws.onmessage = (ev) => {
		const packet = String(ev.data);
		if (packet === '2') ws.send('3');
		else inbox.push(packet);
		wake();
	};
	const take = async (match: (packet: string) => boolean): Promise<string> => {
		const deadline = Date.now() + 5000;
		for (;;) {
			const at = inbox.findIndex(match);
			if (at >= 0) return inbox.splice(at, 1)[0]!;
			if (Date.now() > deadline) throw new Error('sin paquete del servidor');
			await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, 50);
			});
		}
	};
	const is_update = (packet: string) => packet.startsWith('42["update"');
	const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error('no abrió el WebSocket'));
	});
	await take((packet) => packet.startsWith('0'));
	ws.send('40');
	await take((packet) => packet.startsWith('40'));
	return {
		ws,
		closed,
		async emit(event, data) {
			const id = ++ack_ids;
			ws.send(`42${id}${JSON.stringify([event, data])}`);
			const packet = await take((candidate) => candidate.startsWith(`43${id}[`));
			return (JSON.parse(packet.slice(`43${id}`.length)) as Record<string, unknown>[])[0]!;
		},
		async updates(action) {
			const [, payload] = JSON.parse((await take(is_update)).slice(2)) as [string, { action: string; data: ImperiumDoc[] }];
			expect(payload.action).toBe(action);
			return payload.data;
		},
		pending: () => inbox.filter(is_update),
	};
}

function person(name: string, settings?: { privacy?: Record<string, unknown>; presence_status?: string }): string {
	const id = hex_id();
	names.set(id, name);
	if (settings) user_settings.set(id, { privacy: settings.privacy ?? {}, presence_status: settings.presence_status ?? '' });
	return id;
}

function group(user_ids: string[], extra: ImperiumDoc = {}): string {
	const id = hex_id();
	conversations.set(id, { _id: id, kind: 'group', conversation_key: `conv:${id}`, memberCount: user_ids.length, last_seq: 0, ...extra });
	members.set(id, user_ids);
	return id;
}

/** Un directo entre `a` y `b`; `written_by`, quienes ya escribieron por él. */
function direct(a: string, b: string, written_by = [a, b]): void {
	const id = hex_id();
	conversations.set(id, { _id: id, kind: 'direct', conversation_key: [a, b].sort().join('::'), memberCount: 2, last_seq: 0, written_by });
	members.set(id, [a, b]);
}

/** Espera también a que el servidor procese el cierre. */
async function close_all(...clients: Client[]): Promise<void> {
	for (const client of clients) client.ws.close();
	await Promise.all(clients.map((client) => client.closed));
	await Bun.sleep(100);
}

describe('escritura', () => {
	test('llega con el nombre a los demás; lo mismo antes de 2 s no se repite, un cambio sí, y caduca a los 6 s', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const carla = person('Carla');
		const id = group([ana, beto, carla]);
		const [a, b, c] = await Promise.all([ana, beto, carla].map(connect));
		expect(await a!.emit('chat:typing', { conversation_id: id, state: 'typing' })).toEqual({ ok: true });
		const typing = [{ conversation_id: id, user_id: ana, name: 'Ana', state: 'typing' }];
		expect(await b!.updates('chat_typing')).toEqual(typing);
		expect(await c!.updates('chat_typing')).toEqual(typing);
		expect(await a!.emit('chat:typing', { conversation_id: id, state: 'typing' })).toEqual({ ok: true });
		expect(await a!.emit('chat:typing', { conversation_id: id, state: 'paused' })).toEqual({ ok: true });
		expect(await b!.updates('chat_typing')).toEqual([{ ...typing[0]!, state: 'paused' }]);
		chat_realtime_tick(Date.now() + 7000);
		expect(await b!.updates('chat_typing')).toEqual([{ ...typing[0]!, state: 'stopped' }]);
		expect(await c!.updates('chat_typing')).toEqual([{ ...typing[0]!, state: 'paused' }]);
		expect(await c!.updates('chat_typing')).toEqual([{ ...typing[0]!, state: 'stopped' }]);
		await close_all(a!, b!, c!);
	}, 30_000);

	test('es recíproca: quien la apaga no la manda ni la ve; arriba del tope de funciones en vivo no sale', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const carla = person('Carla', { privacy: { typing: false } });
		const id = group([ana, beto, carla]);
		const big = group([ana, beto], { memberCount: 21 });
		const [a, b, c] = await Promise.all([ana, beto, carla].map(connect));
		await c!.emit('chat:typing', { conversation_id: id, state: 'typing' });
		await a!.emit('chat:typing', { conversation_id: big, state: 'typing' });
		await a!.emit('chat:typing', { conversation_id: id, state: 'typing' });
		expect(await b!.updates('chat_typing')).toEqual([{ conversation_id: id, user_id: ana, name: 'Ana', state: 'typing' }]);
		await b!.emit('chat:typing', { conversation_id: id, state: 'typing' });
		expect(await a!.updates('chat_typing')).toEqual([{ conversation_id: id, user_id: beto, name: 'Beto', state: 'typing' }]);
		expect(await c!.emit('presence:subscribe', { user_ids: [] })).toEqual({ data: [], ok: true });
		expect(c!.pending()).toEqual([]);
		await close_all(a!, b!, c!);
	}, 30_000);

	test('solo los miembros; cerrar la sesión que escribía avisa que dejó de escribir', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const dario = person('Darío');
		const id = group([ana, beto]);
		const [a, b, d] = await Promise.all([ana, beto, dario].map(connect));
		expect(await d!.emit('chat:typing', { conversation_id: id, state: 'typing' })).toMatchObject({ ok: false, code: 'not_member' });
		expect(await d!.emit('chat:typing', { conversation_id: hex_id(), state: 'typing' })).toMatchObject({
			ok: false,
			code: 'conversation_not_found',
		});
		expect(await a!.emit('chat:typing', { conversation_id: id, state: 'gritando' })).toMatchObject({
			ok: false,
			code: 'invalid_request',
		});
		await a!.emit('chat:typing', { conversation_id: id, state: 'typing' });
		expect((await b!.updates('chat_typing'))[0]).toMatchObject({ user_id: ana, state: 'typing' });
		await close_all(a!);
		expect((await b!.updates('chat_typing'))[0]).toMatchObject({ user_id: ana, state: 'stopped' });
		await close_all(b!, d!);
	}, 30_000);
});

describe('entregado', () => {
	test('se agrupa: una escritura cada 2 s con el mayor, nunca pasa de last_seq y el delta sale con funciones en vivo', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const id = group([ana, beto], { last_seq: 10 });
		const [a, b] = await Promise.all([ana, beto].map(connect));
		const writes = () => delivered_writes.filter((write) => write.user_id === beto).map((write) => write.seq);
		await b!.emit('chat:delivered', { conversation_id: id, seq: 3 });
		const delta = { conversation_id: id, op: 'delivered', user_id: beto };
		expect(await a!.updates('chat_delta')).toEqual([{ ...delta, seq: 3 }]);
		await b!.emit('chat:delivered', { conversation_id: id, seq: 5 });
		await b!.emit('chat:delivered', { conversation_id: id, seq: 4 });
		chat_realtime_tick(Date.now() + 2500);
		expect(await a!.updates('chat_delta')).toEqual([{ ...delta, seq: 5 }]);
		expect(writes()).toEqual([3, 5]);
		await b!.emit('chat:delivered', { conversation_id: id, seq: 1_000_000_000 });
		chat_realtime_tick(Date.now() + 5000);
		expect(await a!.updates('chat_delta')).toEqual([{ ...delta, seq: 10 }]);
		expect(writes()).toEqual([3, 5, 10]);
		expect(await b!.emit('chat:delivered', { conversation_id: id, seq: -1 })).toMatchObject({ ok: false, code: 'invalid_request' });
		await close_all(a!, b!);
	}, 30_000);

	test('sin funciones en vivo avanza la marca sin avisar', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const id = group([ana, beto], { last_seq: 4, memberCount: 25 });
		const [a, b] = await Promise.all([ana, beto].map(connect));
		await b!.emit('chat:delivered', { conversation_id: id, seq: 4 });
		expect(delivered_marks.get(`${id}:${beto}`)).toBe(4);
		await a!.emit('chat:typing', { conversation_id: group([ana, beto]), state: 'typing' });
		expect((await b!.updates('chat_typing'))[0]).toMatchObject({ user_id: ana });
		await close_all(a!, b!);
	}, 30_000);
});

describe('presencia', () => {
	test('la foto llega en el ack y los cambios a quien sigue; invisible se ve desconectado', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const carla = person('Carla');
		const [a, b] = await Promise.all([ana, beto].map(connect));
		await Bun.sleep(50);
		expect(await a!.emit('presence:subscribe', { user_ids: [beto, carla] })).toEqual({
			ok: true,
			data: [
				{ user_id: beto, state: 'available' },
				{ user_id: carla, state: 'offline' },
			],
		});
		await b!.emit('presence:set', { state: 'busy' });
		expect(await a!.updates('presence')).toEqual([{ user_id: beto, state: 'busy' }]);
		await Bun.sleep(1100);
		await b!.emit('presence:set', { state: 'invisible' });
		expect(await a!.updates('presence')).toEqual([{ user_id: beto, state: 'offline', last_seen_bucket: 'recently' }]);
		expect(await b!.emit('presence:set', { state: 'fantasma' })).toMatchObject({ ok: false });
		await close_all(a!, b!);
	}, 30_000);

	test('quien guardó invisible no se asoma al conectar', async () => {
		const ana = person('Ana');
		const beto = person('Beto', { presence_status: 'invisible' });
		const a = await connect(ana);
		const b = await connect(beto);
		await Bun.sleep(50);
		expect(await a.emit('presence:subscribe', { user_ids: [beto] })).toEqual({
			ok: true,
			data: [{ user_id: beto, state: 'offline' }],
		});
		await close_all(a, b);
	}, 30_000);

	test('ausente al avisar inactividad o tras 10 min sin actividad; al desconectar quedan 30 s de gracia', async () => {
		const ana = person('Ana');
		const beto = person('Beto');
		const [a, b] = await Promise.all([ana, beto].map(connect));
		await Bun.sleep(50);
		await a!.emit('presence:subscribe', { user_ids: [beto] });
		await b!.emit('presence:activity', { idle: true });
		expect(await a!.updates('presence')).toEqual([{ user_id: beto, state: 'away' }]);
		expect(await b!.emit('presence:activity', { idle: false })).toMatchObject({ ok: false, code: 'socket_rate_limited' });
		const b2 = await connect(beto);
		expect(await a!.updates('presence')).toEqual([{ user_id: beto, state: 'available' }]);
		chat_realtime_tick(Date.now() + 11 * 60_000);
		expect(await a!.updates('presence')).toEqual([{ user_id: beto, state: 'away' }]);
		await close_all(b!, b2);
		expect(a!.pending()).toEqual([]);
		chat_realtime_tick(Date.now() + 31_000);
		expect(await a!.updates('presence')).toEqual([{ user_id: beto, state: 'offline', last_seen_bucket: 'recently' }]);
		await close_all(a!);
	}, 30_000);

	test('la última vez es recíproca: quien no la comparte no ve la ajena; la de contactos, solo si su dueño escribió por el directo', async () => {
		const ana = person('Ana');
		const carla = person('Carla');
		const nadie = person('Nadie', { privacy: { last_seen: 'nobody' } });
		const dario = person('Darío', { privacy: { last_seen: 'contacts' } });
		const eva = person('Eva', { privacy: { last_seen: 'nobody' } });
		direct(ana, dario);
		direct(carla, dario, [carla]);
		const gone = await Promise.all([dario, eva].map(connect));
		await Bun.sleep(50);
		await close_all(...gone);
		chat_realtime_tick(Date.now() + 31_000);
		const [a, c, n] = await Promise.all([ana, carla, nadie].map(connect));
		const subscribe = async (client: Client) =>
			((await client.emit('presence:subscribe', { user_ids: [dario, eva] })).data as ImperiumDoc[]).map(
				(entry) => entry.last_seen_bucket ?? null,
			);
		expect(await subscribe(a)).toEqual(['recently', null]);
		expect(await subscribe(c)).toEqual([null, null]);
		expect(await subscribe(n)).toEqual([null, null]);
		await Bun.sleep(1100);
		expect(await n.emit('presence:subscribe', { user_ids: Array.from({ length: 201 }, hex_id) })).toMatchObject({
			ok: false,
			code: 'invalid_request',
		});
		await close_all(a, c, n);
	}, 30_000);
});
