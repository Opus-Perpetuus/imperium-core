/**
 * Notificaciones, digest de toasts, invitaciones de proyecto y menciones.
 * Mismo contrato que `notifications.service.ts` + `mentions.service.ts`.
 */
import { ACTIVITY_CONTEXTS, ChatError } from './chat-access.ts';
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { emit_notifications_refresh } from './socket-stub.ts';
import type { ChatUserBrief, ImperiumStore } from './store.ts';

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

function mine_match(uid: string) {
	return {
		$or: [{ recipientId: uid }, { user: uid }, { to: uid }],
	};
}

function created_stamp(doc: ImperiumDoc) {
	return String(doc.createdAt ?? doc.created_at ?? '');
}

function consider_latest(rows: ImperiumDoc[], row: ImperiumDoc, limit: number) {
	if (rows.length < limit) {
		rows.push(row);
		rows.sort((a, b) => created_stamp(b).localeCompare(created_stamp(a)));
		return;
	}
	if (created_stamp(row).localeCompare(created_stamp(rows[rows.length - 1]!)) <= 0) return;
	rows[rows.length - 1] = row;
	rows.sort((a, b) => created_stamp(b).localeCompare(created_stamp(a)));
}

async function* scan_mine(store: ImperiumStore, uid: string) {
	if (!uid || !store.has('notifications')) return;
	for await (const page of store.scan('notifications', {
		mongo_match: mine_match(uid),
		include_inactive: false,
	})) {
		const kept = page.filter((row) => recipient_of(row) === uid && row.is_active !== false);
		if (kept.length) yield kept;
	}
}

async function hard_remove(ctx: NotificationCtx, resource: string, id: string) {
	await ctx.sql.unsafe(`DELETE FROM ${ctx.store.qt(resource)} WHERE id = $1`, [id]);
}

/**
 * Destinatario → notificaciones y actividad creadas en la ventana: un solo aviso por persona.
 * Las acciones insertan en serie y esperan la base entre fila y fila; la ventana
 * junta lo de una misma acción.
 */
const pending_refresh = new Map<string, { notification_ids: string[]; activity_ids: string[] }>();
const REFRESH_WINDOW_MS = 100;

function flush_notifications_refresh(): void {
	const batch = [...pending_refresh];
	pending_refresh.clear();
	for (const [recipient_id, { notification_ids, activity_ids }] of batch) {
		emit_notifications_refresh([recipient_id], {
			reason: notification_ids.length ? 'notification_created' : 'activity_created',
			...(notification_ids.length ? { notification_ids } : {}),
			...(activity_ids.length ? { activity_ids } : {}),
		});
	}
}

function queue_refresh(recipient_id: string, created: { notification_id?: string; activity_id?: string }): void {
	if (!pending_refresh.size) setTimeout(flush_notifications_refresh, REFRESH_WINDOW_MS);
	const pending = pending_refresh.get(recipient_id) ?? { notification_ids: [], activity_ids: [] };
	if (created.notification_id) pending.notification_ids.push(created.notification_id);
	if (created.activity_id) pending.activity_ids.push(created.activity_id);
	pending_refresh.set(recipient_id, pending);
}

/** Toda notificación nueva entra por aquí: así llega por socket a su destinatario. */
export async function insert_notification(
	store: ImperiumStore,
	doc: ImperiumDoc,
	opts: { notify?: boolean } = {},
) {
	const created = await store.insert('notifications', {
		...doc,
		name: String(doc.title ?? doc.name ?? 'Notificación'),
		isRead: doc.isRead === true,
		is_active: true,
	});
	const recipient_id = recipient_of(created);
	if (recipient_id && opts.notify !== false) queue_refresh(recipient_id, { notification_id: String(created._id) });
	return created;
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
	let existing: ImperiumDoc | undefined;
	for await (const page of scan_mine(ctx.store, uid)) {
		for (const row of page) {
			if (String(row.type) !== 'toast_digest' || is_read(row)) continue;
			if (!existing || created_stamp(row).localeCompare(created_stamp(existing)) > 0) {
				existing = row;
			}
		}
	}
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
	let modified = 0;
	for await (const page of scan_mine(ctx.store, uid)) {
		for (const row of page) {
			if (is_read(row)) continue;
			await ctx.store.update('notifications', String(row._id), {
				isRead: true,
				read: true,
				leido: true,
				readAt: new Date().toISOString(),
			});
			modified += 1;
		}
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
	const uid = String(input.recipientId);
	for await (const page of scan_mine(store, uid)) {
		for (const row of page) {
			if (String(row.type) !== String(input.type)) continue;
			if (document_id && ref_id(as_object(row.source).documentId) !== document_id) continue;
			if (reminder_key && payload_string(row, 'reminder_key') !== reminder_key) continue;
			return true;
		}
	}
	return false;
}

/** Comprobar y luego insertar no es atómico: una sincronización por usuario a la vez. */
const reminder_syncs = new Map<string, Promise<void>>();

function sync_planning_reminders(store: ImperiumStore, uid: string): Promise<void> {
	const running = reminder_syncs.get(uid);
	if (running) return running;
	const sync = create_planning_reminders(store, uid).finally(() => reminder_syncs.delete(uid));
	reminder_syncs.set(uid, sync);
	return sync;
}

async function create_planning_reminders(store: ImperiumStore, uid: string) {
	if (!store.has('planeacion-proyectos') && !store.has('planeacion-mis-tareas')) return;
	const inputs: ImperiumDoc[] = [];
	if (store.has('planeacion-proyectos')) {
		for await (const page of store.scan('planeacion-proyectos', {
			mongo_match: {
				$or: [
					{ owner_user: uid },
					{ collaborator_users: { $regex: uid } },
				],
			},
			include_inactive: false,
		})) {
		for (const project of page) {
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
	}
	if (store.has('planeacion-mis-tareas')) {
		for await (const page of store.scan('planeacion-mis-tareas', {
			where: { owner_user: uid },
			include_inactive: false,
		})) {
		for (const task of page) {
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
	}
	for (const input of inputs) {
		if (await reminder_exists(store, input)) continue;
		// Quien pidió el resumen ya los recibe en la respuesta; el aviso lo haría pedirlo otra vez.
		await insert_notification(store, input, { notify: false });
	}
}

export async function notification_summary(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('No se encontró una sesión válida.');
	await sync_planning_reminders(ctx.store, uid);
	const size = Math.min(20, Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('size') ?? '6'), 10) || 6));
	let unread_count = 0;
	const unread_notifications: ImperiumDoc[] = [];
	for await (const page of scan_mine(ctx.store, uid)) {
		for (const row of page) {
			if (is_read(row)) continue;
			unread_count += 1;
			consider_latest(unread_notifications, row, size);
		}
	}
	return ok(
		[{ unread_count, unread_notifications }],
		unread_count
			? 'Resumen de notificaciones obtenido correctamente'
			: 'No hay notificaciones pendientes',
	);
}

export async function my_notifications(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const page = Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('page') ?? '1'), 10) || 1);
	const size = Math.min(100, Math.max(1, Number.parseInt(String(ctx.url.searchParams.get('size') ?? '25'), 10) || 25));
	const status = query_text(ctx.url.searchParams.get('status'))?.toLowerCase();
	const refs: Array<{ id: string; stamp: string }> = [];
	for await (const batch of scan_mine(ctx.store, uid)) {
		for (const row of batch) {
			if (status === 'unread' && is_read(row)) continue;
			if (status === 'read' && !is_read(row)) continue;
			refs.push({ id: String(row._id), stamp: created_stamp(row) });
		}
	}
	refs.sort((a, b) => b.stamp.localeCompare(a.stamp));
	const slice_refs = refs.slice((page - 1) * size, page * size);
	let slice: ImperiumDoc[] = [];
	if (slice_refs.length) {
		const { rows } = await ctx.store.find_many('notifications', {
			ids: slice_refs.map((item) => item.id),
			take: slice_refs.length,
			include_inactive: false,
			populate: false,
			skip_total: true,
		});
		const by_id = new Map(rows.map((row) => [String(row._id), row]));
		slice = slice_refs
			.map((item) => by_id.get(item.id))
			.filter((row): row is ImperiumDoc => Boolean(row));
	}
	return ok(
		slice,
		slice.length
			? 'Notificaciones obtenidas correctamente'
			: 'No se encontraron notificaciones para este usuario',
		refs.length,
	);
}

const ACTIVITY_LIMIT = { fallback: 25, max: 50 };
const ACTIVITY_MARK_MAX = 200;
const ACTIVITY_FILTERS = new Set(['all', 'chat', 'history', 'reactions']);
/** `contextType` de `mentions` → `kind` de `ChatActivityItem` (contrato §3.5). */
const ACTIVITY_KINDS: Record<string, string> = {
	'chat-message': 'mention',
	'chat-reply': 'reply',
	'chat-reaction': 'reaction',
	'chat-missed-call': 'missed_call',
	'history-comment': 'comment_mention',
	'history-reply': 'reply',
	document: 'mention',
};
const CHAT_MENTION_TOKEN = /\[@([^\n\]]*)\]\(mention:[a-z\d]+\)/gi;

function invalid_request(): ChatError {
	return new ChatError(422, 'invalid_request', 'La petición no es válida.');
}

/** Texto plano de ≤ 160 caracteres, sin markdown; una mención queda como `@Nombre`. */
function plain_excerpt(text: string): string {
	const plain = String(text ?? '')
		.replace(CHAT_MENTION_TOKEN, '@$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_~`#>|]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return plain.length > 160 ? `${plain.slice(0, 159)}…` : plain;
}

function activity_filter(value: unknown): string[] | undefined {
	const context = query_text(value) ?? 'all';
	if (!ACTIVITY_FILTERS.has(context)) throw invalid_request();
	return context === 'all' ? undefined : ACTIVITY_CONTEXTS[context as keyof typeof ACTIVITY_CONTEXTS];
}

function activity_cursor(row: ImperiumDoc): string {
	return Buffer.from(JSON.stringify({ at: String(row.created_at), id: String(row._id) })).toString('base64url');
}

function activity_before(raw: string): { at: string; id: string } {
	const cursor = as_object(Buffer.from(raw, 'base64url').toString('utf8'));
	if (typeof cursor.at === 'string' && typeof cursor.id === 'string' && cursor.id) return { at: cursor.at, id: cursor.id };
	throw new ChatError(400, 'invalid_cursor', 'La página solicitada ya no es válida; recarga la lista.');
}

function user_brief(user: ChatUserBrief) {
	return { _id: user._id, name: user.name, ...(user.email ? { email: user.email } : {}), ...(user.img ? { img: user.img } : {}) };
}

/** `ChatActivityItem[]`: quien la causó, las conversaciones y sus títulos salen en una consulta cada uno. */
async function activity_items(store: ImperiumStore, uid: string, rows: ImperiumDoc[]): Promise<ImperiumDoc[]> {
	const actor_of = (row: ImperiumDoc) => String(row.actorId ?? ref_id(row.actor));
	const conversation_ids = [...new Set(rows.map((row) => String(row.conversationId ?? '')).filter(Boolean))];
	const conversations = conversation_ids.length
		? (
				await store.find_many('chat-conversations', {
					ids: conversation_ids,
					take: conversation_ids.length,
					include_inactive: true,
					populate: false,
					skip_total: true,
				})
			).rows
		: [];
	const by_id = new Map(conversations.map((conversation) => [String(conversation._id), conversation]));
	const { rows: memberships } = conversation_ids.length
		? await store.find_many('chat-members', {
				where: { user_id: uid, conversation_id: { in: conversation_ids }, state: 'active' },
				take: conversation_ids.length,
				populate: false,
				skip_total: true,
			})
		: { rows: [] };
	const member_of = new Set(memberships.map((row) => String(row.conversation_id)));
	const peer_of = (conversation: ImperiumDoc | undefined) =>
		conversation?.kind === 'direct'
			? String(conversation.conversation_key ?? '')
					.split('::')
					.find((id) => id !== uid)
			: undefined;
	const users = new Map(
		(await store.chat_users_brief([...rows.map(actor_of), ...conversations.flatMap((row) => peer_of(row) ?? [])])).map(
			(user) => [user._id, user],
		),
	);
	return rows.map((row) => {
		const kind = ACTIVITY_KINDS[String(row.contextType ?? '')] ?? 'mention';
		const actor = users.get(actor_of(row));
		const source = as_object(row.source);
		const conversation_id = String(row.conversationId ?? '');
		const conversation = by_id.get(conversation_id);
		const peer = users.get(peer_of(conversation) ?? '');
		return {
			_id: String(row._id),
			kind,
			created_at: String(row.created_at),
			is_read: row.isRead === true,
			actor: actor ? user_brief(actor) : null,
			excerpt: plain_excerpt(String(row.excerpt ?? '')),
			...(kind === 'reaction' && row.reaction ? { reaction: String(row.reaction) } : {}),
			...(conversation_id
				? {
						chat: {
							conversation_id,
							message_id: String(row.messageId ?? ''),
							conversation_title:
								peer?.name ??
								String((member_of.has(conversation_id) ? conversation?.name : row.conversationTitle) ?? ''),
						},
					}
				: {
						record: {
							model_name: String(source.modelName ?? ''),
							collection_name: String(source.collectionName ?? ''),
							document_id: String(source.documentId ?? ''),
							history_id: String(row.historyId ?? source.historyId ?? ''),
							route: String(source.route ?? ''),
							entity_label: String(source.entityLabel ?? ''),
						},
					}),
		};
	});
}

/**
 * La bandeja de Actividad (contrato §3.5 y §4.6), por keyset del más nuevo al más viejo;
 * `counts` son las no leídas de cada filtro.
 */
export async function my_mentions(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('No se encontró una sesión válida para consultar menciones.');
	const params = ctx.url.searchParams;
	const context_types = activity_filter(params.get('context'));
	const raw_before = query_text(params.get('before'));
	const limit = Math.min(
		Math.max(1, Number.parseInt(params.get('limit') ?? '', 10) || ACTIVITY_LIMIT.fallback),
		ACTIVITY_LIMIT.max,
	);
	const rows = await ctx.store.chat_activity_page({
		user_id: uid,
		context_types,
		unread: params.get('unread') === '1' || params.get('unread') === 'true',
		before: raw_before ? activity_before(raw_before) : undefined,
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	const items = await activity_items(ctx.store, uid, page);
	const last = page.at(-1);
	return {
		...ok(items, items.length ? 'Actividad cargada.' : 'No hay actividad.'),
		next_cursor: rows.length > limit && last ? activity_cursor(last) : null,
		server_time: new Date().toISOString(),
		counts: await ctx.store.chat_activity_counts(uid),
	};
}

/** Contrato §4.6: unas (`ids`), todas (`all`) o las de un filtro; también su notificación ligada. */
export async function mark_mentions_read(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('No se encontró una sesión válida para consultar menciones.');
	const context_types = activity_filter(ctx.body.context);
	const ids = ctx.body.ids;
	const all = ctx.body.all === true;
	const listed =
		Array.isArray(ids) &&
		ids.length <= ACTIVITY_MARK_MAX &&
		ids.every((id) => typeof id === 'string' && OBJECT_ID.test(id));
	if (!all && !listed) throw invalid_request();
	const read = await ctx.store.chat_mark_activity_read({
		user_id: uid,
		ids: all ? undefined : (ids as string[]),
		context_types,
		now: new Date().toISOString(),
	});
	if (read.ids.length) {
		emit_notifications_refresh([uid], {
			reason: 'activity_read',
			activity_ids: read.ids,
			...(read.notification_ids.length ? { notification_ids: read.notification_ids } : {}),
		});
	}
	return ok([{ updated: read.ids.length }], 'Actividad marcada como leída.');
}

export type ChatActivityInput = {
	user_id: string;
	context_type: 'chat-message' | 'chat-reply' | 'chat-reaction' | 'chat-missed-call';
	conversation_id: string;
	/** El título del grupo al momento: es lo que ve quien después ya no es miembro. */
	conversation_title?: string;
	message_id: string;
	excerpt: string;
	reaction?: string;
};

/**
 * Actividad del chat (contrato §1.12): una fila de `mentions` por persona y su aviso
 * `activity_created`. Los mensajes del chat no crean notificación de campana; el silencio de
 * cada conversación lo aplica el cliente con sus preferencias.
 */
export async function register_chat_activity(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	inputs: ChatActivityInput[],
) {
	const uid = String(actor?._id ?? '');
	const records = inputs
		.filter((input) => input.user_id && input.user_id !== uid)
		.map((input) => ({
			mentionedUserId: input.user_id,
			actorId: uid,
			actor: { _id: uid, name: actor?.name, email: actor?.email },
			contextType: input.context_type,
			conversationId: input.conversation_id,
			...(input.conversation_title ? { conversationTitle: input.conversation_title } : {}),
			messageId: input.message_id,
			...(input.reaction ? { reaction: input.reaction } : {}),
			excerpt: plain_excerpt(input.excerpt),
			source: {
				kind: 'chat',
				action: input.context_type,
				conversationId: input.conversation_id,
				messageId: input.message_id,
			},
			isRead: false,
		}));
	if (records.length) await persist_mentions(store, records, []);
}

/** Lo que dejó de existir (un mensaje borrado, una reacción quitada) sale de la Actividad. */
export async function retire_chat_activity(
	store: ImperiumStore,
	input: { message_id: string; context_type?: string; actor_id?: string; reaction?: string },
) {
	const retired = await store.chat_retire_activity({ ...input, now: new Date().toISOString() });
	const by_user = new Map<string, string[]>();
	for (const row of retired) by_user.set(row.user_id, [...(by_user.get(row.user_id) ?? []), row.id]);
	for (const [user_id, activity_ids] of by_user) {
		emit_notifications_refresh([user_id], { reason: 'activity_removed', activity_ids });
	}
}

export async function clear_notifications(ctx: NotificationCtx) {
	const uid = actor_id(ctx);
	const scope = query_text(ctx.url.searchParams.get('scope'))?.toLowerCase();
	let deleted = 0;
	for await (const page of scan_mine(ctx.store, uid)) {
		for (const row of page) {
			if (scope === 'read' && !is_read(row)) continue;
			await hard_remove(ctx, 'notifications', String(row._id));
			deleted += 1;
		}
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
	const inserted = await store.insert_activity(
		records.map((record) => {
			const notification_id = by_recipient.get(String(record.mentionedUserId ?? ''));
			return { ...record, ...(notification_id ? { notificationId: notification_id } : {}), isRead: false };
		}),
	);
	for (const activity of inserted) queue_refresh(activity.user_id, { activity_id: activity.id });
}

export async function resolve_comment_mentioned_users(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	comment_text: string,
	mentioned_user_ids?: unknown,
) {
	const uid = String(actor?._id ?? '').toLowerCase();
	const from_body = as_array(mentioned_user_ids)
		.map((item) => {
			if (item && typeof item === 'object') {
				return String((item as { _id?: unknown })._id ?? '').toLowerCase();
			}
			return String(item ?? '').toLowerCase();
		})
		.filter(Boolean);
	const ids = [...new Set([...from_body, ...mention_ids_in(comment_text)])].filter(
		(id) => id && id !== uid,
	);
	return resolve_users(store, ids);
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
	const users = await resolve_comment_mentioned_users(
		store,
		actor,
		params.comment_text,
		params.mentioned_user_ids,
	);
	if (!users.length) return;
	const uid = String(actor?._id ?? '');
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

/**
 * Contrato §4.6: quien escribió el comentario que se responde recibe la notificación
 * `history-comment-reply` y la actividad `history-reply`.
 */
export async function register_comment_reply(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	params: {
		author_id: string;
		comment_text: string;
		model_name?: string;
		collection_name?: string;
		document_id?: string;
		history_id?: string;
		route?: string;
		entity_label?: string;
	},
) {
	const uid = String(actor?._id ?? '');
	if (!params.author_id || params.author_id === uid) return;
	const [author] = await resolve_users(store, [params.author_id]);
	if (!author) return;
	const excerpt = clean_excerpt(params.comment_text);
	const by = { _id: uid, name: actor?.name, email: actor?.email };
	const source = {
		kind: 'document-change-history',
		action: 'comment-reply',
		modelName: params.model_name,
		collectionName: params.collection_name,
		documentId: params.document_id,
		historyId: params.history_id,
		route: params.route,
		entityLabel: params.entity_label,
	};
	await persist_mentions(
		store,
		[
			{
				mentionedUserId: author._id,
				actorId: uid,
				actor: by,
				source,
				excerpt,
				contextType: 'history-reply',
				historyId: params.history_id,
				isRead: false,
			},
		],
		[
			{
				recipientId: author._id,
				type: 'history-comment-reply',
				title: `${actor_label(actor)} respondió tu comentario`,
				message: excerpt || 'Respondieron tu comentario.',
				description: 'Respuesta en el historial de cambios de un registro del sistema.',
				actor: by,
				source,
				payload: { commentText: params.comment_text, historyId: params.history_id },
				isRead: false,
			},
		],
	);
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
	const current = as_object(input.current_document);
	const tags = as_array(current.tags ?? current.etiquetas).map((tag) =>
		tag && typeof tag === 'object' && tag !== null
			? String((tag as { _id?: unknown; name?: unknown })._id ?? (tag as { name?: unknown }).name ?? '')
			: String(tag ?? ''),
	);
	const recipients = new Map<string, string[]>();
	for await (const page of store.scan('user-settings', { include_inactive: false })) {
		for (const row of page) {
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
