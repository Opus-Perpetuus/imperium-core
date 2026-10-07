/**
 * Autorización y fugas del chat contra Postgres real (`DATABASE_URL`), por las acciones como las
 * llama el router. Ids aleatorios y limpieza al final: no debe dejar rastro.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { handle_action } from './actions.ts';
import type { ImperiumDoc } from './envelope.ts';
import { outside_history_context } from './history.ts';
import { ImperiumStore, load_catalog_path } from './store.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const store = sql ? new ImperiumStore(sql, load_catalog_path()) : null;

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);
const tag = hex_id().slice(0, 6);
const created: Record<string, string[]> = {};
const conversations: string[] = [];
const users: string[] = [];

function track(resource: string, id: string): string {
	(created[resource] ??= []).push(id);
	return id;
}

type Res = { status: number; code?: string; body: { data: ImperiumDoc[] } & Record<string, unknown> };

async function act(
	actor: ImperiumDoc,
	resource: string,
	action: string,
	init: { method?: string; path?: string; params?: Record<string, string>; json?: unknown } = {},
): Promise<Res> {
	const url = new URL(`http://core/api/${resource}${init.path ?? ''}`);
	const req = new Request(url, {
		method: init.method ?? (init.json === undefined ? 'GET' : 'POST'),
		headers: init.json === undefined ? undefined : { 'content-type': 'application/json' },
		body: init.json === undefined ? undefined : JSON.stringify(init.json),
	});
	try {
		const res = await handle_action(store!, sql!, req, url, resource, action, init.params ?? {}, actor);
		const body = JSON.parse(await res.text()) as Res['body'];
		return { status: res.status, code: body.code as string | undefined, body };
	} catch (err) {
		const e = err as { status?: number; code?: string };
		return { status: e.status ?? 500, code: e.code, body: { data: [] } };
	}
}

type User = { _id: string; name: string; email: string };

async function mk_user(name: string): Promise<User> {
	const user = { _id: hex_id(), name: `${name} ${tag}`, email: `${name.toLowerCase()}.${tag}@empresa.test` };
	await sql!.unsafe(
		`INSERT INTO ${store!.qt('user')} (id, name, is_active, email, payload, created_at, updated_at)
		 VALUES ($1, $2, true, $3, '{}'::jsonb, $4, $4)`,
		[user._id, user.name, user.email, new Date().toISOString()],
	);
	users.push(track('user', user._id));
	return user;
}

/** Quien tiene el menú de administración: acceso total a los modelos. */
function as_admin(user: ImperiumDoc): ImperiumDoc {
	return { ...user, _ref: 'user-menu-management-0' };
}

async function mk_group(owner: ImperiumDoc, member_ids: string[], extra: Record<string, unknown> = {}): Promise<string> {
	const res = await act(owner, 'chat-conversations', 'create_group_conversation', {
		path: '/group',
		json: { title: `Grupo ${tag}`, member_ids, ...extra },
	});
	expect(res.status).toBe(200);
	const id = String(res.body.data[0]!._id);
	conversations.push(id);
	return id;
}

async function self_chat(user: ImperiumDoc): Promise<string> {
	const res = await act(user, 'chat-conversations', 'open_direct_conversation', { path: '/direct', json: { user_id: user._id } });
	expect(res.status).toBe(200);
	const id = String(res.body.data[0]!._id);
	conversations.push(id);
	return id;
}

async function send(actor: ImperiumDoc, conversation_id: string, payload: Record<string, unknown>): Promise<Res> {
	return act(actor, 'messages', 'create_chat_message', {
		path: '/chat',
		json: { conversation_id, client_id: crypto.randomUUID(), ...payload },
	});
}

afterAll(async () => {
	if (!sql || !store) return;
	const ids = [...new Set(conversations)];
	if (ids.length) {
		for (const resource of ['messages', 'chat-members', 'chat-reactions', 'chat-audit'] as const) {
			await sql.unsafe(
				`DELETE FROM ${store.qt(resource)} WHERE conversation_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
				[ids],
			);
		}
		await sql.unsafe(
			`DELETE FROM ${store.qt('chat-conversations')} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[ids],
		);
	}
	if (users.length) {
		await sql.unsafe(
			`DELETE FROM ${store.qt('mentions')} WHERE payload ->> 'mentionedUserId' IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[users],
		);
		await sql.unsafe(
			`DELETE FROM ${store.qt('notifications')} WHERE payload ->> 'recipientId' IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[users],
		);
		await sql.unsafe(
			`DELETE FROM ${store.qt('attachment-management')} WHERE created_by_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			[users],
		);
	}
	for (const [resource, rows] of Object.entries(created)) {
		await sql.unsafe(`DELETE FROM ${store.qt(resource)} WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, [rows]);
	}
	await sql.close();
}, 60_000);

describe.skipIf(!sql)('chat: autorización y fugas', () => {
	beforeAll(async () => {
		await store!.ensure_orphan_tables();
		await store!.ensure_unique_indexes();
	}, 180_000);

	test('la tarjeta de un registro no lee filas del chat, ni siquiera como administrador', async () => {
		const ana = await mk_user('AnaTarjeta');
		const self = await self_chat(ana);
		const attachment = await outside_history_context(() =>
			store!.insert('attachment-management', {
				name: `nomina-confidencial-${tag}.pdf`,
				name_stored: `${hex_id()}.pdf`,
				related_model: 'Message',
				related_record_id: hex_id(),
				created_by_id: hex_id(),
			}),
		);
		track('attachment-management', String(attachment._id));
		const res = await send(as_admin(ana), self, {
			record_ref: { model_name: 'attachment-management', document_id: String(attachment._id), route: '/internal/adjuntos' },
		});
		expect([res.status, res.code]).toEqual([422, 'invalid_request']);
	});

	test('la ruta de la tarjeta solo lleva a pantallas internas de esta app', async () => {
		const ana = await mk_user('AnaRuta');
		const self = await self_chat(ana);
		const card = (route: string) =>
			send(as_admin(ana), self, { record_ref: { model_name: 'user', document_id: ana._id, route } });
		for (const route of [
			'/\\evil.example/login',
			'/\t/evil.example/login',
			'/\n/evil.example/login',
			'/\\/evil.example/login',
			'//evil.example',
			'https://evil.example',
			'javascript:alert(1)',
			'/otra-app/login',
			'/internal/x\\y',
		]) {
			expect([route, (await card(route)).code]).toEqual([route, 'invalid_request']);
		}
		const ok = await card('/internal/user/detail/x?tab=1');
		expect(ok.status).toBe(200);
		expect(ok.body.data[0]!.record_card).toMatchObject({ route: '/internal/user/detail/x?tab=1' });
	});

	async function invite_of(actor: ImperiumDoc, id: string): Promise<string> {
		const res = await act(actor, 'chat-conversations', 'create_conversation_invite', { path: `/${id}/invites`, params: { id }, json: {} });
		expect(res.status).toBe(200);
		return String(res.body.data[0]!.token);
	}

	const join = (actor: ImperiumDoc, token: string) =>
		act(actor, 'chat-conversations', 'join_conversation_by_invite', { path: `/invite/${token}/join`, params: { token }, json: {} });

	test('el enlace de un miembro deja de servir si lo banean, sale o ya no puede invitar', async () => {
		const [oscar, mia, lia, rita, xavi] = await Promise.all(['Oscar', 'Mia', 'Lia', 'Rita', 'Xavi'].map(mk_user));
		const id = await mk_group(oscar, [mia._id, lia._id, rita._id]);
		const [of_mia, of_lia, of_rita] = await Promise.all([invite_of(mia, id), invite_of(lia, id), invite_of(rita, id)]);
		const ban = await act(oscar, 'chat-conversations', 'remove_conversation_member', {
			method: 'DELETE',
			path: `/${id}/members/${mia._id}?ban=1`,
			params: { id, userId: mia._id },
		});
		expect(ban.status).toBe(200);
		expect((await act(lia, 'chat-conversations', 'leave_conversation', { path: `/${id}/leave`, params: { id }, json: {} })).status).toBe(200);
		expect([(await join(xavi, of_mia)).code, (await join(xavi, of_lia)).code]).toEqual(['invite_not_found', 'invite_not_found']);
		const off = await act(oscar, 'chat-conversations', 'update_conversation_info', {
			method: 'PATCH',
			path: `/${id}/info`,
			params: { id },
			json: { settings: { members_can_invite: false } },
		});
		expect(off.status).toBe(200);
		expect((await join(xavi, of_rita)).code).toBe('invite_not_found');
		const preview = (token: string) =>
			act(xavi, 'chat-conversations', 'read_conversation_invite', { path: `/invite/${token}`, params: { token } });
		expect([(await preview(of_mia)).code, (await preview(of_rita)).code]).toEqual(['invite_not_found', 'invite_not_found']);
		const xavi_rows = await sql!.unsafe(
			`SELECT state FROM ${store!.qt('chat-members')} WHERE conversation_id = $1 AND user_id = $2`,
			[id, xavi._id],
		);
		expect([...xavi_rows]).toEqual([]);
		const revoked = (await act(oscar, 'chat-conversations', 'read_conversation_detail', { path: `/${id}/detail`, params: { id } })).body
			.data[0]!.invites as ImperiumDoc[];
		const by = (user: ImperiumDoc) => revoked.find((invite) => (invite.created_by as ImperiumDoc)._id === user._id)!;
		expect([Boolean(by(mia).revoked_at), Boolean(by(lia).revoked_at), Boolean(by(rita).revoked_at)]).toEqual([true, true, false]);
	});

	test('en un canal, un miembro sin rol no renombra, invita, añade, fija ni llama por omisión', async () => {
		const [olivia, marco, xochitl] = await Promise.all([mk_user('Olivia'), mk_user('Marco'), mk_user('Xochitl')]);
		const id = await mk_group(olivia, [marco._id], { kind: 'channel' });
		const post = await send(olivia, id, { text: 'Comunicado oficial' });
		const post_id = String(post.body.data[0]!._id);
		expect(
			(await act(olivia, 'chat-conversations', 'pin_conversation_message', {
				path: `/${id}/pins`,
				params: { id },
				json: { message_id: post_id, duration: 'forever' },
			})).status,
		).toBe(200);
		const tries = await Promise.all([
			act(marco, 'chat-conversations', 'update_conversation_info', { method: 'PATCH', path: `/${id}/info`, params: { id }, json: { title: 'Comprometido' } }),
			act(marco, 'chat-conversations', 'create_conversation_invite', { path: `/${id}/invites`, params: { id }, json: {} }),
			act(marco, 'chat-conversations', 'add_conversation_members', { path: `/${id}/members`, params: { id }, json: { user_ids: [xochitl._id] } }),
			act(marco, 'chat-conversations', 'unpin_conversation_message', {
				method: 'DELETE',
				path: `/${id}/pins/${post_id}`,
				params: { id, messageId: post_id },
			}),
		]);
		expect(tries.map((res) => `${res.status}:${res.code}`)).toEqual(Array(4).fill('403:role_required'));
		const view = await act(marco, 'chat-conversations', 'read_conversation_summary', { path: `/${id}`, params: { id } });
		expect(view.body.data[0]!.settings).toMatchObject({
			announcement_only: true,
			members_can_invite: false,
			members_can_pin: false,
			members_can_edit_info: false,
			members_can_call: false,
			members_can_mention_all: false,
		});
	});

	test('quien está restringido, o un miembro de un grupo de solo anuncios, no edita lo suyo', async () => {
		const [omar, raul, meli] = await Promise.all([mk_user('Omar'), mk_user('Raul'), mk_user('Meli')]);
		const id = await mk_group(omar, [raul._id, meli._id], { settings: { members_can_mention_all: true } });
		const own_id = String((await send(raul, id, { text: 'hola' })).body.data[0]!._id);
		const edit = () =>
			act(raul, 'messages', 'edit_chat_message', {
				method: 'PATCH',
				path: `/message/${own_id}`,
				params: { id: own_id },
				json: { text: 'COMPRA YA http://phish.example [@todos](mention:all)', confirm_mass_mention: true },
			});
		const restrict = await act(omar, 'chat-conversations', 'update_conversation_member', {
			method: 'PATCH',
			path: `/${id}/members/${raul._id}`,
			params: { id, userId: raul._id },
			json: { restricted_until: new Date(Date.now() + 24 * 3600_000).toISOString() },
		});
		expect(restrict.status).toBe(200);
		expect(await edit()).toMatchObject({ status: 403, code: 'member_restricted' });
		await act(omar, 'chat-conversations', 'update_conversation_member', {
			method: 'PATCH',
			path: `/${id}/members/${raul._id}`,
			params: { id, userId: raul._id },
			json: { restricted_until: null },
		});
		await act(omar, 'chat-conversations', 'update_conversation_info', {
			method: 'PATCH',
			path: `/${id}/info`,
			params: { id },
			json: { settings: { announcement_only: true } },
		});
		expect(await edit()).toMatchObject({ status: 403, code: 'announcement_only' });
		const notified = await sql!.unsafe(
			`SELECT 1 FROM ${store!.qt('mentions')} WHERE payload ->> 'conversationId' = $1 AND payload ->> 'messageId' = $2`,
			[id, own_id],
		);
		expect([...notified]).toEqual([]);
	});

	test('las rutas heredadas no traen la respuesta de un cuestionario, el correo de quien envía ni campos internos', async () => {
		const [ari, beto] = await Promise.all([mk_user('Ari'), mk_user('Beto')]);
		const quiz = await act(ari, 'messages', 'create_chat_message', {
			path: '/chat',
			json: {
				recipient_user_id: beto._id,
				client_id: crypto.randomUUID(),
				poll: { question: '¿Capital de Australia?', options: ['Sídney', 'Melbourne', 'Canberra'], quiz: { correct_option_index: 2 } },
			},
		});
		expect(quiz.status).toBe(200);
		const message_id = String(quiz.body.data[0]!._id);
		conversations.push(String(quiz.body.data[0]!.conversation_id));
		const thread = await act(beto, 'messages', 'read_conversation', { path: `/conversation/${ari._id}`, params: { participantId: ari._id } });
		const inbox = await act(beto, 'messages', 'read_my_conversations', { path: '/conversations' });
		const docs = [
			thread.body.data.find((row) => String(row._id) === message_id)!,
			inbox.body.data.find((row) => (row.latest_message as ImperiumDoc)?._id === message_id)!.latest_message as ImperiumDoc,
		];
		for (const doc of docs) {
			expect(JSON.stringify(doc)).not.toContain('correctOptionId');
			expect(doc).not.toHaveProperty('senderEmail');
			expect(doc).toMatchObject({ _id: message_id, senderUserId: ari._id, senderName: ari.name, conversationKey: expect.any(String) });
		}
	});

	test('un miembro sin rol recibe el mismo 403 al quitar a quien sea: no distingue bajas de desconocidos', async () => {
		const [olmo, mara, lino] = await Promise.all([mk_user('Olmo'), mk_user('Mara'), mk_user('Lino')]);
		const id = await mk_group(olmo, [mara._id, lino._id]);
		expect((await act(lino, 'chat-conversations', 'leave_conversation', { path: `/${id}/leave`, params: { id }, json: {} })).status).toBe(200);
		const outcomes = [];
		for (const target of [hex_id(), lino._id, olmo._id]) {
			const res = await act(mara, 'chat-conversations', 'remove_conversation_member', {
				method: 'DELETE',
				path: `/${id}/members/${target}?ban=1`,
				params: { id, userId: target },
			});
			outcomes.push(`${res.status}:${res.code}`);
		}
		expect(outcomes).toEqual(Array(3).fill('403:role_required'));
	});

	test('la Actividad de quien ya no es miembro muestra el título que tenía el grupo, no el vigente', async () => {
		const [olga, memo] = await Promise.all([mk_user('OlgaA'), mk_user('MemoA')]);
		const id = await mk_group(olga, [memo._id], { title: `Equipo ${tag}` });
		await send(olga, id, { text: `hola [@Memo](mention:${memo._id})` });
		const title_of = async () => {
			const activity = await act(memo, 'notifications', 'read_my_mentions', { path: '/my-mentions' });
			const item = activity.body.data.find((row) => (row.chat as ImperiumDoc | undefined)?.conversation_id === id)!;
			return (item.chat as ImperiumDoc).conversation_title;
		};
		const rename = (title: string) =>
			act(olga, 'chat-conversations', 'update_conversation_info', { method: 'PATCH', path: `/${id}/info`, params: { id }, json: { title } });
		expect((await rename(`Equipo nuevo ${tag}`)).status).toBe(200);
		expect(await title_of()).toBe(`Equipo nuevo ${tag}`);
		await act(olga, 'chat-conversations', 'remove_conversation_member', {
			method: 'DELETE',
			path: `/${id}/members/${memo._id}`,
			params: { id, userId: memo._id },
		});
		expect((await rename(`Despidos marzo ${tag}`)).status).toBe(200);
		expect(await title_of()).toBe(`Equipo ${tag}`);
	});

	test('reenviar solo copia archivos que pertenecen al mensaje reenviado', async () => {
		const ana = await mk_user('AnaReenvio');
		const self = await self_chat(ana);
		const source_id = String((await send(ana, self, { text: 'con archivo' })).body.data[0]!._id);
		const foreign = await outside_history_context(() =>
			store!.insert('attachment-management', {
				name: `ajeno-${tag}.pdf`,
				name_stored: `${hex_id()}.pdf`,
				related_model: 'Message',
				related_record_id: hex_id(),
				created_by_id: hex_id(),
			}),
		);
		track('attachment-management', String(foreign._id));
		await sql!.unsafe(
			`UPDATE ${store!.qt('messages')} SET payload = jsonb_set(payload, '{attachments}', $2::jsonb) WHERE id = $1`,
			[source_id, [{ attachmentId: String(foreign._id), name: `ajeno-${tag}.pdf`, kind: 'file' }]],
		);
		const fwd = await act(ana, 'messages', 'forward_chat_messages', {
			path: '/forward',
			json: { message_ids: [source_id], conversation_ids: [self] },
		});
		expect([fwd.status, fwd.code]).toEqual([422, 'invalid_attachment']);
		const copies = await sql!.unsafe(
			`SELECT id FROM ${store!.qt('attachment-management')} WHERE name = $1 AND created_by_id = $2`,
			[`ajeno-${tag}.pdf`, ana._id],
		);
		expect([...copies]).toEqual([]);
	});

	test('el detalle no muestra un fijado que quien mira borró para sí', async () => {
		const [olga, memo] = await Promise.all([mk_user('OlgaPin'), mk_user('MemoPin')]);
		const id = await mk_group(olga, [memo._id]);
		const message_id = String((await send(olga, id, { text: 'fijado y borrado para mí' })).body.data[0]!._id);
		const pin = await act(olga, 'chat-conversations', 'pin_conversation_message', {
			path: `/${id}/pins`,
			params: { id },
			json: { message_id, duration: 'forever' },
		});
		expect(pin.status).toBe(200);
		const hide = await act(memo, 'messages', 'delete_chat_message', {
			method: 'DELETE',
			path: `/message/${message_id}?scope=me`,
			params: { id: message_id },
		});
		expect(hide.status).toBe(200);
		const pins_of = async (user: User) =>
			((await act(user, 'chat-conversations', 'read_conversation_detail', { path: `/${id}/detail`, params: { id } })).body.data[0]!
				.pins as ImperiumDoc[]).map((item) => item.message_id);
		expect(await pins_of(memo)).toEqual([]);
		expect(await pins_of(olga)).toEqual([message_id]);
	});
});
