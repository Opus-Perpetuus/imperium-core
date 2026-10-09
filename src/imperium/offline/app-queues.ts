import { note_pouch_create } from "./pouch-bridge";

type QueueDoc = { _id?: string } & Record<string, unknown>;

export function queue_module_doc(storage: Storage, module_name: string, doc: QueueDoc): number {
	return note_pouch_create(storage, module_name, doc);
}

export function queue_pedido(storage: Storage, doc: QueueDoc): number {
	return queue_module_doc(storage, "pedidos", doc);
}

export function queue_pos_ticket(storage: Storage, doc: QueueDoc): number {
	return queue_module_doc(storage, "pos-tickets", doc);
}

export function queue_logistics(storage: Storage, doc: QueueDoc): number {
	return queue_module_doc(storage, "delivery-package-logistics-events", doc);
}

export function queue_gps(storage: Storage, doc: QueueDoc): number {
	return queue_module_doc(storage, "ruta-gps", doc);
}

export function queue_violation(storage: Storage, doc: QueueDoc): number {
	return queue_module_doc(storage, "violation", doc);
}

export function queue_lectura(storage: Storage, doc: QueueDoc): number {
	return queue_module_doc(storage, "lectura", doc);
}

export function capturar_lectura(storage: Storage, doc: QueueDoc): number {
	const id = String(doc._id ?? "").trim();
	if (!id) throw new Error("La lectura no tiene id");
	return queue_lectura(storage, doc);
}

export function enqueue_gps_points(
	storage: Storage,
	destino: string,
	puntos: { t: number; lat: number; lon: number }[],
): number {
	let added = 0;
	for (const punto of puntos) {
		added += queue_gps(storage, {
			_id: `${destino}:${punto.t}:${punto.lat}:${punto.lon}`,
			...punto,
		});
	}
	return added;
}
