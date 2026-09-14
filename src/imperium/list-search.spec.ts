import { describe, expect, test } from 'bun:test';
import { list_search_columns } from './list-search.ts';

describe('list_search_columns', () => {
	test('citizen-report busca nombre de ciudadano y descripción además de name', () => {
		const cols = list_search_columns(
			'citizen-report',
			new Set([
				'name',
				'search_field',
				'citizen_name',
				'citizen_phone',
				'report_description',
				'payload',
			]),
		);
		expect(cols).toContain('name');
		expect(cols).toContain('search_field');
		expect(cols).toContain('citizen_name');
		expect(cols).toContain('citizen_phone');
		expect(cols).toContain('report_description');
		expect(cols).not.toContain('payload');
	});

	test('otros recursos no inventan columnas de reportes', () => {
		expect(list_search_columns('user', new Set(['name', 'email']))).toEqual([
			'name',
		]);
	});
});
