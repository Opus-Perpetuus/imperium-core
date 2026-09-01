/**
 * Reportes ciudadanos: misma normalización y folio que el service original.
 */
import { as_object, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { format_model_field_value } from './custom-pattern-render.ts';

const REF_FIELDS = [
	'employee_taken_the_report',
	'assinged_to',
	'department',
	'cuadrilla',
	'jefe_de_cuadrilla',
	'citizen_report_problem',
	'reporting_medium',
	'borough',
	'delegado',
	'parent_report_id',
];

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') {
		const rec = value as { _id?: unknown; id?: unknown };
		return ref_id(rec._id ?? rec.id);
	}
	return String(value).trim();
}

const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;

function evidence_id(item: unknown): string | null {
	if (item == null || item === '') return null;
	if (typeof item === 'string') {
		const id = item.trim();
		return OBJECT_ID_HEX.test(id) ? id : null;
	}
	if (typeof item === 'object') {
		const nested =
			(item as { _id?: unknown; id?: unknown })._id ??
			(item as { id?: unknown }).id;
		if (nested == null || nested === '') return null;
		const id = String(nested).trim();
		return OBJECT_ID_HEX.test(id) ? id : null;
	}
	return null;
}

export function sanitize_citizen_report_evidence(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		const id = evidence_id(item);
		if (id) out.push(id);
	}
	return out;
}

function parse_coord(value: unknown, min: number, max: number): number | null {
	if (value == null || value === '') return null;
	const n = typeof value === 'number' ? value : Number(String(value).trim());
	if (!Number.isFinite(n) || n < min || n > max) return null;
	return Number(n.toFixed(6));
}

export function is_citizen_report_resource(resource: string) {
	return resource === 'citizen-report';
}

export async function prepare_citizen_report_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
	is_create: boolean,
): Promise<ImperiumDoc> {
	const doc: ImperiumDoc = { ...incoming };
	if (is_create) {
		delete doc.sequence;
		delete doc.name;
	}
	delete doc.images;
	for (const field of ['evidence_before_images', 'evidence_after_images'] as const) {
		if (!Object.hasOwn(doc, field)) continue;
		doc[field] = sanitize_citizen_report_evidence(doc[field]);
	}
	if (Object.hasOwn(doc, 'evidences')) {
		const leftover = doc.evidences;
		delete doc.evidences;
		const before = doc.evidence_before_images;
		const before_empty = !Array.isArray(before) || before.length === 0;
		if (before_empty && Array.isArray(leftover) && leftover.length > 0) {
			doc.evidence_before_images = sanitize_citizen_report_evidence(leftover);
		}
	}
	for (const field of REF_FIELDS) {
		if (!Object.hasOwn(doc, field)) continue;
		const id = ref_id(doc[field]);
		doc[field] = id || null;
	}
	if (Object.hasOwn(doc, 'citizen_email')) {
		doc.citizen_email = String(doc.citizen_email ?? '').trim().toLowerCase();
	}
	if (Object.hasOwn(doc, 'citizen_phone')) {
		const raw = String(doc.citizen_phone ?? '').trim();
		const plus = raw.startsWith('+');
		const digits = raw.replace(/\D/g, '');
		doc.citizen_phone = digits ? (plus ? `+${digits}` : digits) : '';
	}
	if (Object.hasOwn(doc, 'report_coordinates')) {
		const raw = doc.report_coordinates;
		if (!raw || typeof raw !== 'object') {
			doc.report_coordinates = null;
		} else {
			const coords = as_object(raw);
			const latitude = parse_coord(coords.latitude, -90, 90);
			const longitude = parse_coord(coords.longitude, -180, 180);
			doc.report_coordinates =
				latitude == null || longitude == null ? null : { latitude, longitude };
		}
	}
	if (is_create) {
		const name = String(doc.citizen_name ?? '').trim();
		const email = String(doc.citizen_email ?? '').trim();
		if (!name) throw new Error('Debes definir el nombre del ciudadano');
		if (!email) throw new Error('Debes definir el email del ciudadano');
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			throw new Error('Debes definir un email valido');
		}
		const sequence = await store.next_auto_increment('CitizenReport', 'sequence', {
			resource: 'citizen-report',
			context: doc,
		});
		doc.sequence = sequence;
		doc.name = String(
			await format_model_field_value(store, 'CitizenReport', 'name', sequence, {
				...doc,
				sequence,
			}, `CR-${sequence}`),
		);
		if (!doc.status) doc.status = 'pendiente';
	}
	return doc;
}
