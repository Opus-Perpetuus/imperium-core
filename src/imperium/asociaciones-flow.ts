/**
 * Asociaciones: el formulario manda tipo/fecha/notas transitorios
 * y el service original los acumula en `interacciones`.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';

function trim_text(value: unknown): string {
	return String(value ?? '').trim();
}

const TIPOS_INTERACCION = [
	'llamada',
	'correo',
	'carta',
	'persona',
	'registro',
] as const;

function parse_interaccion_fecha(value: unknown): Date | undefined {
	if (value == null || value === '') return undefined;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : value;
	}
	const text = String(value).trim();
	if (!text) return undefined;
	const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
	if (ymd) {
		const date = new Date(
			Number(ymd[1]),
			Number(ymd[2]) - 1,
			Number(ymd[3]),
			0,
			0,
			0,
			0,
		);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function normalize_tipo_interaccion(value: unknown): string {
	if (value && typeof value === 'object' && 'value' in value) {
		value = (value as { value: unknown }).value;
	}
	const text = String(value ?? '').trim();
	return (TIPOS_INTERACCION as readonly string[]).includes(text)
		? text
		: 'llamada';
}

function same_calendar_day(left?: Date, right?: Date): boolean {
	if (!left && !right) return true;
	if (!left || !right) return false;
	return (
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate()
	);
}

function extract_interaccion(body: ImperiumDoc): ImperiumDoc | null {
	const tipo_raw = body.tipo_interaccion;
	const fecha_raw = body.fecha_interaccion;
	const notas = trim_text(body.notas_interaccion);
	delete body.tipo_interaccion;
	delete body.fecha_interaccion;
	delete body.notas_interaccion;
	const parsed = parse_interaccion_fecha(fecha_raw);
	if (!notas && !parsed) return null;
	const tipo = normalize_tipo_interaccion(tipo_raw);
	const fecha = parsed ? parsed.toISOString() : undefined;
	return { tipo, ...(fecha ? { fecha } : {}), notas };
}

function merge_interaccion(
	previas: unknown,
	nueva: ImperiumDoc | null,
): ImperiumDoc[] {
	const list = as_array(previas).map((item) => {
		const row = item && typeof item === 'object' ? (item as ImperiumDoc) : {};
		return {
			tipo: normalize_tipo_interaccion(row.tipo),
			...(row.fecha != null && row.fecha !== '' ? { fecha: row.fecha } : {}),
			notas: trim_text(row.notas),
		};
	});
	if (!nueva) return list;
	if (list.length === 0) return [nueva];
	const last = list[list.length - 1];
	const same_tipo = last.tipo === nueva.tipo;
	const same_notas = trim_text(last.notas) === trim_text(nueva.notas);
	const same_day = same_calendar_day(
		parse_interaccion_fecha(last.fecha),
		parse_interaccion_fecha(nueva.fecha),
	);
	if (same_tipo && same_notas && same_day) return list;
	if (same_tipo && same_notas) {
		list[list.length - 1] = { ...last, ...nueva };
		return list;
	}
	return [...list, nueva];
}

export function is_asociacion_resource(resource: string) {
	return resource === 'asociaciones';
}

export function prepare_asociacion_write(
	incoming: ImperiumDoc,
	previous: ImperiumDoc | null,
	is_create: boolean,
): ImperiumDoc {
	const doc: ImperiumDoc = { ...incoming };
	const interaccion = extract_interaccion(doc);
	if (Object.hasOwn(doc, 'name') || is_create) {
		const name = trim_text(doc.name);
		if (!name) throw new Error('Debes definir un nombre');
		if (name.length < 4) {
			throw new Error('El nombre debe contener cuatro letras o mas');
		}
		doc.name = name;
	}
	for (const field of ['telefono', 'correo', 'ciudad', 'localidad', 'pais', 'observaciones']) {
		if (Object.hasOwn(doc, field)) doc[field] = trim_text(doc[field]);
	}
	if (is_create) {
		doc.interacciones = merge_interaccion([], interaccion);
	} else {
		doc.interacciones = merge_interaccion(previous?.interacciones, interaccion);
	}
	return doc;
}
