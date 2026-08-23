/**
 * Tickets públicos, internos, de error/log e interinstancia.
 * Mismo contrato que `tickets.service.ts` + `tickets.routes.ts`.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { build_access } from './auth.ts';
import { is_seed_admin } from './group-access.ts';
import {
	assert_interinstance_outbound,
	deny_interinstance,
	forward_interinstance,
	interinstance_key_from_req,
	messaging_settings,
	validate_interinstance_api_key,
} from './interinstance.ts';
import type { ImperiumStore } from './store.ts';

export type TicketCtx = {
	store: ImperiumStore;
	req: Request;
	url: URL;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
};

const TICKET_STATUS_VALUES = [
	{ value: 'open', type: 'warning', display_leyend: 'Abierto', icon: 'fas fa-exclamation' },
	{ value: 'in_progress', type: 'info', display_leyend: 'En proceso', icon: 'fas fa-gears' },
	{ value: 'resolved', type: 'success', display_leyend: 'Resuelto', icon: 'fas fa-check' },
	{ value: 'closed', type: 'neutral', display_leyend: 'Cerrado', icon: 'fas fa-ban' },
];

const ADMIN_INSTANCE_TYPE = {
	title: 'String',
	description: 'String',
	status: 'String',
	sourceType: 'String',
	reporter_name: 'String',
	isLockedByAssignment: 'Boolean',
	createdAt: 'Date',
};

const public_rate_buckets = new Map<string, { started_at: number; count: number }>();

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function optional_text(value: unknown): string | undefined {
	const raw = text(value);
	return raw || undefined;
}

function optional_object(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function id_list(value: unknown): string[] {
	if (typeof value === 'string') {
		const item = text(value);
		return item ? [item] : [];
	}
	const unique = new Set<string>();
	for (const item of as_array(value)) {
		const id =
			item && typeof item === 'object'
				? text((item as { _id?: unknown; id?: unknown })._id ?? (item as { id?: unknown }).id)
				: text(item);
		if (id) unique.add(id);
	}
	return [...unique];
}

function has_body_field(body: Record<string, unknown>, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(body, field);
}

function now(): string {
	return new Date().toISOString();
}

function created_ms(doc: ImperiumDoc): number {
	const t = new Date(String(doc.createdAt ?? doc.created_at ?? '')).getTime();
	return Number.isFinite(t) ? t : 0;
}

function actor_id(actor: ImperiumDoc | null): string {
	return text(actor?._id ?? actor?.id);
}

function http_error(message: string, status: number): never {
	const error = new Error(message) as Error & { status: number };
	error.status = status;
	throw error;
}

function created(ticket: ImperiumDoc, message: string): Response {
	return Response.json(ok([ticket], message), { status: 201 });
}

function client_ip(req: Request): string | undefined {
	const forwarded = req.headers.get('x-forwarded-for');
	if (forwarded?.trim()) return forwarded.split(',')[0]?.trim() || undefined;
	return undefined;
}

function bool_flag(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value === 1;
	if (typeof value === 'string') {
		const raw = value.trim().toLowerCase();
		return raw === 'true' || raw === '1';
	}
	return false;
}

function current_reporter(ctx: TicketCtx): ImperiumDoc {
	return {
		userId: actor_id(ctx.actor) || undefined,
		name: optional_text(ctx.actor?.name),
		email: optional_text(ctx.actor?.email),
		ip: client_ip(ctx.req),
	};
}

function has_planning_assignment(ticket?: Partial<ImperiumDoc> | null): boolean {
	return Boolean(
		id_list(ticket?.assignedProjectIds ?? ticket?.assigned_project_ids).length ||
			id_list(ticket?.assignedPersonalTaskIds ?? ticket?.assigned_personal_task_ids).length,
	);
}

function ticket_schema_validation() {
	return {
		properties: {
			title: { type: 'String' },
			description: { type: 'String' },
			status: { type: 'String' },
			sourceType: { type: 'String' },
			isLockedByAssignment: { type: 'Boolean' },
		},
		metadata: {
			state_fields: {
				fields: [
					{
						field_name: 'status',
						enabled: true,
						values: TICKET_STATUS_VALUES,
					},
				],
			},
		},
	};
}

function serialize_log(log_payload?: Record<string, unknown>) {
	if (!log_payload) return undefined;
	try {
		return JSON.stringify(log_payload, null, 2);
	} catch {
		return undefined;
	}
}

function ticket_route(ticket_id?: unknown) {
	const id = text(ticket_id);
	if (!id) return '/internal/tickets';
	return `/internal/tickets?ticket_id=${encodeURIComponent(id)}`;
}

function assert_public_rate(ip: string | undefined, window_minutes: number, max: number) {
	const key = ip || 'unknown';
	const window_ms = Math.max(1, window_minutes) * 60 * 1000;
	const stamp = Date.now();
	const current = public_rate_buckets.get(key);
	if (!current || stamp - current.started_at > window_ms) {
		public_rate_buckets.set(key, { started_at: stamp, count: 1 });
		return;
	}
	current.count += 1;
	if (current.count > max) {
		http_error(
			'Has alcanzado temporalmente el límite de tickets públicos. Intenta más tarde.',
			429,
		);
	}
}

async function ensure_user_exists(store: ImperiumStore, user_id?: string): Promise<string | undefined> {
	const id = optional_text(user_id);
	if (!id) return undefined;
	const user = store.has('user') ? await store.find_id('user', id) : null;
	if (!user) throw new Error('No se encontró el usuario asignado solicitado.');
	return id;
}

async function ensure_ids_exist(
	store: ImperiumStore,
	resource: string,
	ids: string[],
	missing_message: string,
): Promise<string[]> {
	if (!ids.length) return [];
	if (!store.has(resource)) throw new Error(missing_message);
	const missing: string[] = [];
	for (const id of ids) {
		const found = await store.find_id(resource, id);
		if (!found) missing.push(id);
	}
	if (missing.length) throw new Error(missing_message);
	return ids;
}

async function can_bypass_assignment(store: ImperiumStore, actor: ImperiumDoc | null): Promise<boolean> {
	if (is_seed_admin(actor)) return true;
	if (actor?.has_full_access === true) return true;
	if (!actor) return false;
	const access = await build_access(store, actor);
	return access.has_full_access === true;
}

function ensure_ticket_update_allowed(
	ticket: ImperiumDoc,
	actor: ImperiumDoc | null,
	bypass: boolean,
) {
	if (has_planning_assignment(ticket)) {
		throw new Error(
			'Este ticket ya fue asignado a tareas o proyectos y debe gestionarse desde ese proyecto o tarea.',
		);
	}
	const assigned = text(ticket.assignedUserId ?? ticket.assigned_user_id);
	if (!assigned) return;
	const uid = actor_id(actor);
	if (!bypass && uid !== assigned) {
		throw new Error('Solo la persona asignada o un administrador puede modificar este ticket.');
	}
}

async function notify_internal_ticket_created(store: ImperiumStore, ticket: ImperiumDoc, actor: ImperiumDoc | null) {
	const uid = actor_id(actor);
	if (!uid || !store.has('notifications')) return;
	await store.insert('notifications', {
		name: 'Ticket creado',
		title: 'Ticket creado',
		message: text(ticket.title) || 'Se creó un ticket de soporte desde tu sesión.',
		type: 'ticket',
		recipientId: uid,
		isRead: false,
		is_active: true,
		source: {
			kind: 'ticket',
			action: 'created',
			modelName: 'Ticket',
			collectionName: '__tickets',
			documentId: ticket._id,
			route: ticket_route(ticket._id),
			entityLabel: ticket.title,
		},
		payload: {
			ticket_id: ticket._id,
			source_type: ticket.sourceType,
		},
		actor: {
			_id: uid,
			name: optional_text(actor?.name),
			email: optional_text(actor?.email),
		},
	});
}

type CreateTicketInput = {
	title: string;
	description: string;
	source_type: string;
	reporter?: ImperiumDoc;
	assigned_user_id?: string;
	assigned_personal_task_ids?: string[];
	assigned_project_ids?: string[];
	payload?: Record<string, unknown>;
	instance_data?: Record<string, unknown>;
	should_forward_interinstance?: boolean;
	interinstance?: Record<string, unknown>;
};

async function persist_ticket(store: ImperiumStore, input: CreateTicketInput, actor: ImperiumDoc | null) {
	const settings = await messaging_settings(store);
	const should_forward =
		input.should_forward_interinstance === true &&
		settings.interinstance_enabled &&
		Boolean(settings.interinstance_endpoint) &&
		Boolean(settings.interinstance_api_key);

	if (should_forward) {
		return forward_created_ticket(store, input, settings);
	}

	const assigned_personal_task_ids = input.assigned_personal_task_ids ?? [];
	const assigned_project_ids = input.assigned_project_ids ?? [];
	const is_locked = Boolean(assigned_personal_task_ids.length || assigned_project_ids.length);
	const assigned_user_id = is_locked ? undefined : input.assigned_user_id;
	return store.insert('tickets', {
		name: input.title,
		title: input.title,
		description: input.description,
		sourceType: input.source_type,
		status: 'open',
		estado: 'open',
		reporter: input.reporter,
		assignedUserId: assigned_user_id,
		assigned_user_id: assigned_user_id,
		assignedPersonalTaskIds: assigned_personal_task_ids,
		assignedProjectIds: assigned_project_ids,
		isLockedByAssignment: is_locked,
		payload: input.payload,
		instanceData: input.instance_data,
		interinstance: {
			forwarded: false,
			...(input.interinstance ?? {}),
		},
		created_by: actor_id(actor) || undefined,
	});
}

async function forward_created_ticket(
	store: ImperiumStore,
	input: CreateTicketInput,
	settings: Awaited<ReturnType<typeof messaging_settings>>,
) {
	const { endpoint } = await assert_interinstance_outbound(store, 'tickets');
	const has_planning = Boolean(
		input.assigned_personal_task_ids?.length || input.assigned_project_ids?.length,
	);
	const payload = {
		title: input.title,
		description: input.description,
		source_type: input.source_type,
		reporter: input.reporter,
		assigned_user_id: has_planning ? undefined : input.assigned_user_id,
		assigned_personal_task_ids: input.assigned_personal_task_ids,
		assigned_project_ids: input.assigned_project_ids,
		payload: input.payload,
		instance_data: input.instance_data,
	};
	const forward_result = await forward_interinstance(endpoint, settings.interinstance_api_key, payload);
	if (!forward_result.delivered) {
		const status_segment = forward_result.status ? ` (${forward_result.status})` : '';
		const response_message = text(forward_result.responseMessage);
		throw new Error(
			response_message
				? `No se pudo enviar el ticket interinstancia${status_segment}: ${response_message}`
				: `No se pudo enviar el ticket interinstancia${status_segment}.`,
		);
	}
	let remote: ImperiumDoc = {};
	try {
		const parsed = JSON.parse(String(forward_result.responseMessage ?? '')) as {
			data?: ImperiumDoc[];
		};
		if (parsed?.data?.[0] && typeof parsed.data[0] === 'object') remote = parsed.data[0]!;
	} catch {
		remote = {};
	}
	return {
		...remote,
		_id: remote._id ?? undefined,
		title: remote.title ?? input.title,
		description: remote.description ?? input.description,
		name: String(remote.title ?? input.title),
		sourceType: 'interinstance',
		status: remote.status ?? 'open',
		reporter: remote.reporter ?? input.reporter,
		assignedUserId: remote.assignedUserId ?? input.assigned_user_id,
		assignedPersonalTaskIds:
			remote.assignedPersonalTaskIds ?? input.assigned_personal_task_ids ?? [],
		assignedProjectIds: remote.assignedProjectIds ?? input.assigned_project_ids ?? [],
		isLockedByAssignment:
			remote.isLockedByAssignment ??
			Boolean(input.assigned_personal_task_ids?.length || input.assigned_project_ids?.length),
		payload: remote.payload ?? input.payload,
		instanceData: remote.instanceData ?? input.instance_data,
		interinstance: {
			...as_object(remote.interinstance),
			endpoint,
			forwarded: true,
			responseStatus: forward_result.status,
			responseMessage: forward_result.responseMessage,
			externalTicketId: remote._id,
		},
	};
}

export async function tickets_public_metadata(ctx: TicketCtx) {
	const settings = await messaging_settings(ctx.store);
	const endpoint = settings.interinstance_endpoint.trim();
	return ok(
		[
			{
				settings: {
					public_enabled: settings.public_enabled,
					rate_limit_window_minutes: settings.rate_limit_window_minutes,
					rate_limit_max: settings.rate_limit_max,
					messaging_enabled: settings.messaging_enabled,
					interinstance_enabled: settings.interinstance_enabled,
					interinstance_outbound_ready:
						settings.interinstance_enabled &&
						Boolean(endpoint) &&
						Boolean(settings.interinstance_api_key),
				},
			},
		],
		'Metadata pública de tickets cargada correctamente.',
	);
}

export async function tickets_admin_list(ctx: TicketCtx) {
	const termino = text(ctx.url.searchParams.get('termino')).toLowerCase();
	const desde = Math.max(0, Number(ctx.url.searchParams.get('desde') ?? 0) || 0);
	const limite = Math.min(500, Math.max(1, Number(ctx.url.searchParams.get('limite') ?? 50) || 50));
	const { rows } = await ctx.store.find_many('tickets', {
		mongo_match: termino
			? {
					$or: [
						{ name: { $regex: termino, $options: 'i' } },
						{ title: { $regex: termino, $options: 'i' } },
						{ description: { $regex: termino, $options: 'i' } },
						{ status: { $regex: termino, $options: 'i' } },
						{ sourceType: { $regex: termino, $options: 'i' } },
					],
				}
			: undefined,
		take: 20000,
		include_inactive: true,
	});
	const matched = rows
		.filter((row) => {
			if (!termino) return true;
			const reporter = as_object(row.reporter);
			const hay = [
				row.title,
				row.name,
				row.description,
				row.sourceType,
				row.source_type,
				row.status,
				row.estado,
				reporter.name,
				reporter.email,
			]
				.map((value) => String(value ?? '').toLowerCase())
				.join(' ');
			return hay.includes(termino);
		})
		.sort((a, b) => created_ms(b) - created_ms(a));
	const page = matched.slice(desde, desde + limite);
	return {
		...ok(page, 'Tickets cargados correctamente.', matched.length),
		tipo_de_instancia: ADMIN_INSTANCE_TYPE,
		schema_validation: ticket_schema_validation(),
	};
}

export async function tickets_admin_one(ctx: TicketCtx) {
	const ticket_id = text(ctx.params.id);
	if (!ticket_id) throw new Error('Debes indicar el ticket que deseas consultar.');
	const ticket = await ctx.store.find_id('tickets', ticket_id);
	if (!ticket) throw new Error('No se encontró el ticket solicitado.');
	return {
		...ok([ticket], 'Ticket cargado correctamente.'),
		schema_validation: ticket_schema_validation(),
	};
}

export async function tickets_field_values(ctx: TicketCtx) {
	const field_name = text(ctx.params.field_name);
	if (field_name !== 'status') {
		throw new Error('El campo solicitado no soporta catálogos dinámicos.');
	}
	const values = TICKET_STATUS_VALUES.map((option) => ({
		value: option.value,
		label: option.display_leyend,
		icon: option.icon,
		count: 0,
	}));
	return ok(values, 'Valores de campo cargados correctamente.');
}

export async function create_public_ticket(ctx: TicketCtx) {
	const settings = await messaging_settings(ctx.store);
	if (!settings.public_enabled) {
		http_error('El soporte público de tickets está deshabilitado.', 403);
	}
	assert_public_rate(client_ip(ctx.req), settings.rate_limit_window_minutes, settings.rate_limit_max);
	const title = text(ctx.body.title);
	const description = text(ctx.body.description);
	if (!title || !description) {
		throw new Error('Debes proporcionar título y descripción para crear el ticket público.');
	}
	const instance_data_in = optional_object(ctx.body.instance_data) ?? {};
	const ticket = await persist_ticket(
		ctx.store,
		{
			title,
			description,
			source_type: 'public',
			reporter: { ip: client_ip(ctx.req) },
			payload: optional_object(ctx.body.payload),
			instance_data: {
				label: optional_text(instance_data_in.label) || settings.instance_label,
				url: optional_text(instance_data_in.url),
				version: optional_text(instance_data_in.version) || settings.instance_version,
				generatedAt: now(),
				log: optional_text(instance_data_in.log),
				metadata: optional_object(instance_data_in.metadata),
			},
			should_forward_interinstance: true,
		},
		ctx.actor,
	);
	return created(ticket, 'Ticket público creado correctamente.');
}

export async function create_internal_ticket(ctx: TicketCtx) {
	const title = text(ctx.body.title);
	const description = text(ctx.body.description);
	if (!title || !description) {
		throw new Error('Debes proporcionar título y descripción para crear el ticket.');
	}
	const assigned_personal_task_ids = await ensure_ids_exist(
		ctx.store,
		'planeacion-proyectos-task',
		id_list(ctx.body.assigned_personal_task_ids),
		'No se encontró alguna de las tareas asignadas.',
	);
	const assigned_project_ids = await ensure_ids_exist(
		ctx.store,
		'planeacion-proyectos',
		id_list(ctx.body.assigned_project_ids),
		'No se encontró alguno de los proyectos asignados.',
	);
	const has_planning = Boolean(assigned_personal_task_ids.length || assigned_project_ids.length);
	const ticket = await persist_ticket(
		ctx.store,
		{
			title,
			description,
			source_type: 'internal',
			reporter: current_reporter(ctx),
			assigned_user_id: has_planning
				? undefined
				: await ensure_user_exists(ctx.store, optional_text(ctx.body.assigned_user_id)),
			assigned_personal_task_ids,
			assigned_project_ids,
			payload: optional_object(ctx.body.payload),
			should_forward_interinstance: false,
		},
		ctx.actor,
	);
	await notify_internal_ticket_created(ctx.store, ticket, ctx.actor);
	return created(ticket, 'Ticket creado correctamente.');
}

export async function create_error_ticket(ctx: TicketCtx) {
	const should_forward = bool_flag(ctx.body.should_forward_interinstance);
	if (should_forward) await assert_interinstance_outbound(ctx.store, 'tickets');
	const title = optional_text(ctx.body.title) || 'Error reportado desde interfaz';
	const description =
		text(ctx.body.description) || 'Se generó un ticket automático a partir de un error de ejecución.';
	const instance_data_in = optional_object(ctx.body.instance_data) ?? {};
	const ticket = await persist_ticket(
		ctx.store,
		{
			title,
			description,
			source_type: 'error',
			reporter: current_reporter(ctx),
			payload: {
				source_channel: optional_text(ctx.body.source_channel),
				context: optional_object(ctx.body.context),
			},
			instance_data: {
				label: optional_text(instance_data_in.label),
				url: optional_text(instance_data_in.url),
				version: optional_text(instance_data_in.version),
				generatedAt: now(),
				log: optional_text(instance_data_in.log),
				metadata: optional_object(instance_data_in.metadata),
			},
			should_forward_interinstance: should_forward,
		},
		ctx.actor,
	);
	return created(
		ticket,
		should_forward
			? 'Ticket de error interinstancia enviado correctamente.'
			: 'Ticket de error generado correctamente.',
	);
}

export async function create_log_ticket(ctx: TicketCtx) {
	const log_payload = optional_object(ctx.body.log);
	const should_forward = bool_flag(ctx.body.should_forward_interinstance);
	if (should_forward) await assert_interinstance_outbound(ctx.store, 'tickets');
	const title =
		optional_text(ctx.body.title) ||
		optional_text(log_payload?.label) ||
		'Error detectado en consola';
	const description =
		text(ctx.body.description) ||
		optional_text(log_payload?.message) ||
		'Se generó un ticket desde el detalle de un log del sistema.';
	const ticket = await persist_ticket(
		ctx.store,
		{
			title,
			description,
			source_type: 'log',
			reporter: current_reporter(ctx),
			payload: {
				log: log_payload,
				source_channel: 'debug-log-console',
			},
			instance_data: {
				generatedAt: now(),
				log:
					serialize_log(log_payload) ||
					optional_text(log_payload?.formatted_message) ||
					optional_text(log_payload?.message),
				metadata: log_payload
					? {
							full_log: log_payload,
							metadata: optional_object(log_payload.metadata),
						}
					: undefined,
			},
			should_forward_interinstance: should_forward,
		},
		ctx.actor,
	);
	return created(
		ticket,
		should_forward
			? 'Ticket de log interinstancia enviado correctamente.'
			: 'Ticket de log generado correctamente.',
	);
}

export async function create_interinstance_ticket(ctx: TicketCtx) {
	const settings = await messaging_settings(ctx.store);
	if (!settings.interinstance_enabled) {
		return deny_interinstance('La recepción interinstancia no está habilitada.', 403);
	}
	await assert_interinstance_outbound(ctx.store, 'tickets');
	const title = text(ctx.body.title);
	const description = text(ctx.body.description);
	if (!title || !description) {
		throw new Error('Debes proporcionar título y descripción para crear el ticket interinstancia.');
	}
	const assigned_personal_task_ids = await ensure_ids_exist(
		ctx.store,
		'planeacion-proyectos-task',
		id_list(ctx.body.assigned_personal_task_ids),
		'No se encontró alguna de las tareas asignadas.',
	);
	const assigned_project_ids = await ensure_ids_exist(
		ctx.store,
		'planeacion-proyectos',
		id_list(ctx.body.assigned_project_ids),
		'No se encontró alguno de los proyectos asignados.',
	);
	const has_planning = Boolean(assigned_personal_task_ids.length || assigned_project_ids.length);
	const ticket = await persist_ticket(
		ctx.store,
		{
			title,
			description,
			source_type: 'internal',
			reporter: current_reporter(ctx),
			assigned_user_id: has_planning
				? undefined
				: await ensure_user_exists(ctx.store, optional_text(ctx.body.assigned_user_id)),
			assigned_personal_task_ids,
			assigned_project_ids,
			payload: optional_object(ctx.body.payload),
			instance_data: {
				label: settings.instance_label,
				version: settings.instance_version,
				generatedAt: now(),
			},
			should_forward_interinstance: true,
		},
		ctx.actor,
	);
	return created(ticket, 'Ticket interinstancia enviado correctamente.');
}

export async function receive_interinstance_ticket(ctx: TicketCtx) {
	const settings = await messaging_settings(ctx.store);
	if (!settings.interinstance_enabled) {
		return deny_interinstance('La recepción interinstancia no está habilitada.', 403);
	}
	let matched: ImperiumDoc;
	try {
		matched = await validate_interinstance_api_key(ctx.store, interinstance_key_from_req(ctx.req));
	} catch (error) {
		return deny_interinstance(
			error instanceof Error ? error.message : 'Clave interinstancia inválida.',
			401,
		);
	}
	const title = text(ctx.body.title);
	const description = text(ctx.body.description);
	if (!title || !description) {
		throw new Error('La recepción interinstancia requiere título y descripción.');
	}
	const ticket = await persist_ticket(
		ctx.store,
		{
			title,
			description,
			source_type: 'interinstance',
			reporter: optional_object(ctx.body.reporter),
			assigned_personal_task_ids: id_list(ctx.body.assigned_personal_task_ids),
			assigned_project_ids: id_list(ctx.body.assigned_project_ids),
			payload: optional_object(ctx.body.payload),
			instance_data: optional_object(ctx.body.instance_data),
			should_forward_interinstance: false,
			interinstance: {
				forwarded: false,
				receivedFromKeyId: String(matched._id),
				receivedFromDomain: matched.domain,
				receivedFromClient: matched.client,
			},
		},
		ctx.actor,
	);
	return created(ticket, 'Ticket interinstancia recibido correctamente.');
}

export async function read_received_interinstance_tickets(ctx: TicketCtx) {
	const settings = await messaging_settings(ctx.store);
	if (!settings.interinstance_enabled) {
		return deny_interinstance('La recepción interinstancia no está habilitada.', 403);
	}
	let matched: ImperiumDoc;
	try {
		matched = await validate_interinstance_api_key(ctx.store, interinstance_key_from_req(ctx.req));
	} catch (error) {
		return deny_interinstance(
			error instanceof Error ? error.message : 'Clave interinstancia inválida.',
			401,
		);
	}
	const termino = text(ctx.url.searchParams.get('termino')).toLowerCase();
	const ticket_id = text(ctx.url.searchParams.get('ticket_id'));
	const desde = Math.max(0, Number(ctx.url.searchParams.get('desde') ?? 0) || 0);
	const limite = Math.min(500, Math.max(1, Number(ctx.url.searchParams.get('limite') ?? 50) || 50));
	const { rows } = await ctx.store.find_many('tickets', {
		mongo_match: { sourceType: 'interinstance' },
		take: 20000,
		include_inactive: true,
	});
	const filtered = rows
		.filter((row) => {
			if (String(row.sourceType ?? row.source_type ?? '') !== 'interinstance') return false;
			const meta = as_object(row.interinstance);
			if (String(meta.receivedFromKeyId ?? '') !== String(matched._id)) return false;
			if (ticket_id && String(row._id) !== ticket_id) return false;
			if (!termino) return true;
			const reporter = as_object(row.reporter);
			return [row.title, row.description, reporter.name, reporter.email]
				.map((value) => String(value ?? '').toLowerCase())
				.join(' ')
				.includes(termino);
		})
		.sort((a, b) => created_ms(b) - created_ms(a));
	const page = filtered.slice(desde, desde + limite);
	return ok(page, 'Tickets interinstancia recibidos cargados correctamente.', filtered.length);
}

export async function update_ticket(ctx: TicketCtx) {
	const ticket_id = text(ctx.params.id);
	if (!ticket_id) throw new Error('Debes indicar el ticket que deseas actualizar.');
	const existing = await ctx.store.find_id('tickets', ticket_id);
	if (!existing) throw new Error('No se encontró el ticket solicitado.');
	const bypass = await can_bypass_assignment(ctx.store, ctx.actor);
	ensure_ticket_update_allowed(existing, ctx.actor, bypass);

	const title = optional_text(ctx.body.title);
	const description = optional_text(ctx.body.description);
	const status = optional_text(ctx.body.status);
	const has_assigned_user_update = has_body_field(ctx.body, 'assigned_user_id');
	const has_personal_task_update = has_body_field(ctx.body, 'assigned_personal_task_ids');
	const has_project_update = has_body_field(ctx.body, 'assigned_project_ids');
	const assigned_user_id = await ensure_user_exists(
		ctx.store,
		optional_text(ctx.body.assigned_user_id),
	);
	const assigned_personal_task_ids = await ensure_ids_exist(
		ctx.store,
		'planeacion-proyectos-task',
		id_list(ctx.body.assigned_personal_task_ids),
		'No se encontró alguna de las tareas asignadas.',
	);
	const assigned_project_ids = await ensure_ids_exist(
		ctx.store,
		'planeacion-proyectos',
		id_list(ctx.body.assigned_project_ids),
		'No se encontró alguno de los proyectos asignados.',
	);

	const patch: ImperiumDoc = {};
	if (title) {
		patch.title = title;
		patch.name = title;
	}
	if (description) patch.description = description;
	if (status) {
		patch.status = status;
		patch.estado = status;
	}
	if (has_personal_task_update) patch.assignedPersonalTaskIds = assigned_personal_task_ids;
	if (has_project_update) patch.assignedProjectIds = assigned_project_ids;
	if (has_assigned_user_update) {
		patch.assignedUserId = assigned_user_id;
		patch.assigned_user_id = assigned_user_id;
	}
	if (optional_object(ctx.body.payload)) patch.payload = optional_object(ctx.body.payload);

	const resulting_personal = has_personal_task_update
		? assigned_personal_task_ids
		: id_list(existing.assignedPersonalTaskIds);
	const resulting_projects = has_project_update
		? assigned_project_ids
		: id_list(existing.assignedProjectIds);
	const resulting_planning = Boolean(resulting_personal.length || resulting_projects.length);
	if (resulting_planning && has_body_field(ctx.body, 'status')) {
		throw new Error(
			'El estatus de los tickets asignados a proyectos o tareas debe gestionarse desde esa relación.',
		);
	}
	if (resulting_planning) {
		patch.assignedUserId = undefined;
		patch.assigned_user_id = undefined;
	}
	patch.isLockedByAssignment = resulting_planning;

	const updated = await ctx.store.update('tickets', ticket_id, patch);
	if (!updated) throw new Error('No se pudo actualizar el ticket solicitado.');
	return ok([updated], 'Ticket actualizado.');
}

export async function read_my_tickets(ctx: TicketCtx) {
	const uid = actor_id(ctx.actor);
	if (!uid) throw new Error('No hay una sesión válida para consultar tickets.');
	const { rows } = await ctx.store.find_many('tickets', {
		take: 2000,
		include_inactive: true,
	});
	const mine = rows
		.filter((row) => {
			const reporter = as_object(row.reporter);
			const reporter_id = text(reporter.userId ?? reporter.user_id);
			const assigned = text(row.assignedUserId ?? row.assigned_user_id);
			const tasks = id_list(row.assignedPersonalTaskIds ?? row.assigned_personal_task_ids);
			return reporter_id === uid || assigned === uid || tasks.includes(uid);
		})
		.sort((a, b) => created_ms(b) - created_ms(a))
		.slice(0, 200);
	return ok(mine, 'Tickets del usuario cargados correctamente.');
}
