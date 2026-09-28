import { describe, expect, test } from 'bun:test';
import { kirlet_identity_can, verify_kirlet_identity } from '@opus-perpetuus/imperium-core-kit';
import { reshape_subject_menus } from './auth.ts';
import { keep_reshaped_menus_for_access } from './group-access.ts';
import {
	anonymous_subject_identity,
	apply_subject_identity_headers,
	principal_type_of,
	sees_dependent_of,
	service_subject_identity,
	subject_grant_refs,
	subject_grants_from_menus,
} from './subject-identity.ts';

const MODULES = [
	{ resource: 'providers', menu_ref: 'tienda-providers' },
	{ resource: 'orders', menu_ref: 'tienda-orders' },
	{ resource: 'pricing', menu_ref: 'tienda-pricing' },
];

describe('grants de app desde los menús que el lanzador pinta', () => {
	test('admin no lleva grants: is_admin abre todo en el kit', () => {
		expect(
			subject_grants_from_menus({
				slug: 'tienda',
				modules: MODULES,
				has_full_access: true,
				visible_menu_refs: [],
			}),
		).toEqual([]);
	});

	test('solo los módulos cuyo menú el usuario ve', () => {
		const grants = subject_grants_from_menus({
			slug: 'tienda',
			modules: MODULES,
			has_full_access: false,
			visible_menu_refs: ['tienda-orders'],
		});
		expect(grants.map((g) => g.resource)).toEqual(['kirlet.tienda.orders']);
		expect(grants[0]).toMatchObject({ c: true, r: true, u: true, d: true });
	});

	test('sin ningún menú visible no hay un solo grant', () => {
		expect(
			subject_grants_from_menus({
				slug: 'tienda',
				modules: MODULES,
				has_full_access: false,
				visible_menu_refs: ['menu-de-otra-cosa'],
			}),
		).toEqual([]);
	});

	test('un menú declarado da los grants de sus resources; :read solo lectura', () => {
		const refs = subject_grant_refs({
			modules: [{ resource: 'grupo', menu_ref: 'grupo-menu' }],
			menus: [
				{ menu_ref: 'ce-tipos', resources: ['tipos-incidencia'] },
				{ menu_ref: 'ce-examenes', resources: ['examenes', 'periodos-examen:read'] },
				{ menu_ref: 'ce-periodos', resources: ['periodos-examen'] },
				{ menu_ref: 'ce-carpeta' },
			],
		});
		const solo_examenes = subject_grants_from_menus({
			slug: 'ce',
			modules: refs,
			has_full_access: false,
			visible_menu_refs: ['ce-examenes'],
		});
		expect(solo_examenes).toEqual([
			{ resource: 'kirlet.ce.examenes', c: true, r: true, u: true, d: true },
			{ resource: 'kirlet.ce.periodos-examen', c: false, r: true, u: false, d: false },
		]);
		// Dos menús que dan el mismo recurso se combinan: gana el permiso más amplio.
		const ambos = subject_grants_from_menus({
			slug: 'ce',
			modules: refs,
			has_full_access: false,
			visible_menu_refs: ['ce-examenes', 'ce-periodos'],
		});
		expect(ambos.filter((g) => g.resource === 'kirlet.ce.periodos-examen')).toEqual([
			{ resource: 'kirlet.ce.periodos-examen', c: true, r: true, u: true, d: true },
		]);
	});

	/**
	 * La regresión que motivó el cambio: los menús de una app no existen como
	 * filas, los materializa `reshape_subject_menus` desde el catálogo. Buscarlos
	 * en la base por `_ref` devolvía cero y dejaba sin grants a todo no-admin.
	 */
	test('los refs salen de la materialización del catálogo, no de filas guardadas', () => {
		const reshaped = reshape_subject_menus(
			{
				subjects: [
					{
						slug: 'tienda',
						name: 'Tienda',
						menu_ref: 'tienda-menu-root',
						path: '/tienda',
						modules: [
							{ resource: 'orders', name: 'Pedidos', path: '/orders', menu_ref: 'tienda-orders' },
						],
					},
				],
			} as unknown as Parameters<typeof reshape_subject_menus>[0],
			[],
			new Set<string>(),
			true,
		);
		const refs = reshaped.map((row) => String(row._ref ?? ''));
		expect(refs).toContain('tienda-orders');
		expect(
			subject_grants_from_menus({
				slug: 'tienda',
				modules: [{ resource: 'orders', menu_ref: 'tienda-orders' }],
				has_full_access: false,
				visible_menu_refs: refs,
			}).map((g) => g.resource),
		).toEqual(['kirlet.tienda.orders']);
	});
});

describe('tipo de principal', () => {
	test('sin sesión es anónimo; type external es externo', () => {
		expect(principal_type_of(null)).toBe('anonymous');
		expect(principal_type_of({ type: 'external' })).toBe('external');
		expect(principal_type_of({ email: 'a@b.co' })).toBe('internal');
	});
});

describe('cabeceras de identidad', () => {
	const secret = 'imperium-subject-test-secret-000!';
	const identity = {
		user_id: 'u1',
		email: 'a@b.co',
		is_admin: false,
		kirlet_id: 'subject-tienda',
		grants: [],
		user_type: 'internal' as const,
		realm: 'internal' as const,
	};

	test('firma verificable por el kit', () => {
		const headers = new Headers();
		apply_subject_identity_headers(headers, identity, secret);
		const record: Record<string, string> = {};
		headers.forEach((v, k) => {
			record[k] = v;
		});
		const verified = verify_kirlet_identity(record, secret);
		expect(verified.ok).toBe(true);
		if (verified.ok) {
			expect(verified.identity.user_id).toBe('u1');
			expect(verified.identity.user_type).toBe('internal');
		}
	});

	test('la cabecera que mandó el cliente no sobrevive', () => {
		const headers = new Headers({
			'x-nox-is-admin': 'true',
			'x-nox-user-id': 'intruso',
			'x-nox-identity-sig': 'falsa',
		});
		apply_subject_identity_headers(headers, identity, secret);
		expect(headers.get('x-nox-user-id')).toBe('u1');
		expect(headers.get('x-nox-is-admin')).toBe('false');
		const record: Record<string, string> = {};
		headers.forEach((v, k) => {
			record[k] = v;
		});
		expect(verify_kirlet_identity(record, secret).ok).toBe(true);
	});

	test('sin secreto no queda ninguna cabecera de identidad', () => {
		const headers = new Headers({ 'x-nox-is-admin': 'true' });
		apply_subject_identity_headers(headers, identity, '');
		expect(headers.get('x-nox-is-admin')).toBeNull();
	});
});

describe('identidad anónima del realm público', () => {
	const secret = 'imperium-subject-test-secret-000!';

	test('un visitante sin sesión llega a la app como anónimo del realm público', () => {
		// El kit exige el centinela `anonymous` para un principal sin sesión.
		// Firmando cadenas vacías la verificación fallaba y la app se quedaba
		// sin identidad: construía sus enlaces como si fuera el lanzador
		// interno y mandaba a los clientes del escaparate a `/internal`.
		const headers = new Headers();
		apply_subject_identity_headers(
			headers,
			anonymous_subject_identity('subject-tienda', 'public'),
			secret,
		);
		const record: Record<string, string> = {};
		headers.forEach((v, k) => {
			record[k] = v;
		});
		const verified = verify_kirlet_identity(record, secret);
		expect(verified.ok).toBe(true);
		if (verified.ok) {
			expect(verified.identity.user_type).toBe('anonymous');
			expect(verified.identity.realm).toBe('public');
			expect(verified.identity.is_admin).toBe(false);
			expect(verified.identity.grants).toEqual([]);
		}
	});

	test('el anónimo interno también verifica', () => {
		const headers = new Headers();
		apply_subject_identity_headers(
			headers,
			anonymous_subject_identity('subject-tienda', 'internal'),
			secret,
		);
		const record: Record<string, string> = {};
		headers.forEach((v, k) => {
			record[k] = v;
		});
		const verified = verify_kirlet_identity(record, secret);
		expect(verified.ok).toBe(true);
		if (verified.ok) expect(verified.identity.realm).toBe('internal');
	});
});

describe('identidad de servicio de una app hacia otra', () => {
	const target = {
		technical_id: 'subject-ce',
		slug: 'ce',
		modules: [
			{ resource: 'grupo', menu_ref: 'ce-grupo' },
			{ resource: 'alumno' },
		],
		menus: [
			{ menu_ref: 'ce-examenes', resources: ['examenes', 'periodos-examen:read'] },
			{ menu_ref: 'ce-alumno', resources: ['alumno:read'] },
			{ menu_ref: 'ce-carpeta' },
		],
	};

	test('un grant por recurso, sin depender de menús visibles; :read solo lectura', () => {
		const identity = service_subject_identity({ caller: 'subject-pos', target });
		expect(identity).toMatchObject({
			user_id: 'subject:subject-pos',
			email: 'subject-pos',
			is_admin: false,
			kirlet_id: 'subject-ce',
			user_type: 'internal',
			realm: 'internal',
		});
		expect(identity.grants).toEqual([
			{ resource: 'kirlet.ce.grupo', c: true, r: true, u: true, d: true },
			// El módulo da escritura y el menú `:read` no se la quita.
			{ resource: 'kirlet.ce.alumno', c: true, r: true, u: true, d: true },
			{ resource: 'kirlet.ce.examenes', c: true, r: true, u: true, d: true },
			{ resource: 'kirlet.ce.periodos-examen', c: false, r: true, u: false, d: false },
		]);
		expect(kirlet_identity_can(identity, 'kirlet.ce.periodos-examen', 'read')).toBe(true);
		expect(kirlet_identity_can(identity, 'kirlet.ce.periodos-examen', 'create')).toBe(false);
		expect(kirlet_identity_can(identity, 'kirlet.ce.otro', 'read')).toBe(false);
	});

	test('sin módulos ni menús no hay grants', () => {
		expect(
			service_subject_identity({ caller: 'subject-pos', target: { technical_id: 'subject-x', slug: 'x' } })
				.grants,
		).toEqual([]);
	});

	test('firma y verifica como identidad v2 del kit', () => {
		const secret = 'imperium-subject-test-secret-000!';
		const headers = new Headers();
		apply_subject_identity_headers(
			headers,
			service_subject_identity({ caller: 'subject-pos', target }),
			secret,
		);
		const record: Record<string, string> = {};
		headers.forEach((v, k) => {
			record[k] = v;
		});
		const verified = verify_kirlet_identity(record, secret);
		expect(verified.ok).toBe(true);
		if (verified.ok) {
			expect(verified.identity.user_id).toBe('subject:subject-pos');
			expect(verified.identity.is_admin).toBe(false);
			expect(verified.identity.grants.map((g) => g.resource)).toContain('kirlet.ce.grupo');
		}
	});
});

describe('lectura de una app por las que dependen de ella', () => {
	const SUBJECTS = [
		{
			slug: 'vehiculos',
			name: 'Vehículos',
			technical_id: 'subject-vehiculos',
			menu_ref: 'vehiculos-menu-root',
			path: '/vehiculos',
			depends_on: [],
			modules: [{ resource: 'vehiculos', name: 'Vehículos', path: '/vehiculos/lista', menu_ref: 'veh-vehiculos' }],
			menus: [],
		},
		{
			slug: 'herramientas',
			name: 'Herramientas',
			technical_id: 'subject-herramientas',
			menu_ref: 'herramientas-menu-root',
			path: '/herramientas',
			depends_on: ['subject-vehiculos'],
			modules: [],
			menus: [{ menu_ref: 'herr-gastos', name: 'Gastos', path: '/herramientas/gastos', icon: 'fa-coins' }],
		},
		{
			slug: 'tienda',
			name: 'Tienda',
			technical_id: 'subject-tienda',
			menu_ref: 'tienda-menu-root',
			path: '/tienda',
			depends_on: [],
			modules: [],
			menus: [{ menu_ref: 'tienda-pedidos', name: 'Pedidos', path: '/tienda/pedidos', icon: 'fa-box' }],
		},
	];
	const reshaped = reshape_subject_menus(
		{ subjects: SUBJECTS } as unknown as Parameters<typeof reshape_subject_menus>[0],
		[],
		new Set<string>(),
		false,
	);
	const visible_for = (ids: string[]) =>
		keep_reshaped_menus_for_access(
			ids.map((_id) => ({ _id })),
			reshaped,
		);
	const VEH_MODULES = subject_grant_refs({
		modules: [
			{ resource: 'vehiculos', menu_ref: 'veh-vehiculos' },
			{ resource: 'bitacora' },
		],
		menus: [{ menu_ref: 'veh-rutas', resources: ['rutas', 'zonas:read'] }],
	});

	test('ver un menú de una app dependiente cuenta aunque sea una hoja', () => {
		const menus = visible_for(['herr-gastos']);
		expect(
			sees_dependent_of({ technical_id: 'subject-vehiculos', subjects: SUBJECTS, visible_menus: menus }),
		).toBe(true);
	});

	test('una app que no depende del destino, o el propio destino, no cuenta', () => {
		for (const ids of [['tienda-pedidos'], ['veh-vehiculos'], []]) {
			expect(
				sees_dependent_of({
					technical_id: 'subject-vehiculos',
					subjects: SUBJECTS,
					visible_menus: visible_for(ids),
				}),
			).toBe(false);
		}
		expect(
			sees_dependent_of({
				technical_id: 'subject-herramientas',
				subjects: SUBJECTS,
				visible_menus: visible_for(['herr-gastos']),
			}),
		).toBe(false);
	});

	test('con dependiente visible: solo lectura sobre todos los recursos del destino', () => {
		expect(
			subject_grants_from_menus({
				slug: 'vehiculos',
				modules: VEH_MODULES,
				has_full_access: false,
				visible_menu_refs: ['herr-gastos'],
				dependent_read: true,
			}),
		).toEqual([
			{ resource: 'kirlet.vehiculos.vehiculos', c: false, r: true, u: false, d: false },
			{ resource: 'kirlet.vehiculos.bitacora', c: false, r: true, u: false, d: false },
			{ resource: 'kirlet.vehiculos.rutas', c: false, r: true, u: false, d: false },
			{ resource: 'kirlet.vehiculos.zonas', c: false, r: true, u: false, d: false },
		]);
	});

	test('el grant de escritura por menú propio no se rebaja', () => {
		const grants = subject_grants_from_menus({
			slug: 'vehiculos',
			modules: VEH_MODULES,
			has_full_access: false,
			visible_menu_refs: ['veh-rutas'],
			dependent_read: true,
		});
		expect(grants.find((g) => g.resource === 'kirlet.vehiculos.rutas')).toEqual({
			resource: 'kirlet.vehiculos.rutas',
			c: true,
			r: true,
			u: true,
			d: true,
		});
		expect(grants.find((g) => g.resource === 'kirlet.vehiculos.vehiculos')).toMatchObject({
			c: false,
			r: true,
		});
	});

	test('sin dependiente visible nada cambia', () => {
		expect(
			subject_grants_from_menus({
				slug: 'vehiculos',
				modules: VEH_MODULES,
				has_full_access: false,
				visible_menu_refs: ['tienda-pedidos'],
				dependent_read: false,
			}),
		).toEqual([]);
	});
});
