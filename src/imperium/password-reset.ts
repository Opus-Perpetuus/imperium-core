/**
 * Tokens de recuperación — mismo contrato que PasswordResetService.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { build_recovery_link, type EmailSettings } from './email.ts';

const RECOVERY_TTL_MS = 2 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hash_reset_token(raw: string) {
	return createHash('sha256').update(raw).digest('hex');
}

export async function generate_password_reset(
	store: ImperiumStore,
	user: ImperiumDoc,
	kind: 'recovery' | 'invitation',
	settings: EmailSettings,
	origin = '',
) {
	const raw = randomBytes(32).toString('hex');
	const expires_at = new Date(Date.now() + (kind === 'invitation' ? INVITATION_TTL_MS : RECOVERY_TTL_MS));
	await store.update('user', String(user._id), {
		reset_password_token_hash: hash_reset_token(raw),
		reset_password_expires: expires_at.toISOString(),
		reset_password_kind: kind,
		recovery_token: null,
		recovery_expires: null,
	});
	return {
		raw,
		link: build_recovery_link(settings, raw, origin),
		expires_at,
		kind,
	};
}

export async function find_user_by_reset_token(store: ImperiumStore, raw_token: string) {
	const cleaned = String(raw_token ?? '').trim();
	if (!cleaned || !store.has('user')) return null;
	const user = await store.find_where('user', {
		reset_password_token_hash: hash_reset_token(cleaned),
	});
	if (!user || user.is_active === false) return null;
	const expires_at = Date.parse(String(user.reset_password_expires ?? ''));
	if (!expires_at || expires_at < Date.now()) return null;
	return user;
}
