import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load_configuration_parameter_seeds } from '../../../../backend/src/components/configuration/reconcile-configuration-seeds.ts';
import { handle_action } from './actions.ts';
import { chat_settings } from './chat-settings.ts';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

/** Contrato §7.1: nombre, tipo y valor por defecto exactos. */
const CONTRACT_PARAMS: Record<string, { type: string; value: unknown; name: string }> = {
	'configuration-calls-enabled': { type: 'checkbox', value: true, name: 'Activar llamadas y videollamadas' },
	'configuration-calls-mesh-max-participants': {
		type: 'number',
		value: 4,
		name: 'Participantes máximos en conexión directa',
	},
	'configuration-calls-class-max-participants': {
		type: 'number',
		value: 20,
		name: 'Participantes máximos en modo clase sin servidor de medios',
	},
	'configuration-calls-ring-timeout-seconds': {
		type: 'number',
		value: 45,
		name: 'Segundos de timbre antes de marcar perdida',
	},
	'configuration-calls-stun-urls': {
		type: 'text',
		value: 'stun:stun.cloudflare.com:3478',
		name: 'Servidores STUN (separados por coma)',
	},
	'configuration-meetings-guests-enabled': {
		type: 'checkbox',
		value: false,
		name: 'Permitir invitados sin cuenta en reuniones',
	},
	'configuration-meetings-recording-enabled': { type: 'checkbox', value: true, name: 'Permitir grabar reuniones' },
	'configuration-meetings-captions-cloud-allowed': {
		type: 'checkbox',
		value: false,
		name: 'Permitir subtítulos con el servicio de voz en la nube del navegador',
	},
	'configuration-chat-edit-window-minutes': { type: 'number', value: 15, name: 'Minutos para editar un mensaje' },
	'configuration-chat-delete-window-minutes': { type: 'number', value: 60, name: 'Minutos para borrar para todos' },
	'configuration-chat-stories-enabled': { type: 'checkbox', value: true, name: 'Activar historias' },
	'configuration-chat-ephemeral-enabled': { type: 'checkbox', value: false, name: 'Permitir mensajes temporales' },
	'configuration-chat-legal-hold': { type: 'checkbox', value: false, name: 'Retención legal del chat' },
	'configuration-chat-mass-mention-threshold': {
		type: 'number',
		value: 15,
		name: 'Miembros desde los que @todos pide confirmación',
	},
	'configuration-chat-live-features-max-members': {
		type: 'number',
		value: 20,
		name: 'Miembros máximos con escritura y acuses en vivo',
	},
	'configuration-chat-max-group-members': { type: 'number', value: 1024, name: 'Miembros máximos por grupo' },
	'configuration-chat-max-pinned-messages': { type: 'number', value: 5, name: 'Mensajes fijados por conversación' },
	'configuration-chat-max-upload-mb': { type: 'number', value: 50, name: 'Tamaño máximo por archivo del chat (MB)' },
};

/** Almacén con filas de `configuration` que cuenta las consultas. */
function config_store(values: Record<string, unknown>) {
	const queries: Array<{ resource: string; where?: Record<string, unknown> }> = [];
	const store = {
		queries,
		has: (resource: string) => resource === 'configuration' || resource === 'user',
		async find_many(resource: string, opts: { where?: Record<string, unknown> }) {
			queries.push({ resource, where: opts.where });
			const wanted = (opts.where?.ref as { in?: string[] } | undefined)?.in ?? [];
			const rows = Object.entries(values)
				.filter(([ref]) => wanted.includes(ref))
				.map(([ref, value], i) => ({ _id: `cfg-${i}`, _ref: ref, value }));
			return { rows, total: rows.length };
		},
		async find_id(_resource: string, id: string) {
			return { _id: id, name: `Persona ${id}` };
		},
		inserted: [] as ImperiumDoc[],
		async insert(_resource: string, doc: ImperiumDoc) {
			const row = { ...doc, _id: `mensaje-${store.inserted.length + 1}` };
			store.inserted.push(row);
			return row;
		},
	};
	return store;
}

const settings_of = (values: Record<string, unknown>, now = 0) =>
	chat_settings(config_store(values) as unknown as ImperiumStore, now);

describe('semillas de los parámetros del chat', () => {
	const BACKEND_SRC = join(import.meta.dir, '../../../../backend/src');

	test('module.data y la copia JSON llevan los 18 del contrato con nombre, tipo y valor exactos', () => {
		const snapshot = JSON.parse(
			readFileSync(join(import.meta.dir, 'configuration-parameter-seeds.json'), 'utf8'),
		) as ImperiumDoc[];
		for (const seeds of [load_configuration_parameter_seeds(BACKEND_SRC), snapshot]) {
			for (const [ref, expected] of Object.entries(CONTRACT_PARAMS)) {
				const seed = seeds.find((row) => row._ref === ref);
				expect({ ref, ...seed }).toMatchObject({ ref, ...expected, is_system: true, module_id: 'NA' });
			}
		}
		expect(Object.keys(CONTRACT_PARAMS)).toHaveLength(18);
	});
});

describe('chat_settings', () => {
	test('sin la tabla de parámetros usa los valores del contrato', async () => {
		const store = { has: () => false } as unknown as ImperiumStore;
		expect(await chat_settings(store, 0)).toEqual({
			messaging_enabled: true,
			calls_enabled: true,
			mesh_max: 4,
			class_max: 20,
			ring_timeout_seconds: 45,
			stun_urls: ['stun:stun.cloudflare.com:3478'],
			guests_enabled: false,
			recording_enabled: true,
			captions_cloud_allowed: false,
			edit_window_minutes: 15,
			delete_for_all_window_minutes: 60,
			stories_enabled: true,
			ephemeral_enabled: false,
			legal_hold: false,
			mass_mention_threshold: 15,
			live_features_max_members: 20,
			max_group_members: 1024,
			max_pinned_messages: 5,
			max_upload_mb: 50,
		});
	});

	test('lee los 19 parámetros en una sola consulta y la memoriza 30 s', async () => {
		const store = config_store({ 'configuration-chat-max-upload-mb': 25 });
		const typed = store as unknown as ImperiumStore;
		expect((await chat_settings(typed, 1_000)).max_upload_mb).toBe(25);
		expect((await chat_settings(typed, 30_999)).max_upload_mb).toBe(25);
		expect(store.queries).toHaveLength(1);
		const refs = (store.queries[0]?.where?.ref as { in: string[] }).in;
		expect([...refs].sort()).toEqual(
			[...Object.keys(CONTRACT_PARAMS), 'configuration-messaging-enabled'].sort(),
		);
		await chat_settings(typed, 31_000);
		expect(store.queries).toHaveLength(2);
	});

	test('cada almacén tiene su memoria', async () => {
		expect((await settings_of({ 'configuration-chat-legal-hold': true })).legal_hold).toBe(true);
		expect((await settings_of({ 'configuration-chat-legal-hold': false })).legal_hold).toBe(false);
	});

	test('acepta el valor guardado como texto JSON o envuelto en comillas', async () => {
		const settings = await settings_of({
			'configuration-messaging-enabled': 'false',
			'configuration-calls-enabled': '"false"',
			'configuration-chat-stories-enabled': 0,
			'configuration-meetings-guests-enabled': 'true',
			'configuration-chat-max-group-members': '"300"',
			'configuration-calls-ring-timeout-seconds': '30',
			'configuration-calls-stun-urls': '"stun:a.example:3478, stun:b.example:3478 ,"',
		});
		expect(settings).toMatchObject({
			messaging_enabled: false,
			calls_enabled: false,
			stories_enabled: false,
			guests_enabled: true,
			max_group_members: 300,
			ring_timeout_seconds: 30,
			stun_urls: ['stun:a.example:3478', 'stun:b.example:3478'],
		});
	});

	test('0 en las ventanas de edición y borrado es sin límite; en los demás cae al valor por defecto', async () => {
		const settings = await settings_of({
			'configuration-chat-edit-window-minutes': 0,
			'configuration-chat-delete-window-minutes': '0',
			'configuration-chat-max-pinned-messages': 0,
			'configuration-calls-ring-timeout-seconds': '0',
			'configuration-chat-max-upload-mb': -5,
			'configuration-chat-mass-mention-threshold': 'muchos',
		});
		expect(settings).toMatchObject({
			edit_window_minutes: null,
			delete_for_all_window_minutes: null,
			max_pinned_messages: 5,
			ring_timeout_seconds: 45,
			max_upload_mb: 50,
			mass_mention_threshold: 15,
		});
	});

	test('vacío no es 0: una ventana sin valor conserva su valor por defecto', async () => {
		const settings = await settings_of({
			'configuration-chat-edit-window-minutes': '',
			'configuration-chat-delete-window-minutes': null,
		});
		expect(settings.edit_window_minutes).toBe(15);
		expect(settings.delete_for_all_window_minutes).toBe(60);
	});

	test('la conexión directa se acota a 2–6 participantes', async () => {
		expect((await settings_of({ 'configuration-calls-mesh-max-participants': 12 })).mesh_max).toBe(6);
		expect((await settings_of({ 'configuration-calls-mesh-max-participants': 1 })).mesh_max).toBe(2);
		expect((await settings_of({ 'configuration-calls-mesh-max-participants': '5' })).mesh_max).toBe(5);
	});

	test('sin servidores STUN capturados la lista queda vacía', async () => {
		expect((await settings_of({ 'configuration-calls-stun-urls': '' })).stun_urls).toEqual([]);
	});
});

describe('envío del chat con la mensajería apagada', () => {
	function send(store: ReturnType<typeof config_store>, sender: string) {
		const url = new URL('http://core/api/messages/chat');
		const req = new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ recipient_user_id: 'destino', message: 'hola' }),
		});
		return handle_action(
			store as unknown as ImperiumStore,
			{} as Bun.SQL,
			req,
			url,
			'messages',
			'create_chat_message',
			{},
			{ _id: sender, name: 'Ana' },
		);
	}

	test('responde 403 messaging_disabled y no guarda nada', async () => {
		const store = config_store({ 'configuration-messaging-enabled': '"false"' });
		await expect(send(store, 'apagada')).rejects.toMatchObject({
			status: 403,
			code: 'messaging_disabled',
			message: 'El chat está desactivado en esta organización.',
		});
		expect(store.inserted).toEqual([]);
	});
});
