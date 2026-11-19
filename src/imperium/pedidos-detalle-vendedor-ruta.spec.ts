import { describe, expect, test } from 'bun:test';
import type { ImperiumDoc } from './envelope.ts';
import { hydrate_pedido_detail } from './pedidos-flow.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

// #275: el detalle del pedido trae vendedor y ruta por nombre, como la lista y el tablero.
const BASE = ['subject-configuracion', 'subject-configuraciones-de-vista', 'subject-planeacion'];
const USER_ID = '507f1f77bcf86cd799439011';
const CONTACT_ID = '64b7f0c2a1b2c3d4e5f60718';

function fake_store(slugs: string[]) {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.set_installed_subjects([...BASE, ...slugs.map((slug) => `subject-${slug}`)]);
	(store as unknown as { find_many: unknown }).find_many = async (resource: string) => {
		if (resource === 'delivery-route') {
			return {
				rows: [
					{ _id: 'r-sur', name: 'Zona Sur', contacts: JSON.stringify([CONTACT_ID]) },
					{ _id: 'r-otra', name: 'Otra', contacts: ['c-x'] },
				],
				total: 2,
			};
		}
		if (resource === 'user') return { rows: [{ _id: USER_ID, name: 'IA Vendedor' }], total: 1 };
		throw new Error(`consulta inesperada a ${resource}`);
	};
	(store as unknown as { find_id: unknown }).find_id = async (resource: string, id: string) =>
		resource === 'contacto' ? { _id: id, name: 'Cliente Sur' } : null;
	return store;
}

const pedido = (extra: ImperiumDoc = {}): ImperiumDoc => ({
	_id: 'p-1',
	folio: '7',
	contacto: CONTACT_ID,
	usuario: USER_ID,
	...extra,
});

describe('detalle de pedido: vendedor y ruta (#275)', () => {
	test('la ruta sale del contacto en delivery-route.contacts, por nombre', async () => {
		const out = await hydrate_pedido_detail(fake_store(['ventas', 'logistica']), pedido());
		expect(out.ruta).toBe('Zona Sur');
	});

	test('el vendedor guardado como id llega con su nombre', async () => {
		const out = await hydrate_pedido_detail(fake_store(['ventas', 'logistica']), pedido());
		expect(out.usuario).toEqual({ _id: USER_ID, name: 'IA Vendedor' });
		expect(out.usuario_id).toBe(USER_ID);
	});

	test('el vendedor ya poblado conserva su nombre sin otra consulta', async () => {
		const out = await hydrate_pedido_detail(
			fake_store(['ventas', 'logistica']),
			pedido({ usuario: { _id: USER_ID, name: 'Gerardo' } }),
		);
		expect(out.usuario).toEqual({ _id: USER_ID, name: 'Gerardo' });
	});

	test('sin logística instalada la ruta queda vacía', async () => {
		const out = await hydrate_pedido_detail(fake_store(['ventas']), pedido());
		expect(out.ruta).toBe('');
	});
});
