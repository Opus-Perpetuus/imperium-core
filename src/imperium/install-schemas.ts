import type { KirletSchemaBundle } from '@opus-perpetuus/imperium-core-kit';
import { schema_bundle_mismatch } from './subject-schema.ts';

export type SchemaFetchResult =
	| { id: string; ok: true; bundle: KirletSchemaBundle }
	| { id: string; ok: false; status?: number; error: string; detail?: string };

export function install_schema_fetch_timeout_ms(): number {
	const from_env = Number(process.env.CORE_INSTALL_SCHEMA_FETCH_TIMEOUT_MS ?? '');
	return Number.isFinite(from_env) && from_env > 0 ? from_env : 5_000;
}

// Una app del catálogo sin contenedor deja el fetch colgado; el race con la
// señal acota cada app aunque el fetch no la respete.
async function fetch_one(
	id: string,
	url: string,
	do_fetch: typeof fetch,
	timeout_ms: number,
): Promise<SchemaFetchResult> {
	const signal = AbortSignal.timeout(timeout_ms);
	const aborted = new Promise<never>((_, reject) =>
		signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
	);
	return Promise.race([
		(async (): Promise<SchemaFetchResult> => {
			const res = await do_fetch(url, { signal });
			if (!res.ok) return { id, ok: false, status: res.status, error: `http_${res.status}` };
			const bundle = (await res.json()) as KirletSchemaBundle;
			const mismatch = schema_bundle_mismatch(bundle, id);
			return mismatch ? { id, ok: false, error: mismatch } : { id, ok: true, bundle };
		})(),
		aborted,
	]);
}

export async function fetch_subject_schemas(
	ids: string[],
	url_of: (id: string) => string | undefined,
	opts: { fetch?: typeof fetch; timeout_ms?: number } = {},
): Promise<SchemaFetchResult[]> {
	const do_fetch = opts.fetch ?? fetch;
	const timeout_ms = opts.timeout_ms ?? install_schema_fetch_timeout_ms();
	const settled = await Promise.allSettled(
		ids.map((id) => fetch_one(id, `${url_of(id)}/schema`, do_fetch, timeout_ms)),
	);
	return settled.map((r, i) =>
		r.status === 'fulfilled'
			? r.value
			: { id: ids[i]!, ok: false, error: 'unreachable', detail: String(r.reason) },
	);
}
