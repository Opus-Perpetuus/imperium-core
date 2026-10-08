import { describe, expect, test } from 'bun:test';
import { ImperiumStore, is_missing_relation, load_catalog_path } from './store.ts';

const BASE = ['subject-configuracion', 'subject-configuraciones-de-vista', 'subject-planeacion'];

function catalog_store(): ImperiumStore {
	return new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
}

function store_with(...slugs: string[]): ImperiumStore {
	const store = catalog_store();
	store.set_installed_subjects([...BASE, ...slugs.map((slug) => `subject-${slug}`)]);
	return store;
}

function missing_relation(table: string) {
	return Object.assign(new Error(`relation "${table}" does not exist`), {
		code: 'ERR_POSTGRES_SERVER_ERROR',
		errno: '42P01',
	});
}

type FindMany = ImperiumStore['find_many'];

function stub_find_many(
	store: ImperiumStore,
	impl: (resource: string, opts: Parameters<FindMany>[1]) => Promise<unknown>,
) {
	(store as unknown as { find_many: unknown }).find_many = impl;
}

describe('borrado sin apps ajenas instaladas', () => {
	test('incoming_simple_refs no consulta tablas de apps que no están instaladas', () => {
		const ayuntamiento = store_with();
		const users = ayuntamiento.incoming_simple_refs('user').map((hit) => hit.resource);
		const contactos = ayuntamiento.incoming_simple_refs('contacto').map((hit) => hit.resource);
		const ordenes = ayuntamiento.incoming_simple_refs('purchase-order').map((hit) => hit.resource);
		expect(users).not.toContain('pos-session');
		expect(contactos).not.toContain('delivery-route');
		expect(ordenes).not.toContain('cfdi-document');
		expect(ayuntamiento.is_resource_installed('pos-session')).toBe(false);
		expect(ayuntamiento.is_resource_installed('delivery-route')).toBe(false);
		expect(ayuntamiento.is_resource_installed('cfdi-document')).toBe(false);
	});

	test('una referencia de una app instalada sí bloquea el borrado', () => {
		const ventas = store_with('ventas');
		const users = ventas.incoming_simple_refs('user');
		expect(users).toContainEqual({ resource: 'pedidos', field: 'usuario' });
		const pos = store_with('pos');
		expect(pos.incoming_simple_refs('user')).toContainEqual({
			resource: 'pos-session',
			field: 'created_by',
		});
	});

	test('referencing_counts salta la relación ausente y conserva el conteo real', async () => {
		const store = store_with('ventas', 'pos');
		expect(is_missing_relation(missing_relation('subject_pos.pos_session'))).toBe(true);
		const queried: string[] = [];
		stub_find_many(store, async (resource) => {
			queried.push(resource);
			if (resource === 'pos-session') throw missing_relation('subject_pos.pos_session');
			if (resource === 'pedidos') return { rows: [{ _id: 'p1' }], total: 2 };
			return { rows: [], total: 0 };
		});
		const hits = await store.referencing_counts('user', 'aaaaaaaaaaaaaaaaaaaaaaaa');
		expect(queried).toContain('pos-session');
		expect(queried).toContain('pedidos');
		expect(hits.find((hit) => hit.resource === 'pos-session')).toBeUndefined();
		expect(hits).toContainEqual({ resource: 'pedidos', field: 'usuario', conteo: 2 });
	});

	test('referencing_counts de un usuario sin usos no llama a POS, logística ni CFDI', async () => {
		const store = store_with();
		const queried: string[] = [];
		stub_find_many(store, async (resource) => {
			queried.push(resource);
			return { rows: [], total: 0 };
		});
		expect(await store.referencing_counts('user', 'u1')).toEqual([]);
		expect(await store.referencing_counts('contacto', 'c1')).toEqual([]);
		expect(await store.referencing_counts('purchase-order', 'o1')).toEqual([]);
		expect(queried).not.toContain('pos-session');
		expect(queried).not.toContain('delivery-route');
		expect(queried).not.toContain('cfdi-document');
	});
});
