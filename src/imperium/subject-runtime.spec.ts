import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	BASE_SUBJECT_SLUGS,
	compose_install_args,
	compose_project_args,
	compose_rm_args,
	compose_stop_args,
	handle_operator_http,
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
		expect(is_base_subject_slug('reportes')).toBe(true);
		expect(is_base_subject_slug('subject-reportes')).toBe(true);
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

	test('operator compose file declares a service for every catalog slug including tienda', () => {
		const catalog = JSON.parse(
			readFileSync(new URL('../../catalog.json', import.meta.url), 'utf8'),
		) as { subjects: Array<{ slug: string }> };
		const compose = readFileSync(
			new URL('../../../docker-compose.yml', import.meta.url),
			'utf8',
		);
		const missing: string[] = [];
		for (const subject of catalog.subjects) {
			const service = subject_service_name(subject.slug);
			const declared = new RegExp(`^  ${service}:`, 'm').test(compose);
			if (!declared) missing.push(service);
		}
		expect(missing).toEqual([]);
		expect(compose).toContain('subject-tienda:');
	});
});

describe('operador: leer el manifiesto de una imagen', () => {
	const SECRET = process.env.CORE_SUBJECT_GATEWAY_SECRET;
	afterEach(() => {
		if (SECRET == null) delete process.env.CORE_SUBJECT_GATEWAY_SECRET;
		else process.env.CORE_SUBJECT_GATEWAY_SECRET = SECRET;
	});
	const ask = (path: string, secret?: string) =>
		handle_operator_http(
			new Request(`http://operador${path}`, {
				headers: secret ? { 'x-core-subject-gateway-secret': secret } : {},
			}),
		);

	test('solo el núcleo (secreto maestro)', async () => {
		process.env.CORE_SUBJECT_GATEWAY_SECRET = 'maestro';
		const res = await ask('/runtime/pos/manifest?image=ghcr.io/opus-perpetuus/subject-pos:0.3.0');
		expect(res.status).toBe(403);
	});

	test('no baja imágenes de otra app ni de otro registro', async () => {
		process.env.CORE_SUBJECT_GATEWAY_SECRET = 'maestro';
		for (const image of [
			'ghcr.io/opus-perpetuus/subject-tienda:0.3.0',
			'docker.io/library/alpine:3',
			'',
		]) {
			const res = await ask(`/runtime/pos/manifest?image=${encodeURIComponent(image)}`, 'maestro');
			expect([image, res.status]).toEqual([image, 400]);
		}
	});
});

test('el operador no corta a los 10 s una descarga del núcleo, y a nadie más le quita el corte', () => {
	const src = readFileSync(new URL('../subject-operator.ts', import.meta.url), 'utf8');
	expect(src).toContain('if (is_master_request(req)) srv.timeout(req, 0);');
	expect(src).not.toContain('idleTimeout: 0');
});
