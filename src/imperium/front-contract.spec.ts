/**
 * Contrato que el Angular real consume. Arranca el layer que monta :3100
 * (`create_imperium_layer`) y compara status + forma con el backend original.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign_realtime_token } from './realtime-tokens.ts';
import { create_imperium_layer } from './router.ts';
import { load_catalog_path } from './store.ts';

const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://imperium:imperium@127.0.0.1:5434/imperium_core';
const EMAIL = process.env.E2E_EMAIL ?? 'admin@admin.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'lr92*JCaa';

const sql = new Bun.SQL(DATABASE_URL);
const layer = create_imperium_layer(sql);

afterAll(async () => {
	await sql.close();
});

type Call = {
	status: number;
	json: Record<string, unknown> | null;
	text: string;
	set_cookie: string | null;
};

async function call(
	method: string,
	api_path: string,
	opts?: { body?: unknown; cookie?: string },
): Promise<Call> {
	const headers: Record<string, string> = { accept: 'application/json' };
	if (opts?.cookie) headers.cookie = opts.cookie;
	if (opts?.body !== undefined) headers['content-type'] = 'application/json';
	const req = new Request(`http://imperium.test/api${api_path}`, {
		method,
		headers,
		body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
	});
	const res = await layer.handle(req);
	if (!res) {
		return {
			status: 404,
			json: { error: 'not found' },
			text: '{"error":"not found"}',
			set_cookie: null,
		};
	}
	const text = await res.text();
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		/* raw */
	}
	return {
		status: res.status,
		json,
		text,
		set_cookie: res.headers.get('set-cookie'),
	};
}

async function wait_subject(
	cookie: string,
	technical_id: string,
	pred: (row: Record<string, unknown>) => boolean,
	timeout_ms = 15_000,
) {
	const start = Date.now();
	while (Date.now() - start < timeout_ms) {
		const listed = await call('GET', '/subjects', { cookie });
		const subjects = (listed.json?.data as Record<string, unknown>[]) ?? [];
		const row = subjects.find((item) => item.technical_id === technical_id);
		if (row && pred(row)) return row;
		await Bun.sleep(50);
	}
	throw new Error(`timeout waiting for ${technical_id}`);
}

function sid_from(set_cookie: string | null): string {
	const m = String(set_cookie ?? '').match(/connect\.sid=([^;]+)/);
	if (!m) throw new Error(`no session cookie: ${set_cookie}`);
	return `connect.sid=${m[1]}`;
}

function secret_keys(obj: Record<string, unknown> | null): string[] {
	if (!obj) return [];
	return [
		'password',
		'reset_password_token_hash',
		'reset_password_expires',
		'reset_password_kind',
		'recovery_token',
		'recovery_expires',
	].filter((k) => k in obj && obj[k] != null && obj[k] !== '');
}

describe('front-used Imperium contract via shipped create_imperium_layer', () => {
	test('GET /auth without session is 401 JSON, not 500 HTML', async () => {
		const r = await call('GET', '/auth');
		expect(r.status).toBe(401);
		expect(String(r.text ?? '').toLowerCase()).not.toContain('<!doctype');
		expect(String(r.json?.message ?? r.json?.error ?? '')).toContain(
			'autenticado',
		);
	});

	test('GET /auth/branding is public and uses the original list envelope', async () => {
		const r = await call('GET', '/auth/branding');
		expect(r.status).toBe(200);
		expect(r.json).not.toBeNull();
		expect(Array.isArray(r.json?.data)).toBe(true);
		expect(typeof r.json?.total_elementos).toBe('number');
		const row = (r.json?.data as Record<string, unknown>[])[0];
		expect(row).toBeTruthy();
		expect('branding_mode' in (row ?? {})).toBe(true);
		expect('company_logo' in (row ?? {})).toBe(true);
	});

	test('POST /auth/login returns user._id, L1 menus only for installed subjects, no recovery hashes', async () => {
		const r = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		expect(r.status).toBe(200);
		const user = r.json?.user as Record<string, unknown> | undefined;
		const menus = r.json?.menus as Record<string, unknown>[] | undefined;
		expect(user).toBeTruthy();
		expect(String(user?._id ?? '')).not.toBe('');
		expect(secret_keys(user ?? null)).toEqual([]);
		expect(Array.isArray(menus)).toBe(true);
		const cookie = sid_from(r.set_cookie);
		const catalog = await call('GET', '/subjects', { cookie });
		const subjects =
			(catalog.json?.data as Record<string, unknown>[]) ?? [];
		const installed_names = new Set(
			subjects
				.filter((s) => s.installed)
				.map((s) => String(s.name ?? '')),
		);
		const tops = (menus ?? []).filter((m) => !m.parent_id);
		expect(tops.length).toBe(installed_names.size);
		for (const name of tops.map((m) => String(m.name ?? ''))) {
			expect(installed_names.has(name)).toBe(true);
		}
		expect(r.json).toHaveProperty('access_rights');
		expect(sid_from(r.set_cookie).startsWith('connect.sid=')).toBe(true);
		const models = ((r.json?.access_rights as Record<string, unknown>)
			?.models ?? []) as string[];
		// El dashboard (`is_model_available('Pedidos')`) usa nombres mongoose,
		// no slugs kebab del catálogo modular.
		for (const name of [
			'Pedidos',
			'PosSession',
			'Products',
			'Ticket',
			'MisTareas',
			'Proyectos',
		]) {
			expect(models).toContain(name);
		}
		expect(models.includes('pedidos')).toBe(false);
		const paths = (menus ?? []).map((m) =>
			String(m.path ?? '').replace(/\/+$/, ''),
		);
		expect(paths.includes('/model-tracker')).toBe(false);
		expect(
			(menus ?? []).some(
				(m) =>
					String(m._ref ?? '') === 'model-tracker-menu-management-0',
			),
		).toBe(false);
		expect(paths.includes('/postgres-table-tracker')).toBe(true);
		expect(
			(menus ?? []).some(
				(m) =>
					String(m._ref ?? '') ===
						'postgres-table-tracker-menu-management-0' ||
					String(m.path ?? '').replace(/\/+$/, '') ===
						'/postgres-table-tracker',
			),
		).toBe(true);
	});

	test('GET /postgres-table-tracker/CitizenReport returns schema fields; model-tracker is gone', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('GET', '/postgres-table-tracker/CitizenReport', {
			cookie,
		});
		expect(r.status).toBe(200);
		const row = (r.json?.data as Record<string, unknown>[] | undefined)?.[0];
		expect(row).toBeTruthy();
		expect(String(row?.__model_name ?? '')).toBe('CitizenReport');
		expect(String(row?.__collection ?? '')).toBe('citizen-report');
		const fields = (row?.__schema_fields as Array<{ path?: string }> | undefined) ?? [];
		expect(fields.some((field) => field.path === 'sequence')).toBe(true);
		expect(fields.some((field) => field.path === 'name')).toBe(true);
		const gone = await call('GET', '/model-tracker/CitizenReport', { cookie });
		expect(gone.status).toBe(404);
	});

	test('GET /auth (session) is the original public user, not hashes', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('GET', '/auth', { cookie });
		expect(r.status).toBe(200);
		expect(String(r.json?._id ?? '')).not.toBe('');
		expect(secret_keys(r.json)).toEqual([]);
	});

	test('GET /user?limite=1 list envelope matches original (_id, data, total)', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('GET', '/user?limite=1', { cookie });
		expect(r.status).toBe(200);
		expect(Array.isArray(r.json?.data)).toBe(true);
		expect(typeof r.json?.total_elementos).toBe('number');
		const row = (r.json?.data as Record<string, unknown>[])[0];
		expect(row).toBeTruthy();
		expect(String(row?._id ?? '')).not.toBe('');
	});

	test('POST /configuration/sync-missing-seeds is missing-seed sync, not 404', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('POST', '/configuration/sync-missing-seeds', {
			cookie,
			body: {},
		});
		expect(r.status).not.toBe(404);
		expect(String(r.json?.message ?? r.json?.error ?? '').toLowerCase()).not.toBe(
			'not found',
		);
		expect(String(r.json?.message ?? r.json?.error ?? '')).not.toContain(
			'Acción no implementada',
		);
		const rows = (r.json?.data as Record<string, unknown>[] | undefined) ?? [];
		const payload = rows[0] ?? {};
		const created = payload.created;
		const patched = payload.patched;
		const has_arrays = Array.isArray(created) && Array.isArray(patched);
		const no_faltaba = String(r.json?.message ?? '').includes('No faltaba');
		expect(has_arrays || no_faltaba).toBe(true);
	});

	test('GET /notifications/my-notifications is the original session extra, not 404', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const r = await call('GET', '/notifications/my-notifications', {
			cookie,
		});
		expect(r.status).not.toBe(404);
		expect(r.status).toBe(200);
	});

	test('ni el administrador lee chats por el CRUD genérico: 404; sus acciones siguen vivas', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		for (const path of [
			'/messages',
			'/messages?limite=1&termino=hola',
			'/messages/statistics',
			'/messages/field-values/message',
			'/messages/export.csv',
			'/notifications',
			'/mentions',
		]) {
			const r = await call('GET', path, { cookie });
			expect(r.status).toBe(404);
			expect(r.json?.message).toBe('not found');
		}
		expect((await call('POST', '/messages/mass-query', { cookie, body: {} })).status).toBe(404);
		expect((await call('GET', '/messages/conversations', { cookie })).status).toBe(200);
		expect((await call('GET', '/notifications/my-mentions', { cookie })).status).toBe(200);
	});

	test('/api/media: un adjunto del chat solo para sus participantes, por cookie o por token de medios', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const admin_id = String((login.json?.user as Record<string, unknown>)._id);
		const media = (id: string, headers: Record<string, string> = {}, query = '') =>
			layer.handle(new Request(`http://imperium.test/api/media/${id}${query}`, { headers }));
		expect((await media('sin-adjunto', { cookie }))?.status).toBe(404);
		const folder = mkdtempSync(join(tmpdir(), 'imperium-media-contract-'));
		writeFileSync(join(folder, 'chat-propio.txt'), 'texto del chat');
		writeFileSync(join(folder, 'chat-ajeno.txt'), 'texto ajeno');
		const previous = process.env.MULTER_UPLOAD_FOLDER;
		process.env.MULTER_UPLOAD_FOLDER = folder;
		const store = layer.store;
		const mine = await store.insert('messages', {
			message: 'con adjunto',
			sourceType: 'chat',
			participantUserIds: [admin_id, 'otra-persona'],
		});
		const others = await store.insert('messages', {
			message: 'de otros',
			sourceType: 'chat',
			participantUserIds: ['persona-a', 'persona-b'],
		});
		const attach = (message: Record<string, unknown>, stored: string) =>
			store.insert('attachment-management', {
				name: stored.replace('.txt', ''),
				file_ext: 'txt',
				name_stored: stored,
				mimetype: 'text/plain',
				related_model: 'Message',
				related_record_id: String(message._id),
			});
		const own_file = await attach(mine, 'chat-propio.txt');
		const other_file = await attach(others, 'chat-ajeno.txt');
		const own_id = String(own_file._id);
		const token = (aid: string) =>
			sign_realtime_token({ t: 'media', sub: `u:${admin_id}`, aid, exp: Math.floor(Date.now() / 1000) + 600 });
		try {
			const denied = await media(String(other_file._id), { cookie });
			expect(denied?.status).toBe(403);
			expect(((await denied?.json()) as Record<string, unknown>).code).toBe('attachment_forbidden');

			const part = await media(own_id, { cookie, range: 'bytes=0-4' });
			expect(part?.status).toBe(206);
			expect(part?.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''chat-propio.txt");
			expect(part?.headers.get('x-content-type-options')).toBe('nosniff');
			expect(await part?.text()).toBe('texto');

			const by_token = await media(own_id, {}, `?mt=${encodeURIComponent(token(own_id))}`);
			expect(by_token?.status).toBe(200);
			expect(await by_token?.text()).toBe('texto del chat');
			expect((await media(own_id, {}, `?mt=${encodeURIComponent(token('otro-adjunto'))}`))?.status).toBe(401);
			expect((await media(own_id))?.status).toBe(401);
		} finally {
			if (previous === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
			else process.env.MULTER_UPLOAD_FOLDER = previous;
			for (const [resource, id] of [
				['attachment-management', own_id],
				['attachment-management', String(other_file._id)],
				['messages', String(mine._id)],
				['messages', String(others._id)],
			] as const) {
				await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id = $1`, [id]);
			}
		}
	});

	test('el CRUD genérico de adjuntos no ve ni toca los del chat, ni siquiera el administrador', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const store = layer.store;
		const tag = `adjunto-${crypto.randomUUID().slice(0, 8)}`;
		const message = await store.insert('messages', {
			message: 'de otros',
			sourceType: 'chat',
			participantUserIds: ['persona-a', 'persona-b'],
		});
		const attach = (suffix: string, related: Record<string, unknown>) =>
			store.insert('attachment-management', {
				name: `${tag}-${suffix}`,
				name_stored: `${tag}-${suffix}.txt`,
				file_ext: 'txt',
				mimetype: 'text/plain',
				...related,
			});
		const chat = await attach('chat', { related_model: 'Message', related_record_id: String(message._id) });
		const plain = await attach('normal', { related_model: 'AttachmentManagement' });
		const chat_id = String(chat._id);
		const plain_id = String(plain._id);
		const ids_of = (r: Call) => ((r.json?.data as Record<string, unknown>[]) ?? []).map((row) => row._id);
		const missing = '0'.repeat(24);
		try {
			for (const [method, path, body] of [
				['GET', `/attachment-management/${chat_id}`, undefined],
				['GET', `/attachment-management/${chat_id}/array/tags`, undefined],
				['PATCH', `/attachment-management/${chat_id}`, { name: `${tag}-otro`, related_model: 'AttachmentManagement' }],
				['PUT', '/attachment-management', { _id: chat_id, related_model: 'AttachmentManagement' }],
				['DELETE', `/attachment-management/id/${chat_id}`, undefined],
				['GET', `/attachment-management/${missing}`, undefined],
				['PATCH', `/attachment-management/${missing}`, { name: `${tag}-otro` }],
				['PUT', '/attachment-management', { _id: missing, name: `${tag}-otro` }],
				['DELETE', `/attachment-management/id/${missing}`, undefined],
			] as const) {
				expect((await call(method, path, { cookie, body })).status).toBe(404);
			}
			const batch = await call('PUT', '/attachment-management/batch', {
				cookie,
				body: [{ _id: chat_id, related_model: 'AttachmentManagement' }],
			});
			expect(batch.status).toBe(400);
			const kept = await store.find_id('attachment-management', chat_id);
			expect(kept?.related_model).toBe('Message');
			expect(kept?.name).toBe(`${tag}-chat`);
			expect(kept?.is_active).not.toBe(false);

			expect(ids_of(await call('GET', `/attachment-management?limite=50&termino=${tag}`, { cookie }))).toEqual([plain_id]);
			const mass = await call('POST', '/attachment-management/mass-query', { cookie, body: { ids: [chat_id, plain_id] } });
			expect(ids_of(mass)).toEqual([plain_id]);
			const values = await call('GET', `/attachment-management/field-values/name?termino=${tag}`, { cookie });
			expect((values.json?.data as Record<string, unknown>[]).map((row) => row.value)).toEqual([`${tag}-normal`]);
			const csv = await call('GET', `/attachment-management/export.csv?termino=${tag}`, { cookie });
			expect(csv.text).toContain(`${tag}-normal`);
			expect(csv.text).not.toContain(`${tag}-chat`);

			const relabel = await call('PATCH', `/attachment-management/${plain_id}`, {
				cookie,
				body: { name: `${tag}-normal`, related_model: 'Message', related_record_id: String(message._id) },
			});
			expect(relabel.status).toBe(200);
			const still_plain = await store.find_id('attachment-management', plain_id);
			expect(still_plain?.related_model).toBe('AttachmentManagement');
			expect(still_plain?.related_record_id ?? null).toBeNull();
		} finally {
			for (const [resource, id] of [
				['attachment-management', chat_id],
				['attachment-management', plain_id],
				['messages', String(message._id)],
			] as const) {
				await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id = $1`, [id]);
			}
		}
	});

	test('el envío del chat por la ruta real: subida, envío idempotente con seq y details de ChatError', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const admin_id = String((login.json?.user as Record<string, unknown>)._id);
		const store = layer.store;
		const folder = mkdtempSync(join(tmpdir(), 'imperium-chat-contract-'));
		const previous = process.env.MULTER_UPLOAD_FOLDER;
		process.env.MULTER_UPLOAD_FOLDER = folder;
		const now = new Date().toISOString();
		const conversations: string[] = [];
		const group = async (member: Record<string, unknown> = {}) => {
			const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
			conversations.push(id);
			await store.insert('chat-conversations', {
				_id: id,
				name: 'Contrato',
				kind: 'group',
				conversation_key: `conv:${id}`,
				last_seq: 0,
				memberCount: 1,
				settings: { announcementOnly: false, slowModeSeconds: 0 },
			});
			await store.insert('chat-members', {
				conversation_id: id,
				user_id: admin_id,
				role: 'member',
				state: 'active',
				last_read_seq: 0,
				public_read_seq: 0,
				delivered_seq: 0,
				joinedAt: now,
				visibleFromSeq: 0,
				...member,
			});
			return id;
		};
		const post = async (path: string, body: FormData | Record<string, unknown>, method = 'POST') => {
			const form = body instanceof FormData;
			const res = await layer.handle(
				new Request(`http://imperium.test/api/messages${path}`, {
					method,
					headers: form ? { cookie } : { cookie, 'content-type': 'application/json' },
					body: form ? body : JSON.stringify(body),
				}),
			);
			return { status: res?.status ?? 404, json: ((await res?.json()) ?? {}) as Record<string, unknown> };
		};
		try {
			const conversation_id = await group();
			const form = new FormData();
			form.append('conversation_id', conversation_id);
			form.append('client_upload_id', crypto.randomUUID());
			form.append('alt', 'Plano del edificio');
			form.append('file', new File(['planos'], 'plano.txt', { type: 'text/plain' }));
			const uploaded = await post('/uploads', form);
			expect(uploaded.status).toBe(200);
			const attachment = (uploaded.json.data as Record<string, unknown>[])[0]!;
			expect(attachment).toMatchObject({ kind: 'file', alt: 'Plano del edificio', name: 'plano', file_ext: 'txt' });
			const request = {
				conversation_id,
				client_id: crypto.randomUUID(),
				text: 'Aquí van los planos',
				attachment_ids: [attachment.attachment_id],
			};
			const sent = await post('/chat', request);
			const again = await post('/chat', request);
			expect(sent.status).toBe(200);
			const view = (sent.json.data as Record<string, unknown>[])[0]!;
			expect(view).toMatchObject({
				conversation_id,
				conversation_key: `conv:${conversation_id}`,
				seq: 1,
				kind: 'media',
				text: 'Aquí van los planos',
				sender: { _id: admin_id },
				attachments: [{ attachment_id: attachment.attachment_id, alt: 'Plano del edificio' }],
			});
			expect(again).toEqual(sent);
			const bound = await store.find_id('attachment-management', String(attachment.attachment_id));
			expect(bound?.related_record_id).toBe(view._id);
			const removal = await post(`/uploads/${attachment.attachment_id}`, {}, 'DELETE');
			expect([removal.status, removal.json.code]).toEqual([409, 'upload_bound']);

			const until = new Date(Date.now() + 3_600_000).toISOString();
			const restricted = await post('/chat', {
				conversation_id: await group({ restrictedUntil: until }),
				client_id: crypto.randomUUID(),
				text: 'Hola',
			});
			expect(restricted.status).toBe(403);
			expect(restricted.json).toMatchObject({ code: 'member_restricted', details: { restricted_until: until } });
		} finally {
			if (previous === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
			else process.env.MULTER_UPLOAD_FOLDER = previous;
			for (const [resource, column] of [
				['attachment-management', "payload #>> '{chatUpload,conversationId}'"],
				['messages', 'conversation_id'],
				['chat-members', 'conversation_id'],
				['chat-conversations', 'id'],
			] as const) {
				await sql.unsafe(
					`DELETE FROM ${store.qt(resource)} WHERE ${column} IN (SELECT jsonb_array_elements_text($1::jsonb))`,
					[conversations],
				);
			}
		}
	});

	test('historial y bandeja por la ruta real: lo más reciente, /mine gana a /:id y solo POST read marca', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const admin_id = String((login.json?.user as Record<string, unknown>)._id);
		const store = layer.store;
		const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
		const folder = `contrato-${id}`;
		try {
			await store.insert('chat-conversations', {
				_id: id,
				name: 'Contrato bandeja',
				kind: 'group',
				conversation_key: `conv:${id}`,
				last_seq: 0,
				memberCount: 1,
				settings: { announcementOnly: false, slowModeSeconds: 0 },
			});
			await store.insert('chat-members', {
				conversation_id: id,
				user_id: admin_id,
				role: 'owner',
				state: 'active',
				last_read_seq: 0,
				public_read_seq: 0,
				delivered_seq: 0,
				visibleFromSeq: 0,
				folder,
			});
			for (const text of ['uno', 'dos', 'tres']) {
				const sent = await call('POST', '/messages/chat', {
					cookie,
					body: { conversation_id: id, client_id: crypto.randomUUID(), text },
				});
				expect(sent.status).toBe(200);
			}
			const history = await call('GET', `/messages/history/${id}?limit=2`, { cookie });
			expect(history.status).toBe(200);
			expect((history.json?.data as Record<string, unknown>[]).map((row) => row.text)).toEqual(['dos', 'tres']);
			expect(history.json).toMatchObject({ has_more_before: true, has_more_after: false });
			const inbox = await call('GET', `/chat-conversations/mine?folder=${folder}`, { cookie });
			expect(inbox.status).toBe(200);
			expect(inbox.json?.data).toEqual([expect.objectContaining({ _id: id, title: 'Contrato bandeja', last_seq: 3 })]);
			expect(inbox.json?.counts).toEqual(expect.objectContaining({ all: expect.any(Number) }));
			const summary = await call('GET', `/chat-conversations/${id}`, { cookie });
			expect([summary.status, (summary.json?.data as Record<string, unknown>[])[0]?._id]).toEqual([200, id]);
			const detail = await call('GET', `/chat-conversations/${id}/detail`, { cookie });
			expect((detail.json?.data as Record<string, unknown>[])[0]).toMatchObject({ _id: id, pins: [] });
			const config = await call('GET', '/messages/chat-config', { cookie });
			expect((config.json?.data as Record<string, unknown>[])[0]).toMatchObject({ api_version: 2 });
			const unread = await call('POST', `/chat-conversations/${id}/unread`, { cookie, body: {} });
			expect(unread.json?.data).toEqual([{ marked_unread: true }]);
			await call('GET', `/messages/history/${id}`, { cookie });
			const listed = async () =>
				((await call('GET', `/chat-conversations/mine?folder=${folder}`, { cookie })).json?.data as Record<string, unknown>[])[0];
			expect(await listed()).toMatchObject({ marked_unread: true, my_last_read_seq: 3 });
			const read = await call('POST', `/chat-conversations/${id}/read`, { cookie, body: { seq: 3 } });
			expect(read.json?.data).toEqual([{ last_read_seq: 3, public_read_seq: expect.any(Number), unread_count: 0, unread_mentions: 0 }]);
			expect(await listed()).toMatchObject({ marked_unread: false });
			const missing = '0'.repeat(24);
			expect((await call('GET', `/chat-conversations/${missing}`, { cookie })).json?.code).toBe(
				'conversation_not_found',
			);
		} finally {
			for (const [resource, column] of [
				['messages', 'conversation_id'],
				['chat-members', 'conversation_id'],
				['chat-conversations', 'id'],
			] as const) {
				await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE ${column} = $1`, [id]);
			}
		}
	});

	test('mensajes y Actividad por la ruta real: /message/:id y /my-mentions/read ganan a las rutas con parámetro', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const admin_id = String((login.json?.user as Record<string, unknown>)._id);
		const store = layer.store;
		const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
		try {
			await store.insert('chat-conversations', {
				_id: id,
				name: 'Contrato mensajes',
				kind: 'group',
				conversation_key: `conv:${id}`,
				last_seq: 0,
				memberCount: 1,
				settings: { announcementOnly: false, slowModeSeconds: 0 },
			});
			await store.insert('chat-members', {
				conversation_id: id,
				user_id: admin_id,
				role: 'owner',
				state: 'active',
				last_read_seq: 0,
				public_read_seq: 0,
				delivered_seq: 0,
				visibleFromSeq: 0,
			});
			const sent = await call('POST', '/messages/chat', {
				cookie,
				body: { conversation_id: id, client_id: crypto.randomUUID(), text: 'Hola' },
			});
			const message_id = String((sent.json?.data as Record<string, unknown>[])[0]?._id);
			const edited = await call('PATCH', `/messages/message/${message_id}`, { cookie, body: { text: 'Hola, editado' } });
			expect([edited.status, (edited.json?.data as Record<string, unknown>[])[0]?.text]).toEqual([200, 'Hola, editado']);
			const reacted = await call('POST', `/messages/message/${message_id}/reactions`, { cookie, body: { emoji: '👍' } });
			expect(reacted.json?.data).toEqual([{ emoji: '👍', count: 1, mine: true, rev: 2 }]);
			const info = await call('GET', `/messages/message/${message_id}/info`, { cookie });
			expect((info.json?.data as Record<string, unknown>[])[0]).toMatchObject({ revisions: [{ text: 'Hola' }] });
			const removed = await call('DELETE', `/messages/message/${message_id}?scope=all`, { cookie });
			expect(removed.json?.data).toEqual([{ _id: message_id, scope: 'all' }]);
			const read = await call('PATCH', '/notifications/my-mentions/read', { cookie, body: { ids: [id] } });
			expect([read.status, read.json?.data]).toEqual([200, [{ updated: 0 }]]);
			const activity = await call('GET', '/notifications/my-mentions?limit=1', { cookie });
			expect(activity.json).toMatchObject({
				counts: { all: expect.any(Number), chat: expect.any(Number) },
				server_time: expect.any(String),
			});
			expect(activity.json).toHaveProperty('next_cursor');
		} finally {
			for (const [resource, column] of [
				['chat-reactions', 'conversation_id'],
				['chat-audit', 'conversation_id'],
				['messages', 'conversation_id'],
				['chat-members', 'conversation_id'],
				['chat-conversations', 'id'],
			] as const) {
				await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE ${column} = $1`, [id]);
			}
		}
	});

	test('MCP no vuelve público un adjunto ajeno del chat cambiando related_model', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const admin_id = String((login.json?.user as Record<string, unknown>)._id);
		const store = layer.store;
		const tag = `mcp-adjunto-${crypto.randomUUID().slice(0, 8)}`;
		const token = `isic_${tag}`;
		const message = await store.insert('messages', {
			message: 'de otros',
			sourceType: 'chat',
			participantUserIds: ['persona-a', 'persona-b'],
		});
		const attach = (suffix: string, related: Record<string, unknown>) =>
			store.insert('attachment-management', {
				name: `${tag}-${suffix}`,
				name_stored: crypto.randomUUID(),
				file_ext: 'txt',
				mimetype: 'text/plain',
				base64: Buffer.from(`texto ${suffix}`).toString('base64'),
				...related,
			});
		const chat = await attach('chat', { related_model: 'Message', related_record_id: String(message._id) });
		const plain = await attach('normal', { related_model: 'AttachmentManagement' });
		const grant = await store.insert('mcp-user-token', {
			name: tag,
			user_id: admin_id,
			token_hash: createHash('sha256').update(token).digest('hex'),
			is_active: true,
			last_used_at: new Date().toISOString(),
		});
		const chat_id = String(chat._id);
		const mcp = async (method: string, path: string, body?: unknown) => {
			const res = await layer.handle(
				new Request(`http://imperium.test/api/mcp-agent/v1${path}`, {
					method,
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			);
			return { status: res?.status ?? 404, json: ((await res?.json()) ?? {}) as Record<string, unknown> };
		};
		try {
			const relabel = await mcp('PATCH', `/records/attachment-management/${chat_id}`, {
				values: { related_model: 'AttachmentManagement', related_record_id: null, created_by_id: admin_id },
			});
			expect(relabel.status).toBe(404);
			const kept = await store.find_id('attachment-management', chat_id);
			expect(kept?.related_model).toBe('Message');
			expect(kept?.created_by_id ?? null).toBeNull();
			const media = await layer.handle(new Request(`http://imperium.test/api/media/${chat_id}`, { headers: { cookie } }));
			expect(media?.status).toBe(403);

			expect((await mcp('GET', `/records/attachment-management/${chat_id}`)).status).toBe(404);
			const found = await mcp('POST', '/search', { model: 'attachment-management', q: tag });
			expect((found.json.data as Record<string, unknown>[]).map((row) => row.name)).toEqual([`${tag}-normal`]);
			const counted = await mcp('POST', '/count', { model: 'attachment-management', q: tag });
			expect((counted.json.data as Record<string, unknown>[])[0]?.count).toBe(1);
		} finally {
			for (const [resource, id] of [
				['attachment-management', chat_id],
				['attachment-management', String(plain._id)],
				['messages', String(message._id)],
				['mcp-user-token', String(grant._id)],
			] as const) {
				await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id = $1`, [id]);
			}
		}
	});

	test('el historial viejo del chat no sale por ninguna lectura genérica, ni para el administrador', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const admin_id = String((login.json?.user as Record<string, unknown>)._id);
		const store = layer.store;
		const tag = `historial-chat-${crypto.randomUUID().slice(0, 8)}`;
		const token = `isic_${tag}`;
		const chat_doc = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
		const other_doc = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
		const history = (suffix: string, fields: Record<string, unknown>) =>
			store.insert('document-change-history', {
				name: `${tag}-${suffix}`,
				entryType: 'change',
				actionName: 'Registro actualizado',
				actionDescription: `${tag} ${suffix}`,
				changes: [{ dotPath: 'message', before: `${tag} antes`, after: `${tag} después` }],
				...fields,
			});
		const legacy = await history('mongo', { modelName: 'Message', collectionName: '__messages', documentId: chat_doc });
		const core = await history('nucleo', { modelName: 'messages', collectionName: 'messages', documentId: chat_doc });
		const plain = await history('productos', { modelName: 'products', collectionName: 'products', documentId: other_doc });
		const grant = await store.insert('mcp-user-token', {
			name: tag,
			user_id: admin_id,
			token_hash: createHash('sha256').update(token).digest('hex'),
			is_active: true,
			last_used_at: new Date().toISOString(),
		});
		const [legacy_id, core_id, plain_id] = [legacy, core, plain].map((row) => String(row._id));
		const names = (rows: unknown) => ((rows ?? []) as Record<string, unknown>[]).map((row) => row.name);
		const mcp = async (method: string, path: string, body?: unknown) => {
			const res = await layer.handle(
				new Request(`http://imperium.test/api/mcp-agent/v1${path}`, {
					method,
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			);
			return { status: res?.status ?? 404, json: ((await res?.json()) ?? {}) as Record<string, unknown> };
		};
		try {
			const by_doc = (document_id: string) =>
				call('GET', `/document-change-history?document_id=${document_id}&model_name=products`, { cookie });
			expect(names((await by_doc(chat_doc)).json?.data)).toEqual([]);
			expect(names((await by_doc(other_doc)).json?.data)).toEqual([`${tag}-productos`]);
			for (const id of [legacy_id, core_id]) {
				const one = await call('GET', `/document-change-history/${id}`, { cookie });
				expect(one.status).toBe(200);
				expect(one.json?.data).toEqual([]);
				expect((await call('GET', `/document-change-history/${id}/array/changes`, { cookie })).status).toBe(404);
				expect((await call('PATCH', `/document-change-history/${id}`, { cookie, body: { name: 'x' } })).status).toBe(404);
			}
			expect(names((await call('GET', `/document-change-history/${plain_id}`, { cookie })).json?.data)).toEqual([
				`${tag}-productos`,
			]);
			const mass = await call('POST', '/document-change-history/mass-query', {
				cookie,
				body: { ids: [legacy_id, core_id, plain_id] },
			});
			expect(names(mass.json?.data)).toEqual([`${tag}-productos`]);
			const values = await call('GET', `/document-change-history/field-values/actionDescription?termino=${tag}`, {
				cookie,
			});
			expect((values.json?.data as Record<string, unknown>[]).map((row) => row.value)).toEqual([`${tag} productos`]);

			const tracked = await call(
				'GET',
				`/postgres-table-tracker/global/DocumentChangeHistory/field-values/actionDescription?termino=${tag}`,
				{ cookie },
			);
			expect((tracked.json?.data as Record<string, unknown>[]).map((row) => row.value)).toEqual([`${tag} productos`]);
			const widget = await call('POST', '/dynamic-dashboard/widget-data', {
				cookie,
				body: {
					spec: {
						widget_type: 'table',
						model_id: 'DocumentChangeHistory',
						fields: ['name'],
						domain: { documentId: { $in: [chat_doc, other_doc] } },
					},
				},
			});
			const table = (widget.json?.data as Record<string, Record<string, unknown>>[])[0]?.table;
			expect(names(table?.rows)).toEqual([`${tag}-productos`]);
			for (const id of [legacy_id, core_id]) {
				const report = await call('GET', `/reports/model-record/DocumentChangeHistory/${id}`, { cookie });
				expect(report.json?.data).toEqual([]);
			}
			const report_rows = await call('GET', `/reports/model-records/DocumentChangeHistory?termino=${tag}`, { cookie });
			expect(names(report_rows.json?.data)).toEqual([`${tag}-productos`]);

			const searched = await mcp('POST', '/search', {
				model: 'DocumentChangeHistory',
				filters: { documentId: { $in: [chat_doc, other_doc] } },
			});
			expect(names(searched.json.data)).toEqual([`${tag}-productos`]);
			expect((await mcp('GET', `/records/DocumentChangeHistory/${legacy_id}`)).status).toBe(404);
		} finally {
			for (const [resource, id] of [
				['document-change-history', legacy_id],
				['document-change-history', core_id],
				['document-change-history', plain_id],
				['mcp-user-token', String(grant._id)],
			] as const) {
				await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id = $1`, [id]);
			}
		}
	});

	test('GET reports-pdf-setting/:id is public like the original (list stays 403)', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const listed = await call('GET', '/reports-pdf-setting?limite=1', {
			cookie,
		});
		expect([200, 403]).toContain(listed.status);
		const anon_list = await call('GET', '/reports-pdf-setting?limite=1');
		expect(anon_list.status).toBe(403);
		const row = (
			listed.json?.data as Record<string, unknown>[] | undefined
		)?.[0];
		if (!row?._id) return;
		const anon = await call('GET', `/reports-pdf-setting/${row._id}`);
		expect(anon.status).toBe(200);
	});

	test('GET /subjects lists catalog L1; uninstall/install mutates menus', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		// Desde Módulos solo se reinstala lo que está en el catálogo del tenant.
		const added = await call('POST', '/subjects/catalog', {
			cookie,
			body: { slug: 'turnos' },
		});
		expect([201, 409]).toContain(added.status);
		const listed = await call('GET', '/subjects', { cookie });
		expect(listed.status).toBe(200);
		const subjects = (listed.json?.data as Record<string, unknown>[]) ?? [];
		// Nadie ve el catálogo entero del núcleo: base, instaladas y autorizadas.
		const catalog_size = (
			JSON.parse(
				readFileSync(load_catalog_path(), 'utf8'),
			) as { subjects: unknown[] }
		).subjects.length;
		expect(subjects.length).toBeLessThanOrEqual(catalog_size);
		for (const row of subjects) {
			expect(
				Boolean(row.base || row.installed || row.busy || row.catalog_source),
			).toBe(true);
		}
		const turnos = subjects.find(
			(s) => s.technical_id === 'subject-turnos',
		);
		expect(turnos).toBeTruthy();
		expect(typeof turnos?.installed).toBe('boolean');
		const vista_install = await call(
			'POST',
			'/subjects/subject-configuraciones-de-vista/install',
			{ cookie, body: {} },
		);
		expect([200, 202]).toContain(vista_install.status);
		expect(vista_install.json?.accepted).toBe(true);
		await wait_subject(
			cookie,
			'subject-configuraciones-de-vista',
			(row) => row.installed === true && row.busy !== true,
		);
		const vista_detail = await call(
			'GET',
			'/subjects/subject-configuraciones-de-vista',
			{ cookie },
		);
		expect(vista_detail.status).toBe(200);
		const vista_info = vista_detail.json?.data as Record<string, unknown>;
		expect(vista_info?.installed).toBe(true);
		expect(vista_info).toHaveProperty('permissions');
		expect(vista_info).toHaveProperty('menus');
		expect(vista_info).toHaveProperty('collections');
		expect(vista_info).toHaveProperty('health');
		expect(vista_info).toHaveProperty('version');
		expect(vista_info).toHaveProperty('data_bytes');
		expect(vista_info).toHaveProperty('install_bytes');
		expect(vista_info).toHaveProperty('status');
		const off = await call('POST', '/subjects/subject-turnos/uninstall', {
			cookie,
			body: {},
		});
		expect([200, 202]).toContain(off.status);
		await wait_subject(
			cookie,
			'subject-turnos',
			(row) => row.installed === false && row.status !== 'uninstalling',
		);
		const after_off = await call('GET', '/auth/menus', { cookie });
		expect(after_off.status).toBe(200);
		const menus_off =
			(after_off.json?.menus as Record<string, unknown>[]) ?? [];
		const l1_off = menus_off
			.filter((m) => !m.parent_id)
			.map((m) => String(m.name ?? ''));
		expect(l1_off.includes('Turnos')).toBe(false);
		const blocked = await call('GET', '/ticketing-system-turn?limite=1', {
			cookie,
		});
		expect(blocked.status).toBe(404);
		expect(blocked.json?.code).toBe('subject_not_installed');
		expect(
			(blocked.json?.details as { slug?: string } | undefined)?.slug,
		).toBe('turnos');
		const models = ((
			after_off.json?.access_rights as Record<string, unknown>
		)?.models ?? []) as string[];
		expect(models).toContain('Pedidos');
		const on = await call('POST', '/subjects/subject-turnos/install', {
			cookie,
			body: {},
		});
		expect([200, 202]).toContain(on.status);
		await wait_subject(
			cookie,
			'subject-turnos',
			(row) => row.installed === true && row.busy !== true,
		);
		const notes = await call('GET', '/notifications/my-summary', { cookie });
		const unread =
			(
				(notes.json?.data as Array<{ unread_notifications?: Array<Record<string, unknown>> }>) ??
				[]
			)[0]?.unread_notifications ?? [];
		expect(
			unread.some(
				(item) =>
					item.type === 'background_job' ||
					(item.payload as { kind?: string } | undefined)?.kind ===
						'background_job',
			),
		).toBe(true);
		const after_on = await call('GET', '/auth/menus', { cookie });
		expect(after_on.status).toBe(200);
		const l1_on = (
			(after_on.json?.menus as Record<string, unknown>[]) ?? []
		)
			.filter((m) => !m.parent_id)
			.map((m) => String(m.name ?? ''));
		expect(l1_on.includes('Turnos')).toBe(true);
		const allowed = await call('GET', '/ticketing-system-turn?limite=1', {
			cookie,
		});
		expect(allowed.status).not.toBe(404);
		if (added.status === 201) {
			const removed = await call('DELETE', '/subjects/catalog/subject-turnos', {
				cookie,
			});
			expect(removed.status).toBe(200);
		}
	});

	test('una referencia acepta ids de app, no solo ObjectId de Mongo', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const res = await call('GET', '/lista-asistencia?limite=1', { cookie });
		expect(res.status).toBe(200);
		const ref = (
			res.json?.schema_validation as {
				properties?: Record<string, { pattern?: string; 'x-ref'?: string }>;
			}
		)?.properties?.registro_asistencia_id;
		expect(ref?.['x-ref']).toBeTruthy();
		expect(ref?.pattern).toBeUndefined();
	});

	test('GET /products schema uses catalog checkbox/number widgets; user list partial search', async () => {
		const login = await call('POST', '/auth/login', {
			body: { email: EMAIL, password: PASSWORD },
		});
		const cookie = sid_from(login.set_cookie);
		const products = await call('GET', '/products?limite=1', { cookie });
		expect(products.status).toBe(200);
		const props = (
			products.json?.schema_validation as {
				properties?: Record<
					string,
					{ type?: string; 'x-component'?: string }
				>;
			}
		)?.properties;
		expect(props?.puedoProducirlo?.type).toBe('boolean');
		expect(props?.puedoProducirlo?.['x-component']).toBe('input-checkbox');
		const users = await call('GET', '/user?termino=adm&limite=25', {
			cookie,
		});
		expect(users.status).toBe(200);
		expect(Array.isArray(users.json?.data)).toBe(true);
		expect(Number(users.json?.total_elementos ?? 0)).toBeGreaterThan(0);
	});
});
