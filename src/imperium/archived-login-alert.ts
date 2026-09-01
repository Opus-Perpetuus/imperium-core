/**
 * Aviso e historial cuando un usuario archivado (`is_active: false`) intenta
 * entrar. Mismo contrato que `archived-login-alert.ts` del original.
 */
import { as_array, as_object, type ImperiumDoc } from './envelope.ts';
import { debug_error } from './debug-request-log.ts';
import type { ImperiumStore } from './store.ts';

export const SEED_ADMIN_USER_REF = 'user-menu-management-0';
export const ADMIN_USER_GROUP_REF = 'user-group-0';
export const ARCHIVED_LOGIN_ALERT_TYPE = 'archived_user_login_attempt';
export const ARCHIVED_LOGIN_DOMAIN_EVENT = 'intento-login-usuario-archivado';

function text(value: unknown) {
	return String(value ?? '').trim();
}

function unique_id_list(ids: Array<unknown>, exclude_id?: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of ids) {
		const id = text(raw);
		if (!id || id === exclude_id || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}

function id_list(value: unknown): string[] {
	return unique_id_list(
		as_array(value).map((item) => {
			if (item && typeof item === 'object') {
				const rec = item as Record<string, unknown>;
				return text(rec._id ?? rec.id);
			}
			return text(item);
		}),
	);
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

function ref_of(doc: ImperiumDoc) {
	return text(doc._ref ?? doc.ref);
}

function is_active(doc: ImperiumDoc) {
	return doc.is_active !== false;
}

function is_read(doc: ImperiumDoc) {
	return doc.isRead === true || doc.read === true || doc.leido === true;
}

function source_document_id(doc: ImperiumDoc) {
	const source = as_object(doc.source);
	return text(source.documentId ?? source.document_id);
}

export function build_archived_login_alert_copy(user: { name?: string; email?: string }) {
	const email = text(user.email);
	const label = text(user.name) || email || 'Usuario';
	return {
		title: 'Intento de acceso de usuario archivado',
		message:
			email && email !== label
				? `${label} (${email}) intentó iniciar sesión. Revisa si debe reactivarse.`
				: `${label} intentó iniciar sesión. Revisa si debe reactivarse.`,
		label,
	};
}

export function build_archived_login_history_comment(user: { name?: string; email?: string }) {
	const email = text(user.email);
	const label = text(user.name) || email || 'Usuario';
	return [
		`[${ARCHIVED_LOGIN_DOMAIN_EVENT}] Intento de inicio de sesión en cuenta archivada.`,
		email ? `Correo: ${email}.` : null,
		label && label !== email ? `Nombre: ${label}.` : null,
		'No se concedió acceso.',
		'Acción requerida: revisar si el usuario debe reactivarse.',
	]
		.filter(Boolean)
		.join('\n');
}

async function record_archived_login_history(store: ImperiumStore, user: ImperiumDoc) {
	const archived_user_id = text(user._id ?? user.id);
	if (!archived_user_id || !store.has('document-change-history')) return;
	const comment = build_archived_login_history_comment({
		name: text(user.name),
		email: text(user.email),
	});
	await store.insert('document-change-history', {
		name: 'Intento de acceso archivado',
		entryType: 'comment',
		actor: { name: 'Sistema' },
		collectionName: 'user',
		modelName: 'User',
		documentId: archived_user_id,
		record_id: archived_user_id,
		operationType: 'domain_event',
		actionName: 'Intento de acceso archivado',
		actionDescription: comment,
		comment: comment,
		commentText: comment,
		mentionedUserIds: [],
		mentionedUsers: [],
		changeCount: 0,
		changes: [],
	});
}

async function notify_admins_of_archived_login(store: ImperiumStore, user: ImperiumDoc) {
	const archived_user_id = text(user._id ?? user.id);
	if (!archived_user_id || !store.has('notifications') || !store.has('user')) return;

	const seed_admin = await store.find_where('user', { _ref: SEED_ADMIN_USER_REF });
	const seed_admin_ids =
		seed_admin && is_active(seed_admin) ? [text(seed_admin._id ?? seed_admin.id)] : [];

	let group_user_ids: string[] = [];
	if (store.has('user-group')) {
		const admin_group = await store.find_where('user-group', { _ref: ADMIN_USER_GROUP_REF });
		if (admin_group && is_active(admin_group)) {
			group_user_ids = id_list(admin_group.user_ids ?? admin_group.userIds);
		}
	}

	const candidate_ids = unique_id_list([...seed_admin_ids, ...group_user_ids], archived_user_id);
	if (!candidate_ids.length) return;

	const active_admin_ids: string[] = [];
	for (const id of candidate_ids) {
		const row = await store.find_id('user', id);
		if (row && is_active(row)) active_admin_ids.push(text(row._id ?? row.id));
	}
	if (!active_admin_ids.length) return;

	const unread_recipient_ids: string[] = [];
	for await (const page of store.scan('notifications', {
		where: { type: ARCHIVED_LOGIN_ALERT_TYPE },
		include_inactive: true,
	})) {
		for (const row of page) {
			if (text(row.type) !== ARCHIVED_LOGIN_ALERT_TYPE || is_read(row)) continue;
			if (source_document_id(row) !== archived_user_id) continue;
			const recipient = text(row.recipientId ?? row.user ?? row.to);
			if (!active_admin_ids.includes(recipient)) continue;
			unread_recipient_ids.push(recipient);
		}
	}
	const unread = new Set(unread_recipient_ids);
	const recipient_ids = active_admin_ids.filter((id) => !unread.has(id));
	if (!recipient_ids.length) return;

	const { title, message, label } = build_archived_login_alert_copy({
		name: text(user.name),
		email: text(user.email),
	});
	const route = `/internal/user/detail/${route_slug(label)}/${archived_user_id}`;
	for (const recipient_id of recipient_ids) {
		await store.insert('notifications', {
			name: title,
			recipientId: recipient_id,
			type: ARCHIVED_LOGIN_ALERT_TYPE,
			title,
			message,
			isRead: false,
			is_active: true,
			actor: {
				_id: archived_user_id,
				name: user.name,
				email: user.email,
			},
			source: {
				kind: 'user',
				action: 'archived_login_attempt',
				modelName: 'User',
				collectionName: 'user',
				documentId: archived_user_id,
				route,
				entityLabel: label,
			},
			payload: {
				user_id: archived_user_id,
				email: user.email,
			},
		});
	}
}

/**
 * Historial del usuario + aviso a administradores. No lanza: el 401 del login
 * no debe depender de esto.
 */
export async function report_archived_login_attempt(store: ImperiumStore, user: ImperiumDoc) {
	const archived_user_id = text(user._id ?? user.id);
	if (!archived_user_id) return;
	try {
		await Promise.all([
			record_archived_login_history(store, user),
			notify_admins_of_archived_login(store, user),
		]);
	} catch (error) {
		debug_error(
			'No se pudo notificar el intento de login de un usuario archivado: ' +
				(error instanceof Error ? error.message : String(error)),
		);
	}
}
