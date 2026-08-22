/**
 * Mensajería interinstancia — mismo contrato que
 * MessagingRoutingSettingsService + ApiKeysService.
 */
import type { ImperiumStore } from './store.ts';

export const INTERINSTANCE_API_KEY_HEADER = 'x-imperium-interinstance-key';
export const API_KEY_INVALID_ERROR = 'Clave interinstancia inválida.';
export const API_KEY_EXPIRED_ERROR = 'La API key interinstancia ha expirado.';

function cfg_text(value: unknown) {
	return String(value ?? '').replace(/^"+|"+$/g, '').trim();
}

function cfg_bool(value: unknown, fallback = false) {
	if (value === true || value === 1) return true;
	if (value === false || value === 0) return false;
	const raw = cfg_text(value).toLowerCase();
	if (!raw) return fallback;
	return !['0', 'false', 'off', 'no'].includes(raw);
}

export async function messaging_settings(store: ImperiumStore) {
	const get = async (ref: string) =>
		(await store.find_where('configuration', { ref }))?.value;
	return {
		messaging_enabled: cfg_bool(await get('configuration-messaging-enabled'), true),
		interinstance_enabled: cfg_bool(
			await get('configuration-messaging-interinstance-enabled'),
			false,
		),
		interinstance_endpoint: cfg_text(await get('configuration-messaging-interinstance-endpoint')),
		interinstance_api_key: cfg_text(await get('configuration-messaging-interinstance-api-key')),
		instance_label:
			String(process.env.INSTANCE_LABEL ?? process.env.HOST ?? '').trim() || 'Instancia local',
		instance_version: String(process.env.APP_VERSION ?? '').trim(),
	};
}

export function interinstance_receive_url(base: string, kind: 'messages' | 'tickets') {
	const clean = base.trim();
	if (!clean) return '';
	try {
		const url = new URL(clean);
		url.pathname = `/api/${kind}/interinstance/receive`;
		return url.toString();
	} catch {
		return '';
	}
}

export async function assert_interinstance_outbound(
	store: ImperiumStore,
	kind: 'messages' | 'tickets',
) {
	const settings = await messaging_settings(store);
	if (!settings.interinstance_enabled) {
		throw new Error('La mensajería interinstancia está deshabilitada.');
	}
	const endpoint = interinstance_receive_url(settings.interinstance_endpoint, kind);
	if (!endpoint) {
		throw new Error(
			kind === 'tickets'
				? 'No existe un endpoint interinstancia configurado para tickets.'
				: 'No existe un endpoint interinstancia configurado para mensajería.',
		);
	}
	if (kind === 'tickets' && !settings.interinstance_api_key) {
		throw new Error('No existe una api key interinstancia configurada para tickets.');
	}
	return { settings, endpoint };
}

export async function validate_interinstance_api_key(store: ImperiumStore, header: unknown) {
	const request_key = cfg_text(header);
	if (!request_key) throw new Error(API_KEY_INVALID_ERROR);
	if (!store.has('api-keys')) throw new Error(API_KEY_INVALID_ERROR);
	const { rows } = await store.find_many('api-keys', { take: 500 });
	const matched = rows.find((row) => cfg_text(row.api_key) === request_key);
	if (!matched) throw new Error(API_KEY_INVALID_ERROR);
	if (matched.has_expiration === true || matched.has_expiration === 'true') {
		const exp = matched.expiration_date ? new Date(String(matched.expiration_date)) : null;
		if (!exp || Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now()) {
			throw new Error(API_KEY_EXPIRED_ERROR);
		}
	}
	return matched;
}

export async function forward_interinstance(
	endpoint: string,
	api_key: string,
	payload: Record<string, unknown>,
) {
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(api_key ? { [INTERINSTANCE_API_KEY_HEADER]: api_key } : {}),
			},
			body: JSON.stringify(payload),
		});
		const responseMessage = (await response.text()).slice(0, 400);
		return { endpoint, delivered: response.ok, status: response.status, responseMessage };
	} catch (error) {
		return {
			endpoint,
			delivered: false,
			status: 0,
			responseMessage: error instanceof Error ? error.message : String(error),
		};
	}
}

export function interinstance_key_from_req(req: Request) {
	return req.headers.get(INTERINSTANCE_API_KEY_HEADER) ?? req.headers.get('x-api-key');
}

export function deny_interinstance(message: string, status: number) {
	return Response.json({ data: [], total_elementos: 0, message, error: message }, { status });
}
