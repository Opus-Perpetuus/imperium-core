/**
 * Máquina de estados de las llamadas (contrato §6.1), pura: recibe la llamada leída, un evento y la
 * hora, y devuelve la llamada siguiente con los efectos que el flujo ejecuta después de escribirla
 * (`update_versioned`). Una pata por persona: `device` es el `leg_id` de la pestaña que contestó.
 * La llamada de una reunión no tiene patas: quién está lo lleva su sala (`call-room.ts`).
 */

export type CallMedia = 'audio' | 'video';
export type CallKind = 'direct' | 'group' | 'meeting';
export type Topology = 'mesh' | 'star' | 'sfu';
export type EndReason =
	| 'completed'
	| 'declined'
	| 'no_answer'
	| 'cancelled'
	| 'busy'
	| 'failed'
	| 'ended_by_host'
	| 'interrupted';
export type LegState = 'ringing' | 'joined' | 'left' | 'declined' | 'missed' | 'cancelled';
export type CallOutcome = 'completed' | 'missed' | 'declined' | 'cancelled' | 'busy' | 'failed';

export type CallLeg = {
	user_id: string;
	state: LegState;
	device?: string;
	busy?: boolean;
	invited_at: string;
	joined_at?: string;
	left_at?: string;
	reason?: 'answered_elsewhere' | 'network';
};

export type CallDoc = {
	_id: string;
	state: 'ringing' | 'active' | 'ended';
	v: number;
	kind: CallKind;
	media: CallMedia;
	topology: Topology;
	conversation_id: string;
	conversation_key: string;
	meeting_id?: string;
	parent_call_id?: string;
	initiator_id: string;
	participant_ids: string[];
	legs: CallLeg[];
	started_at: string;
	answered_at?: string;
	ended_at?: string;
	duration_s?: number;
	end_reason?: EndReason;
	recording?: { by: string; started_at: string; recording_id: string };
};

export type TopologyLimits = { sfu: boolean; mesh_max: number; class_max: number };

export type CallEvent =
	| {
			type: 'create';
			id: string;
			kind: 'direct' | 'group';
			media: CallMedia;
			conversation_id: string;
			conversation_key: string;
			initiator_id: string;
			leg_id: string;
			invitee_ids: string[];
			/** Llamados con una pata unida en otra llamada: su pata nueva queda en espera. */
			busy_ids: string[];
			ring_timeout_s: number;
	  }
	| {
			type: 'open_meeting';
			id: string;
			meeting_id: string;
			conversation_id: string;
			conversation_key: string;
			host_id: string;
			media: CallMedia;
			/** Una sala pequeña: la llamada de su sala principal. */
			parent_call_id?: string;
	  }
	/** Una persona más admitida en la sala de la reunión. */
	| { type: 'grow'; joined_next: number; limits: TopologyLimits }
	| { type: 'accept'; user_id: string; leg_id: string; limits: TopologyLimits }
	| { type: 'join'; user_id: string; leg_id: string; limits: TopologyLimits }
	| { type: 'decline'; user_id: string; leg_id: string }
	| { type: 'cancel'; user_id: string }
	| { type: 'leave'; user_id: string; leg_id: string; reason?: 'network' }
	| { type: 'end'; user_id: string; is_host: boolean }
	| { type: 'ring_timeout'; ring_timeout_s: number }
	| { type: 'network_lost'; user_id: string; leg_id: string; grace_s: number }
	/**
	 * El barrido: lo que sonó de más y las patas unidas sin socket desde hace más de la gracia; en
	 * una reunión, `idle` dice que su sala lleva la gracia vacía.
	 */
	| { type: 'sweep'; ring_timeout_s: number; stale_user_ids: string[]; idle?: boolean }
	/** Empieza (`recording`) o termina (`null`) la grabación del anfitrión. */
	| {
			type: 'recording';
			user_id: string;
			is_host: boolean;
			recording: NonNullable<CallDoc['recording']> | null;
			limits: TopologyLimits;
	  };

export type CallEffect =
	| { type: 'emit_update' }
	| { type: 'start_ring_timer'; ms: number }
	| { type: 'clear_ring_timer' }
	| { type: 'start_grace_timer'; user_id: string; leg_id: string; ms: number }
	| { type: 'clear_grace_timer'; user_id: string }
	/** Contestó estando en otra llamada: sale de la anterior. */
	| { type: 'leave_other_calls'; user_id: string }
	/** El mensaje `call` de la conversación; solo lo tienen sin leer quienes se lo perdieron. */
	| { type: 'call_message'; outcome: CallOutcome; duration_s?: number; unread_user_ids: string[] }
	/** Actividad `chat-missed-call` y notificación `call-missed`; solo en llamadas directas. */
	| { type: 'notify_missed'; user_ids: string[] }
	| { type: 'attendance'; user_ids: string[] }
	/** En `sfu` el servidor de medios no sabe que la pata salió: se la saca él. */
	| { type: 'sfu_remove'; member_key: string; leg_id: string }
	| { type: 'sfu_close' };

export type CallErrorCode =
	| 'not_ringing'
	| 'answered_elsewhere'
	| 'not_initiator'
	| 'not_host'
	| 'call_ended'
	| 'room_full'
	/** Contestar o unirse a la llamada de una reunión: a ella se entra por su código. */
	| 'invalid_request';

export type TransitionResult =
	| { ok: true; call: CallDoc; effects: CallEffect[]; changed: boolean }
	| { ok: false; code: CallErrorCode };

const MAX_LEGS = 32;

const OUTCOME: Record<EndReason, CallOutcome> = {
	completed: 'completed',
	ended_by_host: 'completed',
	declined: 'declined',
	no_answer: 'missed',
	cancelled: 'cancelled',
	busy: 'busy',
	failed: 'failed',
	interrupted: 'failed',
};

function outcome_of(reason: EndReason): CallOutcome {
	return OUTCOME[reason];
}

/** Espejo de `decide_topology` del cliente (contrato §6.2). */
export function decide_topology(input: {
	joined_next: number;
	sfu: boolean;
	mesh_max: number;
	class_max: number;
	recording: boolean;
}): Topology | 'room_full' {
	if (input.sfu && (input.joined_next >= 3 || input.recording)) return 'sfu';
	if (input.joined_next <= input.mesh_max) return 'mesh';
	if (input.joined_next <= input.class_max) return 'star';
	return 'room_full';
}

export type RoomRole = 'host' | 'cohost' | 'presenter' | 'participant' | 'guest';
export type TopologyPeer = { member_key: string; leg_id: string; role: RoomRole };

const PRESENTING = new Set<RoomRole>(['host', 'cohost', 'presenter']);

/** En una llamada grupal el roster no marca a nadie: presenta quien la inició. */
function presents(entry: TopologyPeer, initiator_key?: string): boolean {
	return PRESENTING.has(entry.role) || entry.member_key === initiator_key;
}

/** Patas con las que `self_leg` abre enlace P2P; la misma regla que el cliente. */
export function links_for<T extends TopologyPeer>(
	self_leg: string,
	roster: readonly T[],
	topology: Topology,
	initiator_key?: string,
): T[] {
	const self = roster.find((entry) => entry.leg_id === self_leg);
	if (!self || topology === 'sfu') return [];
	const others = roster.filter((entry) => entry.leg_id !== self_leg);
	if (topology === 'mesh' || presents(self, initiator_key)) return others;
	return others.filter((entry) => presents(entry, initiator_key));
}

function iso(now: number): string {
	return new Date(now).toISOString();
}

function joined(call: CallDoc): CallLeg[] {
	return call.legs.filter((leg) => leg.state === 'joined');
}

function with_leg(call: CallDoc, user_id: string, patch: (leg: CallLeg) => CallLeg): CallDoc {
	return { ...call, legs: call.legs.map((leg) => (leg.user_id === user_id ? patch(leg) : leg)) };
}

function done(call: CallDoc, effects: CallEffect[]): TransitionResult {
	return { ok: true, call, effects, changed: true };
}

function unchanged(call: CallDoc): TransitionResult {
	return { ok: true, call, effects: [], changed: false };
}

function fail(code: CallErrorCode): TransitionResult {
	return { ok: false, code };
}

/** Topología al sumar una persona; nunca se baja de `sfu` durante la llamada. */
function next_topology(call: CallDoc, limits: TopologyLimits, joined_next = joined(call).length + 1): Topology | 'room_full' {
	if (call.kind === 'direct') return 'mesh';
	const decided = decide_topology({
		joined_next,
		sfu: limits.sfu,
		mesh_max: limits.mesh_max,
		class_max: limits.class_max,
		recording: Boolean(call.recording),
	});
	return call.topology === 'sfu' && decided !== 'room_full' ? 'sfu' : decided;
}

/**
 * Cierra la llamada: las patas unidas salen, las que sonaban quedan como `ringing_to` y el mensaje
 * `call` queda sin leer para quienes se la perdieron. `left_now`: quien acaba de salir y también
 * cuenta en la asistencia.
 */
function finish(
	call: CallDoc,
	reason: EndReason,
	now: number,
	ringing_to: 'missed' | 'cancelled',
	left_now: string[] = [],
): TransitionResult {
	const at = iso(now);
	const present = [...left_now, ...joined(call).map((leg) => leg.user_id)];
	const legs = call.legs.map((leg): CallLeg => {
		if (leg.state === 'joined') return { ...leg, state: 'left', left_at: at };
		if (leg.state === 'ringing') return { ...leg, state: ringing_to };
		return leg;
	});
	const duration_s = call.answered_at ? Math.max(0, Math.round((now - Date.parse(call.answered_at)) / 1000)) : undefined;
	const ended: CallDoc = { ...call, legs, state: 'ended', ended_at: at, end_reason: reason, duration_s };
	const missed = legs
		.filter((leg) => (leg.state === 'missed' || leg.state === 'cancelled') && leg.user_id !== call.initiator_id)
		.map((leg) => leg.user_id);
	const effects: CallEffect[] = [
		{ type: 'emit_update' },
		{ type: 'clear_ring_timer' },
		...present.map((user_id): CallEffect => ({ type: 'clear_grace_timer', user_id })),
	];
	// Una sala pequeña comparte la conversación de su reunión, que ya registra la llamada principal.
	if (!call.parent_call_id) effects.push({ type: 'call_message', outcome: outcome_of(reason), duration_s, unread_user_ids: missed });
	if (call.kind === 'direct' && missed.length) effects.push({ type: 'notify_missed', user_ids: missed });
	if (present.length) effects.push({ type: 'attendance', user_ids: present });
	if (call.topology === 'sfu') effects.push({ type: 'sfu_close' });
	return done(ended, effects);
}

function create(event: Extract<CallEvent, { type: 'create' }>, now: number): TransitionResult {
	const at = iso(now);
	const invitees = [...new Set(event.invitee_ids)].filter((id) => id !== event.initiator_id).slice(0, MAX_LEGS - 1);
	const legs: CallLeg[] = [
		{ user_id: event.initiator_id, state: 'joined', device: event.leg_id, invited_at: at, joined_at: at },
		...invitees.map(
			(user_id): CallLeg => ({
				user_id,
				state: 'ringing',
				invited_at: at,
				...(event.busy_ids.includes(user_id) ? { busy: true } : {}),
			}),
		),
	];
	const call: CallDoc = {
		_id: event.id,
		state: 'ringing',
		v: 0,
		kind: event.kind,
		media: event.media,
		topology: 'mesh',
		conversation_id: event.conversation_id,
		conversation_key: event.conversation_key,
		initiator_id: event.initiator_id,
		participant_ids: legs.map((leg) => leg.user_id),
		legs,
		started_at: at,
	};
	return done(call, [{ type: 'emit_update' }, { type: 'start_ring_timer', ms: event.ring_timeout_s * 1000 }]);
}

function open_meeting(event: Extract<CallEvent, { type: 'open_meeting' }>, now: number): TransitionResult {
	const at = iso(now);
	const call: CallDoc = {
		_id: event.id,
		state: 'active',
		v: 0,
		kind: 'meeting',
		media: event.media,
		topology: 'mesh',
		conversation_id: event.conversation_id,
		conversation_key: event.conversation_key,
		meeting_id: event.meeting_id,
		...(event.parent_call_id ? { parent_call_id: event.parent_call_id } : {}),
		initiator_id: event.host_id,
		participant_ids: [],
		legs: [],
		started_at: at,
		answered_at: at,
	};
	return done(call, [{ type: 'emit_update' }]);
}

/** La topología solo sube: la malla pasa a estrella o al servidor de medios al crecer la sala. */
function grow(call: CallDoc, event: Extract<CallEvent, { type: 'grow' }>): TransitionResult {
	if (call.state === 'ended') return fail('call_ended');
	const topology = next_topology(call, event.limits, event.joined_next);
	if (topology === 'room_full') return fail('room_full');
	if (topology === call.topology || (call.topology !== 'mesh' && topology === 'mesh')) return unchanged(call);
	return done({ ...call, topology }, [{ type: 'emit_update' }]);
}

/** Contestar (`accept`) o entrar a una grupal (`join`): gana la primera pestaña de cada persona. */
function answer(
	call: CallDoc,
	event: { type: 'accept' | 'join'; user_id: string; leg_id: string; limits: TopologyLimits },
	now: number,
): TransitionResult {
	if (call.state === 'ended') return fail(event.type === 'join' ? 'call_ended' : 'not_ringing');
	// En una reunión quién está lo sabe la sala; una pata aquí la vería ocupada sin haber entrado.
	if (call.kind === 'meeting') return fail('invalid_request');
	const leg = call.legs.find((item) => item.user_id === event.user_id);
	if (leg?.state === 'joined') return leg.device === event.leg_id ? unchanged(call) : fail('answered_elsewhere');
	const rings = leg?.state === 'ringing';
	if (event.type === 'accept' && !rings) return fail('not_ringing');
	if (event.type === 'join' && call.kind === 'direct' && !rings) return fail('not_ringing');
	if (!leg && call.legs.length >= MAX_LEGS) return fail('room_full');
	const topology = next_topology(call, event.limits);
	if (topology === 'room_full') return fail('room_full');
	const at = iso(now);
	const entered: CallLeg = {
		user_id: event.user_id,
		state: 'joined',
		device: event.leg_id,
		invited_at: leg?.invited_at ?? at,
		joined_at: at,
		...(event.type === 'accept' ? { reason: 'answered_elsewhere' as const } : {}),
	};
	const legs = leg ? call.legs.map((item) => (item === leg ? entered : item)) : [...call.legs, entered];
	const next: CallDoc = {
		...call,
		legs,
		topology,
		state: 'active',
		answered_at: call.answered_at ?? at,
		participant_ids: call.participant_ids.includes(event.user_id)
			? call.participant_ids
			: [...call.participant_ids, event.user_id],
	};
	const effects: CallEffect[] = [{ type: 'emit_update' }];
	if (!legs.some((item) => item.state === 'ringing')) effects.push({ type: 'clear_ring_timer' });
	if (leg?.busy) effects.push({ type: 'leave_other_calls', user_id: event.user_id });
	return done(next, effects);
}

function decline(call: CallDoc, event: Extract<CallEvent, { type: 'decline' }>, now: number): TransitionResult {
	const leg = call.legs.find((item) => item.user_id === event.user_id);
	if (call.state === 'ended' || leg?.state !== 'ringing') return fail('not_ringing');
	const next = with_leg(call, event.user_id, (item) => ({ ...item, state: 'declined' }));
	const nobody_rings = !next.legs.some((item) => item.state === 'ringing');
	if (call.kind === 'direct' || (call.state === 'ringing' && nobody_rings && joined(next).length <= 1)) {
		return finish(next, 'declined', now, 'cancelled');
	}
	const effects: CallEffect[] = [{ type: 'emit_update' }];
	if (nobody_rings) effects.push({ type: 'clear_ring_timer' });
	return done(next, effects);
}

function leave(
	call: CallDoc,
	event: { user_id: string; leg_id: string; reason?: 'network' },
	now: number,
): TransitionResult {
	if (call.state === 'ended') return unchanged(call);
	const leg = call.legs.find((item) => item.user_id === event.user_id);
	if (leg?.state !== 'joined' || leg.device !== event.leg_id) return unchanged(call);
	const next = with_leg(call, event.user_id, (item) => ({
		...item,
		state: 'left',
		left_at: iso(now),
		...(event.reason ? { reason: event.reason } : {}),
	}));
	const remaining = joined(next).length;
	const over = call.kind === 'direct' ? remaining <= 1 : remaining === 0;
	if (over) {
		const reason = call.state === 'ringing' ? 'cancelled' : event.reason === 'network' ? 'interrupted' : 'completed';
		return finish(next, reason, now, 'cancelled', [event.user_id]);
	}
	const effects: CallEffect[] = [
		{ type: 'emit_update' },
		{ type: 'clear_grace_timer', user_id: event.user_id },
		{ type: 'attendance', user_ids: [event.user_id] },
	];
	if (call.topology === 'sfu') effects.push({ type: 'sfu_remove', member_key: `u:${event.user_id}`, leg_id: event.leg_id });
	return done(next, effects);
}

/** Grabar con SFU lleva la llamada al servidor de medios; dejar de grabar no la regresa. */
function record(call: CallDoc, event: Extract<CallEvent, { type: 'recording' }>): TransitionResult {
	if (call.state === 'ended') return fail('call_ended');
	if (call.initiator_id !== event.user_id && !event.is_host) return fail('not_host');
	if (!event.recording) {
		if (!call.recording) return unchanged(call);
		const { recording: _stopped, ...rest } = call;
		return done(rest, [{ type: 'emit_update' }]);
	}
	const topology = call.kind !== 'direct' && event.limits.sfu ? 'sfu' : call.topology;
	return done({ ...call, recording: event.recording, topology }, [{ type: 'emit_update' }]);
}

function ring_timeout(call: CallDoc, ring_timeout_s: number, now: number): TransitionResult {
	if (call.state === 'ended') return unchanged(call);
	const due = (leg: CallLeg) => leg.state === 'ringing' && Date.parse(leg.invited_at) + ring_timeout_s * 1000 <= now;
	if (!call.legs.some(due)) return unchanged(call);
	const busy = call.legs.some((leg) => due(leg) && leg.busy);
	const next: CallDoc = { ...call, legs: call.legs.map((leg) => (due(leg) ? { ...leg, state: 'missed' } : leg)) };
	const still = next.legs.filter((leg) => leg.state === 'ringing');
	if (call.state === 'ringing' && !still.length && joined(next).length <= 1) {
		return finish(next, call.kind === 'direct' && busy ? 'busy' : 'no_answer', now, 'missed');
	}
	const effects: CallEffect[] = [{ type: 'emit_update' }];
	if (still.length) {
		const first = Math.min(...still.map((leg) => Date.parse(leg.invited_at)));
		effects.push({ type: 'start_ring_timer', ms: Math.max(0, first + ring_timeout_s * 1000 - now) });
	}
	return done(next, effects);
}

function sweep(call: CallDoc, event: Extract<CallEvent, { type: 'sweep' }>, now: number): TransitionResult {
	let current = call;
	let effects: CallEffect[] = [];
	let changed = false;
	const apply = (result: TransitionResult) => {
		if (!result.ok || !result.changed) return;
		current = result.call;
		effects = [...effects, ...result.effects];
		changed = true;
	};
	apply(ring_timeout(current, event.ring_timeout_s, now));
	for (const user_id of event.stale_user_ids) {
		const leg = current.legs.find((item) => item.user_id === user_id && item.state === 'joined');
		if (leg?.device) apply(leave(current, { user_id, leg_id: leg.device, reason: 'network' }, now));
	}
	const empty = current.kind === 'meeting' ? event.idle === true : !joined(current).length;
	if (current.state !== 'ended' && empty) apply(finish(current, 'interrupted', now, 'cancelled'));
	if (!changed) return unchanged(call);
	const updates = effects.filter((effect) => effect.type === 'emit_update').length;
	return done(current, updates > 1 ? dedupe_updates(effects) : effects);
}

function dedupe_updates(effects: CallEffect[]): CallEffect[] {
	let seen = false;
	return effects.filter((effect) => {
		if (effect.type !== 'emit_update') return true;
		if (seen) return false;
		seen = true;
		return true;
	});
}

export function transition(call: CallDoc | null, event: CallEvent, now: number): TransitionResult {
	if (event.type === 'create') return create(event, now);
	if (event.type === 'open_meeting') return open_meeting(event, now);
	if (!call) return fail('call_ended');
	switch (event.type) {
		case 'grow':
			return grow(call, event);
		case 'accept':
		case 'join':
			return answer(call, event, now);
		case 'decline':
			return decline(call, event, now);
		case 'cancel':
			if (call.initiator_id !== event.user_id) return fail('not_initiator');
			if (call.state !== 'ringing') return fail('not_ringing');
			return finish(call, 'cancelled', now, 'cancelled');
		case 'leave':
			return leave(call, event, now);
		case 'end':
			if (call.state === 'ended') return unchanged(call);
			if (call.kind === 'direct' || (call.initiator_id !== event.user_id && !event.is_host)) return fail('not_host');
			return finish(call, 'ended_by_host', now, 'cancelled');
		case 'ring_timeout':
			return ring_timeout(call, event.ring_timeout_s, now);
		case 'network_lost': {
			const leg = call.legs.find((item) => item.user_id === event.user_id);
			if (call.state === 'ended' || leg?.state !== 'joined' || leg.device !== event.leg_id) return unchanged(call);
			return {
				ok: true,
				call,
				changed: false,
				effects: [{ type: 'start_grace_timer', user_id: event.user_id, leg_id: event.leg_id, ms: event.grace_s * 1000 }],
			};
		}
		case 'sweep':
			return sweep(call, event, now);
		case 'recording':
			return record(call, event);
	}
}

export type CallUpdate = {
	call_id: string;
	conversation_id: string;
	meeting_id?: string;
	initiator_id: string;
	state: CallDoc['state'];
	kind: CallKind;
	media: CallMedia;
	topology: Topology;
	legs: Array<Pick<CallLeg, 'user_id' | 'state' | 'device' | 'busy' | 'reason'>>;
	end_reason?: EndReason;
	duration_s?: number;
	joined_count: number;
	v: number;
};

/**
 * Lo que viaja por `call_update` (contrato §5.4): deltas pequeños, nunca el documento. En una
 * reunión `joined_count` lo cuenta su sala.
 */
export function call_update(call: CallDoc, joined_count = joined(call).length): CallUpdate {
	return strip({
		call_id: call._id,
		conversation_id: call.conversation_id,
		meeting_id: call.meeting_id,
		initiator_id: call.initiator_id,
		state: call.state,
		kind: call.kind,
		media: call.media,
		topology: call.topology,
		legs: call.legs.map((leg) =>
			strip({ user_id: leg.user_id, state: leg.state, device: leg.device, busy: leg.busy, reason: leg.reason }),
		),
		end_reason: call.end_reason,
		duration_s: call.duration_s,
		joined_count,
		v: call.v,
	});
}

export type CallView = Omit<CallDoc, 'participant_ids' | 'recording'> & {
	joined_count: number;
	recording?: { by_name: string; started_at: string };
	callee_online?: boolean;
};

/** `CallView` (contrato §3.6): sin `participant_ids` ni quién graba por id. */
export function call_view(
	call: CallDoc,
	extra: { callee_online?: boolean; recording_by_name?: string; joined_count?: number } = {},
): CallView {
	const { participant_ids: _participants, recording, ...rest } = call;
	return strip({
		...rest,
		joined_count: extra.joined_count ?? joined(call).length,
		recording: recording ? { by_name: extra.recording_by_name ?? '', started_at: recording.started_at } : undefined,
		callee_online: extra.callee_online,
	});
}

function strip<T extends Record<string, unknown>>(rec: T): T {
	for (const key of Object.keys(rec)) if (rec[key] === undefined) delete rec[key];
	return rec;
}
