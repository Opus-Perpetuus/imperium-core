import { describe, expect, test } from 'bun:test';
import { remember_socket_ip } from './auth-rate-limit.ts';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import { handle_socket_io } from './socket-stub.ts';
import { ImperiumStore, load_catalog_path, status_guard_clause } from './store.ts';

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
	store.update = async (
		resource: string,
		id: string,
		patch: Row,
		guard?: { only_if_status?: string },
	) => {
		const rows = data[resource] ?? [];
		const index = rows.findIndex((row) => String(row._id) === String(id));
		if (index < 0) return null;
		const current = rows[index]!;
		if (guard?.only_if_status != null) {
			if (String(current.status ?? '') !== guard.only_if_status) return null;
			if (current.is_active === false) return null;
		}
		rows[index] = { ...current, ...patch };
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

function socket_updates(body: string, action: string): Row[][] {
	const out: Row[][] = [];
	for (const packet of body.split('\x1e')) {
		if (!packet.startsWith('42')) continue;
		const [event, data] = JSON.parse(packet.slice(2)) as [
			string,
			{ action?: string; data?: Row[] },
		];
		if (event === 'update' && data?.action === action) out.push(data.data ?? []);
	}
	return out;
}

function notify_payloads(body: string): Row[] {
	return socket_updates(body, 'notify_turn').flat();
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
	return (await res.json()) as { data: Row[]; message?: string; total_elementos?: number };
}

function box_row(id: string, name: string): Row {
	return {
		_id: id,
		name,
		is_active: true,
		allowed_services: ['svc-1'],
		allowed_customer_types: ['type-1'],
	};
}

function pending_turn(id: string, createdAt: string): Row {
	return {
		_id: id,
		name: id.toUpperCase(),
		status: 'pendiente',
		estado: 'pendiente',
		services: ['svc-1'],
		customer_type: 'type-1',
		priority_level: 1,
		createdAt,
		is_active: true,
	};
}

function assigned_box_id(turn: Row): string {
	const box = turn.assigned_box;
	if (box && typeof box === 'object') return String((box as Row)._id ?? '');
	return String(box ?? '');
}

describe('tomar el siguiente turno es de una sola caja', () => {
	test('seis cajas a la vez no reciben el mismo turno', async () => {
		const boxes = Array.from({ length: 6 }, (_, i) => box_row(`box-${i + 1}`, `Caja ${i + 1}`));
		const turns = Array.from({ length: 6 }, (_, i) =>
			pending_turn(`turn-${i + 1}`, `2026-01-01T00:00:0${i}.000Z`),
		);
		const seed = desk();
		seed['ticketing-system-box-config'] = boxes;
		seed['ticketing-system-turn'] = turns;
		const store = memory_store(seed);
		const results = await Promise.all(
			boxes.map((box) => call(store, 'take_next_turn', { box_config_id: box._id })),
		);
		const taken = results.flatMap((res) => res.data);
		expect(taken).toHaveLength(6);
		expect(new Set(taken.map((row) => String(row._id))).size).toBe(6);
		expect(new Set(taken.map(assigned_box_id)).size).toBe(6);
	});

	test('la última foto del tablero trae las dos cajas', async () => {
		const boxes = [1, 2].map((i) => box_row(`box-${i}`, `Caja ${i}`));
		const turns = [1, 2].map((i) => pending_turn(`turn-${i}`, `2026-01-01T00:00:0${i}.000Z`));
		const seed = desk();
		seed['ticketing-system-box-config'] = boxes;
		seed['ticketing-system-turn'] = turns;
		const store = memory_store(seed);
		const sid = await board();
		await Promise.all(boxes.map((box) => call(store, 'take_next_turn', { box_config_id: box._id })));
		const snapshots = socket_updates(await poll(sid), 'turn_stack_attending');
		const last = snapshots.at(-1) ?? [];
		expect(last.map((row) => String(row._id)).sort()).toEqual(['turn-1', 'turn-2']);
		expect(new Set(last.map(assigned_box_id)).size).toBe(2);
	});

	test('con un solo turno pendiente, una caja lo toma y las otras reciben reintento', async () => {
		const boxes = [1, 2, 3].map((i) => box_row(`box-${i}`, `Caja ${i}`));
		const seed = desk();
		seed['ticketing-system-box-config'] = boxes;
		seed['ticketing-system-turn'] = [pending_turn('turn-only', '2026-01-01T00:00:00.000Z')];
		const store = memory_store(seed);
		const results = await Promise.all(
			boxes.map((box) => call(store, 'take_next_turn', { box_config_id: box._id })),
		);
		const winners = results.filter((res) => res.data.length === 1);
		const retries = results.filter((res) => res.data.length === 0);
		expect(winners).toHaveLength(1);
		expect(String(winners[0]?.data[0]?._id)).toBe('turn-only');
		expect(retries).toHaveLength(2);
		for (const res of retries) expect(res.message).toBe('Sin turnos a la espera');
	});

	test('el UPDATE de Postgres solo escribe si el turno sigue pendiente y activo', () => {
		expect(status_guard_clause('$9')).toBe(
			'status = $9 AND is_active IS DISTINCT FROM false',
		);
		expect(String(ImperiumStore.prototype.update)).toContain('status_guard_clause');
		expect(String(ImperiumStore.prototype.update)).toContain('only_if_status');
	});
});

describe('tomar el siguiente turno con fila vacía', () => {
	test('responde 200 sin turno cuando no hay pendientes', async () => {
		const seed = desk();
		seed['ticketing-system-turn'] = [];
		const res = await call(memory_store(seed), 'take_next_turn', {
			box_config_id: 'box-1',
		});
		expect(res.data).toEqual([]);
		expect(res.total_elementos).toBe(0);
		expect(res.message).toBe('Sin turnos a la espera');
	});
});

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

describe('turno en atención de la caja (#185, PR 459)', () => {
	const open_turn = (id: string, box: string, updatedAt: string, extra: Row = {}): Row => ({
		_id: id,
		name: id.toUpperCase(),
		status: 'en_atencion',
		estado: 'en_atencion',
		services: ['svc-1'],
		customer_type: 'type-1',
		assigned_box: box,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt,
		is_active: true,
		...extra,
	});

	test('devuelve el turno en atención más reciente de esa caja, con la caja poblada', async () => {
		const seed = desk();
		seed['ticketing-system-turn']!.push(
			open_turn('b001', 'box-1', '2026-01-01T10:00:00.000Z'),
			open_turn('b002', 'box-1', '2026-01-01T11:00:00.000Z'),
			open_turn('b003', 'box-otra', '2026-01-01T12:00:00.000Z'),
			open_turn('b004', 'box-1', '2026-01-01T13:00:00.000Z', { is_active: false }),
		);
		const res = await call(memory_store(seed), 'attending_turn_for_box', { box_config_id: 'box-1' });
		expect(res.data.map((row: Row) => row._id)).toEqual(['b002']);
		expect(res.total_elementos).toBe(1);
		expect((res.data[0]?.assigned_box as Row | undefined)?.name).toBe('Caja 3');
	});

	test('sin turno en atención responde lista vacía', async () => {
		const res = await call(memory_store(desk()), 'attending_turn_for_box', { box_config_id: 'box-1' });
		expect(res.data).toEqual([]);
		expect(res.total_elementos).toBe(0);
	});

	test('la ruta está declarada en extra-routes', async () => {
		const routes = (await import('./extra-routes.json')).default as Array<Record<string, string>>;
		expect(routes).toContainEqual({
			resource: 'ticketing-system-turn',
			method: 'post',
			path: '/attending-turn-for-box',
			action: 'attending_turn_for_box',
		});
	});
});

describe('cajas con turno en atención (boxes_attending_turns)', () => {
	const open_turn = (id: string, box: string, updatedAt: string, extra: Row = {}): Row => ({
		_id: id,
		name: id.toUpperCase(),
		status: 'en_atencion',
		estado: 'en_atencion',
		services: ['svc-1'],
		customer_type: 'type-1',
		assigned_box: box,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt,
		is_active: true,
		...extra,
	});

	test('caja con turno en atención aparece; vacía no', async () => {
		const seed = desk();
		seed['ticketing-system-box-config']!.push({
			_id: 'box-2',
			name: 'Caja vacía',
			is_active: true,
			allowed_services: ['svc-1'],
			allowed_customer_types: ['type-1'],
		});
		seed['ticketing-system-turn']!.push(
			open_turn('b001', 'box-1', '2026-01-01T10:00:00.000Z'),
			open_turn('b002', 'box-1', '2026-01-01T11:00:00.000Z'),
			open_turn('b003', 'box-otra', '2026-01-01T12:00:00.000Z'),
			open_turn('b004', 'box-1', '2026-01-01T13:00:00.000Z', { is_active: false }),
		);
		const res = await call(memory_store(seed), 'boxes_attending_turns', {});
		const by_box = Object.fromEntries(
			(res.data as Array<Row>).map((row) => [String(row.box_config_id), row]),
		);
		expect(by_box['box-1']).toEqual({
			box_config_id: 'box-1',
			turn_id: 'b002',
			turn_name: 'B002',
		});
		expect(by_box['box-otra']).toEqual({
			box_config_id: 'box-otra',
			turn_id: 'b003',
			turn_name: 'B003',
		});
		expect(by_box['box-2']).toBeUndefined();
		expect(res.total_elementos).toBe(2);
	});

	test('sin turnos en atención responde lista vacía', async () => {
		const res = await call(memory_store(desk()), 'boxes_attending_turns', {});
		expect(res.data).toEqual([]);
		expect(res.total_elementos).toBe(0);
	});

	test('la ruta está declarada en extra-routes', async () => {
		const routes = (await import('./extra-routes.json')).default as Array<Record<string, string>>;
		expect(routes).toContainEqual({
			resource: 'ticketing-system-turn',
			method: 'post',
			path: '/boxes-attending-turns',
			action: 'boxes_attending_turns',
		});
	});
});

describe('resumen de pendientes de la caja (box-turns-summary)', () => {
	test('devuelve la cola de la caja con su box_config_id', async () => {
		const res = await call(memory_store(desk()), 'box_turns_summary', { box_config_id: 'box-1' });
		expect(res.data).toHaveLength(1);
		const summary = res.data[0] as Row;
		expect(summary.box_config_id).toBe('box-1');
		const pending = summary.pending_queue as Row[];
		expect(pending.map((row) => row._id)).toEqual(['turn-waiting']);
		expect((pending[0]?.customer_type as Row | undefined)?.name).toBe('General');
		expect(((pending[0]?.services as Row[] | undefined) ?? []).map((row) => row.name)).toEqual([
			'Trámite',
		]);
		expect(Object.keys(summary.turns_by_service as Row)).toEqual(['Trámite']);
		expect(Object.keys(summary.turns_by_user_type as Row)).toEqual(['General']);
		expect(res.total_elementos).toBe(1);
	});

	test('no cuenta turnos que la caja no puede atender', async () => {
		const seed = desk();
		seed['ticketing-system-turn']![0]!.customer_type = 'type-otro';
		const res = await call(memory_store(seed), 'box_turns_summary', { box_config_id: 'box-1' });
		expect((res.data[0] as Row).pending_queue).toEqual([]);
		expect(res.total_elementos).toBe(0);
	});

	test('la ruta está declarada en extra-routes', async () => {
		const routes = (await import('./extra-routes.json')).default as Array<Record<string, string>>;
		expect(routes).toContainEqual({
			resource: 'ticketing-system-turn',
			method: 'post',
			path: '/box-turns-summary',
			action: 'box_turns_summary',
		});
	});
});
