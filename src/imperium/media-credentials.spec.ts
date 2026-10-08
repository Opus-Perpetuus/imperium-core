import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
	ice_servers,
	sfu_admin,
	sfu_admin_token,
	sfu_available,
	sfu_grants,
	sfu_token,
	sfu_webhook_event,
	turn_configured,
	turn_credentials,
	type SfuSource,
} from './media-credentials.ts';

const NOW = Date.parse('2025-10-08T12:20:45.000Z');
const USER_KEY = 'u:0123456789abcdef01234567';
const TURN = {
	IMPERIUM_TURN_URLS: 'turn:turn.empresa.test:3478?transport=udp, turns:turn.empresa.test:5349',
	IMPERIUM_TURN_SECRET: 'turn-shared-secret',
};
const SFU = {
	IMPERIUM_SFU_URL: 'wss://sfu.empresa.test',
	IMPERIUM_SFU_API_KEY: 'APIkey',
	IMPERIUM_SFU_API_SECRET: 'sfu-api-secret',
};

describe('TURN por REST', () => {
	test('vector conocido: username con la caducidad y la clave; credencial HMAC-SHA1 en base64', () => {
		expect(turn_credentials({ secret: 'turn-shared-secret', ttl_s: 3600, member_key: USER_KEY, now: NOW })).toEqual({
			username: `1759929645:${USER_KEY}`,
			credential: 'rFUUq6E3+2bcboQAT/LtXQJ7VCY=',
		});
	});

	test('sin TURN solo STUN; con TURN, una entrada efímera con las URLs del entorno', () => {
		expect(ice_servers({ stun_urls: ['stun:stun.test:3478'], member_key: USER_KEY, now: NOW, env: {} })).toEqual({
			ice_servers: [{ urls: ['stun:stun.test:3478'] }],
			ttl_s: 3600,
		});
		const full = ice_servers({
			stun_urls: [],
			member_key: USER_KEY,
			now: NOW,
			env: { ...TURN, IMPERIUM_TURN_TTL_SECONDS: '600' },
		});
		expect(full.ttl_s).toBe(600);
		expect(full.ice_servers).toEqual([
			{
				urls: ['turn:turn.empresa.test:3478?transport=udp', 'turns:turn.empresa.test:5349'],
				...turn_credentials({ secret: TURN.IMPERIUM_TURN_SECRET, ttl_s: 600, member_key: USER_KEY, now: NOW }),
			},
		]);
		expect(JSON.stringify(full)).not.toContain(TURN.IMPERIUM_TURN_SECRET);
	});

	test('turn_configured exige URLs y secreto; una vida inválida vuelve a 3600', () => {
		expect(turn_configured({})).toBe(false);
		expect(turn_configured({ IMPERIUM_TURN_URLS: ' , ', IMPERIUM_TURN_SECRET: 's' })).toBe(false);
		expect(turn_configured(TURN)).toBe(true);
		expect(ice_servers({ stun_urls: [], member_key: USER_KEY, now: NOW, env: { IMPERIUM_TURN_TTL_SECONDS: '-5' } }).ttl_s).toBe(
			3600,
		);
	});
});

describe('token del servidor de medios', () => {
	const input = {
		call_id: 'c1',
		leg_key: `${USER_KEY}:leg-1`,
		name: 'Ana',
		role: 'participant',
		can_publish: true,
		sources: ['camera', 'microphone'] as Array<'camera' | 'microphone'>,
		now: NOW,
	};

	test('sin las tres variables no hay SFU ni token', () => {
		expect(sfu_available({ ...SFU, IMPERIUM_SFU_API_SECRET: '' })).toBe(false);
		expect(sfu_available(SFU)).toBe(true);
		expect(sfu_token({ ...input, env: {} })).toBeNull();
	});

	test('JWT HS256 verificable con el secreto, con la sala, la pata y 60 s de vida', () => {
		const issued = sfu_token({ ...input, env: SFU })!;
		expect(issued.url).toBe(SFU.IMPERIUM_SFU_URL);
		expect(issued.expires_at).toBe('2025-10-08T12:21:45.000Z');
		const [header, body, signature] = issued.token.split('.') as [string, string, string];
		const expected = createHmac('sha256', SFU.IMPERIUM_SFU_API_SECRET).update(`${header}.${body}`).digest('base64url');
		expect(signature).toBe(expected);
		expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
		expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual({
			iss: 'APIkey',
			sub: `${USER_KEY}:leg-1`,
			name: 'Ana',
			nbf: 1759926045,
			exp: 1759926105,
			video: {
				room: 'imperium-c1',
				roomJoin: true,
				canSubscribe: true,
				canPublish: true,
				canPublishData: true,
				canPublishSources: ['camera', 'microphone'],
				roomAdmin: false,
			},
			metadata: '{"role":"participant"}',
		});
		expect(issued.token).not.toContain(SFU.IMPERIUM_SFU_API_SECRET);
	});

	test('quien no publica entra sin fuentes', () => {
		const issued = sfu_token({ ...input, can_publish: false, env: SFU })!;
		const claims = JSON.parse(Buffer.from(issued.token.split('.')[1]!, 'base64url').toString());
		expect(claims.video).toMatchObject({ canPublish: false, canPublishSources: [] });
	});
});

const claims_of = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());

describe('qué publica cada rol en el servidor de medios', () => {
	const base = { class_profile: false, has_floor: false, hard_muted: false, cams_allowed: true, screen_share: 'all' as const };
	const ALL: SfuSource[] = ['camera', 'microphone', 'screen_share', 'screen_share_audio'];

	test('fuera de clase publica todos, con la misma política que la sala', () => {
		expect(sfu_grants({ ...base, role: 'participant' })).toEqual({ can_publish: true, sources: ALL });
		expect(sfu_grants({ ...base, role: 'guest', screen_share: 'hosts', cams_allowed: false }).sources).toEqual(['microphone']);
		expect(sfu_grants({ ...base, role: 'presenter', screen_share: 'hosts' }).sources).toEqual(ALL);
		expect(sfu_grants({ ...base, role: 'participant', hard_muted: true }).sources).not.toContain('microphone');
	});

	test('en clase solo publican anfitriones y presentadores; el alumno, solo audio y con la palabra', () => {
		const clase = { ...base, class_profile: true };
		for (const role of ['host', 'cohost', 'presenter'] as const) expect(sfu_grants({ ...clase, role }).sources).toEqual(ALL);
		for (const role of ['participant', 'guest'] as const) {
			expect(sfu_grants({ ...clase, role })).toEqual({ can_publish: false, sources: [] });
			expect(sfu_grants({ ...clase, role, has_floor: true })).toEqual({ can_publish: true, sources: ['microphone'] });
		}
		expect(sfu_grants({ ...clase, role: 'participant', has_floor: true, hard_muted: true }).can_publish).toBe(false);
	});
});

describe('administración del servidor de medios', () => {
	test('JWT de 60 s: roomAdmin de esa sala, o roomCreate para borrarla', () => {
		expect(sfu_admin_token({ room: 'imperium-c1', now: NOW, env: {} })).toBeNull();
		const admin = sfu_admin_token({ room: 'imperium-c1', now: NOW, env: SFU })!;
		const [header, body, signature] = admin.split('.') as [string, string, string];
		expect(signature).toBe(createHmac('sha256', SFU.IMPERIUM_SFU_API_SECRET).update(`${header}.${body}`).digest('base64url'));
		expect(claims_of(admin)).toEqual({
			iss: 'APIkey',
			nbf: 1759926045,
			exp: 1759926105,
			video: { room: 'imperium-c1', roomAdmin: true },
		});
		expect(claims_of(sfu_admin_token({ room: 'imperium-c1', create: true, now: NOW, env: SFU })!).video).toEqual({ roomCreate: true });
	});

	type Sent = { url: string; auth: string; body: Record<string, unknown> };
	function fake(reply: (method: string) => [number, unknown]) {
		const sent: Sent[] = [];
		const fetch_fake = (async (url: string, init: RequestInit) => {
			const headers = init.headers as Record<string, string>;
			sent.push({ url, auth: headers.authorization!, body: JSON.parse(String(init.body)) });
			const [status, data] = reply(url.split('/').at(-1)!);
			return new Response(JSON.stringify(data), { status });
		}) as unknown as typeof fetch;
		return { sent, admin: sfu_admin({ env: SFU, fetch: fetch_fake, now: () => NOW })! };
	}

	test('sin SFU no hay cliente', () => {
		expect(sfu_admin({ env: {} })).toBeNull();
	});

	test('Twirp por HTTPS con el JWT de administración y el cuerpo de cada método', async () => {
		const { sent, admin } = fake((method) =>
			method === 'GetParticipant'
				? [200, { identity: 'u:x:l', tracks: [{ sid: 'TR_a', source: 'MICROPHONE' }, { sid: 'TR_v', source: 1 }, { sid: 'TR_?', source: 0 }] }]
				: [200, {}],
		);
		expect(await admin.tracks('imperium-c1', 'u:x:l')).toEqual([
			{ sid: 'TR_a', source: 'microphone' },
			{ sid: 'TR_v', source: 'camera' },
			{ sid: 'TR_?', source: null },
		]);
		await admin.mute_track('imperium-c1', 'u:x:l', 'TR_a');
		await admin.remove_participant('imperium-c1', 'u:x:l');
		await admin.update_participant('imperium-c1', 'u:x:l', { can_publish: true, sources: ['microphone'] }, { role: 'participant' });
		await admin.delete_room('imperium-c1');
		expect(sent.map((item) => item.url)).toEqual(
			['GetParticipant', 'MutePublishedTrack', 'RemoveParticipant', 'UpdateParticipant', 'DeleteRoom'].map(
				(method) => `https://sfu.empresa.test/twirp/livekit.RoomService/${method}`,
			),
		);
		expect(sent.map((item) => item.body)).toEqual([
			{ room: 'imperium-c1', identity: 'u:x:l' },
			{ room: 'imperium-c1', identity: 'u:x:l', track_sid: 'TR_a', muted: true },
			{ room: 'imperium-c1', identity: 'u:x:l' },
			{
				room: 'imperium-c1',
				identity: 'u:x:l',
				metadata: '{"role":"participant"}',
				permission: { can_subscribe: true, can_publish: true, can_publish_data: true, can_publish_sources: ['MICROPHONE'] },
			},
			{ room: 'imperium-c1' },
		]);
		for (const item of sent.slice(0, 4)) {
			expect(claims_of(item.auth.replace('Bearer ', '')).video).toEqual({ room: 'imperium-c1', roomAdmin: true });
		}
		expect(claims_of(sent[4]!.auth.replace('Bearer ', '')).video).toEqual({ roomCreate: true });
	});

	test('que la pata o la sala ya no existan no es error; cualquier otro fallo sí', async () => {
		const { admin } = fake(() => [404, { code: 'not_found', msg: 'participant not found' }]);
		expect(await admin.tracks('imperium-c1', 'u:x:l')).toBeNull();
		await admin.remove_participant('imperium-c1', 'u:x:l');
		await admin.delete_room('imperium-c1');
		const broken = fake(() => [401, { code: 'unauthenticated', msg: 'invalid token' }]).admin;
		await expect(broken.remove_participant('imperium-c1', 'u:x:l')).rejects.toThrow('SFU RemoveParticipant: 401 unauthenticated');
	});
});

describe('webhook del SFU', () => {
	const body = JSON.stringify({ event: 'participant_joined', room: { name: 'imperium-c1' }, participant: { identity: 'u:x:l' } });
	const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const auth = (claims: Record<string, unknown>, secret = SFU.IMPERIUM_SFU_API_SECRET) => {
		const signed = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
		return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
	};
	const claims = (over: Record<string, unknown> = {}) => ({
		iss: SFU.IMPERIUM_SFU_API_KEY,
		nbf: NOW / 1000,
		exp: NOW / 1000 + 300,
		sha256: createHash('sha256').update(body).digest('base64'),
		...over,
	});
	const receive = (authorization: string | null, raw = body, env: Record<string, string> = SFU) =>
		sfu_webhook_event({ body: raw, authorization, now: NOW, env });

	test('con la firma de LiveKit devuelve el aviso', () => {
		expect(receive(auth(claims()))).toEqual(JSON.parse(body));
	});

	test('firma con otro secreto, otra llave, vencida, sin cabecera o sin SFU: nada', () => {
		expect(receive(auth(claims(), 'otro-secreto'))).toBeNull();
		expect(receive(auth(claims({ iss: 'otra-llave' })))).toBeNull();
		expect(receive(auth(claims({ exp: NOW / 1000 - 60 })))).toBeNull();
		expect(receive(auth(claims({ nbf: NOW / 1000 + 60 })))).toBeNull();
		expect(receive(null)).toBeNull();
		expect(receive(`Bearer ${auth(claims())}`)).toBeNull();
		expect(receive(auth(claims()), body, {})).toBeNull();
	});

	test('un cuerpo distinto del que se firmó no pasa', () => {
		expect(receive(auth(claims()), body.replace('u:x:l', 'u:y:l'))).toBeNull();
		expect(receive(auth(claims({ sha256: undefined })))).toBeNull();
	});
});
