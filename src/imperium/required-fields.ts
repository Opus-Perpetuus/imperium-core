/**
 * Required / minlength / maxlength / match / enum / min-max numérico de
 * Mongoose + `field_errors` del `ValidationError` original.
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

type EnumRule = { values: string[]; message: string };
const ENUM_RULES: Record<string, Record<string, EnumRule>> = (
	JSON.parse(readFileSync(join(import.meta.dir, 'schema-enum.json'), 'utf8')) as {
		enum: Record<string, Record<string, EnumRule>>;
	}
).enum;

type NumberBound = { min?: number; max?: number; message: string };
const NUMBER_LIMITS = JSON.parse(
	readFileSync(join(import.meta.dir, 'schema-number-limits.json'), 'utf8'),
) as { min: Record<string, Record<string, NumberBound>>; max: Record<string, Record<string, NumberBound>> };

const STRING_SETTERS = JSON.parse(
	readFileSync(join(import.meta.dir, 'schema-string-setters.json'), 'utf8'),
) as {
	trim: Record<string, string[]>;
	lowercase: Record<string, string[]>;
	uppercase: Record<string, string[]>;
};

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

/**
 * Replica trim / lowercase / uppercase de Mongoose (corren antes de validar).
 */
/** Defaults de Mongoose que el original aplica al crear (antes de validar). */
const SCHEMA_DEFAULTS: Record<string, Record<string, unknown>> = {
	'payroll-period': { estado: 'draft', tipo_nomina: 'O' },
	'payroll-receipt': { estado: 'draft' },
	'inventory-reception': { estado: 'pendiente' },
	'delivery-package': { estado: 'pendiente' },
	'delivery-return': { estado: 'borrador' },
	'citizen-report': { priority: 'BAJA', status: 'pendiente' },
};

export function apply_schema_setters(resource: string, doc: Record<string, unknown>) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	const defaults = SCHEMA_DEFAULTS[canonical] ?? SCHEMA_DEFAULTS[resource] ?? {};
	for (const [field, value] of Object.entries(defaults)) {
		if (is_missing(doc[field])) doc[field] = value;
	}
	const fields = (kind: 'trim' | 'lowercase' | 'uppercase') =>
		STRING_SETTERS[kind][canonical] ?? STRING_SETTERS[kind][resource] ?? [];
	for (const field of fields('trim')) {
		if (typeof doc[field] === 'string') doc[field] = doc[field].trim();
	}
	for (const field of fields('lowercase')) {
		if (typeof doc[field] === 'string') doc[field] = doc[field].toLowerCase();
	}
	for (const field of fields('uppercase')) {
		if (typeof doc[field] === 'string') doc[field] = doc[field].toUpperCase();
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
	const matches = MATCH_RULES[canonical] ?? MATCH_RULES[resource] ?? {};
	const enums = ENUM_RULES[canonical] ?? ENUM_RULES[resource] ?? {};
	const mins_n = NUMBER_LIMITS.min[canonical] ?? NUMBER_LIMITS.min[resource] ?? {};
	const maxs_n = NUMBER_LIMITS.max[canonical] ?? NUMBER_LIMITS.max[resource] ?? {};
	for (const { path, value } of collect_leaves(doc)) {
		const key = rule_key(path);
		const min_rule = mins[key];
		if (min_rule) {
			for (const text of string_values(value)) {
				if (text.length < min_rule.min) add(path, min_rule.message);
			}
		}
		const max_rule = maxs[key];
		if (max_rule) {
			for (const text of string_values(value)) {
				if (text.length > max_rule.max) add(path, max_rule.message);
			}
		}
		const match_rule = matches[key];
		if (match_rule && !is_missing(value)) {
			let regex: RegExp | undefined;
			try {
				regex = new RegExp(match_rule.pattern, match_rule.flags);
			} catch {
				regex = undefined;
			}
			if (regex) {
				for (const text of string_values(value)) {
					if (!regex.test(text)) add(path, match_rule.message);
				}
			}
		}
		const enum_rule = enums[key];
		if (enum_rule && !is_missing(value)) {
			const allowed = new Set(enum_rule.values);
			for (const text of string_values(value)) {
				if (allowed.has(text)) continue;
				add(path, enum_message(enum_rule.message, path, text));
			}
		}
		const nmin = mins_n[key];
		if (nmin && !is_missing(value)) {
			for (const n of number_values(value)) {
				if (nmin.min !== undefined && n < nmin.min) {
					add(path, number_bound_message(nmin.message, path, n, { MIN: nmin.min }));
				}
			}
		}
		const nmax = maxs_n[key];
		if (nmax && !is_missing(value)) {
			for (const n of number_values(value)) {
				if (nmax.max !== undefined && n > nmax.max) {
					add(path, number_bound_message(nmax.message, path, n, { MAX: nmax.max }));
				}
			}
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

function rule_key(path: string) {
	return path
		.split('.')
		.filter((part) => !/^\d+$/.test(part))
		.join('.');
}

function collect_leaves(
	value: unknown,
	prefix = '',
): Array<{ path: string; value: unknown }> {
	if (value == null || typeof value !== 'object' || value instanceof Date) {
		return prefix ? [{ path: prefix, value }] : [];
	}
	if (Array.isArray(value)) {
		const out: Array<{ path: string; value: unknown }> = [];
		value.forEach((item, index) => {
			const path = prefix ? `${prefix}.${index}` : String(index);
			out.push(...collect_leaves(item, path));
		});
		return out;
	}
	const out: Array<{ path: string; value: unknown }> = [];
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (!prefix && key === 'payload') continue;
		const path = prefix ? `${prefix}.${key}` : key;
		if (child && typeof child === 'object' && !(child instanceof Date)) {
			out.push(...collect_leaves(child, path));
		} else {
			out.push({ path, value: child });
		}
	}
	return out;
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

function enum_message(template: string, field: string, value: string) {
	return template.replaceAll('{VALUE}', value).replaceAll('{PATH}', field);
}

function number_values(value: unknown): number[] {
	if (typeof value === 'number' && Number.isFinite(value)) return [value];
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		if (Number.isFinite(n)) return [n];
	}
	return [];
}

function number_bound_message(
	template: string,
	field: string,
	value: number,
	bounds: { MIN?: number; MAX?: number },
) {
	return template
		.replaceAll('{PATH}', field)
		.replaceAll('{VALUE}', String(value))
		.replaceAll('{MIN}', bounds.MIN === undefined ? '' : String(bounds.MIN))
		.replaceAll('{MAX}', bounds.MAX === undefined ? '' : String(bounds.MAX));
}

function model_label(resource: string) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return canonical.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
}
