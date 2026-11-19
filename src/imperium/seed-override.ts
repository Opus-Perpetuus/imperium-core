/**
 * Semillas con `override`: la versión oficial nueva reemplaza al registro solo
 * si el cliente no lo personalizó.
 *
 * Se compara una huella (sha256 de los campos que trae la semilla, sin `_ref`
 * ni metadatos). El registro se considera intacto, y se actualiza, cuando:
 * - su contenido coincide con la huella que se le estampó al aplicarlo
 *   (`seed_fingerprint` sobre los campos de `seed_fields`), o
 * - coincide con alguna semilla oficial anterior de su `_ref`
 *   (official-seed-fingerprints.json, para los registros sembrados antes de
 *   que existiera la estampa).
 * Si no, el cliente lo editó: se respeta y se avisa en el log. «Forzar
 * recreación» (`force`) sigue sobrescribiendo a propósito.
 */
import { createHash } from 'node:crypto';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import official_seed_fingerprints from './official-seed-fingerprints.json';

export const SEED_FINGERPRINT_FIELD = 'seed_fingerprint';
export const SEED_FIELDS_FIELD = 'seed_fields';

export type OfficialFingerprints = Record<string, { fields: string[]; hashes: string[] }[]>;

const META_FIELDS = new Set([
	'_ref',
	'ref',
	'_id',
	'id',
	'createdAt',
	'updatedAt',
	'created_at',
	'updated_at',
	'payload',
	SEED_FINGERPRINT_FIELD,
	SEED_FIELDS_FIELD,
]);

/** Campos de contenido de una semilla: lo que la semilla escribe. */
export function seed_content_fields(doc: Record<string, unknown>): string[] {
	return Object.keys(doc)
		.filter((key) => !META_FIELDS.has(key))
		.sort();
}

/* La BD regresa números como texto y null/'' indistintos: se comparan como texto. */
function normalize(value: unknown): unknown {
	if (value === null || value === undefined || value === '') return '';
	if (Array.isArray(value)) return value.map(normalize);
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') {
		return Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => [key, normalize((value as Record<string, unknown>)[key])]);
	}
	return String(value);
}

export function seed_fingerprint(doc: Record<string, unknown>, fields: string[]): string {
	const content = fields.map((field) => [field, normalize(doc[field])]);
	return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
}

export type OverrideSeedAction =
	| 'crear'
	| 'actualizar'
	| 'al-dia'
	| 'personalizado';

export type OverrideSeedDecision = {
	action: OverrideSeedAction;
	motivo: string;
	fields: string[];
	fingerprint: string;
};

function stamped_intact(existing: ImperiumDoc): boolean {
	const stamp = existing[SEED_FINGERPRINT_FIELD];
	const fields = existing[SEED_FIELDS_FIELD];
	if (typeof stamp !== 'string' || !Array.isArray(fields) || !fields.length) return false;
	return seed_fingerprint(existing, fields.map(String)) === stamp;
}

export function decide_override_seed(
	existing: ImperiumDoc | null,
	seed_doc: Record<string, unknown>,
	official: OfficialFingerprints = official_seed_fingerprints as OfficialFingerprints,
): OverrideSeedDecision {
	const fields = seed_content_fields(seed_doc);
	const fingerprint = seed_fingerprint(seed_doc, fields);
	const base = { fields, fingerprint };
	if (!existing) return { ...base, action: 'crear', motivo: 'no existe' };
	if (seed_fingerprint(existing, fields) === fingerprint) {
		return { ...base, action: 'al-dia', motivo: 'ya es la semilla actual' };
	}
	if (stamped_intact(existing)) {
		return { ...base, action: 'actualizar', motivo: 'sin cambios desde la semilla que se aplicó' };
	}
	const ref = String(seed_doc._ref ?? '');
	for (const entry of official[ref] ?? []) {
		if (entry.hashes.includes(seed_fingerprint(existing, entry.fields))) {
			return { ...base, action: 'actualizar', motivo: 'igual a una semilla oficial anterior' };
		}
	}
	return { ...base, action: 'personalizado', motivo: 'el cliente lo modificó' };
}

type SeedLog = Pick<Console, 'info' | 'warn'>;

/** Upsert por `_ref` de una semilla con override, sin pisar personalizaciones. */
export async function upsert_override_seed(
	store: ImperiumStore,
	resource: string,
	model: string,
	doc: ImperiumDoc,
	options: { force?: boolean; official?: OfficialFingerprints; log?: SeedLog } = {},
): Promise<OverrideSeedDecision> {
	const log = options.log ?? console;
	const ref = String(doc._ref ?? '');
	const existing =
		(await store.find_where(resource, { _ref: ref })) ??
		(await store.find_where(resource, { ref }));
	const decision = decide_override_seed(existing, doc, options.official);
	const stamp = {
		[SEED_FINGERPRINT_FIELD]: decision.fingerprint,
		[SEED_FIELDS_FIELD]: decision.fields,
	};
	const label = `${model} «${String(doc.name ?? existing?.name ?? ref)}» (${ref})`;
	if (!existing) {
		await store.insert(resource, { ...doc, ...stamp });
		return decision;
	}
	const id = String(existing._id);
	if (decision.action === 'personalizado' && !options.force) {
		log.warn(
			`[semillas] ${label}: personalizado por el cliente, se respeta y no se sobrescribe con la semilla oficial. «Forzar recreación» lo reemplaza.`,
		);
		return decision;
	}
	if (decision.action === 'al-dia') {
		if (existing[SEED_FINGERPRINT_FIELD] !== decision.fingerprint) {
			await store.update(resource, id, stamp);
		}
		return decision;
	}
	await store.update(resource, id, { ...doc, ...stamp });
	log.info(
		`[semillas] ${label}: actualizado a la semilla oficial (${options.force && decision.action === 'personalizado' ? 'forzado' : decision.motivo}).`,
	);
	return decision;
}
