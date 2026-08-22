/**
 * Incidencias escolares: misma normalización de refs y filtros
 * que el service original.
 */
import type { ImperiumDoc } from './envelope.ts';

const REF_FIELDS = [
	'alumno_id',
	'grupo_id',
	'registro_asistencia_id',
	'lista_asistencia_id',
	'materia_id',
	'grado_escolar_id',
	'escuela_id',
] as const;

const LIST_FILTERS = [
	'alumno_id',
	'grupo_id',
	'registro_asistencia_id',
	'lista_asistencia_id',
] as const;

function trim_text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') {
		const obj = value as { _id?: unknown; id?: unknown; client_id?: unknown };
		return String(obj._id ?? obj.id ?? obj.client_id ?? '').trim();
	}
	return String(value).trim();
}

export function is_incidencia_resource(resource: string) {
	return resource === 'registro-incidencias';
}

export function apply_incidencia_list_where(
	where: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...where };
	for (const field of LIST_FILTERS) {
		if (!Object.hasOwn(out, field)) continue;
		const id = ref_id(out[field]);
		if (id) out[field] = id;
		else delete out[field];
	}
	return out;
}

export function prepare_incidencia_write(
	incoming: ImperiumDoc,
	is_create: boolean,
): ImperiumDoc {
	const doc: ImperiumDoc = { ...incoming };
	const name =
		trim_text(doc.name) ||
		trim_text(doc.description) ||
		(is_create ? 'Incidencia escolar' : '');
	if (name) doc.name = name;
	if (is_create || Object.hasOwn(doc, 'description')) {
		doc.description = trim_text(doc.description);
	}
	for (const field of REF_FIELDS) {
		if (!Object.hasOwn(doc, field)) continue;
		const id = ref_id(doc[field]);
		doc[field] = id || null;
	}
	if (is_create || Object.hasOwn(doc, 'tipo')) {
		doc.tipo = trim_text(doc.tipo) || 'ausencia';
	}
	if (is_create || Object.hasOwn(doc, 'justificada')) {
		doc.justificada = Boolean(doc.justificada);
	}
	if (is_create || Object.hasOwn(doc, 'evidencia')) {
		doc.evidencia = trim_text(doc.evidencia);
	}
	if (Object.hasOwn(doc, 'fecha_asistencia')) {
		if (!doc.fecha_asistencia) {
			doc.fecha_asistencia = null;
		} else {
			const parsed = new Date(String(doc.fecha_asistencia));
			doc.fecha_asistencia = Number.isNaN(parsed.getTime())
				? null
				: parsed.toISOString();
		}
	}
	return doc;
}
