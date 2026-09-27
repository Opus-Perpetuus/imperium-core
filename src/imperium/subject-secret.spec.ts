import { describe, expect, test } from 'bun:test';
import { derive_subject_secret, secret_equals } from './subject-secret.ts';

describe('derive_subject_secret', () => {
	// Mismo vector que imperium-sic-deploy/files/subject-secrets.test.sh: si cambia
	// aquí, el host deja de escribir el secreto que el núcleo espera.
	test('vector compartido con el host', () => {
		expect(derive_subject_secret('imperium-subject-dev-secret', 'subject-pos')).toBe(
			'6ba2fac89a99d3a47fecb6dc2a785c29312a440fc23773b09d481dd814e08761',
		);
		expect(
			derive_subject_secret('imperium-subject-dev-secret', 'subject-database-manager'),
		).toBe('286855a2b6ef55b76f28fb070d082d187b06f0a5c2f16d8132ecb11ecbb341d6');
	});

	test('cada app obtiene uno distinto', () => {
		expect(derive_subject_secret('m', 'subject-a')).not.toBe(
			derive_subject_secret('m', 'subject-b'),
		);
	});
});

describe('secret_equals', () => {
	test('vacío nunca coincide', () => {
		expect(secret_equals('', '')).toBe(false);
		expect(secret_equals('a', '')).toBe(false);
		expect(secret_equals('', 'a')).toBe(false);
	});

	test('compara contenido y longitud', () => {
		expect(secret_equals('abc', 'abc')).toBe(true);
		expect(secret_equals('abc', 'abd')).toBe(false);
		expect(secret_equals('abc', 'abcd')).toBe(false);
	});
});
