/**
 * Parámetros de configuración que solo Odoo crea, borra o renombra. Hoy es uno:
 * las fuentes de imágenes de apps, que existen mientras Odoo tenga encendido el
 * autoescaneo de repos de imágenes. Su valor sí se puede ver y editar (Odoo lo
 * vuelve a fijar en cada «Aplicar súbditos»).
 */
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { read_imperium_body } from './body.ts';
import { IMAGE_SOURCES_CONFIG_REF } from './subject-image-sources.ts';

export const ODOO_ONLY_CONFIG_REFS: ReadonlySet<string> = new Set([IMAGE_SOURCES_CONFIG_REF]);

export const ODOO_ONLY_CONFIG_MESSAGE =
	'Este parámetro solo lo habilita Odoo (autoescaneo de repos de imágenes del servidor)';

function guarded(ref: unknown): boolean {
	return typeof ref === 'string' && ODOO_ONLY_CONFIG_REFS.has(ref.trim());
}

/** Un cambio a `item` (nuevo si no trae id) que crea, renombra o mueve un parámetro reservado. */
async function touches_guarded(store: ImperiumStore, item: Record<string, unknown>): Promise<boolean> {
	const id = String(item._id ?? item.id ?? '').trim();
	if (!id) return guarded(item._ref);
	const previous = (await store.find_id('configuration', id)) as ImperiumDoc | null;
	if (!previous) return guarded(item._ref);
	if (item._ref === undefined) return false;
	const was = String(previous._ref ?? '');
	const next = String(item._ref ?? '');
	return was !== next && (guarded(was) || guarded(next));
}

/**
 * `null` si la escritura puede seguir. Lee el cuerpo de una copia de la
 * petición para que `handle_crud` lo vuelva a leer.
 */
export async function odoo_only_config_denied(
	store: ImperiumStore,
	req: Request,
	method: string,
	segs: readonly string[],
): Promise<string | null> {
	if (method === 'DELETE' && segs[0] === 'id' && segs[1]) {
		const previous = await store.find_id('configuration', segs[1]);
		return previous && guarded(previous._ref) ? ODOO_ONLY_CONFIG_MESSAGE : null;
	}
	const writes =
		(method === 'POST' && segs.length === 0) ||
		(method === 'PUT' && (segs.length === 0 || (segs[0] === 'batch' && segs.length === 1))) ||
		(method === 'PATCH' && segs.length === 1);
	if (!writes) return null;
	let raw: unknown;
	try {
		const ctype = req.headers.get('content-type') ?? '';
		raw = ctype.includes('json') || !ctype ? await req.clone().json() : await read_imperium_body(req.clone());
	} catch {
		return null;
	}
	const obj = raw && typeof raw === 'object' ? (raw as { data?: unknown; rows?: unknown }) : null;
	const items: unknown[] = Array.isArray(raw)
		? raw
		: Array.isArray(obj?.rows)
			? obj.rows
			: Array.isArray(obj?.data)
				? obj.data
				: [raw];
	for (const item of items) {
		if (!item || typeof item !== 'object') continue;
		const row = { ...(item as Record<string, unknown>) };
		if (method === 'PATCH') row._id = segs[0];
		if (await touches_guarded(store, row)) return ODOO_ONLY_CONFIG_MESSAGE;
	}
	return null;
}
