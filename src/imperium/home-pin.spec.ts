import { describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import { assert_http_access } from './auth.ts';
import type { ImperiumDoc } from './envelope.ts';
import extra_routes from './extra-routes.json';
import type { ImperiumStore } from './store.ts';

function pins_store() {
	const rows: ImperiumDoc[] = [];
	let seq = 0;
	const matches = (row: ImperiumDoc, where: Record<string, unknown> = {}) =>
		Object.entries(where).every(([key, value]) => row[key] === value);
	const store = {
		rows,
		has: (resource: string) => resource === 'home-pin',
		async find_many(
			_resource: string,
			opts: { where?: Record<string, unknown>; take?: number; include_inactive?: boolean },
		) {
			const hits = rows.filter(
				(row) => (opts.include_inactive || row.is_active !== false) && matches(row, opts.where),
			);
			return { rows: hits.slice(0, opts.take ?? 100), total: hits.length };
		},
		async find_id(_resource: string, id: string) {
			return rows.find((row) => row._id === id) ?? null;
		},
		async insert(_resource: string, doc: ImperiumDoc) {
			const row = { ...doc, _id: `pin-${++seq}`, is_active: true };
			rows.push(row);
			return row;
		},
		async update(_resource: string, id: string, patch: ImperiumDoc) {
			const row = rows.find((item) => item._id === id);
			if (!row) return null;
			Object.assign(row, patch);
			return row;
		},
		async remove(resource: string, id: string) {
			return store.update(resource, id, { is_active: false });
		},
	};
	return store;
}

const ana = { _id: 'ana', email: 'ana@empresa.com' };
const beto = { _id: 'beto', email: 'beto@empresa.com' };

async function call(
	store: ReturnType<typeof pins_store>,
	actor: ImperiumDoc,
	action: string,
	opts: { method?: string; id?: string; body?: Record<string, unknown> } = {},
) {
	const method = opts.method ?? 'GET';
	const url = new URL(`http://core/api/home-pin/mine${opts.id ? `/${opts.id}` : ''}`);
	const req = new Request(url, {
		method,
		headers: { 'content-type': 'application/json' },
		body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
	});
	const res = await handle_action(
		store as unknown as ImperiumStore,
		{} as Bun.SQL,
		req,
		url,
		'home-pin',
		action,
		opts.id ? { id: opts.id } : {},
		actor,
	);
	return (await res.json()) as { data: ImperiumDoc[]; message: string };
}

const crear = (store: ReturnType<typeof pins_store>, actor: ImperiumDoc, body: Record<string, unknown>) =>
	call(store, actor, 'create_mine', { method: 'POST', body });

describe('pines de inicio', () => {
	test('cada quien ve solo sus pines y el dueño lo pone el núcleo', async () => {
		const store = pins_store();
		await crear(store, ana, { name: 'Usuarios', path: '/internal/user', icon: 'fas fa-users', user_id: 'beto' });
		await crear(store, beto, { name: 'Almacén', path: '/internal/subject/almacen' });
		const mios = await call(store, ana, 'list_mine');
		expect(mios.data.map((pin) => pin.name)).toEqual(['Usuarios']);
		expect(mios.data[0]?.user_id).toBe('ana');
	});

	test('no repite pantalla para el mismo usuario, pero otro sí puede fijarla', async () => {
		const store = pins_store();
		await crear(store, ana, { name: 'Usuarios', path: '/internal/user' });
		await expect(crear(store, ana, { name: 'Otra vez', path: '/internal/user' })).rejects.toThrow(
			'Ya tienes un pin a esta pantalla.',
		);
		const de_beto = await crear(store, beto, { name: 'Usuarios', path: '/internal/user' });
		expect(de_beto.data[0]?.user_id).toBe('beto');
	});

	test('nadie edita ni quita el pin de otro', async () => {
		const store = pins_store();
		const { data } = await crear(store, ana, { name: 'Usuarios', path: '/internal/user' });
		const id = String(data[0]?._id);
		await expect(
			call(store, beto, 'update_mine', { method: 'PUT', id, body: { name: 'Mío', path: '/internal/user' } }),
		).rejects.toThrow('Pin no encontrado');
		await expect(call(store, beto, 'delete_mine', { method: 'DELETE', id })).rejects.toThrow(
			'Pin no encontrado',
		);
	});

	test('editar cambia nombre, ícono y destino', async () => {
		const store = pins_store();
		const { data } = await crear(store, ana, { name: 'Usuarios', path: '/internal/user' });
		const id = String(data[0]?._id);
		const editado = await call(store, ana, 'update_mine', {
			method: 'PUT',
			id,
			body: { name: 'Personal', path: '/internal/user-group', icon: 'fas fa-user-group' },
		});
		expect(editado.data[0]).toMatchObject({ name: 'Personal', path: '/internal/user-group', user_id: 'ana' });
	});

	test('quitar un pin deja volver a crearlo', async () => {
		const store = pins_store();
		const { data } = await crear(store, ana, { name: 'Usuarios', path: '/internal/user' });
		await call(store, ana, 'delete_mine', { method: 'DELETE', id: String(data[0]?._id) });
		expect((await call(store, ana, 'list_mine')).data).toEqual([]);
		const otra_vez = await crear(store, ana, { name: 'Usuarios', path: '/internal/user' });
		expect(otra_vez.data[0]?.name).toBe('Usuarios');
	});

	test('pide nombre y una ruta de esta misma app', async () => {
		const store = pins_store();
		await expect(crear(store, ana, { name: '', path: '/internal/user' })).rejects.toThrow('nombre');
		await expect(crear(store, ana, { name: 'Fuera', path: '//otro-sitio.com' })).rejects.toThrow(
			'pantalla',
		);
		await expect(crear(store, ana, { name: 'Fuera', path: 'https://otro-sitio.com' })).rejects.toThrow(
			'pantalla',
		);
		for (const path of ['/\\otro-sitio.com', '/\t/otro-sitio.com', '/\n/otro-sitio.com', '/\\/otro-sitio.com', '/login']) {
			await expect(crear(store, ana, { name: 'Fuera', path })).rejects.toThrow('pantalla');
		}
	});

	test('las rutas propias solo piden sesión; el CRUD general sigue pidiendo permisos', async () => {
		const store_que_pide_acl = new Proxy(
			{},
			{
				get() {
					throw new Error('consultó permisos');
				},
			},
		) as unknown as ImperiumStore;
		const rutas = (extra_routes as Array<{ resource: string; action: string }>).filter(
			(route) => route.resource === 'home-pin',
		);
		expect(rutas.map((route) => route.action).sort()).toEqual([
			'create_mine',
			'delete_mine',
			'list_mine',
			'update_mine',
		]);
		for (const route of rutas) {
			await expect(
				assert_http_access(store_que_pide_acl, ana, 'home-pin', 'POST', { extra: true, action: route.action }),
			).resolves.toBeUndefined();
		}
		await expect(assert_http_access(store_que_pide_acl, ana, 'home-pin', 'GET')).rejects.toThrow(
			'consultó permisos',
		);
	});
});
