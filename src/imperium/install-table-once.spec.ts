import { describe, expect, test } from 'bun:test';
import { installed_image_of } from './subjects-admin.ts';

function fake_sql(opts: { missing_once?: boolean } = {}) {
	const queries: string[] = [];
	let missing = opts.missing_once ?? false;
	const sql = {
		unsafe: async (query: string) => {
			queries.push(query);
			if (/FROM public\.subject_installs/.test(query) && missing) {
				missing = false;
				throw Object.assign(new Error('relation "public.subject_installs" does not exist'), {
					errno: '42P01',
				});
			}
			if (/FROM public\.subject_installs/.test(query)) {
				return [{ technical_id: 'subject-pos', installed: true, status: 'installed', installed_image: 'img:1' }];
			}
			return [];
		},
	};
	return { sql: sql as unknown as Bun.SQL, queries };
}

const alters = (queries: string[]) => queries.filter((q) => /ALTER TABLE/.test(q)).length;

describe('subject_installs: el esquema se asegura una vez', () => {
	test('varias lecturas no repiten ALTER TABLE', async () => {
		const { sql, queries } = fake_sql();
		const first = await Promise.all([1, 2, 3].map(() => installed_image_of(sql, 'subject-pos')));
		const once = alters(queries);
		await installed_image_of(sql, 'subject-pos');
		expect(first).toEqual(['img:1', 'img:1', 'img:1']);
		expect(once).toBeGreaterThan(0);
		expect(alters(queries)).toBe(once);
	});

	test('si la tabla desaparece (restauración) se vuelve a crear', async () => {
		const { sql, queries } = fake_sql();
		await installed_image_of(sql, 'subject-pos');
		const once = alters(queries);
		const again = fake_sql({ missing_once: true });
		await installed_image_of(again.sql, 'subject-pos');
		expect(alters(again.queries)).toBe(once * 2);
		expect(await installed_image_of(again.sql, 'subject-pos')).toBe('img:1');
	});
});
