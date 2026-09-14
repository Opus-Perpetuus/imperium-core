import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
	FieldValidationError,
	assert_required_fields,
} from './required-fields.ts';
import {
	SubjectNotInstalledError,
	planned_missing_install_rows,
	stale_lifecycle_write,
	subject_is_installed,
	subject_marker_display_name,
	subject_not_installed_body,
	visible_lifecycle_status,
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

describe('visible_lifecycle_status', () => {
	test('a never-installed app including rh is not busy or installing', () => {
		expect(visible_lifecycle_status(undefined, false, false)).toEqual({
			status: 'not_installed',
			busy: false,
		});
		expect(
			visible_lifecycle_status('not_installed', false, false),
		).toEqual({
			status: 'not_installed',
			busy: false,
		});
		expect(
			visible_lifecycle_status('not_installed', false, false).status,
		).not.toBe('installing');
	});

	test('orphan installing without an in-flight job is not presented as busy', () => {
		expect(visible_lifecycle_status('installing', false, false)).toEqual({
			status: 'not_installed',
			busy: false,
		});
		expect(visible_lifecycle_status('uninstalling', false, false)).toEqual({
			status: 'uninstalled',
			busy: false,
		});
	});

	test('a real in-flight job keeps installing/uninstalling as busy', () => {
		expect(visible_lifecycle_status('installing', false, true)).toEqual({
			status: 'installing',
			busy: true,
		});
		expect(visible_lifecycle_status('uninstalling', false, true)).toEqual({
			status: 'uninstalling',
			busy: true,
		});
	});
});

describe('stale_lifecycle_write', () => {
	test('does not write installing when listing a never-installed app', () => {
		expect(
			stale_lifecycle_write(
				{
					technical_id: 'subject-rh',
					status: 'not_installed',
					installed: false,
				},
				false,
			),
		).toBeNull();
		expect(
			planned_missing_install_rows(
				[{ technical_id: 'subject-rh' }],
				[],
				() => false,
			),
		).toEqual([{ technical_id: 'subject-rh', installed: false }]);
	});

	test('reconciles leftover installing/uninstalling when no job is running', () => {
		expect(
			stale_lifecycle_write(
				{
					technical_id: 'subject-rh',
					status: 'installing',
					installed: false,
				},
				false,
			),
		).toEqual({
			technical_id: 'subject-rh',
			installed: false,
			status: 'not_installed',
		});
		expect(
			stale_lifecycle_write(
				{
					technical_id: 'subject-pos',
					status: 'uninstalling',
					installed: false,
				},
				false,
			),
		).toEqual({
			technical_id: 'subject-pos',
			installed: false,
			status: 'uninstalled',
		});
		expect(
			stale_lifecycle_write(
				{
					technical_id: 'subject-rh',
					status: 'installing',
					installed: false,
				},
				true,
			),
		).toBeNull();
	});
});

describe('list_catalog_subjects wiring', () => {
	test('listing uses lifecycle view/reconcile and does not start a lifecycle', () => {
		const src = readFileSync(new URL('./subjects-admin.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function list_catalog_subjects');
		expect(start).toBeGreaterThanOrEqual(0);
		const lines = src.slice(start).split('\n');
		const body_lines = [lines[0]];
		for (let i = 1; i < lines.length; i++) {
			body_lines.push(lines[i]);
			if (lines[i] === '}') break;
		}
		const body = body_lines.join('\n');
		expect(body).toContain('stale_lifecycle_write');
		expect(body).not.toContain('accept_subject_lifecycle');
		expect(body).not.toContain('begin_subject_lifecycle');
		expect(body).not.toContain('set_subject_installed');
		expect(src).toMatch(/visible_lifecycle_status\(/);
		expect(src).toMatch(/busy:\s*view\.busy/);
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
