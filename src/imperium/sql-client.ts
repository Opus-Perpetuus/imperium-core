const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

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

function pool_max(override?: number): number {
	if (override != null && Number.isFinite(override) && override >= 1) return Math.floor(override);
	return 10;
}

function connect(database_url: string, max: number): Bun.SQL {
	return new Bun.SQL(database_url, {
		max,
		// Bun 1.3.14 mata la consulta en curso si idleTimeout es mayor que 0.
		idleTimeout: 0,
		connectionTimeout: 10,
	});
}

export function open_core_sql(
	database_url: string,
	opts?: { query_timeout_ms?: number; max?: number },
): Bun.SQL {
	const timeout_ms = query_timeout_ms(opts?.query_timeout_ms);
	const max = pool_max(opts?.max);
	let inner = connect(database_url, max);
	let generation = 0;

	function recycle(seen: number) {
		if (seen !== generation) return;
		generation += 1;
		const dead = inner;
		inner = connect(database_url, max);
		void dead.close({ timeout: 0 }).catch(() => {});
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
