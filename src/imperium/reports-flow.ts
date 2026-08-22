/**
 * Reportes: validación de plantilla e interpolación como el service original.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const STATIC_PLACEHOLDERS = new Set([
	'fecha_actual',
	'hora_actual',
	'timestamp_actual',
	'usuario_genera',
	'usuario_actual',
	'report_item_delimiter',
	'reporte_delimitador',
	'qr',
]);

export type ReportFieldLike = {
	field_name: string;
	is_reference?: boolean;
	is_array?: boolean;
	related_fields?: Array<{ field_name: string }>;
};

function to_kebab_model(raw: string) {
	return raw
		.replace(/^\/+/, '')
		.replace(/Model$/, '')
		.replace(/([a-z])([A-Z])/g, '$1-$2')
		.toLowerCase();
}

function to_pascal_model(kebab: string) {
	return kebab
		.split(/[-_]/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

/** El front pide kebab; el original guarda el modelName Mongoose. */
export function expand_related_model_aliases(
	store: ImperiumStore,
	raw: string,
): string[] {
	const value = String(raw ?? '').trim();
	if (!value) return [];
	const aliases = new Set<string>([value]);
	const kebab = to_kebab_model(value);
	aliases.add(kebab);
	aliases.add(kebab.replace(/-/g, ''));
	aliases.add(to_pascal_model(kebab));
	const resolved =
		store.resource_for_model(value) ??
		store.resource_for_model(to_pascal_model(kebab)) ??
		(store.has(kebab) ? kebab : null);
	if (resolved) {
		aliases.add(resolved);
		aliases.add(to_pascal_model(resolved));
	}
	return [...aliases];
}

export function apply_report_list_where(
	store: ImperiumStore,
	where: Record<string, unknown>,
): Record<string, unknown> {
	const raw = where.related_model;
	if (typeof raw !== 'string' || !raw.trim()) return where;
	const aliases = expand_related_model_aliases(store, raw);
	if (aliases.length <= 1) return where;
	return { ...where, related_model: { in: aliases } };
}

export function extract_placeholders(template: string): string[] {
	if (!template) return [];
	const found = [...template.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map(
		(match) => String(match[1] ?? '').trim(),
	);
	return [...new Set(found.filter(Boolean))];
}

function path_allowed(fields: ReportFieldLike[], path: string): string | null {
	if (!path) return 'Placeholder vacío';
	if (STATIC_PLACEHOLDERS.has(path)) return null;
	if (fields.some((field) => field.field_name === path)) return null;
	const parts = path.split('.');
	if (parts.length === 1) {
		return `No existe el campo '${path}' en el modelo`;
	}
	const head = fields.find((field) => field.field_name === parts[0]);
	if (!head) return `No existe el campo '${parts[0]}' en el modelo`;
	const rest = parts.slice(1).join('.');
	const related = head.related_fields ?? [];
	if (related.some((item) => item.field_name === rest || item.field_name === parts[1])) {
		return null;
	}
	if (head.is_reference && ['name', 'description', '_id', 'id'].includes(parts[1]!)) {
		return null;
	}
	if (head.is_array) return null;
	if (!head.is_reference && !head.is_array) {
		return `El campo '${parts[0]}' no es una referencia en el modelo`;
	}
	return `No existe el campo '${path}' en el modelo`;
}

export function validate_report_template(
	html: string,
	fields: ReportFieldLike[],
	model_name: string,
) {
	const placeholders = extract_placeholders(html);
	const invalid_placeholders = placeholders
		.map((placeholder) => {
			const reason = path_allowed(fields, placeholder);
			return reason
				? { placeholder, reason: `${reason} ${model_name}`.trim() }
				: null;
		})
		.filter((issue): issue is { placeholder: string; reason: string } => Boolean(issue));
	return {
		is_valid: invalid_placeholders.length === 0,
		placeholders,
		invalid_placeholders,
		model_name,
	};
}

function runtime_value(path: string, now: Date, user_name: string): string | null {
	if (path === 'fecha_actual') {
		return now.toISOString().split('T')[0] ?? '';
	}
	if (path === 'hora_actual') {
		return now.toTimeString().split(' ')[0]?.replace(/:/g, '') ?? '';
	}
	if (path === 'timestamp_actual') {
		return `${now.toISOString().split('T')[0]}_${now.toTimeString().split(' ')[0]?.replace(/:/g, '')}`;
	}
	if (path === 'usuario_genera' || path === 'usuario_actual') return user_name;
	if (path === 'report_item_delimiter' || path === 'reporte_delimitador') {
		return '{{report_item_delimiter}}';
	}
	return null;
}

function display_value(value: unknown): string {
	if (value == null) return '';
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (Array.isArray(value)) {
		return value.map(display_value).filter(Boolean).join(', ');
	}
	if (typeof value === 'object') {
		const obj = as_object(value);
		return String(obj.name ?? obj._name ?? obj.description ?? obj._id ?? obj.id ?? '');
	}
	return String(value);
}

function resolve_path(record: Record<string, unknown>, path: string): unknown {
	return path.split('.').reduce<unknown>((acc, key) => {
		if (acc == null) return undefined;
		if (typeof acc !== 'object') return undefined;
		return as_object(acc)[key];
	}, record);
}

export function interpolate_report_template(
	template: string,
	record: Record<string, unknown>,
	user_name: string,
	now = new Date(),
): string {
	if (!template) return '';
	return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
		const clean = String(path ?? '').trim();
		const runtime = runtime_value(clean, now, user_name);
		if (runtime != null) return runtime;
		return display_value(resolve_path(record, clean));
	});
}

function fields_from_store(store: ImperiumStore, resource: string): ReportFieldLike[] {
	const refs = store.field_refs(resource);
	const seen = new Set<string>();
	const fields: ReportFieldLike[] = [];
	const push = (field: ReportFieldLike) => {
		if (!field.field_name || seen.has(field.field_name)) return;
		seen.add(field.field_name);
		fields.push(field);
	};
	for (const name of ['name', 'description', 'is_active']) {
		push({ field_name: name });
	}
	for (const col of store.loc(resource).columns) {
		const reference_model = refs[col.name];
		push({
			field_name: col.name,
			is_reference: Boolean(reference_model),
			is_array: col.pg === 'json' && !reference_model,
			related_fields: reference_model
				? [{ field_name: 'name' }, { field_name: 'description' }]
				: [],
		});
	}
	for (const [field_name, reference_model] of Object.entries(refs)) {
		push({
			field_name,
			is_reference: true,
			related_fields: [{ field_name: 'name' }, { field_name: 'description' }],
		});
		void reference_model;
	}
	return fields;
}

export async function assert_report_template_write(
	store: ImperiumStore,
	incoming: ImperiumDoc,
) {
	const related_model = String(incoming.related_model ?? '').trim();
	const html_content = String(incoming.html_content ?? '').trim();
	if (!related_model || !html_content) return;
	let resource = '';
	try {
		const kebab = related_model
			.replace(/^\/+/, '')
			.replace(/Model$/, '')
			.replace(/([a-z])([A-Z])/g, '$1-$2')
			.toLowerCase();
		resource = store.has(kebab) ? kebab : store.has(related_model) ? related_model : '';
		if (!resource) {
			const hit = [...store.locs.keys()].find(
				(key) => key.replace(/-/g, '') === kebab.replace(/-/g, ''),
			);
			resource = hit ?? '';
		}
	} catch {
		resource = '';
	}
	if (!resource) return;
	const validation = validate_report_template(
		html_content,
		fields_from_store(store, resource),
		related_model,
	);
	if (!validation.is_valid) {
		const issues = validation.invalid_placeholders
			.map((issue) => `{{${issue.placeholder}}}: ${issue.reason}`)
			.join(' | ');
		throw new Error(
			`La plantilla contiene placeholders inválidos para el modelo ${validation.model_name}. ${issues}`,
		);
	}
}

export function report_validation_ok(
	html: string,
	fields: ReportFieldLike[],
	model_name: string,
) {
	const validation = validate_report_template(html, fields, model_name);
	return ok(
		[validation],
		validation.is_valid
			? 'Plantilla válida'
			: `La plantilla contiene placeholders inválidos para el modelo ${model_name}`,
	);
}

export async function resolve_report_records(
	store: ImperiumStore,
	resource: string,
	body: Record<string, unknown>,
): Promise<ImperiumDoc[]> {
	if (body.apply_to_all === true) {
		return (await store.find_many(resource, { take: 200 })).rows;
	}
	const ids = as_array(body.record_ids)
		.map((id) => String(id ?? '').trim())
		.filter(Boolean);
	const single = String(body.record_id ?? '').trim();
	if (single && !ids.includes(single)) ids.unshift(single);
	const out: ImperiumDoc[] = [];
	for (const id of ids) {
		const doc = await store.find_id(resource, id);
		if (doc) {
			const [populated] = await store.populate_docs(resource, [doc]);
			out.push(populated ?? doc);
		}
	}
	return out;
}
