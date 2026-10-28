/**
 * El menú guarda el path de la pantalla. El CRUD del núcleo escucha el
 * `resource` del catálogo. Cuando no son el mismo segmento, GET del path
 * del menú cae en 404 aunque la colección exista.
 */

export type MenuPathModule = {
	resource?: string;
	path?: string;
};

export type MenuPathSubject = {
	modules?: readonly MenuPathModule[];
};

/**
 * El gestor vive en `/db-admin`. El menú sigue diciendo `/database-manager/…`.
 * La consola no entra: no hay GET, solo `POST /db-admin/query`.
 */
const GESTOR_ALIASES: ReadonlyArray<readonly [string, string]> = [
	['/database-manager/audit', '/db-admin/audit'],
	['/database-manager/backups', '/db-admin/backups'],
	['/database-manager/health', '/db-admin/health'],
];

export function rewrite_menu_api_path(
	path: string,
	subjects: readonly MenuPathSubject[],
	has_resource: (resource: string) => boolean,
): string {
	const bare = path.length > 1 ? path.replace(/\/+$/, '') : path;
	const prefixed = bare.startsWith('/') ? bare : `/${bare}`;
	const candidates: Array<{ from: string; to: string }> = GESTOR_ALIASES.map(
		([from, to]) => ({ from, to }),
	);
	for (const subject of subjects) {
		for (const mod of subject.modules ?? []) {
			const resource = String(mod.resource ?? '').trim();
			const from = normalize_menu_path(mod.path);
			if (!resource || !from || from === `/${resource}`) continue;
			if (!has_resource(resource)) continue;
			candidates.push({ from, to: `/${resource}` });
		}
	}
	let chosen: { from: string; to: string } | null = null;
	for (const candidate of candidates) {
		const { from } = candidate;
		if (prefixed !== from && !prefixed.startsWith(`${from}/`)) continue;
		if (chosen && from.length <= chosen.from.length) continue;
		chosen = candidate;
	}
	if (!chosen) return path;
	const next = chosen.to + prefixed.slice(chosen.from.length);
	return bare.startsWith('/') ? next : next.slice(1);
}

function normalize_menu_path(path: string | undefined): string {
	const raw = String(path ?? '').trim();
	if (!raw) return '';
	const with_slash = raw.startsWith('/') ? raw : `/${raw}`;
	return with_slash.length > 1 ? with_slash.replace(/\/+$/, '') : with_slash;
}
