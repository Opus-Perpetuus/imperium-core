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
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '').trim();
	return String(value).trim();
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
