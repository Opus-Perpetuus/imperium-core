import { describe, expect, test } from 'bun:test';
import { is_column_name, search_sql, where_sql } from './data-plane-where.ts';

/**
 * `= ANY($1)` con un array JS rompía la sincronización de proveedores:
 * Bun.SQL manda el array como texto unido por comas y Postgres contesta
 * "malformed array literal". Cada valor va como su propio placeholder.
 */
describe('where_sql: operador in', () => {
	test('expande a un placeholder por valor y nunca manda un array', () => {
		const w = where_sql({ external_id: { in: ['a', 'b', 'c'] } });
		expect(w.sql).toBe(' WHERE "external_id" IN ($1, $2, $3)');
		expect(w.params).toEqual(['a', 'b', 'c']);
		expect(w.params.some((p) => Array.isArray(p))).toBe(false);
	});

	test('numera los placeholders junto a otras condiciones', () => {
		const w = where_sql({
			provider_id: 'prov_1',
			external_id: { in: ['a', 'b'] },
		});
		expect(w.sql).toBe(
			' WHERE "provider_id" = $1 AND "external_id" IN ($2, $3)',
		);
		expect(w.params).toEqual(['prov_1', 'a', 'b']);
	});

	test('respeta el offset de start (camino de update)', () => {
		const w = where_sql({ id: { in: ['x', 'y'] } }, 4);
		expect(w.sql).toBe(' WHERE "id" IN ($4, $5)');
		expect(w.params).toEqual(['x', 'y']);
	});

	test('lista vacía no genera IN () inválido', () => {
		const w = where_sql({ id: { in: [] } });
		expect(w.sql).toBe(' WHERE FALSE');
		expect(w.params).toEqual([]);
	});

	test('el resto de operadores sigue igual', () => {
		expect(where_sql({ state: { ne: 'x' } }).sql).toBe(
			' WHERE "state" IS DISTINCT FROM $1',
		);
		expect(where_sql({ ref: { isNull: true } })).toEqual({
			sql: ' WHERE "ref" IS NULL',
			params: [],
		});
		expect(where_sql(undefined)).toEqual({ sql: '', params: [] });
	});
});

/**
 * El filtro de columnas de `update` traía `[a-z0-9-]` (guion en vez de guion
 * bajo), así que descartaba en silencio toda columna con `_`: `updated_at` se
 * quedaba con la hora de alta y `config_json` no se podía cambiar nunca.
 */
describe('is_column_name', () => {
	test('acepta columnas con guion bajo', () => {
		for (const col of [
			'updated_at',
			'config_json',
			'stats_json',
			'external_id',
			'base_price_cents',
			'_ref',
		]) {
			expect(is_column_name(col)).toBe(true);
		}
	});

	test('acepta columnas simples', () => {
		expect(is_column_name('name')).toBe(true);
		expect(is_column_name('id')).toBe(true);
	});

	test('rechaza lo que no es identificador', () => {
		for (const bad of [
			'con-guion',
			'2empieza_con_digito',
			'con espacio',
			'punto.compuesto',
			'"comilla"',
			'',
		]) {
			expect(is_column_name(bad)).toBe(false);
		}
	});
});

/**
 * `count` ignoraba el término de búsqueda que el cliente sí manda, así que el
 * total de una lista filtrada salía como si no hubiera filtro.
 */
describe('search_sql', () => {
	test('encadena con AND cuando ya hay WHERE', () => {
		const s = search_sql({ fields: ['title', 'sku'], q: 'cable' }, true, 3);
		expect(s.sql).toBe(' AND ("title" ILIKE $3 OR "sku" ILIKE $4)');
		expect(s.params).toEqual(['%cable%', '%cable%']);
	});

	test('abre el WHERE cuando no hay condiciones previas', () => {
		const s = search_sql({ fields: ['title'], q: 'cable' }, false, 1);
		expect(s.sql).toBe(' WHERE ("title" ILIKE $1)');
		expect(s.params).toEqual(['%cable%']);
	});

	test('sin término o sin campos no filtra', () => {
		expect(search_sql(undefined, false, 1)).toEqual({ sql: '', params: [] });
		expect(search_sql({ fields: ['title'], q: '' }, false, 1).sql).toBe('');
		expect(search_sql({ fields: [], q: 'cable' }, false, 1).sql).toBe('');
	});

	test('descarta campos que no son columnas', () => {
		const s = search_sql({ fields: ['title', 'no-valido'], q: 'x' }, false, 1);
		expect(s.sql).toBe(' WHERE ("title" ILIKE $1)');
		expect(s.params).toEqual(['%x%']);
	});
});

/**
 * El kit declara nueve operadores y el plano de datos implementaba cuatro. Los
 * cinco restantes caían en la igualdad final, así que el filtro de marca del
 * escaparate (`{ like: 'panduit' }`) preguntaba por un objeto y contestaba cero
 * filas: el panel ofrecía «panduit (2 468)» y el catálogo salía vacío.
 */
describe('where_sql: operadores que faltaban', () => {
	test('like se traduce a ILIKE, que ancla el patrón como el cliente en memoria', () => {
		expect(where_sql({ brand: { like: 'panduit' } })).toEqual({
			sql: ' WHERE "brand" ILIKE $1',
			params: ['panduit'],
		});
	});

	test('los comodines del patrón viajan intactos', () => {
		expect(where_sql({ tags_text: { like: '%|exterior|%' } })).toEqual({
			sql: ' WHERE "tags_text" ILIKE $1',
			params: ['%|exterior|%'],
		});
	});

	test('las comparaciones de rango salen como tales', () => {
		expect(where_sql({ stock: { gt: 0 } }).sql).toBe(' WHERE "stock" > $1');
		expect(where_sql({ stock: { gte: 1 } }).sql).toBe(' WHERE "stock" >= $1');
		expect(where_sql({ stock: { lt: 5 } }).sql).toBe(' WHERE "stock" < $1');
		expect(where_sql({ created_at: { lte: 'ayer' } })).toEqual({
			sql: ' WHERE "created_at" <= $1',
			params: ['ayer'],
		});
	});

	test('isNotNull no lleva parámetro', () => {
		expect(where_sql({ detail_fetched_at: { isNotNull: true } })).toEqual({
			sql: ' WHERE "detail_fetched_at" IS NOT NULL',
			params: [],
		});
	});

	test('ningún operador manda el objeto como parámetro', () => {
		for (const cond of [
			{ like: 'x' },
			{ gt: 1 },
			{ gte: 1 },
			{ lt: 1 },
			{ lte: 1 },
			{ isNotNull: true },
		]) {
			const w = where_sql({ col: cond } as never);
			expect(w.params.some((p) => typeof p === 'object' && p !== null)).toBe(
				false,
			);
		}
	});

	test('se numeran junto a otras condiciones', () => {
		const w = where_sql({
			is_published: 1,
			brand: { like: 'acme' },
			stock: { gte: 1 },
		});
		expect(w.sql).toBe(
			' WHERE "is_published" = $1 AND "brand" ILIKE $2 AND "stock" >= $3',
		);
		expect(w.params).toEqual([1, 'acme', 1]);
	});

	test('un objeto que no es operador sigue comparándose por igualdad (jsonb)', () => {
		const w = where_sql({ payload: { tags: ['a'] } } as never);
		expect(w.sql).toBe(' WHERE "payload" = $1');
		expect(w.params).toEqual([{ tags: ['a'] }]);
	});
});
