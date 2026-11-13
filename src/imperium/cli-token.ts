/**
 * Tokens de la CLI: varios por usuario (uno por dispositivo), Bearer `icli_`,
 * el mismo usuario y el mismo ACL que la GUI. No tocan los tokens MCP.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { can_enter_internal } from '@opus-perpetuus/imperium-core-kit';
import { as_object, caught_http_error, ok, type ImperiumDoc } from './envelope.ts';
import { read_imperium_body } from './body.ts';
import { build_access, current_user } from './auth.ts';
import type { ImperiumStore } from './store.ts';

export const CLI_MODEL_ID = 'ImperiumCli';
export const CLI_TOKEN_RESOURCE = 'cli-user-token';
export const CLI_TOKEN_PREFIX = 'icli_';
export const CLI_ACCESS_REF = 'imperium-cli-access-rights-0';

const FORBIDDEN_GENERIC = new Set(['ImperiumCli', 'CliUserToken', 'imperium-cli', 'cli-user-token']);

export function is_cli_token_plaintext(value: string): boolean {
	return value.startsWith(CLI_TOKEN_PREFIX);
}

export function extract_bearer(req: Request): string {
	const auth = req.headers.get('authorization') ?? '';
	const bearer = auth.match(/^\s*Bearer\s+(\S+)\s*$/i);
	return bearer?.[1]?.trim() ?? '';
}

export function hash_cli_token(plaintext: string): string {
	return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

function safe_equal_hex(a: string, b: string): boolean {
	try {
		const ba = Buffer.from(a, 'hex');
		const bb = Buffer.from(b, 'hex');
		if (ba.length !== bb.length) return false;
		return timingSafeEqual(ba, bb);
	} catch {
		return false;
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function cli_error(status: number, code: string, message: string): Response {
	return json({ ok: false, error: code, message }, status);
}

function deny(status: number, code: string, message: string): never {
	const error = new Error(message) as Error & { status?: number; code?: string };
	error.status = status;
	error.code = code;
	throw error;
}

export async function seed_cli_access(store: ImperiumStore): Promise<void> {
	if (!store.has('access-rights')) return;
	const existing = await store.find_where('access-rights', { _ref: CLI_ACCESS_REF });
	if (existing) return;
	await store.insert('access-rights', {
		name: 'CLI de Imperium | Conexión y tokens',
		description:
			'Permite iniciar sesión en la CLI con la misma cuenta de la GUI, generar, rotar y revocar tokens icli_.',
		_ref: CLI_ACCESS_REF,
		model_id: CLI_MODEL_ID,
		group_id: 'user-group-0',
		allow_read: true,
		allow_create: true,
		allow_update: true,
		allow_delete: true,
		is_active: true,
	});
}

/**
 * Cualquier usuario interno de la GUI puede usar la CLI con su mismo ACL.
 * El permiso ImperiumCli queda sembrado para el grupo administrador (como
 * McpAgent) y aparece en sus modelos; no se exige para cajeros u operadores.
 * Un usuario público o inactivo no entra.
 */
export async function has_cli_gate(store: ImperiumStore, user: ImperiumDoc): Promise<boolean> {
	if (!user || user.is_active === false) return false;
	if (!can_enter_internal(user)) return false;
	const access = await build_access(store, user);
	if (access.has_full_access) return true;
	const perms = access.permissions_by_model?.[CLI_MODEL_ID];
	if (perms && perms.allow_read === false) return false;
	return true;
}

export async function authenticate_cli_user(
	store: ImperiumStore,
	req: Request,
): Promise<ImperiumDoc | null> {
	const plaintext = extract_bearer(req);
	if (!plaintext || !is_cli_token_plaintext(plaintext)) return null;
	const token_hash = hash_cli_token(plaintext);
	if (!store.has(CLI_TOKEN_RESOURCE)) return null;
	const consider = (row: ImperiumDoc) => {
		const stored = String(row.token_hash ?? '');
		if (!stored || !safe_equal_hex(stored, token_hash)) return false;
		if (row.is_active === false || row.revoked_at) return false;
		if (row.expires_at) {
			const exp = new Date(String(row.expires_at)).getTime();
			if (Number.isFinite(exp) && exp < Date.now()) return false;
		}
		return true;
	};
	let token_doc =
		(await store.find_where(CLI_TOKEN_RESOURCE, { token_hash }).catch(() => null)) ?? null;
	if (token_doc && !consider(token_doc)) token_doc = null;
	if (!token_doc) {
		for await (const page of store.scan(CLI_TOKEN_RESOURCE, {
			mongo_match: { token_hash },
			include_inactive: true,
		})) {
			token_doc = page.find(consider) ?? null;
			if (token_doc) break;
		}
	}
	if (!token_doc) return null;
	const user = await store.find_id('user', String(token_doc.user_id ?? ''));
	if (!user || user.is_active === false) return null;
	const last = token_doc.last_used_at ? new Date(String(token_doc.last_used_at)).getTime() : 0;
	if (Date.now() - last > 60_000) {
		await store.update(CLI_TOKEN_RESOURCE, String(token_doc._id), {
			last_used_at: new Date().toISOString(),
		});
	}
	return user;
}

async function active_tokens(store: ImperiumStore, user_id: string): Promise<ImperiumDoc[]> {
	if (!store.has(CLI_TOKEN_RESOURCE)) return [];
	const rows: ImperiumDoc[] = [];
	for await (const page of store.scan(CLI_TOKEN_RESOURCE, {
		mongo_match: { user_id },
		include_inactive: true,
	})) {
		for (const row of page) {
			if (String(row.user_id ?? '') !== user_id) continue;
			if (row.is_active === false || row.revoked_at) continue;
			rows.push(row);
		}
	}
	return rows;
}

function public_token_row(row: ImperiumDoc) {
	return {
		id: String(row._id ?? ''),
		has_token: true,
		token_prefix: row.token_prefix,
		name: row.name,
		device_name: row.device_name ?? null,
		created_at: row.createdAt ?? row.created_at ?? null,
		last_used_at: row.last_used_at ?? null,
		expires_at: row.expires_at ?? null,
	};
}

async function token_status(store: ImperiumStore, user: ImperiumDoc) {
	const active = await active_tokens(store, String(user._id));
	if (!active.length) {
		return ok([{ has_token: false, tokens: [] }], 'Sin tokens CLI activos');
	}
	return ok(
		[
			{
				has_token: true,
				tokens: active.map(public_token_row),
			},
		],
		active.length === 1 ? 'Token CLI activo' : `${active.length} tokens CLI activos`,
	);
}

async function revoke_matching(
	store: ImperiumStore,
	user: ImperiumDoc,
	match?: { id?: string; token_prefix?: string; name?: string; bearer?: string },
): Promise<ImperiumDoc[]> {
	const now = new Date().toISOString();
	const active = await active_tokens(store, String(user._id));
	const bearer_hash = match?.bearer ? hash_cli_token(match.bearer) : '';
	const selected = active.filter((row) => {
		if (!match || (!match.id && !match.token_prefix && !match.name && !match.bearer)) {
			return true;
		}
		if (match.id && String(row._id) === match.id) return true;
		if (match.token_prefix && String(row.token_prefix ?? '') === match.token_prefix) return true;
		if (match.name && String(row.name ?? '') === match.name) return true;
		if (bearer_hash && safe_equal_hex(String(row.token_hash ?? ''), bearer_hash)) return true;
		return false;
	});
	for (const row of selected) {
		await store.update(CLI_TOKEN_RESOURCE, String(row._id), {
			is_active: false,
			revoked_at: now,
		});
	}
	return selected;
}

async function issue_token(
	store: ImperiumStore,
	user: ImperiumDoc,
	body: Record<string, unknown>,
	message: string,
) {
	const name =
		typeof body.name === 'string' && body.name.trim()
			? body.name.trim()
			: typeof body.device_name === 'string' && body.device_name.trim()
				? body.device_name.trim()
				: 'Token personal CLI';
	const device_name =
		typeof body.device_name === 'string' && body.device_name.trim()
			? body.device_name.trim()
			: name;
	const plaintext = `${CLI_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
	const token_hash = hash_cli_token(plaintext);
	const token_prefix = plaintext.slice(0, 12);
	const row = await store.insert(CLI_TOKEN_RESOURCE, {
		name,
		device_name,
		description: 'Token personal para la CLI de Imperium',
		user_id: String(user._id),
		token_hash,
		token_prefix,
		is_active: true,
		revoked_at: null,
		last_used_at: null,
		expires_at: null,
		created_by: String(user._id),
	});
	return ok(
		[
			{
				token: plaintext,
				token_prefix,
				id: String(row._id ?? ''),
				name,
				device_name,
				message,
			},
		],
		message,
	);
}

export function is_cli_token_resource(resource: string): boolean {
	return FORBIDDEN_GENERIC.has(resource);
}

export async function handle_cli_token(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
): Promise<Response> {
	const path = url.pathname.replace(/^\/api/, '') || '/';
	const rest = path.replace(/^\/cli/, '') || '/';
	const method = req.method.toUpperCase();

	const actor = await current_user(sql, req);
	if (!actor) {
		return cli_error(401, 'not_authenticated', 'Debes iniciar sesión o enviar un token CLI vigente.');
	}
	if (!(await has_cli_gate(store, actor))) {
		return cli_error(
			403,
			'cli_gate_denied',
			'Tu usuario no puede usar la CLI de Imperium. Contacta a un administrador.',
		);
	}

	try {
		if (method === 'GET' && (rest === '/token/status' || rest === '/token/status/')) {
			return json(await token_status(store, actor));
		}
		if (method === 'POST' && (rest === '/token/generate' || rest === '/token/generate/')) {
			const body = await read_imperium_body(req);
			return json(
				await issue_token(
					store,
					actor,
					as_object(body),
					'Token CLI generado. Cópialo ahora; no se volverá a mostrar.',
				),
			);
		}
		if (method === 'POST' && (rest === '/token/rotate' || rest === '/token/rotate/')) {
			const body = as_object(await read_imperium_body(req));
			const selector = {
				id: typeof body.id === 'string' ? body.id : undefined,
				token_prefix: typeof body.token_prefix === 'string' ? body.token_prefix : undefined,
				name: typeof body.name === 'string' ? body.name : undefined,
				bearer: extract_bearer(req) || undefined,
			};
			const has_selector = Boolean(
				selector.id || selector.token_prefix || selector.name || selector.bearer,
			);
			if (!has_selector) {
				const active = await active_tokens(store, String(actor._id));
				if (active.length !== 1) {
					deny(
						400,
						'ambiguous_token',
						'Indica el id, el nombre o el token a rotar; hay varios tokens CLI activos.',
					);
				}
				selector.id = String(active[0]!._id);
			}
			const revoked = await revoke_matching(store, actor, selector);
			if (!revoked.length) {
				deny(404, 'not_found', 'No se encontró un token CLI activo para rotar.');
			}
			const kept = {
				name: typeof body.name === 'string' && body.name.trim() ? body.name : String(revoked[0]?.name ?? ''),
				device_name:
					typeof body.device_name === 'string' && body.device_name.trim()
						? body.device_name
						: String(revoked[0]?.device_name ?? revoked[0]?.name ?? ''),
			};
			return json(
				await issue_token(
					store,
					actor,
					kept,
					'Token CLI rotado. El anterior ya no es válido. Cópialo ahora.',
				),
			);
		}
		if (method === 'POST' && (rest === '/token/revoke' || rest === '/token/revoke/')) {
			const body = as_object(await read_imperium_body(req).catch(() => ({})));
			const all = body.all === true || body.all === 'true';
			const revoked = await revoke_matching(store, actor, all
				? undefined
				: {
						id: typeof body.id === 'string' ? body.id : undefined,
						token_prefix: typeof body.token_prefix === 'string' ? body.token_prefix : undefined,
						name: typeof body.name === 'string' ? body.name : undefined,
						bearer: extract_bearer(req) || undefined,
					});
			return json(
				ok(
					[{ revoked: revoked.length, ids: revoked.map((row) => String(row._id)) }],
					revoked.length ? 'Token CLI revocado' : 'No había token CLI activo que coincidiera',
				),
			);
		}
		return cli_error(404, 'not_found', 'Ruta CLI no encontrada');
	} catch (err) {
		const mapped = caught_http_error(err);
		return cli_error(mapped.status, mapped.code ?? 'error', mapped.message);
	}
}
