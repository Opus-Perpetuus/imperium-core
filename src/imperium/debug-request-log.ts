/**
 * Persiste cada request Imperium en `debug-log` con el mismo contrato
 * que DebugService.request + request_logger_middleware.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { broadcast_event } from './socket-stub.ts';

export async function persist_request_log(
	store: ImperiumStore,
	req: Request,
	res: Response,
	actor: ImperiumDoc | null,
	started_ms: number,
): Promise<void> {
	if (req.method === 'OPTIONS') return;
	if (!store.has('debug-log')) return;
	const url = new URL(req.url);
	const route = strip_api(url.pathname) + url.search;
	if (is_noisy_path(route)) return;
	const status_code = res.status;
	let response_message = '';
	let response_code = '';
	try {
		const text = await res.text();
		if (text) {
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				response_message = String(parsed.message ?? parsed.error ?? '').trim();
				response_code = String(parsed.code ?? '').trim();
			} catch {
				response_message = text.replace(/\s+/g, ' ').trim().slice(0, 240);
			}
		}
	} catch {
		/* body already consumed / binary */
	}
	const duration_ms = Math.max(0, Date.now() - started_ms);
	const result = request_result(status_code, response_code);
	const result_label = result.toUpperCase();
	const status_group = status_group_of(status_code);
	const user_name = String(actor?.name ?? '').trim();
	const message = [
		route,
		`${result_label.padEnd(7, ' ')} ${status_code} ${duration_ms}ms | ${response_message || 'N/A'}`,
		`${user_name || 'No autenticado'} | origin: ${req.headers.get('origin') || 'N/A'}`,
	].join('\n');
	const request_context = {
		method: req.method,
		label: req.method,
		url: url.href,
		route,
		origin: req.headers.get('origin') || undefined,
		ip: req.headers.get('x-forwarded-for') || undefined,
		user_agent: req.headers.get('user-agent') || undefined,
		user: actor
			? {
					id: String(actor._id ?? actor.id ?? ''),
					name: user_name || undefined,
					email: String(actor.email ?? '') || undefined,
				}
			: undefined,
		response: {
			result,
			result_label,
			status_code,
			status_group,
			response_message: response_message || undefined,
			duration_ms,
		},
	};
	try {
		const logged = await store.insert('debug-log', {
			name: `${req.method} ${strip_api(url.pathname)}`,
			message,
			formatted_message: message,
			level: 'request',
			label: 'REQUEST',
			request_label: req.method,
			request_context,
			origin: {
				file: 'imperium/router.ts',
				display: 'router.ts',
			},
			call_stack: [],
			process: {
				pid: process.pid,
				node_env: process.env.NODE_ENV,
			},
			search_field: [
				req.method,
				route,
				response_message,
				user_name,
				String(actor?.email ?? ''),
			]
				.filter(Boolean)
				.join(' ')
				.toLowerCase(),
		});
		broadcast_event('new_log', logged);
	} catch {
		/* logging must never fail the request */
	}
}

function strip_api(pathname: string): string {
	if (pathname === '/api') return '/';
	if (pathname.startsWith('/api/')) return pathname.slice(4) || '/';
	return pathname;
}

function is_noisy_path(pathname: string): boolean {
	const path = pathname.split('?')[0] ?? pathname;
	return (
		path.startsWith('/socket.io') ||
		path.startsWith('/assets/') ||
		path === '/favicon.ico' ||
		path === '/debug-log' ||
		path.startsWith('/debug-log/')
	);
}

function request_result(status_code: number, response_code: string): string {
	if (status_code === 400 && response_code === 'user_pin_required') return 'warning';
	if (status_code >= 400) return 'error';
	if (status_code >= 300) return 'warning';
	if (status_code >= 200) return 'success';
	return 'info';
}

function status_group_of(status_code: number): string {
	if (status_code >= 500) return '5xx';
	if (status_code >= 400) return '4xx';
	if (status_code >= 300) return '3xx';
	if (status_code >= 200) return '2xx';
	if (status_code >= 100) return '1xx';
	return '0xx';
}
