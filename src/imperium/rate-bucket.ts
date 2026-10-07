/**
 * Límites de tasa en memoria (token bucket). Valen para una sola réplica del
 * núcleo, como el resto del tiempo real.
 */
import { fail } from './envelope.ts';

export type BucketRule = { capacity: number; refill_per_s: number };

type Bucket = { tokens: number; at: number; full_at: number };

const buckets = new Map<string, Bucket>();

export function take_token(
	key: string,
	rule: BucketRule,
	now = Date.now(),
): { ok: true } | { ok: false; retry_after_s: number } {
	const prev = buckets.get(key);
	const tokens = prev
		? Math.min(rule.capacity, prev.tokens + ((now - prev.at) / 1000) * rule.refill_per_s)
		: rule.capacity;
	const left = tokens >= 1 ? tokens - 1 : tokens;
	buckets.set(key, {
		tokens: left,
		at: now,
		full_at: now + ((rule.capacity - left) / rule.refill_per_s) * 1000,
	});
	if (tokens >= 1) return { ok: true };
	return { ok: false, retry_after_s: Math.ceil((1 - tokens) / rule.refill_per_s) };
}

setInterval(() => {
	const now = Date.now();
	for (const [key, bucket] of buckets) {
		if (bucket.full_at <= now) buckets.delete(key);
	}
}, 60_000).unref?.();

export function rate_limited_response(
	retry_after_s: number,
	code = 'rate_limited',
	message = `Demasiadas solicitudes; intenta de nuevo en ${retry_after_s} s.`,
): Response {
	return Response.json(
		fail(message, 429, { code, details: { retry_after_s } }).body,
		{ status: 429, headers: { 'retry-after': String(retry_after_s) } },
	);
}
