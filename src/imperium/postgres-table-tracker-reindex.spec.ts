import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { handle_action, reindex_target, type ReindexTrabajo } from './actions.ts';
import { reset_tasks } from './db-admin-tasks.ts';
import type { ImperiumDoc } from './envelope.ts';
import { TRACKER_RESOURCE } from './postgres-table-tracker.ts';
import { http_deadline_ms, with_deadline } from './sql-client.ts';
import type { ImperiumStore, ModuleLoc } from './store.ts';

// #268: «Reindexar todo» se caía en el primer modelo de una app sin tablas, y
// después moría con 503 http_deadline (30 + 5 s) al reindexar 200+ modelos.
// Ahora corre en segundo plano: POST → 202 con el trabajo; GET /reindex/estado
// → progreso, reindexados, omitidos con su motivo, y si terminó o falló.
const ADMIN = { _id: 'admin', _ref: 'user-menu-management-0' };
const MODELS: Record<string, string> = {
	Product: 'products',
	Employee: 'employees',
	CitizenReport: 'citizen-reports',
	Turn: 'turns',
};

type Body = { data: ReindexTrabajo[]; message: string; error?: string };

function loc(resource: string): ModuleLoc {
	return { resource, collection: resource, slug: 'x', technical_id: 'x', name: resource } as unknown as ModuleLoc;
}

function missing_table(resource: string) {
	return Object.assign(new Error(`relation "subject_x.${resource}" does not exist`), {
		code: 'ERR_POSTGRES_SERVER_ERROR',
		errno: '42P01',
	});
}

/**
 * CitizenReport: app no instalada. Employee: instalada pero sin tabla.
 * `delay_ms` hace que cada tabla tarde, para pasar del plazo HTTP.
 */
function store_with_apps_sin_tablas(updates: string[], delay_ms = 0) {
	return {
		has: () => true,
		loc,
		resource_for_model: (model: string) => MODELS[model] ?? null,
		is_model_installed: (model: string) => model !== 'CitizenReport',
		async *scan(resource: string): AsyncGenerator<ImperiumDoc[]> {
			if (resource === 'module-management') {
				yield Object.keys(MODELS).map((model_id) => ({ _id: model_id, model_id }));
				return;
			}
			if (delay_ms) await Bun.sleep(delay_ms);
			if (resource === 'citizen-reports' || resource === 'employees') throw missing_table(resource);
			yield [{ _id: `${resource}-1`, name: `Registro de ${resource}` }];
		},
		async set_search_fields(resource: string, rows: Array<{ id: string }>) {
			for (const row of rows) updates.push(`${resource}/${row.id}`);
			return rows.length;
		},
	} as unknown as ImperiumStore;
}

async function reindex(store: ImperiumStore, model_name?: string) {
	const url = new URL(`http://core/api/postgres-table-tracker/reindex${model_name ? `/${model_name}` : ''}`);
	const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const res = await handle_action(store, {} as Bun.SQL, req, url, TRACKER_RESOURCE, 'trigger_reindex', model_name ? { model_name } : {}, ADMIN);
	return { status: res.status, body: (await res.json()) as Body };
}

async function estado(store: ImperiumStore, id = '') {
	const url = new URL(`http://core/api/postgres-table-tracker/reindex/estado${id ? `?id=${id}` : ''}`);
	const req = new Request(url, { method: 'GET' });
	const res = await handle_action(store, {} as Bun.SQL, req, url, TRACKER_RESOURCE, 'get_reindex_status', {}, ADMIN);
	return { status: res.status, body: (await res.json()) as Body };
}

/** Lo que hace el modal: consultar el estado hasta que deje de estar en curso. */
async function hasta_que_termine(store: ImperiumStore, id: string): Promise<ReindexTrabajo> {
	for (let i = 0; i < 200; i++) {
		const { body } = await estado(store, id);
		const job = body.data[0]!;
		if (job.estado !== 'en_curso') return job;
		await Bun.sleep(10);
	}
	throw new Error('el reindexado no terminó');
}

describe('Reindexar todo en segundo plano (#268)', () => {
	const deadline_env = process.env.CORE_HTTP_DEADLINE_MS;
	beforeEach(() => reset_tasks());
	afterEach(() => {
		if (deadline_env === undefined) delete process.env.CORE_HTTP_DEADLINE_MS;
		else process.env.CORE_HTTP_DEADLINE_MS = deadline_env;
	});

	test('aunque el trabajo tarde más que el plazo HTTP, el POST contesta 202 a tiempo y el estado llega al final', async () => {
		process.env.CORE_HTTP_DEADLINE_MS = '100';
		const updates: string[] = [];
		// 3 tablas × 80 ms = 240 ms > 100 ms de plazo.
		const store = store_with_apps_sin_tablas(updates, 80);
		const { status, body } = await with_deadline(reindex(store), http_deadline_ms());
		expect(status).toBe(202);
		const started = body.data[0]!;
		expect(started).toMatchObject({ estado: 'en_curso', modelo: null, total: 4, reindexados: [], omitidos: [] });
		expect(started.id).toBeTruthy();

		const job = await hasta_que_termine(store, started.id);
		expect(job.estado).toBe('terminado');
		expect(job.procesados).toBe(4);
		expect(job.reindexados).toEqual(['Product', 'Turn']);
		expect(job.omitidos).toEqual([
			{ model: 'Employee', motivo: 'sin_tabla' },
			{ model: 'CitizenReport', motivo: 'app_no_instalada' },
		]);
		expect(job.terminado).toBeTruthy();
		const final = await estado(store);
		expect(final.body.message).toContain('2 reindexado(s)');
		expect(final.body.message).toContain('2 omitido(s)');
		// Sin buscador externo, los modelos con tabla sí se reindexan (search_field).
		expect(updates).toEqual(['products/products-1', 'turns/turns-1']);
	});

	test('no se pueden lanzar dos a la vez: el segundo recibe 409 con el que ya corre', async () => {
		const store = store_with_apps_sin_tablas([], 30);
		const first = await reindex(store);
		expect(first.status).toBe(202);
		const second = await reindex(store);
		expect(second.status).toBe(409);
		expect(second.body.error).toBe('reindex_en_curso');
		expect(second.body.data[0]?.id).toBe(first.body.data[0]!.id);
		expect(await reindex(store, 'Product').then((r) => r.status)).toBe(409);
		await hasta_que_termine(store, first.body.data[0]!.id);
		expect((await reindex(store)).status).toBe(202);
	});

	test('reindexar un solo modelo sin tabla termina con el omitido', async () => {
		const store = store_with_apps_sin_tablas([]);
		const { status, body } = await reindex(store, 'Employee');
		expect(status).toBe(202);
		const job = await hasta_que_termine(store, body.data[0]!.id);
		expect(job).toMatchObject({
			estado: 'terminado',
			modelo: 'Employee',
			total: 1,
			reindexados: [],
			omitidos: [{ model: 'Employee', motivo: 'sin_tabla' }],
		});
	});

	test('un error que no es de tabla faltante deja el trabajo fallido, con su error', async () => {
		const store = store_with_apps_sin_tablas([]);
		(store as unknown as { scan: unknown }).scan = async function* (resource: string) {
			if (resource === 'module-management') {
				yield [{ _id: 'Product', model_id: 'Product' }];
				return;
			}
			throw new Error('conexión perdida');
		};
		const { status, body } = await reindex(store);
		expect(status).toBe(202);
		const job = await hasta_que_termine(store, body.data[0]!.id);
		expect(job.estado).toBe('fallido');
		expect(job.error).toBe('conexión perdida');
		expect((await estado(store)).body.message).toContain('falló');
	});

	test('el estado de un trabajo que ya no existe es 404; sin trabajos, lista vacía', async () => {
		const store = store_with_apps_sin_tablas([]);
		expect((await estado(store)).body.data).toEqual([]);
		expect((await estado(store, 'search-reindex-viejo')).status).toBe(404);
	});

	test('la ruta de estado existe y es GET (pide leer el rastreador, no solo sesión)', () => {
		const routes = JSON.parse(readFileSync(new URL('./extra-routes.json', import.meta.url), 'utf8')) as Array<
			Record<string, string>
		>;
		expect(routes).toContainEqual({
			resource: 'postgres-table-tracker',
			method: 'get',
			path: '/reindex/estado',
			action: 'get_reindex_status',
		});
		const auth = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
		expect(auth).not.toContain("'postgres-table-tracker:get_reindex_status'");
	});
});

describe('Reindexar todo: cada modelo procesado queda reindexado u omitido con motivo (#268)', () => {
	beforeEach(() => reset_tasks());

	// Como en kyostenas: 148 procesados, 129 reindexados y 0 omitidos; los 19
	// sin recurso en el catálogo o del chat no salían en ninguna lista.
	function store_con_modelos_sin_recurso() {
		const recursos: Record<string, string> = { ...MODELS, Message: 'messages' };
		const base = store_with_apps_sin_tablas([]);
		return Object.assign(base, {
			resource_for_model: (model: string) => recursos[model] ?? null,
			has: (resource: string) => resource !== 'model-tracker-custom',
			async *scan(resource: string): AsyncGenerator<ImperiumDoc[]> {
				if (resource === 'module-management') {
					yield [
						...Object.keys(MODELS).map((model_id) => ({ _id: model_id, model_id })),
						{ _id: 'sin-id', model_id: '' },
						{ _id: 'planeacion', model_id: 'Planeacion' },
						{ _id: 'mensajes', model_id: 'Message' },
					];
					return;
				}
				if (resource === 'citizen-reports' || resource === 'employees') throw missing_table(resource);
				yield [{ _id: `${resource}-1`, name: `Registro de ${resource}` }];
			},
		}) as unknown as ImperiumStore;
	}

	test('los modelos sin model_id, sin recurso o del chat cuentan como omitidos con su motivo', async () => {
		const store = store_con_modelos_sin_recurso();
		const { body } = await reindex(store);
		const job = await hasta_que_termine(store, body.data[0]!.id);
		expect(job.estado).toBe('terminado');
		expect(job.procesados).toBe(7);
		expect(job.reindexados).toEqual(['Product', 'Turn']);
		expect(job.omitidos).toEqual([
			{ model: 'Employee', motivo: 'sin_tabla' },
			{ model: 'CitizenReport', motivo: 'app_no_instalada' },
			{ model: '(sin model_id)', motivo: 'sin_model_id' },
			{ model: 'Planeacion', motivo: 'sin_recurso' },
			{ model: 'Message', motivo: 'chat_privado' },
		]);
		// Invariante: reindexados + omitidos = procesados.
		expect(job.reindexados.length + job.omitidos.length).toBe(job.procesados);
		const final = await estado(store, job.id);
		expect(final.body.message).toContain('2 reindexado(s)');
		expect(final.body.message).toContain('5 omitido(s)');
		expect(final.body.message).toContain('1 sin tabla en el catálogo');
		expect(final.body.message).toContain('1 privado del chat');
	});

	test('reindexar un modelo que el catálogo no conoce también lo reporta omitido', async () => {
		const store = store_con_modelos_sin_recurso();
		const { body } = await reindex(store, 'Planeacion');
		const job = await hasta_que_termine(store, body.data[0]!.id);
		expect(job).toMatchObject({
			total: 1,
			procesados: 1,
			reindexados: [],
			omitidos: [{ model: 'Planeacion', motivo: 'sin_recurso' }],
		});
	});

	test('reindex_target da el motivo sin tocar la BD', () => {
		const store = {
			resource_for_model: (model: string) => ({ Message: 'messages', Product: 'products' })[model] ?? null,
			has: () => true,
			is_model_installed: () => true,
		};
		expect(reindex_target(store, '')).toEqual({ motivo: 'sin_model_id' });
		expect(reindex_target(store, 'Planeacion')).toEqual({ motivo: 'sin_recurso' });
		expect(reindex_target(store, 'Message')).toEqual({ motivo: 'chat_privado' });
		expect(reindex_target(store, 'Product')).toEqual({ resource: 'products' });
	});
});
