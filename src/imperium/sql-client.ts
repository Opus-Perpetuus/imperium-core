const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_MAX = 20;
const DEFAULT_IDLE_TIMEOUT_S = 60;
const DEFAULT_CONNECT_TIMEOUT_S = 10;
const TERMINATED_BY_ADMIN = '57P01';

function positive_env(name: string): number | undefined {
	const value = Number(process.env[name] ?? '');
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function query_timeout_ms(override?: number): number {
	if (override != null && Number.isFinite(override) && override > 0) return override;
	const from_env = Number(process.env.CORE_SQL_TIMEOUT_MS ?? '');
	if (Number.isFinite(from_env) && from_env > 0) return from_env;
	return DEFAULT_QUERY_TIMEOUT_MS;
}

export function http_deadline_ms(): number {
	const from_env = Number(process.env.CORE_HTTP_DEADLINE_MS ?? '');
	if (Number.isFinite(from_env) && from_env > 0) return from_env;
	return query_timeout_ms() + 5_000;
}

export function with_deadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(deadline_error());
		}, ms);
	});
	return Promise.race([work, deadline]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export async function request_with_received_body(req: Request): Promise<Request> {
	if (req.body == null) return req;
	const bytes = new Uint8Array(await req.arrayBuffer());
	return new Request(req, { body: bytes });
}

function deadline_error(): Error & { status: number; code: string } {
	return Object.assign(new Error('La solicitud no terminó a tiempo'), {
		status: 503,
		code: 'http_deadline',
	});
}

function sql_timeout_error(): Error & { status: number; code: string } {
	return Object.assign(new Error('La base no respondió a tiempo'), {
		status: 503,
		code: 'sql_timeout',
	});
}

function error_code(err: unknown): string {
	if (!err || typeof err !== 'object' || !('code' in err)) return '';
	return String((err as { code?: unknown }).code ?? '');
}

function error_errno(err: unknown): string {
	if (!err || typeof err !== 'object' || !('errno' in err)) return '';
	return String((err as { errno?: unknown }).errno ?? '');
}

function error_message(err: unknown): string {
	return err instanceof Error ? err.message : String(err ?? '');
}

function is_poison(err: unknown): boolean {
	const message = error_message(err);
	const code = error_code(err);
	if (code === 'sql_timeout') return true;
	if (/failed to read data/i.test(message)) return true;
	if (/^ERR_POSTGRES_(CONNECTION_|IDLE_TIMEOUT|LIFETIME_TIMEOUT|UNSUPPORTED_|INVALID_)/.test(code))
		return true;
	if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNREFUSED') return true;
	if (error_errno(err) === TERMINATED_BY_ADMIN) return true;
	if (/bind message supplies \d+ parameters?, but prepared statement .* requires \d+/i.test(message))
		return true;
	return /bind message has \d+ result formats but query has \d+ columns/i.test(message);
}

function is_read_glitch(err: unknown): boolean {
	return error_code(err) !== 'sql_timeout' && is_poison(err);
}

function sql_read_failed(cause: unknown): Error & { status: number; code: string } {
	return Object.assign(new Error('No se pudo leer la respuesta de la base'), {
		status: 503,
		code: 'sql_read_failed',
		cause,
	});
}

function present(err: unknown): unknown {
	return is_read_glitch(err) ? sql_read_failed(err) : err;
}

// Un SELECT se puede repetir; un INSERT ya pudo ejecutarse en el servidor.
function is_idempotent_read(query: string): boolean {
	const stripped = query.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
	if (!/^(select|show|explain)\b/i.test(stripped)) return false;
	if (/\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|copy|call|do|into)\b/i.test(stripped))
		return false;
	return true;
}

function query_text(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
		return value.join(' ');
	}
	return '';
}

export type CorePoolOptions = {
	max: number;
	idle_timeout_s: number;
	connect_timeout_s: number;
};

export function core_pool_options(
	timeout_ms: number,
	overrides?: Partial<CorePoolOptions>,
): CorePoolOptions {
	const pick = (value: number | undefined, env: string, fallback: number) =>
		value != null && Number.isFinite(value) && value > 0 ? value : (positive_env(env) ?? fallback);
	const max = Math.max(1, Math.floor(pick(overrides?.max, 'CORE_SQL_POOL_MAX', DEFAULT_POOL_MAX)));
	const idle = pick(overrides?.idle_timeout_s, 'CORE_SQL_IDLE_TIMEOUT_S', DEFAULT_IDLE_TIMEOUT_S);
	const connect = pick(
		overrides?.connect_timeout_s,
		'CORE_SQL_CONNECT_TIMEOUT_S',
		DEFAULT_CONNECT_TIMEOUT_S,
	);
	return {
		max,
		// Bun.SQL corta la consulta en curso al vencer idleTimeout: nunca por debajo del tope de consulta.
		idle_timeout_s: Math.max(Math.ceil(idle), Math.ceil(timeout_ms / 1000)),
		connect_timeout_s: Math.ceil(connect),
	};
}

function connect(database_url: string, pool: CorePoolOptions, application_name: string): Bun.SQL {
	return new Bun.SQL(database_url, {
		max: pool.max,
		idleTimeout: pool.idle_timeout_s,
		connectionTimeout: pool.connect_timeout_s,
		// Bun 1.3 cuelga consultas con sentencias preparadas con nombre (IN de largo variable).
		prepare: false,
		connection: { application_name },
	});
}

export function open_core_sql(
	database_url: string,
	opts?: {
		query_timeout_ms?: number;
		max?: number;
		idle_timeout_s?: number;
		connect_timeout_s?: number;
		application_name?: string;
	},
): Bun.SQL {
	const timeout_ms = query_timeout_ms(opts?.query_timeout_ms);
	const pool = core_pool_options(timeout_ms, opts);
	const tag = `${(opts?.application_name ?? 'imperium-core').slice(0, 40)}:${crypto.randomUUID().slice(0, 8)}`;
	let generation = 0;
	const name_of = (gen: number) => `${tag}:${gen}`;
	let inner = connect(database_url, pool, name_of(generation));

	// close() espera a las consultas en curso; si el driver nunca resuelve, el pool viejo no suelta sus conexiones.
	function recycle(seen: number) {
		if (seen !== generation) return;
		const dead = inner;
		const dead_name = name_of(generation);
		generation += 1;
		inner = connect(database_url, pool, name_of(generation));
		void inner
			.unsafe(
				`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
				 WHERE application_name = $1 AND pid <> pg_backend_pid()`,
				[dead_name],
			)
			.catch(() => {})
			.finally(() => dead.close({ timeout: 0 }).catch(() => {}));
	}

	async function attempt<T>(op: (client: Bun.SQL) => Promise<T>): Promise<T> {
		const seen = generation;
		const client = inner;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timed_out = false;
		let pending: Promise<T> | undefined;
		try {
			pending = op(client);
			// El driver puede no resolver el promise aunque Postgres ya contestó.
			return await Promise.race([
				pending,
				new Promise<T>((_, reject) => {
					timer = setTimeout(() => {
						timed_out = true;
						reject(sql_timeout_error());
					}, timeout_ms);
				}),
			]);
		} catch (err) {
			if (timed_out || is_poison(err)) recycle(seen);
			throw err;
		} finally {
			if (timer) clearTimeout(timer);
			if (timed_out && pending) void Promise.resolve(pending).catch(() => {});
		}
	}

	async function run<T>(op: (client: Bun.SQL) => Promise<T>, query?: string): Promise<T> {
		try {
			return await attempt(op);
		} catch (err) {
			if (query && is_idempotent_read(query) && is_read_glitch(err)) {
				try {
					return await attempt(op);
				} catch (again) {
					throw present(again);
				}
			}
			throw present(err);
		}
	}

	const call = (args: unknown[]) => {
		const query = query_text(args[0]);
		return run((client) => {
			const fn = client as unknown as (...parts: unknown[]) => Promise<unknown>;
			return fn.apply(client, args);
		}, query);
	};

	return new Proxy(inner, {
		get(_target, prop) {
			if (prop === 'unsafe') {
				return (query: string, params?: unknown[]) =>
					run((client) => client.unsafe(query, params), query_text(query));
			}
			if (prop === 'begin') {
				return (fn: (tx: Bun.SQL) => Promise<unknown>) =>
					run((client) => client.begin(fn));
			}
			if (prop === 'close') {
				return (options?: { timeout?: number }) => inner.close(options);
			}
			const bag = inner as unknown as Record<PropertyKey, unknown>;
			const value = bag[prop];
			if (typeof value === 'function') {
				return (...args: unknown[]) => {
					const current = (inner as unknown as Record<PropertyKey, unknown>)[prop];
					return (current as (...a: unknown[]) => unknown).apply(inner, args);
				};
			}
			return value;
		},
		apply(_target, _thisArg, args) {
			return call(args);
		},
	}) as unknown as Bun.SQL;
}
