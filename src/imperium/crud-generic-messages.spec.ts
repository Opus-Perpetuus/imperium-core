import { describe, expect, test } from 'bun:test';
import { handle_crud } from './crud.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

type Row = ImperiumDoc;

const ID = '507f1f77bcf86cd799439011';

function memory_store(seed: Record<string, Row[]>): ImperiumStore {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => ({ ...row }));
	let n = 0;
	return {
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		loc() {
			return { columns: [] };
		},
		field_refs() {
			return {};
		},
		async find_id(resource: string, id: string) {
			return (data[resource] ?? []).find((row) => String(row._id) === String(id)) ?? null;
		},
		async populate_docs(_resource: string, docs: ImperiumDoc[]) {
			return docs;
		},
		async insert(resource: string, doc: Row) {
			n += 1;
			const row = {
				...doc,
				_id: doc._id ?? `507f1f77bcf86cd7994${String(n).padStart(5, '0')}`,
			};
			data[resource] = data[resource] ?? [];
			data[resource].push(row);
			return row;
		},
	} as unknown as ImperiumStore;
}

describe('mensajes genéricos de CRUD', () => {
	test('crear un registro sin mensaje propio dice Registro creado', async () => {
		const store = memory_store({ country: [] });
		const req = new Request('http://local/api/country', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'México' }),
		});
		const res = await handle_crud(store, req, new URL(req.url), 'country', '', null);
		const body = await res!.json();
		expect(res!.status).toBe(201);
		expect(body.message).toBe('Registro creado');
	});

	test('leer un registro sin mensaje propio dice Registro encontrado', async () => {
		const store = memory_store({
			country: [{ _id: ID, name: 'México', is_active: true }],
		});
		const req = new Request(`http://local/api/country/${ID}`);
		const res = await handle_crud(store, req, new URL(req.url), 'country', ID, null);
		const body = await res!.json();
		expect(res!.status).toBe(200);
		expect(body.message).toBe('Registro encontrado');
		expect(body.data[0].name).toBe('México');
	});

	test('la orden de compra conserva su mensaje específico', async () => {
		const store = memory_store({
			'purchase-order': [{ _id: ID, name: 'Compra 1', is_active: true }],
		});
		const req = new Request(`http://local/api/purchase-order/${ID}`);
		const res = await handle_crud(store, req, new URL(req.url), 'purchase-order', ID, null);
		const body = await res!.json();
		expect(body.message).toBe('Orden de compra encontrada');
	});
});
