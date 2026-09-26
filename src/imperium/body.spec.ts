import { describe, expect, test } from 'bun:test';
import { query_list } from './body.ts';

function list_take(search: string) {
	return query_list(new URL(`https://imperium.local/list${search}`)).take;
}

describe('query_list', () => {
	test('limite mayor a 200 se recorta a 200', () => {
		expect(list_take('?limite=201')).toBe(200);
		expect(list_take('?limite=10000')).toBe(200);
		expect(list_take('?take=500')).toBe(200);
	});

	test('un limite válido se respeta', () => {
		expect(list_take('?limite=1')).toBe(1);
		expect(list_take('?limite=50')).toBe(50);
		expect(list_take('?limite=199')).toBe(199);
		expect(list_take('?limite=200')).toBe(200);
		expect(list_take('?take=25')).toBe(25);
		expect(list_take('')).toBe(100);
	});
});
