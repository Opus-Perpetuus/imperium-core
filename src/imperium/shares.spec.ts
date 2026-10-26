import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { share_binding_of } from './share-binding.ts';
import {
	blocked_by,
	gate_share_request,
	handle_public_share,
	is_denied_path,
	scope_allows,
	scope_entry_of,
	share_access_rights,
	share_allows_media,
	share_grants,
	touched_by,
	type PublicShareDeps,
	type Share,
	type ShareBlock,
} from './shares.ts';

const BASE = 'http://imperium.local';
const NOW = Date.parse('2026-10-02T20:00:00Z');
const OWNER: ImperiumDoc = { _id: 'u-dueno', name: 'Dueña', email: 'duena@x.mx', type: 'internal' };
const VISITOR: ImperiumDoc = { _id: 'u-otro', name: 'Otro', type: 'internal' };
const PAGE = '/api/m/subject-herramientas/pages/herramientas.herr-tabla';

function url(path: string): URL {
	return new URL(path, BASE);
}

function share(over: Partial<Share> = {}): Share {
	return {
		id: 'tok',
		owner_id: 'u-dueno',
		title: 'Ventas',
		target: '/internal/herr-tabla?id=T1',
		scope: [scope_entry_of(url(`${PAGE}?id=T1`)), scope_entry_of(url('/api/employee?desde=0&limite=20&ids=&termino='))],
		hidden: ['abc123'],
		state: 'activo',
		expires_at: null,
		created_at: NOW - 60_000,
		published_at: NOW - 30_000,
		last_access_at: null,
		access_count: 0,
		...over,
	};
}

function deps(over: Partial<PublicShareDeps> & { row?: Share | null; cookie_user?: ImperiumDoc | null; blocks?: ShareBlock[] } = {}) {
	const counted: string[] = [];
	const value: PublicShareDeps = {
		load_share: async (id) => (id === 'tok' ? (over.row === undefined ? share() : over.row) : null),
		load_owner: async (id) => (id === 'u-dueno' ? OWNER : null),
		real_user: async () => over.cookie_user ?? null,
		load_blocks: async () => over.blocks ?? [],
		resource_app: (resource) => (resource === 'employee' ? 'subject-rh' : null),
		now: () => NOW,
		access_of: async () =>
			({
				access_granted: true,
				has_full_access: true,
				has_user_groups: false,
				models: ['Employee', 'Auth'],
				menu_ids: [],
				user_group_ids: [],
				user_group_refs: [],
				permissions_by_model: {},
				record_rules_by_model: {},
				user_group_names: [],
				allowed_groups: [],
				message: '',
				model: '',
				method: 'Leer',
			}) as never,
		global_hidden: async () => ['global1'],
		count_access: async (id) => {
			counted.push(id);
		},
		...over,
	};
	return { value, counted };
}

function shared_req(path: string, init: RequestInit = {}, token = 'tok'): Request {
	const headers = new Headers(init.headers);
	if (token) headers.set('x-imperium-compartido', token);
	return new Request(new URL(path, BASE), { ...init, headers });
}

async function status_of(gate: Awaited<ReturnType<typeof gate_share_request>>): Promise<[number, string]> {
	if (gate.kind !== 'response') return [0, gate.kind];
	const body = (await gate.response.json()) as { code?: string };
	return [gate.response.status, body.code ?? ''];
}

describe('alcance de un enlace', () => {
	const scope = [scope_entry_of(url(`${PAGE}?id=T1&desde=0`))];

	test('la misma llamada pasa aunque cambie la paginación, el orden o la búsqueda', () => {
		expect(scope_allows(scope, url(`${PAGE}?id=T1&desde=40&limite=20&campoSort=nombre&sort=-1&termino=ana&q=x&page=3`))).toBe(true);
		expect(scope_allows(scope, url(`${PAGE}?id=T1`))).toBe(true);
	});

	test('un parámetro fijo distinto, quitado o añadido no pasa', () => {
		expect(scope_allows(scope, url(`${PAGE}?id=T2`))).toBe(false);
		expect(scope_allows(scope, url(PAGE))).toBe(false);
		expect(scope_allows(scope, url(`${PAGE}?id=T1&modo=disenar`))).toBe(false);
		expect(scope_allows(scope, url(`${PAGE}?id=T1&id=T2`))).toBe(false);
	});

	test('vacío y ausente son lo mismo, y el token no cuenta', () => {
		const list = [scope_entry_of(url('/api/employee?ids=&export_excel=&termino='))];
		expect(scope_allows(list, url('/api/employee?compartido=tok'))).toBe(true);
		expect(scope_allows(list, url('/api/employee?ids=a1'))).toBe(false);
		expect(scope_allows(list, url('/api/employee?export_excel=true'))).toBe(false);
	});

	test('otra ruta no pasa; la barra final no cuenta', () => {
		expect(scope_allows(scope, url('/api/m/subject-herramientas/pages/herramientas.herr-registro?id=T1'))).toBe(false);
		expect(scope_allows(scope, url(`${PAGE}/?id=T1`))).toBe(true);
	});

	test('una ventana de fechas de «hoy» pasa días después, corrida hacia adelante, nunca hacia atrás', () => {
		const stats = '/api/pedidos/stats';
		const grabada = [scope_entry_of(url(`${stats}?date_from=2026-07-06T06:00:00.000Z&date_to=2026-10-06T05:59:59.999Z&status=abierto`))];
		const ahora = { now: Date.parse('2026-10-09T15:00:00.000Z'), recorded_at: Date.parse('2026-10-06T15:00:00.000Z') };
		const tres_dias = `${stats}?date_from=2026-07-09T06:00:00.000Z&date_to=2026-10-09T05:59:59.999Z&status=abierto`;
		expect(scope_allows(grabada, url(tres_dias), ahora)).toBe(true);
		expect(scope_allows(grabada, url(tres_dias))).toBe(false);
		// El reporte de un día pasado se queda en ese día.
		const de_un_dia = [scope_entry_of(url('/api/reporte?dia=2026-09-01'))];
		expect(scope_allows(de_un_dia, url('/api/reporte?dia=2026-09-02'), ahora)).toBe(false);
		// Más historia, otra longitud, otro filtro o el futuro: no.
		expect(scope_allows(grabada, url(`${stats}?date_from=2026-01-01T06:00:00.000Z&date_to=2026-10-06T05:59:59.999Z&status=abierto`), ahora)).toBe(false);
		expect(scope_allows(grabada, url(`${stats}?date_from=2026-07-09T06:00:00.000Z&date_to=2026-10-10T05:59:59.999Z&status=abierto`), ahora)).toBe(false);
		expect(scope_allows(grabada, url(`${stats}?date_from=2026-07-09T06:00:00.000Z&date_to=2026-10-09T05:59:59.999Z&status=cerrado`), ahora)).toBe(false);
		expect(scope_allows(grabada, url(`${stats}?date_from=2027-07-09T06:00:00.000Z&date_to=2027-10-09T05:59:59.999Z&status=abierto`), ahora)).toBe(false);
		expect(scope_allows(grabada, url(`${stats}?date_from=2026-07-05&date_to=2026-10-05&status=abierto`), ahora)).toBe(false);
		// Otra forma de escribir la misma fecha (sin zona, otra zona, solo el día) no pasa.
		expect(scope_allows(grabada, url(`${stats}?date_from=2026-07-09T06:00:00&date_to=2026-10-09T05:59:59&status=abierto`), ahora)).toBe(false);
		expect(scope_allows(grabada, url(`${stats}?date_from=2026-07-09T06:00:00.000%2B00:00&date_to=2026-10-09T05:59:59.999%2B00:00&status=abierto`), ahora)).toBe(false);
		// Lo que no es fecha sigue exigiéndose tal cual.
		expect(scope_allows([scope_entry_of(url(`${PAGE}?id=T1`))], url(`${PAGE}?id=2026-10-09`), ahora)).toBe(false);
	});

	test('la clave canónica no depende del orden de los parámetros', () => {
		expect(scope_entry_of(url('/api/x?b=2&a=1')).key).toBe(scope_entry_of(url('/api/x?a=1&b=2')).key);
	});

	test('rutas que un enlace nunca alcanza', () => {
		for (const path of ['/api/auth', '/api/auth/menus', '/api/compartir/bloqueos', '/api/subjects', '/api/mcp-agent/x', '/api/db-admin/sql']) {
			expect(is_denied_path(path)).toBe(true);
		}
		expect(is_denied_path('/api/employee')).toBe(false);
		expect(is_denied_path('/api/authors')).toBe(false);
	});
});

describe('bloqueos del administrador', () => {
	const resource_app = (resource: string) => (resource === 'employee' ? 'subject-rh' : null);

	test('qué app y recurso toca cada llamada', () => {
		expect(touched_by(PAGE, resource_app)).toEqual({ app: 'subject-herramientas', resource: null });
		expect(touched_by('/api/m/subject-herramientas/herr-registros/abc', resource_app)).toEqual({
			app: 'subject-herramientas',
			resource: 'herr-registros',
		});
		expect(touched_by('/api/employee/abc', resource_app)).toEqual({ app: 'subject-rh', resource: 'employee' });
		expect(touched_by('/api/media/abc', resource_app)).toEqual({ app: null, resource: null });
	});

	test('una ruta bloquea su vista y las de debajo; con query, solo esa', () => {
		const blocks: ShareBlock[] = [{ kind: 'ruta', key: '/internal/employee', label: '' }];
		const check = (target: string) => blocked_by(blocks, { target, paths: [], resource_app });
		expect(check('/internal/employee')).not.toBeNull();
		expect(check('/internal/employee/detail/x/1')).not.toBeNull();
		expect(check('/internal/employees')).toBeNull();
		const one: ShareBlock[] = [{ kind: 'ruta', key: '/internal/herr-tabla?id=T9', label: '' }];
		expect(blocked_by(one, { target: '/internal/herr-tabla?id=T9&modo=x', paths: [], resource_app })).not.toBeNull();
		expect(blocked_by(one, { target: '/internal/herr-tabla?id=T1', paths: [], resource_app })).toBeNull();
	});

	test('lo que lee rutas negadas o captura en el dispositivo no se comparte aunque nadie lo bloquee', () => {
		const check = (target: string) => blocked_by([], { target, paths: [], resource_app });
		expect(check('/internal/database-manager/health')).not.toBeNull();
		expect(check('/internal/user-pin')).not.toBeNull();
		expect(check('/internal/module-management')).not.toBeNull();
		expect(check('/internal/pos/venta')).not.toBeNull();
		expect(check('/internal/kiosk/form/new')).not.toBeNull();
		expect(check('/internal/pos-session')).toBeNull();
		expect(check('/internal/dbm-runs')).toBeNull();
	});

	test('una app o un recurso bloquean por lo que la vista lee', () => {
		const app: ShareBlock[] = [{ kind: 'app', key: 'subject-rh', label: '' }];
		expect(blocked_by(app, { target: '/internal/tablero', paths: ['/api/employee'], resource_app })).not.toBeNull();
		expect(blocked_by(app, { target: '/internal/x', paths: [], app: 'subject-rh', resource_app })).not.toBeNull();
		expect(blocked_by(app, { target: '/internal/x', paths: [PAGE], resource_app })).toBeNull();
		const resource: ShareBlock[] = [{ kind: 'recurso', key: 'herr-registros', label: '' }];
		expect(
			blocked_by(resource, { target: '/internal/x', paths: ['/api/m/subject-herramientas/herr-registros'], resource_app }),
		).not.toBeNull();
	});
});

describe('permisos de un enlace', () => {
	test('la app recibe solo lectura de lo que el dueño ve', () => {
		const grants = share_grants({
			slug: 'herramientas',
			modules: [{ resource: 'herr-tablas' }],
			is_admin: false,
			grants: [
				{ resource: 'kirlet.herramientas.herr-tablas', c: true, r: true, u: true, d: true },
				{ resource: 'kirlet.herramientas.herr-voz', c: true, r: false, u: false, d: false },
			],
		});
		expect(grants).toEqual([{ resource: 'kirlet.herramientas.herr-tablas', c: false, r: true, u: false, d: false }]);
	});

	test('un dueño admin lee cada módulo de la app, sin ser admin', () => {
		const grants = share_grants({
			slug: 'herramientas',
			modules: [{ resource: 'herr-tablas' }, { resource: 'herr-registros' }, { resource: 'herr-tablas' }],
			is_admin: true,
			grants: [],
		});
		expect(grants.map((grant) => grant.resource)).toEqual([
			'kirlet.herramientas.herr-tablas',
			'kirlet.herramientas.herr-registros',
		]);
		expect(grants.every((grant) => grant.r && !grant.c && !grant.u && !grant.d)).toBe(true);
	});

	test('el front del visitante lee lo que lee el dueño y no escribe', () => {
		const rights = share_access_rights({
			access_granted: true,
			has_full_access: true,
			has_user_groups: true,
			models: ['Employee'],
			menu_ids: ['m1'],
			user_group_ids: ['g1'],
			user_group_refs: ['r1'],
			permissions_by_model: { Employee: { allow_read: true, allow_create: true, allow_update: true, allow_delete: true } },
			record_rules_by_model: {},
			user_group_names: ['Admins'],
			allowed_groups: [],
			message: '',
			model: '',
			method: 'Leer',
		} as never);
		expect(rights.has_full_access).toBe(false);
		expect(rights.permissions_by_model).toEqual({
			Employee: { allow_read: true, allow_create: false, allow_update: false, allow_delete: false },
		});
		expect(rights.user_group_ids).toEqual([]);
	});

	test('un adjunto se sirve si es de la app o el recurso que la vista lee', () => {
		const binding = { share_id: 'tok', owner: OWNER, target: '/internal/herr-tabla?id=T1', scope: share().scope };
		expect(share_allows_media(binding, 'subject-herramientas:herr-registros')).toBe(true);
		expect(share_allows_media(binding, 'subject-tienda:productos')).toBe(false);
		expect(share_allows_media(binding, 'employee')).toBe(true);
		expect(share_allows_media(binding, 'Employee')).toBe(true);
		const reportes = { ...binding, scope: [scope_entry_of(url('/api/citizen-report?desde=0'))] };
		expect(share_allows_media(reportes, 'CitizenReport')).toBe(true);
		expect(share_allows_media(reportes, 'citizen_report')).toBe(true);
		expect(share_allows_media(binding, 'user')).toBe(false);
		expect(share_allows_media(binding, '')).toBe(false);
	});
});

describe('petición que trae un enlace', () => {
	test('sin token, o hacia algo ya público, sigue como siempre', async () => {
		const { value } = deps();
		expect((await gate_share_request(new Request(`${BASE}${PAGE}?id=T1`), url(`${PAGE}?id=T1`), value)).kind).toBe('none');
		const branding = shared_req('/api/auth/branding');
		expect((await gate_share_request(branding, url('/api/auth/branding'), value)).kind).toBe('none');
		const portal = shared_req('/api/p/m/subject-tienda/pages/x');
		expect((await gate_share_request(portal, url('/api/p/m/subject-tienda/pages/x'), value)).kind).toBe('none');
	});

	test('dentro del alcance, la petición es del dueño aunque el visitante traiga sesión', async () => {
		const { value } = deps({ cookie_user: VISITOR });
		const req = shared_req(`${PAGE}?id=T1`);
		const gate = await gate_share_request(req, url(`${PAGE}?id=T1`), value);
		expect(gate.kind).toBe('bound');
		expect(gate.kind === 'bound' && gate.record).toBe(false);
		expect(share_binding_of(req)?.owner).toEqual(OWNER);
	});

	test('cada estado del enlace corta con su código', async () => {
		const ask = async (row: Share | null, cookie_user: ImperiumDoc | null = null) => {
			const { value } = deps({ row, cookie_user });
			return status_of(await gate_share_request(shared_req(`${PAGE}?id=T1`), url(`${PAGE}?id=T1`), value));
		};
		expect(await ask(null)).toEqual([404, 'compartido_no_existe']);
		expect(await ask(share({ state: 'retirado' }))).toEqual([410, 'compartido_retirado']);
		expect(await ask(share({ expires_at: NOW - 1 }))).toEqual([410, 'compartido_caducado']);
		expect(await ask(share({ state: 'borrador' }))).toEqual([404, 'compartido_no_existe']);
		expect(await ask(share({ state: 'borrador' }), VISITOR)).toEqual([404, 'compartido_no_existe']);
		expect(await ask(share({ state: 'borrador', created_at: NOW - 2 * 3600_000 }), OWNER)).toEqual([410, 'compartido_caducado']);
		expect(await ask(share({ expires_at: NOW + 60_000 }))).toEqual([0, 'bound']);
	});

	test('en borrador, solo la sesión del dueño pasa, y graba lo que pide', async () => {
		const { value } = deps({ row: share({ state: 'borrador', scope: [] }), cookie_user: OWNER });
		const gate = await gate_share_request(shared_req('/api/employee?desde=0'), url('/api/employee?desde=0'), value);
		expect(gate.kind === 'bound' && gate.record).toBe(true);
	});

	test('solo lectura, nada fuera del alcance y nada de lo prohibido', async () => {
		const { value } = deps({ cookie_user: OWNER });
		const post = shared_req(PAGE, { method: 'POST' });
		expect(await status_of(await gate_share_request(post, url(PAGE), value))).toEqual([403, 'compartido_solo_lectura']);
		const other = `${PAGE}?id=T2`;
		expect(await status_of(await gate_share_request(shared_req(other), url(other), value))).toEqual([
			403,
			'compartido_fuera_de_alcance',
		]);
		const menus = shared_req('/api/auth/menus');
		expect(await status_of(await gate_share_request(menus, url('/api/auth/menus'), value))).toEqual([
			403,
			'compartido_fuera_de_alcance',
		]);
		const draft = deps({ row: share({ state: 'borrador' }), cookie_user: OWNER }).value;
		expect(await status_of(await gate_share_request(shared_req('/api/auth'), url('/api/auth'), draft))).toEqual([
			403,
			'compartido_fuera_de_alcance',
		]);
	});

	test('lo bloqueado por el admin deja de verse aunque el enlace ya exista', async () => {
		const { value } = deps({ blocks: [{ kind: 'app', key: 'subject-rh', label: 'RH' }] });
		const path = '/api/employee?desde=0&limite=20';
		expect(await status_of(await gate_share_request(shared_req(path), url(path), value))).toEqual([
			403,
			'compartido_bloqueado',
		]);
	});

	test('una imagen llega con el token en la query y no se graba', async () => {
		const { value } = deps({ row: share({ state: 'borrador' }), cookie_user: OWNER });
		const req = new Request(`${BASE}/api/media/a1?compartido=tok`);
		const gate = await gate_share_request(req, url('/api/media/a1?compartido=tok'), value);
		expect(gate.kind === 'bound' && gate.record).toBe(false);
		const active = deps().value;
		const other = new Request(`${BASE}/api/employee?compartido=tok`);
		expect((await gate_share_request(other, url('/api/employee?compartido=tok'), active)).kind).toBe('none');
	});

	test('un dueño que ya no puede entrar se lleva sus enlaces', async () => {
		const { value } = deps({ load_owner: async () => null });
		expect(await status_of(await gate_share_request(shared_req(`${PAGE}?id=T1`), url(`${PAGE}?id=T1`), value))).toEqual([
			404,
			'compartido_no_existe',
		]);
	});
});

describe('GET /api/p/compartido/:id', () => {
	const resolve = (value: PublicShareDeps, id = 'tok') =>
		handle_public_share(new Request(`${BASE}/api/p/compartido/${id}`), url(`/api/p/compartido/${id}`), value);

	test('da la ruta, lo oculto, los permisos de solo lectura y cuenta la visita', async () => {
		const { value, counted } = deps({ cookie_user: VISITOR });
		const res = await resolve(value);
		expect(res.status).toBe(200);
		const { data } = (await res.json()) as { data: Record<string, unknown> };
		expect(data.ruta).toBe('/internal/herr-tabla?id=T1');
		expect(data.ocultos).toEqual(['abc123']);
		expect(data.ocultos_globales).toEqual(['global1']);
		expect(data.es_dueno).toBe(false);
		expect(data.dueno).toBe('Dueña');
		expect(data).not.toHaveProperty('dueno_id');
		expect(data).not.toHaveProperty('llamadas');
		expect((data.permisos as Record<string, unknown>).has_full_access).toBe(false);
		expect(counted).toEqual(['tok']);
	});

	test('sin nombre no se enseña el correo del dueño', async () => {
		const { value } = deps({ load_owner: async () => ({ _id: 'u-dueno', email: 'duena@x.mx', type: 'internal' }) });
		const { data } = (await (await resolve(value)).json()) as { data: Record<string, unknown> };
		expect(data.dueno).toBe('');
	});

	test('al dueño no se le cuenta la visita y se le dice que es suyo', async () => {
		const { value, counted } = deps({ cookie_user: OWNER });
		const { data } = (await (await resolve(value)).json()) as { data: Record<string, unknown> };
		expect(data.es_dueno).toBe(true);
		expect(counted).toEqual([]);
	});

	test('lo bloqueado o caducado no se resuelve', async () => {
		expect((await resolve(deps({ blocks: [{ kind: 'recurso', key: 'employee', label: '' }] }).value)).status).toBe(403);
		expect((await resolve(deps({ row: share({ expires_at: NOW }) }).value)).status).toBe(410);
		expect((await resolve(deps().value, 'otro')).status).toBe(404);
	});
});
