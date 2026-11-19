import { describe, expect, test } from 'bun:test';
import { ensure_pedido_fecha } from './pedidos-fecha.ts';
import { FieldValidationError } from './required-fields.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const NOW = new Date('2026-11-18T19:00:00.000Z');
const PEDIDO_ID = 'dddddddddddddddddddddddd';

describe('fecha de pedido (Odoo #267)', () => {
	test('sin fecha toma la de alta y, si no hay, ahora', () => {
		const con_alta: Record<string, unknown> = { createdAt: '2026-10-05T23:51:26.418Z' };
		ensure_pedido_fecha(con_alta, null, NOW);
		expect(con_alta.fecha).toBe('2026-10-05T23:51:26.418Z');
		for (const fecha of [undefined, null, '', '   ']) {
			const doc: Record<string, unknown> = { fecha };
			ensure_pedido_fecha(doc, null, NOW);
			expect(doc.fecha).toBe(NOW.toISOString());
		}
	});

	test('al editar sin fecha conserva la guardada o usa la de alta del pedido', () => {
		const doc: Record<string, unknown> = { fecha: null };
		ensure_pedido_fecha(doc, { fecha: '2026-11-01T10:00:00.000Z', created_at: '2026-10-01T00:00:00.000Z' }, NOW);
		expect(doc.fecha).toBe('2026-11-01T10:00:00.000Z');
		const legado: Record<string, unknown> = {};
		ensure_pedido_fecha(legado, { fecha: null, created_at: '2026-01-31T00:56:10.631Z' }, NOW);
		expect(legado.fecha).toBe('2026-01-31T00:56:10.631Z');
	});

	test('respeta una fecha válida y rechaza texto que no es fecha', () => {
		const doc: Record<string, unknown> = { fecha: '2025-01-02T00:00:00.000Z' };
		ensure_pedido_fecha(doc, null, NOW);
		expect(doc.fecha).toBe('2025-01-02T00:00:00.000Z');
		const dia: Record<string, unknown> = { fecha: new Date('2025-03-04T05:06:07.000Z') };
		ensure_pedido_fecha(dia, null, NOW);
		expect(dia.fecha).toBe('2025-03-04T05:06:07.000Z');
		expect(() => ensure_pedido_fecha({ fecha: 'mañana' }, null, NOW)).toThrow(FieldValidationError);
	});
});

function fake_store(existing?: Record<string, unknown>) {
	const queries: Array<{ sql: string; params: unknown[] }> = [];
	const sql = {
		unsafe: async (query: string, params: unknown[] = []) => {
			queries.push({ sql: query, params });
			return [{ id: PEDIDO_ID, payload: {}, is_active: true }];
		},
	};
	const store = new ImperiumStore(sql as unknown as Bun.SQL, load_catalog_path());
	store.set_installed_subjects(['subject-ventas']);
	const store_any = store as unknown as {
		find_id: ImperiumStore['find_id'];
		assert_unique_business_keys: ImperiumStore['assert_unique_business_keys'];
		sync_search: ImperiumStore['sync_search'];
	};
	store_any.find_id = async () => (existing ? { ...existing } : null);
	store_any.assert_unique_business_keys = async () => undefined;
	store_any.sync_search = async () => undefined;
	const bound = (verb: 'INSERT' | 'UPDATE', column: string) => {
		const query = queries.find((q) => q.sql.startsWith(verb));
		expect(query).toBeTruthy();
		if (verb === 'UPDATE') {
			const match = query!.sql.match(new RegExp(`"${column}" = \\$(\\d+)`));
			expect(match).toBeTruthy();
			return query!.params[Number(match![1]) - 1];
		}
		const cols = query!.sql.match(/\(([^)]*)\) VALUES/)![1]!.split(', ').map((c) => c.replace(/"/g, ''));
		return query!.params[cols.indexOf(column)];
	};
	return { store, bound };
}

describe('store: ningún pedido se guarda con fecha NULL (Odoo #267)', () => {
	test('insert sin fecha (p. ej. /sync/v1/mutaciones o una semilla) la escribe', async () => {
		const { store, bound } = fake_store();
		await store.insert('pedidos', { _id: PEDIDO_ID, folio: 'admin-1', estado: 'confirmado' });
		const fecha = bound('INSERT', 'fecha');
		expect(typeof fecha).toBe('string');
		expect(Number.isNaN(new Date(String(fecha)).getTime())).toBe(false);
	});

	test('update que manda fecha vacía no la borra', async () => {
		const { store, bound } = fake_store({
			_id: PEDIDO_ID,
			id: PEDIDO_ID,
			folio: 'admin-1',
			fecha: '2026-11-17T15:15:13.783Z',
			createdAt: '2026-11-17T15:15:13.805Z',
			payload: {},
		});
		await store.update('pedidos', PEDIDO_ID, { fecha: null, estado: 'surtido' });
		expect(bound('UPDATE', 'fecha')).toBe('2026-11-17T15:15:13.783Z');
	});

	test('editar un pedido viejo sin fecha le pone su fecha de alta', async () => {
		const { store, bound } = fake_store({
			_id: PEDIDO_ID,
			id: PEDIDO_ID,
			folio: 'ADMIN-2026_01_30-1',
			fecha: null,
			createdAt: '2026-01-31T00:56:10.631Z',
			payload: {},
		});
		await store.update('pedidos', PEDIDO_ID, { estado: 'surtido' });
		expect(bound('UPDATE', 'fecha')).toBe('2026-01-31T00:56:10.631Z');
	});
});
