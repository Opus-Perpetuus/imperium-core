/**
 * Turnos de ventanilla: create/take/notify/end y sockets como el plugin original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { emit_to_room } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

const ROOM = 'ticketing_system_turns';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function turn_id_from_body(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	return ref_id(value);
}

function as_id_list(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => ref_id(item) || String(item ?? '').trim()).filter(Boolean);
	}
	if (typeof value === 'string') {
		const raw = value.trim();
		if (!raw) return [];
		try {
			return as_id_list(JSON.parse(raw));
		} catch {
			return raw.split(',').map((item) => item.trim()).filter(Boolean);
		}
	}
	if (value && typeof value === 'object') {
		const id = ref_id(value);
		return id ? [id] : [];
	}
	return [];
}

function is_pending(doc: ImperiumDoc): boolean {
	const status = text(doc.status ?? doc.estado);
	return status === 'pendiente' && doc.is_active !== false;
}

function is_attending(doc: ImperiumDoc): boolean {
	const status = text(doc.status ?? doc.estado);
	return status === 'en_atencion' && doc.is_active !== false;
}

async function priority_number(store: ImperiumStore, value: unknown): Promise<number> {
	if (value == null || value === '') return 0;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'object') {
		const nested = Number((value as { priority_level?: unknown }).priority_level);
		if (Number.isFinite(nested)) return nested;
	}
	const id = ref_id(value) || text(value);
	if (id && store.has('ticketing-system-priority')) {
		const row = await store.find_id('ticketing-system-priority', id);
		const n = Number(row?.priority_level ?? 0);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

async function load_services(store: ImperiumStore, ids: string[]) {
	if (!ids.length || !store.has('ticketing-system-service-type')) return [];
	const rows: ImperiumDoc[] = [];
	for (const id of ids) {
		const row = await store.find_id('ticketing-system-service-type', id);
		if (row) rows.push(row);
	}
	return rows;
}

async function max_priority_of_turn(store: ImperiumStore, turn: ImperiumDoc): Promise<number> {
	const values = [Number(turn.priority_level ?? 0) || 0];
	for (const raw of as_array(turn.services)) {
		const service =
			typeof raw === 'object'
				? as_object(raw)
				: store.has('ticketing-system-service-type')
					? ((await store.find_id('ticketing-system-service-type', text(raw))) ?? {})
					: {};
		values.push(await priority_number(store, service.priority_level));
	}
	return Math.max(...values);
}

async function next_consecutive(store: ImperiumStore, letter: string): Promise<number> {
	if (!store.has('ticketing-system-consecutive')) {
		const { rows } = await store.find_many('ticketing-system-turn', {
			take: 5000,
			include_inactive: true,
			populate: false,
		});
		const prefix = letter.toUpperCase();
		let max = -1;
		for (const row of rows) {
			const name = text(row.name).toUpperCase();
			if (!name.startsWith(prefix)) continue;
			const n = Number(name.slice(prefix.length));
			if (Number.isFinite(n)) max = Math.max(max, n);
		}
		return max + 1;
	}
	const existing =
		(await store.find_where('ticketing-system-consecutive', { name: letter })) ??
		(await store.find_where('ticketing-system-consecutive', { name: letter.toUpperCase() }));
	if (!existing) {
		await store.insert('ticketing-system-consecutive', {
			name: letter,
			consecutive: 1,
			is_active: true,
		});
		return 0;
	}
	const current = Number(existing.consecutive ?? 0);
	await store.update('ticketing-system-consecutive', String(existing._id), {
		consecutive: current + 1,
	});
	return current;
}

async function pending_turns(store: ImperiumStore): Promise<ImperiumDoc[]> {
	const by_status = (
		await store.find_many('ticketing-system-turn', {
			where: { status: 'pendiente' },
			take: 10000,
			populate: false,
		})
	).rows;
	const by_estado = by_status.length
		? []
		: (
				await store.find_many('ticketing-system-turn', {
					where: { estado: 'pendiente' },
					take: 10000,
					populate: false,
				})
			).rows;
	return [...by_status, ...by_estado].filter(is_pending);
}

async function attending_turns(store: ImperiumStore): Promise<ImperiumDoc[]> {
	const { rows } = await store.find_many('ticketing-system-turn', {
		where: { status: 'en_atencion' },
		take: 10000,
		populate: false,
	});
	const extra = rows.length
		? []
		: (
				await store.find_many('ticketing-system-turn', {
					where: { estado: 'en_atencion' },
					take: 10000,
					populate: false,
				})
			).rows;
	return [...rows, ...extra].filter(is_attending);
}

/** El tablero lee `assigned_box.name`; el original hace `.populate('assigned_box')`. */
async function populate_turns(
	store: ImperiumStore,
	turns: ImperiumDoc[],
): Promise<ImperiumDoc[]> {
	if (!turns.length) return turns;
	return store.populate_docs('ticketing-system-turn', turns);
}

async function sort_pending(store: ImperiumStore, turns: ImperiumDoc[]): Promise<ImperiumDoc[]> {
	const ranked = await Promise.all(
		turns.map(async (turn) => ({
			turn,
			priority: await max_priority_of_turn(store, turn),
			created: new Date(String(turn.createdAt ?? turn.created_at ?? 0)).getTime(),
		})),
	);
	ranked.sort((a, b) => b.priority - a.priority || a.created - b.created);
	return ranked.map((row) => row.turn);
}

async function box_turns_summary(store: ImperiumStore, box: ImperiumDoc) {
	const allowed_services = as_id_list(box.allowed_services);
	const allowed_types = as_id_list(box.allowed_customer_types);
	const waiting = await pending_turns(store);
	const matching: ImperiumDoc[] = [];
	for (const turn of waiting) {
		const services = as_id_list(turn.services);
		const type_id = ref_id(turn.customer_type);
		const services_ok = services.every((id) => allowed_services.includes(id));
		const type_ok = allowed_types.includes(type_id);
		if (services_ok && type_ok) matching.push(turn);
	}
	const pending_queue = await sort_pending(store, matching);
	const turns_by_service: Record<string, ImperiumDoc[]> = {};
	const turns_by_user_type: Record<string, ImperiumDoc[]> = {};
	for (const turn of matching) {
		for (const raw of as_array(turn.services)) {
			const id = ref_id(raw) || text(raw);
			const service =
				typeof raw === 'object'
					? as_object(raw)
					: ((await store.find_id('ticketing-system-service-type', id)) ?? { name: 'Servicio desconocido' });
			const service_name = text(service.name) || 'Servicio desconocido';
			(turns_by_service[service_name] ??= []).push(turn);
		}
		const type_id = ref_id(turn.customer_type);
		const type_doc =
			typeof turn.customer_type === 'object'
				? as_object(turn.customer_type)
				: type_id
					? ((await store.find_id('ticketing-system-customer-type', type_id)) ?? {})
					: {};
		const type_name = text(type_doc.name) || 'Tipo desconocido';
		(turns_by_user_type[type_name] ??= []).push(turn);
	}
	return { pending_queue, turns_by_service, turns_by_user_type };
}

export async function notify_ticketing_rooms(store: ImperiumStore) {
	if (!store.has('ticketing-system-turn')) return;
	const pending = await sort_pending(store, await pending_turns(store));
	emit_to_room(ROOM, 'update', { action: 'turn_stack_next', data: pending });
	emit_to_room(ROOM, 'update', {
		action: 'turn_stack_attending',
		data: await populate_turns(store, await attending_turns(store)),
	});
	if (!store.has('ticketing-system-box-config')) return;
	const { rows } = await store.find_many('ticketing-system-box-config', {
		take: 500,
		populate: false,
	});
	for (const box of rows.filter((row) => row.is_active !== false)) {
		emit_to_room(ROOM, 'update', {
			action: 'box_turns_summary',
			data: await box_turns_summary(store, box),
		});
	}
}

export async function prepare_ticketing_turn_create(
	store: ImperiumStore,
	doc: ImperiumDoc,
): Promise<ImperiumDoc> {
	const out = { ...doc };
	delete out._id;
	const customer_id = ref_id(out.customer_type) || text(out.customer_type);
	if (!customer_id) throw new Error('No se encontró el tipo de cliente seleccionado');
	const customer = store.has('ticketing-system-customer-type')
		? await store.find_id('ticketing-system-customer-type', customer_id)
		: null;
	if (!customer) throw new Error('No se encontró el tipo de cliente seleccionado');
	const service_ids = as_id_list(out.services);
	if (!service_ids.length) {
		throw new Error('Se necesita al menos un servicio para crear un turno');
	}
	const services = await load_services(store, service_ids);
	if (store.has('ticketing-system-service-type') && services.length !== service_ids.length) {
		throw new Error('No se encontraron todos los servicios seleccionados');
	}
	let highest = await priority_number(store, customer.priority_level);
	let letter = text(customer.letter) || 'M';
	for (const service of services) {
		const service_priority = await priority_number(store, service.priority_level);
		if (service_priority > highest) {
			highest = service_priority;
			letter = text(service.letter) || letter;
		}
	}
	const consecutive = await next_consecutive(store, letter);
	out.customer_type = customer_id;
	out.services = service_ids;
	out.name = `${letter}${String(consecutive).padStart(3, '0')}`;
	out.priority_level = highest;
	out.status = 'pendiente';
	out.estado = 'pendiente';
	out.time = [new Date().toISOString()];
	out.time_box = as_array(out.time_box);
	out.time_attending = as_array(out.time_attending);
	return out;
}

export async function take_next_turn(
	store: ImperiumStore,
	box_config_id: string,
): Promise<{ turn: ImperiumDoc; waiting: number }> {
	const box_id = text(box_config_id);
	if (!box_id) throw new Error('Se necesita una caja para tomar el siguiente turno');
	const box = await store.find_id('ticketing-system-box-config', box_id);
	if (!box) throw new Error('No se encontró la configuración de la caja');
	const allowed_services = as_id_list(box.allowed_services);
	const allowed_types = as_id_list(box.allowed_customer_types);
	const waiting = await pending_turns(store);
	if (!waiting.length) throw new Error('Sin turnos a la espera');
	const matching: ImperiumDoc[] = [];
	for (const turn of waiting) {
		const services = as_id_list(turn.services);
		const type_id = ref_id(turn.customer_type);
		if (services.every((id) => allowed_services.includes(id)) && allowed_types.includes(type_id)) {
			matching.push(turn);
		}
	}
	if (!matching.length) {
		const missing_services = new Set<string>();
		const missing_types = new Set<string>();
		for (const turn of waiting) {
			for (const raw of as_array(turn.services)) {
				const id = ref_id(raw) || text(raw);
				if (allowed_services.includes(id)) continue;
				const service =
					typeof raw === 'object'
						? as_object(raw)
						: ((await store.find_id('ticketing-system-service-type', id)) ?? {});
				missing_services.add(text(service.name) || 'servicio desconocido');
			}
			const type_id = ref_id(turn.customer_type);
			if (!allowed_types.includes(type_id)) {
				const type_doc =
					typeof turn.customer_type === 'object'
						? as_object(turn.customer_type)
						: type_id
							? ((await store.find_id('ticketing-system-customer-type', type_id)) ?? {})
							: {};
				missing_types.add(text(type_doc.name) || 'tipo desconocido');
			}
		}
		const services_list = [...missing_services].join(', ');
		const types_list = [...missing_types].join(', ');
		if (missing_services.size && missing_types.size) {
			throw new Error(
				`Los turnos disponibles requieren que la caja tenga el servicio '${services_list}' y el tipo de usuario '${types_list}' configurado. No fue posible tomar un turno.`,
			);
		}
		if (missing_services.size) {
			throw new Error(
				`Los turnos disponibles requieren que la caja tenga el servicio '${services_list}' configurado. No fue posible tomar un turno.`,
			);
		}
		throw new Error(
			`Los turnos disponibles requieren que la caja tenga el tipo de usuario '${types_list}' configurado. No fue posible tomar un turno.`,
		);
	}
	const ordered = await sort_pending(store, matching);
	const next = ordered[0];
	const updated = await store.update('ticketing-system-turn', String(next._id), {
		status: 'en_atencion',
		estado: 'en_atencion',
		assigned_box: box_id,
		fecha_inicio: new Date().toISOString(),
		time_box: [new Date().toISOString()],
	});
	if (!updated) throw new Error('No se encontró el siguiente turno');
	await notify_ticketing_rooms(store);
	const [populated] = await populate_turns(store, [updated]);
	return { turn: populated ?? updated, waiting: waiting.length };
}

export async function notify_turn(store: ImperiumStore, raw_id: unknown): Promise<ImperiumDoc> {
	const id = turn_id_from_body(raw_id);
	if (!id) throw new Error('Se necesita un id de turno para notificar');
	const turn = await store.find_id('ticketing-system-turn', id);
	if (!turn || turn.is_active === false) throw new Error('No se encontró el turno');
	const [populated] = await populate_turns(store, [turn]);
	const shown = populated ?? turn;
	emit_to_room(ROOM, 'update', { action: 'notify_turn', data: [shown] });
	const box_id = ref_id(shown.assigned_box);
	if (box_id) {
		const box = await store.find_id('ticketing-system-box-config', box_id);
		if (box) {
			emit_to_room(ROOM, 'update', {
				action: 'box_turns_summary',
				data: await box_turns_summary(store, box),
			});
		}
	}
	return shown;
}

export async function end_attending_turn(
	store: ImperiumStore,
	raw_id: unknown,
): Promise<ImperiumDoc> {
	const id = turn_id_from_body(raw_id);
	if (!id) throw new Error('Se necesita un id de turno para finalizar');
	const turn = await store.find_id('ticketing-system-turn', id);
	if (!turn || turn.is_active === false) throw new Error('No se encontró el turno');
	const stamp = new Date().toISOString();
	const updated = await store.update('ticketing-system-turn', id, {
		status: 'completado',
		estado: 'completado',
		time: [...as_array(turn.time), stamp],
		time_box: [...as_array(turn.time_box), stamp],
		time_attending: [...as_array(turn.time_attending), stamp],
		fecha_fin: stamp,
	});
	if (!updated) throw new Error('No se encontró el turno');
	await notify_ticketing_rooms(store);
	return updated;
}
