import { describe, expect, test } from 'bun:test';
import { list_search_columns } from './list-search.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

describe('list_search_columns', () => {
	test('citizen-report busca nombre de ciudadano y descripción además de name', () => {
		const cols = list_search_columns(
			'citizen-report',
			new Set([
				'name',
				'search_field',
				'citizen_name',
				'citizen_phone',
				'report_description',
				'payload',
			]),
		);
		expect(cols).toContain('name');
		expect(cols).toContain('search_field');
		expect(cols).toContain('citizen_name');
		expect(cols).toContain('citizen_phone');
		expect(cols).toContain('report_description');
		expect(cols).not.toContain('payload');
	});

	test('delivery-return busca folio y cliente', () => {
		const cols = list_search_columns(
			'delivery-return',
			new Set(['name', 'pedido_folio', 'contacto_nombre', 'estado']),
		);
		expect(cols).toContain('pedido_folio');
		expect(cols).toContain('contacto_nombre');
		expect(cols).toContain('name');
	});

	test('otros recursos no inventan columnas de reportes', () => {
		expect(list_search_columns('user', new Set(['name', 'email']))).toEqual([
			'name',
		]);
	});

	test('inventory-internal-location busca por codigo además de name', () => {
		const cols = list_search_columns(
			'inventory-internal-location',
			new Set([
				'name',
				'description',
				'search_field',
				'codigo',
				'tipo',
				'parent',
			]),
		);
		expect(cols).toEqual(['name', 'description', 'search_field', 'codigo']);
	});

	test('el ILIKE de ubicaciones incluye codigo: PRUEBAALBA no está en el nombre', async () => {
		const queries: string[] = [];
		const sql = {
			unsafe(query: string) {
				queries.push(query);
				if (query.startsWith('SELECT count(*)')) return Promise.resolve([{ n: 0 }]);
				return Promise.resolve([]);
			},
		} as unknown as Bun.SQL;
		const store = new ImperiumStore(sql, load_catalog_path());
		await store.find_many('inventory-internal-location', {
			q: 'PRUEBAALBA',
			take: 30,
			populate: false,
			sql_search_only: true,
		});
		const like = queries.find((query) => query.includes('ILIKE'));
		expect(like).toContain('"codigo"');
	});

	test('products busca por codigo además de name, description y search_field', () => {
		const cols = list_search_columns(
			'products',
			new Set([
				'name',
				'description',
				'search_field',
				'codigo',
				'codigos_proveedor',
				'positional_code',
			]),
		);
		expect(cols).toEqual(['name', 'description', 'search_field', 'codigo']);
	});

	test('pedidos busca por folio y folio interno', () => {
		const cols = list_search_columns(
			'pedidos',
			new Set(['name', 'description', 'search_field', 'folio', 'folio_interno', 'contacto']),
		);
		expect(cols).toEqual(['name', 'description', 'search_field', 'folio', 'folio_interno']);
	});
	test('user no busca por ref: «ana» no debe traer a admin (#179)', () => {
		const cols = list_search_columns(
			'user',
			new Set(['name', 'ref', 'search_field', 'code']),
		);
		expect(cols).not.toContain('ref');
		expect(cols).toContain('name');
		expect(cols).toContain('search_field');
	});

	test('otros recursos siguen buscando por ref', () => {
		expect(list_search_columns('products', new Set(['name', 'ref']))).toContain(
			'ref',
		);
	});
});
