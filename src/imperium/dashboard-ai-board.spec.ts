import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { ImperiumStore, load_catalog_path } from './store.ts';

const BASE = ['subject-configuracion', 'subject-configuraciones-de-vista', 'subject-planeacion'];

function board_store() {
	const store = new ImperiumStore(null as unknown as Bun.SQL, load_catalog_path());
	store.set_installed_subjects([...BASE, 'subject-almacen']);
	const reads: string[] = [];
	store.find_many = async (resource: string) => {
		reads.push(resource);
		if (resource === 'products') return { rows: [{ _id: 'p1', is_active: true }], total: 4 };
		return { rows: [], total: 0 };
	};
	store.scan = async function* () {
		yield [];
	};
	return { store, reads };
}

describe('tablero: la consulta pinta con el permiso del usuario', () => {
	test('el chat del tablero es una acción del núcleo', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		expect(src).toContain("case 'dynamic-dashboard:ai_query':");
		expect(src).toContain('return ok([{ answer, widgets }]');
	});

	test('sin permiso el widget niega y no lee filas', async () => {
		const { resolve_widget_data } = await import('./dashboard-flow.ts');
		const { store, reads } = board_store();
		const res = await resolve_widget_data(store, { _id: 'u1', _ref: 'user-other' }, {
			spec: { widget_type: 'kpi', model_id: 'Products', title: 'Ventas' },
		});
		const payload = res.data[0] as { denied?: boolean; kpi?: unknown; message?: string };
		expect(payload.denied).toBe(true);
		expect(payload.kpi).toBeUndefined();
		expect(payload.message).toBeTruthy();
		expect(reads).not.toContain('products');
	});

	test('con acceso el mismo widget devuelve el número', async () => {
		const { resolve_widget_data } = await import('./dashboard-flow.ts');
		const { store } = board_store();
		const res = await resolve_widget_data(
			store,
			{ _id: 'a', _ref: 'user-menu-management-0' },
			{ spec: { widget_type: 'kpi', model_id: 'Products', title: 'Productos' } },
		);
		const payload = res.data[0] as { denied?: boolean; kpi?: { value: number } };
		expect(payload.denied).toBe(false);
		expect(payload.kpi?.value).toBe(4);
	});

	test('un tipo que el tablero no registra se rechaza', async () => {
		const { resolve_widget_data } = await import('./dashboard-flow.ts');
		const { store } = board_store();
		const err = await resolve_widget_data(
			store,
			{ _id: 'a', _ref: 'user-menu-management-0' },
			{ spec: { widget_type: 'note', model_id: 'Products' } },
		).catch((error: Error) => error);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('note');
	});
});
