import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { project_list_docs } from './list-projection.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const CONTACT_ID = '507f1f77bcf86cd799439011';
const CONTACT_NAME = 'PRUEBA Grokcito contacto QA';

function store_with_contact(): ImperiumStore {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.find_many = async (resource: string) => {
		if (resource === 'contacto') {
			return {
				rows: [{ _id: CONTACT_ID, name: CONTACT_NAME, codigo: 'GROKQA01' }],
				total: 1,
			};
		}
		return { rows: [], total: 0 };
	};
	return store;
}

const order: ImperiumDoc = {
	_id: 'po-fefo-1',
	name: 'PRUEBA ALBA FEFO',
	folio_interno: 1,
	estado: 'aprobada',
	proveedor: CONTACT_ID,
	proveedor_nombre: '',
};

describe('nombre del proveedor en la orden de compra', () => {
	test('el detalle y la lista muestran el nombre del contacto, no el id', async () => {
		const store = store_with_contact();
		const [detail] = await store.populate_docs('purchase-order', [order]);
		expect(detail?.proveedor).toMatchObject({ _id: CONTACT_ID, name: CONTACT_NAME });
		expect(String(detail?.proveedor_nombre ?? '')).toBe(CONTACT_NAME);

		const [flat] = store.flatten_list_docs('purchase-order', [detail!]);
		const [listed] = project_list_docs('purchase-order', [flat!]);
		expect(listed?.proveedor_nombre).toBe(CONTACT_NAME);
		expect(listed?.proveedor_nombre).not.toBe(CONTACT_ID);
	});

	test('un snapshot que es el id se sustituye por el nombre del contacto', async () => {
		const store = store_with_contact();
		const [detail] = await store.populate_docs('purchase-order', [
			{ ...order, proveedor_nombre: CONTACT_ID },
		]);
		expect(detail?.proveedor_nombre).toBe(CONTACT_NAME);
	});

	test('un nombre ya guardado no se pisa', async () => {
		const store = store_with_contact();
		const [detail] = await store.populate_docs('purchase-order', [
			{ ...order, proveedor_nombre: 'Proveedor capturado' },
		]);
		expect(detail?.proveedor_nombre).toBe('Proveedor capturado');
	});
});
