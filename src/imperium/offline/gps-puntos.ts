export type GpsPoint = {
	t: string | number;
	lat: number;
	lon: number;
};

export function gps_point_id(ruta_id: string, punto: GpsPoint): string {
	return `${ruta_id}:${punto.t}:${punto.lat}:${punto.lon}`;
}

export function gps_puntos_body(
	ruta_id: string,
	puntos: GpsPoint[],
): { ruta_id: string; puntos: GpsPoint[] } {
	return {
		ruta_id,
		puntos: puntos.map((punto) => ({ t: punto.t, lat: punto.lat, lon: punto.lon })),
	};
}

function puntos_endpoint_reply(row: Record<string, unknown>): boolean {
	return (
		typeof row.distancia_m === "number" &&
		typeof row.puntos === "number" &&
		typeof row.nuevos === "number"
	);
}

export function confirm_gps_batch(reply: unknown, point_ids: string[]): boolean {
	if (!reply || typeof reply !== "object" || Array.isArray(reply)) return false;
	if (!point_ids.length) return false;
	const row = reply as Record<string, unknown>;
	if ("results" in row || row.status === "applied" || row.resource === "ruta-gps") return false;
	if (puntos_endpoint_reply(row)) return true;
	if (typeof row.ruta_id !== "string" || !Array.isArray(row.puntos)) return false;
	const written = row.puntos
		.filter((punto): punto is GpsPoint => {
			if (!punto || typeof punto !== "object") return false;
			const item = punto as GpsPoint;
			return (typeof item.t === "string" || typeof item.t === "number") && typeof item.lat === "number";
		})
		.map((punto) => gps_point_id(row.ruta_id as string, punto));
	if (written.length !== point_ids.length) return false;
	const have = new Set(written);
	return point_ids.every((id) => have.has(id));
}
