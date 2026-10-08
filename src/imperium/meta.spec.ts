import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImperiumDoc } from './envelope.ts';
import { SEED_ADMIN_REF } from './group-access.ts';
import { meta_http_response } from './meta.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const QUIET = new Set([
	'postgres-table-tracker',
	'module-management',
	'configuration',
	'custom-field-control',
]);

type Column = { name: string; label?: string; component?: string };

const catalog = JSON.parse(readFileSync(load_catalog_path(), 'utf8')) as {
	subjects: Array<{ modules?: Array<{ resource: string; columns?: Column[] }> }>;
};

function catalog_column(resource: string, name: string): Column {
	for (const subject of catalog.subjects) {
		for (const mod of subject.modules ?? []) {
			if (mod.resource !== resource) continue;
			const column = mod.columns?.find((item) => item.name === name);
			if (column) return column;
		}
	}
	throw new Error(`sin columna ${resource}.${name}`);
}

function harness(rights: ImperiumDoc[] = []) {
	const real = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	const store = new Proxy(real, {
		get(target, prop, receiver) {
			if (prop === 'has') {
				return (resource: string) => (QUIET.has(resource) ? false : target.has(resource));
			}
			if (prop === 'scan') {
				return async function* (resource: string) {
					if (resource === 'access-rights' && rights.length) yield rights;
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as ImperiumStore;
	return store;
}

const admin: ImperiumDoc = { _id: 'admin', _ref: SEED_ADMIN_REF, type: 'internal' };

function right(id: string, model_id: string, allow_read: boolean): ImperiumDoc {
	return {
		_id: id,
		model_id,
		allow_read,
		allow_create: false,
		allow_update: false,
		allow_delete: false,
	};
}

async function call(
	store: ImperiumStore,
	user: ImperiumDoc | null,
	init?: RequestInit,
) {
	const res = await meta_http_response(
		store,
		user,
		new Request('http://imperium.test/api/meta', init),
	);
	const text = await res.text();
	return {
		status: res.status,
		text,
		json: text ? (JSON.parse(text) as Record<string, unknown>) : null,
		etag: res.headers.get('etag'),
		cache: res.headers.get('cache-control'),
		vary: res.headers.get('vary'),
	};
}

function resources_of(json: Record<string, unknown> | null) {
	const row = (json?.data as Array<{ resources?: Array<Record<string, unknown>> }> | undefined)?.[0];
	return row?.resources ?? [];
}

function resource_named(rows: Array<Record<string, unknown>>, name: string) {
	return rows.find((row) => row.resource === name);
}

describe('GET /api/meta', () => {
	test('sin sesión responde 401', async () => {
		const router = readFileSync(join(import.meta.dir, 'router.ts'), 'utf8');
		const meta_at = router.indexOf("path === '/meta'");
		const crud_at = router.indexOf('const hit = split_resource');
		expect(meta_at).toBeGreaterThan(0);
		expect(crud_at).toBeGreaterThan(meta_at);

		const res = await call(harness(), null);
		expect(res.status).toBe(401);
		expect(String(res.json?.message ?? res.json?.error ?? '')).toContain('autenticado');
	});

	test('quien no puede leer un recurso no lo ve; el admin sí', async () => {
		const limited_store = harness([right('ar-user', 'User', true)]);
		const limited_user: ImperiumDoc = { _id: 'u-limited', _ref: 'user-limited', type: 'internal' };
		const limited = resources_of((await call(limited_store, limited_user)).json);
		expect(resource_named(limited, 'user')).toBeTruthy();
		expect(resource_named(limited, 'products')).toBeUndefined();
		const user = resource_named(limited, 'user') as {
			permissions: { read: boolean; create: boolean; update: boolean; delete: boolean };
		};
		expect(user.permissions).toEqual({
			read: true,
			create: false,
			update: false,
			delete: false,
		});

		const visible = resources_of((await call(harness(), admin)).json);
		expect(resource_named(visible, 'products')).toBeTruthy();
		expect(resource_named(visible, 'user')).toBeTruthy();
	}, 20_000);

	test('user no expone secretos', async () => {
		const rows = resources_of((await call(harness(), admin)).json);
		const user = resource_named(rows, 'user') as {
			fields: Array<{ name: string }>;
			list_columns: Array<{ name: string }>;
		};
		const names = [...user.fields.map((field) => field.name), ...user.list_columns.map((col) => col.name)];
		for (const secret of ['password', 'reset_password_token_hash', 'recovery_token', 'pin_hash']) {
			expect(names).not.toContain(secret);
		}
	}, 20_000);

	test('etiqueta y componente salen del catálogo', async () => {
		const column = catalog_column('user', 'email');
		const rows = resources_of((await call(harness(), admin)).json);
		const user = resource_named(rows, 'user') as {
			fields: Array<{ name: string; label: string; component: string }>;
		};
		const email = user.fields.find((field) => field.name === 'email');
		expect(email?.label).toBe(column.label);
		expect(email?.component).toBe(column.component);
	}, 20_000);

	test('un requerido del esquema sale required', async () => {
		const rows = resources_of((await call(harness(), admin)).json);
		const user = resource_named(rows, 'user') as {
			fields: Array<{ name: string; required: boolean }>;
		};
		expect(user.fields.find((field) => field.name === 'email')?.required).toBe(true);
	}, 20_000);

	test('el mismo cuerpo repite el ETag y If-None-Match responde 304', async () => {
		const store = harness();
		const first = await call(store, admin);
		const second = await call(store, admin);
		expect(first.status).toBe(200);
		expect(first.etag).toBeTruthy();
		expect(second.etag).toBe(first.etag);
		expect(first.cache).toBe('private, no-cache');
		expect(first.vary).toBe('Cookie');

		const cached = await call(store, admin, { headers: { 'if-none-match': first.etag ?? '' } });
		expect(cached.status).toBe(304);
		expect(cached.text).toBe('');
		expect(cached.etag).toBe(first.etag);
		expect(cached.cache).toBe('private, no-cache');
		expect(cached.vary).toBe('Cookie');

		const post = await meta_http_response(
			store,
			admin,
			new Request('http://imperium.test/api/meta', { method: 'POST' }),
		);
		expect(post.status).toBe(405);
	}, 20_000);

	test('dos usuarios con permisos distintos dan ETag distinto', async () => {
		const reader: ImperiumDoc = { _id: 'u-reader', _ref: 'user-reader', type: 'internal' };
		const other: ImperiumDoc = { _id: 'u-other', _ref: 'user-other', type: 'internal' };
		const user_only = await call(harness([right('ar-user', 'User', true)]), reader);
		const products_only = await call(harness([right('ar-products', 'Products', true)]), other);
		expect(user_only.status).toBe(200);
		expect(products_only.status).toBe(200);
		expect(user_only.etag).not.toBe(products_only.etag);
		const reader_names = resources_of(user_only.json).map((row) => row.resource);
		const other_names = resources_of(products_only.json).map((row) => row.resource);
		expect(reader_names).toContain('user');
		expect(reader_names).not.toContain('products');
		expect(other_names).toContain('products');
		expect(other_names).not.toContain('user');
	}, 20_000);
});
