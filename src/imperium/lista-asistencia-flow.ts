/**
 * Asistencia escolar: mismo ciclo que registro-asistencias.service
 * y lista-asistencia.service (snapshot del grupo, pase de lista, incidencias).
 */
import { type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const OPEN = 'abierta';
const CLOSED = 'cerrada';
const MARK_STATES = new Set(['pendiente', 'presente', 'ausente']);

export function is_registro_asistencia_resource(resource: string) {
	return resource === 'registro-asistencias';
}

export function is_lista_asistencia_resource(resource: string) {
	return resource === 'lista-asistencia';
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'object') {
		const obj = value as { _id?: unknown; id?: unknown; client_id?: unknown };
		return String(obj._id ?? obj.id ?? obj.client_id ?? '').trim();
	}
	return String(value).trim();
}

function actor_id(actor: ImperiumDoc | null): string {
	return ref_id(actor?._id ?? actor?.id);
}

function normalize_date(value: unknown): string {
	if (!value) return new Date().toISOString();
	if (value instanceof Date) return value.toISOString();
	const parsed = new Date(String(value));
	return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalize_number(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const n = Number(value.trim());
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

export function apply_registro_asistencia_list_where(
	where: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...where };
	const grupo_id = ref_id(out.grupo_id);
	if (grupo_id) out.grupo_id = grupo_id;
	else delete out.grupo_id;
	return out;
}

export function apply_lista_asistencia_list_where(
	where: Record<string, unknown>,
): Record<string, unknown> {
	const out = { ...where };
	for (const field of ['registro_asistencia_id', 'grupo_id', 'alumno_id'] as const) {
		if (!Object.hasOwn(out, field)) continue;
		const id = ref_id(out[field]);
		if (id) out[field] = id;
		else delete out[field];
	}
	return out;
}

export async function ensure_attendance_is_open(
	store: ImperiumStore,
	registro_asistencia_id: string,
): Promise<ImperiumDoc> {
	const id = text(registro_asistencia_id);
	if (!id) throw new Error('No se encontró el registro de asistencia');
	const attendance = store.has('registro-asistencias')
		? await store.find_id('registro-asistencias', id)
		: null;
	if (!attendance) throw new Error('No se encontró el registro de asistencia');
	const estatus = text(attendance.estatus ?? attendance.estado);
	if (estatus === CLOSED) {
		throw new Error('La asistencia ya está cerrada y no permite modificar sus alumnos');
	}
	return attendance;
}

export function prepare_registro_asistencia_write(
	incoming: ImperiumDoc,
	actor: ImperiumDoc | null,
	is_create: boolean,
): ImperiumDoc {
	const grupo_id = ref_id(incoming.grupo_id);
	if (!grupo_id) throw new Error('Debes indicar el grupo de la asistencia');
	const fecha_asistencia = normalize_date(incoming.fecha_asistencia);
	const name = text(incoming.name) || `Asistencia ${fecha_asistencia.slice(0, 10)}`;
	return {
		...incoming,
		name,
		description: text(incoming.description),
		grupo_id,
		materia_id: ref_id(incoming.materia_id) || undefined,
		teacher_user_id: ref_id(incoming.teacher_user_id) || actor_id(actor) || undefined,
		fecha_asistencia,
		estatus: text(incoming.estatus) || (is_create ? OPEN : incoming.estatus),
	};
}

export async function snapshot_attendance_entries(
	store: ImperiumStore,
	created: ImperiumDoc,
): Promise<ImperiumDoc> {
	const attendance_id = String(created._id ?? '');
	const grupo_id = ref_id(created.grupo_id);
	if (!attendance_id || !grupo_id || !store.has('alumnos') || !store.has('lista-asistencia')) {
		return created;
	}
	const { rows } = await store.find_many('alumnos', {
		where: { grupo_id },
		take: 20000,
		include_inactive: false,
		populate: false,
	});
	const students = rows
		.filter((row) => row.is_active !== false && ref_id(row.grupo_id) === grupo_id)
		.sort((a, b) => {
			const na = Number(a.numero_lista ?? 0) - Number(b.numero_lista ?? 0);
			if (na) return na;
			return text(a.name).localeCompare(text(b.name), 'es');
		});
	const attendance_name = text(created.name) || 'Asistencia';
	for (const [index, student] of students.entries()) {
		await store.insert('lista-asistencia', {
			name: `${attendance_name} - ${text(student.name)}`,
			registro_asistencia_id: attendance_id,
			alumno_id: student._id,
			grupo_id,
			alumno_nombre_snapshot: text(student.name),
			numero_lista: Number(student.numero_lista ?? index + 1),
			estado: 'pendiente',
			justificada: false,
			evidencia: '',
			description: '',
		});
	}
	const saved = await store.update('registro-asistencias', attendance_id, {
		total_alumnos: students.length,
	});
	return saved ?? { ...created, total_alumnos: students.length };
}

export async function prepare_lista_asistencia_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
): Promise<ImperiumDoc> {
	const registro_asistencia_id = ref_id(incoming.registro_asistencia_id);
	const alumno_id = ref_id(incoming.alumno_id);
	const grupo_id = ref_id(incoming.grupo_id);
	if (!registro_asistencia_id || !alumno_id || !grupo_id) {
		throw new Error('Debes indicar el registro de asistencia, alumno y grupo de la fila');
	}
	await ensure_attendance_is_open(store, registro_asistencia_id);
	return {
		...incoming,
		name: text(incoming.name) || 'Fila de asistencia',
		registro_asistencia_id,
		alumno_id,
		grupo_id,
		alumno_nombre_snapshot:
			text(incoming.alumno_nombre_snapshot) || text(incoming.name) || 'Alumno',
		numero_lista: normalize_number(incoming.numero_lista),
		estado: text(incoming.estado) || 'pendiente',
		justificada: Boolean(incoming.justificada),
		evidencia: text(incoming.evidencia),
		description: text(incoming.description),
		registro_incidencia_id: ref_id(incoming.registro_incidencia_id) || undefined,
	};
}

export async function mark_lista_asistencia(
	store: ImperiumStore,
	entry_id: string,
	body: ImperiumDoc,
): Promise<ImperiumDoc> {
	const id = text(entry_id);
	const entry = id && store.has('lista-asistencia') ? await store.find_id('lista-asistencia', id) : null;
	if (!entry) throw new Error('No se encontró la fila de asistencia solicitada');
	const estado = text(body.estado) || 'pendiente';
	if (!MARK_STATES.has(estado)) throw new Error('El estado de asistencia no es válido');
	const attendance = await ensure_attendance_is_open(
		store,
		ref_id(entry.registro_asistencia_id),
	);
	const justificada = estado === 'ausente' ? Boolean(body.justificada) : false;
	const evidencia = estado === 'ausente' ? text(body.evidencia) : '';
	const description = text(body.description);
	const patch: ImperiumDoc = { estado, justificada, evidencia, description };
	if (estado === 'ausente' && store.has('registro-incidencias')) {
		const incident = await store.insert('registro-incidencias', {
			name: `Ausencia ${text(entry.alumno_nombre_snapshot) || text(entry.name)}`.trim(),
			description,
			alumno_id: entry.alumno_id,
			grupo_id: entry.grupo_id,
			registro_asistencia_id: entry.registro_asistencia_id,
			lista_asistencia_id: entry._id,
			materia_id: attendance.materia_id,
			tipo: 'ausencia',
			justificada,
			evidencia,
			fecha_asistencia: attendance.fecha_asistencia ?? new Date().toISOString(),
		});
		patch.registro_incidencia_id = incident._id;
	}
	const saved = await store.update('lista-asistencia', String(entry._id), patch);
	if (!saved) throw new Error('No se encontró la fila de asistencia solicitada');
	return saved;
}
