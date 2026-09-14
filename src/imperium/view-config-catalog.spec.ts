import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

describe('view-config-preset catalog columns', () => {
	test('physical json columns include table_configs and assignments', () => {
		const catalog = JSON.parse(
			readFileSync(new URL('../../catalog.json', import.meta.url), 'utf8'),
		) as {
			subjects: Array<{
				modules?: Array<{
					resource?: string;
					columns?: Array<{ name?: string; pg?: string }>;
				}>;
			}>;
		};
		const mod = catalog.subjects
			.flatMap((subject) => subject.modules ?? [])
			.find((item) => item.resource === 'view-config-preset');
		const by_name = new Map(
			(mod?.columns ?? []).map((col) => [String(col.name ?? ''), col]),
		);
		for (const name of [
			'table_configs',
			'assigned_user_ids',
			'assigned_user_group_ids',
			'appearance',
		]) {
			expect(by_name.get(name)?.pg).toBe('json');
		}
	});
});
