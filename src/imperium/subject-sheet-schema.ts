import { as_array, as_object } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	load_state_fields_metadata,
	schema_validation_for,
	type StateField,
} from './state-fields.ts';

const RESOURCE_RE = /^[a-z][a-z0-9_-]*$/;
const FIELD_RE = /^[a-z_][a-z0-9_]*$/i;
const META = new Set([
	'health',
	'schema',
	'manifest',
	'menu',
	'pages',
	'seed',
	'metrics',
	'files',
	'logs',
]);
const SKIP_SECOND = new Set(['statistics', 'field-values', 'batch', 'mass-query']);

type SubjectSheetIdInput = {
	owner?: string;
	table?: string;
	technical_id?: string;
	resource?: string;
	path?: string;
	model_id?: string;
};

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function path_resource(path: string | undefined): string {
	const raw = text(path).split('?')[0] ?? '';
	const segment = raw.split('/').filter(Boolean)[0] ?? '';
	return RESOURCE_RE.test(segment) ? segment : '';
}

/**
 * Id estable de una hoja de app, el que la siembra escribe en
 * status-options-by-module (subject-tienda/orders).
 * Preferir owner/table; si no hay tabla, technical_id/resource.
 * Sin model_id en la hoja, sale de owner + resource o del primer tramo del path.
 */
export function canonical_subject_sheet_id(input: SubjectSheetIdInput): string {
	const owner = text(input.owner);
	const table = text(input.table);
	const technical_id = text(input.technical_id);
	const resource = text(input.resource);
	const model_id = text(input.model_id);
	const from_path = path_resource(input.path);
	if (owner && table) return `${owner}/${table}`;
	if (technical_id && resource) return `${technical_id}/${resource}`;
	if (owner && (resource || from_path)) return `${owner}/${resource || from_path}`;
	if (model_id.includes('/')) return model_id;
	return model_id;
}

type SheetHit =
	| { kind: 'sheet'; resource: string }
	| { kind: 'field-values'; resource: string; field: string };

function sheet_hit(rest: string): SheetHit | null {
	const parts = (rest.split('?')[0] ?? '').split('/').filter(Boolean);
	if (!parts.length || parts.length > 3) return null;
	const resource = parts[0] ?? '';
	if (!RESOURCE_RE.test(resource) || META.has(resource)) return null;
	if (parts.length === 1) return { kind: 'sheet', resource };
	const second = parts[1] ?? '';
	if (parts.length === 2) {
		if (SKIP_SECOND.has(second)) return null;
		return { kind: 'sheet', resource };
	}
	const field = parts[2] ?? '';
	if (second === 'field-values' && FIELD_RE.test(field)) {
		return { kind: 'field-values', resource, field };
	}
	return null;
}

function json_like(res: Response, body: unknown): Response {
	const headers = new Headers(res.headers);
	headers.delete('content-length');
	headers.delete('content-encoding');
	return Response.json(body, { status: res.status, statusText: res.statusText, headers });
}

function merge_field_values(data: unknown[], field: StateField): Record<string, unknown>[] {
	const seen = new Set<string>();
	const next: Record<string, unknown>[] = [];
	for (const item of data.map((row) => as_object(row))) {
		const value = text(item.value);
		if (!value || seen.has(value)) continue;
		seen.add(value);
		const configured = field.values.find((option) => option.value === value);
		if (!configured) {
			next.push(item);
			continue;
		}
		next.push({
			...item,
			value,
			label: configured.display_leyend || text(item.label) || value,
			...(configured.color ? { color: configured.color } : {}),
			...(configured.icon ? { icon: configured.icon } : {}),
		});
	}
	for (const option of field.values) {
		if (!option.value || seen.has(option.value)) continue;
		seen.add(option.value);
		next.push({
			value: option.value,
			label: option.display_leyend || option.value,
			...(option.color ? { color: option.color } : {}),
			...(option.icon ? { icon: option.icon } : {}),
		});
	}
	return next;
}

async function dress_sheet_schema(
	store: ImperiumStore,
	model_id: string,
	res: Response,
): Promise<Response> {
	const schema = await schema_validation_for(store, model_id);
	const metadata = as_object(schema.metadata);
	const state_fields = as_object(metadata.state_fields);
	if (!as_array(state_fields.fields).length) return res;
	const doc = as_object(await res.clone().json());
	const existing = as_object(doc.schema_validation);
	const existing_fields = as_array(as_object(as_object(existing.metadata).state_fields).fields);
	if (existing_fields.length) return res;
	doc.schema_validation = Object.keys(existing).length
		? {
				...existing,
				metadata: {
					...as_object(existing.metadata),
					state_fields,
					model_id: metadata.model_id,
				},
			}
		: schema;
	return json_like(res, doc);
}

async function dress_field_values(
	store: ImperiumStore,
	model_id: string,
	field_name: string,
	res: Response,
): Promise<Response> {
	const metadata = await load_state_fields_metadata(store, model_id);
	const field = metadata.fields.find((item) => item.field_name === field_name);
	if (!field?.values.length) return res;
	const doc = as_object(await res.clone().json());
	const data = merge_field_values(as_array(doc.data), field);
	doc.data = data;
	if ('total_elementos' in doc) doc.total_elementos = data.length;
	return json_like(res, doc);
}

export async function dress_subject_sheet(
	store: ImperiumStore,
	technical_id: string,
	rest: string,
	res: Response,
): Promise<Response> {
	if (!res.ok) return res;
	if (!(res.headers.get('content-type') ?? '').includes('application/json')) return res;
	const hit = sheet_hit(rest);
	if (!hit) return res;
	const model_id = canonical_subject_sheet_id({ technical_id, resource: hit.resource });
	try {
		if (hit.kind === 'field-values') return await dress_field_values(store, model_id, hit.field, res);
		return await dress_sheet_schema(store, model_id, res);
	} catch {
		// Un fallo al armar el schema no puede tumbar la lista de la app.
		return res;
	}
}
