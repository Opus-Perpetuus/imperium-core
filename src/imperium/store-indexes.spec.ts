import { describe, expect, test } from 'bun:test';
import { mongo_match_to_sql } from './record-rules.ts';
import {
	created_at_keyset_sql,
	fecha_entrada_keyset_sql,
	history_page_index_sqls,
	max_numeric_expr,
	json_bind_value,
	list_select_sql,
	lookup_index_sqls,
	populate_lite_select_sql,
	scan_select_sql,
	scan_omit_sql,
	json_array_length_sql,
	INTERACTIVE_MANUAL_CARD_FIELDS,
	CITIZEN_REPORT_STATS_FIELDS,
	TURN_STATS_FIELDS,
	value_counts_sql,
	payload_field_eq_sql,
	payload_lookup_index_sqls,
	unique_index_sqls,
	unwrap_jsonb_string_sql,
	payload_text_expr,
	debug_payload_expr,
	debug_log_filter_sql,
	debug_log_list_select_sql,
	debug_log_related_sql,
	documentation_page_current_sql,
	documentation_page_neighbor_sql,
	documentation_page_order_sql,
} from './store.ts';
import { debug_related_route_candidates } from './debug-log-flow.ts';
import { list_projection_keys } from './list-projection.ts';

describe('unique_index_sqls', () => {
	test('indexes a physical column used at login (user.email)', () => {
		const sqls = unique_index_sqls({
			quoted_table: '"core"."user"',
			table_key: 'user',
			fields: ['email'],
			columns: new Set(['id', 'email', 'payload']),
		});
		expect(sqls.length).toBe(1);
		expect(sqls[0]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
		expect(sqls[0]).toContain('"email"');
		expect(sqls[0]).not.toContain('payload ->>');
	});

	test('falls back to payload expression when the field is not a column', () => {
		const sqls = unique_index_sqls({
			quoted_table: '"core"."products"',
			table_key: 'products',
			fields: ['codigo'],
			columns: new Set(['id', 'name', 'payload']),
		});
		expect(sqls[0]).toContain("payload ->> 'codigo'");
	});

	test('skips COUNT companions: skip_total is a documented find_many opt', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		expect(src).toContain('skip_total?: boolean');
		expect(src).toMatch(/if\s*\(\s*!opts\.skip_total\s*\)/);
	});
});

describe('lookup_index_sqls', () => {
	test('adds a btree on user.email even when unique cannot be created', () => {
		const sqls = lookup_index_sqls({
			quoted_table: '"core"."user"',
			table_key: 'user',
			fields: ['email'],
			columns: new Set(['id', 'email', 'payload']),
		});
		expect(sqls.length).toBe(1);
		expect(sqls[0]).toContain('CREATE INDEX IF NOT EXISTS');
		expect(sqls[0]).toContain('"email"');
		expect(sqls[0]).not.toContain('UNIQUE');
	});
});

describe('payload_lookup_index_sqls', () => {
	test('indexes documentId inside history payload JSONB', () => {
		const sqls = payload_lookup_index_sqls({
			quoted_table: '"core"."document_change_history"',
			table_key: 'document_change_history',
			fields: ['documentId', 'modelName'],
		});
		expect(sqls.length).toBe(2);
		expect(sqls[0]).toContain("payload ->> 'documentId'");
		expect(sqls[1]).toContain("payload ->> 'modelName'");
		expect(sqls[0]).toContain('CREATE INDEX IF NOT EXISTS');
	});
});

describe('sargable payload predicates', () => {
	test('equality is a single payload ->> so the btree can be used', () => {
		const sql = payload_field_eq_sql('documentId', '$1');
		expect(sql).toBe("payload ->> 'documentId' = $1::text");
		expect(sql).not.toContain('jsonb_typeof');
		expect(sql).not.toContain('COALESCE');
	});

	test('map coordinates match physical text or lat/lon columns', () => {
		const params: unknown[] = [];
		const sql = mongo_match_to_sql(
			{
				$or: [
					{
						$and: [
							{ delivery_address_coordinates: { $exists: true } },
							{ delivery_address_coordinates: { $ne: '' } },
						],
					},
					{ $and: [{ latitude: { $exists: true } }, { longitude: { $exists: true } }] },
				],
			},
			new Set(['id', 'delivery_address_coordinates', 'latitude', 'longitude', 'payload']),
			params,
		);
		expect(sql).toContain('"delivery_address_coordinates" IS NOT NULL');
		expect(sql).toContain('"latitude" IS NOT NULL');
		expect(sql).toContain('"longitude" IS NOT NULL');
		expect(sql).toContain(' OR ');
		expect(sql).not.toContain('payload ->>');
		expect(params).toEqual(['']);
	});

	test('delivery_route present uses the physical column, not payload', () => {
		const params: unknown[] = [];
		const sql = mongo_match_to_sql(
			{
				$and: [{ delivery_route: { $exists: true } }, { delivery_route: { $ne: '' } }],
			},
			new Set(['id', 'delivery_route', 'payload']),
			params,
		);
		expect(sql).toContain('"delivery_route" IS NOT NULL');
		expect(sql).toContain('"delivery_route" IS DISTINCT FROM');
		expect(sql).not.toContain('payload ->>');
		expect(params).toEqual(['']);
	});

	test('mongo_match extracts payload without a double-decode wrapper', () => {
		const params: unknown[] = [];
		const sql = mongo_match_to_sql({ documentId: 'cfg-1' }, new Set(['id', 'payload']), params);
		expect(sql).toContain("payload ->> 'documentId'");
		expect(sql).not.toContain('jsonb_typeof');
		expect(sql).not.toContain('COALESCE');
		expect(params).toEqual(['cfg-1']);
	});

	test('q search does not cast the whole payload to text', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		expect(src).not.toContain('payload::text ILIKE');
		expect(src).toContain('search_field');
	});
});

describe('created_at_keyset_sql', () => {
	test('compares the TEXT pair without a timestamptz cast', () => {
		const sql = created_at_keyset_sql('$3', '$4');
		expect(sql).toBe('(created_at, id) > ($3, $4)');
		expect(sql).not.toContain('timestamptz');
		expect(sql).not.toContain('::');
	});
});

describe('fecha_entrada_keyset_sql', () => {
	test('compares the TEXT triple without a timestamptz cast', () => {
		const sql = fecha_entrada_keyset_sql('$1', '$2', '$3');
		expect(sql).toBe('(fecha_entrada, created_at, id) > ($1, $2, $3)');
		expect(sql).not.toContain('timestamptz');
	});
});

describe('max_numeric_expr', () => {
	test('aggregates digits or a trailing number without hydrating rows', () => {
		const sql = max_numeric_expr('"consecutivo"');
		expect(sql).toContain('MAX(CASE');
		expect(sql).toContain('"consecutivo"::numeric');
		expect(sql).toContain('regexp_match');
	});
});

describe('history_page_index_sqls', () => {
	test('covers documentId plus created_at for the history LIMIT page', () => {
		const [sql] = history_page_index_sqls({
			quoted_table: '"core"."document_change_history"',
			table_key: 'document_change_history',
		});
		expect(sql).toContain("payload ->> 'documentId'");
		expect(sql).toContain('created_at DESC');
		expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
	});
});

describe('list_select_sql', () => {
	const cols = new Set([
		'id',
		'name',
		'description',
		'is_active',
		'ref',
		'custom_data',
		'payload',
		'created_at',
		'updated_at',
		'existencia',
	]);

	test('returns null when the resource has no list projection', () => {
		expect(list_select_sql('no-such-resource', cols)).toBeNull();
	});

	test('selects physical list columns and a slim payload, not star', () => {
		const sql = list_select_sql('products', cols);
		expect(sql).toBeTruthy();
		expect(sql).toContain('"id"');
		expect(sql).toContain('"existencia"');
		expect(sql).toContain('jsonb_object_agg');
		expect(sql).toContain("'costoVenta'");
		expect(sql).not.toBe('*');
		expect(list_projection_keys('products')).toContain('existencia');
	});

	test('keeps pedidos partidas out of the slim payload', () => {
		const sql = list_select_sql('pedidos', cols);
		expect(sql).toContain("'folio'");
		expect(sql).not.toContain("'partidas'");
		expect(sql).not.toContain("'articulos'");
	});

	test('keeps decorate keys that finalize_rows reads before projecting', () => {
		const reception = list_select_sql('inventory-reception', cols);
		expect(reception).toContain("'articulos'");
		expect(reception).toContain("'purchase_order'");
		const count = list_select_sql('inventory-physical-count', cols);
		expect(count).toContain("'lineas'");
	});
});

describe('populate_lite_select_sql', () => {
	test('selects id and name, not star', () => {
		const sql = populate_lite_select_sql(
			new Set(['id', 'name', 'description', 'payload', 'existencia']),
		);
		expect(sql).toContain('"id"');
		expect(sql).toContain('"name"');
		expect(sql).toContain("'name'");
		expect(sql).not.toContain('"existencia"');
		expect(sql).not.toBe('*');
	});
});

describe('scan_select_sql', () => {
	test('keeps id and the requested payload key, not star', () => {
		const sql = scan_select_sql(
			new Set(['id', 'created_at', 'payload', 'is_active', 'existencia']),
			['estado'],
		);
		expect(sql).toContain('"id"');
		expect(sql).toContain("'estado'");
		expect(sql).not.toContain('"existencia"');
		expect(sql).not.toBe('*');
	});

	test('price-list offline cards keep product and drop the rest of payload', () => {
		const sql = scan_select_sql(
			new Set(['id', 'name', 'iva', 'product', 'payload', 'created_at', 'is_active']),
			['name', 'iva', 'product', 'productos'],
		);
		expect(sql).toContain('"name"');
		expect(sql).toContain('"iva"');
		expect(sql).toContain('"product"');
		expect(sql).toContain("'productos'");
		expect(sql).not.toBe('*');
	});

	test('view baseline cards keep assignment keys and drop table_configs', () => {
		const sql = scan_select_sql(
			new Set(['id', 'name', 'scope', 'is_template', 'appearance', 'payload', 'updated_at', 'is_active', 'created_at']),
			['created_by', 'scope', 'is_template', 'assigned_user_ids', 'assigned_user_group_ids', 'updated_at'],
		);
		expect(sql).toContain('"scope"');
		expect(sql).toContain("'assigned_user_ids'");
		expect(sql).not.toContain("'table_configs'");
		expect(sql).not.toContain('"appearance"');
		expect(sql).not.toBe('*');
	});

	test('sku offline omit drops lotes from payload without selecting star', () => {
		const sql = scan_omit_sql(
			new Set(['id', 'name', 'puedoVenderlo', 'payload', 'is_active', 'created_at']),
			['produccion', 'existenciaAlmacenes', 'lotes', 'proveedores'],
		);
		expect(sql).toContain('"name"');
		expect(sql).toContain('"puedoVenderlo"');
		expect(sql).toContain('NOT IN');
		expect(sql).toContain("'lotes'");
		expect(sql).toContain("'produccion'");
		expect(sql).not.toBe('*');
	});

	test('increment consolidate cards keep grouping keys and drop search_field', () => {
		const sql = scan_select_sql(
			new Set([
				'id',
				'name',
				'search_field',
				'payload',
				'created_at',
				'is_active',
				'_unique_string_reference',
				'current_sequence',
				'current_real_value',
			]),
			['_unique_string_reference', 'current_sequence', 'current', 'valor', 'current_real_value'],
		);
		expect(sql).toContain('"_unique_string_reference"');
		expect(sql).toContain('"current_sequence"');
		expect(sql).toContain("'current'");
		expect(sql).toContain("'valor'");
		expect(sql).not.toContain('"search_field"');
		expect(sql).not.toContain("'search_field'");
		expect(sql).not.toBe('*');
	});

	test('citizen report stats keep kpi keys and drop search_field', () => {
		const sql = scan_select_sql(
			new Set([
				'id',
				'name',
				'search_field',
				'payload',
				'created_at',
				'updated_at',
				'is_active',
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
				'evidence_before_images',
				'report_description',
			]),
			CITIZEN_REPORT_STATS_FIELDS,
		);
		expect(sql).toContain('"status"');
		expect(sql).toContain('"priority"');
		expect(sql).toContain('"name"');
		expect(sql).toContain('"assinged_to"');
		expect(sql).toContain('"citizen_phone"');
		expect(sql).toContain('"citizen_name"');
		expect(sql).toContain('"updated_at"');
		expect(sql).not.toContain('"search_field"');
		expect(sql).not.toContain('"evidence_before_images"');
		expect(sql).not.toContain('"report_description"');
		expect(sql).toContain("'{}'::jsonb");
		expect(sql).not.toContain('jsonb_each');
		expect(sql).not.toBe('*');
	});

	test('turn stats cards keep box/service keys and drop search_field', () => {
		const sql = scan_select_sql(
			new Set([
				'id',
				'name',
				'search_field',
				'payload',
				'created_at',
				'is_active',
				'assigned_box',
				'services',
				'customer_type',
				'status',
				'state',
				'time_box',
				'time',
			]),
			TURN_STATS_FIELDS,
		);
		expect(sql).toContain('"assigned_box"');
		expect(sql).toContain('"services"');
		expect(sql).toContain('"customer_type"');
		expect(sql).toContain('"time_box"');
		expect(sql).toContain('"status"');
		expect(sql).not.toContain("'service_type'");
		expect(sql).not.toContain('"search_field"');
		expect(sql).not.toContain("'search_field'");
		expect(sql).toContain("'{}'::jsonb");
		expect(sql).not.toContain('jsonb_each');
		expect(sql).not.toBe('*');
	});

	test('interactive-manual cards keep assignment keys and drop steps', () => {
		const sql = scan_select_sql(
			new Set(['id', 'name', 'description', 'payload', 'created_at', 'is_active']),
			INTERACTIVE_MANUAL_CARD_FIELDS,
		);
		expect(sql).toContain('"name"');
		expect(sql).toContain("'icon'");
		expect(sql).toContain("'assigned_user_ids'");
		expect(sql).toContain("'assigned_group_ids'");
		expect(sql).not.toContain("'steps'");
		expect(sql).not.toBe('*');
	});

	test('documentation cards keep markdown content out of the slim payload', () => {
		const sql = scan_select_sql(
			new Set(['id', 'name', 'is_active', 'payload', 'created_at']),
			[
				'title',
				'name',
				'slug',
				'section',
				'folder_path',
				'metadata',
				'order',
				'is_root_page',
				'parent_hierarchy',
				'headings',
				'description',
			],
		);
		expect(sql).toContain('"name"');
		expect(sql).toContain("'slug'");
		expect(sql).toContain("'metadata'");
		expect(sql).not.toContain("'content'");
		expect(sql).not.toBe('*');
	});
});

describe('value_counts_sql', () => {
	test('groups one scalar expression without selecting star', () => {
		const sql = value_counts_sql('"subject_ventas"."pedidos"', '"estado"', true);
		expect(sql).toContain('GROUP BY 1');
		expect(sql).toContain('COUNT(*)');
		expect(sql).toContain("'-'");
		expect(sql).not.toContain('SELECT *');
		expect(sql).not.toContain('is_active IS DISTINCT FROM false');
	});
});

describe('payload_text_expr', () => {
	test('unwraps string-wrapped jsonb and walks dotted paths', () => {
		const simple = payload_text_expr('level');
		expect(simple).toContain('jsonb_typeof');
		expect(simple).toContain("->> 'level'");
		const dotted = payload_text_expr('origin.file');
		expect(dotted).toContain("#>> '{origin,file}'");
	});
});

describe('documentation_page neighbor sql', () => {
	test('looks up current slug and one neighbor without selecting the catalog', () => {
		const current_params: unknown[] = [];
		const current = documentation_page_current_sql(current_params, {
			slug: 'como-usar',
			folder: 'docs',
			section: 'general',
		});
		expect(current).toContain("->> 'slug'");
		expect(current).toContain("->> 'folder_path'");
		expect(current_params).toEqual(['como-usar', 'docs', 'general']);
		const neighbor_params: unknown[] = [];
		const neighbor = documentation_page_neighbor_sql('next', neighbor_params, {
			section: 'general',
			order: 2,
			id: 'abc',
		});
		expect(neighbor).toContain('LIMIT 1');
		expect(neighbor).toContain("->> 'section'");
		expect(neighbor).not.toContain('SELECT *');
		expect(neighbor).not.toContain("'order'::numeric");
		expect(neighbor_params).toEqual(['general', 2, 'abc']);
	});

	test('casts the extracted order value, not the json key', () => {
		const sql = documentation_page_order_sql();
		expect(sql).toContain(')::numeric');
		expect(sql).not.toContain("'order'::numeric");
		expect(sql).toContain('::numeric');
	});
});

describe('debug_payload_expr', () => {
	test('reads payload object keys without a CASE unwrap', () => {
		expect(debug_payload_expr('level')).toBe("payload ->> 'level'");
		expect(debug_payload_expr('origin.file')).toBe("payload #>> '{origin,file}'");
		expect(debug_payload_expr('level')).not.toContain('jsonb_typeof');
	});
});

describe('debug_log_list_select_sql', () => {
	test('projects console cards without call_stack or star', () => {
		const sql = debug_log_list_select_sql();
		expect(sql).toContain('left(');
		expect(sql).toContain('request_context');
		expect(sql).toContain('response_message');
		expect(sql).not.toContain('call_stack');
		expect(sql).not.toContain('user_agent');
		expect(sql).not.toContain('SELECT *');
	});
});

describe('debug_log_filter_sql', () => {
	test('filters level and dates without selecting star', () => {
		const params: unknown[] = [];
		const sql = debug_log_filter_sql(
			{
				levels: ['error', 'request'],
				search: '',
				user: '',
				origin_file: '',
				request_results: [],
				date_from: '2026-01-01T00:00:00.000Z',
				date_to: '2026-01-02T00:00:00.000Z',
			},
			params,
		);
		expect(sql).toContain('WHERE');
		expect(sql).toContain("payload ->> 'level'");
		expect(sql).not.toContain('jsonb_typeof');
		expect(sql).toContain('created_at >=');
		expect(sql).not.toContain('SELECT *');
		expect(params).toEqual(['error', 'request', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']);
	});
});

describe('debug_log_related_sql', () => {
	test('filters route candidates, method, status and window without selecting star', () => {
		const params: unknown[] = [];
		const sql = debug_log_related_sql(
			{
				routes: ['/pedidos', '/api/pedidos'],
				method: 'GET',
				status_code: 404,
				created_after: '2026-08-28T00:00:00.000Z',
				created_before: '2026-08-28T00:00:30.000Z',
			},
			params,
		);
		expect(sql).toContain('WHERE');
		expect(sql).toContain("payload ->> 'level'");
		expect(sql).not.toContain('jsonb_typeof');
		expect(sql).toContain("#>> '{request_context,route}'");
		expect(sql).toContain("#>> '{request_context,method}'");
		expect(sql).toContain("#>> '{request_context,response,status_code}'");
		expect(sql).toContain('created_at >=');
		expect(sql).toContain('created_at <=');
		expect(sql).not.toContain('SELECT *');
		expect(params).toEqual([
			'error',
			'request',
			'2026-08-28T00:00:00.000Z',
			'2026-08-28T00:00:30.000Z',
			'/pedidos',
			'/api/pedidos',
			'GET',
			'404',
		]);
	});

	test('related route candidates keep /api and stripped forms', () => {
		expect(debug_related_route_candidates('/api/pedidos')).toEqual(['/api/pedidos', '/pedidos']);
		expect(debug_related_route_candidates('/pedidos')).toEqual(['/pedidos', '/api/pedidos']);
		expect(debug_related_route_candidates('https://app.local/api/foo?x=1')).toEqual([
			'/api/foo?x=1',
			'/foo?x=1',
		]);
	});
});

describe('json_array_length_sql', () => {
	test('counts a payload array without selecting the array', () => {
		const sql = json_array_length_sql('steps');
		expect(sql).toContain('jsonb_array_length');
		expect(sql).toContain("-> 'steps'");
		expect(sql).toContain("jsonb_typeof");
		expect(sql).not.toContain('SELECT *');
	});
});

describe('json_bind_value', () => {
	test('passes objects through so Bun.SQL does not wrap them as jsonb strings', () => {
		expect(json_bind_value({ documentId: 'cfg-1' })).toEqual({ documentId: 'cfg-1' });
		expect(typeof json_bind_value({ documentId: 'cfg-1' })).toBe('object');
	});

	test('coerces numbers and booleans to JSON text so $n::jsonb is not integer', () => {
		expect(json_bind_value(1)).toBe('1');
		expect(json_bind_value(0)).toBe('0');
		expect(json_bind_value(12.5)).toBe('12.5');
		expect(json_bind_value(true)).toBe('true');
		expect(json_bind_value(false)).toBe('false');
		expect(json_bind_value(null)).toBeNull();
	});
});

describe('unwrap_jsonb_string_sql', () => {
	test('rewrites string-wrapped jsonb in id batches', () => {
		const sql = unwrap_jsonb_string_sql('"core"."document_change_history"', 'payload');
		expect(sql).toContain('#>>');
		expect(sql).toContain("jsonb_typeof");
		expect(sql).toContain('LIMIT 1000');
		expect(sql).toContain('RETURNING');
	});
});
