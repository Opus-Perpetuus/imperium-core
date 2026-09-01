import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { field_values_from_distinct } from './field-values.ts';
import { MASS_QUERY_MAX_IDS } from './crud.ts';

describe('scale contracts', () => {
	test('ensure unwraps string-wrapped jsonb so payload ->> can use the btree', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async ensure_defaults(');
		const body = src.slice(start, src.indexOf('async warmup_search_indexes(', start));
		expect(body).toContain('ensure_object_json_cells');
		expect(src).toContain('json_bind_value');
		expect(src).toContain('unwrap_jsonb_string_sql');
	});

	test('list populate loads ref name without COUNT(*) or SELECT *', () => {
		const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const pop = store.slice(
			store.indexOf('async populate_docs('),
			store.indexOf('flatten_list_docs('),
		);
		expect(pop).toContain('skip_total: true');
		expect(pop).toContain('populate_lite: lite');
		const find = store.slice(store.indexOf('async find_many('), store.indexOf('async *scan('));
		expect(find).toContain('lite: Boolean(opts.list_project)');
		expect(find).toContain('populate_lite_select_sql');
	});

	test('list UI projects columns in SQL instead of SELECT *', () => {
		const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = store.indexOf('async find_many(');
		const body = store.slice(start, store.indexOf('async *scan(', start));
		expect(body).toContain('opts.list_project');
		expect(body).toContain('list_select_sql');
		const crud = readFileSync(new URL('./crud.ts', import.meta.url), 'utf8');
		const list = crud.slice(
			crud.indexOf('async function read_list_docs'),
			crud.indexOf('async function attach_custom_list_fields'),
		);
		expect(list).toContain('list_project: !excel');
		expect(store).toContain('if (!(col.name in parsed)) continue;');
	});

	test('export.csv streams keyset pages instead of collecting the table', () => {
		const src = readFileSync(new URL('./crud.ts', import.meta.url), 'utf8');
		expect(src).toContain('stream_export_csv');
		expect(src).toContain('populate: false');
		expect(src).toContain("sort: 'id:asc'");
		expect(src).not.toMatch(/collected\.push/);
	});

	test('field-values goes through store.distinct', () => {
		const src = readFileSync(new URL('./crud.ts', import.meta.url), 'utf8');
		const fn = src.slice(src.indexOf("segs[0] === 'field-values'"));
		const body = fn.slice(0, fn.indexOf("segs[0] === 'export.csv'"));
		expect(body).toContain('store.distinct');
		expect(body).not.toContain('read_list_docs');
	});

	test('mass-query caps ids at 500 and does not default limite to 10000', () => {
		expect(MASS_QUERY_MAX_IDS).toBe(500);
		const src = readFileSync(new URL('./crud.ts', import.meta.url), 'utf8');
		const fn = src.slice(src.indexOf("segs[0] === 'mass-query'"));
		const body = fn.slice(0, fn.indexOf("segs[0] === 'batch'"));
		expect(body).toContain('MASS_QUERY_MAX_IDS');
		expect(body).not.toContain('10000');
	});

	test('store.scan is a keyset iterator with a hard page cap', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async *scan(');
		expect(start).toBeGreaterThan(0);
		const body = src.slice(start, src.indexOf('async count(', start));
		expect(body).toContain('populate: false');
		expect(body).toContain('skip_total: true');
		expect(body).toContain('where.id = { gt: after_id }');
		expect(body).toContain("order?: 'id' | 'created_at' | 'fecha_entrada'");
		expect(body).toContain("sort: by_lot ? 'fecha_entrada:asc' : by_time ? 'created_at:asc' : 'id:asc'");
		expect(body).toContain('after_created');
		expect(body).toContain('after_entrada');
		expect(body).toContain('scan_fields: opts.fields');
		expect(body).toContain('scan_omit: opts.omit');
		expect(body).toContain('page_size ?? 500');
		expect(body).toContain('1000');
		expect(body).not.toContain('take: 20000');
	});

	test('font awesome catalog indexes by scan instead of taking 5000', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async seed_font_awesome_catalog(');
		const body = src.slice(start, src.indexOf('async ensure_orphan_tables(', start));
		expect(body).toContain("this.scan('font-awesome-icon-catalog'");
		expect(body).not.toContain('take: 5000');
		expect(body).not.toContain('take: 20000');
	});

	test('search warmup pages with scan instead of COUNT plus OFFSET', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async warmup_search_indexes(');
		const body = src.slice(start, src.indexOf('async seed_font_awesome_catalog(', start));
		expect(body).toContain('this.scan(');
		expect(body).toContain('page_size: 200');
		expect(body).not.toContain('skip +=');
		expect(body).not.toContain('take: 20000');
	});

	test('model tracker reindex scans instead of taking 5000', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function model_tracker_reindex');
		const body = src.slice(start, src.indexOf('function cfg_text(', start));
		expect(body).toContain('ctx.store.scan(');
		expect(body).toContain("scan('module-management'");
		expect(body).toContain('SearchEngine.index_documents');
		expect(body).not.toContain('take: 2000');
		expect(body).not.toContain('take: 5000');
		expect(body).not.toContain('take: 20000');
	});

	test('turn and citizen stats scan instead of take 20000', () => {
		const src = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const turn = src.slice(src.indexOf('async turn_stats('), src.indexOf('async citizen_report_stats('));
		const citizen = src.slice(src.indexOf('async citizen_report_stats('));
		expect(src).toContain('async count_by_created_day(');
		expect(src).toContain('LEFT(created_at, 10)');
		expect(turn).toContain('count_by_created_day(');
		expect(turn).toContain('TURN_STATS_FIELDS');
		expect(turn).toContain('fields: TURN_STATS_FIELDS');
		expect(turn).toContain('this.scan(');
		expect(turn).not.toContain('take: 20000');
		expect(citizen).toContain('this.scan(');
		expect(citizen).toContain('CITIZEN_REPORT_STATS_FIELDS');
		expect(citizen).toContain('fields: CITIZEN_REPORT_STATS_FIELDS');
		expect(citizen).toContain("populate_docs('citizen-report'");
		expect(citizen).toContain('lite: true');
		expect(citizen).toContain('export_records');
		expect(citizen).not.toContain('CITIZEN_REPORT_STATS_EXPORT_MAX');
		expect(citizen).not.toContain('take: 20000');
		expect(citizen).not.toContain('records: []');
	});

	test('pedidos sales stats filter in SQL and scan pages', () => {
		const src = readFileSync(new URL('./pedidos-flow.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function pedidos_sales_stats');
		const body = src.slice(start);
		expect(body).toContain('store.scan(');
		expect(body).toContain('estado: { in: wanted_states }');
		expect(body).not.toContain('take: 20000');
	});

	test('delivery route map filters packages with coordinates in SQL', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('const HAS_MAP_COORDINATES');
		const body = src.slice(start, src.indexOf('async function delivery_chofer_routes'));
		expect(body).toContain('mongo_match: HAS_MAP_COORDINATES');
		expect(body).toContain('delivery_address_coordinates');
		expect(body).toContain('latitude');
		expect(body).not.toContain('HAS_DELIVERY_ROUTE');
	});

	test('delivery offline catalog filters packages with a route in SQL', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('const HAS_DELIVERY_ROUTE');
		const body = src.slice(start, src.indexOf('async function delivery_route_map'));
		expect(body).toContain('HAS_DELIVERY_ROUTE');
		expect(body).toContain('mongo_match');
		expect(body).toContain('$exists: true');
		expect(body).toContain("$ne: ''");
	});

	test('delivery package number uses count instead of hydrating the order', () => {
		const src = readFileSync(
			new URL('./delivery-package-flow.ts', import.meta.url),
			'utf8',
		);
		const start = src.indexOf('async function resolve_next_package_number');
		const body = src.slice(start, src.indexOf('async function resolve_package_codigo'));
		expect(body).toContain('store.count(');
		expect(body).not.toContain('take: 20000');
	});

	test('stock consistency scans quants and products without take 20000', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function stock_consistency');
		const body = src.slice(start, src.indexOf('async function violation_challenge'));
		expect(body).toContain('ctx.store.scan(');
		expect(body).toContain('revisados += 1');
		expect(body).not.toContain('take: 20000');
	});

	test('debug logs page and stats in SQL instead of collecting the table', () => {
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const flow = readFileSync(new URL('./debug-log-flow.ts', import.meta.url), 'utf8');
		const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		expect(actions).toContain('debug_read_logs(ctx.store, ctx.url)');
		expect(actions).toContain('debug_statistics(ctx.store, ctx.url)');
		expect(actions).toContain('debug_read_related(ctx.store, ctx.url)');
		expect(actions).not.toContain('collect_debug_logs');
		expect(flow).toContain('store.debug_log_page(');
		expect(flow).toContain('store.debug_log_stats(');
		expect(flow).toContain('store.debug_log_related(');
		expect(flow).not.toContain('collect_scan');
		expect(flow).not.toContain('take: 20000');
		expect(store).toContain('async debug_log_page(');
		expect(store).toContain('async debug_log_stats(');
		expect(store).toContain('async debug_log_related(');
		expect(store).toContain('debug_log_filter_sql');
		expect(store).toContain('debug_log_list_select_sql');
		expect(store).toContain('debug_log_related_sql');
		expect(store).toContain('debug_payload_expr');
		const page = store.slice(
			store.indexOf('async debug_log_page('),
			store.indexOf('async debug_log_stats('),
		);
		expect(page).toContain('debug_log_list_select_sql()');
		expect(page).not.toContain('SELECT *');
		expect(store).toContain('payload_text_expr');
		expect(store).toContain("code === '42P01'");
		expect(store).toContain('LIMIT ${take} OFFSET ${skip}');
		expect(store).toContain('GROUP BY 1');
		expect(store).toContain('LIMIT 10');
	});

	test('disabled model ids scan only assignment fields', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const fields = src.slice(
			src.indexOf('const DISABLED_MODULE_FIELDS'),
			src.indexOf('async function disabled_model_ids'),
		);
		const body = src.slice(
			src.indexOf('async function disabled_model_ids'),
			src.indexOf('async function payments_catalog'),
		);
		expect(fields).toContain("'model_id'");
		expect(fields).toContain("'is_enable'");
		expect(fields).not.toContain("'path'");
		expect(fields).not.toContain("'module_dependencies'");
		expect(body).toContain('fields: DISABLED_MODULE_FIELDS');
	});

	test('auto-increment list pages in SQL instead of collecting every control', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('const INCREMENT_LIST_FIELDS');
		const fields = src.slice(start, src.indexOf('async function list_auto_increment_controls'));
		const body = src.slice(
			src.indexOf('async function list_auto_increment_controls'),
			src.indexOf('async function increment_consolidate'),
		);
		expect(fields).toContain("'model_name'");
		expect(fields).toContain("'increment_field'");
		expect(fields).not.toContain("'search_field'");
		expect(body).toContain('scan_fields: INCREMENT_LIST_FIELDS');
		expect(body).toContain("store.find_many('auto-increment-control'");
		expect(body).toContain('populate: false');
		expect(body).toContain('Math.min(q.take, 200)');
		expect(body).not.toContain('collect_scan');
		expect(body).not.toContain('mapped.slice');
	});

	test('increment consolidate groups without hydrating search_field n-grams', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const fields = src.slice(
			src.indexOf('const INCREMENT_CONSOLIDATE_FIELDS'),
			src.indexOf('async function list_auto_increment_controls'),
		);
		const body = src.slice(
			src.indexOf('async function increment_consolidate'),
			src.indexOf('async function increment_counter'),
		);
		expect(fields).toContain("'_unique_string_reference'");
		expect(fields).toContain("'current_sequence'");
		expect(fields).not.toContain("'search_field'");
		expect(body).toContain('fields: INCREMENT_CONSOLIDATE_FIELDS');
		expect(body).toContain('collect_scan');
	});

	test('view baseline looks up one preset without hydrating table_configs of all', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('const VIEW_BASELINE_FIELDS');
		const body = src.slice(start, src.indexOf('async function view_assign'));
		expect(body).toContain('fields: VIEW_BASELINE_FIELDS');
		expect(body).toContain('find_id');
		expect(body).not.toContain('table_configs');
		expect(body).not.toContain('appearance');
	});

	test('price-list offline catalog projects name iva and product without star', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function lista_de_precios_sync_offline');
		const body = src.slice(start, src.indexOf('const SKU_OFFLINE_OMIT'));
		expect(body).toContain("fields: ['name', 'iva', 'product', 'productos']");
		expect(body).toContain('collect_scan');
	});

	test('sku offline catalog filters sellable rows in SQL', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function sku_sync_offline');
		const body = src.slice(start, src.indexOf('function session_employee_id'));
		expect(body).toContain('where: { puedoVenderlo: true }');
		expect(body).toContain('omit: [...SKU_OFFLINE_OMIT]');
		expect(body).toContain('collect_scan');
	});

	test('documentation cards scan projected fields instead of hydrating markdown', () => {
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const collect = actions.slice(
			actions.indexOf('async function collect_scan'),
			actions.indexOf('export async function handle_action'),
		);
		expect(collect).toContain('fields?: string[]');
		const read_all = actions.slice(
			actions.indexOf('async function documentation_read_all'),
			actions.indexOf('async function documentation_read_one'),
		);
		const structure = actions.slice(
			actions.indexOf('async function documentation_structure'),
			actions.indexOf('function documentation_snippet'),
		);
		expect(read_all).toContain('fields: DOCUMENTATION_CARD_FIELDS');
		expect(structure).toContain('fields: DOCUMENTATION_CARD_FIELDS');
		expect(read_all).not.toContain('content');
		expect(structure).not.toContain('content');
	});

	test('interactive-manual board projects cards and counts steps in SQL', () => {
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const body = actions.slice(
			actions.indexOf('async function interactive_manual_board'),
			actions.indexOf('async function view_available'),
		);
		expect(body).toContain('ctx.store.interactive_manual_cards(');
		expect(body).not.toContain('collect_scan');
		expect(store).toContain('async interactive_manual_cards(');
		expect(store).toContain('INTERACTIVE_MANUAL_CARD_FIELDS');
		expect(store).toContain("json_array_length_sql('steps')");
		expect(store).not.toContain("fields: ['steps']");
	});

	test('documentation adjacent looks up neighbors in SQL instead of collecting pages', () => {
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		const start = actions.indexOf('async function documentation_adjacent');
		const body = actions.slice(start, actions.indexOf('function documentation_page_card'));
		expect(body).toContain('ctx.store.documentation_adjacent(');
		expect(body).not.toContain('collect_scan');
		expect(store).toContain('async documentation_adjacent(');
		expect(store).toContain('documentation_page_neighbor_sql');
		expect(store).toContain('LIMIT 1');
	});

	test('conversation messages page by size instead of hydrating 20000', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function conversation(');
		const body = src.slice(start, src.indexOf('function conversation_key_for'));
		expect(body).toContain("sort: 'created_at:asc'");
		expect(body).toContain('skip_total: true');
		expect(body).not.toContain('take: 20000');
	});

	test('chat inbox scans messages instead of taking 20000', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function my_conversations');
		const body = src.slice(start, src.indexOf('async function mark_conversation_as_read'));
		expect(body).toContain('ctx.store.scan(');
		expect(body).toContain('consider_latest');
		expect(body).not.toContain('take: 20000');
		expect(body).not.toContain('take = 20000');
	});

	test('planning project stats scan tasks instead of taking 20000', () => {
		const src = readFileSync(
			new URL('./planeacion-flow.ts', import.meta.url),
			'utf8',
		);
		const start = src.indexOf('async function scan_planning_stats');
		const body = src.slice(start, src.indexOf('export async function planeacion_statistics'));
		expect(body).toContain('store.scan(');
		expect(body).not.toContain('take: 20000');
	});

	test('ticketing turn helpers scan instead of taking 20000', () => {
		const src = readFileSync(
			new URL('./ticketing-turn-flow.ts', import.meta.url),
			'utf8',
		);
		expect(src).toContain('async function collect_turns');
		expect(src).toContain('store.scan(');
		expect(src).not.toContain('take: 20000');
		expect(src).not.toContain('take: 5000');
		const next = src.slice(src.indexOf('async function next_consecutive'));
		expect(next).toContain("store.scan('ticketing-system-turn'");
	});

	test('normalize_all_counters scans increment configs instead of taking 5000', () => {
		const src = readFileSync(new URL('./increment-normalize.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function normalize_all_counters');
		const body = src.slice(start, src.indexOf('function text(value: unknown): string'));
		expect(body).toContain("store.scan('auto-increment-control'");
		expect(body).not.toContain('take: 5000');
		expect(body).not.toContain('take: 20000');
	});

	test('documentation sync deletes by scan instead of taking 5000', () => {
		const src = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function documentation_sync');
		const body = src.slice(start, src.indexOf('async function dashboard_catalog', start));
		expect(body).toContain('ctx.store.scan(');
		expect(body).not.toContain('take: 5000');
		expect(body).not.toContain('take: 20000');
	});

	test('tickets admin list pages in SQL instead of taking 20000', () => {
		const src = readFileSync(new URL('./tickets-flow.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function tickets_admin_list');
		const body = src.slice(start, src.indexOf('export async function tickets_admin_one'));
		expect(body).toContain("sort: 'created_at:desc'");
		expect(body).toContain('take: limite');
		expect(body).not.toContain('take: 20000');
	});

	test('my tickets keep a top-200 window while scanning', () => {
		const src = readFileSync(new URL('./tickets-flow.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function read_my_tickets');
		const body = src.slice(start);
		expect(body).toContain('store.scan(');
		expect(body).toContain('consider_latest(mine, row, 200)');
		expect(body).not.toContain('take: 20000');
	});

	test('notification inbox scans instead of taking 20000', () => {
		const src = readFileSync(new URL('./notifications.ts', import.meta.url), 'utf8');
		const inbox = src.slice(0, src.indexOf('export async function notify_document_subscription_event'));
		expect(inbox).toContain('async function* scan_mine');
		expect(inbox).toContain("sort: 'created_at:desc'");
		expect(inbox).not.toContain('take: 20000');
		expect(inbox).not.toContain('take = 20000');
	});

	test('report PDF streams pages instead of hydrating the universe', () => {
		const reports = readFileSync(new URL('./reports-flow.ts', import.meta.url), 'utf8');
		expect(reports).toContain('export async function* iter_report_record_pages');
		expect(reports).toContain('export async function render_report_from_pages');
		expect(reports).toContain('hydrate_loose_product_references_many');
		expect(reports).toContain('apply_to_all must stream via iter_report_record_pages');
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const start = actions.indexOf('async function report_full_pdf');
		const body = actions.slice(start, actions.indexOf('async function html_to_pdf_response'));
		expect(body).toContain('render_report_from_pages');
		expect(body).not.toContain('hydrated.push');
	});

	test('cost entry stats consume FIFO per created_at page instead of sales[]', () => {
		const src = readFileSync(
			new URL('./inventory-logistics-flow.ts', import.meta.url),
			'utf8',
		);
		const start = src.indexOf('export async function cost_entry_stats');
		const body = src.slice(start);
		expect(body).toContain('store.scan(');
		expect(body).toContain("order: 'created_at'");
		expect(body).toContain("order: 'fecha_entrada'");
		expect(body).toContain('consume_fifo(');
		expect(body).toContain('fifo_queues.set(');
		expect(body).not.toContain('purchase_entries');
		expect(body).not.toContain('sales.push');
		expect(body).not.toContain('sales.sort');
		expect(body).not.toContain('take: 20000');
	});

	test('picking route scans quants and batches locations', () => {
		const src = readFileSync(new URL('./inventory-picking.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function compute_picking_route');
		const body = src.slice(start, src.indexOf('async function compute_weighted_consumption'));
		expect(body).toContain('store.scan(');
		expect(body).toContain('inventory-internal-location');
		expect(body).not.toContain('take: 20000');
	});

	test('payroll drafts scan employees and incidents instead of taking 20000', () => {
		const src = readFileSync(new URL('./payroll-flow.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function generate_payroll_drafts');
		const body = src.slice(start, src.indexOf('function receipt_for_cfdi'));
		expect(body).toContain('store.scan(');
		expect(body).toContain('incidents_by_emp');
		expect(body).not.toContain('take: 20000');
	});

	test('reception and physical count scan instead of taking 20000', () => {
		const reception = readFileSync(
			new URL('./inventory-reception-flow.ts', import.meta.url),
			'utf8',
		);
		const count = readFileSync(
			new URL('./inventory-physical-count-flow.ts', import.meta.url),
			'utf8',
		);
		expect(reception).toContain('store.scan(');
		expect(reception).toContain("scan('inventory-internal-location'");
		expect(reception).not.toContain('take: 2000');
		expect(reception).not.toContain('take: 20000');
		expect(count).toContain('store.scan(');
		expect(count).not.toContain('take: 20000');
	});

	test('document subscription scans user-settings instead of taking 20000', () => {
		const src = readFileSync(new URL('./notifications.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function notify_document_subscription_event');
		const body = src.slice(start);
		expect(body).toContain('store.scan(');
		expect(body).toContain('user-settings');
		expect(body).not.toContain('take: 20000');
	});

	test('delivery return existencia and by-state scan instead of taking 20000', () => {
		const src = readFileSync(new URL('./delivery-return-flow.ts', import.meta.url), 'utf8');
		const existencia = src.slice(
			src.indexOf('export async function recompute_product_existencia'),
			src.indexOf('async function post_return_received_comments'),
		);
		const by_state = src.slice(src.indexOf('export async function delivery_return_by_state'));
		expect(existencia).toContain('store.scan(');
		expect(existencia).not.toContain('take: 20000');
		expect(by_state).toContain('store.scan(');
		expect(by_state).not.toContain('take: 20000');
	});

	test('status normalize and spurious replace scan instead of taking 5000', () => {
		const src = readFileSync(new URL('./status-options.ts', import.meta.url), 'utf8');
		const normalize = src.slice(
			src.indexOf('export async function normalize_state_values'),
			src.indexOf('export async function resolve_spurious_options'),
		);
		const resolve = src.slice(src.indexOf('export async function resolve_spurious_options'));
		expect(normalize).toContain('ctx.store.scan(');
		expect(resolve).toContain('ctx.store.scan(');
		expect(normalize).not.toContain('take: 5000');
		expect(resolve).not.toContain('take: 5000');
	});

	test('CFDI purchase lookup scans instead of taking 2000', () => {
		const src = readFileSync(new URL('./cfdi-from-purchase.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function find_by_uuid');
		const body = src.slice(start, src.indexOf('export async function link_or_create_from_purchase_order'));
		expect(body).toContain('store.find_where');
		expect(body).toContain('store.scan(');
		expect(body).not.toContain('take: 2000');
		expect(body).not.toContain('take: 20000');
	});

	test('recreate_indexes scans documents instead of taking 2000', () => {
		const src = readFileSync(new URL('./module-data.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function recreate_indexes');
		const body = src.slice(start);
		expect(body).toContain('ctx.store.scan(');
		expect(body).not.toContain('take: 2000');
		expect(body).not.toContain('take: 20000');
	});

	test('migrate_legacy_modules scans modules instead of taking 2000', () => {
		const src = readFileSync(new URL('./module-data.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function migrate_legacy_modules');
		const body = src.slice(start, src.indexOf('export async function recreate_indexes'));
		expect(body).toContain("scan('module-management'");
		expect(body).not.toContain('take: 2000');
		expect(body).not.toContain('take: 20000');
	});

	test('POS consecutive preview uses MAX instead of taking 5000', () => {
		const src = readFileSync(new URL('./pos-session-flow.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function preview_pos_consecutive');
		const body = src.slice(start, src.indexOf('export async function prepare_pos_session_create'));
		expect(body).toContain("store.max_numeric('pos-session', 'consecutivo')");
		expect(body).not.toContain('take: 5000');
		expect(body).not.toContain('take: 20000');
		const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		expect(store).toContain('async max_numeric(');
		expect(store).toContain('max_numeric_expr');
	});

	test('POS session report scans tickets instead of taking 20000', () => {
		const src = readFileSync(new URL('./pos-session-flow.ts', import.meta.url), 'utf8');
		const start = src.indexOf('async function ticket_summaries_for_session');
		const body = src.slice(start, src.indexOf('function total_sales_of'));
		expect(body).toContain('store.scan(');
		expect(body).toContain('summarize_pos_ticket');
		expect(body).not.toContain('take: 20000');
	});

	test('invoice request lookup and stats scan instead of taking 20000', () => {
		const src = readFileSync(new URL('./invoice-request-flow.ts', import.meta.url), 'utf8');
		const lookup = src.slice(
			src.indexOf('async function find_existing_request'),
			src.indexOf('async function load_order'),
		);
		const stats = src.slice(src.indexOf('export async function invoice_request_stats'));
		expect(lookup).toContain('store.scan(');
		expect(lookup).not.toContain('take: 20000');
		expect(stats).toContain('store.scan(');
		expect(stats).not.toContain('take: 20000');
	});

	test('product cost and purchase-order stats scan instead of taking 20000', () => {
		const products = readFileSync(new URL('./products-flow.ts', import.meta.url), 'utf8');
		const cost = products.slice(products.indexOf('export async function products_inventory_cost'));
		const purchase = readFileSync(new URL('./purchase-order-flow.ts', import.meta.url), 'utf8');
		const stats = purchase.slice(purchase.indexOf('export async function purchase_order_stats'));
		expect(cost).toContain('store.scan(');
		expect(cost).not.toContain('take: 20000');
		expect(stats).toContain('store.scan(');
		expect(stats).not.toContain('take: 20000');
	});

	test('cobranza payments scan and lookup hydrates by id chunks', () => {
		const payment = readFileSync(new URL('./cobranza-payment-flow.ts', import.meta.url), 'utf8');
		const recompute = payment.slice(
			payment.indexOf('export async function recompute_cobranza_charge'),
			payment.indexOf('export async function apply_cobranza_payment'),
		);
		const lookup = readFileSync(new URL('./cobranza-lookup-flow.ts', import.meta.url), 'utf8');
		const payments_of = lookup.slice(
			lookup.indexOf('async function payments_of'),
			lookup.indexOf('async function agua_outstanding_amount'),
		);
		expect(recompute).toContain('store.scan(');
		expect(recompute).not.toContain('take: 20000');
		expect(payments_of).toContain('store.scan(');
		expect(payments_of).toContain('ids: chunk');
		expect(payments_of).not.toContain('take: 20000');
	});

	test('attendance snapshot scans group students instead of taking 20000', () => {
		const src = readFileSync(new URL('./lista-asistencia-flow.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function snapshot_attendance_entries');
		const body = src.slice(start, src.indexOf('export async function prepare_lista_asistencia_write'));
		expect(body).toContain('store.scan(');
		expect(body).not.toContain('take: 20000');
	});

	test('model-tracker field-values scan counts and refs instead of taking 20000', () => {
		const src = readFileSync(
			new URL('./model-tracker-field-values.ts', import.meta.url),
			'utf8',
		);
		const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
		expect(src).toContain('value_counts');
		expect(src).toContain('increment_parent_counts');
		expect(src).toContain('fields: [field_path]');
		expect(src).toContain('populate_lite: true');
		expect(src).toContain('store.scan(');
		expect(src).not.toContain('take: 20000');
		expect(store).toContain('async value_counts(');
		expect(store).toContain('value_counts_sql');
		expect(store).toContain('scan_fields: opts.fields');
	});

	test('location and vehicle stats scan instead of taking 20000', () => {
		const location = readFileSync(new URL('./location-flow.ts', import.meta.url), 'utf8');
		const loc = location.slice(location.indexOf('export async function location_stats_extras'));
		const vehicle = readFileSync(new URL('./vehicle-flow.ts', import.meta.url), 'utf8');
		const by_status = vehicle.slice(vehicle.indexOf('export async function vehicle_by_status'));
		expect(loc).toContain('store.scan(');
		expect(loc).not.toContain('take: 20000');
		expect(by_status).toContain('store.scan(');
		expect(by_status).not.toContain('take: 20000');
	});

	test('agua brackets, pattern parts, and interinstance keys scan instead of taking 20000', () => {
		const agua = readFileSync(new URL('./agua-importe.ts', import.meta.url), 'utf8');
		const calc = agua.slice(agua.indexOf('export async function calcular_importe'));
		const parts = readFileSync(new URL('./pattern-parts-flow.ts', import.meta.url), 'utf8');
		const active = parts.slice(
			parts.indexOf('async function active_parts'),
			parts.indexOf('export async function rebuild_custom_pattern'),
		);
		const inter = readFileSync(new URL('./interinstance.ts', import.meta.url), 'utf8');
		const key = inter.slice(
			inter.indexOf('export async function validate_interinstance_api_key'),
			inter.indexOf('export async function forward_interinstance'),
		);
		expect(calc).toContain('store.scan(');
		expect(calc).not.toContain('take: 20000');
		expect(active).toContain('store.scan(');
		expect(active).not.toContain('take: 20000');
		expect(key).toContain('store.scan(');
		expect(key).not.toContain('take: 20000');
	});

	test('build_access scans groups and rights instead of taking 20000', () => {
		const src = readFileSync(new URL('./auth.ts', import.meta.url), 'utf8');
		const access = src.slice(
			src.indexOf('export async function build_access'),
			src.indexOf('export async function assert_target_model_read'),
		);
		const menus = src.slice(
			src.indexOf('async function build_menus'),
			src.indexOf('function by_order'),
		);
		expect(access).toContain('store.scan(');
		expect(access).not.toContain('take: 20000');
		expect(menus).toContain('store.scan(');
		expect(menus).not.toContain('take: 20000');
	});

	test('record-rules load scans rules instead of taking 20000', () => {
		const src = readFileSync(new URL('./record-rules.ts', import.meta.url), 'utf8');
		const start = src.indexOf('export async function load_record_rules_by_model');
		const body = src.slice(start, src.indexOf('function literal('));
		expect(body).toContain('store.scan(');
		expect(body).not.toContain('take: 20000');
	});

	test('login catalogs and admin extras scan instead of taking 20000', () => {
		const group = readFileSync(new URL('./group-access.ts', import.meta.url), 'utf8');
		const dash = readFileSync(new URL('./dashboard-flow.ts', import.meta.url), 'utf8');
		const increment = readFileSync(
			new URL('./increment-normalize.ts', import.meta.url),
			'utf8',
		);
		const status = readFileSync(new URL('./status-options.ts', import.meta.url), 'utf8');
		const modules = readFileSync(new URL('./module-data.ts', import.meta.url), 'utf8');
		const mcp = readFileSync(new URL('./mcp-agent.ts', import.meta.url), 'utf8');
		const archived = readFileSync(
			new URL('./archived-login-alert.ts', import.meta.url),
			'utf8',
		);
		const subjects = readFileSync(new URL('./subjects-admin.ts', import.meta.url), 'utf8');
		for (const src of [group, dash, increment, status, modules, mcp, archived, subjects]) {
			expect(src).toContain('store.scan(');
			expect(src).not.toContain('take: 20000');
		}
		expect(subjects).toContain('async function collect_resource');
		expect(archived).toContain("find_where('user'");
	});

	test('agua metrics and field list scan instead of taking 20000', () => {
		const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
		const metricas = actions.slice(
			actions.indexOf('async function agua_build_metricas'),
			actions.indexOf('async function agua_public_contrato'),
		);
		const campo = actions.slice(
			actions.indexOf('async function agua_campo_contratos'),
			actions.indexOf('async function agua_archivar_periodo'),
		);
		const mssql = readFileSync(new URL('./agua-mssql.ts', import.meta.url), 'utf8');
		expect(metricas).toContain('store.scan(');
		expect(metricas).not.toContain('20_000');
		expect(campo).toContain('store.scan(');
		expect(campo).not.toContain('20_000');
		expect(mssql).toContain('store.count(');
		expect(mssql).not.toContain('20_000');
	});

	test('custom-pattern render scans lookups instead of taking 20000', () => {
		const src = readFileSync(
			new URL('./custom-pattern-render.ts', import.meta.url),
			'utf8',
		);
		expect(src).toContain('async function collect_scan');
		expect(src).not.toContain('take: 20000');
		expect(src).toContain('INCREMENT_LOOKUP_FIELDS');
		expect(src).toContain('fields: INCREMENT_LOOKUP_FIELDS');
		expect(src).not.toContain("'search_field'");
	});

	test('field_values_from_distinct keeps state labels without hydrating docs', () => {
		const options = field_values_from_distinct(
			['por_surtir', 'surtido'],
			'estado',
			{
				field_name: 'estado',
				enabled: true,
				read_only: false,
				values: [
					{
						value: 'por_surtir',
						type: 'primary',
						display_leyend: 'Por surtir',
						color: '',
					},
					{ value: 'surtido', type: 'success', display_leyend: 'Surtido', color: '' },
				],
			},
		);
		expect(options.find((option) => option.value === 'por_surtir')?.label).toBe('Por surtir');
	});
});
