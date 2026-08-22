/**
 * Google Routes — mismo contrato que
 * backend/src/services/route-optimization/providers/google-routes.provider.ts
 */

export type GeoPoint = { latitude: number; longitude: number };

export type RouteStop = {
	id: string;
	location: GeoPoint;
	label?: string;
	demand_kg?: number;
};

const COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_WAYPOINTS = 98;

export function google_maps_api_key() {
	const key = String(process.env.GOOGLE_MAPS_API_KEY ?? '').trim();
	if (!key) throw new Error('Falta GOOGLE_MAPS_API_KEY para usar Google Routes API.');
	return key;
}

export function warehouse_origin(): GeoPoint | null {
	const lat_raw = String(process.env.WAREHOUSE_LAT ?? '').trim();
	const lng_raw = String(process.env.WAREHOUSE_LNG ?? '').trim();
	if (!lat_raw || !lng_raw) return null;
	const lat = Number(lat_raw);
	const lng = Number(lng_raw);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	return { latitude: lat, longitude: lng };
}

async function fetch_json<T>(url: string, init: RequestInit, retry = true): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			let detail = '';
			try {
				detail = JSON.stringify(await response.json());
			} catch {
				detail = await response.text().catch(() => '');
			}
			throw new Error(`Google respondió ${response.status}: ${detail || response.statusText}`);
		}
		return (await response.json()) as T;
	} catch (error: unknown) {
		if (retry && error instanceof Error && error.name !== 'AbortError') {
			return fetch_json<T>(url, init, false);
		}
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Tiempo de espera agotado al contactar Google Routes API.');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function to_waypoint(point: GeoPoint) {
	return { location: { latLng: { latitude: point.latitude, longitude: point.longitude } } };
}

function parse_duration_seconds(value: string | undefined) {
	if (!value) return 0;
	const parsed = parseFloat(String(value).replace(/s$/i, ''));
	return Number.isFinite(parsed) ? parsed : 0;
}

export async function optimize_google_routes(input: {
	origin: GeoPoint;
	stops: RouteStop[];
	traffic_aware?: boolean;
	depart_at?: string;
}) {
	const key = google_maps_api_key();
	const stops = input.stops;
	if (!stops.length) throw new Error('No hay paradas para optimizar.');
	if (stops.length > MAX_WAYPOINTS) {
		throw new Error(
			`La ruta tiene ${stops.length} paradas; el máximo por optimización es ${MAX_WAYPOINTS}. Divide la ruta.`,
		);
	}
	const traffic_aware = input.traffic_aware !== false;
	const body: Record<string, unknown> = {
		origin: to_waypoint(input.origin),
		destination: to_waypoint(input.origin),
		intermediates: stops.map((stop) => to_waypoint(stop.location)),
		travelMode: 'DRIVE',
		optimizeWaypointOrder: true,
		routingPreference: traffic_aware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
	};
	if (traffic_aware && input.depart_at) {
		const depart = new Date(input.depart_at);
		if (!Number.isNaN(depart.getTime()) && depart.getTime() > Date.now()) {
			body.departureTime = depart.toISOString();
		}
	}
	const data = await fetch_json<{
		routes?: Array<{
			optimizedIntermediateWaypointIndex?: number[];
			distanceMeters?: number;
			duration?: string;
			legs?: Array<{ distanceMeters?: number; duration?: string }>;
			polyline?: { encodedPolyline?: string };
		}>;
		error?: { message?: string };
	}>(COMPUTE_ROUTES_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Goog-Api-Key': key,
			'X-Goog-FieldMask':
				'routes.optimizedIntermediateWaypointIndex,routes.duration,routes.distanceMeters,routes.legs.duration,routes.legs.distanceMeters,routes.polyline.encodedPolyline',
		},
		body: JSON.stringify(body),
	});
	const route = data.routes?.[0];
	if (!route) {
		throw new Error(data.error?.message ?? 'Google no devolvió una ruta para las paradas indicadas.');
	}
	const legs = route.legs ?? [];
	const order = route.optimizedIntermediateWaypointIndex ?? stops.map((_, index) => index);
	const depart_ms = input.depart_at ? new Date(input.depart_at).getTime() : NaN;
	let cumulative_distance = 0;
	let cumulative_duration = 0;
	const ordered_stops = order.map((original_index, position) => {
		const leg = legs[position];
		cumulative_distance += leg?.distanceMeters ?? 0;
		cumulative_duration += parse_duration_seconds(leg?.duration);
		const source = stops[original_index]!;
		const eta =
			Number.isFinite(depart_ms) && !Number.isNaN(depart_ms)
				? new Date(depart_ms + cumulative_duration * 1000).toISOString()
				: undefined;
		return {
			...source,
			sequence: position,
			cumulative_distance_meters: cumulative_distance,
			cumulative_duration_seconds: cumulative_duration,
			eta,
		};
	});
	return {
		ordered_stops,
		total_distance_meters: route.distanceMeters ?? cumulative_distance,
		total_duration_seconds: parse_duration_seconds(route.duration) || cumulative_duration,
		encoded_polyline: route.polyline?.encodedPolyline,
		provider: 'google-routes',
		computed_at: new Date().toISOString(),
	};
}

export async function geocode_address(address: string): Promise<GeoPoint | null> {
	const query = address.trim();
	if (!query) return null;
	const key = google_maps_api_key();
	const data = await fetch_json<{
		status?: string;
		results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
	}>(
		`${GEOCODE_URL}?address=${encodeURIComponent(query)}&region=mx&language=es&key=${encodeURIComponent(key)}`,
		{ method: 'GET' },
	);
	if (data.status !== 'OK' || !data.results?.length) return null;
	const location = data.results[0]?.geometry?.location;
	if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return null;
	return { latitude: location.lat, longitude: location.lng };
}
