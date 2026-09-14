import { describe, expect, test } from 'bun:test';
import {
	apply_related_labels,
	field_value_ids_needing_label,
	field_values_from_distinct,
	merge_related_names,
	related_doc_label,
} from './field-values.ts';

describe('field-values assigned-to labels', () => {
	test('distinct of employee ids keeps value as id and lists names', () => {
		const employee_id = '507f1f77bcf86cd799439011';
		const other_id = '507f1f77bcf86cd799439012';
		const options = field_values_from_distinct(
			[employee_id, other_id],
			'assinged_to',
			null,
		);
		expect(field_value_ids_needing_label(options).sort()).toEqual(
			[employee_id, other_id].sort(),
		);
		const labeled = apply_related_labels(
			options,
			new Map([
				[employee_id, 'Paola Méndez'],
				[other_id, 'Lorena Pérez'],
			]),
		);
		expect(labeled.find((row) => row.value === employee_id)?.label).toBe(
			'Paola Méndez',
		);
		expect(labeled.find((row) => row.value === other_id)?.label).toBe(
			'Lorena Pérez',
		);
	});

	test('related_doc_label prefers name then username', () => {
		expect(related_doc_label({ name: 'Paola Méndez' })).toBe('Paola Méndez');
		expect(related_doc_label({ name: '', username: 'paola' })).toBe('paola');
		expect(related_doc_label({ _id: '507f1f77bcf86cd799439011' })).toBe('');
	});

	test('employee miss falls back to user names', () => {
		const employee_id = '507f1f77bcf86cd799439011';
		const user_id = '507f1f77bcf86cd799439012';
		const options = field_values_from_distinct(
			[employee_id, user_id],
			'assinged_to',
			null,
		);
		const labeled = apply_related_labels(
			options,
			merge_related_names(
				new Map([[employee_id, 'Paola Méndez']]),
				new Map([[user_id, 'Lorena Pérez']]),
			),
		);
		expect(labeled.find((row) => row.value === employee_id)?.label).toBe(
			'Paola Méndez',
		);
		expect(labeled.find((row) => row.value === user_id)?.label).toBe(
			'Lorena Pérez',
		);
	});

	test('state labels are not treated as ids', () => {
		const options = field_values_from_distinct(['abierto'], 'status', {
			field_name: 'status',
			enabled: true,
			read_only: false,
			values: [
				{
					value: 'abierto',
					type: 'primary',
					display_leyend: 'Abierto',
					color: '',
				},
			],
		});
		expect(field_value_ids_needing_label(options)).toEqual([]);
		expect(options[0]?.label).toBe('Abierto');
	});
});
