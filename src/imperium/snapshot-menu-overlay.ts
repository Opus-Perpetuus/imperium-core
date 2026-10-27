/** El catálogo gana el path; el snapshot solo agrega hojas que catalog.json no trae. */
import {
	leaf_segment_is_reserved,
	type KirletManifestMenuItem,
} from '@opus-perpetuus/imperium-core-kit';
import type { RegistrySql } from './app-registry.ts';
import type { AppManifestSnapshotBody, RegistryLeafSnapshot } from './app-registry-manifest.ts';
import { sql_app_registry } from './app-registry-store.ts';

export type SnapshotMenuHost = {
	slug: string;
	name: string;
	path: string;
	menu_ref: string;
	technical_id?: string;
	modules?: ReadonlyArray<{
		path?: string;
		menu_ref?: string;
	}>;
	menus?: Array<{
		menu_ref: string;
		name: string;
		path?: string;
		icon: string;
		parent_ref?: string;
		resources?: string[];
	}>;
};

type DeclaredMenu = NonNullable<SnapshotMenuHost['menus']>[number];

/** Si la tabla aún no existe, el catálogo sigue solo. */
export async function load_installed_menu_snapshots(
	sql: RegistrySql,
): Promise<AppManifestSnapshotBody[]> {
	try {
		const rows = await sql_app_registry(sql).list_snapshots();
		return rows.map((row) => row.manifest);
	} catch {
		return [];
	}
}

export function overlay_snapshot_menus<T extends SnapshotMenuHost>(
	subjects: readonly T[],
	snapshots: readonly AppManifestSnapshotBody[],
): T[] {
	if (!subjects.length || !snapshots.length) return subjects as T[];
	const by_slug = new Map<string, AppManifestSnapshotBody>();
	for (const snap of snapshots) {
		if (snap?.slug) by_slug.set(snap.slug, snap);
	}
	let changed = false;
	const out = subjects.map((sub) => {
		const snap = by_slug.get(sub.slug);
		if (!snap) return sub;
		if (
			snap.technicalId &&
			sub.technical_id &&
			snap.technicalId !== sub.technical_id
		) {
			return sub;
		}
		const extra = menus_from_snapshot(sub, snap);
		if (!extra.length) return sub;
		changed = true;
		return { ...sub, menus: [...(sub.menus ?? []), ...extra] } as T;
	});
	return changed ? out : (subjects as T[]);
}

function menus_from_snapshot(
	sub: SnapshotMenuHost,
	snap: AppManifestSnapshotBody,
): DeclaredMenu[] {
	const known = new Map<string, string>();
	const seen = new Set<string>();
	const remember = (path: unknown, ref: unknown) => {
		const norm = slash_path(path);
		const id = String(ref ?? '').trim();
		if (norm && id) known.set(norm, id);
		if (id) seen.add(id);
	};
	remember(sub.path, sub.menu_ref);
	for (const mod of sub.modules ?? []) remember(mod.path, mod.menu_ref);
	for (const menu of sub.menus ?? []) remember(menu.path, menu.menu_ref);

	const leaves = new Map<string, RegistryLeafSnapshot>();
	const owned = new Set<string>();
	for (const leaf of snap.leaves ?? []) {
		const segment = String(leaf.segment ?? '').replace(/^\/+|\/+$/g, '');
		if (!segment) continue;
		leaves.set(segment, leaf);
		owned.add(segment.split('/')[0] ?? segment);
	}
	const write = new Set<string>();
	for (const perm of snap.permissions ?? []) {
		const parsed = parse_permission(sub.slug, perm.id);
		if (parsed?.mode === 'write') write.add(parsed.resource);
	}

	const hidden = new Set<string>();
	const extra: DeclaredMenu[] = [];
	const menu = Array.isArray(snap.menu) ? snap.menu : [];

	const add = (decl: DeclaredMenu): boolean => {
		if (!decl.menu_ref || seen.has(decl.menu_ref)) return false;
		const path = slash_path(decl.path);
		if (path && (known.has(path) || hidden.has(path))) return false;
		seen.add(decl.menu_ref);
		if (path) known.set(path, decl.menu_ref);
		extra.push(path ? { ...decl, path } : { ...decl, path: undefined });
		return true;
	};

	const walk = (
		items: KirletManifestMenuItem[] | undefined,
		parent_ref: string,
		inherited_public: boolean,
	) => {
		for (const item of items ?? []) {
			// realm public es el escaparate, no el sidebar del personal.
			const is_public =
				item.realm === 'public' ||
				(inherited_public && item.realm !== 'internal');
			const raw = String(item.path ?? '').trim();
			const path = raw ? safe_path(raw, owned) : '';
			if (is_public) {
				if (path) hidden.add(path);
				walk(item.children, parent_ref, true);
				continue;
			}
			if (raw && !path) {
				walk(item.children, parent_ref, false);
				continue;
			}
			const subject_path = slash_path(sub.path);
			const is_root =
				parent_ref === sub.menu_ref &&
				((!path && item.label === sub.name) ||
					(!!path && path === subject_path));
			if (is_root) {
				walk(item.children, sub.menu_ref, false);
				continue;
			}
			if (path && known.has(path)) {
				walk(item.children, known.get(path) ?? parent_ref, false);
				continue;
			}
			if (!path && !item.children?.length) continue;
			const leaf = path ? leaves.get(path.slice(1)) : undefined;
			const ref = unique_ref(sub.slug, path, item.id, seen);
			const placed = add({
				menu_ref: ref,
				name: item.label || leaf?.pageId || path.slice(1),
				path: path || undefined,
				icon: item.icon || leaf?.icon || (path ? 'fa-circle' : 'fa-folder'),
				parent_ref,
				resources: path
					? resources_for(
							sub.slug,
							item.permission ?? leaf?.permission,
							path,
							leaves,
							write,
						)
					: undefined,
			});
			walk(item.children, placed ? ref : parent_ref, false);
		}
	};

	walk(menu, sub.menu_ref, false);

	for (const leaf of snap.leaves ?? []) {
		const path = safe_path(leaf.segment, owned);
		if (!path || known.has(path) || hidden.has(path)) continue;
		if (path === slash_path(sub.path)) continue;
		const ref = unique_ref(sub.slug, path, leaf.pageId, seen);
		add({
			menu_ref: ref,
			name:
				label_for_page(menu, leaf.pageId) ??
				snap.permissions?.find((perm) => perm.id === leaf.permission)?.label ??
				leaf.pageId,
			path,
			icon: leaf.icon || 'fa-circle',
			parent_ref: sub.menu_ref,
			resources: resources_for(sub.slug, leaf.permission, path, leaves, write),
		});
	}

	return prune(extra);
}

function resources_for(
	slug: string,
	permission: string | undefined,
	path: string,
	leaves: ReadonlyMap<string, RegistryLeafSnapshot>,
	write: ReadonlySet<string>,
): string[] | undefined {
	const parsed = permission ? parse_permission(slug, permission) : null;
	const segment = path.slice(1);
	const from_leaf = leaves.get(segment);
	const leaf_perm = from_leaf ? parse_permission(slug, from_leaf.permission) : null;
	const resource =
		parsed?.resource ??
		leaf_perm?.resource ??
		(/^[a-z][a-z0-9-]*$/.test(segment) ? segment : null);
	if (!resource) return undefined;
	return write.has(resource) ? [resource] : [`${resource}:read`];
}

function parse_permission(
	slug: string,
	id: string,
): { resource: string; mode: 'read' | 'write' } | null {
	const match = new RegExp(
		`^(?:subject|kirlet)\\.${slug}\\.([a-z][a-z0-9-]*)\\.(read|write)$`,
	).exec(id);
	if (!match?.[1] || (match[2] !== 'read' && match[2] !== 'write')) return null;
	return { resource: match[1], mode: match[2] };
}

function slash_path(raw: unknown): string {
	const text = String(raw ?? '').trim();
	if (!text) return '';
	const with_slash = text.startsWith('/') ? text : `/${text}`;
	const cleaned = with_slash.replace(/\/+$/, '');
	return cleaned === '/' ? '' : cleaned;
}

function safe_path(raw: string, owned: ReadonlySet<string>): string | null {
	if (
		raw.includes('..') ||
		raw.includes('://') ||
		raw.includes('\\') ||
		raw.includes('?') ||
		raw.includes('#')
	) {
		return null;
	}
	const cleaned = slash_path(raw);
	if (!cleaned) return null;
	if (
		cleaned === '/api' ||
		cleaned.startsWith('/api/') ||
		cleaned === '/m' ||
		cleaned.startsWith('/m/')
	) {
		return null;
	}
	const head = cleaned.slice(1).split('/')[0] ?? '';
	if (leaf_segment_is_reserved(head) && !owned.has(head)) return null;
	return cleaned;
}

function unique_ref(slug: string, path: string, id: string, seen: ReadonlySet<string>): string {
	const segment = path
		.slice(1)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	let base = segment ? `${slug}-${segment}` : '';
	if (!base) {
		const clean = id
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, '-')
			.replace(/^-|-$/g, '');
		base = clean
			? clean.startsWith(`${slug}-`)
				? clean
				: `${slug}-${clean}`
			: `${slug}-menu`;
	}
	if (!seen.has(base)) return base;
	let n = 2;
	while (seen.has(`${base}-${n}`)) n += 1;
	return `${base}-${n}`;
}

function label_for_page(
	items: readonly KirletManifestMenuItem[] | undefined,
	page_id: string,
): string | null {
	for (const item of items ?? []) {
		if (item.pageId === page_id && item.label) return item.label;
		const nested = label_for_page(item.children, page_id);
		if (nested) return nested;
	}
	return null;
}

function prune(rows: DeclaredMenu[]): DeclaredMenu[] {
	const by_ref = new Map(rows.map((row) => [row.menu_ref, row]));
	const keep = new Set(
		rows.filter((row) => slash_path(row.path)).map((row) => row.menu_ref),
	);
	let grew = true;
	while (grew) {
		grew = false;
		for (const ref of keep) {
			const parent = by_ref.get(ref)?.parent_ref;
			if (parent && by_ref.has(parent) && !keep.has(parent)) {
				keep.add(parent);
				grew = true;
			}
		}
	}
	return rows.filter((row) => keep.has(row.menu_ref));
}
