import { describe, expect, test } from 'bun:test';
import { record_document_history } from './history.ts';
import { crud_write } from './mcp-agent.ts';

type Call = { method: string; path: string; rest: string; body: unknown };

function fake_crud(response: () => Response) {
	const calls: Call[] = [];
	const history: Array<Record<string, unknown>> = [];
	const store = {
		has: (name: string) => name === 'document-change-history',
		insert: async (_name: string, row: Record<string, unknown>) => {
			history.push(row);
			return { ...row, _id: 'h1' };
		},
		find_many: async () => ({ rows: [], total: 0 }),
	};
	const handle = (async (_s: unknown, req: Request, url: URL, resource: string, rest: string) => {
		calls.push({ method: req.method, path: url.pathname, rest, body: await req.json() });
		await record_document_history(store as never, resource, null, { _id: 'r1', name: 'Fuga' }).catch(
			() => null,
		);
		return response();
	}) as never;
	return { calls, history, handle };
}

const user = { _id: 'u-token', name: 'Agente', email: 'agente@local' };

describe('escrituras del agente MCP', () => {
	test('crear pasa por el POST del CRUD y el historial lleva al usuario del token', async () => {
		const crud = fake_crud(() => Response.json({ data: [{ _id: 'r1', folio: 'INT-000001' }] }));
		const doc = await crud_write({} as never, user, 'registro-emergencias', 'POST', '', { name: 'Fuga' }, crud.handle);
		expect(doc).toEqual({ _id: 'r1', folio: 'INT-000001' });
		expect(crud.calls).toEqual([
			{ method: 'POST', path: '/registro-emergencias', rest: '/', body: { name: 'Fuga' } },
		]);
		expect(crud.history[0]).toMatchObject({
			documentId: 'r1',
			actor: { _id: 'u-token', name: 'Agente' },
			request: { method: 'POST', url: '/registro-emergencias', userAgent: 'mcp-agent' },
		});
	});

	test('editar pasa por el PATCH del CRUD sobre el id', async () => {
		const crud = fake_crud(() => Response.json({ data: [{ _id: 'r1' }] }));
		await crud_write({} as never, user, 'registro-emergencias', 'PATCH', 'r1', { name: 'Fuga mayor' }, crud.handle);
		expect(crud.calls[0]).toMatchObject({ method: 'PATCH', path: '/registro-emergencias/r1', rest: '/r1' });
	});

	test('un rechazo del CRUD llega al agente con su mensaje y su estado', async () => {
		const crud = fake_crud(() => Response.json({ message: 'Falta el campo prioridad' }, { status: 400 }));
		await expect(
			crud_write({} as never, user, 'registro-emergencias', 'POST', '', {}, crud.handle),
		).rejects.toMatchObject({ message: 'Falta el campo prioridad', status: 400 });
	});
});
