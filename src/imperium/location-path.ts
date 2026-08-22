/**
 * Rutas de ubicación (mismo contrato que inventory-location-path.utils).
 */

export function sanitize_location_segment(value: unknown): string {
	return String(value ?? '')
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

function sanitize_text(value: unknown): string {
	return String(value ?? '').trim();
}

export type LocationPathSegment = { name: string; segmento_codigo: string };

export function parse_path_token(token: unknown): LocationPathSegment | null {
	const raw = sanitize_text(token);
	if (!raw) return null;
	const bracket = raw.match(/^(.+?)\s*[\[(]([A-Za-z0-9]+)[\])]?\s*$/);
	if (bracket) {
		const name_part = sanitize_text(bracket[1]);
		const segmento = sanitize_location_segment(bracket[2]);
		if (!segmento) return null;
		const name = name_part.length >= 4 ? name_part : `Ubic ${segmento}`.slice(0, 80);
		return { name, segmento_codigo: segmento };
	}
	const segmento = sanitize_location_segment(raw);
	if (!segmento) return null;
	return { name: raw.length < 4 ? `Ubic ${segmento}` : raw, segmento_codigo: segmento };
}

export function parse_location_path(path: unknown): LocationPathSegment[] {
	const raw = sanitize_text(path);
	if (!raw) return [];
	const parts = raw
		.split(/\s*(?:\/|>|\||→|->)\s*/)
		.map((p) => p.trim())
		.filter(Boolean);
	const segments: LocationPathSegment[] = [];
	for (const part of parts) {
		const seg = parse_path_token(part);
		if (seg) segments.push(seg);
	}
	return segments;
}

export function path_from_level_columns(row: Record<string, unknown>): string {
	const keys = ['zona', 'subzona', 'pasillo', 'anaquel', 'repisa', 'bin', 'ubicacion_hoja'];
	return keys.map((k) => sanitize_text(row[k])).filter(Boolean).join(' / ');
}

export function extract_path_from_row(row: Record<string, unknown>): string {
	return (
		sanitize_text(row.ubicacion_path) ||
		sanitize_text(row.path) ||
		sanitize_text(row.ruta) ||
		sanitize_text(row.ruta_ubicacion) ||
		path_from_level_columns(row)
	);
}

export function expand_path_to_tree_lines(
	path: unknown,
	options: { root_parent_codigo?: string; fila?: number; leaf_permite_almacenaje?: boolean } = {},
) {
	const segments = parse_location_path(path);
	if (!segments.length) return [];
	const fila = options.fila ?? 1;
	const root = sanitize_location_segment(options.root_parent_codigo ?? '');
	const leaf_storage = options.leaf_permite_almacenaje !== false;
	const lines: Array<{
		fila: number;
		name: string;
		segmento_codigo: string;
		parent_codigo: string;
		permite_almacenaje: boolean;
	}> = [];
	let parent_codigo = root;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		if (
			i === 0 &&
			root &&
			(seg.segmento_codigo === root || sanitize_location_segment(seg.name) === root)
		) {
			parent_codigo = root;
			continue;
		}
		const is_leaf = i === segments.length - 1;
		lines.push({
			fila,
			name: seg.name,
			segmento_codigo: seg.segmento_codigo,
			parent_codigo,
			permite_almacenaje: is_leaf ? leaf_storage : false,
		});
		parent_codigo = parent_codigo
			? `${parent_codigo}${seg.segmento_codigo}`
			: seg.segmento_codigo;
	}
	return lines;
}

export function composed_codigo_from_path(path: unknown, root_parent_codigo?: string): string {
	const lines = expand_path_to_tree_lines(path, { root_parent_codigo });
	if (!lines.length) return sanitize_location_segment(root_parent_codigo ?? '');
	const last = lines[lines.length - 1]!;
	return last.parent_codigo
		? `${last.parent_codigo}${last.segmento_codigo}`
		: last.segmento_codigo;
}

export function normalize_alias_map(raw: unknown): Map<string, string> {
	const map = new Map<string, string>();
	if (!raw || typeof raw !== 'object') return map;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const alias = sanitize_text(key);
		const codigo = sanitize_text(value).toUpperCase();
		if (alias && codigo) {
			map.set(alias.toUpperCase(), codigo);
			map.set(alias, codigo);
		}
	}
	return map;
}
