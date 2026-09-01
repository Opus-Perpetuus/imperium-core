/**
 * Almacén de documentos Imperium sobre los schemas SQL de las apps.
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
import { delivery_package_by_status } from './delivery-package-flow.ts';
import { pedidos_sales_stats } from './pedidos-flow.ts';
import { purchase_order_stats } from './purchase-order-flow.ts';
import { planeacion_statistics } from './planeacion-flow.ts';
import { invoice_request_stats } from './invoice-request-flow.ts';
import { physical_count_by_state } from './inventory-physical-count-flow.ts';
import {
	cost_entry_stats,
	inventory_movement_stats_extras,
	stock_quant_stats_extras,
} from './inventory-logistics-flow.ts';
import { location_stats_extras } from './location-flow.ts';
import { delivery_return_by_state } from './delivery-return-flow.ts';
import { record_document_history } from './history.ts';
import {
	find_increment_control,
	compute_reset_key,
	find_or_create_increment_segment,
	format_increment_real_value,
	type PatternContext,
} from './custom-pattern-render.ts';
import {
	apply_schema_setters,
	assert_required_fields,
	FieldValidationError,
	required_fields_for,
} from './required-fields.ts';
import { list_projection_keys } from './list-projection.ts';

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
	technical_id: string;
	image: string;
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
	__time_sheets: 'time-sheets',
};

function round_qty(value: number): number {
	return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * El service original (`create_system_movements`) siempre recalcula
 * stock_disponible_resultante = total − apartado. El default Mongoose es 0
 * y no debe quedarse si el total resultante es distinto.
 */
function apply_inventory_movement_ledger(resource: string, doc: ImperiumDoc) {
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	if (canonical !== 'inventory-movement') return;
	const total = Number(doc.stock_total_resultante ?? 0);
	const apartado = Number(doc.stock_apartado_resultante ?? 0);
	if (!Number.isFinite(total) || !Number.isFinite(apartado)) return;
	doc.stock_disponible_resultante = round_qty(total - apartado);
}

const SQL_NAME_FALLBACKS = [
	'nombre_completo',
	'nombre_paciente',
	'citizen_name',
	'ticket_sequence',
];

/**
 * El SQL del kit exige `name NOT NULL`. Modelos como Patient / MedicalFile no
 * tienen `name` en Mongoose (el form original manda `nombre_completo` /
 * `nombre_paciente`). Sin este relleno el INSERT truena con 23502.
 */
function ensure_sql_name(resource: string, doc: ImperiumDoc) {
	if (doc.name != null && String(doc.name).trim() !== '') return;
	if (required_fields_for(resource).includes('name')) return;
	for (const field of SQL_NAME_FALLBACKS) {
		const value = String(doc[field] ?? '').trim();
		if (value) {
			doc.name = value;
			return;
		}
	}
	doc.name = '';
}

/** Unique de negocio que el original imponía en Mongoose y Postgres aún no indexa. */
const UNIQUE_FIELDS: Record<string, string[]> = {
	user: ['email'],
	products: ['codigo'],
	'physical-device': ['install_uuid'],
	'cfdi-document': ['uuid'],
	pedidos: ['offline_uuid'],
	patient: ['numero_expediente'],
	'payroll-concept': ['clave_interna'],
	sku: ['codigo'],
	'ticketing-system-consecutive': ['name'],
	'api-keys': ['api_key'],
	'auto-increment-control': ['_unique_string_reference'],
	contrato: ['contrato'],
	'font-awesome-icon-catalog': ['icon'],
	'user-settings': ['user_id'],
	'interface-restriction': ['html_element_hash'],
	'inventory-internal-location': ['codigo'],
	'violation-mobility-law': ['name'],
	violation: ['code'],
	'module-management-reference': ['reference'],
	'mcp-user-token': ['token_hash'],
	'epson-ticket-template': ['template_key'],
};

/** Unique solo entre activos (`partialFilterExpression: { is_active: { $ne: false } }`). */
const UNIQUE_FIELDS_ACTIVE: Record<string, string[]> = {
	'custom-field-control': ['module_id'],
};

/** Unique compuesto que el original imponía con índice multi-campo. */
const UNIQUE_COMPOSITES: Record<string, string[][]> = {
	cobranza: [['source_module', 'source_id']],
	'cfdi-catalog': [['catalog', 'code']],
	'custom-user-themes': [['user_id', 'theme_name']],
	'documentation-page': [['slug', 'folder_path']],
};

/** Unique compuesto solo entre activos. */
const UNIQUE_COMPOSITES_ACTIVE: Record<string, string[][]> = {
	'user-pin': [['document_model', 'document_id']],
};

function unique_fields_for(resource: string): string[] {
	return UNIQUE_FIELDS[resource] ?? UNIQUE_FIELDS[RESOURCE_ALIASES[resource] ?? ''] ?? [];
}

function unique_composites_for(resource: string): string[][] {
	return (
		UNIQUE_COMPOSITES[resource] ??
		UNIQUE_COMPOSITES[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

function unique_fields_active_for(resource: string): string[] {
	return (
		UNIQUE_FIELDS_ACTIVE[resource] ??
		UNIQUE_FIELDS_ACTIVE[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

function unique_composites_active_for(resource: string): string[][] {
	return (
		UNIQUE_COMPOSITES_ACTIVE[resource] ??
		UNIQUE_COMPOSITES_ACTIVE[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

function index_name(table_key: string, suffix: string): string {
	const raw = `uq_${table_key}_${suffix}`.replace(/[^a-z0-9_]/gi, '_').slice(0, 63);
	return raw.replace(/_+$/, '') || 'uq_idx';
}

/**
 * Unique de negocio en Postgres (Mongoose lo imponía; aquí no había INDEX).
 * Columna física si existe; si no, expresión sobre `payload`.
 */
export function unique_index_sqls(input: {
	quoted_table: string;
	table_key: string;
	fields: readonly string[];
	composites?: readonly string[][];
	columns: ReadonlySet<string>;
}): string[] {
	const out: string[] = [];
	for (const field of input.fields) {
		const idx = qident(index_name(input.table_key, field));
		if (input.columns.has(field)) {
			const col = qident(field);
			out.push(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${col}) WHERE ${col} IS NOT NULL AND btrim(${col}::text) <> ''`,
			);
		} else {
			const expr = `payload ->> '${field.replace(/'/g, "''")}'`;
			out.push(
				`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} ((${expr})) WHERE ${expr} IS NOT NULL AND btrim(${expr}) <> ''`,
			);
		}
	}
	for (const fields of input.composites ?? []) {
		if (!fields.length) continue;
		const idx = qident(index_name(input.table_key, fields.join('_')));
		const cols = fields.map((field) =>
			input.columns.has(field)
				? qident(field)
				: `(payload ->> '${field.replace(/'/g, "''")}')`,
		);
		out.push(
			`CREATE UNIQUE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${cols.join(', ')})`,
		);
	}
	return out;
}

/** Lookup no-único: el UNIQUE puede fallar si ya hay duplicados; el btree igual acelera el login. */
export function lookup_index_sqls(input: {
	quoted_table: string;
	table_key: string;
	fields: readonly string[];
	columns: ReadonlySet<string>;
}): string[] {
	const out: string[] = [];
	for (const field of input.fields) {
		if (!input.columns.has(field)) continue;
		const idx = qident(index_name(input.table_key, field).replace(/^uq_/, 'ix_'));
		const col = qident(field);
		out.push(`CREATE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${col})`);
	}
	return out;
}

const LOOKUP_PAYLOAD_FIELDS: Record<string, string[]> = {
	'document-change-history': ['documentId', 'modelName'],
};

function lookup_payload_fields_for(resource: string): string[] {
	return (
		LOOKUP_PAYLOAD_FIELDS[resource] ??
		LOOKUP_PAYLOAD_FIELDS[RESOURCE_ALIASES[resource] ?? ''] ??
		[]
	);
}

export function payload_lookup_index_sqls(input: {
	quoted_table: string;
	table_key: string;
	fields: readonly string[];
}): string[] {
	const out: string[] = [];
	for (const field of input.fields) {
		const idx = qident(index_name(input.table_key, field).replace(/^uq_/, 'ix_'));
		const expr = `(payload ->> '${field.replace(/'/g, "''")}')`;
		out.push(`CREATE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} (${expr})`);
	}
	return out;
}

/** Página de historial: WHERE documentId + ORDER BY created_at DESC LIMIT n. */
export function history_page_index_sqls(input: {
	quoted_table: string;
	table_key: string;
}): string[] {
	const idx = qident(index_name(input.table_key, 'doc_created').replace(/^uq_/, 'ix_'));
	return [
		`CREATE INDEX IF NOT EXISTS ${idx} ON ${input.quoted_table} ((payload ->> 'documentId'), created_at DESC)`,
	];
}

/**
 * Keyset temporal: `(created_at, id) > ($at, $id)`.
 * `created_at` es TEXT ISO; el predicado no casteá — coincide con
 * `ORDER BY created_at ASC, id ASC` (lex = cronológico en ISO-8601).
 */
export function created_at_keyset_sql(at_param: string, id_param: string): string {
	return `(created_at, id) > (${at_param}, ${id_param})`;
}

/**
 * Keyset FIFO de lotes: `(fecha_entrada, created_at, id) > (...)`.
 * TEXT ISO; el predicado no casteá. Empate = created_at, luego id.
 */
export function fecha_entrada_keyset_sql(
	fecha_param: string,
	created_param: string,
	id_param: string,
): string {
	return `(fecha_entrada, created_at, id) > (${fecha_param}, ${created_param}, ${id_param})`;
}

/** Un `MAX` numérico: dígitos enteros o cola numérica (`SES-12` → 12). */
export function max_numeric_expr(field_sql: string): string {
	return `MAX(CASE
		WHEN ${field_sql}::text ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${field_sql}::numeric
		WHEN ${field_sql}::text ~ '[0-9]+$' THEN (regexp_match(${field_sql}::text, '([0-9]+)$'))[1]::numeric
		ELSE NULL
	END)`;
}

/**
 * `GROUP BY` de un campo escalar (columna o `payload ->>`). Una fila por
 * valor distinto + COUNT. No hidrata docs. Refs/objetos no van por aquí:
 * `payload ->>` de `{_id, name}` no es el id de `serialize_field_value`.
 */
export function value_counts_sql(
	quoted_table: string,
	expr: string,
	include_inactive: boolean,
): string {
	const active = include_inactive ? '' : 'is_active IS DISTINCT FROM false AND ';
	return `SELECT ${expr} AS v, COUNT(*)::int AS n
		FROM ${quoted_table}
		WHERE ${active}${expr} IS NOT NULL
		  AND btrim(${expr}::text) <> ''
		  AND ${expr}::text NOT IN ('-', 'ERR!')
		GROUP BY 1`;
}

/**
 * Lote que convierte JSONB string-wrapped (`"{\"a\":1}"`) en objeto.
 * Así `payload ->>` y los btrees de expresión vuelven a ver las claves.
 */
export function unwrap_jsonb_string_sql(quoted_table: string, column: string): string {
	const col = qident(column);
	return `UPDATE ${quoted_table} AS t
		SET ${col} = (t.${col} #>> '{}')::jsonb
		FROM (
			SELECT id FROM ${quoted_table}
			WHERE jsonb_typeof(${col}) = 'string'
			  AND (${col} #>> '{}') ~ '^[[:space:]]*[\\{\\[]'
			LIMIT 1000
		) s
		WHERE t.id = s.id
		RETURNING t.id`;
}

export function string_jsonb_ids_sql(quoted_table: string, column: string): string {
	const col = qident(column);
	return `SELECT id FROM ${quoted_table}
		WHERE jsonb_typeof(${col}) = 'string'
		  AND (${col} #>> '{}') ~ '^[[:space:]]*[\\{\\[]'
		LIMIT 1000`;
}

export function unwrap_jsonb_string_one_sql(quoted_table: string, column: string): string {
	const col = qident(column);
	return `UPDATE ${quoted_table}
		SET ${col} = (${col} #>> '{}')::jsonb
		WHERE id = $1
		  AND jsonb_typeof(${col}) = 'string'
		RETURNING id`;
}

/**
 * Bun.SQL pone el SQLSTATE en `errno` y `ERR_POSTGRES_SERVER_ERROR` en `code`.
 * Usar solo `code` deja pasar 42P01 y tumba el boot de toda la API.
 */
export function is_missing_relation(err: unknown): boolean {
	if (err === null || err === undefined || typeof err !== 'object') {
		return /relation ".+" does not exist/i.test(String(err ?? ''));
	}
	const rec = err as { code?: string; errno?: string; message?: string };
	const code = String(rec.code ?? '');
	const errno = String(rec.errno ?? '');
	if (code === '42P01' || errno === '42P01' || code === '42703' || errno === '42703') {
		return true;
	}
	return /relation ".+" does not exist/i.test(String(rec.message ?? ''));
}

/**
 * Bun.SQL pone el SQLSTATE en `errno` (`23505`) y `ERR_POSTGRES_SERVER_ERROR` en `code`.
 * El unwrap de jsonb string-wrapped choca unique si ya existe la fila objeto.
 */
export function is_unique_violation(err: unknown): boolean {
	if (err === null || err === undefined || typeof err !== 'object') {
		return /duplicate key value violates unique constraint/i.test(String(err ?? ''));
	}
	const rec = err as { code?: string; errno?: string; message?: string };
	const code = String(rec.code ?? '');
	const errno = String(rec.errno ?? '');
	if (code === '23505' || errno === '23505') return true;
	return /duplicate key value violates unique constraint/i.test(String(rec.message ?? ''));
}

export function json_unwrap_error_action(
	err: unknown,
): 'skip-table' | 'lenient' | 'throw' {
	if (is_missing_relation(err)) return 'skip-table';
	if (is_unique_violation(err)) return 'lenient';
	return 'throw';
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
/** Original `on_populate_get_name_and_id: false`: el $lookup se queda como objeto. */
const LIST_KEEP_POPULATED_REFS = new Set([
	'employee',
	'vehicle',
	'pos-session',
	'custom-field-control',
]);

/** `__get_statistics` del scaffold con `charts.daily_stats` (línea 30 días). */
const DAILY_LINE_CHART = new Set([
	'cfdi-document',
	'cfdi-catalog',
	'cfdi-issuer-profile',
	'cfdi',
	'payments',
	'dynamic-dashboard',
	'payroll-concept',
	'payroll-period',
	'payroll-receipt',
	'labor-schedule',
	'labor-incident',
	'nomina',
]);

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

const LIST_SQL_ALWAYS_PHYSICAL = [
	'id',
	'name',
	'description',
	'is_active',
	'state',
	'ref',
	'search_field',
	'created_by',
	'custom_data',
	'created_at',
	'updated_at',
] as const;

const LIST_SQL_ALWAYS_PAYLOAD = [
	'parent_task',
	'parent_task_id',
	'is_global',
	'assigned_user_ids',
	'assigned_user_group_ids',
	'tags',
	'etiquetas',
] as const;

/** Claves que `finalize_rows` lee antes de `project_list_docs`. */
const LIST_SQL_DECORATE_PAYLOAD: Record<string, readonly string[]> = {
	'inventory-reception': ['articulos', 'purchase_order', 'orden_compra'],
	'inventory-physical-count': ['lineas'],
	'inventory-stock-quant': ['producto', 'ubicacion'],
	'custom-field-control': ['fields'],
};

function physical_list_name(key: string): string {
	if (key === '_id' || key === 'id') return 'id';
	if (key === '_ref' || key === 'ref') return 'ref';
	if (key === 'createdAt') return 'created_at';
	if (key === 'updatedAt') return 'updated_at';
	return key;
}

function payload_list_expr(): string {
	return `CASE
		WHEN jsonb_typeof(payload) = 'object' THEN payload
		WHEN jsonb_typeof(payload) = 'string' THEN COALESCE((payload #>> '{}')::jsonb, '{}'::jsonb)
		ELSE '{}'::jsonb
	END`;
}

/**
 * Extrae texto de payload objeto o string-wrapped. No es sargable
 * (CASE); usar solo en caminos que aún no desenvuelven el JSONB.
 */
export function payload_text_expr(field: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)) {
		throw new Error(`bad ident ${field}`);
	}
	const root = `(${payload_list_expr()})`;
	if (!field.includes('.')) return `${root} ->> ${literal(field)}`;
	return `${root} #>> '{${field.split('.').join(',')}}'`;
}

/**
 * Longitud de un arreglo en payload (objeto o string-wrapped).
 * CASE unwrap: solo proyección, no predicado sargable.
 */
export function json_array_length_sql(field: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new Error(`bad ident ${field}`);
	const arr = `(${payload_list_expr()}) -> ${literal(field)}`;
	return `CASE WHEN jsonb_typeof(${arr}) = 'array' THEN jsonb_array_length(${arr}) ELSE 0 END`;
}

/**
 * Stats de turnos: caja / servicio / duración. Sin `search_field`.
 * `created_at` entra por el SELECT de `scan_select_sql`.
 */
export const TURN_STATS_FIELDS = [
	'status',
	'state',
	'assigned_box',
	'services',
	'customer_type',
	'time_box',
	'time',
];

/**
 * Stats de quejas: KPIs / series. Sin `search_field` ni evidencia.
 * `created_at` entra por el SELECT de `scan_select_sql`.
 * `citizen_name` alimenta la etiqueta de reincidencia (la identidad sigue
 * siendo el teléfono). `name` / `assinged_to` van al Excel de registros.
 * Las refs se resuelven por página con populate lite.
 */
export const CITIZEN_REPORT_STATS_FIELDS = [
	'name',
	'status',
	'priority',
	'employee_taken_the_report',
	'assinged_to',
	'department',
	'reporting_medium',
	'citizen_report_problem',
	'borough',
	'report_coordinates',
	'latitude',
	'longitude',
	'citizen_phone',
	'citizen_name',
	'updated_at',
];

/** Cards del tablero de guías. Sin `steps` (el blob). */
export const INTERACTIVE_MANUAL_CARD_FIELDS = [
	'name',
	'description',
	'icon',
	'module_model_id',
	'is_default_for_module',
	'assigned_user_ids',
	'assigned_group_ids',
];

/** `order` de documentation-page (payload). Numérico, no texto. */
export function documentation_page_order_sql(): string {
	const expr = `(${payload_text_expr('order')})`;
	return `CASE WHEN ${expr} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${expr}::numeric ELSE 0 END`;
}

export function documentation_page_current_sql(params: unknown[], lookup: {
	slug: string;
	folder: string;
	section: string;
}): string {
	params.push(lookup.slug);
	const clauses = [
		'is_active IS DISTINCT FROM false',
		`${payload_text_expr('slug')} = $${params.length}`,
	];
	if (lookup.folder) {
		params.push(lookup.folder);
		clauses.push(`${payload_text_expr('folder_path')} = $${params.length}`);
	}
	if (lookup.section) {
		params.push(lookup.section);
		clauses.push(`${payload_text_expr('section')} = $${params.length}`);
	}
	return ` WHERE ${clauses.join(' AND ')}`;
}

export function documentation_page_neighbor_sql(
	dir: 'prev' | 'next',
	params: unknown[],
	cursor: { section: string; order: number; id: string },
): string {
	const section_expr = payload_text_expr('section');
	const order_expr = documentation_page_order_sql();
	params.push(cursor.section, cursor.order, cursor.id);
	const sec = `$${params.length - 2}`;
	const ord = `$${params.length - 1}`;
	const id = `$${params.length}`;
	const cmp = dir === 'prev'
		? `(${section_expr} < ${sec}
			OR (${section_expr} = ${sec} AND ${order_expr} < ${ord})
			OR (${section_expr} = ${sec} AND ${order_expr} = ${ord} AND id < ${id}))`
		: `(${section_expr} > ${sec}
			OR (${section_expr} = ${sec} AND ${order_expr} > ${ord})
			OR (${section_expr} = ${sec} AND ${order_expr} = ${ord} AND id > ${id}))`;
	const order = dir === 'prev'
		? `${section_expr} DESC, ${order_expr} DESC, id DESC`
		: `${section_expr} ASC, ${order_expr} ASC, id ASC`;
	return ` WHERE is_active IS DISTINCT FROM false AND ${cmp} ORDER BY ${order} LIMIT 1`;
}

/**
 * Extrae texto de payload objeto. Sargable (`payload ->>` / `#>>`).
 * Solo debug-log, que `ensure_object_json_cells` desenvuelve al boot.
 * No usar en `field_extract`: el CASE rompería el btree del historial.
 */
export function debug_payload_expr(field: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field)) {
		throw new Error(`bad ident ${field}`);
	}
	if (!field.includes('.')) return `payload ->> ${literal(field)}`;
	return `payload #>> '{${field.split('.').join(',')}}'`;
}

export type DebugLogFilter = {
	levels: string[];
	search: string;
	user: string;
	origin_file: string;
	request_results: string[];
	date_from: string;
	date_to: string;
};

const DEBUG_LOG_SORTS: Record<string, string> = {
	createdAt: 'created_at',
	created_at: 'created_at',
	level: 'level',
	message: 'message',
	'origin.file': 'origin.file',
	'request_context.response.status_code': 'request_context.response.status_code',
	'request_context.response.duration_ms': 'request_context.response.duration_ms',
};

function debug_log_sort_sql(field: string, dir: 'ASC' | 'DESC'): string {
	const key = DEBUG_LOG_SORTS[field] ?? 'created_at';
	if (key === 'created_at') return `created_at ${dir} NULLS LAST, id ${dir}`;
	if (key === 'request_context.response.status_code' || key === 'request_context.response.duration_ms') {
		const expr = debug_payload_expr(key);
		return `CASE WHEN ${expr} ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${expr}::numeric END ${dir} NULLS LAST, id ${dir}`;
	}
	return `${debug_payload_expr(key)} ${dir} NULLS LAST, id ${dir}`;
}

/**
 * Página de consola: escalares + mensaje recortado. Sin call_stack,
 * metadata ni user_agent. El detalle hace find_id.
 */
export function debug_log_list_select_sql(): string {
	const root = `(${payload_list_expr()})`;
	const ctx = `${root} -> 'request_context'`;
	const resp = `(${ctx}) -> 'response'`;
	const slim_response = `CASE
		WHEN jsonb_typeof(${resp}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
			'result', ${resp} -> 'result',
			'result_label', ${resp} -> 'result_label',
			'status_code', ${resp} -> 'status_code',
			'status_group', ${resp} -> 'status_group',
			'status_text', ${resp} -> 'status_text',
			'response_message', to_jsonb(left(${resp} ->> 'response_message', 240)),
			'duration_ms', ${resp} -> 'duration_ms'
		))
		ELSE NULL
	END`;
	const slim_ctx = `CASE
		WHEN jsonb_typeof(${ctx}) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
			'method', ${ctx} -> 'method',
			'label', ${ctx} -> 'label',
			'url', ${ctx} -> 'url',
			'route', ${ctx} -> 'route',
			'origin', ${ctx} -> 'origin',
			'ip', ${ctx} -> 'ip',
			'user', ${ctx} -> 'user',
			'response', ${slim_response}
		))
		ELSE NULL
	END`;
	return `"id", "name", "created_at", "is_active",
		jsonb_strip_nulls(jsonb_build_object(
			'level', ${root} -> 'level',
			'label', ${root} -> 'label',
			'request_label', ${root} -> 'request_label',
			'origin', ${root} -> 'origin',
			'process', ${root} -> 'process',
			'message', to_jsonb(left(${root} ->> 'message', 2000)),
			'formatted_message', to_jsonb(left(${root} ->> 'formatted_message', 2000)),
			'formatted_message_ansi', to_jsonb(left(${root} ->> 'formatted_message_ansi', 2000)),
			'request_context', ${slim_ctx}
		)) AS payload`;
}

function debug_log_status_sql(lo: number, hi: number): string {
	const expr = debug_payload_expr('request_context.response.status_code');
	return `(CASE WHEN ${expr} ~ '^[0-9]+$' THEN ${expr}::int END BETWEEN ${lo} AND ${hi})`;
}

export function debug_log_filter_sql(filter: DebugLogFilter, params: unknown[]): string {
	const clauses: string[] = [];
	if (filter.levels.length) {
		const marks = filter.levels.map((level) => {
			params.push(level);
			return `$${params.length}`;
		});
		clauses.push(`${debug_payload_expr('level')} IN (${marks.join(', ')})`);
	}
	if (filter.date_from) {
		params.push(filter.date_from);
		clauses.push(`created_at >= $${params.length}`);
	}
	if (filter.date_to) {
		params.push(filter.date_to);
		clauses.push(`created_at <= $${params.length}`);
	}
	if (filter.search) {
		params.push(`%${filter.search}%`);
		const n = `$${params.length}`;
		clauses.push(`(
			name ILIKE ${n}
			OR search_field ILIKE ${n}
			OR ${debug_payload_expr('message')} ILIKE ${n}
			OR (payload -> 'origin')::text ILIKE ${n}
		)`);
	}
	if (filter.user) {
		params.push(`%${filter.user}%`);
		const n = `$${params.length}`;
		clauses.push(`(
			created_by ILIKE ${n}
			OR ${debug_payload_expr('user')} ILIKE ${n}
			OR ${debug_payload_expr('request_context.user.name')} ILIKE ${n}
			OR ${debug_payload_expr('request_context.user.email')} ILIKE ${n}
		)`);
	}
	if (filter.origin_file) {
		params.push(`%${filter.origin_file}%`);
		const n = `$${params.length}`;
		clauses.push(`(
			${debug_payload_expr('origin.file')} ILIKE ${n}
			OR ${debug_payload_expr('origin_file')} ILIKE ${n}
		)`);
	}
	if (filter.request_results.length) {
		const result_expr = `lower(${debug_payload_expr('request_context.response.result')})`;
		const branches = filter.request_results.map((value) => {
			if (value === 'success') {
				return `(${debug_log_status_sql(200, 299)} OR ${result_expr} IN ('success', 'ok'))`;
			}
			if (value === 'warning') {
				return `(${debug_log_status_sql(300, 399)} OR ${result_expr} IN ('warning', 'notice', 'redirect', 'redirection'))`;
			}
			if (value === 'error') {
				return `(${debug_log_status_sql(400, 599)} OR ${result_expr} IN ('error', 'danger'))`;
			}
			params.push(value);
			return `${result_expr} = $${params.length}`;
		});
		clauses.push(`(${branches.join(' OR ')})`);
	}
	return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

export type DebugLogRelatedLookup = {
	routes: string[];
	method: string;
	status_code?: number;
	created_after?: string;
	created_before?: string;
};

/**
 * Lookup de un request log. Ruta/método/status/ventana en SQL.
 * El caller hidrata ≤ 10 filas; no el universo.
 */
export function debug_log_related_sql(lookup: DebugLogRelatedLookup, params: unknown[]): string {
	const clauses: string[] = [];
	params.push('error', 'request');
	clauses.push(`${debug_payload_expr('level')} IN ($${params.length - 1}, $${params.length})`);
	if (lookup.created_after) {
		params.push(lookup.created_after);
		clauses.push(`created_at >= $${params.length}`);
	}
	if (lookup.created_before) {
		params.push(lookup.created_before);
		clauses.push(`created_at <= $${params.length}`);
	}
	const routes = lookup.routes.filter((route) => route.length > 0).slice(0, 8);
	if (routes.length) {
		const marks = routes.map((route) => {
			params.push(route);
			return `$${params.length}`;
		});
		clauses.push(`${debug_payload_expr('request_context.route')} IN (${marks.join(', ')})`);
	}
	if (lookup.method) {
		params.push(lookup.method);
		clauses.push(`upper(${debug_payload_expr('request_context.method')}) = $${params.length}`);
	}
	if (lookup.status_code != null) {
		params.push(String(lookup.status_code));
		clauses.push(`${debug_payload_expr('request_context.response.status_code')} = $${params.length}`);
	}
	return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * SELECT de lista UI: columnas físicas de la proyección + payload recortado.
 * Sin spec (recurso desconocido) → null, el caller usa `*`.
 */
export function list_select_sql(resource: string, cols: Set<string>): string | null {
	const keys = list_projection_keys(resource);
	if (!keys.length) return null;
	const wanted = new Set<string>(keys);
	for (const key of LIST_SQL_ALWAYS_PAYLOAD) wanted.add(key);
	const canonical = RESOURCE_ALIASES[resource] ?? resource;
	for (const key of LIST_SQL_DECORATE_PAYLOAD[resource] ?? LIST_SQL_DECORATE_PAYLOAD[canonical] ?? []) {
		wanted.add(key);
	}
	for (const field of Object.keys(field_map_for(resource) ?? {})) {
		wanted.add(field);
		wanted.add(`${field}_id`);
	}
	const physical: string[] = [];
	const seen = new Set<string>();
	for (const col of LIST_SQL_ALWAYS_PHYSICAL) {
		if (!cols.has(col)) continue;
		physical.push(qident(col));
		seen.add(col);
	}
	const payload_keys: string[] = [];
	const seen_payload = new Set<string>();
	const consider = (key: string) => {
		const physical_name = physical_list_name(key);
		if (physical_name === 'payload' || physical_name === 'custom_data') return;
		if (cols.has(physical_name)) {
			if (seen.has(physical_name)) return;
			physical.push(qident(physical_name));
			seen.add(physical_name);
			return;
		}
		if (seen_payload.has(physical_name)) return;
		seen_payload.add(physical_name);
		payload_keys.push(physical_name);
	};
	for (const key of wanted) consider(key);
	if (cols.has('payload')) {
		const literals = payload_keys
			.filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			.map((key) => `'${key}'`)
			.join(', ');
		physical.push(
			literals
				? `(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
					FROM jsonb_each(${payload_list_expr()}) e
					WHERE e.key IN (${literals})) AS payload`
				: `'{}'::jsonb AS payload`,
		);
	}
	return physical.length ? physical.join(', ') : null;
}

const POPULATE_LITE_PHYSICAL = ['id', 'name', 'description', 'is_active', 'ref'] as const;

/**
 * SELECT de refs para lista: id + name. flatten_list_docs tira el resto.
 */
export function populate_lite_select_sql(cols: Set<string>): string {
	const physical = POPULATE_LITE_PHYSICAL.filter((col) => cols.has(col)).map(qident);
	if (cols.has('payload')) {
		physical.push(`(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
			FROM jsonb_each(${payload_list_expr()}) e
			WHERE e.key IN ('name')) AS payload`);
	}
	return physical.length ? physical.join(', ') : '*';
}

/**
 * SELECT de un barrido que solo necesita unas claves: id + keyset + payload recortado.
 */
export function scan_select_sql(cols: Set<string>, keys: string[]): string {
	const physical: string[] = [];
	const seen = new Set<string>();
	for (const col of ['id', 'created_at', 'fecha_entrada', 'is_active'] as const) {
		if (!cols.has(col)) continue;
		physical.push(qident(col));
		seen.add(col);
	}
	const payload_keys: string[] = [];
	const seen_payload = new Set<string>();
	for (const key of keys) {
		const root = key.split('.')[0] ?? key;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) continue;
		const physical_name = physical_list_name(root);
		if (cols.has(physical_name)) {
			if (seen.has(physical_name)) continue;
			physical.push(qident(physical_name));
			seen.add(physical_name);
			continue;
		}
		if (seen_payload.has(physical_name)) continue;
		seen_payload.add(physical_name);
		payload_keys.push(physical_name);
	}
	if (cols.has('payload')) {
		const literals = payload_keys.map((key) => `'${key}'`).join(', ');
		physical.push(
			literals
				? `(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
					FROM jsonb_each(${payload_list_expr()}) e
					WHERE e.key IN (${literals})) AS payload`
				: `'{}'::jsonb AS payload`,
		);
	}
	return physical.length ? physical.join(', ') : '*';
}

/**
 * SELECT de un barrido que debe devolver el set salvo unas claves
 * pesadas (lotes, markdown, …). Columnas físicas + payload sin esas keys.
 */
export function scan_omit_sql(cols: Set<string>, omit: string[]): string {
	const banned = new Set<string>();
	for (const key of omit) {
		const root = key.split('.')[0] ?? key;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) continue;
		banned.add(physical_list_name(root));
	}
	const physical: string[] = [];
	for (const col of cols) {
		if (col === 'payload') continue;
		if (banned.has(col)) continue;
		physical.push(qident(col));
	}
	if (cols.has('payload')) {
		const literals = [...banned].map((key) => `'${key}'`).join(', ');
		physical.push(
			literals
				? `(SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
					FROM jsonb_each(${payload_list_expr()}) e
					WHERE e.key NOT IN (${literals})) AS payload`
				: 'payload',
		);
	}
	return physical.length ? physical.join(', ') : '*';
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
				image?: string;
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
				technical_id: s.technical_id ?? `subject-${s.slug}`,
				image: s.image ?? '',
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
				'time-sheets',
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
			const time_sheets = this.locs.get('time-sheets');
			if (time_sheets) time_sheets.collection = '__time_sheets';
			const tokens = this.locs.get('mcp-user-token');
			if (tokens) tokens.collection = 'mcp_user_tokens';
			for (const [alias, resource] of Object.entries(RESOURCE_ALIASES)) {
				const loc = this.locs.get(resource);
				if (loc && !this.locs.has(alias)) this.locs.set(alias, loc);
			}
		}
	}

	async ensure_search_indexes(): Promise<void> {
		try {
			await this.sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
		} catch {
			return;
		}
		for (const loc of this.locs.values()) {
			const idx = `trgm_${loc.table}_search`.slice(0, 63);
			try {
				await this.sql.unsafe(
					`CREATE INDEX IF NOT EXISTS ${qident(idx)} ON ${this.qt(loc.resource)} USING gin (${qident('search_field')} gin_trgm_ops)`,
				);
			} catch {
				/* table may not exist yet for some locs */
			}
		}
	}

	async ensure_unique_indexes(): Promise<void> {
		const seen = new Set<string>();
		for (const loc of this.locs.values()) {
			if (seen.has(loc.resource)) continue;
			seen.add(loc.resource);
			const sqls = [
				...unique_index_sqls({
					quoted_table: this.qt(loc.resource),
					table_key: loc.table,
					fields: unique_fields_for(loc.resource),
					composites: unique_composites_for(loc.resource),
					columns: this.column_names(loc.resource),
				}),
				...lookup_index_sqls({
					quoted_table: this.qt(loc.resource),
					table_key: loc.table,
					fields: unique_fields_for(loc.resource),
					columns: this.column_names(loc.resource),
				}),
				...payload_lookup_index_sqls({
					quoted_table: this.qt(loc.resource),
					table_key: loc.table,
					fields: lookup_payload_fields_for(loc.resource),
				}),
				...(loc.resource === 'document-change-history'
					? history_page_index_sqls({
							quoted_table: this.qt(loc.resource),
							table_key: loc.table,
						})
					: []),
			];
			for (const sql of sqls) {
				try {
					await this.sql.unsafe(sql);
				} catch {
					/* tabla o columna aún no existen */
				}
			}
		}
	}

	async ensure_object_json_cells(): Promise<void> {
		const seen = new Set<string>();
		for (const loc of this.locs.values()) {
			if (seen.has(loc.resource)) continue;
			seen.add(loc.resource);
			const cols = this.column_names(loc.resource);
			for (const col of this.json_cols(loc.resource)) {
				if (!cols.has(col)) continue;
				try {
					for (;;) {
						const rows = await this.sql.unsafe(
							unwrap_jsonb_string_sql(this.qt(loc.resource), col),
						);
						if (!rows.length) break;
					}
				} catch (err) {
					const action = json_unwrap_error_action(err);
					if (action === 'skip-table') continue;
					if (action === 'lenient') {
						await this.unwrap_json_cells_lenient(loc.resource, col);
						continue;
					}
					throw err;
				}
			}
		}
	}

	async unwrap_json_cells_lenient(resource: string, col: string): Promise<void> {
		const qt = this.qt(resource);
		for (;;) {
			let ids: Array<{ id: string }>;
			try {
				ids = (await this.sql.unsafe(string_jsonb_ids_sql(qt, col))) as Array<{
					id: string;
				}>;
			} catch (err) {
				if (json_unwrap_error_action(err) === 'skip-table') return;
				throw err;
			}
			if (!ids.length) break;
			for (const row of ids) {
				try {
					await this.sql.unsafe(unwrap_jsonb_string_one_sql(qt, col), [row.id]);
				} catch (err) {
					const action = json_unwrap_error_action(err);
					if (action === 'skip-table') return;
					if (action === 'lenient') {
						await this.sql.unsafe(`DELETE FROM ${qt} WHERE id = $1`, [row.id]);
						continue;
					}
					throw err;
				}
			}
		}
	}

	async ensure_defaults(): Promise<void> {
		await this.ensure_orphan_tables();
		await this.ensure_object_json_cells();
		await this.ensure_search_indexes();
		await this.ensure_unique_indexes();
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
			for await (const rows of this.scan(loc.resource, {
				include_inactive: false,
				page_size: 200,
			})) {
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
					{
						icon: entry.icon,
						slug: entry.slug,
						prefix: entry.prefix,
						style: entry.style,
						search_terms: entry.search_terms ?? [],
					},
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
			await SearchEngine.clear_index('__font_awesome_icon_catalog');
			for await (const page of this.scan('font-awesome-icon-catalog', {
				include_inactive: true,
				page_size: 200,
			})) {
				const docs = page
					.map((doc) => ({
						id: String(doc._id),
						search_text: search_text_from_doc(doc),
					}))
					.filter((doc) => doc.search_text);
				if (docs.length) {
					await SearchEngine.index_documents('__font_awesome_icon_catalog', docs);
				}
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
			'time-sheets',
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
			if (loc.resource.startsWith('__')) continue;
			const model_name =
				resource_to_model.get(loc.resource) ??
				(loc.resource === 'branchoffice'
					? 'Branchoffice'
					: loc.resource
							.split('-')
							.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
							.join(''));
			if (!model_name || model_name.startsWith('__') || seen.has(model_name)) continue;
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
		if (!reset_key && resource && this.has(resource)) {
			floor = await this.max_numeric(resource, increment_field);
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

	/** `MAX` de un campo numérico (columna o `payload ->>`). Una fila, no N docs. */
	async max_numeric(resource: string, field: string): Promise<number> {
		if (!this.has(resource) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) return 0;
		const cols = this.column_names(resource);
		const expr = cols.has(field) ? qident(field) : `payload ->> ${literal(field)}`;
		const rows = await this.sql.unsafe(
			`SELECT ${max_numeric_expr(expr)} AS m FROM ${this.qt(resource)}`,
		);
		return Number(rows[0]?.m ?? 0) || 0;
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
				if (!(col.name in parsed)) continue;
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
			/** Login/menús: no hace falta paginar; evita un COUNT(*) extra. */
			skip_total?: boolean;
			/** Lista UI: columnas de LIST_PROJECTIONS + payload recortado. */
			list_project?: boolean;
			/** Lookup de populate de lista: id + name, sin COUNT(*). */
			populate_lite?: boolean;
			/** Keyset `(created_at, id)` para scan ordenado por tiempo. */
			after_created?: { at: string; id: string };
			/** Keyset FIFO `(fecha_entrada, created_at, id)`. */
			after_entrada?: { fecha: string; created: string; id: string };
			/** Barrido: solo estas claves + id/keyset, no SELECT *. */
			scan_fields?: string[];
			/** Barrido: todas las claves salvo estas. */
			scan_omit?: string[];
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
					const range = v as { gte?: unknown; lte?: unknown; gt?: unknown; lt?: unknown };
					if (range.gte !== undefined && range.gte !== '') {
						params.push(range_bound(String(range.gte), 'gte'));
						clauses.push(range_compare_sql(cols, k, '>=', params.length));
					}
					if (range.lte !== undefined && range.lte !== '') {
						params.push(range_bound(String(range.lte), 'lte'));
						clauses.push(range_compare_sql(cols, k, '<=', params.length));
					}
					if (range.gt !== undefined && range.gt !== '') {
						params.push(range_bound(String(range.gt), 'gte'));
						clauses.push(range_compare_sql(cols, k, '>', params.length));
					}
					if (range.lt !== undefined && range.lt !== '') {
						params.push(range_bound(String(range.lt), 'lte'));
						clauses.push(range_compare_sql(cols, k, '<', params.length));
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
			const search_cols = ['name', 'description', 'ref', 'search_field', 'code'].filter((c) =>
				cols.has(c),
			);
			const parts = search_cols.map((c) => {
				params.push(like);
				return `${qident(c)} ILIKE $${params.length}`;
			});
			if (parts.length) clauses.push(`(${parts.join(' OR ')})`);
		}
		if (opts.after_created?.at && opts.after_created.id && cols.has('created_at')) {
			params.push(opts.after_created.at, opts.after_created.id);
			clauses.push(
				created_at_keyset_sql(`$${params.length - 1}`, `$${params.length}`),
			);
		}
		if (
			opts.after_entrada?.fecha &&
			opts.after_entrada.created &&
			opts.after_entrada.id &&
			cols.has('fecha_entrada') &&
			cols.has('created_at')
		) {
			params.push(opts.after_entrada.fecha, opts.after_entrada.created, opts.after_entrada.id);
			clauses.push(
				fecha_entrada_keyset_sql(
					`$${params.length - 2}`,
					`$${params.length - 1}`,
					`$${params.length}`,
				),
			);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
		let total = 0;
		if (!opts.skip_total) {
			const count_rows = await this.sql.unsafe(
				`SELECT count(*)::int AS n FROM ${qt}${where}`,
				params,
			);
			total = Number(count_rows[0]?.n ?? 0);
		}
		let order = ' ORDER BY name ASC NULLS LAST, id ASC';
		if (
			opts.after_entrada?.fecha &&
			cols.has('fecha_entrada') &&
			cols.has('created_at')
		) {
			order = ' ORDER BY fecha_entrada ASC NULLS LAST, created_at ASC, id ASC';
		} else if (opts.after_created?.at && cols.has('created_at')) {
			order = ' ORDER BY created_at ASC NULLS LAST, id ASC';
		} else if (opts.sort) {
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
				if (col === 'fecha_entrada' && cols.has('created_at')) {
					order += `, created_at ${dir}, id ${dir}`;
				} else if (col === 'created_at') {
					order += `, id ${dir}`;
				}
			}
		}
		const take = opts.take ?? 100;
		const skip = opts.skip ?? 0;
		const select = opts.list_project
			? list_select_sql(resource, cols) ?? '*'
			: opts.populate_lite
				? populate_lite_select_sql(cols)
				: opts.scan_fields?.length
					? scan_select_sql(cols, opts.scan_fields)
					: opts.scan_omit?.length
						? scan_omit_sql(cols, opts.scan_omit)
						: '*';
		const rows = await this.sql.unsafe(
			`SELECT ${select} FROM ${qt}${where}${order} LIMIT ${take} OFFSET ${skip}`,
			params,
		);
		const flattened = rows.map((r) => this.flatten(r as Record<string, unknown>, resource)!);
		const populated =
			opts.populate === false
				? flattened
				: await this.populate_docs(resource, flattened, {
						lite: Boolean(opts.list_project) && !LIST_KEEP_POPULATED_REFS.has(resource),
					});
		if (opts.skip_total) total = populated.length;
		return {
			rows: populated,
			total,
		};
	}

	/**
	 * Barrido interno por keyset (`id > last`, o `(created_at, id)`
	 * si `order: 'created_at'`). Una página en vuelo; no hidrata la
	 * tabla ni hace COUNT(*).
	 */
	async *scan(
		resource: string,
		opts: {
			where?: Record<string, unknown>;
			mongo_match?: Record<string, unknown> | null;
			include_inactive?: boolean;
			page_size?: number;
			q?: string;
			/** FIFO / stats: una página en orden temporal, no O(N) en RAM. */
			order?: 'id' | 'created_at' | 'fecha_entrada';
			/** Solo estas claves + id/keyset. */
			fields?: string[];
			/** Todas las claves salvo estas (set completo, blobs fuera). */
			omit?: string[];
			/** Catálogo de refs: id + name. */
			populate_lite?: boolean;
		} = {},
	): AsyncGenerator<ImperiumDoc[], void, void> {
		const page_size = Math.min(Math.max(opts.page_size ?? 500, 1), 1000);
		const by_lot = opts.order === 'fecha_entrada';
		const by_time = opts.order === 'created_at';
		let after_id = '';
		let after_at = '';
		let after_fecha = '';
		for (;;) {
			const where: Record<string, unknown> = { ...(opts.where ?? {}) };
			if (!by_time && !by_lot && after_id) where.id = { gt: after_id };
			const { rows } = await this.find_many(resource, {
				take: page_size,
				sort: by_lot ? 'fecha_entrada:asc' : by_time ? 'created_at:asc' : 'id:asc',
				populate: false,
				skip_total: true,
				include_inactive: opts.include_inactive,
				where: Object.keys(where).length ? where : undefined,
				mongo_match: opts.mongo_match,
				q: opts.q,
				after_created: by_time && after_at ? { at: after_at, id: after_id } : undefined,
				after_entrada:
					by_lot && after_fecha && after_at
						? { fecha: after_fecha, created: after_at, id: after_id }
						: undefined,
				scan_fields: opts.fields,
				scan_omit: opts.omit,
				populate_lite: opts.populate_lite,
			});
			if (!rows.length) return;
			yield rows;
			const last = rows[rows.length - 1];
			after_id = String(last?._id ?? '');
			if (by_time || by_lot) {
				const raw = last?.createdAt ?? last?.created_at;
				after_at =
					raw instanceof Date ? raw.toISOString() : String(raw ?? '').trim();
				if (!after_at) return;
			}
			if (by_lot) {
				const raw = last?.fecha_entrada ?? last?.fechaEntrada;
				after_fecha =
					raw instanceof Date ? raw.toISOString() : String(raw ?? '').trim();
				if (!after_fecha) return;
			}
			if (!after_id || rows.length < page_size) return;
		}
	}

	/**
	 * Conteos por día (`LEFT(created_at, 10)`). `created_at` es TEXT ISO.
	 * Una fila agregada por día, 0 docs hidratados.
	 */
	async count_by_created_day(
		resource: string,
		opts: {
			from_iso: string;
			to_iso?: string;
			mongo_match?: Record<string, unknown> | null;
			include_inactive?: boolean;
		},
	): Promise<Map<string, number>> {
		if (!this.has(resource)) return new Map();
		const cols = this.column_names(resource);
		if (!cols.has('created_at')) return new Map();
		const qt = this.qt(resource);
		const params: unknown[] = [opts.from_iso];
		const clauses = ['created_at >= $1'];
		if (opts.to_iso) {
			params.push(opts.to_iso);
			clauses.push(`created_at <= $${params.length}`);
		}
		if (!opts.include_inactive) clauses.push('is_active IS DISTINCT FROM false');
		if (opts.mongo_match) {
			const extra = mongo_match_to_sql(opts.mongo_match, cols, params);
			if (extra) clauses.push(extra);
		}
		const rows = await this.sql.unsafe(
			`SELECT LEFT(created_at, 10) AS day, COUNT(*)::int AS n
			FROM ${qt}
			WHERE ${clauses.join(' AND ')}
			GROUP BY 1`,
			params,
		);
		const out = new Map<string, number>();
		for (const row of rows) {
			const day = String((row as { day?: unknown }).day ?? '').slice(0, 10);
			const n = Number((row as { n?: unknown }).n ?? 0);
			if (!day || !Number.isFinite(n) || n <= 0) continue;
			out.set(day, n);
		}
		return out;
	}

	/** COUNT(*) del predicado, sin hidratar filas. */
	async count(
		resource: string,
		opts: {
			where?: Record<string, unknown>;
			mongo_match?: Record<string, unknown> | null;
			include_inactive?: boolean;
			q?: string;
		} = {},
	): Promise<number> {
		const { total } = await this.find_many(resource, {
			where: opts.where,
			mongo_match: opts.mongo_match,
			include_inactive: opts.include_inactive,
			q: opts.q,
			take: 1,
			populate: false,
		});
		return total;
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
			sort: 'id:asc',
			include_inactive: true,
			populate: false,
			skip_total: true,
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
		for (const field of unique_fields_active_for(resource)) {
			const raw = doc[field];
			if (raw === undefined || raw === null) continue;
			const value = String(raw).trim();
			if (!value) continue;
			const { rows } = await this.find_many(resource, {
				where: { [field]: value },
				take: 1,
				include_inactive: false,
				populate: false,
			});
			const found = rows[0];
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
		for (const fields of unique_composites_active_for(resource)) {
			const where: Record<string, unknown> = {};
			let skip = false;
			for (const field of fields) {
				const raw = doc[field];
				if (raw === undefined || raw === null) {
					skip = true;
					break;
				}
				const value = typeof raw === 'string' ? raw.trim() : raw;
				if (value === '') {
					skip = true;
					break;
				}
				where[field] = value;
			}
			if (skip) continue;
			const { rows } = await this.find_many(resource, {
				where,
				take: 1,
				include_inactive: false,
				populate: false,
			});
			const found = rows[0];
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const field = fields[0] ?? 'campo';
			const value = String(where[field] ?? '').trim();
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
		for (const fields of unique_composites_for(resource)) {
			const where: Record<string, unknown> = {};
			let skip = false;
			for (const field of fields) {
				const raw = doc[field];
				if (raw === undefined || raw === null) {
					skip = true;
					break;
				}
				const value = typeof raw === 'string' ? raw.trim() : raw;
				if (value === '') {
					skip = true;
					break;
				}
				where[field] = value;
			}
			if (skip) continue;
			const found = await this.find_where(resource, where);
			if (!found?._id || String(found._id) === String(except_id ?? '')) continue;
			const field = fields[0] ?? 'campo';
			const value = String(where[field] ?? '').trim();
			const label = field === '_ref' ? 'la referencia' : `el campo ${field}`;
			throw new Error(`Ya existe un registro con ${label} "${value}".`);
		}
	}

	async insert(resource: string, doc: ImperiumDoc): Promise<ImperiumDoc> {
		apply_schema_setters(resource, doc);
		apply_inventory_movement_ledger(resource, doc);
		ensure_sql_name(resource, doc);
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
		apply_schema_setters(resource, merged, { apply_defaults: false });
		assert_required_fields(resource, merged, Object.keys(patch));
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

	/** Como `updateMany({ _id: { $in } }, { is_active: false })` del original. */
	async set_inactive_ids(resource: string, ids: string[]): Promise<number> {
		const wanted = [...new Set(ids.map(String).filter(Boolean))];
		if (!wanted.length || !this.has(resource)) return 0;
		const now = new Date().toISOString();
		const marks = wanted.map((_, i) => `$${i + 2}`).join(', ');
		await this.sql.unsafe(
			`UPDATE ${this.qt(resource)} SET is_active = false, updated_at = $1 WHERE id IN (${marks}) AND is_active IS DISTINCT FROM false`,
			[now, ...wanted],
		);
		return wanted.length;
	}

	/** Como `updateMany({}, { $set: { field } })` del original. */
	async set_payload_field_all(resource: string, field: string, value: unknown): Promise<number> {
		if (!this.has(resource)) return 0;
		if (!/^[a-z_][a-z0-9_]*$/i.test(field)) throw new Error(`bad ident ${field}`);
		const now = new Date().toISOString();
		const rows = await this.sql.unsafe(
			`UPDATE ${this.qt(resource)}
			 SET payload = (
			   CASE
			     WHEN jsonb_typeof(payload) = 'string' THEN COALESCE((payload #>> '{}')::jsonb, '{}'::jsonb)
			     WHEN jsonb_typeof(payload) = 'object' THEN COALESCE(payload, '{}'::jsonb)
			     ELSE '{}'::jsonb
			   END
			 ) || jsonb_build_object($2::text, to_jsonb($3::text)),
			 updated_at = $1
			 RETURNING id`,
			[now, field, String(value ?? '')],
		);
		return rows.length;
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

	async populate_docs(
		resource: string,
		docs: ImperiumDoc[],
		opts?: { full?: boolean; lite?: boolean },
	): Promise<ImperiumDoc[]> {
		const field_map = field_map_for(resource);
		if (!field_map || !docs.length) return docs;
		const full = Boolean(opts?.full);
		const lite = Boolean(opts?.lite) && !full;
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
				skip_total: true,
				populate_lite: lite,
			});
			loaded.set(
				target,
				new Map(rows.map((r) => [String(r._id), full ? strip_populated_secrets(target, r) : r])),
			);
		}
		return docs.map((doc) => {
			const out = { ...doc };
			for (const [field, model] of Object.entries(field_map)) {
				const target = this.resource_for_model(model);
				const lookup = target ? loaded.get(target) : undefined;
				apply_populated_path(out, field.split('.'), lookup, full);
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
		if (LIST_KEEP_POPULATED_REFS.has(resource)) return docs;
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
		const expr = cols.has(field) ? qident(field) : payload_distinct_expr(field);
		const params: unknown[] = [];
		let extra = '';
		if (q) {
			params.push(`%${q}%`);
			extra = ` WHERE ${expr}::text ILIKE $1`;
		}
		const rows = await this.sql.unsafe(
			`SELECT DISTINCT ${expr} AS v FROM ${qt}${extra} LIMIT 200`,
			params,
		);
		return rows.map((r) => (r as { v: unknown }).v).filter((v) => v != null && v !== '');
	}

	/**
	 * Conteos por valor distinto. Una fila agregada por valor, no N docs.
	 * Solo escalares; el caller no lo usa en refs/arrays/paths con punto.
	 */
	async value_counts(
		resource: string,
		field: string,
		opts: { include_inactive?: boolean } = {},
	): Promise<Array<{ value: string; count: number }>> {
		if (!this.has(resource)) return [];
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(field)) return [];
		const cols = this.column_names(resource);
		const expr = cols.has(field) ? qident(field) : payload_distinct_expr(field);
		const rows = await this.sql.unsafe(
			value_counts_sql(this.qt(resource), expr, opts.include_inactive === true),
		);
		const out: Array<{ value: string; count: number }> = [];
		for (const row of rows) {
			const rec = row as { v: unknown; n: unknown };
			const value = String(rec.v ?? '').trim();
			const count = Number(rec.n ?? 0);
			if (!value || !Number.isFinite(count) || count <= 0) continue;
			out.push({ value, count });
		}
		return out;
	}

	/**
	 * Página de debug-log. Filtros sargables (`payload ->>`).
	 * No hidrata la tabla. Contrato: `data` + `total_elementos`.
	 */
	async debug_log_page(
		filter: DebugLogFilter,
		opts: { skip: number; take: number; sort: string; dir: 'asc' | 'desc' },
	): Promise<{ rows: ImperiumDoc[]; total: number }> {
		if (!this.has('debug-log')) return { rows: [], total: 0 };
		const qt = this.qt('debug-log');
		const params: unknown[] = [];
		const where = debug_log_filter_sql(filter, params);
		const count_rows = await this.sql.unsafe(
			`SELECT count(*)::int AS n FROM ${qt}${where}`,
			params,
		);
		const total = Number(count_rows[0]?.n ?? 0);
		const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
		const order = debug_log_sort_sql(opts.sort, dir);
		const take = Math.min(Math.max(opts.take, 1), 200);
		const skip = Math.max(opts.skip, 0);
		const rows = await this.sql.unsafe(
			`SELECT ${debug_log_list_select_sql()} FROM ${qt}${where} ORDER BY ${order} LIMIT ${take} OFFSET ${skip}`,
			params,
		);
		return {
			rows: rows.map((row) => this.flatten(row as Record<string, unknown>, 'debug-log')!),
			total,
		};
	}

	/** Agregados de debug-log. Una pasada SQL, 0 docs hidratados. */
	async debug_log_stats(filter: DebugLogFilter): Promise<{
		total: number;
		by_level: Array<{ level: string; count: number; percentage: number }>;
		by_origin: Array<{ file: string; display: string; count: number; percentage: number }>;
		timeline: Array<{ level: string; hour: string; count: number }>;
	}> {
		const empty = { total: 0, by_level: [], by_origin: [], timeline: [] };
		if (!this.has('debug-log')) return empty;
		const qt = this.qt('debug-log');
		const params: unknown[] = [];
		const where = debug_log_filter_sql(filter, params);
		const level_expr = debug_payload_expr('level');
		const file_expr = debug_payload_expr('origin.file');
		const display_expr = debug_payload_expr('origin.display');
		const hour_expr = `to_char((created_at::timestamptz AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM-DD HH24":00"')`;
		const [totals, origins, hours] = await Promise.all([
			this.sql.unsafe(
				`SELECT ${level_expr} AS level, count(*)::int AS n FROM ${qt}${where} GROUP BY 1`,
				params,
			),
			this.sql.unsafe(
				`SELECT COALESCE(${file_expr}, 'unknown') AS file,
					COALESCE(NULLIF(${display_expr}, ''), ${file_expr}, 'unknown') AS display,
					count(*)::int AS n
				FROM ${qt}${where}
				GROUP BY 1, 2
				ORDER BY n DESC
				LIMIT 50`,
				params,
			),
			this.sql.unsafe(
				`SELECT COALESCE(${level_expr}, 'log') AS level, ${hour_expr} AS hour, count(*)::int AS n
				FROM ${qt}${where}
				GROUP BY 1, 2
				ORDER BY 2`,
				params,
			),
		]);
		const by_level_raw = totals.map((row) => {
			const rec = row as { level?: string; n?: number };
			return { level: String(rec.level ?? 'log'), count: Number(rec.n ?? 0) };
		});
		const total = by_level_raw.reduce((sum, row) => sum + row.count, 0);
		const pct = (count: number) =>
			total ? parseFloat(((count / total) * 100).toFixed(2)) : 0;
		return {
			total,
			by_level: by_level_raw
				.map((row) => ({ ...row, percentage: pct(row.count) }))
				.sort((a, b) => b.count - a.count),
			by_origin: origins.map((row) => {
				const rec = row as { file?: string; display?: string; n?: number };
				const count = Number(rec.n ?? 0);
				return {
					file: String(rec.file ?? 'unknown'),
					display: String(rec.display ?? rec.file ?? 'unknown'),
					count,
					percentage: pct(count),
				};
			}),
			timeline: hours.map((row) => {
				const rec = row as { level?: string; hour?: string; n?: number };
				return {
					level: String(rec.level ?? 'log'),
					hour: String(rec.hour ?? ''),
					count: Number(rec.n ?? 0),
				};
			}),
		};
	}

	/**
	 * Hasta 10 request logs que matchean ruta+método. No hidrata la tabla.
	 * El caller elige error-preferente entre esas 10.
	 */
	async debug_log_related(lookup: DebugLogRelatedLookup): Promise<ImperiumDoc[]> {
		if (!this.has('debug-log')) return [];
		if (!lookup.routes.length || !lookup.method) return [];
		const params: unknown[] = [];
		const where = debug_log_related_sql(lookup, params);
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${this.qt('debug-log')}${where}
			ORDER BY created_at DESC NULLS LAST, id DESC
			LIMIT 10`,
			params,
		);
		return rows.map((row) => this.flatten(row as Record<string, unknown>, 'debug-log')!);
	}

	/**
	 * Página actual + vecinos de documentation-page. 3 lecturas LIMIT,
	 * no el catálogo. payload_text_expr: la tabla huérfana aún puede
	 * venir string-wrapped.
	 */
	async documentation_adjacent(lookup: {
		slug: string;
		folder?: string;
		section?: string;
	}): Promise<{ current: ImperiumDoc | null; previous: ImperiumDoc | null; next: ImperiumDoc | null }> {
		const empty = { current: null, previous: null, next: null };
		if (!this.has('documentation-page') || !lookup.slug) return empty;
		const qt = this.qt('documentation-page');
		const current_params: unknown[] = [];
		const current_where = documentation_page_current_sql(current_params, {
			slug: lookup.slug,
			folder: lookup.folder ?? '',
			section: lookup.section ?? '',
		});
		const current_rows = await this.sql.unsafe(
			`SELECT * FROM ${qt}${current_where} ORDER BY id ASC LIMIT 5`,
			current_params,
		);
		const current = this.flatten(
			(current_rows[0] as Record<string, unknown>) ?? null,
			'documentation-page',
		);
		if (!current) return empty;
		const cursor = {
			section: String(current.section ?? ''),
			order: Number(current.order ?? 0) || 0,
			id: String(current._id ?? ''),
		};
		const prev_params: unknown[] = [];
		const next_params: unknown[] = [];
		const [prev_rows, next_rows] = await Promise.all([
			this.sql.unsafe(
				`SELECT * FROM ${qt}${documentation_page_neighbor_sql('prev', prev_params, cursor)}`,
				prev_params,
			),
			this.sql.unsafe(
				`SELECT * FROM ${qt}${documentation_page_neighbor_sql('next', next_params, cursor)}`,
				next_params,
			),
		]);
		return {
			current,
			previous: this.flatten(
				(prev_rows[0] as Record<string, unknown>) ?? null,
				'documentation-page',
			),
			next: this.flatten(
				(next_rows[0] as Record<string, unknown>) ?? null,
				'documentation-page',
			),
		};
	}

	/**
	 * Tablero de guías: cards + `step_count`, sin hidratar `steps`.
	 * Play/export hacen `find_id` del elegido.
	 */
	async interactive_manual_cards(): Promise<ImperiumDoc[]> {
		if (!this.has('interactive-manual')) return [];
		const qt = this.qt('interactive-manual');
		const cols = this.column_names('interactive-manual');
		const select = `${scan_select_sql(cols, INTERACTIVE_MANUAL_CARD_FIELDS)}, ${json_array_length_sql('steps')} AS step_count`;
		const rows = await this.sql.unsafe(
			`SELECT ${select} FROM ${qt} WHERE is_active IS DISTINCT FROM false`,
		);
		return rows
			.map((row) => this.flatten(row as Record<string, unknown>, 'interactive-manual'))
			.filter((row): row is ImperiumDoc => Boolean(row))
			.map((row) => {
				row.step_count = Number(row.step_count ?? 0) || 0;
				return row;
			});
	}

	async stats(
		resource: string,
		url?: URL,
		mongo_match?: Record<string, unknown> | null,
		actor?: ImperiumDoc | null,
	): Promise<Record<string, unknown>> {
		if (resource === 'ticketing-system-turn') return this.turn_stats(mongo_match);
		if (resource === 'citizen-report') return this.citizen_report_stats(url, mongo_match);
		if (resource === 'purchase-order') return purchase_order_stats(this, mongo_match);
		if (resource === 'pedidos' || resource === 'pedidos-surtir') {
			return pedidos_sales_stats(this, url, mongo_match);
		}
		const planning = await planeacion_statistics(this, resource, url, actor, mongo_match);
		if (planning) return planning;
		if (resource === 'invoice-request') return invoice_request_stats(this, mongo_match);
		if (resource === 'inventory-cost-entry') return cost_entry_stats(this, url, mongo_match);
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
		if (resource === 'delivery-package') {
			domain.by_status = await delivery_package_by_status(this, mongo_match);
		}
		if (resource === 'inventory-physical-count') {
			domain.by_state = await physical_count_by_state(this, mongo_match);
		}
		if (resource === 'inventory-stock-quant') {
			Object.assign(domain, await stock_quant_stats_extras(this, mongo_match));
		}
		if (resource === 'inventory-movement') {
			Object.assign(domain, await inventory_movement_stats_extras(this, mongo_match));
		}
		if (resource === 'inventory-internal-location') {
			Object.assign(domain, await location_stats_extras(this, mongo_match));
		}
		if (resource === 'delivery-return') {
			domain.by_state = await delivery_return_by_state(this, mongo_match);
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
		const from = new Date();
		from.setUTCDate(from.getUTCDate() - 30);
		const completed_match = {
			$or: [{ status: 'completado' }, { state: 'completado' }],
		};
		const match = mongo_match
			? { $and: [mongo_match, completed_match] }
			: completed_match;
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const is_completed = (r: ImperiumDoc) =>
			String(r.status ?? r.state ?? '') === 'completado';
		const day_counts = await this.count_by_created_day('ticketing-system-turn', {
			from_iso: from.toISOString(),
			mongo_match: match,
			include_inactive: true,
		});
		const today_key = new Date().toISOString().slice(0, 10);
		let ref_key = today_key;
		if (!(day_counts.get(today_key))) {
			let best = '';
			let n = 0;
			for (const [k, count] of day_counts) {
				if (count > n) {
					n = count;
					best = k;
				}
			}
			if (best) ref_key = best;
		}
		const ref_date = new Date(`${ref_key}T00:00:00.000Z`);
		const seven_keys: string[] = [];
		for (let i = 6; i >= 0; i--) {
			const d = new Date(ref_date);
			d.setUTCDate(d.getUTCDate() - i);
			seven_keys.push(d.toISOString().slice(0, 10));
		}
		const by_day = new Map<string, ImperiumDoc[]>();
		for await (const page of this.scan('ticketing-system-turn', {
			where: {
				created_at: {
					gte: `${seven_keys[0]}T00:00:00.000Z`,
					lte: `${ref_key}T23:59:59.999Z`,
				},
			},
			mongo_match: match,
			include_inactive: true,
			fields: TURN_STATS_FIELDS,
		})) {
			for (const r of page) {
				if (!is_completed(r)) continue;
				const k = day_of(r);
				if (!k || !seven_keys.includes(k)) continue;
				const list = by_day.get(k) ?? [];
				list.push(r);
				by_day.set(k, list);
			}
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
							take: 200,
							include_inactive: false,
							populate: false,
							skip_total: true,
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
		const where: Record<string, unknown> = {};
		if (date_from || date_to) {
			where.created_at = {
				...(date_from ? { gte: date_from } : {}),
				...(date_to ? { lte: date_to } : {}),
			};
		}
		if (priorities.length) where.priority = { in: priorities };
		if (statuses.length) where.status = { in: statuses };
		const status_of = (r: ImperiumDoc) => String(r.status ?? '').toLowerCase();
		const priority_of = (r: ImperiumDoc) => String(r.priority ?? '').toUpperCase();
		const ref_name = (v: unknown, fallback: string) => {
			const o = as_object(v);
			const label = String(o.name ?? o.nombreCompleto ?? '').trim();
			if (label) return label;
			if (typeof v === 'string') {
				const s = v.trim();
				if (s && !OBJECT_ID_HEX.test(s)) return s;
			}
			return fallback;
		};
		const slim_ref = (v: unknown) => {
			const label = ref_name(v, '');
			if (!label) return null;
			return { _id: ref_id(v), name: label };
		};
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const coord = (r: ImperiumDoc) => {
			const c = as_object(r.report_coordinates);
			const lat = Number(c.latitude ?? c.lat);
			const lon = Number(c.longitude ?? c.lng ?? c.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
			return `${lat.toFixed(2)},${lon.toFixed(2)}`;
		};
		const inc = (map: Map<string, number>, name: string) => {
			map.set(name, (map.get(name) ?? 0) + 1);
		};
		const series = (map: Map<string, number>) =>
			[...map.entries()]
				.map(([name, value]) => ({ name, value }))
				.sort((a, b) => b.value - a.value);
		let total_complaints = 0;
		let pending_complaints = 0;
		let urgent_complaints = 0;
		let resolved_complaints = 0;
		const priority_map = new Map<string, number>();
		const status_map = new Map<string, number>();
		const employee_map = new Map<string, number>();
		const department_map = new Map<string, number>();
		const recent_map = new Map<string, number>();
		const medium_map = new Map<string, number>();
		const problem_map = new Map<string, number>();
		const month_map = new Map<string, number>();
		const geo_map = new Map<string, number>();
		const phones = new Map<string, { count: number; name: string }>();
		const resolution = new Map<string, { sum: number; n: number }>();
		const export_records: Record<string, unknown>[] = [];
		const recent_cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
		for await (const page of this.scan('citizen-report', {
			where: Object.keys(where).length ? where : undefined,
			mongo_match,
			include_inactive: false,
			fields: CITIZEN_REPORT_STATS_FIELDS,
		})) {
			const rows = await this.populate_docs('citizen-report', page, { lite: true });
			for (const r of rows) {
				total_complaints += 1;
				const st = status_of(r);
				const pr = priority_of(r);
				if (
					st === 'pendiente' ||
					st === 'en_proceso' ||
					(!st && ['MEDIA', 'ALTA', 'URGENTE', 'CRITICA'].includes(pr))
				) {
					pending_complaints += 1;
				}
				if (['URGENTE', 'CRITICA'].includes(pr)) urgent_complaints += 1;
				if (st === 'terminado' || (!st && pr === 'BAJA')) resolved_complaints += 1;
				inc(priority_map, String(r.priority ?? 'SIN_PRIORIDAD'));
				inc(status_map, String(r.status ?? 'SIN_ESTATUS'));
				inc(employee_map, ref_name(r.employee_taken_the_report, 'Sin asignar'));
				inc(department_map, ref_name(r.department, 'Sin departamento'));
				inc(medium_map, ref_name(r.reporting_medium, 'Sin medio'));
				inc(problem_map, ref_name(r.citizen_report_problem, 'Sin problema'));
				const day = day_of(r);
				if (day) {
					inc(month_map, day.slice(0, 7));
					const t = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
					if (Number.isFinite(t) && t >= recent_cut) inc(recent_map, day);
				}
				inc(geo_map, ref_name(r.borough, coord(r) || 'Sin ubicación'));
				export_records.push({
					name: r.name ?? '',
					citizen_name: r.citizen_name ?? '',
					citizen_phone: r.citizen_phone ?? '',
					priority: r.priority ?? '',
					status: r.status ?? '',
					employee_taken_the_report: slim_ref(r.employee_taken_the_report),
					assinged_to: slim_ref(r.assinged_to),
					department: slim_ref(r.department),
					reporting_medium: slim_ref(r.reporting_medium),
					citizen_report_problem: slim_ref(r.citizen_report_problem),
					createdAt: r.createdAt ?? r.created_at ?? '',
				});
				const phone = String(r.citizen_phone ?? '').trim();
				if (phone) {
					const citizen_name = String(r.citizen_name ?? '').trim();
					const cur = phones.get(phone);
					if (cur) {
						cur.count += 1;
						if (!cur.name && citizen_name) cur.name = citizen_name;
					} else {
						phones.set(phone, { count: 1, name: citizen_name });
					}
				}
				if (st !== 'terminado') continue;
				const a = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
				const b = new Date(String(r.updatedAt ?? r.updated_at ?? '')).getTime();
				if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
				const p = pr || 'SIN_PRIORIDAD';
				const cur = resolution.get(p) ?? { sum: 0, n: 0 };
				cur.sum += (b - a) / (1000 * 60 * 60 * 24);
				cur.n += 1;
				resolution.set(p, cur);
			}
		}
		const avg_resolution_time = [...resolution.entries()]
			.map(([name, v]) => ({ name, value: Number((v.sum / v.n).toFixed(1)) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const citizen_recurrence = [...phones.entries()]
			.filter(([, v]) => v.count > 1)
			.map(([phone, v]) => ({ name: v.name || phone, value: v.count }))
			.sort((a, b) => b.value - a.value)
			.slice(0, 10);
		const export_sheet = (
			title: string,
			chart_type: string,
			lookups: Record<string, string> = {},
		) => ({
			records: export_records,
			metadata: {
				title,
				unit: 'Quejas',
				total_records: export_records.length,
				chart_type,
			},
			lookups,
		});
		return {
			kpis: {
				total_complaints,
				pending_complaints,
				urgent_complaints,
				resolved_complaints,
			},
			charts: {
				priority_distribution: { data: series(priority_map) },
				status_distribution: { data: series(status_map) },
				employee_workload: { data: series(employee_map) },
				department_distribution: { data: series(department_map) },
				recent_activity: { data: series(recent_map).filter((x) => x.name) },
				reporting_medium_distribution: { data: series(medium_map) },
				problem_distribution: { data: series(problem_map) },
				monthly_trend: { data: series(month_map).filter((x) => x.name) },
				geographic_distribution: { data: series(geo_map) },
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

/** El populate sin select del original deja el documento; quita secretos de user/PIN. */
function strip_populated_secrets(resource: string, doc: ImperiumDoc): ImperiumDoc {
	const out = { ...doc };
	delete out.pin_hash;
	if (resource === 'user' || resource === 'usuario') {
		delete out.password;
		delete out.reset_password_token_hash;
		delete out.reset_password_expires;
		delete out.reset_password_kind;
		delete out.recovery_token;
		delete out.recovery_expires;
	}
	return out;
}

function pick_populated(
	hit: ImperiumDoc | undefined,
	id: string,
	full: boolean,
): ImperiumDoc {
	if (full) return hit ? { ...hit } : { _id: id, name: '' };
	return populated_lite(hit, id);
}

function apply_populated_path(
	target: Record<string, unknown>,
	path: string[],
	lookup: Map<string, ImperiumDoc> | undefined,
	full = false,
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
				return id ? pick_populated(lookup?.get(id), id, full) : entry;
			});
			return;
		}
		const id = ref_id(val);
		if (id) target[head!] = pick_populated(lookup?.get(id), id, full);
		return;
	}
	const val = target[head!];
	if (Array.isArray(val)) {
		target[head!] = val.map((entry) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
			const copy = { ...(entry as Record<string, unknown>) };
			apply_populated_path(copy, rest, lookup, full);
			return copy;
		});
		return;
	}
	if (val && typeof val === 'object' && !Array.isArray(val)) {
		const copy = { ...(val as Record<string, unknown>) };
		apply_populated_path(copy, rest, lookup, full);
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

function is_range_filter(value: unknown): value is {
	gte?: unknown;
	lte?: unknown;
	gt?: unknown;
	lt?: unknown;
} {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const rec = value as Record<string, unknown>;
	return ('gte' in rec || 'lte' in rec || 'gt' in rec || 'lt' in rec) && !('in' in rec);
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

function range_compare_sql(
	cols: Set<string>,
	field: string,
	op: '>=' | '<=' | '>' | '<',
	index: number,
) {
	if (cols.has(field)) return `${qident(field)} ${op} $${index}`;
	return payload_field_range_sql(field, op, `$${index}`);
}

export function payload_field_range_sql(
	field: string,
	op: '>=' | '<=' | '>' | '<',
	param: string,
): string {
	const key = literal(field);
	return `payload ->> ${key} ${op} ${param}::text`;
}

/** Predicado sargable: el btree `(payload ->> campo)` lo cubre. */
export function payload_field_eq_sql(field: string, param: string): string {
	const key = literal(field);
	return `payload ->> ${key} = ${param}::text`;
}

export function payload_field_in_sql(field: string, marks: string[]): string {
	const key = literal(field);
	return `payload ->> ${key} IN (${marks.join(', ')})`;
}

function payload_distinct_expr(field: string): string {
	if (!field.includes('.')) return `payload ->> ${literal(field)}`;
	const parts = field.split('.').filter((part) => /^[a-z_][a-z0-9_]*$/i.test(part));
	if (!parts.length) throw new Error(`bad ident ${field}`);
	return `payload #>> '{${parts.join(',')}}'`;
}

/**
 * Bind JSONB: objeto/arreglo, no string. Bun.SQL + `::jsonb` re-encoda un string.
 * Entero/boolean van como texto JSON (`123`, `true`): PG no castea integer→jsonb
 * (`cannot cast type integer to jsonb` en counters como current_real_value).
 */
export function json_bind_value(v: unknown): unknown {
	if (v == null) return null;
	if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
	return typeof v === 'string' ? parse_json_cell(v) : v;
}

function cell(v: unknown, json: boolean): unknown {
	if (v == null) return null;
	if (json) return json_bind_value(v);
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
