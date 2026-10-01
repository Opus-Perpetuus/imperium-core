import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert_http_access } from './auth.ts';
import { icon_search_terms_es } from './font-awesome-icon-search-es.ts';
import type { ImperiumStore } from './store.ts';

const store_que_pide_acl = new Proxy(
	{},
	{
		get() {
			throw new Error('consultó permisos');
		},
	},
) as unknown as ImperiumStore;

const empleado = { _id: 'u1', email: 'empleado@empresa.com' };

describe('catálogo de íconos', () => {
	test('viaja dentro del núcleo: la imagen no lleva backend/src', () => {
		const file = join(import.meta.dir, 'font-awesome-icons.data.json');
		expect(existsSync(file)).toBe(true);
		const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{ icon: string }>;
		expect(rows.length).toBeGreaterThan(2000);
		expect(rows.every((row) => /^fa[sbr] fa-[a-z0-9-]+$/.test(row.icon))).toBe(true);
	});

	test('cualquier usuario interno lo lee sin permiso de su grupo', async () => {
		await expect(
			assert_http_access(store_que_pide_acl, empleado, 'font-awesome-icon-catalog', 'GET'),
		).resolves.toBeUndefined();
	});

	test('escribirlo sigue pidiendo permisos', async () => {
		await expect(
			assert_http_access(store_que_pide_acl, empleado, 'font-awesome-icon-catalog', 'POST'),
		).rejects.toThrow('consultó permisos');
	});

	test('sin sesión no se lee', async () => {
		await expect(
			assert_http_access(store_que_pide_acl, null, 'font-awesome-icon-catalog', 'GET'),
		).rejects.toThrow();
	});

	test('se busca en español, con y sin acento', () => {
		const casa = icon_search_terms_es('house-chimney');
		expect(casa).toContain('casa');
		expect(icon_search_terms_es('hospital-user')).toContain('usuario');
		const almacen = icon_search_terms_es('warehouse');
		expect(almacen).toContain('almacén');
		expect(almacen).toContain('almacen');
		expect(icon_search_terms_es('baseball')).toEqual([]);
	});
});
