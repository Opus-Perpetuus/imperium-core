import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { handle_action } from './actions.ts';
import { assert_target_model_read } from './auth.ts';
import {
	assert_attachment_access,
	CHAT_ATTACHMENT_MODELS,
	chat_can,
	ChatError,
	DIRECT_CONVERSATION_SETTINGS,
	invite_state,
	is_chat_private_resource,
	is_chat_row,
	media_token_actor,
	without_chat_rows,
} from './chat-access.ts';
import { handle_crud } from './crud.ts';
import { resolve_dashboard_catalog, resolve_widget_data } from './dashboard-flow.ts';
import type { ImperiumDoc } from './envelope.ts';
import { handle_mcp_agent } from './mcp-agent.ts';
import { postgres_table_tracker_field_values } from './postgres-table-tracker-field-values.ts';
import { sign_realtime_token } from './realtime-tokens.ts';
import {
	sync_postgres_table_tracker,
	tracker_model_id_for_resource,
	TRACKER_RESOURCE,
} from './postgres-table-tracker.ts';
import { ImperiumStore, load_catalog_path, type ModuleLoc } from './store.ts';

const ADMIN = { _id: 'admin', _ref: 'user-menu-management-0' };
const CHAT_RESOURCES = ['messages', 'notifications', 'mentions', 'chat-conversations', 'chat-members'];

function loc(resource: string): ModuleLoc {
	return { slug: 'configuracion', technical_id: 'subject-configuracion', resource, table: resource, collection: resource, name: resource, columns: [] };
}

/** Lo mínimo que `build_access` pide para el administrador sembrado. */
const admin_store_base = {
	available_mongoose_models: () => [],
	is_model_installed: () => true,
	is_resource_installed: () => true,
};

async function chat_error(promise: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(ChatError);
		const e = err as ChatError;
		return { status: e.status, code: e.code, message: e.message };
	}
	throw new Error('se esperaba un ChatError');
}

describe('recursos privados del chat', () => {
	test('messages, notifications, mentions y todo chat-* son privados; lo demás no', () => {
		for (const resource of CHAT_RESOURCES) expect(is_chat_private_resource(resource)).toBe(true);
		for (const resource of ['user', 'document-change-history', 'attachment-management', 'products']) {
			expect(is_chat_private_resource(resource)).toBe(false);
		}
	});

	test('el CRUD genérico no los atiende: el router responde 404', async () => {
		const url = new URL('http://core/api/messages?limite=10');
		for (const resource of CHAT_RESOURCES) {
			for (const [method, rest] of [['GET', '/'], ['GET', '/abc'], ['GET', '/statistics'], ['GET', '/field-values/message'], ['POST', '/mass-query'], ['PUT', '/abc'], ['DELETE', '/abc']]) {
				const req = new Request(url, { method });
				expect(await handle_crud({} as ImperiumStore, req, url, resource, rest!, ADMIN)).toBeNull();
			}
		}
	});

	test('una acción sin case no parchea un recurso del chat', async () => {
		const patched: string[] = [];
		const store = {
			has: () => true,
			async update(resource: string) {
				patched.push(resource);
				return { _id: 'x' };
			},
		};
		const run = (resource: string) => {
			const url = new URL(`http://core/api/${resource}/x/archivar`);
			const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
			return handle_action(store as unknown as ImperiumStore, {} as Bun.SQL, req, url, resource, 'archivar', { id: 'x' }, ADMIN);
		};
		for (const resource of CHAT_RESOURCES) {
			await expect(run(resource)).rejects.toThrow('Acción no implementada');
		}
		expect(patched).toEqual([]);
		expect((await run('products')).status).toBe(200);
		expect(patched).toEqual(['products']);
	});

	test('reportes e historial: ni el administrador lee un modelo del chat, por recurso o por modelo', async () => {
		const store = {
			...admin_store_base,
			has: (resource: string) => ['messages', 'notifications', 'products'].includes(resource),
			loc,
			resource_for_model: (model: string) => ({ Message: 'messages', Notification: 'notifications' })[model] ?? null,
		} as unknown as ImperiumStore;
		for (const target of ['messages', 'Message', 'notifications', 'Notification']) {
			await expect(assert_target_model_read(store, ADMIN, target)).rejects.toMatchObject({ status: 403 });
		}
		expect(await assert_target_model_read(store, ADMIN, 'products')).toBe('products');
	});

	test('MCP: ningún recurso del chat es operable, se escriba como se escriba', async () => {
		const token = 'isic_prueba-chat';
		const all_locs = ['messages', 'notifications', 'products'].map(loc);
		const store = {
			...admin_store_base,
			all_locs,
			has: (resource: string) =>
				resource === 'mcp-user-token' || all_locs.some((l) => l.resource === resource),
			find_where: async () => ({
				_id: 'token-1',
				user_id: ADMIN._id,
				token_hash: createHash('sha256').update(token).digest('hex'),
				last_used_at: new Date().toISOString(),
			}),
			find_id: async () => ADMIN,
		} as unknown as ImperiumStore;
		for (const model of ['messages', 'MESSAGES', 'notifications']) {
			const url = new URL('http://core/api/mcp-agent/v1/search');
			const req = new Request(url, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ model }),
			});
			const res = await handle_mcp_agent(store, {} as Bun.SQL, req, url);
			expect(res.status).toBe(403);
			expect(((await res.json()) as { error: string }).error).toBe('model_forbidden');
		}
	});

	test('tableros: ni el catálogo los ofrece ni un widget los lee', async () => {
		const locs = new Map(['messages', 'notifications', 'mentions', 'chat-conversations'].map((r) => [r, loc(r)]));
		const store = {
			...admin_store_base,
			locs,
			has: (resource: string) => locs.has(resource),
			resource_for_model: (model: string) => ({ Message: 'messages', Mention: 'mentions' })[model] ?? null,
		} as unknown as ImperiumStore;
		expect((await resolve_dashboard_catalog(store, ADMIN)).data).toEqual([]);
		for (const model_id of ['Message', 'Mention', 'chat-conversations']) {
			await expect(
				resolve_widget_data(store, ADMIN, { spec: { widget_type: 'table', model_id } }),
			).rejects.toThrow(`El modelo '${model_id}' no está disponible.`);
		}
	});

	test('el rastreador no los registra y quita los que ya tenía', async () => {
		const locs = new Map(['messages', 'notifications', 'mentions', 'products'].map((r) => [r, loc(r)]));
		const inserted: ImperiumDoc[] = [];
		const removed: string[] = [];
		const store = {
			locs,
			has: (resource: string) => resource === TRACKER_RESOURCE,
			field_refs: () => ({}),
			async *scan(resource: string) {
				if (resource === TRACKER_RESOURCE) {
					yield [{ _id: 'rastreo-mensajes', __model_name: tracker_model_id_for_resource('messages') }];
				}
			},
			async insert(_resource: string, doc: ImperiumDoc) {
				inserted.push(doc);
				return doc;
			},
			async remove(_resource: string, id: string) {
				removed.push(id);
				return null;
			},
		} as unknown as ImperiumStore;
		await sync_postgres_table_tracker(store);
		expect(inserted.map((doc) => doc.__collection)).toEqual(['products']);
		expect(removed).toEqual(['rastreo-mensajes']);
	});

	test('los valores globales de un campo piden permiso de lectura del modelo', async () => {
		const tracker = { _id: 'rastreo', __model_name: 'Message', __schema_fields: [] };
		const store = {
			...admin_store_base,
			has: (resource: string) => [TRACKER_RESOURCE, 'messages', 'products'].includes(resource),
			loc,
			resource_for_model: (model: string) => ({ Message: 'messages', Product: 'products' })[model] ?? null,
			field_refs: () => ({}),
			find_id: async () => null,
			async find_where(_resource: string, where: Record<string, unknown>) {
				return where.__model_name === 'Message' || where.__model_name === 'Product'
					? { ...tracker, __model_name: where.__model_name }
					: null;
			},
			value_counts: async () => [{ value: 'secreto', count: 1 }],
			async *scan() {},
		} as unknown as ImperiumStore;
		const read = (model: string, actor: ImperiumDoc | null) =>
			postgres_table_tracker_field_values({
				store,
				actor,
				params: { model_tracker_id: model, field_path: 'message' },
				url: new URL(`http://core/api/postgres-table-tracker/global/${model}/field-values/message`),
			});
		await expect(read('Message', ADMIN)).rejects.toMatchObject({ status: 403 });
		await expect(read('Product', { _id: 'sin-permisos', email: 'x@empresa.com' })).rejects.toMatchObject({ status: 403 });
		expect((await read('Product', ADMIN)).data).toHaveLength(1);
	});

	test('la reindexación del buscador se salta los recursos del chat', async () => {
		const scanned: string[] = [];
		const store = {
			has: () => true,
			resource_for_model: (model: string) => ({ Message: 'messages' })[model] ?? null,
			loc,
			async *scan(resource: string) {
				scanned.push(resource);
				if (resource === 'module-management') yield [{ model_id: 'Message' }];
			},
		};
		const url = new URL('http://core/api/postgres-table-tracker/reindex/Message');
		const req = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		const res = await handle_action(store as unknown as ImperiumStore, {} as Bun.SQL, req, url, TRACKER_RESOURCE, 'trigger_reindex', { model_name: 'Message' }, ADMIN);
		expect(res.status).toBe(200);
		expect(scanned).toEqual(['module-management']);
	});
});

describe('motor de búsqueda', () => {
	const requests: string[] = [];
	let meili: ReturnType<typeof Bun.serve>;
	const store = new ImperiumStore({} as Bun.SQL, load_catalog_path());

	beforeAll(() => {
		meili = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				requests.push(`${req.method} ${url.pathname}`);
				if (url.pathname.endsWith('/stats')) return Response.json({ numberOfDocuments: 3 });
				return Response.json({ taskUid: null });
			},
		});
		process.env.MEILI_URL = `http://127.0.0.1:${meili.port}`;
	});

	afterAll(() => {
		delete process.env.MEILI_URL;
		meili.stop(true);
	});

	test('no indexa documentos del chat', async () => {
		requests.length = 0;
		await store.sync_search('messages', { _id: 'm1', message: 'texto privado' });
		await store.sync_search('notifications', { _id: 'n1', message: 'aviso privado' });
		expect(requests).toEqual([]);
		await store.sync_search('user', { _id: 'u1', name: 'Ana' });
		expect(requests).toContain(`POST /indexes/imp_${store.loc('user').collection}/documents`);
	});

	test('al calentar borra lo ya indexado del chat y no lo vuelve a leer', async () => {
		requests.length = 0;
		await store.warmup_search_indexes();
		const chat = [
			'messages',
			'notifications',
			'mentions',
			'chat-conversations',
			'chat-members',
			'chat-reactions',
			'chat-audit',
			'chat-scheduled',
			'chat-saved',
			'chat-stories',
			'chat-story-views',
		];
		const deleted = requests.filter((line) => line.startsWith('DELETE'));
		expect(deleted.sort()).toEqual(chat.map((collection) => `DELETE /indexes/imp_${collection}/documents`).sort());
	});
});

describe('adjuntos del chat', () => {
	const messages: Record<string, ImperiumDoc> = {
		vivo: { _id: 'vivo', participantUserIds: ['ana', 'beto'] },
		borrado: { _id: 'borrado', participantUserIds: ['ana', 'beto'], is_active: false },
		lapida: { _id: 'lapida', participantUserIds: ['ana', 'beto'], deleted: { at: '2026-10-06T00:00:00.000Z', byRole: 'sender' } },
		del_grupo: { _id: 'del_grupo', conversation_id: 'grupo', seq: 5, participantUserIds: ['carla'] },
		una_vez: { _id: 'una_vez', conversation_id: 'grupo', seq: 6, sender_user_id: 'ana', viewOnce: { openedByUserIds: [] } },
		caducado: { _id: 'caducado', conversation_id: 'grupo', seq: 7, expires_at: '2026-01-01T00:00:00.000Z' },
		programado: { _id: 'programado', sender_user_id: 'ana' },
		historia: {
			_id: 'historia',
			author_id: 'ana',
			expires_at: '2999-01-01T00:00:00.000Z',
			audience: { kind: 'users', userIds: ['dario', 'carla'], excludeIds: ['carla'] },
		},
		historia_vencida: { _id: 'historia_vencida', author_id: 'ana', expires_at: '2026-01-01T00:00:00.000Z', audience: { kind: 'organization' } },
	};
	const members: ImperiumDoc[] = [
		{ conversation_id: 'grupo', user_id: 'ana', state: 'active', visibleFromSeq: 0 },
		{ conversation_id: 'grupo', user_id: 'carla', state: 'removed', visibleFromSeq: 0 },
		{ conversation_id: 'grupo', user_id: 'dario', state: 'active', visibleFromSeq: 5 },
	];
	const store = {
		find_id: async (_resource: string, id: string) => messages[id] ?? null,
		find_many: async (_resource: string, opts: { where?: Record<string, unknown> }) => ({
			rows: members.filter((row) => row.conversation_id === opts.where?.conversation_id && row.user_id === opts.where?.user_id),
			total: 0,
		}),
	};
	const ana = { _id: 'ana' };
	const carla = { _id: 'carla' };
	const attachment = (related_model: string, related_record_id: string, created_by_id = 'ana') => ({
		_id: 'adjunto',
		related_model,
		related_record_id,
		created_by_id,
		mimetype: 'image/png',
		base64: Buffer.from('contenido privado').toString('base64'),
	});

	test('los modelos del contrato y el nombre que escribe el CRUD genérico', () => {
		expect([...CHAT_ATTACHMENT_MODELS].sort()).toEqual(
			['ChatConversation', 'ChatScheduled', 'ChatStory', 'Message', 'messages'].sort(),
		);
	});

	test('cada modelo de adjunto del chat resuelve a su recurso privado', () => {
		const real = new ImperiumStore({} as Bun.SQL, load_catalog_path());
		const resolved = [...CHAT_ATTACHMENT_MODELS].sort().map((model) => [model, real.resource_for_model(model)]);
		expect(resolved).toEqual([
			['ChatConversation', 'chat-conversations'],
			['ChatScheduled', 'chat-scheduled'],
			['ChatStory', 'chat-stories'],
			['Message', 'messages'],
			['messages', 'messages'],
		]);
	});

	test('un adjunto ajeno al chat no se toca aquí', async () => {
		await assert_attachment_access(store, null, attachment('citizen-report', 'r1'));
	});

	test('de un mensaje: solo sus participantes', async () => {
		for (const model of ['Message', 'messages']) {
			await assert_attachment_access(store, ana, attachment(model, 'vivo'));
			expect(await chat_error(assert_attachment_access(store, carla, attachment(model, 'vivo')))).toEqual({
				status: 403,
				code: 'attachment_forbidden',
				message: 'No tienes acceso a este archivo.',
			});
			expect((await chat_error(assert_attachment_access(store, null, attachment(model, 'vivo')))).status).toBe(403);
		}
	});

	test('de un mensaje borrado, con lápida o inexistente: 410', async () => {
		for (const id of ['borrado', 'lapida', 'no-existe']) {
			expect(await chat_error(assert_attachment_access(store, ana, attachment('Message', id)))).toEqual({
				status: 410,
				code: 'message_gone',
				message: 'Este mensaje se borró o caducó.',
			});
		}
	});

	test('sin ligar a un mensaje: solo quien lo subió', async () => {
		await assert_attachment_access(store, ana, attachment('Message', '', 'ana'));
		expect((await chat_error(assert_attachment_access(store, carla, attachment('Message', '', 'ana')))).status).toBe(403);
	});

	test('de una conversación: quien sigue en ella y desde lo que ve; quien salió o fue expulsado, ya no', async () => {
		await assert_attachment_access(store, ana, attachment('Message', 'del_grupo'));
		for (const user of [carla, { _id: 'dario' }, { _id: 'beto' }]) {
			expect((await chat_error(assert_attachment_access(store, user, attachment('Message', 'del_grupo')))).code).toBe(
				'attachment_forbidden',
			);
		}
	});

	test('ver una vez: quien lo envió, sin token; los demás, solo con el token de abrirlo; lo caducado ya no está', async () => {
		const dario = { _id: 'dario' };
		const once = attachment('Message', 'una_vez');
		await assert_attachment_access(store, ana, once);
		expect((await chat_error(assert_attachment_access(store, dario, once))).code).toBe('attachment_forbidden');
		expect((await chat_error(assert_attachment_access(store, dario, once, { token_user_id: 'ana' }))).code).toBe('attachment_forbidden');
		await assert_attachment_access(store, dario, once, { token_user_id: 'dario' });
		expect((await chat_error(assert_attachment_access(store, ana, attachment('Message', 'caducado')))).code).toBe('message_gone');
	});

	test('lo de una historia: su autor y su audiencia mientras siga vigente; los excluidos, no', async () => {
		await assert_attachment_access(store, ana, attachment('ChatStory', 'historia'));
		await assert_attachment_access(store, { _id: 'dario' }, attachment('ChatStory', 'historia'));
		for (const user of [carla, { _id: 'beto' }]) {
			expect((await chat_error(assert_attachment_access(store, user, attachment('ChatStory', 'historia')))).code).toBe(
				'attachment_forbidden',
			);
		}
		expect((await chat_error(assert_attachment_access(store, ana, attachment('ChatStory', 'historia_vencida')))).code).toBe(
			'story_expired',
		);
	});

	test('lo de un programado: solo quien lo programó', async () => {
		await assert_attachment_access(store, ana, attachment('ChatScheduled', 'programado'));
		for (const user of [carla, null]) {
			expect((await chat_error(assert_attachment_access(store, user, attachment('ChatScheduled', 'programado')))).code).toBe(
				'attachment_forbidden',
			);
		}
	});

	test('la imagen de un grupo: solo sus miembros activos', async () => {
		await assert_attachment_access(store, ana, attachment('ChatConversation', 'grupo'));
		for (const user of [carla, null]) {
			expect((await chat_error(assert_attachment_access(store, user, attachment('ChatConversation', 'grupo')))).code).toBe(
				'attachment_forbidden',
			);
		}
	});

	test('sin el registro al que apuntan, los adjuntos del chat se niegan', async () => {
		for (const [model, record] of [
			['ChatScheduled', 'x'],
			['ChatConversation', ''],
			['ChatStory', ''],
		] as const) {
			expect((await chat_error(assert_attachment_access(store, ana, attachment(model, record)))).code).toBe('attachment_forbidden');
		}
	});

	test('el token de medios identifica a su usuario solo para su adjunto', () => {
		const exp = Math.floor(Date.now() / 1000) + 600;
		const token = sign_realtime_token({ t: 'media', sub: 'u:ana', aid: 'foto', exp });
		expect(media_token_actor(token, 'foto')).toEqual({ _id: 'ana' });
		expect(media_token_actor(token, 'otra')).toBeNull();
		expect(media_token_actor(`${token}x`, 'foto')).toBeNull();
		expect(media_token_actor(null, 'foto')).toBeNull();
		expect(media_token_actor(sign_realtime_token({ t: 'media', sub: 'u:ana', aid: 'foto', exp: exp - 1200 }), 'foto')).toBeNull();
		expect(media_token_actor(sign_realtime_token({ t: 'media', sub: 'g:invitada', aid: 'foto', exp }), 'foto')).toBeNull();
		const ticket = sign_realtime_token({ t: 'socket', sub: 'ana', sid: 's-ana', n: crypto.randomUUID(), exp });
		expect(media_token_actor(ticket, 'foto')).toBeNull();
	});

	test('/attachment-management/:id/view aplica la guarda', async () => {
		const files = { ...store, find_id: async (resource: string, id: string) => (resource === 'attachment-management' ? attachment('Message', 'vivo') : messages[id] ?? null) };
		const url = new URL('http://core/api/attachment-management/adjunto/view');
		const view = handle_action(files as unknown as ImperiumStore, {} as Bun.SQL, new Request(url), url, 'attachment-management', 'view', { id: 'adjunto' }, carla);
		expect((await chat_error(view)).status).toBe(403);
	});

	test('la imagen pública de reportes no entrega adjuntos del chat', async () => {
		const files = { has: () => true, find_id: async () => attachment('Message', 'vivo') };
		const url = new URL('http://core/api/reports/image-base64/adjunto');
		const res = await handle_action(files as unknown as ImperiumStore, {} as Bun.SQL, new Request(url), url, 'reports', 'get_image_base64', { attach_id: 'adjunto' }, null);
		expect(((await res.json()) as { data: string[] }).data).toEqual(['']);
	});

	test('el marcador {{image:…}} de un reporte no incrusta adjuntos del chat', async () => {
		const preview = async (related_model: string) => {
			const doc = {
				...attachment(related_model, 'vivo'),
				mimetype: 'application/pdf',
				base64: Buffer.from('contenido privado del chat '.repeat(4)).toString('base64'),
			};
			const files = { has: (resource: string) => resource === 'attachment-management', find_id: async () => doc };
			const url = new URL('http://core/api/reports/process-preview');
			const req = new Request(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ htmlContent: '{{image:foto}}', recordData: { foto: 'adjunto' } }),
			});
			const res = await handle_action(files as unknown as ImperiumStore, {} as Bun.SQL, req, url, 'reports', 'process_preview', {}, carla);
			return ((await res.json()) as { html: string }).html;
		};
		expect(await preview('citizen-report')).toContain('src="data:application/pdf;base64,');
		for (const model of CHAT_ATTACHMENT_MODELS) {
			const html = await preview(model);
			expect(html).not.toContain('data:');
			expect(html).toContain('Imagen no disponible');
		}
	});
});

describe('CRUD genérico de adjuntos: un solo alcance para todas las rutas', () => {
	const RESOURCE = 'attachment-management';
	const CON_REGLA = { _id: 'con-regla' };
	const REGLA = { name: 'solo-esta' };
	const rows: Record<string, ImperiumDoc> = {
		chat: { _id: 'chat', related_model: 'Message', related_record_id: 'm1', name: 'solo-esta' },
		ajeno: { _id: 'ajeno', related_model: 'AttachmentManagement', name: 'otra' },
	};
	const seen: unknown[] = [];
	const store = {
		...admin_store_base,
		has: (resource: string) => ['user-group', 'record-rules', RESOURCE].includes(resource),
		resource_for_model: () => null,
		async *scan(resource: string) {
			if (resource === 'user-group') {
				yield [{ _id: 'grupo-regla', user_ids: [CON_REGLA._id], record_rules_ids: ['regla'] }];
			}
			if (resource === 'record-rules') {
				yield [
					{
						_id: 'regla',
						model_id: RESOURCE,
						allow_read: true,
						allow_update: true,
						allow_delete: true,
						domain: JSON.stringify(REGLA),
					},
				];
			}
		},
		find_id: async (_resource: string, id: string) => rows[id] ?? null,
		find_many: async (_resource: string, opts: { mongo_match?: unknown }) => {
			seen.push(opts.mongo_match);
			return { rows: [], total: 0 };
		},
		distinct: async (_resource: string, _field: string, _q: string, match: unknown) => {
			seen.push(match);
			return [];
		},
		stats: async (_resource: string, _url: URL, match: unknown) => {
			seen.push(match);
			return {};
		},
		flatten_list_docs: (_resource: string, docs: ImperiumDoc[]) => docs,
	} as unknown as ImperiumStore;

	async function crud(method: string, rest: string, actor: ImperiumDoc, body?: unknown): Promise<number> {
		const url = new URL(`http://core/api/${RESOURCE}${rest}`);
		const req = new Request(url, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		try {
			const res = await handle_crud(store, req, url, RESOURCE, rest, actor);
			await res?.text();
			return res?.status ?? 404;
		} catch (err) {
			return (err as { status?: number }).status ?? 400;
		}
	}

	test('statistics, field-values, export.csv y mass-query recorren con las reglas y sin el chat, también el administrador', async () => {
		for (const [actor, regla] of [
			[CON_REGLA, REGLA],
			[ADMIN, null],
		] as const) {
			seen.length = 0;
			await crud('GET', '/statistics', actor);
			await crud('GET', '/field-values/name', actor);
			await crud('GET', '/export.csv', actor);
			await crud('POST', '/mass-query', actor, { ids: ['ajeno', 'chat'] });
			expect(seen).toEqual(Array(4).fill(without_chat_rows(RESOURCE, regla)));
		}
	});

	test('por id: lo que no existe y lo del chat responden 404 antes que la regla; lo ajeno a la regla, 403', async () => {
		for (const [method, rest, body] of [
			['GET', '/falta'],
			['PATCH', '/falta', { name: 'otro' }],
			['PUT', '', { _id: 'falta', name: 'otro' }],
			['DELETE', '/id/falta'],
			['GET', '/chat'],
			['GET', '/chat/array/items'],
			['PATCH', '/chat', { name: 'otro' }],
			['PUT', '', { _id: 'chat', name: 'otro' }],
			['DELETE', '/id/chat'],
		] as const) {
			expect(`${method} ${rest} ${await crud(method, rest, CON_REGLA, body)}`).toBe(`${method} ${rest} 404`);
		}
		expect(await crud('PATCH', '/ajeno', CON_REGLA, { name: 'otro' })).toBe(403);
	});
});

describe('historial de documentos que el chat escribió antes de salir de él', () => {
	test('una fila cita al chat por recurso, por colección de Mongo o por modelo; sin esos campos sigue visible', () => {
		for (const doc of [
			{ modelName: 'Message', collectionName: '__messages' },
			{ modelName: 'messages', collectionName: 'messages' },
			{ modelName: 'Notification', collectionName: '__notifications' },
			{ modelName: 'mentions' },
			{ collectionName: 'chat-conversations' },
			{ modelName: 'ChatConversation' },
			{ model: 'messages', modelName: 'productos' },
		]) {
			expect(is_chat_row('document-change-history', doc)).toBe(true);
		}
		for (const doc of [
			{ modelName: 'products', collectionName: 'products' },
			{ modelName: 'Chatbot', collectionName: 'chatbot' },
			{ modelName: 'mensajeria' },
			{},
		]) {
			expect(is_chat_row('document-change-history', doc)).toBe(false);
		}
		expect(without_chat_rows('document-change-history', null)).not.toBeNull();
	});
});

describe('matriz de roles (contrato §9)', () => {
	test('con anuncios solo escribe quien administra o modera; el invitado escribe sin adjuntos', () => {
		const open = { announcementOnly: false };
		const announcements = { announcementOnly: true };
		const can = (role: Parameters<typeof chat_can>[0], settings: Record<string, unknown>) =>
			(['send', 'attach', 'skip_slow_mode'] as const).filter((verb) => chat_can(role, settings, verb));
		expect(can('owner', announcements)).toEqual(['send', 'attach', 'skip_slow_mode']);
		expect(can('admin', announcements)).toEqual(['send', 'attach', 'skip_slow_mode']);
		expect(can('moderator', announcements)).toEqual(['send', 'attach', 'skip_slow_mode']);
		expect(can('member', open)).toEqual(['send', 'attach']);
		expect(can('member', announcements)).toEqual([]);
		expect(can('guest', open)).toEqual(['send']);
	});

	test('editar, borrar y ocultar lo propio: todos menos el invitado; ver la info ajena: quien modera', () => {
		const verbs = ['edit_own', 'delete_own', 'hide', 'read_any_info'] as const;
		const can = (role: Parameters<typeof chat_can>[0]) => verbs.filter((verb) => chat_can(role, {}, verb));
		expect(can('owner')).toEqual([...verbs]);
		expect(can('admin')).toEqual([...verbs]);
		expect(can('moderator')).toEqual([...verbs]);
		expect(can('member')).toEqual(['edit_own', 'delete_own', 'hide']);
		expect(can('guest')).toEqual([]);
	});

	test('reaccionar y votar: todos menos el invitado; crear encuestas, quien puede adjuntar; cerrar las ajenas, quien administra', () => {
		const verbs = ['react', 'vote', 'poll', 'close_any_poll'] as const;
		const can = (role: Parameters<typeof chat_can>[0], settings: Record<string, unknown> = {}) =>
			verbs.filter((verb) => chat_can(role, settings, verb));
		expect(can('owner')).toEqual([...verbs]);
		expect(can('admin')).toEqual([...verbs]);
		expect(can('moderator')).toEqual(['react', 'vote', 'poll']);
		expect(can('member')).toEqual(['react', 'vote', 'poll']);
		expect(can('member', { announcementOnly: true })).toEqual(['react', 'vote']);
		expect(can('guest')).toEqual([]);
	});

	test('mencionar: todos menos el invitado; @todos y @aquí, quien modera o un miembro si el grupo lo permite', () => {
		const can = (role: Parameters<typeof chat_can>[0], settings: Record<string, unknown> = {}) =>
			(['mention', 'mention_all'] as const).filter((verb) => chat_can(role, settings, verb));
		for (const role of ['owner', 'admin', 'moderator'] as const) expect(can(role)).toEqual(['mention', 'mention_all']);
		expect(can('member')).toEqual(['mention']);
		expect(can('member', { membersCanMentionAll: true })).toEqual(['mention', 'mention_all']);
		expect(can('guest', { membersCanMentionAll: true })).toEqual([]);
	});

	test('borrar lo ajeno depende del rol de su autor', () => {
		const roles = ['owner', 'admin', 'moderator', 'member', 'guest'] as const;
		const targets = (role: (typeof roles)[number]) => roles.filter((target) => chat_can(role, {}, 'delete_others', target));
		expect(targets('owner')).toEqual([...roles]);
		expect(targets('admin')).toEqual(['admin', 'moderator', 'member', 'guest']);
		expect(targets('moderator')).toEqual(['member', 'guest']);
		expect(targets('member')).toEqual([]);
		expect(targets('guest')).toEqual([]);
	});

	test('ajustes, quien administra; título, descripción e imagen, también un miembro si el grupo lo permite; transferir, el dueño', () => {
		const verbs = ['change_settings', 'edit_info', 'transfer'] as const;
		const can = (role: Parameters<typeof chat_can>[0], settings: Record<string, unknown> = {}) =>
			verbs.filter((verb) => chat_can(role, settings, verb));
		expect(can('owner')).toEqual([...verbs]);
		expect(can('admin')).toEqual(['change_settings', 'edit_info']);
		expect(can('moderator', { membersCanEditInfo: true })).toEqual([]);
		expect(can('member')).toEqual([]);
		expect(can('member', { membersCanEditInfo: true })).toEqual(['edit_info']);
		expect(can('guest', { membersCanEditInfo: true })).toEqual([]);
	});

	test('añadir miembros: quien modera o un miembro si el grupo lo permite; ver las bajas, quien modera', () => {
		const can = (role: Parameters<typeof chat_can>[0], settings: Record<string, unknown> = {}) =>
			(['add_members', 'read_departed'] as const).filter((verb) => chat_can(role, settings, verb));
		for (const role of ['owner', 'admin', 'moderator'] as const) expect(can(role)).toEqual(['add_members', 'read_departed']);
		expect(can('member')).toEqual([]);
		expect(can('member', { membersCanInvite: true })).toEqual(['add_members']);
		expect(can('guest', { membersCanInvite: true })).toEqual([]);
	});

	test('restringir y expulsar: solo a quien tiene un rol menor que el propio', () => {
		const roles = ['owner', 'admin', 'moderator', 'member', 'guest'] as const;
		for (const verb of ['restrict', 'remove_member'] as const) {
			const targets = (role: (typeof roles)[number]) => roles.filter((target) => chat_can(role, {}, verb, target));
			expect(targets('owner')).toEqual(['admin', 'moderator', 'member', 'guest']);
			expect(targets('admin')).toEqual(['moderator', 'member', 'guest']);
			expect(targets('moderator')).toEqual(['member', 'guest']);
			expect(targets('member')).toEqual([]);
			expect(targets('guest')).toEqual([]);
		}
	});

	test('enlaces: crearlos, quien administra o un miembro si el grupo lo permite; revocar, cualquiera quien administra y los suyos un miembro; aprobar, quien modera', () => {
		const verbs = ['create_invite', 'revoke_invite', 'revoke_own_invite', 'approve_join'] as const;
		const can = (role: Parameters<typeof chat_can>[0], settings: Record<string, unknown> = {}) =>
			verbs.filter((verb) => chat_can(role, settings, verb));
		expect(can('owner')).toEqual([...verbs]);
		expect(can('admin')).toEqual([...verbs]);
		expect(can('moderator', { membersCanInvite: true })).toEqual(['approve_join']);
		expect(can('member')).toEqual(['revoke_own_invite']);
		expect(can('member', { membersCanInvite: true })).toEqual(['create_invite', 'revoke_own_invite']);
		expect(can('guest', { membersCanInvite: true })).toEqual([]);
	});

	test('fijar y desfijar: quien modera, o un miembro si el grupo lo permite (en un directo, siempre)', () => {
		for (const role of ['owner', 'admin', 'moderator'] as const) expect(chat_can(role, {}, 'pin')).toBe(true);
		expect(chat_can('member', {}, 'pin')).toBe(false);
		expect(chat_can('member', { membersCanPin: true }, 'pin')).toBe(true);
		expect(chat_can('member', DIRECT_CONVERSATION_SETTINGS, 'pin')).toBe(true);
		expect(chat_can('guest', { membersCanPin: true }, 'pin')).toBe(false);
	});

	test('un enlace sirve mientras no se revoque, no caduque y le queden usos', () => {
		const now = '2026-10-07T12:00:00.000Z';
		expect(invite_state({ uses: 3 }, now)).toBe('live');
		expect(invite_state({ revokedAt: now, expiresAt: '2026-01-01T00:00:00.000Z' }, now)).toBe('revoked');
		expect(invite_state({ expiresAt: now }, now)).toBe('expired');
		expect(invite_state({ expiresAt: '2026-10-08T00:00:00.000Z', maxUses: 2, uses: 2 }, now)).toBe('exhausted');
		expect(invite_state({ maxUses: 2, uses: 1 }, now)).toBe('live');
	});

	test('cambiar rol: el dueño entre administrador, moderador y miembro; el administrador entre moderador y miembro', () => {
		const roles = ['owner', 'admin', 'moderator', 'member', 'guest'] as const;
		const assignable = (role: (typeof roles)[number]) => roles.filter((target) => chat_can(role, {}, 'change_role', target));
		expect(assignable('owner')).toEqual(['admin', 'moderator', 'member']);
		expect(assignable('admin')).toEqual(['moderator', 'member']);
		expect(assignable('moderator')).toEqual([]);
		expect(assignable('member')).toEqual([]);
		expect(assignable('guest')).toEqual([]);
	});
});
