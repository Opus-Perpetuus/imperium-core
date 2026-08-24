/**
 * Auth Imperium: login/sesión/menús contra `user` + `access-rights` + `menu-management`.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { read_imperium_body } from './body.ts';
import { PREFER_OWNER, type ImperiumStore } from './store.ts';
import {
	email_is_configured,
	resolve_email_settings,
	send_password_reset_email,
} from './email.ts';
import { find_user_by_reset_token, generate_password_reset } from './password-reset.ts';
import {
	consume_login_limits,
	consume_password_reset_ip_limit,
	consume_password_reset_request_limits,
	ensure_auth_rate_limit_table,
	normalize_auth_rate_limit_email,
	request_ip,
} from './auth-rate-limit.ts';
import {
	access_flag,
	build_model_denied_message,
	load_record_rules_by_model,
	record_rule_lookup_keys,
	type RecordRuleOperationFlag,
} from './record-rules.ts';
import { debug_error, debug_info } from './debug-request-log.ts';
import { report_archived_login_attempt } from './archived-login-alert.ts';

const COOKIE = 'connect.sid';
const SECRET = process.env.SESSION_SECRET ?? 'imperium-modular-dev-session';
const SEED_ADMIN_REF = 'user-menu-management-0';

function id_list(value: unknown): string[] {
	return as_array(value)
		.map((item) => {
			if (item && typeof item === 'object') {
				const rec = item as Record<string, unknown>;
				return String(rec._id ?? rec.id ?? '');
			}
			return String(item ?? '');
		})
		.filter(Boolean);
}

type Session = {
	id: string;
	user: ImperiumDoc;
	expires: number;
};

const memory = new Map<string, Session>();

export async function ensure_session_table(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.imperium_sessions (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
	await ensure_auth_rate_limit_table(sql);
}

export async function handle_auth(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
): Promise<Response | null> {
	const path = url.pathname;
	if (!path.startsWith('/auth')) return null;
	const method = req.method.toUpperCase();
	const rest = path.slice('/auth'.length) || '/';

	if (method === 'POST' && (rest === '/login' || rest === '/login/')) {
		const body = await read_imperium_body(req);
		const email = normalize_auth_rate_limit_email(body.email);
		const password = String(body.password ?? '');
		const limited = await consume_login_limits(sql, email, request_ip(req));
		if (limited) {
			return Response.json(limited, { status: 429 });
		}
		if (!email || !password) {
			return Response.json(
				{ message: 'Usuario o contraseña no válido', error: 'Usuario o contraseña no válido' },
				{ status: 400 },
			);
		}
		const user = await store.find_where('user', { email });
		const hash = String(user?.password ?? '');
		const ok_pw = user && user.is_active !== false && hash
			? await verify_password(password, hash)
			: await dummy_verify();
		if (!ok_pw || !user || user.is_active === false) {
			if (user && user.is_active === false) {
				debug_error('Usuario no encontrado o inactivo');
				await report_archived_login_attempt(store, user);
			}
			return Response.json(
				{ message: 'Usuario o contraseña incorrectos', error: 'Usuario o contraseña incorrectos' },
				{ status: 401 },
			);
		}
		const safe = public_user(user);
		const session = await create_session(sql, safe);
		debug_info('Sesión guardada correctamente');
		const access_rights = await build_access(store, safe);
		const menus = await build_menus(store, access_rights);
		return with_cookie(
			Response.json({ user: safe, menus, access_rights }),
			session.id,
		);
	}

	if (
		method === 'POST' &&
		(rest === '/logout' || rest === '/logout/' || rest === '/' || rest === '')
	) {
		const sid = read_sid(req);
		if (sid) await destroy_session(sql, sid);
		return with_cookie(Response.json({ ok: true }), '', true);
	}
	if (method === 'DELETE' && (rest === '/' || rest === '')) {
		const sid = read_sid(req);
		if (sid) await destroy_session(sql, sid);
		return with_cookie(Response.json({ ok: true }), '', true);
	}

	if (method === 'POST' && rest.startsWith('/password-reset/request')) {
		const body = await read_imperium_body(req);
		const email = normalize_auth_rate_limit_email(body.email);
		const limited = await consume_password_reset_request_limits(sql, email, request_ip(req));
		if (limited) {
			return Response.json(limited, { status: 429 });
		}
		const user = email ? await store.find_where('user', { email }) : null;
		if (user && user.is_active !== false) {
			const settings = await resolve_email_settings(store);
			const origin = req.headers.get('origin') ?? '';
			const generated = await generate_password_reset(store, user, 'recovery', settings, origin);
			if (email_is_configured(settings)) {
				try {
					await send_password_reset_email({
						settings,
						to: String(user.email ?? email),
						link: generated.link,
						kind: 'recovery',
						user_name: String(user.name ?? ''),
					});
				} catch {
					/* la respuesta al cliente debe ser genérica */
				}
			}
		}
		return Response.json({
			message:
				'Si el correo está registrado, te enviaremos un enlace para recuperar tu contraseña.',
		});
	}
	if (method === 'GET' && rest.startsWith('/password-reset/validate')) {
		const limited = await consume_password_reset_ip_limit(sql, request_ip(req));
		if (limited) {
			return Response.json(limited, { status: 429 });
		}
		const codigo = String(url.searchParams.get('codigo') ?? '').trim();
		const user = await find_user_by_reset_token(store, codigo);
		return Response.json({
			valid: Boolean(user),
			type: user ? String(user.reset_password_kind ?? 'recovery') : null,
		});
	}
	if (method === 'GET' && rest.startsWith('/branding')) {
		if (rest.startsWith('/branding/logo')) {
			return branding_logo(store);
		}
		return branding_json(store);
	}

	if (method === 'POST' && rest.startsWith('/password-reset/login')) {
		const limited = await consume_password_reset_ip_limit(sql, request_ip(req));
		if (limited) {
			return Response.json(limited, { status: 429 });
		}
		const body = await read_imperium_body(req);
		const codigo = String(body.codigo ?? '').trim();
		const user = await find_user_by_reset_token(store, codigo);
		if (!user) {
			return Response.json(
				{
					message: 'El enlace no es válido o ya expiró.',
					error: 'El enlace no es válido o ya expiró.',
				},
				{ status: 400 },
			);
		}
		await store.update('user', String(user._id), {
			reset_password_token_hash: null,
			reset_password_expires: null,
			reset_password_kind: null,
			recovery_token: null,
			recovery_expires: null,
		});
		const safe = public_user(user);
		const session = await create_session(sql, safe);
		const access_rights = await build_access(store, safe);
		const menus = await build_menus(store, access_rights);
		return with_cookie(
			Response.json({ user: safe, menus, access_rights }),
			session.id,
		);
	}

	const session = await load_session(sql, req);
	if (!session) {
		return Response.json({ error: 'No estás autenticado', message: 'No estás autenticado' }, { status: 401 });
	}

	if (method === 'GET' && (rest === '/' || rest === '')) {
		return Response.json(session.user);
	}
	if (method === 'GET' && rest.startsWith('/menus')) {
		const access_rights = await build_access(store, session.user);
		const menus = await build_menus(store, access_rights);
		return Response.json({ menus, access_rights });
	}
	return Response.json(session.user);
}

export async function current_user(
	sql: Bun.SQL,
	req: Request,
): Promise<ImperiumDoc | null> {
	const s = await load_session(sql, req);
	return s?.user ?? null;
}

function public_user(user: ImperiumDoc): ImperiumDoc {
	const {
		password: _p,
		reset_password_token_hash: _h,
		reset_password_expires: _e,
		reset_password_kind: _k,
		recovery_token: _rt,
		recovery_expires: _re,
		...rest
	} = user;
	return rest;
}

async function verify_password(plain: string, hash: string): Promise<boolean> {
	try {
		if (await Bun.password.verify(plain, hash)) return true;
	} catch {
		/* hashes de node-argon2 a veces no los acepta Bun.password */
	}
	try {
		const argon2 = await import('argon2');
		return await argon2.verify(hash, plain);
	} catch {
		return false;
	}
}

async function dummy_verify(): Promise<boolean> {
	try {
		const dummy = await Bun.password.hash('imperium-dummy-login', 'argon2id');
		await Bun.password.verify('x', dummy);
	} catch {
		/* ignore */
	}
	return false;
}

async function create_session(sql: Bun.SQL, user: ImperiumDoc): Promise<Session> {
	const id = crypto.randomUUID();
	const expires = Date.now() + 7 * 24 * 3600 * 1000;
	const session: Session = { id, user, expires };
	memory.set(id, session);
	await sql.unsafe(
		`INSERT INTO public.imperium_sessions (id, payload, expires_at)
     VALUES ($1, $2::jsonb, to_timestamp($3 / 1000.0))
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
		[id, JSON.stringify(user), expires],
	);
	return session;
}

async function destroy_session(sql: Bun.SQL, id: string): Promise<void> {
	memory.delete(id);
	await sql.unsafe(`DELETE FROM public.imperium_sessions WHERE id = $1`, [id]);
}

async function load_session(sql: Bun.SQL, req: Request): Promise<Session | null> {
	const id = read_sid(req);
	if (!id) return null;
	const mem = memory.get(id);
	if (mem && mem.expires > Date.now()) return mem;
	const rows = await sql.unsafe(
		`SELECT payload, extract(epoch from expires_at) * 1000 AS exp FROM public.imperium_sessions WHERE id = $1`,
		[id],
	);
	const row = rows[0] as { payload: unknown; exp: number } | undefined;
	if (!row || Number(row.exp) < Date.now()) return null;
	const user = as_object(row.payload) as ImperiumDoc;
	const session: Session = { id, user, expires: Number(row.exp) };
	memory.set(id, session);
	return session;
}

function read_sid(req: Request): string {
	const raw = req.headers.get('cookie') ?? '';
	const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
	return m ? decodeURIComponent(m[1]!) : '';
}

function with_cookie(res: Response, sid: string, clear = false): Response {
	const headers = new Headers(res.headers);
	if (clear || !sid) {
		headers.append('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
	} else {
		headers.append(
			'set-cookie',
			`${COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
		);
	}
	return new Response(res.body, { status: res.status, headers });
}

export async function build_access(store: ImperiumStore, user: ImperiumDoc) {
	const is_admin = user._ref === SEED_ADMIN_REF;
	if (is_admin) {
		const models = [...new Set([...store.all_locs.map((l) => l.resource), 'McpAgent'])];
		return {
			access_granted: true,
			has_full_access: true,
			has_user_groups: false,
			models,
			menu_ids: [] as string[],
			user_group_ids: [] as string[],
			user_group_refs: [] as string[],
			permissions_by_model: {},
			record_rules_by_model: {},
			user_group_names: [] as string[],
			allowed_groups: [] as string[],
			message: 'Permisos del usuario calculados correctamente',
			model: '',
			method: 'Leer',
		};
	}
	const groups = store.has('user-group')
		? (
				await store.find_many('user-group', {
					mongo_match: { user_ids: { $regex: String(user._id) } },
					take: 20000,
					include_inactive: false,
				})
			).rows.filter((g) => id_list(g.user_ids).includes(String(user._id)))
		: [];
	const user_group_reference_ids = new Set(
		groups.flatMap((g) => [String(g._id ?? ''), String(g._ref ?? '')].filter(Boolean)),
	);
	const user_group_access_right_ids = new Set<string>();
	for (const g of groups) {
		for (const id of id_list(g.access_rights_ids)) user_group_access_right_ids.add(id);
	}
	const all_groups = store.has('user-group')
		? (await store.find_many('user-group', { take: 20000, include_inactive: false })).rows
		: [];
	const access_right_ids_assigned_to_any_group = new Set<string>();
	for (const g of all_groups) {
		for (const id of id_list(g.access_rights_ids)) {
			access_right_ids_assigned_to_any_group.add(id);
		}
	}
	const rights = store.has('access-rights')
		? (await store.find_many('access-rights', { take: 20000, include_inactive: false })).rows
		: [];
	const mine = rights.filter((r) => {
		const rid = String(r._id ?? '');
		const gid = String(r.group_id ?? '').trim();
		const belongs =
			user_group_access_right_ids.has(rid) ||
			(Boolean(gid) && user_group_reference_ids.has(gid));
		if (groups.length) return belongs;
		return !gid && !access_right_ids_assigned_to_any_group.has(rid);
	});
	const models = [...new Set(mine.filter((r) => access_flag(r.allow_read)).map((r) => String(r.model_id)))];
	const permissions_by_model: Record<string, Record<string, boolean>> = {};
	for (const r of mine) {
		const mid = String(r.model_id ?? '');
		if (!mid) continue;
		const cur = permissions_by_model[mid] ?? {
			allow_read: false,
			allow_create: false,
			allow_update: false,
			allow_delete: false,
		};
		cur.allow_read ||= access_flag(r.allow_read);
		cur.allow_create ||= access_flag(r.allow_create);
		cur.allow_update ||= access_flag(r.allow_update);
		cur.allow_delete ||= access_flag(r.allow_delete);
		permissions_by_model[mid] = cur;
	}
	return {
		access_granted: true,
		has_full_access: false,
		has_user_groups: groups.length > 0,
		models,
		menu_ids: [] as string[],
		user_group_ids: groups.map((g) => String(g._id)),
		user_group_refs: groups.map((g) => String(g._ref ?? '')).filter(Boolean),
		permissions_by_model,
		record_rules_by_model: await load_record_rules_by_model(store, groups),
		user_group_names: groups.map((g) => String(g.name ?? '')),
		allowed_groups: [] as string[],
		message: 'Permisos del usuario calculados correctamente',
		model: '',
		method: 'Leer',
	};
}

const PUBLIC_EXTRA_ACTIONS = new Set([
	'read_public_metadata',
	'create_public_ticket',
	'public_catalog',
	'public_checkout',
	'public_session',
	'public_contrato',
	'public_url',
	'stripe_webhook',
	'mitec_webhook',
	'receive_interinstance_message',
	'receive_interinstance_ticket',
	// El router original de reports va `secured: false` (module.config
	// add_router(..., false)) para preview HTML / placeholders.
	'get_image_base64',
	'get_first_record',
	'get_model_fields',
	'get_model_fields_detailed',
	'get_model_records',
	'get_model_record_by_id',
	'get_pdf_direct_target',
	'validate_template',
	'generate_pdf',
	'generate_full_report_pdf',
	'process_preview',
	'print_pdf_direct',
]);

/** Extras del original que solo exigen sesión (el handler acota al usuario). */
const SESSION_SCOPED_EXTRAS = new Set([
	'notifications:read_my_summary',
	'notifications:read_my_notifications',
	'notifications:read_my_mentions',
	'notifications:create_toast_digest',
	'notifications:mark_all_as_read',
	'notifications:update_read_status',
	'notifications:apply_action',
	'notifications:clear_my_notifications',
	'notifications:delete_notification',
	'messages:read_my_messages',
	'messages:read_my_conversations',
	'messages:read_conversation',
	'messages:search_chat_messages',
	'messages:create_chat_message',
	'messages:create_internal_message',
	'messages:create_interinstance_message',
	'interactive-manual:board',
	'view-config-preset:available',
	'view-config-preset:baseline',
	'interface-restriction:runtime_read',
	'document-change-history:read_history',
	'document-change-history:read_history_by_id',
	'document-change-history:create_comment',
	'documentation-page:read_all',
	'documentation-page:get_structure',
	'documentation-page:search',
	'documentation-page:check_sync_status',
	'documentation-page:sync_documents',
	'documentation-page:read_by_slug',
	'documentation-page:get_adjacent',
	'documentation-page:read_by_id',
	'attachment-management:view',
	'user-pin:verify',
	'tickets:read_my_tickets',
	'tickets:read_admin_tickets',
	'tickets:read_admin_ticket',
	'tickets:read_ticket_field_values',
	'tickets:create_internal_ticket',
	'tickets:create_error_ticket',
	'tickets:create_log_ticket',
	'tickets:create_interinstance_ticket',
	'tickets:read_received_interinstance_tickets',
	'tickets:update_ticket',
	'debug-log:read_logs',
	'debug-log:get_statistics',
	'debug-log:read_related_request_log',
	'debug-log:read_log_by_id',
	'user-settings:get',
	'user-settings:upsert',
	'user-settings:set_global_default_theme',
	'user-settings:save_table_config',
	'user-settings:list_custom_themes',
	'user-settings:create_custom_theme',
	'user-settings:update_custom_theme',
	'user-settings:delete_custom_theme',
	'reports:get_first_record',
	'reports:get_model_fields',
	'reports:get_model_fields_detailed',
	'reports:get_model_records',
	'reports:get_model_record_by_id',
	'reports:validate_template',
	'reports:get_image_base64',
	'reports:generate_pdf',
	'reports:generate_full_report_pdf',
	'reports:get_pdf_direct_target',
	'reports:print_pdf_direct',
	'reports:process_preview',
	'lista-de-precios:sync_offline',
	'sku:sync_offline',
	'medical-file:read_pending',
	'medical-file:read_for_doctor',
	'delivery-package:read_offline_catalog',
	'delivery-package:read_load_manifest',
	'delivery-package:read_by_pedido',
	'delivery-package:read_chofer_queue',
	'delivery-package:close_empaque',
	'delivery-package:apply_logistics_event',
	'delivery-package:cancel_package',
	'pedidos:sync_offline',
	'pedidos:reclamar_surtir',
	'physical-device:report',
	'pos-session:get_next_consecutive',
	'pos-session:get_last_closure_reference',
	'pos-session:save_runtime_state',
	'pos-session:generate_partial_report',
	'pos-session:generate_close_report',
	'pos-session:conclude_close_report',
	'pos-session:cancel_open_session',
	'ticketing-system-turn:take_next_turn',
	'ticketing-system-turn:notify_turn',
	'ticketing-system-turn:end_attending_turn',
	'citizen-report:reverse_geocode',
	'purchase-order:approve',
	'purchase-order:register_receipt',
	'purchase-order:register_invoice',
	'purchase-order:confirm',
	'purchase-order:replenish_from_order',
	'purchase-order:parse_document',
	'cfdi-catalog:lookup',
	'cfdi-catalog:search',
	'cfdi-document:from_invoice_request',
	'cfdi-document:from_payroll_receipt',
	'cfdi-document:from_purchase_order',
	'cfdi-document:validate_document',
	'cfdi-document:stamp_document',
	'cfdi-document:export_xml',
	'cfdi-document:export_json',
	'invoice-request:generate_from_order',
	'invoice-request:authorize',
	'invoice-request:send_to_commercial',
	'invoice-request:mark_invoiced',
	'invoice-request:link_cfdi_document',
	'invoice-request:request_cfdi_draft',
	'invoice-request:cancel_request',
	'delivery-route:read_route_map',
	'delivery-route:read_chofer_routes',
	'delivery-route:optimize_route',
	'delivery-route:read_driver_location',
	'delivery-return:recibir',
	'lista-asistencia:mark_attendance',
	'cobranza:lookup',
	'cobranza:checkout',
	'inventory-internal-location:import_tree',
	'inventory-movement:register_transfer',
	'inventory-physical-count:import_apertura',
	'inventory-physical-count:aplicar',
	'inventory-reception:read_in_transit',
	'inventory-reception:read_pending_for_product',
	'inventory-reception:create_from_purchase_order',
	'inventory-reception:confirm_reception',
	'inventory-reception:create_backorder',
	'inventory-reception:acomodar',
	'inventory-reception:reservar',
	'inventory-stock-quant:read_picking_route',
	'inventory-stock-quant:validar_consistencia',
	'payroll-period:generate_drafts',
	'payroll-receipt:prepare_stamp',
	'payroll-receipt:export_payload',
	'configuration:ai_generate_text',
	'model-tracker:get_all_models',
	'model-tracker:get_search_engine_status',
	'model-tracker:read_field_values_globally',
	'auto-increment-control:preview',
	'auto-increment-control:get_available_models',
	'auto-increment-control:increment',
	'auto-increment-control:consolidate_duplicates',
	'auto-increment-control:normalize_counters',
	'custom-pattern-increment-sequence-parts:get_by_counter_config',
	'status-option-control:save_module_configuration',
	'status-option-control:normalize_state_values',
	'status-option-control:resolve_spurious_options',
]);

function is_session_scoped_extra(resource?: string, action?: string) {
	return Boolean(resource && action && SESSION_SCOPED_EXTRAS.has(`${resource}:${action}`));
}

const READ_EXTRA_ACTIONS = new Set([
	'widget_data',
	'ai_query',
	'generate_pdf',
	'generate_full_report_pdf',
	'validate_template',
	'process_preview',
	'print_pdf_direct',
	'parse_document',
	'generate_close_report',
]);

export class HttpAuthRequiredError extends Error {
	status = 401;
	code = 'not_authenticated';
	constructor(message = 'No estás autenticado') {
		super(message);
		this.name = 'HttpAuthRequiredError';
	}
}

export class HttpAccessDeniedError extends Error {
	status = 403;
	code = 'access_denied';
	constructor(message: string) {
		super(message);
		this.name = 'HttpAccessDeniedError';
	}
}

export function is_public_extra_action(action?: string): boolean {
	return Boolean(action && PUBLIC_EXTRA_ACTIONS.has(action));
}

function crud_flag(method: string): RecordRuleOperationFlag {
	const m = method.toUpperCase();
	if (m === 'POST') return 'allow_create';
	if (m === 'PUT' || m === 'PATCH') return 'allow_update';
	if (m === 'DELETE') return 'allow_delete';
	return 'allow_read';
}

function extra_flag(method: string, action: string): RecordRuleOperationFlag {
	const m = method.toUpperCase();
	if (m === 'GET' || m === 'HEAD' || READ_EXTRA_ACTIONS.has(action)) return 'allow_read';
	if (m === 'DELETE') return 'allow_delete';
	if (
		action.startsWith('create_') ||
		action.startsWith('from_') ||
		action.startsWith('generate_from') ||
		action.startsWith('seed_')
	) {
		return 'allow_create';
	}
	if (m === 'POST' || m === 'PUT' || m === 'PATCH') return 'allow_update';
	return 'allow_read';
}

function flag_http_method(flag: RecordRuleOperationFlag): string {
	if (flag === 'allow_create') return 'POST';
	if (flag === 'allow_update') return 'PUT';
	if (flag === 'allow_delete') return 'DELETE';
	return 'GET';
}

function permissions_for_resource(
	access: Awaited<ReturnType<typeof build_access>>,
	resource: string,
): { perms?: Record<string, boolean>; model: string } {
	const keys = record_rule_lookup_keys(resource);
	for (const key of keys) {
		const hit = access.permissions_by_model?.[key];
		if (hit) return { perms: hit, model: key };
	}
	const collapsed = resource.replace(/-/g, '').toLowerCase();
	for (const [model, perms] of Object.entries(access.permissions_by_model ?? {})) {
		if (model.replace(/[^A-Za-z0-9]/g, '').toLowerCase() === collapsed) {
			return { perms, model };
		}
	}
	return { model: keys[1] ?? resource };
}

/**
 * Permiso de Leer sobre el modelo del documento (no sobre document-change-history).
 * Replica validate_read_access del original.
 */
export async function assert_target_model_read(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	model_or_resource: string,
): Promise<string> {
	if (!actor) throw new HttpAuthRequiredError();
	const access = await build_access(store, actor);
	const canonical = store.has(model_or_resource)
		? store.loc(model_or_resource).resource
		: model_or_resource;
	if (access.has_full_access) return canonical;
	const { perms, model } = permissions_for_resource(access, canonical);
	if (perms?.allow_read) return model;
	throw new HttpAccessDeniedError(
		build_model_denied_message('GET', model, access.user_group_names ?? []),
	);
}

const REPORTS_PDF_SETTING_ID = /^[a-f0-9]{24}$/i;

function reports_pdf_setting_public_read(resource: string, method: string, rest = '') {
	if (resource !== 'reports-pdf-setting' || method !== 'GET') return false;
	const id = rest.replace(/^\/+|\/+$/g, '').split('/')[0] ?? '';
	return REPORTS_PDF_SETTING_ID.test(id);
}

export async function assert_http_access(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	resource: string,
	method: string,
	opts: { action?: string; extra?: boolean; rest?: string } = {},
): Promise<void> {
	if (opts.extra && is_public_extra_action(opts.action)) return;
	if (reports_pdf_setting_public_read(resource, method, opts.rest)) return;
	if (!actor) {
		if (resource === 'reports-pdf-setting' && method === 'GET') {
			throw new HttpAccessDeniedError(
				build_model_denied_message('GET', 'ReportsPdfSetting', []),
			);
		}
		throw new HttpAuthRequiredError();
	}
	if (opts.extra && is_session_scoped_extra(resource, opts.action)) return;
	const access = await build_access(store, actor);
	if (access.has_full_access) return;
	const canonical = store.has(resource) ? store.loc(resource).resource : resource;
	const flag = opts.extra && opts.action ? extra_flag(method, opts.action) : crud_flag(method);
	const { perms, model } = permissions_for_resource(access, canonical);
	if (perms?.[flag]) return;
	throw new HttpAccessDeniedError(
		build_model_denied_message(
			flag_http_method(flag),
			model,
			access.user_group_names ?? [],
		),
	);
}

async function build_menus(store: ImperiumStore, access: Awaited<ReturnType<typeof build_access>>) {
	if (!store.has('menu-management')) return [];
	const { rows } = await store.find_many('menu-management', {
		take: 20000,
		include_inactive: false,
		populate: false,
	});
	if (access.has_full_access) return reshape_subject_menus(store, rows).sort(by_order);
	const models = new Set(access.models.map(String));
	const assigned = new Set(access.menu_ids.map(String));
	let filtered = rows.filter((m) => {
		const mid = String(m._id ?? '');
		const model = String(m.model ?? '');
		return assigned.has(mid) || (model && models.has(model));
	});
	const by_id = new Map(rows.map((m) => [String(m._id), m]));
	const keep = new Map(filtered.map((m) => [String(m._id), m]));
	for (const m of [...keep.values()]) {
		let pid = m.parent_id ? String(m.parent_id) : '';
		while (pid && !keep.has(pid) && by_id.has(pid)) {
			const parent = by_id.get(pid)!;
			keep.set(pid, parent);
			pid = parent.parent_id ? String(parent.parent_id) : '';
		}
	}
	filtered = [...keep.values()];
	if (store.has('module-management')) {
		const mods = (
			await store.find_many('module-management', {
				mongo_match: {
					$or: [{ is_enable: false }, { is_active: false }],
				},
				take: 20000,
				include_inactive: true,
			})
		).rows;
		const disabled = new Set(
			mods.filter((m) => m.is_enable === false || m.is_enable === 'false').map((m) => String(m.model_id ?? m._id)),
		);
		filtered = filtered.filter((m) => {
			const model = String(m.model ?? '');
			return !model || !disabled.has(model);
		});
	}
	return reshape_subject_menus(store, filtered).sort(by_order);
}

function by_order(a: ImperiumDoc, b: ImperiumDoc) {
	return Number(a.order ?? 100) - Number(b.order ?? 100);
}

const SUBJECT_ICONS: Record<string, string> = {
	almacen: 'fa-warehouse',
	ventas: 'fa-chart-line',
	configuracion: 'fa-cog',
	rh: 'fa-users',
	reportes: 'fa-chart-bar',
	logistica: 'fa-truck',
	pos: 'fa-store',
	'control-municipal': 'fa-landmark',
	'control-emergencias': 'fa-ambulance',
	'control-escolar': 'fa-graduation-cap',
	'control-hospitalario': 'fa-hospital',
	turnos: 'fa-id-card',
	planeacion: 'fa-clipboard-list',
	pagos: 'fa-credit-card',
	'facturacion-electronica': 'fa-file-invoice',
	'tableros-dinamicos': 'fa-chart-pie',
	vehiculos: 'fa-truck',
	'dispositivos-fisicos': 'fa-desktop',
	'configuraciones-de-vista': 'fa-table-columns',
};

function reshape_subject_menus(store: ImperiumStore, rows: ImperiumDoc[]): ImperiumDoc[] {
	const menus = rows.map((r) => ({ ...r }));
	const by_ref = new Map(menus.map((m) => [String(m._ref ?? ''), m]));
	const root_ids = new Set<string>();
	const norm = (p: unknown) => String(p ?? '').replace(/\/+$/, '');

	store.subjects.forEach((sub, i) => {
		let root = by_ref.get(sub.menu_ref);
		if (!root) {
			root = menus.find((m) => !m.parent_id && String(m.name) === sub.name);
		}
		if (!root) {
			const id = `subject-root-${sub.slug}`;
			root = {
				_id: id,
				id,
				name: sub.name,
				path: sub.path || '',
				parent_id: null,
				_ref: sub.menu_ref,
				icon: SUBJECT_ICONS[sub.slug] ?? 'fa-cube',
				order: (i + 1) * 10,
				is_active: true,
				model: '',
			};
			menus.push(root);
			by_ref.set(sub.menu_ref, root);
		} else {
			root.parent_id = null;
			root.name = sub.name;
			if (!root.icon) root.icon = SUBJECT_ICONS[sub.slug] ?? 'fa-cube';
			const order = Number(root.order);
			if (!Number.isFinite(order) || order === 0) root.order = (i + 1) * 10;
		}
		root_ids.add(String(root._id));

		for (const mod of sub.modules) {
			const prefer = PREFER_OWNER[mod.resource];
			if (prefer && prefer !== sub.slug) continue;
			let found = false;
			for (const m of menus) {
				if (String(m._id) === String(root._id)) continue;
				const hit =
					(mod.menu_ref && String(m._ref ?? '') === mod.menu_ref) ||
					(mod.path && norm(m.path) === norm(mod.path));
				if (!hit) continue;
				m.parent_id = root._id;
				found = true;
			}
			if (!found && mod.path && norm(mod.path) !== norm(root.path)) {
				const id = `subject-mod-${sub.slug}-${mod.resource}`;
				menus.push({
					_id: id,
					id,
					name: mod.name,
					path: mod.path,
					parent_id: root._id,
					_ref: mod.menu_ref || id,
					icon: 'fa-circle',
					order: 10,
					is_active: true,
					model: '',
				});
			}
		}
	});

	const sibling = new Set<string>();
	return menus.filter((m) => {
		if (!m.parent_id) return root_ids.has(String(m._id));
		const path = norm(m.path);
		if (!path) return true;
		const key = `${m.parent_id}::${path}`;
		if (sibling.has(key)) return false;
		sibling.add(key);
		return true;
	});
}

const BRANDING_REFS = [
	'configuration-branding-mode',
	'configuration-company-logo',
	'configuration-branding-logo-width',
	'configuration-branding-logo-height',
	'configuration-branding-logo-text-position',
	'configuration-default-theme',
] as const;

async function config_by_ref(store: ImperiumStore, ref: string) {
	if (!store.has('configuration')) return null;
	return store.find_where('configuration', { _ref: ref });
}

async function branding_json(store: ImperiumStore): Promise<Response> {
	const docs = new Map<string, ImperiumDoc>();
	for (const ref of BRANDING_REFS) {
		const doc = await config_by_ref(store, ref);
		if (doc) docs.set(ref, doc);
	}
	const logo = docs.get('configuration-company-logo');
	const payload = {
		branding_mode: unwrap_config(docs.get('configuration-branding-mode')?.value) ?? 'imperium',
		company_logo: unwrap_config(logo?.value) ?? null,
		company_logo_type: unwrap_config(logo?.type) ?? 'image',
		logo_width: unwrap_config(docs.get('configuration-branding-logo-width')?.value) ?? null,
		logo_height: unwrap_config(docs.get('configuration-branding-logo-height')?.value) ?? null,
		logo_text_position: unwrap_config(docs.get('configuration-branding-logo-text-position')?.value) ?? null,
		default_theme: String(unwrap_config(docs.get('configuration-default-theme')?.value) ?? 'default').trim() || 'default',
	};
	return Response.json({
		data: [payload],
		total_elementos: 1,
		message: 'Branding cargado correctamente',
	});
}

function unwrap_config(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!trimmed) return '';
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

async function branding_logo(store: ImperiumStore): Promise<Response> {
	const logo = await config_by_ref(store, 'configuration-company-logo');
	const type = String(logo?.type ?? 'image');
	const reference = logo?.value;
	if (type !== 'image' || !reference) {
		return new Response('Logo no configurado', { status: 404 });
	}
	if (!store.has('attachment-management')) {
		return new Response('Logo no encontrado', { status: 404 });
	}
	const attachment = await store.find_id('attachment-management', String(reference));
	if (!attachment) {
		return new Response('Logo no encontrado', { status: 404 });
	}
	const { serve_attachment_bytes } = await import('./media.ts');
	const served = await serve_attachment_bytes(attachment);
	if (!served) return new Response('Logo no encontrado', { status: 404 });
	return new Response(served.body, {
		headers: {
			'content-type': served.mime,
			'cache-control': 'public, max-age=300',
		},
	});
}

void ok;
void SECRET;
