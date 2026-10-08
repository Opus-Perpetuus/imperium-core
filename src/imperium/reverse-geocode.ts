export const REVERSE_GEOCODE_TIMEOUT_MS = 8_000;

const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';

export const REVERSE_GEOCODE_UNAVAILABLE_MESSAGE =
	'No se pudo obtener la dirección. Puedes continuar el reporte sin ella.';

export type ReverseGeocodeBody = Record<string, unknown>;

export type ReverseGeocodeLookup = {
	status: number;
	body: ReverseGeocodeBody;
};

type ReverseFetch = (
	input: string | URL,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	json: () => Promise<unknown>;
}>;

function unavailable(): ReverseGeocodeLookup {
	return {
		status: 200,
		body: {
			display_name: '',
			address: {},
			message: REVERSE_GEOCODE_UNAVAILABLE_MESSAGE,
		},
	};
}

export async function lookup_reverse_geocode(
	lat: string,
	lon: string,
	deps?: {
		fetch?: ReverseFetch;
		timeout_ms?: number;
		user_agent?: string;
	},
): Promise<ReverseGeocodeLookup> {
	const latitude = lat.trim();
	const longitude = lon.trim();
	if (!latitude || !longitude) {
		return {
			status: 400,
			body: { error: 'lat y lon son requeridos' },
		};
	}

	const url = new URL(NOMINATIM_REVERSE);
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('lat', latitude);
	url.searchParams.set('lon', longitude);
	url.searchParams.set('addressdetails', '1');
	url.searchParams.set('accept-language', 'es');

	const timeout_ms = deps?.timeout_ms ?? REVERSE_GEOCODE_TIMEOUT_MS;
	const fetch_impl = deps?.fetch ?? fetch;
	try {
		const upstream = await fetch_impl(url, {
			headers: {
				'user-agent': deps?.user_agent ?? 'ImperiumSIC-modular/1.0',
			},
			signal: AbortSignal.timeout(timeout_ms),
		});
		const payload = await upstream.json().catch(() => null);
		if (
			upstream.ok &&
			payload &&
			typeof payload === 'object' &&
			!Array.isArray(payload)
		) {
			return { status: 200, body: payload as ReverseGeocodeBody };
		}
		return unavailable();
	} catch {
		return unavailable();
	}
}
