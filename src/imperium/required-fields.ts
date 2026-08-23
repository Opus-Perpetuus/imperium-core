/**
 * Required de Mongoose (`schema-constraints.json`) + `field_errors` del
 * `ValidationError` original.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type SchemaConstraints = {
	required: Record<string, string[]>;
};

const CONSTRAINTS: SchemaConstraints = JSON.parse(
	readFileSync(join(import.meta.dir, 'schema-constraints.json'), 'utf8'),
) as SchemaConstraints;

const RESOURCE_ALIASES: Record<string, string> = {
	proyectos: 'planeacion-proyectos',
	'mis-tareas': 'planeacion-mis-tareas',
	'proyectos-task': 'planeacion-proyectos-task',
	'pedidos-surtir': 'pedidos',
	usuario: 'user',
};

const FIELD_MESSAGES: Record<string, string> = {
	name: 'Debes definir un nombre',
	email: 'El email es requerido',
	placas: 'Debes definir las placas',
	'tags.name': 'Debes definir un nombre para la etiqueta',
};

export class FieldValidationError extends Error {
	status = 400;
	code = 'ValidationError';
	field_errors: Record<string, string[]>;

	constructor(field_errors: Record<string, string[]>, message: string) {
		super(message);
		this.field_errors = field_errors;
	}
}

export function required_fields_for(resource: string): string[] {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return CONSTRAINTS.required[canonical] ?? CONSTRAINTS.required[resource] ?? [];
}

export function assert_required_fields(resource: string, doc: Record<string, unknown>) {
	const field_errors: Record<string, string[]> = {};
	for (const field of required_fields_for(resource)) {
		if (field.includes('.')) continue;
		if (!is_missing(doc[field])) continue;
		field_errors[field] = [required_message(resource, field)];
	}
	if (!Object.keys(field_errors).length) return;
	const model = model_label(resource);
	const detail = Object.entries(field_errors)
		.map(([field, messages]) => `${field}: ${messages[0]}`)
		.join(', ');
	throw new FieldValidationError(field_errors, `${model} validation failed: ${detail}`);
}

function required_message(resource: string, field: string) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return (
		FIELD_MESSAGES[`${canonical}.${field}`] ??
		FIELD_MESSAGES[`${resource}.${field}`] ??
		FIELD_MESSAGES[field] ??
		'Debes definir un valor'
	);
}

function is_missing(value: unknown) {
	if (value === undefined || value === null) return true;
	if (typeof value === 'string' && value.trim() === '') return true;
	if (Array.isArray(value) && value.length === 0) return true;
	return false;
}

function model_label(resource: string) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return canonical.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
}
