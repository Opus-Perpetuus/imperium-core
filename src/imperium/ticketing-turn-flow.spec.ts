import { describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import { handle_socket_io } from './socket-stub.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const ROOM = 'ticketing_system_turns';
const POLLING = 'http://imperium.test/api/socket.io/?EIO=4&transport=polling';

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>): ImperiumStore {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
	const matches = (row: Row, where?: Record<string, unknown>) => {
		if (!where) return true;
		return Object.entries(where).every(([key, value]) => row[key] === value);
	};
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.has = (resource: string) => Object.hasOwn(data, resource);
	store.scan = async function* (
		resource: string,
		opts: { where?: Record<string, unknown> } = {},
	) {
		yield (data[resource] ?? []).filter((row) => matches(row, opts.where));
	};
	store.find_id = async (resource: string, id: string) =>
		(data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
	store.update = async (resource: string, id: string, patch: Row) => {
		const rows = data[resource] ?? [];
		const index = rows.findIndex((row) => String(row._id) === String(id));
		if (index < 0) return null;
		rows[index] = { ...rows[index], ...patch };
		return rows[index]!;
	};
	store.find_many = async (resource: string, opts: { ids?: string[] } = {}) => {
		let rows = data[resource] ?? [];
		if (opts.ids?.length) {
			const wanted = new Set(opts.ids.map(String));
			rows = rows.filter((row) => wanted.has(String(row._id)));
		}
		return { rows, total: rows.length };
	};
	return store;
}

function desk(): Record<string, Row[]> {
	return {
		'ticketing-system-box-config': [
			{
				_id: 'box-1',
				name: 'Caja 3',
				is_active: true,
				allowed_services: ['svc-1'],
				allowed_customer_types: ['type-1'],
			},
		],
		'ticketing-system-service-type': [
			{ _id: 'svc-1', name: 'Trámite', priority_level: 1, is_active: true },
		],
		'ticketing-system-customer-type': [
			{ _id: 'type-1', name: 'General', priority_level: 1, is_active: true },
		],
		'ticketing-system-turn': [
			{
				_id: 'turn-waiting',
				name: 'A007',
				status: 'pendiente',
				estado: 'pendiente',
				services: ['svc-1'],
				customer_type: 'type-1',
				priority_level: 1,
				createdAt: '2026-01-01T00:00:00.000Z',
				is_active: true,
			},
		],
	};
}

let handshakes = 0;

async function board(): Promise<string> {
	const req = new Request(POLLING);
	remember_socket_ip(req, `10.9.0.${++handshakes}`);
	const opened = handle_socket_io(req);
	expect(opened).toBeInstanceOf(Response);
	const hello = await (opened as Response).text();
	const sid = (JSON.parse(hello.slice(1)) as { sid: string }).sid;
	await handle_socket_io(
		new Request(`${POLLING}&sid=${sid}`, { method: 'POST', body: '40' }),
	);
	const connected = await handle_socket_io(new Request(`${POLLING}&sid=${sid}`));
	expect(await connected!.text()).toStartWith('40');
	await handle_socket_io(
		new Request(`${POLLING}&sid=${sid}`, {
			method: 'POST',
			body: `42${JSON.stringify(['joinRoom', ROOM])}`,
		}),
	);
	return sid;
}

async function poll(sid: string): Promise<string> {
	const res = await handle_socket_io(new Request(`${POLLING}&sid=${sid}`));
	return res!.text();
}

function notify_payloads(body: string): Row[] {
	const out: Row[] = [];
	for (const packet of body.split('\x1e')) {
		if (!packet.startsWith('42')) continue;
		const [event, data] = JSON.parse(packet.slice(2)) as [
			string,
			{ action?: string; data?: Row[] },
		];
		if (event === 'update' && data?.action === 'notify_turn') {
			out.push(...(data.data ?? []));
		}
	}
	return out;
}

async function call(store: ImperiumStore, action: string, json: Record<string, unknown>) {
	const url = new URL(`http://core/api/ticketing-system-turn/${action}`);
	const req = new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(json),
	});
	const res = await handle_action(
		store,
		null as unknown as Bun.SQL,
		req,
		url,
		'ticketing-system-turn',
		action,
		{},
		null,
	);
	return (await res.json()) as { data: Row[] };
}

describe('tomar el siguiente turno avisa al tablero una vez', () => {
	test('take y el notify del botón emiten un solo notify_turn con la caja', async () => {
		const store = memory_store(desk());
		const sid = await board();
		const taken = await call(store, 'take_next_turn', { box_config_id: 'box-1' });
		const turn_id = String(taken.data[0]?._id ?? '');
		expect(turn_id).toBe('turn-waiting');
		await call(store, 'notify_turn', { turn_id });
		const announced = notify_payloads(await poll(sid));
		expect(announced).toHaveLength(1);
		expect(announced[0]?.name).toBe('A007');
		expect((announced[0]?.assigned_box as Row | undefined)?.name).toBe('Caja 3');
	});

	test('terminar el turno en atención y tomar el siguiente también avisa una sola vez', async () => {
		const seed = desk();
		seed['ticketing-system-turn']!.unshift({
			_id: 'turn-open',
			name: 'B001',
			status: 'en_atencion',
			estado: 'en_atencion',
			services: ['svc-1'],
			customer_type: 'type-1',
			assigned_box: 'box-1',
			priority_level: 1,
			createdAt: '2026-01-01T00:00:00.000Z',
			is_active: true,
			time: [],
			time_box: [],
			time_attending: [],
		});
		const store = memory_store(seed);
		const sid = await board();
		await call(store, 'end_attending_turn', { turn_id: 'turn-open' });
		const taken = await call(store, 'take_next_turn', { box_config_id: 'box-1' });
		const turn_id = String(taken.data[0]?._id ?? '');
		expect(turn_id).toBe('turn-waiting');
		await call(store, 'notify_turn', { turn_id });
		const announced = notify_payloads(await poll(sid));
		expect(announced).toHaveLength(1);
		expect(announced[0]?.name).toBe('A007');
		expect((announced[0]?.assigned_box as Row | undefined)?.name).toBe('Caja 3');
	});
});
