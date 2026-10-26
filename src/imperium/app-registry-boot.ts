import { read_app_registry_enabled } from './app-registry.ts';
import { read_installed_image_manifest, sync_installed_manifests } from './app-registry-sync.ts';
import type { ImperiumStore } from './store.ts';

/** No bloquea el arranque: sin Docker el lector responde skipped y no borra snapshots. */
export async function start_registry_cold_sync(store: ImperiumStore, sql: Bun.SQL): Promise<void> {
	if (!(await read_app_registry_enabled(store))) return;
	await sync_installed_manifests(sql, read_installed_image_manifest);
}
