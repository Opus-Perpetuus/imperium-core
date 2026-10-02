/**
 * Enlaces públicos: cualquier vista interna se comparte con un token.
 *
 * El visitante ve lo que ve el dueño, en solo lectura y con sus permisos, pero
 * solo por las llamadas que esa vista hizo en la vista previa del dueño
 * (`scope`): misma ruta y mismos parámetros, salvo paginar, ordenar y buscar.
 */
import { randomBytes } from 'node:crypto';
import { can_enter_internal } from '@opus-perpetuus/imperium-core-kit';
import { build_access, current_user, public_user } from './auth.ts';
import type { ImperiumDoc } from './envelope.ts';
import {
	bind_share,
	type ShareBinding,
	type ShareScopeEntry,
} from './share-binding.ts';
import type { ImperiumStore } from './store.ts';

const SHARE_HEADER = 'x-imperium-compartido';
const SHARE_QUERY = 'compartido';

/** Paginar, ordenar y buscar no cambian qué datos enseña la vista. */
const FREE_KEYS = new Set([
	'desde',
	'limite',
	'campoSort',
	'sort',
	'termino',
	'q',
	'page',
	'pagina',
	'cursor',
	'after',
]);

/** Ni se graban ni se alcanzan con un enlace, aunque la vista previa las pida. */
const DENIED_PREFIXES = [
	'/api/auth',
	'/api/compartir',
	'/api/mcp-agent',
	'/api/subjects',
	'/api/kirlets',
	'/api/install-schemas',
	'/api/db-admin',
	'/api/user-pin',
];

const DRAFT_TTL_MS = 60 * 60 * 1000;
const MAX_SCOPE = 200;
const MAX_HIDDEN = 500;
const HASH = /^[A-Za-z0-9_-]{1,64}$/;

export type ShareState = 'borrador' | 'activo' | 'retirado';

export type Share = {
	id: string;
	owner_id: string;
	title: string;
	target: string;
	scope: ShareScopeEntry[];
	hidden: string[];
	state: ShareState;
	expires_at: number | null;
	created_at: number;
	published_at: number | null;
	last_access_at: number | null;
	access_count: number;
};

export type ShareBlockKind = 'app' | 'recurso' | 'ruta';
export type ShareBlock = { kind: ShareBlockKind; key: string; label: string };

type AccessRights = Awaited<ReturnType<typeof build_access>>;

//   #region ALCANCE

function normalize_path(path: string): string {
	const trimmed = path.replace(/\/+$/, '');
	return trimmed || '/';
}

/** Parámetros con valor, sin el token. Vacío y ausente significan lo mismo. */
function query_of(url: URL): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [key, value] of url.searchParams) {
		if (key === SHARE_QUERY || value === '') continue;
		out.set(key, [...(out.get(key) ?? []), value]);
	}
	for (const [key, values] of out) out.set(key, [...values].sort());
	return out;
}

export function scope_entry_of(url: URL): ShareScopeEntry {
	const path = normalize_path(url.pathname);
	const pinned: Record<string, string[]> = {};
	for (const [key, values] of query_of(url)) {
		if (!FREE_KEYS.has(key)) pinned[key] = values;
	}
	const pairs = Object.keys(pinned)
		.sort()
		.flatMap((key) => pinned[key]!.map((value) => `${key}=${value}`));
	return { key: `${path}?${pairs.join('&')}`, path, pinned };
}

/** Los fijos tienen que ir tal cual (y ausentes si no estaban); los libres, como quieran. */
export function scope_allows(scope: ShareScopeEntry[], url: URL): boolean {
	const asked = scope_entry_of(url);
	return scope.some((entry) => entry.key === asked.key);
}

export function is_denied_path(path: string): boolean {
	return DENIED_PREFIXES.some(
		(prefix) => path === prefix || path.startsWith(`${prefix}/`),
	);
}

function is_media_path(path: string): boolean {
	return path.startsWith('/api/media/');
}

/** Con o sin enlace se atienden como anónimas: ya son públicas. */
function is_public_path(path: string): boolean {
	return (
		!path.startsWith('/api/') ||
		path.startsWith('/api/p/') ||
		path === '/api/health' ||
		path.startsWith('/api/auth/branding')
	);
}

//   #endregion ALCANCE

//   #region BLOQUEOS

/** App y recurso que toca una llamada; las páginas nox no dicen de qué recurso son. */
export function touched_by(
	path: string,
	resource_app: (resource: string) => string | null,
): { app: string | null; resource: string | null } {
	const app_call = path.match(/^\/api\/(?:p\/)?m\/(subject-[a-z0-9-]+)(?:\/([^/?]+))?/);
	if (app_call) {
		const segment = app_call[2] ?? null;
		return {
			app: app_call[1]!,
			resource: segment && segment !== 'pages' ? segment : null,
		};
	}
	const core_call = path.match(/^\/api\/([^/?]+)/);
	if (!core_call || core_call[1] === 'media') return { app: null, resource: null };
	const resource = core_call[1]!;
	return { app: resource_app(resource), resource };
}

function route_blocked(key: string, target: URL): boolean {
	const blocked = new URL(key, 'http://imperium.local');
	const path = normalize_path(target.pathname);
	const prefix = normalize_path(blocked.pathname);
	if (path !== prefix && !path.startsWith(`${prefix}/`)) return false;
	for (const [name, value] of blocked.searchParams) {
		if (!target.searchParams.getAll(name).includes(value)) return false;
	}
	return true;
}

export function blocked_by(
	blocks: ShareBlock[],
	input: {
		target: string;
		paths: string[];
		app?: string | null;
		resource_app: (resource: string) => string | null;
	},
): ShareBlock | null {
	const target = new URL(input.target, 'http://imperium.local');
	for (const block of blocks) {
		if (block.kind === 'ruta' && route_blocked(block.key, target)) return block;
		if (block.kind === 'app' && input.app && block.key === input.app) return block;
	}
	for (const path of input.paths) {
		const touched = touched_by(path, input.resource_app);
		for (const block of blocks) {
			if (block.kind === 'app' && touched.app === block.key) return block;
			if (block.kind === 'recurso' && touched.resource === block.key) return block;
		}
	}
	return null;
}

//   #endregion BLOQUEOS

//   #region PERMISOS

type GrantRef = { resource: string; menu_ref?: string };
type Grant = { resource: string; c: boolean; r: boolean; u: boolean; d: boolean };

/**
 * Lo que una app recibe de un enlace: lectura de lo que el dueño ve. Un admin
 * no lleva grants (`is_admin` abre todo); para el enlace se le da lectura de
 * cada módulo de la app y se le quita el admin.
 */
export function share_grants(input: {
	slug: string;
	modules: GrantRef[];
	grants: Grant[];
	is_admin: boolean;
}): Grant[] {
	const base = input.is_admin
		? input.modules.map((mod) => ({
				resource: `kirlet.${input.slug}.${mod.resource}`,
				c: false,
				r: true,
				u: false,
				d: false,
			}))
		: input.grants;
	const unique = new Map<string, Grant>();
	for (const grant of base) {
		if (!grant.r) continue;
		unique.set(grant.resource, { resource: grant.resource, c: false, r: true, u: false, d: false });
	}
	return [...unique.values()];
}

/** Permisos para el front del visitante: leer lo que el dueño lee, nada más. */
export function share_access_rights(access: AccessRights): Record<string, unknown> {
	const permissions_by_model: Record<string, Record<string, boolean>> = {};
	for (const model of access.models) {
		permissions_by_model[model] = {
			allow_read: true,
			allow_create: false,
			allow_update: false,
			allow_delete: false,
		};
	}
	return {
		...access,
		has_full_access: false,
		has_user_groups: false,
		permissions_by_model,
		record_rules_by_model: {},
		menu_ids: [],
		user_group_ids: [],
		user_group_refs: [],
		user_group_names: [],
	};
}

//   #endregion PERMISOS

//   #region TABLAS

let tables_ready: Promise<void> | null = null;

function ensure_share_tables(sql: Bun.SQL): Promise<void> {
	tables_ready ??= (async () => {
		await sql.unsafe(`CREATE TABLE IF NOT EXISTS public.imperium_shares (
			id TEXT PRIMARY KEY,
			owner_id TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			target TEXT NOT NULL,
			scope JSONB NOT NULL DEFAULT '[]'::jsonb,
			hidden JSONB NOT NULL DEFAULT '[]'::jsonb,
			state TEXT NOT NULL DEFAULT 'borrador',
			expires_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			published_at TIMESTAMPTZ,
			revoked_at TIMESTAMPTZ,
			last_access_at TIMESTAMPTZ,
			access_count INTEGER NOT NULL DEFAULT 0
		)`);
		await sql.unsafe(
			`CREATE INDEX IF NOT EXISTS imperium_shares_owner ON public.imperium_shares (owner_id, created_at DESC)`,
		);
		await sql.unsafe(`CREATE TABLE IF NOT EXISTS public.imperium_share_blocks (
			kind TEXT NOT NULL,
			key TEXT NOT NULL,
			label TEXT NOT NULL DEFAULT '',
			created_by TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (kind, key)
		)`);
	})().catch((err) => {
		tables_ready = null;
		throw err;
	});
	return tables_ready;
}

const SHARE_COLUMNS = `id, owner_id, title, target, scope, hidden, state,
	extract(epoch from expires_at) * 1000 AS expires_at,
	extract(epoch from created_at) * 1000 AS created_at,
	extract(epoch from published_at) * 1000 AS published_at,
	extract(epoch from last_access_at) * 1000 AS last_access_at,
	access_count`;

function json_list(value: unknown): unknown[] {
	const parsed = typeof value === 'string' ? JSON.parse(value) : value;
	return Array.isArray(parsed) ? parsed : [];
}

function ms_or_null(value: unknown): number | null {
	return value == null ? null : Number(value);
}

function share_of_row(row: Record<string, unknown>): Share {
	return {
		id: String(row.id),
		owner_id: String(row.owner_id),
		title: String(row.title ?? ''),
		target: String(row.target ?? ''),
		scope: json_list(row.scope) as ShareScopeEntry[],
		hidden: json_list(row.hidden).map(String),
		state: String(row.state) as ShareState,
		expires_at: ms_or_null(row.expires_at),
		created_at: Number(row.created_at),
		published_at: ms_or_null(row.published_at),
		last_access_at: ms_or_null(row.last_access_at),
		access_count: Number(row.access_count ?? 0),
	};
}

async function load_share(sql: Bun.SQL, id: string): Promise<Share | null> {
	if (!id || id.length > 64) return null;
	await ensure_share_tables(sql);
	const rows = (await sql.unsafe(
		`SELECT ${SHARE_COLUMNS} FROM public.imperium_shares WHERE id = $1`,
		[id],
	)) as Record<string, unknown>[];
	return rows[0] ? share_of_row(rows[0]) : null;
}

/** Atómico: dos llamadas de la misma vista previa no se pisan ni se duplican. */
export async function record_share_scope(
	sql: Bun.SQL,
	id: string,
	entry: ShareScopeEntry,
): Promise<void> {
	await sql.unsafe(
		`UPDATE public.imperium_shares
		SET scope = scope || $2::jsonb
		WHERE id = $1 AND state = 'borrador'
			AND jsonb_array_length(scope) < $3
			AND NOT scope @> $4::jsonb`,
		// Bun.SQL codifica el jsonb: con `JSON.stringify` quedaría una cadena.
		[id, [entry], MAX_SCOPE, [{ key: entry.key }]],
	);
}

let blocks_cache: { at: number; rows: ShareBlock[] } | null = null;

async function load_share_blocks(sql: Bun.SQL): Promise<ShareBlock[]> {
	if (blocks_cache && Date.now() - blocks_cache.at < 5_000) return blocks_cache.rows;
	await ensure_share_tables(sql);
	const rows = (await sql.unsafe(
		`SELECT kind, key, label FROM public.imperium_share_blocks ORDER BY kind, key`,
	)) as Record<string, unknown>[];
	const blocks = rows.map((row) => ({
		kind: String(row.kind) as ShareBlockKind,
		key: String(row.key),
		label: String(row.label ?? ''),
	}));
	blocks_cache = { at: Date.now(), rows: blocks };
	return blocks;
}

//   #endregion TABLAS

//   #region PETICIÓN CON ENLACE

type ShareGateDeps = {
	load_share(id: string): Promise<Share | null>;
	load_owner(id: string): Promise<ImperiumDoc | null>;
	real_user(req: Request): Promise<ImperiumDoc | null>;
	load_blocks(): Promise<ShareBlock[]>;
	resource_app(resource: string): string | null;
	now(): number;
};

export type ShareGate =
	| { kind: 'none' }
	| { kind: 'response'; response: Response }
	| { kind: 'bound'; share: Share; record: boolean };

function share_error(status: number, code: string, message: string): Response {
	return Response.json({ error: message, message, code }, { status });
}

const NOT_FOUND = () => share_error(404, 'compartido_no_existe', 'Este enlace no existe.');

function share_problem(
	share: Share | null,
	input: { now: number; is_owner: boolean },
): Response | null {
	if (!share) return NOT_FOUND();
	if (share.state === 'retirado') {
		return share_error(410, 'compartido_retirado', 'Quien compartió este enlace lo retiró.');
	}
	if (share.state === 'borrador') {
		// Un borrador solo existe para su dueño, mientras prepara el enlace.
		if (!input.is_owner) return NOT_FOUND();
		if (input.now - share.created_at > DRAFT_TTL_MS) {
			return share_error(410, 'compartido_caducado', 'Este enlace caducó.');
		}
		return null;
	}
	if (share.expires_at != null && share.expires_at <= input.now) {
		return share_error(410, 'compartido_caducado', 'Este enlace caducó.');
	}
	return null;
}

function blocked_response(): Response {
	return share_error(
		403,
		'compartido_bloqueado',
		'El administrador no permite compartir esta vista en público.',
	);
}

function share_token_of(req: Request, url: URL): string {
	const header = (req.headers.get(SHARE_HEADER) ?? '').trim();
	if (header) return header;
	if (req.method === 'GET' && is_media_path(url.pathname)) {
		return (url.searchParams.get(SHARE_QUERY) ?? '').trim();
	}
	return '';
}

/**
 * Una petición que trae un enlace se atiende como su dueño o se corta aquí.
 *
 * En borrador solo pasa con la sesión del propio dueño (su vista previa) y lo
 * que pide se graba como alcance; publicado, solo pasa lo grabado.
 */
export async function gate_share_request(
	req: Request,
	url: URL,
	deps: ShareGateDeps,
): Promise<ShareGate> {
	const token = share_token_of(req, url);
	if (!token || is_public_path(url.pathname)) return { kind: 'none' };
	const share = await deps.load_share(token);
	const real_user = share ? await deps.real_user(req) : null;
	const is_owner =
		!!share && !!real_user && String(real_user._id ?? '') === share.owner_id;
	const problem = share_problem(share, { now: deps.now(), is_owner });
	if (problem) return { kind: 'response', response: problem };
	const active = share!;
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return {
			kind: 'response',
			response: share_error(403, 'compartido_solo_lectura', 'Un enlace compartido es de solo lectura.'),
		};
	}
	const media = is_media_path(url.pathname);
	if (is_denied_path(url.pathname)) {
		return { kind: 'response', response: out_of_scope() };
	}
	const block = blocked_by(await deps.load_blocks(), {
		target: active.target,
		paths: [url.pathname],
		resource_app: deps.resource_app,
	});
	if (block) return { kind: 'response', response: blocked_response() };
	const recording = active.state === 'borrador';
	if (!recording && !media && !scope_allows(active.scope, url)) {
		return { kind: 'response', response: out_of_scope() };
	}
	const owner = await deps.load_owner(active.owner_id);
	if (!owner) return { kind: 'response', response: NOT_FOUND() };
	bind_share(req, {
		share_id: active.id,
		owner,
		target: active.target,
		scope: active.scope,
	});
	return { kind: 'bound', share: active, record: recording && !media };
}

function out_of_scope(): Response {
	return share_error(403, 'compartido_fuera_de_alcance', 'Esto no forma parte de la vista compartida.');
}

/** `CitizenReport` (modelo del adjunto) y `citizen-report` (recurso de la ruta) son el mismo. */
function same_model(a: string, b: string): boolean {
	const plain = (value: string) => value.replace(/[-_]/g, '').toLowerCase();
	return plain(a) === plain(b);
}

/** Un adjunto se sirve si es de una app o recurso que la vista compartida lee. */
export function share_allows_media(binding: ShareBinding, related_model: string): boolean {
	const model = related_model.trim();
	if (!model) return false;
	const owner_app = model.match(/^(subject-[a-z0-9-]+):/)?.[1] ?? null;
	return binding.scope.some((entry) => {
		const touched = touched_by(entry.path, () => null);
		if (owner_app) return touched.app === owner_app;
		return touched.resource != null && same_model(touched.resource, model);
	});
}

/** El dueño de un enlace, como lo vería su propia sesión. */
async function load_share_owner(
	store: ImperiumStore,
	owner_id: string,
): Promise<ImperiumDoc | null> {
	const user = await store.find_id('user', owner_id);
	if (!user || user.is_active === false || !can_enter_internal(user)) return null;
	return public_user(user);
}

//   #endregion PETICIÓN CON ENLACE

//   #region RESPUESTAS

function iso(ms: number | null): string | null {
	return ms == null ? null : new Date(ms).toISOString();
}

function share_view(share: Share): Record<string, unknown> {
	return {
		id: share.id,
		titulo: share.title,
		ruta: share.target,
		estado: share.state,
		expira_en: iso(share.expires_at),
		creado_en: iso(share.created_at),
		publicado_en: iso(share.published_at),
		ultimo_acceso_en: iso(share.last_access_at),
		accesos: share.access_count,
		ocultos: share.hidden,
		llamadas: share.scope.length,
		dueno_id: share.owner_id,
	};
}

/** Lo que ve quien abre el enlace: el nombre, nunca el correo. */
function owner_name(owner: ImperiumDoc): string {
	return String(owner.name ?? '').trim();
}

export type PublicShareDeps = ShareGateDeps & {
	access_of(owner: ImperiumDoc): Promise<AccessRights>;
	global_hidden(): Promise<string[]>;
	count_access(id: string): Promise<void>;
};

export function share_deps(store: ImperiumStore, sql: Bun.SQL): PublicShareDeps {
	return {
		load_share: (id) => load_share(sql, id),
		load_owner: (id) => load_share_owner(store, id),
		real_user: (req) => current_user(sql, req).catch(() => null),
		load_blocks: () => load_share_blocks(sql),
		resource_app: (resource) => store.locs.get(resource)?.technical_id ?? null,
		now: () => Date.now(),
		access_of: (owner) => build_access(store, owner),
		// El visitante no está en ningún grupo: toda restricción de interfaz le aplica.
		async global_hidden() {
			if (!store.has('interface-restriction')) return [];
			const { rows } = await store.find_many('interface-restriction', { take: 5000 });
			return rows.map((row) => String(row.html_element_hash ?? '').trim()).filter(Boolean);
		},
		async count_access(id) {
			await sql.unsafe(
				`UPDATE public.imperium_shares SET access_count = access_count + 1, last_access_at = now() WHERE id = $1`,
				[id],
			);
		},
	};
}

/** `GET /api/p/compartido/:id`: lo que el front necesita para pintar la vista. */
export async function handle_public_share(
	req: Request,
	url: URL,
	deps: PublicShareDeps,
): Promise<Response> {
	if (req.method !== 'GET') return share_error(405, 'metodo_no_permitido', 'Método no permitido.');
	const id = decodeURIComponent(url.pathname.slice('/api/p/compartido/'.length).split('/')[0] ?? '');
	const share = await deps.load_share(id);
	const real_user = share ? await deps.real_user(req) : null;
	const is_owner =
		!!share && !!real_user && String(real_user._id ?? '') === share.owner_id;
	const problem = share_problem(share, { now: deps.now(), is_owner });
	if (problem) return problem;
	const active = share!;
	const block = blocked_by(await deps.load_blocks(), {
		target: active.target,
		paths: active.scope.map((entry) => entry.path),
		resource_app: deps.resource_app,
	});
	if (block) return blocked_response();
	const owner = await deps.load_owner(active.owner_id);
	if (!owner) return NOT_FOUND();
	if (!is_owner && active.state === 'activo') await deps.count_access(active.id);
	const { dueno_id: _dueno_id, llamadas: _llamadas, ...visible } = share_view(active);
	return Response.json({
		data: {
			...visible,
			dueno: owner_name(owner),
			es_dueno: is_owner,
			ocultos_globales: await deps.global_hidden(),
			permisos: share_access_rights(await deps.access_of(owner)),
		},
	});
}

//   #endregion RESPUESTAS

//   #region API DEL PERSONAL

function json_response(status: number, body: unknown): Response {
	return Response.json(body, { status });
}

async function read_json(req: Request): Promise<Record<string, unknown>> {
	try {
		const body = await req.json();
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function valid_target(value: unknown): string | null {
	const target = String(value ?? '').trim();
	if (!target.startsWith('/internal/') || target.length > 2000) return null;
	return target;
}

function valid_hidden(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const hashes = [...new Set(value.map((item) => String(item ?? '').trim()))];
	if (hashes.length > MAX_HIDDEN || hashes.some((hash) => !HASH.test(hash))) return null;
	return hashes;
}

function valid_expiry(value: unknown, now: number): { ok: true; at: string | null } | { ok: false } {
	if (value === null) return { ok: true, at: null };
	const at = Date.parse(String(value ?? ''));
	if (!Number.isFinite(at) || at <= now) return { ok: false };
	return { ok: true, at: new Date(at).toISOString() };
}

const BLOCK_KINDS = new Set<ShareBlockKind>(['app', 'recurso', 'ruta']);

/**
 * `/api/compartir…` (sesión del personal):
 * - `GET /compartir/politica?ruta=&app=`: si se puede compartir la vista.
 * - `GET /compartir[?ruta=][&todos=1]`, `POST /compartir`,
 *   `PATCH /compartir/:id`, `DELETE /compartir/:id`: los enlaces.
 * - `GET|PUT /compartir/bloqueos`: lo que nunca se comparte (admin).
 */
export async function handle_share_api(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
	path: string,
): Promise<Response> {
	const actor = await current_user(sql, req);
	if (!actor) {
		return json_response(401, { error: 'No estás autenticado', message: 'No estás autenticado' });
	}
	if (!can_enter_internal(actor)) {
		return json_response(403, { error: 'Solo usuarios internos', message: 'Solo usuarios internos' });
	}
	await ensure_share_tables(sql);
	const access = await build_access(store, actor);
	const is_admin = access.has_full_access === true;
	const actor_id = String(actor._id ?? '');
	const rest = path.slice('/compartir'.length).replace(/^\/+/, '');
	const method = req.method.toUpperCase();
	const resource_app = (resource: string) => store.locs.get(resource)?.technical_id ?? null;

	if (rest === 'politica' && method === 'GET') {
		const target = valid_target(url.searchParams.get('ruta'));
		if (!target) return json_response(400, { error: 'Ruta no válida', message: 'Ruta no válida' });
		const block = blocked_by(await load_share_blocks(sql), {
			target,
			paths: [],
			app: url.searchParams.get('app'),
			resource_app,
		});
		return json_response(200, {
			data: {
				permitido: !block,
				motivo: block ? 'El administrador no permite compartir esta vista en público.' : '',
				es_admin: is_admin,
			},
		});
	}

	if (rest === 'bloqueos') {
		if (!is_admin) {
			return json_response(403, {
				error: 'Solo el administrador cambia lo que se puede compartir.',
				message: 'Solo el administrador cambia lo que se puede compartir.',
			});
		}
		if (method === 'GET') {
			return json_response(200, {
				data: (await load_share_blocks(sql)).map((block) => ({
					tipo: block.kind,
					clave: block.key,
					etiqueta: block.label,
				})),
			});
		}
		if (method === 'PUT') {
			const body = await read_json(req);
			const raw = Array.isArray(body.bloqueos) ? body.bloqueos : null;
			if (!raw) return json_response(400, { error: 'Falta la lista de bloqueos', message: 'Falta la lista de bloqueos' });
			const blocks: ShareBlock[] = [];
			for (const item of raw as Record<string, unknown>[]) {
				const kind = String(item?.tipo ?? '') as ShareBlockKind;
				const key = String(item?.clave ?? '').trim();
				if (!BLOCK_KINDS.has(kind) || !key || key.length > 2000) {
					return json_response(400, { error: 'Bloqueo no válido', message: 'Bloqueo no válido' });
				}
				blocks.push({ kind, key, label: String(item?.etiqueta ?? '').trim().slice(0, 200) });
			}
			await sql.begin(async (tx) => {
				await tx.unsafe(`DELETE FROM public.imperium_share_blocks`);
				for (const block of blocks) {
					await tx.unsafe(
						`INSERT INTO public.imperium_share_blocks (kind, key, label, created_by)
						VALUES ($1, $2, $3, $4) ON CONFLICT (kind, key) DO UPDATE SET label = EXCLUDED.label`,
						[block.kind, block.key, block.label, actor_id],
					);
				}
			});
			blocks_cache = null;
			return json_response(200, {
				data: blocks.map((block) => ({ tipo: block.kind, clave: block.key, etiqueta: block.label })),
			});
		}
	}

	if (rest === '' && method === 'GET') {
		const all = url.searchParams.get('todos') === '1' && is_admin;
		const target = url.searchParams.get('ruta');
		const params: unknown[] = [];
		const where: string[] = [];
		if (!all) {
			params.push(actor_id);
			where.push(`owner_id = $${params.length}`);
		}
		if (target) {
			params.push(target);
			where.push(`target = $${params.length}`);
		}
		// Un borrador viejo ya no se puede continuar: no se lista.
		params.push(new Date(Date.now() - DRAFT_TTL_MS).toISOString());
		where.push(`(state <> 'borrador' OR created_at >= $${params.length}::timestamptz)`);
		const rows = (await sql.unsafe(
			`SELECT ${SHARE_COLUMNS} FROM public.imperium_shares
			WHERE ${where.join(' AND ')}
			ORDER BY created_at DESC LIMIT 500`,
			params,
		)) as Record<string, unknown>[];
		const shares = rows.map(share_of_row);
		const names = new Map<string, string>();
		for (const owner_id of new Set(shares.map((share) => share.owner_id))) {
			const owner = await store.find_id('user', owner_id).catch(() => null);
			names.set(owner_id, owner ? owner_name(owner) || String(owner.email ?? '') : '');
		}
		return json_response(200, {
			data: shares.map((share) => ({ ...share_view(share), dueno: names.get(share.owner_id) ?? '' })),
		});
	}

	if (rest === '' && method === 'POST') {
		const body = await read_json(req);
		const target = valid_target(body.ruta);
		if (!target) return json_response(400, { error: 'Ruta no válida', message: 'Ruta no válida' });
		const block = blocked_by(await load_share_blocks(sql), {
			target,
			paths: [],
			app: typeof body.app === 'string' ? body.app : null,
			resource_app,
		});
		if (block) return blocked_response();
		await sql.unsafe(
			`DELETE FROM public.imperium_shares WHERE state = 'borrador' AND created_at < now() - interval '1 day'`,
		);
		const id = randomBytes(24).toString('base64url');
		await sql.unsafe(
			`INSERT INTO public.imperium_shares (id, owner_id, title, target) VALUES ($1, $2, $3, $4)`,
			[id, actor_id, String(body.titulo ?? '').trim().slice(0, 200), target],
		);
		const share = await load_share(sql, id);
		return json_response(201, { data: share_view(share!) });
	}

	const id = decodeURIComponent(rest.split('/')[0] ?? '');
	const share = rest && !rest.includes('/') ? await load_share(sql, id) : null;
	if (!share || (share.owner_id !== actor_id && !is_admin)) {
		return json_response(404, { error: 'Este enlace no existe.', message: 'Este enlace no existe.', code: 'compartido_no_existe' });
	}

	if (method === 'DELETE') {
		await sql.unsafe(
			`UPDATE public.imperium_shares SET state = 'retirado', revoked_at = now() WHERE id = $1 AND state <> 'retirado'`,
			[share.id],
		);
		return json_response(200, { data: share_view((await load_share(sql, share.id))!) });
	}

	if (method === 'PATCH') {
		if (share.state === 'retirado') {
			return json_response(410, { error: 'Este enlace ya se retiró.', message: 'Este enlace ya se retiró.', code: 'compartido_retirado' });
		}
		const body = await read_json(req);
		const sets: string[] = [];
		const params: unknown[] = [share.id];
		if (body.titulo !== undefined) {
			params.push(String(body.titulo ?? '').trim().slice(0, 200));
			sets.push(`title = $${params.length}`);
		}
		if (body.expira_en !== undefined) {
			const expiry = valid_expiry(body.expira_en, Date.now());
			if (!expiry.ok) {
				return json_response(400, { error: 'La caducidad tiene que ser una fecha futura.', message: 'La caducidad tiene que ser una fecha futura.' });
			}
			params.push(expiry.at);
			sets.push(`expires_at = $${params.length}::timestamptz`);
		}
		if (body.ocultos !== undefined) {
			const hidden = valid_hidden(body.ocultos);
			if (!hidden) return json_response(400, { error: 'Elementos ocultos no válidos', message: 'Elementos ocultos no válidos' });
			params.push(hidden);
			sets.push(`hidden = $${params.length}::jsonb`);
		}
		if (body.publicar === true && share.state === 'borrador') {
			if (!share.scope.length) {
				return json_response(409, {
					error: 'La vista todavía no cargó nada que compartir.',
					message: 'La vista todavía no cargó nada que compartir.',
				});
			}
			const block = blocked_by(await load_share_blocks(sql), {
				target: share.target,
				paths: share.scope.map((entry) => entry.path),
				resource_app,
			});
			if (block) return blocked_response();
			sets.push(`state = 'activo'`, `published_at = now()`);
		}
		if (sets.length) {
			await sql.unsafe(`UPDATE public.imperium_shares SET ${sets.join(', ')} WHERE id = $1`, params);
		}
		return json_response(200, { data: share_view((await load_share(sql, share.id))!) });
	}

	return json_response(405, { error: 'Método no permitido', message: 'Método no permitido' });
}

//   #endregion API DEL PERSONAL
