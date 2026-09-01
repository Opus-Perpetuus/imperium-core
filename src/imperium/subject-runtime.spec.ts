import { describe, expect, test } from 'bun:test';
import {
	BASE_SUBJECT_SLUGS,
	compose_install_args,
	compose_project_args,
	compose_rm_args,
	compose_stop_args,
	is_base_subject_slug,
	normalize_subject_slug,
	subject_image_ref,
	subject_service_name,
} from './subject-runtime.ts';

describe('subject-runtime', () => {
	test('normalizes and rejects unsafe slugs', () => {
		expect(normalize_subject_slug('subject-pos')).toBe('pos');
		expect(normalize_subject_slug('control-municipal')).toBe(
			'control-municipal',
		);
		expect(normalize_subject_slug('../etc')).toBeNull();
		expect(normalize_subject_slug('POS')).toBeNull();
		expect(normalize_subject_slug('pos;rm')).toBeNull();
	});

	test('base slugs cannot be uninstalled', () => {
		expect(is_base_subject_slug('configuracion')).toBe(true);
		expect(is_base_subject_slug('subject-planeacion')).toBe(true);
		expect(is_base_subject_slug('pos')).toBe(false);
		expect(BASE_SUBJECT_SLUGS.has('configuraciones-de-vista')).toBe(true);
	});

	test('compose args never include down, volumes or DROP', () => {
		const up = compose_install_args('subject-pos', ['subjects']).join(' ');
		const stop = compose_stop_args('subject-ventas', ['subjects']).join(' ');
		const rm = compose_rm_args('subject-ventas', ['subjects']).join(' ');
		expect(up).toBe('--profile subjects up -d --no-deps subject-pos');
		expect(stop).toBe('--profile subjects stop subject-ventas');
		expect(rm).toBe('--profile subjects rm -f subject-ventas');
		expect(rm.split(' ').includes('-v')).toBe(false);
		expect(rm.includes('--volumes')).toBe(false);
		expect(up.split(' ').includes('down')).toBe(false);
	});

	test('compose project flag is allowlisted', () => {
		expect(compose_project_args('imperium-sic-v13')).toEqual([
			'-p',
			'imperium-sic-v13',
		]);
		expect(compose_project_args('modular')).toEqual(['-p', 'modular']);
		expect(compose_project_args('../etc')).toEqual([]);
		expect(compose_project_args('')).toEqual([]);
	});

	test('image refs stay on the allowlisted ghcr repo', () => {
		expect(
			subject_image_ref({
				slug: 'pos',
				image: 'ghcr.io/opus-perpetuus/subject-pos:0.1.0',
			}),
		).toBe('ghcr.io/opus-perpetuus/subject-pos:0.1.0');
		expect(subject_service_name('almacen')).toBe('subject-almacen');
	});
});
