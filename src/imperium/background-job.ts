/**
 * Notificación `background_job`: progreso + registro de un trabajo largo
 * (instalar / desinstalar app) sin saturar toasts ni el hilo de la UI.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import { emit_notifications_refresh } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

export const BACKGROUND_JOB_TYPE = 'background_job';
export const MAX_BACKGROUND_JOB_LOGS = 40;
export const MODULE_MANAGEMENT_ROUTE = '/internal/module-management';

export type BackgroundJobLevel = 'info' | 'success' | 'warning' | 'error';
export type BackgroundJobStatus = 'running' | 'success' | 'error';
export type BackgroundJobKind = 'subject_install' | 'subject_uninstall';

export type BackgroundJobLog = {
	at: string;
	level: BackgroundJobLevel;
	phase: string;
	message: string;
};

export type BackgroundJobPayload = {
	kind: typeof BACKGROUND_JOB_TYPE;
	job_kind: BackgroundJobKind;
	technical_id: string;
	slug: string;
	name: string;
	status: BackgroundJobStatus;
	progress: number;
	phase: string;
	logs: BackgroundJobLog[];
};

export function background_job_progress(
	phase: string,
	status?: string,
): number {
	if (status === 'success' || phase === 'done') return 100;
	if (status === 'error' || phase === 'error') return 100;
	switch (phase) {
		case 'sql':
			return 12;
		case 'docker':
		case 'docker_up':
		case 'docker_stop':
			return 40;
		case 'docker_rm':
			return 58;
		case 'docker_rmi':
			return 72;
		case 'schema':
			return 88;
		default:
			return 20;
	}
}

export function should_toast_subject_event(phase: string): boolean {
	return phase === 'done' || phase === 'error';
}

export function should_refresh_shell_for_subject(phase: string): boolean {
	return phase === 'done' || phase === 'error';
}

export function append_background_job_logs(
	logs: BackgroundJobLog[],
	entry: BackgroundJobLog,
): BackgroundJobLog[] {
	const last = logs[logs.length - 1];
	if (
		last &&
		last.level === entry.level &&
		last.phase === entry.phase &&
		last.message === entry.message
	) {
		return logs;
	}
	const next = [...logs, entry];
	return next.length > MAX_BACKGROUND_JOB_LOGS
		? next.slice(-MAX_BACKGROUND_JOB_LOGS)
		: next;
}

export function job_bag(doc: ImperiumDoc): Record<string, unknown> {
	return { ...as_object(doc), ...as_object(doc.payload) };
}

export function is_background_job_doc(
	doc: ImperiumDoc | null | undefined,
): boolean {
	if (!doc) return false;
	const bag = job_bag(doc);
	return (
		String(doc.type ?? '') === BACKGROUND_JOB_TYPE ||
		String(bag.kind ?? '') === BACKGROUND_JOB_TYPE
	);
}

export function read_background_job_payload(
	doc: ImperiumDoc,
): BackgroundJobPayload | null {
	if (!is_background_job_doc(doc)) return null;
	const bag = job_bag(doc);
	const logs = Array.isArray(bag.logs)
		? (bag.logs as BackgroundJobLog[])
		: [];
	return {
		kind: BACKGROUND_JOB_TYPE,
		job_kind:
			bag.job_kind === 'subject_uninstall'
				? 'subject_uninstall'
				: 'subject_install',
		technical_id: String(bag.technical_id ?? ''),
		slug: String(bag.slug ?? ''),
		name: String(bag.name ?? ''),
		status:
			bag.status === 'success' || bag.status === 'error'
				? bag.status
				: 'running',
		progress: Number(bag.progress ?? 0) || 0,
		phase: String(bag.phase ?? ''),
		logs,
	};
}

export function merge_background_job_payload(
	current: BackgroundJobPayload,
	event: {
		phase?: string;
		status?: string;
		level?: BackgroundJobLevel;
		message?: string;
		progress?: number;
		name?: string;
		slug?: string;
	},
): BackgroundJobPayload {
	const phase = String(event.phase ?? current.phase);
	const terminal =
		phase === 'done' ||
		phase === 'error' ||
		event.status === 'installed' ||
		event.status === 'uninstalled' ||
		event.status === 'error';
	const status: BackgroundJobStatus =
		phase === 'error' || event.status === 'error'
			? 'error'
			: terminal
				? 'success'
				: 'running';
	const progress =
		typeof event.progress === 'number'
			? event.progress
			: background_job_progress(phase, status);
	const message = String(event.message ?? '').trim();
	const logs = message
		? append_background_job_logs(current.logs, {
				at: new Date().toISOString(),
				level: event.level ?? (status === 'error' ? 'error' : 'info'),
				phase,
				message,
			})
		: current.logs;
	return {
		...current,
		name: String(event.name ?? current.name),
		slug: String(event.slug ?? current.slug),
		status,
		progress,
		phase,
		logs,
	};
}

export function background_job_title(
	job_kind: BackgroundJobKind,
	name: string,
	status: BackgroundJobStatus,
): string {
	if (status === 'success') {
		return job_kind === 'subject_install'
			? `${name} instalada`
			: `${name} desinstalada`;
	}
	if (status === 'error') {
		return job_kind === 'subject_install'
			? `Error al instalar ${name}`
			: `Error al desinstalar ${name}`;
	}
	return job_kind === 'subject_install'
		? `Instalando ${name}`
		: `Desinstalando ${name}`;
}

export async function find_running_background_job(
	store: ImperiumStore,
	recipient_id: string,
	technical_id: string,
): Promise<ImperiumDoc | null> {
	if (!recipient_id || !technical_id || !store.has('notifications')) {
		return null;
	}
	const { rows } = await store.find_many('notifications', {
		mongo_match: {
			$or: [{ recipientId: recipient_id }, { user: recipient_id }],
		},
		take: 200,
		include_inactive: true,
	});
	return (
		rows.find((row) => {
			if (!is_background_job_doc(row)) return false;
			const payload = read_background_job_payload(row);
			return (
				payload?.technical_id === technical_id &&
				payload.status === 'running'
			);
		}) ?? null
	);
}

export function background_job_persist_patch(
	existing: ImperiumDoc,
	payload: BackgroundJobPayload,
	message: string,
): ImperiumDoc {
	const bag = job_bag(existing);
	const recipientId = String(bag.recipientId ?? bag.user ?? bag.to ?? '');
	const title = background_job_title(
		payload.job_kind,
		payload.name,
		payload.status,
	);
	return {
		title,
		name: title,
		message,
		type: BACKGROUND_JOB_TYPE,
		recipientId,
		user: recipientId,
		is_active: existing.is_active !== false,
		source: existing.source,
		actor: existing.actor,
		status: payload.status,
		phase: payload.phase,
		progress: payload.progress,
		payload,
		isRead: payload.status === 'running' ? existing.isRead === true : false,
	};
}

export async function persist_background_job(
	store: ImperiumStore,
	notification_id: string,
	payload: BackgroundJobPayload,
	message: string,
): Promise<ImperiumDoc | null> {
	if (!store.has('notifications')) return null;
	const existing = await store.find_id('notifications', notification_id);
	if (!existing) return null;
	return store.update(
		'notifications',
		notification_id,
		background_job_persist_patch(existing, payload, message),
	);
}

export async function create_background_job_notification(
	store: ImperiumStore,
	input: {
		recipient_id: string;
		actor?: ImperiumDoc | null;
		job_kind: BackgroundJobKind;
		technical_id: string;
		slug: string;
		name: string;
		message: string;
	},
): Promise<ImperiumDoc | null> {
	if (!input.recipient_id || !store.has('notifications')) return null;
	const existing = await find_running_background_job(
		store,
		input.recipient_id,
		input.technical_id,
	);
	const payload: BackgroundJobPayload = {
		kind: BACKGROUND_JOB_TYPE,
		job_kind: input.job_kind,
		technical_id: input.technical_id,
		slug: input.slug,
		name: input.name,
		status: 'running',
		progress: background_job_progress('sql'),
		phase: 'sql',
		logs: input.message
			? [
					{
						at: new Date().toISOString(),
						level: 'info',
						phase: 'sql',
						message: input.message,
					},
				]
			: [],
	};
	const title = background_job_title(input.job_kind, input.name, 'running');
	if (existing?._id) {
		return persist_background_job(
			store,
			String(existing._id),
			payload,
			input.message,
		);
	}
	return store.insert('notifications', {
		name: title,
		title,
		message: input.message,
		type: BACKGROUND_JOB_TYPE,
		recipientId: input.recipient_id,
		user: input.recipient_id,
		isRead: false,
		is_active: true,
		source: {
			kind: BACKGROUND_JOB_TYPE,
			action: input.job_kind,
			modelName: 'Subject',
			collectionName: 'subject_installs',
			documentId: input.technical_id,
			route: MODULE_MANAGEMENT_ROUTE,
			entityLabel: input.name,
		},
		payload,
		actor: {
			_id: String(input.actor?._id ?? input.recipient_id),
			name: input.actor?.name,
			email: input.actor?.email,
		},
	});
}

export function notify_background_job_refresh(
	recipient_id: string,
	notification_id?: string,
	reason = 'background_job',
): void {
	if (!recipient_id) return;
	emit_notifications_refresh([recipient_id], {
		reason,
		notification_ids: notification_id ? [notification_id] : undefined,
	});
}
