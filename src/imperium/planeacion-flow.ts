/**
 * Planeación: mismo ciclo que proyectos.service / proyectos-task / mis-tareas.
 * El detalle hidrata tareas y tiempos; el save sincroniza esos hijos.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const TIME_LOG = 'proyectos-time-log';
const TASK_STATES = new Set(['pendiente', 'en_progreso', 'completado', 'cancelado']);
const PRIORITIES = new Set(['baja', 'media', 'alta', 'urgente']);
const COLLAB = {
	pendiente: 'pendiente',
	aceptada: 'aceptada',
	rechazada: 'rechazada',
} as const;

export function is_project_resource(resource: string) {
	return resource === 'planeacion-proyectos' || resource === 'proyectos';
}

export function is_project_task_resource(resource: string) {
	return resource === 'planeacion-proyectos-task' || resource === 'proyectos-task';
}

export function is_personal_task_resource(resource: string) {
	return resource === 'planeacion-mis-tareas' || resource === 'mis-tareas';
}

function text(value: unknown): string {
	return String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') {
		const o = value as { _id?: unknown; id?: unknown; client_id?: unknown };
		return text(o._id ?? o.id ?? o.client_id);
	}
	return text(value);
}

function ref_key(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') {
		const o = value as { client_id?: unknown; _id?: unknown; id?: unknown };
		return text(o.client_id ?? o._id ?? o.id);
	}
	return text(value);
}

function ref_list(value: unknown): string[] {
	return [...new Set(as_array(value).map(ref_id).filter(Boolean))];
}

function normalize_date(value: unknown): string | undefined {
	if (!value) return undefined;
	if (value instanceof Date) return value.toISOString();
	const raw = text(value);
	return raw || undefined;
}

function normalize_number(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const n = Number(value.trim());
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function actor_id(actor: ImperiumDoc | null): string {
	return ref_id(actor?._id ?? actor?.id);
}

function project_resource(store: ImperiumStore) {
	return store.has('planeacion-proyectos') ? 'planeacion-proyectos' : 'proyectos';
}

function task_resource(store: ImperiumStore) {
	return store.has('planeacion-proyectos-task') ? 'planeacion-proyectos-task' : 'proyectos-task';
}

function route_slug(value?: string) {
	return (
		(value ?? 'proyecto')
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '') || 'proyecto'
	);
}

function collaboration_requests(existing: ImperiumDoc | null | undefined, collaborator_ids: string[]) {
	const previous = new Map<string, Record<string, unknown>>();
	for (const raw of as_array(existing?.collaboration_requests)) {
		const row = as_object(raw);
		const uid = ref_id(row.user_id);
		if (uid) previous.set(uid, row);
	}
	return collaborator_ids.map((user_id) => {
		const current = previous.get(user_id);
		if (!current) {
			return { user_id, status: COLLAB.pendiente, invited_at: new Date().toISOString() };
		}
		const status = text(current.status) || COLLAB.pendiente;
		return {
			user_id,
			status,
			invited_at: current.invited_at ?? new Date().toISOString(),
			responded_at: status === COLLAB.pendiente ? undefined : current.responded_at,
			responded_by_user: status === COLLAB.pendiente ? undefined : ref_id(current.responded_by_user),
		};
	});
}

export function prepare_project_write(
	incoming: ImperiumDoc,
	actor: ImperiumDoc | null,
	previous?: ImperiumDoc | null,
): ImperiumDoc {
	const collaborator_users =
		'collaborator_users' in incoming
			? ref_list(incoming.collaborator_users)
			: ref_list(previous?.collaborator_users);
	const owner_user =
		ref_id(incoming.owner_user) || ref_id(previous?.owner_user) || actor_id(actor);
	return {
		...incoming,
		name: incoming.name,
		description: incoming.description,
		markdown_specification: incoming.markdown_specification ?? incoming.description ?? previous?.description,
		state: incoming.state ?? incoming.status ?? previous?.state,
		priority: incoming.priority ?? previous?.priority,
		start_date: normalize_date(incoming.start_date) ?? previous?.start_date,
		due_date: normalize_date(incoming.due_date) ?? previous?.due_date,
		completed_at: normalize_date(incoming.completed_at) ?? previous?.completed_at,
		owner_user,
		collaborator_users,
		collaboration_requests: collaboration_requests(previous, collaborator_users),
		observer_users:
			'observer_users' in incoming
				? ref_list(incoming.observer_users)
				: ref_list(previous?.observer_users),
		progress_percentage:
			typeof incoming.progress_percentage === 'number' ? incoming.progress_percentage : undefined,
		is_active: typeof incoming.is_active === 'boolean' ? incoming.is_active : incoming.is_active,
		tasks: undefined,
		time_logs: undefined,
	};
}

export function prepare_project_task_write(incoming: ImperiumDoc, actor: ImperiumDoc | null): ImperiumDoc {
	const project_id = ref_id(incoming.project_id);
	if (!project_id) throw new Error('Debes indicar el proyecto de la tarea');
	const status = text(incoming.status ?? incoming.state);
	const priority = text(incoming.priority);
	return {
		...incoming,
		name: incoming.name,
		description: incoming.description,
		markdown_specification: text(incoming.markdown_specification) || text(incoming.description) || '',
		project_id,
		parent_task_id: ref_id(incoming.parent_task_id ?? incoming.parent_task) || undefined,
		requested_by_user: ref_id(incoming.requested_by_user) || actor_id(actor),
		assignee_users: ref_list(incoming.assignee_users),
		observer_users: ref_list(incoming.observer_users),
		status: TASK_STATES.has(status) ? status : 'pendiente',
		priority: PRIORITIES.has(priority) ? priority : 'media',
		start_date: normalize_date(incoming.start_date),
		due_date: normalize_date(incoming.due_date),
		completed_at: normalize_date(incoming.completed_at),
		estimated_minutes: normalize_number(incoming.estimated_minutes),
		sort_order: normalize_number(incoming.sort_order),
		is_active: typeof incoming.is_active === 'boolean' ? incoming.is_active : incoming.is_active,
	};
}

export function prepare_personal_task_write(incoming: ImperiumDoc, actor: ImperiumDoc | null): ImperiumDoc {
	const uid = actor_id(actor);
	if (!uid) throw new Error('No se pudo resolver el usuario actual');
	return {
		...incoming,
		name: incoming.name,
		description: incoming.description,
		markdown_specification: incoming.markdown_specification ?? incoming.description,
		state: incoming.state ?? incoming.status,
		priority: incoming.priority,
		start_date: normalize_date(incoming.start_date),
		due_date: normalize_date(incoming.due_date),
		completed_at: normalize_date(incoming.completed_at),
		estimated_minutes: normalize_number(incoming.estimated_minutes),
		owner_user: uid,
		assignee_users: ref_list(incoming.assignee_users),
		observer_users: ref_list(incoming.observer_users),
		parent_task: ref_id(incoming.parent_task ?? incoming.parent_task_id) || undefined,
		is_active: typeof incoming.is_active === 'boolean' ? incoming.is_active : incoming.is_active,
	};
}

export function assert_personal_task_owner(existing: ImperiumDoc | null, actor: ImperiumDoc | null) {
	const uid = actor_id(actor);
	if (!existing || ref_id(existing.owner_user) !== uid) {
		throw new Error('No se encontró la tarea personal a actualizar');
	}
}

function compute_duration(started_at: unknown, ended_at: unknown, fallback?: number) {
	if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback;
	if (!started_at || !ended_at) return fallback;
	const start = new Date(String(started_at)).getTime();
	const end = new Date(String(ended_at)).getTime();
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallback;
	return Math.round((end - start) / 60000);
}

async function sync_project_tasks(
	store: ImperiumStore,
	project_id: string,
	raw_tasks: unknown,
	current_user_id?: string,
) {
	const map = new Map<string, string>();
	if (!Array.isArray(raw_tasks) || !store.has(task_resource(store))) return map;
	const resource = task_resource(store);
	const { rows: existing } = await store.find_many(resource, {
		where: { project_id },
		take: 20000,
		include_inactive: false,
		populate: false,
	});
	const retained = new Set<string>();
	const parents = new Map<string, string>();
	for (const [index, raw] of raw_tasks.entries()) {
		if (!raw || typeof raw !== 'object') continue;
		const input = as_object(raw);
		const task_id = ref_id(input._id);
		const client_id = ref_key(input.client_id);
		const task_name = text(input.name);
		if (!task_name && !task_id) continue;
		const payload: ImperiumDoc = {
			name: task_name || `Tarea ${index + 1}`,
			description: text(input.description) || undefined,
			markdown_specification: text(input.markdown_specification) || text(input.description) || '',
			project_id,
			requested_by_user: ref_id(input.requested_by_user) || current_user_id,
			assignee_users: ref_list(input.assignee_users),
			status: TASK_STATES.has(text(input.status)) ? text(input.status) : 'pendiente',
			priority: PRIORITIES.has(text(input.priority)) ? text(input.priority) : 'media',
			start_date: normalize_date(input.start_date),
			due_date: normalize_date(input.due_date),
			completed_at: normalize_date(input.completed_at),
			estimated_minutes: normalize_number(input.estimated_minutes),
			sort_order: normalize_number(input.sort_order) ?? index,
			is_active: typeof input.is_active === 'boolean' ? input.is_active : true,
		};
		let saved: ImperiumDoc | null = null;
		if (task_id) {
			const current = await store.find_id(resource, task_id);
			if (current && ref_id(current.project_id) === project_id) {
				saved = await store.update(resource, task_id, payload);
			}
		}
		if (!saved) saved = await store.insert(resource, payload);
		const persisted = String(saved._id);
		retained.add(persisted);
		map.set(persisted, persisted);
		if (task_id) map.set(task_id, persisted);
		if (client_id) map.set(client_id, persisted);
		const parent = ref_key(input.parent_task_id ?? input.parent_task);
		if (parent) parents.set(persisted, parent);
	}
	for (const [task_id, parent_ref] of parents) {
		const resolved = map.get(parent_ref);
		if (resolved && resolved !== task_id) {
			await store.update(resource, task_id, { parent_task_id: resolved });
		} else {
			await store.update(resource, task_id, { parent_task_id: null });
		}
	}
	await store.set_inactive_ids(
		resource,
		existing.map((row) => String(row._id)).filter((id) => !retained.has(id)),
	);
	return map;
}

async function sync_project_time_logs(
	store: ImperiumStore,
	project_id: string,
	raw_logs: unknown,
	current_user_id?: string,
	task_map = new Map<string, string>(),
) {
	if (!Array.isArray(raw_logs) || !store.has(TIME_LOG)) return;
	const { rows: existing } = await store.find_many(TIME_LOG, {
		where: { project_id },
		take: 20000,
		include_inactive: false,
		populate: false,
	});
	const retained = new Set<string>();
	for (const raw of raw_logs) {
		if (!raw || typeof raw !== 'object') continue;
		const input = as_object(raw);
		const log_id = ref_id(input._id);
		const started_at = normalize_date(input.started_at);
		if (!log_id && !started_at) continue;
		const task_ref = ref_key(input.task_id);
		const resolved_task = task_ref ? task_map.get(task_ref) || ref_id(task_ref) : undefined;
		const payload: ImperiumDoc = {
			name: text(input.name) || 'Registro de tiempo',
			description: text(input.description) || undefined,
			notes: text(input.notes) || undefined,
			project_id,
			task_id: resolved_task,
			user_id: ref_id(input.user_id) || current_user_id,
			started_at: started_at ?? new Date().toISOString(),
			ended_at: normalize_date(input.ended_at),
			duration_minutes: compute_duration(started_at, normalize_date(input.ended_at), normalize_number(input.duration_minutes)),
			is_active: typeof input.is_active === 'boolean' ? input.is_active : true,
		};
		let saved: ImperiumDoc | null = null;
		if (log_id) {
			const current = await store.find_id(TIME_LOG, log_id);
			if (current && ref_id(current.project_id) === project_id) {
				saved = await store.update(TIME_LOG, log_id, payload);
			}
		}
		if (!saved) saved = await store.insert(TIME_LOG, payload);
		retained.add(String(saved._id));
	}
	await store.set_inactive_ids(
		TIME_LOG,
		existing.map((row) => String(row._id)).filter((id) => !retained.has(id)),
	);
}

async function notify_new_collaborators(
	store: ImperiumStore,
	project: ImperiumDoc,
	recipient_ids: string[],
	actor: ImperiumDoc | null,
) {
	const uid = actor_id(actor);
	const recipients = recipient_ids.filter((id) => id && id !== uid);
	if (!project._id || !recipients.length || !store.has('notifications')) return;
	const name = text(project.name) || 'Proyecto';
	const route = `/internal/planeacion/proyectos/detail/${route_slug(name)}/${project._id}`;
	for (const recipientId of recipients) {
		await store.insert('notifications', {
			name: `Te agregaron al proyecto "${name}"`,
			title: `Te agregaron al proyecto "${name}"`,
			message:
				'Revisa el proyecto y confirma si participarás en los siguientes entregables desde Planeación.',
			recipientId,
			type: 'project_assignment',
			actor: { _id: uid, name: actor?.name, email: actor?.email },
			source: {
				kind: 'project',
				action: 'assignment',
				modelName: 'Proyectos',
				collectionName: 'proyectos',
				documentId: String(project._id),
				route,
				entityLabel: name,
			},
			payload: {
				project_id: String(project._id),
				response_status: COLLAB.pendiente,
				available_actions: ['accept', 'reject'],
			},
			isRead: false,
			is_active: true,
		});
	}
}

export async function after_project_write(
	store: ImperiumStore,
	project: ImperiumDoc,
	body: ImperiumDoc,
	actor: ImperiumDoc | null,
	previous?: ImperiumDoc | null,
) {
	const project_id = String(project._id ?? '');
	const uid = actor_id(actor);
	const task_map = await sync_project_tasks(store, project_id, body.tasks, uid);
	await sync_project_time_logs(store, project_id, body.time_logs, uid, task_map);
	const before = new Set(ref_list(previous?.collaborator_users));
	const added = ref_list(project.collaborator_users).filter((id) => !before.has(id));
	await notify_new_collaborators(store, project, added, actor);
}

async function load_users(store: ImperiumStore, ids: string[]) {
	const wanted = [...new Set(ids.filter(Boolean))];
	if (!wanted.length || !store.has('user')) return new Map<string, ImperiumDoc>();
	const { rows } = await store.find_many('user', {
		ids: wanted,
		take: wanted.length,
		include_inactive: true,
		populate: false,
	});
	return new Map(rows.map((row) => [String(row._id), row]));
}

function user_lite(row: ImperiumDoc | undefined, id: string) {
	return row
		? { _id: row._id, name: row.name ?? '', description: row.description ?? '' }
		: { _id: id, name: '' };
}

export async function hydrate_project(store: ImperiumStore, project: ImperiumDoc): Promise<ImperiumDoc> {
	const project_id = String(project._id ?? '');
	const tasks = store.has(task_resource(store))
		? (
				await store.find_many(task_resource(store), {
					where: { project_id },
					take: 20000,
					sort: 'sort_order:asc',
					populate: false,
				})
			).rows
		: [];
	const time_logs = store.has(TIME_LOG)
		? (
				await store.find_many(TIME_LOG, {
					where: { project_id },
					take: 20000,
					populate: false,
				})
			).rows
		: [];
	const completed_task_count = tasks.filter((task) => text(task.status) === 'completado').length;
	const task_count = tasks.length;
	const user_ids = [
		ref_id(project.owner_user),
		...ref_list(project.collaborator_users),
		...ref_list(project.observer_users),
		...tasks.flatMap((task) => [
			ref_id(task.requested_by_user),
			...ref_list(task.assignee_users),
		]),
		...time_logs.map((log) => ref_id(log.user_id)),
	];
	const users = await load_users(store, user_ids);
	tasks.sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
	const hydrated_tasks = tasks.map((task) => ({
		...task,
		requested_by_user: user_lite(users.get(ref_id(task.requested_by_user)), ref_id(task.requested_by_user)),
		assignee_users: ref_list(task.assignee_users).map((id) => user_lite(users.get(id), id)),
	}));
	return {
		...project,
		owner_user: user_lite(users.get(ref_id(project.owner_user)), ref_id(project.owner_user)),
		collaborator_users: ref_list(project.collaborator_users).map((id) => user_lite(users.get(id), id)),
		observer_users: ref_list(project.observer_users).map((id) => user_lite(users.get(id), id)),
		task_count,
		completed_task_count,
		progress_percentage: task_count ? Math.round((completed_task_count / task_count) * 100) : 0,
		tasks: hydrated_tasks,
		time_logs: time_logs.map((log) => ({
			...log,
			user_id: user_lite(users.get(ref_id(log.user_id)), ref_id(log.user_id)),
		})),
	};
}

export function apply_root_parent_filter(resource: string, where: Record<string, unknown>, rows: ImperiumDoc[]) {
	const key = is_personal_task_resource(resource) ? 'parent_task' : 'parent_task_id';
	if (where[key] !== '__root__' && where.parent_task !== '__root__' && where.parent_task_id !== '__root__') {
		return rows;
	}
	return rows.filter((row) => !ref_id(row.parent_task ?? row.parent_task_id));
}

export function strip_root_parent_where(where: Record<string, unknown>) {
	const next = { ...where };
	if (next.parent_task === '__root__') delete next.parent_task;
	if (next.parent_task_id === '__root__') delete next.parent_task_id;
	return next;
}

/** Agrupa como el `$group._id` de Mongoose: vacío o ausente → `null`. */
function breakdown_field(
	rows: ImperiumDoc[],
	field: string,
): Array<{ _id: string | null; count: number }> {
	const counts = new Map<string | null, number>();
	for (const row of rows) {
		const raw = row[field];
		const key = raw == null || raw === '' ? null : String(raw);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? '')))
		.map(([_id, count]) => ({ _id, count }));
}

function planning_stats_payload(
	rows: ImperiumDoc[],
	extra: Record<string, unknown>,
): Record<string, unknown> {
	const total_records = rows.length;
	const active_records = rows.filter((row) => row.is_active !== false).length;
	const now = new Date();
	return {
		total_records,
		active_records,
		...extra,
		last_updated: now,
		kpis: {
			total_records: { label: 'Total', value: total_records },
			active_records: { label: 'Activos', value: active_records },
		},
	};
}

/**
 * `__get_statistics` de proyectos / tareas / mis-tareas: breakdowns
 * (`status_breakdown`, `priority_breakdown`) y recuentos con el mismo
 * alcance que el original (proyecto, dueño).
 */
export async function planeacion_statistics(
	store: ImperiumStore,
	resource: string,
	url?: URL,
	actor?: ImperiumDoc | null,
	mongo_match?: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
	if (is_project_resource(resource)) {
		const { rows } = await store.find_many(resource, {
			take: 20000,
			include_inactive: true,
			populate: false,
			mongo_match,
		});
		return planning_stats_payload(rows, {
			status_breakdown: breakdown_field(rows, 'state'),
			priority_breakdown: breakdown_field(rows, 'priority'),
		});
	}
	if (is_project_task_resource(resource)) {
		const project_id = String(url?.searchParams.get('project_id') ?? '').trim();
		if (!project_id) return null;
		const { rows } = await store.find_many(resource, {
			take: 20000,
			include_inactive: true,
			populate: false,
			where: { project_id },
			mongo_match,
		});
		const normalized = rows.map((row) => ({
			...row,
			status: row.status ?? row.state,
		}));
		return planning_stats_payload(normalized, {
			status_breakdown: breakdown_field(normalized, 'status'),
		});
	}
	if (is_personal_task_resource(resource)) {
		const uid = ref_id(actor?._id ?? actor?.id);
		if (!uid) throw new Error('No se pudo resolver el usuario actual');
		const { rows } = await store.find_many(resource, {
			take: 20000,
			include_inactive: true,
			populate: false,
			where: { owner_user: uid },
			mongo_match,
		});
		return planning_stats_payload(rows, {
			status_breakdown: breakdown_field(rows, 'state'),
		});
	}
	return null;
}

export { project_resource, TIME_LOG as PROJECT_TIME_LOG_RESOURCE };
