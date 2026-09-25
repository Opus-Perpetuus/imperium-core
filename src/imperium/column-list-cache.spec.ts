import { describe, expect, test } from 'bun:test';
import { ColumnListCache } from './column-list-cache.ts';

describe('lista de columnas del plano de datos', () => {
	test('caduca: una columna añadida por otra réplica se ve sin reiniciar', () => {
		let t = 0;
		const cache = new ColumnListCache(30_000, () => t);
		cache.set('subject_tienda.products', ['id', 'title']);
		t = 29_999;
		expect(cache.get('subject_tienda.products')).toEqual(['id', 'title']);
		t = 30_000;
		expect(cache.get('subject_tienda.products')).toBeNull();
	});

	test('aplicar el esquema de una app olvida solo sus tablas', () => {
		const cache = new ColumnListCache(30_000, () => 0);
		cache.set('subject_tienda.products', ['id']);
		cache.set('subject_tienda.carts', ['id']);
		cache.set('subject_pos.tickets', ['id']);
		cache.forget_schema('subject_tienda');
		expect(cache.get('subject_tienda.products')).toBeNull();
		expect(cache.get('subject_tienda.carts')).toBeNull();
		expect(cache.get('subject_pos.tickets')).toEqual(['id']);
	});
});
