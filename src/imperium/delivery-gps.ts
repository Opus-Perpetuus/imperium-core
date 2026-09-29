/**
 * GPS de la entrega de un bulto. Un cliente que manda `delivery_gps_status`
 * debe traer coordenadas válidas o el motivo de por qué no las hay. Un evento
 * sin ese campo (APK o cola offline anteriores) se acepta y queda `legado`:
 * rechazarlo atascaría la cola del chofer.
 */
import { as_object } from './envelope.ts';

export type DeliveryGpsStatus = 'ok' | 'sin_gps' | 'legado';

export type DeliveryCoordinates = { latitude: number; longitude: number };

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

export function resolve_delivery_gps(body: Record<string, unknown>): {
	coordinates: DeliveryCoordinates | null;
	status: DeliveryGpsStatus;
	reason: string | null;
	accuracy_m: number | null;
} {
	const raw = body.delivery_coordinates;
	const coordinates = parse_coordinates(raw);
	const declared = String(body.delivery_gps_status ?? '').trim();
	if (!declared) {
		return { coordinates, status: 'legado', reason: null, accuracy_m: null };
	}
	const accuracy = Number(body.delivery_gps_accuracy_m);
	const accuracy_m =
		body.delivery_gps_accuracy_m != null && Number.isFinite(accuracy) && accuracy >= 0
			? accuracy
			: null;
	if (coordinates) return { coordinates, status: 'ok', reason: null, accuracy_m };
	if (raw != null && Object.keys(as_object(raw)).length) {
		throw new Error('Las coordenadas de entrega no son válidas');
	}
	const reason = String(body.delivery_gps_missing_reason ?? '').trim();
	if (!reason) {
		throw new Error('Sin ubicación del dispositivo, indica el motivo para registrar la entrega');
	}
	return { coordinates: null, status: 'sin_gps', reason, accuracy_m: null };
}
