/**
 * Credenciales efímeras de medios (contrato §6.4): TURN por REST con HMAC-SHA1, el token HS256
 * del servidor de medios (SFU) y su API de administración para imponer la moderación. Los
 * secretos solo vienen de variables de entorno, nunca de `configuration.value`, que no se
 * enmascara.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RoomRole } from './call-state.ts';

type Env = Record<string, string | undefined>;

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

const DEFAULT_TURN_TTL_S = 3600;
const SFU_TOKEN_TTL_S = 60;
const SFU_ADMIN_TTL_S = 60;
const SFU_ADMIN_TIMEOUT_MS = 5000;
const SFU_WEBHOOK_LEEWAY_S = 10;

function list(value: string | undefined): string[] {
	return (value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

export function turn_configured(env: Env = process.env): boolean {
	return list(env.IMPERIUM_TURN_URLS).length > 0 && Boolean(env.IMPERIUM_TURN_SECRET);
}

export function sfu_available(env: Env = process.env): boolean {
	return Boolean(env.IMPERIUM_SFU_URL && env.IMPERIUM_SFU_API_KEY && env.IMPERIUM_SFU_API_SECRET);
}

function turn_ttl_s(env: Env): number {
	const n = Number(env.IMPERIUM_TURN_TTL_SECONDS);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_TURN_TTL_S;
}

/** TURN REST: `username = <exp_unix>:<member_key>`, `credential = base64(HMAC-SHA1(secreto, username))`. */
export function turn_credentials(input: { secret: string; ttl_s: number; member_key: string; now: number }): {
	username: string;
	credential: string;
} {
	const username = `${Math.floor(input.now / 1000) + input.ttl_s}:${input.member_key}`;
	return { username, credential: createHmac('sha1', input.secret).update(username).digest('base64') };
}

/** STUN del parámetro y, si el entorno lo trae, TURN efímero para esa persona. */
export function ice_servers(input: { stun_urls: string[]; member_key: string; now: number; env?: Env }): {
	ice_servers: IceServer[];
	ttl_s: number;
} {
	const env = input.env ?? process.env;
	const ttl_s = turn_ttl_s(env);
	const servers: IceServer[] = input.stun_urls.length ? [{ urls: input.stun_urls }] : [];
	if (turn_configured(env)) {
		const credentials = turn_credentials({
			secret: env.IMPERIUM_TURN_SECRET!,
			ttl_s,
			member_key: input.member_key,
			now: input.now,
		});
		servers.push({ urls: list(env.IMPERIUM_TURN_URLS), ...credentials });
	}
	return { ice_servers: servers, ttl_s };
}

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sign_jwt(claims: Record<string, unknown>, secret: string): string {
	const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
	return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export type SfuSource = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio';

const PRESENTING = new Set<RoomRole>(['host', 'cohost', 'presenter']);

/**
 * Qué publica cada quien en el SFU: la misma política que `call:media` (contrato §9). En el
 * perfil clase solo publican el anfitrión, los coanfitriones y los presentadores; el resto, solo
 * audio y solo con la palabra.
 */
export function sfu_grants(input: {
	role: RoomRole;
	class_profile: boolean;
	has_floor: boolean;
	hard_muted: boolean;
	cams_allowed: boolean;
	screen_share: 'hosts' | 'all';
}): { can_publish: boolean; sources: SfuSource[] } {
	const sources: SfuSource[] = [];
	const presents = PRESENTING.has(input.role);
	if (presents || !input.class_profile) {
		if (input.cams_allowed) sources.push('camera');
		if (!input.hard_muted) sources.push('microphone');
		if (presents || input.screen_share === 'all') sources.push('screen_share', 'screen_share_audio');
	} else if (input.has_floor && !input.hard_muted) {
		sources.push('microphone');
	}
	return { can_publish: sources.length > 0, sources };
}

export function sfu_room(call_id: string): string {
	return `imperium-${call_id}`;
}

/**
 * Token de 60 s para entrar a la sala `imperium-<call_id>` del SFU: solo sirve para conectarse, y
 * un expulsado o movido no lo reusa para volver. Cada (re)conexión pide otro por `sfu-token`, que
 * revisa la sala. `leg_key` es
 * `<member_key>:<leg_id>`, único por pestaña; en modo clase quien no presenta llega sin
 * publicar o solo con micrófono. `null` si el SFU no está configurado.
 */
export function sfu_token(input: {
	call_id: string;
	leg_key: string;
	name: string;
	role: string;
	can_publish: boolean;
	sources: SfuSource[];
	now: number;
	env?: Env;
}): { url: string; token: string; expires_at: string } | null {
	const env = input.env ?? process.env;
	if (!sfu_available(env)) return null;
	const nbf = Math.floor(input.now / 1000);
	const exp = nbf + SFU_TOKEN_TTL_S;
	const token = sign_jwt(
		{
			iss: env.IMPERIUM_SFU_API_KEY,
			sub: input.leg_key,
			name: input.name,
			nbf,
			exp,
			video: {
				room: sfu_room(input.call_id),
				roomJoin: true,
				canSubscribe: true,
				canPublish: input.can_publish,
				canPublishData: true,
				canPublishSources: input.can_publish ? input.sources : [],
				roomAdmin: false,
			},
			// El servidor de medios espera la metadata como texto.
			metadata: JSON.stringify({ role: input.role }),
		},
		env.IMPERIUM_SFU_API_SECRET!,
	);
	return { url: env.IMPERIUM_SFU_URL!, token, expires_at: new Date(exp * 1000).toISOString() };
}

/** JWT de 60 s para la API de administración; borrar la sala pide `roomCreate`, lo demás `roomAdmin`. */
export function sfu_admin_token(input: { room: string; create?: boolean; now: number; env?: Env }): string | null {
	const env = input.env ?? process.env;
	if (!sfu_available(env)) return null;
	const nbf = Math.floor(input.now / 1000);
	const video = input.create ? { roomCreate: true } : { room: input.room, roomAdmin: true };
	return sign_jwt({ iss: env.IMPERIUM_SFU_API_KEY, nbf, exp: nbf + SFU_ADMIN_TTL_S, video }, env.IMPERIUM_SFU_API_SECRET!);
}

/**
 * El aviso del webhook del SFU (formato de LiveKit) si su firma vale: `Authorization` trae un JWT
 * HS256 firmado con el secreto de la API, emitido por su llave y vigente, cuyo `sha256` es el hash
 * en base64 del cuerpo tal cual llegó. `null` si algo no cuadra o no hay SFU.
 */
export function sfu_webhook_event(input: {
	body: string;
	authorization: string | null;
	now: number;
	env?: Env;
}): Record<string, unknown> | null {
	const env = input.env ?? process.env;
	if (!sfu_available(env)) return null;
	const [header, payload, signature, ...rest] = (input.authorization ?? '').split('.');
	if (!header || !payload || !signature || rest.length) return null;
	const expected = createHmac('sha256', env.IMPERIUM_SFU_API_SECRET!).update(`${header}.${payload}`).digest();
	const given = Buffer.from(signature, 'base64url');
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
	const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
	const now_s = input.now / 1000;
	if (claims.iss !== env.IMPERIUM_SFU_API_KEY || typeof claims.exp !== 'number' || claims.exp + SFU_WEBHOOK_LEEWAY_S < now_s) return null;
	if (typeof claims.nbf === 'number' && claims.nbf - SFU_WEBHOOK_LEEWAY_S > now_s) return null;
	const body_hash = createHash('sha256').update(input.body).digest();
	const claimed = Buffer.from(String(claims.sha256 ?? ''), 'base64');
	if (claimed.length !== body_hash.length || !timingSafeEqual(claimed, body_hash)) return null;
	const event = JSON.parse(input.body) as unknown;
	return event && typeof event === 'object' && !Array.isArray(event) ? (event as Record<string, unknown>) : null;
}

/** Fuentes del protocolo de administración, por nombre o por número. */
const TRACK_SOURCES: Record<string, SfuSource> = {
	CAMERA: 'camera',
	MICROPHONE: 'microphone',
	SCREEN_SHARE: 'screen_share',
	SCREEN_SHARE_AUDIO: 'screen_share_audio',
	'1': 'camera',
	'2': 'microphone',
	'3': 'screen_share',
	'4': 'screen_share_audio',
};

export type SfuTrack = { sid: string; source: SfuSource | null };

export type SfuAdmin = {
	/** Pistas publicadas de esa pata; `null` si ya no está en la sala. */
	tracks(room: string, identity: string): Promise<SfuTrack[] | null>;
	mute_track(room: string, identity: string, track_sid: string): Promise<void>;
	remove_participant(room: string, identity: string): Promise<void>;
	update_participant(
		room: string,
		identity: string,
		grants: { can_publish: boolean; sources: SfuSource[] },
		metadata: Record<string, unknown>,
	): Promise<void>;
	delete_room(room: string): Promise<void>;
};

class SfuAdminError extends Error {
	constructor(
		readonly method: string,
		readonly status: number,
		readonly code: string,
	) {
		super(`SFU ${method}: ${status} ${code}`);
	}
}

/**
 * Cliente Twirp de administración (JSON por POST). `null` sin SFU. Que la
 * pata o la sala ya no existan no es un error: el efecto buscado ya se cumplió.
 */
export function sfu_admin(opts: { env?: Env; fetch?: typeof fetch; now?: () => number } = {}): SfuAdmin | null {
	const env = opts.env ?? process.env;
	if (!sfu_available(env)) return null;
	const send = opts.fetch ?? fetch;
	const now = opts.now ?? Date.now;
	const base = env.IMPERIUM_SFU_URL!.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
	const rpc = async (method: string, body: Record<string, unknown>, room: string, create = false) => {
		const token = sfu_admin_token({ room, create, now: now(), env })!;
		const res = await send(`${base}/twirp/livekit.RoomService/${method}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(SFU_ADMIN_TIMEOUT_MS),
		});
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		if (!res.ok) throw new SfuAdminError(method, res.status, String(data.code ?? ''));
		return data;
	};
	const gone = (err: unknown) => err instanceof SfuAdminError && err.code === 'not_found';
	const ignore_gone = (err: unknown) => {
		if (!gone(err)) throw err;
	};
	return {
		async tracks(room, identity) {
			try {
				const data = await rpc('GetParticipant', { room, identity }, room);
				const tracks = Array.isArray(data.tracks) ? (data.tracks as Array<Record<string, unknown>>) : [];
				return tracks.map((track) => ({ sid: String(track.sid ?? ''), source: TRACK_SOURCES[String(track.source)] ?? null }));
			} catch (err) {
				if (gone(err)) return null;
				throw err;
			}
		},
		async mute_track(room, identity, track_sid) {
			await rpc('MutePublishedTrack', { room, identity, track_sid, muted: true }, room).catch(ignore_gone);
		},
		async remove_participant(room, identity) {
			await rpc('RemoveParticipant', { room, identity }, room).catch(ignore_gone);
		},
		async update_participant(room, identity, grants, metadata) {
			await rpc(
				'UpdateParticipant',
				{
					room,
					identity,
					metadata: JSON.stringify(metadata),
					permission: {
						can_subscribe: true,
						can_publish: grants.can_publish,
						can_publish_data: true,
						can_publish_sources: grants.sources.map((source) => source.toUpperCase()),
					},
				},
				room,
			).catch(ignore_gone);
		},
		async delete_room(room) {
			await rpc('DeleteRoom', { room }, room, true).catch(ignore_gone);
		},
	};
}
