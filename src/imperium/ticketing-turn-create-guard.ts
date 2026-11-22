import type { ImperiumDoc } from './envelope.ts';

export const TURN_CONFIRM_WINDOW_MS = 2 * 60 * 1000;

export type TurnCreateClaim<T> =
	| { status: 'new'; settle: (turn: T) => void; fail: (error: unknown) => void }
	| { status: 'replay'; turn: Promise<T> }
	| { status: 'skip' };

type Slot<T> = { at: number; promise: Promise<T> };

export function normalize_client_request_id(raw: unknown): string {
	const id = String(raw ?? '').trim();
	if (!id || id.length > 80) return '';
	if (!/^[0-9a-zA-Z_-]+$/.test(id)) return '';
	return id;
}

export function create_turn_confirm_gate<T>(window_ms = TURN_CONFIRM_WINDOW_MS) {
	const slots = new Map<string, Slot<T>>();

	function prune(now: number) {
		for (const [id, slot] of slots) {
			if (now - slot.at > window_ms) slots.delete(id);
		}
	}

	function claim(raw: unknown, now = Date.now()): TurnCreateClaim<T> {
		prune(now);
		const id = normalize_client_request_id(raw);
		if (!id) return { status: 'skip' };
		const hit = slots.get(id);
		if (hit && now - hit.at <= window_ms) {
			return { status: 'replay', turn: hit.promise };
		}
		let settle!: (turn: T) => void;
		let fail!: (error: unknown) => void;
		const promise = new Promise<T>((resolve, reject) => {
			settle = (turn) => resolve(turn);
			fail = (error) => {
				if (slots.get(id)?.promise === promise) slots.delete(id);
				reject(error);
			};
		});
		promise.catch(() => undefined);
		slots.set(id, { at: now, promise });
		return { status: 'new', settle, fail };
	}

	return { claim };
}

const turn_confirm_gate = create_turn_confirm_gate<ImperiumDoc>();

export function claim_turn_confirm(raw: unknown, now = Date.now()): TurnCreateClaim<ImperiumDoc> {
	return turn_confirm_gate.claim(raw, now);
}

export function schedule_ticketing_room_notice(
	notify: () => Promise<unknown>,
	log: (message: string) => void = console.error,
): void {
	void notify().catch((error) => {
		const detail = error instanceof Error ? error.message : String(error);
		log(`[ticketing-system-turn] el turno ya se guardó; no se avisó a las cajas: ${detail}`);
	});
}
