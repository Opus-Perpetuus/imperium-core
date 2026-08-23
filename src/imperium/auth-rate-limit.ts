/**
 * Rate limits de autenticación pública — mismo contrato que el original
 * (`auth.rate-limit.ts` + `auth-rate-limit.store.ts`).
 *
 * Capas:
 * - por **email** (identidad del intento): desbloqueable por admin
 * - por **IP**: protección NAT / multi-cuenta; no se resetea con el email
 */
const LOGIN_BLOCKED =
	'Demasiados intentos de inicio de sesión. Intenta más tarde o contacta a un administrador.';
const RESET_BLOCKED =
	'Demasiadas solicitudes de recuperación. Intenta más tarde o contacta a un administrador.';

function env_int(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const window_ms = env_int('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);
const login_email_max = env_int('AUTH_LOGIN_EMAIL_RATE_LIMIT_MAX', 15);
const login_ip_max = env_int('AUTH_LOGIN_IP_RATE_LIMIT_MAX', 60);
const reset_email_max = env_int('AUTH_PASSWORD_RESET_EMAIL_RATE_LIMIT_MAX', 5);
const reset_ip_max = env_int('AUTH_PASSWORD_RESET_IP_RATE_LIMIT_MAX', 20);

export function normalize_auth_rate_limit_email(email: unknown): string {
	return String(email ?? '')
		.trim()
		.toLowerCase();
}

export function request_ip(req: Request): string {
	const forwarded = req.headers.get('x-forwarded-for');
	if (forwarded) {
		const first = forwarded.split(',')[0]?.trim();
		if (first) return first;
	}
	return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function ensure_auth_rate_limit_table(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.imperium_auth_rate_limits (
      key TEXT PRIMARY KEY,
      hits INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL
    )
  `);
}

function skip_in_test() {
	return process.env.NODE_ENV === 'test';
}

async function increment_key(sql: Bun.SQL, key: string): Promise<number> {
	const now = Date.now();
	const rows = await sql.unsafe(
		`SELECT hits, extract(epoch from reset_at) * 1000 AS exp
     FROM public.imperium_auth_rate_limits WHERE key = $1`,
		[key],
	);
	const row = rows[0] as { hits?: number; exp?: number } | undefined;
	if (!row || Number(row.exp) <= now) {
		const reset_at = now + window_ms;
		await sql.unsafe(
			`INSERT INTO public.imperium_auth_rate_limits (key, hits, reset_at)
       VALUES ($1, 1, to_timestamp($2 / 1000.0))
       ON CONFLICT (key) DO UPDATE SET hits = 1, reset_at = EXCLUDED.reset_at`,
			[key, reset_at],
		);
		return 1;
	}
	const updated = await sql.unsafe(
		`UPDATE public.imperium_auth_rate_limits SET hits = hits + 1 WHERE key = $1 RETURNING hits`,
		[key],
	);
	return Number((updated[0] as { hits?: number } | undefined)?.hits ?? Number(row.hits ?? 0) + 1);
}

async function consume(sql: Bun.SQL, storage_key: string, limit: number): Promise<boolean> {
	if (skip_in_test()) return false;
	const hits = await increment_key(sql, storage_key);
	return hits > limit;
}

function blocked_body(message: string) {
	return { error: message, message };
}

export async function consume_login_limits(
	sql: Bun.SQL,
	email: string,
	ip: string,
): Promise<{ error: string; message: string } | null> {
	const identity = email || `missing:${ip}`;
	if (await consume(sql, `le:login-email:${identity}`, login_email_max)) {
		return blocked_body(LOGIN_BLOCKED);
	}
	if (await consume(sql, `li:login-ip:${ip}`, login_ip_max)) {
		return blocked_body(LOGIN_BLOCKED);
	}
	return null;
}

export async function consume_password_reset_request_limits(
	sql: Bun.SQL,
	email: string,
	ip: string,
): Promise<{ error: string; message: string } | null> {
	const identity = email || `missing:${ip}`;
	if (await consume(sql, `re:reset-email:${identity}`, reset_email_max)) {
		return blocked_body(RESET_BLOCKED);
	}
	if (await consume(sql, `ri:reset-ip:${ip}`, reset_ip_max)) {
		return blocked_body(RESET_BLOCKED);
	}
	return null;
}

export async function consume_password_reset_ip_limit(
	sql: Bun.SQL,
	ip: string,
): Promise<{ error: string; message: string } | null> {
	if (await consume(sql, `ri:reset-ip:${ip}`, reset_ip_max)) {
		return blocked_body(RESET_BLOCKED);
	}
	return null;
}

/**
 * Borra contadores de login/recuperación asociados a un email.
 * No toca contadores por IP (siguen protegiendo la red).
 */
export async function reset_auth_rate_limits_for_email(
	sql: Bun.SQL,
	email: string,
): Promise<number> {
	const normalized = normalize_auth_rate_limit_email(email);
	if (!normalized) return 0;
	const keys = [`le:login-email:${normalized}`, `re:reset-email:${normalized}`];
	let deleted = 0;
	for (const key of keys) {
		const rows = await sql.unsafe(
			`DELETE FROM public.imperium_auth_rate_limits WHERE key = $1 RETURNING key`,
			[key],
		);
		deleted += Array.isArray(rows) ? rows.length : 0;
	}
	return deleted;
}
