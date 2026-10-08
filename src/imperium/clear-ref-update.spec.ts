import { describe, expect, test } from 'bun:test';
import { ImperiumStore, load_catalog_path } from './store.ts';

const USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const EMPLOYEE_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const LIST_ID = 'cccccccccccccccccccccccc';

describe('update de refs vacíos', () => {
	test('limpiar empleado y lista de precios se escribe como NULL', async () => {
		const queries: Array<{ sql: string; params: unknown[] }> = [];
		const sql = {
			unsafe: async (query: string, params: unknown[] = []) => {
				queries.push({ sql: query, params });
				return [
					{
						id: USER_ID,
						name: 'Ana',
						email: 'ana@local.test',
						employee: null,
						listaDePrecios: null,
						payload: { name: 'Ana', employee: null, listaDePrecios: null },
						is_active: true,
					},
				];
			},
		};
		const store = new ImperiumStore(sql as unknown as Bun.SQL, load_catalog_path());
		store.set_installed_subjects([
			'subject-configuracion',
			'subject-configuraciones-de-vista',
			'subject-planeacion',
		]);
		const store_any = store as unknown as {
			find_id: ImperiumStore['find_id'];
			assert_unique_business_keys: ImperiumStore['assert_unique_business_keys'];
		};
		store_any.find_id = async () => ({
			_id: USER_ID,
			id: USER_ID,
			name: 'Ana',
			email: 'ana@local.test',
			employee: EMPLOYEE_ID,
			listaDePrecios: LIST_ID,
			is_active: true,
			payload: { employee: EMPLOYEE_ID, listaDePrecios: LIST_ID, name: 'Ana' },
		});
		store_any.assert_unique_business_keys = async () => undefined;

		const saved = await store.update('user', USER_ID, {
			employee: null,
			listaDePrecios: null,
		});
		const update = queries.find((query) => query.sql.includes('UPDATE'));
		expect(update).toBeTruthy();
		const bound = (column: string) => {
			const match = update!.sql.match(new RegExp(`"${column}" = \\$(\\d+)`));
			expect(match).toBeTruthy();
			return update!.params[Number(match![1]) - 1];
		};
		expect(bound('employee')).toBeNull();
		expect(bound('listaDePrecios')).toBeNull();
		const payload = bound('payload') as Record<string, unknown>;
		expect(payload.employee).toBeNull();
		expect(payload.listaDePrecios).toBeNull();
		expect(saved?.employee ?? null).toBeNull();
		expect(saved?.listaDePrecios ?? null).toBeNull();
	});
});
