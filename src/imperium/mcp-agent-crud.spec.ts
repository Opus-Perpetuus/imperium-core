import { describe, expect, test } from 'bun:test';
import { record_document_history } from './history.ts';
import { apply_schema_validation, crud_write, public_schema_validation } from './mcp-agent.ts';

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

describe('describe_model del agente MCP usa el schema_validation real', () => {
	const base = [
		{ field: 'name', label: 'Name', type: 'string', required: false, is_array: false },
		{ field: 'prioridad', label: 'Prioridad', type: 'string', required: false, is_array: false },
		{ field: 'notas', label: 'Notas', type: 'string', required: false, is_array: false },
	];
	const schema = {
		required: ['prioridad', 'tipo', 'password'],
		properties: {
			prioridad: { type: 'string', 'x-component': 'input-select', enum: ['alta', 'baja'] },
			tipo: { type: 'string', title: 'Tipo de reporte' },
			password: { type: 'string' },
		},
		metadata: { state_fields: { fields: [] } },
	};

	test('los requeridos son los del schema, con componente y enum', () => {
		const fields = apply_schema_validation(base, schema);
		const required = fields.filter((f) => f.required).map((f) => f.field);
		expect(required).toEqual(['prioridad', 'tipo']);
		expect(fields.find((f) => f.field === 'name')?.required).toBe(false);
		expect(fields.find((f) => f.field === 'prioridad')).toMatchObject({
			component: 'input-select',
			enum: ['alta', 'baja'],
		});
		expect(fields.find((f) => f.field === 'tipo')?.label).toBe('Tipo de reporte');
	});

	test('sin schema conserva name como único requerido', () => {
		const fields = apply_schema_validation(base, null);
		expect(fields.filter((f) => f.required).map((f) => f.field)).toEqual(['name']);
	});

	test('el schema que ve el agente no expone campos sensibles', () => {
		const pub = public_schema_validation(schema);
		expect(pub?.required).toEqual(['prioridad', 'tipo']);
		expect(Object.keys(pub?.properties ?? {})).not.toContain('password');
		expect(pub?.state_fields).toEqual({ fields: [] });
	});
});
