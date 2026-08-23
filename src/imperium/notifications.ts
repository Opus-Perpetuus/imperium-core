/**
 * Notificaciones, digest de toasts, invitaciones de proyecto y menciones.
 * Mismo contrato que `notifications.service.ts` + `mentions.service.ts`.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const PLANNING_REMINDER_WINDOW_MS = 48 * 60 * 60 * 1000;
const MENTION_TOKEN = /\[@[^\n\]]*\]\(mention:([a-f\d]{24})\)/gi;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const COLLAB = {
	pendiente: 'pendiente',
	aceptada: 'aceptada',
	rechazada: 'rechazada',
} as const;
const CLOSED_STATES = new Set(['completado', 'cancelado']);

export type NotificationCtx = {
	store: ImperiumStore;
	sql: Bun.SQL;
	url: URL;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
};

function actor_id(ctx: NotificationCtx) {
	return String(ctx.actor?._id ?? ctx.actor?.id ?? '').trim();
}

function actor_name(ctx: NotificationCtx) {
	return String(ctx.actor?.name ?? ctx.actor?.email ?? '');
}

function query_text(value: unknown) {
	const text = String(value ?? '').trim();
	return text || undefined;
}

function sanitize_count(value: unknown) {
	return Math.max(0, Number.parseInt(String(value ?? 0), 10) || 0);
}

function notification_payload(doc: ImperiumDoc) {
	return { ...as_object(doc), ...as_object(doc.payload) };
}

function recipient_of(doc: ImperiumDoc) {
	return String(doc.recipientId ?? doc.user ?? doc.to ?? '').trim();
}

function is_read(doc: ImperiumDoc) {
	return doc.isRead === true || doc.read === true || doc.leido === true;
}

function payload_string(doc: ImperiumDoc, key: string) {
	const bag = notification_payload(doc);
	return query_text(bag[key]);
}

function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
}

function route_slug(value?: string) {
	return (
		(value ?? 'registro')
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '') || 'registro'
	);
}

function mention_ids_in(text: string) {
	const ids = new Set<string>();
	const regex = new RegExp(MENTION_TOKEN.source, 'gi');
	let match: RegExpExecArray | null;
	while ((match = regex.exec(String(text ?? ''))) !== null) {
		if (match[1]) ids.add(match[1].toLowerCase());
	}
	return [...ids];
}

function clean_excerpt(text: string) {
	const cleaned = String(text ?? '')
		.replace(new RegExp(MENTION_TOKEN.source, 'gi'), (token) =>
			token.replace(/\]\(mention:[a-f\d]{24}\)/i, '').replace(/^\[/, ''),
		)
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

function sanitize_toast_entries(entries: unknown) {
	if (!Array.isArray(entries)) return [] as Array<Record<string, unknown>>;
	return entries
		.map((entry) => {
			const rec = as_object(entry);
			const actions = as_array(rec.actions)
				.map((action) => {
					const item = as_object(action);
					const id = query_text(item.id);
					const kind = query_text(item.kind);
					const label = query_text(item.label);
					if (!id || !kind || !label) return null;
					const click = as_object(item.click_target);
					const log = as_object(item.request_log);
					return {
						id,
						kind,
						label,
						icon: query_text(item.icon),
						style: query_text(item.style),
						click_target:
							item.click_target && typeof item.click_target === 'object'
								? { route: query_text(click.route), url: query_text(click.url) }
								: undefined,
						request_log:
							item.request_log && typeof item.request_log === 'object'
								? {
										route: query_text(log.route),
										method: query_text(log.method),
										status: Number.isFinite(Number(log.status)) ? Number(log.status) : undefined,
										created_after: query_text(log.created_after),
										created_before: query_text(log.created_before),
									}
								: undefined,
						ticket_payload:
							item.ticket_payload && typeof item.ticket_payload === 'object'
								? as_object(item.ticket_payload)
								: undefined,
					};
				})
				.filter(Boolean);
			const title = query_text(rec.title);
			const message = query_text(rec.message);
			const html = query_text(rec.html);
			if (!title && !message && !html) return null;
			return {
				id: query_text(rec.id),
				tone: query_text(rec.tone) || 'info',
				title: title || message || 'Toast consolidado',
				message,
				html,
				delivery_kind: query_text(rec.delivery_kind),
				created_at: query_text(rec.created_at),
				actions: actions.length ? actions : undefined,
			};
		})
		.filter(Boolean)
		.slice(0, 24) as Array<Record<string, unknown>>;
}

async function list_mine(store: ImperiumStore, uid: string, take = 20000) {
	const { rows } = await store.find_many('notifications', {
		mongo_match: {
			$or: [{ recipientId: uid }, { user: uid }, { to: uid }],
		},
		take,
		include_inactive: true,
	});
	return rows.filter((row) => recipient_of(row) === uid && row.is_active !== false);
}

async function hard_remove(ctx: NotificationCtx, resource: string, id: string) {
	await ctx.sql.unsafe(`DELETE FROM ${ctx.store.qt(resource)} WHERE id = $1`, [id]);
}

async function insert_notification(store: ImperiumStore, doc: ImperiumDoc) {
	return store.insert('notifications', {
		...doc,
		name: String(doc.title ?? doc.name ?? 'Notificación'),
		isRead: doc.isRead === true,
		is_active: true,
	});
}

/**
 * Replica `MessagesService.notify_recipients`: cada destinatario
 * distinto del remitente recibe una notificación `type: message`.
 */
export async function notify_message_recipients(store: ImperiumStore, message: ImperiumDoc) {
	const sender = String(message.senderUserId ?? message.sender_user_id ?? '').trim();
	const recipients = as_array(message.recipientUserIds ?? message.recipient_user_ids)
		.map((item) => ref_id(item) || String(item ?? '').trim())
		.filter((id) => id && id !== sender);
	const title = String(
		message.title || `Nuevo mensaje de ${message.senderName || 'sistema'}`,
	);
	for (const recipient_id of recipients) {
		await insert_notification(store, {
			recipientId: recipient_id,
			type: 'message',
			title,
			message: String(message.message ?? ''),
			isRead: false,
			source: {
				kind: 'message',
				action: message.direction,
				modelName: 'Message',
				collectionName: '__messages',
				documentId: message._id,
				route: '/internal/notifications',
				entityLabel: message.title,
			},
			payload: {
				message_id: message._id,
				direction: message.direction,
				source_type: message.sourceType ?? message.source_type,
				related_ticket_id: message.relatedTicketId ?? message.related_ticket_id,
			},
			actor: {
				_id: sender,
				name: message.senderName,
				email: message.senderEmail,
			},
		});
	}
}

export async function notification_toast_digest(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('No se encontró una sesión válida.');
	const body = ctx.body;
	const digest_counts = {
		total: sanitize_count(body.total),
		error: sanitize_count(body.error),
		warning: sanitize_count(body.warning),
		info: sanitize_count(body.info),
		success: sanitize_count(body.success),
	};
	if (
		digest_counts.total <= 0 &&
		digest_counts.error <= 0 &&
		digest_counts.warning <= 0 &&
		digest_counts.info <= 0 &&
		digest_counts.success <= 0
	) {
		return ok([], 'No se recibieron toasts para consolidar.');
	}
	const normalized_total =
		digest_counts.total ||
		digest_counts.error + digest_counts.warning + digest_counts.info + digest_counts.success;
	const sanitized_samples = [
		...new Set(
			as_array(body.samples)
				.map((sample) => String(sample ?? '').trim())
				.filter(Boolean),
		),
	].slice(0, 8);
	const sanitized_entries = sanitize_toast_entries(body.entries);
	const summary_text =
		query_text(body.summary) ||
		`Hay ${normalized_total} eventos de toast pendientes por revisar en notificaciones.`;
	const mine = await list_mine(ctx.store, uid);
	const existing = mine
		.filter((row) => String(row.type) === 'toast_digest' && !is_read(row))
		.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
	const existing_pending = as_object(existing?.pendingToast);
	const existing_payload = notification_payload(existing ?? {});
	const existing_entries = sanitize_toast_entries(existing_payload.toast_digest_entries);
	const now_iso = new Date().toISOString();
	const merged_pending = {
		total: sanitize_count(existing_pending.total) + normalized_total,
		error: sanitize_count(existing_pending.error) + digest_counts.error,
		warning: sanitize_count(existing_pending.warning) + digest_counts.warning,
		info: sanitize_count(existing_pending.info) + digest_counts.info,
		success: sanitize_count(existing_pending.success) + digest_counts.success,
		summary: summary_text,
		samples: [...new Set([...as_array(existing_pending.samples).map(String), ...sanitized_samples])].slice(
			0,
			8,
		),
		lastAggregatedAt: now_iso,
	};
	const merged_entries = [...sanitized_entries, ...existing_entries].slice(0, 24);
	const next_payload = {
		...existing_payload,
		kind: 'toast_digest',
		updated_at: now_iso,
		toast_digest_entries: merged_entries,
	};
	if (existing?._id) {
		const updated = await ctx.store.update('notifications', String(existing._id), {
			title: 'Toasts pendientes por revisar',
			name: 'Toasts pendientes por revisar',
			message: summary_text,
			pendingToast: merged_pending,
			payload: next_payload,
			type: 'toast_digest',
			recipientId: uid,
			isRead: false,
		});
		return ok(updated ? [updated] : [], 'Digest de toasts actualizado');
	}
	const created = await insert_notification(ctx.store, {
		recipientId: uid,
		type: 'toast_digest',
		title: 'Toasts pendientes por revisar',
		message: summary_text,
		description: 'Algunos toasts se consolidaron para evitar saturación visual.',
		isRead: false,
		pendingToast: merged_pending,
		payload: {
			kind: 'toast_digest',
			created_at: now_iso,
			updated_at: now_iso,
			toast_digest_entries: merged_entries,
		},
		source: {
			kind: 'toast',
			action: 'digest',
			route: '/internal/notifications',
		},
	});
	return ok([created], 'Digest de toasts creado');
}

export async function notification_update_read(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const notification_id = String(ctx.params.id ?? '').trim();
	if (!notification_id || !OBJECT_ID.test(notification_id)) {
		throw new Error('La notificacion solicitada no es valida.');
	}
	const is_read_flag = typeof ctx.body.is_read === 'boolean' ? ctx.body.is_read : true;
	const doc = await ctx.store.find_id('notifications', notification_id);
	if (!doc || recipient_of(doc) !== uid) {
		return ok([], 'Notificacion no encontrada');
	}
	const updated = await ctx.store.update('notifications', notification_id, {
		isRead: is_read_flag,
		read: is_read_flag,
		leido: is_read_flag,
		readAt: is_read_flag ? new Date().toISOString() : undefined,
	});
	return ok(
		updated ? [updated] : [],
		is_read_flag ? 'Notificacion marcada como leida' : 'Notificacion marcada como no leida',
	);
}

export async function mark_all_notifications(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const mine = await list_mine(ctx.store, uid);
	let modified = 0;
	for (const row of mine) {
		if (is_read(row)) continue;
		await ctx.store.update('notifications', String(row._id), {
			isRead: true,
			read: true,
			leido: true,
			readAt: new Date().toISOString(),
		});
		modified += 1;
	}
	return ok(
		[],
		modified
			? 'Notificaciones marcadas como leidas'
			: 'No habia notificaciones pendientes por actualizar',
		modified,
	);
}

export async function notification_apply_action(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const notification_id = String(ctx.params.id ?? '').trim();
	const action = query_text(ctx.body.action)?.toLowerCase();
	if (!notification_id || !OBJECT_ID.test(notification_id)) {
		throw new Error('La notificacion solicitada no es valida.');
	}
	if (action !== 'accept' && action !== 'reject') {
		throw new Error('La accion solicitada no es valida.');
	}
	const notification = await ctx.store.find_id('notifications', notification_id);
	if (!notification || recipient_of(notification) !== uid) {
		return ok([], 'Notificacion no encontrada');
	}
	if (String(notification.type) !== 'project_assignment') {
		throw new Error('La notificacion seleccionada no admite acciones interactivas.');
	}
	const current_status = payload_string(notification, 'response_status');
	if (current_status === COLLAB.aceptada || current_status === COLLAB.rechazada) {
		return ok([notification], 'Esta invitacion ya fue atendida previamente.');
	}
	const source = as_object(notification.source);
	const project_id =
		query_text(source.documentId) ?? payload_string(notification, 'project_id') ?? '';
	if (!project_id || !OBJECT_ID.test(project_id)) {
		throw new Error('La invitacion no tiene un proyecto valido asociado.');
	}
	const project =
		(await ctx.store.find_id('planeacion-proyectos', project_id)) ??
		(await ctx.store.find_id('proyectos', project_id));
	if (!project) throw new Error('El proyecto asociado a la notificacion ya no existe.');
	const response_status = action === 'accept' ? COLLAB.aceptada : COLLAB.rechazada;
	const responded_at = new Date().toISOString();
	const existing_requests = as_array(project.collaboration_requests).map((item) => as_object(item));
	let request_found = false;
	const next_requests = existing_requests.map((request) => {
		if (ref_id(request.user_id) !== uid) return request;
		request_found = true;
		return {
			...request,
			user_id: uid,
			status: response_status,
			responded_at,
			responded_by_user: uid,
		};
	});
	if (!request_found) {
		next_requests.push({
			user_id: uid,
			status: response_status,
			invited_at: notification.createdAt ?? responded_at,
			responded_at,
			responded_by_user: uid,
		});
	}
	const collaborators = as_array(project.collaborator_users)
		.map((entry) => ref_id(entry))
		.filter(Boolean);
	const next_collaborators =
		action === 'accept'
			? [...new Set([...collaborators, uid])]
			: collaborators.filter((id) => id !== uid);
	await ctx.store.update('planeacion-proyectos', String(project._id), {
		collaboration_requests: next_requests,
		collaborator_users: next_collaborators,
	});
	const next_payload = {
		...notification_payload(notification),
		response_status,
		response_at: responded_at,
		project_id: String(project._id),
	};
	const updated = await ctx.store.update('notifications', notification_id, {
		payload: next_payload,
		isRead: true,
		read: true,
		leido: true,
		readAt: responded_at,
	});
	const owner_id = ref_id(project.owner_user) || ref_id(as_object(notification.actor)._id);
	if (owner_id && owner_id !== uid) {
		await insert_notification(ctx.store, {
			recipientId: owner_id,
			type: 'project_assignment_response',
			title:
				action === 'accept'
					? `${actor_name(ctx) || 'Un colaborador'} acepto el proyecto "${project.name ?? 'Proyecto'}"`
					: `${actor_name(ctx) || 'Un colaborador'} rechazo el proyecto "${project.name ?? 'Proyecto'}"`,
			message:
				action === 'accept'
					? 'La invitacion fue aceptada y el colaborador ya puede operar dentro del proyecto.'
					: 'La invitacion fue rechazada. Conviene reasignar o renegociar el alcance.',
			actor: {
				_id: uid,
				name: ctx.actor?.name,
				email: ctx.actor?.email,
			},
			source: {
				kind: 'project',
				action: response_status,
				modelName: 'Proyectos',
				collectionName: 'proyectos',
				documentId: String(project._id),
				route: `/internal/planeacion/proyectos/detail/${route_slug(String(project.name ?? ''))}/${project._id}`,
				entityLabel: project.name ?? 'Proyecto',
			},
			payload: {
				project_id: String(project._id),
				response_status,
			},
			isRead: false,
		});
	}
	return ok(
		updated ? [updated] : [],
		action === 'accept' ? 'Invitacion aceptada correctamente' : 'Invitacion rechazada correctamente',
	);
}

function normalize_date(value: unknown) {
	if (!value) return undefined;
	const parsed = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function reminder_input(params: {
	recipient_id: string;
	type: string;
	title: string;
	message: string;
	date_value?: unknown;
	document_id?: unknown;
	route?: string;
	entity_label?: unknown;
	kind: 'project' | 'personal-task';
	reminder_key_prefix: string;
	allow_overdue?: boolean;
}) {
	const date_value = normalize_date(params.date_value);
	if (!date_value) return undefined;
	const delta_ms = date_value.getTime() - Date.now();
	const is_within_window = delta_ms >= 0 && delta_ms <= PLANNING_REMINDER_WINDOW_MS;
	const is_overdue = Boolean(params.allow_overdue) && delta_ms < 0;
	if (!is_within_window && !is_overdue) return undefined;
	const reminder_state = is_overdue ? 'overdue' : 'soon';
	const reminder_key = `${params.reminder_key_prefix}:${reminder_state}:${date_value.toISOString().slice(0, 10)}`;
	return {
		recipientId: params.recipient_id,
		type: is_overdue ? `${params.type}_overdue` : `${params.type}_soon`,
		title: params.title,
		message: params.message,
		source: {
			kind: params.kind,
			action: reminder_state,
			documentId: ref_id(params.document_id) || undefined,
			route: params.route,
			entityLabel: params.entity_label,
		},
		payload: {
			reminder_key,
			reminder_state,
			reminder_at: date_value.toISOString(),
		},
		isRead: false,
	} as ImperiumDoc;
}

function has_project_access(project: ImperiumDoc, uid: string) {
	if (ref_id(project.owner_user) === uid) return true;
	const requests = as_array(project.collaboration_requests).map((item) => as_object(item));
	const request = requests.find((item) => ref_id(item.user_id) === uid);
	if (!request) {
		return as_array(project.collaborator_users).some((entry) => ref_id(entry) === uid);
	}
	return String(request.status) === COLLAB.aceptada;
}

async function reminder_exists(store: ImperiumStore, input: ImperiumDoc) {
	const reminder_key = payload_string(input, 'reminder_key');
	const document_id = ref_id(as_object(input.source).documentId);
	const mine = await list_mine(store, String(input.recipientId), 2000);
	return mine.some((row) => {
		if (String(row.type) !== String(input.type)) return false;
		if (document_id && ref_id(as_object(row.source).documentId) !== document_id) return false;
		if (reminder_key && payload_string(row, 'reminder_key') !== reminder_key) return false;
		return true;
	});
}

async function sync_planning_reminders(store: ImperiumStore, uid: string) {
	if (!store.has('planeacion-proyectos') && !store.has('planeacion-mis-tareas')) return;
	const inputs: ImperiumDoc[] = [];
	if (store.has('planeacion-proyectos')) {
		const { rows } = await store.find_many('planeacion-proyectos', {
			mongo_match: {
				$or: [
					{ owner_user: uid },
					{ collaborator_users: { $regex: uid } },
				],
			},
			take: 20000,
			include_inactive: false,
		});
		for (const project of rows) {
			if (CLOSED_STATES.has(String(project.status ?? project.state ?? ''))) continue;
			const related =
				ref_id(project.owner_user) === uid ||
				as_array(project.collaborator_users).some((entry) => ref_id(entry) === uid);
			if (!related || !has_project_access(project, uid)) continue;
			const start = reminder_input({
				recipient_id: uid,
				type: 'project_start_reminder',
				title: `El proyecto "${project.name ?? 'Proyecto'}" inicia pronto`,
				message:
					'La fecha de arranque está dentro de las próximas 48 horas. Verifica responsables y entregables.',
				date_value: project.start_date,
				document_id: project._id,
				route: `/internal/planeacion/proyectos/detail/${route_slug(String(project.name ?? ''))}/${project._id}`,
				entity_label: project.name,
				kind: 'project',
				reminder_key_prefix: 'project-start',
			});
			const due = reminder_input({
				recipient_id: uid,
				type: 'project_due_reminder',
				title: `El proyecto "${project.name ?? 'Proyecto'}" está por concluir`,
				message:
					'La fecha objetivo está dentro de las próximas 48 horas o ya venció. Conviene revisar el avance y los bloqueos.',
				date_value: project.due_date,
				document_id: project._id,
				route: `/internal/planeacion/proyectos/detail/${route_slug(String(project.name ?? ''))}/${project._id}`,
				entity_label: project.name,
				kind: 'project',
				reminder_key_prefix: 'project-due',
				allow_overdue: true,
			});
			if (start) inputs.push(start);
			if (due) inputs.push(due);
		}
	}
	if (store.has('planeacion-mis-tareas')) {
		const { rows } = await store.find_many('planeacion-mis-tareas', {
			where: { owner_user: uid },
			take: 20000,
			include_inactive: false,
		});
		for (const task of rows) {
			if (CLOSED_STATES.has(String(task.status ?? task.state ?? ''))) continue;
			const start = reminder_input({
				recipient_id: uid,
				type: 'personal_task_start_reminder',
				title: `Tu tarea "${task.name ?? 'Tarea'}" inicia pronto`,
				message:
					'La fecha de inicio está dentro de las próximas 48 horas. Revisa dependencias y tiempo estimado.',
				date_value: task.start_date,
				document_id: task._id,
				route: `/internal/planeacion/mis-tareas/detail/${route_slug(String(task.name ?? ''))}/${task._id}`,
				entity_label: task.name,
				kind: 'personal-task',
				reminder_key_prefix: 'personal-task-start',
			});
			const due = reminder_input({
				recipient_id: uid,
				type: 'personal_task_due_reminder',
				title: `Tu tarea "${task.name ?? 'Tarea'}" está por concluir`,
				message:
					'La fecha compromiso está dentro de las próximas 48 horas o ya venció. Conviene cerrar o replanear.',
				date_value: task.due_date,
				document_id: task._id,
				route: `/internal/planeacion/mis-tareas/detail/${route_slug(String(task.name ?? ''))}/${task._id}`,
				entity_label: task.name,
				kind: 'personal-task',
				reminder_key_prefix: 'personal-task-due',
				allow_overdue: true,
			});
			if (start) inputs.push(start);
			if (due) inputs.push(due);
		}
	}
	for (const input of inputs) {
		if (await reminder_exists(store, input)) continue;
		await insert_notification(store, input);
	}
}

export async function notification_summary(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('No se encontró una sesión válida.');
	await sync_planning_reminders(ctx.store, uid);
	const size = Math.min(20, Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('size') ?? '6'), 10) || 6));
	const unread = (await list_mine(ctx.store, uid)).filter((row) => !is_read(row));
	unread.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
	return ok(
		[{ unread_count: unread.length, unread_notifications: unread.slice(0, size) }],
		unread.length
			? 'Resumen de notificaciones obtenido correctamente'
			: 'No hay notificaciones pendientes',
	);
}

export async function my_notifications(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const page = Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('page') ?? '1'), 10) || 1);
	const size = Math.min(100, Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('size') ?? '25'), 10) || 25));
	const status = query_text(ctx.url.searchParams.get('status'))?.toLowerCase();
	let rows = await list_mine(ctx.store, uid);
	if (status === 'unread') rows = rows.filter((row) => !is_read(row));
	if (status === 'read') rows = rows.filter((row) => is_read(row));
	rows.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
	const slice = rows.slice((page - 1) * size, page * size);
	return ok(
		slice,
		slice.length
			? 'Notificaciones obtenidas correctamente'
			: 'No se encontraron notificaciones para este usuario',
		rows.length,
	);
}

export async function my_mentions(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('No se encontró una sesión válida para consultar menciones.');
	if (!ctx.store.has('mentions')) {
		return ok([], 'No se encontraron menciones para este usuario');
	}
	const page = Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('page') ?? '1'), 10) || 1);
	const size = Math.min(100, Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('size') ?? '25'), 10) || 25));
	const { rows } = await ctx.store.find_many('mentions', {
		mongo_match: { mentionedUserId: uid },
		take: 20000,
		include_inactive: true,
	});
	const mine = rows
		.filter((row) => String(row.mentionedUserId ?? '') === uid && row.is_active !== false)
		.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
	const slice = mine.slice((page - 1) * size, page * size);
	return ok(
		slice,
		slice.length
			? 'Menciones obtenidas correctamente'
			: 'No se encontraron menciones para este usuario',
		mine.length,
	);
}

export async function clear_notifications(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const scope = query_text(ctx.url.searchParams.get('scope'))?.toLowerCase();
	const mine = await list_mine(ctx.store, uid);
	let deleted = 0;
	for (const row of mine) {
		if (scope === 'read' && !is_read(row)) continue;
		await hard_remove(ctx, 'notifications', String(row._id));
		deleted += 1;
	}
	return ok(
		[],
		scope === 'read'
			? 'Notificaciones leidas eliminadas correctamente'
			: 'Notificaciones eliminadas correctamente',
		deleted,
	);
}

export async function delete_notification(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const notification_id = String(ctx.params.id ?? '').trim();
	if (!notification_id || !OBJECT_ID.test(notification_id)) {
		throw new Error('La notificacion solicitada no es valida.');
	}
	const doc = await ctx.store.find_id('notifications', notification_id);
	if (!doc || recipient_of(doc) !== uid) {
		return ok([], 'Notificacion no encontrada');
	}
	await hard_remove(ctx, 'notifications', notification_id);
	return ok([doc], 'Notificacion eliminada correctamente');
}

async function resolve_users(store: ImperiumStore, ids: string[]) {
	const out: Array<{ _id: string; name?: unknown; email?: unknown }> = [];
	for (const id of ids) {
		const user = await store.find_id('user', id);
		if (!user || user.is_active === false) continue;
		out.push({ _id: String(user._id), name: user.name, email: user.email });
	}
	return out;
}

function actor_label(actor: ImperiumDoc | null) {
	return String(actor?.name ?? actor?.email ?? 'Alguien');
}

function collect_mention_map(document: unknown) {
	const map = new Map<string, { excerpt: string; field: string }>();
	try {
		if (!JSON.stringify(document ?? {}).includes('(mention:')) return map;
	} catch {
		return map;
	}
	const walk = (value: unknown, path: string) => {
		if (typeof value === 'string') {
			if (!value.includes('(mention:')) return;
			const regex = new RegExp(MENTION_TOKEN.source, 'gi');
			let match: RegExpExecArray | null;
			while ((match = regex.exec(value)) !== null) {
				const mentioned_id = match[1]!.toLowerCase();
				if (!map.has(mentioned_id)) {
					map.set(mentioned_id, {
						excerpt: clean_excerpt(value),
						field: path || 'documento',
					});
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) => walk(item, `${path}[${index}]`));
			return;
		}
		if (value && typeof value === 'object') {
			for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
				if (key.startsWith('_') || key === 'search_field') continue;
				walk(inner, path ? `${path}.${key}` : key);
			}
		}
	};
	walk(document, '');
	return map;
}

async function persist_mentions(
	store: ImperiumStore,
	records: ImperiumDoc[],
	notifications: ImperiumDoc[],
) {
	const created = [];
	for (const input of notifications) {
		if (!input.recipientId || !input.title || !input.message) continue;
		created.push(await insert_notification(store, input));
	}
	const by_recipient = new Map<string, string>();
	for (const notification of created) {
		const recipient = recipient_of(notification);
		if (recipient && !by_recipient.has(recipient)) {
			by_recipient.set(recipient, String(notification._id));
		}
	}
	if (!store.has('mentions')) return;
	for (const record of records) {
		await store.insert('mentions', {
			...record,
			name: 'mención',
			notificationId: by_recipient.get(String(record.mentionedUserId ?? '')),
			isRead: false,
		});
	}
}

export async function register_comment_mentions(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	params: {
		comment_text: string;
		mentioned_user_ids?: unknown;
		model_name?: string;
		collection_name?: string;
		document_id?: string;
		history_id?: string;
		route?: string;
		entity_label?: string;
	},
) {
	const uid = String(actor?._id ?? '');
	const from_body = as_array(params.mentioned_user_ids).map((id) => String(id).toLowerCase());
	const ids = [...new Set([...from_body, ...mention_ids_in(params.comment_text)])].filter(
		(id) => id && id !== uid,
	);
	const users = await resolve_users(store, ids);
	if (!users.length) return;
	const excerpt = clean_excerpt(params.comment_text);
	const records: ImperiumDoc[] = [];
	const notifications: ImperiumDoc[] = [];
	for (const user of users) {
		const source = {
			kind: 'document-change-history',
			action: 'comment-mention',
			modelName: params.model_name,
			collectionName: params.collection_name,
			documentId: params.document_id,
			historyId: params.history_id,
			route: params.route,
			entityLabel: params.entity_label,
		};
		records.push({
			mentionedUserId: user._id,
			actor: { _id: uid, name: actor?.name, email: actor?.email },
			source,
			excerpt,
			contextType: 'history-comment',
			isRead: false,
		});
		notifications.push({
			recipientId: user._id,
			type: 'history-comment-mention',
			title: `${actor_label(actor)} te mencionó en un comentario`,
			message: excerpt || 'Te mencionaron en un comentario.',
			description: 'Mención en el historial de cambios de un registro del sistema.',
			actor: { _id: uid, name: actor?.name, email: actor?.email },
			source,
			payload: {
				commentText: params.comment_text,
				historyId: params.history_id,
			},
			isRead: false,
		});
	}
	await persist_mentions(store, records, notifications);
}

export async function register_document_mentions(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	params: {
		current_document: unknown;
		previous_document?: unknown;
		resource: string;
		document_id?: string;
	},
) {
	const current_map = collect_mention_map(params.current_document);
	if (!current_map.size) return;
	const previous_ids = new Set(collect_mention_map(params.previous_document ?? {}).keys());
	const uid = String(actor?._id ?? '');
	const new_ids = [...current_map.keys()].filter((id) => !previous_ids.has(id) && id !== uid);
	const users = await resolve_users(store, new_ids);
	if (!users.length) return;
	const current = as_object(params.current_document);
	const entity_label = query_text(current.name ?? current.title ?? current.folio ?? current.nombre);
	const records: ImperiumDoc[] = [];
	const notifications: ImperiumDoc[] = [];
	for (const user of users) {
		const context = current_map.get(user._id);
		const source = {
			kind: 'mention',
			action: 'document-mention',
			modelName: params.resource,
			collectionName: params.resource,
			documentId: params.document_id,
			entityLabel: entity_label,
			field: context?.field,
		};
		records.push({
			mentionedUserId: user._id,
			actor: { _id: uid, name: actor?.name, email: actor?.email },
			source,
			excerpt: context?.excerpt,
			contextType: 'document',
			isRead: false,
		});
		notifications.push({
			recipientId: user._id,
			type: 'mention',
			title: `${actor_label(actor)} te mencionó`,
			message: context?.excerpt || 'Te mencionaron en un documento del sistema.',
			description: entity_label
				? `Mención en "${entity_label}".`
				: 'Mención en un documento del sistema.',
			actor: { _id: uid, name: actor?.name, email: actor?.email },
			source,
			payload: { mentionField: context?.field },
			isRead: false,
		});
	}
	await persist_mentions(store, records, notifications);
}

function settings_user_id(row: ImperiumDoc): string {
	const raw = row.user_id ?? row.user;
	if (raw && typeof raw === 'object' && raw !== null && '_id' in raw) {
		return String((raw as { _id: unknown })._id ?? '');
	}
	return String(raw ?? '');
}

function flag_on(value: unknown): boolean {
	return value === true || value === 'true' || value === 1;
}

function record_label_of(doc: ImperiumDoc | null): string {
	if (!doc) return '';
	for (const key of ['name', 'title', 'titulo', 'folio', 'codigo', 'code', 'email']) {
		const text = String(doc[key] ?? '').trim();
		if (text) return text;
	}
	return '';
}

/**
 * Aviso a quien se suscribió al documento, a su autor o a sus etiquetas.
 * Mismo tipo `document-subscription-match` que el original.
 */
export async function notify_document_subscription_event(
	store: ImperiumStore,
	input: {
		history_id?: string;
		actor?: ImperiumDoc | null;
		collection_name: string;
		model_name: string;
		document_id: string;
		was_new: boolean;
		current_document?: ImperiumDoc | null;
		module_label?: string;
	},
) {
	if (!store.has('user-settings') || !store.has('notifications')) return;
	if (!input.document_id) return;
	const event_kind = input.was_new ? 'create' : 'update';
	const event_flag = input.was_new ? 'notify_on_create' : 'notify_on_update';
	const actor_id_value = String(input.actor?._id ?? '');
	const { rows } = await store.find_many('user-settings', {
		take: 20000,
		include_inactive: false,
	});
	const current = as_object(input.current_document);
	const tags = as_array(current.tags ?? current.etiquetas).map((tag) =>
		tag && typeof tag === 'object' && tag !== null
			? String((tag as { _id?: unknown; name?: unknown })._id ?? (tag as { name?: unknown }).name ?? '')
			: String(tag ?? ''),
	);
	const recipients = new Map<string, string[]>();
	for (const row of rows) {
		const recipient = settings_user_id(row);
		if (!recipient) continue;
		const subs = as_object(row.subscriptions);
		const reasons: string[] = [];
		if (event_kind === 'update') {
			const hit = as_array(subs.document_subscriptions).find((item) => {
				const sub = as_object(item);
				return (
					flag_on(sub.notify_on_update) &&
					String(sub.document_id ?? '') === input.document_id &&
					String(sub.collection_name ?? '') === input.collection_name
				);
			});
			if (hit) reasons.push('documento específico');
		}
		if (actor_id_value) {
			const hit = as_array(subs.user_subscriptions).find((item) => {
				const sub = as_object(item);
				return flag_on(sub[event_flag]) && String(sub.user_id ?? '') === actor_id_value;
			});
			if (hit) {
				reasons.push(
					`usuario ${String(as_object(hit).user_name ?? input.actor?.name ?? '').trim()}`,
				);
			}
		}
		for (const item of as_array(subs.tag_subscriptions)) {
			const sub = as_object(item);
			if (!flag_on(sub[event_flag])) continue;
			const tag_id = String(sub.tag_id ?? '');
			const tag_name = String(sub.tag_name ?? sub.tag_name_normalized ?? '');
			if (tags.some((tag) => tag && (tag === tag_id || tag.toLowerCase() === tag_name.toLowerCase()))) {
				reasons.push(`etiqueta ${tag_name || tag_id}`);
			}
		}
		if (reasons.length) recipients.set(recipient, reasons);
	}
	if (!recipients.size) return;
	const label = input.module_label || input.model_name || 'registro';
	const record = record_label_of(input.current_document ?? null);
	const actor_label_text =
		String(input.actor?.name ?? input.actor?.email ?? '').trim() || 'Sistema';
	const title_prefix =
		actor_label_text === 'Sistema'
			? event_kind === 'create'
				? 'Se creó'
				: 'Se actualizó'
			: event_kind === 'create'
				? `${actor_label_text} creó`
				: `${actor_label_text} actualizó`;
	const quoted = record && record !== label ? ` "${record}"` : '';
	for (const [recipient, reasons] of recipients) {
		await insert_notification(store, {
			recipientId: recipient,
			recipient: recipient,
			type: 'document-subscription-match',
			title: `${title_prefix} ${label}${quoted}`,
			message: `Coincide con tus suscripciones por ${reasons.join(', ')}.`,
			description:
				event_kind === 'create'
					? 'Nuevo documento detectado por una suscripción global.'
					: 'Actualización detectada por una suscripción global.',
			actor: {
				_id: input.actor?._id,
				name: input.actor?.name,
				email: input.actor?.email,
			},
			source: {
				kind: 'document-subscription',
				action: event_kind,
				modelName: input.model_name,
				collectionName: input.collection_name,
				documentId: input.document_id,
				historyId: input.history_id,
				entityLabel: record || label,
			},
			payload: {
				event_kind,
				matched_document: reasons.includes('documento específico'),
				history_id: input.history_id,
			},
			isRead: false,
		});
	}
}
