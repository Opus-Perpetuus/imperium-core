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

const AI_CONFIG: Record<string, string> = {
	'configuration-ai-extraction-provider': 'opencode',
	'configuration-ai-extraction-opencode-endpoint': 'http://ia.simulada',
	'configuration-ai-extraction-opencode-api-key': 'simulada',
};

async function ask_board(steps: unknown[]) {
	const { handle_action } = await import('./actions.ts');
	const { store } = board_store();
	store.find_where = async (_resource: string, where: Record<string, unknown>) => ({
		_id: 'cfg',
		value: AI_CONFIG[String(where.ref)] ?? '',
	});
	const prompts: string[] = [];
	const real_fetch = globalThis.fetch;
	globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		prompts.push(String(init?.body ?? ''));
		const content = JSON.stringify({ answer: 'Listo.', steps });
		return Response.json({ choices: [{ message: { content } }] });
	}) as typeof fetch;
	try {
		const url = new URL('http://nucleo/api/dynamic-dashboard/ai-query');
		const req = new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ question: '¿cuántos productos hay?' }),
		});
		const res = await handle_action(store, null as unknown as Bun.SQL, req, url, 'dynamic-dashboard', 'ai_query', {}, {
			_id: 'a',
			_ref: 'user-menu-management-0',
		});
		const body = (await res.json()) as {
			data: Array<{ answer: string; widgets: Array<{ spec: Record<string, unknown>; result?: { kpi?: { value: number } }; error?: string }> }>;
		};
		return { board: body.data[0]!, prompts };
	} finally {
		globalThis.fetch = real_fetch;
	}
}

describe('tablero: la IA solo arma widgets de la lista blanca', () => {
	test('el widget válido se resuelve y los rechazados se reportan sin tumbar la respuesta', async () => {
		const { board } = await ask_board([
			{ model_id: 'Products', title: 'Productos', widget_type: 'kpi' },
			{ model_id: 'Secretos', title: 'Fuera' },
			{ model_id: 'Products', title: 'Suma', aggregation: { op: 'sum', field: 'campo_inexistente' } },
		]);
		expect(board.widgets).toHaveLength(3);
		const [valid, outside, unknown_field] = board.widgets;
		expect(valid!.result?.kpi?.value).toBe(4);
		expect(valid!.error).toBeUndefined();
		expect(outside!.result).toBeUndefined();
		expect(outside!.error).toContain('Secretos');
		expect(unknown_field!.result).toBeUndefined();
		expect(unknown_field!.error).toContain('campo_inexistente');
	});

	test('registrar un tipo nuevo lo agrega al enum del schema que ve el modelo', async () => {
		const { register_widget_kind } = await import('./widget-kinds.ts');
		register_widget_kind({ widget_type: 'gauge-tablero', family: 'kpi', aggregations: ['count'], max_rows: 10 });
		const { prompts } = await ask_board([]);
		expect(prompts[0]).toContain('gauge-tablero');
		expect(prompts[0]).toContain('chart-pie');
	});
});
