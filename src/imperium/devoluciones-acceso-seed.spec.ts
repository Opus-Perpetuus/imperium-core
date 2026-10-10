import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	MENU_REF_DEVOLUCIONES,
	permiso_plantilla_ticket_choferes,
	permisos_adjunto_firma,
	permisos_devolucion,
} from '../../../../backend/src/components/user-group/flujo-grupos-acceso.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	DEVOLUCIONES_ACCESS_RIGHTS,
	DEVOLUCIONES_MENU_GROUPS,
	DEVOLUCIONES_MENU_REF,
	ensure_devoluciones_access,
} from './devoluciones-acceso-seed.ts';
import { parse_module_data_file } from './module-data.ts';

const MENU_ID = 'menu-devoluciones-1';
const GRUPOS = ['user-group-choferes', 'user-group-almacen', 'user-group-logistica'] as const;

type Row = ImperiumDoc;

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) {
		data[key] = rows.map((row) => ({ ...row }));
	}
	const inserts: Array<{ resource: string; doc: Row }> = [];
	const updates: Array<{ resource: string; id: string; patch: Row }> = [];
	const store = {
		data,
		inserts,
		updates,
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		async *scan(resource: string, _opts: { include_inactive?: boolean } = {}) {
			yield (data[resource] ?? []).map((row) => ({ ...row }));
		},
		async insert(resource: string, doc: Row) {
			const row = { ...doc, _id: doc._id ?? `id-${crypto.randomUUID()}` };
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			inserts.push({ resource, doc: row });
			return row;
		},
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			rows[index] = { ...rows[index], ...patch, _id: id };
			updates.push({ resource, id, patch });
			return rows[index];
		},
	};
	return store as unknown as ImperiumStore & {
		data: Record<string, Row[]>;
		inserts: Array<{ resource: string; doc: Row }>;
		updates: Array<{ resource: string; id: string; patch: Row }>;
	};
}

function base(extra: {
	menus?: Row[];
	groups?: Row[];
	rights?: Row[];
} = {}) {
	return memory_store({
		'menu-management': extra.menus ?? [
			{ _id: MENU_ID, _ref: DEVOLUCIONES_MENU_REF, name: 'Devoluciones' },
		],
		'user-group': extra.groups ?? [
			{ _id: 'g-choferes', _ref: 'user-group-choferes', name: 'Choferes', menus_ids: [] },
			{ _id: 'g-almacen', _ref: 'user-group-almacen', name: 'Almacén', menus_ids: [] },
			{ _id: 'g-logistica', _ref: 'user-group-logistica', name: 'Logística', menus_ids: [] },
			{ _id: 'g-vendedores', _ref: 'user-group-vendedores', name: 'Vendedores', menus_ids: [] },
		],
		'access-rights': extra.rights ?? [],
	});
}

const CAMPOS = [
	'_ref',
	'name',
	'description',
	'model_id',
	'group_id',
	'allow_read',
	'allow_create',
	'allow_update',
	'allow_delete',
] as const;

function pick(row: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	for (const key of CAMPOS) out[key] = row[key];
	return out;
}

describe('siembra de accesos de Devoluciones', () => {
	test('base vacía crea las 8 filas y anexa el menú a los 3 grupos', async () => {
		const store = base();
		const result = await ensure_devoluciones_access(store);
		expect(result.rights).toEqual(DEVOLUCIONES_ACCESS_RIGHTS.map((row) => row._ref));
		expect(result.groups).toEqual(['g-choferes', 'g-almacen', 'g-logistica']);
		expect(store.data['access-rights']).toHaveLength(8);
		expect(store.inserts.filter((call) => call.resource === 'access-rights')).toHaveLength(8);
		for (const row of store.data['access-rights'] ?? []) {
			expect(row.is_active).toBe(true);
			expect(row.allow_delete).toBe(false);
		}
		for (const id of ['g-choferes', 'g-almacen', 'g-logistica']) {
			const group = store.data['user-group']?.find((row) => row._id === id);
			expect(group?.menus_ids).toEqual([MENU_ID]);
		}
		const vendedores = store.data['user-group']?.find((row) => row._ref === 'user-group-vendedores');
		expect(vendedores?.menus_ids).toEqual([]);
		expect(store.data['access-rights']?.some((row) => row.group_id === 'user-group-vendedores')).toBe(
			false,
		);
		expect(DEVOLUCIONES_MENU_GROUPS).toEqual([...GRUPOS]);
	});

	test('la segunda corrida no crea ni actualiza nada', async () => {
		const store = base();
		await ensure_devoluciones_access(store);
		store.inserts.length = 0;
		store.updates.length = 0;
		const second = await ensure_devoluciones_access(store);
		expect(second).toEqual({ rights: [], groups: [] });
		expect(store.inserts).toEqual([]);
		expect(store.updates).toEqual([]);
		expect(store.data['access-rights']).toHaveLength(8);
		const refs = (store.data['access-rights'] ?? []).map((row) => row._ref);
		expect(new Set(refs).size).toBe(8);
	});

	test('no pisa un _ref existente y respeta menus_ids en JSON', async () => {
		const previa: Row = {
			_id: 'ar-choferes',
			_ref: 'delivery-return-access-rights-choferes',
			name: 'viejo',
			description: 'distinto',
			model_id: 'DeliveryReturn',
			group_id: 'user-group-choferes',
			allow_read: true,
			allow_create: true,
			allow_update: false,
			allow_delete: true,
			is_active: false,
		};
		const store = base({
			rights: [previa],
			groups: [
				{
					_id: 'g-choferes',
					_ref: 'user-group-choferes',
					menus_ids: [MENU_ID, 'menu-pedidos'],
				},
				{
					_id: 'g-almacen',
					_ref: 'user-group-almacen',
					menus_ids: '["menu-recepcion","menu-conteo"]',
				},
				{
					_id: 'g-logistica',
					_ref: 'user-group-logistica',
					menus_ids: '',
				},
				{
					_id: 'g-vendedores',
					_ref: 'user-group-vendedores',
					menus_ids: '["menu-ventas"]',
				},
			],
		});
		const result = await ensure_devoluciones_access(store);
		expect(result.rights).not.toContain('delivery-return-access-rights-choferes');
		const choferes = store.data['access-rights']?.filter(
			(row) => row._ref === 'delivery-return-access-rights-choferes',
		);
		expect(choferes).toHaveLength(1);
		expect(choferes?.[0]).toMatchObject({
			allow_update: false,
			allow_delete: true,
			is_active: false,
			name: 'viejo',
			description: 'distinto',
		});
		expect(store.data['access-rights']).toHaveLength(8);
		expect(store.updates.filter((call) => call.resource === 'access-rights')).toEqual([]);
		expect(store.updates.map((call) => call.id).sort()).toEqual(['g-almacen', 'g-logistica']);
		const almacen = store.data['user-group']?.find((row) => row._id === 'g-almacen');
		expect(almacen?.menus_ids).toEqual(['menu-recepcion', 'menu-conteo', MENU_ID]);
		const grupo_choferes = store.data['user-group']?.find((row) => row._id === 'g-choferes');
		expect(grupo_choferes?.menus_ids).toEqual([MENU_ID, 'menu-pedidos']);
		const vendedores = store.data['user-group']?.find((row) => row._id === 'g-vendedores');
		expect(vendedores?.menus_ids).toEqual('["menu-ventas"]');
	});

	test('sin el menú de Devoluciones no toca grupos', async () => {
		const store = base({
			menus: [{ _id: 'menu-otro', _ref: 'otro-menu', name: 'Otro' }],
			groups: [
				{ _id: 'g-choferes', _ref: 'user-group-choferes', menus_ids: ['menu-otro'] },
				{ _id: 'g-almacen', _ref: 'user-group-almacen', menus_ids: null },
				{ _id: 'g-logistica', _ref: 'user-group-logistica', menus_ids: '' },
			],
		});
		const antes = structuredClone(store.data['user-group']);
		const result = await ensure_devoluciones_access(store);
		expect(result.groups).toEqual([]);
		expect(store.updates).toEqual([]);
		expect(store.data['user-group']).toEqual(antes);
		expect(result.rights).toHaveLength(8);
	});

	test('paridad con el backend en los tres grupos', () => {
		expect(DEVOLUCIONES_MENU_REF).toBe(MENU_REF_DEVOLUCIONES);
		expect(DEVOLUCIONES_ACCESS_RIGHTS).toHaveLength(8);
		const grupos = new Set<string>(GRUPOS);
		const backend = [...permisos_devolucion(), ...permisos_adjunto_firma()].filter((row) =>
			grupos.has(row.group_id),
		);
		const nucleo = DEVOLUCIONES_ACCESS_RIGHTS.filter(
			(row) => row.model_id === 'DeliveryReturn' || row.model_id === 'AttachmentManagement',
		);
		expect(nucleo.map(pick)).toEqual(backend.map(pick));
		const parsed = parse_module_data_file(
			join(import.meta.dir, '../../../../backend/src/components/user-group/module.data.ts'),
		);
		const ubicacion = parsed.find(
			(row) => row.doc._ref === 'almacen-access-rights-inventory-internal-location',
		);
		expect(ubicacion).toBeTruthy();
		const fila = DEVOLUCIONES_ACCESS_RIGHTS.find(
			(row) => row._ref === 'almacen-access-rights-inventory-internal-location',
		);
		expect(pick(fila ?? {})).toEqual(pick(ubicacion?.doc ?? {}));
		expect(fila?.is_active).toBe(true);
		const plantilla = DEVOLUCIONES_ACCESS_RIGHTS.find(
			(row) => row._ref === 'choferes-access-rights-epson-ticket-template',
		);
		expect(pick(plantilla ?? {})).toEqual(pick(permiso_plantilla_ticket_choferes()));
		expect(plantilla?.is_active).toBe(true);
	});

	test('una base con las 7 filas previas sólo inserta choferes-access-rights-epson-ticket-template', async () => {
		const previas = DEVOLUCIONES_ACCESS_RIGHTS.filter(
			(row) => row._ref !== 'choferes-access-rights-epson-ticket-template',
		);
		const store = base({ rights: previas });
		const result = await ensure_devoluciones_access(store);
		expect(previas).toHaveLength(7);
		expect(result.rights).toEqual(['choferes-access-rights-epson-ticket-template']);
		expect(
			store.inserts
				.filter((call) => call.resource === 'access-rights')
				.map((call) => call.doc._ref),
		).toEqual(['choferes-access-rights-epson-ticket-template']);
	});

	test('un fallo de esta siembra no tumba el resto', () => {
		const src = readFileSync(new URL('./configuration-seed-sync.ts', import.meta.url), 'utf8');
		const reuniones = src.indexOf('await ensure_reuniones_menu(store)');
		const devoluciones = src.indexOf('await ensure_devoluciones_access(store)');
		const subjects = src.indexOf('await ensure_installed_subject_menus(');
		expect(reuniones).toBeGreaterThan(-1);
		expect(devoluciones).toBeGreaterThan(reuniones);
		expect(subjects).toBeGreaterThan(devoluciones);
		const between = src.slice(reuniones, subjects);
		expect(between).toContain('try {');
		expect(between).toContain('console.warn');
		expect(between).toContain('No se pudieron sembrar los permisos de Devoluciones');
	});
});
