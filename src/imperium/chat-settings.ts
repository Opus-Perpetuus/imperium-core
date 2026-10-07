/**
 * Parámetros del chat, las llamadas, las reuniones y las historias (contrato §7.1).
 * Se leen juntos en una consulta y se memorizan 30 s por almacén.
 */
import { cfg_bool, cfg_text } from './interinstance.ts';
import type { ImperiumStore } from './store.ts';

export type ChatSettings = {
	messaging_enabled: boolean;
	calls_enabled: boolean;
	mesh_max: number;
	class_max: number;
	ring_timeout_seconds: number;
	stun_urls: string[];
	guests_enabled: boolean;
	recording_enabled: boolean;
	captions_cloud_allowed: boolean;
	/** `null`: sin límite (el parámetro en 0). */
	edit_window_minutes: number | null;
	delete_for_all_window_minutes: number | null;
	stories_enabled: boolean;
	ephemeral_enabled: boolean;
	legal_hold: boolean;
	mass_mention_threshold: number;
	live_features_max_members: number;
	max_group_members: number;
	max_pinned_messages: number;
	max_upload_mb: number;
};

type Reader<T> = (value: unknown) => T;

/** Entero del parámetro. Vacío no es 0: `cfg_num` no sirve porque rechaza el 0. */
function whole_number(value: unknown): number | null {
	const text = cfg_text(value);
	const n = typeof value === 'number' ? value : text === '' ? Number.NaN : Number(text);
	return Number.isFinite(n) ? Math.floor(n) : null;
}

const flag =
	(fallback: boolean): Reader<boolean> =>
	(value) =>
		cfg_bool(value, fallback);

const positive =
	(fallback: number): Reader<number> =>
	(value) => {
		const n = whole_number(value);
		return n !== null && n > 0 ? n : fallback;
	};

const clamped =
	(fallback: number, min: number, max: number): Reader<number> =>
	(value) => {
		const n = whole_number(value);
		return n === null ? fallback : Math.min(max, Math.max(min, n));
	};

const window_minutes =
	(fallback: number): Reader<number | null> =>
	(value) => {
		const n = whole_number(value);
		if (n === null || n < 0) return fallback;
		return n === 0 ? null : n;
	};

const url_list =
	(fallback: string[]): Reader<string[]> =>
	(value) =>
		value === undefined
			? fallback
			: cfg_text(value)
					.split(',')
					.map((url) => url.trim())
					.filter(Boolean);

const PARAMS: { [K in keyof ChatSettings]: [ref: string, read: Reader<ChatSettings[K]>] } = {
	messaging_enabled: ['configuration-messaging-enabled', flag(true)],
	calls_enabled: ['configuration-calls-enabled', flag(true)],
	mesh_max: ['configuration-calls-mesh-max-participants', clamped(4, 2, 6)],
	class_max: ['configuration-calls-class-max-participants', positive(20)],
	ring_timeout_seconds: ['configuration-calls-ring-timeout-seconds', positive(45)],
	stun_urls: ['configuration-calls-stun-urls', url_list(['stun:stun.cloudflare.com:3478'])],
	guests_enabled: ['configuration-meetings-guests-enabled', flag(false)],
	recording_enabled: ['configuration-meetings-recording-enabled', flag(true)],
	captions_cloud_allowed: ['configuration-meetings-captions-cloud-allowed', flag(false)],
	edit_window_minutes: ['configuration-chat-edit-window-minutes', window_minutes(15)],
	delete_for_all_window_minutes: ['configuration-chat-delete-window-minutes', window_minutes(60)],
	stories_enabled: ['configuration-chat-stories-enabled', flag(true)],
	ephemeral_enabled: ['configuration-chat-ephemeral-enabled', flag(false)],
	legal_hold: ['configuration-chat-legal-hold', flag(false)],
	mass_mention_threshold: ['configuration-chat-mass-mention-threshold', positive(15)],
	live_features_max_members: ['configuration-chat-live-features-max-members', positive(20)],
	max_group_members: ['configuration-chat-max-group-members', positive(1024)],
	max_pinned_messages: ['configuration-chat-max-pinned-messages', positive(5)],
	max_upload_mb: ['configuration-chat-max-upload-mb', positive(50)],
};

const REFS = Object.values(PARAMS).map(([ref]) => ref);
const MEMO_MS = 30_000;
const memo = new WeakMap<object, { at: number; settings: ChatSettings }>();

export async function chat_settings(
	store: Pick<ImperiumStore, 'has' | 'find_many'>,
	now = Date.now(),
): Promise<ChatSettings> {
	const hit = memo.get(store);
	if (hit && now - hit.at < MEMO_MS) return hit.settings;
	const values = new Map<string, unknown>();
	if (store.has('configuration')) {
		const { rows } = await store.find_many('configuration', {
			where: { ref: { in: REFS } },
			include_inactive: true,
			sort: 'id:asc',
			take: 100,
			populate: false,
			skip_total: true,
		});
		// Como `find_where`: si un _ref se repite, gana la fila de id menor.
		for (const row of rows) {
			const ref = String(row._ref ?? '');
			if (!values.has(ref)) values.set(ref, row.value);
		}
	}
	const settings = Object.fromEntries(
		Object.entries(PARAMS).map(([key, [ref, read]]) => [key, read(values.get(ref))]),
	) as ChatSettings;
	memo.set(store, { at: now, settings });
	return settings;
}
