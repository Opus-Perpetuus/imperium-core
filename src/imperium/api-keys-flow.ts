/**
 * API keys de interinstancia: el original generaba la llave al crear
 * (`ApiKeysService.generate_unique_api_key`) y nunca la tomaba del cliente.
 * Sin esto el alta desde Configuración → API keys responde 400 (#191).
 */
import { randomBytes } from 'node:crypto';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const API_KEY_PREFIX = 'imperium_iak_';
const API_KEY_GENERATION_ATTEMPTS = 5;

export function new_api_key_candidate(): string {
	return `${API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
}

/** Alta: la llave siempre la genera el servidor, única en la colección. */
export async function prepare_api_key_create(
	store: Pick<ImperiumStore, 'find_where'>,
	incoming: ImperiumDoc,
	candidate: () => string = new_api_key_candidate,
): Promise<ImperiumDoc> {
	for (let i = 0; i < API_KEY_GENERATION_ATTEMPTS; i++) {
		const api_key = candidate();
		if (!(await store.find_where('api-keys', { api_key }))) return { ...incoming, api_key };
	}
	throw new Error('No fue posible generar una API key única. Intenta nuevamente.');
}

/** Edición: la llave no cambia por el formulario; se conserva la guardada. */
export function prepare_api_key_update(incoming: ImperiumDoc, previous: ImperiumDoc | null): ImperiumDoc {
	const { api_key: _ignored, ...rest } = incoming;
	return previous?.api_key ? { ...rest, api_key: previous.api_key } : rest;
}
