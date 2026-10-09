import { enqueue_mutation, type LocalSession } from "./device";

export const LEGACY_OFFLINE_QUEUES = [
	"pedidos",
	"pos",
	"logistica",
	"gps",
	"violation",
	"agua",
] as const;

export type LegacyQueueName = (typeof LEGACY_OFFLINE_QUEUES)[number];

const QUEUE_RESOURCE: Record<LegacyQueueName, string> = {
	pedidos: "pedidos",
	pos: "pos-tickets",
	logistica: "delivery-package-logistics-events",
	gps: "ruta-gps",
	violation: "violation",
	agua: "lectura",
};

export function migrate_legacy_queue(
	device: LocalSession,
	queue: LegacyQueueName,
	rows: { id: string; payload: Record<string, unknown> }[],
): number {
	let added = 0;
	for (const row of rows) {
		const marker = `${device.server_id}:${queue}:${row.id}`;
		if (device.migrated.includes(marker)) continue;
		device.migrated.push(marker);
		enqueue_mutation(device, {
			name: "record.create",
			payload: {
				resource: QUEUE_RESOURCE[queue],
				id: row.id,
				fields: row.payload,
			},
		});
		added += 1;
	}
	return added;
}
