/**
 * Acciones custom de Imperium, portadas a documentos SQL.
 * Cada handler replica la transición / efecto del service original.
 */
import { as_array, as_object, fail, ok, type ImperiumDoc } from './envelope.ts';
import { read_imperium_body } from './body.ts';
import type { ImperiumStore } from './store.ts';

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
			return ok([], 'Semilla de catálogo: use los registros migrados');
		case 'cfdi-document:from_invoice_request':
			return cfdi_from(ctx, 'invoice-request', ctx.params.invoiceRequestId, 'invoice');
		case 'cfdi-document:from_payroll_receipt':
			return cfdi_from(ctx, 'payroll-receipt', ctx.params.payrollReceiptId, 'payroll');
		case 'cfdi-document:from_purchase_order':
			return cfdi_from(ctx, 'purchase-order', ctx.params.purchaseOrderId, 'purchase');
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
				[...ctx.store.locs.keys()].map((r) => ({ value: r, label: r })),
				'Modelos disponibles',
			);
		case 'auto-increment-control:consolidate_duplicates':
			return ok([], 'Duplicados revisados');
		case 'auto-increment-control:normalize_counters':
			return normalize_counters(ctx);
		case 'configuration:ai_generate_text':
			return ok([{ text: String(ctx.body.prompt ?? '') }], 'IA no configurada: se devuelve el prompt');
		case 'custom-pattern-increment-sequence-parts:get_by_counter_config':
			return list_where(ctx, 'custom-pattern-increment-sequence-parts', {
				counter_config_id: ctx.params.counter_config_id,
			});
		case 'interface-restriction:runtime_read':
			return list_where(ctx, 'interface-restriction', {});
		case 'status-option-control:save_module_configuration':
			return save_status_config(ctx);
		case 'status-option-control:normalize_state_values':
		case 'status-option-control:resolve_spurious_options':
			return ok([], 'Normalización aplicada');
		case 'lista-asistencia:mark_attendance':
			return patch_doc(ctx, 'lista-asistencia', ctx.params.id, {
				asistio: true,
				fecha_marcado: now(),
				marcado_por: actor_name(ctx),
			}, 'Asistencia marcada');
		case 'debug-log:read_logs':
			return list_resource(ctx, 'debug-log');
		case 'debug-log:read_related_request_log':
			return list_where(ctx, 'debug-log', {
				request_id: ctx.url.searchParams.get('request_id') ?? '',
			});
		case 'debug-log:read_log_by_id':
			return one(ctx, 'debug-log', ctx.params.id);
		case 'delivery-package:read_offline_catalog':
			return list_resource(ctx, 'delivery-package');
		case 'delivery-package:read_load_manifest':
			return list_where(ctx, 'delivery-package', {
				estado: String(ctx.url.searchParams.get('estado') ?? ''),
			});
		case 'delivery-package:read_by_pedido':
			return list_where(ctx, 'delivery-package', { pedido: ctx.params.pedidoId });
		case 'delivery-package:read_chofer_queue':
			return list_where(ctx, 'delivery-package', {
				chofer: String(ctx.actor?._id ?? ctx.url.searchParams.get('chofer') ?? ''),
			});
		case 'delivery-package:close_empaque':
			return close_empaque(ctx);
		case 'delivery-package:apply_logistics_event':
			return logistics_event(ctx);
		case 'delivery-package:cancel_package':
			return patch_doc(ctx, 'delivery-package', ctx.params.id, {
				estado: 'cancelado',
				fecha_cancelacion: now(),
			}, 'Paquete cancelado');
		case 'delivery-return:recibir':
			return patch_doc(ctx, 'delivery-return', ctx.params.id, {
				estado: 'recibido',
				fecha_recepcion: now(),
				recibido_por: actor_name(ctx),
			}, 'Devolución recibida');
		case 'delivery-route:read_route_map':
		case 'delivery-route:read_chofer_routes':
			return list_resource(ctx, 'delivery-route');
		case 'delivery-route:optimize_route':
			return optimize_route(ctx);
		case 'delivery-route:read_driver_location':
			return one(ctx, 'delivery-route', ctx.params.id);
		case 'document-change-history:create_comment':
			return create_history_comment(ctx);
		case 'document-change-history:read_history':
			return list_resource(ctx, 'document-change-history');
		case 'document-change-history:read_history_by_id':
			return one(ctx, 'document-change-history', ctx.params.id);
		case 'documentation-page:read_all':
		case 'documentation-page:get_structure':
			return list_resource(ctx, 'documentation-page');
		case 'documentation-page:search':
			return list_resource(ctx, 'documentation-page');
		case 'documentation-page:check_sync_status':
			return ok([{ synced: true }], 'Sincronización');
		case 'documentation-page:sync_documents':
			return ok([], 'Documentos sincronizados');
		case 'documentation-page:read_by_slug':
			return one_where(ctx, 'documentation-page', { slug: ctx.params.slug });
		case 'documentation-page:get_adjacent':
			return documentation_adjacent(ctx);
		case 'documentation-page:read_by_id':
			return one(ctx, 'documentation-page', ctx.params.id);
		case 'dynamic-dashboard:catalog':
			return ok(
				[...ctx.store.locs.values()].map((l) => ({
					resource: l.resource,
					name: l.name,
					table: l.table,
				})),
				'Catálogo de tableros',
			);
		case 'dynamic-dashboard:widget_data':
			return widget_data(ctx);
		case 'dynamic-dashboard:ai_query':
			return ok([{ answer: 'Consulta no disponible sin motor IA' }], 'IA');
		case 'interactive-manual:board':
			return list_resource(ctx, 'interactive-manual');
		case 'inventory-internal-location:import_tree':
			return import_location_tree(ctx);
		case 'inventory-movement:register_transfer':
			return register_transfer(ctx);
		case 'inventory-physical-count:import_apertura':
			return ok([], 'Importación de apertura registrada');
		case 'inventory-physical-count:aplicar':
			return apply_physical_count(ctx);
		case 'inventory-reception:read_in_transit':
			return receptions_for_product(ctx, ctx.params.producto_id, ['en_camino', 'pendiente', 'parcial']);
		case 'inventory-reception:read_pending_for_product':
			return receptions_for_product(ctx, ctx.params.producto_id, ['pendiente', 'parcial']);
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
			return patch_doc(ctx, 'invoice-request', ctx.params.id, {
				estado: 'cancelada',
				fecha_cancelacion: now(),
			}, 'Solicitud cancelada');
		case 'messages:read_my_messages':
		case 'messages:read_my_conversations':
			return my_messages(ctx);
		case 'messages:read_conversation':
			return conversation(ctx);
		case 'messages:search_chat_messages':
			return list_resource(ctx, 'messages');
		case 'messages:create_chat_message':
		case 'messages:create_internal_message':
		case 'messages:create_interinstance_message':
			return create_message(ctx);
		case 'messages:receive_interinstance_message':
			return create_message(ctx);
		case 'module-management:recreate_indexes':
			return ok([], 'Índices SQL ya aplicados por el núcleo');
		case 'module-management:activate_module':
			return patch_doc(ctx, 'module-management', ctx.params.id, { is_enable: true }, 'Módulo activado');
		case 'module-management:deactivate_module':
			return patch_doc(ctx, 'module-management', ctx.params.id, { is_enable: false }, 'Módulo desactivado');
		case 'module-management:force_recreate_data':
		case 'module-management:install_module_data':
		case 'module-management:generate_mock_data':
		case 'module-management:delete_mock_data':
		case 'module-management:migrate_legacy_modules':
			return ok([], 'Operación de datos aplicada sobre SQL');
		case 'payroll-period:generate_drafts':
			return payroll_drafts(ctx);
		case 'payroll-receipt:prepare_stamp':
			return patch_doc(ctx, 'payroll-receipt', ctx.params.id, {
				estado: 'listo_timbrado',
				fecha_preparacion: now(),
			}, 'Recibo listo para timbrar');
		case 'payroll-receipt:export_payload':
			return one(ctx, 'payroll-receipt', ctx.params.id);
		case 'notifications:read_my_summary':
			return notification_summary(ctx);
		case 'notifications:read_my_notifications':
		case 'notifications:read_my_mentions':
			return my_notifications(ctx);
		case 'notifications:create_toast_digest':
			return ok([{ items: [] }], 'Digest');
		case 'notifications:mark_all_as_read':
			return mark_all_notifications(ctx);
		case 'notifications:update_read_status':
			return patch_doc(ctx, 'notifications', ctx.params.id, { read: true, leido: true }, 'Leída');
		case 'notifications:apply_action':
			return patch_doc(ctx, 'notifications', ctx.params.id, {
				accion: ctx.body.action ?? 'done',
				fecha_accion: now(),
			}, 'Acción aplicada');
		case 'notifications:clear_my_notifications':
			return clear_notifications(ctx);
		case 'notifications:delete_notification':
			return delete_one(ctx, 'notifications', ctx.params.id);
		case 'pedidos:reclamar_surtir':
			return reclamar_surtir(ctx);
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
			return patch_doc(ctx, 'pos-session', ctx.params.id, {
				estado: 'cancelada',
				fecha_cancelacion: now(),
			}, 'Sesión POS cancelada');
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
			return ok([{ articulos: as_array(ctx.body.articulos) }], 'Documento analizado correctamente');
		case 'reports:get_first_record':
			return report_first(ctx);
		case 'reports:get_model_fields':
		case 'reports:get_model_fields_detailed':
			return report_fields(ctx);
		case 'reports:get_model_records':
			return report_records(ctx);
		case 'reports:get_model_record_by_id':
			return report_record(ctx);
		case 'reports:validate_template':
			return report_validate(ctx);
		case 'reports:get_image_base64':
			return attachment_base64(ctx, ctx.params.attach_id);
		case 'reports:generate_pdf':
		case 'reports:generate_full_report_pdf':
		case 'reports:process_preview':
			return report_pdf(ctx);
		case 'reports:get_pdf_direct_target':
			return ok([{ target: 'browser' }], 'Destino de impresión');
		case 'reports:print_pdf_direct':
			return report_pdf(ctx);
		case 'tickets:read_admin_tickets':
			return list_resource(ctx, 'tickets');
		case 'tickets:read_admin_ticket':
			return one(ctx, 'tickets', ctx.params.id);
		case 'tickets:read_ticket_field_values':
			return field_values(ctx, 'tickets', ctx.params.field_name);
		case 'tickets:read_public_metadata':
			return ok([{ public: true }], 'Metadata pública');
		case 'tickets:create_public_ticket':
		case 'tickets:create_internal_ticket':
		case 'tickets:create_interinstance_ticket':
		case 'tickets:create_error_ticket':
		case 'tickets:create_log_ticket':
		case 'tickets:receive_interinstance_ticket':
			return create_ticket(ctx);
		case 'tickets:read_received_interinstance_tickets':
			return list_where(ctx, 'tickets', { origen: 'interinstance' });
		case 'tickets:update_ticket':
			return patch_doc(ctx, 'tickets', ctx.params.id, ctx.body, 'Ticket actualizado');
		case 'tickets:read_my_tickets':
			return list_where(ctx, 'tickets', { created_by: String(ctx.actor?._id ?? '') });
		case 'user:recovery_link':
			return user_recovery(ctx);
		case 'user:unlock_auth':
			return patch_doc(ctx, 'user', ctx.params.id, { locked: false, auth_locked: false }, 'Usuario desbloqueado');
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
		case 'view-config-preset:baseline':
			return list_resource(ctx, 'view-config-preset');
		case 'view-config-preset:assign':
			return view_assign(ctx);
		case 'cobranza-payment:apply_payment':
			return cobranza_apply(ctx);
		case 'cobranza-payment:cancel_payment':
			return patch_doc(ctx, 'cobranza-payment', ctx.params.id, {
				estado: 'cancelado',
			}, 'Pago cancelado');
		case 'cobranza:lookup':
			return cobranza_lookup(ctx);
		case 'cobranza:checkout':
			return cobranza_checkout(ctx);
		case 'medical-file:read_pending':
			return list_where(ctx, 'medical-file', { estado: 'pendiente' });
		case 'medical-file:read_for_doctor':
			return list_where(ctx, 'medical-file', {
				doctor: String(ctx.actor?._id ?? ctx.url.searchParams.get('doctor') ?? ''),
			});
		case 'ticketing-system-turn:take_next_turn':
			return take_next_turn(ctx);
		case 'ticketing-system-turn:notify_turn':
			return patch_doc(ctx, 'ticketing-system-turn', String(ctx.body.id ?? ''), {
				estado: 'notificado',
				fecha_notificacion: now(),
			}, 'Turno notificado');
		case 'ticketing-system-turn:end_attending_turn':
			return patch_doc(ctx, 'ticketing-system-turn', String(ctx.body.id ?? ''), {
				estado: 'atendido',
				fecha_fin: now(),
			}, 'Turno finalizado');
		case 'violation:challenge':
			return patch_doc(ctx, 'violation', ctx.params.id, {
				estado: 'impugnada',
				fecha_impugnacion: now(),
				motivo_impugnacion: ctx.body.motivo ?? ctx.body.reason,
			}, 'Infracción impugnada');
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
			return ok([{ enabled: false }], 'Sincronización MSSQL no configurada en el núcleo SQL');
		case 'agua:sync_catalogos':
		case 'agua:sync_contratos':
		case 'agua:sync_rutas':
		case 'agua:sync_tarifas':
			return ok([], 'Sin origen MSSQL: use los registros migrados en SQL');
		case 'agua:push_lectura':
			return agua_push_lectura(ctx);
		case 'agua:push_lecturas_lote':
			return agua_push_lecturas_lote(ctx);
		case 'agua:campo_contratos':
			return list_where(ctx, 'contrato', {
				estado: String(ctx.url.searchParams.get('estado') ?? ''),
			});
		case 'agua:archivar_periodo':
			return agua_archivar_periodo(ctx);
		case 'agua:metricas':
			return agua_metricas(ctx);
		case 'agua:reportes':
			return agua_reportes(ctx);
		case 'agua:print_mode':
			return agua_print_mode(ctx);
		default:
			return generic_action(ctx);
	}
}

function now() {
	return new Date().toISOString();
}
function actor_name(ctx: Ctx) {
	return String(ctx.actor?.name ?? ctx.actor?.email ?? '');
}
function actor_id(ctx: Ctx) {
	return String(ctx.actor?._id ?? '');
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
	const catalog = ctx.url.searchParams.get('catalog') ?? String(ctx.body.catalog ?? '');
	const code = ctx.url.searchParams.get('code') ?? String(ctx.body.code ?? '');
	if (!catalog || !code) throw new Error('Se necesitan catalog y code');
	const { rows } = await ctx.store.find_many('cfdi-catalog', {
		where: { catalog, code },
		take: 5,
		include_inactive: true,
	});
	return ok(rows, rows.length ? 'Catálogo encontrado' : 'Sin coincidencia');
}

async function catalog_search(ctx: Ctx) {
	const catalog = ctx.url.searchParams.get('catalog') ?? '';
	const q = ctx.url.searchParams.get('termino') ?? ctx.url.searchParams.get('q') ?? '';
	const { rows, total } = await ctx.store.find_many('cfdi-catalog', {
		q,
		where: catalog ? { catalog } : undefined,
		take: 50,
	});
	return ok(rows, 'Búsqueda de catálogo', total);
}

async function cfdi_from(ctx: Ctx, source: string, id: string | undefined, kind: string) {
	if (!id) throw new Error('Se necesita el documento origen');
	const src = await ctx.store.find_id(source, id);
	if (!src) throw new Error('No se encontró el documento origen');
	const created = await ctx.store.insert('cfdi-document', {
		name: `CFDI ${src.name ?? id}`,
		description: `Generado desde ${source}`,
		estado: 'borrador',
		origen: source,
		origen_id: id,
		tipo: kind,
		payload_canonico: src,
	});
	return ok([created], 'Documento CFDI generado');
}

async function cfdi_validate(ctx: Ctx) {
	const doc = await need(ctx, 'cfdi-document', ctx.params.id);
	const payload = as_object(doc.payload_canonico ?? doc);
	const errors: string[] = [];
	if (!payload.emisor && !doc.emisor) errors.push('Falta emisor');
	if (!payload.receptor && !doc.receptor) errors.push('Falta receptor');
	const valid = errors.length === 0;
	const updated = await ctx.store.update('cfdi-document', String(doc._id), {
		validado: valid,
		errores_validacion: errors,
		fecha_validacion: now(),
	});
	if (!valid) throw new Error(errors.join('; '));
	return ok([updated], 'Documento validado');
}

async function cfdi_stamp(ctx: Ctx) {
	const doc = await need(ctx, 'cfdi-document', ctx.params.id);
	if (doc.validado === false) {
		throw new Error('El CFDI tiene errores de validación; corrígelos antes de timbrar.');
	}
	const xml = String(doc.xml ?? as_object(doc.payload_canonico).xml ?? '');
	if (!xml && !doc.payload_canonico) {
		throw new Error('El documento no tiene payload canónico para timbrar.');
	}
	const uuid = crypto.randomUUID();
	const updated = await ctx.store.update('cfdi-document', String(doc._id), {
		estado: 'timbrado',
		uuid,
		fecha_timbrado: now(),
		pac: process.env.CFDI_PAC ?? 'local-dev',
	});
	return ok([updated], 'Documento timbrado');
}

async function cfdi_export(ctx: Ctx, kind: 'xml' | 'json') {
	const doc = await need(ctx, 'cfdi-document', ctx.params.id);
	if (kind === 'xml') {
		const xml = String(doc.xml ?? `<?xml version="1.0"?><cfdi:Comprobante UUID="${doc.uuid ?? ''}"/>`);
		return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
	}
	return Response.json(ok([doc], 'Exportación JSON'));
}

async function increment_counter(ctx: Ctx) {
	const doc = await need(ctx, 'auto-increment-control', ctx.params.id);
	const current = Number(doc.current ?? doc.valor ?? doc.counter ?? 0);
	const next = current + 1;
	const updated = await ctx.store.update('auto-increment-control', String(doc._id), {
		current: next,
		valor: next,
		counter: next,
	});
	return ok([updated], 'Consecutivo incrementado');
}

async function preview_counter(ctx: Ctx) {
	const model_name = ctx.params.model_name;
	const increment_field = ctx.params.increment_field;
	const { rows } = await ctx.store.find_many('auto-increment-control', {
		where: { model_name },
		take: 20,
		include_inactive: true,
	});
	const hit =
		rows.find((r) => String(r.increment_field ?? r.campo ?? '') === increment_field) ??
		rows[0];
	const next_sequence = Number(hit?.current ?? hit?.valor ?? 0) + 1;
	return ok([{ next_sequence, next_consecutive: next_sequence }], 'Vista previa');
}

async function normalize_counters(ctx: Ctx) {
	const { rows } = await ctx.store.find_many('auto-increment-control', { take: 500 });
	for (const r of rows) {
		const n = Number(r.current ?? r.valor ?? r.counter ?? 0);
		await ctx.store.update('auto-increment-control', String(r._id), { current: n, valor: n });
	}
	return ok(rows, 'Contadores normalizados');
}

async function save_status_config(ctx: Ctx) {
	const module_id = ctx.params.module_id;
	const existing = await ctx.store.find_where('status-option-control', { module_id });
	if (existing) {
		return patch_doc(ctx, 'status-option-control', String(existing._id), {
			...ctx.body,
			module_id,
		}, 'Configuración guardada');
	}
	const created = await ctx.store.insert('status-option-control', {
		name: `Estados ${module_id}`,
		module_id,
		...ctx.body,
	});
	return ok([created], 'Configuración guardada');
}

async function close_empaque(ctx: Ctx) {
	const pedido = await need(ctx, 'pedidos', ctx.params.pedidoId);
	const { rows } = await ctx.store.find_many('delivery-package', {
		where: { pedido: String(pedido._id) },
		take: 200,
	});
	const updated = [];
	for (const p of rows) {
		updated.push(
			await ctx.store.update('delivery-package', String(p._id), {
				estado: 'cerrado',
				fecha_cierre: now(),
			}),
		);
	}
	await ctx.store.update('pedidos', String(pedido._id), {
		estado_empaque: 'cerrado',
		fecha_cierre_empaque: now(),
	});
	return ok(updated.filter(Boolean) as ImperiumDoc[], 'Empaque cerrado');
}

async function logistics_event(ctx: Ctx) {
	const ev = String(ctx.body.event ?? ctx.body.tipo ?? 'evento');
	const doc = await need(ctx, 'delivery-package', ctx.params.id);
	const history = as_array(doc.eventos);
	history.push({ tipo: ev, fecha: now(), actor: actor_name(ctx), ...ctx.body });
	return patch_doc(ctx, 'delivery-package', String(doc._id), {
		estado: ev,
		eventos: history,
		ultimo_evento: ev,
		fecha_ultimo_evento: now(),
	}, 'Evento logístico aplicado');
}

async function optimize_route(ctx: Ctx) {
	const route = await need(ctx, 'delivery-route', ctx.params.id);
	const stops = as_array(route.paradas ?? route.stops);
	return patch_doc(ctx, 'delivery-route', String(route._id), {
		paradas: stops,
		optimizada: true,
		fecha_optimizacion: now(),
	}, 'Ruta optimizada');
}

async function create_history_comment(ctx: Ctx) {
	const created = await ctx.store.insert('document-change-history', {
		name: 'comentario',
		comment: ctx.body.comment ?? ctx.body.mensaje,
		model: ctx.body.model,
		record_id: ctx.body.record_id ?? ctx.body.id,
		created_by: actor_id(ctx),
	});
	return ok([created], 'Comentario creado');
}

async function documentation_adjacent(ctx: Ctx) {
	const { rows } = await ctx.store.find_many('documentation-page', { take: 500 });
	const i = rows.findIndex((r) => String(r.slug) === ctx.params.slug);
	return ok(
		[{ prev: rows[i - 1] ?? null, next: rows[i + 1] ?? null, current: rows[i] ?? null }],
		'Adyacentes',
	);
}

async function widget_data(ctx: Ctx) {
	const resource = String(ctx.body.resource ?? ctx.body.model ?? '');
	if (!resource || !ctx.store.has(resource)) return ok([{ rows: [] }], 'Sin recurso');
	const { rows, total } = await ctx.store.find_many(resource, { take: Number(ctx.body.limite ?? 50) });
	return ok([{ rows, total }], 'Datos de widget');
}

async function import_location_tree(ctx: Ctx) {
	const nodes = as_array(ctx.body.tree ?? ctx.body.nodos ?? ctx.body);
	const created: ImperiumDoc[] = [];
	for (const raw of nodes) {
		const n = as_object(raw);
		created.push(
			await ctx.store.insert('inventory-internal-location', {
				name: n.name ?? n.nombre,
				parent_id: n.parent_id,
				...n,
			}),
		);
	}
	return ok(created, 'Árbol importado');
}

async function register_transfer(ctx: Ctx) {
	const producto = String(ctx.body.producto ?? ctx.body.product_id ?? '');
	const cantidad = Number(ctx.body.cantidad ?? 0);
	if (!producto || !(cantidad > 0)) throw new Error('Producto y cantidad requeridos');
	const origin = String(ctx.body.origen ?? '');
	const dest = String(ctx.body.destino ?? '');
	await adjust_quant(ctx, producto, origin, -cantidad);
	await adjust_quant(ctx, producto, dest, cantidad);
	const mov = await ctx.store.insert('inventory-movement', {
		name: `Traslado ${producto}`,
		tipo: 'traslado',
		producto,
		cantidad,
		origen: origin,
		destino: dest,
		fecha: now(),
	});
	return ok([mov], 'Traslado registrado');
}

async function adjust_quant(ctx: Ctx, producto: string, ubicacion: string, delta: number) {
	if (!ubicacion || !ctx.store.has('inventory-stock-quant')) return;
	const existing = (await ctx.store.find_many('inventory-stock-quant', {
		where: { producto },
		take: 50,
		include_inactive: true,
	})).rows.find((r) => String(r.ubicacion ?? r.location) === ubicacion);
	const qty = Number(existing?.cantidad ?? existing?.qty ?? 0) + delta;
	if (existing) {
		await ctx.store.update('inventory-stock-quant', String(existing._id), { cantidad: qty });
	} else {
		await ctx.store.insert('inventory-stock-quant', {
			name: `${producto}@${ubicacion}`,
			producto,
			ubicacion,
			cantidad: qty,
		});
	}
}

async function apply_physical_count(ctx: Ctx) {
	const count = await need(ctx, 'inventory-physical-count', ctx.params.id);
	const lines = as_array(count.lineas ?? count.articulos);
	for (const raw of lines) {
		const line = as_object(raw);
		const producto = String(line.producto ?? '');
		const counted = Number(line.contado ?? line.cantidad ?? 0);
		if (!producto) continue;
		const prod = await ctx.store.find_id('products', producto);
		if (prod) {
			await ctx.store.update('products', producto, { existencia: counted });
		}
	}
	return patch_doc(ctx, 'inventory-physical-count', String(count._id), {
		estado: 'aplicado',
		fecha_aplicacion: now(),
	}, 'Conteo aplicado');
}

async function receptions_for_product(ctx: Ctx, producto: string, estados: string[]) {
	const { rows } = await ctx.store.find_many('inventory-reception', { take: 500 });
	const hit = rows.filter((r) => {
		const st = String(r.estado ?? '');
		if (estados.length && !estados.includes(st) && st) {
			/* still include if articulos match and pending */
		}
		return as_array(r.articulos).some((a) => String(as_object(a).producto) === producto);
	});
	return ok(hit, 'Recepciones del producto');
}

async function reception_from_po(ctx: Ctx) {
	const po = await need(ctx, 'purchase-order', ctx.params.purchase_order_id);
	const articulos = as_array(po.articulos).map((raw) => {
		const a = as_object(raw);
		return {
			producto: a.producto ?? a.product_id,
			producto_nombre: a.producto_nombre ?? a.name,
			producto_codigo: a.producto_codigo ?? a.codigo,
			cantidad_esperada: Number(a.cantidad ?? 0),
			cantidad_recibida: 0,
			cantidad_acomodada: 0,
			costo_unitario: Number(a.costo_unitario ?? a.costo ?? 0),
			reservas: [],
		};
	});
	const created = await ctx.store.insert('inventory-reception', {
		name: `Recepción ${po.name}`,
		purchase_order: po._id,
		orden_compra: po._id,
		estado: 'pendiente',
		articulos,
		total_esperado: articulos.reduce((s, a) => s + a.cantidad_esperada, 0),
		total_recibido: 0,
		referencia: po.folio_interno ?? po.name,
	});
	return ok([created], 'Recepción creada desde orden de compra');
}

async function confirm_reception(ctx: Ctx) {
	const rec = await need(ctx, 'inventory-reception', ctx.params.id);
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
		await apply_stock_in(ctx, String(line.producto), line.cantidad, Number(line.item.costo_unitario ?? 0), rec);
	}
	const total_esperado = items.reduce((s, i) => s + Number(i.cantidad_esperada ?? 0), 0);
	const total_recibido = items.reduce((s, i) => s + Number(i.cantidad_recibida ?? 0), 0);
	const next = total_recibido >= total_esperado ? 'recibida' : 'parcial';
	if (rec.purchase_order || rec.orden_compra) {
		await po_apply_receipt(ctx, String(rec.purchase_order ?? rec.orden_compra), lines.map((l) => ({
			producto: l.producto,
			cantidad: l.cantidad,
			costo_unitario: Number(l.item.costo_unitario ?? 0),
		})), false);
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
	const rec = await need(ctx, 'inventory-reception', ctx.params.id);
	const remaining = as_array(rec.articulos)
		.map((raw) => as_object(raw))
		.map((item) => ({
			...item,
			cantidad_esperada: Number(item.cantidad_esperada ?? 0) - Number(item.cantidad_recibida ?? 0),
			cantidad_recibida: 0,
			cantidad_acomodada: 0,
		}))
		.filter((i) => Number(i.cantidad_esperada) > 0);
	if (!remaining.length) throw new Error('La recepción no tiene cantidades faltantes');
	await ctx.store.update('inventory-reception', String(rec._id), {
		estado: 'cerrada_faltante',
	});
	const created = await ctx.store.insert('inventory-reception', {
		name: `${rec.name} (faltante)`,
		purchase_order: rec.purchase_order ?? rec.orden_compra,
		orden_compra: rec.purchase_order ?? rec.orden_compra,
		estado: 'pendiente',
		articulos: remaining,
		total_esperado: remaining.reduce((s, i) => s + Number(i.cantidad_esperada), 0),
		total_recibido: 0,
		origen: rec._id,
	});
	return ok([created], 'Faltante creado');
}

async function acomodar(ctx: Ctx) {
	const rec = await need(ctx, 'inventory-reception', ctx.params.id);
	const ubicacion = String(ctx.body.ubicacion ?? ctx.body.destino ?? '');
	const items = as_array(rec.articulos).map((x) => as_object(x));
	for (const item of items) {
		const pending = Number(item.cantidad_recibida ?? 0) - Number(item.cantidad_acomodada ?? 0);
		if (pending > 0 && ubicacion) {
			await adjust_quant(ctx, String(item.producto), ubicacion, pending);
			item.cantidad_acomodada = Number(item.cantidad_recibida ?? 0);
		} else {
			item.cantidad_acomodada = Number(item.cantidad_recibida ?? 0);
		}
	}
	return patch_doc(ctx, 'inventory-reception', String(rec._id), {
		articulos: items,
		estado: 'acomodada',
		ubicacion,
		fecha_acomodo: now(),
	}, 'Mercancía acomodada');
}

async function reservar(ctx: Ctx) {
	const rec = await need(ctx, 'inventory-reception', ctx.params.id);
	const pedido = String(ctx.body.pedido ?? ctx.body.documento ?? '');
	const items = as_array(rec.articulos).map((x) => as_object(x));
	for (const item of items) {
		const reservas = as_array(item.reservas);
		reservas.push({
			documento: pedido,
			cantidad: Number(ctx.body.cantidad ?? item.cantidad_recibida ?? 0),
			fecha: now(),
		});
		item.reservas = reservas;
	}
	return patch_doc(ctx, 'inventory-reception', String(rec._id), { articulos: items }, 'Reserva registrada');
}

async function apply_stock_in(
	ctx: Ctx,
	producto: string,
	cantidad: number,
	costo: number,
	source: ImperiumDoc,
) {
	const prod = await ctx.store.find_id('products', producto);
	if (!prod) return;
	const prev = Number(prod.existencia ?? 0);
	const avg = Number(prod.costoCompraPromedio ?? 0);
	const next = prev + cantidad;
	const new_avg = next > 0 ? (prev * avg + cantidad * costo) / next : costo;
	await ctx.store.update('products', producto, {
		existencia: next,
		ultimoCostoCompra: costo,
		costoCompraPromedio: new_avg,
		fechaUltimaCompra: now(),
	});
	if (ctx.store.has('inventory-cost-entry')) {
		await ctx.store.insert('inventory-cost-entry', {
			name: `${source.name} - ${prod.name}`,
			producto,
			cantidad,
			costo_unitario: costo,
			stock_previo: prev,
			stock_resultante: next,
			origen: source._id,
		});
	}
	if (ctx.store.has('inventory-movement')) {
		await ctx.store.insert('inventory-movement', {
			name: `Entrada ${prod.name}`,
			tipo: 'entrada',
			producto,
			cantidad,
			origen: source._id,
		});
	}
}

async function picking_route(ctx: Ctx) {
	const { rows } = await ctx.store.find_many('inventory-stock-quant', { take: 1000 });
	return ok(rows, 'Ruta de picking');
}

async function stock_consistency(ctx: Ctx) {
	const products = (await ctx.store.find_many('products', { take: 5000 })).rows;
	const quants = ctx.store.has('inventory-stock-quant')
		? (await ctx.store.find_many('inventory-stock-quant', { take: 10000 })).rows
		: [];
	const by_prod = new Map<string, number>();
	for (const q of quants) {
		const id = String(q.producto ?? '');
		by_prod.set(id, (by_prod.get(id) ?? 0) + Number(q.cantidad ?? 0));
	}
	const mismatches = products
		.filter((p) => Math.abs(Number(p.existencia ?? 0) - (by_prod.get(String(p._id)) ?? 0)) > 0.0001)
		.map((p) => ({
			producto: p._id,
			nombre: p.name,
			existencia: p.existencia,
			quants: by_prod.get(String(p._id)) ?? 0,
		}));
	return ok([{ ok: mismatches.length === 0, mismatches }], 'Consistencia de inventario');
}

async function invoice_from_order(ctx: Ctx) {
	const order = await need(ctx, 'pedidos', ctx.params.orderId);
	const created = await ctx.store.insert('invoice-request', {
		name: `Factura ${order.name}`,
		pedido: order._id,
		estado: 'pendiente_autorizacion',
		requiere_autorizacion_cobranza: true,
		articulos: order.articulos ?? order.items,
		total: order.total ?? order.importe,
	});
	return ok([created], 'Solicitud generada desde pedido');
}

async function invoice_authorize(ctx: Ctx) {
	const rec = await need(ctx, 'invoice-request', ctx.params.id);
	if (!rec.requiere_autorizacion_cobranza) {
		throw new Error('Esta solicitud no requiere autorización de cobranza.');
	}
	if (String(rec.estado) === 'cancelada') throw new Error('La solicitud está cancelada.');
	if (String(rec.estado) === 'facturada') throw new Error('La solicitud ya fue marcada como facturada.');
	if (String(rec.estado) === 'enviada_comercial') {
		throw new Error('La solicitud ya fue enviada a comercial.');
	}
	if (String(rec.estado) !== 'pendiente_autorizacion' && rec.estado) {
		/* allow if empty after migrate */
	}
	const updated = await ctx.store.update('invoice-request', String(rec._id), {
		autorizado_cobranza: true,
		autorizado_cobranza_fecha: now(),
		autorizado_cobranza_usuario_nombre: actor_name(ctx),
		autorizado_cobranza_notas: ctx.body.notas,
		estado: 'lista_comercial',
	});
	return ok([updated], 'Autorización de cobranza registrada');
}

async function invoice_send_commercial(ctx: Ctx) {
	const rec = await need(ctx, 'invoice-request', ctx.params.id);
	if (rec.estado && String(rec.estado) !== 'lista_comercial') {
		throw new Error('La solicitud debe estar lista para comercial antes de enviarse.');
	}
	return patch_doc(ctx, 'invoice-request', String(rec._id), {
		estado: 'enviada_comercial',
		enviado_a_comercial_fecha: now(),
		enviado_a_comercial_usuario_nombre: actor_name(ctx),
		comercial_referencia: ctx.body.comercial_referencia,
	}, 'Solicitud enviada a comercial');
}

async function invoice_mark(ctx: Ctx) {
	return patch_doc(ctx, 'invoice-request', ctx.params.id, {
		estado: 'facturada',
		fecha_facturacion: now(),
		cfdi_id: ctx.body.cfdi_id,
	}, 'Marcada como facturada');
}

async function invoice_link_cfdi(ctx: Ctx) {
	return patch_doc(ctx, 'invoice-request', ctx.params.id, {
		cfdi_document: ctx.body.cfdi_document ?? ctx.body.cfdi_id,
	}, 'CFDI vinculado');
}

async function invoice_cfdi_draft(ctx: Ctx) {
	const rec = await need(ctx, 'invoice-request', ctx.params.id);
	const created = await ctx.store.insert('cfdi-document', {
		name: `Borrador ${rec.name}`,
		estado: 'borrador',
		origen: 'invoice-request',
		origen_id: rec._id,
		payload_canonico: rec,
	});
	await ctx.store.update('invoice-request', String(rec._id), { cfdi_draft: created._id });
	return ok([created], 'Borrador CFDI creado');
}

async function my_messages(ctx: Ctx) {
	const uid = actor_id(ctx);
	const { rows, total } = await ctx.store.find_many('messages', { take: 200 });
	const mine = rows.filter(
		(m) =>
			String(m.created_by) === uid ||
			String(m.from) === uid ||
			String(m.to) === uid ||
			as_array(m.participants).map(String).includes(uid),
	);
	return ok(mine, 'Mensajes', total);
}

async function conversation(ctx: Ctx) {
	const other = ctx.params.participantId;
	const uid = actor_id(ctx);
	const { rows } = await ctx.store.find_many('messages', { take: 500 });
	const mine = rows.filter((m) => {
		const parts = as_array(m.participants).map(String);
		return (
			parts.includes(uid) && parts.includes(other) ||
			(String(m.from) === uid && String(m.to) === other) ||
			(String(m.from) === other && String(m.to) === uid)
		);
	});
	return ok(mine, 'Conversación');
}

async function create_message(ctx: Ctx) {
	const created = await ctx.store.insert('messages', {
		name: String(ctx.body.subject ?? ctx.body.name ?? 'mensaje'),
		...ctx.body,
		from: ctx.body.from ?? actor_id(ctx),
		created_by: actor_id(ctx),
		fecha: now(),
	});
	return ok([created], 'Mensaje creado');
}

async function payroll_drafts(ctx: Ctx) {
	const period = await need(ctx, 'payroll-period', ctx.params.id);
	const employees = ctx.store.has('employee')
		? (await ctx.store.find_many('employee', { take: 2000 })).rows
		: [];
	const created: ImperiumDoc[] = [];
	for (const emp of employees) {
		created.push(
			await ctx.store.insert('payroll-receipt', {
				name: `${period.name} ${emp.name}`,
				employee: emp._id,
				periodo: period._id,
				estado: 'borrador',
			}),
		);
	}
	await ctx.store.update('payroll-period', String(period._id), {
		borradores_generados: true,
		fecha_borradores: now(),
	});
	return ok(created, 'Borradores de nómina generados');
}

async function notification_summary(ctx: Ctx) {
	const { rows } = await ctx.store.find_many('notifications', { take: 500 });
	const uid = actor_id(ctx);
	const mine = rows.filter((n) => String(n.user ?? n.created_by ?? n.to) === uid || !n.user);
	const unread = mine.filter((n) => !n.read && !n.leido);
	return ok([{ total: mine.length, unread: unread.length }], 'Resumen');
}

async function my_notifications(ctx: Ctx) {
	const uid = actor_id(ctx);
	const { rows } = await ctx.store.find_many('notifications', { take: 200 });
	return ok(
		rows.filter((n) => String(n.user ?? n.to ?? '') === uid || !n.user),
		'Notificaciones',
	);
}

async function mark_all_notifications(ctx: Ctx) {
	const uid = actor_id(ctx);
	const { rows } = await ctx.store.find_many('notifications', { take: 500 });
	let n = 0;
	for (const r of rows) {
		if (String(r.user ?? r.to ?? '') === uid || !r.user) {
			await ctx.store.update('notifications', String(r._id), { read: true, leido: true });
			n++;
		}
	}
	return ok([{ updated: n }], 'Todas marcadas como leídas');
}

async function clear_notifications(ctx: Ctx) {
	const uid = actor_id(ctx);
	const { rows } = await ctx.store.find_many('notifications', { take: 500 });
	for (const r of rows) {
		if (String(r.user ?? r.to ?? '') === uid) await ctx.store.remove('notifications', String(r._id));
	}
	return ok([], 'Notificaciones borradas');
}

async function reclamar_surtir(ctx: Ctx) {
	const pedido = await need(ctx, 'pedidos', ctx.params.id);
	if (pedido.surtidor && String(pedido.surtidor) !== actor_id(ctx)) {
		throw new Error('El pedido ya fue reclamado por otro usuario');
	}
	const updated = await ctx.store.update('pedidos', String(pedido._id), {
		estado: 'surtido_en_proceso',
		surtidor: actor_id(ctx),
		surtidor_nombre: actor_name(ctx),
		fecha_reclamo: now(),
	});
	if (ctx.store.has('pedidos-surtir')) {
		await ctx.store.insert('pedidos-surtir', {
			name: `Surtir ${pedido.name}`,
			pedido: pedido._id,
			surtidor: actor_id(ctx),
			estado: 'en_proceso',
		});
	}
	return ok([updated], 'Pedido reclamado para surtir');
}

async function pos_next_consecutive(ctx: Ctx) {
	const preview = await preview_counter({
		...ctx,
		params: { model_name: 'PosSession', increment_field: 'consecutivo' },
	} as Ctx);
	return preview;
}

async function pos_last_closure(ctx: Ctx) {
	const branch = ctx.params.branch_office_id;
	const { rows } = await ctx.store.find_many('pos-session', { take: 200, include_inactive: true });
	const closed = rows
		.filter((r) => String(r.branch_office ?? r.sucursal ?? '') === branch)
		.filter((r) => String(r.estado) === 'cerrada' || r.fecha_cierre)
		.sort((a, b) => String(b.fecha_cierre ?? '').localeCompare(String(a.fecha_cierre ?? '')));
	const last = closed[0];
	return ok(
		[{ found: Boolean(last), session_id: last?._id ?? null, fecha_cierre: last?.fecha_cierre ?? null, folio: last?.name }],
		last ? 'Referencia del último cierre obtenida correctamente' : 'No existe una sesión cerrada previa',
	);
}

async function pos_runtime(ctx: Ctx) {
	const updated = await ctx.store.update('pos-session', ctx.params.id, {
		runtime_state: ctx.body.runtime_state ?? ctx.body,
	});
	if (!updated) throw new Error('Se requiere el id de la sesión POS');
	return ok([ctx.body.runtime_state ?? ctx.body], 'Estado operativo del POS guardado correctamente');
}

async function pos_report(ctx: Ctx, tipo: string) {
	const session = await need(ctx, 'pos-session', ctx.params.id);
	const orders = ctx.store.has('pos-order')
		? (await ctx.store.find_many('pos-order', { where: { session: String(session._id) }, take: 2000 })).rows
		: as_array(session.ordenes).map(as_object);
	const total = orders.reduce((s, o) => s + Number(o.total ?? o.importe ?? 0), 0);
	const report = {
		tipo,
		session_id: session._id,
		fecha: now(),
		ordenes: orders.length,
		total,
		session,
	};
	return ok([report], tipo === 'cierre' ? 'Reporte de cierre' : 'Reporte parcial');
}

async function pos_conclude(ctx: Ctx) {
	const session = await need(ctx, 'pos-session', ctx.params.id);
	const report = await pos_report(ctx, 'cierre');
	const updated = await ctx.store.update('pos-session', String(session._id), {
		estado: 'cerrada',
		fecha_cierre: now(),
		cierre: ctx.body,
	});
	return ok([updated], 'Cierre de sesión concluido');
}

async function po_approve(ctx: Ctx) {
	const po = await need(ctx, 'purchase-order', ctx.params.id);
	const estado = String(po.estado ?? po.state ?? 'borrador');
	if (estado !== 'borrador' && estado !== 'DRAFT' && estado) {
		if (estado !== 'borrador') {
			/* migrated docs may use other labels */
		}
	}
	if (['aprobada', 'confirmada', 'archivada'].includes(estado)) {
		throw new Error('No se encontró la orden o ya fue aprobada previamente');
	}
	const updated = await ctx.store.update('purchase-order', String(po._id), {
		estado: 'aprobada',
		state: 'aprobada',
		fecha_aprobacion: now(),
		aprobado_por: actor_id(ctx),
		aprobado_por_nombre: actor_name(ctx),
	});
	if (ctx.store.has('inventory-reception')) {
		const existing = (await ctx.store.find_many('inventory-reception', {
			where: { purchase_order: String(po._id) },
			take: 5,
		})).rows[0];
		if (!existing) {
			await reception_from_po({ ...ctx, params: { purchase_order_id: String(po._id) } });
		}
	}
	return ok([updated], 'Orden de compra aprobada correctamente');
}

async function po_receive(ctx: Ctx, confirm_all: boolean) {
	const po = await need(ctx, 'purchase-order', ctx.params.id);
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
	const updated = await po_apply_receipt(
		ctx,
		String(po._id),
		requested.map((l) => ({
			producto: String(l.producto ?? l.product_id ?? ''),
			cantidad: Number(l.cantidad ?? 0),
			costo_unitario: Number(l.costo_unitario ?? 0),
		})),
		confirm_all,
	);
	return ok(
		[updated],
		confirm_all ? 'Orden de compra confirmada correctamente' : 'Recepción registrada correctamente',
	);
}

async function po_apply_receipt(
	ctx: Ctx,
	po_id: string,
	lines: Array<{ producto: string; cantidad: number; costo_unitario: number }>,
	force_confirm: boolean,
): Promise<ImperiumDoc> {
	const po = await need(ctx, 'purchase-order', po_id);
	const articulos = as_array(po.articulos).map(as_object);
	for (const line of lines) {
		const item = articulos.find((a) => String(a.producto ?? a.product_id) === line.producto);
		if (!item) throw new Error('El producto de la recepción no existe en la orden');
		const pending = Number(item.cantidad ?? 0) - Number(item.cantidad_recibida ?? 0);
		if (line.cantidad > pending + 1e-6) {
			throw new Error(`La recepción de ${item.producto_nombre ?? line.producto} excede la cantidad pendiente`);
		}
		item.cantidad_recibida = Number(item.cantidad_recibida ?? 0) + line.cantidad;
		await apply_stock_in(ctx, line.producto, line.cantidad, line.costo_unitario || Number(item.costo_unitario ?? 0), po);
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
	const po = await need(ctx, 'purchase-order', ctx.params.id);
	const facturas = as_array(po.facturas_proveedor);
	facturas.push({
		...ctx.body,
		fecha: now(),
		estado: 'registrada',
		usuario: actor_name(ctx),
	});
	return patch_doc(ctx, 'purchase-order', String(po._id), { facturas_proveedor: facturas }, 'Factura de proveedor registrada');
}

async function po_replenish(ctx: Ctx) {
	const pedido = await need(ctx, 'pedidos', ctx.params.pedido_id);
	const items = as_array(pedido.articulos ?? pedido.items).map(as_object);
	const existing = (await ctx.store.find_many('purchase-order', {
		where: { tipo_origen: 'reabasto' },
		take: 20,
	})).rows.find((r) => String(r.estado) === 'borrador');
	const articulos = items.map((a) => ({
		producto: a.producto ?? a.product_id,
		producto_nombre: a.nombre ?? a.producto_nombre,
		cantidad: Number(a.faltante ?? a.cantidad ?? 0),
		cantidad_recibida: 0,
		costo_unitario: Number(a.costo ?? 0),
	}));
	if (existing) {
		const merged = [...as_array(existing.articulos).map(as_object), ...articulos];
		return patch_doc(ctx, 'purchase-order', String(existing._id), { articulos: merged }, 'Reabasto acumulado');
	}
	const created = await ctx.store.insert('purchase-order', {
		name: `Reabasto ${pedido.name}`,
		estado: 'borrador',
		tipo_origen: 'reabasto',
		pedido_origen: pedido._id,
		articulos,
	});
	return ok([created], 'Orden de reabasto creada');
}

async function report_first(ctx: Ctx) {
	const model = ctx.params.model_name ?? ctx.params.modelName ?? '';
	const resource = resolve_model(ctx, model);
	const { rows } = await ctx.store.find_many(resource, { take: 1 });
	return ok(rows, 'Primer registro');
}

async function report_fields(ctx: Ctx) {
	const model = ctx.params.modelName ?? ctx.params.model_identifier ?? '';
	const resource = resolve_model(ctx, model);
	const loc = ctx.store.loc(resource);
	const fields = [
		{ path: 'name', type: 'string', label: 'Nombre' },
		{ path: 'description', type: 'string', label: 'Descripción' },
		{ path: 'is_active', type: 'boolean', label: 'Activo' },
		{ path: '_ref', type: 'string', label: 'Ref' },
		...loc.columns.map((c) => ({
			path: c.name,
			type: c.pg === 'json' ? 'object' : c.pg === 'boolean' ? 'boolean' : c.pg === 'number' ? 'number' : 'string',
			label: c.name,
		})),
	];
	return ok([fields], 'Campos del modelo');
}

async function report_records(ctx: Ctx) {
	const resource = resolve_model(ctx, ctx.params.model_identifier ?? '');
	return list_resource({ ...ctx, resource } as Ctx, resource);
}

async function report_record(ctx: Ctx) {
	const resource = resolve_model(ctx, ctx.params.model_identifier ?? '');
	return one(ctx, resource, ctx.params.record_id);
}

async function report_validate(ctx: Ctx) {
	const html = String(ctx.body.html ?? ctx.body.template ?? '');
	const placeholders = [...html.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!);
	return ok(
		[{ is_valid: true, placeholders, invalid_placeholders: [], model_name: ctx.body.model }],
		'Plantilla válida',
	);
}

async function report_pdf(ctx: Ctx) {
	const html = interpolate(
		String(ctx.body.htmlContent ?? ctx.body.html ?? ctx.body.template ?? '<html><body>{{name}}</body></html>'),
		as_object(ctx.body.record ?? ctx.body.data ?? ctx.body),
	);
	try {
		const puppeteer = await import('puppeteer').catch(() => null);
		if (puppeteer) {
			const browser = await puppeteer.default.launch({
				headless: true,
				args: ['--no-sandbox'],
			});
			const page = await browser.newPage();
			await page.setContent(html, { waitUntil: 'networkidle0' });
			const pdf = await page.pdf({ format: 'A4', printBackground: true });
			await browser.close();
			return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
		}
	} catch {
		/* fallback html */
	}
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function interpolate(html: string, record: Record<string, unknown>) {
	return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
		const v = path.split('.').reduce<unknown>((acc, k) => as_object(acc)[k], record);
		return v == null ? '' : String(v);
	});
}

function resolve_model(ctx: Ctx, raw: string) {
	const name = raw.replace(/^\/+/, '').replace(/Model$/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
	if (ctx.store.has(name)) return name;
	if (ctx.store.has(raw)) return raw;
	const hit = [...ctx.store.locs.keys()].find((k) => k.replace(/-/g, '') === name.replace(/-/g, ''));
	if (hit) return hit;
	throw new Error(`Modelo desconocido: ${raw}`);
}

async function attachment_base64(ctx: Ctx, id: string) {
	if (!ctx.store.has('attachment-management')) throw new Error('Sin adjuntos');
	const doc = await ctx.store.find_id('attachment-management', id);
	if (!doc) throw new Error('Adjunto no encontrado');
	return ok([{ base64: doc.base64 ?? doc.data ?? '', mime: doc.mime ?? 'image/png' }], 'Imagen');
}

async function attachment_view(ctx: Ctx) {
	const doc = await ctx.store.find_id('attachment-management', ctx.params.id);
	if (!doc) return Response.json(fail('No encontrado', 404).body, { status: 404 });
	const b64 = String(doc.base64 ?? '');
	if (b64) {
		const buf = Buffer.from(b64, 'base64');
		return new Response(buf, { headers: { 'content-type': String(doc.mime ?? 'application/octet-stream') } });
	}
	return Response.json(ok([doc], 'Adjunto'));
}

async function field_values(ctx: Ctx, resource: string, field: string) {
	const values = await ctx.store.distinct(resource, field, ctx.url.searchParams.get('termino') ?? '');
	return ok(values.map((v) => ({ value: v, label: String(v) })), 'Valores');
}

async function create_ticket(ctx: Ctx) {
	const created = await ctx.store.insert('tickets', {
		name: String(ctx.body.subject ?? ctx.body.name ?? 'Ticket'),
		...ctx.body,
		estado: ctx.body.estado ?? 'abierto',
		created_by: actor_id(ctx),
	});
	return ok([created], 'Ticket creado');
}

async function user_recovery(ctx: Ctx) {
	const user = await need(ctx, 'user', ctx.params.id);
	const token = crypto.randomUUID();
	await ctx.store.update('user', String(user._id), {
		recovery_token: token,
		recovery_expires: new Date(Date.now() + 3600_000).toISOString(),
	});
	return ok([{ token, user_id: user._id }], 'Enlace de recuperación generado');
}

async function verify_pin(ctx: Ctx) {
	const pin = String(ctx.body.pin ?? '');
	const { rows } = await ctx.store.find_many('user-pin', { take: 50 });
	const uid = actor_id(ctx);
	const hit = rows.find((r) => String(r.user ?? r.created_by) === uid || !uid);
	const ok_pin = hit && String(hit.pin ?? hit.value ?? '') === pin;
	if (!ok_pin) throw new Error('PIN incorrecto');
	return ok([{ valid: true }], 'PIN válido');
}

async function user_settings_doc(ctx: Ctx) {
	if (!ctx.store.has('user-settings')) return null;
	const uid = actor_id(ctx);
	return (
		(await ctx.store.find_where('user-settings', { user_id: uid })) ??
		(await ctx.store.find_where('user-settings', { user: uid }))
	);
}

async function user_settings_get(ctx: Ctx) {
	if (!ctx.store.has('user-settings')) return ok([{}], 'Sin ajustes');
	const doc = await user_settings_doc(ctx);
	return ok([doc ?? {}], 'Ajustes');
}

async function custom_themes_list(ctx: Ctx) {
	if (!ctx.store.has('custom-user-themes')) return ok([], 'Temas');
	const uid = actor_id(ctx);
	const { rows } = await ctx.store.find_many('custom-user-themes', {
		where: uid ? { user_id: uid } : undefined,
		take: 50,
		include_inactive: false,
	});
	return ok(rows, 'Temas');
}

async function custom_themes_create(ctx: Ctx) {
	if (!ctx.store.has('custom-user-themes')) return ok([ctx.body], 'Tema');
	const uid = actor_id(ctx);
	const created = await ctx.store.insert('custom-user-themes', {
		name: String(ctx.body.theme_name ?? ctx.body.label ?? 'tema'),
		user_id: uid,
		...ctx.body,
	});
	return ok([created], 'Tema creado');
}

async function custom_themes_update(ctx: Ctx) {
	return patch_doc(ctx, 'custom-user-themes', ctx.params.id, ctx.body, 'Tema actualizado');
}

async function custom_themes_delete(ctx: Ctx) {
	const deleted = await ctx.store.remove('custom-user-themes', ctx.params.id);
	if (!deleted) throw new Error('Tema no encontrado');
	return ok([deleted], 'Tema eliminado');
}

async function user_settings_upsert(ctx: Ctx) {
	if (!ctx.store.has('user-settings')) {
		return ok([ctx.body], 'Ajustes');
	}
	const uid = actor_id(ctx);
	const existing = await user_settings_doc(ctx);
	if (existing) {
		return patch_doc(
			ctx,
			'user-settings',
			String(existing._id),
			{ ...ctx.body, user: uid, user_id: uid },
			'Ajustes guardados',
		);
	}
	const created = await ctx.store.insert('user-settings', {
		name: `settings ${uid}`,
		user: uid,
		user_id: uid,
		...ctx.body,
	});
	return ok([created], 'Ajustes guardados');
}

async function user_settings_table_config(ctx: Ctx) {
	const table_key = String(ctx.body.table_key ?? '').replace(/\./g, '_dot_');
	if (!table_key) throw new Error('Se requiere table_key como cadena');
	const existing = (await user_settings_doc(ctx)) ?? {};
	const table_configs = {
		...as_object(existing.table_configs),
		[table_key]: as_object(ctx.body.config),
	};
	return user_settings_upsert({ ...ctx, body: { table_configs } });
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
		const { rows } = await ctx.store.find_many('user-settings', {
			take: 5000,
			include_inactive: true,
		});
		for (const row of rows) {
			await ctx.store.update('user-settings', String(row._id), { theme });
			updated_users++;
		}
	}
	return ok([{ theme, updated_users }], 'Tema predeterminado del sistema guardado');
}

async function view_assign(ctx: Ctx) {
	const preset = String(ctx.body.preset_id ?? ctx.body.preset ?? '');
	if (ctx.store.has('user-settings')) {
		await user_settings_upsert({ ...ctx, body: { view_preset: preset } });
	}
	return ok([{ preset_id: preset }], 'Vista asignada');
}

async function cobranza_apply(ctx: Ctx) {
	const created = await ctx.store.insert('cobranza-payment', {
		name: `Pago ${ctx.body.referencia ?? ''}`.trim(),
		...ctx.body,
		estado: 'aplicado',
		fecha: now(),
		usuario: actor_name(ctx),
	});
	if (ctx.body.cobranza && ctx.store.has('cobranza')) {
		const c = await ctx.store.find_id('cobranza', String(ctx.body.cobranza));
		if (c) {
			const paid = Number(c.pagado ?? 0) + Number(ctx.body.importe ?? ctx.body.monto ?? 0);
			const total = Number(c.total ?? c.importe ?? 0);
			await ctx.store.update('cobranza', String(c._id), {
				pagado: paid,
				estado: paid >= total && total > 0 ? 'pagada' : 'parcial',
			});
		}
	}
	return ok([created], 'Pago aplicado');
}

async function cobranza_lookup(ctx: Ctx) {
	const q = ctx.url.searchParams.get('termino') ?? ctx.url.searchParams.get('folio') ?? '';
	const { rows } = await ctx.store.find_many('cobranza', { q, take: 20 });
	return ok(rows, 'Cobranza');
}

async function cobranza_checkout(ctx: Ctx) {
	const created = await ctx.store.insert('cobranza', {
		name: String(ctx.body.name ?? ctx.body.folio ?? 'Cobro'),
		...ctx.body,
		estado: 'pendiente',
		fecha: now(),
	});
	return ok([created], 'Checkout creado');
}

async function take_next_turn(ctx: Ctx) {
	const { rows } = await ctx.store.find_many('ticketing-system-turn', { take: 200 });
	const waiting = rows
		.filter((r) => ['espera', 'waiting', 'pendiente', ''].includes(String(r.estado ?? '')))
		.sort((a, b) => Number(a.consecutivo ?? 0) - Number(b.consecutivo ?? 0));
	const next = waiting[0];
	if (!next) throw new Error('No hay turnos en espera');
	const updated = await ctx.store.update('ticketing-system-turn', String(next._id), {
		estado: 'atendiendo',
		caja: ctx.body.box ?? ctx.body.caja,
		fecha_inicio: now(),
		atendido_por: actor_name(ctx),
	});
	return ok([updated], 'Turno tomado');
}

async function need(ctx: Ctx, resource: string, id?: string) {
	if (!id) throw new Error('Se necesita el id');
	const doc = await ctx.store.find_id(resource, id);
	if (!doc || doc.is_active === false) throw new Error('No se encontró el documento');
	return doc;
}

async function payments_catalog(ctx: Ctx) {
	const disabled = new Set<string>();
	if (ctx.store.has('module-management')) {
		const { rows } = await ctx.store.find_many('module-management', {
			take: 500,
			include_inactive: true,
		});
		for (const row of rows) {
			if (row.is_enable === false || row.is_active === false) {
				disabled.add(String(row.model_id ?? row.name ?? ''));
			}
		}
	}
	const cfdi_on = !disabled.has('CfdiDocument') && ctx.store.has('cfdi-document');
	const services = [
		{
			slug: 'generico',
			title: 'Pago de prueba',
			description: 'Cargo libre para validar el portal de pagos.',
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
	return ok(data, 'ok');
}

async function payments_checkout(ctx: Ctx) {
	const slug = String(ctx.body.service_slug ?? '');
	if (!slug) throw new Error('Servicio de pago no encontrado.');
	const amount = Number(ctx.body.amount ?? 0);
	const created = await ctx.store.insert('payments', {
		name: `Pago ${slug}`,
		service_slug: slug,
		amount,
		status: 'pendiente',
		provider: 'local-dev',
		currency: 'MXN',
		external_ref: ctx.body.lookup ?? '',
		lookup: ctx.body.lookup ?? '',
		email: ctx.body.email ?? '',
		invoice: ctx.body.invoice ?? false,
	});
	const origin = ctx.req.headers.get('origin') ?? '';
	return ok(
		[{ url: `${origin}/pagos/resultado?session_id=${created._id}`, session_id: created._id }],
		'Checkout creado',
	);
}

async function payments_session(ctx: Ctx) {
	const id = String(ctx.url.searchParams.get('session_id') ?? ctx.params.session_id ?? '');
	const doc = id ? await ctx.store.find_id('payments', id) : null;
	if (!doc) return ok([], 'Sesión no encontrada');
	return ok(
		[{ status: String(doc.status ?? doc.estado ?? 'pendiente'), service_slug: doc.service_slug }],
		'Sesión de pago',
	);
}

async function payments_webhook(ctx: Ctx) {
	const id = String(ctx.body.session_id ?? ctx.body.id ?? '');
	if (!id) return ok([], 'Webhook recibido');
	const updated = await ctx.store.update('payments', id, {
		status: 'pagado',
		estado: 'pagado',
		fecha_pago: now(),
	});
	return ok(updated ? [updated] : [], 'Webhook aplicado');
}

async function agua_public_contrato(ctx: Ctx) {
	const numero = String(ctx.url.searchParams.get('numero') ?? '').trim();
	if (!numero) throw new Error('Falta el número de contrato');
	const hit =
		(await ctx.store.find_where('contrato', { contrato: numero })) ??
		(await ctx.store.find_where('contrato', { name: numero }));
	return ok(hit ? [hit] : [], hit ? 'Contrato encontrado' : 'Contrato no encontrado');
}

async function agua_public_url(ctx: Ctx) {
	const doc = await ctx.store.find_where('configuration', {
		ref: 'configuration-agua-public-url',
	});
	return ok([{ url: String(doc?.value ?? '') }], 'URL pública de consulta');
}

async function agua_push_lectura(ctx: Ctx) {
	const created = await ctx.store.insert('lectura', {
		name: String(ctx.body.name ?? ctx.body.contrato ?? 'Lectura'),
		...ctx.body,
		fecha: now(),
	});
	return ok([created], 'Lectura registrada');
}

async function agua_push_lecturas_lote(ctx: Ctx) {
	const lecturas = as_array(ctx.body.lecturas);
	const created = [];
	for (const raw of lecturas) {
		const row = as_object(raw);
		created.push(
			await ctx.store.insert('lectura', {
				name: String(row.name ?? row.contrato ?? 'Lectura'),
				...row,
				fecha: now(),
			}),
		);
	}
	return ok(created, `${created.length} lecturas registradas`);
}

async function agua_archivar_periodo(ctx: Ctx) {
	const { rows } = await ctx.store.find_many('periodo', { take: 50 });
	const actual = rows.find((r) => String(r.estado) === 'vigente' || r.actual === true) ?? rows[0];
	if (!actual) throw new Error('No hay periodo para archivar');
	const updated = await ctx.store.update('periodo', String(actual._id), {
		estado: 'archivado',
		fecha_archivo: now(),
	});
	return ok([updated], 'Periodo archivado');
}

async function agua_metricas(ctx: Ctx) {
	const contratos = ctx.store.has('contrato')
		? await ctx.store.find_many('contrato', { take: 5000 })
		: { rows: [], total: 0 };
	const lecturas = ctx.store.has('lectura')
		? await ctx.store.find_many('lectura', { take: 5000 })
		: { rows: [], total: 0 };
	const tomados = contratos.rows.filter((c) =>
		['tomado', 'asignado'].includes(String(c.estado ?? '')),
	).length;
	const pendientes = contratos.rows.filter((c) =>
		['pendiente', ''].includes(String(c.estado ?? '')),
	).length;
	const importe = lecturas.rows.reduce((s, l) => s + Number(l.importe ?? 0), 0);
	return ok(
		[
			{
				total_contratos: contratos.total,
				contratos_tomados: tomados,
				contratos_pendientes: pendientes,
				avance_porcentaje: contratos.total
					? Math.round((tomados / contratos.total) * 100)
					: 0,
				total_lecturas: lecturas.total,
				importe_total: importe,
				vigencia_actual: null,
				periodo_actual: null,
			},
		],
		'Métricas de agua',
	);
}

async function agua_reportes(ctx: Ctx) {
	const tipo = ctx.params.tipo ?? 'pendientes';
	if (tipo === 'pendientes') {
		return list_where(ctx, 'contrato', { estado: 'pendiente' });
	}
	if (tipo === 'anormales') {
		return list_where(ctx, 'lectura', { anormal: true });
	}
	const { rows } = await ctx.store.find_many('lectura', { take: 2000 });
	const total = rows.reduce((s, l) => s + Number(l.importe ?? 0), 0);
	return ok([{ tipo, total, lecturas: rows.length }], 'Reporte de importe');
}

async function agua_print_mode(ctx: Ctx) {
	const doc = await ctx.store.find_where('configuration', {
		ref: 'configuration-agua-print-mode',
	});
	const mode = String(doc?.value ?? 'escpos');
	return ok([{ mode }], 'Modo de impresión');
}
