import { describe, expect, test } from 'bun:test';
import {
	FieldValidationError,
	assert_required_fields,
} from './required-fields.ts';
import {
	SubjectNotInstalledError,
	planned_missing_install_rows,
	subject_is_installed,
	subject_marker_display_name,
	subject_not_installed_body,
} from './subjects-admin.ts';

describe('subject_is_installed', () => {
	test('SQL catalog row is the source of truth when present', () => {
		expect(subject_is_installed({ installed: false }, [{ is_enable: true }])).toBe(
			false,
		);
		expect(subject_is_installed({ installed: true }, [{ is_enable: false }])).toBe(
			true,
		);
	});

	test('without catalog row, falls back to any enabled module-management row', () => {
		expect(subject_is_installed(undefined, [])).toBe(false);
		expect(subject_is_installed(undefined, [{ is_enable: false }])).toBe(false);
		expect(subject_is_installed(undefined, [{ is_enable: true }])).toBe(true);
		expect(
			subject_is_installed(undefined, [
				{ is_enable: false },
				{ is_enable: 'false' },
			]),
		).toBe(false);
	});

	test('uninstalled catalog row hides the subject even if module rows are missing', () => {
		expect(subject_is_installed({ installed: false }, [])).toBe(false);
	});

	test('installing/uninstalling counts as not installed', () => {
		expect(
			subject_is_installed({ installed: false }, [{ is_enable: true }]),
		).toBe(false);
	});
});

describe('planned_missing_install_rows', () => {
	test('seeds only subjects that have no install row yet', () => {
		const subjects = [
			{ technical_id: 'subject-pos' },
			{ technical_id: 'subject-ventas' },
			{ technical_id: 'subject-almacen' },
		];
		expect(
			planned_missing_install_rows(subjects, ['subject-pos'], (sub) =>
				sub.technical_id !== 'subject-ventas',
			),
		).toEqual([
			{ technical_id: 'subject-ventas', installed: false },
			{ technical_id: 'subject-almacen', installed: true },
		]);
	});

	test('after a seed row exists, leftover enabled modules cannot hide an uninstall', () => {
		expect(
			subject_is_installed({ installed: false }, [{ is_enable: true }]),
		).toBe(false);
		expect(planned_missing_install_rows(
			[{ technical_id: 'subject-pos' }],
			['subject-pos'],
			() => true,
		)).toEqual([]);
	});
});

describe('subject_marker_display_name', () => {
	const marker_doc = (name: string) => ({
		name,
		module_location: 'components',
		module_name: 'rh',
	});

	test('raw two-letter subject name fails ModuleManagement minlength', () => {
		expect(() =>
			assert_required_fields('module-management', marker_doc('RH')),
		).toThrow(FieldValidationError);
		try {
			assert_required_fields('module-management', marker_doc('RH'));
		} catch (err) {
			expect(String(err)).toContain(
				'El nombre debe contener tres letras o mas',
			);
		}
	});

	test('RH catalog name becomes a ModuleManagement name of at least 3 letters', () => {
		const name = subject_marker_display_name({ name: 'RH', slug: 'rh' });
		expect(name.length).toBeGreaterThanOrEqual(3);
		expect(() =>
			assert_required_fields('module-management', marker_doc(name)),
		).not.toThrow();
	});

	test('keeps already-valid names including the POS minimum of 3', () => {
		expect(subject_marker_display_name({ name: 'POS', slug: 'pos' })).toBe(
			'POS',
		);
		expect(
			subject_marker_display_name({
				name: 'Recursos Humanos',
				slug: 'rh',
			}),
		).toBe('Recursos Humanos');
	});
});

describe('SubjectNotInstalledError', () => {
	test('envelope names the app and carries install details', () => {
		const err = new SubjectNotInstalledError({
			slug: 'almacen',
			name: 'Almacén',
			technical_id: 'subject-almacen',
			resource: 'products',
		});
		expect(err.status).toBe(404);
		expect(err.code).toBe('subject_not_installed');
		expect(err.message).toBe('Almacén no está instalada');
		expect(subject_not_installed_body(err)).toEqual({
			message: 'Almacén no está instalada',
			error: 'Almacén no está instalada',
			code: 'subject_not_installed',
			details: {
				slug: 'almacen',
				name: 'Almacén',
				technical_id: 'subject-almacen',
				resource: 'products',
			},
		});
	});
});
