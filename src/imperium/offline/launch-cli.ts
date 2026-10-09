import { queue_pos_ticket } from "./app-queues";
import { sqlite_imperium_sync } from "./durable";
import { handle_sync_http } from "./http";
import { pending_for_server } from "./device";
import { pos_ticket_online_body } from "./pos-ticket-body";
import { read_sync_device } from "./pouch-bridge";

const ticket = {
	_id: "c-1",
	ticket_sequence: 4,
	pos_session: "507f1f77bcf86cd799439011",
	subtotal: 10.5,
	total_paid: 10.5,
	change: 0,
};

function memory_storage(): Storage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
		clear: () => values.clear(),
		key: (index) => [...values.keys()][index] ?? null,
		get length() {
			return values.size;
		},
	};
}

const storage = memory_storage();
const online = pos_ticket_online_body(ticket);
queue_pos_ticket(storage, online);
const mutations = pending_for_server(read_sync_device(storage), "local");
const store = sqlite_imperium_sync();
const payload = { server_id: "local", mutations };
const post = () =>
	handle_sync_http(
		new Request("http://local/sync/v1/mutaciones", {
			method: "POST",
			body: JSON.stringify(payload),
		}),
		"/sync/v1/mutaciones",
		store,
	);

const first = (await (await post()).json()) as { results: { status?: string }[] };
const second = (await (await post()).json()) as { results: { status?: string; row?: { id?: string } }[] };
const row = await store.find_id("pos-tickets", "c-1");
const inserted = store.inserted();
store.close();
if (first.results[0]?.status !== "applied" || row?.ticket_sequence !== 4) {
	console.error("la primera mutación no quedó aplicada");
	process.exit(1);
}
if (second.results[0]?.status !== "applied" || inserted !== 1) {
	console.error("la repetición duplicó la fila");
	process.exit(1);
}
console.log(
	JSON.stringify({
		status: first.results[0]?.status,
		rows: 1,
		replay: second.results[0]?.status,
	}),
);
