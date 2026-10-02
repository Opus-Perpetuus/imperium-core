import type { ImperiumDoc } from './envelope.ts';

export type ShareScopeEntry = {
	/** Ruta + parámetros fijos en forma canónica: deduplica sin comparar objetos. */
	key: string;
	path: string;
	pinned: Record<string, string[]>;
};

export type ShareBinding = {
	share_id: string;
	owner: ImperiumDoc;
	target: string;
	scope: ShareScopeEntry[];
};

// WeakMap y no una cabecera: el cliente no puede fabricar el vínculo.
const bindings = new WeakMap<Request, ShareBinding>();

export function bind_share(req: Request, binding: ShareBinding): void {
	bindings.set(req, binding);
}

/** El enlace con el que entró la petición; la sesión resuelve a su dueño. */
export function share_binding_of(req: Request): ShareBinding | null {
	return bindings.get(req) ?? null;
}
