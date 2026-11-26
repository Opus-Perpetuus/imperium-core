/**
 * Turnos de ventanilla: create/take/notify/end y sockets como el plugin original.
 */
import { debug_warning } from './debug-request-log.ts';
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { emit_to_room } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';
import { turn_code_prefix } from './ticketing-box-letters.ts';

export { TURN_PREFIX_MAX_LETTERS, turn_code_prefix, with_box_service_letters } from './ticketing-box-letters.ts';

const ROOM = 'ticketing_system_turns';

function text(value: unknown): string {
	return String(value ?? '').trim();
}

/** Dígitos del consecutivo; se conservan los 3 de siempre (A001). */
export const TURN_NUMBER_DIGITS = 3;

/** Código visible del turno: prefijo + consecutivo con ceros (AP001, G014). */
export function format_turn_code(prefix: string, consecutive: number): string {
	return `${prefix}${String(consecutive).padStart(TURN_NUMBER_DIGITS, '0')}`;
}

/** Número del consecutivo si `name` es exactamente `prefix` + dígitos. */
export function turn_code_number(name: unknown, prefix: string): number | null {
	const match = /^([A-ZÑ]+)(\d+)$/.exec(text(name).toUpperCase());
	if (!match || match[1] !== prefix.toUpperCase()) return null;
	return Number(match[2]);
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
	const prefix = letter.toUpperCase();
	if (!store.has('ticketing-system-consecutive')) {
		let max = -1;
		for await (const page of store.scan('ticketing-system-turn', {
			include_inactive: true,
		})) {
			for (const row of page) {
				// Prefijo exacto: «A» no cuenta los AP001 ni «AP» los A001.
				const n = turn_code_number(row.name, prefix);
				if (n != null) max = Math.max(max, n);
			}
		}
		return max + 1;
	}
	const existing =
		(await store.find_where('ticketing-system-consecutive', { name: prefix })) ??
		(await store.find_where('ticketing-system-consecutive', { name: prefix.toLowerCase() }));
	if (!existing) {
		await store.insert('ticketing-system-consecutive', {
			name: prefix,
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

async function collect_turns(
	store: ImperiumStore,
	where: Record<string, unknown>,
	keep: (row: ImperiumDoc) => boolean,
): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan('ticketing-system-turn', { where })) {
		for (const row of page) {
			if (keep(row)) out.push(row);
		}
	}
	return out;
}

async function pending_turns(store: ImperiumStore): Promise<ImperiumDoc[]> {
	const by_status = await collect_turns(store, { status: 'pendiente' }, is_pending);
	if (by_status.length) return by_status;
	return collect_turns(store, { estado: 'pendiente' }, is_pending);
}

async function attending_turns(store: ImperiumStore): Promise<ImperiumDoc[]> {
	const rows = await collect_turns(store, { status: 'en_atencion' }, is_attending);
	if (rows.length) return rows;
	return collect_turns(store, { estado: 'en_atencion' }, is_attending);
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

/** #300: la caja de licencias se reconoce por tener un servicio «Licencia(s)». */
const LICENCIAS = /licencia/i;
/** #300: filas en las que otra caja puede apoyar: general y tercera edad / discapacitados. */
const APOYO_TYPES = /general|3ra|tercera|discapac/i;

/**
 * #300: minutos que un turno de General o 3ra edad espera antes de que otra
 * caja lo apoye. Cada servicio lo cambia con `apoyo_minutos` (0 = apoyo
 * inmediato); si el turno trae varios servicios manda el menor.
 */
export const APOYO_MINUTOS_DEFAULT = 10;

async function service_doc(store: ImperiumStore, raw: unknown): Promise<ImperiumDoc> {
	if (raw && typeof raw === 'object') return as_object(raw);
	const id = text(raw);
	if (!id || !store.has('ticketing-system-service-type')) return {};
	return (await store.find_id('ticketing-system-service-type', id)) ?? {};
}

async function service_name(store: ImperiumStore, raw: unknown): Promise<string> {
	return text((await service_doc(store, raw)).name);
}

export function apoyo_minutos(value: unknown): number {
	if (value == null || String(value).trim() === '') return APOYO_MINUTOS_DEFAULT;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : APOYO_MINUTOS_DEFAULT;
}

async function apoyo_threshold_minutes(store: ImperiumStore, turn: ImperiumDoc): Promise<number> {
	const values: number[] = [];
	for (const raw of as_array(turn.services)) {
		values.push(apoyo_minutos((await service_doc(store, raw)).apoyo_minutos));
	}
	return values.length ? Math.min(...values) : APOYO_MINUTOS_DEFAULT;
}

function waiting_minutes(turn: ImperiumDoc, now: number): number {
	const created = new Date(String(turn.createdAt ?? turn.created_at ?? '')).getTime();
	if (!Number.isFinite(created)) return 0;
	return (now - created) / 60_000;
}

async function has_licencias_service(store: ImperiumStore, raws: unknown[]): Promise<boolean> {
	for (const raw of raws) {
		if (LICENCIAS.test(await service_name(store, raw))) return true;
	}
	return false;
}

async function apoyo_type_ids(store: ImperiumStore): Promise<string[]> {
	if (!store.has('ticketing-system-customer-type')) return [];
	const ids: string[] = [];
	for await (const page of store.scan('ticketing-system-customer-type')) {
		for (const row of page) {
			if (row.is_active !== false && APOYO_TYPES.test(text(row.name))) ids.push(text(row._id));
		}
	}
	return ids;
}

/**
 * #300 apoyo entre cajas: la fila de un turno de General o 3ra edad está
 * saturada cuando ese turno lleva más de su umbral esperando (ver
 * APOYO_MINUTOS_DEFAULT). Entonces una caja que no es de licencias y no tiene
 * turnos propios lo toma aunque no tenga ese tipo de cliente, siempre que
 * tenga los servicios del turno y el turno no sea de licencias.
 */
async function apoyo_turns(
	store: ImperiumStore,
	box: ImperiumDoc,
	waiting: ImperiumDoc[],
): Promise<ImperiumDoc[]> {
	const allowed_services = as_id_list(box.allowed_services);
	const allowed_types = as_id_list(box.allowed_customer_types);
	if (await has_licencias_service(store, allowed_services)) return [];
	const apoyo = await apoyo_type_ids(store);
	if (!allowed_types.some((id) => apoyo.includes(id))) return [];
	const now = Date.now();
	const out: ImperiumDoc[] = [];
	for (const turn of waiting) {
		const services = as_array(turn.services);
		if (!apoyo.includes(ref_id(turn.customer_type))) continue;
		if (!as_id_list(turn.services).every((id) => allowed_services.includes(id))) continue;
		if (await has_licencias_service(store, services)) continue;
		if (waiting_minutes(turn, now) < (await apoyo_threshold_minutes(store, turn))) continue;
		out.push(turn);
	}
	return out;
}

/** #300: en la caja de licencias, los turnos de licencias van primero. */
async function licencias_first(
	store: ImperiumStore,
	box: ImperiumDoc,
	ordered: ImperiumDoc[],
): Promise<ImperiumDoc[]> {
	if (!(await has_licencias_service(store, as_id_list(box.allowed_services)))) return ordered;
	const first: ImperiumDoc[] = [];
	const rest: ImperiumDoc[] = [];
	for (const turn of ordered) {
		((await has_licencias_service(store, as_array(turn.services))) ? first : rest).push(turn);
	}
	return [...first, ...rest];
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
	// #300: la pantalla muestra lo mismo que tomará «Tomar siguiente turno».
	if (!matching.length) matching.push(...(await apoyo_turns(store, box, waiting)));
	// La pantalla de caja muestra customer_type.name y services[].name;
	// sin populate llegan ids crudos (ObjectId) y el front los pinta tal cual.
	const pending_queue = await populate_turns(
		store,
		await licencias_first(store, box, await sort_pending(store, matching)),
	);
	// #373: las vistas por servicio y por tipo de usuario muestran también los
	// pendientes de otras cajas, marcados con `de_otra_caja: true`. La cola de
	// «Pendientes» y «Tomar siguiente turno» siguen siendo solo los de esta caja.
	const own_ids = new Set(pending_queue.map((turn) => ref_id(turn)));
	const others = await populate_turns(
		store,
		(await sort_pending(store, waiting.filter((turn) => !own_ids.has(ref_id(turn))))).map(
			(turn) => ({ ...turn, de_otra_caja: true }),
		),
	);
	const turns_by_service: Record<string, ImperiumDoc[]> = {};
	const turns_by_user_type: Record<string, ImperiumDoc[]> = {};
	for (const turn of [...pending_queue, ...others]) {
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
	// La pantalla de cada caja descarta los resúmenes que no traen su box_config_id.
	return { box_config_id: text(box._id), pending_queue, turns_by_service, turns_by_user_type };
}

/**
 * Resumen de pendientes de una caja (POST /box-turns-summary). La pantalla
 * de la caja lo pide al abrir; antes solo llegaba por socket (#185).
 */
export async function box_turns_summary_for_box(
	store: ImperiumStore,
	box_config_id: string,
): Promise<Record<string, unknown>> {
	const box_id = text(box_config_id);
	if (!box_id) throw new Error('Se necesita box_config_id');
	const box = await store.find_id('ticketing-system-box-config', box_id);
	if (!box) throw new Error('No se encontró la configuración de la caja');
	return box_turns_summary(store, box);
}

/** Las fotos salen en orden: una lectura anterior no pisa el tablero. */
let rooms_notice: Promise<void> = Promise.resolve();

export async function notify_ticketing_rooms(store: ImperiumStore) {
	const run = rooms_notice.then(() => publish_ticketing_rooms(store));
	rooms_notice = run.then(
		() => undefined,
		() => undefined,
	);
	await run;
}

async function publish_ticketing_rooms(store: ImperiumStore) {
	if (!store.has('ticketing-system-turn')) return;
	const pending = await sort_pending(store, await pending_turns(store));
	emit_to_room(ROOM, 'update', { action: 'turn_stack_next', data: pending });
	emit_to_room(ROOM, 'update', {
		action: 'turn_stack_attending',
		data: await populate_turns(store, await attending_turns(store)),
	});
	if (!store.has('ticketing-system-box-config')) return;
	const boxes: ImperiumDoc[] = [];
	for await (const page of store.scan('ticketing-system-box-config')) {
		boxes.push(...page);
	}
	for (const box of boxes.filter((row) => row.is_active !== false)) {
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
	let letter = turn_code_prefix(customer.letter);
	for (const service of services) {
		const service_priority = await priority_number(store, service.priority_level);
		if (service_priority > highest) {
			highest = service_priority;
			letter = turn_code_prefix(service.letter, letter);
		}
	}
	const consecutive = await next_consecutive(store, letter);
	out.customer_type = customer_id;
	out.services = service_ids;
	out.name = format_turn_code(letter, consecutive);
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
): Promise<{ turn: ImperiumDoc | null; waiting: number }> {
	const box_id = text(box_config_id);
	if (!box_id) throw new Error('Se necesita una caja para tomar el siguiente turno');
	const box = await store.find_id('ticketing-system-box-config', box_id);
	if (!box) throw new Error('No se encontró la configuración de la caja');
	const allowed_services = as_id_list(box.allowed_services);
	const allowed_types = as_id_list(box.allowed_customer_types);
	const waiting = await pending_turns(store);
	// Fila vacía: aviso 200 sin turno (mismo contrato que el backend Mongo).
	if (!waiting.length) return { turn: null, waiting: 0 };
	const matching: ImperiumDoc[] = [];
	for (const turn of waiting) {
		const services = as_id_list(turn.services);
		const type_id = ref_id(turn.customer_type);
		if (services.every((id) => allowed_services.includes(id)) && allowed_types.includes(type_id)) {
			matching.push(turn);
		}
	}
	if (!matching.length) matching.push(...(await apoyo_turns(store, box, waiting)));
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
		let detail = `Los turnos disponibles requieren que la caja tenga el tipo de usuario '${types_list}' configurado. No fue posible tomar un turno.`;
		if (missing_services.size && missing_types.size) {
			detail = `Los turnos disponibles requieren que la caja tenga el servicio '${services_list}' y el tipo de usuario '${types_list}' configurado. No fue posible tomar un turno.`;
		} else if (missing_services.size) {
			detail = `Los turnos disponibles requieren que la caja tenga el servicio '${services_list}' configurado. No fue posible tomar un turno.`;
		}
		debug_warning(detail);
		return { turn: null, waiting: 0 };
	}
	const ordered = await licencias_first(store, box, await sort_pending(store, matching));
	for (const next of ordered) {
		const stamp = new Date().toISOString();
		const updated = await store.update(
			'ticketing-system-turn',
			String(next._id),
			{
				status: 'en_atencion',
				estado: 'en_atencion',
				assigned_box: box_id,
				fecha_inicio: stamp,
				time_box: [stamp],
			},
			{ only_if_status: 'pendiente' },
		);
		if (!updated) continue;
		await notify_ticketing_rooms(store);
		const [populated] = await populate_turns(store, [updated]);
		return { turn: populated ?? updated, waiting: waiting.length };
	}
	return { turn: null, waiting: 0 };
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

function attending_stamp(row: ImperiumDoc): string {
	return text(row.updatedAt ?? row.updated_at ?? row.createdAt ?? row.created_at);
}

/**
 * Turno que la caja dejó «en atención» (el más reciente). La pantalla de la
 * caja lo pide al abrir para avisar «Turno sin terminar» aunque el turno se
 * haya quedado abierto en otro navegador o equipo (#185, PR 459).
 */
export async function attending_turn_for_box(
	store: ImperiumStore,
	box_config_id: string,
): Promise<ImperiumDoc | null> {
	const box_id = text(box_config_id);
	if (!box_id) throw new Error('Se necesita box_config_id');
	const rows = (await attending_turns(store)).filter((row) => ref_id(row.assigned_box) === box_id);
	if (!rows.length) return null;
	rows.sort((a, b) => attending_stamp(b).localeCompare(attending_stamp(a)));
	const [populated] = await populate_turns(store, [rows[0]]);
	return populated ?? rows[0];
}

/**
 * Por cada caja con turno en atención, el más reciente (misma regla de stamp
 * que attending_turn_for_box). Sirve al modal «Abrir caja» para señalarlo.
 */
export async function boxes_attending_turns(
	store: ImperiumStore,
): Promise<Array<{ box_config_id: string; turn_id: string; turn_name: string }>> {
	const by_box = new Map<string, ImperiumDoc>();
	for (const row of await attending_turns(store)) {
		const box_id = ref_id(row.assigned_box);
		if (!box_id) continue;
		const prev = by_box.get(box_id);
		if (!prev || attending_stamp(row).localeCompare(attending_stamp(prev)) > 0) {
			by_box.set(box_id, row);
		}
	}
	return [...by_box.entries()].map(([box_config_id, turn]) => ({
		box_config_id,
		turn_id: text(turn._id),
		turn_name: text(turn.name),
	}));
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
