import { beforeEach, describe, expect, test } from 'bun:test';
import { handle_action, type ReindexTrabajo } from './actions.ts';
import { reset_tasks } from './db-admin-tasks.ts';
import type { ImperiumDoc } from './envelope.ts';
import { TRACKER_RESOURCE } from './postgres-table-tracker.ts';
import { search_field_for_reindex, search_index_text, search_text_from_doc } from './search-engine.ts';
import { ImperiumStore, type ModuleLoc } from './store.ts';

// #268 (Lupo, kyostenas): cada «Reindexar todo» reescribía ~265 mil filas de debug_log,
// cambiaba su updated_at y hacía crecer search_field (el texto anterior entraba otra vez).
// Dos corridas seguidas sin cambios: la segunda debe dejar 0 filas y updated_at intacto.
const ADMIN = { _id: 'admin', _ref: 'user-menu-management-0' };
const MODELS: Record<string, string> = { DebugLog: 'debug-log', Pedidos: 'pedidos', Product: 'products' };
const VIEJO = '2025-01-02T03:04:05.000Z';

type Body = { data: ReindexTrabajo[]; message: string };

/** Store en memoria con la semántica de ImperiumStore: update() reescribe updated_at. */
function memory_store() {
	const data: Record<string, ImperiumDoc[]> = {
		'debug-log': [
			{
				_id: 'log-1',
				name: 'GET /tickets/public/metadata',
				level: 'info',
				search_field: 'info get /tickets/public/metadata 200',
				created_at: VIEJO,
				updated_at: VIEJO,
				payload: { request_label: 'GET', process: { pid: 1 } },
			},
		],
		pedidos: [
			{
				_id: 'ped-1',
				name: 'PED-1',
				observaciones: 'entregar temprano',
				search_field: 'ALVAREZ GONZALEZ MARIA\nentregar temprano',
				created_at: VIEJO,
				updated_at: VIEJO,
			},
		],
		products: [{ _id: 'prod-1', name: 'Codo PVC', description: 'Codo de 90°', created_at: VIEJO, updated_at: VIEJO }],
	};
	const writes: string[] = [];
	const store = {
		data,
		writes,
		has: () => true,
		loc: (resource: string) => ({ resource, collection: resource }) as unknown as ModuleLoc,
		resource_for_model: (model: string) => MODELS[model] ?? null,
		is_model_installed: () => true,
		async *scan(resource: string): AsyncGenerator<ImperiumDoc[]> {
			if (resource === 'module-management') {
				yield Object.keys(MODELS).map((model_id) => ({ _id: model_id, model_id }));
				return;
			}
			yield structuredClone(data[resource] ?? []);
		},
		async update(resource: string, id: string, patch: ImperiumDoc) {
			const row = data[resource]!.find((r) => r._id === id)!;
			Object.assign(row, patch, { updated_at: new Date().toISOString() });
			writes.push(`${resource}/${id}`);
			return row;
		},
		async set_search_fields(resource: string, rows: Array<{ id: string; search_field: string }>) {
			let changed = 0;
			for (const { id, search_field } of rows) {
				const row = data[resource]!.find((r) => r._id === id)!;
				if (row.search_field === search_field) continue; // IS DISTINCT FROM
				row.search_field = search_field;
				writes.push(`${resource}/${id}`);
				changed += 1;
			}
			return changed;
		},
	};
	return store;
}

async function call(store: unknown, action: string, path: string, method: string) {
	const url = new URL(`http://core/api/postgres-table-tracker/${path}`);
	const req = new Request(url, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
	const res = await handle_action(store as ImperiumStore, {} as Bun.SQL, req, url, TRACKER_RESOURCE, action, {}, ADMIN);
	return (await res.json()) as Body;
}

async function reindexar_todo(store: unknown): Promise<ReindexTrabajo> {
	const started = (await call(store, 'trigger_reindex', 'reindex', 'POST')).data[0]!;
	for (let i = 0; i < 200; i++) {
		const job = (await call(store, 'get_reindex_status', `reindex/estado?id=${started.id}`, 'GET')).data[0]!;
		if (job.estado !== 'en_curso') return job;
		await Bun.sleep(5);
	}
	throw new Error('el reindexado no terminó');
}

describe('«Reindexar todo» idempotente (#268)', () => {
	beforeEach(() => reset_tasks());

	test('dos corridas seguidas: la segunda no cambia filas, updated_at intacto y search_field no crece', async () => {
		const store = memory_store();
		const primera = await reindexar_todo(store);
		expect(primera.estado).toBe('terminado');
		const tras_primera = structuredClone(store.data);
		const escrituras = store.writes.length;

		const segunda = await reindexar_todo(store);
		expect(segunda.estado).toBe('terminado');
		expect(segunda.filas_actualizadas).toBe(0);
		expect(store.writes.length).toBe(escrituras);
		expect(store.data).toEqual(tras_primera);
		// El reindexado nunca toca updated_at.
		for (const rows of Object.values(store.data)) {
			for (const row of rows) expect(row.updated_at).toBe(VIEJO);
		}
	});

	test('conserva el search_field del dominio y no repite el nombre', async () => {
		const store = memory_store();
		await reindexar_todo(store);
		await reindexar_todo(store);
		const pedido = String(store.data.pedidos![0]!.search_field);
		expect(pedido.startsWith('ALVAREZ GONZALEZ MARIA\nentregar temprano')).toBe(true);
		expect(pedido).toContain('PED-1');
		const log = String(store.data['debug-log']![0]!.search_field);
		expect(log.split('/tickets/public/metadata').length - 1).toBe(1);
		expect(log).not.toContain(VIEJO);
	});
});

describe('Texto de búsqueda sin su search_field ni campos técnicos (#268)', () => {
	const doc: ImperiumDoc = {
		_id: 'x',
		name: 'Codo',
		search_field: 'texto viejo Codo',
		updated_at: VIEJO,
		created_at: VIEJO,
		payload: { color: 'rojo', updated_at: VIEJO },
	};

	test('search_text_from_doc no mete search_field ni updated_at/created_at', () => {
		expect(search_text_from_doc(doc)).toBe('Codo rojo');
	});

	test('search_field_for_reindex es idempotente y no duplica palabras (sin importar mayúsculas)', () => {
		const once = search_field_for_reindex(doc);
		expect(once).toBe('texto viejo Codo rojo');
		expect(search_field_for_reindex({ ...doc, search_field: once })).toBe(once);
		expect(search_field_for_reindex({ name: 'GET /x', search_field: 'get /x' })).toBe('get /x');
	});

	test('el documento de Meilisearch lleva el texto del dominio una sola vez', () => {
		const text = search_index_text({ name: 'PED-1', search_field: 'MARIA' });
		expect(text).toBe('MARIA PED-1');
	});
});

// Con Postgres (DATABASE_URL): el UPDATE real solo escribe lo que cambia y no toca updated_at.
const PG = process.env.REINDEX_TEST_DATABASE_URL;
describe.skipIf(!PG)('ImperiumStore.set_search_fields en Postgres (#268)', () => {
	test('solo cambia las filas distintas y deja updated_at', async () => {
		const sql = new Bun.SQL(PG!);
		const table = `reindex_idem_${process.pid}`;
		try {
			await sql.unsafe(`CREATE TABLE ${table} (id text primary key, search_field text, updated_at text)`);
			await sql.unsafe(`INSERT INTO ${table} VALUES ('a', 'uno', '${VIEJO}'), ('b', NULL, '${VIEJO}')`);
			const fake = { sql, qt: () => table } as unknown as ImperiumStore;
			const set = ImperiumStore.prototype.set_search_fields;
			const rows = [
				{ id: 'a', search_field: 'uno' },
				{ id: 'b', search_field: 'dos' },
			];
			expect(await set.call(fake, 'x', rows)).toBe(1);
			expect(await set.call(fake, 'x', rows)).toBe(0);
			const after = await sql.unsafe(`SELECT id, search_field, updated_at FROM ${table} ORDER BY id`);
			expect(after.map((r: Record<string, string>) => [r.id, r.search_field, r.updated_at])).toEqual([
				['a', 'uno', VIEJO],
				['b', 'dos', VIEJO],
			]);
		} finally {
			await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
			await sql.close();
		}
	});
});
