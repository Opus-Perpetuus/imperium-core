/**
 * GET /debug-log, statistics y related-request — página, agregados y lookup en SQL.
 * No hidrata el universo. Contrato Angular: data + total_elementos + page/size.
 */
import { ok, type ImperiumDoc } from './envelope.ts';
import type { DebugLogFilter, ImperiumStore } from './store.ts';

const DEBUG_SORTS = new Set([
	'createdAt',
	'level',
	'message',
	'origin.file',
	'request_context.response.status_code',
	'request_context.response.duration_ms',
]);

function csv_params(url: URL, key: string): string[] {
	return String(url.searchParams.get(key) ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

function iso_or_empty(raw: string): string {
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

export function parse_debug_log_filter(url: URL): DebugLogFilter {
	let date_from = iso_or_empty(String(url.searchParams.get('date_from') ?? ''));
	let date_to = iso_or_empty(String(url.searchParams.get('date_to') ?? ''));
	if (date_from && date_to && date_from > date_to) {
		const swap = date_from;
		date_from = date_to;
		date_to = swap;
	}
	return {
		levels: csv_params(url, 'level'),
		search: String(url.searchParams.get('search') ?? '').trim().toLowerCase(),
		user: String(url.searchParams.get('user') ?? '').trim().toLowerCase(),
		origin_file: String(url.searchParams.get('origin_file') ?? '').trim().toLowerCase(),
		request_results: csv_params(url, 'request_result').map((item) => item.toLowerCase()),
		date_from,
		date_to,
	};
}

export async function debug_read_logs(store: ImperiumStore, url: URL) {
	const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
	const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size') ?? 50) || 50));
	const sort_field = url.searchParams.get('sort') || 'createdAt';
	const sort = DEBUG_SORTS.has(sort_field) ? sort_field : 'createdAt';
	const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
	const { rows, total } = await store.debug_log_page(parse_debug_log_filter(url), {
		skip: (page - 1) * size,
		take: size,
		sort,
		dir,
	});
	return {
		...ok(rows, 'Logs obtenidos', total),
		page,
		size,
		total_pages: Math.ceil(total / size) || 0,
	};
}

export async function debug_statistics(store: ImperiumStore, url: URL) {
	const data = await store.debug_log_stats(parse_debug_log_filter(url));
	return {
		data,
		message: 'Estadísticas de logs',
	};
}

export function debug_normalize_related_route(value: string): string {
	const normalized = value.trim();
	if (!normalized) return '';
	if (normalized.startsWith('/')) return normalized.slice(0, 1024);
	try {
		const parsed = new URL(normalized);
		return `${parsed.pathname}${parsed.search}`.slice(0, 1024);
	} catch {
		return '';
	}
}

export function debug_route_key(value: string): string {
	const route = debug_normalize_related_route(value);
	if (route === '/api') return '/';
	if (route.startsWith('/api/')) return route.slice(4) || '/';
	return route;
}

/**
 * Persist guarda pathname+search (con o sin `/api`). El toast manda
 * cualquiera de las dos; igualdad SQL directa perdería el match.
 */
export function debug_related_route_candidates(route: string): string[] {
	const normalized = debug_normalize_related_route(route);
	const key = debug_route_key(route);
	const out = new Set<string>();
	if (normalized) out.add(normalized);
	if (key) {
		out.add(key);
		if (key === '/') out.add('/api');
		else out.add(key.startsWith('/') ? `/api${key}` : `/api/${key}`);
	}
	return [...out].slice(0, 8);
}

function debug_pick_related_request_log(docs: ImperiumDoc[]): ImperiumDoc | null {
	if (!docs.length) return null;
	return docs.find((doc) => String(doc.level ?? '') === 'error') ?? docs[0] ?? null;
}

export async function debug_read_related(store: ImperiumStore, url: URL) {
	const route = debug_normalize_related_route(
		String(url.searchParams.get('route') ?? url.searchParams.get('url') ?? ''),
	);
	const method = String(url.searchParams.get('method') ?? '').trim().toUpperCase().slice(0, 10);
	if (!route || !method) {
		return ok([], 'Debes indicar `route` y `method` para localizar el log.');
	}
	const status_raw = Number(url.searchParams.get('status') ?? '');
	const status_code =
		Number.isFinite(status_raw) && status_raw >= 100 && status_raw <= 599
			? Math.trunc(status_raw)
			: undefined;
	const created_after = iso_or_empty(String(url.searchParams.get('created_after') ?? ''));
	const created_before = iso_or_empty(String(url.searchParams.get('created_before') ?? ''));
	const rows = await store.debug_log_related({
		routes: debug_related_route_candidates(route),
		method,
		status_code,
		created_after: created_after || undefined,
		created_before: created_before || undefined,
	});
	const related_log = debug_pick_related_request_log(rows);
	if (!related_log) return ok([], 'No se encontró un log relacionado.');
	return ok([related_log], 'Log relacionado encontrado');
}
