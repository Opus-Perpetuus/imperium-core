/**
 * Acciones custom de Imperium, portadas a documentos SQL.
 * Cada handler replica la transición / efecto del service original.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { as_array, as_object, fail, ok, type ImperiumDoc } from './envelope.ts';
import { serve_attachment_bytes } from './media.ts';
import { query_list, read_imperium_body } from './body.ts';
import { qident, type ImperiumStore } from './store.ts';
import { SearchEngine, search_text_from_doc } from './search-engine.ts';
import { assert_pos_pin, verify_user_pin } from './user-pin.ts';
import { pac_provider, stamp_with_pac } from './pac.ts';
import {
	composed_codigo_from_path,
	expand_path_to_tree_lines,
	extract_path_from_row,
	normalize_alias_map,
	sanitize_location_segment,
} from './location-path.ts';
import { compose_location_code } from './location-flow.ts';
import {
	format_increment_real_value,
	resolve_increment_preview_target,
} from './custom-pattern-render.ts';
import { normalize_all_counters } from './increment-normalize.ts';
import { model_tracker_field_values } from './model-tracker-field-values.ts';
import { debug_read_logs, debug_read_related, debug_statistics } from './debug-log-flow.ts';
import { AguaMssqlService } from './agua-mssql.ts';
import { calcular_importe } from './agua-importe.ts';
import { looks_like_canonical, serialize_cfdi_to_xml, type CfdiCanonical } from './cfdi-xml.ts';
import { has_cfdi_errors, run_cfdi_validation } from './cfdi-validator.ts';
import { create_cfdi_from_invoice_request } from './cfdi-from-invoice.ts';
import { create_cfdi_from_payroll_receipt } from './cfdi-from-payroll.ts';
import { create_cfdi_from_purchase_order } from './cfdi-from-purchase.ts';
import { seal_canonical_with_csd } from './cfdi-seal.ts';
import { extract_structured, generate_text } from './ai-extraction.ts';
import { get_pdf_direct_target, send_pdf } from './pdf-direct.ts';
import {
	geocode_address,
	google_maps_api_key,
	optimize_google_routes,
	warehouse_origin,
	type GeoPoint,
} from './route-optimize.ts';
import {
	assert_interinstance_outbound,
	deny_interinstance,
	forward_interinstance,
	interinstance_key_from_req,
	messaging_settings,
	validate_interinstance_api_key,
} from './interinstance.ts';
import { mitec_create_link, mitec_decrypt_payload, mitec_parse_callback } from './mitec.ts';
import {
	email_is_configured,
	resolve_email_settings,
	send_password_reset_email,
} from './email.ts';
import { generate_password_reset } from './password-reset.ts';
import { reset_auth_rate_limits_for_email } from './auth-rate-limit.ts';
import {
	clear_notifications,
	delete_notification,
	mark_all_notifications,
	my_mentions,
	my_notifications,
	notify_message_recipients,
	notification_apply_action,
	notification_summary,
	notification_toast_digest,
	notification_update_read,
	register_comment_mentions,
	resolve_comment_mentioned_users,
} from './notifications.ts';
import { assert_target_model_read, build_access } from './auth.ts';
import {
	enrich_history_row,
	history_find_many_opts,
	history_page_limits,
	resolve_history_model,
} from './history.ts';
import {
	list_status_option_control,
	normalize_state_values,
	read_status_option_control,
	resolve_spurious_options,
	save_status_config,
} from './status-options.ts';
import {
	activate_module,
	delete_mock_data,
	force_recreate_data,
	generate_mock_data,
	install_module_data,
	migrate_legacy_modules,
	recreate_indexes,
} from './module-data.ts';
import { is_upload, persist_upload_as_attachment } from './uploads.ts';
import { emit_messages_refresh, last_driver_location } from './socket-stub.ts';
import {
	assert_report_template_write,
	hydrate_loose_product_references,
	hydrate_loose_product_references_many,
	interpolate_report_records,
	interpolate_report_template,
	iter_report_record_pages,
	render_report_from_pages,
	report_validation_ok,
} from './reports-flow.ts';
import {
	GROUP_REF_ALMACEN,
	GROUP_REF_SURTIDORES,
	actor_group_refs,
	is_seed_admin,
} from './group-access.ts';
import { emit_pedidos_updated, prepare_pedido_create } from './pedidos-flow.ts';
import {
	compute_picking_route,
	generate_replenishment_for_order,
} from './inventory-picking.ts';
import {
	after_delivery_package_mutate,
	cancel_delivery_package,
	list_packages_by_pedido,
} from './delivery-package-flow.ts';
import { decorate_delivery_routes } from './delivery-route-flow.ts';
import { register_package_delivery_exit } from './inventory-logistics-flow.ts';
import {
	apply_quant_delta,
	find_quant_for_pair,
	recibir_delivery_return,
	recompute_product_existencia,
} from './delivery-return-flow.ts';
import { apply_purchase_receipt_stock } from './purchase-order-flow.ts';
import { list_instance_type, project_list_docs } from './list-projection.ts';
import {
	acomodar_reception,
	create_reception_backorder,
	create_reception_from_purchase_order,
	ensure_pending_reception_from_purchase_order,
	in_transit_for_product,
	list_pending_for_product,
	register_internal_transfer,
	reservar_reception,
} from './inventory-reception-flow.ts';
import { apply_physical_count as apply_physical_count_doc } from './inventory-physical-count-flow.ts';
import { mark_lista_asistencia } from './lista-asistencia-flow.ts';
import { lookup_cobranza } from './cobranza-lookup-flow.ts';
import {
	apply_cobranza_payment,
	apply_online_cobranza_payment,
	cancel_cobranza_payment,
} from './cobranza-payment-flow.ts';
import {
	authorize_invoice_request,
	cancel_invoice_request,
	generate_invoice_from_order,
	mark_invoice_request,
	send_invoice_to_commercial,
} from './invoice-request-flow.ts';
import { resolve_dashboard_catalog, resolve_widget_data } from './dashboard-flow.ts';
import {
	export_payroll_payload,
	generate_payroll_drafts,
	prepare_payroll_stamp,
} from './payroll-flow.ts';
import {
	end_attending_turn as end_ticketing_turn,
	notify_turn as notify_ticketing_turn,
	take_next_turn as take_ticketing_turn,
} from './ticketing-turn-flow.ts';
import {
	assert_pos_runtime_writable,
	build_last_closure_reference,
	build_pos_session_report,
	cancel_pos_session_patch,
	conclude_pos_session_patch,
	is_pos_session_open,
	normalize_pos_runtime_state,
	POS_REPORT_CLOSE,
	POS_REPORT_PARTIAL,
	preview_pos_consecutive,
} from './pos-session-flow.ts';
import {
	create_error_ticket,
	create_interinstance_ticket,
	create_internal_ticket,
	create_log_ticket,
	create_public_ticket,
	read_my_tickets,
	read_received_interinstance_tickets,
	receive_interinstance_ticket,
	tickets_admin_list,
	tickets_admin_one,
	tickets_field_values,
	tickets_public_metadata,
	update_ticket,
} from './tickets-flow.ts';

type Ctx = {
	store: ImperiumStore;
	sql: Bun.SQL;
	req: Request;
	url: URL;
	resource: string;
	action: string;
	params: Record<string, string>;
	actor: ImperiumDoc | null;
	body: Record<string, unknown>;
};

async function collect_scan(
	store: ImperiumStore,
	resource: string,
	opts: {
		where?: Record<string, unknown>;
		mongo_match?: Record<string, unknown> | null;
		include_inactive?: boolean;
		page_size?: number;
		q?: string;
		/** Payload recortado. El set se devuelve entero. */
		fields?: string[];
		/** Set entero salvo estas claves pesadas. */
		omit?: string[];
	} = {},
): Promise<ImperiumDoc[]> {
	const out: ImperiumDoc[] = [];
	for await (const page of store.scan(resource, opts)) out.push(...page);
	return out;
}

export async function handle_action(
	store: ImperiumStore,
	sql: Bun.SQL,
	req: Request,
	url: URL,
	resource: string,
	action: string,
	params: Record<string, string>,
	actor: ImperiumDoc | null,
): Promise<Response> {
	const ctx: Ctx = {
		store,
		sql,
		req,
		url,
		resource,
		action,
		params,
		actor,
		body: await read_imperium_body(req),
	};
	const data = await dispatch(ctx);
	if (data instanceof Response) return data;
	return Response.json(data);
}

async function dispatch(ctx: Ctx): Promise<unknown | Response> {
	const key = `${ctx.resource}:${ctx.action}`;
	switch (key) {
		case 'cfdi-catalog:lookup':
			return catalog_lookup(ctx);
		case 'cfdi-catalog:search':
			return catalog_search(ctx);
		case 'cfdi-catalog:seed_samples':
			return catalog_seed_samples(ctx);
		case 'cfdi-document:from_invoice_request':
			return create_cfdi_from_invoice_request(ctx);
		case 'cfdi-document:from_payroll_receipt':
			return create_cfdi_from_payroll_receipt(ctx);
		case 'cfdi-document:from_purchase_order':
			return create_cfdi_from_purchase_order(ctx);
		case 'cfdi-document:validate_document':
			return cfdi_validate(ctx);
		case 'cfdi-document:stamp_document':
			return cfdi_stamp(ctx);
		case 'cfdi-document:export_xml':
			return cfdi_export(ctx, 'xml');
		case 'cfdi-document:export_json':
			return cfdi_export(ctx, 'json');
		case 'auto-increment-control:increment':
			return increment_counter(ctx);
		case 'auto-increment-control:preview':
			return preview_counter(ctx);
		case 'auto-increment-control:get_available_models':
			return ok(
				ctx.store.available_mongoose_models(),
				'Modelos disponibles cargados correctamente.',
			);
		case 'auto-increment-control:consolidate_duplicates':
			return increment_consolidate(ctx);
		case 'auto-increment-control:normalize_counters':
			return normalize_counters(ctx);
		case 'configuration:ai_generate_text':
			return ai_generate_text(ctx);
		case 'custom-pattern-increment-sequence-parts:get_by_counter_config':
			return pattern_parts_by_counter(ctx);
		case 'interface-restriction:runtime_read':
			return interface_restriction_runtime(ctx);
		case 'status-option-control:read_list':
			return list_status_option_control(ctx);
		case 'status-option-control:read_one':
			return read_status_option_control(ctx);
		case 'auto-increment-control:read_list':
			return list_auto_increment_controls(ctx);
		case 'status-option-control:save_module_configuration':
			return save_status_config(ctx);
		case 'status-option-control:normalize_state_values':
			return normalize_state_values(ctx);
		case 'status-option-control:resolve_spurious_options':
			return resolve_spurious_options(ctx);
		case 'lista-asistencia:mark_attendance':
			return mark_attendance(ctx);
		case 'debug-log:read_logs':
			return debug_read_logs(ctx.store, ctx.url);
		case 'debug-log:get_statistics':
			return debug_statistics(ctx.store, ctx.url);
		case 'debug-log:read_related_request_log':
			return debug_read_related(ctx.store, ctx.url);
		case 'debug-log:read_log_by_id':
			return debug_read_one(ctx);
		case 'delivery-package:read_offline_catalog':
			return delivery_offline_catalog(ctx);
		case 'delivery-package:read_load_manifest':
			return read_load_manifest(ctx);
		case 'delivery-package:read_by_pedido':
			return read_packages_by_pedido(ctx);
		case 'delivery-package:read_chofer_queue':
			return read_chofer_queue(ctx);
		case 'delivery-package:close_empaque':
			return close_empaque(ctx);
		case 'delivery-package:apply_logistics_event':
			return logistics_event(ctx);
		case 'delivery-package:cancel_package': {
			const cancelled = await cancel_delivery_package(
				ctx.store,
				ctx.params.id,
				String(ctx.body.reason ?? ''),
			);
			return ok(
				[cancelled],
				'Bulto anulado. Las cantidades quedan disponibles para reempacar.',
			);
		}
		case 'delivery-return:recibir': {
			const received = await recibir_delivery_return(
				ctx.store,
				ctx.params.id,
				String(ctx.body.ubicacion ?? ctx.body.ubicacion_id ?? ''),
				ctx.actor,
			);
			return ok([received], 'Devolución recibida en almacén correctamente');
		}
		case 'delivery-route:read_route_map':
			return delivery_route_map(ctx);
		case 'delivery-route:read_chofer_routes':
			return delivery_chofer_routes(ctx);
		case 'delivery-route:optimize_route':
			return optimize_route(ctx);
		case 'delivery-route:read_driver_location':
			return read_driver_location(ctx);
		case 'document-change-history:create_comment':
			return create_history_comment(ctx);
		case 'document-change-history:read_history':
			return read_history(ctx);
		case 'document-change-history:read_history_by_id':
			return read_history_by_id(ctx);
		case 'documentation-page:read_all':
			return documentation_read_all(ctx);
		case 'documentation-page:get_structure':
			return documentation_structure(ctx);
		case 'documentation-page:search':
			return documentation_search(ctx);
		case 'documentation-page:check_sync_status':
			return documentation_sync_status(ctx);
		case 'documentation-page:sync_documents':
			return documentation_sync(ctx);
		case 'documentation-page:read_by_slug':
			return documentation_read_one(ctx, {
				slug: ctx.params.slug,
				folder: ctx.url.searchParams.get('folder') ?? '',
			});
		case 'documentation-page:get_adjacent':
			return documentation_adjacent(ctx);
		case 'documentation-page:read_by_id':
			return documentation_read_one(ctx, { id: ctx.params.id });
		case 'dynamic-dashboard:catalog':
			return dashboard_catalog(ctx);
		case 'dynamic-dashboard:widget_data':
			return widget_data(ctx);
		case 'dynamic-dashboard:ai_query':
			return dashboard_ai_query(ctx);
		case 'interactive-manual:board':
			return interactive_manual_board(ctx);
		case 'inventory-internal-location:import_tree':
			return import_location_tree(ctx);
		case 'inventory-movement:register_transfer':
			return register_transfer(ctx);
		case 'inventory-physical-count:import_apertura':
			return import_apertura(ctx);
		case 'inventory-physical-count:aplicar':
			return apply_physical_count(ctx);
		case 'inventory-reception:read_in_transit':
			return ok(
				[await in_transit_for_product(ctx.store, ctx.params.producto_id)],
				'Cantidad en camino calculada correctamente',
			);
		case 'inventory-reception:read_pending_for_product':
			return ok(
				await list_pending_for_product(ctx.store, ctx.params.producto_id),
				'Recepciones en camino del producto',
			);
		case 'inventory-reception:create_from_purchase_order':
			return reception_from_po(ctx);
		case 'inventory-reception:confirm_reception':
			return confirm_reception(ctx);
		case 'inventory-reception:create_backorder':
			return create_backorder(ctx);
		case 'inventory-reception:acomodar':
			return acomodar(ctx);
		case 'inventory-reception:reservar':
			return reservar(ctx);
		case 'inventory-stock-quant:read_picking_route':
			return picking_route(ctx);
		case 'inventory-stock-quant:validar_consistencia':
			return stock_consistency(ctx);
		case 'invoice-request:generate_from_order':
			return invoice_from_order(ctx);
		case 'invoice-request:authorize':
			return invoice_authorize(ctx);
		case 'invoice-request:send_to_commercial':
			return invoice_send_commercial(ctx);
		case 'invoice-request:mark_invoiced':
			return invoice_mark(ctx);
		case 'invoice-request:link_cfdi_document':
			return invoice_link_cfdi(ctx);
		case 'invoice-request:request_cfdi_draft':
			return invoice_cfdi_draft(ctx);
		case 'invoice-request:cancel_request':
			return ok(
				[await cancel_invoice_request(ctx.store, ctx.params.id, ctx.body.motivo)],
				'Solicitud cancelada',
			);
		case 'messages:read_my_messages':
			return my_messages(ctx);
		case 'messages:read_my_conversations':
			return my_conversations(ctx);
		case 'messages:read_conversation':
			return conversation(ctx);
		case 'messages:search_chat_messages':
			return search_chat_messages(ctx);
		case 'messages:create_chat_message':
			return create_chat_message(ctx);
		case 'messages:create_internal_message':
			return create_internal_message(ctx);
		case 'messages:create_interinstance_message':
			return create_interinstance_message(ctx);
		case 'messages:receive_interinstance_message':
			return receive_interinstance_message(ctx);
		case 'module-management:recreate_indexes':
			return recreate_indexes(ctx);
		case 'module-management:activate_module':
			return activate_module(ctx);
		case 'module-management:deactivate_module':
			return patch_doc(ctx, 'module-management', ctx.params.id, { is_enable: false }, 'Operación completada exitosamente');
		case 'module-management:force_recreate_data':
			return force_recreate_data(ctx);
		case 'module-management:install_module_data':
			return install_module_data(ctx);
		case 'module-management:generate_mock_data':
			return generate_mock_data(ctx);
		case 'module-management:delete_mock_data':
			return delete_mock_data(ctx);
		case 'module-management:migrate_legacy_modules':
			return migrate_legacy_modules(ctx);
		case 'payroll-period:generate_drafts':
			return payroll_drafts(ctx);
		case 'payroll-receipt:prepare_stamp':
			return payroll_prepare_stamp(ctx);
		case 'payroll-receipt:export_payload':
			return payroll_export_payload(ctx);
		case 'notifications:read_my_summary':
			return notification_summary(ctx);
		case 'notifications:read_my_notifications':
			return my_notifications(ctx);
		case 'notifications:read_my_mentions':
			return my_mentions(ctx);
		case 'notifications:create_toast_digest':
			return notification_toast_digest(ctx);
		case 'notifications:mark_all_as_read':
			return mark_all_notifications(ctx);
		case 'notifications:update_read_status':
			return notification_update_read(ctx);
		case 'notifications:apply_action':
			return notification_apply_action(ctx);
		case 'notifications:clear_my_notifications':
			return clear_notifications(ctx);
		case 'notifications:delete_notification':
			return delete_notification(ctx);
		case 'pedidos:reclamar_surtir':
			return reclamar_surtir(ctx);
		case 'pedidos:sync_offline':
			return pedidos_sync_offline(ctx);
		case 'lista-de-precios:sync_offline':
			return lista_de_precios_sync_offline(ctx);
		case 'sku:sync_offline':
			return sku_sync_offline(ctx);
		case 'pos-session:get_next_consecutive':
			return pos_next_consecutive(ctx);
		case 'pos-session:get_last_closure_reference':
			return pos_last_closure(ctx);
		case 'pos-session:save_runtime_state':
			return pos_runtime(ctx);
		case 'pos-session:generate_partial_report':
			return pos_report(ctx, 'parcial');
		case 'pos-session:generate_close_report':
			return pos_report(ctx, 'cierre');
		case 'pos-session:conclude_close_report':
			return pos_conclude(ctx);
		case 'pos-session:cancel_open_session':
			return pos_cancel(ctx);
		case 'purchase-order:approve':
			return po_approve(ctx);
		case 'purchase-order:register_receipt':
		case 'purchase-order:confirm':
			return po_receive(ctx, ctx.action === 'confirm');
		case 'purchase-order:register_invoice':
			return po_register_invoice(ctx);
		case 'purchase-order:replenish_from_order':
			return po_replenish(ctx);
		case 'purchase-order:parse_document':
			return purchase_order_parse_document(ctx);
		case 'reports:get_first_record':
			return report_first(ctx);
		case 'reports:get_model_fields':
			return report_fields(ctx, false);
		case 'reports:get_model_fields_detailed':
			return report_fields(ctx, true);
		case 'reports:get_model_records':
			return report_records(ctx);
		case 'reports:get_model_record_by_id':
			return report_record(ctx);
		case 'reports:validate_template':
			return report_validate(ctx);
		case 'reports:get_image_base64':
			return attachment_base64(ctx, ctx.params.attach_id);
		case 'reports:generate_pdf':
			return report_pdf(ctx);
		case 'reports:generate_full_report_pdf':
			return report_full_pdf(ctx);
		case 'reports:process_preview':
			return report_preview(ctx);
		case 'reports:get_pdf_direct_target':
			return reports_pdf_direct_target(ctx);
		case 'reports:print_pdf_direct':
			return reports_print_pdf_direct(ctx);
		case 'tickets:read_admin_tickets':
			return tickets_admin_list(ctx);
		case 'tickets:read_admin_ticket':
			return tickets_admin_one(ctx);
		case 'tickets:read_ticket_field_values':
			return tickets_field_values(ctx);
		case 'tickets:read_public_metadata':
			return tickets_public_metadata(ctx);
		case 'tickets:create_public_ticket':
			return create_public_ticket(ctx);
		case 'tickets:create_internal_ticket':
			return create_internal_ticket(ctx);
		case 'tickets:create_error_ticket':
			return create_error_ticket(ctx);
		case 'tickets:create_log_ticket':
			return create_log_ticket(ctx);
		case 'tickets:create_interinstance_ticket':
			return create_interinstance_ticket(ctx);
		case 'tickets:receive_interinstance_ticket':
			return receive_interinstance_ticket(ctx);
		case 'tickets:read_received_interinstance_tickets':
			return read_received_interinstance_tickets(ctx);
		case 'tickets:update_ticket':
			return update_ticket(ctx);
		case 'tickets:read_my_tickets':
			return read_my_tickets(ctx);
		case 'user:recovery_link':
			return user_recovery(ctx);
		case 'user:unlock_auth':
			return user_unlock_auth(ctx);
		case 'user-pin:verify':
			return verify_pin(ctx);
		case 'user-settings:get':
			return user_settings_get(ctx);
		case 'user-settings:upsert':
			return user_settings_upsert(ctx);
		case 'user-settings:set_global_default_theme':
			return user_settings_global_theme(ctx);
		case 'user-settings:save_table_config':
			return user_settings_table_config(ctx);
		case 'user-settings:list_custom_themes':
			return custom_themes_list(ctx);
		case 'user-settings:create_custom_theme':
			return custom_themes_create(ctx);
		case 'user-settings:update_custom_theme':
			return custom_themes_update(ctx);
		case 'user-settings:delete_custom_theme':
			return custom_themes_delete(ctx);
		case 'view-config-preset:available':
			return view_available(ctx);
		case 'view-config-preset:baseline':
			return view_baseline(ctx);
		case 'view-config-preset:assign':
			return view_assign(ctx);
		case 'cobranza-payment:apply_payment':
			return apply_cobranza_payment(ctx);
		case 'cobranza-payment:cancel_payment':
			return cancel_cobranza_payment(ctx);
		case 'cobranza:mitec_webhook':
			return cobranza_mitec_webhook(ctx);
		case 'cobranza:stripe_webhook':
			return cobranza_stripe_webhook(ctx);
		case 'cobranza:lookup':
			return cobranza_lookup(ctx);
		case 'cobranza:checkout':
			return cobranza_checkout(ctx);
		case 'medical-file:read_pending':
			return medical_pending(ctx);
		case 'medical-file:read_for_doctor':
			return medical_for_doctor(ctx);
		case 'ticketing-system-turn:take_next_turn':
			return take_next_turn(ctx);
		case 'ticketing-system-turn:notify_turn':
			return notify_turn(ctx);
		case 'ticketing-system-turn:end_attending_turn':
			return end_attending_turn(ctx);
		case 'citizen-report:reverse_geocode':
			return reverse_geocode(ctx);
		case 'violation:challenge':
			return violation_challenge(ctx);
		case 'attachment-management:view':
			return attachment_view(ctx);
		case 'payments:public_catalog':
			return payments_catalog(ctx);
		case 'payments:public_checkout':
			return payments_checkout(ctx);
		case 'payments:public_session':
			return payments_session(ctx);
		case 'payments:stripe_webhook':
			return payments_webhook(ctx);
		case 'agua:public_contrato':
			return agua_public_contrato(ctx);
		case 'agua:public_url':
			return agua_public_url(ctx);
		case 'agua:sync_estado':
			return agua_sync_estado(ctx);
		case 'agua:sync_catalogos':
			return agua_sync_catalogos(ctx);
		case 'agua:sync_contratos':
			return agua_sync_contratos(ctx);
		case 'agua:sync_rutas':
			return agua_sync_rutas(ctx);
		case 'agua:sync_tarifas':
			return agua_sync_tarifas(ctx);
		case 'agua:push_lectura':
			return agua_push_lectura(ctx);
		case 'agua:push_lecturas_lote':
			return agua_push_lecturas_lote(ctx);
		case 'agua:campo_contratos':
			return agua_campo_contratos(ctx);
		case 'agua:archivar_periodo':
			return agua_archivar_periodo(ctx);
		case 'agua:metricas':
			return agua_metricas(ctx);
		case 'agua:reportes':
			return agua_reportes(ctx);
		case 'agua:print_mode':
			return agua_print_mode(ctx);
		case 'physical-device:report':
			return physical_device_report(ctx);
		case 'model-tracker:get_all_models':
			return model_tracker_all_models(ctx);
		case 'model-tracker:get_search_engine_status':
			return model_tracker_search_status(ctx);
		case 'model-tracker:read_field_values_globally':
			return model_tracker_field_values(ctx);
		case 'model-tracker:trigger_reindex':
			return model_tracker_reindex(ctx);
		default:
			return generic_action(ctx);
	}
}

function now() {
	return new Date().toISOString();
}
function ref_id(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return String((value as { _id?: unknown })._id ?? '');
	return String(value).trim();
}
function actor_name(ctx: Ctx) {
	return String(ctx.actor?.name ?? ctx.actor?.email ?? '');
}
function actor_id(ctx: Ctx) {
	return String(ctx.actor?._id ?? '');
}

function id_list(value: unknown): string[] {
	return as_array(value)
		.map((item) => {
			if (item && typeof item === 'object') {
				const rec = item as Record<string, unknown>;
				return String(rec._id ?? rec.id ?? '');
			}
			return String(item ?? '');
		})
		.filter(Boolean);
}

function has_id(value: unknown, id: string): boolean {
	return Boolean(id) && id_list(value).includes(id);
}

function intersects_ids(value: unknown, ids: string[]): boolean {
	if (!ids.length) return false;
	const set = new Set(id_list(value));
	return ids.some((id) => set.has(id));
}

function merge_unique_ids(...lists: unknown[]): string[] {
	return [...new Set(lists.flatMap((list) => id_list(list)))];
}

function updated_ms(doc: ImperiumDoc): number {
	const t = new Date(String(doc.updatedAt ?? doc.updated_at ?? '')).getTime();
	return Number.isFinite(t) ? t : 0;
}

function sort_by_name(rows: ImperiumDoc[]): ImperiumDoc[] {
	return [...rows].sort((a, b) =>
		String(a.name ?? '').localeCompare(String(b.name ?? ''), 'es'),
	);
}

function sort_by_updated_desc(rows: ImperiumDoc[]): ImperiumDoc[] {
	return [...rows].sort((a, b) => updated_ms(b) - updated_ms(a));
}

async function actor_access(ctx: Ctx) {
	if (!ctx.actor) {
		return {
			has_full_access: false,
			user_group_ids: [] as string[],
			models: [] as string[],
		};
	}
	return build_access(ctx.store, ctx.actor);
}

async function can_manage_other_user_auth(ctx: Ctx): Promise<boolean> {
	if (String(ctx.actor?._ref ?? '') === 'user-menu-management-0') return true;
	const access = await actor_access(ctx);
	if (access.has_full_access) return true;
	const perms = (access as { permissions_by_model?: Record<string, { allow_update?: boolean }> })
		.permissions_by_model;
	return Boolean(perms?.User?.allow_update);
}

async function one(ctx: Ctx, resource: string, id: string) {
	const doc = await ctx.store.find_id(resource, id);
	if (!doc) throw new Error('No encontrado');
	return ok([doc], 'Ruta encontrada');
}

async function one_where(ctx: Ctx, resource: string, where: Record<string, unknown>) {
	const doc = await ctx.store.find_where(resource, where);
	if (!doc) throw new Error('No encontrado');
	return ok([doc], 'Ruta encontrada');
}

async function list_resource(ctx: Ctx, resource: string) {
	const { rows, total } = await ctx.store.find_many(resource, {
		q: ctx.url.searchParams.get('termino') ?? '',
		skip: Number(ctx.url.searchParams.get('desde') ?? 0),
		take: Number(ctx.url.searchParams.get('limite') ?? 100),
	});
	return ok(rows, 'Ruta encontrada', total);
}

async function list_where(ctx: Ctx, resource: string, where: Record<string, unknown>) {
	const clean = Object.fromEntries(Object.entries(where).filter(([, v]) => v !== ''));
	const { rows, total } = await ctx.store.find_many(resource, { where: clean, take: 500 });
	return ok(rows, 'Ruta encontrada', total);
}

async function pattern_parts_by_counter(ctx: Ctx) {
	const counter_config_id = String(ctx.params.counter_config_id ?? '').trim();
	if (!counter_config_id) throw new Error('Debes indicar el contador padre.');
	if (!ctx.store.has('custom-pattern-increment-sequence-parts')) {
		return ok([], 'Partes del patrón cargadas correctamente.', 0);
	}
	const rows = await collect_scan(ctx.store, 'custom-pattern-increment-sequence-parts', {
		where: { counter_config_id },
	});
	const ordered = [...rows].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
	return ok(ordered, 'Partes del patrón cargadas correctamente.', ordered.length);
}

/**
 * Lista activa para el watcher de UI. Mismo contrato que el original:
 * solo sesión (sin ACL del módulo) y los filtros/orden del query del front.
 */
async function interface_restriction_runtime(ctx: Ctx) {
	const q = query_list(ctx.url);
	const { rows, total } = await ctx.store.find_many('interface-restriction', {
		q: q.q,
		skip: q.skip,
		take: q.take || 5000,
		sort: q.sort || 'html_element_hash:asc',
		where: Object.keys(q.where).length ? q.where : undefined,
		include_inactive: q.include_inactive,
	});
	return ok(rows, 'Ruta encontrada', total);
}

async function patch_doc(
	ctx: Ctx,
	resource: string,
	id: string,
	patch: ImperiumDoc,
	message: string,
) {
	if (!id) throw new Error('Se necesita el id');
	const updated = await ctx.store.update(resource, id, patch);
	if (!updated) throw new Error('No se encontró el documento');
	return ok([updated], message);
}

async function delete_one(ctx: Ctx, resource: string, id: string) {
	const deleted = await ctx.store.remove(resource, id);
	if (!deleted) throw new Error('No encontrado');
	return ok([deleted], 'Eliminado correctamente');
}

async function generic_action(ctx: Ctx) {
	const id = ctx.params.id ?? String(ctx.body._id ?? ctx.body.id ?? '');
	if (id && ctx.store.has(ctx.resource)) {
		return patch_doc(ctx, ctx.resource, id, {
			...ctx.body,
			ultima_accion: ctx.action,
			fecha_accion: now(),
		}, `Acción ${ctx.action} aplicada`);
	}
	throw new Error(`Acción no implementada: ${ctx.resource}:${ctx.action}`);
}

async function catalog_lookup(ctx: Ctx) {
	const catalog = String(ctx.url.searchParams.get('catalog') ?? ctx.body.catalog ?? '').trim();
	const code = String(
		ctx.url.searchParams.get('code') ??
			ctx.url.searchParams.get('key') ??
			ctx.body.code ??
			ctx.body.key ??
			'',
	).trim();
	if (!catalog || !code) return ok([], 'Clave no encontrada', 0);
	const { rows } = await ctx.store.find_many('cfdi-catalog', {
		where: { catalog, code },
		take: 5,
		populate: false,
	});
	const row = rows[0] ?? null;
	return ok(row ? [row] : [], row ? 'Clave encontrada' : 'Clave no encontrada', row ? 1 : 0);
}

function cfdi_samples_dir() {
	const from_catalog = process.env.CATALOG_PATH
		? join(dirname(process.env.CATALOG_PATH), '../backend/src/components/cfdi/cfdi-catalog/data/samples')
		: '';
	const candidates = [process.env.CFDI_SAMPLES_DIR, from_catalog].filter(Boolean) as string[];
	return candidates.find((p) => existsSync(p)) ?? '';
}

async function catalog_seed_samples(ctx: Ctx) {
	const dir = cfdi_samples_dir();
	if (!dir) return ok([], 'No hay paquetes de catálogo SAT en el núcleo');
	const files = readdirSync(dir).filter((f) => f.startsWith('c_') && f.endsWith('.json'));
	const have = new Set<string>();
	for await (const page of ctx.store.scan('cfdi-catalog', { include_inactive: true })) {
		for (const row of page) have.add(String(row._ref ?? row.ref ?? ''));
	}
	let seeded = 0;
	let skipped = 0;
	for (const file of files) {
		const catalog = file.slice(0, -5);
		const rows = as_array(JSON.parse(readFileSync(join(dir, file), 'utf8')));
		for (const raw of rows) {
			const row = as_object(raw);
			const code = String(row.code ?? '').trim();
			if (!code) continue;
			const description = String(row.description ?? row.texto ?? code).trim();
			const ref = `cfdi-catalog-${catalog}-${code}`;
			if (have.has(ref)) {
				skipped += 1;
				continue;
			}
			try {
				await ctx.store.insert('cfdi-catalog', {
					name: description !== code ? `${code} — ${description}`.slice(0, 500) : code,
					catalog,
					code,
					description,
					is_active: true,
					_ref: ref,
				});
				seeded += 1;
				have.add(ref);
			} catch (err) {
				if (String(err).includes('duplicate')) {
					skipped += 1;
					continue;
				}
				throw err;
			}
		}
	}
	return ok([{ seeded, skipped }], `Catálogo SAT sembrado (${seeded})`);
}

async function catalog_search(ctx: Ctx) {
	const catalog = String(ctx.url.searchParams.get('catalog') ?? '').trim();
	const term = String(
		ctx.url.searchParams.get('q') ?? ctx.url.searchParams.get('termino') ?? '',
	).trim();
	const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit') ?? 20) || 20, 1), 100);
	const { rows } = await ctx.store.find_many('cfdi-catalog', {
		where: { catalog },
		q: term || undefined,
		take: limit,
		sort: 'code:asc',
		populate: false,
		skip_total: true,
		list_project: true,
	});
	return ok(rows, 'Búsqueda de catálogo', rows.length);
}

async function cfdi_validate(ctx: Ctx) {
	const doc = await need(
		ctx,
		'cfdi-document',
		ctx.params.id,
		'No se encontró el documento CFDI.',
		'Debes indicar el identificador del documento CFDI.',
	);
	const canonical = as_object(doc.canonical ?? doc.payload_canonico);
	if (!looks_like_canonical(canonical)) {
		throw new Error('El documento no tiene un payload canónico para validar.');
	}
	const issues = await run_cfdi_validation(ctx.store, canonical);
	const status = has_cfdi_errors(issues) ? 'invalid' : 'valid';
	const next_canonical = {
		...canonical,
		meta: {
			...(canonical.meta ?? {}),
			validation: { status, errors: issues },
		},
	};
	const updated = await ctx.store.update('cfdi-document', String(doc._id), {
		status,
		estado: status,
		validado: status === 'valid',
		canonical: next_canonical,
		payload_canonico: next_canonical,
		validation_issues: issues,
		errores_validacion: issues,
		fecha_validacion: now(),
	});
	return ok(
		[updated],
		status === 'valid'
			? 'Documento CFDI válido según las reglas actuales'
			: 'Documento CFDI con errores o advertencias de validación',
	);
}

async function sync_cfdi_source_stamp(
	store: ImperiumStore,
	doc: ImperiumDoc,
	status: 'stamped' | 'stamp_error',
	stamp?: { uuid?: string },
) {
	const source_id = String(doc.source_id ?? doc.origen_id ?? '');
	if (!source_id) return;
	const origen = String(doc.origen ?? '');
	const source_type =
		String(doc.source_type ?? '').trim() ||
		(origen === 'invoice-request' ? 'invoice_request' : '') ||
		(origen === 'payroll-receipt' ? 'payroll_receipt' : '');
	if (source_type === 'invoice_request' && store.has('invoice-request')) {
		await store.update(
			'invoice-request',
			source_id,
			status === 'stamped'
				? {
						cfdi_document_id: doc._id,
						cfdi_document_status: 'stamped',
						cfdi_document_name: doc.name,
					}
				: { cfdi_document_status: 'stamp_error' },
		);
	}
	if (source_type === 'payroll_receipt' && store.has('payroll-receipt')) {
		await store.update(
			'payroll-receipt',
			source_id,
			status === 'stamped'
				? {
						cfdi_document_id: String(doc._id),
						uuid_fiscal: stamp?.uuid,
						estado: 'stamped',
					}
				: { estado: 'stamp_error' },
		);
	}
}

async function cfdi_stamp(ctx: Ctx) {
	const doc = await need(
		ctx,
		'cfdi-document',
		ctx.params.id,
		'No se encontró el documento CFDI.',
		'Debes indicar el identificador del documento CFDI.',
	);
	const canonical = as_object(doc.canonical ?? doc.payload_canonico);
	if (!looks_like_canonical(canonical)) {
		throw new Error('El documento no tiene payload canónico para timbrar.');
	}
	const issues = await run_cfdi_validation(ctx.store, canonical);
	if (has_cfdi_errors(issues)) {
		await ctx.store.update('cfdi-document', String(doc._id), {
			status: 'invalid',
			estado: 'invalid',
			validado: false,
			validation_issues: issues,
			errores_validacion: issues,
		});
		throw new Error('El CFDI tiene errores de validación; corrígelos antes de timbrar.');
	}

	let working = {
		...canonical,
		comprobante: { ...as_object(canonical.comprobante) },
	} as Record<string, unknown>;
	const private_key_pem = String(ctx.body.private_key_pem ?? '').trim();
	if (private_key_pem) {
		const comprobante = { ...as_object(working.comprobante) };
		const { sello } = seal_canonical_with_csd(
			working as CfdiCanonical,
			private_key_pem,
			String(ctx.body.passphrase ?? '') || undefined,
		);
		comprobante.sello = sello;
		if (ctx.body.no_certificado) comprobante.no_certificado = String(ctx.body.no_certificado);
		if (ctx.body.certificado) comprobante.certificado = String(ctx.body.certificado);
		working = { ...working, comprobante };
	}

	const xml = serialize_cfdi_to_xml(working as CfdiCanonical);
	await ctx.store.update('cfdi-document', String(doc._id), {
		status: 'stamping',
		estado: 'stamping',
	});
	try {
		const stamp = await stamp_with_pac(xml);
		const provider = pac_provider() || 'mock';
		const comprobante = as_object(working.comprobante);
		const stamped_canonical = {
			...working,
			complemento: {
				...as_object(working.complemento),
				timbre_fiscal_digital: {
					version: '1.1',
					uuid: stamp.uuid,
					fecha_timbrado: stamp.fecha_timbrado,
					rfc_prov_certif: stamp.rfc_prov_certif ?? provider,
					sello_cfd: comprobante.sello ?? '',
					no_certificado_sat: stamp.no_certificado_sat ?? '',
					sello_sat: stamp.sello_sat ?? '',
				},
			},
			meta: {
				...as_object(working.meta),
				validation: { status: 'stamped', errors: [] },
			},
		};
		const updated = await ctx.store.update('cfdi-document', String(doc._id), {
			status: 'stamped',
			estado: 'stamped',
			validado: true,
			canonical: stamped_canonical,
			payload_canonico: stamped_canonical,
			uuid: stamp.uuid,
			fecha_timbrado: stamp.fecha_timbrado,
			xml: stamp.xml_timbrado,
			xml_timbrado: stamp.xml_timbrado,
			pac: String(provider).toLowerCase(),
			rfc_prov_certif: stamp.rfc_prov_certif,
			no_certificado_sat: stamp.no_certificado_sat,
			sello_sat: stamp.sello_sat,
			validation_issues: [],
			errores_validacion: [],
		});
		await sync_cfdi_source_stamp(
			ctx.store,
			{ ...doc, ...(updated ?? {}), name: updated?.name ?? doc.name },
			'stamped',
			stamp,
		);
		return ok([updated], `CFDI timbrado (${provider}): ${stamp.uuid}`);
	} catch (err) {
		await ctx.store.update('cfdi-document', String(doc._id), {
			status: 'stamp_error',
			estado: 'stamp_error',
		});
		await sync_cfdi_source_stamp(ctx.store, doc, 'stamp_error');
		throw err;
	}
}

async function cfdi_export(ctx: Ctx, kind: 'xml' | 'json') {
	const doc = await need(
		ctx,
		'cfdi-document',
		ctx.params.id,
		'No se encontró el documento CFDI.',
		'Debes indicar el identificador del documento CFDI.',
	);
	const canonical = as_object(doc.canonical ?? doc.payload_canonico);
	if (kind === 'xml') {
		if (!looks_like_canonical(canonical)) {
			throw new Error('El documento no tiene un payload canónico para exportar a XML.');
		}
		const xml = serialize_cfdi_to_xml(canonical);
		const serie = String(canonical.comprobante?.serie ?? '');
		const folio = String(canonical.comprobante?.folio ?? '');
		const base =
			serie || folio
				? `cfdi_${serie}${serie && folio ? '-' : ''}${folio}`
				: `cfdi_${doc._id}`;
		const filename = `${base}.xml`;
		const as_download =
			ctx.url.searchParams.get('download') === '1' ||
			ctx.url.searchParams.get('raw') === '1';
		if (as_download) {
			return new Response(xml, {
				headers: {
					'content-type': 'application/xml; charset=utf-8',
					'content-disposition': `attachment; filename="${filename}"`,
				},
			});
		}
		return ok([{ xml, filename }], 'XML CFDI generado correctamente');
	}
	if (!Object.keys(canonical).length) {
		throw new Error('El documento no tiene un payload canónico para exportar a JSON.');
	}
	const as_download =
		ctx.url.searchParams.get('download') === '1' || ctx.url.searchParams.get('raw') === '1';
	if (as_download) {
		return new Response(JSON.stringify(canonical), {
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'content-disposition': `attachment; filename="cfdi_${doc._id}.json"`,
			},
		});
	}
	return ok([{ json: canonical, filename: `cfdi_${doc._id}.json` }], 'JSON CFDI generado correctamente');
}

async function ai_generate_text(ctx: Ctx) {
	const text = await generate_text(ctx.store, {
		instruction: String(ctx.body.instruction ?? ctx.body.prompt ?? ''),
		context_text: ctx.body.context_text ? String(ctx.body.context_text) : undefined,
	});
	return ok([{ text }], 'Texto generado correctamente');
}

const PO_PARSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['proveedor_nombre', 'articulos'],
	properties: {
		proveedor_nombre: { type: 'string' },
		proveedor_rfc: { type: 'string' },
		referencia_origen: { type: 'string' },
		uuid_xml: { type: 'string' },
		fecha_documento: { type: 'string' },
		articulos: {
			type: 'array',
			items: {
				type: 'object',
				required: ['producto_nombre', 'cantidad', 'costo_unitario'],
				properties: {
					producto_codigo: { type: 'string' },
					producto_nombre: { type: 'string' },
					cantidad: { type: 'number' },
					costo_unitario: { type: 'number' },
					importe: { type: 'number' },
				},
			},
		},
	},
};

async function purchase_order_parse_document(ctx: Ctx) {
	const content_base64 = String(ctx.body.content_base64 ?? '').trim();
	if (!content_base64) {
		throw new Error('Se necesita el contenido del documento (base64)');
	}
	const filename = String(ctx.body.filename ?? 'documento.pdf');
	const mime = String(ctx.body.mime ?? 'application/pdf');
	const extracted = await extract_structured(ctx.store, {
		instructions:
			'Extrae los datos de esta factura/documento de compra (CFDI o equivalente). ' +
			'Identifica al EMISOR/proveedor (nombre y RFC), la referencia (serie+folio), ' +
			'el UUID fiscal si existe, la fecha del documento y cada partida/concepto ' +
			'con su código (NoIdentificacion o SKU del proveedor), descripción, cantidad, ' +
			'precio unitario e importe. Usa números (no strings) en cantidades y montos.',
		json_schema: PO_PARSE_SCHEMA,
		files: [{ filename, mime, content_base64 }],
	});
	const raw_items = Array.isArray(extracted.articulos)
		? (extracted.articulos as Record<string, unknown>[])
		: [];
	if (!raw_items.length) {
		throw new Error('El documento no contiene partidas para importar');
	}
	const articulos = raw_items.map((item) => {
		const cantidad = Number(item.cantidad ?? 0);
		const costo_unitario = Number(item.costo_unitario ?? 0);
		const importe = Number(item.importe ?? Number((cantidad * costo_unitario).toFixed(2)));
		return {
			producto: undefined,
			producto_nombre: String(item.producto_nombre ?? ''),
			producto_codigo: String(item.producto_codigo ?? ''),
			descripcion_origen: String(item.producto_nombre ?? ''),
			cantidad,
			costo_unitario,
			importe,
		};
	});
	return ok(
		[
			{
				proveedor_nombre: String(extracted.proveedor_nombre ?? ''),
				proveedor_rfc: String(extracted.proveedor_rfc ?? ''),
				referencia_origen: String(extracted.referencia_origen ?? ''),
				uuid_xml: String(extracted.uuid_xml ?? ''),
				fecha_documento: String(extracted.fecha_documento ?? ''),
				articulos,
			},
		],
		'Documento analizado correctamente',
	);
}

/** Lista UI: columnas del mapa. Sin `search_field` (n-gramas enormes). */
const INCREMENT_LIST_FIELDS = [
	'name',
	'model_name',
	'collection',
	'increment_field',
	'index_name',
	'type',
	'custom_pattern',
	'current_sequence',
	'current_real_value',
	'ref_value',
	'is_active',
];

/** Consolida duplicados. Sin `search_field` (n-gramas). */
const INCREMENT_CONSOLIDATE_FIELDS = [
	'_unique_string_reference',
	'current_sequence',
	'current',
	'valor',
	'current_real_value',
];

async function list_auto_increment_controls(ctx: Ctx) {
	const q = query_list(ctx.url);
	const take = Math.min(q.take, 200);
	const { rows, total } = await ctx.store.find_many('auto-increment-control', {
		include_inactive: true,
		take,
		skip: q.skip,
		q: q.q || undefined,
		sort: q.sort || 'name:asc',
		populate: false,
		scan_fields: INCREMENT_LIST_FIELDS,
	});
	const mapped = rows.map((row) => {
		const ref_value = row.ref_value;
		const is_global =
			ref_value == null || ref_value === undefined || String(ref_value).trim() === '';
		return {
			_id: row._id,
			name: row.name || `${row.model_name}.${row.increment_field}`,
			model_name: row.model_name,
			collection: row.collection,
			increment_field: row.increment_field,
			index_name: row.index_name,
			type: row.type,
			custom_pattern: row.custom_pattern || undefined,
			current_sequence: row.current_sequence,
			current_real_value: row.current_real_value,
			ref_value: row.ref_value,
			segment: is_global ? '(global)' : String(ref_value),
			is_active: row.is_active !== false,
		};
	});
	return ok(mapped, 'Controles de auto-incremento cargados correctamente.', total);
}

async function increment_consolidate(ctx: Ctx) {
	const rows = await collect_scan(ctx.store, 'auto-increment-control', {
		include_inactive: true,
		fields: INCREMENT_CONSOLIDATE_FIELDS,
	});
	const groups = new Map<string, ImperiumDoc[]>();
	for (const row of rows) {
		const key = String(row._unique_string_reference ?? '').trim();
		if (!key) continue;
		const list = groups.get(key) ?? [];
		list.push(row);
		groups.set(key, list);
	}
	let consolidated = 0;
	let deleted = 0;
	let errors = 0;
	for (const list of groups.values()) {
		if (list.length < 2) continue;
		try {
			const sorted = [...list].sort(
				(a, b) =>
					Number(b.current_sequence ?? b.current ?? b.valor ?? 0) -
					Number(a.current_sequence ?? a.current ?? a.valor ?? 0),
			);
			const keep = sorted[0]!;
			const max_sequence = Math.max(
				...list.map((row) => Number(row.current_sequence ?? row.current ?? row.valor ?? 0)),
			);
			const with_max = list.find(
				(row) => Number(row.current_sequence ?? row.current ?? row.valor ?? 0) === max_sequence,
			);
			for (const extra of sorted.slice(1)) {
				await ctx.sql.unsafe(
					`DELETE FROM ${ctx.store.qt('auto-increment-control')} WHERE id = $1`,
					[String(extra._id)],
				);
				deleted += 1;
			}
			await ctx.store.update('auto-increment-control', String(keep._id), {
				current_sequence: max_sequence,
				current: max_sequence,
				valor: max_sequence,
				current_real_value: with_max?.current_real_value ?? keep.current_real_value ?? 0,
			});
			consolidated += 1;
		} catch {
			errors += 1;
		}
	}
	return ok(
		[{ consolidated, deleted, errors }],
		`Consolidación completada. ${consolidated} grupos consolidados, ${deleted} duplicados eliminados.`,
	);
}

async function increment_counter(ctx: Ctx) {
	const doc = await need(
		ctx,
		'auto-increment-control',
		ctx.params.id,
		'No se encontró el control solicitado.',
		'Se necesita un id para incrementar.',
	);
	const amount = Math.max(1, Number(ctx.body.amount ?? ctx.url.searchParams.get('amount') ?? 1));
	const model_name = String(doc.model_name ?? '');
	const increment_field = String(doc.increment_field ?? doc.campo ?? 'sequence');
	let next = Number(doc.current_sequence ?? doc.current ?? doc.valor ?? 0);
	if (model_name) {
		for (let i = 0; i < amount; i++) {
			next = await ctx.store.next_auto_increment(model_name, increment_field);
		}
		const { target } = await resolve_increment_preview_target(
			ctx.store,
			model_name,
			increment_field,
		);
		const shown = target ?? (await ctx.store.find_id('auto-increment-control', String(doc._id)));
		const real_value = shown?.current_real_value ?? next;
		return ok(
			[{ ...(shown ?? {}), real_value, sequence: next, next_sequence: next }],
			`Secuencia incrementada a ${String(real_value)}.`,
		);
	}
	next += amount;
	const real_value = await format_increment_real_value(ctx.store, doc, next);
	const updated = await ctx.store.update('auto-increment-control', String(doc._id), {
		current_sequence: next,
		current: next,
		valor: next,
		counter: next,
		current_real_value: real_value,
	});
	return ok(
		[{ ...(updated ?? {}), real_value, sequence: next, next_sequence: next }],
		`Secuencia incrementada a ${String(real_value)}.`,
	);
}

async function preview_counter(ctx: Ctx) {
	const model_name = String(ctx.params.model_name ?? '').trim();
	const increment_field = String(ctx.params.increment_field ?? '').trim() || 'sequence';
	if (!model_name) throw new Error('Debes indicar el nombre del modelo.');
	try {
		const { config, target } = await resolve_increment_preview_target(
			ctx.store,
			model_name,
			increment_field,
		);
		const next_sequence =
			Number(target?.current_sequence ?? target?.current ?? target?.valor ?? 0) + 1;
		const next_real_value = await format_increment_real_value(
			ctx.store,
			config ?? target,
			next_sequence,
		);
		return ok(
			[
				{
					next_sequence,
					next_consecutive: next_sequence,
					next_real_value,
					tracker: target ?? null,
				},
			],
			`Siguiente valor: ${String(next_real_value)}.`,
		);
	} catch (error) {
		return ok(
			[{ next_sequence: 0, next_real_value: null, tracker: null }],
			error instanceof Error ? error.message : 'Error al obtener la previsualización.',
		);
	}
}

async function normalize_counters(ctx: Ctx) {
	const force = ctx.body.force === true;
	const summary = await normalize_all_counters(ctx.store, { force });
	const unresolved_note = summary.unresolved_documents
		? ` ${summary.unresolved_documents} no se pudieron interpretar y se dejaron intactos.`
		: '';
	let message: string;
	if (force) {
		message = summary.updated_documents
			? `Reparación forzosa completada: ${summary.renumbered_documents} documentos renumerados de ${summary.scanned_documents} revisados y ${summary.adjusted_trackers} contadores ajustados.${unresolved_note}`
			: `Reparación forzosa ejecutada sobre ${summary.scanned_documents} documentos; los números ya eran contiguos (${summary.adjusted_trackers} contadores verificados).${unresolved_note}`;
	} else {
		message = summary.updated_documents
			? `Normalización completada: ${summary.updated_documents} folios actualizados de ${summary.scanned_documents} revisados en ${summary.normalized_indexes} contadores.${unresolved_note}`
			: `La normalización se ejecutó sobre ${summary.scanned_documents} documentos, pero ninguno requirió cambios de formato.${unresolved_note}`;
	}
	return ok([summary], message, summary.results.length);
}


async function close_empaque(ctx: Ctx) {
	const pedido_id = String(ctx.params.pedidoId ?? '').trim();
	if (!pedido_id || !/^[a-f0-9]{24}$/i.test(pedido_id)) {
		throw new Error('Debes indicar un pedido válido');
	}
	const pedido = await ctx.store.find_id('pedidos', pedido_id);
	if (!pedido || pedido.is_active === false) {
		throw new Error('No se encontró el pedido');
	}
	const estado = String(pedido.estado ?? '');
	if (estado === 'cancelado') {
		throw new Error('No se puede cerrar empaque de un pedido cancelado');
	}
	if (estado !== 'surtido' && estado !== 'enviado') {
		throw new Error(
			`El pedido debe estar en «surtido» para cerrar empaque (ahora: ${estado || 'sin estado'})`,
		);
	}
	const rows = await collect_scan(ctx.store, 'delivery-package', {
		where: { pedido: String(pedido._id) },
		include_inactive: true,
	});
	const active = rows.filter(
		(p) => p.is_active !== false && String(p.estado) !== 'cancelado',
	);
	const articulos = as_array(pedido.articulos);
	let total_base = 0;
	let total_remanente = 0;
	for (let i = 0; i < articulos.length; i++) {
		const art = as_object(articulos[i]);
		const surtida = Number(art.cantidad_surtida ?? 0);
		const base = surtida > 0 ? surtida : Math.max(0, Number(art.cantidad ?? 0));
		const pid = ref_id(art.product);
		let empacado = 0;
		for (const pack of active) {
			for (const raw of as_array(pack.contenido)) {
				const item = as_object(raw);
				const qty = Number(item.quantity ?? 0);
				if (!(qty > 0)) continue;
				if (item.articulo_index != null && String(item.articulo_index) !== '') {
					if (Number(item.articulo_index) === i) empacado += qty;
				} else if (pid && ref_id(item.product) === pid) {
					empacado += qty;
				}
			}
		}
		total_base += base;
		total_remanente += Math.max(0, base - empacado);
	}
	if (total_base <= 0) throw new Error('El pedido no tiene cantidades para empacar');
	if (total_remanente > 1e-9) {
		throw new Error(
			`Aún hay remanente por empacar (${total_remanente} uds). Completa los bultos antes de cerrar.`,
		);
	}
	if (!active.length) throw new Error('No hay bultos activos para cerrar el empaque');
	const post = ['cargado', 'en_ruta', 'entregado'];
	if (active.some((p) => post.includes(String(p.estado)))) {
		return ok(active, 'El empaque ya avanzó a carga/entrega; no se requiere cerrar de nuevo.');
	}
	const missing_route: string[] = [];
	const missing_vehicle: string[] = [];
	for (const pack of active) {
		const code = String(pack.codigo_bulto ?? pack.name ?? pack._id);
		if (!ref_id(pack.delivery_route)) missing_route.push(code);
		if (!ref_id(pack.vehicle)) missing_vehicle.push(code);
	}
	if (missing_route.length) {
		throw new Error(
			`Falta ruta en bulto(s): ${missing_route.join(', ')}. Asigna ruta antes de cerrar.`,
		);
	}
	if (missing_vehicle.length) {
		throw new Error(
			`Falta vehículo en bulto(s): ${missing_vehicle.join(', ')}. Asigna vehículo (o ponlo en la ruta) antes de cerrar.`,
		);
	}
	if (active.every((p) => String(p.estado) === 'asignado')) {
		return ok(active, 'El empaque ya estaba cerrado (bultos asignados a carga).');
	}
	const updated: ImperiumDoc[] = [];
	for (const pack of active) {
		const st = String(pack.estado ?? '');
		if (st === 'pendiente' || st === 'incidencia' || !st) {
			const next = await ctx.store.update('delivery-package', String(pack._id), {
				estado: 'asignado',
				fecha_cierre: now(),
			});
			if (next) updated.push(next);
		} else {
			updated.push(pack);
		}
	}
	await after_delivery_package_mutate(ctx.store, String(pedido._id));
	return ok(
		updated.length ? updated : active,
		'Empaque cerrado. Los bultos quedaron asignados para carga del chofer.',
	);
}

async function read_chofer_queue(ctx: Ctx) {
	const mode = String(ctx.url.searchParams.get('mode') ?? 'load').toLowerCase();
	const employee = ref_id(ctx.actor?.employee);
	if (!employee) {
		return ok(
			[],
			'El usuario no tiene un empleado vinculado. Pide a admin ligar el usuario al empleado chofer.',
		);
	}
	const vehicles = (
		await ctx.store.find_many('vehicle', {
			where: { chofer: employee },
			take: 50,
			populate: false,
			skip_total: true,
		})
	).rows;
	const vehicle_ids = new Set(vehicles.map((v) => String(v._id)));
	if (!vehicle_ids.size) {
		return ok([], 'No hay vehículos con este chofer asignado. Configura vehicle.chofer.');
	}
	const estados = mode === 'delivery' ? ['cargado', 'en_ruta'] : ['asignado'];
	const { rows } = await ctx.store.find_many('delivery-package', {
		where: {
			vehicle: { in: [...vehicle_ids] },
			estado: { in: estados },
		},
		take: 200,
		populate: false,
		skip_total: true,
	});
	return ok(
		rows,
		mode === 'delivery' ? 'Cola de entrega del chofer' : 'Cola de carga del chofer',
		rows.length,
	);
}

async function read_load_manifest(ctx: Ctx) {
	const vehicle_id = String(ctx.url.searchParams.get('vehicle_id') ?? '').trim();
	const route_id = String(ctx.url.searchParams.get('route_id') ?? '').trim();
	const estado = String(ctx.url.searchParams.get('estado') ?? '').trim();
	const where: Record<string, unknown> = {};
	if (vehicle_id) where.vehicle = vehicle_id;
	if (route_id) where.delivery_route = route_id;
	if (estado) where.estado = estado;
	const { rows } = await ctx.store.find_many('delivery-package', {
		where,
		take: 200,
		populate: false,
		skip_total: true,
	});
	const records = rows;
	const groups = new Map<
		string,
		{
			vehicle: unknown;
			vehicle_nombre: string;
			delivery_route: unknown;
			delivery_route_nombre: string;
			packages: ImperiumDoc[];
			pedidos: Set<string>;
			total_bultos: number;
			total_cargados: number;
			peso_total: number;
		}
	>();
	for (const record of records) {
		const key = `${ref_id(record.vehicle) || 'sin-vehiculo'}__${ref_id(record.delivery_route) || 'sin-ruta'}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				vehicle: record.vehicle ?? null,
				vehicle_nombre: String(record.vehicle_nombre ?? 'Sin vehículo'),
				delivery_route: record.delivery_route ?? null,
				delivery_route_nombre: String(record.delivery_route_nombre ?? 'Sin ruta'),
				packages: [],
				pedidos: new Set<string>(),
				total_bultos: 0,
				total_cargados: 0,
				peso_total: 0,
			};
			groups.set(key, group);
		}
		group.packages.push(record);
		group.total_bultos += 1;
		group.peso_total += Number(record.peso_kg ?? 0);
		if (ref_id(record.pedido)) group.pedidos.add(ref_id(record.pedido));
		if (['cargado', 'en_ruta', 'entregado'].includes(String(record.estado))) {
			group.total_cargados += 1;
		}
	}
	const data = [...groups.values()].map((group) => ({
		vehicle: group.vehicle,
		vehicle_nombre: group.vehicle_nombre,
		delivery_route: group.delivery_route,
		delivery_route_nombre: group.delivery_route_nombre,
		packages: group.packages,
		total_bultos: group.total_bultos,
		total_cargados: group.total_cargados,
		total_pedidos: group.pedidos.size,
		peso_total: Math.round(group.peso_total * 100) / 100,
	}));
	return ok(data, 'Manifiesto de carga generado correctamente', data.length);
}

/** Columna física: no hidratar bultos sin ruta. $ne solo no basta (NULL IS DISTINCT FROM ''). */
const HAS_DELIVERY_ROUTE = {
	$and: [{ delivery_route: { $exists: true } }, { delivery_route: { $ne: '' } }],
};

async function delivery_offline_catalog(ctx: Ctx) {
	const route_id = String(ctx.url.searchParams.get('route_id') ?? '').trim();
	const rows = await collect_scan(ctx.store, 'delivery-package', {
		where: route_id ? { delivery_route: route_id } : undefined,
		mongo_match: route_id ? null : HAS_DELIVERY_ROUTE,
	});
	const records = rows
		.filter((row) => {
			const route = ref_id(row.delivery_route);
			if (!route) return false;
			if (route_id && route !== route_id) return false;
			return true;
		})
		.sort((a, b) => {
			const route = String(a.delivery_route_nombre ?? '').localeCompare(
				String(b.delivery_route_nombre ?? ''),
				'es',
			);
			if (route) return route;
			const num = Number(a.numero_bulto ?? 0) - Number(b.numero_bulto ?? 0);
			if (num) return num;
			return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'es');
		});
	return ok(records, 'Catálogo logístico offline cargado correctamente');
}

/**
 * El mapa lee `delivery_address_coordinates` (TEXT JSON), no las
 * columnas latitude/longitude (el write path no las llena).
 * `$exists` en lat/lon cubre filas legacy. No filtrar “tiene ruta”:
 * el grupo `sin-ruta` es parte del contrato.
 */
const HAS_MAP_COORDINATES = {
	$or: [
		{
			$and: [
				{ delivery_address_coordinates: { $exists: true } },
				{ delivery_address_coordinates: { $ne: '' } },
			],
		},
		{ $and: [{ latitude: { $exists: true } }, { longitude: { $exists: true } }] },
	],
};

async function delivery_route_map(ctx: Ctx) {
	const route_id = String(ctx.url.searchParams.get('route_id') ?? '').trim();
	const rows = await collect_scan(ctx.store, 'delivery-package', {
		where: route_id ? { delivery_route: route_id } : undefined,
		mongo_match: HAS_MAP_COORDINATES,
	});
	const packages = rows.filter((row) => {
		const coords = as_object(row.delivery_address_coordinates);
		const lat = Number(coords.latitude ?? coords.lat);
		const lon = Number(coords.longitude ?? coords.lng ?? coords.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
		if (route_id && ref_id(row.delivery_route) !== route_id) return false;
		return true;
	});
	const groups = new Map<string, ImperiumDoc>();
	for (const pkg of packages) {
		const key = ref_id(pkg.delivery_route) || 'sin-ruta';
		let group = groups.get(key);
		if (!group) {
			group = {
				delivery_route: pkg.delivery_route ?? null,
				delivery_route_nombre: String(pkg.delivery_route_nombre ?? 'Sin ruta'),
				points: [] as ImperiumDoc[],
				optimization: null,
			};
			groups.set(key, group);
		}
		const coords = as_object(pkg.delivery_address_coordinates);
		(as_array(group.points) as ImperiumDoc[]).push({
			_id: pkg._id,
			codigo_bulto: pkg.codigo_bulto,
			pedido: pkg.pedido,
			pedido_folio: pkg.pedido_folio,
			pedido_contacto_nombre: pkg.pedido_contacto_nombre,
			domicilio: pkg.pedido_contacto_domicilio,
			estado: pkg.estado,
			vehicle_nombre: pkg.vehicle_nombre,
			latitude: coords.latitude ?? coords.lat,
			longitude: coords.longitude ?? coords.lng ?? coords.lon,
		});
	}
	for (const [key, group] of groups) {
		if (key === 'sin-ruta') continue;
		const route = await ctx.store.find_id('delivery-route', key);
		group.optimization = route?.optimization ?? null;
	}
	return ok([...groups.values()], 'Mapa de rutas generado correctamente');
}

async function delivery_chofer_routes(ctx: Ctx) {
	const employee_raw = ctx.actor?.employee;
	const employee_id =
		employee_raw && typeof employee_raw === 'object'
			? ref_id(employee_raw)
			: String(employee_raw ?? '').trim();
	if (!employee_id) {
		return ok([], 'El usuario no tiene un empleado vinculado para identificar al chofer.');
	}
	const vehicles = ctx.store.has('vehicle')
		? await collect_scan(ctx.store, 'vehicle', {
				where: { chofer: employee_id },
				include_inactive: false,
			})
		: [];
	if (!vehicles.length) {
		return ok([], 'El chofer no tiene vehículos asignados.');
	}
	const vehicle_ids = vehicles.map((v) => String(v._id));
	const rows = await collect_scan(ctx.store, 'delivery-route', {
		where: { vehicle: { in: vehicle_ids } },
		include_inactive: false,
	});
	const routes = sort_by_name(rows);
	return ok(
		await decorate_delivery_routes(ctx.store, routes, 'detail'),
		'Rutas del chofer cargadas correctamente',
	);
}

async function logistics_event(ctx: Ctx) {
	const id = String(ctx.params.id ?? '').trim();
	const doc = id ? await ctx.store.find_id('delivery-package', id) : null;
	if (!doc || doc.is_active === false) {
		throw new Error('No se encontró el bulto indicado');
	}
	const event_type = String(ctx.body.event_type ?? ctx.body.event ?? ctx.body.tipo ?? '').trim();
	const event_id = String(ctx.body.event_id ?? crypto.randomUUID());
	const occurred_at = String(ctx.body.occurred_at ?? ctx.body.created_at ?? now());
	const source = String(ctx.body.source ?? 'manual');
	const history = as_array(doc.logistics_events ?? doc.eventos);
	if (history.some((raw) => String(as_object(raw).event_id) === event_id)) {
		return ok([doc], 'El evento logístico ya había sido aplicado previamente');
	}
	if (doc.is_active === false || String(doc.estado) === 'cancelado') {
		throw new Error('No puedes operar logística sobre un bulto anulado');
	}
	const st = String(doc.estado ?? '');
	const patch: ImperiumDoc = {};
	if (event_type === 'load') {
		if (st === 'pendiente') {
			throw new Error('Este bulto aún no está listo para carga. Cierra el empaque del pedido primero.');
		}
		if (st !== 'asignado' && st !== 'cargado') {
			throw new Error(`No puedes cargar un bulto en estado «${st}»`);
		}
		if (st === 'asignado') {
			patch.estado = 'cargado';
			patch.loaded_at = doc.loaded_at ?? occurred_at;
		}
	} else if (event_type === 'delivery') {
		if (st === 'entregado') throw new Error('Este bulto ya fue entregado');
		if (st === 'incidencia') {
			throw new Error('No puedes confirmar entrega sobre un bulto marcado como incidencia');
		}
		if (st !== 'cargado' && st !== 'en_ruta') {
			throw new Error('Solo puedes entregar bultos cargados (o en ruta). Registra la carga primero.');
		}
		const ticket = String(ctx.body.delivery_ticket_reference ?? '').trim();
		if (!ticket) throw new Error('Debes capturar el ticket o referencia de entrega');
		if (!actor_id(ctx)) {
			throw new Error(
				'No se pudo identificar al usuario autenticado para guardar la firma',
			);
		}
		const attachment_id = await save_delivery_signature(ctx, String(doc._id));
		patch.estado = 'entregado';
		patch.delivered_at = occurred_at;
		patch.loaded_at = doc.loaded_at ?? occurred_at;
		patch.delivery_ticket_reference = ticket;
		patch.delivery_signature_attachment_id = attachment_id;
		if (ctx.body.delivery_coordinates) {
			patch.delivery_coordinates = ctx.body.delivery_coordinates;
		}
		if (ctx.body.delivery_distance_m != null) {
			patch.delivery_distance_m = Number(ctx.body.delivery_distance_m);
		}
		if (ctx.body.delivery_within_geofence != null) {
			patch.delivery_within_geofence =
				ctx.body.delivery_within_geofence === true ||
				ctx.body.delivery_within_geofence === 'true';
		}
	} else {
		throw new Error('El tipo de evento logístico no es válido');
	}
	history.push({
		event_id,
		event_type,
		created_at: occurred_at,
		source,
		actor: actor_name(ctx),
	});
	const saved = await ctx.store.update('delivery-package', String(doc._id), {
		...patch,
		logistics_events: history,
		ultimo_evento: event_type,
		last_logistics_event_type: event_type,
		fecha_ultimo_evento: occurred_at,
		last_logistics_event_at: occurred_at,
	});
	if (!saved) throw new Error('No se encontró el documento');
	if (event_type === 'delivery') {
		await register_package_delivery_exit(
			ctx.store,
			{ ...doc, ...saved },
			event_id,
			occurred_at,
		);
	}
	await after_delivery_package_mutate(ctx.store, ref_id(saved.pedido) || ref_id(doc.pedido));
	return ok(
		[saved],
		event_type === 'load' ? 'Bulto cargado correctamente' : 'Entrega confirmada correctamente',
	);
}

async function read_packages_by_pedido(ctx: Ctx) {
	const flag = String(ctx.url.searchParams.get('include_cancelled') ?? '')
		.trim()
		.toLowerCase();
	const listed = await list_packages_by_pedido(
		ctx.store,
		ctx.params.pedidoId,
		flag === '1' || flag === 'true',
	);
	return ok(listed.rows, listed.message, listed.rows.length);
}

async function read_driver_location(ctx: Ctx) {
	const route_id = String(ctx.params.id ?? '').trim();
	if (!route_id) throw new Error('Se necesita el id de la ruta.');
	const position = last_driver_location(route_id);
	return ok(
		position ? [position] : [],
		position
			? 'Ubicación del chofer obtenida correctamente'
			: 'Sin ubicación reciente del chofer',
	);
}

async function optimize_route(ctx: Ctx) {
	const route_id = String(ctx.params.id ?? '').trim();
	if (!route_id) throw new Error('Se necesita el id de la ruta a optimizar.');
	const route = await ctx.store.find_id('delivery-route', route_id);
	if (!route) throw new Error('No se encontró la ruta indicada.');
	const body_origin = as_object(ctx.body.origin);
	const has_driver_gps =
		Number.isFinite(Number(body_origin.latitude)) &&
		Number.isFinite(Number(body_origin.longitude));
	let origin: GeoPoint;
	if (has_driver_gps) {
		origin = { latitude: Number(body_origin.latitude), longitude: Number(body_origin.longitude) };
	} else {
		const warehouse = warehouse_origin();
		if (!warehouse) {
			throw new Error(
				'No hay origen para la ruta: configura WAREHOUSE_LAT/WAREHOUSE_LNG o envía la ubicación del chofer.',
			);
		}
		origin = warehouse;
	}
	const packages = ctx.store.has('delivery-package')
		? await collect_scan(ctx.store, 'delivery-package', {
				where: { delivery_route: route_id },
			})
		: [];
	const grouped = new Map<
		string,
		{ id: string; location: GeoPoint; label: string; demand_kg: number; pedido?: string; package_ids: string[] }
	>();
	for (const pkg of packages) {
		const coords = as_object(pkg.delivery_address_coordinates);
		let location: GeoPoint | null =
			Number.isFinite(Number(coords.latitude)) && Number.isFinite(Number(coords.longitude))
				? { latitude: Number(coords.latitude), longitude: Number(coords.longitude) }
				: null;
		if (!location && pkg.pedido_contacto_domicilio) {
			location = await geocode_address(String(pkg.pedido_contacto_domicilio));
		}
		if (!location) continue;
		const key = String(pkg.pedido ?? pkg._id);
		if (!grouped.has(key)) {
			grouped.set(key, {
				id: key,
				location,
				label: String(pkg.pedido_contacto_nombre || pkg.pedido_folio || 'Parada'),
				demand_kg: 0,
				pedido: pkg.pedido ? String(pkg.pedido) : undefined,
				package_ids: [],
			});
		}
		const entry = grouped.get(key)!;
		entry.package_ids.push(String(pkg._id));
		entry.demand_kg += Number(pkg.peso_kg ?? 0);
	}
	const stops = [...grouped.values()];
	if (!stops.length) {
		throw new Error('La ruta no tiene paradas georreferenciadas para optimizar.');
	}
	google_maps_api_key();
	const result = await optimize_google_routes({
		origin,
		stops,
		traffic_aware: ctx.body.traffic_aware !== false,
		depart_at: ctx.body.depart_at ? String(ctx.body.depart_at) : undefined,
	});
	const stop_meta = new Map(stops.map((stop) => [stop.id, stop]));
	const ordered_stops = result.ordered_stops.map((optimized) => {
		const meta = stop_meta.get(optimized.id);
		return {
			id: optimized.id,
			pedido: meta?.pedido,
			package_ids: meta?.package_ids ?? [],
			location: optimized.location,
			label: meta?.label ?? optimized.label ?? '',
			demand_kg: optimized.demand_kg ?? 0,
			sequence: optimized.sequence,
			cumulative_distance_meters: optimized.cumulative_distance_meters,
			cumulative_duration_seconds: optimized.cumulative_duration_seconds,
			eta: optimized.eta,
		};
	});
	const optimization = {
		origin,
		origin_source: has_driver_gps ? 'driver_gps' : 'warehouse',
		ordered_stops,
		total_distance_meters: result.total_distance_meters,
		total_duration_seconds: result.total_duration_seconds,
		encoded_polyline: result.encoded_polyline,
		provider: result.provider,
		optimized_at: now(),
	};
	await ctx.store.update('delivery-route', route_id, { optimization });
	return ok([optimization], 'Ruta optimizada correctamente');
}

async function create_history_comment(ctx: Ctx) {
	const document_id = String(
		ctx.body.document_id ?? ctx.body.documentId ?? ctx.body.record_id ?? ctx.body.id ?? '',
	).trim();
	const collection_name = String(
		ctx.body.collection_name ?? ctx.body.collectionName ?? ctx.body.model ?? '',
	).trim();
	const model_name = String(ctx.body.model_name ?? ctx.body.modelName ?? collection_name).trim();
	const comment_text = String(
		ctx.body.comment_text ?? ctx.body.commentText ?? ctx.body.comment ?? ctx.body.mensaje ?? '',
	).trim();
	if (!document_id) throw new Error('Se requiere document_id para registrar el comentario.');
	if (!collection_name && !model_name) {
		throw new Error('Se requiere collection_name o model_name para registrar el comentario.');
	}
	if (!comment_text) throw new Error('Debes escribir un comentario antes de guardarlo.');
	const canonical = resolve_history_model(ctx.store, model_name, collection_name);
	if (!canonical) {
		throw new Error('No se pudo resolver el modelo del historial solicitado.');
	}
	await assert_target_model_read(ctx.store, ctx.actor, canonical);
	const mentioned_users = await resolve_comment_mentioned_users(
		ctx.store,
		ctx.actor,
		comment_text,
		ctx.body.mentioned_user_ids ?? ctx.body.mentionedUserIds,
	);
	const mentioned_user_ids = mentioned_users.map((user) => String(user._id ?? ''));
	const created = await ctx.store.insert('document-change-history', {
		name: 'comentario',
		entryType: 'comment',
		comment: comment_text,
		commentText: comment_text,
		actionName: mentioned_users.length ? 'Comentario con menciones' : 'Comentario',
		actionDescription: comment_text,
		model: canonical,
		modelName: canonical,
		collectionName: collection_name || canonical,
		documentId: document_id,
		record_id: document_id,
		operationType: 'comment',
		mentionedUserIds: mentioned_user_ids,
		mentionedUsers: mentioned_users.map((user) => ({
			_id: user._id,
			name: user.name,
			email: user.email,
		})),
		created_by: actor_id(ctx),
		actor: {
			_id: actor_id(ctx),
			name: ctx.actor?.name,
			email: ctx.actor?.email,
		},
	});
	await register_comment_mentions(ctx.store, ctx.actor, {
		comment_text,
		mentioned_user_ids: ctx.body.mentioned_user_ids ?? ctx.body.mentionedUserIds,
		model_name,
		collection_name: collection_name || model_name,
		document_id,
		history_id: String(created._id),
		route: String(ctx.body.source_route ?? ctx.body.sourceRoute ?? ''),
		entity_label: String(ctx.body.source_entity_label ?? ctx.body.sourceEntityLabel ?? ''),
	});
	return ok([created], 'Comentario registrado correctamente');
}

async function read_history(ctx: Ctx) {
	const document_id = String(
		ctx.url.searchParams.get('document_id') ?? ctx.url.searchParams.get('documentId') ?? '',
	).trim();
	const collection_name = String(
		ctx.url.searchParams.get('collection_name') ??
			ctx.url.searchParams.get('collectionName') ??
			'',
	).trim();
	const model_name = String(
		ctx.url.searchParams.get('model_name') ?? ctx.url.searchParams.get('modelName') ?? '',
	).trim();
	if (!document_id) throw new Error('Se requiere document_id para consultar el historial.');
	if (!collection_name && !model_name) {
		throw new Error('Se requiere collection_name o model_name para consultar el historial.');
	}
	const canonical = resolve_history_model(ctx.store, model_name, collection_name);
	if (!canonical) {
		throw new Error('No se pudo resolver el modelo del historial solicitado.');
	}
	await assert_target_model_read(ctx.store, ctx.actor, canonical);
	const { desde, limite } = history_page_limits({
		limite: ctx.url.searchParams.get('limite'),
		size: ctx.url.searchParams.get('size'),
		desde: ctx.url.searchParams.get('desde'),
	});
	const { rows, total } = await ctx.store.find_many(
		'document-change-history',
		history_find_many_opts({
			document_id,
			canonical,
			collection_name,
			model_name,
			desde,
			limite,
		}),
	);
	const page = rows.map((row) => enrich_history_row(row));
	return ok(
		page,
		page.length ? 'Historial obtenido correctamente' : 'No se encontraron cambios para este registro',
		total,
	);
}

function created_ms(doc: ImperiumDoc): number {
	const t = new Date(String(doc.createdAt ?? doc.created_at ?? '')).getTime();
	return Number.isFinite(t) ? t : 0;
}

async function read_history_by_id(ctx: Ctx) {
	const history_id = String(ctx.params.id ?? '').trim();
	if (!history_id) throw new Error('Debes indicar el historial que deseas consultar.');
	const record = await ctx.store.find_id('document-change-history', history_id);
	if (!record) {
		return ok([], 'Registro de historial no encontrado', 0);
	}
	const canonical = resolve_history_model(
		ctx.store,
		String(record.modelName ?? record.model_name ?? record.model ?? ''),
		String(record.collectionName ?? record.collection_name ?? ''),
	);
	if (!canonical) {
		throw new Error('No se pudo resolver el modelo del historial solicitado.');
	}
	await assert_target_model_read(ctx.store, ctx.actor, canonical);
	return ok([enrich_history_row(record)], 'Registro de historial obtenido correctamente');
}

function documentation_order(doc: ImperiumDoc) {
	return Number(doc.order ?? 0);
}

function documentation_adjacent_card(doc: ImperiumDoc | null) {
	if (!doc) return null;
	const meta = as_object(doc.metadata);
	return {
		_id: doc._id,
		title: meta.title ?? doc.title ?? doc.name,
		slug: doc.slug,
		section: doc.section,
		folder_path: doc.folder_path,
		metadata: doc.metadata ?? meta,
		order: documentation_order(doc),
	};
}

async function documentation_adjacent(ctx: Ctx) {
	const slug = String(ctx.params.slug ?? '').trim();
	const folder = String(ctx.url.searchParams.get('folder') ?? '').trim();
	const section = String(ctx.url.searchParams.get('section') ?? '').trim();
	const found = await ctx.store.documentation_adjacent({ slug, folder, section });
	if (!found.current) {
		return ok([{ previous: null, next: null }], 'Documento no encontrado.', 0);
	}
	return ok(
		[
			{
				previous: documentation_adjacent_card(found.previous),
				next: documentation_adjacent_card(found.next),
			},
		],
		'Documentos adyacentes obtenidos.',
		1,
	);
}

/** Cards del árbol / read_all. Sin `content` (markdown). */
const DOCUMENTATION_CARD_FIELDS = [
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
];

function documentation_page_card(doc: ImperiumDoc) {
	const meta = as_object(doc.metadata);
	return {
		title: meta.title ?? doc.title ?? doc.name,
		slug: doc.slug,
		description: meta.description ?? doc.description,
		icon: meta.icon,
		order: doc.order,
		headings: doc.headings ?? [],
	};
}

function documentation_children(children: Map<string, { key: string; title: string; pages: ImperiumDoc[]; children: Map<string, unknown> }>): unknown[] {
	return [...children.values()]
		.map((child) => ({
			key: child.key,
			title: child.title,
			description: '',
			icon: 'fa-folder',
			pages: [...child.pages].sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
			children: documentation_children(child.children as Map<string, typeof child>),
		}))
		.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

async function documentation_read_all(ctx: Ctx) {
	const rows = await collect_scan(ctx.store, 'documentation-page', {
		include_inactive: false,
		fields: DOCUMENTATION_CARD_FIELDS,
	});
	const docs = rows
		.filter((doc) => doc.is_active !== false)
		.sort((a, b) => {
			const section = String(a.section ?? '').localeCompare(String(b.section ?? ''));
			if (section) return section;
			return Number(a.order ?? 0) - Number(b.order ?? 0);
		})
		.map((doc) => ({
			_id: doc._id,
			title: doc.title ?? doc.name,
			slug: doc.slug,
			section: doc.section,
			folder_path: doc.folder_path,
			metadata: doc.metadata,
			order: doc.order,
			is_root_page: doc.is_root_page,
			parent_hierarchy: doc.parent_hierarchy,
		}));
	return ok(docs, 'Documentos obtenidos correctamente.', docs.length);
}

async function documentation_read_one(
	ctx: Ctx,
	opts: { id?: string; slug?: string; folder?: string },
) {
	let doc: ImperiumDoc | null = null;
	if (opts.id) {
		doc = await ctx.store.find_id('documentation-page', opts.id);
	} else if (opts.slug) {
		const where: Record<string, unknown> = { slug: opts.slug };
		if (opts.folder) where.folder_path = opts.folder;
		const { rows } = await ctx.store.find_many('documentation-page', {
			where,
			take: 1,
			sort: 'id:asc',
			include_inactive: false,
		});
		doc = rows[0] ?? null;
	}
	if (!doc || doc.is_active === false) {
		return ok([], 'Documento no encontrado.');
	}
	return ok([doc], 'Documento obtenido correctamente.');
}

async function debug_read_one(ctx: Ctx) {
	const doc = await ctx.store.find_id('debug-log', ctx.params.id);
	if (!doc) return ok([], 'Log no encontrado');
	return ok([doc], 'Log encontrado');
}

async function documentation_structure(ctx: Ctx) {
	const rows = await collect_scan(ctx.store, 'documentation-page', {
		fields: DOCUMENTATION_CARD_FIELDS,
	});
	const root_pages: ReturnType<typeof documentation_page_card>[] = [];
	const sections = new Map<
		string,
		{
			key: string;
			title: string;
			description: string;
			icon: string;
			pages: ReturnType<typeof documentation_page_card>[];
			children: Map<string, { key: string; title: string; pages: ReturnType<typeof documentation_page_card>[]; children: Map<string, unknown> }>;
		}
	>();
	for (const doc of rows) {
		if (doc.is_root_page === true || doc.is_root_page === 'true') {
			root_pages.push(documentation_page_card(doc));
			continue;
		}
		const section_key = String(doc.section ?? 'general');
		if (!sections.has(section_key)) {
			sections.set(section_key, {
				key: section_key,
				title: section_key,
				description: '',
				icon: 'fa-folder',
				pages: [],
				children: new Map(),
			});
		}
		const section = sections.get(section_key)!;
		const folder_parts = String(doc.folder_path ?? '')
			.split('/')
			.filter((part) => part && part !== 'children');
		if (!folder_parts.length) {
			section.pages.push(documentation_page_card(doc));
			continue;
		}
		let current = section.children;
		let path = '';
		for (let i = 0; i < folder_parts.length; i++) {
			path = path ? `${path}/${folder_parts[i]}` : folder_parts[i]!;
			if (!current.has(path)) {
				current.set(path, {
					key: path,
					title: folder_parts[i]!,
					pages: [],
					children: new Map(),
				});
			}
			const folder = current.get(path)!;
			if (i === folder_parts.length - 1) {
				folder.pages.push(documentation_page_card(doc));
			} else {
				current = folder.children as typeof current;
			}
		}
	}
	const structure = {
		root_pages: root_pages.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
		sections: [...sections.values()]
			.map((section) => ({
				...section,
				pages: section.pages.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
				children: documentation_children(section.children),
			}))
			.sort((a, b) => a.key.localeCompare(b.key)),
	};
	return ok([structure], 'Estructura obtenida correctamente.');
}

function documentation_snippet(content: string, query: string): string {
	const text = String(content ?? '');
	const lower_content = text.toLowerCase();
	const lower_query = query.toLowerCase();
	const index = lower_content.indexOf(lower_query);
	if (index === -1) return text.substring(0, 200);
	const start = Math.max(0, index - 80);
	const end = Math.min(text.length, index + query.length + 80);
	let snippet = text.substring(start, end);
	if (start > 0) snippet = `...${snippet}`;
	if (end < text.length) snippet = `${snippet}...`;
	return snippet;
}

async function documentation_search(ctx: Ctx) {
	const query = String(ctx.url.searchParams.get('q') ?? ctx.url.searchParams.get('termino') ?? '').trim();
	if (query.length < 2) {
		return ok([], 'La búsqueda debe tener al menos 2 caracteres.');
	}
	const { rows } = await ctx.store.find_many('documentation-page', { q: query, take: 50 });
	const results = rows
		.filter((doc) => doc.is_active !== false)
		.map((doc) => ({
			title: doc.title ?? doc.name,
			slug: doc.slug,
			section: doc.section,
			folder_path: doc.folder_path,
			metadata: doc.metadata,
			snippet: documentation_snippet(String(doc.content ?? ''), query),
			order: doc.order,
		}));
	return ok(results, `Se encontraron ${results.length} resultado(s).`);
}

async function documentation_sync_status(ctx: Ctx) {
	const { total } = await ctx.store.find_many('documentation-page', { take: 1 });
	return ok(
		[{ has_documents: total > 0, total_documents: total, synced: total > 0 }],
		total > 0 ? 'Documentos encontrados.' : 'No hay documentos sincronizados.',
	);
}

async function documentation_sync(ctx: Ctx) {
	if (ctx.actor?._ref !== 'user-menu-management-0') {
		return ok([], 'Solo administradores pueden sincronizar documentos.');
	}
	const documents = as_array(ctx.body.documents);
	if (!documents.length) {
		return ok([], 'No se proporcionaron documentos para sincronizar.');
	}
	for await (const page of ctx.store.scan('documentation-page', {
		include_inactive: true,
	})) {
		for (const row of page) {
			await ctx.store.remove('documentation-page', String(row._id));
		}
	}
	const created: ImperiumDoc[] = [];
	for (const raw of documents) {
		const doc = as_object(raw);
		created.push(
			await ctx.store.insert('documentation-page', {
				name: String(doc.title ?? doc.name ?? doc.slug ?? 'documento'),
				...doc,
			}),
		);
	}
	return ok(created, `${created.length} documento(s) sincronizado(s) correctamente.`);
}

async function dashboard_catalog(ctx: Ctx) {
	return resolve_dashboard_catalog(ctx.store, ctx.actor);
}

const AI_QUERY_JSON_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['answer', 'widgets'],
	properties: {
		answer: { type: 'string' },
		widgets: { type: 'array' },
	},
};

async function dashboard_ai_query(ctx: Ctx) {
	const question = String(ctx.body.question ?? '').trim();
	if (!question) throw new Error('Escribe una pregunta para el asistente.');
	const catalog = await dashboard_catalog(ctx);
	const entries = as_array((catalog as { data?: unknown }).data);
	if (!entries.length) {
		throw new Error('No tienes módulos consultables para el asistente.');
	}
	const catalog_text = entries
		.map((raw) => {
			const entry = as_object(raw);
			const fields = as_array(entry.fields)
				.map((field) => {
					const f = as_object(field);
					return `${f.path}:${f.type}`;
				})
				.join(', ');
			return `- ${entry.model_id} (${entry.module_name}): ${fields}`;
		})
		.join('\n');
	const history = as_array(ctx.body.history)
		.map((turn) => {
			const t = as_object(turn);
			return `${t.role === 'user' ? 'Usuario' : 'Asistente'}: ${t.content ?? ''}`;
		})
		.filter((line) => line.includes(': ') && !line.endsWith(': '));
	const raw = await extract_structured(ctx.store, {
		instructions: [
			'Eres el asistente de reportes de un ERP. El usuario pide información en lenguaje natural y tú respondes con `answer` (texto en español) y, cuando aplica, con `widgets`: especificaciones de consulta que el sistema ejecutará por ti.',
			'Solo puedes usar los modelos y campos del catálogo. Si lo pedido no existe, explícalo en `answer` y devuelve `widgets` vacío.',
			'CATÁLOGO DE MODELOS DISPONIBLES:',
			catalog_text,
		].join('\n\n'),
		json_schema: AI_QUERY_JSON_SCHEMA,
		text: [...history, `Usuario: ${question}`].join('\n\n'),
	});
	const answer = String(raw.answer ?? '');
	const raw_widgets = Array.isArray(raw.widgets) ? raw.widgets : [];
	const widgets = [];
	for (const raw_widget of raw_widgets) {
		const spec = as_object(raw_widget);
		try {
			const inner: Ctx = { ...ctx, body: { spec } };
			const result = await widget_data(inner);
			widgets.push({ spec, result: (result as { data?: unknown }).data ?? result });
		} catch (error) {
			widgets.push({
				spec,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return ok([{ answer, widgets }], 'Consulta procesada');
}

async function reports_pdf_direct_target(ctx: Ctx) {
	const target = await get_pdf_direct_target(ctx.store);
	return ok([target], 'ok');
}

async function reports_print_pdf_direct(ctx: Ctx) {
	const pdf_b64 = String(ctx.body.pdfBase64 ?? '').trim();
	let bytes: Uint8Array;
	if (pdf_b64) {
		bytes = Buffer.from(pdf_b64, 'base64');
	} else {
		const generated = await report_full_pdf(ctx);
		if (!(generated instanceof Response)) {
			throw new Error('No se pudo generar el PDF para imprimir.');
		}
		bytes = new Uint8Array(await generated.arrayBuffer());
	}
	await send_pdf(ctx.store, bytes);
	return ok([{ ok: true }], 'Enviado a la impresora PDF Direct');
}

async function widget_data(ctx: Ctx) {
	return resolve_widget_data(ctx.store, ctx.actor, ctx.body);
}

async function find_location_by_codigo(ctx: Ctx, codigo: string) {
	if (!codigo || !ctx.store.has('inventory-internal-location')) return null;
	return (
		(
			await ctx.store.find_many('inventory-internal-location', {
				where: { codigo },
				take: 1,
				include_inactive: true,
			})
		).rows[0] ?? null
	);
}

async function upsert_location_line(
	ctx: Ctx,
	line: {
		name: string;
		segmento_codigo: string;
		parent_codigo?: string;
		permite_almacenaje?: boolean;
	},
	dry_run: boolean,
) {
	const segmento = sanitize_location_segment(line.segmento_codigo || line.name);
	const parent_codigo = sanitize_location_segment(line.parent_codigo ?? '');
	const parent_doc = parent_codigo ? await find_location_by_codigo(ctx, parent_codigo) : null;
	const parent_id = parent_doc ? String(parent_doc._id) : '';
	const composed = parent_id
		? await compose_location_code(ctx.store, parent_id, segmento)
		: {
				codigo: parent_codigo ? `${parent_codigo}${segmento}` : segmento,
				nivel: 0,
				parent: null as string | null,
				parent_codigo,
			};
	const existing = await find_location_by_codigo(ctx, composed.codigo);
	if (existing) {
		if (!dry_run) {
			await ctx.store.update('inventory-internal-location', String(existing._id), {
				name: line.name || existing.name,
				permite_almacenaje: line.permite_almacenaje ?? existing.permite_almacenaje,
				parent: composed.parent ?? existing.parent ?? null,
				parent_codigo: composed.parent_codigo || parent_codigo || existing.parent_codigo,
				nivel: existing.nivel ?? composed.nivel,
				segmento_codigo: existing.segmento_codigo || segmento,
			});
		}
		return { codigo: composed.codigo, accion: 'exists' as const, id: existing._id };
	}
	if (!dry_run) {
		const created = await ctx.store.insert('inventory-internal-location', {
			name: line.name || composed.codigo,
			codigo: composed.codigo,
			segmento_codigo: segmento,
			parent: composed.parent,
			parent_codigo: composed.parent_codigo || parent_codigo || null,
			nivel: composed.nivel,
			permite_almacenaje: line.permite_almacenaje !== false,
			tipo: 'almacen',
		});
		return { codigo: composed.codigo, accion: 'create' as const, id: created._id };
	}
	return { codigo: composed.codigo, accion: 'create' as const, id: null };
}

async function ensure_location_path(
	ctx: Ctx,
	path: string,
	root: string,
	dry_run: boolean,
	fila: number,
) {
	const lines = expand_path_to_tree_lines(path, {
		root_parent_codigo: root,
		fila,
	});
	const creadas: string[] = [];
	const ya_existian: string[] = [];
	const preview: ImperiumDoc[] = [];
	if (!(await find_location_by_codigo(ctx, root)) && root) {
		const root_row = await upsert_location_line(
			ctx,
			{ name: root, segmento_codigo: root, permite_almacenaje: false },
			dry_run,
		);
		preview.push({ ...root_row, path: root });
		if (root_row.accion === 'create') creadas.push(root_row.codigo);
		else ya_existian.push(root_row.codigo);
	}
	let leaf = root;
	for (const line of lines) {
		const row = await upsert_location_line(ctx, line, dry_run);
		preview.push({ ...row, path });
		if (row.accion === 'create') creadas.push(row.codigo);
		else ya_existian.push(row.codigo);
		leaf = row.codigo;
	}
	return { leaf_codigo: lines.length ? leaf : composed_codigo_from_path(path, root) || root, creadas, ya_existian, preview };
}

async function import_location_tree(ctx: Ctx) {
	const dry_run = Boolean(ctx.body.dry_run);
	const root = sanitize_location_segment(ctx.body.root_parent_codigo ?? 'ALMACEN') || 'ALMACEN';
	const raw_lines = as_array(ctx.body.lineas ?? ctx.body.tree ?? ctx.body.nodos);
	if (!raw_lines.length) {
		throw new Error(
			"Debes enviar lineas[] con name+segmento_codigo o ubicacion_path (ej. 'Zona 1 / Zona 1-A')",
		);
	}
	const expanded: Array<{
		name: string;
		segmento_codigo: string;
		parent_codigo?: string;
		permite_almacenaje?: boolean;
	}> = [];
	for (const raw of raw_lines) {
		const n = as_object(raw);
		const path = extract_path_from_row(n);
		if (path && !String(n.segmento_codigo ?? '').trim()) {
			expanded.push(
				...expand_path_to_tree_lines(path, { root_parent_codigo: root }),
			);
			continue;
		}
		const name = String(n.name ?? n.nombre ?? '').trim();
		const codigo = String(n.segmento_codigo ?? n.codigo ?? name).trim();
		if (!name && !codigo) continue;
		expanded.push({
			name: name || codigo,
			segmento_codigo: codigo,
			parent_codigo: String(n.parent_codigo ?? root),
			permite_almacenaje: n.permite_almacenaje !== false,
		});
	}
	const preview: ImperiumDoc[] = [];
	const creadas: string[] = [];
	const actualizadas: string[] = [];
	const errores: ImperiumDoc[] = [];
	for (const line of expanded) {
		if (!sanitize_location_segment(line.segmento_codigo || line.name)) {
			errores.push({ mensaje: 'Fila sin name ni segmento_codigo' });
			continue;
		}
		const row = await upsert_location_line(ctx, line, dry_run);
		preview.push(row);
		if (row.accion === 'create') creadas.push(row.codigo);
		else actualizadas.push(row.codigo);
	}
	const summary = {
		dry_run,
		total_filas: raw_lines.length,
		creadas: creadas.length,
		actualizadas: actualizadas.length,
		codigos_creados: creadas,
		codigos_actualizados: actualizadas,
		errores,
		preview: dry_run ? preview : undefined,
	};
	return ok(
		[summary],
		dry_run
			? `Simulación árbol: ${preview.length} fila(s) OK, ${errores.length} error(es)`
			: `Árbol importado: ${creadas.length} creada(s), ${actualizadas.length} actualizada(s), ${errores.length} error(es)`,
	);
}

export async function import_location_tree_from_body(
	store: ImperiumStore,
	body: Record<string, unknown>,
) {
	return import_location_tree({ store, body } as Ctx);
}

async function register_transfer(ctx: Ctx) {
	await register_internal_transfer(ctx.store, {
		producto: String(ctx.body.producto ?? ctx.body.product_id ?? ''),
		ubicacion_origen: String(ctx.body.ubicacion_origen ?? ctx.body.origen ?? ''),
		ubicacion_destino: String(ctx.body.ubicacion_destino ?? ctx.body.destino ?? ''),
		cantidad: Number(ctx.body.cantidad ?? 0),
	});
	return {
		data: null,
		total_elementos: 1,
		message: 'Traslado registrado correctamente',
	};
}

function location_allows_storage(loc: ImperiumDoc | null) {
	if (!loc) return false;
	return Boolean(loc.permite_almacenaje) && loc.permite_almacenaje !== 'false' && loc.permite_almacenaje !== 0;
}

function opening_qty(value: unknown) {
	return Number((Number(value ?? 0) || 0).toFixed(4));
}

async function import_apertura(ctx: Ctx) {
	const dry_run = Boolean(ctx.body.dry_run);
	const modo = String(ctx.body.modo ?? 'set') === 'delta' ? 'delta' : 'set';
	const crear_ubicaciones =
		ctx.body.crear_ubicaciones === undefined ? true : Boolean(ctx.body.crear_ubicaciones);
	const root = sanitize_location_segment(ctx.body.root_parent_codigo ?? 'ALMACEN') || 'ALMACEN';
	const alias_map = normalize_alias_map(ctx.body.alias_map);
	const lineas = Array.isArray(ctx.body) ? ctx.body : as_array(ctx.body.lineas);
	if (!lineas.length) {
		throw new Error(
			'Debes enviar lineas[] con producto_codigo, ubicación (codigo o path) y cantidad',
		);
	}
	if (lineas.length > 500) {
		throw new Error('Máximo 500 líneas por request. Usa el wizard de apertura (lotes de 100)');
	}
	const errores: ImperiumDoc[] = [];
	const resolved: ImperiumDoc[] = [];
	const ubicaciones_creadas: string[] = [];
	const preview_ubicaciones: ImperiumDoc[] = [];
	for (let i = 0; i < lineas.length; i++) {
		const row = as_object(lineas[i]);
		const fila = Number(row.fila ?? i + 2);
		const raw_qty = row.cantidad ?? row.qty;
		const cantidad =
			raw_qty === undefined || raw_qty === null || raw_qty === '' ? 1 : Number(raw_qty);
		if (!Number.isFinite(cantidad) || (modo === 'set' && cantidad < 0)) {
			errores.push({
				fila,
				mensaje: Number.isFinite(cantidad)
					? 'La cantidad no puede ser negativa (usa modo delta con signo o set absoluto ≥ 0)'
					: `Cantidad inválida: ${String(raw_qty)}`,
				raw: row,
			});
			continue;
		}
		let prod: ImperiumDoc | null = null;
		const pid = String(row.producto ?? '').trim();
		const pcod = String(row.producto_codigo ?? '').trim();
		if (pid) prod = await ctx.store.find_id('products', pid);
		if (!prod && pcod) {
			prod =
				(await ctx.store.find_many('products', { where: { codigo: pcod }, take: 1 })).rows[0] ??
				null;
		}
		if (!prod) {
			errores.push({ fila, mensaje: `Producto no encontrado (${pid || pcod || 'sin clave'})`, raw: row });
			continue;
		}
		let codigo = String(row.ubicacion_codigo ?? '').trim().toUpperCase();
		const alias = String(row.ubicacion_alias ?? '').trim();
		if (!codigo && alias) {
			codigo = alias_map.get(alias) || alias_map.get(alias.toUpperCase()) || '';
		}
		const path = extract_path_from_row(row);
		if (!codigo && path) {
			codigo = composed_codigo_from_path(path, root);
			if (crear_ubicaciones) {
				const ensured = await ensure_location_path(ctx, path, root, dry_run, fila);
				codigo = ensured.leaf_codigo;
				ubicaciones_creadas.push(...ensured.creadas);
				for (const created of ensured.creadas) {
					preview_ubicaciones.push({ codigo: created, path, accion: 'create' });
				}
			}
		} else if (!codigo) {
			codigo = String(row.ubicacion ?? '').trim().toUpperCase();
		}
		if (!codigo) {
			errores.push({
				fila,
				mensaje: alias
					? `No se pudo resolver el alias de ubicación "${alias}" (revisa alias_map, ubicacion_path o ubicacion_codigo)`
					: "Falta ubicacion_codigo, ubicacion_path (ej. 'Zona 1 / Bin A') o columnas zona/subzona",
				raw: row,
			});
			continue;
		}
		const loc = await find_location_by_codigo(ctx, codigo);
		if (!loc) {
			errores.push({
				fila,
				mensaje: crear_ubicaciones
					? `Ubicación no encontrada ni creable (${codigo}). Indica ubicacion_path (ej. "Zona 1 / Bin A") o parent_codigo+segmento_codigo`
					: `Ubicación no encontrada (${codigo}). Activa crear_ubicaciones o importa el árbol antes`,
				raw: row,
			});
			continue;
		}
		if (!location_allows_storage(loc)) {
			errores.push({
				fila,
				mensaje: `La ubicación ${loc.codigo ?? codigo} no permite almacenaje (no es hoja). Usa el último nivel del path como hoja`,
				raw: row,
			});
			continue;
		}
		resolved.push({
			fila,
			producto_id: String(prod._id),
			producto_codigo: String(prod.codigo ?? pcod),
			producto_nombre: String(prod.name ?? ''),
			ubicacion_id: String(loc._id),
			ubicacion_codigo: String(loc.codigo ?? codigo),
			cantidad,
		});
	}
	const aggregated = new Map<string, ImperiumDoc>();
	for (const line of resolved) {
		const key = `${line.producto_id}::${line.ubicacion_id}`;
		const existing = aggregated.get(key);
		if (!existing) {
			aggregated.set(key, { ...line });
			continue;
		}
		if (modo === 'delta') {
			existing.cantidad = opening_qty(Number(existing.cantidad) + Number(line.cantidad));
		} else {
			existing.cantidad = line.cantidad;
			existing.fila = line.fila;
		}
	}
	const preview: ImperiumDoc[] = [];
	const adjustments: ImperiumDoc[] = [];
	for (const line of aggregated.values()) {
		const current = await find_quant_for_pair(
			ctx.store,
			String(line.producto_id),
			String(line.ubicacion_id),
			String(line.ubicacion_codigo),
		);
		const cantidad_actual = opening_qty(current?.cantidad ?? 0);
		const diferencia =
			modo === 'delta'
				? opening_qty(line.cantidad)
				: opening_qty(Number(line.cantidad) - cantidad_actual);
		const item = {
			fila: line.fila,
			producto: line.producto_id,
			producto_codigo: line.producto_codigo,
			ubicacion_codigo: line.ubicacion_codigo,
			cantidad_actual,
			cantidad_objetivo: modo === 'delta' ? opening_qty(cantidad_actual + Number(line.cantidad)) : opening_qty(line.cantidad),
			diferencia,
		};
		preview.push(item);
		if (diferencia) {
			adjustments.push({
				...line,
				...item,
			});
		}
	}
	if (!dry_run && adjustments.length) {
		const running = new Map<string, number>();
		const fecha = new Date();
		for (const adj of adjustments) {
			const product_id = String(adj.producto_id);
			const prod = await ctx.store.find_id('products', product_id);
			if (!prod) continue;
			const previo = running.get(product_id) ?? opening_qty(prod.existencia);
			const resultante = opening_qty(previo + Number(adj.diferencia));
			running.set(product_id, resultante);
			await apply_quant_delta(ctx.store, {
				producto: product_id,
				producto_nombre: String(adj.producto_nombre || prod.name || ''),
				producto_codigo: String(adj.producto_codigo || prod.codigo || ''),
				ubicacion: String(adj.ubicacion_id),
				ubicacion_codigo: String(adj.ubicacion_codigo),
				delta: Number(adj.diferencia),
			});
			await recompute_product_existencia(ctx.store, product_id);
			if (ctx.store.has('inventory-movement')) {
				const apartado = opening_qty(prod.existenciaApartada);
				const delta = Number(adj.diferencia);
				await ctx.store.insert('inventory-movement', {
					name: `Apertura ${adj.producto_codigo || product_id}`,
					description: 'Ajuste manual de inventario por apertura',
					tipo: 'ajuste_manual',
					tipo_movimiento: 'ajuste_manual',
					producto: product_id,
					producto_id: product_id,
					producto_nombre: String(adj.producto_nombre || prod.name || ''),
					producto_codigo: String(adj.producto_codigo || prod.codigo || ''),
					ubicacion_origen: delta < 0 ? adj.ubicacion_id : undefined,
					ubicacion_origen_nombre: delta < 0 ? adj.ubicacion_codigo : '',
					ubicacion_destino: delta > 0 ? adj.ubicacion_id : undefined,
					ubicacion_destino_nombre: delta > 0 ? adj.ubicacion_codigo : '',
					documento_tipo: 'inventory-opening-import',
					documento_modelo: 'InventoryPhysicalCount',
					documento_nombre: 'Importación apertura de inventario',
					documento_referencia: `${adj.ubicacion_codigo}:${adj.producto_codigo || product_id}`,
					cantidad: Math.abs(delta),
					stock_total_previo: previo,
					stock_total_resultante: resultante,
					stock_apartado_previo: apartado,
					stock_apartado_resultante: apartado,
					fecha_movimiento: fecha.toISOString(),
				});
			}
		}
	}
	const a_aplicar = adjustments.length;
	const sin_cambio = preview.length - a_aplicar;
	const unique_created = [...new Set(ubicaciones_creadas)];
	return ok(
		[
			{
				dry_run,
				modo,
				crear_ubicaciones,
				total_filas: lineas.length,
				validas: resolved.length,
				a_aplicar: dry_run ? a_aplicar : undefined,
				aplicados: dry_run ? 0 : a_aplicar,
				sin_cambio,
				ubicaciones_creadas: unique_created,
				preview_ubicaciones,
				preview: preview.filter((row) => Number(row.diferencia) !== 0),
				preview_sin_cambio: preview.filter((row) => Number(row.diferencia) === 0),
				aplicados_detalle: dry_run
					? []
					: adjustments.map((adj) => ({
							fila: adj.fila,
							producto_codigo: adj.producto_codigo,
							ubicacion_codigo: adj.ubicacion_codigo,
							diferencia: adj.diferencia,
						})),
				puede_aplicar: errores.length === 0 && (a_aplicar > 0 || unique_created.length > 0),
				ok: errores.length === 0,
				errores,
			},
		],
		dry_run
			? `Simulación: ${a_aplicar} ajuste(s), ${unique_created.length} ubicación(es) a crear, ${errores.length} error(es)`
			: `Apertura aplicada: ${a_aplicar} ajuste(s), ${unique_created.length} ubicación(es) creada(s), ${errores.length} error(es)`,
	);
}

async function apply_physical_count(ctx: Ctx) {
	const saved = await apply_physical_count_doc(ctx.store, ctx.params.id);
	return ok([saved], 'Conteo aplicado correctamente');
}

async function reception_from_po(ctx: Ctx) {
	const created = await create_reception_from_purchase_order(
		ctx.store,
		ctx.params.purchase_order_id,
		ctx.body,
	);
	return ok([created], 'Recepción pendiente creada correctamente');
}

async function confirm_reception(ctx: Ctx) {
	const rec = await need(
		ctx,
		'inventory-reception',
		ctx.params.id,
		'No se encontró la recepción indicada',
		'No se encontró la recepción indicada',
	);
	const estado = String(rec.estado ?? '');
	if (estado && !['pendiente', 'parcial', 'PENDING', 'PARTIAL'].includes(estado)) {
		throw new Error('La recepción ya fue cerrada o cancelada');
	}
	const requested = as_array(ctx.body.articulos);
	if (!requested.length) throw new Error('Captura al menos una cantidad recibida');
	const items = as_array(rec.articulos).map((x) => as_object(x));
	const lookup = new Map(items.map((i) => [String(i.producto), i]));
	const lines = requested.map((raw, index) => {
		const line = as_object(raw);
		const producto = String(line.producto ?? '');
		const cantidad = Number(line.cantidad ?? 0);
		const item = lookup.get(producto);
		if (!item) throw new Error(`El producto de la línea ${index + 1} no pertenece a esta recepción`);
		if (!(cantidad > 0)) throw new Error(`La cantidad recibida de ${item.producto_nombre} debe ser mayor que cero`);
		const pending = Number(item.cantidad_esperada ?? 0) - Number(item.cantidad_recibida ?? 0);
		if (cantidad > pending) {
			throw new Error(`La cantidad recibida de ${item.producto_nombre} excede lo pendiente`);
		}
		return { producto, cantidad, item };
	});
	for (const line of lines) {
		line.item.cantidad_recibida = Number(line.item.cantidad_recibida ?? 0) + line.cantidad;
	}
	const total_esperado = items.reduce((s, i) => s + Number(i.cantidad_esperada ?? 0), 0);
	const total_recibido = items.reduce((s, i) => s + Number(i.cantidad_recibida ?? 0), 0);
	const next = total_recibido >= total_esperado ? 'recibida' : 'parcial';
	if (rec.purchase_order || rec.orden_compra) {
		await po_apply_receipt(
			ctx,
			String(rec.purchase_order ?? rec.orden_compra),
			lines.map((l) => ({
				producto: l.producto,
				cantidad: l.cantidad,
				costo_unitario: Number(l.item.costo_unitario ?? 0),
			})),
			false,
			`reception-${rec._id}-${Date.now()}`,
			String(ctx.body.referencia ?? rec.referencia ?? ''),
		);
	}
	const updated = await ctx.store.update('inventory-reception', String(rec._id), {
		articulos: items,
		total_esperado,
		total_recibido,
		estado: next,
		fecha_confirmacion: now(),
	});
	return ok([updated], 'Recepción confirmada correctamente');
}

async function create_backorder(ctx: Ctx) {
	const created = await create_reception_backorder(ctx.store, ctx.params.id);
	return ok([created], 'Recepción por faltante creada correctamente');
}

async function acomodar(ctx: Ctx) {
	const updated = await acomodar_reception(ctx.store, ctx.params.id, ctx.body);
	return ok([updated], 'Producto acomodado correctamente');
}

async function reservar(ctx: Ctx) {
	const updated = await reservar_reception(ctx.store, ctx.params.id, ctx.body);
	return ok([updated], 'Mercancía en camino reservada correctamente');
}

async function apply_stock_in(
	ctx: Ctx,
	producto: string,
	cantidad: number,
	costo: number,
	source: ImperiumDoc,
) {
	await apply_purchase_receipt_stock(ctx.store, {
		producto,
		cantidad,
		costo_unitario: costo,
		source,
		receipt_key: `receipt-${source._id}-${Date.now()}`,
	});
}

async function picking_route(ctx: Ctx) {
	const producto = String(ctx.url.searchParams.get('producto') ?? ctx.body.producto ?? '').trim();
	const cantidad = Number(ctx.url.searchParams.get('cantidad') ?? ctx.body.cantidad ?? 0);
	if (!producto || !/^[a-f0-9]{24}$/i.test(producto)) {
		throw new Error('Debes indicar un producto válido');
	}
	if (!(cantidad > 0)) {
		throw new Error('Debes indicar una cantidad mayor a cero');
	}
	const ruta = await compute_picking_route(ctx.store, producto, cantidad);
	return ok([ruta], 'Ruta de surtimiento calculada');
}

async function stock_consistency(ctx: Ctx) {
	const solo_inconsistentes = ctx.url.searchParams.get('solo_inconsistentes') !== '0';
	const reparar = ctx.url.searchParams.get('reparar') === '1';
	// Original: ProductsModel.find + aggregate de quants sin filtrar is_active.
	// Sin inactivos, un producto borrado (sonda o real) con quants vivos
	// aparece como inconsistente con nombre vacío y existencia 0.
	const by_prod = new Map<string, { suma: number; ubicaciones: number }>();
	if (ctx.store.has('inventory-stock-quant')) {
		for await (const page of ctx.store.scan('inventory-stock-quant', {
			include_inactive: true,
		})) {
			for (const q of page) {
				const id = ref_id(q.producto);
				if (!id) continue;
				const cur = by_prod.get(id) ?? { suma: 0, ubicaciones: 0 };
				cur.suma += Number(q.cantidad ?? 0);
				cur.ubicaciones += 1;
				by_prod.set(id, cur);
			}
		}
	}
	const seen = new Set<string>();
	const filas: ImperiumDoc[] = [];
	let inconsistentes = 0;
	let revisados = 0;
	const push_fila = (
		id: string,
		product: ImperiumDoc | undefined,
		quant: { suma: number; ubicaciones: number } | undefined,
	) => {
		const suma_quants = Number((quant?.suma ?? 0).toFixed(4));
		const existencia = Number(Number(product?.existencia ?? 0).toFixed(4));
		const delta = Number((existencia - suma_quants).toFixed(4));
		const consistente = delta === 0;
		if (solo_inconsistentes && consistente) return;
		if (!consistente) inconsistentes += 1;
		filas.push({
			producto_id: id,
			producto_nombre: product?.name ?? '',
			producto_codigo: product?.codigo ?? '',
			existencia,
			suma_quants,
			delta,
			ubicaciones: quant?.ubicaciones ?? 0,
			consistente,
		});
	};
	for await (const page of ctx.store.scan('products', { include_inactive: true })) {
		for (const product of page) {
			const id = String(product._id ?? '');
			if (!id) continue;
			seen.add(id);
			if (!by_prod.has(id) && Number(product.existencia ?? 0) === 0) continue;
			revisados += 1;
			push_fila(id, product, by_prod.get(id));
		}
	}
	for (const id of by_prod.keys()) {
		if (seen.has(id)) continue;
		revisados += 1;
		push_fila(id, undefined, by_prod.get(id));
	}
	let reparados = 0;
	if (reparar) {
		for (const fila of filas) {
			if (fila.consistente) continue;
			await ctx.store.update('products', String(fila.producto_id), {
				existencia: fila.suma_quants,
			});
			reparados += 1;
		}
	}
	return ok(
		[
			{
				total_productos_revisados: revisados,
				inconsistentes,
				reparados,
				filas,
			},
		],
		reparar
			? `Consistencia: ${inconsistentes} inconsistente(s), ${reparados} reparado(s)`
			: `Consistencia: ${inconsistentes} inconsistente(s) de ${revisados} producto(s)`,
	);
}

async function violation_challenge(ctx: Ctx) {
	const id = String(ctx.params.id ?? ctx.body._id ?? '').trim();
	if (!id) throw new Error('Se requiere la infracción a impugnar.');
	const reason = String(ctx.body.reason ?? ctx.body.motivo ?? '').trim();
	if (reason.length < 4) {
		throw new Error('Escribe el motivo de la impugnación (mínimo 4 caracteres).');
	}
	const rec = await ctx.store.find_id('violation', id);
	if (!rec) throw new Error('Registro no encontrado.');
	const status = String(rec.status ?? rec.estado ?? '');
	if (status === 'PAGADA') {
		throw new Error('No se puede impugnar una infracción ya pagada.');
	}
	if (status === 'CANCELADA') {
		throw new Error('La infracción está cancelada.');
	}
	return patch_doc(
		ctx,
		'violation',
		String(rec._id),
		{
			status: 'IMPUGNADA',
			estado: 'IMPUGNADA',
			challenged_reason: reason,
			challenged_at: now(),
			challenged_by_id: actor_id(ctx),
		},
		'Infracción impugnada.',
	);
}

async function invoice_from_order(ctx: Ctx) {
	const generated = await generate_invoice_from_order(ctx.store, ctx.params.orderId);
	return ok([generated.record], generated.message);
}

async function invoice_authorize(ctx: Ctx) {
	const updated = await authorize_invoice_request(
		ctx.store,
		ctx.params.id,
		ctx.actor,
		ctx.body.notas,
	);
	return ok([updated], 'Autorización de cobranza registrada');
}

async function invoice_send_commercial(ctx: Ctx) {
	const updated = await send_invoice_to_commercial(
		ctx.store,
		ctx.params.id,
		ctx.actor,
		ctx.body.comercial_referencia,
	);
	return ok([updated], 'Solicitud enviada a comercial');
}

async function invoice_mark(ctx: Ctx) {
	const updated = await mark_invoice_request(
		ctx.store,
		ctx.params.id,
		ctx.actor,
		ctx.body.factura_referencia,
	);
	return ok([updated], 'Solicitud marcada como facturada');
}

async function invoice_link_cfdi(ctx: Ctx) {
	const rec = await need(
		ctx,
		'invoice-request',
		ctx.params.id,
		'No se encontró la solicitud de facturación.',
		'Debes especificar la solicitud de facturación.',
	);
	const estado = String(rec.estado ?? '').trim().toLowerCase();
	if (estado === 'cancelado' || estado === 'cancelada') {
		throw new Error('No se puede vincular un CFDI a una solicitud cancelada.');
	}
	const cfdi_document_id = String(
		ctx.body.cfdi_document_id ?? ctx.body.cfdiDocumentId ?? '',
	).trim();
	if (!cfdi_document_id) {
		throw new Error('Debes indicar cfdi_document_id para vincular el documento CFDI.');
	}
	const cfdi_document_status = String(
		ctx.body.cfdi_document_status ?? ctx.body.cfdiDocumentStatus ?? '',
	).trim();
	const cfdi_document_name = String(
		ctx.body.cfdi_document_name ?? ctx.body.cfdiDocumentName ?? '',
	).trim();
	const patch: ImperiumDoc = { cfdi_document_id };
	if (cfdi_document_status) patch.cfdi_document_status = cfdi_document_status;
	if (cfdi_document_name) patch.cfdi_document_name = cfdi_document_name;
	return patch_doc(
		ctx,
		'invoice-request',
		String(rec._id),
		patch,
		'Documento CFDI vinculado a la solicitud',
	);
}

async function invoice_cfdi_draft(ctx: Ctx) {
	const rec = await need(
		ctx,
		'invoice-request',
		ctx.params.id,
		'No se encontró la solicitud de facturación.',
		'Debes especificar la solicitud de facturación.',
	);
	const estado = String(rec.estado ?? '').trim().toLowerCase();
	if (estado === 'cancelado' || estado === 'cancelada') {
		throw new Error('No se puede generar un borrador CFDI desde una solicitud cancelada.');
	}
	const draft = await create_cfdi_from_invoice_request({
		store: ctx.store,
		params: { invoiceRequestId: String(rec._id), id: String(rec._id) },
		body: ctx.body,
	});
	const updated = await ctx.store.find_id('invoice-request', String(rec._id));
	const message =
		(draft as { message?: string }).message ||
		'Borrador CFDI solicitado desde la solicitud de facturación';
	return ok([updated ?? rec], message);
}

function message_participants(doc: ImperiumDoc, uid: string): string[] {
	const parts = id_list(
		doc.participants ?? doc.participant_user_ids ?? doc.participantUserIds,
	);
	const extra = [
		ref_id(doc.from),
		ref_id(doc.to),
		ref_id(doc.created_by),
		ref_id(doc.senderUserId),
		ref_id(doc.sender_user_id),
		...id_list(doc.recipientUserIds ?? doc.recipient_user_ids),
	].filter(Boolean);
	return [...new Set([...parts, ...extra].filter(Boolean))];
}

function message_source_type(doc: ImperiumDoc): string {
	return String(doc.sourceType ?? doc.source_type ?? '');
}

function message_conversation_key(doc: ImperiumDoc): string {
	return String(doc.conversationKey ?? doc.conversation_key ?? '').trim();
}

function message_is_unread_for(doc: ImperiumDoc, uid: string): boolean {
	if (!uid) return false;
	const recipients = id_list(doc.recipientUserIds ?? doc.recipient_user_ids);
	const read = id_list(doc.readByUserIds ?? doc.read_by_user_ids);
	return recipients.includes(uid) && !read.includes(uid);
}

function user_messages_match(uid: string) {
	return {
		$or: [
			{ senderUserId: uid },
			{ sender_user_id: uid },
			{ created_by: uid },
			{ recipientUserIds: { $regex: uid } },
			{ participantUserIds: { $regex: uid } },
			{ participants: { $regex: uid } },
		],
	};
}

function consider_latest(rows: ImperiumDoc[], row: ImperiumDoc, limit: number) {
	if (rows.length < limit) {
		rows.push(row);
		rows.sort((a, b) => created_ms(b) - created_ms(a));
		return;
	}
	if (created_ms(row) <= created_ms(rows[rows.length - 1]!)) return;
	rows[rows.length - 1] = row;
	rows.sort((a, b) => created_ms(b) - created_ms(a));
}

async function my_conversations(ctx: Ctx) {
	const uid = actor_id(ctx);
	const groups = new Map<
		string,
		{ latest: ImperiumDoc; unread_count: number; participant_user_ids: string[] }
	>();
	if (uid && ctx.store.has('messages')) {
		for await (const page of ctx.store.scan('messages', {
			mongo_match: user_messages_match(uid),
			include_inactive: true,
		})) {
			for (const m of page) {
				if (message_source_type(m) !== 'chat') continue;
				const key = message_conversation_key(m);
				if (!key) continue;
				const participant_user_ids = id_list(
					m.participantUserIds ?? m.participant_user_ids ?? m.participants,
				);
				if (!participant_user_ids.includes(uid)) continue;
				const cur = groups.get(key);
				if (!cur) {
					groups.set(key, {
						latest: m,
						unread_count: message_is_unread_for(m, uid) ? 1 : 0,
						participant_user_ids,
					});
					continue;
				}
				if (created_ms(m) > created_ms(cur.latest)) {
					cur.latest = m;
					cur.participant_user_ids = participant_user_ids;
				}
				if (message_is_unread_for(m, uid)) cur.unread_count += 1;
			}
		}
	}
	const summaries = [...groups.entries()]
		.map(([conversation_key, group]) => {
			const other_id =
				group.participant_user_ids.find((p) => p !== uid) ??
				group.participant_user_ids[0];
			return {
				conversation_key,
				participant_user_ids: group.participant_user_ids,
				other_participant: other_id
					? {
							_id: other_id,
							name: String(group.latest.name ?? group.latest.title ?? other_id),
						}
					: undefined,
				latest_message: group.latest,
				unread_count: group.unread_count,
			};
		})
		.sort((a, b) => created_ms(b.latest_message) - created_ms(a.latest_message))
		.slice(0, 100);
	return ok(summaries, 'Conversaciones cargadas correctamente.');
}

async function search_chat_messages(ctx: Ctx) {
	const uid = actor_id(ctx);
	const participant_id = String(
		ctx.url.searchParams.get('participant_id') ??
			ctx.url.searchParams.get('participantId') ??
			'',
	).trim();
	const raw_term = String(
		ctx.url.searchParams.get('term') ?? ctx.url.searchParams.get('termino') ?? '',
	).trim();
	if (!raw_term) {
		return ok([], 'Debes indicar un texto para buscar en el chat.');
	}
	const needle = raw_term.toLowerCase();
	const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 25) || 25));
	const expected_key = participant_id ? conversation_key_for([uid, participant_id]) : '';
	const matched: ImperiumDoc[] = [];
	if (uid && ctx.store.has('messages')) {
		for await (const page of ctx.store.scan('messages', {
			mongo_match: user_messages_match(uid),
			include_inactive: true,
		})) {
			for (const row of page) {
				if (message_source_type(row) !== 'chat') continue;
				if (
					!id_list(
						row.participantUserIds ?? row.participant_user_ids ?? row.participants,
					).includes(uid)
				) {
					continue;
				}
				if (participant_id && expected_key && message_conversation_key(row) !== expected_key) {
					continue;
				}
				const snapshots = as_array(row.participantSnapshot ?? row.participant_snapshot);
				const attachments = as_array(row.attachments);
				const reply = as_object(row.replyPreview ?? row.reply_preview);
				const hay = [
					row.search_field,
					row.message,
					row.name,
					row.senderName,
					row.senderEmail,
					row.sender_name,
					row.sender_email,
					...snapshots.flatMap((item) => {
						const rec = as_object(item);
						return [rec.name, rec.email];
					}),
					...attachments.flatMap((item) => {
						const rec = as_object(item);
						return [rec.name, rec.fileExt, rec.mimetype];
					}),
					reply.textPreview,
				]
					.map((v) => String(v ?? '').toLowerCase())
					.join(' ');
				if (!hay.includes(needle)) continue;
				consider_latest(matched, row, limit);
			}
		}
	}
	const hits = matched
		.map((row) => {
			const parts = message_participants(row, uid);
			const other = parts.find((p) => p !== uid) ?? '';
			const conversation_key =
				String(row.conversationKey ?? row.conversation_key ?? '') ||
				[uid, other].filter(Boolean).sort().join('::');
			return {
				conversation_key,
				other_participant: other
					? {
							_id: other,
							name: String(
								row.senderName ??
									as_object(row.participantSnapshot).name ??
									row.name ??
									other,
							),
						}
					: undefined,
				message: row,
			};
		})
		.filter((row) => row.conversation_key);
	return ok(
		hits,
		participant_id
			? 'Coincidencias del chat cargadas correctamente.'
			: 'Coincidencias globales del chat cargadas correctamente.',
	);
}

async function my_messages(ctx: Ctx) {
	const uid = actor_id(ctx);
	const mine: ImperiumDoc[] = [];
	if (uid && ctx.store.has('messages')) {
		for await (const page of ctx.store.scan('messages', {
			mongo_match: user_messages_match(uid),
			include_inactive: true,
		})) {
			for (const m of page) {
				const source = String(m.sourceType ?? m.source_type ?? '');
				if (source === 'chat') continue;
				if (!message_participants(m, uid).includes(uid)) continue;
				consider_latest(mine, m, 200);
			}
		}
	}
	return ok(mine, 'Mensajes', mine.length);
}

async function mark_conversation_as_read(
	store: ImperiumStore,
	uid: string,
	conversation_key: string,
) {
	if (!uid || !conversation_key || !store.has('messages')) return;
	for await (const page of store.scan('messages', {
		mongo_match: {
			$or: [
				{ conversationKey: conversation_key },
				{ conversation_key: conversation_key },
			],
		},
		include_inactive: true,
	})) {
		for (const row of page) {
			if (message_source_type(row) !== 'chat') continue;
			if (message_conversation_key(row) !== conversation_key) continue;
			if (!message_is_unread_for(row, uid)) continue;
			const read = id_list(row.readByUserIds ?? row.read_by_user_ids);
			await store.update('messages', String(row._id), {
				readByUserIds: [...read, uid],
			});
		}
	}
}

async function conversation(ctx: Ctx) {
	const other = String(
		ctx.params.participantId ?? ctx.url.searchParams.get('participant_id') ?? '',
	).trim();
	const uid = actor_id(ctx);
	if (!other) throw new Error('Debes indicar el participante del chat.');
	const expected_key = conversation_key_for([uid, other]);
	if (!expected_key) throw new Error('No fue posible resolver la conversación solicitada.');
	await mark_conversation_as_read(ctx.store, uid, expected_key);
	const size = Math.min(
		500,
		Math.max(1, Number(ctx.url.searchParams.get('size') ?? 250) || 250),
	);
	const { rows } = await ctx.store.find_many('messages', {
		mongo_match: {
			$or: [
				{ conversationKey: expected_key },
				{ conversation_key: expected_key },
			],
		},
		take: size,
		sort: 'created_at:asc',
		include_inactive: true,
		populate: false,
		skip_total: true,
	});
	const mine = rows
		.filter(
			(m) =>
				message_source_type(m) === 'chat' &&
				message_conversation_key(m) === expected_key,
		)
		.sort((a, b) => created_ms(a) - created_ms(b))
		.slice(0, size);
	return ok(mine, 'Historial del chat cargado correctamente.');
}

function conversation_key_for(ids: string[]): string {
	return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort().join('::');
}

function take_chat_attachment_files(body: Record<string, unknown>): Blob[] {
	const files: Blob[] = [];
	const attachments = body.attachments;
	if (Array.isArray(attachments)) {
		for (const item of attachments) {
			if (is_upload(item)) files.push(item);
		}
	} else if (is_upload(attachments)) {
		files.push(attachments);
	}
	delete body.attachments;
	for (const [key, value] of Object.entries(body)) {
		if (!/^attachments\[\d+\]$/.test(key) || !is_upload(value)) continue;
		files.push(value);
		delete body[key];
	}
	return files;
}

function chat_attachment_info(doc: ImperiumDoc) {
	const mime = String(doc.mimetype ?? doc.mime ?? '');
	const size = Number(doc.size_in_kb);
	return {
		attachmentId: String(doc._id ?? ''),
		name: String(doc.name ?? ''),
		fileExt: String(doc.file_ext ?? '') || undefined,
		mimetype: mime || undefined,
		sizeInKb: Number.isFinite(size) ? size : undefined,
		isImage: mime.startsWith('image/'),
	};
}

async function participant_snapshot(ctx: Ctx, ids: string[]) {
	const current = {
		_id: actor_id(ctx),
		name: actor_name(ctx) || undefined,
		email: String(ctx.actor?.email ?? '') || undefined,
		img: String(ctx.actor?.img ?? '') || undefined,
	};
	const others: ImperiumDoc[] = [];
	for (const id of ids) {
		if (!id || id === current._id) continue;
		const user = await ctx.store.find_id('user', id);
		if (!user) continue;
		others.push({
			_id: String(user._id ?? id),
			name: String(user.name ?? '').trim() || undefined,
			email: String(user.email ?? '').trim() || undefined,
			img: String(user.img ?? '').trim() || undefined,
		});
	}
	return [current, ...others];
}

async function create_chat_message(ctx: Ctx) {
	const sender_user_id = actor_id(ctx);
	const files = take_chat_attachment_files(ctx.body);
	const recipient_user_id = String(
		ctx.body.recipient_user_id ?? ctx.body.recipientUserId ?? ctx.body.recipient_id ?? '',
	).trim();
	const message = String(ctx.body.message ?? '').trim();
	if (!recipient_user_id) {
		throw new Error('Debes indicar el usuario destinatario del chat.');
	}
	if (!message && !files.length) {
		throw new Error('Debes escribir un mensaje o adjuntar al menos un archivo.');
	}
	const recipient = await ctx.store.find_id('user', recipient_user_id);
	if (!recipient?._id) {
		throw new Error('No se encontró el destinatario solicitado.');
	}
	const participant_user_ids = [...new Set([sender_user_id, recipient_user_id].filter(Boolean))];
	const conversation_key = conversation_key_for(participant_user_ids);
	if (!conversation_key) {
		throw new Error('No fue posible crear la conversación solicitada.');
	}
	const reply_to = String(
		ctx.body.reply_to_message_id ?? ctx.body.replyToMessageId ?? '',
	).trim();
	let reply_preview: ImperiumDoc | undefined;
	if (reply_to) {
		const replied = await ctx.store.find_id('messages', reply_to);
		if (
			!replied ||
			message_source_type(replied) !== 'chat' ||
			message_conversation_key(replied) !== conversation_key
		) {
			throw new Error(
				'El mensaje que intentas responder no pertenece a esta conversación.',
			);
		}
		reply_preview = {
			messageId: String(replied._id ?? ''),
			senderUserId: String(replied.senderUserId ?? replied.sender_user_id ?? ''),
			senderName: String(replied.senderName ?? replied.sender_name ?? ''),
			textPreview: String(replied.message ?? replied.name ?? 'Mensaje enviado').slice(0, 160),
		};
	}
	const created = await ctx.store.insert('messages', {
		name:
			String(recipient.name ?? '').trim() ||
			String(recipient.email ?? '').trim() ||
			'Chat interno',
		title:
			String(recipient.name ?? '').trim() ||
			String(recipient.email ?? '').trim() ||
			'Chat interno',
		message,
		senderUserId: sender_user_id,
		senderName: actor_name(ctx),
		senderEmail: String(ctx.actor?.email ?? ''),
		recipientUserIds: [recipient_user_id],
		direction: 'internal',
		sourceType: 'chat',
		participantUserIds: participant_user_ids,
		participantSnapshot: await participant_snapshot(ctx, participant_user_ids),
		conversationKey: conversation_key,
		replyToMessageId: reply_to || undefined,
		replyPreview: reply_preview,
		readByUserIds: sender_user_id ? [sender_user_id] : [],
		from: sender_user_id,
		to: recipient_user_id,
		created_by: sender_user_id,
		fecha: now(),
	});
	if (!files.length) {
		emit_messages_refresh([sender_user_id, recipient_user_id], {
			reason: 'created',
			conversation_key,
			message_ids: created._id ? [String(created._id)] : undefined,
			message: created,
		});
		return ok([created], 'Mensaje del chat enviado correctamente.');
	}
	const infos = [];
	try {
		for (const file of files) {
			const attachment = await persist_upload_as_attachment(ctx.store, file, {
				actor_id: sender_user_id,
				related_model: 'Message',
				related_record_id: String(created._id ?? ''),
				field: 'attachments',
				index_if_is_array: infos.length,
				inside_array: true,
			});
			infos.push(chat_attachment_info(attachment));
		}
	} catch (error) {
		await ctx.store.remove('messages', String(created._id ?? ''));
		throw error;
	}
	const updated = await ctx.store.update('messages', String(created._id ?? ''), {
		attachments: infos,
	});
	const sent = updated ?? created;
	emit_messages_refresh([sender_user_id, recipient_user_id], {
		reason: 'created',
		conversation_key,
		message_ids: sent._id ? [String(sent._id)] : undefined,
		message: sent,
	});
	return ok([sent], 'Mensaje del chat enviado correctamente.');
}

async function create_internal_message(ctx: Ctx) {
	const title = String(ctx.body.title ?? '').trim();
	const message = String(ctx.body.message ?? '').trim();
	const sender_user_id = actor_id(ctx);
	const recipient_user_ids = interinstance_recipients(
		ctx.body.recipient_user_ids ?? ctx.body.recipient_ids,
	);
	if (!title || !message) {
		throw new Error('Debes definir título y mensaje para enviar.');
	}
	if (!recipient_user_ids.length) {
		throw new Error('Debes definir al menos un destinatario.');
	}
	const created = await ctx.store.insert('messages', {
		name: title,
		title,
		message,
		senderUserId: sender_user_id,
		senderName: actor_name(ctx),
		senderEmail: String(ctx.actor?.email ?? ''),
		recipientUserIds: recipient_user_ids,
		direction: 'internal',
		sourceType: 'internal',
		participantUserIds: [...new Set([sender_user_id, ...recipient_user_ids].filter(Boolean))],
		readByUserIds: sender_user_id ? [sender_user_id] : [],
		relatedTicketId: String(ctx.body.related_ticket_id ?? '').trim() || undefined,
		from: sender_user_id,
		created_by: sender_user_id,
		fecha: now(),
	});
	await notify_message_recipients(ctx.store, created);
	return ok([created], 'Mensaje interno enviado correctamente.');
}

function interinstance_text(value: unknown) {
	return String(value ?? '').trim();
}

function interinstance_recipients(value: unknown) {
	if (Array.isArray(value)) {
		return value.map((item) => interinstance_text(item)).filter(Boolean);
	}
	if (typeof value === 'string' && value.trim()) {
		try {
			return interinstance_recipients(JSON.parse(value));
		} catch {
			return value.split(',').map((item) => item.trim()).filter(Boolean);
		}
	}
	return [];
}

function interinstance_participants(sender: string, recipients: string[]) {
	return [...new Set([sender, ...recipients].filter(Boolean))];
}

async function create_interinstance_message(ctx: Ctx) {
	const settings = await messaging_settings(ctx.store);
	if (!settings.messaging_enabled) {
		return deny_interinstance('La mensajería está deshabilitada.', 403);
	}
	if (!settings.interinstance_enabled) {
		return deny_interinstance('La mensajería interinstancia está deshabilitada.', 403);
	}
	const { endpoint } = await assert_interinstance_outbound(ctx.store, 'messages');
	const title = interinstance_text(ctx.body.title);
	const message = interinstance_text(ctx.body.message);
	if (!title || !message) {
		throw new Error('Debes definir título y mensaje para enviar.');
	}
	const sender_user_id = actor_id(ctx);
	const sender_name = actor_name(ctx);
	const sender_email = String(ctx.actor?.email ?? '');
	const recipient_user_ids = interinstance_recipients(
		ctx.body.recipient_user_ids ?? ctx.body.recipient_ids,
	);
	const payload =
		ctx.body.payload && typeof ctx.body.payload === 'object'
			? as_object(ctx.body.payload)
			: undefined;
	const forward_payload = {
		title,
		message,
		recipient_user_ids,
		related_ticket_id: interinstance_text(ctx.body.related_ticket_id) || undefined,
		payload,
		instance_data: {
			label: settings.instance_label,
			version: settings.instance_version,
			generatedAt: now(),
		},
		sender: {
			user_id: sender_user_id,
			name: sender_name,
			email: sender_email,
		},
	};
	const forward_result = await forward_interinstance(
		endpoint,
		settings.interinstance_api_key,
		forward_payload,
	);
	const created = await ctx.store.insert('messages', {
		name: title,
		title,
		message,
		senderUserId: sender_user_id,
		senderName: sender_name,
		senderEmail: sender_email,
		recipientUserIds: recipient_user_ids,
		direction: 'outbound',
		sourceType: 'interinstance',
		participantUserIds: interinstance_participants(sender_user_id, recipient_user_ids),
		readByUserIds: sender_user_id ? [sender_user_id] : [],
		relatedTicketId: interinstance_text(ctx.body.related_ticket_id) || undefined,
		payload: { ...(payload ?? {}), interinstance_delivery: forward_result },
		instanceData: forward_payload.instance_data,
		from: sender_user_id,
		created_by: sender_user_id,
		fecha: now(),
	});
	await notify_message_recipients(ctx.store, created);
	return ok(
		[created],
		forward_result.delivered
			? 'Mensaje interinstancia enviado correctamente.'
			: 'Mensaje interinstancia registrado localmente, pero no se pudo entregar al endpoint remoto.',
	);
}

async function receive_interinstance_message(ctx: Ctx) {
	const settings = await messaging_settings(ctx.store);
	if (!settings.messaging_enabled) {
		return deny_interinstance('La mensajería está deshabilitada.', 403);
	}
	if (!settings.interinstance_enabled) {
		return deny_interinstance('La mensajería interinstancia está deshabilitada.', 403);
	}
	try {
		await validate_interinstance_api_key(ctx.store, interinstance_key_from_req(ctx.req));
	} catch (error) {
		return deny_interinstance(
			error instanceof Error ? error.message : 'Clave interinstancia inválida.',
			401,
		);
	}
	const title = interinstance_text(ctx.body.title);
	const message = interinstance_text(ctx.body.message);
	if (!title || !message) {
		throw new Error('Debes definir título y mensaje para registrar.');
	}
	const sender = as_object(ctx.body.sender);
	const sender_user_id = interinstance_text(sender.user_id);
	const recipient_user_ids = interinstance_recipients(
		ctx.body.recipient_user_ids ?? ctx.body.recipient_ids,
	);
	const created = await ctx.store.insert('messages', {
		name: title,
		title,
		message,
		senderUserId: sender_user_id,
		senderName: interinstance_text(sender.name),
		senderEmail: interinstance_text(sender.email),
		recipientUserIds: recipient_user_ids,
		direction: 'inbound',
		sourceType: 'interinstance',
		participantUserIds: interinstance_participants(sender_user_id, recipient_user_ids),
		readByUserIds: sender_user_id ? [sender_user_id] : [],
		relatedTicketId: interinstance_text(ctx.body.related_ticket_id) || undefined,
		payload:
			ctx.body.payload && typeof ctx.body.payload === 'object'
				? as_object(ctx.body.payload)
				: undefined,
		instanceData:
			ctx.body.instance_data && typeof ctx.body.instance_data === 'object'
				? as_object(ctx.body.instance_data)
				: undefined,
		from: sender_user_id,
		fecha: now(),
	});
	await notify_message_recipients(ctx.store, created);
	return ok([created], 'Mensaje interinstancia recibido correctamente.');
}

async function payroll_drafts(ctx: Ctx) {
	const summary = await generate_payroll_drafts(ctx.store, String(ctx.params.id ?? ''));
	return ok([summary], `Borradores generados: ${summary.created} creados, ${summary.updated} actualizados`);
}

async function payroll_prepare_stamp(ctx: Ctx) {
	const { receipt, handoff } = await prepare_payroll_stamp(ctx.store, String(ctx.params.id ?? ''));
	return ok([receipt], handoff.message);
}

async function payroll_export_payload(ctx: Ctx) {
	const payload = await export_payroll_payload(ctx.store, String(ctx.params.id ?? ''));
	return ok([payload], 'Payload CFDI N exportado (sin timbrar)');
}


const PEDIDO_ESTADOS = new Set([
	'borrador',
	'confirmado',
	'por_surtir',
	'surtiendo',
	'surtido',
	'enviado',
	'cancelado',
]);

/**
 * Sync-back de pedidos capturados offline. Mismo contrato que
 * `POST /pedidos/offline/sincronizar` del backend original: `{ ok, total, resultados }`
 * con dedupe por `offline_uuid`.
 */
async function pedidos_sync_offline(ctx: Ctx) {
	const incoming = as_array(ctx.body.pedidos);
	const resultados: Array<{
		offline_uuid: string;
		_id?: string;
		folio_interno?: unknown;
		status: 'creado' | 'duplicado' | 'error';
		error?: string;
	}> = [];
	for (const raw of incoming) {
		const pedido = as_object(raw);
		const offline_uuid = String(pedido.offline_uuid ?? pedido._id ?? '').trim();
		if (!offline_uuid) {
			resultados.push({
				offline_uuid: '',
				status: 'error',
				error: 'Falta el identificador local del pedido',
			});
			continue;
		}
		try {
			const existing = await ctx.store.find_where('pedidos', { offline_uuid });
			if (existing) {
				resultados.push({
					offline_uuid,
					_id: String(existing._id),
					folio_interno: existing.folio_interno,
					status: 'duplicado',
				});
				continue;
			}
			const estado = PEDIDO_ESTADOS.has(String(pedido.estado))
				? String(pedido.estado)
				: 'confirmado';
			const prepared = await prepare_pedido_create(
				ctx.store,
				{
					name: String(pedido.name ?? pedido.folio ?? `Pedido ${offline_uuid.slice(0, 8)}`),
					articulos: Array.isArray(pedido.articulos) ? pedido.articulos : [],
					contacto: pedido.contacto,
					observaciones: pedido.observaciones ?? '',
					listaDePreciosId: pedido.listaDePreciosId,
					folio: pedido.folio ?? '',
					ubicacion: pedido.ubicacion,
					estado,
				},
				ctx.actor,
			);
			const created = await ctx.store.insert('pedidos', {
				...prepared,
				sincronizado: true,
				offline_uuid,
				is_active: true,
			});
			resultados.push({
				offline_uuid,
				_id: String(created._id),
				folio_interno: created.folio_interno,
				status: 'creado',
			});
		} catch (item_error) {
			resultados.push({
				offline_uuid,
				status: 'error',
				error:
					item_error instanceof Error
						? item_error.message
						: 'Error al sincronizar el pedido',
			});
		}
	}
	if (resultados.some((item) => item.status === 'creado')) {
		emit_pedidos_updated();
	}
	return Response.json({ ok: true, total: resultados.length, resultados });
}

/**
 * Descarga de listas de precio para PouchDB. Mismo contrato que el original:
 * `{ listasDePrecios }` con name, iva y product[] (sin popular).
 */
async function lista_de_precios_sync_offline(ctx: Ctx) {
	const rows = await collect_scan(ctx.store, 'lista-de-precios', {
		fields: ['name', 'iva', 'product', 'productos'],
	});
	const listasDePrecios = rows.map((row) => {
		let product = row.product ?? row.productos ?? [];
		if (typeof product === 'string') {
			try {
				product = JSON.parse(product);
			} catch {
				product = [];
			}
		}
		return {
			_id: row._id,
			name: row.name,
			iva: Number(row.iva ?? 0),
			product: Array.isArray(product) ? product : [],
		};
	});
	return Response.json({ listasDePrecios });
}

const SKU_OFFLINE_OMIT = new Set([
	'produccion',
	'existenciaAlmacenes',
	'lotes',
	'proveedores',
]);

/**
 * Catálogo de SKU vendibles para PouchDB. Mismo contrato que
 * `GET|USE /sku/offline/sincronizar` del original: `{ skus }` sin
 * producción, almacenes, lotes ni proveedores.
 */
async function sku_sync_offline(ctx: Ctx) {
	if (!ctx.store.has('sku')) return Response.json({ skus: [] });
	const rows = await collect_scan(ctx.store, 'sku', {
		where: { puedoVenderlo: true },
		omit: [...SKU_OFFLINE_OMIT],
	});
	const skus = rows
		.filter((row) => row.is_active !== false && row.puedoVenderlo === true)
		.map((row) => {
			const out: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				if (SKU_OFFLINE_OMIT.has(key) || key === 'payload') continue;
				out[key] = value;
			}
			return out;
		});
	return Response.json({ skus });
}

function session_employee_id(ctx: Ctx) {
	const raw = ctx.actor?.employee;
	if (raw == null || raw === '') return '';
	if (typeof raw === 'object') return String((raw as { _id?: unknown })._id ?? '');
	return String(raw).trim();
}

async function reclamar_surtir(ctx: Ctx) {
	if (!is_seed_admin(ctx.actor)) {
		const refs = await actor_group_refs(ctx.store, ctx.actor);
		if (!refs.includes(GROUP_REF_ALMACEN) && !refs.includes(GROUP_REF_SURTIDORES)) {
			throw new Error('No tienes permiso para reclamar pedidos para surtir.');
		}
	}
	const employee_id = session_employee_id(ctx);
	if (!employee_id || !/^[a-f0-9]{24}$/i.test(employee_id)) {
		throw new Error(
			'Tu usuario no tiene un empleado vinculado. Configúralo en Usuarios antes de surtir.',
		);
	}
	const id = String(ctx.params.id ?? '').trim();
	if (!id || !/^[a-f0-9]{24}$/i.test(id)) {
		throw new Error('Identificador de pedido no válido.');
	}
	const pedido = await ctx.store.find_id('pedidos', id);
	if (!pedido) throw new Error('Pedido no encontrado.');
	const assigned = ref_id(pedido.assigned_employee);
	const estado = String(pedido.estado ?? '');
	if (estado === 'surtiendo') {
		if (assigned && assigned !== employee_id) {
			throw new Error('Este pedido ya lo está surtiendo otro empleado.');
		}
		if (!assigned) {
			const updated = await ctx.store.update('pedidos', id, {
				assigned_employee: employee_id,
				init_time: pedido.init_time ?? now(),
			});
			emit_pedidos_updated();
			return ok([updated ?? pedido], 'Pedido ya asignado a ti');
		}
		return ok([pedido], 'Pedido ya asignado a ti');
	}
	if (estado !== 'por_surtir') {
		throw new Error(`Este pedido no está disponible para surtir (estado: ${estado}).`);
	}
	if (assigned && assigned !== employee_id) {
		throw new Error('Este pedido ya está asignado a otro empleado.');
	}
	if (!is_seed_admin(ctx.actor)) {
		const refs = await actor_group_refs(ctx.store, ctx.actor);
		if (!refs.includes(GROUP_REF_ALMACEN) && !refs.includes(GROUP_REF_SURTIDORES)) {
			throw new Error(
				'No tienes permiso para cambiar el pedido de "por_surtir" a "surtiendo". Esta acción está reservada al grupo correspondiente.',
			);
		}
	}
	const updated = await ctx.store.update('pedidos', id, {
		estado: 'surtiendo',
		assigned_employee: employee_id,
		init_time: now(),
	});
	emit_pedidos_updated();
	return ok([updated ?? pedido], 'Pedido reclamado para surtir');
}

async function pos_next_consecutive(ctx: Ctx) {
	const next_consecutive = await preview_pos_consecutive(ctx.store);
	return ok([{ next_consecutive, next_sequence: next_consecutive }], 'Siguiente consecutivo obtenido correctamente');
}

async function pos_last_closure(ctx: Ctx) {
	const reference = await build_last_closure_reference(ctx.store, ctx.params.branch_office_id);
	return ok(
		[reference],
		reference.found
			? 'Referencia del último cierre obtenida correctamente'
			: 'No existe una sesión cerrada previa en la sucursal indicada',
	);
}

async function pos_runtime(ctx: Ctx) {
	const session_id = String(ctx.params.id ?? '').trim();
	if (!session_id) throw new Error('Se requiere el id de la sesión POS');
	const session = await ctx.store.find_id('pos-session', session_id);
	assert_pos_runtime_writable(session, ctx.actor);
	const runtime_state = normalize_pos_runtime_state(ctx.body.runtime_state ?? ctx.body);
	await ctx.store.update('pos-session', session_id, { runtime_state });
	return ok([runtime_state], 'Estado operativo del POS guardado correctamente');
}

async function pos_session_for_report(ctx: Ctx) {
	const session = ctx.params.id
		? await ctx.store.find_id('pos-session', ctx.params.id)
		: null;
	if (!session || session.is_active === false) {
		throw new Error('No se encontró la sesión solicitada');
	}
	return session;
}

async function pos_report(ctx: Ctx, tipo: string) {
	await assert_pos_pin(
		ctx.store,
		ctx.req,
		String(ctx.params.id ?? ''),
		tipo === 'cierre'
			? { method: 'POST', path: '/pos-session/report/close/:id', label: 'Reporte de cierre POS' }
			: { method: 'GET', path: '/pos-session/report/partial/:id', label: 'Reporte parcial POS' },
		ctx.actor,
	);
	const session = await pos_session_for_report(ctx);
	if (tipo === 'cierre' && !is_pos_session_open(session)) {
		throw new Error('Solo se puede generar el cierre para sesiones abiertas');
	}
	const report = await build_pos_session_report(
		ctx.store,
		session,
		tipo === 'cierre' ? POS_REPORT_CLOSE : POS_REPORT_PARTIAL,
		actor_name(ctx),
	);
	return ok(
		[report],
		tipo === 'cierre'
			? 'Cierre de caja generado correctamente'
			: 'Reporte parcial generado correctamente',
	);
}

async function pos_conclude(ctx: Ctx) {
	await assert_pos_pin(
		ctx.store,
		ctx.req,
		String(ctx.params.id ?? ''),
		{
			method: 'POST',
			path: '/pos-session/report/close/conclude/:id',
			label: 'Concluir cierre POS',
		},
		ctx.actor,
	);
	const session = await pos_session_for_report(ctx);
	if (!is_pos_session_open(session)) {
		throw new Error('Solo se puede concluir el cierre para sesiones abiertas');
	}
	const updated = await ctx.store.update(
		'pos-session',
		String(session._id),
		conclude_pos_session_patch(session),
	);
	return ok([updated], 'Cierre de caja concluido correctamente');
}

async function pos_cancel(ctx: Ctx) {
	await assert_pos_pin(
		ctx.store,
		ctx.req,
		String(ctx.params.id ?? ''),
		{ method: 'POST', path: '/pos-session/cancel/:id', label: 'Cancelar sesion POS' },
		ctx.actor,
	);
	const session = await pos_session_for_report(ctx);
	if (!is_pos_session_open(session)) {
		throw new Error('Solo se pueden cancelar sesiones abiertas');
	}
	return patch_doc(
		ctx,
		'pos-session',
		String(session._id),
		cancel_pos_session_patch(session),
		'Sesión cancelada correctamente',
	);
}

async function po_approve(ctx: Ctx) {
	const po = await need(
		ctx,
		'purchase-order',
		ctx.params.id,
		'No se encontró la orden o ya fue aprobada previamente',
		'Se necesita el id de la orden de compra',
	);
	const estado = String(po.estado ?? po.state ?? 'borrador');
	if (estado !== 'borrador' && estado !== 'DRAFT') {
		throw new Error('No se encontró la orden o ya fue aprobada previamente');
	}
	const updated = await ctx.store.update('purchase-order', String(po._id), {
		estado: 'aprobada',
		state: 'aprobada',
		fecha_aprobacion: now(),
		aprobado_por: actor_id(ctx),
		aprobado_por_nombre: actor_name(ctx),
	});
	await ensure_pending_reception_from_purchase_order(ctx.store, updated ?? po);
	return ok([updated], 'Orden de compra aprobada correctamente');
}

async function po_receive(ctx: Ctx, confirm_all: boolean) {
	const po = await need(
		ctx,
		'purchase-order',
		ctx.params.id,
		'No se encontró la orden de compra indicada',
		'Se necesita el id de la orden de compra',
	);
	if (String(po.estado) === 'archivada') throw new Error('No puedes recibir una orden archivada');
	if (String(po.estado) === 'confirmada') throw new Error('La orden de compra ya fue recibida por completo');
	const articulos = as_array(po.articulos).map(as_object);
	if (!articulos.length) throw new Error('La orden de compra no tiene partidas para recibir');
	const requested = confirm_all && !as_array(ctx.body.articulos).length
		? articulos.map((a) => ({
				producto: a.producto ?? a.product_id,
				cantidad: Number(a.cantidad ?? 0) - Number(a.cantidad_recibida ?? 0),
				costo_unitario: Number(a.costo_unitario ?? 0),
			}))
		: as_array(ctx.body.articulos).map(as_object);
	if (!requested.length) throw new Error('La orden de compra no tiene cantidades pendientes por recibir');
	const receipt_key = String(ctx.body.receipt_key ?? '').trim() || `receipt-${po._id}-${Date.now()}`;
	const updated = await po_apply_receipt(
		ctx,
		String(po._id),
		requested.map((l) => ({
			producto: String(l.producto ?? l.product_id ?? ''),
			cantidad: Number(l.cantidad ?? 0),
			costo_unitario: Number(l.costo_unitario ?? 0),
			ubicacion_destino: String(l.ubicacion_destino ?? ''),
			ubicacion_destino_nombre: String(l.ubicacion_destino_nombre ?? ''),
		})),
		confirm_all,
		receipt_key,
		String(ctx.body.referencia ?? ''),
	);
	return ok(
		[updated],
		confirm_all ? 'Orden de compra confirmada correctamente' : 'Recepción registrada correctamente',
	);
}

async function po_apply_receipt(
	ctx: Ctx,
	po_id: string,
	lines: Array<{
		producto: string;
		cantidad: number;
		costo_unitario: number;
		ubicacion_destino?: string;
		ubicacion_destino_nombre?: string;
	}>,
	force_confirm: boolean,
	receipt_key = `receipt-${po_id}-${Date.now()}`,
	referencia = '',
): Promise<ImperiumDoc> {
	const po = await need(ctx, 'purchase-order', po_id, 'No se encontró la orden de compra indicada');
	const articulos = as_array(po.articulos).map(as_object);
	for (const line of lines) {
		const item = articulos.find((a) => String(a.producto ?? a.product_id) === line.producto);
		if (!item) throw new Error('El producto de la recepción no existe en la orden');
		const pending = Number(item.cantidad ?? 0) - Number(item.cantidad_recibida ?? 0);
		if (line.cantidad > pending + 1e-6) {
			throw new Error(`La recepción de ${item.producto_nombre ?? line.producto} excede la cantidad pendiente`);
		}
		item.cantidad_recibida = Number(item.cantidad_recibida ?? 0) + line.cantidad;
		await apply_purchase_receipt_stock(ctx.store, {
			producto: line.producto,
			cantidad: line.cantidad,
			costo_unitario: line.costo_unitario || Number(item.costo_unitario ?? 0),
			source: po,
			receipt_key,
			ubicacion_destino: line.ubicacion_destino,
			ubicacion_destino_nombre: line.ubicacion_destino_nombre,
			referencia,
		});
	}
	const total = articulos.reduce((s, a) => s + Number(a.cantidad ?? 0), 0);
	const rec = articulos.reduce((s, a) => s + Number(a.cantidad_recibida ?? 0), 0);
	const estado = rec >= total || force_confirm ? 'confirmada' : rec > 0 ? 'parcialmente_recibida' : String(po.estado ?? 'aprobada');
	const recepciones = as_array(po.recepciones);
	recepciones.push({ fecha: now(), articulos: lines, usuario: actor_name(ctx) });
	return (await ctx.store.update('purchase-order', po_id, {
		articulos,
		recepciones,
		estado,
		state: estado,
		total_recibido: rec,
		fecha_confirmacion: estado === 'confirmada' ? now() : po.fecha_confirmacion,
	}))!;
}

async function po_register_invoice(ctx: Ctx) {
	const po = await need(
		ctx,
		'purchase-order',
		ctx.params.id,
		'No se encontró la orden de compra indicada',
		'Se necesita el id de la orden de compra',
	);
	const invoice = normalize_supplier_invoice(ctx.body, 0);
	const facturas = as_array(po.facturas_proveedor).map(as_object);
	if (facturas.some((row) => String(row.numero_factura) === invoice.numero_factura)) {
		throw new Error('La factura del proveedor ya está registrada');
	}
	facturas.push(invoice);
	return patch_doc(
		ctx,
		'purchase-order',
		String(po._id),
		{ facturas_proveedor: facturas },
		'Factura de proveedor registrada correctamente',
	);
}

const SUPPLIER_INVOICE_STATES = new Set(['pendiente', 'parcial', 'pagada']);

function normalize_supplier_invoice(raw: ImperiumDoc, index: number): ImperiumDoc {
	const numero_factura = String(raw.numero_factura ?? '').trim();
	if (!numero_factura) {
		throw new Error(`La factura ${index + 1} requiere número de factura`);
	}
	const estado = SUPPLIER_INVOICE_STATES.has(String(raw.estado ?? ''))
		? String(raw.estado)
		: 'pendiente';
	const fecha_raw = raw.fecha_factura ?? raw.fecha;
	const fecha = fecha_raw ? new Date(String(fecha_raw)) : new Date();
	if (Number.isNaN(fecha.getTime())) {
		throw new Error(`El campo facturas_proveedor[${index}].fecha_factura no contiene una fecha válida`);
	}
	const monto = Number(raw.monto_total ?? 0);
	if (!Number.isFinite(monto)) {
		throw new Error(`El campo facturas_proveedor[${index}].monto_total debe ser numérico`);
	}
	return {
		numero_factura,
		fecha_factura: fecha.toISOString(),
		monto_total: Number(monto.toFixed(6)),
		estado,
		notas: String(raw.notas ?? '').trim(),
	};
}

async function po_replenish(ctx: Ctx) {
	const result = await generate_replenishment_for_order(ctx.store, String(ctx.params.pedido_id ?? ''));
	return ok([result], 'Reabasto automático actualizado');
}

async function resolve_report_module(ctx: Ctx, raw: string) {
	if (!ctx.store.has('module-management')) return null;
	const ident = String(raw ?? '').trim();
	if (!ident) return null;
	if (/^[a-f0-9]{24}$/i.test(ident)) {
		const by_id = await ctx.store.find_id('module-management', ident);
		if (by_id) return by_id;
	}
	return (
		(await ctx.store.find_where('module-management', { model_id: ident })) ??
		(await ctx.store.find_where('module-management', { module_name: ident })) ??
		(await ctx.store.find_where('module-management', { name: ident }))
	);
}

async function resolve_report_target(ctx: Ctx, raw: string) {
	const ident = String(raw ?? '').trim();
	if (!ident) throw new Error('No se recibió un identificador de modelo válido');
	const module_record = await resolve_report_module(ctx, ident);
	if (module_record && module_record.is_enable === false) {
		throw new Error(
			`El módulo '${String(module_record.name || module_record.model_id || ident)}' está deshabilitado`,
		);
	}
	const model_name = String(module_record?.model_id || ident);
	try {
		const resource = resolve_model(ctx, model_name);
		await assert_target_model_read(ctx.store, ctx.actor, resource);
		return resource;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('Modelo desconocido:')) {
			throw new Error(`Model ${model_name} not found`);
		}
		throw error;
	}
}

async function report_first(ctx: Ctx) {
	const model = ctx.params.model_name ?? ctx.params.modelName ?? '';
	try {
		const resource = await resolve_report_target(ctx, model);
		const { rows } = await ctx.store.find_many(resource, {
			take: 1,
			sort: 'id:asc',
			populate: false,
		});
		const raw = rows[0] ?? null;
		const [populated] = raw
			? await ctx.store.populate_docs(resource, [raw], { full: true })
			: [null];
		const record = populated
			? await hydrate_loose_product_references(ctx.store, populated)
			: null;
		return ok(record ? [record] : [], record ? 'Record found' : 'No record found', record ? 1 : 0);
	} catch {
		return ok([], 'No record found');
	}
}

const REPORT_SYSTEM_PATHS = new Set([
	'_id',
	'id',
	'__v',
	'createdAt',
	'updatedAt',
	'created_at',
	'updated_at',
	'search_field',
	'_ref',
	'_name',
	'ref',
	'payload',
	'custom_data',
]);

function is_report_system_path(path: string) {
	if (!path) return true;
	if (path.startsWith('_')) return true;
	return REPORT_SYSTEM_PATHS.has(path);
}

function report_pg_type(pg?: string) {
	if (pg === 'boolean') return 'Boolean';
	if (pg === 'number') return 'Number';
	if (pg === 'json') return 'Mixed';
	return 'String';
}

function report_related_candidates(ctx: Ctx, model_name: string) {
	const target = ctx.store.resource_for_model(model_name);
	const base = [
		{ field_name: 'name', field_type: 'String', is_required: false },
		{ field_name: 'description', field_type: 'String', is_required: false },
		{ field_name: 'is_active', field_type: 'Boolean', is_required: false },
	];
	if (!target || !ctx.store.has(target)) return base;
	const seen = new Set(base.map((f) => f.field_name));
	for (const col of ctx.store.loc(target).columns) {
		if (is_report_system_path(col.name) || seen.has(col.name)) continue;
		seen.add(col.name);
		base.push({
			field_name: col.name,
			field_type: report_pg_type(col.pg),
			is_required: false,
		});
	}
	return base;
}

function report_json_item_fields(value: unknown) {
	const item = Array.isArray(value) ? value[0] : value;
	if (!item || typeof item !== 'object') return [];
	const obj = as_object(item);
	const related: Array<{ field_name: string; field_type: string; is_required: boolean }> = [];
	for (const [key, raw] of Object.entries(obj)) {
		if (is_report_system_path(key)) continue;
		const kind =
			typeof raw === 'number'
				? 'Number'
				: typeof raw === 'boolean'
					? 'Boolean'
					: Array.isArray(raw)
						? 'Array'
						: raw && typeof raw === 'object'
							? 'ObjectID'
							: 'String';
		related.push({ field_name: key, field_type: kind, is_required: false });
	}
	const product_key = related.find((f) =>
		['product', 'producto', 'product_id', 'producto_id'].includes(f.field_name),
	);
	if (product_key) {
		for (const nested of ['name', 'codigo', 'description', 'descripcion']) {
			related.push({
				field_name: `${product_key.field_name}.${nested}`,
				field_type: 'String',
				is_required: false,
			});
		}
	}
	return related;
}

async function build_report_field_metadata(ctx: Ctx, resource: string) {
	const loc = ctx.store.loc(resource);
	const refs = ctx.store.field_refs(resource);
	/* El original valida contra el schema Mongoose (todas las paths), no contra
	 * un sample name ASC. Campos de payload como `observaciones` viven en filas
	 * leftover y no en columnas SQL. */
	const payload_keys = new Set<string>();
	let sample: ImperiumDoc = {};
	for await (const page of ctx.store.scan(resource, { include_inactive: true })) {
		for (const row of page) {
			for (const key of Object.keys(row)) payload_keys.add(key);
			if (
				Array.isArray(row.articulos) &&
				as_array(row.articulos).length &&
				!Array.isArray(sample.articulos)
			) {
				sample = row;
			} else if (!Object.keys(sample).length) {
				sample = row;
			}
		}
	}
	const fields: Array<{
		field_name: string;
		field_type: string;
		is_required: boolean;
		is_reference: boolean;
		reference_model: string | null;
		is_array: boolean;
		related_fields: Array<{ field_name: string; field_type: string; is_required: boolean }>;
	}> = [];
	const seen = new Set<string>();
	const push = (field: (typeof fields)[number]) => {
		if (seen.has(field.field_name) || is_report_system_path(field.field_name)) return;
		seen.add(field.field_name);
		fields.push(field);
	};
	push({
		field_name: 'name',
		field_type: 'String',
		is_required: true,
		is_reference: false,
		reference_model: null,
		is_array: false,
		related_fields: [],
	});
	push({
		field_name: 'description',
		field_type: 'String',
		is_required: false,
		is_reference: false,
		reference_model: null,
		is_array: false,
		related_fields: [],
	});
	push({
		field_name: 'is_active',
		field_type: 'Boolean',
		is_required: false,
		is_reference: false,
		reference_model: null,
		is_array: false,
		related_fields: [],
	});
	for (const col of loc.columns) {
		const reference_model = refs[col.name] ?? null;
		const sample_value = sample[col.name];
		const is_array = Array.isArray(sample_value) || col.pg === 'json';
		push({
			field_name: col.name,
			field_type: reference_model ? 'ObjectID' : is_array && Array.isArray(sample_value) ? 'Array' : report_pg_type(col.pg),
			is_required: false,
			is_reference: Boolean(reference_model),
			reference_model,
			is_array: Boolean(is_array && !reference_model),
			related_fields: reference_model
				? report_related_candidates(ctx, reference_model)
				: is_array
					? report_json_item_fields(sample_value)
					: [],
		});
	}
	for (const [field_name, reference_model] of Object.entries(refs)) {
		push({
			field_name,
			field_type: 'ObjectID',
			is_required: false,
			is_reference: true,
			reference_model,
			is_array: false,
			related_fields: report_related_candidates(ctx, reference_model),
		});
	}
	for (const [field_name, raw] of Object.entries(sample)) {
		if (seen.has(field_name) || is_report_system_path(field_name)) continue;
		const reference_model = refs[field_name] ?? null;
		const is_array = Array.isArray(raw);
		push({
			field_name,
			field_type: reference_model
				? 'ObjectID'
				: is_array
					? 'Array'
					: typeof raw === 'number'
						? 'Number'
						: typeof raw === 'boolean'
							? 'Boolean'
							: raw && typeof raw === 'object'
								? 'Mixed'
								: 'String',
			is_required: false,
			is_reference: Boolean(reference_model),
			reference_model,
			is_array,
			related_fields: reference_model
				? report_related_candidates(ctx, reference_model)
				: is_array
					? report_json_item_fields(raw)
					: [],
		});
	}
	for (const field_name of payload_keys) {
		if (seen.has(field_name) || is_report_system_path(field_name)) continue;
		const reference_model = refs[field_name] ?? null;
		push({
			field_name,
			field_type: reference_model ? 'ObjectID' : 'String',
			is_required: false,
			is_reference: Boolean(reference_model),
			reference_model,
			is_array: false,
			related_fields: reference_model ? report_related_candidates(ctx, reference_model) : [],
		});
	}
	return fields;
}

async function report_fields(ctx: Ctx, detailed: boolean) {
	const model =
		ctx.params.model_identifier ?? ctx.params.modelName ?? ctx.params.model_name ?? '';
	try {
		const resource = await resolve_report_target(ctx, model);
		const fields = await build_report_field_metadata(ctx, resource);
		if (!detailed) {
			return ok(
				fields.map((field) => field.field_name),
				'Campos del modelo obtenidos correctamente',
			);
		}
		return ok(fields, 'Campos del modelo obtenidos correctamente');
	} catch {
		return ok([], `Error obteniendo campos del modelo ${model}`);
	}
}

async function report_records(ctx: Ctx) {
	const model = ctx.params.model_identifier ?? '';
	try {
		const resource = await resolve_report_target(ctx, model);
		const desde = Math.max(0, Number(ctx.url.searchParams.get('desde') ?? 0) || 0);
		const limite = Math.max(
			1,
			Math.min(200, Number(ctx.url.searchParams.get('limite') ?? 30) || 30),
		);
		const { rows, total } = await ctx.store.find_many(resource, {
			q: ctx.url.searchParams.get('termino') ?? '',
			skip: desde,
			take: limite,
		});
		return ok(rows, 'Registros del modelo obtenidos correctamente', total);
	} catch {
		return ok([], `Error obteniendo registros del modelo ${model}`);
	}
}

async function report_record(ctx: Ctx) {
	const model = ctx.params.model_identifier ?? '';
	const record_id = String(ctx.params.record_id ?? '').trim();
	try {
		if (!/^[a-f0-9]{24}$/i.test(record_id)) {
			return ok([], 'ID de registro inválido', 0);
		}
		const resource = await resolve_report_target(ctx, model);
		const loaded = await ctx.store.find_id(resource, record_id);
		if (!loaded || loaded.is_active === false) {
			return ok([], 'Registro no encontrado', 0);
		}
		const [populated] = await ctx.store.populate_docs(resource, [loaded], { full: true });
		const record = await hydrate_loose_product_references(ctx.store, populated ?? loaded);
		return ok([record], 'Registro obtenido correctamente', 1);
	} catch {
		return ok([], `Error obteniendo registro del modelo ${model}`);
	}
}

async function report_validate(ctx: Ctx) {
	let related = String(ctx.body.related_model ?? ctx.body.model ?? '').trim();
	let html = String(ctx.body.html_content ?? ctx.body.html ?? ctx.body.template ?? '');
	const report_id = String(ctx.body._id ?? ctx.body.id ?? '').trim();
	if ((!related || !html) && report_id && ctx.store.has('reports')) {
		const stored = await ctx.store.find_id('reports', report_id);
		related = related || String(stored?.related_model ?? '');
		html = html || String(stored?.html_content ?? '');
	}
	try {
		const resource = await resolve_report_target(ctx, related);
		const fields = await build_report_field_metadata(ctx, resource);
		return report_validation_ok(html, fields, related || resource);
	} catch (error) {
		const reason = error instanceof Error ? error.message : 'Error desconocido';
		return ok(
			[
				{
					is_valid: false,
					placeholders: [],
					invalid_placeholders: [{ placeholder: '', reason }],
					model_name: related,
				},
			],
			'No se pudo validar la plantilla',
		);
	}
}

async function report_preview(ctx: Ctx) {
	const html = String(ctx.body.htmlContent ?? ctx.body.html_content ?? '');
	const model_name = String(ctx.body.model_name ?? ctx.body.related_model ?? '');
	const record_id = String(ctx.body.record_id ?? '');
	if (!html || (!ctx.body.recordData && !(model_name && record_id))) {
		throw new Error('htmlContent y recordData (o model_name+record_id) son requeridos');
	}
	let record = as_object(ctx.body.recordData ?? ctx.body.record ?? {});
	if (model_name && record_id) {
		try {
			const resource = await resolve_report_target(ctx, model_name);
			const loaded = await ctx.store.find_id(resource, record_id);
			if (loaded) {
				const [populated] = await ctx.store.populate_docs(resource, [loaded], {
					full: true,
				});
				record = populated ?? loaded;
			}
		} catch {
			/* keep client record */
		}
	}
	const raw_list = Array.isArray(ctx.body.recordData)
		? ctx.body.recordData
		: Array.isArray(ctx.body.record)
			? ctx.body.record
			: Object.keys(record).length
				? [record]
				: [];
	if (!raw_list.length) {
		throw new Error('No se pudo obtener el registro para la vista previa');
	}
	const hydrated = await hydrate_loose_product_references_many(
		ctx.store,
		raw_list.map((row) => as_object(row)),
	);
	return {
		html: await interpolate_report_records(
			html,
			hydrated,
			actor_name(ctx) || 'USER',
			new Date(),
			{ store: ctx.store, model_name },
		),
		processed: true,
	};
}

async function report_full_pdf(ctx: Ctx) {
	const report_id = String(ctx.body.report_id ?? '');
	const model_name = String(ctx.body.model_name ?? '');
	if (!report_id || !model_name) throw new Error('Report o HTML inválido');
	const report = await ctx.store.find_id('reports', report_id);
	const html_content = String(report?.html_content ?? '').trim();
	if (!report || !html_content) throw new Error('Report o HTML inválido');
	const resource = await resolve_report_target(ctx, model_name);
	const user_name = actor_name(ctx) || 'USER';
	const now = new Date();
	const opts = { store: ctx.store, model_name };
	const rendered = await render_report_from_pages(
		ctx.store,
		html_content,
		iter_report_record_pages(ctx.store, resource, ctx.body),
		user_name,
		now,
		opts,
	);
	if (!rendered.count || !rendered.first) {
		throw new Error('No se encontraron registros para generar el reporte');
	}
	const gen_name = String(report.generated_report_name || '{{name}}_{{timestamp_actual}}');
	const filename = `${(await interpolate_report_template(gen_name, rendered.first, user_name, now, opts)) || 'REPORTE_GENERADO'}${
		rendered.count > 1 ? `_LOTE_${rendered.count}` : ''
	}.pdf`;
	return html_to_pdf_response(rendered.html, filename);
}

async function html_to_pdf_response(html: string, filename?: string) {
	const headers: Record<string, string> = { 'content-type': 'application/pdf' };
	if (filename) {
		headers['content-disposition'] = `attachment; filename="${filename.replace(/"/g, '')}"`;
	}
	const chrome = [
		process.env.PUPPETEER_EXECUTABLE_PATH,
		process.env.CHROME_PATH,
		`${process.env.HOME ?? ''}/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
		'/usr/bin/chromium',
		'/usr/bin/google-chrome',
	].find((p) => Boolean(p) && existsSync(p!));
	if (chrome) {
		try {
			const stamp = crypto.randomUUID();
			const html_path = `/tmp/imperium-pdf-${stamp}.html`;
			const pdf_path = `/tmp/imperium-pdf-${stamp}.pdf`;
			await Bun.write(html_path, html);
			const proc = Bun.spawn(
				[
					chrome,
					'--headless=new',
					'--disable-gpu',
					'--no-sandbox',
					`--print-to-pdf=${pdf_path}`,
					`file://${html_path}`,
				],
				{ stdout: 'ignore', stderr: 'pipe' },
			);
			const code = await proc.exited;
			if (code === 0 && existsSync(pdf_path)) {
				const pdf = await Bun.file(pdf_path).arrayBuffer();
				return new Response(pdf, { headers });
			}
		} catch {
			/* fallback */
		}
	}
	try {
		const puppeteer = await import('puppeteer').catch(() => null);
		if (puppeteer) {
			const browser = await puppeteer.default.launch({
				headless: true,
				executablePath: chrome,
				args: ['--no-sandbox', '--disable-gpu'],
			});
			const page = await browser.newPage();
			await page.setContent(html, { waitUntil: 'networkidle0' });
			const pdf = await page.pdf({ format: 'A4', printBackground: true });
			await browser.close();
			return new Response(pdf, { headers });
		}
	} catch {
		/* fallback html */
	}
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function report_pdf(ctx: Ctx) {
	const record = as_object(ctx.body.record ?? ctx.body.recordData ?? ctx.body.data ?? ctx.body);
	const html = await interpolate_report_template(
		String(ctx.body.htmlContent ?? ctx.body.html ?? ctx.body.template ?? '<html><body>{{name}}</body></html>'),
		await hydrate_loose_product_references(ctx.store, record),
		actor_name(ctx) || String(ctx.body.user_name ?? 'USER'),
		new Date(),
		{
			store: ctx.store,
			model_name: String(ctx.body.model_name ?? ctx.body.related_model ?? ''),
		},
	);
	const filename = String(ctx.body.fileName ?? ctx.body.filename ?? 'report.pdf');
	return html_to_pdf_response(html, filename);
}

function resolve_model(ctx: Ctx, raw: string) {
	const from_refs = ctx.store.resource_for_model(raw);
	if (from_refs) return from_refs;
	const name = raw.replace(/^\/+/, '').replace(/Model$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
	if (ctx.store.has(name)) return name;
	if (ctx.store.has(raw)) return raw;
	const hit = [...ctx.store.locs.keys()].find((k) => k.replace(/-/g, '') === name.replace(/-/g, ''));
	if (hit) return hit;
	throw new Error(`Modelo desconocido: ${raw}`);
}

async function attachment_base64(ctx: Ctx, id: string) {
	const attach_id = String(id ?? '').trim();
	if (!/^[a-f0-9]{24}$/i.test(attach_id)) {
		throw new Error('ID de attachment inválido');
	}
	const doc = ctx.store.has('attachment-management')
		? await ctx.store.find_id('attachment-management', attach_id)
		: null;
	if (!doc || doc.is_active === false) {
		return ok([''], 'Data URL de imagen generada correctamente');
	}
	const served = await serve_attachment_bytes(doc);
	if (!served) {
		return ok([''], 'Data URL de imagen generada correctamente');
	}
	const dataurl = `data:${served.mime};base64,${Buffer.from(served.body).toString('base64')}`;
	return ok([dataurl], 'Data URL de imagen generada correctamente');
}

async function attachment_view(ctx: Ctx) {
	const doc = await ctx.store.find_id('attachment-management', ctx.params.id);
	if (!doc) return Response.json(fail('No encontrado', 404).body, { status: 404 });
	const served = await serve_attachment_bytes(doc);
	if (!served) {
		return Response.json({ error: 'Failed to download file' }, { status: 500 });
	}
	const ext = String(doc.file_ext ?? '').trim();
	const file_name = `${doc.name ?? 'adjunto'}${ext ? ` .${ext}` : ''}`;
	return new Response(served.body, {
		headers: {
			'content-type': served.mime,
			'content-disposition': `attachment; filename="${file_name}"`,
		},
	});
}

async function field_values(ctx: Ctx, resource: string, field: string) {
	const values = await ctx.store.distinct(resource, field, ctx.url.searchParams.get('termino') ?? '');
	return ok(values.map((v) => ({ value: v, label: String(v) })), 'Valores');
}

async function save_delivery_signature(ctx: Ctx, package_id: string): Promise<string> {
	const existing = String(ctx.body.delivery_signature_attachment_id ?? '').trim();
	if (existing) return existing;
	const file = ctx.body.signature;
	if (!file || typeof file !== 'object' || typeof (file as Blob).arrayBuffer !== 'function') {
		throw new Error('Debes capturar la firma de recibido');
	}
	const blob = file as File;
	const bytes = Buffer.from(await blob.arrayBuffer());
	if (!bytes.length) throw new Error('Debes capturar la firma de recibido');
	const name = String(blob.name || `${package_id}.png`);
	const mime = String(blob.type || 'image/png');
	const created = await ctx.store.insert('attachment-management', {
		name,
		name_stored: name,
		mimetype: mime,
		mime,
		file_ext: name.includes('.') ? name.split('.').pop() : 'png',
		size_in_kb: String(Math.max(1, Math.round(bytes.length / 1024))),
		related_model: 'delivery-package',
		related_record_id: package_id,
		field: 'signature',
		created_by_id: actor_id(ctx),
		base64: bytes.toString('base64'),
	});
	return String(created._id);
}

async function user_recovery(ctx: Ctx) {
	if (!ctx.params.id) throw new Error('Se necesita el id del usuario.');
	if (!(await can_manage_other_user_auth(ctx))) {
		throw Object.assign(
			new Error('No tienes permisos para generar enlaces de acceso de otros usuarios.'),
			{ status: 403, code: 'access_denied' },
		);
	}
	const user = await ctx.store.find_id('user', ctx.params.id);
	if (!user) throw new Error('No se encontró el usuario.');
	const email = String(user.email ?? '').trim();
	if (!email) throw new Error('El usuario no tiene un correo para enviarle el enlace.');
	const requested = String(ctx.body.kind ?? '');
	const kind: 'recovery' | 'invitation' =
		requested === 'recovery' || requested === 'invitation'
			? requested
			: user.password
				? 'recovery'
				: 'invitation';
	const settings = await resolve_email_settings(ctx.store);
	const generated = await generate_password_reset(
		ctx.store,
		user,
		kind,
		settings,
		cobranza_origin(ctx),
	);
	let email_sent = false;
	let email_error: string | undefined;
	const send_email = ctx.body.send_email === true || ctx.body.send_email === 'true';
	if (send_email) {
		if (!email_is_configured(settings)) {
			email_error =
				'El servicio de correo no está configurado en el servidor. Comparte el enlace manualmente.';
		} else {
			try {
				await send_password_reset_email({
					settings,
					to: email,
					link: generated.link,
					kind,
					user_name: String(user.name ?? ''),
				});
				email_sent = true;
			} catch {
				email_error = 'No se pudo enviar el correo. Comparte el enlace manualmente.';
			}
		}
	}
	return ok(
		[
			{
				link: generated.link,
				codigo: generated.raw,
				expires_at: generated.expires_at,
				kind,
				email,
				email_sent,
				email_error,
			},
		],
		email_sent ? 'Enlace generado y enviado por correo.' : 'Enlace generado correctamente.',
	);
}

async function user_unlock_auth(ctx: Ctx) {
	if (!(await can_manage_other_user_auth(ctx))) {
		throw Object.assign(
			new Error('No tienes permisos para desbloquear intentos de acceso de otros usuarios.'),
			{ status: 403, code: 'access_denied' },
		);
	}
	const user_id = String(ctx.params.id ?? '').trim();
	if (!user_id) throw new Error('Se necesita el id del usuario.');
	const user = await ctx.store.find_id('user', user_id);
	if (!user) throw new Error('No se encontró el usuario.');
	const email = String(user.email ?? '').trim();
	if (!email) throw new Error('El usuario no tiene correo asociado.');
	const deleted = await reset_auth_rate_limits_for_email(ctx.sql, email);
	return ok(
		[{ email, deleted }],
		deleted > 0
			? 'Intentos de acceso desbloqueados para este usuario.'
			: 'No había bloqueos por email pendientes para este usuario.',
	);
}

async function verify_pin(ctx: Ctx) {
	return verify_user_pin(ctx.store, ctx.body, ctx.actor);
}

async function user_settings_doc(ctx: Ctx) {
	if (!ctx.store.has('user-settings')) return null;
	const uid = actor_id(ctx);
	if (!uid) return null;
	return (
		(await ctx.store.find_where('user-settings', { user_id: uid })) ??
		(await ctx.store.find_where('user-settings', { user: uid }))
	);
}

function user_settings_defaults(uid: string, theme = 'default'): ImperiumDoc {
	return {
		name: 'user-settings',
		user_id: uid,
		user: uid,
		theme,
		favorite_theme_names: [],
		backdrop_blur_multiplier: 1,
		transparency_multiplier: 1,
		floating_backdrop_blur_enabled: true,
		floating_backdrop_blur_multiplier: 1,
		theme_gradient_enabled: true,
		theme_gradient_animation_enabled: false,
		low_power_mode: false,
		compact_mode: false,
		liquid_glass_enabled: false,
		liquid_glass_blur: 8,
		liquid_glass_depth: 0.55,
		liquid_glass_refraction: 32,
		mobile_list_mode: 'card',
		theme_gradient_preference_initialized: true,
		border_thickness_multiplier: 1,
		border_contrast_multiplier: 1,
		border_style: 'solid',
		corner_radius_multiplier: 1,
		font_size_multiplier: 1,
		corner_radius_mode: 'rounded',
		main_menu_lateral: false,
		main_menu_lateral_open: false,
		main_menu_lateral_expanded: false,
		android_status_bar_background_mode: 'theme-primary',
		android_status_bar_icon_style: 'auto',
		android_status_bar_custom_color: '#111827',
		android_push_notifications_enabled: true,
		message_toasts_enabled: true,
		notification_toasts_enabled: true,
		web_browser_notifications_enabled: false,
		message_sounds_enabled: true,
		notification_sounds_enabled: true,
		message_sound_key: 'default',
		notification_sound_key: 'default',
		android_background_activity_enabled: true,
		android_merge_top_bar: false,
		android_hide_navigation_bar: false,
		subscriptions: {
			tag_subscriptions: [],
			user_subscriptions: [],
			document_subscriptions: [],
		},
		dashboard_preferences: { default_dashboard_id: '' },
		module_visibility_preferences: {
			proyectos: { default_task_view: 'board' },
			mis_tareas: { show_subtasks_panel: true },
		},
	};
}

async function system_default_theme(ctx: Ctx): Promise<string> {
	if (!ctx.store.has('configuration')) return 'default';
	const doc = await ctx.store.find_where('configuration', {
		_ref: 'configuration-default-theme',
	});
	const value = String(doc?.value ?? '').trim();
	return value || 'default';
}

async function ensure_user_settings(ctx: Ctx): Promise<ImperiumDoc> {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('Se requiere autenticación');
	if (!ctx.store.has('user-settings')) {
		return { ...user_settings_defaults(uid, await system_default_theme(ctx)) };
	}
	const existing = await user_settings_doc(ctx);
	const defaults = user_settings_defaults(uid, await system_default_theme(ctx));
	if (!existing) {
		return ctx.store.insert('user-settings', defaults);
	}
	const patch: ImperiumDoc = {};
	for (const [key, value] of Object.entries(defaults)) {
		if (existing[key] === undefined) patch[key] = value;
	}
	if (!Object.keys(patch).length) return existing;
	return (await ctx.store.update('user-settings', String(existing._id), patch)) ?? existing;
}

async function user_settings_get(ctx: Ctx) {
	const doc = await ensure_user_settings(ctx);
	return ok([doc], 'Configuración del usuario');
}

async function custom_themes_list(ctx: Ctx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('Se requiere autenticación');
	if (!ctx.store.has('custom-user-themes')) return ok([], 'Temas personalizados del usuario');
	const { rows } = await ctx.store.find_many('custom-user-themes', {
		where: { user_id: uid },
		take: 50,
		include_inactive: false,
	});
	return ok(rows, 'Temas personalizados del usuario');
}

async function custom_themes_create(ctx: Ctx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('Se requiere autenticación');
	if (!ctx.store.has('custom-user-themes')) return ok([ctx.body], 'Tema creado');
	const { total } = await ctx.store.find_many('custom-user-themes', {
		where: { user_id: uid },
		take: 1,
		include_inactive: true,
	});
	if (total >= 50) {
		throw new Error('Máximo 50 temas personalizados permitidos');
	}
	const theme_name = String(ctx.body.theme_name ?? ctx.body.label ?? '').trim();
	const created = await ctx.store.insert('custom-user-themes', {
		...ctx.body,
		name: theme_name || 'tema',
		theme_name: theme_name || ctx.body.theme_name,
		user_id: uid,
	});
	return ok([created], 'Tema creado');
}

async function custom_themes_owned(ctx: Ctx): Promise<ImperiumDoc> {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('Se requiere autenticación');
	const theme = await ctx.store.find_id('custom-user-themes', ctx.params.id);
	if (!theme || String(theme.user_id ?? '') !== uid) {
		throw new Error('Tema no encontrado');
	}
	return theme;
}

async function custom_themes_update(ctx: Ctx) {
	await custom_themes_owned(ctx);
	const patch = { ...ctx.body };
	delete patch.user_id;
	delete patch._id;
	return patch_doc(ctx, 'custom-user-themes', ctx.params.id, patch, 'Tema actualizado');
}

async function custom_themes_delete(ctx: Ctx) {
	await custom_themes_owned(ctx);
	const deleted = await ctx.store.remove('custom-user-themes', ctx.params.id);
	if (!deleted) throw new Error('Tema no encontrado');
	return ok([deleted], 'Tema eliminado');
}

async function user_settings_upsert(ctx: Ctx) {
	const uid = actor_id(ctx);
	if (!uid) throw new Error('Se requiere autenticación');
	if (!ctx.store.has('user-settings')) {
		return ok([{ ...ctx.body, user_id: uid }], 'Configuración actualizada');
	}
	const existing = await ensure_user_settings(ctx);
	const updated = await ctx.store.update('user-settings', String(existing._id), {
		...ctx.body,
		user: uid,
		user_id: uid,
	});
	return ok([updated ?? existing], 'Configuración actualizada');
}

async function user_settings_table_config(ctx: Ctx) {
	const table_key = String(ctx.body.table_key ?? '').replace(/\./g, '_dot_');
	if (!table_key) throw new Error('Se requiere table_key como cadena');
	const existing = await ensure_user_settings(ctx);
	const table_configs = {
		...as_object(existing.table_configs),
		[table_key]: as_object(ctx.body.config),
	};
	const updated = await ctx.store.update('user-settings', String(existing._id), {
		table_configs,
		user: actor_id(ctx),
		user_id: actor_id(ctx),
	});
	return ok([updated ?? existing], 'Configuración de tabla guardada');
}

async function user_settings_global_theme(ctx: Ctx) {
	const theme = String(ctx.body.theme ?? 'default').trim() || 'default';
	if (ctx.store.has('configuration')) {
		const doc = await ctx.store.find_where('configuration', {
			_ref: 'configuration-default-theme',
		});
		if (doc) {
			await ctx.store.update('configuration', String(doc._id), { value: theme });
		} else {
			await ctx.store.insert('configuration', {
				name: 'Tema predeterminado',
				_ref: 'configuration-default-theme',
				value: theme,
			});
		}
	}
	let updated_users = 0;
	if (ctx.body.apply_to_all && ctx.store.has('user-settings')) {
		updated_users = await ctx.store.set_payload_field_all('user-settings', 'theme', theme);
	}
	return ok([{ theme, updated_users }], 'Tema predeterminado del sistema guardado');
}

async function interactive_manual_board(ctx: Ctx) {
	const user_id = actor_id(ctx);
	const access = await actor_access(ctx);
	if (!user_id && !access.has_full_access) {
		return ok([], 'Sin guías');
	}
	const rows = await ctx.store.interactive_manual_cards();
	const readable = new Set(access.models.map(String));
	const group_ids = access.user_group_ids;
	const filtered = access.has_full_access
		? rows
		: rows.filter((doc) => {
				if (has_id(doc.assigned_user_ids, user_id)) return true;
				if (intersects_ids(doc.assigned_group_ids, group_ids)) return true;
				if (doc.is_default_for_module !== true) return false;
				const model = String(doc.module_model_id ?? '').trim();
				return !model || readable.has(model);
			});
	return ok(sort_by_name(filtered), 'Guías disponibles');
}

async function view_available(ctx: Ctx) {
	const user_id = actor_id(ctx);
	if (!user_id) throw new Error('No estás autenticado');
	const access = await actor_access(ctx);
	const group_ids = access.user_group_ids;
	/* Original: find({ $or: [created_by, scope global, is_template,
	 * assigned_user_ids: user_id, assigned_user_group_ids: { $in: groups }] }).
	 * $regex sobre el jsonb del array matchea subcadena (AAA…ffff), no membresía. */
	const rows = await collect_scan(ctx.store, 'view-config-preset', {
		include_inactive: false,
	});
	const filtered = rows.filter((doc) => {
		if (String(doc.created_by ?? '') === user_id) return true;
		if (String(doc.scope ?? '') === 'global') return true;
		if (doc.is_template === true) return true;
		if (has_id(doc.assigned_user_ids, user_id)) return true;
		return intersects_ids(doc.assigned_user_group_ids, group_ids);
	});
	return ok(sort_by_updated_desc(filtered), 'Configuraciones disponibles');
}

/** Lookup de 1: cards de asignación, sin table_configs del catálogo. */
const VIEW_BASELINE_FIELDS = [
	'created_by',
	'scope',
	'is_template',
	'assigned_user_ids',
	'assigned_user_group_ids',
	'updated_at',
];

async function view_baseline(ctx: Ctx) {
	const user_id = actor_id(ctx);
	if (!user_id) throw new Error('No estás autenticado');
	const rows = await collect_scan(ctx.store, 'view-config-preset', {
		include_inactive: false,
		fields: VIEW_BASELINE_FIELDS,
	});
	rows.sort((a, b) =>
		String(b.updatedAt ?? b.updated_at ?? '').localeCompare(
			String(a.updatedAt ?? a.updated_at ?? ''),
		),
	);
	const direct = rows.find((doc) => has_id(doc.assigned_user_ids, user_id));
	const access = direct ? null : await actor_access(ctx);
	const picked =
		direct ??
		rows.find((doc) => intersects_ids(doc.assigned_user_group_ids, access!.user_group_ids)) ??
		null;
	if (!picked) return ok([], 'Sin configuración base asignada');
	const full = picked._id
		? await ctx.store.find_id('view-config-preset', String(picked._id))
		: null;
	return ok([full ?? picked], 'Configuración base asignada');
}

async function view_assign(ctx: Ctx) {
	if (!actor_id(ctx)) throw new Error('No estás autenticado');
	const preset_id = String(ctx.body.preset_id ?? ctx.body.preset ?? '').trim();
	if (!preset_id) throw new Error('Se requiere preset_id');
	const preset = await ctx.store.find_id('view-config-preset', preset_id);
	if (!preset) throw new Error('Configuración no encontrada');
	const assigned_user_ids = merge_unique_ids(preset.assigned_user_ids, ctx.body.user_ids);
	const assigned_user_group_ids = merge_unique_ids(
		preset.assigned_user_group_ids,
		ctx.body.user_group_ids,
	);
	const scope = String(preset.scope ?? '') === 'private' ? 'shared' : preset.scope;
	return patch_doc(
		ctx,
		'view-config-preset',
		preset_id,
		{ assigned_user_ids, assigned_user_group_ids, scope },
		'Configuración asignada',
	);
}

async function cobranza_lookup(ctx: Ctx) {
	const reference =
		ctx.url.searchParams.get('reference') ??
		ctx.url.searchParams.get('folio') ??
		ctx.url.searchParams.get('termino') ??
		'';
	return lookup_cobranza(ctx.store, ctx.actor, reference);
}

async function cobranza_config_text(ctx: Ctx, ref: string, env_name: string) {
	const from_env = String(process.env[env_name] ?? '').trim();
	if (from_env) return from_env;
	return cfg_text((await ctx.store.find_where('configuration', { ref }))?.value);
}

function cobranza_origin(ctx: Ctx) {
	const host = ctx.req.headers.get('x-forwarded-host') ?? ctx.req.headers.get('host') ?? '';
	const proto = ctx.req.headers.get('x-forwarded-proto') ?? 'https';
	return ctx.req.headers.get('origin') || (host ? `${proto}://${host}` : '');
}

async function apply_online_payment(
	ctx: Ctx,
	params: { charge_id: string; amount: number; provider: string; provider_ref?: string },
) {
	return apply_online_cobranza_payment(ctx.store, params);
}

async function cobranza_checkout(ctx: Ctx) {
	const charge_id = String(ctx.body.charge_id ?? '');
	const provider = String(ctx.body.provider ?? 'STRIPE').toUpperCase();
	if (!charge_id) throw new Error('Se requiere el cargo a pagar.');
	const charge = await ctx.store.find_id('cobranza', charge_id);
	if (!charge) throw new Error('No se encontró el cargo.');
	if (Number(charge.balance ?? 0) <= 0) throw new Error('El cargo ya está pagado.');
	const amount = Number(charge.balance);
	const origin = cobranza_origin(ctx);
	if (provider === 'MITEC') {
		const credentials = {
			key_hex: await cobranza_config_text(ctx, 'configuration-payments-mitec-key', 'MITEC_KEY'),
			company: await cobranza_config_text(
				ctx,
				'configuration-payments-mitec-company',
				'MITEC_COMPANY',
			),
			branch: await cobranza_config_text(
				ctx,
				'configuration-payments-mitec-branch',
				'MITEC_BRANCH',
			),
			user: await cobranza_config_text(ctx, 'configuration-payments-mitec-user', 'MITEC_USER'),
			password: await cobranza_config_text(
				ctx,
				'configuration-payments-mitec-password',
				'MITEC_PASSWORD',
			),
			data0: await cobranza_config_text(ctx, 'configuration-payments-mitec-data0', 'MITEC_DATA0'),
		};
		const link = await mitec_create_link(credentials, String(charge.reference ?? ''), amount);
		return ok([{ url: link.url, provider: 'MITEC' }], 'checkout');
	}
	const secret = await cobranza_config_text(
		ctx,
		'configuration-payments-stripe-secret-key',
		'STRIPE_SECRET_KEY',
	);
	const session = await stripe_create_checkout({
		secret_key: secret,
		success_url: `${origin}/internal/cobranza/cobro?paid=1`,
		cancel_url: `${origin}/internal/cobranza/cobro?paid=0`,
		amount_cents: Math.round(amount * 100),
		currency: 'mxn',
		description: String(charge.concept || `Cobro ${charge.reference}`),
		metadata: {
			charge_id: String(charge._id),
			reference: String(charge.reference ?? ''),
		},
	});
	return ok([{ url: session.url, provider: 'STRIPE' }], 'checkout');
}

async function cobranza_mitec_webhook(ctx: Ctx) {
	const encoded = String(ctx.body.strResponse ?? ctx.body.xml ?? '');
	if (!encoded) throw new Error('Falta la respuesta de Mitec.');
	const key = await cobranza_config_text(ctx, 'configuration-payments-mitec-key', 'MITEC_KEY');
	const xml = encoded.trim().startsWith('<') ? encoded : mitec_decrypt_payload(encoded, key);
	const parsed = mitec_parse_callback(xml);
	if (!parsed.approved) return { received: true };
	const charge = await ctx.store.find_where('cobranza', { reference: parsed.reference });
	if (!charge) return { received: true };
	await apply_online_payment(ctx, {
		charge_id: String(charge._id),
		amount: parsed.amount || Number(charge.balance ?? 0),
		provider: 'MITEC',
		provider_ref: parsed.folio,
	});
	return { received: true };
}

async function cobranza_stripe_webhook(ctx: Ctx) {
	const secret = await cobranza_config_text(
		ctx,
		'configuration-payments-stripe-webhook-secret',
		'STRIPE_WEBHOOK_SECRET',
	);
	const raw = JSON.stringify(ctx.body ?? {});
	if (secret && !stripe_verify_webhook(raw, ctx.req.headers.get('stripe-signature'), secret)) {
		throw new Error('Firma de webhook Stripe inválida.');
	}
	const event = ctx.body as {
		type?: string;
		data?: { object?: { id?: string; amount_total?: number; metadata?: { charge_id?: string } } };
	};
	if (event.type !== 'checkout.session.completed') return { received: true };
	const charge_id = event.data?.object?.metadata?.charge_id;
	if (!charge_id) return { received: true };
	const cents = Number(event.data?.object?.amount_total || 0);
	await apply_online_payment(ctx, {
		charge_id,
		amount: cents > 0 ? cents / 100 : 0,
		provider: 'STRIPE',
		provider_ref: event.data?.object?.id,
	});
	return { received: true };
}

function as_id_list(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => ref_id(item) || String(item ?? '').trim()).filter(Boolean);
	}
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return [];
		try {
			return as_id_list(JSON.parse(text));
		} catch {
			return text.split(',').map((s) => s.trim()).filter(Boolean);
		}
	}
	if (value && typeof value === 'object') {
		const id = ref_id(value);
		return id ? [id] : [];
	}
	return [];
}

async function take_next_turn(ctx: Ctx) {
	const taken = await take_ticketing_turn(
		ctx.store,
		String(ctx.body.box_config_id ?? ctx.body.box ?? ctx.body.caja ?? ''),
	);
	return ok([taken.turn], 'Turno tomado', taken.waiting);
}

async function notify_turn(ctx: Ctx) {
	const doc = await notify_ticketing_turn(ctx.store, ctx.body.turn_id ?? ctx.body.id ?? ctx.body._id);
	return ok([doc], 'Turno notificado');
}

async function end_attending_turn(ctx: Ctx) {
	const updated = await end_ticketing_turn(
		ctx.store,
		ctx.body.turn_id ?? ctx.body.id ?? ctx.body._id,
	);
	return ok([updated], 'Turno finalizado');
}

async function reverse_geocode(ctx: Ctx) {
	const lat = String(ctx.url.searchParams.get('lat') ?? '').trim();
	const lon = String(ctx.url.searchParams.get('lon') ?? '').trim();
	if (!lat || !lon) {
		return Response.json({ error: 'lat y lon son requeridos' }, { status: 400 });
	}
	const url = new URL('https://nominatim.openstreetmap.org/reverse');
	url.searchParams.set('format', 'jsonv2');
	url.searchParams.set('lat', lat);
	url.searchParams.set('lon', lon);
	url.searchParams.set('addressdetails', '1');
	url.searchParams.set('accept-language', 'es');
	const upstream = await fetch(url, {
		headers: { 'user-agent': 'ImperiumSIC-modular/1.0' },
	});
	const payload = await upstream.json().catch(() => ({ error: 'geocode falló' }));
	return Response.json(payload, { status: upstream.ok ? 200 : upstream.status });
}

async function mark_attendance(ctx: Ctx) {
	const saved = await mark_lista_asistencia(ctx.store, ctx.params.id, ctx.body);
	return ok([saved], 'Asistencia actualizada correctamente');
}

async function medical_list(
	ctx: Ctx,
	where: Record<string, unknown>,
	message: string,
) {
	const q = query_list(ctx.url);
	const found = await ctx.store.find_many('medical-file', {
		...q,
		where: { ...q.where, ...where },
		populate: false,
	});
	return {
		...ok(project_list_docs('medical-file', found.rows), message, found.total),
		tipo_de_instancia: list_instance_type('medical-file'),
	};
}

async function medical_for_doctor(ctx: Ctx) {
	const by_status = await medical_list(
		ctx,
		{ status: { in: ['pendiente', 'en_consulta'] } },
		'Expedientes del médico',
	);
	if (as_array(by_status.data).length) return by_status;
	return medical_list(
		ctx,
		{ estado: { in: ['pendiente', 'en_consulta'] } },
		'Expedientes del médico',
	);
}

async function medical_pending(ctx: Ctx) {
	const by_status = await medical_list(ctx, { status: 'pendiente' }, 'Pendientes');
	if (as_array(by_status.data).length) return by_status;
	return medical_list(ctx, { estado: 'pendiente' }, 'Pendientes');
}

async function need(
	ctx: Ctx,
	resource: string,
	id?: string,
	missing = 'No se encontró el documento',
	empty = 'Se necesita el id',
) {
	if (!id) throw new Error(empty);
	const doc = await ctx.store.find_id(resource, id);
	if (!doc || doc.is_active === false) throw new Error(missing);
	return doc;
}

/** Login/menú: solo ids. Sin path, dependencias ni payload. */
const DISABLED_MODULE_FIELDS = ['model_id', 'name', 'is_enable'];

async function disabled_model_ids(ctx: Ctx) {
	const disabled = new Set<string>();
	if (!ctx.store.has('module-management')) return disabled;
	const rows = await collect_scan(ctx.store, 'module-management', {
		mongo_match: {
			$or: [{ is_enable: false }, { is_active: false }],
		},
		include_inactive: true,
		fields: DISABLED_MODULE_FIELDS,
	});
	for (const row of rows) {
		if (row.is_enable === false || row.is_active === false) {
			disabled.add(String(row.model_id ?? row.name ?? ''));
		}
	}
	return disabled;
}

async function payments_catalog(ctx: Ctx) {
	const disabled = await disabled_model_ids(ctx);
	const cfdi_on = !disabled.has('CfdiDocument') && ctx.store.has('cfdi-document');
	const services = payable_services();
	const data = services
		.filter((s) => !s.required_model_id || !disabled.has(s.required_model_id))
		.map((s) => ({
			slug: s.slug,
			title: s.title,
			description: s.description,
			kind: s.kind,
			lookup_label: s.lookup_label,
			invoice_available: Boolean(s.billable && cfdi_on),
		}));
	const secret = await payments_stripe_secret(ctx);
	const publishable = await payments_config_text(
		ctx,
		'configuration-payments-stripe-publishable-key',
		'STRIPE_PUBLISHABLE_KEY',
	);
	return ok(data, secret && publishable ? 'ok' : 'pagos_no_configurados');
}

function payable_services() {
	return [
		{
			slug: 'generico',
			title: 'Pago de prueba',
			description: 'Cargo libre para validar Stripe en modo test.',
			kind: 'one_time',
			required_model_id: null as string | null,
			lookup_label: null as string | null,
			billable: true,
		},
		{
			slug: 'agua',
			title: 'Agua potable',
			description: 'Consulta el contrato y paga el saldo pendiente.',
			kind: 'one_time',
			required_model_id: 'Agua',
			lookup_label: 'Número de contrato',
			billable: true,
		},
		{
			slug: 'infracciones',
			title: 'Infracciones',
			description: 'Paga un cargo de infracción con su folio o placas.',
			kind: 'one_time',
			required_model_id: 'Cobranza',
			lookup_label: 'Folio o placas',
			billable: true,
		},
	];
}

async function payments_config_text(ctx: Ctx, ref: string, env_name: string) {
	const from_env = String(process.env[env_name] ?? '').trim();
	if (from_env) return from_env;
	return cfg_text((await ctx.store.find_where('configuration', { ref }))?.value);
}

async function payments_stripe_secret(ctx: Ctx) {
	return payments_config_text(
		ctx,
		'configuration-payments-stripe-secret-key',
		'STRIPE_SECRET_KEY',
	);
}

async function stripe_create_checkout(input: {
	secret_key: string;
	success_url: string;
	cancel_url: string;
	amount_cents: number;
	currency: string;
	description: string;
	customer_email?: string;
	metadata: Record<string, string>;
}) {
	if (!input.secret_key) {
		throw new Error('Stripe no está configurado (falta la clave secreta).');
	}
	const body = new URLSearchParams();
	body.set('success_url', input.success_url);
	body.set('cancel_url', input.cancel_url);
	body.set('mode', 'payment');
	if (input.customer_email) body.set('customer_email', input.customer_email);
	for (const [key, value] of Object.entries(input.metadata)) {
		body.set(`metadata[${key}]`, value);
	}
	body.set('line_items[0][price_data][currency]', input.currency);
	body.set('line_items[0][price_data][product_data][name]', input.description);
	body.set('line_items[0][price_data][unit_amount]', String(input.amount_cents));
	body.set('line_items[0][quantity]', '1');
	const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${input.secret_key}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body,
	});
	const payload = (await response.json()) as {
		id?: string;
		url?: string;
		error?: { message?: string };
	};
	if (!response.ok || !payload.id || !payload.url) {
		throw new Error(payload.error?.message ?? 'Stripe rechazó la sesión de checkout.');
	}
	return { id: payload.id, url: payload.url };
}

function stripe_verify_webhook(
	raw_body: string,
	signature_header: string | null,
	webhook_secret: string,
) {
	if (!webhook_secret || !signature_header) return false;
	const parts = Object.fromEntries(
		signature_header.split(',').map((piece) => {
			const [key, ...rest] = piece.split('=');
			return [key.trim(), rest.join('=')];
		}),
	) as { t?: string; v1?: string };
	if (!parts.t || !parts.v1) return false;
	const expected = createHmac('sha256', webhook_secret)
		.update(`${parts.t}.${raw_body}`, 'utf8')
		.digest('hex');
	try {
		return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
	} catch {
		return false;
	}
}

async function payments_checkout(ctx: Ctx) {
	const slug = String(ctx.body.service_slug ?? '');
	const service = payable_services().find((s) => s.slug === slug);
	if (!service) throw new Error('Servicio de pago no encontrado.');
	const disabled = await disabled_model_ids(ctx);
	if (service.required_model_id && disabled.has(service.required_model_id)) {
		throw new Error('Este servicio no está disponible.');
	}
	const lookup = String(ctx.body.lookup ?? '').trim();
	if (service.lookup_label && !lookup) {
		throw new Error(`Se requiere: ${service.lookup_label}.`);
	}
	const amount = Number(ctx.body.amount);
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error('El monto debe ser mayor a cero.');
	}
	const cfdi_on = !disabled.has('CfdiDocument') && ctx.store.has('cfdi-document');
	const invoice_requested = Boolean(ctx.body.invoice) && cfdi_on && service.billable;
	const secret = await payments_stripe_secret(ctx);
	const currency =
		(await payments_config_text(ctx, 'configuration-payments-currency', 'STRIPE_CURRENCY')) ||
		'mxn';
	const host = ctx.req.headers.get('x-forwarded-host') ?? ctx.req.headers.get('host') ?? '';
	const proto = ctx.req.headers.get('x-forwarded-proto') ?? 'https';
	const origin = ctx.req.headers.get('origin') || (host ? `${proto}://${host}` : '');
	const created = await ctx.store.insert('payments', {
		name: `Pago ${service.slug} ${lookup || 'libre'}`.slice(0, 120),
		description: service.title,
		service_slug: slug,
		amount,
		status: 'PENDIENTE',
		provider: 'stripe',
		currency,
		external_ref: lookup,
		customer_email: ctx.body.email ? String(ctx.body.email) : '',
		invoice_requested,
	});
	const session = await stripe_create_checkout({
		secret_key: secret,
		success_url: `${origin}/pagos/exito?session_id={CHECKOUT_SESSION_ID}`,
		cancel_url: `${origin}/pagos/cancelado`,
		amount_cents: Math.round(amount * 100),
		currency,
		description: service.title,
		customer_email: ctx.body.email ? String(ctx.body.email) : undefined,
		metadata: {
			payment_id: String(created._id),
			service_slug: service.slug,
		},
	});
	await ctx.store.update('payments', String(created._id), {
		provider_ref: session.id,
	});
	return ok([{ url: session.url }], 'checkout');
}

async function payments_session(ctx: Ctx) {
	const id = String(ctx.url.searchParams.get('session_id') ?? ctx.params.session_id ?? '').trim();
	if (!id) throw new Error('No se encontró la sesión de pago.');
	const doc =
		(await ctx.store.find_where('payments', { provider_ref: id })) ??
		(await ctx.store.find_id('payments', id));
	if (!doc) throw new Error('No se encontró la sesión de pago.');
	return ok(
		[{ status: String(doc.status ?? doc.estado ?? 'PENDIENTE'), service_slug: doc.service_slug }],
		'',
	);
}

async function payments_webhook(ctx: Ctx) {
	const secret = await payments_config_text(
		ctx,
		'configuration-payments-stripe-webhook-secret',
		'STRIPE_WEBHOOK_SECRET',
	);
	const raw = JSON.stringify(ctx.body ?? {});
	if (secret && !stripe_verify_webhook(raw, ctx.req.headers.get('stripe-signature'), secret)) {
		throw new Error('Firma de webhook Stripe inválida.');
	}
	const event = ctx.body as {
		id?: string;
		type?: string;
		data?: { object?: { id?: string; metadata?: { payment_id?: string } } };
	};
	if (event.id) {
		const already = await ctx.store.find_where('payments', { webhook_event_id: event.id });
		if (already) return { received: true };
	}
	const session_id = event.data?.object?.id;
	const payment_id = event.data?.object?.metadata?.payment_id;
	const payment = payment_id
		? await ctx.store.find_id('payments', payment_id)
		: session_id
			? await ctx.store.find_where('payments', { provider_ref: session_id })
			: null;
	if (!payment) return { received: true };
	if (event.type === 'checkout.session.completed') {
		await ctx.store.update('payments', String(payment._id), {
			status: 'PAGADO',
			estado: 'pagado',
			webhook_event_id: event.id,
			fecha_pago: now(),
		});
	} else if (
		event.type === 'checkout.session.expired' ||
		event.type === 'checkout.session.async_payment_failed'
	) {
		await ctx.store.update('payments', String(payment._id), {
			status: 'FALLIDO',
			estado: 'fallido',
			webhook_event_id: event.id,
		});
	}
	return { received: true };
}

const AGUA_PUBLIC_WINDOW_MS = 60_000;
const AGUA_PUBLIC_MAX = 30;
const agua_public_hits = new Map<string, { count: number; reset_at: number }>();

function agua_public_throttled(ip: string) {
	const stamp = Date.now();
	const bucket = agua_public_hits.get(ip);
	if (!bucket || bucket.reset_at <= stamp) {
		agua_public_hits.set(ip, { count: 1, reset_at: stamp + AGUA_PUBLIC_WINDOW_MS });
		return false;
	}
	bucket.count += 1;
	return bucket.count > AGUA_PUBLIC_MAX;
}

function agua_next_periodo_state(periodo_actual?: number, vigencia_actual?: number) {
	const year = vigencia_actual ?? new Date().getFullYear();
	const siguiente = (periodo_actual ?? 1) + 1;
	if (siguiente > 6) return { periodo_actual: 1, vigencia_actual: year + 1 };
	return { periodo_actual: siguiente, vigencia_actual: year };
}

const CONTRATO_FLAGS_ON_ARCHIVE = {
	tomada: false,
	sincronizada: false,
	recibe_lectura: false,
	sincronizado_simapa: false,
} as const;

function agua_pick(doc: ImperiumDoc, keys: string[]) {
	const out: ImperiumDoc = { _id: doc._id };
	for (const key of keys) if (doc[key] !== undefined) out[key] = doc[key];
	return out;
}

function is_tomada(doc: ImperiumDoc) {
	return doc.tomada === true || doc.tomada === 'true' || doc.tomada === 1;
}

function is_sync_simapa(doc: ImperiumDoc) {
	return (
		doc.sincronizado_simapa === true ||
		doc.sincronizado_simapa === 'true' ||
		doc.sincronizado_simapa === 1
	);
}

async function agua_build_metricas(ctx: Ctx) {
	const parametros = ctx.store.has('agua')
		? (
				await ctx.store.find_many('agua', {
					take: 1,
					sort: 'created_at:asc',
				})
			).rows[0]
		: null;
	let total_contratos = 0;
	let contratos_tomados = 0;
	const promedio_by_contrato = new Map<string, number>();
	if (ctx.store.has('contrato')) {
		for await (const page of ctx.store.scan('contrato')) {
			for (const contrato of page) {
				total_contratos += 1;
				if (is_tomada(contrato)) contratos_tomados += 1;
				promedio_by_contrato.set(String(contrato.contrato ?? ''), Number(contrato.promedio ?? 0));
			}
		}
	}
	let total_lecturas = 0;
	let importe_total = 0;
	let lecturas_anormales = 0;
	if (ctx.store.has('lectura')) {
		for await (const page of ctx.store.scan('lectura')) {
			for (const lectura of page) {
				total_lecturas += 1;
				importe_total += Number(lectura.importe ?? 0);
				const promedio = promedio_by_contrato.get(String(lectura.contrato ?? '')) ?? 0;
				if (promedio <= 0) continue;
				const consumo = Number(lectura.consumo_mts3 ?? 0);
				if (consumo > promedio * 1.5 || consumo < promedio * 0.5) lecturas_anormales += 1;
			}
		}
	}
	const contratos_pendientes = Math.max(total_contratos - contratos_tomados, 0);
	return {
		total_contratos,
		contratos_tomados,
		contratos_pendientes,
		avance_porcentaje: total_contratos
			? Math.round((contratos_tomados / total_contratos) * 100)
			: 0,
		total_lecturas,
		importe_total,
		importe_periodo: importe_total,
		lecturas_anormales,
		vigencia_actual: parametros?.vigencia_actual ?? null,
		periodo_actual: parametros?.periodo_actual ?? null,
	};
}

async function agua_public_contrato(ctx: Ctx) {
	const ip =
		ctx.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
		ctx.req.headers.get('x-real-ip') ||
		'unknown';
	if (agua_public_throttled(ip)) {
		return Response.json(
			{ data: [], total_elementos: 0, message: 'Demasiadas consultas públicas. Intenta de nuevo en un minuto.' },
			{ status: 429 },
		);
	}
	const numero = String(ctx.url.searchParams.get('numero') ?? '').trim();
	if (!numero) {
		return Response.json(
			{ data: [], total_elementos: 0, message: 'Falta el número de contrato' },
			{ status: 400 },
		);
	}
	const hit = await ctx.store.find_where('contrato', { contrato: numero });
	const active = hit && hit.is_active !== false ? hit : null;
	const public_doc = active
		? agua_pick(active, [
				'contrato',
				'contribuyente',
				'calle',
				'colonia',
				'poblacion',
				'exterior',
				'interior',
				'saldo',
				'adeudo',
			])
		: null;
	return ok(
		public_doc ? [public_doc] : [],
		public_doc ? 'Contrato encontrado' : 'Contrato no encontrado',
	);
}

async function agua_public_url(ctx: Ctx) {
	const doc = await ctx.store.find_where('configuration', {
		ref: 'configuration-agua-public-url',
	});
	return ok([{ url: cfg_text(doc?.value) }], 'URL pública de consulta');
}

async function agua_push_lectura(ctx: Ctx) {
	const id = String(ctx.params.id ?? '');
	const lectura = id ? await ctx.store.find_id('lectura', id) : null;
	if (!lectura) {
		return Response.json(
			{ data: [], total_elementos: 0, message: 'Lectura no encontrada' },
			{ status: 404 },
		);
	}
	await new AguaMssqlService(ctx.store).push_lectura(lectura);
	const updated = await ctx.store.update('lectura', String(lectura._id), {
		sincronizado_simapa: true,
	});
	return ok(updated ? [updated] : [lectura], 'Lectura enviada a MSSQL');
}

async function agua_push_lecturas_lote(ctx: Ctx) {
	const items = as_array(ctx.body.lecturas);
	const saved = [];
	for (const raw of items) {
		const item = as_object(raw);
		const { consumo_mts3, importe } = await calcular_importe(
			ctx.store,
			Number(item.lectura_actual ?? 0),
			Number(item.lectura_anterior ?? 0),
			item.id_tarifa ? String(item.id_tarifa) : undefined,
		);
		const payload = {
			...item,
			consumo_mts3,
			importe,
			sincronizado_simapa: false,
		};
		delete payload._id;
		const created = await ctx.store.insert('lectura', {
			name: String(payload.name ?? payload.contrato ?? 'Lectura'),
			...payload,
		});
		saved.push(created);
		if (item.contrato) {
			const contrato = await ctx.store.find_where('contrato', {
				contrato: String(item.contrato),
			});
			if (contrato) {
				await ctx.store.update('contrato', String(contrato._id), {
					tomada: true,
					sincronizada: true,
				});
			}
		}
	}
	return ok(saved, `Se registraron ${saved.length} lecturas`);
}

async function agua_campo_contratos(ctx: Ctx) {
	const estado = String(ctx.url.searchParams.get('estado') ?? 'pendientes');
	const id_ruta = String(ctx.url.searchParams.get('id_ruta') ?? '').trim();
	const filtered: ImperiumDoc[] = [];
	if (ctx.store.has('contrato')) {
		for await (const page of ctx.store.scan('contrato', {
			where: id_ruta ? { id_ruta } : undefined,
		})) {
			for (const contrato of page) {
				if (estado === 'tomadas' && !is_tomada(contrato)) continue;
				if (estado === 'por_sincronizar' && !(is_tomada(contrato) && !is_sync_simapa(contrato))) {
					continue;
				}
				if (estado !== 'tomadas' && estado !== 'por_sincronizar' && is_tomada(contrato)) continue;
				filtered.push(contrato);
			}
		}
	}
	filtered.sort(
		(a, b) =>
			Number(a.consecutivo_ruta ?? 0) - Number(b.consecutivo_ruta ?? 0) ||
			String(a.contrato ?? '').localeCompare(String(b.contrato ?? '')),
	);
	return ok(
		filtered.map((c) =>
			agua_pick(c, [
				'name',
				'contrato',
				'contribuyente',
				'colonia',
				'id_ruta',
				'tomada',
				'sincronizada',
				'sincronizado_simapa',
				'lectura_anterior',
				'promedio',
				'saldo',
			]),
		),
		'Contratos de captura de campo',
	);
}

async function agua_archivar_periodo(ctx: Ctx) {
	const confirm =
		ctx.body.confirm === true || ctx.url.searchParams.get('confirm') === 'true';
	if (!confirm) {
		return Response.json(
			{
				data: [],
				total_elementos: 0,
				message:
					'Confirma el archivo del periodo (confirm: true). El historial de lecturas no se borra.',
			},
			{ status: 400 },
		);
	}
	let contratos_reiniciados = 0;
	if (ctx.store.has('contrato')) {
		for await (const page of ctx.store.scan('contrato')) {
			for (const contrato of page) {
				await ctx.store.update('contrato', String(contrato._id), {
					...CONTRATO_FLAGS_ON_ARCHIVE,
				});
				contratos_reiniciados += 1;
			}
		}
	}
	const parametros = ctx.store.has('agua')
		? (await ctx.store.find_many('agua', { take: 1, sort: 'created_at:asc' })).rows[0]
		: null;
	let vigencia_actual = parametros?.vigencia_actual ?? null;
	let periodo_actual = parametros?.periodo_actual ?? null;
	if (parametros) {
		const next = agua_next_periodo_state(
			Number(parametros.periodo_actual ?? 1),
			Number(parametros.vigencia_actual ?? new Date().getFullYear()),
		);
		await ctx.store.update('agua', String(parametros._id), next);
		vigencia_actual = next.vigencia_actual;
		periodo_actual = next.periodo_actual;
	}
	return ok(
		[{ contratos_reiniciados, vigencia_actual, periodo_actual }],
		'Periodo archivado y avanzado correctamente',
	);
}

async function agua_metricas(ctx: Ctx) {
	return ok([await agua_build_metricas(ctx)], 'Métricas del módulo de agua');
}

async function agua_reportes(ctx: Ctx) {
	const tipo = String(ctx.params.tipo ?? '');
	const metricas_data = await agua_build_metricas(ctx);
	if (tipo === 'pendientes') {
		const data: ImperiumDoc[] = [];
		if (ctx.store.has('contrato')) {
			for await (const page of ctx.store.scan('contrato')) {
				for (const contrato of page) {
					if (is_tomada(contrato)) continue;
					data.push(agua_pick(contrato, ['contrato', 'contribuyente', 'id_ruta', 'colonia']));
				}
			}
		}
		return ok(data, 'Contratos pendientes de lectura');
	}
	if (tipo === 'anormales') {
		return ok(
			[{ lecturas_anormales: metricas_data.lecturas_anormales }],
			'Lecturas anormales vs promedio',
		);
	}
	if (tipo === 'importe') {
		return ok(
			[
				{
					importe_periodo: metricas_data.importe_periodo,
					periodo_actual: metricas_data.periodo_actual,
					vigencia_actual: metricas_data.vigencia_actual,
				},
			],
			'Importe del periodo',
		);
	}
	return Response.json(
		{
			data: [],
			total_elementos: 0,
			message: 'Tipo de reporte no válido (pendientes | anormales | importe)',
		},
		{ status: 400 },
	);
}

async function agua_print_mode(ctx: Ctx) {
	const doc = await ctx.store.find_where('configuration', {
		ref: 'configuration-agua-print-mode',
	});
	const value = cfg_text(doc?.value, 'escpos').toLowerCase();
	const mode = value === 'zpl' ? 'zpl' : 'escpos';
	return ok([{ mode }], 'Tecnología de impresión');
}

const HARDWARE_REPORTING_FLAG = 'configuration-desktop-hardware-reporting-enabled';

function truthy_flag(value: unknown, fallback = false) {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return value !== 0;
	if (value == null) return fallback;
	return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

async function hardware_reporting_enabled(store: ImperiumStore) {
	const flag =
		(await store.find_where('configuration', { _ref: HARDWARE_REPORTING_FLAG })) ??
		(await store.find_where('configuration', { ref: HARDWARE_REPORTING_FLAG }));
	return truthy_flag(flag?.value, false);
}

async function physical_device_report(ctx: Ctx) {
	if (!(await hardware_reporting_enabled(ctx.store))) {
		throw new Error('El reporte de hardware de dispositivos está desactivado.');
	}
	const install_uuid = String(ctx.body.install_uuid ?? '').trim();
	if (!install_uuid) {
		throw new Error('Se requiere install_uuid para registrar el dispositivo.');
	}
	const payload = as_object(ctx.body);
	const device_kind = String(
		payload.device_kind ||
			(payload.os_platform === 'android' ? 'mobile' : payload.os_platform ? 'desktop' : ''),
	);
	const doc: ImperiumDoc = {
		name: String(payload.hostname || payload.model || install_uuid),
		install_uuid,
		machine_uuid: String(payload.machine_uuid ?? ''),
		hostname: String(payload.hostname ?? ''),
		manufacturer: String(payload.manufacturer ?? ''),
		model: String(payload.model ?? ''),
		serial: String(payload.serial ?? ''),
		os_platform: String(payload.os_platform ?? ''),
		os_distro: String(payload.os_distro ?? ''),
		os_release: String(payload.os_release ?? ''),
		os_arch: String(payload.os_arch ?? ''),
		cpu_brand: String(payload.cpu_brand ?? ''),
		cpu_cores: payload.cpu_cores ?? 0,
		memory_total_bytes: payload.memory_total_bytes ?? 0,
		gpu_primary: String(payload.gpu_primary ?? ''),
		primary_mac: String(payload.primary_mac ?? ''),
		primary_ip4: String(payload.primary_ip4 ?? ''),
		device_kind,
		app_version: String(payload.app_version ?? ''),
		last_user_id: actor_id(ctx),
		last_user_name: actor_name(ctx),
		last_seen: now(),
		raw_snapshot: payload.raw_snapshot ?? {},
		is_active: true,
	};
	const existing = await ctx.store.find_where('physical-device', { install_uuid });
	const saved = existing
		? await ctx.store.update('physical-device', String(existing._id), doc)
		: await ctx.store.insert('physical-device', doc);
	return ok([saved ?? doc], 'Dispositivo registrado');
}

async function model_tracker_all_models(ctx: Ctx) {
	const rows = await collect_scan(ctx.store, 'model-tracker', {
		include_inactive: true,
	});
	return ok(rows, 'Todos los modelos registrados fueron obtenidos.', rows.length);
}

async function model_tracker_search_status() {
	const active = await SearchEngine.ensure_available(true);
	return ok(
		[{ active, configured: SearchEngine.is_enabled() }],
		active
			? 'Motor de búsqueda externo activo.'
			: 'Motor de búsqueda externo no disponible.',
	);
}

async function model_tracker_reindex(ctx: Ctx) {
	const only_model = String(ctx.params.model_name ?? '').trim();
	const force = ctx.url.searchParams.get('force') === 'true';
	for await (const modules of ctx.store.scan('module-management', {
		include_inactive: true,
	})) {
		for (const module_record of modules) {
			const model_id = String(module_record.model_id ?? '');
			if (
				only_model &&
				model_id !== only_model &&
				model_id.toLowerCase() !== only_model.toLowerCase()
			) {
				continue;
			}
			const resource = ctx.store.resource_for_model(model_id);
			if (!resource || !ctx.store.has(resource)) continue;
			const collection = ctx.store.loc(resource).collection;
			const meili = await SearchEngine.ensure_available();
			if (meili) await SearchEngine.clear_index(collection);
			for await (const page of ctx.store.scan(resource, { include_inactive: true })) {
				if (meili) {
					const search_docs = page
						.filter((doc) => doc.is_active !== false)
						.map((doc) => ({
							id: String(doc._id),
							search_text: search_text_from_doc(doc),
						}))
						.filter((doc) => doc.search_text);
					if (search_docs.length) await SearchEngine.index_documents(collection, search_docs);
				}
				if (!meili || force) {
					for (const doc of page) {
						const search = search_text_from_doc(doc);
						if (search && (force || String(doc.search_field ?? '') !== search)) {
							await ctx.store.update(resource, String(doc._id), { search_field: search });
						}
					}
				}
			}
		}
	}
	const forced = force ? ' (forzado)' : '';
	return ok(
		[],
		only_model
			? `Reindexado de "${only_model}" iniciado${forced}. El progreso se emite por sockets.`
			: `Reindexado de todos los modelos iniciado${forced}. El progreso se emite por sockets.`,
	);
}

function cfg_text(value: unknown, fallback = '') {
	return String(value ?? fallback).replace(/^"+|"+$/g, '') || fallback;
}

async function agua_is_mssql_enabled(ctx: Ctx) {
	return new AguaMssqlService(ctx.store).is_enabled();
}

async function agua_sync_estado(ctx: Ctx) {
	const enabled = await agua_is_mssql_enabled(ctx);
	return ok(
		[{ enabled }],
		enabled ? 'Conexión MSSQL habilitada' : 'Conexión MSSQL deshabilitada',
	);
}

async function agua_sync_catalogos(ctx: Ctx) {
	const svc = new AguaMssqlService(ctx.store);
	await svc.assert_enabled();
	const data = [
		await svc.sync_impedimentos(),
		await svc.sync_incidencias(),
		await svc.sync_periodos(),
	];
	return ok(data, 'Catálogos sincronizados desde MSSQL');
}

async function agua_sync_contratos(ctx: Ctx) {
	const id_ruta = String(ctx.url.searchParams.get('id_ruta') ?? ctx.body.id_ruta ?? '').trim();
	const svc = new AguaMssqlService(ctx.store);
	const result = await svc.sync_contratos(id_ruta || undefined);
	return ok([result], result.message);
}

async function agua_sync_rutas(ctx: Ctx) {
	const result = await new AguaMssqlService(ctx.store).sync_rutas(
		String(ctx.params.idLecturista ?? ''),
	);
	return ok([result], 'Rutas sincronizadas');
}

async function agua_sync_tarifas(ctx: Ctx) {
	const result = await new AguaMssqlService(ctx.store).sync_tarifas(
		String(ctx.params.idLecturista ?? ''),
	);
	return ok([result], 'Tarifas sincronizadas');
}
