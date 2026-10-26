/**
 * Catálogo e instalación desde el registro. Nadie escribe
 * `IMPERIUM_SUBJECT_TAG_*`: el tag aplicado queda en `app_registry.installed_tag`.
 */
import { image_tag, registry_tag_or_null, subject_image_ref } from './subject-runtime.ts';
import type { AppRegistryRepository, RegistryRow } from './app-registry-store.ts';
import { sync_slug_manifest, type ManifestReader } from './app-registry-sync.ts';

export type CatalogApp = {
	slug: string;
	name: string;
	technical_id: string;
	image: string;
	installed?: boolean;
};

export type CatalogItem = {
	slug: string;
	name: string;
	technical_id: string;
	image: string;
	installed: boolean;
	installed_tag: string | null;
	discovered_tag: string | null;
	install_status: string | null;
	pin_tag: string;
	envWrite: false;
};

function digest_or_null(value: unknown): string | null {
	const text = String(value ?? '').trim();
	return /^sha256:[a-f0-9]{64}$/.test(text) ? text : null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function page_registry_catalog(input: {
	subjects: readonly CatalogApp[];
	registry: readonly RegistryRow[];
	q?: string;
	installed?: boolean | null;
	cursor?: string;
	limit?: number;
}): { items: CatalogItem[]; next_cursor: string | null } {
	const by_slug = new Map(input.registry.map((row) => [row.slug, row]));
	const seen = new Set<string>();
	const items: CatalogItem[] = [];
	const push = (app: CatalogApp) => {
		if (seen.has(app.slug)) return;
		seen.add(app.slug);
		const row = by_slug.get(app.slug);
		const installed = app.installed === true || row?.install_status === 'ok';
		items.push({
			slug: app.slug,
			name: app.name,
			technical_id: app.technical_id,
			image: app.image,
			installed,
			installed_tag: row?.installed_tag ?? null,
			discovered_tag: row?.discovered_tag ?? null,
			install_status: row?.install_status ?? null,
			pin_tag: image_tag(app.image),
			envWrite: false,
		});
	};
	for (const app of input.subjects) push(app);
	for (const row of input.registry) {
		if (seen.has(row.slug)) continue;
		push({
			slug: row.slug,
			name: row.slug,
			technical_id: row.technical_id,
			image: row.image_repo ?? '',
			installed: row.install_status === 'ok',
		});
	}
	const q = (input.q ?? '').trim().toLowerCase();
	let filtered = items;
	if (q) {
		filtered = items.filter((item) =>
			[item.slug, item.name, item.technical_id].some((value) => value.toLowerCase().includes(q)),
		);
	}
	if (input.installed === true) filtered = filtered.filter((item) => item.installed);
	if (input.installed === false) filtered = filtered.filter((item) => !item.installed);
	filtered.sort((a, b) => a.slug.localeCompare(b.slug));
	const cursor = (input.cursor ?? '').trim();
	if (cursor) filtered = filtered.filter((item) => item.slug > cursor);
	const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
	const page = filtered.slice(0, limit);
	const next = filtered.length > limit ? (page[page.length - 1]?.slug ?? null) : null;
	return { items: page, next_cursor: next };
}

export function version_view(app: CatalogApp | null, row: RegistryRow | null) {
	const pin = image_tag(app?.image ?? row?.image_repo ?? '');
	return {
		slug: row?.slug ?? app?.slug ?? '',
		installed_tag: row?.installed_tag ?? null,
		discovered_tag: row?.discovered_tag ?? null,
		pin_tag: pin,
		policy: {
			policy: row?.policy ?? null,
			hold: row?.hold === true,
			minAgeHours: null,
		},
		suggestions: row?.discovered_tag ? [{ tag: row.discovered_tag, source: 'registry' }] : [],
		envWrite: false as const,
	};
}

export type DockerInstall = (input: {
	slug: string;
	image: string;
	registry_installed_tag: string | null;
}) => Promise<{ ok: boolean; skipped: boolean; image: string | null; error?: string }>;

export async function install_registry_app(input: {
	repo: AppRegistryRepository;
	slug: string;
	app: CatalogApp | null;
	tag?: string | null;
	digest?: string | null;
	actor: string | null;
	run: DockerInstall;
	read: ManifestReader;
}): Promise<{ status: number; body: Record<string, unknown> }> {
	const row = await input.repo.get_registry(input.slug);
	if (!input.app && !row) {
		return { status: 404, body: { error: 'not_found', message: 'App desconocida' } };
	}
	const requested = registry_tag_or_null(input.tag);
	const current = row?.installed_tag ?? null;
	if (row?.install_status === 'ok' && current && (!requested || requested === current)) {
		return {
			status: 409,
			body: {
				error: 'already_installed',
				message: 'La app ya está instalada en ese tag.',
				installed_tag: current,
				envWrite: false,
			},
		};
	}
	const tag = requested || current || image_tag(input.app?.image ?? '') || null;
	const image = subject_image_ref({
		slug: input.slug,
		image: input.app?.image,
		registry_installed_tag: tag,
	});
	const applied_tag = image_tag(image) || tag;
	const docker = await input.run({
		slug: input.slug,
		image,
		registry_installed_tag: applied_tag,
	});
	if (docker.skipped) {
		return {
			status: 200,
			body: {
				slug: input.slug,
				applied: false,
				envWrite: false,
				suggestion: { tag: applied_tag, image, digest: input.digest ?? null },
				message: 'Docker no está en este proceso. No se escribió el tag ni el entorno.',
			},
		};
	}
	if (!docker.ok) {
		await input.repo.upsert_registry({
			slug: input.slug,
			technical_id: input.app?.technical_id ?? row?.technical_id ?? `subject-${input.slug}`,
			install_status: 'failed',
			previous_tag: current,
		});
		await input.repo.insert_audit({
			actor_user_id: input.actor,
			action: 'install',
			slug: input.slug,
			detail: { ok: false, error: docker.error ?? 'docker' },
		});
		return {
			status: 502,
			body: {
				error: 'install_failed',
				message: docker.error || 'No se pudo instalar la imagen.',
				envWrite: false,
			},
		};
	}
	const synced = await sync_slug_manifest(input.repo, input.slug, input.read, input.actor);
	if (synced.status !== 200 || synced.body.skipped === true) {
		await input.repo.upsert_registry({
			slug: input.slug,
			technical_id: input.app?.technical_id ?? `subject-${input.slug}`,
			install_status: 'failed',
			previous_tag: current,
		});
		return {
			status: synced.status === 200 ? 422 : synced.status,
			body: {
				...synced.body,
				message:
					synced.status === 409
						? 'El contenedor arrancó, pero un segmento choca con otra app. El snapshot anterior se conserva.'
						: 'El contenedor arrancó, pero el manifiesto no se aplicó. El snapshot anterior se conserva.',
				envWrite: false,
			},
		};
	}
	await input.repo.upsert_registry({
		slug: input.slug,
		technical_id: input.app?.technical_id ?? row?.technical_id ?? `subject-${input.slug}`,
		installed_tag: applied_tag,
		installed_digest: digest_or_null(input.digest),
		previous_tag: current && current !== applied_tag ? current : row?.previous_tag ?? null,
		install_status: 'ok',
		image_repo: image,
	});
	await input.repo.insert_audit({
		actor_user_id: input.actor,
		action: 'install',
		slug: input.slug,
		detail: { installed_tag: applied_tag, envWrite: false },
	});
	return {
		status: 200,
		body: {
			slug: input.slug,
			applied: true,
			installed_tag: applied_tag,
			manifest_hash: synced.body.manifest_hash ?? null,
			envWrite: false,
		},
	};
}
