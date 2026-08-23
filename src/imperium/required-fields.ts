/**
 * Required / minlength / maxlength de Mongoose + `field_errors` del
 * `ValidationError` original.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type SchemaConstraints = {
	required: Record<string, string[]>;
};

type StringLimits = {
	minlength: Record<string, Record<string, { min: number; message: string }>>;
	maxlength: Record<string, Record<string, { max: number; message: string }>>;
};

const CONSTRAINTS: SchemaConstraints = JSON.parse(
	readFileSync(join(import.meta.dir, 'schema-constraints.json'), 'utf8'),
) as SchemaConstraints;

const STRING_LIMITS: StringLimits = JSON.parse(
	readFileSync(join(import.meta.dir, 'schema-string-limits.json'), 'utf8'),
) as StringLimits;

type MatchRule = { pattern: string; flags: string; message: string };
const MATCH_RULES: Record<string, Record<string, MatchRule>> = (
	JSON.parse(readFileSync(join(import.meta.dir, 'schema-match.json'), 'utf8')) as {
		match: Record<string, Record<string, MatchRule>>;
	}
).match;

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
	const add = (field: string, message: string) => {
		if (!field_errors[field]) field_errors[field] = [];
		if (!field_errors[field].includes(message)) field_errors[field].push(message);
	};
	for (const field of required_fields_for(resource)) {
		if (field.includes('.')) continue;
		if (!is_missing(doc[field])) continue;
		add(field, required_message(resource, field));
	}
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	const mins = STRING_LIMITS.minlength[canonical] ?? STRING_LIMITS.minlength[resource] ?? {};
	const maxs = STRING_LIMITS.maxlength[canonical] ?? STRING_LIMITS.maxlength[resource] ?? {};
	for (const [field, rule] of Object.entries(mins)) {
		for (const value of string_values(doc[field])) {
			if (value.length < rule.min) add(field, rule.message);
		}
	}
	for (const [field, rule] of Object.entries(maxs)) {
		for (const value of string_values(doc[field])) {
			if (value.length > rule.max) add(field, rule.message);
		}
	}
	const matches = MATCH_RULES[canonical] ?? MATCH_RULES[resource] ?? {};
	for (const [field, rule] of Object.entries(matches)) {
		if (is_missing(doc[field])) continue;
		let regex: RegExp;
		try {
			regex = new RegExp(rule.pattern, rule.flags);
		} catch {
			continue;
		}
		for (const value of string_values(doc[field])) {
			if (!regex.test(value)) add(field, rule.message);
		}
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

function string_values(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
	return [];
}

function model_label(resource: string) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return canonical.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
}
