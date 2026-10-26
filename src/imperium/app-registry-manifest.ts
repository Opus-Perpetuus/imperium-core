/**
 * El JSON del contenedor no es de confianza: el slug instalado manda el
 * prefijo de permiso y el `appBase` efectivo. Esta función no escribe la base.
 */
import { createHash } from 'node:crypto';
import {
	validate_kirlet_manifest,
	type KirletManifest,
} from '@opus-perpetuus/imperium-core-kit';

export type RegistryIssue = { path: string; message: string };

export type RegistryLeafSnapshot = {
	segment: string;
	pageId: string;
	permission: string;
	kind: 'crud' | 'page';
	appBase?: string;
	appBaseEffective?: string;
	appCreate?: string;
	appCreateEffective?: string;
	icon?: string;
	listHeaders?: Record<string, Record<string, string>>;
	formLabels?: Record<string, Record<string, string>>;
	listOnly: boolean;
	minShellVersion?: string;
};

export type AppManifestSnapshotBody = {
	manifestVersion: 1;
	slug: string;
	technicalId: string;
	name: string;
	version: string;
	image: string;
	imageDigest?: string;
	repository?: KirletManifest['repository'];
	versionChannel?: KirletManifest['versionChannel'];
	permissions: Array<{ id: string; label: string }>;
	menu: NonNullable<KirletManifest['menu']>;
	leaves: RegistryLeafSnapshot[];
	widgets: NonNullable<KirletManifest['widgets']>;
	localFunctions?: KirletManifest['localFunctions'];
};

export type RegistryProjection =
	| { ok: true; snapshot: AppManifestSnapshotBody; manifest_hash: string }
	| { ok: false; issues: RegistryIssue[] };

export type SegmentOwner = { slug: string; segments: readonly string[] };

/** Recurso relativo reescrito al gateway de la app. `null` si intenta salir de ahí. */
export function effective_subject_resource(slug: string, relative: string): string | null {
	if (!/^[a-z][a-z0-9-]*$/.test(slug)) return null;
	if (
		relative.startsWith('/') ||
		relative.startsWith('m/') ||
		relative.includes('..') ||
		relative.includes('://') ||
		relative.includes('\\')
	) {
		return null;
	}
	if (!/^[a-z0-9]+(?:[/-][a-z0-9]+)*$/.test(relative)) return null;
	return `m/subject-${slug}/${relative}`;
}

export function project_registry_snapshot(
	input: unknown,
	installed_slug: string,
): RegistryProjection {
	if (!/^[a-z][a-z0-9-]*$/.test(installed_slug)) {
		return {
			ok: false,
			issues: [{ path: '$.slug', message: 'installed slug is invalid' }],
		};
	}
	const validated = validate_kirlet_manifest(input);
	if (!validated.ok) return { ok: false, issues: validated.issues };

	const manifest = validated.manifest;
	const technical_id = `subject-${installed_slug}`;
	const issues: RegistryIssue[] = [];
	if (manifest.technicalId !== technical_id) {
		issues.push({
			path: '$.technicalId',
			message: `technicalId must be ${technical_id} for the installed slug`,
		});
	}

	const prefix = `subject.${installed_slug}.`;
	const leaves: RegistryLeafSnapshot[] = [];
	for (const [index, page] of (manifest.pages ?? []).entries()) {
		if (!page.leaf) continue;
		const permission = page.leaf.permission ?? page.permission ?? '';
		if (!permission.startsWith(prefix)) {
			issues.push({
				path: `$.pages[${index}].leaf.permission`,
				message: `permission must start with ${prefix}`,
			});
			continue;
		}
		const leaf: RegistryLeafSnapshot = {
			segment: page.path,
			pageId: page.id,
			permission,
			kind: page.leaf.kind,
			listOnly: page.leaf.listOnly === true,
		};
		if (page.leaf.appBase) {
			const effective = effective_subject_resource(installed_slug, page.leaf.appBase);
			if (!effective) {
				issues.push({
					path: `$.pages[${index}].leaf.appBase`,
					message: 'appBase escaped the subject gateway',
				});
				continue;
			}
			leaf.appBase = page.leaf.appBase;
			leaf.appBaseEffective = effective;
		} else if (page.leaf.kind === 'crud') {
			issues.push({
				path: `$.pages[${index}].leaf.appBase`,
				message: 'appBase is required for kind crud',
			});
			continue;
		}
		if (page.leaf.appCreate) {
			const effective = effective_subject_resource(installed_slug, page.leaf.appCreate);
			if (!effective) {
				issues.push({
					path: `$.pages[${index}].leaf.appCreate`,
					message: 'appCreate escaped the subject gateway',
				});
				continue;
			}
			leaf.appCreate = page.leaf.appCreate;
			leaf.appCreateEffective = effective;
		}
		if (page.leaf.icon) leaf.icon = page.leaf.icon;
		if (page.leaf.listHeaders) leaf.listHeaders = page.leaf.listHeaders;
		if (page.leaf.formLabels) leaf.formLabels = page.leaf.formLabels;
		if (page.leaf.minShellVersion) leaf.minShellVersion = page.leaf.minShellVersion;
		leaves.push(leaf);
	}
	if (issues.length) return { ok: false, issues };

	const snapshot: AppManifestSnapshotBody = {
		manifestVersion: 1,
		slug: installed_slug,
		technicalId: technical_id,
		name: manifest.name,
		version: manifest.version,
		image: manifest.image,
		permissions: manifest.permissions ?? [],
		menu: manifest.menu ?? [],
		leaves,
		widgets: manifest.widgets ?? [],
	};
	if (manifest.imageDigest) snapshot.imageDigest = manifest.imageDigest;
	if (manifest.repository) snapshot.repository = manifest.repository;
	if (manifest.versionChannel) snapshot.versionChannel = manifest.versionChannel;
	if (manifest.localFunctions) snapshot.localFunctions = manifest.localFunctions;
	return {
		ok: true,
		snapshot,
		manifest_hash: hash_manifest_snapshot(snapshot),
	};
}

export function hash_manifest_snapshot(body: unknown): string {
	return createHash('sha256').update(canonical_json(body)).digest('hex');
}

/**
 * Segmentos que ya pertenecen a otro slug. El mismo slug puede volver a
 * publicarlos: es un upgrade, no una colisión.
 */
export function colliding_segments(
	applied: readonly SegmentOwner[],
	candidate: SegmentOwner,
): string[] {
	const owned = new Map<string, string>();
	for (const owner of applied) {
		if (owner.slug === candidate.slug) continue;
		for (const segment of owner.segments) {
			if (!owned.has(segment)) owned.set(segment, owner.slug);
		}
	}
	const hits: string[] = [];
	for (const segment of candidate.segments) {
		if (owned.has(segment) && !hits.includes(segment)) hits.push(segment);
	}
	return hits;
}

function canonical_json(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonical_json(item)).join(',')}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonical_json(record[key])}`)
		.join(',')}}`;
}
