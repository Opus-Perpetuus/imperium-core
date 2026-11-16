import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

export const INTERACTIVE_MANUAL_RESOURCE = 'interactive-manual';

type SeedStore = Pick<ImperiumStore, 'has' | 'insert' | 'scan'>;

/**
 * Guías de los feature maps como manuales interactivos reproducibles. Las
 * genera `yarn flow manual` (e2e/flow/manual.mjs) desde los `.flow.yaml`.
 */
export function load_interactive_manual_seeds(): ImperiumDoc[] {
	const file = join(import.meta.dir, 'interactive-manual-seeds.json');
	const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
	return Array.isArray(parsed) ? (parsed as ImperiumDoc[]) : [];
}

/**
 * Crea las guías que falten por `_ref` sin pisar las existentes: lo que el
 * administrador editó o desactivó (`is_active: false`) se queda como está.
 * Corre al arrancar (instancia nueva incluida) y en «Sembrar opciones por
 * defecto». Devuelve cuántas creó.
 */
export async function seed_interactive_manuals(
	store: SeedStore,
	seeds: ImperiumDoc[] = load_interactive_manual_seeds(),
): Promise<number> {
	if (!store.has(INTERACTIVE_MANUAL_RESOURCE) || !seeds.length) return 0;
	const existing = new Set<string>();
	for await (const batch of store.scan(INTERACTIVE_MANUAL_RESOURCE, {
		include_inactive: true,
		omit: ['steps'],
	})) {
		for (const row of batch) {
			const ref = String(row._ref ?? row.ref ?? '');
			if (ref) existing.add(ref);
		}
	}
	let created = 0;
	for (const seed of seeds) {
		const ref = String(seed._ref ?? '');
		if (!ref || existing.has(ref)) continue;
		await store.insert(INTERACTIVE_MANUAL_RESOURCE, structuredClone(seed));
		existing.add(ref);
		created += 1;
	}
	return created;
}
