import { describe, expect, test } from 'bun:test';
import {
	coerce_hours,
	image_parts,
	is_newer_same_major,
	manifest_fits_catalog,
	NEEDS_CATALOG,
	newest_same_major,
	parse_version_holds,
	soaked,
	subject_update_target,
	update_wanted,
	type UpdateTarget,
} from './subject-versions.ts';
import { is_base_subject_slug } from './subject-runtime.ts';

const img = (tag: string, app = 'pos') => `ghcr.io/opus-perpetuus/subject-${app}:${tag}`;

describe('versiones del registro', () => {
	test('la más nueva del mismo major; latest, prereleases y otros majors fuera', () => {
		const tags = ['0.1.0', 'latest', '0.1.1', '0.10.0', '0.2.0', '0.11.0-rc1', '1.0.0', '13.26.0'];
		expect(newest_same_major(tags, '0.1.1')).toBe('0.10.0');
		expect(newest_same_major(tags, '1.0.0')).toBe('1.0.0');
		expect(newest_same_major(tags, 'latest')).toBeNull();
		expect(newest_same_major([], '0.1.0')).toBeNull();
	});

	test('más nueva solo dentro del mismo major', () => {
		expect(is_newer_same_major('0.2.0', '0.1.9')).toBe(true);
		expect(is_newer_same_major('0.1.9', '0.2.0')).toBe(false);
		expect(is_newer_same_major('1.0.0', '0.9.0')).toBe(false);
		expect(is_newer_same_major('0.2.0', '0.2.0')).toBe(false);
		expect(is_newer_same_major('latest', '0.1.0')).toBe(false);
	});

	test('image_parts solo reconoce imágenes de apps', () => {
		expect(image_parts(img('0.3.1'))).toEqual({
			repo: 'ghcr.io/opus-perpetuus/subject-pos',
			tag: '0.3.1',
		});
		expect(image_parts('docker.io/otro/cosa:1.0')).toBeNull();
	});
});

describe('versiones fijadas por servidor', () => {
	test('congelar, versión exacta y basura ignorada', () => {
		const holds = parse_version_holds('tienda; pos=0.3.1, subject-rh=0.2.0\nbasura=abc; ;Mal Slug');
		expect([...holds]).toEqual([
			['tienda', { freeze: true }],
			['pos', { tag: '0.3.1' }],
			['rh', { tag: '0.2.0' }],
		]);
	});

	test('un valor que no es texto no fija nada', () => {
		expect(parse_version_holds(true).size).toBe(0);
		expect(parse_version_holds(null).size).toBe(0);
		expect(parse_version_holds('').size).toBe(0);
	});
});

describe('objetivo de actualización', () => {
	const found = (tag: string, extra: Partial<{ created_at: string; note: string }> = {}) => ({
		image: img(tag),
		created_at: extra.created_at ?? '2026-09-01T00:00:00Z',
		note: extra.note ?? null,
	});

	test('sin versión descubierta, el pin', () => {
		expect(subject_update_target({ pin: img('0.2.0') })).toEqual({
			image: img('0.2.0'),
			source: 'catalog',
			created_at: null,
		});
	});

	test('la descubierta gana si es más nueva en el mismo major', () => {
		expect(subject_update_target({ pin: img('0.2.0'), discovered: found('0.3.0') })).toMatchObject({
			image: img('0.3.0'),
			source: 'registry',
		});
	});

	test('el pin gana si la descubierta no es más nueva, es de otro major, de otra app o necesita catálogo', () => {
		for (const discovered of [
			found('0.2.0'),
			found('0.1.9'),
			found('1.0.0'),
			{ ...found('0.3.0'), image: img('0.3.0', 'tienda') },
			found('0.3.0', { note: NEEDS_CATALOG }),
		]) {
			expect(subject_update_target({ pin: img('0.2.0'), discovered })?.source).toBe('catalog');
		}
	});

	test('si la pasada no acepta la descubierta (espera), cae al pin', () => {
		expect(
			subject_update_target({
				pin: img('0.2.0'),
				discovered: found('0.3.0'),
				accept_discovered: () => false,
			})?.image,
		).toBe(img('0.2.0'));
	});

	test('congelada no tiene objetivo; versión exacta va a esa imagen', () => {
		expect(subject_update_target({ pin: img('0.2.0'), hold: { freeze: true } })).toBeNull();
		expect(
			subject_update_target({ pin: img('0.2.0'), discovered: found('0.3.0'), hold: { tag: '0.1.0' } }),
		).toEqual({ image: img('0.1.0'), source: 'hold', created_at: null });
	});
});

describe('cuándo hay que mover una app', () => {
	const to = (tag: string, source: UpdateTarget['source'] = 'catalog'): UpdateTarget => ({
		image: img(tag),
		source,
		created_at: null,
	});

	test('dentro del mismo major solo sube', () => {
		expect(update_wanted(img('0.1.0'), to('0.2.0'))).toBe(true);
		// Una tarjeta de Odoo más vieja que lo que ya corre no regresa la app.
		expect(update_wanted(img('0.3.0'), to('0.2.0'))).toBe(false);
		expect(update_wanted(img('0.2.0'), to('0.2.0'))).toBe(false);
	});

	test('una versión fijada sí regresa', () => {
		expect(update_wanted(img('0.3.0'), to('0.2.0', 'hold'))).toBe(true);
	});

	test('entre majors o tags que no son semver manda el pin', () => {
		expect(update_wanted(img('13.26.0'), to('0.1.2'))).toBe(true);
		expect(update_wanted(img('latest'), to('0.1.2'))).toBe(true);
	});

	test('sin imagen instalada conocida o sin objetivo, nada', () => {
		expect(update_wanted(null, to('0.2.0'))).toBe(false);
		expect(update_wanted(img('0.1.0'), null)).toBe(false);
	});
});

describe('espera antes de instalar una versión descubierta', () => {
	const now = Date.parse('2026-09-30T12:00:00Z');
	test('cuenta desde que se construyó la imagen', () => {
		expect(soaked('2026-09-29T11:00:00Z', 24, now)).toBe(true);
		expect(soaked('2026-09-29T13:00:00Z', 24, now)).toBe(false);
		expect(soaked('2026-09-30T12:00:00Z', 0, now)).toBe(true);
	});
	test('sin fecha conocida no pasa', () => {
		expect(soaked(null, 0, now)).toBe(false);
		expect(soaked('no es fecha', 0, now)).toBe(false);
	});
	test('horas del parámetro', () => {
		expect(coerce_hours(48)).toBe(48);
		expect(coerce_hours('0')).toBe(0);
		expect(coerce_hours('')).toBe(24);
		expect(coerce_hours(true)).toBe(24);
		expect(coerce_hours(-3)).toBe(24);
	});
});

describe('¿cabe la versión nueva en el catálogo del servidor?', () => {
	const sub = {
		depends_on: ['subject-almacen'],
		modules: [{ resource: 'pedidos', path: '/pedidos', menu_ref: 'x', name: 'Pedidos' }],
		menus: [{ menu_ref: 'm', name: 'M', icon: 'fa-x', resources: ['reportes-pos:read'] }],
	};
	const is_base = (tid: string) => is_base_subject_slug(tid);

	test('lo que ya declaraba la versión instalada no cuenta (recursos del escaparate)', () => {
		const current = { resources: { pedidos: {}, store: {}, tracking: {} }, dependsOn: [] };
		const next = { resources: { pedidos: {}, store: {}, tracking: {}, 'reportes-pos': {} }, dependsOn: ['subject-almacen'] };
		expect(manifest_fits_catalog(sub, next, current, is_base)).toEqual({ ok: true });
	});

	test('un recurso o una dependencia nuevos que el catálogo no conoce piden catálogo', () => {
		const next = { resources: { pedidos: {}, cupones: {} }, dependsOn: ['subject-almacen', 'subject-pagos'] };
		expect(manifest_fits_catalog(sub, next, { resources: { pedidos: {} } }, is_base)).toEqual({
			ok: false,
			dependencies: ['subject-pagos'],
			resources: ['cupones'],
		});
	});

	test('las apps base no cuentan como dependencia; sin manifiesto actual se compara con el catálogo', () => {
		expect(
			manifest_fits_catalog(sub, { resources: ['pedidos'], dependsOn: ['subject-configuracion'] }, null, is_base),
		).toEqual({ ok: true });
		expect(manifest_fits_catalog(sub, { resources: { store: {} } }, null, is_base)).toEqual({
			ok: false,
			dependencies: [],
			resources: ['store'],
		});
	});
});
