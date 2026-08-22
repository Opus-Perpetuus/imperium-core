/**
 * Asociaciones: el formulario manda tipo/fecha/notas transitorios
 * y el service original los acumula en `interacciones`.
 */
import { as_array, type ImperiumDoc } from './envelope.ts';

const TIPOS = new Set(['llamada', 'correo', 'carta', 'persona', 'registro']);

function trim_text(value: unknown): string {
	return String(value ?? '').trim();
}

function extract_interaccion(body: ImperiumDoc): ImperiumDoc | null {
	const tipo_raw = body.tipo_interaccion;
	const fecha_raw = body.fecha_interaccion;
	const notas = trim_text(body.notas_interaccion);
	delete body.tipo_interaccion;
	delete body.fecha_interaccion;
	delete body.notas_interaccion;
	if (!notas && (fecha_raw == null || fecha_raw === '')) return null;
	const tipo = TIPOS.has(String(tipo_raw ?? '')) ? String(tipo_raw) : 'llamada';
	const parsed = fecha_raw ? new Date(String(fecha_raw)) : null;
	const fecha =
		parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
	return { tipo, ...(fecha ? { fecha } : {}), notas };
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
		doc.interacciones = interaccion ? [interaccion] : [];
	} else {
		const previas = as_array(previous?.interacciones);
		doc.interacciones = interaccion ? [...previas, interaccion] : previas;
	}
	return doc;
}
