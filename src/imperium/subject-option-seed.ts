/**
 * Siembra de una app sin sesión. Mismo candado que app → app, pero el destino
 * es el núcleo: solo modelos `caller` o `caller/…`. Los builtins siguen siendo
 * de una sesión humana.
 */
import { SUBJECT_CALLER_HEADER } from '@opus-perpetuus/imperium-core-kit';
import { as_object } from './envelope.ts';

const SEED_KEYS = new Set([
	'status-option-control:seed_defaults',
	'general-option-list-control:seed_defaults',
]);

export type SubjectOptionSeedDeps = {
	master_configured: () => boolean;
	catalog_tids: ReadonlySet<string>;
	is_subject_request: (req: Request, technical_id: string) => boolean;
	installed: (technical_id: string) => Promise<boolean>;
};

function refuse(status: number, code: string, message: string): Response {
	return Response.json({ error: message, message, code }, { status });
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function owns(caller: string, value: string): boolean {
	return value === caller || value.startsWith(`${caller}/`);
}

/**
 * Misma noción de “hay entries” que `status_seed_plan` / `seed_entries`.
 * Un `module_name` suelto no cuenta: el planificador de estatus caería en los
 * builtins del núcleo.
 */
function explicit_entries(
	body: Record<string, unknown>,
	resource: string,
): Record<string, unknown>[] | null {
	if (Array.isArray(body.entries)) {
		if (!body.entries.length) return null;
		return body.entries.map((item) => as_object(item));
	}
	const loose =
		resource === 'status-option-control'
			? Array.isArray(body.options) || Boolean(text(body.model_id)) || Boolean(text(body.module_id))
			: Array.isArray(body.lists) || Boolean(text(body.model_id)) || Boolean(text(body.module_id));
	return loose ? [body] : null;
}

function entry_in_scope(caller: string, entry: Record<string, unknown>): boolean {
	const model_id = text(entry.model_id);
	const module_name = text(entry.module_name);
	const module_id = text(entry.module_id);
	if (model_id && !owns(caller, model_id)) return false;
	if (module_name && !owns(caller, module_name)) return false;
	if (module_id && !owns(caller, module_id)) return false;
	return Boolean((model_id && owns(caller, model_id)) || (module_name && owns(caller, module_name)));
}

/**
 * `null`: no es una app sembrando (sigue la sesión). `Response`: corte.
 * `{ ok: true }` ya pasó el candado y el prefijo; el cuerpo original sigue
 * legible para `handle_action`.
 */
export async function authorize_subject_option_seed(
	req: Request,
	resource: string,
	action: string | undefined,
	deps: SubjectOptionSeedDeps,
): Promise<null | { ok: true; caller: string } | Response> {
	const caller = req.headers.get(SUBJECT_CALLER_HEADER)?.trim() ?? '';
	if (!caller) return null;
	if (!SEED_KEYS.has(`${resource}:${action ?? ''}`)) return null;
	if (!deps.master_configured()) {
		return refuse(
			503,
			'gateway_secret_missing',
			'El secreto de gateway del núcleo no está configurado',
		);
	}
	if (!deps.catalog_tids.has(caller) || !deps.is_subject_request(req, caller)) {
		return refuse(403, 'forbidden', 'Prohibido');
	}
	if (!(await deps.installed(caller))) {
		return refuse(403, 'caller_not_installed', `${caller} no está instalada`);
	}
	let body: Record<string, unknown>;
	try {
		body = as_object(await req.clone().json());
	} catch {
		return refuse(400, 'invalid_body', 'El cuerpo no es JSON válido.');
	}
	const entries = explicit_entries(body, resource);
	if (!entries) {
		return refuse(403, 'seed_builtins_forbidden', 'Una app no puede sembrar los estatus del núcleo.');
	}
	if (entries.some((entry) => !entry_in_scope(caller, entry))) {
		return refuse(403, 'seed_out_of_scope', 'Una app solo puede sembrar opciones de su propio modelo.');
	}
	return { ok: true, caller };
}
