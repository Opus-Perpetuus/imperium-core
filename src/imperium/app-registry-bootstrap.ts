/**
 * El cable del bootstrap es plano y en snake_case. El snapshot guarda los
 * mapas de idioma; aplanarlos aquí evita reescribir la fila cuando cambia
 * el idioma del usuario. El ETag incluye la huella de permisos: no es global.
 */
import { hash_manifest_snapshot, type RegistryLeafSnapshot } from './app-registry-manifest.ts';
import type { AppManifestSnapshotBody } from './app-registry-manifest.ts';
import { REGISTRY_API_VERSION } from './app-registry.ts';
import { model_id_from_resource } from './subject-menu-seed.ts';
import type { SnapshotRow } from './app-registry-store.ts';

export type LeafAccess = {
	full: boolean;
	allow_read: (model_id: string) => boolean;
};

export type RegistryWireLeaf = {
	segment: string;
	path: string;
	slug: string;
	name: string;
	icon: string;
	ref: string;
	kind: 'crud' | 'page';
	page_id: string;
	app_base?: string;
	app_create?: string;
	list_headers?: Record<string, string>;
	form_labels?: Record<string, string>;
	list_only?: boolean;
	permission?: string;
	min_shell_version?: string;
};

export type RegistryWireMenu = {
	id: string;
	label: string;
	path?: string;
	page_id?: string;
	permission?: string;
	icon?: string;
	children?: RegistryWireMenu[];
};

const READ_PERMISSION = /^subject\.[a-z0-9-]+\.([a-z0-9-]+)\.read$/;

export function leaf_permission_visible(permission: string, access: LeafAccess): boolean {
	if (!permission) return false;
	if (access.full) return true;
	const match = READ_PERMISSION.exec(permission);
	if (!match) return false;
	return access.allow_read(model_id_from_resource(match[1] ?? ''));
}

export function acl_fingerprint(access: LeafAccess, permissions: readonly string[]): string {
	if (access.full) return 'full';
	const models: string[] = [];
	for (const permission of permissions) {
		const match = READ_PERMISSION.exec(permission);
		if (!match) continue;
		const model = model_id_from_resource(match[1] ?? '');
		if (model && access.allow_read(model) && !models.includes(model)) models.push(model);
	}
	models.sort();
	return models.join(',');
}

export function pick_locale_labels(
	map: Record<string, Record<string, string>> | undefined,
	chain: readonly string[],
): Record<string, string> | undefined {
	if (!map) return undefined;
	const keys = Object.keys(map);
	if (!keys.length) return undefined;
	const prefs = [...chain.map((item) => item.toLowerCase().split('-')[0] ?? ''), 'es'];
	for (const pref of prefs) {
		if (!pref) continue;
		const hit = map[pref];
		if (hit && typeof hit === 'object' && !Array.isArray(hit)) return { ...hit };
	}
	const first = map[keys[0] ?? ''];
	if (first && typeof first === 'object' && !Array.isArray(first)) return { ...first };
	return undefined;
}

function leaf_name(snapshot: AppManifestSnapshotBody, leaf: RegistryLeafSnapshot): string {
	const walk = (items: AppManifestSnapshotBody['menu']): string | null => {
		for (const item of items ?? []) {
			if (item.pageId === leaf.pageId && item.label) return item.label;
			const nested = walk(item.children);
			if (nested) return nested;
		}
		return null;
	};
	return walk(snapshot.menu) ?? leaf.pageId;
}

export function wire_leaf(
	snapshot: AppManifestSnapshotBody,
	leaf: RegistryLeafSnapshot,
	locales: readonly string[],
): RegistryWireLeaf {
	const wire: RegistryWireLeaf = {
		segment: leaf.segment,
		path: leaf.segment.startsWith('/') ? leaf.segment : `/${leaf.segment}`,
		slug: snapshot.slug,
		name: leaf_name(snapshot, leaf),
		icon: leaf.icon || 'fa-circle',
		ref: `${snapshot.slug}-${leaf.segment}`,
		kind: leaf.kind,
		page_id: leaf.pageId,
		permission: leaf.permission,
	};
	if (leaf.appBaseEffective) wire.app_base = leaf.appBaseEffective;
	if (leaf.appCreateEffective) wire.app_create = leaf.appCreateEffective;
	const headers = pick_locale_labels(leaf.listHeaders, locales);
	const labels = pick_locale_labels(leaf.formLabels, locales);
	if (headers) wire.list_headers = headers;
	if (labels) wire.form_labels = labels;
	if (leaf.listOnly) wire.list_only = true;
	if (leaf.minShellVersion) wire.min_shell_version = leaf.minShellVersion;
	return wire;
}

function wire_menu(
	items: AppManifestSnapshotBody['menu'],
	access: LeafAccess,
): RegistryWireMenu[] {
	const out: RegistryWireMenu[] = [];
	for (const item of items ?? []) {
		if (item.permission && !leaf_permission_visible(item.permission, access)) continue;
		const children = wire_menu(item.children, access);
		if (item.children?.length && !children.length && !item.path && !item.pageId) continue;
		const node: RegistryWireMenu = { id: item.id, label: item.label };
		if (item.path) node.path = item.path.startsWith('/') ? item.path : `/${item.path}`;
		if (item.pageId) node.page_id = item.pageId;
		if (item.permission) node.permission = item.permission;
		if (item.icon) node.icon = item.icon;
		if (children.length) node.children = children;
		out.push(node);
	}
	return out;
}

export function user_bootstrap(
	snapshots: readonly SnapshotRow[],
	access: LeafAccess,
	locales: readonly string[],
): { etag: string; leaves: RegistryWireLeaf[]; menu: RegistryWireMenu[] } {
	const permissions: string[] = [];
	for (const row of snapshots) {
		for (const leaf of row.manifest.leaves) {
			if (leaf.permission) permissions.push(leaf.permission);
		}
	}
	const fingerprint = acl_fingerprint(access, permissions);
	const hashes = snapshots.map((row) => row.manifest_hash).sort();
	const etag = `"${hash_manifest_snapshot({
		hashes,
		acl: fingerprint,
		registryApiVersion: REGISTRY_API_VERSION,
	})}"`;
	const seen = new Set<string>();
	const leaves: RegistryWireLeaf[] = [];
	const menu: RegistryWireMenu[] = [];
	for (const row of snapshots) {
		for (const leaf of row.manifest.leaves) {
			if (!leaf_permission_visible(leaf.permission, access)) continue;
			if (seen.has(leaf.segment)) continue;
			seen.add(leaf.segment);
			leaves.push(wire_leaf(row.manifest, leaf, locales));
		}
		menu.push(...wire_menu(row.manifest.menu, access));
	}
	return { etag, leaves, menu };
}

export function etag_matches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const want = etag.replace(/^W\//, '').replaceAll('"', '');
	return header.split(',').some((part) => {
		const got = part.trim().replace(/^W\//, '').replaceAll('"', '');
		return got.length > 0 && got === want;
	});
}
