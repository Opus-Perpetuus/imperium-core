import { beforeEach, describe, expect, it } from 'bun:test';
import { ensure_db_admin_objects, reset_db_admin_capabilities } from './db-admin-setup.ts';

/** `Bun.SQL` mínimo: cuenta los CREATE SCHEMA y puede fallar el primero. */
function fake_sql(opts: { fail_first_schema?: boolean } = {}) {
	let schema_calls = 0;
	const sql = {
		unsafe: async (text: string) => {
			if (/CREATE SCHEMA/.test(text)) {
				schema_calls += 1;
				await new Promise((r) => setTimeout(r, 5));
				if (opts.fail_first_schema && schema_calls === 1) {
					throw Object.assign(
						new Error('duplicate key value violates unique constraint "pg_namespace_nspname_index"'),
						{ code: '23505' },
					);
				}
			}
			if (/pg_extension/.test(text)) return [];
			return [];
		},
	};
	return { sql: sql as unknown as Bun.SQL, schema_calls: () => schema_calls };
}

describe('ensure_db_admin_objects', () => {
	beforeEach(() => reset_db_admin_capabilities());

	it('peticiones simultáneas comparten una sola preparación', async () => {
		const f = fake_sql();
		const [a, b, c] = await Promise.all([
			ensure_db_admin_objects(f.sql),
			ensure_db_admin_objects(f.sql),
			ensure_db_admin_objects(f.sql),
		]);
		expect(f.schema_calls()).toBe(1);
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	it('un choque de unicidad de otro proceso se reintenta', async () => {
		const f = fake_sql({ fail_first_schema: true });
		const caps = await ensure_db_admin_objects(f.sql);
		expect(f.schema_calls()).toBe(2);
		expect(caps.stat_statements).toBe(false);
	});
});
