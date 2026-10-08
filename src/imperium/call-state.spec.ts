import { describe, expect, test } from 'bun:test';
import {
	call_update,
	call_view,
	decide_topology,
	links_for,
	transition,
	type CallDoc,
	type CallEffect,
	type CallEvent,
	type TopologyPeer,
	type TransitionResult,
} from './call-state.ts';

const T0 = Date.parse('2026-10-08T12:00:00.000Z');
const at = (s: number) => T0 + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();
const LIMITS = { sfu: false, mesh_max: 4, class_max: 20 };

function ok(result: TransitionResult): { call: CallDoc; effects: CallEffect[]; changed: boolean } {
	if (!result.ok) throw new Error(`se esperaba una transición válida y llegó ${result.code}`);
	return result;
}

function code(result: TransitionResult): string {
	return result.ok ? 'ok' : result.code;
}

function create(input: Partial<Extract<CallEvent, { type: 'create' }>> = {}): CallDoc {
	return ok(
		transition(
			null,
			{
				type: 'create',
				id: 'c1',
				kind: 'direct',
				media: 'video',
				conversation_id: 'conv',
				conversation_key: 'ana::beto',
				initiator_id: 'ana',
				leg_id: 'leg-ana',
				invitee_ids: ['beto'],
				busy_ids: [],
				ring_timeout_s: 45,
				...input,
			},
			at(0),
		),
	).call;
}

function step(call: CallDoc, event: CallEvent, s: number) {
	return ok(transition(call, event, at(s)));
}

const types = (effects: CallEffect[]) => effects.map((effect) => effect.type);
const message = (effects: CallEffect[]) => effects.find((effect) => effect.type === 'call_message');
const legs = (call: CallDoc) => Object.fromEntries(call.legs.map((leg) => [leg.user_id, leg.state]));

describe('llamada 1:1', () => {
	test('crear: suena 45 s, quien llama ya está unido y la llamada es malla', () => {
		const result = ok(
			transition(
				null,
				{
					type: 'create',
					id: 'c1',
					kind: 'direct',
					media: 'audio',
					conversation_id: 'conv',
					conversation_key: 'ana::beto',
					initiator_id: 'ana',
					leg_id: 'leg-ana',
					invitee_ids: ['beto', 'ana', 'beto'],
					busy_ids: [],
					ring_timeout_s: 45,
				},
				at(0),
			),
		);
		expect(result.call).toMatchObject({
			_id: 'c1',
			state: 'ringing',
			v: 0,
			topology: 'mesh',
			participant_ids: ['ana', 'beto'],
			started_at: iso(0),
			legs: [
				{ user_id: 'ana', state: 'joined', device: 'leg-ana', joined_at: iso(0) },
				{ user_id: 'beto', state: 'ringing', invited_at: iso(0) },
			],
		});
		expect(result.effects).toEqual([{ type: 'emit_update' }, { type: 'start_ring_timer', ms: 45_000 }]);
	});

	test('contestar, colgar: completada con su duración y sin dejar nada sin leer', () => {
		const answered = step(create(), { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 5);
		expect(answered.call).toMatchObject({ state: 'active', answered_at: iso(5) });
		expect(answered.call.legs[1]).toMatchObject({ state: 'joined', device: 'tel', reason: 'answered_elsewhere' });
		expect(types(answered.effects)).toEqual(['emit_update', 'clear_ring_timer']);
		const hung = step(answered.call, { type: 'leave', user_id: 'ana', leg_id: 'leg-ana' }, 197);
		expect(hung.call).toMatchObject({ state: 'ended', end_reason: 'completed', duration_s: 192, ended_at: iso(197) });
		expect(legs(hung.call)).toEqual({ ana: 'left', beto: 'left' });
		expect(message(hung.effects)).toEqual({ type: 'call_message', outcome: 'completed', duration_s: 192, unread_user_ids: [] });
		expect(hung.effects).toContainEqual({ type: 'attendance', user_ids: ['ana', 'beto'] });
		expect(types(hung.effects)).not.toContain('notify_missed');
	});

	test('el primer dispositivo gana; el segundo recibe answered_elsewhere y el mismo repetido no cambia nada', () => {
		const answered = step(create(), { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 3).call;
		expect(code(transition(answered, { type: 'accept', user_id: 'beto', leg_id: 'pc', limits: LIMITS }, at(4)))).toBe(
			'answered_elsewhere',
		);
		const again = step(answered, { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 4);
		expect(again.changed).toBe(false);
		expect(again.call).toBe(answered);
	});

	test('rechazar termina declinada, sin perdida y sin aviso', () => {
		const declined = step(create(), { type: 'decline', user_id: 'beto', leg_id: 'tel' }, 8);
		expect(declined.call).toMatchObject({ state: 'ended', end_reason: 'declined' });
		expect(declined.call.duration_s).toBeUndefined();
		expect(legs(declined.call)).toEqual({ ana: 'left', beto: 'declined' });
		expect(message(declined.effects)).toMatchObject({ outcome: 'declined', unread_user_ids: [] });
		expect(types(declined.effects)).not.toContain('notify_missed');
		expect(code(transition(declined.call, { type: 'decline', user_id: 'beto', leg_id: 'tel' }, at(9)))).toBe('not_ringing');
	});

	test('cancelar: solo quien llama y solo mientras suena; para el llamado cuenta como perdida', () => {
		const call = create();
		expect(code(transition(call, { type: 'cancel', user_id: 'beto' }, at(2)))).toBe('not_initiator');
		const cancelled = step(call, { type: 'cancel', user_id: 'ana' }, 2);
		expect(cancelled.call).toMatchObject({ state: 'ended', end_reason: 'cancelled' });
		expect(legs(cancelled.call)).toEqual({ ana: 'left', beto: 'cancelled' });
		expect(message(cancelled.effects)).toMatchObject({ outcome: 'cancelled', unread_user_ids: ['beto'] });
		expect(cancelled.effects).toContainEqual({ type: 'notify_missed', user_ids: ['beto'] });
		const answered = step(call, { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 1).call;
		expect(code(transition(answered, { type: 'cancel', user_id: 'ana' }, at(2)))).toBe('not_ringing');
	});

	test('colgar antes de que contesten es cancelar', () => {
		const left = step(create(), { type: 'leave', user_id: 'ana', leg_id: 'leg-ana' }, 6);
		expect(left.call).toMatchObject({ state: 'ended', end_reason: 'cancelled' });
		expect(left.effects).toContainEqual({ type: 'notify_missed', user_ids: ['beto'] });
	});

	test('vence el timbre: perdida con mensaje sin leer, actividad y notificación', () => {
		const call = create();
		expect(step(call, { type: 'ring_timeout', ring_timeout_s: 45 }, 44).changed).toBe(false);
		const missed = step(call, { type: 'ring_timeout', ring_timeout_s: 45 }, 45);
		expect(missed.call).toMatchObject({ state: 'ended', end_reason: 'no_answer' });
		expect(legs(missed.call)).toEqual({ ana: 'left', beto: 'missed' });
		expect(message(missed.effects)).toMatchObject({ outcome: 'missed', unread_user_ids: ['beto'] });
		expect(missed.effects).toContainEqual({ type: 'notify_missed', user_ids: ['beto'] });
		expect(code(transition(missed.call, { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, at(46)))).toBe(
			'not_ringing',
		);
	});

	test('ocupado: la pata en espera no suena; si vence es ocupado, y contestar sale de la otra llamada', () => {
		const call = create({ busy_ids: ['beto'] });
		expect(call.legs[1]).toMatchObject({ state: 'ringing', busy: true });
		const busy = step(call, { type: 'ring_timeout', ring_timeout_s: 45 }, 50);
		expect(busy.call.end_reason).toBe('busy');
		expect(message(busy.effects)).toMatchObject({ outcome: 'busy', unread_user_ids: ['beto'] });
		const taken = step(call, { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 10);
		expect(taken.effects).toContainEqual({ type: 'leave_other_calls', user_id: 'beto' });
		expect(taken.call.legs[1]!.busy).toBeUndefined();
	});

	test('red: la pata caída abre 30 s de gracia; luego sale por red y la llamada queda interrumpida', () => {
		const answered = step(create(), { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 2).call;
		const lost = step(answered, { type: 'network_lost', user_id: 'beto', leg_id: 'tel', grace_s: 30 }, 60);
		expect(lost.changed).toBe(false);
		expect(lost.effects).toEqual([{ type: 'start_grace_timer', user_id: 'beto', leg_id: 'tel', ms: 30_000 }]);
		expect(step(answered, { type: 'network_lost', user_id: 'beto', leg_id: 'otro', grace_s: 30 }, 60).effects).toEqual([]);
		const gone = step(answered, { type: 'leave', user_id: 'beto', leg_id: 'tel', reason: 'network' }, 90);
		expect(gone.call).toMatchObject({ state: 'ended', end_reason: 'interrupted', duration_s: 88 });
		expect(gone.call.legs[1]).toMatchObject({ state: 'left', reason: 'network', left_at: iso(90) });
		expect(message(gone.effects)).toMatchObject({ outcome: 'failed' });
	});

	test('salir con otra pestaña o de una llamada terminada no cambia nada', () => {
		const answered = step(create(), { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 2).call;
		expect(step(answered, { type: 'leave', user_id: 'beto', leg_id: 'pc' }, 3).changed).toBe(false);
		const ended = step(answered, { type: 'leave', user_id: 'beto', leg_id: 'tel' }, 3).call;
		expect(step(ended, { type: 'leave', user_id: 'ana', leg_id: 'leg-ana' }, 4).changed).toBe(false);
	});

	test('terminar para todos no aplica a un 1:1', () => {
		expect(code(transition(create(), { type: 'end', user_id: 'ana', is_host: false }, at(1)))).toBe('not_host');
	});
});

describe('llamada grupal', () => {
	const group = () => create({ kind: 'group', invitee_ids: ['beto', 'carla', 'dario'] });

	test('suenan todos; sigue activa mientras haya alguien unido y cierra con el último', () => {
		const call = group();
		expect(legs(call)).toEqual({ ana: 'joined', beto: 'ringing', carla: 'ringing', dario: 'ringing' });
		const beto = step(call, { type: 'accept', user_id: 'beto', leg_id: 'b', limits: LIMITS }, 3);
		expect(beto.call.state).toBe('active');
		expect(types(beto.effects)).toEqual(['emit_update']);
		const ana_out = step(beto.call, { type: 'leave', user_id: 'ana', leg_id: 'leg-ana' }, 10);
		expect(ana_out.call.state).toBe('active');
		expect(ana_out.effects).toEqual([
			{ type: 'emit_update' },
			{ type: 'clear_grace_timer', user_id: 'ana' },
			{ type: 'attendance', user_ids: ['ana'] },
		]);
		const last = step(ana_out.call, { type: 'leave', user_id: 'beto', leg_id: 'b' }, 63);
		expect(last.call).toMatchObject({ state: 'ended', end_reason: 'completed', duration_s: 60 });
		expect(legs(last.call)).toEqual({ ana: 'left', beto: 'left', carla: 'cancelled', dario: 'cancelled' });
		expect(message(last.effects)).toMatchObject({ outcome: 'completed', unread_user_ids: ['carla', 'dario'] });
		expect(types(last.effects)).not.toContain('notify_missed');
	});

	test('un miembro sin pata entra con join; tras salir puede volver', () => {
		const active = step(group(), { type: 'accept', user_id: 'beto', leg_id: 'b', limits: LIMITS }, 1).call;
		const eva = step(active, { type: 'join', user_id: 'eva', leg_id: 'e', limits: LIMITS }, 2).call;
		expect(eva.participant_ids).toContain('eva');
		expect(eva.legs.at(-1)).toMatchObject({ user_id: 'eva', state: 'joined', device: 'e' });
		expect(eva.legs.at(-1)!.reason).toBeUndefined();
		const out = step(eva, { type: 'leave', user_id: 'eva', leg_id: 'e' }, 3).call;
		const back = step(out, { type: 'join', user_id: 'eva', leg_id: 'e2', limits: LIMITS }, 4).call;
		expect(back.legs.filter((leg) => leg.user_id === 'eva')).toEqual([
			{ user_id: 'eva', state: 'joined', device: 'e2', invited_at: iso(2), joined_at: iso(4) },
		]);
	});

	test('join: una terminada responde call_ended y un 1:1 sin timbre no admite entrar', () => {
		const ended = step(group(), { type: 'cancel', user_id: 'ana' }, 1).call;
		expect(code(transition(ended, { type: 'join', user_id: 'eva', leg_id: 'e', limits: LIMITS }, at(2)))).toBe('call_ended');
		expect(code(transition(create(), { type: 'join', user_id: 'eva', leg_id: 'e', limits: LIMITS }, at(2)))).toBe(
			'not_ringing',
		);
	});

	test('si todos rechazan termina declinada; si nadie contesta, perdida sin actividad', () => {
		let call = group();
		for (const user_id of ['beto', 'carla']) call = step(call, { type: 'decline', user_id, leg_id: 'x' }, 1).call;
		expect(call.state).toBe('ringing');
		const all = step(call, { type: 'decline', user_id: 'dario', leg_id: 'x' }, 2);
		expect(all.call.end_reason).toBe('declined');
		const missed = step(group(), { type: 'ring_timeout', ring_timeout_s: 45 }, 45);
		expect(missed.call.end_reason).toBe('no_answer');
		expect(message(missed.effects)).toMatchObject({ outcome: 'missed', unread_user_ids: ['beto', 'carla', 'dario'] });
		expect(types(missed.effects)).not.toContain('notify_missed');
	});

	test('el timbre que vence en una activa solo marca perdidas a quienes no contestaron', () => {
		const active = step(group(), { type: 'accept', user_id: 'beto', leg_id: 'b', limits: LIMITS }, 1).call;
		const late = step(active, { type: 'ring_timeout', ring_timeout_s: 45 }, 46);
		expect(late.call.state).toBe('active');
		expect(legs(late.call)).toEqual({ ana: 'joined', beto: 'joined', carla: 'missed', dario: 'missed' });
		expect(late.effects).toEqual([{ type: 'emit_update' }]);
	});

	test('terminar para todos: el iniciador o el anfitrión', () => {
		const active = step(group(), { type: 'accept', user_id: 'beto', leg_id: 'b', limits: LIMITS }, 1).call;
		expect(code(transition(active, { type: 'end', user_id: 'beto', is_host: false }, at(5)))).toBe('not_host');
		const ended = step(active, { type: 'end', user_id: 'beto', is_host: true }, 31);
		expect(ended.call).toMatchObject({ state: 'ended', end_reason: 'ended_by_host', duration_s: 30 });
		expect(message(ended.effects)).toMatchObject({ outcome: 'completed' });
		expect(ended.effects).toContainEqual({ type: 'attendance', user_ids: ['ana', 'beto'] });
		expect(step(ended.call, { type: 'end', user_id: 'ana', is_host: false }, 32).changed).toBe(false);
	});

	test('topología: malla hasta mesh_max, luego estrella, luego sala llena; con SFU desde 3 y nunca de vuelta', () => {
		const people = ['b', 'c', 'd', 'e', 'f', 'g'];
		let call = create({ kind: 'group', invitee_ids: people });
		const small = { sfu: false, mesh_max: 3, class_max: 5 };
		const seen = [];
		for (const user_id of people) {
			const result = transition(call, { type: 'accept', user_id, leg_id: user_id, limits: small }, at(1));
			if (!result.ok) {
				seen.push(result.code);
				break;
			}
			call = result.call;
			seen.push(call.topology);
		}
		expect(seen).toEqual(['mesh', 'mesh', 'star', 'star', 'room_full']);
		const sfu = { sfu: true, mesh_max: 4, class_max: 20 };
		let with_sfu = step(create({ kind: 'group', invitee_ids: people }), { type: 'accept', user_id: 'b', leg_id: 'b', limits: sfu }, 1).call;
		expect(with_sfu.topology).toBe('mesh');
		with_sfu = step(with_sfu, { type: 'accept', user_id: 'c', leg_id: 'c', limits: sfu }, 2).call;
		expect(with_sfu.topology).toBe('sfu');
		with_sfu = step(with_sfu, { type: 'leave', user_id: 'c', leg_id: 'c' }, 3).call;
		with_sfu = step(with_sfu, { type: 'join', user_id: 'c', leg_id: 'c2', limits: { ...sfu, sfu: false } }, 4).call;
		expect(with_sfu.topology).toBe('sfu');
	});

	test('a lo más 32 patas', () => {
		const invitees = Array.from({ length: 40 }, (_, i) => `u${i}`);
		const call = create({ kind: 'group', invitee_ids: invitees });
		expect(call.legs).toHaveLength(32);
		expect(code(transition(call, { type: 'join', user_id: 'extra', leg_id: 'x', limits: LIMITS }, at(1)))).toBe('room_full');
	});
});

describe('servidor de medios', () => {
	const SFU = { sfu: true, mesh_max: 4, class_max: 20 };
	const in_sfu = () => {
		let call = create({ kind: 'group', invitee_ids: ['beto', 'carla', 'dario'] });
		call = step(call, { type: 'accept', user_id: 'beto', leg_id: 'b', limits: SFU }, 1).call;
		return step(call, { type: 'accept', user_id: 'carla', leg_id: 'c', limits: SFU }, 2);
	};

	test('el tercer participante migra a sfu y el aviso lo lleva', () => {
		const third = in_sfu();
		expect(third.call.topology).toBe('sfu');
		expect(third.effects).toContainEqual({ type: 'emit_update' });
		expect(call_update(third.call).topology).toBe('sfu');
	});

	test('en sfu, quien sale se saca del servidor de medios y el final cierra su sala', () => {
		const out = step(in_sfu().call, { type: 'leave', user_id: 'carla', leg_id: 'c' }, 3);
		expect(out.call.topology).toBe('sfu');
		expect(out.effects).toContainEqual({ type: 'sfu_remove', member_key: 'u:carla', leg_id: 'c' });
		const ended = step(out.call, { type: 'end', user_id: 'ana', is_host: false }, 4);
		expect(types(ended.effects)).toContain('sfu_close');
		expect(types(ended.effects)).not.toContain('sfu_remove');
	});

	test('en malla nada toca el servidor de medios', () => {
		const active = step(create({ kind: 'group', invitee_ids: ['beto', 'carla'] }), { type: 'accept', user_id: 'beto', leg_id: 'b', limits: LIMITS }, 1).call;
		const joined = step(active, { type: 'join', user_id: 'carla', leg_id: 'c', limits: LIMITS }, 2).call;
		const out = step(joined, { type: 'leave', user_id: 'carla', leg_id: 'c' }, 3);
		const ended = step(out.call, { type: 'end', user_id: 'ana', is_host: false }, 4);
		expect([...types(out.effects), ...types(ended.effects)].filter((type) => type.startsWith('sfu_'))).toEqual([]);
	});

	test('grabar con SFU migra a sfu y dejar de grabar no regresa a malla; sin SFU no cambia la topología', () => {
		const recording = { by: 'ana', started_at: iso(5), recording_id: 'r1' };
		const two = step(create({ kind: 'group', invitee_ids: ['beto'] }), { type: 'accept', user_id: 'beto', leg_id: 'b', limits: SFU }, 1).call;
		expect(two.topology).toBe('mesh');
		expect(code(transition(two, { type: 'recording', user_id: 'beto', is_host: false, recording, limits: SFU }, at(5)))).toBe('not_host');
		const on = step(two, { type: 'recording', user_id: 'ana', is_host: false, recording, limits: SFU }, 5);
		expect(on.call).toMatchObject({ topology: 'sfu', recording });
		expect(on.effects).toEqual([{ type: 'emit_update' }]);
		const off = step(on.call, { type: 'recording', user_id: 'beto', is_host: true, recording: null, limits: SFU }, 6);
		expect(off.call.topology).toBe('sfu');
		expect(off.call).not.toHaveProperty('recording');
		expect(step(off.call, { type: 'recording', user_id: 'ana', is_host: false, recording: null, limits: SFU }, 7).changed).toBe(false);
		const no_sfu = step(two, { type: 'recording', user_id: 'ana', is_host: false, recording, limits: LIMITS }, 5);
		expect(no_sfu.call).toMatchObject({ topology: 'mesh', recording });
		const ended = step(two, { type: 'end', user_id: 'ana', is_host: false }, 8).call;
		expect(code(transition(ended, { type: 'recording', user_id: 'ana', is_host: false, recording, limits: SFU }, at(9)))).toBe('call_ended');
	});
});

describe('barrido', () => {
	test('cierra por timbre vencido y saca a las patas sin socket; sin nadie unido, interrumpida', () => {
		const answered = step(create(), { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 2).call;
		const quiet = step(answered, { type: 'sweep', ring_timeout_s: 45, stale_user_ids: [] }, 100);
		expect(quiet.changed).toBe(false);
		const swept = step(answered, { type: 'sweep', ring_timeout_s: 45, stale_user_ids: ['ana', 'beto'] }, 100);
		expect(swept.call).toMatchObject({ state: 'ended', end_reason: 'interrupted' });
		expect(types(swept.effects).filter((type) => type === 'emit_update')).toHaveLength(1);
		const rang = step(create(), { type: 'sweep', ring_timeout_s: 45, stale_user_ids: [] }, 60);
		expect(rang.call.end_reason).toBe('no_answer');
	});

	test('tras un reinicio, una grupal sin nadie unido se cierra aunque no haya patas vencidas', () => {
		const active = step(create({ kind: 'group', invitee_ids: ['beto'] }), { type: 'accept', user_id: 'beto', leg_id: 'b', limits: LIMITS }, 1).call;
		const orphan: CallDoc = { ...active, legs: active.legs.map((leg) => ({ ...leg, state: 'left' })) };
		const swept = step(orphan, { type: 'sweep', ring_timeout_s: 45, stale_user_ids: [] }, 200);
		expect(swept.call).toMatchObject({ state: 'ended', end_reason: 'interrupted' });
	});

	test('sin llamada solo vale crear', () => {
		expect(code(transition(null, { type: 'cancel', user_id: 'ana' }, at(0)))).toBe('call_ended');
	});
});

describe('reunión', () => {
	const open = (s = 0) =>
		ok(
			transition(
				null,
				{
					type: 'open_meeting',
					id: 'm-call',
					meeting_id: 'm1',
					conversation_id: 'conv-m',
					conversation_key: 'conv:conv-m',
					host_id: 'ana',
					media: 'video',
				},
				at(s),
			),
		);

	test('abre activa, sin patas: quién está lo sabe la sala, no la llamada', () => {
		const opened = open();
		expect(opened.call).toMatchObject({
			state: 'active',
			kind: 'meeting',
			meeting_id: 'm1',
			initiator_id: 'ana',
			topology: 'mesh',
			legs: [],
			participant_ids: [],
			started_at: iso(0),
			answered_at: iso(0),
		});
		expect(opened.effects).toEqual([{ type: 'emit_update' }]);
	});

	test('a una reunión no se entra contestando ni uniéndose: no gana patas ni participantes', () => {
		const call = open().call;
		for (const type of ['join', 'accept'] as const) {
			expect(code(transition(call, { type, user_id: 'beto', leg_id: 'L1', limits: LIMITS }, at(1)))).toBe('invalid_request');
		}
	});

	test('el barrido no cierra una reunión sin patas mientras su sala no esté vacía', () => {
		const call = open().call;
		expect(step(call, { type: 'sweep', ring_timeout_s: 45, stale_user_ids: [], idle: false }, 600).changed).toBe(false);
		const swept = step(call, { type: 'sweep', ring_timeout_s: 45, stale_user_ids: [], idle: true }, 600);
		expect(swept.call).toMatchObject({ state: 'ended', end_reason: 'interrupted' });
	});

	test('crecer: malla, estrella y servidor de medios según la sala; nunca baja ni pasa del tope', () => {
		const call = open().call;
		expect(step(call, { type: 'grow', joined_next: 4, limits: LIMITS }, 1).changed).toBe(false);
		const star = step(call, { type: 'grow', joined_next: 5, limits: LIMITS }, 1);
		expect(star.call.topology).toBe('star');
		expect(star.effects).toEqual([{ type: 'emit_update' }]);
		expect(code(transition(star.call, { type: 'grow', joined_next: 21, limits: LIMITS }, at(2)))).toBe('room_full');
		const sfu = step(call, { type: 'grow', joined_next: 3, limits: { ...LIMITS, sfu: true } }, 1).call;
		expect(sfu.topology).toBe('sfu');
		expect(step(sfu, { type: 'grow', joined_next: 2, limits: LIMITS }, 2).changed).toBe(false);
		expect(code(transition({ ...call, state: 'ended' }, { type: 'grow', joined_next: 2, limits: LIMITS }, at(2)))).toBe('call_ended');
	});

	test('solo el anfitrión la termina para todos', () => {
		const call = open().call;
		expect(code(transition(call, { type: 'end', user_id: 'beto', is_host: false }, at(5)))).toBe('not_host');
		expect(step(call, { type: 'end', user_id: 'ana', is_host: true }, 5).call).toMatchObject({
			state: 'ended',
			end_reason: 'ended_by_host',
			duration_s: 5,
		});
	});

	test('una sala pequeña termina sin mensaje de llamada: el chat de la reunión solo registra la principal', () => {
		const child = ok(
			transition(
				null,
				{
					type: 'open_meeting',
					id: 'm-child',
					meeting_id: 'm1',
					conversation_id: 'conv-m',
					conversation_key: 'conv:conv-m',
					host_id: 'ana',
					media: 'video',
					parent_call_id: 'm-call',
				},
				at(0),
			),
		).call;
		expect(child.parent_call_id).toBe('m-call');
		const ended = step(child, { type: 'end', user_id: 'ana', is_host: true }, 60);
		expect(ended.call).toMatchObject({ state: 'ended', end_reason: 'ended_by_host' });
		expect(ended.effects.some((effect) => effect.type === 'call_message')).toBe(false);
		expect(step(open().call, { type: 'end', user_id: 'ana', is_host: true }, 60).effects).toContainEqual(
			expect.objectContaining({ type: 'call_message', outcome: 'completed' }),
		);
	});
});

describe('decide_topology y links_for, como el cliente', () => {
	test('cortes de decide_topology', () => {
		const base = { sfu: false, mesh_max: 4, class_max: 20, recording: false };
		expect(decide_topology({ ...base, joined_next: 2 })).toBe('mesh');
		expect(decide_topology({ ...base, joined_next: 4 })).toBe('mesh');
		expect(decide_topology({ ...base, joined_next: 5 })).toBe('star');
		expect(decide_topology({ ...base, joined_next: 20 })).toBe('star');
		expect(decide_topology({ ...base, joined_next: 21 })).toBe('room_full');
		expect(decide_topology({ ...base, sfu: true, joined_next: 2 })).toBe('mesh');
		expect(decide_topology({ ...base, sfu: true, joined_next: 2, recording: true })).toBe('sfu');
		expect(decide_topology({ ...base, sfu: true, joined_next: 3 })).toBe('sfu');
		expect(decide_topology({ ...base, sfu: true, joined_next: 500 })).toBe('sfu');
	});

	const roster: TopologyPeer[] = [
		{ member_key: 'u:host', leg_id: 'h', role: 'host' },
		{ member_key: 'u:pres', leg_id: 'p', role: 'presenter' },
		{ member_key: 'u:a', leg_id: 'a', role: 'participant' },
		{ member_key: 'g:b', leg_id: 'b', role: 'guest' },
	];
	const legs_of = (peers: TopologyPeer[]) => peers.map((peer) => peer.leg_id);

	test('malla: todos con todos; sfu: ninguno; una pata que no está en el roster, ninguno', () => {
		expect(legs_of(links_for('a', roster, 'mesh'))).toEqual(['h', 'p', 'b']);
		expect(links_for('a', roster, 'sfu')).toEqual([]);
		expect(links_for('zz', roster, 'mesh')).toEqual([]);
	});

	test('estrella: quien presenta con todos; el resto solo con quienes presentan', () => {
		expect(legs_of(links_for('h', roster, 'star'))).toEqual(['p', 'a', 'b']);
		expect(legs_of(links_for('p', roster, 'star'))).toEqual(['h', 'a', 'b']);
		expect(legs_of(links_for('a', roster, 'star'))).toEqual(['h', 'p']);
	});

	test('estrella en una grupal: presenta quien la inició', () => {
		const group: TopologyPeer[] = [
			{ member_key: 'u:ana', leg_id: 'x', role: 'participant' },
			{ member_key: 'u:beto', leg_id: 'y', role: 'participant' },
			{ member_key: 'u:carla', leg_id: 'z', role: 'participant' },
		];
		expect(legs_of(links_for('y', group, 'star', 'u:ana'))).toEqual(['x']);
		expect(legs_of(links_for('x', group, 'star', 'u:ana'))).toEqual(['y', 'z']);
	});
});

describe('formas del cable', () => {
	test('call_update lleva las patas sin fechas; call_view quita participant_ids y nombra a quien graba', () => {
		const answered = step(create(), { type: 'accept', user_id: 'beto', leg_id: 'tel', limits: LIMITS }, 2).call;
		expect(call_update(answered)).toEqual({
			call_id: 'c1',
			conversation_id: 'conv',
			initiator_id: 'ana',
			state: 'active',
			kind: 'direct',
			media: 'video',
			topology: 'mesh',
			legs: [
				{ user_id: 'ana', state: 'joined', device: 'leg-ana' },
				{ user_id: 'beto', state: 'joined', device: 'tel', reason: 'answered_elsewhere' },
			],
			joined_count: 2,
			v: 0,
		});
		const recorded = { ...answered, recording: { by: 'ana', started_at: iso(9), recording_id: 'r' } };
		const view = call_view(recorded, { callee_online: true, recording_by_name: 'Ana' });
		expect(view).not.toHaveProperty('participant_ids');
		expect(view).toMatchObject({ joined_count: 2, callee_online: true, recording: { by_name: 'Ana', started_at: iso(9) } });
	});
});
