/**
 * Auth Imperium: login/sesión/menús contra `user` + `access-rights` + `menu-management`.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { read_imperium_body } from './body.ts';
import type { ImperiumStore } from './store.ts';

const COOKIE = 'connect.sid';
const SECRET = process.env.SESSION_SECRET ?? 'imperium-modular-dev-session';
const SEED_ADMIN_REF = 'user-menu-management-0';

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
		const email = String(body.email ?? '').trim().toLowerCase();
		const password = String(body.password ?? '');
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
			return Response.json(
				{ message: 'Usuario o contraseña incorrectos', error: 'Usuario o contraseña incorrectos' },
				{ status: 401 },
			);
		}
		const safe = public_user(user);
		const session = await create_session(sql, safe);
		const access_rights = await build_access(store, safe);
		const menus = await build_menus(store, access_rights);
		return with_cookie(
			Response.json({ user: safe, menus, access_rights }),
			session.id,
		);
	}

	if (method === 'POST' && (rest === '/logout' || rest === '/logout/')) {
		const sid = read_sid(req);
		if (sid) await destroy_session(sql, sid);
		return with_cookie(Response.json({ ok: true }), '', true);
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
	const { password: _p, ...rest } = user;
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

async function build_access(store: ImperiumStore, user: ImperiumDoc) {
	const is_admin = user._ref === SEED_ADMIN_REF;
	if (is_admin) {
		const models = [...new Set(store.all_locs.map((l) => l.resource))];
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
		? (await store.find_many('user-group', { take: 500, include_inactive: false })).rows.filter(
				(g) => as_array(g.user_ids).map(String).includes(String(user._id)),
			)
		: [];
	const rights_ids = new Set<string>();
	for (const g of groups) {
		for (const id of as_array(g.access_rights_ids)) rights_ids.add(String(id));
	}
	const rights = store.has('access-rights')
		? (await store.find_many('access-rights', { take: 2000, include_inactive: false })).rows
		: [];
	const mine = rights.filter(
		(r) =>
			rights_ids.has(String(r._id)) ||
			groups.some((g) => String(r.group_id) === String(g._id)),
	);
	const models = [...new Set(mine.filter((r) => r.allow_read).map((r) => String(r.model_id)))];
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
		cur.allow_read ||= Boolean(r.allow_read);
		cur.allow_create ||= Boolean(r.allow_create);
		cur.allow_update ||= Boolean(r.allow_update);
		cur.allow_delete ||= Boolean(r.allow_delete);
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
		record_rules_by_model: {},
		user_group_names: groups.map((g) => String(g.name ?? '')),
		allowed_groups: [] as string[],
		message: 'Permisos del usuario calculados correctamente',
		model: '',
		method: 'Leer',
	};
}

async function build_menus(store: ImperiumStore, access: Awaited<ReturnType<typeof build_access>>) {
	if (!store.has('menu-management')) return [];
	const { rows } = await store.find_many('menu-management', {
		take: 5000,
		include_inactive: false,
	});
	if (access.has_full_access) return rows.sort(by_order);
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
		const mods = (await store.find_many('module-management', { take: 2000, include_inactive: true })).rows;
		const disabled = new Set(
			mods.filter((m) => m.is_enable === false || m.is_enable === 'false').map((m) => String(m.model_id ?? m._id)),
		);
		filtered = filtered.filter((m) => {
			const model = String(m.model ?? '');
			return !model || !disabled.has(model);
		});
	}
	return filtered.sort(by_order);
}

function by_order(a: ImperiumDoc, b: ImperiumDoc) {
	return Number(a.order ?? 100) - Number(b.order ?? 100);
}

void ok;
void SECRET;
