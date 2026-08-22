/**
 * Agente MCP de Imperium: tokens de perfil + API v1 con Bearer.
 * Replica `mcp-agent.token.service` y `mcp-agent.operations.service`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { as_object, ok, type ImperiumDoc } from './envelope.ts';
import { read_imperium_body } from './body.ts';
import { build_access, current_user } from './auth.ts';
import type { ExtraCol, ImperiumStore } from './store.ts';
import { register_comment_mentions } from './notifications.ts';
import {
	assert_record_in_scope,
	record_rule_lookup_keys,
	record_rule_scope_from_access,
} from './record-rules.ts';

const MODEL_ID = 'McpAgent';
const TOKEN_PREFIX = 'isic_';
const TOKEN_HEADER = 'x-imperium-sic-token';
const ACCESS_REF = 'mcp-agent-access-rights-0';
const FORBIDDEN = new Set(['McpAgent', 'McpUserToken', 'mcp-agent', 'mcp-user-token']);
const SENSITIVE = /(password|pass|^pin$|token|hash|secret|reset_password)/i;
const INTERNAL = new Set([
	'_id',
	'id',
	'__v',
	'createdAt',
	'updatedAt',
	'created_by',
	'_ref',
	'search_field',
	'is_active',
	'sequence',
]);

export async function handle_mcp_agent(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
): Promise<Response> {
	const path = url.pathname.replace(/^\/api/, '') || '/';
	const rest = path.replace(/^\/mcp-agent/, '') || '/';
	const method = req.method.toUpperCase();

	if (rest === '/v1' || rest.startsWith('/v1/')) {
		return handle_v1(store, sql, req, url, rest.slice('/v1'.length) || '/', method);
	}

	const actor = await current_user(sql, req);
	if (!actor) {
		return mcp_error(401, 'not_authenticated', 'Debes iniciar sesión para gestionar el token MCP.');
	}
	if (method === 'GET' && rest === '/gate') {
		const has_gate = await has_mcp_gate(store, actor);
		return json(
			ok(
				[{ has_mcp_gate: has_gate, model_id: MODEL_ID }],
				has_gate ? 'Tienes acceso a la conexión MCP' : 'Sin acceso a la conexión MCP',
			),
		);
	}
	if (method === 'GET' && rest === '/token/status') {
		await assert_gate(store, actor, 'read');
		return json(await token_status(store, actor));
	}
	if (method === 'POST' && rest === '/token/generate') {
		await assert_gate(store, actor, 'create');
		const body = await read_imperium_body(req);
		return json(
			await issue_token(
				store,
				actor,
				body,
				'Token MCP generado. Cópialo ahora; no se volverá a mostrar.',
			),
		);
	}
	if (method === 'POST' && rest === '/token/rotate') {
		await assert_gate(store, actor, 'update');
		const body = await read_imperium_body(req);
		return json(
			await issue_token(
				store,
				actor,
				body,
				'Token MCP rotado. El anterior ya no es válido. Cópialo ahora.',
			),
		);
	}
	if (method === 'POST' && rest === '/token/revoke') {
		await assert_gate(store, actor, 'delete');
		return json(await revoke_tokens(store, actor));
	}
	return mcp_error(404, 'not_found', 'Ruta MCP no encontrada');
}

export async function seed_mcp_access(store: ImperiumStore): Promise<void> {
	if (!store.has('access-rights')) return;
	const existing = await store.find_where('access-rights', { _ref: ACCESS_REF });
	if (existing) return;
	await store.insert('access-rights', {
		name: 'Agente MCP | Conexión y tokens',
		description:
			'Permite ver el token en el perfil, generar/rotar/revocar y conectar un cliente MCP.',
		_ref: ACCESS_REF,
		model_id: MODEL_ID,
		group_id: 'user-group-0',
		allow_read: true,
		allow_create: true,
		allow_update: true,
		allow_delete: true,
		is_active: true,
	});
}

async function handle_v1(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
	rest: string,
	method: string,
): Promise<Response> {
	const auth = await authenticate_token(store, req);
	if (auth instanceof Response) return auth;
	const { user } = auth;
	const access = await build_access(store, user);
	if (!(await has_mcp_gate(store, user))) {
		return mcp_error(
			403,
			'mcp_gate_denied',
			'Tu usuario ya no tiene permiso de conexión MCP. Contacta a un administrador.',
		);
	}
	const segs = rest.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	try {
		if (method === 'GET' && segs[0] === 'whoami' && segs.length === 1) {
			return json(
				ok(
					[
						{
							user: {
								_id: user._id,
								name: user.name,
								email: user.email,
								_ref: user._ref,
							},
							groups: access.user_group_names ?? [],
							group_refs: access.user_group_refs ?? [],
							mcp_gate: true,
							has_full_access: Boolean(access.has_full_access),
							tip: 'Siguiente paso: llama a capabilities para ver qué módulos puedes leer/crear/editar.',
						},
					],
					'Identidad MCP',
				),
			);
		}
		if (method === 'GET' && segs[0] === 'capabilities' && segs.length === 1) {
			return json(await capabilities(store, access));
		}
		if (method === 'GET' && segs[0] === 'models' && segs[2] === 'describe' && segs[1]) {
			return json(await describe_model(store, access, segs[1]));
		}
		if (method === 'POST' && segs[0] === 'models' && segs[2] === 'prepare_create' && segs[1]) {
			const body = await read_imperium_body(req);
			const values = as_object(body.values ?? body);
			return json(await prepare_create(store, access, segs[1], values));
		}
		if (method === 'POST' && segs[0] === 'search' && segs.length === 1) {
			const body = await read_imperium_body(req);
			return json(await search_records(store, access, user, body));
		}
		if (method === 'POST' && segs[0] === 'count' && segs.length === 1) {
			const body = await read_imperium_body(req);
			return json(await count_records(store, access, user, body));
		}
		if (method === 'GET' && segs[0] === 'statistics' && segs[1] && segs.length === 2) {
			return json(await statistics(store, access, user, segs[1]));
		}
		if (method === 'GET' && segs[0] === 'records' && segs[1] && segs[2] && segs.length === 3) {
			return json(await get_record(store, access, user, segs[1], segs[2]));
		}
		if (method === 'POST' && segs[0] === 'records' && segs[1] && segs.length === 2) {
			const body = await read_imperium_body(req);
			const values = as_object(body.values ?? body);
			return json(await create_record(store, access, user, segs[1], values));
		}
		if (method === 'PATCH' && segs[0] === 'records' && segs[1] && segs[2] && segs.length === 3) {
			const body = await read_imperium_body(req);
			const values = as_object(body.values ?? body);
			return json(await update_record(store, access, user, segs[1], segs[2], values));
		}
		if (
			method === 'GET' &&
			segs[0] === 'records' &&
			segs[3] === 'history' &&
			segs[1] &&
			segs[2]
		) {
			const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
			return json(await get_history(store, access, user, segs[1], segs[2], limit));
		}
		if (
			method === 'POST' &&
			segs[0] === 'records' &&
			segs[3] === 'comments' &&
			segs[1] &&
			segs[2]
		) {
			const body = await read_imperium_body(req);
			return json(
				await post_comment(
					store,
					access,
					user,
					segs[1],
					segs[2],
					String(body.comment_text ?? body.commentText ?? body.comment ?? ''),
				),
			);
		}
		return mcp_error(404, 'not_found', 'Ruta MCP v1 no encontrada');
	} catch (err) {
		const e = err as Error & { status?: number; code?: string };
		return mcp_error(e.status ?? 400, e.code ?? 'error', e.message);
	}
}

type Access = Awaited<ReturnType<typeof build_access>>;

function deny(status: number, code: string, message: string): never {
	const error = new Error(message) as Error & { status?: number; code?: string };
	error.status = status;
	error.code = code;
	throw error;
}

async function has_mcp_gate(store: ImperiumStore, user: ImperiumDoc): Promise<boolean> {
	const access = await build_access(store, user);
	if (access.has_full_access) return true;
	const perms = access.permissions_by_model?.[MODEL_ID];
	return Boolean(perms?.allow_read) || access.models.map(String).includes(MODEL_ID);
}

async function assert_gate(
	store: ImperiumStore,
	user: ImperiumDoc,
	op: 'read' | 'create' | 'update' | 'delete',
): Promise<void> {
	const access = await build_access(store, user);
	if (access.has_full_access) return;
	const perms = access.permissions_by_model?.[MODEL_ID] ?? {
		allow_read: false,
		allow_create: false,
		allow_update: false,
		allow_delete: false,
	};
	const ok_op =
		(op === 'read' && perms.allow_read) ||
		(op === 'create' && perms.allow_create) ||
		(op === 'update' && perms.allow_update) ||
		(op === 'delete' && perms.allow_delete);
	if (!ok_op) {
		deny(
			403,
			'mcp_gate_denied',
			'No tienes permiso para usar la conexión MCP. Pide a un administrador que te agregue al grupo con acceso al asistente MCP.',
		);
	}
}

function hash_token(plaintext: string): string {
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

function extract_token(req: Request): string {
	const auth = req.headers.get('authorization') ?? '';
	const bearer = auth.match(/^\s*Bearer\s+(\S+)\s*$/i);
	if (bearer?.[1]) return bearer[1].trim();
	return (req.headers.get(TOKEN_HEADER) ?? '').trim();
}

async function active_tokens(store: ImperiumStore, user_id: string) {
	if (!store.has('mcp-user-token')) return [];
	const { rows } = await store.find_many('mcp-user-token', {
		take: 200,
		include_inactive: true,
	});
	return rows.filter(
		(row) =>
			String(row.user_id ?? '') === user_id &&
			row.is_active !== false &&
			!row.revoked_at,
	);
}

async function token_status(store: ImperiumStore, user: ImperiumDoc) {
	const active = (await active_tokens(store, String(user._id)))[0];
	if (!active) {
		return ok([{ has_token: false }], 'Sin token MCP activo');
	}
	return ok(
		[
			{
				has_token: true,
				token_prefix: active.token_prefix,
				name: active.name,
				created_at: active.createdAt,
				last_used_at: active.last_used_at ?? null,
				expires_at: active.expires_at ?? null,
			},
		],
		'Token MCP activo',
	);
}

async function revoke_tokens(store: ImperiumStore, user: ImperiumDoc) {
	const now = new Date().toISOString();
	const active = await active_tokens(store, String(user._id));
	for (const row of active) {
		await store.update('mcp-user-token', String(row._id), {
			is_active: false,
			revoked_at: now,
		});
	}
	return ok(
		[{ revoked: active.length > 0 }],
		active.length > 0 ? 'Token MCP revocado' : 'No había token MCP activo',
	);
}

async function issue_token(
	store: ImperiumStore,
	user: ImperiumDoc,
	body: Record<string, unknown>,
	message: string,
) {
	await revoke_tokens(store, user);
	const name =
		typeof body.name === 'string' && body.name.trim()
			? body.name.trim()
			: 'Token personal MCP';
	const plaintext = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
	const token_hash = hash_token(plaintext);
	const token_prefix = plaintext.slice(0, 12);
	await store.insert('mcp-user-token', {
		name,
		description: 'Token personal para el servidor MCP de Imperium SIC',
		user_id: String(user._id),
		token_hash,
		token_prefix,
		is_active: true,
		revoked_at: null,
		last_used_at: null,
		expires_at: null,
		created_by: String(user._id),
	});
	const public_base = String(process.env.IMPERIUM_SIC_MCP_PUBLIC_URL ?? '')
		.replace(/\/+$/, '') || 'http://127.0.0.1:3858/mcp';
	return ok(
		[
			{
				token: plaintext,
				token_prefix,
				mcp_url_hint: `${public_base}?tk=${plaintext}`,
				message,
			},
		],
		message,
	);
}

async function authenticate_token(
	store: ImperiumStore,
	req: Request,
): Promise<{ user: ImperiumDoc } | Response> {
	const plaintext = extract_token(req);
	if (!plaintext) {
		return mcp_error(
			401,
			'not_authenticated',
			'Falta el token MCP. Envía Authorization: Bearer <token> o el header X-Imperium-Sic-Token.',
		);
	}
	const token_hash = hash_token(plaintext);
	const { rows } = store.has('mcp-user-token')
		? await store.find_many('mcp-user-token', { take: 2000, include_inactive: true })
		: { rows: [] as ImperiumDoc[] };
	const token_doc = rows.find((row) => {
		const stored = String(row.token_hash ?? '');
		if (!stored || !safe_equal_hex(stored, token_hash)) return false;
		if (row.is_active === false || row.revoked_at) return false;
		if (row.expires_at) {
			const exp = new Date(String(row.expires_at)).getTime();
			if (Number.isFinite(exp) && exp < Date.now()) return false;
		}
		return true;
	});
	if (!token_doc) {
		return mcp_error(
			401,
			'invalid_token',
			'Token MCP inválido, revocado o expirado. Genera uno nuevo en tu perfil.',
		);
	}
	const user = await store.find_id('user', String(token_doc.user_id ?? ''));
	if (!user || user.is_active === false) {
		return mcp_error(
			401,
			'invalid_token',
			'Token MCP inválido, revocado o expirado. Genera uno nuevo en tu perfil.',
		);
	}
	const last = token_doc.last_used_at ? new Date(String(token_doc.last_used_at)).getTime() : 0;
	if (Date.now() - last > 60_000) {
		await store.update('mcp-user-token', String(token_doc._id), {
			last_used_at: new Date().toISOString(),
		});
	}
	return { user };
}

function resolve_resource(store: ImperiumStore, model_id: string): string {
	const raw = String(model_id || '').trim();
	if (!raw) deny(400, 'missing_model', 'Debes indicar el modelo (model).');
	if (FORBIDDEN.has(raw)) {
		deny(403, 'model_forbidden', 'Ese modelo no es operable por el agente MCP.');
	}
	if (store.has(raw)) return raw;
	const collapsed = raw.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
	for (const loc of store.all_locs) {
		if (loc.resource.replace(/-/g, '') === collapsed) return loc.resource;
		if (loc.name.replace(/[^A-Za-z0-9]/g, '').toLowerCase() === collapsed) {
			return loc.resource;
		}
	}
	deny(
		404,
		'unknown_model',
		`No existe el modelo "${raw}". Usa sic_capabilities para ver modelos disponibles.`,
	);
}

function can(access: Access, resource: string, op: 'read' | 'create' | 'update') {
	if (access.has_full_access) return true;
	const perms =
		access.permissions_by_model?.[resource] ??
		access.permissions_by_model?.[pascal(resource)];
	if (!perms) return access.models.map(String).includes(resource);
	if (op === 'read') return Boolean(perms.allow_read);
	if (op === 'create') return Boolean(perms.allow_create);
	return Boolean(perms.allow_update);
}

function require_perm(access: Access, resource: string, op: 'read' | 'create' | 'update') {
	if (!can(access, resource, op)) {
		deny(403, 'access_denied', `No tienes permiso para esta operación en ${resource}.`);
	}
}

function pascal(resource: string) {
	return resource
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

function sanitize(payload: Record<string, unknown>) {
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (INTERNAL.has(key) || SENSITIVE.test(key) || key.startsWith('__')) continue;
		clean[key] = value;
	}
	delete clean.sequence;
	return clean;
}

async function capabilities(store: ImperiumStore, access: Access) {
	const modules = store.has('module-management')
		? (await store.find_many('module-management', { take: 2000, include_inactive: true }))
				.rows
		: [];
	const enabled = modules.filter(
		(mod) => mod.is_enable === true || mod.is_enable === undefined,
	);
	const list: ImperiumDoc[] = [];
	for (const mod of enabled) {
		const model_id = String(mod.model_id ?? '').trim();
		if (!model_id || FORBIDDEN.has(model_id)) continue;
		let resource = '';
		try {
			resource = resolve_resource(store, model_id);
		} catch {
			continue;
		}
		const can_read = can(access, resource, 'read') || can(access, model_id, 'read');
		const can_create = can(access, resource, 'create') || can(access, model_id, 'create');
		const can_update = can(access, resource, 'update') || can(access, model_id, 'update');
		if (!can_read && !can_create && !can_update) continue;
		list.push({
			model: model_id,
			name: mod.name,
			description: mod.description,
			module_name: mod.module_name,
			path: mod.path,
			collection: store.loc(resource).collection,
			can_read,
			can_create,
			can_update,
			can_delete: false,
			enabled: true,
		});
	}
	list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
	return ok(list, `${list.length} modelos operables con tus permisos`);
}

function title_label(field: string, label?: string) {
	if (label?.trim()) return label.trim();
	return field.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function describe_type(
	col: ExtraCol | undefined,
	ref?: string,
): { type: string; is_array: boolean } {
	if (ref) {
		const arr =
			/ids$|_ids$/i.test(col?.name ?? '') ||
			Boolean(col?.component?.includes('array')) ||
			col?.pg === 'json';
		return arr
			? { type: 'array<objectid>', is_array: true }
			: { type: 'objectid', is_array: false };
	}
	const hint = `${col?.crud ?? ''} ${col?.pg ?? ''} ${col?.component ?? ''}`.toLowerCase();
	if (hint.includes('boolean') || hint.includes('checkbox')) {
		return { type: 'boolean', is_array: false };
	}
	if (
		hint.includes('number') ||
		hint.includes('int') ||
		hint.includes('numeric') ||
		hint.includes('double')
	) {
		return { type: 'number', is_array: false };
	}
	if (hint.includes('date') || hint.includes('time')) return { type: 'date', is_array: false };
	if (hint.includes('json')) return { type: 'mixed', is_array: false };
	return { type: 'string', is_array: false };
}

function describe_fields(store: ImperiumStore, resource: string) {
	const loc = store.loc(resource);
	const refs = store.field_refs(resource);
	const by_name = new Map(loc.columns.map((col) => [col.name, col]));
	const names = ['name', 'description', 'is_active', ...loc.columns.map((col) => col.name)].filter(
		(name, i, all) =>
			all.indexOf(name) === i &&
			!INTERNAL.has(name) &&
			!SENSITIVE.test(name) &&
			name !== 'payload' &&
			name !== 'custom_data',
	);
	const fields = names.map((field) => {
		const col = by_name.get(field);
		const ref = refs[field];
		const typed = describe_type(col, ref);
		return {
			field,
			label: title_label(field, col?.label),
			type: typed.type,
			required: field === 'name',
			ref,
			is_array: typed.is_array,
		};
	});
	fields.sort((a, b) => {
		if (a.required !== b.required) return a.required ? -1 : 1;
		return a.field.localeCompare(b.field);
	});
	return fields;
}

function mcp_read_scope(access: Access, actor: ImperiumDoc, resource: string, model_id: string) {
	return record_rule_scope_from_access(
		access,
		actor,
		record_rule_lookup_keys(resource, model_id),
		'allow_read',
	);
}

function split_mcp_filters(filters: Record<string, unknown>) {
	const where: Record<string, unknown> = {};
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(filters)) {
		if (key === 'is_active' || value === undefined) continue;
		if (key.startsWith('$') || (value && typeof value === 'object')) extra[key] = value;
		else where[key] = value;
	}
	return { where, extra };
}

function merge_mongo_match(
	rule: Record<string, unknown> | null,
	extra: Record<string, unknown>,
): Record<string, unknown> | null {
	const has_extra = Object.keys(extra).length > 0;
	if (rule && has_extra) return { $and: [rule, extra] };
	if (rule) return rule;
	if (has_extra) return extra;
	return null;
}

async function describe_model(store: ImperiumStore, access: Access, model_id: string) {
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'read');
	const fields = describe_fields(store, resource);
	return ok(
		[
			{
				model: model_id,
				collection: store.loc(resource).collection,
				fields,
				required_fields: fields.filter((f) => f.required).map((f) => f.field),
				optional_fields: fields.filter((f) => !f.required).map((f) => f.field),
				guidance: {
					create:
						'Para altas conversacionales usa prepare_create con los valores que ya sepas; pregunta al usuario solo required_missing. Los opcionales se pueden omitir.',
					count: "Para 'cuántos…' usa count con filters (p. ej. status en estados abiertos del enum).",
				},
			},
		],
		`Esquema de ${model_id}`,
	);
}

async function prepare_create(
	store: ImperiumStore,
	access: Access,
	model_id: string,
	values: Record<string, unknown>,
) {
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'create');
	const fields = describe_fields(store, resource);
	const clean = sanitize(values);
	const required_missing = fields.filter(
		(field) =>
			field.required &&
			(clean[field.field] === undefined || clean[field.field] === null || clean[field.field] === ''),
	);
	const optional_suggested = fields
		.filter(
			(field) =>
				!field.required &&
				(clean[field.field] === undefined || clean[field.field] === '') &&
				/status|priority|description|name|phone|email/i.test(field.field),
		)
		.slice(0, 12);
	return ok(
		[
			{
				model: model_id,
				preview: clean,
				required_missing,
				optional_suggested,
				ready: required_missing.length === 0,
				next_step:
					required_missing.length === 0
						? 'Listo para create_record con estos valores (puedes añadir opcionales antes).'
						: `Pregunta al usuario por: ${required_missing.map((f) => f.label).join(', ')}.`,
			},
		],
		required_missing.length ? 'Faltan campos obligatorios' : 'Listo para crear',
	);
}

async function search_records(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	body: Record<string, unknown>,
) {
	const model_id = String(body.model ?? '');
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'read');
	const limit_raw = Number(body.limit);
	const limit = !Number.isFinite(limit_raw) || limit_raw <= 0 ? 20 : Math.min(Math.floor(limit_raw), 100);
	const skip = Math.max(0, Number(body.skip) || 0);
	const filters = as_object(body.filters);
	const { where, extra } = split_mcp_filters(filters);
	const scope = mcp_read_scope(access, user, resource, model_id);
	const { rows, total } = await store.find_many(resource, {
		q: String(body.q ?? '').trim(),
		skip,
		take: limit,
		include_inactive: filters.is_active === false,
		where: Object.keys(where).length ? where : undefined,
		mongo_match: merge_mongo_match(scope.match, extra),
	});
	return ok(rows, `${rows.length} de ${total} registros`, total);
}

async function count_records(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	body: Record<string, unknown>,
) {
	const model_id = String(body.model ?? '');
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'read');
	const filters = as_object(body.filters);
	const { where, extra } = split_mcp_filters(filters);
	const scope = mcp_read_scope(access, user, resource, model_id);
	const { total } = await store.find_many(resource, {
		q: String(body.q ?? '').trim(),
		take: 1,
		include_inactive: filters.is_active === false,
		where: Object.keys(where).length ? where : undefined,
		mongo_match: merge_mongo_match(scope.match, extra),
	});
	return ok([{ model: model_id, count: total }], `${total} registro(s) en ${model_id}`);
}

async function statistics(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	model_id: string,
) {
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'read');
	const scope = mcp_read_scope(access, user, resource, model_id);
	const stats = await store.stats(resource, new URL('http://local/'), scope.match);
	return ok([stats], 'Estadísticas obtenidas correctamente');
}

async function get_record(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	model_id: string,
	id: string,
) {
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'read');
	const doc = await store.find_id(resource, id);
	if (!doc) deny(404, 'not_found', 'Registro no encontrado');
	const scope = mcp_read_scope(access, user, resource, model_id);
	await assert_record_in_scope(store, resource, id, scope, 'GET');
	return ok([doc], 'Registro encontrado');
}

async function create_record(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	model_id: string,
	values: Record<string, unknown>,
) {
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'create');
	const created = await store.insert(resource, {
		...sanitize(values),
		created_by: String(user._id),
	});
	return ok([created], 'Registro creado');
}

async function update_record(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	model_id: string,
	id: string,
	values: Record<string, unknown>,
) {
	const resource = resolve_resource(store, model_id);
	require_perm(access, resource, 'update');
	const existing = await store.find_id(resource, id);
	if (!existing) deny(404, 'not_found', 'Registro no encontrado');
	const scope = record_rule_scope_from_access(
		access,
		user,
		record_rule_lookup_keys(resource, model_id),
		'allow_update',
	);
	await assert_record_in_scope(store, resource, id, scope, 'PATCH');
	const updated = await store.update(resource, id, sanitize(values));
	if (!updated) deny(404, 'not_found', 'Registro no encontrado');
	return ok([updated], 'Actualizado correctamente');
}

async function get_history(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	model_id: string,
	id: string,
	limit: number,
) {
	await get_record(store, access, user, model_id, id);
	const resource = resolve_resource(store, model_id);
	const { rows } = await store.find_many('document-change-history', {
		take: 2000,
		include_inactive: true,
	});
	const matched = rows
		.filter(
			(row) =>
				String(row.documentId ?? row.document_id ?? row.record_id ?? '') === id &&
				(!row.modelName ||
					String(row.modelName) === model_id ||
					String(row.modelName) === resource),
		)
		.slice(0, limit);
	return ok(
		matched,
		matched.length
			? 'Historial obtenido correctamente'
			: 'No se encontraron cambios para este registro',
	);
}

async function post_comment(
	store: ImperiumStore,
	access: Access,
	user: ImperiumDoc,
	model_id: string,
	id: string,
	comment_text: string,
) {
	await get_record(store, access, user, model_id, id);
	const text = comment_text.trim();
	if (!text) deny(400, 'empty_comment', 'El comentario no puede estar vacío.');
	const resource = resolve_resource(store, model_id);
	const created = await store.insert('document-change-history', {
		name: 'comentario',
		entryType: 'comment',
		comment: text,
		commentText: text,
		actionName: 'Comentario',
		model: model_id,
		modelName: model_id,
		collectionName: store.loc(resource).collection,
		documentId: id,
		record_id: id,
		operationType: 'comment',
		created_by: String(user._id),
	});
	await register_comment_mentions(store, user, {
		comment_text: text,
		model_name: model_id,
		collection_name: store.loc(resource).collection,
		document_id: id,
		history_id: String(created._id),
		route: `/mcp-agent/${model_id}/${id}`,
		entity_label: model_id,
	});
	return ok([created], 'Comentario registrado correctamente');
}

function json(body: unknown, status = 200) {
	return Response.json(body, { status });
}

function mcp_error(status: number, code: string, message: string) {
	return Response.json({ ok: false, error: code, message }, { status });
}
