import { FEATURE_MAP_TEST_COLUMN_DDL } from './feature-map-test.ts';
import { debug_error } from './debug-request-log.ts';

export type AuthAttempt = {
	method: 'password' | 'badge' | 'reset';
	result: 'ok' | 'fail' | 'blocked';
	reason: string;
	user_id?: string;
	badge_prefix?: string;
	ip?: string;
	device_id?: string;
	user_agent?: string;
};

const RETENTION_DAYS = 90;

export async function ensure_auth_attempts_table(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.imperium_auth_attempts (
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      method TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT,
      user_id TEXT,
      badge_prefix TEXT,
      ip TEXT,
      device_id TEXT,
      user_agent TEXT,
      ${FEATURE_MAP_TEST_COLUMN_DDL}
    )
  `);
	await sql.unsafe(
		`CREATE INDEX IF NOT EXISTS imperium_auth_attempts_at_idx ON public.imperium_auth_attempts (at)`,
	);
	await sql.unsafe(
		`DELETE FROM public.imperium_auth_attempts WHERE at < now() - interval '${RETENTION_DAYS} days'`,
	);
}

export async function record_auth_attempt(sql: Bun.SQL, attempt: AuthAttempt): Promise<void> {
	try {
		await sql.unsafe(
			`INSERT INTO public.imperium_auth_attempts
       (method, result, reason, user_id, badge_prefix, ip, device_id, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[
				attempt.method,
				attempt.result,
				attempt.reason,
				attempt.user_id || null,
				attempt.badge_prefix || null,
				attempt.ip || null,
				attempt.device_id || null,
				(attempt.user_agent ?? '').slice(0, 200) || null,
			],
		);
	} catch (err) {
		debug_error(`bitácora de acceso no guardada: ${String((err as Error).message)}`);
	}
}
