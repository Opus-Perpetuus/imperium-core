import { confirmed_seqs } from "./confirmed-seqs";
import { enqueue_mutation, pending_for_server, type LocalSession } from "./device";
import { create_device } from "./device";
import { migrate_legacy_queue, type LegacyQueueName } from "./queues";
import { create_authority } from "./types";
import type { Authority, NamedMutation } from "./types";

export type NativePendingWriter = {
	save(row: { server_id: string; client_id: string; seq: number; body: string }): Promise<void>;
};

let native_pending: NativePendingWriter | null = null;

export function set_native_pending_writer(writer: NativePendingWriter | null): void {
	native_pending = writer;
}

const DEVICE_KEY = "imperium.sync.device";

const POUCH_QUEUE: Record<string, LegacyQueueName> = {
	pedidos: "pedidos",
	"pos-tickets": "pos",
	"delivery-package-logistics-events": "logistica",
	violation: "violation",
	lectura: "agua",
	"ruta-gps": "gps",
};

export function pouch_queue_name(module_name: string): LegacyQueueName | null {
	return POUCH_QUEUE[module_name] ?? null;
}

type SavedDevice = Omit<LocalSession, "local"> & {
	local: {
		rows: [string, Record<string, unknown>][];
		ledger: [string, Authority["ledger"] extends Map<string, infer V> ? V : never][];
		stock: [string, { on_hand: number; sales: string[] }][];
		alerts: Authority["alerts"];
		folios: string[];
		cfdi: Authority["cfdi"];
		reviews: Authority["reviews"];
		tickets: Authority["tickets"];
	};
};

function save_device(device: LocalSession): SavedDevice {
	return {
		...device,
		local: {
			rows: [...device.local.rows.entries()],
			ledger: [...device.local.ledger.entries()],
			stock: [...device.local.stock.entries()],
			alerts: device.local.alerts,
			folios: [...device.local.folios],
			cfdi: device.local.cfdi,
			reviews: device.local.reviews,
			tickets: device.local.tickets,
		},
	};
}

function load_device(saved: SavedDevice): LocalSession {
	const local = create_authority();
	local.rows = new Map(saved.local.rows);
	local.ledger = new Map(saved.local.ledger);
	local.stock = new Map(saved.local.stock);
	local.alerts = saved.local.alerts ?? [];
	local.folios = new Set(saved.local.folios ?? []);
	local.cfdi = saved.local.cfdi ?? [];
	local.reviews = saved.local.reviews ?? [];
	local.tickets = saved.local.tickets ?? [];
	return { ...saved, local };
}

export function read_sync_device(storage: Storage, server_id = "local"): LocalSession {
	const raw = storage.getItem(DEVICE_KEY);
	if (!raw) return create_device({ server_id, client_id: "device" });
	try {
		return load_device(JSON.parse(raw) as SavedDevice);
	} catch {
		return create_device({ server_id, client_id: "device" });
	}
}

export function note_pouch_create(
	storage: Storage,
	module_name: string,
	doc: { _id?: string } & Record<string, unknown>,
): number {
	const queue = pouch_queue_name(module_name);
	const id = String(doc._id ?? "").trim();
	if (!queue || !id) return 0;
	const device = read_sync_device(storage);
	const added = migrate_legacy_queue(device, queue, [{ id, payload: doc }]);
	storage.setItem(DEVICE_KEY, JSON.stringify(save_device(device)));
	if (added && native_pending) {
		const mutation = pending_for_server(device, device.server_id).find(
			(item) => String(item.payload.id ?? "") === id,
		);
		if (mutation) {
			void native_pending
				.save({
					server_id: mutation.server_id,
					client_id: mutation.client_id,
					seq: mutation.seq,
					body: JSON.stringify(mutation),
				})
				.catch(() => undefined);
		}
	}
	return added;
}

export async function post_sync_batch(
	endpoint: string,
	body: { server_id: string; mutations: NamedMutation[] },
): Promise<{ results?: { status?: string }[] } | null> {
	const base = endpoint.replace(/\/$/, "");
	if (!base) return null;
	const response = await fetch(`${base}/sync/v1/mutaciones`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) return null;
	return (await response.json()) as { results?: { status?: string }[] };
}

export async function flush_device_queue(
	storage: Storage,
	post: (
		body: { server_id: string; mutations: NamedMutation[] },
	) => Promise<{ results?: { status?: string }[] } | null>,
): Promise<string[]> {
	const device = read_sync_device(storage);
	const batch = pending_for_server(device, device.server_id);
	if (!batch.length) return [];
	let response: { results?: { status?: string }[] } | null = null;
	try {
		response = await post({ server_id: device.server_id, mutations: batch });
	} catch {
		return [];
	}
	const seqs = confirmed_seqs(response?.results, batch);
	if (!seqs.length) return [];
	const drop = new Set(seqs);
	device.pending = device.pending.filter(
		(mutation) => mutation.server_id !== device.server_id || !drop.has(mutation.seq),
	);
	storage.setItem(DEVICE_KEY, JSON.stringify(save_device(device)));
	return batch
		.filter((mutation) => drop.has(mutation.seq))
		.map((mutation) => String(mutation.payload.id ?? ""));
}

export function enqueue_alta_document(
	storage: Storage,
	resource: string,
	id: string,
	body: Record<string, unknown>,
): number {
	const device = read_sync_device(storage);
	const marker = `${device.server_id}:alta:${resource}:${id}`;
	if (device.migrated.includes(marker)) return 0;
	device.migrated.push(marker);
	enqueue_mutation(device, {
		name: "record.create",
		payload: { resource, id, fields: body },
	});
	storage.setItem(DEVICE_KEY, JSON.stringify(save_device(device)));
	return 1;
}

export function enqueue_alta_edit(
	storage: Storage,
	resource: string,
	id: string,
	base: Record<string, unknown>,
	patch: Record<string, unknown>,
): number {
	const device = read_sync_device(storage);
	enqueue_mutation(device, {
		name: "edit",
		payload: { resource, id, base, patch },
	});
	storage.setItem(DEVICE_KEY, JSON.stringify(save_device(device)));
	return 1;
}

export function pending_queue_ids(storage: Storage): string[] {
	const device = read_sync_device(storage);
	return pending_for_server(device, device.server_id).map((mutation) =>
		String(mutation.payload.id ?? ""),
	);
}
