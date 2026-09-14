import { describe, expect, test } from 'bun:test';
import { verify_kirlet_identity } from '@opus-perpetuus/imperium-core-kit';
import { reshape_subject_menus } from './auth.ts';
import {
	anonymous_subject_identity,
	apply_subject_identity_headers,
	principal_type_of,
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
