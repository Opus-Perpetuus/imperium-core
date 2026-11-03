/**
 * Sync en frío: lee el manifiesto ya instalado y no pide reinstalar.
 * Si el lector no tiene Docker, la fila anterior se queda.
 */
import { colliding_segments, project_registry_snapshot, type SegmentOwner } from './app-registry-manifest.ts';
import { GRANDFATHER_SEGMENTS } from './app-registry-grandfather.ts';
import { read_subject_image_manifest, subject_image_ref } from './subject-runtime.ts';
import {
	sql_app_registry,
	type AppRegistryRepository,
	type RegistryRow,
	type SnapshotRow,
} from './app-registry-store.ts';
import type { RegistrySql } from './app-registry.ts';

export type ManifestRead =
	| { ok: true; manifest: unknown; digest?: string | null }
	| { ok: false; skipped: true }
	| { ok: false; error: string };

export type ManifestReader = (
	slug: string,
	row: RegistryRow | null,
	installed_image?: string | null,
) => Promise<ManifestRead>;

export type SyncOutcome = {
	status: number;
	body: Record<string, unknown>;
};

export function segment_owners(snapshots: readonly SnapshotRow[]): SegmentOwner[] {
	const by = new Map<string, Set<string>>();
	for (const [slug, segments] of Object.entries(GRANDFATHER_SEGMENTS)) {
		by.set(slug, new Set(segments));
	}
	for (const row of snapshots) {
		const set = by.get(row.slug) ?? new Set<string>();
		for (const leaf of row.manifest.leaves) set.add(leaf.segment);
		by.set(row.slug, set);
	}
	return [...by.entries()].map(([slug, segments]) => ({ slug, segments: [...segments] }));
}

/**
 * Lee el manifiesto de la imagen instalada. `installed_image` es la de
 * `subject_installs`: sin ella, una app sin `installed_tag` en el registro caía
 * al `IMPERIUM_SUBJECT_TAG` global (0.1.0, sin arm64 en el G85) o a `latest`.
 */
export async function read_installed_image_manifest(
	slug: string,
	row: RegistryRow | null,
	installed_image: string | null = null,
): Promise<ManifestRead> {
	const image = subject_image_ref({
		slug,
		image: installed_image,
		registry_installed_tag: row?.installed_tag,
	});
	const result = await read_subject_image_manifest(slug, image);
	if (result.ok && result.skipped) return { ok: false, skipped: true };
	if (!result.ok) return { ok: false, error: result.error };
	return { ok: true, manifest: result.manifest, digest: null };
}

export async function sync_slug_manifest(
	repo: AppRegistryRepository,
	slug: string,
	read: ManifestReader,
	actor: string | null,
): Promise<SyncOutcome> {
	const row = await repo.get_registry(slug);
	const read_result = await read(slug, row);
	if (!read_result.ok && 'skipped' in read_result && read_result.skipped) {
		return {
			status: 200,
			body: { slug, skipped: true, envWrite: false },
		};
	}
	if (!read_result.ok) {
		return {
			status: 502,
			body: {
				error: 'manifest_unavailable',
				message: 'error' in read_result ? read_result.error : 'No se pudo leer el manifiesto.',
			},
		};
	}
	const projected = project_registry_snapshot(read_result.manifest, slug);
	if (!projected.ok) {
		await repo.insert_audit({
			actor_user_id: actor,
			action: 'reject',
			slug,
			detail: { reason: 'invalid_manifest', issues: projected.issues },
		});
		return {
			status: 422,
			body: {
				error: 'invalid_manifest',
				message: 'El manifiesto no es válido. El snapshot anterior se conserva.',
				issues: projected.issues,
			},
		};
	}
	const snapshots = await repo.list_snapshots();
	const collisions = colliding_segments(segment_owners(snapshots), {
		slug,
		segments: projected.snapshot.leaves.map((leaf) => leaf.segment),
	});
	if (collisions.length) {
		await repo.insert_audit({
			actor_user_id: actor,
			action: 'reject',
			slug,
			detail: { reason: 'segment_collision', segments: collisions },
		});
		return {
			status: 409,
			body: {
				error: 'segment_collision',
				message: 'Un segmento ya pertenece a otra app.',
				segments: collisions,
			},
		};
	}
	const digest = read_result.digest ?? projected.snapshot.imageDigest ?? null;
	await repo.commit_snapshot(slug, projected.snapshot, projected.manifest_hash, digest);
	await repo.upsert_registry({
		slug,
		technical_id: projected.snapshot.technicalId,
		repository: projected.snapshot.repository ?? null,
		image_repo: projected.snapshot.image || null,
		policy: projected.snapshot.versionChannel?.policy ?? null,
	});
	await repo.insert_audit({
		actor_user_id: actor,
		action: 'sync',
		slug,
		detail: { manifest_hash: projected.manifest_hash },
	});
	return {
		status: 200,
		body: {
			slug,
			manifest_hash: projected.manifest_hash,
			leaves: projected.snapshot.leaves.length,
			envWrite: false,
		},
	};
}

export async function sync_installed_manifests(sql: RegistrySql, read: ManifestReader): Promise<void> {
	let installed: Array<Record<string, unknown>> = [];
	try {
		const result = await sql.unsafe(
			`SELECT technical_id, installed_image FROM public.subject_installs WHERE installed IS TRUE`,
		);
		installed = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
	} catch {
		return;
	}
	const repo = sql_app_registry(sql);
	for (const row of installed) {
		const technical_id = String(row.technical_id ?? '');
		const slug = technical_id.replace(/^subject-/, '');
		if (!/^[a-z][a-z0-9-]*$/.test(slug)) continue;
		const installed_image = String(row.installed_image ?? '').trim() || null;
		try {
			await sync_slug_manifest(repo, slug, (s, r) => read(s, r, installed_image), null);
		} catch {
			// Una app ilegible no detiene al resto.
		}
	}
}

export type LiveManifestDeps = {
	fetch?: typeof fetch;
	/** Intentos contra `/manifest` mientras el contenedor termina de arrancar. */
	attempts?: number;
	delay_ms?: number;
	/** Respaldo cuando `/manifest` no contesta (por defecto, la imagen aplicada). */
	fallback?: ManifestReader;
};

/**
 * Lector para justo después de instalar o actualizar: el contenedor ya está
 * sano, así que su `/manifest` es la fuente (no hace falta `docker` ni que la
 * imagen tenga la arquitectura del lector). Si no contesta, cae a la imagen
 * que se acaba de aplicar.
 */
export function live_manifest_reader(
	base_url: string,
	image: string | null,
	deps: LiveManifestDeps = {},
): ManifestReader {
	const do_fetch = deps.fetch ?? fetch;
	const attempts = Math.max(1, deps.attempts ?? 5);
	const delay_ms = deps.delay_ms ?? 2000;
	return async (slug, row) => {
		for (let i = 0; i < attempts; i++) {
			try {
				const res = await do_fetch(`${base_url}/manifest`, { signal: AbortSignal.timeout(10_000) });
				if (res.ok) return { ok: true, manifest: await res.json(), digest: null };
			} catch {
				/* aún arrancando */
			}
			if (i + 1 < attempts && delay_ms > 0) await new Promise((r) => setTimeout(r, delay_ms));
		}
		return (deps.fallback ?? read_installed_image_manifest)(slug, row, image);
	};
}
