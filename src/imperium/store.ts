/**
 * Almacén de documentos Imperium sobre los schemas SQL de los súbditos.
 * Un recurso canónico (products, pedidos) aunque el menú lo repita.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pg_schema_name } from '@opus-perpetuus/imperium-core-kit';
import {
	as_array,
	as_object,
	from_imperium,
	to_imperium,
	type ImperiumDoc,
} from './envelope.ts';
import { SearchEngine, search_text_from_doc } from './search-engine.ts';
import { mongo_match_to_sql } from './record-rules.ts';
import { products_inventory_cost } from './products-flow.ts';
import { vehicle_by_status } from './vehicle-flow.ts';
import { pedidos_sales_stats } from './pedidos-flow.ts';
import { purchase_order_stats } from './purchase-order-flow.ts';
import { record_document_history } from './history.ts';
import {
	find_increment_control,
	compute_reset_key,
	find_or_create_increment_segment,
	format_increment_real_value,
	type PatternContext,
} from './custom-pattern-render.ts';
import { apply_schema_setters, assert_required_fields, FieldValidationError } from './required-fields.ts';

export type ExtraCol = {
	name: string;
	mongo?: string;
	pg?: string;
	crud?: string;
	label?: string;
	component?: string;
};

export type ModuleLoc = {
	slug: string;
	technical_id: string;
	resource: string;
	table: string;
	collection: string;
	name: string;
	columns: ExtraCol[];
};

export type SubjectInfo = {
	slug: string;
	name: string;
	path: string;
	menu_ref: string;
	modules: Array<{ resource: string; path: string; menu_ref: string; name: string }>;
};

export const PREFER_OWNER: Record<string, string> = {
	products: 'almacen',
	pedidos: 'ventas',
};

/** Bases Angular (`super('proyectos')`) vs resource del catálogo modular. */
export const RESOURCE_ALIASES: Record<string, string> = {
	proyectos: 'planeacion-proyectos',
	'mis-tareas': 'planeacion-mis-tareas',
	'proyectos-task': 'planeacion-proyectos-task',
	usuario: 'user',
};

/** Unique de negocio que el original imponía en Mongoose y Postgres aún no indexa. */
const UNIQUE_FIELDS: Record<string, string[]> = {
	user: ['email'],
	products: ['codigo'],
	'physical-device': ['install_uuid'],
};

function unique_fields_for(resource: string): string[] {
	return UNIQUE_FIELDS[resource] ?? UNIQUE_FIELDS[RESOURCE_ALIASES[resource] ?? ''] ?? [];
}

type RefBook = {
	fields: Record<string, Record<string, string>>;
	models: Record<string, string>;
};

const REFS: RefBook = JSON.parse(
	readFileSync(join(import.meta.dir, 'refs.json'), 'utf8'),
) as RefBook;

function field_map_for(resource: string): Record<string, string> | undefined {
	return REFS.fields[resource] ?? REFS.fields[RESOURCE_ALIASES[resource] ?? ''];
}

const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;

function objectid_model_label(resource: string) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	return canonical.replace(/(^|-)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
}

function objectid_cast_message(value: unknown, path: string) {
	const type = value === null ? 'null' : Array.isArray(value) ? 'Array' : typeof value;
	const shown = typeof value === 'string' ? value : JSON.stringify(value);
	return `Cast to ObjectId failed for value "${shown}" (type ${type}) at path "${path}" because of "BSONError"`;
}

function assert_objectid_leaf(
	value: unknown,
	path: string,
	add: (path: string, raw: unknown) => void,
) {
	if (value == null || value === '') return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => assert_objectid_leaf(item, `${path}.${index}`, add));
		return;
	}
	if (typeof value === 'object') {
		const id = ref_id(value);
		if (!id) return;
		if (!OBJECT_ID_HEX.test(id)) add(path, id);
		return;
	}
	const text = String(value).trim();
	if (!text) return;
	if (!OBJECT_ID_HEX.test(text)) add(path, value);
}

function visit_objectid_path(
	value: unknown,
	segs: string[],
	path: string,
	add: (path: string, raw: unknown) => void,
) {
	if (!segs.length) {
		assert_objectid_leaf(value, path, add);
		return;
	}
	if (value == null) return;
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			visit_objectid_path(item, segs, path ? `${path}.${index}` : String(index), add);
		});
		return;
	}
	if (typeof value !== 'object') return;
	const [head, ...rest] = segs;
	if (!head) return;
	const next = path ? `${path}.${head}` : head;
	visit_objectid_path((value as Record<string, unknown>)[head], rest, next, add);
}

/**
 * Replica el CastError de Mongoose 9 (ObjectId inválido → ValidationError + field_errors).
 */
function assert_objectid_refs(resource: string, doc: ImperiumDoc) {
	const field_map = field_map_for(resource);
	if (!field_map) return;
	const field_errors: Record<string, string[]> = {};
	const add = (path: string, raw: unknown) => {
		const message = objectid_cast_message(raw, path);
		if (!field_errors[path]) field_errors[path] = [];
		if (!field_errors[path].includes(message)) field_errors[path].push(message);
	};
	for (const field of Object.keys(field_map)) {
		visit_objectid_path(doc, field.split('.'), '', add);
	}
	if (!Object.keys(field_errors).length) return;
	const detail = Object.entries(field_errors)
		.map(([field, messages]) => `${field}: ${messages[0]}`)
		.join(', ');
	throw new FieldValidationError(
		field_errors,
		`${objectid_model_label(resource)} validation failed: ${detail}`,
	);
}

/** Campos que el original guarda como id string (sin $lookup a name). */
const LIST_REF_KEEP_AS_ID = new Set(['invoice_request_id', 'cfdi_document_id']);

/** `__get_statistics` del scaffold con `charts.daily_stats` (línea 30 días). */
const DAILY_LINE_CHART = new Set(['cfdi-document', 'payments', 'dynamic-dashboard']);

const GENERAL = new Set([
	'id',
	'name',
	'description',
	'is_active',
	'state',
	'ref',
	'search_field',
	'created_by',
	'custom_data',
	'payload',
	'created_at',
	'updated_at',
]);

export function qident(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad ident ${name}`);
	return `"${name.replace(/"/g, '""')}"`;
}

export class ImperiumStore {
	readonly locs = new Map<string, ModuleLoc>();
	readonly all_locs: ModuleLoc[] = [];
	readonly subjects: SubjectInfo[] = [];

	constructor(
		private readonly sql: Bun.SQL,
		catalog_path: string,
	) {
		const catalog = JSON.parse(readFileSync(catalog_path, 'utf8')) as {
			subjects: Array<{
				slug: string;
				name?: string;
				path?: string;
				menu_ref?: string;
				technical_id: string;
				modules?: Array<{
					resource: string;
					table: string;
					collection: string;
					name: string;
					path?: string;
					menu_ref?: string;
					columns?: ExtraCol[];
				}>;
			}>;
		};
		for (const s of catalog.subjects) {
			this.subjects.push({
				slug: s.slug,
				name: s.name ?? s.slug,
				path: s.path ?? '',
				menu_ref: s.menu_ref ?? `${s.slug}-menu-root`,
				modules: (s.modules ?? []).map((m) => ({
					resource: m.resource,
					path: m.path ?? `/${m.resource}`,
					menu_ref: m.menu_ref ?? '',
					name: m.name,
				})),
			});
			for (const m of s.modules ?? []) {
				const loc: ModuleLoc = {
					slug: s.slug,
					technical_id: s.technical_id,
					resource: m.resource,
					table: m.table,
					collection: m.collection,
					name: m.name,
					columns: m.columns ?? [],
				};
				this.all_locs.push(loc);
				const prefer = PREFER_OWNER[m.resource];
				if (prefer && prefer !== s.slug && this.locs.has(m.resource)) continue;
				if (!this.locs.has(m.resource) || prefer === s.slug) {
					this.locs.set(m.resource, loc);
				}
			}
		}
		for (const [alias, resource] of Object.entries(RESOURCE_ALIASES)) {
			const loc = this.locs.get(resource);
			if (loc && !this.locs.has(alias)) this.locs.set(alias, loc);
		}
		const host =
			this.all_locs.find((l) => l.slug === 'configuracion') ?? this.all_locs[0];
		if (host) {
			const orphans = [
				'messages',
				'notifications',
				'mentions',
				'user-settings',
				'custom-user-themes',
				'documentation-page',
				'document-change-history',
				'interactive-manual',
				'cobranza-payment',
				'module-management-reference',
				'font-awesome-icon-catalog',
				'mcp-user-token',
				'proyectos-time-log',
				'user-print-template',
			];
			for (const resource of orphans) {
				if (this.locs.has(resource)) continue;
				const loc: ModuleLoc = {
					slug: host.slug,
					technical_id: host.technical_id,
					resource,
					table: resource.replace(/-/g, '_'),
					collection: resource,
					name: resource,
					columns: [],
				};
				this.all_locs.push(loc);
				this.locs.set(resource, loc);
			}
			const icons = this.locs.get('font-awesome-icon-catalog');
			if (icons) icons.collection = '__font_awesome_icon_catalog';
			const print_templates = this.locs.get('user-print-template');
			if (print_templates) print_templates.collection = '__plantillas_de_usuario';
			const time_logs = this.locs.get('proyectos-time-log');
			if (time_logs) {
				const planeacion = this.all_locs.find((l) => l.slug === 'planeacion');
				if (planeacion) {
					time_logs.slug = planeacion.slug;
					time_logs.technical_id = planeacion.technical_id;
				}
				time_logs.table = 'proyectos_time_log';
				time_logs.collection = 'proyectos-time-log';
			}
			const tokens = this.locs.get('mcp-user-token');
			if (tokens) tokens.collection = 'mcp_user_tokens';
		}
	}

	async ensure_defaults(): Promise<void> {
		await this.ensure_orphan_tables();
		await this.seed_font_awesome_catalog();
		if (this.has('branchoffice')) {
			const { total } = await this.find_many('branchoffice', { take: 1, include_inactive: true });
			if (!total) {
				await this.insert('branchoffice', {
					name: 'Matriz',
					_ref: 'branchoffice-matriz-0',
					description: 'Sucursal predeterminada',
				});
			}
		}
		if (this.has('employee')) {
			const { total } = await this.find_many('employee', { take: 1, include_inactive: true });
			if (!total) {
				const employee = await this.insert('employee', {
					name: 'Administrador',
					_ref: 'employee-admin-0',
					description: 'Empleado predeterminado',
					is_active: true,
				});
				if (this.has('user') && employee?._id) {
					const admin =
						(await this.find_where('user', { _ref: 'user-menu-management-0' })) ??
						(await this.find_where('user', { email: 'admin@admin.com' }));
					if (admin?._id && !admin.employee) {
						await this.update('user', String(admin._id), {
							employee: employee._id,
						});
					}
				}
			}
		}
		if (this.has('access-rights')) {
			const print_right =
				(await this.find_where('access-rights', {
					_ref: 'user-print-template-access-rights-0',
				})) ??
				(await this.find_where('access-rights', { model_id: 'UserPrintTemplate' }));
			if (!print_right) {
				await this.insert('access-rights', {
					_ref: 'user-print-template-access-rights-0',
					name: 'Plantillas de usuario | Permisos generales',
					description: 'Permisos para administrar plantillas del designer',
					model_id: 'UserPrintTemplate',
					allow_read: true,
					allow_create: true,
					allow_update: true,
					allow_delete: true,
				});
			}
		}
		if (process.env.AUTO_REINDEX_SEARCH_ON_STARTUP !== 'false') {
			void this.warmup_search_indexes();
		}
	}

	async warmup_search_indexes(): Promise<void> {
		if (!(await SearchEngine.ensure_available())) return;
		const seen = new Set<string>();
		let processed = 0;
		for (const loc of this.all_locs) {
			if (seen.has(loc.collection)) continue;
			seen.add(loc.collection);
			if (!(await SearchEngine.index_is_empty(loc.collection))) continue;
			let skip = 0;
			for (;;) {
				const { rows, total } = await this.find_many(loc.resource, {
					take: 200,
					skip,
					include_inactive: false,
					populate: false,
				});
				if (!rows.length) break;
				await SearchEngine.index_documents(
					loc.collection,
					rows
						.map((doc) => ({
							id: String(doc._id),
							search_text: search_text_from_doc(doc),
						}))
						.filter((doc) => doc.search_text),
				);
				processed += rows.length;
				skip += rows.length;
				if (skip >= total) break;
			}
		}
		if (processed) {
			console.log(`[search] Indexado inicial al motor: ${processed} documentos`);
		}
	}

	async seed_font_awesome_catalog(): Promise<void> {
		if (!this.has('font-awesome-icon-catalog')) return;
		const catalog_env = process.env.CATALOG_PATH;
		const backend_src = catalog_env
			? join(dirname(catalog_env), '../backend/src')
			: join(import.meta.dir, '../../../../backend/src');
		const file = join(
			backend_src,
			'components/font-awesome-icon-catalog/data/font-awesome-icons.data.json',
		);
		if (!existsSync(file)) return;
		const catalog = JSON.parse(readFileSync(file, 'utf8')) as Array<{
			slug: string;
			name: string;
			icon: string;
			prefix: string;
			style: string;
			search_terms?: string[];
		}>;
		const existing = await this.find_many('font-awesome-icon-catalog', {
			take: 1,
			include_inactive: true,
		});
		if (existing.total === catalog.length && existing.rows[0]?.icon) return;
		const qt = this.qt('font-awesome-icon-catalog');
		await this.sql.unsafe(`DELETE FROM ${qt}`);
		const now = new Date().toISOString();
		for (let i = 0; i < catalog.length; i += 150) {
			const chunk = catalog.slice(i, i + 150);
			const params: unknown[] = [];
			const values = chunk.map((entry) => {
				const search_field = [
					entry.name,
					entry.slug,
					entry.icon,
					...(entry.search_terms ?? []),
				]
					.join(' ')
					.toLowerCase();
				const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
				params.push(
					id,
					entry.name,
					'',
					true,
					entry.slug,
					search_field,
					JSON.stringify({
						icon: entry.icon,
						slug: entry.slug,
						prefix: entry.prefix,
						style: entry.style,
						search_terms: entry.search_terms ?? [],
					}),
					now,
					now,
				);
				const start = params.length - 8;
				return `($${start},$${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5},$${start + 6}::jsonb,$${start + 7},$${start + 8})`;
			});
			await this.sql.unsafe(
				`INSERT INTO ${qt} (id, name, description, is_active, ref, search_field, payload, created_at, updated_at)
         VALUES ${values.join(', ')}`,
				params,
			);
		}
		if (await SearchEngine.ensure_available()) {
			const { rows } = await this.find_many('font-awesome-icon-catalog', {
				take: 5000,
				include_inactive: true,
				populate: false,
			});
			await SearchEngine.clear_index('__font_awesome_icon_catalog');
			for (let i = 0; i < rows.length; i += 200) {
				await SearchEngine.index_documents(
					'__font_awesome_icon_catalog',
					rows.slice(i, i + 200).map((doc) => ({
						id: String(doc._id),
						search_text: search_text_from_doc(doc),
					})),
				);
			}
		}
		console.log(`[icons] Catálogo Font Awesome sembrado: ${catalog.length} íconos`);
	}

	async ensure_orphan_tables(): Promise<void> {
		for (const resource of [
			'messages',
			'notifications',
			'mentions',
			'user-settings',
			'custom-user-themes',
			'documentation-page',
			'document-change-history',
			'interactive-manual',
			'cobranza-payment',
			'module-management-reference',
			'font-awesome-icon-catalog',
			'mcp-user-token',
			'proyectos-time-log',
			'user-print-template',
		]) {
			if (!this.locs.has(resource)) continue;
			const qt = this.qt(resource);
			await this.sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${qt} (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          state TEXT,
          ref TEXT,
          search_field TEXT,
          created_by TEXT,
          custom_data JSONB DEFAULT '{}'::jsonb,
          payload JSONB DEFAULT '{}'::jsonb,
          created_at TEXT,
          updated_at TEXT
        )
      `);
		}
	}

	has(resource: string): boolean {
		return this.locs.has(resource);
	}

	/**
	 * Lista `{ model_name, collection }` como `GET /available-models` del original
	 * (`mongoose.models`, sin nombres `__`, orden alfabético).
	 */
	available_mongoose_models(): Array<{ model_name: string; collection: string }> {
		const resource_to_model = new Map<string, string>();
		for (const [model, resource] of Object.entries(REFS.models)) {
			if (!/^[A-Z]/.test(model) || !this.has(resource)) continue;
			if (!resource_to_model.has(resource)) resource_to_model.set(resource, model);
		}
		const seen = new Set<string>();
		const out: Array<{ model_name: string; collection: string }> = [];
		for (const loc of this.locs.values()) {
			if (loc.resource.startsWith('__') || String(loc.collection).startsWith('__')) continue;
			const model_name =
				resource_to_model.get(loc.resource) ??
				(loc.resource === 'branchoffice'
					? 'Branchoffice'
					: loc.resource
							.split('-')
							.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
							.join(''));
			if (!model_name || seen.has(model_name)) continue;
			seen.add(model_name);
			out.push({ model_name, collection: loc.collection });
		}
		out.sort((a, b) => a.model_name.localeCompare(b.model_name));
		return out;
	}

	loc(resource: string): ModuleLoc {
		const hit = this.locs.get(resource);
		if (!hit) throw new Error(`Recurso desconocido: ${resource}`);
		return hit;
	}

	column_names(resource: string): Set<string> {
		const loc = this.loc(resource);
		return new Set([...GENERAL, ...loc.columns.map((c) => c.name)]);
	}

	field_refs(resource: string): Record<string, string> {
		return field_map_for(resource) ?? {};
	}

	/**
	 * Refs simples (sin path anidado) que apuntan a `target`, como el
	 * `_check_references` original que solo mira `schema.obj` con `ref`.
	 */
	incoming_simple_refs(target: string): Array<{ resource: string; field: string }> {
		const out: Array<{ resource: string; field: string }> = [];
		for (const [from, fields] of Object.entries(REFS.fields)) {
			if (from === target || !this.has(from)) continue;
			for (const [field, model] of Object.entries(fields)) {
				if (!field || field.includes('.')) continue;
				if (this.resource_for_model(model) === target) {
					out.push({ resource: from, field });
				}
			}
		}
		return out;
	}

	async referencing_counts(
		target: string,
		id: string,
	): Promise<Array<{ resource: string; field: string; conteo: number }>> {
		const hits: Array<{ resource: string; field: string; conteo: number }> = [];
		for (const incoming of this.incoming_simple_refs(target)) {
			const { total } = await this.find_many(incoming.resource, {
				where: { [incoming.field]: id },
				take: 1,
				include_inactive: false,
				populate: false,
			});
			if (total > 0) hits.push({ ...incoming, conteo: total });
		}
		return hits;
	}

	json_cols(resource: string): Set<string> {
		const loc = this.loc(resource);
		const out = new Set(['custom_data', 'payload']);
		for (const c of loc.columns) if (c.pg === 'json') out.add(c.name);
		return out;
	}

	qt(resource: string): string {
		const loc = this.loc(resource);
		return `${qident(pg_schema_name(loc.technical_id))}.${qident(loc.table)}`;
	}

	/**
	 * Siguiente valor del tracker `__auto_increment_control` (columna
	 * `current_sequence`). Si el recurso tiene la columna, siembra desde el MAX
	 * ya persistido para no reiniciar tras una migración.
	 */
	async next_auto_increment(
		model_name: string,
		increment_field: string,
		opts: { resource?: string; context?: PatternContext } = {},
	): Promise<number> {
		const config = this.has('auto-increment-control')
			? await find_increment_control(this, model_name, increment_field)
			: null;
		const reset_key = config
			? await compute_reset_key(this, config, opts.context)
			: null;
		let floor = 0;
		const resource = opts.resource;
		if (
			!reset_key &&
			resource &&
			this.has(resource) &&
			this.column_names(resource).has(increment_field)
		) {
			const col = qident(increment_field);
			const rows = await this.sql.unsafe(
				`SELECT MAX(CASE
					WHEN ${col}::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${col}::numeric
					WHEN ${col}::text ~ '[0-9]+$' THEN (regexp_match(${col}::text, '([0-9]+)$'))[1]::numeric
					ELSE NULL
				END) AS m FROM ${this.qt(resource)}`,
			);
			floor = Number(rows[0]?.m ?? 0) || 0;
		}
		if (!this.has('auto-increment-control')) return floor + 1;
		const target = config
			? await find_or_create_increment_segment(this, config, reset_key)
			: null;
		if (!target?._id) return floor + 1;
		const qt = this.qt('auto-increment-control');
		const now = new Date().toISOString();
		const updated = await this.sql.unsafe(
			`UPDATE ${qt}
			 SET current_sequence = GREATEST(COALESCE(current_sequence, 0), $1) + 1,
			     updated_at = $2
			 WHERE id = $3
			 RETURNING id, current_sequence`,
			[floor, now, String(target._id)],
		);
		const row = updated[0] as { id?: string; current_sequence?: number } | undefined;
		if (row?.current_sequence == null) return floor + 1;
		const next = Number(row.current_sequence);
		const real_value = await format_increment_real_value(
			this,
			config ?? target,
			next,
			opts.context,
		);
		await this.update('auto-increment-control', String(row.id), {
			current_sequence: next,
			current: next,
			valor: next,
			current_real_value: real_value,
		});
		return next;
	}

	flatten(row: Record<string, unknown> | null, resource?: string): ImperiumDoc | null {
		if (!row) return null;
		const parsed = { ...row };
		const jsons = resource
			? this.json_cols(resource)
			: new Set(['payload', 'custom_data']);
		for (const k of jsons) {
			if (!(k in parsed)) continue;
			parsed[k] = parse_json_cell(parsed[k]);
		}
		/* Columnas extra mal tipadas como text (p. ej. lista-de-precios.product)
		 * llegan como JSON serializado; el original las devolvía como arreglo. */
		if (resource) {
			for (const col of this.loc(resource).columns) {
				if (jsons.has(col.name)) continue;
				parsed[col.name] = parse_json_cell(parsed[col.name]);
			}
		}
		return to_imperium(parsed);
	}

		async find_many(
		resource: string,
		opts: {
			q?: string;
			skip?: number;
			take?: number;
			sort?: string;
			include_inactive?: boolean;
			where?: Record<string, unknown>;
			ids?: string[];
			populate?: boolean;
			mongo_match?: Record<string, unknown> | null;
		} = {},
	): Promise<{ rows: ImperiumDoc[]; total: number }> {
		const loc = this.loc(resource);
		const qt = this.qt(resource);
		const cols = this.column_names(resource);
		const params: unknown[] = [];
		const clauses: string[] = [];
		if (!opts.include_inactive) clauses.push(`is_active IS DISTINCT FROM false`);
		if (opts.q && SearchEngine.is_enabled() && resource !== 'font-awesome-icon-catalog') {
			const ids = await SearchEngine.search_ids(loc.collection, opts.q);
			if (ids !== null && ids.length) {
				const wanted = opts.ids?.length ? ids.filter((id) => opts.ids!.includes(id)) : ids;
				if (wanted.length) opts = { ...opts, q: '', ids: wanted };
			}
		}
		if (opts.ids?.length) {
			const start = params.length + 1;
			params.push(...opts.ids);
			const marks = opts.ids.map((_, i) => `$${start + i}`).join(', ');
			clauses.push(`id IN (${marks})`);
		}
		if (opts.where) {
			for (const [raw_key, v] of Object.entries(opts.where)) {
				if (v === undefined) continue;
				const k = physical_filter_field(cols, raw_key);
				if (v && typeof v === 'object' && !Array.isArray(v) && 'in' in v && Array.isArray((v as { in: unknown[] }).in)) {
					const values = (v as { in: unknown[] }).in.map(String);
					if (!values.length) continue;
					const marks = values.map((item) => {
						params.push(item);
						return `$${params.length}`;
					});
					if (cols.has(k)) clauses.push(`${qident(k)} IN (${marks.join(', ')})`);
					else clauses.push(payload_field_in_sql(k, marks));
					continue;
				}
				if (is_range_filter(v)) {
					const range = v as { gte?: unknown; lte?: unknown };
					if (range.gte !== undefined && range.gte !== '') {
						params.push(range_bound(String(range.gte), 'gte'));
						clauses.push(range_compare_sql(cols, k, '>=', params.length));
					}
					if (range.lte !== undefined && range.lte !== '') {
						params.push(range_bound(String(range.lte), 'lte'));
						clauses.push(range_compare_sql(cols, k, '<=', params.length));
					}
					continue;
				}
				params.push(v);
				if (cols.has(k)) clauses.push(`${qident(k)} = $${params.length}`);
				else clauses.push(payload_field_eq_sql(k, `$${params.length}`));
			}
		}
		if (opts.mongo_match) {
			const extra = mongo_match_to_sql(opts.mongo_match, cols, params);
			if (extra) clauses.push(extra);
		}
		if (opts.q) {
			const like = `%${opts.q}%`;
			const search_cols = ['name', 'description', 'ref', 'search_field'].filter((c) =>
				cols.has(c),
			);
			const parts = search_cols.map((c) => {
				params.push(like);
				return `${qident(c)} ILIKE $${params.length}`;
			});
			params.push(like);
			parts.push(`payload::text ILIKE $${params.length}`);
			clauses.push(`(${parts.join(' OR ')})`);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
		const count_rows = await this.sql.unsafe(
			`SELECT count(*)::int AS n FROM ${qt}${where}`,
			params,
		);
		const total = Number(count_rows[0]?.n ?? 0);
		let order = ' ORDER BY name ASC NULLS LAST, id ASC';
		if (opts.sort) {
			const m = opts.sort.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?::(asc|desc))?$/i);
			const raw_campo = (m?.[1] ?? '').replace(/^_/, '');
			const aliases: Record<string, string> = {
				updatedAt: 'updated_at',
				createdAt: 'created_at',
				_id: 'id',
			};
			const campo = aliases[raw_campo] ?? raw_campo;
			const dir = (m?.[2] ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
			if (campo && cols.has(campo === 'ref' ? 'ref' : campo)) {
				const col = campo === '_ref' ? 'ref' : campo;
				order = ` ORDER BY ${qident(col)} ${dir} NULLS LAST`;
			}
		}
		const take = opts.take ?? 100;
		const skip = opts.skip ?? 0;
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${qt}${where}${order} LIMIT ${take} OFFSET ${skip}`,
			params,
		);
		const flattened = rows.map((r) => this.flatten(r as Record<string, unknown>, resource)!);
		const populated =
			opts.populate === false ? flattened : await this.populate_docs(resource, flattened);
		return {
			rows: populated,
			total,
		};
	}

	async find_id(resource: string, id: string): Promise<ImperiumDoc | null> {
		if (id.startsWith('ref----')) {
			return this.find_where(resource, { ref: id.slice(7) });
		}
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${this.qt(resource)} WHERE id = $1 LIMIT 1`,
			[id],
		);
		return this.flatten((rows[0] as Record<string, unknown>) ?? null, resource);
	}

	async find_where(
		resource: string,
		where: Record<string, unknown>,
	): Promise<ImperiumDoc | null> {
		const { rows } = await this.find_many(resource, {
			where,
			take: 1,
			include_inactive: true,
			populate: false,
		});
		return rows[0] ?? null;
	}

	async assert_unique_business_keys(
		resource: string,
		doc: ImperiumDoc,
		except_id?: string,
	) {
		for (const field of unique_fields_for(resource)) {
			const raw = doc[field];
			if (raw === undefined || raw === null) continue;
			const value = String(raw).trim();
			if (!value) continue;
			const found = await this.find_where(resource, { [field]: value });
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
	}

	async insert(resource: string, doc: ImperiumDoc): Promise<ImperiumDoc> {
		apply_schema_setters(resource, doc);
		assert_required_fields(resource, doc);
		assert_objectid_refs(resource, doc);
		await this.assert_unique_business_keys(resource, doc);
		const cols = this.column_names(resource);
		const jsons = this.json_cols(resource);
		const row = from_imperium(doc, cols);
		if (!row.id) row.id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
		const ts = new Date().toISOString();
		row.created_at ??= ts;
		row.updated_at ??= ts;
		if (row.is_active === undefined) row.is_active = true;
		const keys = Object.keys(row).filter((k) => cols.has(k));
		const values = keys.map((k) => cell(row[k], jsons.has(k)));
		const qt = this.qt(resource);
		const inserted = await this.sql.unsafe(
			`INSERT INTO ${qt} (${keys.map(qident).join(', ')}) VALUES (${keys.map((k, i) => json_placeholder(i + 1, jsons.has(k))).join(', ')}) RETURNING *`,
			values,
		);
		const created = this.flatten(inserted[0] as Record<string, unknown>, resource)!;
		await this.sync_search(resource, created);
		await record_document_history(this, resource, null, created).catch(() => undefined);
		return created;
	}

	async update(
		resource: string,
		id: string,
		patch: ImperiumDoc,
	): Promise<ImperiumDoc | null> {
		const existing = await this.find_id(resource, id);
		if (!existing) return null;
		const cols = this.column_names(resource);
		const jsons = this.json_cols(resource);
		const merged: ImperiumDoc = {
			...existing,
			...patch,
			_id: id,
			payload: { ...as_object(existing), ...as_object(patch) },
		};
		apply_schema_setters(resource, merged);
		assert_required_fields(resource, merged);
		assert_objectid_refs(resource, merged);
		await this.assert_unique_business_keys(resource, merged, id);
		const row = from_imperium(merged, cols);
		row.id = id;
		row.updated_at = new Date().toISOString();
		const keys = Object.keys(row).filter((k) => cols.has(k) && k !== 'id');
		const values = keys.map((k) => cell(row[k], jsons.has(k)));
		values.push(id);
		const set = keys.map((k, i) => `${qident(k)} = ${json_placeholder(i + 1, jsons.has(k))}`).join(', ');
		const updated = await this.sql.unsafe(
			`UPDATE ${this.qt(resource)} SET ${set} WHERE id = $${keys.length + 1} RETURNING *`,
			values,
		);
		const saved = this.flatten((updated[0] as Record<string, unknown>) ?? null, resource);
		if (saved) await this.sync_search(resource, saved);
		if (saved) await record_document_history(this, resource, existing, saved).catch(() => undefined);
		return saved;
	}

	async sync_search(resource: string, doc: ImperiumDoc) {
		const collection = this.loc(resource).collection;
		const id = String(doc._id ?? '');
		if (!id) return;
		if (doc.is_active === false) {
			await SearchEngine.delete_documents(collection, [id]);
			return;
		}
		const search_text = search_text_from_doc(doc);
		if (!search_text) return;
		await SearchEngine.index_documents(collection, [{ id, search_text }]);
	}

	async remove(resource: string, id: string): Promise<ImperiumDoc | null> {
		return this.update(resource, id, { is_active: false });
	}

	async populate_docs(resource: string, docs: ImperiumDoc[]): Promise<ImperiumDoc[]> {
		const field_map = field_map_for(resource);
		if (!field_map || !docs.length) return docs;
		const needed = new Map<string, Set<string>>();
		for (const [field, model] of Object.entries(field_map)) {
			const target = this.resource_for_model(model);
			if (!target) continue;
			for (const doc of docs) {
				for (const id of collect_ref_ids(doc, field.split('.'))) {
					if (!needed.has(target)) needed.set(target, new Set());
					needed.get(target)!.add(id);
				}
			}
		}
		const loaded = new Map<string, Map<string, ImperiumDoc>>();
		for (const [target, ids] of needed) {
			const { rows } = await this.find_many(target, {
				ids: [...ids],
				take: ids.size,
				include_inactive: true,
				populate: false,
			});
			loaded.set(target, new Map(rows.map((r) => [String(r._id), r])));
		}
		return docs.map((doc) => {
			const out = { ...doc };
			for (const [field, model] of Object.entries(field_map)) {
				const target = this.resource_for_model(model);
				const lookup = target ? loaded.get(target) : undefined;
				apply_populated_path(out, field.split('.'), lookup);
			}
			return out;
		});
	}

	/**
	 * En listados el original deja refs como nombre (lookup) y el id en `campo_id`.
	 * El detalle sigue con el objeto lite para los formularios.
	 */
	flatten_list_docs(resource: string, docs: ImperiumDoc[]): ImperiumDoc[] {
		const field_map = field_map_for(resource);
		if (!field_map || !docs.length) return docs;
		return docs.map((doc) => {
			const out = { ...doc };
			for (const field of Object.keys(field_map)) {
				if (field.includes('.')) continue;
				const val = out[field];
				if (Array.isArray(val)) continue;
				if (!val || typeof val !== 'object') continue;
				const id = ref_id(val);
				if (!id) {
					out[field] = '';
					continue;
				}
				// String denormalizado en el original (no es ObjectId + $lookup).
				// El form de pedidos lee `invoice_request_id` como id.
				if (LIST_REF_KEEP_AS_ID.has(field)) {
					out[field] = id;
					continue;
				}
				const id_key = `${field}_id`;
				if (out[id_key] == null || out[id_key] === '') out[id_key] = id;
				// El $lookup original siempre deja el nombre (aunque vacío), no el objeto.
				out[field] = String((val as ImperiumDoc).name ?? '').trim();
			}
			return out;
		});
	}

	resource_for_model(model: string): string | null {
		const direct = REFS.models[model] ?? REFS.models[model.toLowerCase()];
		if (direct && this.has(direct)) return direct;
		const kebab = model.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
		if (this.has(kebab)) return kebab;
		if (this.has(`${kebab}s`)) return `${kebab}s`;
		if (this.has(model.toLowerCase())) return model.toLowerCase();
		if (model === 'Employee' && this.has('employee')) return 'employee';
		return null;
	}

	async distinct(resource: string, field: string, q = ''): Promise<unknown[]> {
		const cols = this.column_names(resource);
		const qt = this.qt(resource);
		if (cols.has(field)) {
			const params: unknown[] = [];
			let extra = '';
			if (q) {
				params.push(`%${q}%`);
				extra = ` WHERE ${qident(field)}::text ILIKE $1`;
			}
			const rows = await this.sql.unsafe(
				`SELECT DISTINCT ${qident(field)} AS v FROM ${qt}${extra} LIMIT 200`,
				params,
			);
			return rows.map((r) => (r as { v: unknown }).v).filter((v) => v != null);
		}
		const params: unknown[] = [];
		let extra = '';
		if (q) {
			params.push(`%${q}%`);
			extra = ` WHERE payload ->> ${literal(field)} ILIKE $1`;
		}
		const rows = await this.sql.unsafe(
			`SELECT DISTINCT payload ->> ${literal(field)} AS v FROM ${qt}${extra} LIMIT 200`,
			params,
		);
		return rows.map((r) => (r as { v: unknown }).v).filter((v) => v != null && v !== '');
	}

	async stats(
		resource: string,
		url?: URL,
		mongo_match?: Record<string, unknown> | null,
	): Promise<Record<string, unknown>> {
		if (resource === 'ticketing-system-turn') return this.turn_stats(mongo_match);
		if (resource === 'citizen-report') return this.citizen_report_stats(url, mongo_match);
		if (resource === 'purchase-order') return purchase_order_stats(this, mongo_match);
		if (resource === 'pedidos' || resource === 'pedidos-surtir') {
			return pedidos_sales_stats(this, url, mongo_match);
		}
		const qt = this.qt(resource);
		const cols = this.column_names(resource);
		const from = new Date();
		from.setDate(from.getDate() - 30);
		const from_iso = from.toISOString();
		const params: unknown[] = [from_iso];
		const extra = mongo_match ? mongo_match_to_sql(mongo_match, cols, params) : '';
		const where = extra ? ` WHERE ${extra}` : '';
		const rows = await this.sql.unsafe(
			`SELECT
        count(*)::int AS total_records,
        count(*) FILTER (WHERE is_active IS DISTINCT FROM false)::int AS active_records,
        count(*) FILTER (WHERE is_active = false)::int AS inactive_records,
        count(*) FILTER (WHERE created_at >= $1)::int AS recent_records
      FROM ${qt}${where}`,
			params,
		);
		const r = (rows[0] ?? {}) as Record<string, number>;
		const total_records = r.total_records ?? 0;
		const active_records = r.active_records ?? 0;
		const inactive_records = r.inactive_records ?? 0;
		const recent_records_30d = r.recent_records ?? 0;
		const domain: Record<string, unknown> = {};
		if (resource === 'products') {
			domain.total_costo_existencias = await products_inventory_cost(this, mongo_match);
		}
		if (resource === 'vehicle') {
			domain.by_status = await vehicle_by_status(this, mongo_match);
		}
		const now = new Date();
		const daily_where = extra ? `created_at >= $1 AND ${extra}` : `created_at >= $1`;
		const daily_rows =
			DAILY_LINE_CHART.has(resource) || resource === 'medical-file'
				? await this.sql.unsafe(
						`SELECT LEFT(created_at, 10) AS day, COUNT(*)::int AS n
           FROM ${qt}
           WHERE ${daily_where}
           GROUP BY 1
           ORDER BY 1`,
						params,
					)
				: [];
		if (resource === 'medical-file') {
			return {
				total_records,
				active_records,
				inactive_records,
				date_range: { from, to: now },
				daily_stats: daily_rows.map((row) => ({
					date: String((row as { day?: unknown }).day ?? ''),
					count: Number((row as { n?: unknown }).n ?? 0),
				})),
				last_updated: now,
			};
		}
		if (DAILY_LINE_CHART.has(resource)) {
			return {
				total_records,
				active_records,
				inactive_records,
				date_range: { from, to: now },
				last_updated: now,
				kpis: {
					total_records: { label: 'Total', value: total_records },
					active_records: { label: 'Activos', value: active_records },
					inactive_records: { label: 'Inactivos', value: inactive_records },
				},
				charts: {
					daily_stats: {
						title: 'Registros por día (últimos 30 días)',
						chart_type: 'line',
						data: daily_rows.map((row) => ({
							name: String((row as { day?: unknown }).day ?? ''),
							value: Number((row as { n?: unknown }).n ?? 0),
						})),
					},
				},
				...domain,
			};
		}
		return {
			model_name: resource,
			total_records,
			active_records,
			inactive_records,
			recent_records_30d,
			date_range_30d: { from, to: now },
			last_updated: now,
			kpis: {
				total_records: { label: 'Total', value: total_records },
				active_records: { label: 'Activos', value: active_records },
				inactive_records: { label: 'Inactivos', value: inactive_records },
				recent_records_30d: { label: 'Últimos 30 días', value: recent_records_30d },
			},
			...domain,
		};
	}

	async turn_stats(mongo_match?: Record<string, unknown> | null): Promise<Record<string, unknown>> {
		const { rows } = await this.find_many('ticketing-system-turn', {
			take: 5000,
			include_inactive: true,
			mongo_match,
		});
		const completed = rows.filter(
			(r) => String(r.status ?? r.state ?? '') === 'completado',
		);
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const by_day = new Map<string, ImperiumDoc[]>();
		for (const r of completed) {
			const k = day_of(r);
			if (!k) continue;
			const list = by_day.get(k) ?? [];
			list.push(r);
			by_day.set(k, list);
		}
		const today_key = new Date().toISOString().slice(0, 10);
		let ref_key = today_key;
		if (!(by_day.get(today_key)?.length)) {
			let best = '';
			let n = 0;
			for (const [k, list] of by_day) {
				if (list.length > n) {
					n = list.length;
					best = k;
				}
			}
			if (best) ref_key = best;
		}
		const today_rows = by_day.get(ref_key) ?? [];
		const box_label = (r: ImperiumDoc) => {
			const b = as_object(r.assigned_box);
			return String(b.name ?? 'Sin nombre');
		};
		const box_ref = (r: ImperiumDoc) => {
			const b = as_object(r.assigned_box);
			return b._id ? b : { _id: ref_id(r.assigned_box), name: box_label(r) };
		};
		const daily_map = new Map<
			string,
			{ box_id: unknown; box_name: string; turns_attended: number }
		>();
		for (const r of today_rows) {
			const id = ref_id(r.assigned_box) || 'none';
			const cur = daily_map.get(id) ?? {
				box_id: box_ref(r),
				box_name: box_label(r),
				turns_attended: 0,
			};
			cur.turns_attended += 1;
			daily_map.set(id, cur);
		}
		const daily_stats = [...daily_map.values()];
		const ref_date = new Date(`${ref_key}T00:00:00.000Z`);
		const seven_keys: string[] = [];
		for (let i = 6; i >= 0; i--) {
			const d = new Date(ref_date);
			d.setUTCDate(d.getUTCDate() - i);
			seven_keys.push(d.toISOString().slice(0, 10));
		}
		const box_ids = new Set<string>();
		for (const k of seven_keys) {
			for (const r of by_day.get(k) ?? []) box_ids.add(ref_id(r.assigned_box) || 'none');
		}
		const seven_days_stats = [...box_ids].map((id) => {
			const sample =
				seven_keys.flatMap((k) => by_day.get(k) ?? []).find(
					(r) => (ref_id(r.assigned_box) || 'none') === id,
				) ?? today_rows[0];
			const daily = seven_keys.map((k) => {
				const day_rows = (by_day.get(k) ?? []).filter(
					(r) => (ref_id(r.assigned_box) || 'none') === id,
				);
				const mins = day_rows.map(turn_duration_minutes).filter((n) => n > 0);
				return {
					day: k,
					total_turns: day_rows.length,
					avg_time_minutes: mins.length
						? Number((mins.reduce((a, b) => a + b, 0) / mins.length).toFixed(2))
						: 0,
				};
			});
			return {
				box_id: sample ? box_ref(sample) : { _id: id, name: 'Sin nombre' },
				box_name: sample ? box_label(sample) : 'Sin nombre',
				daily_stats: daily,
			};
		});
		const average_times = seven_days_stats.map((box) => {
			const mins = box.daily_stats
				.map((d) => Number(d.avg_time_minutes))
				.filter((n) => n > 0);
			return {
				box_id: box.box_id,
				box_name: box.box_name,
				average_time_minutes: mins.length
					? Number((mins.reduce((a, b) => a + b, 0) / mins.length).toFixed(2))
					: 0,
			};
		});
		const service_map = new Map<
			string,
			{ service_type_name: string; turn_count: number; minutes: number[] }
		>();
		for (const r of today_rows) {
			const services = as_array(r.services);
			const name = String(
				as_object(services[0]).name ?? r.service_type ?? 'Sin servicio',
			);
			const cur = service_map.get(name) ?? {
				service_type_name: name,
				turn_count: 0,
				minutes: [],
			};
			cur.turn_count += 1;
			const m = turn_duration_minutes(r);
			if (m > 0) cur.minutes.push(m);
			service_map.set(name, cur);
		}
		const services_stats = [...service_map.values()].map((s) => ({
			service_type_name: s.service_type_name,
			turn_count: s.turn_count,
			average_time_minutes: s.minutes.length
				? Number((s.minutes.reduce((a, b) => a + b, 0) / s.minutes.length).toFixed(2))
				: 0,
		}));
		const ctype_map = new Map<
			string,
			{ customer_type_name: string; customer_type_id: unknown; turn_count: number; minutes: number[] }
		>();
		for (const r of today_rows) {
			const c = as_object(r.customer_type);
			const name = String(c.name ?? 'Sin tipo');
			const cur = ctype_map.get(name) ?? {
				customer_type_name: name,
				customer_type_id: c._id ? c : { _id: ref_id(r.customer_type), name },
				turn_count: 0,
				minutes: [],
			};
			cur.turn_count += 1;
			const m = turn_duration_minutes(r);
			if (m > 0) cur.minutes.push(m);
			ctype_map.set(name, cur);
		}
		const customer_types_stats = [...ctype_map.values()].map((s) => ({
			customer_type_name: s.customer_type_name,
			customer_type_id: s.customer_type_id,
			turn_count: s.turn_count,
			average_time_minutes: s.minutes.length
				? Number((s.minutes.reduce((a, b) => a + b, 0) / s.minutes.length).toFixed(2))
				: 0,
		}));
		const seven_rows = seven_keys.flatMap((k) => by_day.get(k) ?? []);
		const four_keys = seven_keys.slice(-4);
		const four_rows = four_keys.flatMap((k) => by_day.get(k) ?? []);
		const customer_type_rows = four_rows.filter((r) => Boolean(ref_id(r.customer_type)));
		const load_lookup = async (resource: string) =>
			this.has(resource)
				? (
						await this.find_many(resource, {
							take: 500,
							include_inactive: false,
							populate: false,
						})
					).rows
				: [];
		const [boxes, services, customer_types] = await Promise.all([
			load_lookup('ticketing-system-box-config'),
			load_lookup('ticketing-system-service-type'),
			load_lookup('ticketing-system-customer-type'),
		]);
		const range_7 = { from: `${seven_keys[0]}T00:00:00.000Z`, to: `${ref_key}T23:59:59.999Z` };
		const range_4 = {
			from: `${four_keys[0] ?? ref_key}T00:00:00.000Z`,
			to: `${ref_key}T23:59:59.999Z`,
		};
		const range_today = {
			from: `${ref_key}T00:00:00.000Z`,
			to: `${ref_key}T23:59:59.999Z`,
		};
		const turn_export = (
			records: ImperiumDoc[],
			title: string,
			chart_type: 'pie' | 'line',
			unit: string,
			aggregation_method: string,
			aggregation_description: string,
			range: { from: string; to: string },
			lookups: Record<string, ImperiumDoc[]>,
		) => ({
			records,
			metadata: {
				title,
				unit,
				total_records: records.length,
				chart_type,
				aggregation_method,
				aggregation_description,
				query_date_range: range,
				filters_applied: { status: 'completado' },
			},
			lookups,
		});
		return {
			daily_stats,
			average_times,
			raw_turns_today: today_rows,
			total_turns_today: today_rows.length,
			seven_days_stats,
			services_stats,
			customer_types_stats,
			__export_data: {
				daily_turns_pie: turn_export(
					today_rows,
					'Turnos del día por caja',
					'pie',
					'cantidad',
					'count_by_box',
					'Cantidad de turnos agrupados por caja',
					range_today,
					{ boxes },
				),
				average_times_7d_line: turn_export(
					seven_rows,
					'Tiempos promedio últimos 7 días',
					'line',
					'minutos',
					'weighted_average_by_box_and_day',
					'Promedio ponderado de tiempos por caja y día (últimos 7 días)',
					range_7,
					{ boxes },
				),
				turns_last_7d_line: turn_export(
					seven_rows,
					'Total turnos últimos 7 días',
					'line',
					'cantidad',
					'count_by_box_and_day',
					'Cantidad de turnos por caja y día (últimos 7 días)',
					range_7,
					{ boxes },
				),
				avg_times_per_day_line: turn_export(
					seven_rows,
					'Tiempos promedio por día',
					'line',
					'minutos',
					'average_by_day',
					'Tiempo promedio por día (últimos 7 días)',
					range_7,
					{ boxes },
				),
				services_stats_pie: turn_export(
					four_rows,
					'Tiempos por tipo de servicio',
					'pie',
					'minutos',
					'weighted_average_by_service',
					'Promedio ponderado de tiempos por tipo de servicio (últimos 4 días)',
					range_4,
					{ services },
				),
				customer_types_pie: turn_export(
					customer_type_rows,
					'Tiempos por tipo de cliente',
					'pie',
					'minutos',
					'average_by_customer_type',
					'Tiempo promedio por tipo de cliente (últimos 4 días)',
					range_4,
					{ customer_types, boxes },
				),
			},
		};
	}

	async citizen_report_stats(
		url?: URL,
		mongo_match?: Record<string, unknown> | null,
	): Promise<Record<string, unknown>> {
		const { rows } = await this.find_many('citizen-report', {
			take: 5000,
			include_inactive: false,
			mongo_match,
		});
		const date_from = url?.searchParams.get('date_from');
		const date_to = url?.searchParams.get('date_to');
		const priorities = [
			...(url?.searchParams.getAll('priorities[]') ?? []),
			...(url?.searchParams.getAll('priorities') ?? []),
		].filter(Boolean);
		const statuses = [
			...(url?.searchParams.getAll('statuses[]') ?? []),
			...(url?.searchParams.getAll('statuses') ?? []),
		].filter(Boolean);
		const from_ms = date_from ? new Date(date_from).getTime() : NaN;
		const to_ms = date_to ? new Date(date_to).getTime() : Date.now();
		const filtered = rows.filter((r) => {
			if (Number.isFinite(from_ms)) {
				const created = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
				if (!Number.isFinite(created) || created < from_ms || created > to_ms) {
					return false;
				}
			}
			if (priorities.length && !priorities.includes(String(r.priority ?? ''))) {
				return false;
			}
			if (statuses.length && !statuses.includes(String(r.status ?? ''))) {
				return false;
			}
			return true;
		});
		const status_of = (r: ImperiumDoc) => String(r.status ?? '').toLowerCase();
		const priority_of = (r: ImperiumDoc) => String(r.priority ?? '').toUpperCase();
		const pending = filtered.filter((r) => {
			const st = status_of(r);
			if (st === 'pendiente' || st === 'en_proceso') return true;
			if (!st && ['MEDIA', 'ALTA', 'URGENTE', 'CRITICA'].includes(priority_of(r))) {
				return true;
			}
			return false;
		});
		const urgent = filtered.filter((r) =>
			['URGENTE', 'CRITICA'].includes(priority_of(r)),
		);
		const resolved = filtered.filter((r) => {
			const st = status_of(r);
			if (st === 'terminado') return true;
			if (!st && priority_of(r) === 'BAJA') return true;
			return false;
		});
		const group = (key: (r: ImperiumDoc) => string) => {
			const map = new Map<string, number>();
			for (const r of filtered) {
				const name = key(r) || 'Sin valor';
				map.set(name, (map.get(name) ?? 0) + 1);
			}
			return [...map.entries()]
				.map(([name, value]) => ({ name, value }))
				.sort((a, b) => b.value - a.value);
		};
		const ref_name = (v: unknown, fallback: string) => {
			const o = as_object(v);
			return String(o.name ?? (typeof v === 'string' && v ? v : fallback));
		};
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const month_of = (r: ImperiumDoc) => day_of(r).slice(0, 7);
		const recent_cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const recent = filtered.filter((r) => {
			const t = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
			return Number.isFinite(t) && t >= recent_cut;
		});
		const closed = filtered.filter((r) => status_of(r) === 'terminado');
		const resolution = new Map<string, { sum: number; n: number }>();
		for (const r of closed) {
			const a = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
			const b = new Date(String(r.updatedAt ?? r.updated_at ?? '')).getTime();
			if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
			const days = (b - a) / (1000 * 60 * 60 * 24);
			const p = priority_of(r) || 'SIN_PRIORIDAD';
			const cur = resolution.get(p) ?? { sum: 0, n: 0 };
			cur.sum += days;
			cur.n += 1;
			resolution.set(p, cur);
		}
		const avg_resolution_time = [...resolution.entries()]
			.map(([name, v]) => ({ name, value: Number((v.sum / v.n).toFixed(1)) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const phones = new Map<string, number>();
		for (const r of filtered) {
			const phone = String(r.citizen_phone ?? '').trim();
			if (!phone) continue;
			phones.set(phone, (phones.get(phone) ?? 0) + 1);
		}
		const citizen_recurrence = [...phones.entries()]
			.filter(([, n]) => n > 1)
			.map(([name, value]) => ({ name, value }))
			.sort((a, b) => b.value - a.value)
			.slice(0, 10);
		const coord = (r: ImperiumDoc) => {
			const c = as_object(r.report_coordinates);
			const lat = Number(c.latitude ?? c.lat);
			const lon = Number(c.longitude ?? c.lng ?? c.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
			return `${lat.toFixed(2)},${lon.toFixed(2)}`;
		};
		const export_sheet = (
			title: string,
			chart_type: string,
			lookups: Record<string, string> = {},
		) => ({
			records: filtered,
			metadata: {
				title,
				unit: 'Quejas',
				total_records: filtered.length,
				chart_type,
			},
			lookups,
		});
		return {
			kpis: {
				total_complaints: filtered.length,
				pending_complaints: pending.length,
				urgent_complaints: urgent.length,
				resolved_complaints: resolved.length,
			},
			charts: {
				priority_distribution: { data: group((r) => String(r.priority ?? 'SIN_PRIORIDAD')) },
				status_distribution: { data: group((r) => String(r.status ?? 'SIN_ESTATUS')) },
				employee_workload: {
					data: group((r) => ref_name(r.employee_taken_the_report, 'Sin asignar')),
				},
				department_distribution: {
					data: group((r) => ref_name(r.department, 'Sin departamento')),
				},
				recent_activity: { data: group(day_of).filter((x) => x.name && recent.some((r) => day_of(r) === x.name)) },
				reporting_medium_distribution: {
					data: group((r) => ref_name(r.reporting_medium, 'Sin medio')),
				},
				problem_distribution: {
					data: group((r) => ref_name(r.citizen_report_problem, 'Sin problema')),
				},
				monthly_trend: { data: group(month_of).filter((x) => x.name) },
				geographic_distribution: {
					data: group((r) => ref_name(r.borough, coord(r) || 'Sin ubicación')),
				},
				avg_resolution_time: { data: avg_resolution_time },
				citizen_recurrence: { data: citizen_recurrence },
			},
			__export_data: {
				priority_distribution: export_sheet('Distribución por Prioridad', 'pie'),
				status_distribution: export_sheet('Distribución por Estatus', 'pie'),
				employee_workload: export_sheet('Carga de Trabajo por Empleado', 'bar', {
					employee_taken_the_report: 'name',
				}),
				department_distribution: export_sheet('Distribución por Departamento', 'pie', {
					department: 'name',
				}),
				recent_activity: export_sheet('Actividad Reciente (7 días)', 'line'),
			},
		};
	}
}

function parse_json_cell(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function turn_duration_minutes(row: ImperiumDoc): number {
	let raw: unknown = row.time_box;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return 0;
		}
	}
	if (!Array.isArray(raw) || raw.length < 2) return 0;
	const a = new Date(String(raw[0])).getTime();
	const b = new Date(String(raw[1])).getTime();
	if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
	return (b - a) / 60000;
}

function collect_ref_ids(value: unknown, path: string[]): string[] {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				return collect_ref_ids(JSON.parse(trimmed), path);
			} catch {
				/* id suelto, no JSON */
			}
		}
	}
	if (!path.length) {
		if (Array.isArray(value)) {
			return value.flatMap((entry) => {
				const id = ref_id(entry);
				return id ? [id] : [];
			});
		}
		const id = ref_id(value);
		return id ? [id] : [];
	}
	if (value == null) return [];
	if (Array.isArray(value)) {
		return value.flatMap((entry) => collect_ref_ids(entry, path));
	}
	if (typeof value !== 'object') return [];
	return collect_ref_ids((value as Record<string, unknown>)[path[0]!], path.slice(1));
}

function populated_lite(hit: ImperiumDoc | undefined, id: string): ImperiumDoc {
	if (!hit) return { _id: id, name: '' };
	return {
		_id: hit._id,
		name: hit.name ?? hit.nombreCompleto ?? '',
		description: hit.description ?? '',
		...(hit.codigo != null ? { codigo: hit.codigo } : {}),
		...(hit.image != null ? { image: hit.image } : {}),
	};
}

function apply_populated_path(
	target: Record<string, unknown>,
	path: string[],
	lookup: Map<string, ImperiumDoc> | undefined,
) {
	if (!path.length) return;
	const [head, ...rest] = path;
	const current = target[head!];
	if (typeof current === 'string') {
		const trimmed = current.trim();
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				target[head!] = JSON.parse(trimmed);
			} catch {
				/* se deja el string */
			}
		}
	}
	if (!rest.length) {
		const val = target[head!];
		if (Array.isArray(val)) {
			target[head!] = val.map((entry) => {
				const id = ref_id(entry);
				return id ? populated_lite(lookup?.get(id), id) : entry;
			});
			return;
		}
		const id = ref_id(val);
		if (id) target[head!] = populated_lite(lookup?.get(id), id);
		return;
	}
	const val = target[head!];
	if (Array.isArray(val)) {
		target[head!] = val.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
			const copy = { ...(entry as Record<string, unknown>) };
			apply_populated_path(copy, rest, lookup);
			return copy;
		});
		return;
	}
	if (val && typeof val === 'object' && !Array.isArray(val)) {
		const copy = { ...(val as Record<string, unknown>) };
		apply_populated_path(copy, rest, lookup);
		target[head!] = copy;
	}
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'string') {
		const s = value.trim();
		if (s.startsWith('{') || (s.startsWith('"') && s.endsWith('"'))) {
			try {
				return ref_id(JSON.parse(s));
			} catch {
				return s.replace(/^"+|"+$/g, '');
			}
		}
		return s;
	}
	if (typeof value === 'object' && !Array.isArray(value)) {
		const o = value as Record<string, unknown>;
		const id = o._id ?? o.id;
		if (id == null || id === '') return '';
		return String(id).trim();
	}
	return String(value).trim();
}

function json_placeholder(index: number, json: boolean): string {
	return json ? `$${index}::jsonb` : `$${index}`;
}

const FILTER_FIELD_ALIASES: Record<string, string> = {
	updatedAt: 'updated_at',
	createdAt: 'created_at',
	_id: 'id',
	_ref: 'ref',
};

const RANGE_FILTER_TIMEZONE = process.env.APP_TIMEZONE || 'America/Mexico_City';

function physical_filter_field(cols: Set<string>, field: string) {
	const mapped = FILTER_FIELD_ALIASES[field] ?? field;
	if (mapped === 'fecha' && !cols.has('fecha') && cols.has('created_at')) return 'created_at';
	return mapped;
}

function is_range_filter(value: unknown): value is { gte?: unknown; lte?: unknown } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const rec = value as Record<string, unknown>;
	return ('gte' in rec || 'lte' in rec) && !('in' in rec);
}

function range_bound(raw: string, op: 'gte' | 'lte') {
	const text = raw.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
		return zoned_day_bound(text, op === 'lte', RANGE_FILTER_TIMEZONE).toISOString();
	}
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function zoned_day_bound(date_only: string, end_of_day: boolean, tz: string) {
	const [year, month, day] = date_only.split('-').map(Number);
	const hour = end_of_day ? 23 : 0;
	const minute = end_of_day ? 59 : 0;
	const second = end_of_day ? 59 : 0;
	const ms = end_of_day ? 999 : 0;
	return local_wall_time_to_utc(year!, month!, day!, hour, minute, second, ms, tz);
}

function local_wall_time_to_utc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	ms: number,
	tz: string,
) {
	let utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
	for (let i = 0; i < 2; i++) {
		const offset = tz_offset_ms(new Date(utc), tz);
		utc = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset;
	}
	return new Date(utc);
}

function tz_offset_ms(date: Date, tz: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
	return (
		Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) -
		date.getTime()
	);
}

function range_compare_sql(cols: Set<string>, field: string, op: '>=' | '<=', index: number) {
	if (cols.has(field)) return `${qident(field)} ${op} $${index}`;
	return payload_field_range_sql(field, op, `$${index}`);
}

function payload_field_range_sql(field: string, op: '>=' | '<=', param: string): string {
	const key = literal(field);
	return `(payload ->> ${key} ${op} ${param}::text OR (jsonb_typeof(payload) = 'string' AND ((payload #>> '{}')::jsonb) ->> ${key} ${op} ${param}::text))`;
}

/** Campo en payload, incluso si la celda jsonb quedó como string (doble encode). */
function payload_field_eq_sql(field: string, param: string): string {
	const key = literal(field);
	return `(payload ->> ${key} = ${param}::text OR (jsonb_typeof(payload) = 'string' AND ((payload #>> '{}')::jsonb) ->> ${key} = ${param}::text))`;
}

function payload_field_in_sql(field: string, marks: string[]): string {
	const key = literal(field);
	const list = marks.join(', ');
	return `(payload ->> ${key} IN (${list}) OR (jsonb_typeof(payload) = 'string' AND ((payload #>> '{}')::jsonb) ->> ${key} IN (${list})))`;
}

function cell(v: unknown, json: boolean): unknown {
	if (v == null) return null;
	if (json) {
		const parsed = typeof v === 'string' ? parse_json_cell(v) : v;
		return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
	}
	if (Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))) {
		return JSON.stringify(v);
	}
	return v;
}

function literal(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

export function load_catalog_path(): string {
	return (
		process.env.CATALOG_PATH ??
		join(import.meta.dir, '../../catalog.json')
	);
}
