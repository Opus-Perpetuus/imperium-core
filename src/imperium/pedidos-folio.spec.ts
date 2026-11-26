import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { ImperiumStore } from './store.ts';
import { prepare_pedido_create } from './pedidos-flow.ts';

/** Store mínimo: folio_interno sale de un contador atómico, como `auto-increment-control`. */
function store_con_contador() {
	let secuencia = 0;
	return {
		has: () => false,
		async find_id() {
			return null;
		},
		async next_auto_increment() {
			await Promise.resolve();
			secuencia += 1;
			return secuencia;
		},
	} as unknown as ImperiumStore;
}

const ADMIN = { _id: 'admin', name: 'admin' };

afterEach(() => setSystemTime());

describe('folio de pedido (Odoo #267)', () => {
	test('dos altas concurrentes del mismo usuario en el mismo segundo no comparten folio', async () => {
		setSystemTime(new Date('2026-11-18T21:15:14.100Z'));
		const store = store_con_contador();
		const [a, b] = await Promise.all([
			prepare_pedido_create(store, { estado: 'borrador', articulos: [] }, ADMIN),
			prepare_pedido_create(store, { estado: 'borrador', articulos: [] }, ADMIN),
		]);
		expect(a.folio).not.toBe(b.folio);
		expect(a.name).not.toBe(b.name);
		expect(new Set([a.folio_interno, b.folio_interno]).size).toBe(2);
	});

	test('un lote seguido (sync offline) en el mismo segundo da folios distintos', async () => {
		setSystemTime(new Date('2026-09-21T17:30:26.486Z'));
		const store = store_con_contador();
		const folios: string[] = [];
		for (let i = 0; i < 3; i++) {
			const pedido = await prepare_pedido_create(store, { estado: 'confirmado', articulos: [] }, ADMIN, {
				validar_confirmacion: false,
			});
			folios.push(String(pedido.folio));
		}
		expect(new Set(folios).size).toBe(3);
	});

	test('el folio conserva usuario y hora y termina en el folio interno', async () => {
		setSystemTime(new Date(2026, 10, 18, 15, 15, 14));
		const pedido = await prepare_pedido_create(store_con_contador(), { estado: 'borrador', articulos: [] }, ADMIN);
		expect(pedido.folio).toBe('admin-20261118-151514-1');
		expect(pedido.name).toBe('PEDIDO-admin-20261118-151514-1');
	});
});
