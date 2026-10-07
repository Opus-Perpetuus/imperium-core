/**
 * Reportes: validación de plantilla e interpolación como el service original.
 */
import { as_array, as_object, ok, type ImperiumDoc } from './envelope.ts';
import sharp from 'sharp';
import { CHAT_ATTACHMENT_MODELS, is_chat_row, without_chat_rows } from './chat-access.ts';
import { serve_attachment_bytes } from './media.ts';
import {
	build_report_qr_payload,
	qr_payload_to_data_url,
	render_qr_img_tag,
} from './report-qr.ts';
import {
	code128_svg,
	collect_placeholder_uses,
	display_value,
	lookup,
	parse_template,
	render_nodes,
	uses_record_list,
	type RenderContext,
	type TemplateScope,
} from './report-template-engine.ts';
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
	'registros',
	'total_registros',
	'salto_de_pagina',
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
	return [...new Set(collect_placeholder_uses(template).map((use) => use.path))];
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

/** Dentro de `{{#each lista}}` valen los subcampos de cada elemento. */
function path_allowed_in_loops(
	fields: ReportFieldLike[],
	path: string,
	loops: string[],
): string | null {
	if (path === 'this' || path.startsWith('this.') || path.startsWith('@')) return null;
	if (path.startsWith('../')) return path_allowed_in_loops(fields, path.slice(3), loops.slice(0, -1));
	const at_root = path_allowed(fields, path);
	if (!at_root || !loops.length) return at_root;
	for (const loop of [...loops].reverse()) {
		if (loop === 'registros') return path_allowed(fields, path);
		const head = fields.find((field) => field.field_name === loop.split('.')[0]);
		const related = head?.related_fields ?? [];
		/* Arreglo sin forma conocida (JSON libre): no se puede validar. */
		if (!head || !related.length) return null;
		if (
			related.some(
				(item) =>
					item.field_name === path ||
					item.field_name === path.split('.')[0] ||
					item.field_name.startsWith(`${path}.`),
			)
		) {
			return null;
		}
	}
	return at_root;
}

export function validate_report_template(
	html: string,
	fields: ReportFieldLike[],
	model_name: string,
) {
	const uses = html ? collect_placeholder_uses(html) : [];
	const placeholders = [...new Set(uses.map((use) => use.path))];
	const seen = new Set<string>();
	const invalid_placeholders = uses
		.map((use) => {
			const reason = path_allowed_in_loops(fields, use.path, use.loops);
			if (!reason || seen.has(use.path)) return null;
			seen.add(use.path);
			return { placeholder: use.path, reason: `${reason} ${model_name}`.trim() };
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
		/* Misma grafía que la plantilla: delimiter_token() busca esa. */
		return `{{${path}}}`;
	}
	return null;
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

function collect_loose_product_ids(node: unknown, ids: Set<string>) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		node.forEach((item) => collect_loose_product_ids(item, ids));
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
			collect_loose_product_ids(value, ids);
		}
	}
}

function replace_loose_product_ids(node: unknown, by_id: Map<string, ImperiumDoc>) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		node.forEach((item) => replace_loose_product_ids(item, by_id));
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
		if (value && typeof value === 'object') replace_loose_product_ids(value, by_id);
	}
}

export async function hydrate_loose_product_references_many(
	store: ImperiumStore,
	records: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
	if (!store.has('products') || !store.is_resource_installed('products') || !records.length) {
		return records;
	}
	const ids = new Set<string>();
	for (const record of records) collect_loose_product_ids(record, ids);
	if (!ids.size) return records;
	const by_id = new Map<string, ImperiumDoc>();
	const wanted = [...ids];
	for (let i = 0; i < wanted.length; i += 500) {
		const chunk = wanted.slice(i, i + 500);
		const { rows } = await store.find_many('products', {
			ids: chunk,
			take: chunk.length,
			include_inactive: true,
			populate: false,
			skip_total: true,
		});
		for (const row of rows) by_id.set(String(row._id), row);
	}
	if (!by_id.size) return records;
	for (const record of records) replace_loose_product_ids(record, by_id);
	return records;
}

export async function hydrate_loose_product_references(
	store: ImperiumStore,
	record: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const [hydrated] = await hydrate_loose_product_references_many(store, [record]);
	return hydrated ?? record;
}

async function attachment_data_url(store: ImperiumStore | undefined, attach_id: string) {
	if (!store?.has('attachment-management') || !attach_id) return '';
	const attach = await store.find_id('attachment-management', attach_id);
	// El render no conoce a quien pide el reporte: un adjunto del chat nunca entra.
	if (!attach || attach.is_active === false || CHAT_ATTACHMENT_MODELS.has(String(attach.related_model ?? ''))) {
		return '';
	}
	const served = await serve_attachment_bytes(attach);
	if (!served?.body?.length) return '';
	const image = await shrink_report_image(served.body, served.mime || 'image/jpeg');
	return `data:${image.mime};base64,${Buffer.from(image.body).toString('base64')}`;
}

/** Lado mayor de una imagen dentro del PDF: de sobra para imprimir a 300 dpi en 12 cm. */
const REPORT_IMAGE_MAX_PX = 1400;

/**
 * Una foto de celular (4000 px) metida tal cual hacía PDFs de varios MB por
 * una credencial. Se reduce y, si no tiene transparencia, va como JPEG.
 */
export async function shrink_report_image(
	body: Uint8Array,
	mime: string,
): Promise<{ body: Uint8Array; mime: string }> {
	if (!/^image\/(jpeg|png|webp|gif|avif|tiff)/i.test(mime)) return { body, mime };
	try {
		const source = sharp(body, { animated: false }).rotate();
		const meta = await source.metadata();
		const resized = source.resize({
			width: REPORT_IMAGE_MAX_PX,
			height: REPORT_IMAGE_MAX_PX,
			fit: 'inside',
			withoutEnlargement: true,
		});
		const fits =
			Math.max(meta.width ?? 0, meta.height ?? 0) <= REPORT_IMAGE_MAX_PX && (meta.orientation ?? 1) === 1;
		if (meta.hasAlpha) {
			if (fits) return { body, mime };
			return { body: await resized.png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' };
		}
		/* Chrome deja un JPEG tal cual dentro del PDF; WebP/PNG los guarda sin
		 * pérdida y una foto de 900 px pesaba 1.8 MB. */
		if (fits && /^image\/jpeg/i.test(mime)) return { body, mime };
		return { body: await resized.jpeg({ quality: 82, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' };
	} catch {
		return { body, mime };
	}
}

export type InterpolateReportOpts = {
	store?: ImperiumStore;
	model_name?: string;
};

function render_context(
	user_name: string,
	now: Date,
	opts: InterpolateReportOpts,
	extra: Record<string, string> = {},
): RenderContext {
	return {
		runtime: (path) => (path in extra ? extra[path]! : runtime_value(path, now, user_name)),
		special: async (kind, path, scope) => {
			if (kind === 'qr') {
				/* Dentro de un #each el QR es del elemento, no del documento. */
				let target: TemplateScope | null = scope;
				while (target && (!target.data || typeof target.data !== 'object' || Array.isArray(target.data))) {
					target = target.parent;
				}
				const record = as_object(target?.data ?? {});
				try {
					const payload = build_report_qr_payload(record, opts.model_name, path || undefined);
					return render_qr_img_tag(await qr_payload_to_data_url(payload));
				} catch {
					return '';
				}
			}
			const value = lookup(scope, path);
			if (kind === 'barcode') {
				return code128_svg(display_value(value)) ?? '';
			}
			if (typeof value === 'string' && /^data:image\/[\w.+-]+;base64,/i.test(value)) {
				return `<img src="${value}" alt="${path}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />`;
			}
			const attach_id = extract_reference_id(value);
			if (!attach_id) return '';
			try {
				const data_url = await attachment_data_url(opts.store, attach_id);
				if (data_url.length > 50) {
					return `<img src="${data_url}" alt="${path}" style="max-width:100%;height:auto;display:block;margin:0 auto;" />`;
				}
			} catch {
				/* cae al aviso */
			}
			return '<span class="report-field-missing">Imagen no disponible</span>';
		},
	};
}

export async function interpolate_report_template(
	template: string,
	record: Record<string, unknown>,
	user_name: string,
	now = new Date(),
	opts: InterpolateReportOpts = {},
): Promise<string> {
	if (!template) return '';
	return render_nodes(
		parse_template(template),
		{ data: record, parent: null },
		render_context(user_name, now, opts),
	);
}

/** Un solo registro: el delimitador de lote no tiene a quién ceder el lugar. */
export function strip_report_delimiters(html: string): string {
	return html.replace(/\{\{\s*(?:report_item_delimiter|reporte_delimitador)\s*\}\}/g, '');
}

/** Plantilla de lista: se pinta una vez con todos los registros en `registros`. */
export async function interpolate_report_list(
	template: string,
	records: Record<string, unknown>[],
	user_name: string,
	now = new Date(),
	opts: InterpolateReportOpts = {},
): Promise<string> {
	const root = { ...(records[0] ?? {}), registros: records, total_registros: records.length };
	return render_nodes(
		parse_template(template),
		{ data: root, parent: null },
		render_context(user_name, now, opts, { total_registros: String(records.length) }),
	);
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
	if (uses_record_list(template)) {
		return interpolate_report_list(template, records, user_name, now, opts);
	}
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
	const fields = fields_from_store(store, resource);
	/* El diseñador ofrece también las claves que viven en el payload de las
	 * filas (no son columnas); validarlas solo contra columnas rechazaba al
	 * guardar campos que el propio diseñador había propuesto. */
	const known = new Set(fields.map((field) => field.field_name));
	const { rows } = await store.find_many(resource, {
		take: 200,
		include_inactive: true,
		populate: false,
		skip_total: true,
	});
	for (const row of rows) {
		for (const [key, value] of Object.entries(row)) {
			if (known.has(key) || key.startsWith('_')) continue;
			known.add(key);
			fields.push({ field_name: key, is_array: Array.isArray(value) });
		}
	}
	const validation = validate_report_template(html_content, fields, related_model);
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

export async function* iter_report_record_pages(
	store: ImperiumStore,
	resource: string,
	body: Record<string, unknown>,
): AsyncGenerator<ImperiumDoc[]> {
	const mongo_match = without_chat_rows(resource, null);
	if (body.apply_to_all === true) {
		for await (const page of store.scan(resource, { page_size: 200, mongo_match })) {
			if (page.length) yield page;
		}
		return;
	}
	const ids = as_array(body.record_ids)
		.map((id) => String(id ?? '').trim())
		.filter(Boolean);
	const single = String(body.record_id ?? '').trim();
	if (single && !ids.includes(single)) ids.unshift(single);
	if (!ids.length) {
		const { rows } = await store.find_many(resource, {
			take: 1,
			sort: 'id:asc',
			populate: false,
			skip_total: true,
			mongo_match,
		});
		/* Sin poblar, {{departamento.name}} salía vacío en la ficha de prueba. */
		if (rows.length) yield await store.populate_docs(resource, rows, { full: true });
		return;
	}
	for (let i = 0; i < ids.length; i += 200) {
		const chunk: ImperiumDoc[] = [];
		for (const id of ids.slice(i, i + 200)) {
			const doc = await store.find_id(resource, id);
			if (doc && !is_chat_row(resource, doc)) chunk.push(doc);
		}
		if (!chunk.length) continue;
		yield await store.populate_docs(resource, chunk, { full: true });
	}
}

const REPORT_LIST_MAX_RECORDS = 5000;

export async function render_report_from_pages(
	store: ImperiumStore,
	template: string,
	pages: AsyncIterable<ImperiumDoc[]>,
	user_name: string,
	now: Date,
	opts: InterpolateReportOpts,
): Promise<{ html: string; count: number; first: Record<string, unknown> | null }> {
	if (uses_record_list(template)) {
		const records: Record<string, unknown>[] = [];
		for await (const page of pages) {
			records.push(
				...(await hydrate_loose_product_references_many(
					store,
					page.map((row) => as_object(row)),
				)),
			);
			if (records.length > REPORT_LIST_MAX_RECORDS) {
				throw new Error(
					`El reporte de lista admite hasta ${REPORT_LIST_MAX_RECORDS} registros; filtra la lista antes de generarlo.`,
				);
			}
		}
		if (!records.length) return { html: '', count: 0, first: null };
		return {
			html: await interpolate_report_list(template, records, user_name, now, opts),
			count: records.length,
			first: records[0]!,
		};
	}
	const token = delimiter_token(template);
	let html = '';
	let count = 0;
	let first: Record<string, unknown> | null = null;
	for await (const page of pages) {
		const hydrated = await hydrate_loose_product_references_many(
			store,
			page.map((row) => as_object(row)),
		);
		for (const record of hydrated) {
			count += 1;
			if (!first) first = record;
			if (!token) continue;
			const piece = await interpolate_report_template(template, record, user_name, now, opts);
			html = count === 1 ? piece : html.replace(token, piece);
		}
	}
	if (!count || !first) {
		return { html: '', count: 0, first: null };
	}
	if (!token) {
		return {
			html: await interpolate_report_template(template, first, user_name, now, opts),
			count,
			first,
		};
	}
	return { html: html.replaceAll(token, ''), count, first };
}

export async function resolve_report_records(
	store: ImperiumStore,
	resource: string,
	body: Record<string, unknown>,
): Promise<ImperiumDoc[]> {
	if (body.apply_to_all === true) {
		throw new Error('apply_to_all must stream via iter_report_record_pages');
	}
	const out: ImperiumDoc[] = [];
	for await (const page of iter_report_record_pages(store, resource, body)) {
		out.push(...page);
	}
	return out;
}
