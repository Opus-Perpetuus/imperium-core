import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { handle_action } from './actions.ts';
import { read_imperium_body } from './body.ts';
import { record_document_history, run_with_history_context } from './history.ts';
import {
	decode_html_entities,
	flush_support_ticket,
	queue_support_comment,
	queue_support_update,
	receive_support_comment,
	run_support_sync_pass,
	support_initial_state,
	valid_support_signature,
} from './support-bridge.ts';
import { create_error_ticket, tickets_public_metadata } from './tickets-flow.ts';

const KEY = 'llave-de-prueba';
// Salida de build_notice_payload + notice_request de imperium_ticket_bridge
// (services/ticket_contract.py): los mismos bytes y la misma firma que manda Odoo.
const NOTICE_RAW =
	'{"client_ref":"tk-1","message_id":"5231","related_ticket_id":"92","sender":"Rafael Ramírez","text":"Ya quedó, revisa ✔ &amp; confirma","title":"Error al imprimir ticket"}';
const NOTICE_SIGN = '59b62a1582bd5a8403820d852ef853dcbf171e16a06622ed6c8942f69c183d45';
const CREATE_URL = `http://odoo.test/imperium/api/v1/support-tickets?tksupport=${KEY}`;

type Row = ImperiumDoc;
type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function memory_store(seed: Record<string, Row[]>) {
	const data: Record<string, Row[]> = {};
	for (const [key, rows] of Object.entries(seed)) data[key] = rows.map((row) => structuredClone(row));
	const matches = (row: Row, where?: Record<string, unknown>) =>
		!where || Object.entries(where).every(([key, value]) => row[key] === value);
	const store = {
		data,
		all_locs: Object.keys(data).map((resource) => ({
			resource,
			collection: resource,
			name: resource,
			table: resource,
		})),
		has(resource: string) {
			return Object.hasOwn(data, resource);
		},
		loc(resource: string) {
			return { resource, collection: resource, name: resource };
		},
		async find_id(resource: string, id: string) {
			const row = (data[resource] ?? []).find((item) => String(item._id) === String(id));
			return row ? structuredClone(row) : null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			const row = (data[resource] ?? []).find((item) => matches(item, where));
			return row ? structuredClone(row) : null;
		},
		async *scan(resource: string, opts: { where?: Record<string, unknown> } = {}) {
			yield (data[resource] ?? []).filter((row) => matches(row, opts.where)).map((row) => structuredClone(row));
		},
		async insert(resource: string, doc: Row) {
			const row = { ...structuredClone(doc), _id: doc._id ?? `id-${crypto.randomUUID()}` };
			(data[resource] ??= []).push(row);
			return structuredClone(row);
		},
		// Como el store real: cada update deja rastro en el historial si hay contexto de petición.
		async update(resource: string, id: string, patch: Row) {
			const rows = data[resource] ?? [];
			const index = rows.findIndex((row) => String(row._id) === String(id));
			if (index < 0) return null;
			const before = structuredClone(rows[index]!);
			rows[index] = { ...rows[index], ...structuredClone(patch), _id: id };
			await record_document_history(store as never, resource, before, rows[index]!);
			return structuredClone(rows[index]!);
		},
	};
	return store as unknown as ImperiumStore & { data: Record<string, Row[]> };
}

function linked_ticket(extra: Row = {}): Row {
	return {
		_id: 'tk-1',
		title: 'Error al imprimir ticket',
		description: 'La impresora no responde.',
		status: 'open',
		sourceType: 'error',
		reporter: { userId: 'u-rep', name: 'Ana', email: 'ana@ejemplo.mx' },
		assignedUserId: 'u-asg',
		interinstance: { ...support_initial_state(), externalTicketId: '92', forwarded: true },
		support_sync: 'synced',
		...extra,
	};
}

function comment_row(): Row {
	return {
		_id: 'h-1',
		entryType: 'comment',
		comment: '¿Ya quedó?',
		documentId: 'tk-1',
		actor: { _id: 'u-rep', name: 'Ana', email: 'ana@ejemplo.mx' },
	};
}

async function notice(raw = NOTICE_RAW, sign = NOTICE_SIGN) {
	const url = new URL('http://instancia.test/api/tickets/bridge/comment');
	const req = new Request(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Imperium-Sign': sign },
		body: raw,
	});
	return { req, url, body: await read_imperium_body(req) };
}

function sign(raw: string) {
	return createHmac('sha256', KEY).update(raw, 'utf8').digest('hex');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

let calls: Call[] = [];
let responder: (call: Call) => Response | Promise<Response>;
const real_fetch = globalThis.fetch;

function odoo_ok(call: Call): Response {
	if (call.url === CREATE_URL) {
		return Response.json({
			ok: true,
			id: '92',
			data: [{ _id: '92' }],
			total_elementos: 1,
			message: 'Ticket recibido.',
			client_ref: call.body.client_ref,
		});
	}
	return Response.json({ ok: true, id: '7' });
}

beforeEach(() => {
	calls = [];
	responder = odoo_ok;
	process.env.TKSUPPORT = KEY;
	process.env.TKSUPPORT_URL = 'http://odoo.test';
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			body: JSON.parse(String(init?.body ?? '{}')),
			headers: { ...(init?.headers as Record<string, string>) },
		};
		calls.push(call);
		return responder(call);
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = real_fetch;
	delete process.env.TKSUPPORT;
	delete process.env.TKSUPPORT_URL;
});

describe('firma del aviso de Odoo', () => {
	test('acepta los bytes exactos que firma ticket_contract.py', () => {
		expect(valid_support_signature(KEY, NOTICE_RAW, NOTICE_SIGN)).toBe(true);
	});

	test('rechaza un cuerpo re-serializado, otra llave o una firma mal formada', () => {
		const reserialized = JSON.stringify(JSON.parse(NOTICE_RAW), null, 1);
		expect(valid_support_signature(KEY, reserialized, NOTICE_SIGN)).toBe(false);
		expect(valid_support_signature('otra-llave', NOTICE_RAW, NOTICE_SIGN)).toBe(false);
		expect(valid_support_signature(KEY, NOTICE_RAW, 'zz')).toBe(false);
		expect(valid_support_signature(KEY, NOTICE_RAW, null)).toBe(false);
	});

	test('las entidades que deja Odoo se leen como texto', () => {
		expect(decode_html_entities('a &amp; b &lt;c&gt; &#x2714; &#10004; &bogus; &#0;')).toBe(
			'a & b <c> ✔ ✔ &bogus; &#0;',
		);
	});
});

describe('receive_support_comment', () => {
	test('la respuesta de soporte entra al historial del ticket y avisa a quien reportó y a quien lo tiene', async () => {
		const store = memory_store({
			tickets: [linked_ticket()],
			'document-change-history': [],
			notifications: [],
		});
		const res = await receive_support_comment({ store, ...(await notice()) });
		expect(res.status).toBe(200);
		const comments = store.data['document-change-history']!.filter((row) => row.entryType === 'comment');
		expect(comments).toHaveLength(1);
		expect(comments[0]).toMatchObject({
			documentId: 'tk-1',
			comment: 'Ya quedó, revisa ✔ & confirma',
			support_message_id: '5231',
			actor: { name: 'Rafael Ramírez (soporte)' },
		});
		expect(store.data.notifications!.map((row) => row.recipientId).sort()).toEqual(['u-asg', 'u-rep']);

		// Odoo reintenta si no vio la respuesta a tiempo: el mismo aviso no se duplica.
		const again = await receive_support_comment({ store, ...(await notice()) });
		expect(again.status).toBe(200);
		expect(store.data['document-change-history']!.filter((row) => row.entryType === 'comment')).toHaveLength(1);
		expect(store.data.notifications).toHaveLength(2);
	});

	test('firma inválida 401, ticket ajeno 422 y sin llave 404 (Odoo reintenta en 6 h)', async () => {
		const store = memory_store({ tickets: [linked_ticket()], 'document-change-history': [], notifications: [] });
		expect((await receive_support_comment({ store, ...(await notice(NOTICE_RAW, 'a'.repeat(64))) })).status).toBe(401);

		const other = memory_store({
			tickets: [linked_ticket({ interinstance: { ...support_initial_state(), externalTicketId: '93' } })],
			'document-change-history': [],
		});
		expect((await receive_support_comment({ store: other, ...(await notice()) })).status).toBe(422);

		const empty = memory_store({ tickets: [], 'document-change-history': [] });
		expect((await receive_support_comment({ store: empty, ...(await notice()) })).status).toBe(422);

		delete process.env.TKSUPPORT;
		expect((await receive_support_comment({ store, ...(await notice()) })).status).toBe(404);
		expect(store.data['document-change-history']).toHaveLength(0);
	});

	test('un aviso con status cambia el estatus del ticket sin comentario vacío', async () => {
		const store = memory_store({ tickets: [linked_ticket()], 'document-change-history': [], notifications: [] });
		const raw = JSON.stringify({
			client_ref: 'tk-1',
			message_id: '5300',
			related_ticket_id: '92',
			sender: 'Soporte',
			status: 'resolved',
			text: '',
		});
		const res = await receive_support_comment({ store, ...(await notice(raw, sign(raw))) });
		expect(res.status).toBe(200);
		expect(store.data.tickets![0]).toMatchObject({ status: 'resolved', estado: 'resolved' });
		expect(store.data['document-change-history']!.filter((row) => row.entryType === 'comment')).toHaveLength(0);
		expect(store.data.notifications).toHaveLength(0);
	});
});

describe('envío a Odoo', () => {
	test('el alta manda client_ref y reporter en texto, y la llave no se guarda', async () => {
		const store = memory_store({
			tickets: [
				linked_ticket({
					interinstance: support_initial_state(),
					support_sync: 'pending',
					instanceData: { version: '13.56.0', log: 'TypeError: x', url: 'https://instancia.test/pos' },
				}),
			],
		});
		expect(await flush_support_ticket(store, 'tk-1')).toBe('done');
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(CREATE_URL);
		expect(calls[0]!.headers['Idempotency-Key']).toBe('tk-1');
		expect(calls[0]!.body).toMatchObject({
			client_ref: 'tk-1',
			title: 'Error al imprimir ticket',
			source_type: 'error',
			reporter: 'Ana <ana@ejemplo.mx>',
			instance_url: 'https://instancia.test/pos',
		});
		expect(String(calls[0]!.body.description)).toContain('Versión: 13.56.0');
		expect(String(calls[0]!.body.description)).toContain('TypeError: x');
		const saved = store.data.tickets![0]!;
		expect(saved.support_sync).toBe('synced');
		expect(saved.interinstance).toMatchObject({
			target: 'odoo',
			externalTicketId: '92',
			forwarded: true,
			responseStatus: 200,
		});
		expect(JSON.stringify(saved)).not.toContain(KEY);
	});

	test('un 404 del alta corta la pasada: cada llave mala suma al bloqueo por IP de Odoo', async () => {
		responder = () => new Response('', { status: 404 });
		const pending = { interinstance: support_initial_state(), support_sync: 'pending' };
		const store = memory_store({
			tickets: [linked_ticket({ ...pending }), linked_ticket({ _id: 'tk-2', ...pending })],
		});
		await run_support_sync_pass(store);
		expect(calls).toHaveLength(1);
		expect(store.data.tickets!.map((row) => row.support_sync)).toEqual(['pending', 'pending']);
	});

	test('un 400 del alta deja el ticket rechazado y ya no se reintenta', async () => {
		responder = () => Response.json({ ok: false, error: 'missing_description' }, { status: 400 });
		const store = memory_store({
			tickets: [linked_ticket({ interinstance: support_initial_state(), support_sync: 'pending' })],
		});
		await flush_support_ticket(store, 'tk-1');
		expect(store.data.tickets![0]).toMatchObject({
			support_sync: 'failed',
			interinstance: { rejected: 'missing_description', responseStatus: 400 },
		});
		await run_support_sync_pass(store);
		expect(calls).toHaveLength(1);
	});

	test('un error de red no deja la llave en el mensaje guardado', async () => {
		responder = () => {
			throw new Error(`Unable to connect: ${CREATE_URL}`);
		};
		const store = memory_store({
			tickets: [linked_ticket({ interinstance: support_initial_state(), support_sync: 'pending' })],
		});
		expect(await flush_support_ticket(store, 'tk-1')).toBe('retry');
		const saved = store.data.tickets![0]!;
		expect(saved.support_sync).toBe('pending');
		expect(String(as_state(saved).responseMessage)).toContain('tksupport=');
		expect(JSON.stringify(saved)).not.toContain(KEY);
	});

	test('responder desde la instancia: el comentario espera hasta que Odoo tenga la ruta', async () => {
		responder = (call) => (call.url.includes('/92/comment') ? new Response('', { status: 404 }) : odoo_ok(call));
		const store = memory_store({ tickets: [linked_ticket()], 'document-change-history': [comment_row()] });
		await queue_support_comment(store, 'tk-1', 'h-1');
		await settle();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(`http://odoo.test/imperium/api/v1/support-tickets/92/comment?tksupport=${KEY}`);
		expect(calls[0]!.headers['Idempotency-Key']).toBe('h-1');
		expect(calls[0]!.body).toEqual({
			client_ref: 'tk-1',
			message_ref: 'h-1',
			text: '¿Ya quedó?',
			author: 'Ana <ana@ejemplo.mx>',
		});
		expect(store.data.tickets![0]).toMatchObject({
			support_sync: 'pending',
			interinstance: { pendingComments: ['h-1'] },
		});

		responder = odoo_ok;
		await run_support_sync_pass(store);
		expect(store.data.tickets![0]).toMatchObject({
			support_sync: 'synced',
			interinstance: { pendingComments: [] },
		});
	});

	test('un comentario del panel de historial del ticket sale a Odoo', async () => {
		const store = Object.assign(memory_store({ tickets: [linked_ticket()], 'document-change-history': [] }), {
			available_mongoose_models: () => [],
			is_model_installed: () => true,
		});
		// Lo que manda el panel: collection_name = base del servicio, model_name = module_info.model_id.
		const req = new Request('http://instancia.test/api/document-change-history/comment', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				document_id: 'tk-1',
				collection_name: 'tickets',
				model_name: 'Ticket',
				comment_text: 'Sigue sin imprimir',
			}),
		});
		const admin = { _id: 'u-adm', _ref: 'user-menu-management-0', name: 'Admin', email: 'admin@ejemplo.mx' };
		await handle_action(store, null as never, req, new URL(req.url), 'document-change-history', 'create_comment', {}, admin);
		await settle();
		expect(calls.map((call) => call.url)).toEqual([
			`http://odoo.test/imperium/api/v1/support-tickets/92/comment?tksupport=${KEY}`,
		]);
		expect(calls[0]!.body).toMatchObject({ client_ref: 'tk-1', text: 'Sigue sin imprimir' });
	});

	test('modificar desde la instancia manda solo lo que cambió', async () => {
		const store = memory_store({ tickets: [linked_ticket()] });
		const before = linked_ticket();
		await queue_support_update(store, before, { ...before, status: 'closed' }, { name: 'Ana' });
		await settle();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(`http://odoo.test/imperium/api/v1/support-tickets/92/update?tksupport=${KEY}`);
		expect(calls[0]!.body).toMatchObject({ client_ref: 'tk-1', status: 'closed', author: 'Ana' });
		expect(calls[0]!.body).not.toHaveProperty('title');
		expect(calls[0]!.body).not.toHaveProperty('description');
		expect(store.data.tickets![0]!.support_sync).toBe('synced');
		expect(as_state(store.data.tickets![0]!).pendingUpdate).toBeUndefined();
	});

	test('un ticket que no va a soporte no se toca', async () => {
		const store = memory_store({
			tickets: [linked_ticket({ interinstance: { forwarded: false }, support_sync: undefined })],
			'document-change-history': [comment_row()],
		});
		await queue_support_comment(store, 'tk-1', 'h-1');
		await settle();
		expect(calls).toHaveLength(0);
		expect(store.data.tickets![0]!.interinstance).toEqual({ forwarded: false });
	});

	test('las marcas de sincronización no salen como cambios en el historial del ticket', async () => {
		const store = memory_store({ tickets: [linked_ticket()], 'document-change-history': [comment_row()] });
		await run_with_history_context({ actor: { _id: 'u-rep', name: 'Ana' } }, async () => {
			await queue_support_comment(store, 'tk-1', 'h-1');
		});
		await settle();
		expect(calls).toHaveLength(1);
		const changes = () => store.data['document-change-history']!.filter((row) => row.entryType === 'change');
		expect(changes()).toHaveLength(0);

		await run_with_history_context({ actor: { _id: 'u-rep', name: 'Ana' } }, async () => {
			await store.update('tickets', 'tk-1', { status: 'closed' });
		});
		expect(changes()).toHaveLength(1);
	});
});

describe('interinstancia de tickets con llave de soporte', () => {
	function error_ctx(store: ImperiumStore) {
		const url = new URL('http://instancia.test/api/tickets/internal/error');
		return {
			store,
			req: new Request(url, { method: 'POST' }),
			url,
			params: {},
			actor: { _id: 'u-rep', name: 'Ana', email: 'ana@ejemplo.mx' },
			body: {
				title: 'Falla al cobrar',
				description: 'El cobro devolvió 500.',
				should_forward_interinstance: true,
				instance_data: { url: 'https://instancia.test/pos', version: '13.56.0' },
			},
		};
	}

	test('un ticket de error para interinstancia se queda aquí y además llega a Odoo', async () => {
		const store = memory_store({ tickets: [], configuration: [], notifications: [] });
		const res = await create_error_ticket(error_ctx(store));
		expect(res.status).toBe(201);
		await settle();
		expect(store.data.tickets).toHaveLength(1);
		const ticket = store.data.tickets![0]!;
		expect(ticket).toMatchObject({
			sourceType: 'error',
			support_sync: 'synced',
			interinstance: { target: 'odoo', externalTicketId: '92', forwarded: true },
		});
		expect(calls[0]!.body.client_ref).toBe(String(ticket._id));
	});

	test('sin llave, la interinstancia de tickets sigue pidiendo su configuración', async () => {
		delete process.env.TKSUPPORT;
		const store = memory_store({ tickets: [], configuration: [] });
		await expect(create_error_ticket(error_ctx(store))).rejects.toThrow('deshabilitada');
		expect(calls).toHaveLength(0);
	});

	test('la metadata dice si hay salida a soporte', async () => {
		const store = memory_store({ configuration: [] });
		const ctx = error_ctx(store);
		const settings = async () =>
			((await tickets_public_metadata(ctx)).data[0] as { settings: Record<string, unknown> }).settings;
		expect((await settings()).support_outbound_ready).toBe(true);
		delete process.env.TKSUPPORT;
		expect((await settings()).support_outbound_ready).toBe(false);
	});
});

function as_state(ticket: Row): Record<string, unknown> {
	return (ticket.interinstance ?? {}) as Record<string, unknown>;
}
