import { describe, expect, test } from 'bun:test';
import { decorate_contacto_rutas, strip_contacto_rutas } from './contacto-rutas.ts';
import type { ImperiumDoc } from './envelope.ts';
import { project_list_docs } from './list-projection.ts';
import { enrich_pedidos_list } from './pedidos-flow.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const BASE = ['subject-configuracion', 'subject-configuraciones-de-vista', 'subject-planeacion'];

const ROUTES: ImperiumDoc[] = [
	{ _id: 'r-norte', name: 'Zona Norte', contacts: ['c-1', { _id: 'c-3' }] },
	{ _id: 'r-centro', name: 'Centro', contacts: JSON.stringify([{ $oid: 'c-1' }, 'c-2']) },
];

function store_with(slugs: string[], routes: ImperiumDoc[] = ROUTES) {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.set_installed_subjects([...BASE, ...slugs.map((slug) => `subject-${slug}`)]);
	const calls: string[] = [];
	(store as unknown as { find_many: unknown }).find_many = async (resource: string) => {
		calls.push(resource);
		if (resource !== 'delivery-route') throw new Error(`consulta inesperada a ${resource}`);
		return { rows: routes, total: routes.length };
	};
	return { store, calls };
}

describe('ruta del contacto derivada de delivery-route.contacts', () => {
	test('un contacto en dos rutas las recibe todas, ordenadas por nombre', async () => {
		const { store, calls } = store_with(['ventas', 'logistica']);
		const [row] = await decorate_contacto_rutas(store, [{ _id: 'c-1', name: 'Cliente' }]);
		expect(row!.rutas).toEqual(['r-centro', 'r-norte']);
		expect(row!.ruta).toBe('Centro, Zona Norte');
		expect(calls).toEqual(['delivery-route']);
	});

	test('un contacto sin ruta queda vacío', async () => {
		const { store } = store_with(['ventas', 'logistica']);
		const [row] = await decorate_contacto_rutas(store, [{ _id: 'c-9', name: 'Sin ruta' }]);
		expect(row!.rutas).toEqual([]);
		expect(row!.ruta).toBe('');
	});

	test('sin logística instalada la ruta queda vacía y no se consulta', async () => {
		const { store, calls } = store_with(['ventas']);
		const [row] = await decorate_contacto_rutas(store, [{ _id: 'c-1', name: 'Cliente' }]);
		expect(row!.rutas).toEqual([]);
		expect(row!.ruta).toBe('');
		expect(calls).toEqual([]);
	});

	test('contacto.rutas guardado no es fuente', async () => {
		const { store } = store_with(['ventas', 'logistica']);
		const [row] = await decorate_contacto_rutas(store, [
			{ _id: 'c-9', name: 'Viejo', rutas: ['r-norte'] },
		]);
		expect(row!.rutas).toEqual([]);
		expect(row!.ruta).toBe('');
	});

	test('la lista proyecta el nombre de la ruta', async () => {
		const { store } = store_with(['ventas', 'logistica']);
		const rows = await decorate_contacto_rutas(store, [{ _id: 'c-3', name: 'Cliente' }]);
		expect(project_list_docs('contacto', rows)[0]!.ruta).toBe('Zona Norte');
	});

	test('guardar un contacto no escribe las rutas derivadas', () => {
		expect(strip_contacto_rutas({ name: 'A', rutas: ['r-norte'], ruta: 'Zona Norte' })).toEqual({
			name: 'A',
		});
	});
});

describe('ruta del pedido heredada de su contacto', () => {
	test('cada pedido toma las rutas de su contacto con una sola consulta', async () => {
		const { store, calls } = store_with(['ventas', 'logistica']);
		const rows = await enrich_pedidos_list(store, [
			{ _id: 'p-1', folio: '1', contacto: { _id: 'c-1', name: 'Cliente' } },
			{ _id: 'p-2', folio: '2', contacto_id: 'c-3' },
			{ _id: 'p-3', folio: '3', contacto_id: 'c-9', ruta: 'Guardada' },
		]);
		expect(rows.map((row) => row.ruta)).toEqual(['Centro, Zona Norte', 'Zona Norte', '']);
		expect(calls).toEqual(['delivery-route']);
	});

	test('sin logística instalada el pedido queda sin ruta', async () => {
		const { store, calls } = store_with(['ventas']);
		const rows = await enrich_pedidos_list(store, [{ _id: 'p-1', contacto_id: 'c-1' }]);
		expect(rows[0]!.ruta).toBe('');
		expect(calls).toEqual([]);
	});
});
