/**
 * El snapshot aplicado es la verdad de las hojas. Un sync inválido no lo pisa:
 * `previous_manifest` solo avanza cuando el commit entra.
 */
import type { AppManifestSnapshotBody } from './app-registry-manifest.ts';
import type { RegistrySql } from './app-registry.ts';

export type RegistryInstallStatus = 'ok' | 'failed' | 'upgrading';

export type RegistryRow = {
	slug: string;
	technical_id: string;
	repository: unknown;
	image_repo: string | null;
	policy: string | null;
	hold: boolean;
	pin_tag: string | null;
	channel: string | null;
	installed_tag: string | null;
	installed_digest: string | null;
	discovered_tag: string | null;
	previous_tag: string | null;
	install_status: RegistryInstallStatus | null;
	enabled: boolean;
};

export type SnapshotRow = {
	slug: string;
	manifest_hash: string;
	manifest: AppManifestSnapshotBody;
	image_digest: string | null;
	previous_manifest: unknown;
};

export type AuditAction = 'install' | 'sync' | 'policy' | 'reject';

export type AuditRow = {
	actor_user_id: string | null;
	action: AuditAction;
	slug: string | null;
	detail: unknown;
};

export type RegistryPatch = {
	slug: string;
	technical_id: string;
	repository?: unknown;
	image_repo?: string | null;
	policy?: string | null;
	hold?: boolean;
	pin_tag?: string | null;
	channel?: string | null;
	installed_tag?: string | null;
	installed_digest?: string | null;
	discovered_tag?: string | null;
	previous_tag?: string | null;
	install_status?: RegistryInstallStatus | null;
	enabled?: boolean;
};

export interface AppRegistryRepository {
	list_snapshots(): Promise<SnapshotRow[]>;
	get_snapshot(slug: string): Promise<SnapshotRow | null>;
	list_registry(): Promise<RegistryRow[]>;
	get_registry(slug: string): Promise<RegistryRow | null>;
	commit_snapshot(
		slug: string,
		manifest: AppManifestSnapshotBody,
		manifest_hash: string,
		image_digest: string | null,
	): Promise<void>;
	upsert_registry(patch: RegistryPatch): Promise<void>;
	insert_audit(row: AuditRow): Promise<void>;
}

function rows_of(result: unknown): Array<Record<string, unknown>> {
	return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

function text_or_null(value: unknown): string | null {
	if (value == null) return null;
	const text = String(value).trim();
	return text || null;
}

function as_manifest(value: unknown): AppManifestSnapshotBody | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const body = value as AppManifestSnapshotBody;
	if (!Array.isArray(body.leaves) || typeof body.slug !== 'string') return null;
	return body;
}

function registry_from(row: Record<string, unknown>): RegistryRow | null {
	const slug = text_or_null(row.slug);
	const technical_id = text_or_null(row.technical_id);
	if (!slug || !technical_id) return null;
	const status = text_or_null(row.install_status);
	return {
		slug,
		technical_id,
		repository: row.repository ?? null,
		image_repo: text_or_null(row.image_repo),
		policy: text_or_null(row.policy),
		hold: row.hold === true,
		pin_tag: text_or_null(row.pin_tag),
		channel: text_or_null(row.channel),
		installed_tag: text_or_null(row.installed_tag),
		installed_digest: text_or_null(row.installed_digest),
		discovered_tag: text_or_null(row.discovered_tag),
		previous_tag: text_or_null(row.previous_tag),
		install_status:
			status === 'ok' || status === 'failed' || status === 'upgrading' ? status : null,
		enabled: row.enabled !== false,
	};
}

export function memory_app_registry(): AppRegistryRepository {
	const snapshots = new Map<string, SnapshotRow>();
	const registry = new Map<string, RegistryRow>();
	const audits: AuditRow[] = [];
	return {
		async list_snapshots() {
			return [...snapshots.values()].sort((a, b) => a.slug.localeCompare(b.slug));
		},
		async get_snapshot(slug) {
			return snapshots.get(slug) ?? null;
		},
		async list_registry() {
			return [...registry.values()].sort((a, b) => a.slug.localeCompare(b.slug));
		},
		async get_registry(slug) {
			return registry.get(slug) ?? null;
		},
		async commit_snapshot(slug, manifest, manifest_hash, image_digest) {
			const prev = snapshots.get(slug);
			snapshots.set(slug, {
				slug,
				manifest_hash,
				manifest,
				image_digest,
				previous_manifest: prev?.manifest ?? null,
			});
		},
		async upsert_registry(patch) {
			const prev = registry.get(patch.slug);
			registry.set(patch.slug, {
				slug: patch.slug,
				technical_id: patch.technical_id,
				repository: patch.repository !== undefined ? patch.repository : (prev?.repository ?? null),
				image_repo: patch.image_repo !== undefined ? patch.image_repo : (prev?.image_repo ?? null),
				policy: patch.policy !== undefined ? patch.policy : (prev?.policy ?? null),
				hold: patch.hold !== undefined ? patch.hold : (prev?.hold ?? false),
				pin_tag: patch.pin_tag !== undefined ? patch.pin_tag : (prev?.pin_tag ?? null),
				channel: patch.channel !== undefined ? patch.channel : (prev?.channel ?? null),
				installed_tag: patch.installed_tag || prev?.installed_tag || null,
				installed_digest: patch.installed_digest || prev?.installed_digest || null,
				discovered_tag:
					patch.discovered_tag !== undefined ? patch.discovered_tag : (prev?.discovered_tag ?? null),
				previous_tag: patch.previous_tag || prev?.previous_tag || null,
				install_status:
					patch.install_status !== undefined ? patch.install_status : (prev?.install_status ?? null),
				enabled: patch.enabled !== undefined ? patch.enabled : (prev?.enabled ?? true),
			});
		},
		async insert_audit(row) {
			audits.push(row);
		},
	};
}

function snapshot_from(row: Record<string, unknown>): SnapshotRow | null {
	const slug = text_or_null(row.slug);
	const manifest_hash = text_or_null(row.manifest_hash);
	const manifest = as_manifest(row.manifest);
	if (!slug || !manifest_hash || !manifest) return null;
	return {
		slug,
		manifest_hash,
		manifest,
		image_digest: text_or_null(row.image_digest),
		previous_manifest: row.previous_manifest ?? null,
	};
}

export function sql_app_registry(sql: RegistrySql): AppRegistryRepository {
	return {
		async list_snapshots() {
			const result = await sql.unsafe(
				`SELECT slug, manifest_hash, manifest, image_digest, previous_manifest
           FROM public.app_manifest_snapshot
          ORDER BY slug`,
			);
			const out: SnapshotRow[] = [];
			for (const row of rows_of(result)) {
				const parsed = snapshot_from(row);
				if (parsed) out.push(parsed);
			}
			return out;
		},
		async get_snapshot(slug) {
			const result = await sql.unsafe(
				`SELECT slug, manifest_hash, manifest, image_digest, previous_manifest
           FROM public.app_manifest_snapshot
          WHERE slug = $1`,
				[slug],
			);
			const row = rows_of(result)[0];
			return row ? snapshot_from(row) : null;
		},
		async list_registry() {
			const result = await sql.unsafe(
				`SELECT slug, technical_id, repository, image_repo, policy, hold, pin_tag, channel,
                installed_tag, installed_digest, discovered_tag, previous_tag, install_status, enabled
           FROM public.app_registry
          ORDER BY slug`,
			);
			const out: RegistryRow[] = [];
			for (const row of rows_of(result)) {
				const parsed = registry_from(row);
				if (parsed) out.push(parsed);
			}
			return out;
		},
		async get_registry(slug) {
			const result = await sql.unsafe(
				`SELECT slug, technical_id, repository, image_repo, policy, hold, pin_tag, channel,
                installed_tag, installed_digest, discovered_tag, previous_tag, install_status, enabled
           FROM public.app_registry
          WHERE slug = $1`,
				[slug],
			);
			const row = rows_of(result)[0];
			return row ? registry_from(row) : null;
		},
		async commit_snapshot(slug, manifest, manifest_hash, image_digest) {
			await sql.unsafe(
				`INSERT INTO public.app_manifest_snapshot
            (slug, manifest_hash, manifest, image_digest, previous_manifest)
          VALUES ($1, $2, $3::jsonb, $4, NULL)
          ON CONFLICT (slug) DO UPDATE SET
            previous_manifest = public.app_manifest_snapshot.manifest,
            manifest_hash = EXCLUDED.manifest_hash,
            manifest = EXCLUDED.manifest,
            image_digest = EXCLUDED.image_digest,
            applied_at = NOW()`,
				[slug, manifest_hash, manifest, image_digest],
			);
		},
		async upsert_registry(patch) {
			await sql.unsafe(
				`INSERT INTO public.app_registry
            (slug, technical_id, repository, image_repo, policy, hold, pin_tag, channel,
             installed_tag, installed_digest, discovered_tag, previous_tag, install_status, enabled)
          VALUES ($1, $2, $3::jsonb, $4, $5, COALESCE($6, FALSE), $7, $8, $9, $10, $11, $12, $13, COALESCE($14, TRUE))
          ON CONFLICT (slug) DO UPDATE SET
            technical_id = EXCLUDED.technical_id,
            repository = COALESCE(EXCLUDED.repository, public.app_registry.repository),
            image_repo = COALESCE(EXCLUDED.image_repo, public.app_registry.image_repo),
            policy = COALESCE(EXCLUDED.policy, public.app_registry.policy),
            hold = COALESCE($6, public.app_registry.hold),
            pin_tag = COALESCE(EXCLUDED.pin_tag, public.app_registry.pin_tag),
            channel = COALESCE(EXCLUDED.channel, public.app_registry.channel),
            installed_tag = COALESCE(EXCLUDED.installed_tag, public.app_registry.installed_tag),
            installed_digest = COALESCE(EXCLUDED.installed_digest, public.app_registry.installed_digest),
            discovered_tag = COALESCE(EXCLUDED.discovered_tag, public.app_registry.discovered_tag),
            previous_tag = COALESCE(EXCLUDED.previous_tag, public.app_registry.previous_tag),
            install_status = COALESCE(EXCLUDED.install_status, public.app_registry.install_status),
            enabled = COALESCE($14, public.app_registry.enabled),
            updated_at = NOW()`,
				[
					patch.slug,
					patch.technical_id,
					patch.repository ?? null,
					patch.image_repo ?? null,
					patch.policy ?? null,
					patch.hold ?? null,
					patch.pin_tag ?? null,
					patch.channel ?? null,
					patch.installed_tag ?? null,
					patch.installed_digest ?? null,
					patch.discovered_tag ?? null,
					patch.previous_tag ?? null,
					patch.install_status ?? null,
					patch.enabled ?? null,
				],
			);
		},
		async insert_audit(row) {
			await sql.unsafe(
				`INSERT INTO public.app_registry_audit (actor_user_id, action, slug, detail)
          VALUES ($1, $2, $3, $4::jsonb)`,
				[row.actor_user_id, row.action, row.slug, row.detail ?? null],
			);
		},
	};
}

export async function registry_tag_index(
	sql: RegistrySql,
): Promise<Map<string, { installed_tag: string | null; discovered_tag: string | null }>> {
	const result = await sql.unsafe(
		`SELECT slug, installed_tag, discovered_tag FROM public.app_registry`,
	);
	const out = new Map<string, { installed_tag: string | null; discovered_tag: string | null }>();
	for (const row of rows_of(result)) {
		const slug = text_or_null(row.slug);
		if (!slug) continue;
		out.set(slug, {
			installed_tag: text_or_null(row.installed_tag),
			discovered_tag: text_or_null(row.discovered_tag),
		});
	}
	return out;
}
