import {
	APP_REGISTRY_ENABLED_REF,
	app_registry_env_override,
	read_app_registry_enabled,
} from './app-registry.ts';
import { read_installed_image_manifest, sync_installed_manifests } from './app-registry-sync.ts';
import type { ImperiumStore } from './store.ts';
import { coerce_flag } from './subject-versions.ts';

export type EnsureAppRegistryResult = {
	/** Valor efectivo tras el pase (env gana sobre config). */
	enabled: boolean;
	/** Se escribió `true` en configuration (insert o update). */
	flipped: boolean;
};

/**
 * Migración estática→dynamic: enciende `configuration-app-registry-enabled`.
 * Idempotente. No toca menús ni ACL. `IMPERIUM_APP_REGISTRY=0` no escribe y deja off.
 */
export async function ensure_app_registry_enabled(
	store: ImperiumStore,
): Promise<EnsureAppRegistryResult> {
	const override = app_registry_env_override();
	if (override === false) {
		return { enabled: false, flipped: false };
	}
	let flipped = false;
	try {
		if (store.has('configuration')) {
			const doc = await store.find_where('configuration', {
				_ref: APP_REGISTRY_ENABLED_REF,
			});
			if (!doc) {
				await store.insert('configuration', {
					_ref: APP_REGISTRY_ENABLED_REF,
					description:
						'Si está en SI, el núcleo expone el registro de apps. Si está en NO, esas rutas responden como si no existieran. IMPERIUM_APP_REGISTRY=1 lo enciende y =0 lo apaga aunque aquí diga otra cosa.',
					is_system: true,
					module_id: 'NA',
					name: 'Registro de apps',
					type: 'switch',
					value: true,
				} as never);
				flipped = true;
			} else if (!coerce_flag(doc.value)) {
				const id = String(doc._id ?? doc.id ?? '');
				if (id) {
					await store.update('configuration', id, { value: true } as never);
					flipped = true;
				}
			}
		}
	} catch {
		/* tabla ausente o carrera: cold-sync se salta si el flag sigue off */
	}
	const enabled = await read_app_registry_enabled(store);
	return { enabled, flipped };
}

/** No bloquea el arranque: sin Docker el lector responde skipped y no borra snapshots. */
export async function start_registry_cold_sync(store: ImperiumStore, sql: Bun.SQL): Promise<void> {
	await ensure_app_registry_enabled(store);
	if (!(await read_app_registry_enabled(store))) return;
	await sync_installed_manifests(sql, read_installed_image_manifest);
}
