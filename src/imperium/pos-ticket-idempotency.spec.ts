import { describe, expect, test } from "bun:test";
import type { ImperiumDoc } from "./envelope.ts";
import {
	prepare_pos_ticket_create,
	take_offline_pos_replay,
} from "./pos-session-flow.ts";
import type { ImperiumStore } from "./store.ts";

function store_of(session: ImperiumDoc, tickets: ImperiumDoc[]): ImperiumStore {
	return {
		async find_id(resource: string, id: string) {
			if (resource === "pos-session" && String(session._id) === id) return session;
			return null;
		},
		async find_where(resource: string, where: Record<string, unknown>) {
			if (resource !== "pos-tickets") return null;
			return tickets.find((ticket) => ticket.ref === where.ref) ?? null;
		},
	} as unknown as ImperiumStore;
}

const actor = { _id: "user-1" };
const session = {
	_id: "ses-1",
	status: "abierta",
	is_active: true,
	on_use: true,
	created_by: "user-1",
};

describe("ticket POS idempotente", () => {
	test("la misma clave devuelve el ticket ya guardado y no pide otro alta", async () => {
		const tickets: ImperiumDoc[] = [];
		const store = store_of(session, tickets);
		const first = await prepare_pos_ticket_create(
			store,
			{ pos_session: "ses-1", offline_client_key: "k1", ticket_type: "VENTA" },
			actor,
		);
		expect(take_offline_pos_replay(first)).toBeNull();
		expect(first.ref).toBe("offline-pos:k1");
		tickets.push({ ...first, _id: "t1" });
		const second = await prepare_pos_ticket_create(
			store,
			{ pos_session: "ses-1", offline_client_key: "k1", ticket_type: "VENTA" },
			actor,
		);
		const replay = take_offline_pos_replay(second);
		expect(replay?._id).toBe("t1");
		expect(replay && OFFLINE_FLAG in replay).toBe(false);
		expect(tickets).toHaveLength(1);
	});

	test("la misma clave en otra sesión no entrega el ticket ajeno", async () => {
		const tickets: ImperiumDoc[] = [
			{ _id: "t1", ref: "offline-pos:k1", pos_session: "ses-otra" },
		];
		const store = store_of(session, tickets);
		await expect(
			prepare_pos_ticket_create(
				store,
				{ pos_session: "ses-1", offline_client_key: "k1", ticket_type: "VENTA" },
				actor,
			),
		).rejects.toThrow("otra sesión");
	});
});

const OFFLINE_FLAG = "__offline_replay";
