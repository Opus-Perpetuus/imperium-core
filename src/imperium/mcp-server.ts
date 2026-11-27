/**
 * MCP Streamable HTTP sin estado en el núcleo: un POST, una respuesta JSON.
 * Las herramientas salen de `build_access` en cada petición.
 */
import { createHash } from 'node:crypto';
import { build_access } from './auth.ts';
import { request_ip } from './auth-rate-limit.ts';
import { persist_app_log } from './debug-request-log.ts';
import { caught_http_error, type ImperiumDoc } from './envelope.ts';
import { CORE_VERSION } from './health.ts';
import {
	authenticate_isic_token,
	capabilities,
	has_mcp_gate,
	mcp_can_read,
	search_records,
} from './mcp-agent.ts';
import { rate_limited_response, take_token, type BucketRule } from './rate-bucket.ts';
import type { ImperiumStore } from './store.ts';

const PROTOCOL = '2025-03-26';
export const MCP_RATE: BucketRule = { capacity: 60, refill_per_s: 1 };

const SENSITIVE = /(password|pass|^pin$|token|hash|secret|reset_password)/i;

type Access = Awaited<ReturnType<typeof build_access>>;

type Audit = {
	usuario: string;
	token: string;
	metodo: string;
	herramienta: string;
	modelo: string;
	ids: string;
	resultado: string;
};

export async function handle_mcp(store: ImperiumStore, req: Request, url: URL): Promise<Response> {
	const audit: Audit = {
		usuario: '-',
		token: '-',
		metodo: '-',
		herramienta: '-',
		modelo: '-',
		ids: '-',
		resultado: '-',
	};
	const finish = async (res: Response, resultado: string): Promise<Response> => {
		audit.resultado = resultado;
		await write_audit(store, audit);
		return res;
	};

	if (url.searchParams.has('tk') || url.searchParams.has('token')) {
		return finish(http_error(400, 'token_in_url', 'El token MCP va en el header Authorization, no en la URL.'), 'token_en_url');
	}
	if (!origin_allowed(req)) {
		return finish(http_error(403, 'origin_denied', 'El origen de esta petición no está permitido.'), '403');
	}
	if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
	if (req.method !== 'POST') {
		return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed', message: 'MCP solo acepta POST.' }), {
			status: 405,
			headers: { 'content-type': 'application/json', allow: 'POST' },
		});
	}

	const plaintext = bearer(req);
	if (!plaintext) {
		return finish(
			http_error(401, 'not_authenticated', 'Falta el token MCP. Envía Authorization: Bearer <token>.'),
			'401',
		);
	}
	audit.token = plaintext.startsWith('isic_') ? plaintext.slice(0, 12) : '-';
	if (!plaintext.startsWith('isic_')) {
		return finish(
			http_error(401, 'invalid_token', 'Token MCP inválido, revocado o expirado. Genera uno nuevo en tu perfil.'),
			'401',
		);
	}

	const auth = await authenticate_isic_token(store, plaintext);
	if (auth instanceof Response) return finish(auth, '401');
	audit.usuario = String(auth.user._id ?? '-');
	audit.token = auth.token_prefix || audit.token;

	const limited = take_token(rate_key(plaintext, request_ip(req)), MCP_RATE);
	if (!limited.ok) return finish(rate_limited_response(limited.retry_after_s), '429');
	if (!(await has_mcp_gate(store, auth.user))) {
		return finish(
			http_error(
				403,
				'mcp_gate_denied',
				'Tu usuario ya no tiene permiso de conexión MCP. Contacta a un administrador.',
			),
			'403',
		);
	}

	const parsed = await read_message(req);
	if (parsed instanceof Response) return finish(parsed, '400');
	const method = typeof parsed.method === 'string' ? parsed.method : '';
	audit.metodo = safe_label(method);
	if (method === 'notifications/initialized') {
		return finish(new Response(null, { status: 202 }), '202');
	}
	if (!Object.hasOwn(parsed, 'id')) {
		return finish(new Response(null, { status: 202 }), '202');
	}
	const id = parsed.id ?? null;
	const params = as_params(parsed.params);

	if (method === 'initialize') {
		return finish(
			json_result(id, {
				protocolVersion: PROTOCOL,
				capabilities: { tools: {} },
				serverInfo: { name: 'imperium', version: CORE_VERSION },
			}),
			'ok',
		);
	}
	if (method === 'ping') return finish(json_result(id, {}), 'ok');

	const access = await build_access(store, auth.user);
	if (method === 'tools/list') {
		return finish(json_result(id, { tools: await tool_list(store, access) }), 'ok');
	}
	if (method === 'tools/call') {
		const name = typeof params.name === 'string' ? params.name : '';
		audit.herramienta = safe_label(name);
		const tools = await tool_list(store, access);
		if (!tools.some((tool) => tool.name === name)) {
			return finish(json_error(id, -32602, `Herramienta desconocida: ${name || '(sin nombre)'}`), 'error');
		}
		try {
			const called = await call_tool(store, access, auth.user, name, as_params(params.arguments));
			audit.modelo = called.modelo;
			audit.ids = called.ids;
			return finish(
				json_result(id, {
					content: [{ type: 'text', text: JSON.stringify(called.payload) }],
					isError: called.is_error,
				}),
				called.is_error ? 'error' : 'ok',
			);
		} catch (err) {
			const mapped = caught_http_error(err);
			return finish(
				json_result(id, {
					content: [{ type: 'text', text: mapped.message }],
					isError: true,
				}),
				'error',
			);
		}
	}
	return finish(json_error(id, -32601, `Método no soportado: ${method || '(vacío)'}`), 'error');
}

type McpTool = {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties: Record<string, unknown>;
		required?: string[];
	};
};

async function tool_list(store: ImperiumStore, access: Access): Promise<McpTool[]> {
	const models = await readable_models(store, access);
	const tools: McpTool[] = [
		{
			name: 'imperium_quien_soy',
			description: 'Usuario de este token, sus grupos y si tiene la puerta MCP.',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: 'imperium_modelos',
			description: 'Modelos que este usuario puede leer.',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: 'imperium_buscar',
			description: 'Busca registros de un modelo que el usuario puede leer.',
			inputSchema: {
				type: 'object',
				properties: {
					modelo: {
						type: 'string',
						description: 'Modelo o recurso',
						...(models.length ? { enum: models } : {}),
					},
					buscar: { type: 'string', description: 'Texto' },
					limite: { type: 'integer', description: 'Máximo 100. Si se omite, 20.' },
					filtros: { type: 'object', description: 'Filtros de igualdad' },
				},
				required: ['modelo'],
			},
		},
	];
	if (contacto_visible(store, access)) {
		tools.push({
			name: 'contactos_buscar',
			description: 'Busca contactos visibles para este usuario.',
			inputSchema: {
				type: 'object',
				properties: {
					buscar: { type: 'string', description: 'Texto' },
					limite: { type: 'integer', description: 'Máximo 100. Si se omite, 20.' },
					filtros: { type: 'object', description: 'Filtros de igualdad' },
				},
			},
		});
	}
	return tools;
}

async function readable_models(store: ImperiumStore, access: Access): Promise<string[]> {
	const listed = await capabilities(store, access);
	const contacto = contacto_visible(store, access);
	const ids = new Set<string>();
	for (const row of listed.data) {
		if (row.can_read !== true || !row.model) continue;
		const model = String(row.model);
		if (model.toLowerCase() === 'contacto' && !contacto) continue;
		ids.add(model);
	}
	if (contacto) ids.add('contacto');
	return [...ids].sort((a, b) => a.localeCompare(b, 'es'));
}

function contacto_visible(store: ImperiumStore, access: Access): boolean {
	if (!store.has('contacto') || !store.is_resource_installed('contacto')) return false;
	return mcp_can_read(access, 'contacto');
}

async function call_tool(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	name: string,
	args: Record<string, unknown>,
): Promise<{ payload: unknown; is_error: boolean; modelo: string; ids: string }> {
	if (name === 'imperium_quien_soy') {
		return {
			is_error: false,
			modelo: '-',
			ids: '-',
			payload: redact({
				user: { _id: user._id, name: user.name, email: user.email, _ref: user._ref },
				groups: access.user_group_names ?? [],
				group_refs: access.user_group_refs ?? [],
				mcp_gate: true,
				has_full_access: Boolean(access.has_full_access),
			}),
		};
	}
	if (name === 'imperium_modelos') {
		const listed = await capabilities(store, access);
		return {
			is_error: false,
			modelo: '-',
			ids: '-',
			payload: redact(listed.data.filter((row) => row.can_read === true)),
		};
	}
	if (name === 'imperium_buscar' || name === 'contactos_buscar') {
		const modelo = name === 'contactos_buscar' ? 'contacto' : String(args.modelo ?? '').trim();
		if (!modelo) {
			return { is_error: true, modelo: '-', ids: '-', payload: 'Debes indicar el modelo.' };
		}
		const allowed = await readable_models(store, access);
		if (!allowed.includes(modelo)) {
			return { is_error: true, modelo: safe_label(modelo), ids: '-', payload: 'Ese modelo no está en tus permisos de lectura.' };
		}
		const found = await search_records(store, access, user, {
			model: modelo,
			q: args.buscar ?? '',
			limit: args.limite,
			skip: args.desde,
			filters: args.filtros ?? {},
		});
		const payload = redact({ total: found.total_elementos, registros: found.data });
		return { is_error: false, modelo: safe_label(modelo), ids: record_ids(payload), payload };
	}
	return { is_error: true, modelo: '-', ids: '-', payload: 'Herramienta desconocida.' };
}

function record_ids(payload: unknown): string {
	if (!payload || typeof payload !== 'object') return '-';
	const registros = (payload as { registros?: unknown }).registros;
	if (!Array.isArray(registros)) return '-';
	const ids = registros
		.map((row) => {
			if (!row || typeof row !== 'object') return '';
			return String((row as { _id?: unknown })._id ?? '');
		})
		.filter(Boolean)
		.slice(0, 20);
	return ids.length ? ids.join(',') : '-';
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (!value || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (SENSITIVE.test(key)) continue;
		out[key] = redact(item);
	}
	return out;
}

function safe_label(value: string): string {
	const text = value.trim();
	if (!text || text.length > 80 || /[\s=]/.test(text)) return '-';
	return text;
}

function bearer(req: Request): string | null {
	const header = req.headers.get('authorization') ?? '';
	const match = header.match(/^\s*Bearer\s+(\S+)\s*$/i);
	return match?.[1] ?? null;
}

function rate_key(plaintext: string, ip: string): string {
	const hash = createHash('sha256').update(plaintext).digest('hex');
	return `mcp:${hash}:${ip}`;
}

/**
 * Un nombre que solo existe en el DNS del cliente no es el origen del núcleo:
 * en local se acepta loopback contra loopback, y el resto tiene que coincidir
 * con el host de esta petición o con la lista ya configurada del núcleo.
 */
function origin_allowed(req: Request): boolean {
	const origin = req.headers.get('origin');
	if (!origin) return true;
	let from: URL;
	try {
		from = new URL(origin);
	} catch {
		return false;
	}
	const hosts = request_hosts(req);
	if (hosts.includes(from.host.toLowerCase())) return true;
	if (is_loopback(from.hostname) && hosts.some((host) => is_loopback(host.replace(/:\d+$/, '')))) return true;
	return configured_origins().includes(from.origin);
}

function request_hosts(req: Request): string[] {
	const hosts = [new URL(req.url).host];
	if (trusts_proxy()) {
		const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
		if (forwarded) hosts.push(forwarded);
	}
	return hosts.filter(Boolean).map((host) => host.toLowerCase());
}

function trusts_proxy(): boolean {
	const raw = String(process.env.TRUST_PROXY_HEADERS ?? '').trim().toLowerCase();
	return raw === '1' || raw === 'true' || raw === 'yes';
}

function is_loopback(hostname: string): boolean {
	const name = hostname.toLowerCase();
	return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

function configured_origins(): string[] {
	return String(process.env.IMPERIUM_SOCKET_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((allowed) => allowed.trim().replace(/\/+$/, ''))
		.filter(Boolean);
}

async function read_message(req: Request): Promise<Record<string, unknown> | Response> {
	const text = await req.text();
	if (!text.trim()) return json_error(null, -32600, 'Solicitud vacía', 400);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return json_error(null, -32700, 'JSON no válido', 400);
	}
	if (Array.isArray(parsed) || !parsed || typeof parsed !== 'object') {
		return json_error(null, -32600, 'Una petición, un mensaje', 400);
	}
	const msg = parsed as Record<string, unknown>;
	if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !msg.method) {
		return json_error(msg.id ?? null, -32600, 'Solicitud no válida', 400);
	}
	return msg;
}

function as_params(value: unknown): Record<string, unknown> {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
	return {};
}

function json_result(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: '2.0', id, result });
}

function json_error(id: unknown, code: number, message: string, status = 200): Response {
	return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });
}

function http_error(status: number, code: string, message: string): Response {
	return Response.json({ ok: false, error: code, message }, { status });
}

async function write_audit(store: ImperiumStore, audit: Audit): Promise<void> {
	const line = [
		'mcp',
		`usuario=${audit.usuario}`,
		`token=${audit.token}`,
		`metodo=${audit.metodo}`,
		`herramienta=${audit.herramienta}`,
		`modelo=${audit.modelo}`,
		`ids=${audit.ids}`,
		`resultado=${audit.resultado}`,
	].join(' ');
	try {
		await persist_app_log('info', [line], store);
	} catch {
		/* la bitácora no tumba la llamada */
	}
}
