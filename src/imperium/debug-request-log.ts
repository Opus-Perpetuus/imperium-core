/**
 * Persiste cada request Imperium en `debug-log` con el mismo contrato
 * que DebugService.request + request_logger_middleware, y los niveles
 * info/error/warn del DebugService de aplicación.
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { broadcast_event } from './socket-stub.ts';

export type AppLogLevel =
	| 'error'
	| 'warning'
	| 'info'
	| 'success'
	| 'ok'
	| 'notice'
	| 'log'
	| 'debug';

const APP_LABELS: Record<AppLogLevel, string> = {
	error: 'ERROR',
	warning: 'WARNING',
	info: 'INFO',
	success: 'SUCCESS',
	ok: 'OK',
	notice: 'NOTICE',
	log: 'LOG',
	debug: 'DEBUG',
};

let bound_store: ImperiumStore | null = null;

export function bind_debug_store(store: ImperiumStore): void {
	bound_store = store;
}

export function debug_error(...args: unknown[]): void {
	void persist_app_log('error', args);
}

export function debug_warning(...args: unknown[]): void {
	void persist_app_log('warning', args);
}

export function debug_info(...args: unknown[]): void {
	void persist_app_log('info', args);
}

function format_log_arg(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === 'string') return value;
	if (value == null) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function capture_origin() {
	const lines = String(new Error().stack ?? '')
		.split('\n')
		.slice(1)
		.map((line) => line.trim())
		.filter(Boolean);
	const frame = lines.find((line) => !line.includes('debug-request-log')) ?? lines[0] ?? '';
	const match = frame.match(/\((.*):(\d+):(\d+)\)/) ?? frame.match(/at (.*):(\d+):(\d+)/);
	const file = match?.[1] ?? 'imperium/debug-request-log.ts';
	return {
		file,
		display: file.split('/').pop() ?? file,
		line: match?.[2] ? Number(match[2]) : null,
		column: match?.[3] ? Number(match[3]) : null,
		call_stack: lines.slice(0, 12),
	};
}

export async function persist_app_log(
	level: AppLogLevel,
	args: unknown[],
	store: ImperiumStore | null = bound_store,
): Promise<void> {
	if (!store?.has('debug-log')) return;
	const message = args.map(format_log_arg).filter(Boolean).join(' ').slice(0, 4000);
	if (!message) return;
	const origin = capture_origin();
	const label = APP_LABELS[level];
	const formatted = `[${label}] ${message}`;
	try {
		const logged = await store.insert('debug-log', {
			name: `${label} ${message}`.slice(0, 120),
			message,
			formatted_message: formatted,
			level,
			label,
			origin: {
				file: origin.file,
				display: origin.display,
				line: origin.line,
				column: origin.column,
			},
			call_stack: origin.call_stack,
			process: {
				pid: process.pid,
				node_env: process.env.NODE_ENV,
			},
			search_field: [level, label, message].join(' ').toLowerCase(),
		});
		broadcast_event('new_log', logged);
	} catch {
		/* logging must never fail the request */
	}
}

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
