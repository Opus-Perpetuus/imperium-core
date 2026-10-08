import { describe, expect, test } from 'bun:test';
import {
	admitted_guest,
	apply_room_command,
	BOARD_LIMITS,
	breakouts_view,
	flush_transcript,
	save_caption,
	TRANSCRIPT_FLUSH,
	attendance_camera,
	attendance_count,
	attendance_enter,
	attendance_exit,
	attendance_waited,
	DEFAULT_POLICY,
	flush_attendance,
	guest_admitted,
	guest_sessions_of_conversation,
	meeting_room_idle,
	open_meeting_room,
	room_state,
	run_room_command,
	sync_room_with_call,
	type BoardInput,
	type HostCommand,
	type RoomEvent,
	type RoomMember,
	type RoomResult,
	type RoomState,
} from './call-room.ts';
import type { RoomRole } from './call-state.ts';
import type { ImperiumDoc } from './envelope.ts';
import { sfu_grants } from './media-credentials.ts';

const hex_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

function member(input: Partial<RoomMember> & { leg_id: string }): RoomMember {
	return {
		member_key: `u:${input.leg_id}`,
		name: input.leg_id,
		role: 'participant',
		media: { mic: true, cam: false, screen: false, audio_only: false },
		hard_muted: false,
		speaker: false,
		session_id: `s-${input.leg_id}`,
		...input,
	};
}

function empty(call_id = 'c1'): RoomState {
	return {
		call_id,
		members: [],
		policy: { ...DEFAULT_POLICY, spotlight: [] },
		hands: [],
		admitted: [],
		lobby: [],
		blocked: [],
		entry: { muted: false, cams_off: false },
	};
}

function upserts(events: RoomEvent[]) {
	return events.flatMap((event) => (event.type === 'roster' ? (event.upsert ?? []) : []));
}

function ok(result: ReturnType<typeof apply_room_command>) {
	if (!result.ok) throw new Error(result.code);
	return result;
}

describe('apply_room_command', () => {
	test('adjuntarse suma al roster sin la sesión; al reconectar conserva lo anunciado y cambia de sesión', () => {
		const first = ok(apply_room_command(empty(), { type: 'attach', member: member({ leg_id: 'a' }) }));
		expect(first.room.members).toHaveLength(1);
		expect(first.events).toEqual([
			{
				type: 'roster',
				upsert: [
					{
						member_key: 'u:a',
						leg_id: 'a',
						name: 'a',
						role: 'participant',
						media: { mic: true, cam: false, screen: false, audio_only: false },
						hard_muted: false,
						speaker: false,
					},
				],
			},
		]);
		const muted = ok(
			apply_room_command(first.room, { type: 'media', leg_id: 'a', media: { mic: false, cam: true, screen: false, audio_only: false }, cam_stream_id: 'cam-1' }),
		);
		const again = ok(apply_room_command(muted.room, { type: 'attach', member: member({ leg_id: 'a', session_id: 's-nueva' }) }));
		expect(again.room.members).toEqual([
			{ ...member({ leg_id: 'a', session_id: 's-nueva' }), media: { mic: false, cam: true, screen: false, audio_only: false }, cam_stream_id: 'cam-1' },
		]);
	});

	test('soltar quita la pata y avisa; una pata que no está no cambia nada', () => {
		const room = ok(apply_room_command(empty(), { type: 'attach', member: member({ leg_id: 'a' }) })).room;
		const out = ok(apply_room_command(room, { type: 'detach', leg_id: 'a' }));
		expect(out.room.members).toEqual([]);
		expect(out.events).toEqual([{ type: 'roster', remove: ['a'] }]);
		const none = ok(apply_room_command(out.room, { type: 'detach', leg_id: 'a' }));
		expect(none.events).toEqual([]);
		expect(none.room).toBe(out.room);
	});

	test('medios: el silencio impuesto rechaza el micrófono; la política, la cámara y la pantalla', () => {
		const mic = { mic: true, cam: false, screen: false, audio_only: false };
		const room: RoomState = {
			...empty(),
			members: [member({ leg_id: 'm', hard_muted: true }), member({ leg_id: 'h', role: 'host' }), member({ leg_id: 'p' })],
			policy: { ...DEFAULT_POLICY, spotlight: [], cams_allowed: false, screen_share: 'hosts' },
		};
		expect(apply_room_command(room, { type: 'media', leg_id: 'm', media: mic })).toEqual({ ok: false, code: 'forbidden' });
		expect(ok(apply_room_command(room, { type: 'media', leg_id: 'm', media: { ...mic, mic: false } })).events).toHaveLength(1);
		expect(apply_room_command(room, { type: 'media', leg_id: 'p', media: { ...mic, cam: true } })).toEqual({ ok: false, code: 'forbidden' });
		expect(apply_room_command(room, { type: 'media', leg_id: 'p', media: { ...mic, screen: true } })).toEqual({
			ok: false,
			code: 'forbidden',
		});
		const shared = ok(apply_room_command(room, { type: 'media', leg_id: 'h', media: { ...mic, screen: true }, screen_stream_id: 'pantalla' }));
		expect(upserts(shared.events)[0]).toMatchObject({ leg_id: 'h', media: { screen: true }, screen_stream_id: 'pantalla' });
		expect(apply_room_command(room, { type: 'media', leg_id: 'nadie', media: mic })).toEqual({ ok: false, code: 'forbidden' });
	});

	test('un stream que se apaga deja de anunciarse', () => {
		const room = ok(
			apply_room_command(
				{ ...empty(), members: [member({ leg_id: 'a' })] },
				{ type: 'media', leg_id: 'a', media: { mic: true, cam: true, screen: false, audio_only: false }, cam_stream_id: 'cam' },
			),
		).room;
		const off = ok(apply_room_command(room, { type: 'media', leg_id: 'a', media: { mic: true, cam: false, screen: false, audio_only: false } }));
		expect(off.room.members[0]!.cam_stream_id).toBeUndefined();
	});
});

describe('salas guardadas', () => {
	test('la sala sigue a la llamada: sale quien ya no está unido con ese dispositivo y la terminada se cierra', () => {
		const call_id = hex_id();
		for (const leg_id of ['ana-tel', 'beto-pc', 'carla-pc']) {
			run_room_command(call_id, { type: 'attach', member: member({ leg_id, member_key: `u:${leg_id.split('-')[0]}` }) });
		}
		sync_room_with_call({
			_id: call_id,
			state: 'active',
			legs: [
				{ user_id: 'ana', state: 'joined', device: 'ana-tel' },
				{ user_id: 'beto', state: 'joined', device: 'beto-otro' },
				{ user_id: 'carla', state: 'left', device: 'carla-pc' },
			],
		});
		expect(room_state(call_id).members.map((item) => item.leg_id)).toEqual(['ana-tel']);
		sync_room_with_call({ _id: call_id, state: 'ended', legs: [] });
		expect(room_state(call_id).members).toEqual([]);
	});

	test('nadie está admitido en una reunión hasta que un anfitrión lo admite', () => {
		expect(guest_admitted(hex_id(), hex_id())).toBe(false);
	});
});

/** Una reunión con su anfitriona, una coanfitriona, un participante y una invitada adjuntos. */
function meeting(): RoomState {
	const people: Array<[string, RoomRole]> = [
		['u:ana', 'host'],
		['u:carla', 'cohost'],
		['u:beto', 'participant'],
		['g:inv', 'guest'],
	];
	return {
		...empty('m-call'),
		meeting_id: 'm1',
		conversation_id: 'conv-m',
		admitted: people.map(([member_key, role]) => ({ member_key, name: member_key, role, ...(role === 'guest' ? { guest: true as const } : {}) })),
		members: people.map(([member_key, role]) =>
			member({ leg_id: `${member_key}-leg`, member_key, role, ...(role === 'guest' ? { guest: true as const } : {}) }),
		),
		lobby: [
			{ member_key: 'g:espera', name: 'Espera', role: 'guest', guest: true, waiting_since: 1_000, reason: 'approval' },
			{ member_key: 'u:dario', name: 'Darío', role: 'participant', waiting_since: 4_000, reason: 'host' },
		],
	};
}

const host = (role: RoomRole, member_key = role === 'host' ? 'u:ana' : role === 'cohost' ? 'u:carla' : 'u:beto') => ({ member_key, role });

function order(room: RoomState, actor: { member_key: string; role: RoomRole }, command: HostCommand, visible_from_seq?: number): RoomResult {
	return apply_room_command(room, { type: 'host', actor, command, now: 10_000, visible_from_seq });
}

function done(result: RoomResult) {
	if (!result.ok) throw new Error(result.code);
	return result;
}

const commands = (events: RoomEvent[]) =>
	events.flatMap((event) => (event.type === 'command' ? [[event.member_key, event.kind] as const] : []));

describe('comandos de anfitrión', () => {
	test('cada comando exige anfitrión o coanfitrión; terminar y nombrar coanfitrión, solo el anfitrión', () => {
		const room = meeting();
		const all: HostCommand[] = [
			{ type: 'admit', member_key: 'g:espera' },
			{ type: 'admit_all' },
			{ type: 'deny', member_key: 'g:espera' },
			{ type: 'mute', member_key: 'u:beto' },
			{ type: 'mute_all', allow_unmute: false },
			{ type: 'allow_unmute' },
			{ type: 'cams_off' },
			{ type: 'kick', member_key: 'g:inv', block: true },
			{ type: 'lock', locked: true },
			{ type: 'grant_floor', member_key: 'u:beto' },
			{ type: 'lower_hand', member_key: 'u:beto' },
			{ type: 'lower_all_hands' },
			{ type: 'spotlight', member_keys: ['u:beto'] },
			{ type: 'captions', on: true },
			{ type: 'breakouts_close' },
			{ type: 'set_role', member_key: 'u:beto', role: 'presenter' },
			{ type: 'end' },
		];
		for (const role of ['participant', 'presenter', 'guest'] as RoomRole[]) {
			for (const command of all) expect(order(room, host(role, 'u:beto'), command)).toEqual({ ok: false, code: 'not_host' });
		}
		expect(order(room, host('cohost'), { type: 'end' })).toEqual({ ok: false, code: 'not_host' });
		expect(order(room, host('cohost'), { type: 'set_role', member_key: 'u:beto', role: 'cohost' })).toEqual({ ok: false, code: 'not_host' });
		expect(order(room, host('cohost'), { type: 'kick', member_key: 'u:ana', block: false })).toEqual({ ok: false, code: 'not_host' });
		expect(order(room, host('cohost'), { type: 'mute', member_key: 'u:ana' })).toEqual({ ok: false, code: 'not_host' });
		expect(done(order(room, host('host'), { type: 'end' })).events).toEqual([{ type: 'end' }]);
		const named = done(order(room, host('host'), { type: 'set_role', member_key: 'u:beto', role: 'cohost' }));
		expect(named.room.admitted.find((item) => item.member_key === 'u:beto')!.role).toBe('cohost');
		expect(named.room.members.find((item) => item.member_key === 'u:beto')!.role).toBe('cohost');
		expect(order(room, host('host'), { type: 'set_role', member_key: 'g:inv', role: 'cohost' })).toEqual({ ok: false, code: 'invalid_request' });
		const guest_presenter = done(order(room, host('cohost'), { type: 'set_role', member_key: 'g:inv', role: 'presenter' }));
		const back = done(order(guest_presenter.room, host('cohost'), { type: 'set_role', member_key: 'g:inv', role: 'participant' }));
		expect(back.room.admitted.find((item) => item.member_key === 'g:inv')!.role).toBe('guest');
	});

	test('admitir saca de la espera con lo que esperó; la invitada lee el chat desde ahí; rechazar deja el resultado', () => {
		const room = meeting();
		const one = done(order(room, host('cohost'), { type: 'admit', member_key: 'g:espera' }, 42));
		expect(one.room.lobby.map((item) => item.member_key)).toEqual(['u:dario']);
		expect(one.room.admitted.find((item) => item.member_key === 'g:espera')).toEqual({
			member_key: 'g:espera',
			name: 'Espera',
			role: 'guest',
			guest: true,
			visible_from_seq: 42,
		});
		expect(one.events).toContainEqual({ type: 'admitted', person: expect.objectContaining({ member_key: 'g:espera' }), waited_ms: 9_000 });
		expect(commands(one.events)).toEqual([['g:espera', 'admitted']]);
		expect(one.events.at(-1)).toEqual({ type: 'lobby' });
		const all = done(order(room, host('host'), { type: 'admit_all' }, 7));
		expect(all.room.lobby).toEqual([]);
		expect(all.room.admitted.find((item) => item.member_key === 'u:dario')!.visible_from_seq).toBeUndefined();
		const denied = done(order(room, host('host'), { type: 'deny', member_key: 'u:dario' }));
		expect(denied.events).toContainEqual({
			type: 'removed',
			member_key: 'u:dario',
			outcome: 'denied',
			legs: [],
			person: { member_key: 'u:dario', name: 'Darío', role: 'participant' },
		});
		expect(commands(denied.events)).toEqual([['u:dario', 'denied']]);
		expect(order(room, host('host'), { type: 'admit', member_key: 'g:nadie' })).toEqual({ ok: false, code: 'invalid_request' });
	});

	test('silenciar: sin permiso de reactivar el micrófono no vuelve; permitir reactivar lo libera', () => {
		const room = meeting();
		const soft = done(order(room, host('cohost'), { type: 'mute', member_key: 'u:beto' }));
		expect(soft.room.members.find((item) => item.member_key === 'u:beto')).toMatchObject({ media: { mic: false }, hard_muted: false });
		const all = done(order(room, host('host'), { type: 'mute_all', allow_unmute: false }));
		expect(all.room.policy.allow_unmute).toBe(false);
		expect(all.events[0]).toEqual({ type: 'policy' });
		expect(all.room.members.filter((item) => item.hard_muted).map((item) => item.member_key).sort()).toEqual(['g:inv', 'u:beto']);
		expect(all.room.members.find((item) => item.member_key === 'u:ana')!.media.mic).toBe(true);
		expect(commands(all.events).map(([key]) => key).sort()).toEqual(['g:inv', 'u:beto']);
		const mic = { mic: true, cam: false, screen: false, audio_only: false };
		expect(apply_room_command(all.room, { type: 'media', leg_id: 'u:beto-leg', media: mic })).toEqual({ ok: false, code: 'forbidden' });
		const freed = done(order(all.room, host('cohost'), { type: 'allow_unmute' }));
		expect(freed.room.members.some((item) => item.hard_muted)).toBe(false);
		expect(done(apply_room_command(freed.room, { type: 'media', leg_id: 'u:beto-leg', media: mic })).room.members).toHaveLength(4);
	});

	test('apagar cámaras: a una persona o a todos los que no moderan', () => {
		const room = meeting();
		room.members = room.members.map((item) => ({ ...item, media: { ...item.media, cam: true }, cam_stream_id: 'c' }));
		const one = done(order(room, host('host'), { type: 'cams_off', member_key: 'u:beto' }));
		expect(one.room.members.find((item) => item.member_key === 'u:beto')).toMatchObject({ media: { cam: false } });
		expect(one.room.members.find((item) => item.member_key === 'u:beto')!.cam_stream_id).toBeUndefined();
		const all = done(order(room, host('cohost'), { type: 'cams_off' }));
		expect(all.room.members.filter((item) => item.media.cam).map((item) => item.member_key).sort()).toEqual(['u:ana', 'u:carla']);
		expect(commands(all.events).map(([key]) => key).sort()).toEqual(['g:inv', 'u:beto']);
	});

	test('expulsar con bloqueo: sale de la sala y de la lista de admitidos, y no vuelve a entrar ni a esperar', () => {
		const room = meeting();
		const kicked = done(order(room, host('cohost'), { type: 'kick', member_key: 'g:inv', block: true }));
		expect(kicked.room.members.map((item) => item.member_key)).not.toContain('g:inv');
		expect(kicked.room.admitted.map((item) => item.member_key)).not.toContain('g:inv');
		expect(kicked.room.blocked).toEqual(['g:inv']);
		expect(commands(kicked.events)).toEqual([['g:inv', 'expelled']]);
		expect(kicked.events).toContainEqual({ type: 'roster', remove: ['g:inv-leg'] });
		const removed = kicked.events.find((event) => event.type === 'removed');
		expect(removed).toMatchObject({ outcome: 'expelled', legs: [expect.objectContaining({ leg_id: 'g:inv-leg' })] });
		const person = { member_key: 'g:inv', name: 'Otra vez', role: 'guest' as const, guest: true as const };
		expect(apply_room_command(kicked.room, { type: 'wait', person, reason: 'approval', now: 1 })).toEqual({ ok: false, code: 'forbidden' });
		expect(apply_room_command(kicked.room, { type: 'admit_direct', person })).toEqual({ ok: false, code: 'forbidden' });
		const soft = done(order(room, host('host'), { type: 'kick', member_key: 'u:beto', block: false }));
		expect(soft.room.blocked).toEqual([]);
		expect(done(apply_room_command(soft.room, { type: 'admit_direct', person: { member_key: 'u:beto', name: 'Beto', role: 'participant' } })).room.admitted.map((item) => item.member_key)).toContain('u:beto');
		expect(order(room, host('host'), { type: 'kick', member_key: 'u:ana', block: true })).toEqual({ ok: false, code: 'invalid_request' });
	});

	test('bloquear la reunión y dar la palabra: la política cambia y quien la tenía la pierde', () => {
		const room = meeting();
		expect(done(order(room, host('cohost'), { type: 'lock', locked: true })).room.policy.locked).toBe(true);
		const granted = done(order(room, host('host'), { type: 'grant_floor', member_key: 'u:beto' }));
		expect(granted.room.policy.floor).toBe('u:beto');
		expect(commands(granted.events)).toEqual([['u:beto', 'floor_granted']]);
		const moved = done(order(granted.room, host('cohost'), { type: 'grant_floor', member_key: 'g:inv' }));
		expect(commands(moved.events)).toEqual([
			['u:beto', 'floor_revoked'],
			['g:inv', 'floor_granted'],
		]);
		const revoked = done(order(moved.room, host('host'), { type: 'revoke_floor', member_key: 'g:inv' }));
		expect(revoked.room.policy.floor).toBeUndefined();
		expect(done(order(revoked.room, host('host'), { type: 'revoke_floor', member_key: 'g:inv' })).events).toEqual([]);
	});

	test('esperar: entra a la espera una vez; quien ya estaba admitido no espera', () => {
		const room = meeting();
		const person = { member_key: 'u:eva', name: 'Eva', role: 'participant' as const };
		const waiting = done(apply_room_command(room, { type: 'wait', person, reason: 'approval', now: 5 }));
		const again = done(apply_room_command(waiting.room, { type: 'wait', person, reason: 'host', now: 9 }));
		expect(again.room.lobby.filter((item) => item.member_key === 'u:eva')).toEqual([{ ...person, waiting_since: 5, reason: 'host' }]);
		expect(done(apply_room_command(room, { type: 'wait', person: { ...person, member_key: 'u:beto' }, reason: 'approval', now: 5 })).events).toEqual([]);
		const left = done(apply_room_command(waiting.room, { type: 'leave', member_key: 'u:eva' }));
		expect(left.room.lobby.map((item) => item.member_key)).not.toContain('u:eva');
	});
});

describe('salas de reunión guardadas', () => {
	test('un invitado solo alcanza la reunión que lo admitió y el chat de su conversación', () => {
		const call_id = hex_id();
		const meeting_id = hex_id();
		const other = hex_id();
		open_meeting_room({ call_id, meeting_id, conversation_id: 'conv-a', policy: {}, entry: { muted: true, cams_off: false }, blocked: ['g:vetada'] });
		run_room_command(call_id, { type: 'admit_direct', person: { member_key: 'g:inv', name: 'Inv', role: 'guest', guest: true, visible_from_seq: 3 } });
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'inv-leg', member_key: 'g:inv', role: 'guest', guest: true, session_id: 's-inv' }) });
		expect(guest_admitted(meeting_id, 'inv')).toBe(true);
		expect(guest_admitted(other, 'inv')).toBe(false);
		expect(admitted_guest(meeting_id, 'inv')).toMatchObject({ call_id, person: { visible_from_seq: 3 } });
		expect(guest_sessions_of_conversation('conv-a')).toEqual([{ session_id: 's-inv', visible_from_seq: 3 }]);
		expect(guest_sessions_of_conversation('conv-b')).toEqual([]);
		expect(room_state(call_id).entry).toEqual({ muted: true, cams_off: false });
		expect(run_room_command(call_id, { type: 'admit_direct', person: { member_key: 'g:vetada', name: 'V', role: 'guest', guest: true } })).toEqual({
			ok: false,
			code: 'forbidden',
		});
		sync_room_with_call({ _id: call_id, state: 'active', kind: 'meeting', legs: [] });
		expect(room_state(call_id).members.map((item) => item.member_key)).toEqual(['g:inv']);
		sync_room_with_call({ _id: call_id, state: 'ended', kind: 'meeting', legs: [] });
		expect(guest_admitted(meeting_id, 'inv')).toBe(false);
	});

	test('el silencio impuesto no se quita reconectando, y sin permiso de reactivar se entra silenciado', () => {
		const call_id = hex_id();
		open_meeting_room({ call_id, meeting_id: hex_id(), conversation_id: 'c', policy: { allow_unmute: false }, entry: { muted: false, cams_off: false }, blocked: [] });
		const unmute = (leg_id: string) => run_room_command(call_id, { type: 'media', leg_id, media: { mic: true, cam: false, screen: false, audio_only: false } }).ok;
		const leg = (leg_id: string) => room_state(call_id).members.find((item) => item.leg_id === leg_id)!;
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'h1', member_key: 'u:host', role: 'host' }) });
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'p1', member_key: 'u:p' }) });
		expect([leg('h1').hard_muted, leg('h1').media.mic]).toEqual([false, true]);
		expect([leg('p1').hard_muted, leg('p1').media.mic]).toEqual([true, false]);
		expect(unmute('p1')).toBe(false);

		run_room_command(call_id, { type: 'detach', leg_id: 'p1' });
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'p1', member_key: 'u:p' }) });
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'p2', member_key: 'u:p' }) });
		expect(unmute('p1')).toBe(false);
		expect(unmute('p2')).toBe(false);
		const grants = sfu_grants({ role: 'participant', class_profile: false, has_floor: false, hard_muted: leg('p2').hard_muted, cams_allowed: true, screen_share: 'hosts' });
		expect(grants.sources).not.toContain('microphone');

		// Un coanfitrión puede volver a permitir el micrófono por su cuenta: se le silencia, pero sin imponerlo.
		run_room_command(call_id, { type: 'admit_direct', person: { member_key: 'u:co', name: 'Co', role: 'cohost' } });
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'c1', member_key: 'u:co', role: 'cohost' }) });
		ok(run_room_command(call_id, { type: 'host', actor: { member_key: 'u:host', role: 'host' }, command: { type: 'mute', member_key: 'u:co' }, now: 1 }));
		expect([leg('c1').media.mic, leg('c1').hard_muted]).toEqual([false, false]);

		ok(run_room_command(call_id, { type: 'host', actor: { member_key: 'u:host', role: 'host' }, command: { type: 'allow_unmute' }, now: 1 }));
		expect(unmute('p2')).toBe(true);
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'p3', member_key: 'u:p' }) });
		expect(leg('p3').hard_muted).toBe(false);
	});

	test('vacía o solo con espera vieja, la sala está ociosa; con alguien adentro o esperando hace poco, no', () => {
		const call_id = hex_id();
		open_meeting_room({ call_id, meeting_id: hex_id(), conversation_id: 'c', policy: {}, entry: { muted: false, cams_off: false }, blocked: [] });
		expect(meeting_room_idle(call_id, 1_000, 600_000)).toBe(true);
		run_room_command(call_id, { type: 'wait', person: { member_key: 'g:x', name: 'X', role: 'guest', guest: true }, reason: 'approval', now: 1_000 });
		expect(meeting_room_idle(call_id, 2_000, 600_000)).toBe(false);
		expect(meeting_room_idle(call_id, 700_000, 600_000)).toBe(true);
		expect(meeting_room_idle(hex_id(), 0, 1)).toBe(true);
	});
});

describe('asistencia de la reunión', () => {
	test('intervalos por adjuntarse y soltarse, reconexión por red, espera, cámara y resultado; se escribe como diferencia', async () => {
		const writes: ImperiumDoc[] = [];
		const store = { upsert_call_attendance: async (input: ImperiumDoc) => (writes.push(input), input) };
		const call = { _id: hex_id(), meeting_id: 'm1' };
		const person = { member_key: 'g:ana', name: 'Ana', role: 'guest' as const, guest: true as const, visible_from_seq: 8 };
		attendance_waited(call._id, person, 30_000);
		attendance_enter(call._id, person, 'leg-1', 100_000, true);
		attendance_camera(call._id, 'g:ana', true, 100_000);
		attendance_exit(call._id, 'g:ana', 'leg-1', 160_000, 'network');
		await flush_attendance(store, call, { member_key: 'g:ana' });
		attendance_enter(call._id, person, 'leg-2', 170_000, false);
		await flush_attendance(store, call, { final: true, now: 200_000 });
		expect(writes).toHaveLength(2);
		expect(writes[0]).toMatchObject({
			call_id: call._id,
			meeting_id: 'm1',
			participant_key: 'g:ana',
			payload: {
				guestId: 'ana',
				displayName: 'Ana',
				role: 'guest',
				intervals: [{ in: new Date(100_000).toISOString(), out: new Date(160_000).toISOString(), reason: 'network' }],
				totalS: 60,
				waitedS: 30,
				reconnections: 0,
				cameraS: 60,
				recordingNoticeAt: new Date(100_000).toISOString(),
				visibleFromSeq: 8,
			},
		});
		expect(writes[1]!.payload).toMatchObject({ totalS: 30, waitedS: 0, reconnections: 1, cameraS: 0 });
		expect((writes[1]!.payload as ImperiumDoc).intervals).toEqual([{ in: new Date(170_000).toISOString(), out: new Date(200_000).toISOString() }]);
	});

	/** Cada escritura tarda: lo que se escribe a la vez o llega mientras tanto se ve en la suma. */
	function slow_store(fail_first = false) {
		const writes: ImperiumDoc[] = [];
		let calls = 0;
		const store = {
			upsert_call_attendance: async (input: ImperiumDoc) => {
				await Bun.sleep(20);
				if (fail_first && calls++ === 0) throw new Error('caída');
				writes.push(input.payload as ImperiumDoc);
				return input;
			},
		};
		const sum = (field: string) => writes.reduce((total, item) => total + Number(item[field] ?? 0), 0);
		const intervals = () => writes.flatMap((item) => item.intervals as unknown[]);
		return { store, writes, sum, intervals };
	}

	test('dos escrituras a la vez no cuentan dos veces lo pendiente ni pierden lo que llega mientras tanto', async () => {
		const person = { member_key: 'u:ana', name: 'Ana', role: 'participant' as const };
		const both = slow_store();
		const call = { _id: hex_id(), meeting_id: 'm1' };
		attendance_enter(call._id, person, 'leg-1', 0, false);
		attendance_exit(call._id, 'u:ana', 'leg-1', 60_000);
		await Promise.all([flush_attendance(both.store, call, { member_key: 'u:ana' }), flush_attendance(both.store, call, { final: true, now: 61_000 })]);
		expect([both.sum('totalS'), both.intervals().length]).toEqual([60, 1]);

		const during = slow_store();
		const other = { _id: hex_id(), meeting_id: 'm1' };
		attendance_enter(other._id, person, 'leg-1', 0, false);
		attendance_count(other._id, 'u:ana', 'hands');
		const writing = flush_attendance(during.store, other, { member_key: 'u:ana' });
		attendance_count(other._id, 'u:ana', 'hands');
		attendance_count(other._id, 'u:ana', 'reactions');
		await writing;
		await flush_attendance(during.store, other, { final: true, now: 120_000 });
		expect([during.sum('hands'), during.sum('reactions'), during.sum('totalS')]).toEqual([2, 1, 120]);
	});

	test('si la escritura falla, lo pendiente vuelve a la memoria y sale en la siguiente', async () => {
		const person = { member_key: 'u:ana', name: 'Ana', role: 'participant' as const };
		const flaky = slow_store(true);
		const call = { _id: hex_id(), meeting_id: 'm1' };
		attendance_enter(call._id, person, 'leg-1', 0, false);
		attendance_count(call._id, 'u:ana', 'hands');
		attendance_exit(call._id, 'u:ana', 'leg-1', 30_000);
		await expect(flush_attendance(flaky.store, call, { member_key: 'u:ana' })).rejects.toThrow('caída');
		attendance_count(call._id, 'u:ana', 'reactions');
		await flush_attendance(flaky.store, call, { final: true, now: 40_000 });
		expect([flaky.sum('hands'), flaky.sum('reactions'), flaky.sum('totalS'), flaky.intervals().length]).toEqual([1, 1, 30, 1]);
	});
});

describe('manos, señales y destacados', () => {
	const hand = (room: RoomState, leg_id: string, up: boolean, now: number) => done(apply_room_command(room, { type: 'hand', leg_id, up, now }));
	const queue = (room: RoomState) => room.hands.map((item) => [item.member_key, item.at]);

	test('la cola va por la hora del servidor; levantarla otra vez no cambia el turno; bajarla la quita del roster', () => {
		const room = meeting();
		const one = hand(room, 'g:inv-leg', true, 300);
		const two = hand(one.room, 'u:beto-leg', true, 200);
		expect(queue(two.room)).toEqual([
			['u:beto', 200],
			['g:inv', 300],
		]);
		expect(two.events).toContainEqual({ type: 'hands' });
		expect(two.events).toContainEqual({ type: 'hand_raised', member_key: 'u:beto' });
		expect(upserts(two.events)).toEqual([expect.objectContaining({ member_key: 'u:beto', hand_at: 200 })]);
		const again = hand(two.room, 'g:inv-leg', true, 900);
		expect(again.events).toEqual([]);
		expect(queue(again.room)).toEqual(queue(two.room));
		const down = hand(two.room, 'u:beto-leg', false, 999);
		expect(queue(down.room)).toEqual([['g:inv', 300]]);
		expect(upserts(down.events)[0]!.hand_at).toBeUndefined();
		expect(down.events.some((event) => event.type === 'hand_raised')).toBe(false);
		expect(apply_room_command(room, { type: 'hand', leg_id: 'nadie', up: true, now: 1 })).toEqual({ ok: false, code: 'forbidden' });
	});

	test('quien modera baja una mano o todas; dar la palabra la baja; salir, soltar la última pata o la expulsión la quitan', () => {
		const raised = hand(hand(meeting(), 'u:beto-leg', true, 1).room, 'g:inv-leg', true, 2).room;
		const one = done(order(raised, host('cohost'), { type: 'lower_hand', member_key: 'g:inv' }));
		expect(queue(one.room)).toEqual([['u:beto', 1]]);
		expect(one.events[0]).toEqual({ type: 'hands' });
		expect(done(order(raised, host('host'), { type: 'lower_hand', member_key: 'u:carla' })).events).toEqual([]);
		expect(done(order(raised, host('host'), { type: 'lower_all_hands' })).room.hands).toEqual([]);
		const floor = done(order(raised, host('host'), { type: 'grant_floor', member_key: 'u:beto' }));
		expect(queue(floor.room)).toEqual([['g:inv', 2]]);
		expect(floor.room.policy.floor).toBe('u:beto');
		const left = done(apply_room_command(raised, { type: 'leave', member_key: 'g:inv' }));
		expect(queue(left.room)).toEqual([['u:beto', 1]]);
		expect(left.events).toContainEqual({ type: 'hands' });
		const detached = done(apply_room_command(raised, { type: 'detach', leg_id: 'u:beto-leg' }));
		expect(queue(detached.room)).toEqual([['g:inv', 2]]);
		expect(detached.events).toEqual([{ type: 'roster', remove: ['u:beto-leg'] }, { type: 'hands' }]);
		const kicked = done(order(raised, host('host'), { type: 'kick', member_key: 'u:beto', block: false }));
		expect(queue(kicked.room)).toEqual([['g:inv', 2]]);
		expect(kicked.events).toContainEqual({ type: 'hands' });
	});

	test('con la mano arriba, otra pestaña que se adjunta la anuncia igual', () => {
		const raised = hand(meeting(), 'u:beto-leg', true, 7).room;
		const second = done(apply_room_command(raised, { type: 'attach', member: member({ leg_id: 'beto-2', member_key: 'u:beto' }) }));
		expect(upserts(second.events)).toEqual([expect.objectContaining({ leg_id: 'beto-2', hand_at: 7 })]);
	});

	test('las señales se quedan en el roster hasta cambiarlas o quitarlas', () => {
		const room = meeting();
		const yes = done(apply_room_command(room, { type: 'signal', leg_id: 'g:inv-leg', signal: 'si' }));
		expect(upserts(yes.events)).toEqual([expect.objectContaining({ member_key: 'g:inv', signal: 'si' })]);
		expect(done(apply_room_command(yes.room, { type: 'signal', leg_id: 'g:inv-leg', signal: 'si' })).events).toEqual([]);
		const cleared = done(apply_room_command(yes.room, { type: 'signal', leg_id: 'g:inv-leg', signal: null }));
		expect(upserts(cleared.events)[0]!.signal).toBeUndefined();
		expect(apply_room_command(room, { type: 'signal', leg_id: 'nadie', signal: 'no' })).toEqual({ ok: false, code: 'forbidden' });
	});

	test('destacar: solo personas admitidas, sin repetir y con tope; la expulsada deja de estar destacada', () => {
		const room = meeting();
		const spot = done(order(room, host('cohost'), { type: 'spotlight', member_keys: ['u:beto', 'g:inv', 'u:beto'] }));
		expect(spot.room.policy.spotlight).toEqual(['u:beto', 'g:inv']);
		expect(spot.events).toEqual([{ type: 'policy' }]);
		expect(order(room, host('host'), { type: 'spotlight', member_keys: ['u:nadie'] })).toEqual({ ok: false, code: 'invalid_request' });
		expect(order(room, host('host'), { type: 'spotlight', member_keys: Array.from({ length: 10 }, () => 'u:beto').map((key, i) => `${key}${i}`) })).toEqual({
			ok: false,
			code: 'invalid_request',
		});
		const kicked = done(order(spot.room, host('host'), { type: 'kick', member_key: 'g:inv', block: false }));
		expect(kicked.room.policy.spotlight).toEqual(['u:beto']);
		expect(kicked.events).toContainEqual({ type: 'policy' });
	});

	test('en una llamada de grupo destaca quien la inició, a quien tiene una pata en la sala', () => {
		const ana = member({ leg_id: 'ana-leg', member_key: 'u:ana', role: 'host' });
		const beto = member({ leg_id: 'beto-leg', member_key: 'u:beto' });
		const grupo = { ...empty(), members: [ana, beto] };
		const spot = done(order(grupo, host('host'), { type: 'spotlight', member_keys: ['u:beto'] }));
		expect(spot.room.policy.spotlight).toEqual(['u:beto']);
		expect(spot.events).toEqual([{ type: 'policy' }]);
		expect(order(grupo, host('participant'), { type: 'spotlight', member_keys: ['u:ana'] })).toEqual({ ok: false, code: 'not_host' });
		expect(order(grupo, host('host'), { type: 'spotlight', member_keys: ['u:nadie'] })).toEqual({ ok: false, code: 'invalid_request' });
	});

	test('en una llamada de grupo el destacado se quita cuando esa persona sale con su última pata', () => {
		const grupo = {
			...empty(),
			members: [
				member({ leg_id: 'ana-leg', member_key: 'u:ana', role: 'host' }),
				member({ leg_id: 'beto-tel', member_key: 'u:beto' }),
				member({ leg_id: 'beto-pc', member_key: 'u:beto' }),
			],
		};
		const spot = done(order(grupo, host('host'), { type: 'spotlight', member_keys: ['u:beto', 'u:ana'] })).room;
		const one_left = done(apply_room_command(spot, { type: 'detach', leg_id: 'beto-tel' }));
		expect(one_left.room.policy.spotlight).toEqual(['u:beto', 'u:ana']);
		expect(one_left.events).toEqual([{ type: 'roster', remove: ['beto-tel'] }]);
		const gone = done(apply_room_command(one_left.room, { type: 'detach', leg_id: 'beto-pc' }));
		expect(gone.room.policy.spotlight).toEqual(['u:ana']);
		expect(gone.events).toEqual([{ type: 'roster', remove: ['beto-pc'] }, { type: 'policy' }]);
	});

	test('en una reunión el destacado sigue aunque la persona pierda su pata: sigue admitida', () => {
		const room = done(order(meeting(), host('host'), { type: 'spotlight', member_keys: ['u:beto'] })).room;
		const detached = done(apply_room_command(room, { type: 'detach', leg_id: 'u:beto-leg' }));
		expect(detached.room.policy.spotlight).toEqual(['u:beto']);
		expect(detached.events).not.toContainEqual({ type: 'policy' });
	});

	test('quien sale de una llamada de grupo deja de estar destacado para todos', () => {
		const call_id = hex_id();
		for (const [leg_id, member_key, role] of [
			['ana-leg', 'u:ana', 'host'],
			['beto-leg', 'u:beto', 'participant'],
		] as const) {
			run_room_command(call_id, { type: 'attach', member: member({ leg_id, member_key, role }) });
		}
		run_room_command(call_id, { type: 'host', actor: { member_key: 'u:ana', role: 'host' }, command: { type: 'spotlight', member_keys: ['u:beto'] }, now: 1 });
		const legs = (beto: string) => [
			{ user_id: 'ana', state: 'joined', device: 'ana-leg' },
			{ user_id: 'beto', state: beto, device: 'beto-leg' },
		];
		sync_room_with_call({ _id: call_id, state: 'active', kind: 'group', legs: legs('joined') });
		expect(room_state(call_id).policy.spotlight).toEqual(['u:beto']);
		sync_room_with_call({ _id: call_id, state: 'active', kind: 'group', legs: legs('left') });
		expect(room_state(call_id).policy.spotlight).toEqual([]);
		sync_room_with_call({ _id: call_id, state: 'ended', kind: 'group', legs: legs('left') });
	});

	test('levantar la mano suma a la asistencia de esa persona; bajarla no', async () => {
		const writes: ImperiumDoc[] = [];
		const store = { upsert_call_attendance: async (input: ImperiumDoc) => (writes.push(input), input) };
		const call_id = hex_id();
		open_meeting_room({ call_id, meeting_id: 'm-manos', conversation_id: 'c', policy: {}, entry: { muted: false, cams_off: false }, blocked: [] });
		const person = { member_key: 'u:eli', name: 'Eli', role: 'participant' as const };
		run_room_command(call_id, { type: 'admit_direct', person });
		run_room_command(call_id, { type: 'attach', member: member({ leg_id: 'eli-leg', member_key: 'u:eli' }) });
		attendance_enter(call_id, person, 'eli-leg', 1_000, false);
		run_room_command(call_id, { type: 'hand', leg_id: 'eli-leg', up: true, now: 1 });
		run_room_command(call_id, { type: 'hand', leg_id: 'eli-leg', up: false, now: 2 });
		run_room_command(call_id, { type: 'hand', leg_id: 'eli-leg', up: true, now: 3 });
		await flush_attendance(store, { _id: call_id, meeting_id: 'm-manos' }, { final: true, now: 5_000 });
		expect(writes[0]!.payload).toMatchObject({ hands: 2 });
	});
});

describe('pizarra', () => {
	const stroke = (id: string) => ({ id, kind: 'trazo' as const, points: [[0.1, 0.2], [0.3, 0.4]] as Array<[number, number]>, color: 3, width: 2 });
	const draw = (room: RoomState, leg_id: string, op: BoardInput) => apply_room_command(room, { type: 'board', leg_id, op });

	test('cada trazo entra a la bitácora con autor y lugar; repetirlo no lo duplica; otro autor con el mismo id no pasa', () => {
		const room = meeting();
		const one = done(draw(room, 'u:beto-leg', stroke('t1')));
		expect(one.events).toEqual([{ type: 'board', op: { ...stroke('t1'), by: 'u:beto', seq: 1 } }]);
		expect(one.room.board).toMatchObject({ seq: 1, ops: [{ id: 't1', by: 'u:beto' }] });
		expect(one.room.board!.bytes).toBe(Buffer.byteLength(JSON.stringify({ ...stroke('t1'), by: 'u:beto', seq: 1 })));
		const again = done(draw(one.room, 'u:beto-leg', stroke('t1')));
		expect(again.events).toEqual([]);
		expect(draw(one.room, 'g:inv-leg', stroke('t1'))).toEqual({ ok: false, code: 'invalid_request' });
		expect(draw(room, 'nadie', stroke('t9'))).toEqual({ ok: false, code: 'forbidden' });
	});

	test('con la pizarra solo para quien presenta, el resto no dibuja; limpiar es solo de quien modera', () => {
		const room = { ...meeting(), policy: { ...meeting().policy, whiteboard: 'hosts' as const } };
		expect(draw(room, 'u:beto-leg', stroke('t1'))).toEqual({ ok: false, code: 'forbidden' });
		expect(draw(room, 'g:inv-leg', stroke('t1'))).toEqual({ ok: false, code: 'forbidden' });
		const presenter = { ...room, members: room.members.map((item) => (item.member_key === 'u:beto' ? { ...item, role: 'presenter' as const } : item)) };
		const drawn = done(draw(presenter, 'u:beto-leg', stroke('t1')));
		expect(draw(drawn.room, 'u:beto-leg', { id: 'x', kind: 'limpiar' })).toEqual({ ok: false, code: 'not_host' });
		const cleared = done(draw(drawn.room, 'u:carla-leg', { id: 'c1', kind: 'limpiar' }));
		expect(cleared.room.board).toEqual({ seq: 2, ops: [], bytes: 0 });
		expect(cleared.events).toEqual([{ type: 'board', op: { id: 'c1', kind: 'limpiar', by: 'u:carla', seq: 2 } }]);
	});

	test('deshacer quita el trazo propio de la bitácora; el ajeno solo quien modera', () => {
		const room = meeting();
		const mine = done(draw(room, 'u:beto-leg', stroke('t1')));
		const theirs = done(draw(mine.room, 'g:inv-leg', { ...stroke('t2'), kind: 'borrar' }));
		expect(draw(theirs.room, 'u:beto-leg', { id: 't2', kind: 'deshacer' })).toEqual({ ok: false, code: 'forbidden' });
		const undone = done(draw(theirs.room, 'u:beto-leg', { id: 't1', kind: 'deshacer' }));
		expect(undone.room.board!.ops.map((item) => item.id)).toEqual(['t2']);
		expect(undone.room.board!.bytes).toBe(theirs.room.board!.bytes - mine.room.board!.bytes);
		expect(undone.events).toEqual([{ type: 'board', op: { id: 't1', kind: 'deshacer', by: 'u:beto', seq: 3 } }]);
		expect(done(draw(undone.room, 'u:ana-leg', { id: 't2', kind: 'deshacer' })).room.board!.ops).toEqual([]);
		expect(done(draw(undone.room, 'u:beto-leg', { id: 'nunca', kind: 'deshacer' })).events).toEqual([]);
	});

	test('tope por sala: 5 000 trazos o 1 MB; limpiarla deja seguir', () => {
		const op = { ...stroke('x'), by: 'u:beto', seq: 1 };
		const full_ops = { ...meeting(), board: { seq: 5000, ops: Array.from({ length: BOARD_LIMITS.ops }, (_, i) => ({ ...op, id: `o${i}` })), bytes: 10 } };
		expect(draw(full_ops, 'u:beto-leg', stroke('t1'))).toEqual({ ok: false, code: 'board_full' });
		const full_bytes = { ...meeting(), board: { seq: 1, ops: [op], bytes: BOARD_LIMITS.bytes - 10 } };
		expect(draw(full_bytes, 'u:beto-leg', stroke('t1'))).toEqual({ ok: false, code: 'board_full' });
		const cleared = done(draw(full_bytes, 'u:ana-leg', { id: 'c', kind: 'limpiar' }));
		expect(done(draw(cleared.room, 'u:beto-leg', stroke('t1'))).room.board!.ops).toHaveLength(1);
	});
});

describe('salas pequeñas', () => {
	const open = (room: RoomState, rooms: Array<{ name: string; member_keys: string[] }>, minutes = 10, ids = rooms.map((_, i) => `child-${i}`)) =>
		apply_room_command(room, { type: 'host', actor: host('cohost'), command: { type: 'breakouts_open', rooms, minutes }, now: 1_000, breakout_ids: ids });

	test('abrir: valida salas, personas y minutos; primero se crean las llamadas y luego se mueve a cada quien', () => {
		const room = meeting();
		const opened = done(open(room, [{ name: ' Equipo A ', member_keys: ['u:beto'] }, { name: 'Equipo B', member_keys: ['g:inv'] }]));
		const rooms = [
			{ call_id: 'child-0', name: 'Equipo A', member_keys: ['u:beto'] },
			{ call_id: 'child-1', name: 'Equipo B', member_keys: ['g:inv'] },
		];
		expect(opened.room.breakouts).toEqual({ rooms, ends_at: 1_000 + 10 * 60_000 });
		expect(opened.events).toEqual([
			{ type: 'breakouts_opened', rooms },
			{ type: 'breakouts', rooms },
			{ type: 'command', member_key: 'u:beto', kind: 'moved', data: { call_id: 'child-0', name: 'Equipo A' } },
			{ type: 'command', member_key: 'g:inv', kind: 'moved', data: { call_id: 'child-1', name: 'Equipo B' } },
		]);
		expect(open(opened.room, [{ name: 'Otra', member_keys: [] }])).toEqual({ ok: false, code: 'invalid_request' });
		expect(open(room, [{ name: 'A', member_keys: ['u:beto'] }, { name: 'B', member_keys: ['u:beto'] }])).toEqual({ ok: false, code: 'invalid_request' });
		expect(open(room, [{ name: 'A', member_keys: ['u:nadie'] }])).toEqual({ ok: false, code: 'invalid_request' });
		expect(open(room, [{ name: '  ', member_keys: [] }])).toEqual({ ok: false, code: 'invalid_request' });
		expect(open(room, [{ name: 'A', member_keys: [] }], 0)).toEqual({ ok: false, code: 'invalid_request' });
		expect(open(room, [{ name: 'A', member_keys: [] }], 10, [])).toEqual({ ok: false, code: 'invalid_request' });
		expect(open(room, [])).toEqual({ ok: false, code: 'invalid_request' });
		expect(open({ ...room, parent_call_id: 'p' }, [{ name: 'A', member_keys: [] }])).toEqual({ ok: false, code: 'invalid_request' });
		expect(
			apply_room_command(room, { type: 'host', actor: host('participant'), command: { type: 'breakouts_close' }, now: 1 }),
		).toEqual({ ok: false, code: 'not_host' });
	});

	test('un coanfitrión no mueve al anfitrión ni a otro coanfitrión; cada quien sí se mueve a sí mismo', () => {
		const room = { ...meeting(), admitted: [...meeting().admitted, { member_key: 'u:eva', name: 'Eva', role: 'cohost' as const }] };
		expect(open(room, [{ name: 'A', member_keys: ['u:ana'] }])).toEqual({ ok: false, code: 'not_host' });
		expect(open(room, [{ name: 'A', member_keys: ['u:beto'] }, { name: 'B', member_keys: ['u:eva'] }])).toEqual({ ok: false, code: 'not_host' });
		done(open(room, [{ name: 'A', member_keys: ['u:carla', 'u:beto'] }]));
		const by_host = apply_room_command(room, {
			type: 'host',
			actor: host('host'),
			command: { type: 'breakouts_open', rooms: [{ name: 'A', member_keys: ['u:ana', 'u:eva'] }], minutes: 10 },
			now: 1_000,
			breakout_ids: ['child-0'],
		});
		expect(done(by_host).room.breakouts!.rooms[0]!.member_keys).toEqual(['u:ana', 'u:eva']);
	});

	test('la expulsión ordenada en otra sala saca a la persona de su sala pequeña, la bloquea y no la regresa al cerrar', () => {
		const opened = done(open(meeting(), [{ name: 'A', member_keys: ['u:beto', 'g:inv'] }])).room;
		const expelled = done(apply_room_command(opened, { type: 'expel', member_key: 'g:inv', block: true }));
		expect(expelled.room.breakouts!.rooms[0]!.member_keys).toEqual(['u:beto']);
		expect(expelled.room.blocked).toContain('g:inv');
		expect(expelled.events).toContainEqual({ type: 'breakouts', rooms: expelled.room.breakouts!.rooms });
		const stranger = done(apply_room_command(empty(), { type: 'expel', member_key: 'g:otro', block: true }));
		expect([stranger.room.blocked, stranger.events]).toEqual([['g:otro'], []]);
		expect(apply_room_command(expelled.room, { type: 'attach', member: member({ leg_id: 'inv-2', member_key: 'g:inv', role: 'guest', guest: true }) })).toEqual({
			ok: false,
			code: 'forbidden',
		});
		// Quien ya no está admitido en la principal no recibe la orden de volver.
		const stale = { ...opened, admitted: opened.admitted.filter((item) => item.member_key !== 'g:inv') };
		const ended = done(apply_room_command(stale, { type: 'breakouts_end' }));
		expect(ended.events.filter((event) => event.type === 'command').map((event) => event.type === 'command' && event.member_key)).toEqual(['u:beto']);
	});

	test('mensaje a todas las salas, cierre con cuenta regresiva de 60 s y regreso de todos a la principal', () => {
		const opened = done(open(meeting(), [{ name: 'A', member_keys: ['u:beto', 'g:inv'] }])).room;
		const said = done(apply_room_command(opened, { type: 'host', actor: host('host'), command: { type: 'breakouts_broadcast', text: ' Faltan 2 min ' }, now: 5_000 }));
		expect(said.room.breakouts!.broadcast).toEqual({ text: 'Faltan 2 min', by_name: 'u:ana', at: 5_000 });
		expect(said.events).toEqual([{ type: 'breakouts', rooms: opened.breakouts!.rooms }]);
		expect(breakouts_view(said.room, said.room.breakouts!.rooms, false, 5_000)).toEqual({
			call_id: 'm-call',
			rooms: opened.breakouts!.rooms,
			ends_at: new Date(601_000).toISOString(),
			broadcast: { text: 'Faltan 2 min', by_name: 'u:ana', at: new Date(5_000).toISOString() },
		});
		expect(done(apply_room_command(said.room, { type: 'breakouts_tick', now: 600_999 })).events).toEqual([]);
		const due = done(apply_room_command(said.room, { type: 'breakouts_tick', now: 601_000 }));
		expect(due.room.breakouts!.closing_at).toBe(661_000);
		expect(breakouts_view(due.room, due.room.breakouts!.rooms, false, 631_000)).toMatchObject({ closing_in_s: 30 });
		expect(done(apply_room_command(due.room, { type: 'breakouts_tick', now: 660_000 })).events).toEqual([]);
		const closing_early = done(apply_room_command(opened, { type: 'host', actor: host('cohost'), command: { type: 'breakouts_close' }, now: 2_000 }));
		expect(closing_early.room.breakouts!.closing_at).toBe(62_000);
		expect(done(apply_room_command(closing_early.room, { type: 'host', actor: host('host'), command: { type: 'breakouts_close' }, now: 9_000 })).events).toEqual([]);
		const ended = done(apply_room_command(due.room, { type: 'breakouts_tick', now: 661_000 }));
		expect(ended.room.breakouts).toBeUndefined();
		expect(ended.events).toEqual([
			{ type: 'breakouts', rooms: opened.breakouts!.rooms, closed: true },
			{ type: 'command', member_key: 'u:beto', kind: 'moved', data: { call_id: 'm-call' } },
			{ type: 'command', member_key: 'g:inv', kind: 'moved', data: { call_id: 'm-call' } },
			{ type: 'breakouts_closed', call_ids: ['child-0'] },
		]);
		expect(breakouts_view(ended.room, opened.breakouts!.rooms, true, 661_000)).toEqual({ call_id: 'm-call', rooms: [], ends_at: new Date(661_000).toISOString() });
		expect(apply_room_command(ended.room, { type: 'host', actor: host('host'), command: { type: 'breakouts_broadcast', text: 'x' }, now: 1 })).toEqual({
			ok: false,
			code: 'invalid_request',
		});
	});

	test('una sala pequeña abierta no está ociosa aunque nadie haya llegado; cerrada, sí', () => {
		const parent = hex_id();
		const child = hex_id();
		open_meeting_room({ call_id: parent, meeting_id: 'm', conversation_id: 'c', policy: {}, entry: { muted: false, cams_off: false }, blocked: [] });
		open_meeting_room({ call_id: child, meeting_id: 'm', conversation_id: 'c', policy: {}, entry: { muted: false, cams_off: false }, blocked: [], parent_call_id: parent });
		run_room_command(parent, { type: 'admit_direct', person: { member_key: 'u:host', name: 'H', role: 'host' } });
		run_room_command(parent, { type: 'host', actor: { member_key: 'u:host', role: 'host' }, command: { type: 'breakouts_open', rooms: [{ name: 'A', member_keys: [] }], minutes: 5 }, now: 0, breakout_ids: [child] });
		expect(meeting_room_idle(child, 10 ** 9, 1)).toBe(false);
		run_room_command(parent, { type: 'breakouts_end' });
		expect(meeting_room_idle(child, 10 ** 9, 1)).toBe(true);
	});
});

describe('subtítulos y transcripción', () => {
	test('quien modera los enciende y los apaga; repetir no cambia nada', () => {
		const on = done(order(meeting(), host('cohost'), { type: 'captions', on: true }));
		expect(on.room.policy.captions_on).toBe(true);
		expect(on.events).toEqual([{ type: 'policy' }]);
		expect(done(order(on.room, host('host'), { type: 'captions', on: true })).events).toEqual([]);
		expect(done(order(on.room, host('host'), { type: 'captions', on: false })).room.policy.captions_on).toBe(false);
	});

	test('cada 200 subtítulos sale un bloque con su seq; al terminar se escribe lo que quedó y se suelta el búfer', async () => {
		const writes: ImperiumDoc[] = [];
		const store = {
			insert: async (_resource: string, doc: ImperiumDoc) => (writes.push({ resource: _resource, ...doc }), doc),
			meeting_transcript_next_seq: async () => 0,
		};
		const call_id = hex_id();
		const cue = (i: number) => ({ start_ms: i * 1000, end_ms: i * 1000 + 900, speaker_key: 'u:ana', speaker_name: 'Ana', text: `frase ${i}`, lang: 'es-MX' });
		for (let i = 0; i < TRANSCRIPT_FLUSH.cues + 3; i++) save_caption(store, call_id, 'm-sub', cue(i));
		await Bun.sleep(0);
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ resource: 'chat-meeting-transcripts', call_id, meeting_id: 'm-sub', seq: 0 });
		expect((writes[0]!.cues as ImperiumDoc[]).length).toBe(TRANSCRIPT_FLUSH.cues);
		expect((writes[0]!.cues as ImperiumDoc[])[0]).toEqual({ startMs: 0, endMs: 900, speakerKey: 'u:ana', speakerName: 'Ana', text: 'frase 0', lang: 'es-MX' });
		await flush_transcript(store, call_id, { final: true });
		expect(writes[1]).toMatchObject({ seq: 1, cues: [{ text: 'frase 200' }, { text: 'frase 201' }, { text: 'frase 202' }] });
		await flush_transcript(store, call_id, { final: true });
		expect(writes).toHaveLength(2);
	});

	test('tras un reinicio del núcleo el seq sigue al máximo guardado de esa llamada', async () => {
		const writes: ImperiumDoc[] = [];
		const asked: string[] = [];
		const store = {
			insert: async (_resource: string, doc: ImperiumDoc) => (writes.push(doc), doc),
			meeting_transcript_next_seq: async (call_id: string) => (asked.push(call_id), 2),
		};
		const call_id = hex_id();
		const cue = (i: number) => ({ start_ms: i, end_ms: i + 1, speaker_key: 'u:ana', speaker_name: 'Ana', text: `frase ${i}`, lang: 'es-MX' });
		save_caption(store, call_id, 'm-reinicio', cue(0));
		await flush_transcript(store, call_id);
		save_caption(store, call_id, 'm-reinicio', cue(1));
		await flush_transcript(store, call_id, { final: true });
		expect(writes.map((doc) => doc.seq)).toEqual([2, 3]);
		expect(asked).toEqual([call_id]);
	});
});
