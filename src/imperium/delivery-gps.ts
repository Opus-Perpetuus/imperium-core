/**
 * GPS de una captura (entrega, recolección, pedido). Un cliente que manda
 * `${prefix}_gps_status` debe traer coordenadas válidas o el motivo de por qué
 * no las hay. Un documento sin ese campo (APK o cola offline anteriores) se
 * acepta y queda `legado`: rechazarlo atascaría la cola.
 */
import { as_object } from './envelope.ts';

export type DeliveryGpsStatus = 'ok' | 'sin_gps' | 'legado';

export type DeliveryCoordinates = { latitude: number; longitude: number };

export type CaptureGps = {
	coordinates: DeliveryCoordinates | null;
	status: DeliveryGpsStatus;
	reason: string | null;
	accuracy_m: number | null;
};

function parse_coord(value: unknown, min: number, max: number): number | null {
	if (value == null || value === '') return null;
	const n = typeof value === 'number' ? value : Number(String(value).trim());
	if (!Number.isFinite(n) || n < min || n > max) return null;
	return Number(n.toFixed(6));
}

function parse_coordinates(raw: unknown): DeliveryCoordinates | null {
	const point = as_object(raw);
	const latitude = parse_coord(point.latitude, -90, 90);
	const longitude = parse_coord(point.longitude, -180, 180);
	if (latitude == null || longitude == null) return null;
	if (latitude === 0 && longitude === 0) return null;
	return { latitude, longitude };
}

export function resolve_capture_gps(
	body: Record<string, unknown>,
	prefix: string,
	label: string,
): CaptureGps {
	const raw = body[`${prefix}_coordinates`];
	const coordinates = parse_coordinates(raw);
	const declared = String(body[`${prefix}_gps_status`] ?? '').trim();
	if (!declared) {
		return { coordinates, status: 'legado', reason: null, accuracy_m: null };
	}
	const accuracy_raw = body[`${prefix}_gps_accuracy_m`];
	const accuracy = Number(accuracy_raw);
	const accuracy_m =
		accuracy_raw != null && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null;
	if (coordinates) return { coordinates, status: 'ok', reason: null, accuracy_m };
	if (raw != null && Object.keys(as_object(raw)).length) {
		throw new Error(`Las coordenadas de ${label} no son válidas`);
	}
	const reason = String(body[`${prefix}_gps_missing_reason`] ?? '').trim();
	if (!reason) {
		throw new Error(
			`Sin ubicación del dispositivo, indica el motivo para registrar la ${label}`,
		);
	}
	return { coordinates: null, status: 'sin_gps', reason, accuracy_m: null };
}

/** Misma salida que antes de generalizar el prefijo. */
export function resolve_delivery_gps(body: Record<string, unknown>): CaptureGps {
	return resolve_capture_gps(body, 'delivery', 'entrega');
}

export function assign_capture_gps(
	target: Record<string, unknown>,
	prefix: string,
	gps: CaptureGps,
): void {
	if (gps.coordinates) target[`${prefix}_coordinates`] = gps.coordinates;
	else delete target[`${prefix}_coordinates`];
	target[`${prefix}_gps_status`] = gps.status;
	if (gps.reason) target[`${prefix}_gps_missing_reason`] = gps.reason;
	else delete target[`${prefix}_gps_missing_reason`];
	if (gps.accuracy_m != null) target[`${prefix}_gps_accuracy_m`] = gps.accuracy_m;
	else delete target[`${prefix}_gps_accuracy_m`];
}
