import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { remember_socket_ip } from './auth-rate-limit.ts';
import type { ImperiumDoc } from './envelope.ts';
import { insert_notification, notification_summary } from './notifications.ts';
import { bind_socket_identity_resolver, handle_socket_io } from './socket-stub.ts';
import type { ImperiumStore } from './store.ts';

const POLLING = 'http://imperium.test/api/socket.io/?EIO=4&transport=polling';

const USERS: Record<string, string> = { 'sesion-ana': 'ana', 'sesion-beto': 'beto', 'sesion-dora': 'dora' };

bind_socket_identity_resolver(async (session_id) => USERS[session_id] ?? null);

/** Socket por polling identificado por cookie y ya conectado. */
async function socket_of(session_cookie: string): Promise<string> {
	const req = new Request(POLLING, { headers: { cookie: `connect.sid=${session_cookie}` } });
	remember_socket_ip(req, `198.51.100.${session_cookie.length}`);
	const open = await (handle_socket_io(req) as Response).text();
	const sid = (JSON.parse(open.slice(1)) as { sid: string }).sid;
	await handle_socket_io(new Request(`${POLLING}&sid=${sid}`, { method: 'POST', body: '40' }));
	expect(await poll(sid)).toStartWith('40');
	return sid;
}

/** Solo con algo ya encolado: un poll vacío espera el ping. */
async function poll(sid: string): Promise<string> {
	return ((await handle_socket_io(new Request(`${POLLING}&sid=${sid}`))) as Response).text();
}

function refreshes(body: string): Record<string, unknown>[] {
	return body
		.split('\x1e')
		.filter((packet) => packet.startsWith('42'))
		.map((packet) => JSON.parse(packet.slice(2)) as [string, { action: string; data: Record<string, unknown>[] }])
		.filter(([event, payload]) => event === 'update' && payload.action === 'notifications_refresh')
		.flatMap(([, payload]) => payload.data);
}

describe('notifications_refresh', () => {
	test('cada notificación nueva avisa a su destinatario, una vez por persona en la misma vuelta', async () => {
		const ana = await socket_of('sesion-ana');
		const beto = await socket_of('sesion-beto');
		let next = 0;
		const store = {
			insert: async (_resource: string, doc: ImperiumDoc) => ({ ...doc, _id: `n-${++next}` }),
		} as unknown as ImperiumStore;
		await Promise.all([
			insert_notification(store, { recipientId: 'ana', title: 'Uno' }),
			insert_notification(store, { recipientId: 'ana', title: 'Dos' }),
			insert_notification(store, { recipientId: 'beto', title: 'Tres' }),
		]);
		expect(refreshes(await poll(ana))).toEqual([
			{ recipient_id: 'ana', reason: 'notification_created', notification_ids: ['n-1', 'n-2'] },
		]);
		expect(refreshes(await poll(beto))).toEqual([
			{ recipient_id: 'beto', reason: 'notification_created', notification_ids: ['n-3'] },
		]);
	});

	test('las que una acción crea en serie, esperando la base entre una y otra, salen en un solo aviso', async () => {
		const ana = await socket_of('sesion-ana');
		let next = 0;
		const store = {
			insert: async (_resource: string, doc: ImperiumDoc) => {
				await Bun.sleep(0);
				return { ...doc, _id: `serie-${++next}` };
			},
		} as unknown as ImperiumStore;
		for (const title of ['Uno', 'Dos', 'Tres']) await insert_notification(store, { recipientId: 'ana', title });
		expect(refreshes(await poll(ana))).toEqual([
			{ recipient_id: 'ana', reason: 'notification_created', notification_ids: ['serie-1', 'serie-2', 'serie-3'] },
		]);
	});

	test('los recordatorios de /my-summary no se duplican ni avisan a quien ya los recibe en la respuesta', async () => {
		const dora = await socket_of('sesion-dora');
		await handle_socket_io(
			new Request(`${POLLING}&sid=${dora}`, { method: 'POST', body: `42${JSON.stringify(['joinRoom', 'subjects'])}` }),
		);
		const overdue = new Date(Date.now() - 60_000).toISOString();
		const tasks = Array.from({ length: 6 }, (_, i) => ({ _id: `tarea-${i}`, name: `Tarea ${i}`, due_date: overdue }));
		const reminders: ImperiumDoc[] = [];
		const store = {
			has: (resource: string) => resource === 'planeacion-mis-tareas' || resource === 'notifications',
			async *scan(resource: string) {
				await Bun.sleep(1);
				yield resource === 'notifications' ? [...reminders] : tasks;
			},
			insert: async (_resource: string, doc: ImperiumDoc) => {
				await Bun.sleep(1);
				const saved = { ...doc, _id: `recordatorio-${reminders.length + 1}` };
				reminders.push(saved);
				return saved;
			},
		} as unknown as ImperiumStore;
		const summary = async () => {
			const res = await notification_summary({
				store,
				sql: {} as Bun.SQL,
				url: new URL('http://core/api/notifications/my-summary'),
				params: {},
				actor: { _id: 'dora' },
				body: {},
			});
			return (res.data[0] as { unread_count: number }).unread_count;
		};
		expect(await Promise.all([summary(), summary()])).toEqual([6, 6]);
		expect(reminders.map((row) => (row.source as { documentId: string }).documentId).sort()).toEqual(
			tasks.map((task) => task._id),
		);
		await Bun.sleep(250);
		await handle_socket_io(new Request(`${POLLING}&sid=${dora}`, { method: 'POST', body: '2' }));
		const body = await poll(dora);
		expect(refreshes(body)).toEqual([]);
	});

	test('solo notifications.ts inserta notificaciones (background-job avisa por su cuenta)', () => {
		const dir = new URL('./', import.meta.url);
		const direct = readdirSync(dir)
			.filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
			.filter((file) => /\.insert\(\s*'notifications'/.test(readFileSync(new URL(file, dir), 'utf8')));
		expect(direct.sort()).toEqual(['background-job.ts', 'notifications.ts']);
	});
});
