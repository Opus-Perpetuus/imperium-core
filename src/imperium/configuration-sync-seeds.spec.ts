import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load_configuration_parameter_seeds } from '../../../../backend/src/components/configuration/reconcile-configuration-seeds.ts';
import {
	assert_required_fields,
	FieldValidationError,
} from './required-fields.ts';

const BACKEND_SRC = join(import.meta.dir, '../../../../backend/src');

describe('configuration seed insert (store.insert → assert_required_fields)', () => {
	test('semilla real con value "" no truena Debes definir un valor', () => {
		const seeds = load_configuration_parameter_seeds(BACKEND_SRC);
		const empty = seeds.find((row) => row.value === '');
		expect(empty).toBeTruthy();
		expect(String(empty?._ref ?? '')).not.toBe('');
		expect(() =>
			assert_required_fields('configuration', { ...empty }),
		).not.toThrow();
	});

	test('todas las semillas insertables pasan la validación de insert', () => {
		const seeds = load_configuration_parameter_seeds(BACKEND_SRC);
		const failures: string[] = [];
		for (const seed of seeds) {
			try {
				assert_required_fields('configuration', { ...seed });
			} catch (err) {
				const message =
					err instanceof FieldValidationError
						? err.message
						: String(err);
				failures.push(`${seed._ref}: ${message}`);
			}
		}
		expect(failures).toEqual([]);
	});

	test('value ausente o null sigue siendo inválido', () => {
		expect(() =>
			assert_required_fields('configuration', {
				name: 'Logo de la empresa',
				value: null,
			}),
		).toThrow(FieldValidationError);
		expect(() =>
			assert_required_fields('configuration', {
				name: 'Logo de la empresa',
			}),
		).toThrow(FieldValidationError);
	});

	test('configuration-parameter-seeds.json matches backend module.data walk', () => {
		const walked = load_configuration_parameter_seeds(BACKEND_SRC);
		const snapshot = JSON.parse(
			readFileSync(
				join(import.meta.dir, 'configuration-parameter-seeds.json'),
				'utf8',
			),
		) as Array<{
			_ref: string;
			value?: unknown;
			type?: string;
			name?: string;
			is_system?: boolean;
			module_id?: string;
		}>;
		const walked_refs = walked.map((row) => row._ref);
		const snapshot_refs = snapshot.map((row) => row._ref);
		expect(snapshot_refs.filter((ref) => walked_refs.includes(ref)).sort()).toEqual(
			[...walked_refs].sort(),
		);
		expect(snapshot_refs.filter((ref) => !walked_refs.includes(ref)).sort()).toEqual([
			'configuration-app-registry-enabled',
			'configuration-comercial-cola-activa',
			'configuration-comercial-pedido-concepto',
			'configuration-comercial-pedido-serie',
		]);
		expect(snapshot.find((row) => row._ref === 'configuration-comercial-cola-activa')).toMatchObject({
			name: 'Comercial · Cola activa',
			is_system: true,
			module_id: 'NA',
			type: 'switch',
			value: false,
		});
		const landing_walked = walked.find(
			(row) => row._ref === 'configuration-public-landing-enabled',
		);
		const landing_snapshot = snapshot.find(
			(row) => row._ref === 'configuration-public-landing-enabled',
		);
		expect(landing_walked?.value).toBe(false);
		expect(landing_snapshot?.value).toBe(false);
	});

	test('ensure_defaults aplica semillas faltantes al arrancar', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async ensure_defaults(');
		const body = src.slice(
			start,
			src.indexOf('async warmup_search_indexes(', start),
		);
		expect(body).toContain('apply_missing_configuration_seeds');
		expect(body).toContain('PUBLIC_LANDING_ENABLED_REF');
	});
});
