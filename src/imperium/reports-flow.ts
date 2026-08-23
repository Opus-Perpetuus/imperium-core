/**
 * Reportes: validación de plantilla e interpolación como el service original.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import { serve_attachment_bytes } from './media.ts';
import {
	build_report_qr_payload,
	qr_payload_to_data_url,
	render_qr_img_tag,
} from './report-qr.ts';
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
	if (value instanceof Date) return value.toISOString().split('T')[0] ?? '';
	if (Array.isArray(value)) {
		return value.map(display_value).filter(Boolean).join(', ');
	}
	if (typeof value === 'object') {
		const obj = value as { _bsontype?: string; toHexString?: () => string };
		if (obj._bsontype === 'ObjectId' || typeof obj.toHexString === 'function') {
			if (!('name' in obj) && !('_name' in obj)) return String(value);
		}
		const rec = as_object(value);
		return String(
			rec.name ??
				rec._name ??
				rec.codigo ??
				rec.code ??
				rec.description ??
				rec.descripcion ??
				rec.label ??
				rec.title ??
				rec._id ??
				rec.id ??
				'',
		);
	}
	return String(value);
}

function resolve_path(record: Record<string, unknown>, path: string): unknown {
	const segments = path
		.split('.')
		.map((segment) => segment.trim())
		.filter(Boolean);
	let current: unknown = record;
	for (let index = 0; index < segments.length; index++) {
		if (current == null || typeof current !== 'object') return undefined;
		current = as_object(current)[segments[index]!];
		if (Array.isArray(current) && index < segments.length - 1) {
			current = current.length > 0 ? current[0] : undefined;
		}
	}
	return current;
}

function is_truthy(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === 'boolean') return value;
	if (value == null) return false;
	if (typeof value === 'number') return value !== 0;
	if (typeof value === 'string') return value.length > 0;
	return Boolean(value);
}

function evaluate_condition(condition: string, record: Record<string, unknown>): boolean {
	const trimmed = condition.trim();
	const eq_match = trimmed.match(/^(!)?(\w+(?:\.\w+)*)\s*(==|!=)?\s*(.*)$/);
	if (eq_match) {
		const negated = eq_match[1] === '!';
		const path = eq_match[2] ?? '';
		const operator = eq_match[3];
		const compare_value = eq_match[4]?.trim().replace(/['"]/g, '');
		const value = resolve_path(record, path);
		if (!operator) return negated ? !is_truthy(value) : is_truthy(value);
		const str_val = String(value ?? '');
		if (operator === '==') return negated ? str_val !== compare_value : str_val === compare_value;
		if (operator === '!=') return negated ? str_val === compare_value : str_val !== compare_value;
	}
	return is_truthy(resolve_path(record, trimmed));
}

function process_if_blocks(template: string, record: Record<string, unknown>): string {
	return template.replace(
		/\{\{\s*#if\s+([^}]+)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g,
		(_match, condition: string, content: string) =>
			evaluate_condition(condition, record) ? content : '',
	);
}

function process_each_blocks(template: string, record: Record<string, unknown>): string {
	return template.replace(
		/\{\{\s*#each\s+([a-zA-Z0-9_.]+)\s*\}\}([\s\S]*?)\{\{\s*\/each\s*\}\}/g,
		(_match, array_path: string, content: string) => {
			const array = resolve_path(record, String(array_path || '').trim());
			if (!Array.isArray(array) || array.length === 0) return '';
			return array
				.map((item) => {
					const scope =
						item && typeof item === 'object'
							? { ...record, ...as_object(item), this: item }
							: { ...record, this: item };
					let item_content = process_each_blocks(content, scope);
					item_content = item_content.replace(
						/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g,
						(raw, field: string) => {
							const clean = String(field || '').trim();
							if (!clean || clean.startsWith('#') || clean.startsWith('/')) return raw;
							if (clean === 'this') return display_value(item);
							let val =
								item && typeof item === 'object'
									? resolve_path(as_object(item), clean)
									: undefined;
							if (val == null) val = resolve_path(record, clean);
							if (val == null) return '';
							return Array.isArray(val)
								? val.map(display_value).filter(Boolean).join(', ')
								: display_value(val);
						},
					);
					return item_content;
				})
				.join('');
		},
	);
}

function process_handlebars_blocks(template: string, record: Record<string, unknown>): string {
	return process_each_blocks(process_if_blocks(template, record), record);
}

function extract_reference_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
	if (typeof value === 'object') {
		const rec = as_object(value);
		return String(rec._id ?? rec.id ?? '').trim();
	}
	return '';
}

function is_product_like_key(key: string): boolean {
	const name = String(key || '')
		.trim()
		.toLowerCase();
	return (
		name === 'product' ||
		name === 'product_id' ||
		name === 'producto' ||
		name === 'producto_id' ||
		name.endsWith('_product') ||
		name.endsWith('product_id')
	);
}

export async function hydrate_loose_product_references(
	store: ImperiumStore,
	record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (!store.has('products')) return record;
	const ids = new Set<string>();
	const collect = (node: unknown) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			node.forEach(collect);
			return;
		}
		for (const [key, value] of Object.entries(as_object(node))) {
			if (is_product_like_key(key)) {
				const id = extract_reference_id(value);
				const raw =
					typeof value === 'string' ||
					typeof value === 'number' ||
					(typeof value === 'object' &&
						value !== null &&
						!as_object(value).name &&
						!as_object(value).codigo);
				if (id && raw) ids.add(id);
			} else if (value && typeof value === 'object') {
				collect(value);
			}
		}
	};
	collect(record);
	if (!ids.size) return record;
	const by_id = new Map<string, ImperiumDoc>();
	for (const id of ids) {
		const product = await store.find_id('products', id);
		if (product) by_id.set(id, product);
	}
	if (!by_id.size) return record;
	const replace = (node: unknown) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			node.forEach(replace);
			return;
		}
		const obj = as_object(node);
		for (const [key, value] of Object.entries(obj)) {
			if (is_product_like_key(key)) {
				const hydrated = by_id.get(extract_reference_id(value));
				if (hydrated) {
					obj[key] = hydrated;
					continue;
				}
			}
			if (value && typeof value === 'object') replace(value);
		}
	};
	replace(record);
	return record;
}

async function attachment_data_url(store: ImperiumStore | undefined, attach_id: string) {
	if (!store?.has('attachment-management') || !attach_id) return '';
	const attach = await store.find_id('attachment-management', attach_id);
	if (!attach || attach.is_active === false) return '';
	const served = await serve_attachment_bytes(attach);
	if (!served?.body?.length) return '';
	const mime = served.mime || 'image/jpeg';
	return `data:${mime};base64,${Buffer.from(served.body).toString('base64')}`;
}

export type InterpolateReportOpts = {
	store?: ImperiumStore;
	model_name?: string;
};

export async function interpolate_report_template(
	template: string,
	record: Record<string, unknown>,
	user_name: string,
	now = new Date(),
	opts: InterpolateReportOpts = {},
): Promise<string> {
	if (!template) return '';
	let result = process_handlebars_blocks(template, record);
	for (const match of result.matchAll(/\{\{\s*image:([a-zA-Z0-9_.]+)\s*\}\}/g)) {
		const field = String(match[1] ?? '').trim();
		const attach_id = extract_reference_id(resolve_path(record, field));
		let replacement = '';
		if (attach_id && opts.store) {
			try {
				const data_url = await attachment_data_url(opts.store, attach_id);
				if (data_url.length > 50) {
					replacement = `<img src="${data_url}" alt="${field}" style="max-width:100%;height:auto;display:block;margin:10px auto;" />`;
				}
			} catch {
				replacement = '';
			}
		}
		result = result.replace(match[0], replacement);
	}
	for (const match of result.matchAll(/\{\{\s*qr(?::([a-zA-Z0-9_.]+))?\s*\}\}/g)) {
		const field = match[1]?.trim();
		try {
			const payload = build_report_qr_payload(record, opts.model_name, field || undefined);
			const data_url = await qr_payload_to_data_url(payload);
			result = result.replace(match[0], render_qr_img_tag(data_url));
		} catch {
			result = result.replace(match[0], '');
		}
	}
	return result.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
		const clean = String(path ?? '').trim();
		const runtime = runtime_value(clean, now, user_name);
		if (runtime != null) return runtime;
		const value = resolve_path(record, clean);
		if (value == null) return '';
		return Array.isArray(value)
			? value.map(display_value).filter(Boolean).join(', ')
			: display_value(value);
	});
}

function delimiter_token(template: string): string {
	for (const token of ['{{report_item_delimiter}}', '{{reporte_delimitador}}']) {
		if (template.includes(token)) return token;
	}
	return '';
}

export async function interpolate_report_records(
	template: string,
	records: Record<string, unknown>[],
	user_name: string,
	now = new Date(),
	opts: InterpolateReportOpts = {},
	depth = 0,
): Promise<string> {
	const token = delimiter_token(template);
	if (!token) {
		return interpolate_report_template(template, records[0] ?? {}, user_name, now, opts);
	}
	if (!records.length) return template.replaceAll(token, '');
	if (depth > 5000) {
		throw new Error(
			'La plantilla contiene un delimitador recursivo con demasiados niveles de expansión',
		);
	}
	const [current, ...rest] = records;
	const current_html = await interpolate_report_template(
		template,
		current ?? {},
		user_name,
		now,
		opts,
	);
	if (!rest.length) return current_html.replaceAll(token, '');
	const next_html = await interpolate_report_records(template, rest, user_name, now, opts, depth + 1);
	return current_html.replace(token, next_html);
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
			? 'La plantilla es válida'
			: 'La plantilla contiene placeholders inválidos',
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
