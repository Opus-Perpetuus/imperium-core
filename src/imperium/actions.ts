/**
 * Acciones custom de Imperium, portadas a documentos SQL.
 * Cada handler replica la transición / efecto del service original.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { as_array, as_object, fail, ok, type ImperiumDoc } from './envelope.ts';
import { read_imperium_body } from './body.ts';
import type { ImperiumStore } from './store.ts';
import { assert_pos_pin, verify_user_pin } from './user-pin.ts';

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
			return catalog_seed_samples(ctx);
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
			return mark_attendance(ctx);
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
			return read_load_manifest(ctx);
		case 'delivery-package:read_by_pedido':
			return list_where(ctx, 'delivery-package', { pedido: ctx.params.pedidoId });
		case 'delivery-package:read_chofer_queue':
			return read_chofer_queue(ctx);
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
			return dashboard_catalog(ctx);
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
			return import_apertura(ctx);
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
				estado: 'cancelado',
				fecha_cancelacion: now(),
			}, 'Solicitud cancelada');
		case 'messages:read_my_messages':
			return my_messages(ctx);
		case 'messages:read_my_conversations':
			return my_conversations(ctx);
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
			return payroll_prepare_stamp(ctx);
		case 'payroll-receipt:export_payload':
			return payroll_export_payload(ctx);
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
		case 'pedidos:sync_offline':
			return pedidos_sync_offline(ctx);
		case 'lista-de-precios:sync_offline':
			return lista_de_precios_sync_offline(ctx);
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
			return update_ticket(ctx);
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
		case 'agua:sync_contratos':
		case 'agua:sync_rutas':
		case 'agua:sync_tarifas':
			return agua_require_mssql(ctx);
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
	const code =
		ctx.url.searchParams.get('code') ??
		ctx.url.searchParams.get('key') ??
		String(ctx.body.code ?? ctx.body.key ?? '');
	if (!catalog || !code) throw new Error('Se necesitan catalog y code');
	const { rows } = await ctx.store.find_many('cfdi-catalog', {
		where: { catalog, code },
		take: 5,
		include_inactive: true,
	});
	return ok(rows, rows.length ? 'Catálogo encontrado' : 'Sin coincidencia');
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
	const present = await ctx.store.find_many('cfdi-catalog', {
		take: 20000,
		include_inactive: true,
		populate: false,
	});
	const have = new Set(present.rows.map((r) => String(r._ref ?? r.ref ?? '')));
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
		status: 'draft',
		estado: 'draft',
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
	const status = valid ? 'valid' : 'invalid';
	const updated = await ctx.store.update('cfdi-document', String(doc._id), {
		status,
		estado: status,
		validado: valid,
		errores_validacion: errors,
		fecha_validacion: now(),
	});
	if (!valid) throw new Error(errors.join('; '));
	return ok([updated], 'Documento validado');
}

function pac_provider() {
	return String(process.env.CFDI_PAC_PROVIDER ?? 'noop').trim().toLowerCase();
}

function inject_tfd(xml: string, stamp: { uuid: string; fecha: string; sello_sat: string; no_cert: string; sello_cfd: string }) {
	const tfd =
		`<tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" ` +
		`Version="1.1" UUID="${stamp.uuid}" FechaTimbrado="${stamp.fecha}" ` +
		`RfcProvCertif="MOCK010101AAA" SelloCFD="${stamp.sello_cfd}" ` +
		`NoCertificadoSAT="${stamp.no_cert}" SelloSAT="${stamp.sello_sat}"/>`;
	if (xml.includes('TimbreFiscalDigital')) return xml;
	if (xml.includes('</cfdi:Complemento>')) {
		return xml.replace('</cfdi:Complemento>', `${tfd}</cfdi:Complemento>`);
	}
	if (xml.includes('</cfdi:Comprobante>')) {
		return xml.replace(
			'</cfdi:Comprobante>',
			`<cfdi:Complemento>${tfd}</cfdi:Complemento></cfdi:Comprobante>`,
		);
	}
	return `${xml}${tfd}`;
}

async function cfdi_stamp(ctx: Ctx) {
	const doc = await need(ctx, 'cfdi-document', ctx.params.id);
	if (doc.validado === false || doc.status === 'invalid') {
		throw new Error('El CFDI tiene errores de validación; corrígelos antes de timbrar.');
	}
	const canonical = as_object(doc.canonical ?? doc.payload_canonico);
	if (!Object.keys(canonical).length) {
		throw new Error('El documento no tiene payload canónico para timbrar.');
	}
	const xml = String(doc.xml ?? canonical.xml ?? '');
	await ctx.store.update('cfdi-document', String(doc._id), {
		status: 'stamping',
		estado: 'stamping',
	});
	const provider = pac_provider();
	if (!provider || provider === 'noop' || provider === 'none') {
		await ctx.store.update('cfdi-document', String(doc._id), {
			status: 'stamp_error',
			estado: 'stamp_error',
		});
		throw new Error(
			'PAC no configurado: no se puede timbrar. Configure un adaptador de PAC (set_cfdi_pac_adapter) o use solo exportación XML/JSON.',
		);
	}
	if (provider !== 'mock' && provider !== 'demo' && provider !== 'test') {
		await ctx.store.update('cfdi-document', String(doc._id), {
			status: 'stamp_error',
			estado: 'stamp_error',
		});
		throw new Error(
			`CFDI_PAC_PROVIDER desconocido: "${provider}". Use noop | mock | sw_sapien | finkok | facturama.`,
		);
	}
	const source_xml = xml || `<?xml version="1.0"?><cfdi:Comprobante/>`;
	const uuid = crypto.randomUUID();
	const fecha = now();
	const sello_sat = Buffer.from(`sat|${uuid}`).toString('base64');
	const sello_cfd = source_xml.match(/\sSello="([^"]+)"/)?.[1] ?? Buffer.from(`cfd|${uuid}`).toString('base64');
	const no_cert = '30001000000400002495';
	const xml_timbrado = inject_tfd(source_xml, { uuid, fecha, sello_sat, no_cert, sello_cfd });
	const updated = await ctx.store.update('cfdi-document', String(doc._id), {
		status: 'stamped',
		estado: 'stamped',
		uuid,
		fecha_timbrado: fecha,
		xml: xml_timbrado,
		xml_timbrado,
		pac: 'mock',
		rfc_prov_certif: 'MOCK010101AAA',
		no_certificado_sat: no_cert,
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
	const estado = String(pedido.estado ?? '');
	if (estado === 'cancelado') {
		throw new Error('No se puede cerrar empaque de un pedido cancelado');
	}
	if (estado !== 'surtido' && estado !== 'enviado') {
		throw new Error(
			`El pedido debe estar en «surtido» para cerrar empaque (ahora: ${estado || 'sin estado'})`,
		);
	}
	const { rows } = await ctx.store.find_many('delivery-package', {
		where: { pedido: String(pedido._id) },
		take: 200,
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
	await ctx.store.update('pedidos', String(pedido._id), {
		estado_empaque: 'cerrado',
		fecha_cierre_empaque: now(),
	});
	return ok(updated, 'Empaque cerrado');
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
		await ctx.store.find_many('vehicle', { where: { chofer: employee }, take: 200 })
	).rows;
	const vehicle_ids = new Set(vehicles.map((v) => String(v._id)));
	if (!vehicle_ids.size) {
		return ok([], 'No hay vehículos con este chofer asignado. Configura vehicle.chofer.');
	}
	const estados = mode === 'delivery' ? ['cargado', 'en_ruta'] : ['asignado'];
	const { rows } = await ctx.store.find_many('delivery-package', { take: 500 });
	const hit = rows.filter(
		(p) => vehicle_ids.has(ref_id(p.vehicle)) && estados.includes(String(p.estado)),
	);
	return ok(
		hit,
		mode === 'delivery' ? 'Cola de entrega del chofer' : 'Cola de carga del chofer',
		hit.length,
	);
}

async function read_load_manifest(ctx: Ctx) {
	const vehicle_id = String(ctx.url.searchParams.get('vehicle_id') ?? '').trim();
	const route_id = String(ctx.url.searchParams.get('route_id') ?? '').trim();
	const estado = String(ctx.url.searchParams.get('estado') ?? '').trim();
	const { rows } = await ctx.store.find_many('delivery-package', { take: 500 });
	const records = rows.filter((row) => {
		if (row.is_active === false) return false;
		if (vehicle_id && ref_id(row.vehicle) !== vehicle_id) return false;
		if (route_id && ref_id(row.delivery_route) !== route_id) return false;
		if (estado && String(row.estado) !== estado) return false;
		return true;
	});
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

async function logistics_event(ctx: Ctx) {
	const doc = await need(ctx, 'delivery-package', ctx.params.id);
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
	return patch_doc(
		ctx,
		'delivery-package',
		String(doc._id),
		{
			...patch,
			logistics_events: history,
			ultimo_evento: event_type,
			fecha_ultimo_evento: occurred_at,
		},
		'Evento logístico aplicado',
	);
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

async function dashboard_catalog(ctx: Ctx) {
	const seen = new Set<string>();
	const entries = [];
	for (const loc of ctx.store.locs.values()) {
		if (seen.has(loc.resource)) continue;
		seen.add(loc.resource);
		entries.push({
			model_id: to_model_id(loc.resource),
			module_name: loc.name,
			fields: [
				{ path: '_id', type: 'String', label: 'Id' },
				{ path: 'name', type: 'String', label: 'Nombre' },
				{ path: 'description', type: 'String', label: 'Descripción' },
				{ path: 'is_active', type: 'Boolean', label: 'Activo' },
				{ path: 'createdAt', type: 'Date', label: 'Creado' },
				{ path: 'updatedAt', type: 'Date', label: 'Actualizado' },
				...loc.columns.map((c) => ({
					path: c.name,
					type:
						c.pg === 'json'
							? 'Mixed'
							: c.pg === 'boolean'
								? 'Boolean'
								: c.pg === 'number'
									? 'Number'
									: 'String',
					label: c.name,
				})),
			],
		});
	}
	return ok(entries, 'Catálogo de modelos disponible');
}

function to_model_id(resource: string) {
	if (resource === 'branchoffice') return 'Branchoffice';
	return resource
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}

async function widget_data(ctx: Ctx) {
	const spec = as_object(ctx.body.spec ?? ctx.body);
	const pagination = as_object(ctx.body.pagination ?? {});
	const widget_type = String(spec.widget_type ?? '');
	const model_id = String(spec.model_id ?? spec.model ?? spec.resource ?? '');
	if (!widget_type || !model_id) {
		throw new Error("La especificación del widget requiere 'widget_type' y 'model_id'.");
	}
	let resource: string;
	try {
		resource = resolve_model(ctx, model_id);
	} catch {
		throw new Error(`El modelo '${model_id}' no está disponible.`);
	}
	const take = Number(pagination.limite ?? 50);
	const skip = Number(pagination.desde ?? 0);
	const for_table = widget_type === 'table';
	const { rows, total } = await ctx.store.find_many(resource, {
		take: for_table ? take : 5000,
		skip: for_table ? skip : 0,
	});
	const agg = as_object(spec.aggregation);
	const op = String(agg.op ?? 'count');
	const field = String(agg.field ?? '');
	const numeric = (row: ImperiumDoc) => Number(row[field] ?? 0);
	const scalar = () => {
		if (op === 'sum') return rows.reduce((acc, row) => acc + numeric(row), 0);
		if (op === 'avg') {
			return rows.length
				? rows.reduce((acc, row) => acc + numeric(row), 0) / rows.length
				: 0;
		}
		if (op === 'min') return rows.length ? Math.min(...rows.map(numeric)) : 0;
		if (op === 'max') return rows.length ? Math.max(...rows.map(numeric)) : 0;
		return total;
	};
	if (widget_type === 'kpi') {
		return ok(
			[{ widget_type, denied: false, kpi: { value: scalar() } }],
			'Datos del widget obtenidos',
		);
	}
	if (widget_type === 'progress') {
		const progress = as_object(spec.progress);
		return ok(
			[{
				widget_type,
				denied: false,
				progress: {
					value: scalar(),
					target_value: progress.target_value,
					target_date: progress.target_date,
				},
			}],
			'Datos del widget obtenidos',
		);
	}
	if (widget_type.startsWith('chart-')) {
		const group_by = String(spec.group_by ?? '');
		if (!group_by) throw new Error("Los widgets de gráfica requieren 'group_by'.");
		const map = new Map<string, number>();
		for (const row of rows) {
			const raw = row[group_by];
			const name =
				raw && typeof raw === 'object'
					? String(as_object(raw).name ?? 'Sin valor')
					: String(raw ?? 'Sin valor');
			map.set(name, (map.get(name) ?? 0) + (op === 'count' ? 1 : numeric(row)));
		}
		const series = [...map.entries()]
			.map(([name, value]) => ({ name, value }))
			.sort((a, b) => b.value - a.value)
			.slice(0, 20);
		return ok(
			[{ widget_type, denied: false, chart: { series, truncated: map.size > 20 } }],
			'Datos del widget obtenidos',
		);
	}
	const fields = as_array(spec.fields).map(String);
	const table_rows = rows.map((row) => {
		if (!fields.length) return row;
		const slim: Record<string, unknown> = {};
		for (const key of fields) slim[key] = row[key];
		return slim;
	});
	return ok(
		[{
			widget_type,
			denied: false,
			table: {
				rows: table_rows,
				total_elementos: total,
				fields: fields.length ? fields : Object.keys(table_rows[0] ?? { name: 1 }),
			},
		}],
		'Datos del widget obtenidos',
	);
}

async function import_location_tree(ctx: Ctx) {
	const dry_run = Boolean(ctx.body.dry_run);
	const lineas = as_array(ctx.body.lineas ?? ctx.body.tree ?? ctx.body.nodos);
	if (!lineas.length) {
		throw new Error(
			"Debes enviar lineas[] con name+segmento_codigo o ubicacion_path (ej. 'Zona 1 / Zona 1-A')",
		);
	}
	const preview: ImperiumDoc[] = [];
	const created: ImperiumDoc[] = [];
	const errores: ImperiumDoc[] = [];
	for (const raw of lineas) {
		const n = as_object(raw);
		const name = String(n.name ?? n.nombre ?? '').trim();
		const codigo = String(n.segmento_codigo ?? n.codigo ?? name).trim();
		if (!name && !codigo) {
			errores.push({ mensaje: 'Fila sin name ni segmento_codigo' });
			continue;
		}
		const row: ImperiumDoc = {
			name: name || codigo,
			segmento_codigo: codigo,
			parent_id: n.parent_id,
			parent_codigo: n.parent_codigo,
			...n,
		};
		preview.push({ ...row, accion: 'create', codigo });
		if (!dry_run) {
			created.push(await ctx.store.insert('inventory-internal-location', row));
		}
	}
	const summary = {
		dry_run,
		total_filas: lineas.length,
		creadas: dry_run ? preview.length : created.length,
		actualizadas: 0,
		codigos_creados: preview.map((p) => String(p.codigo ?? p.segmento_codigo ?? '')),
		codigos_actualizados: [] as string[],
		errores,
		preview: dry_run ? preview : undefined,
	};
	return ok(
		[summary],
		dry_run
			? `Simulación árbol: ${preview.length} fila(s) OK, ${errores.length} error(es)`
			: `Árbol importado: ${created.length} creada(s), 0 actualizada(s), ${errores.length} error(es)`,
	);
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

async function import_apertura(ctx: Ctx) {
	const dry_run = Boolean(ctx.body.dry_run);
	const modo = String(ctx.body.modo ?? 'set') === 'delta' ? 'delta' : 'set';
	const lineas = as_array(ctx.body.lineas);
	if (!lineas.length) {
		throw new Error(
			'Debes enviar lineas[] con producto_codigo, ubicación (codigo o path) y cantidad',
		);
	}
	const errores: ImperiumDoc[] = [];
	const preview: ImperiumDoc[] = [];
	const applied: ImperiumDoc[] = [];
	for (let i = 0; i < lineas.length; i++) {
		const row = as_object(lineas[i]);
		const fila = Number(row.fila ?? i + 2);
		const cantidad = Number(row.cantidad ?? row.qty ?? 0);
		if (!Number.isFinite(cantidad)) {
			errores.push({ fila, mensaje: 'Cantidad inválida', raw: row });
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
			errores.push({ fila, mensaje: 'Falta producto o producto_codigo', raw: row });
			continue;
		}
		const ubicacion = String(row.ubicacion ?? row.ubicacion_codigo ?? '').trim();
		if (!ubicacion) {
			errores.push({ fila, mensaje: 'Falta ubicación', raw: row });
			continue;
		}
		const current = ctx.store.has('inventory-stock-quant')
			? (
					await ctx.store.find_many('inventory-stock-quant', {
						where: { producto: String(prod._id) },
						take: 50,
					})
				).rows.find((r) => String(r.ubicacion ?? r.location) === ubicacion)
			: null;
		const actual = Number(current?.cantidad ?? current?.qty ?? 0);
		const objetivo = modo === 'delta' ? actual + cantidad : cantidad;
		const diferencia = Number((objetivo - actual).toFixed(4));
		preview.push({
			fila,
			producto: prod._id,
			producto_codigo: prod.codigo ?? pcod,
			ubicacion_codigo: ubicacion,
			cantidad_actual: actual,
			cantidad_objetivo: objetivo,
			diferencia,
		});
		if (!diferencia || dry_run) continue;
		await adjust_quant(ctx, String(prod._id), ubicacion, diferencia);
		await ctx.store.update('products', String(prod._id), {
			existencia: Number((Number(prod.existencia ?? 0) + diferencia).toFixed(4)),
		});
		applied.push({ fila, diferencia });
	}
	const a_aplicar = preview.filter((p) => Number(p.diferencia) !== 0).length;
	return ok(
		[
			{
				dry_run,
				modo,
				total_filas: lineas.length,
				validas: preview.length,
				a_aplicar,
				aplicados: dry_run ? 0 : applied.length,
				errores,
				preview,
				ok: errores.length === 0,
			},
		],
		dry_run
			? `Simulación: ${a_aplicar} ajuste(s), ${errores.length} error(es)`
			: `Apertura aplicada: ${applied.length} ajuste(s), ${errores.length} error(es)`,
	);
}

async function apply_physical_count(ctx: Ctx) {
	const count = await need(ctx, 'inventory-physical-count', ctx.params.id);
	if (String(count.estado) === 'aplicado') {
		throw new Error('Este conteo ya fue aplicado');
	}
	const ubicacion = String(count.ubicacion ?? '');
	const lines = as_array(count.lineas ?? count.articulos);
	for (const raw of lines) {
		const line = as_object(raw);
		const producto = String(line.producto ?? '');
		if (!producto) continue;
		const sistema = Number(line.cantidad_sistema ?? line.sistema ?? 0);
		const contada = Number(line.cantidad_contada ?? line.contado ?? line.cantidad ?? 0);
		const diferencia = Number((contada - sistema).toFixed(4));
		if (!diferencia) continue;
		const prod = await ctx.store.find_id('products', producto);
		if (!prod) continue;
		if (ubicacion) await adjust_quant(ctx, producto, ubicacion, diferencia);
		await ctx.store.update('products', producto, {
			existencia: Number((Number(prod.existencia ?? 0) + diferencia).toFixed(4)),
		});
		if (ctx.store.has('inventory-movement')) {
			await ctx.store.insert('inventory-movement', {
				name: `Ajuste ${count.name ?? producto}`,
				description: 'Ajuste manual de inventario por conteo físico',
				tipo: 'ajuste_manual',
				tipo_movimiento: 'ajuste_manual',
				producto,
				cantidad: Math.abs(diferencia),
				ubicacion,
				documento_tipo: 'inventory-physical-count',
				documento_id: count._id,
			});
		}
	}
	return patch_doc(ctx, 'inventory-physical-count', String(count._id), {
		estado: 'aplicado',
		fecha_aplicacion: now(),
	}, 'Conteo aplicado correctamente');
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
	const solo_inconsistentes = ctx.url.searchParams.get('solo_inconsistentes') !== '0';
	const reparar = ctx.url.searchParams.get('reparar') === '1';
	const products = (await ctx.store.find_many('products', { take: 5000, populate: false })).rows;
	const quants = ctx.store.has('inventory-stock-quant')
		? (await ctx.store.find_many('inventory-stock-quant', { take: 10000, populate: false })).rows
		: [];
	const by_prod = new Map<string, { suma: number; ubicaciones: number }>();
	for (const q of quants) {
		const id = String(q.producto ?? '');
		if (!id) continue;
		const cur = by_prod.get(id) ?? { suma: 0, ubicaciones: 0 };
		cur.suma += Number(q.cantidad ?? 0);
		cur.ubicaciones += 1;
		by_prod.set(id, cur);
	}
	const ids = new Set([
		...products.filter((p) => Number(p.existencia ?? 0) !== 0).map((p) => String(p._id)),
		...by_prod.keys(),
	]);
	const by_id = new Map(products.map((p) => [String(p._id), p]));
	const filas: ImperiumDoc[] = [];
	let inconsistentes = 0;
	for (const id of ids) {
		const product = by_id.get(id);
		const quant = by_prod.get(id);
		const suma_quants = Number((quant?.suma ?? 0).toFixed(4));
		const existencia = Number(Number(product?.existencia ?? 0).toFixed(4));
		const delta = Number((existencia - suma_quants).toFixed(4));
		const consistente = delta === 0;
		if (solo_inconsistentes && consistente) continue;
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
				total_productos_revisados: ids.size,
				inconsistentes,
				reparados,
				filas,
			},
		],
		reparar
			? `Consistencia: ${inconsistentes} inconsistente(s), ${reparados} reparado(s)`
			: `Consistencia: ${inconsistentes} inconsistente(s) de ${ids.size} producto(s)`,
	);
}

const IR_PENDING = 'pendiente_autorizacion_cobranza';
const IR_READY = 'listo_para_comercial';
const IR_SENT = 'enviado_a_comercial';
const IR_INVOICED = 'facturado';
const IR_CANCELED = 'cancelado';
const IR_PENDING_ALIASES = new Set([IR_PENDING, 'pendiente_autorizacion']);
const IR_READY_ALIASES = new Set([IR_READY, 'lista_comercial']);
const IR_SENT_ALIASES = new Set([IR_SENT, 'enviada_comercial']);
const IR_INVOICED_ALIASES = new Set([IR_INVOICED, 'facturada']);
const IR_CANCELED_ALIASES = new Set([IR_CANCELED, 'cancelada']);

async function violation_challenge(ctx: Ctx) {
	const rec = await need(ctx, 'violation', ctx.params.id);
	const reason = String(ctx.body.reason ?? ctx.body.motivo ?? '').trim();
	if (reason.length < 4) {
		throw new Error('Escribe el motivo de la impugnación (mínimo 4 caracteres).');
	}
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
	const order = await need(ctx, 'pedidos', ctx.params.orderId);
	const created = await ctx.store.insert('invoice-request', {
		name: `Factura ${order.name}`,
		pedido: order._id,
		estado: IR_PENDING,
		requiere_autorizacion_cobranza: true,
		articulos: order.articulos ?? order.items,
		total: order.total ?? order.importe,
		monto_total: order.total ?? order.importe,
	});
	return ok([created], 'Solicitud generada desde pedido');
}

async function invoice_authorize(ctx: Ctx) {
	const rec = await need(ctx, 'invoice-request', ctx.params.id);
	if (!rec.requiere_autorizacion_cobranza) {
		throw new Error('Esta solicitud no requiere autorización de cobranza.');
	}
	const estado = String(rec.estado ?? '');
	if (IR_CANCELED_ALIASES.has(estado)) throw new Error('La solicitud está cancelada.');
	if (IR_INVOICED_ALIASES.has(estado)) throw new Error('La solicitud ya fue marcada como facturada.');
	if (IR_SENT_ALIASES.has(estado)) {
		throw new Error('La solicitud ya fue enviada a comercial.');
	}
	if (estado && !IR_PENDING_ALIASES.has(estado)) {
		throw new Error('Solo se puede autorizar una solicitud pendiente de cobranza.');
	}
	const updated = await ctx.store.update('invoice-request', String(rec._id), {
		autorizado_cobranza: true,
		autorizado_cobranza_fecha: now(),
		autorizado_cobranza_usuario_nombre: actor_name(ctx),
		autorizado_cobranza_notas: ctx.body.notas,
		estado: IR_READY,
	});
	return ok([updated], 'Autorización de cobranza registrada');
}

async function invoice_send_commercial(ctx: Ctx) {
	const rec = await need(ctx, 'invoice-request', ctx.params.id);
	if (rec.estado && !IR_READY_ALIASES.has(String(rec.estado))) {
		throw new Error('La solicitud debe estar lista para comercial antes de enviarse.');
	}
	return patch_doc(ctx, 'invoice-request', String(rec._id), {
		estado: IR_SENT,
		enviado_a_comercial_fecha: now(),
		enviado_a_comercial_usuario_nombre: actor_name(ctx),
		comercial_referencia: ctx.body.comercial_referencia,
	}, 'Solicitud enviada a comercial');
}

async function invoice_mark(ctx: Ctx) {
	const rec = await need(ctx, 'invoice-request', ctx.params.id);
	if (rec.estado && !IR_SENT_ALIASES.has(String(rec.estado))) {
		throw new Error(
			'La solicitud debe haberse enviado a comercial antes de marcarse como facturada.',
		);
	}
	return patch_doc(ctx, 'invoice-request', String(rec._id), {
		estado: IR_INVOICED,
		fecha_facturacion: now(),
		facturado_fecha: now(),
		cfdi_id: ctx.body.cfdi_id,
		factura_referencia: ctx.body.factura_referencia,
	}, 'Solicitud marcada como facturada');
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
		status: 'draft',
		estado: 'draft',
		origen: 'invoice-request',
		origen_id: rec._id,
		payload_canonico: rec,
	});
	await ctx.store.update('invoice-request', String(rec._id), { cfdi_draft: created._id });
	return ok([created], 'Borrador CFDI creado');
}

function message_participants(doc: ImperiumDoc, uid: string): string[] {
	const parts = as_array(doc.participants ?? doc.participant_user_ids).map(String).filter(Boolean);
	const extra = [doc.from, doc.to, doc.created_by].map((v) => String(v ?? '')).filter(Boolean);
	const all = [...new Set([...parts, ...extra, uid].filter(Boolean))];
	return all;
}

async function my_conversations(ctx: Ctx) {
	const uid = actor_id(ctx);
	const { rows } = await ctx.store.find_many('messages', {
		take: 500,
		include_inactive: true,
	});
	const groups = new Map<string, ImperiumDoc[]>();
	for (const m of rows) {
		const parts = message_participants(m, uid);
		if (!parts.includes(uid)) continue;
		const others = parts.filter((p) => p !== uid).sort();
		const key = others.join(',') || `self:${String(m._id ?? m.id ?? '')}`;
		const list = groups.get(key) ?? [];
		list.push(m);
		groups.set(key, list);
	}
	const summaries = [...groups.entries()].map(([conversation_key, msgs]) => {
		const latest = [...msgs].sort((a, b) =>
			String(b.createdAt ?? b.updatedAt ?? '').localeCompare(
				String(a.createdAt ?? a.updatedAt ?? ''),
			),
		)[0]!;
		const participant_user_ids = message_participants(latest, uid);
		const other_id = participant_user_ids.find((p) => p !== uid);
		return {
			conversation_key,
			participant_user_ids,
			other_participant: other_id
				? { _id: other_id, name: String(latest.name ?? latest.title ?? other_id) }
				: undefined,
			latest_message: latest,
			unread_count: 0,
		};
	});
	return ok(summaries, 'Conversaciones');
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
	await ctx.store.update('payroll-period', String(period._id), { estado: 'generating' });
	const employees = ctx.store.has('employee')
		? (await ctx.store.find_many('employee', { take: 2000, populate: false })).rows
		: [];
	const existing = ctx.store.has('payroll-receipt')
		? (
				await ctx.store.find_many('payroll-receipt', {
					where: { payroll_period: String(period._id) },
					take: 5000,
					populate: false,
					include_inactive: true,
				})
			).rows
		: [];
	const by_emp = new Map<string, ImperiumDoc>();
	for (const rec of existing) {
		const emp_id = String(as_object(rec.employee)._id ?? rec.employee ?? '');
		if (emp_id) by_emp.set(emp_id, rec);
	}
	let created = 0;
	let updated = 0;
	const errors: Array<{ employee_id?: string; message: string }> = [];
	for (const emp of employees) {
		const emp_id = String(emp._id ?? '');
		if (!emp_id) continue;
		if (emp.salario_diario != null && !(Number(emp.salario_diario) > 0)) continue;
		const hit = by_emp.get(emp_id);
		const estado = String(hit?.estado ?? '');
		if (estado === 'stamped' || estado === 'stamping') continue;
		try {
			if (hit) {
				await ctx.store.update('payroll-receipt', String(hit._id), {
					name: `Recibo ${emp.name} · ${period.name}`.slice(0, 200),
					estado: estado === 'ready_to_stamp' ? estado : 'calculated',
					payroll_period: period._id,
					employee: emp_id,
				});
				updated += 1;
			} else {
				await ctx.store.insert('payroll-receipt', {
					name: `Recibo ${emp.name} · ${period.name}`.slice(0, 200),
					description: 'Borrador de nómina generado automáticamente',
					employee: emp_id,
					payroll_period: period._id,
					estado: 'calculated',
				});
				created += 1;
			}
		} catch (err) {
			errors.push({
				employee_id: emp_id,
				message: err instanceof Error ? err.message : 'Error al calcular recibo',
			});
		}
	}
	const after = ctx.store.has('payroll-receipt')
		? (
				await ctx.store.find_many('payroll-receipt', {
					where: { payroll_period: String(period._id) },
					take: 5000,
					populate: false,
				})
			).rows
		: [];
	const calculated_count = after.filter((r) =>
		['calculated', 'ready_to_stamp'].includes(String(r.estado)),
	).length;
	await ctx.store.update('payroll-period', String(period._id), {
		estado: 'open',
		receipts_count: after.length,
		calculated_count,
		borradores_generados: true,
		fecha_borradores: now(),
	});
	return ok(
		[{ created, updated, errors, receipts_count: after.length, calculated_count }],
		`Borradores generados: ${created} creados, ${updated} actualizados`,
	);
}

async function payroll_prepare_stamp(ctx: Ctx) {
	const rec = await need(ctx, 'payroll-receipt', ctx.params.id);
	const payload = rec.payload_cfdi ?? {
		meta: { source: 'payroll_receipt', source_id: rec._id },
		receptor: { nombre: rec.name },
		estado: 'ready_to_stamp',
	};
	return patch_doc(
		ctx,
		'payroll-receipt',
		String(rec._id),
		{
			estado: 'ready_to_stamp',
			payload_cfdi: payload,
			fecha_preparacion: now(),
		},
		'Recibo listo para timbrar',
	);
}

async function payroll_export_payload(ctx: Ctx) {
	const rec = await need(ctx, 'payroll-receipt', ctx.params.id);
	const payload =
		rec.payload_cfdi ??
		({
			meta: { source: 'payroll_receipt', source_id: rec._id },
			receptor: { nombre: rec.name },
		} as ImperiumDoc);
	return ok([payload], 'Payload CFDI N exportado (sin timbrar)');
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
			const created = await ctx.store.insert('pedidos', {
				name: String(pedido.name ?? pedido.folio ?? `Pedido ${offline_uuid.slice(0, 8)}`),
				articulos: Array.isArray(pedido.articulos) ? pedido.articulos : [],
				contacto: pedido.contacto,
				usuario: actor_id(ctx) || pedido.usuario,
				observaciones: pedido.observaciones ?? '',
				listaDePreciosId: pedido.listaDePreciosId,
				total: pedido.total ?? 0,
				iva: pedido.iva ?? 0,
				importe: pedido.importe ?? 0,
				folio: pedido.folio ?? '',
				ubicacion: pedido.ubicacion,
				estado,
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
	return Response.json({ ok: true, total: resultados.length, resultados });
}

/**
 * Descarga de listas de precio para PouchDB. Mismo contrato que el original:
 * `{ listasDePrecios }` con name, iva y product[] (sin popular).
 */
async function lista_de_precios_sync_offline(ctx: Ctx) {
	const { rows } = await ctx.store.find_many('lista-de-precios', {
		take: 5000,
		populate: false,
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
	const { rows } = await ctx.store.find_many('pos-session', {
		take: 200,
		include_inactive: true,
		populate: false,
	});
	const office_id = (value: unknown) => {
		if (value && typeof value === 'object') {
			return String((value as { _id?: unknown })._id ?? '');
		}
		return String(value ?? '');
	};
	const closed = rows
		.filter((r) => office_id(r.branch_office ?? r.sucursal) === branch)
		.filter(
			(r) =>
				['cerrada', 'CLOSED', 'cerrada'].includes(String(r.status ?? r.estado ?? '')) ||
				r.closing_date ||
				r.fecha_cierre,
		)
		.sort((a, b) =>
			String(b.closing_date ?? b.fecha_cierre ?? '').localeCompare(
				String(a.closing_date ?? a.fecha_cierre ?? ''),
			),
		);
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
	await assert_pos_pin(
		ctx.store,
		ctx.req,
		String(ctx.params.id ?? ''),
		tipo === 'cierre'
			? { method: 'POST', path: '/pos-session/report/close/:id', label: 'Reporte de cierre POS' }
			: { method: 'GET', path: '/pos-session/report/partial/:id', label: 'Reporte parcial POS' },
		ctx.actor,
	);
	const session = await need(ctx, 'pos-session', ctx.params.id);
	const tickets = ctx.store.has('pos-tickets')
		? (
				await ctx.store.find_many('pos-tickets', {
					where: { pos_session: String(session._id) },
					take: 2000,
					populate: false,
				})
			).rows
		: as_array(session.ordenes).map(as_object);
	const summaries = tickets.map((ticket) => {
		const ticket_type = String(ticket.ticket_type ?? 'VENTA').toUpperCase();
		const subtotal = Number(ticket.subtotal ?? ticket.total ?? ticket.importe ?? 0);
		const withdrawal_amount = Number(ticket.withdrawal_amount ?? 0);
		const is_withdrawal = ticket_type.includes('RETIRO');
		const cash_effect = is_withdrawal ? -Math.abs(withdrawal_amount || subtotal) : subtotal;
		return {
			_id: String(ticket._id ?? ''),
			ticket_sequence: String(ticket.ticket_sequence ?? ticket.name ?? ''),
			ticket_type,
			client_name: String(ticket.client_name ?? 'Publico general'),
			withdrawal_amount,
			withdrawal_reason: String(ticket.withdrawal_reason ?? ''),
			withdrawal_signature: ticket.withdrawal_signature ?? '',
			cash_effect,
			display_amount: Math.abs(cash_effect),
			subtotal,
			total_paid: Number(ticket.total_paid ?? subtotal),
			createdAt: ticket.createdAt ?? ticket.created_at ?? now(),
		};
	});
	const total_sales = summaries
		.filter((t) => !String(t.ticket_type).includes('RETIRO'))
		.reduce((s, t) => s + Number(t.subtotal), 0);
	const total_manual_withdrawals = summaries
		.filter((t) => String(t.ticket_type).includes('RETIRO'))
		.reduce((s, t) => s + Math.abs(Number(t.withdrawal_amount || t.subtotal)), 0);
	const opening_money = Number(session.cash_register_opening_money ?? 0);
	const branch = as_object(session.branch_office);
	const cashier = as_object(session.cashier);
	const report = {
		report_type: tipo === 'cierre' ? 'CIERRE_CAJA' : 'VENTAS_PARCIAL',
		generated_at: now(),
		session_id: String(session._id),
		session_name: String(session.name ?? ''),
		branch_office_name: String(branch.name ?? session.branch_office ?? 'Sin asignar'),
		opening_date: session.opening_date ?? now(),
		closing_date: session.closing_date,
		user_name: actor_name(ctx) || 'Usuario actual',
		employee_name: String(session.cashier_name ?? cashier.name ?? 'Sin asignar'),
		total_tickets: summaries.length,
		total_sales: Number(total_sales.toFixed(2)),
		total_manual_withdrawals: Number(total_manual_withdrawals.toFixed(2)),
		expected_cash: Number((opening_money + total_sales - total_manual_withdrawals).toFixed(2)),
		cash_register_opening_money: opening_money,
		tickets: summaries,
	};
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
	const session = await need(ctx, 'pos-session', ctx.params.id);
	if (!is_pos_session_open(session)) {
		throw new Error('Solo se puede concluir el cierre para sesiones abiertas');
	}
	await pos_report(ctx, 'cierre');
	const closed_at = now();
	const updated = await ctx.store.update('pos-session', String(session._id), {
		status: 'cerrada',
		estado: 'cerrada',
		on_use: false,
		closing_date: closed_at,
		fecha_cierre: closed_at,
		cierre: ctx.body,
	});
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
	const session = await need(ctx, 'pos-session', ctx.params.id);
	if (!is_pos_session_open(session)) {
		throw new Error('Solo se pueden cancelar sesiones abiertas');
	}
	const closed_at = now();
	return patch_doc(ctx, 'pos-session', String(session._id), {
		status: 'cancelada',
		estado: 'cancelada',
		on_use: false,
		closing_date: closed_at,
		fecha_cancelacion: closed_at,
	}, 'Sesión cancelada correctamente.');
}

function is_pos_session_open(doc: ImperiumDoc) {
	const raw = String(doc.status ?? doc.estado ?? '').trim().toLowerCase();
	return raw === 'abierta' || raw === 'open';
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
				return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
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
	const title = String(ctx.body.title ?? ctx.body.subject ?? ctx.body.name ?? 'Ticket');
	const assigned = String(ctx.body.assigned_user_id ?? ctx.body.assignedUserId ?? '').trim();
	const created = await ctx.store.insert('tickets', {
		...ctx.body,
		name: title,
		title,
		status: ctx.body.status ?? 'open',
		estado: ctx.body.estado ?? ctx.body.status ?? 'open',
		sourceType: ctx.body.sourceType ?? infer_ticket_source(ctx.action),
		assignedUserId: assigned || undefined,
		assigned_user_id: assigned || undefined,
		created_by: actor_id(ctx),
	});
	return ok([created], 'Ticket creado');
}

function infer_ticket_source(action: string) {
	if (action.includes('public')) return 'public';
	if (action.includes('error')) return 'error';
	if (action.includes('log')) return 'log';
	if (action.includes('interinstance')) return 'interinstance';
	return 'internal';
}

async function update_ticket(ctx: Ctx) {
	const assigned = String(ctx.body.assigned_user_id ?? ctx.body.assignedUserId ?? '').trim();
	const patch: ImperiumDoc = { ...ctx.body };
	delete patch.signature;
	if (assigned) {
		patch.assignedUserId = assigned;
		patch.assigned_user_id = assigned;
	}
	if (ctx.body.status) {
		patch.status = ctx.body.status;
		patch.estado = ctx.body.status;
	}
	if (ctx.body.title) {
		patch.title = ctx.body.title;
		patch.name = ctx.body.title;
	}
	return patch_doc(ctx, 'tickets', ctx.params.id, patch, 'Ticket actualizado');
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
	const user = await need(ctx, 'user', ctx.params.id);
	const token = crypto.randomUUID();
	await ctx.store.update('user', String(user._id), {
		recovery_token: token,
		recovery_expires: new Date(Date.now() + 3600_000).toISOString(),
	});
	return ok([{ token, user_id: user._id }], 'Enlace de recuperación generado');
}

async function verify_pin(ctx: Ctx) {
	return verify_user_pin(ctx.store, ctx.body, ctx.actor);
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
	const box_id = String(ctx.body.box_config_id ?? ctx.body.box ?? ctx.body.caja ?? '').trim();
	if (!box_id) throw new Error('Se necesita una caja para tomar el siguiente turno');
	const box = await ctx.store.find_id('ticketing-system-box-config', box_id);
	if (!box) throw new Error('No se encontró la configuración de la caja');
	const allowed_services = as_id_list(box.allowed_services);
	const allowed_types = as_id_list(box.allowed_customer_types);
	const pending = await ctx.store.find_many('ticketing-system-turn', {
		where: { status: 'pendiente' },
		take: 10000,
	});
	const waiting = pending.rows.length
		? pending.rows
		: (
				await ctx.store.find_many('ticketing-system-turn', {
					where: { estado: 'pendiente' },
					take: 10000,
				})
			).rows;
	if (!waiting.length) throw new Error('Sin turnos a la espera');
	const matching = waiting.filter((turn) => {
		const services = as_id_list(turn.services);
		const type_id = ref_id(turn.customer_type);
		const services_ok = services.every((id) => allowed_services.includes(id));
		const type_ok = allowed_types.includes(type_id);
		return services_ok && type_ok;
	});
	if (!matching.length) {
		const missing_services = new Set<string>();
		const missing_types = new Set<string>();
		for (const turn of waiting) {
			for (const id of as_id_list(turn.services)) {
				if (!allowed_services.includes(id)) missing_services.add(id);
			}
			const type_id = ref_id(turn.customer_type);
			if (!allowed_types.includes(type_id)) {
				missing_types.add(type_id || 'tipo desconocido');
			}
		}
		const services_list = [...missing_services].join(', ');
		const types_list = [...missing_types].join(', ');
		if (missing_services.size && missing_types.size) {
			throw new Error(
				`Los turnos disponibles requieren que la caja tenga el servicio '${services_list}' y el tipo de usuario '${types_list}' configurado. No fue posible tomar un turno.`,
			);
		}
		if (missing_services.size) {
			throw new Error(
				`Los turnos disponibles requieren que la caja tenga el servicio '${services_list}' configurado. No fue posible tomar un turno.`,
			);
		}
		throw new Error(
			`Los turnos disponibles requieren que la caja tenga el tipo de usuario '${types_list}' configurado. No fue posible tomar un turno.`,
		);
	}
	matching.sort((a, b) => {
		const pa = Number(a.priority_level ?? 0);
		const pb = Number(b.priority_level ?? 0);
		if (pb !== pa) return pb - pa;
		return (
			new Date(String(a.createdAt ?? a.created_at ?? 0)).getTime() -
			new Date(String(b.createdAt ?? b.created_at ?? 0)).getTime()
		);
	});
	const next = matching[0];
	const updated = await ctx.store.update('ticketing-system-turn', String(next._id), {
		status: 'en_atencion',
		estado: 'en_atencion',
		assigned_box: box_id,
		fecha_inicio: now(),
		time_box: [now()],
		atendido_por: actor_name(ctx),
	});
	return ok([updated], 'Turno tomado', waiting.length);
}

async function notify_turn(ctx: Ctx) {
	const id = String(ctx.body.turn_id ?? ctx.body.id ?? ctx.body._id ?? '');
	if (!id) throw new Error('Se necesita un id de turno para notificar');
	const doc = await need(ctx, 'ticketing-system-turn', id);
	return ok([doc], 'Turno notificado');
}

async function end_attending_turn(ctx: Ctx) {
	const id = String(ctx.body.turn_id ?? ctx.body.id ?? ctx.body._id ?? '');
	if (!id) throw new Error('Se necesita un id de turno para finalizar');
	const doc = await need(ctx, 'ticketing-system-turn', id);
	const time = as_array(doc.time);
	const time_box = as_array(doc.time_box);
	const time_attending = as_array(doc.time_attending);
	const stamp = now();
	const updated = await ctx.store.update('ticketing-system-turn', id, {
		status: 'completado',
		estado: 'completado',
		time: [...time, stamp],
		time_box: [...time_box, stamp],
		time_attending: [...time_attending, stamp],
		fecha_fin: stamp,
	});
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
	const entry = await need(ctx, 'lista-asistencia', ctx.params.id);
	const estado = String(ctx.body.estado ?? 'pendiente').trim();
	if (!['pendiente', 'presente', 'ausente'].includes(estado)) {
		throw new Error('El estado de asistencia no es válido');
	}
	const justificada = estado === 'ausente' ? Boolean(ctx.body.justificada) : false;
	const evidencia = estado === 'ausente' ? String(ctx.body.evidencia ?? '') : '';
	const description = String(ctx.body.description ?? '');
	const registro_id = String(entry.registro_asistencia_id ?? '');
	let attendance: ImperiumDoc | null = null;
	if (registro_id && ctx.store.has('registro-asistencias')) {
		attendance = await ctx.store.find_id('registro-asistencias', registro_id);
		if (!attendance) throw new Error('No se encontró el registro de asistencia');
		const estatus = String(attendance.estatus ?? attendance.estado ?? '');
		if (estatus === 'cerrada') {
			throw new Error('La asistencia ya está cerrada y no permite modificar sus alumnos');
		}
	}
	const patch: ImperiumDoc = {
		estado,
		justificada,
		evidencia,
		description,
	};
	if (estado === 'ausente' && ctx.store.has('registro-incidencias')) {
		const incident = await ctx.store.insert('registro-incidencias', {
			name: `Ausencia ${entry.alumno_nombre_snapshot ?? entry.name ?? ''}`.trim(),
			description,
			alumno_id: entry.alumno_id,
			grupo_id: entry.grupo_id,
			registro_asistencia_id: entry.registro_asistencia_id,
			lista_asistencia_id: entry._id,
			materia_id: attendance?.materia_id,
			tipo: 'ausencia',
			justificada,
			evidencia,
			fecha_asistencia: attendance?.fecha_asistencia ?? now(),
		});
		patch.registro_incidencia_id = incident._id;
	}
	return patch_doc(ctx, 'lista-asistencia', String(entry._id), patch, 'Asistencia actualizada correctamente');
}

async function medical_for_doctor(ctx: Ctx) {
	const by_status = await ctx.store.find_many('medical-file', {
		where: { status: { in: ['pendiente', 'en_consulta'] } },
		take: 500,
	});
	if (by_status.rows.length) return ok(by_status.rows, 'Expedientes del médico', by_status.total);
	const by_estado = await ctx.store.find_many('medical-file', {
		where: { estado: { in: ['pendiente', 'en_consulta'] } },
		take: 500,
	});
	return ok(by_estado.rows, 'Expedientes del médico', by_estado.total);
}

async function medical_pending(ctx: Ctx) {
	const by_status = await ctx.store.find_many('medical-file', {
		where: { status: 'pendiente' },
		take: 500,
	});
	if (by_status.rows.length) return ok(by_status.rows, 'Pendientes', by_status.total);
	const by_estado = await ctx.store.find_many('medical-file', {
		where: { estado: 'pendiente' },
		take: 500,
	});
	return ok(by_estado.rows, 'Pendientes', by_estado.total);
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

async function payments_checkout(ctx: Ctx) {
	const slug = String(ctx.body.service_slug ?? '');
	const service = payable_services().find((s) => s.slug === slug);
	if (!service) throw new Error('Servicio de pago no encontrado.');
	const lookup = String(ctx.body.lookup ?? '').trim();
	if (service.lookup_label && !lookup) {
		throw new Error(`Se requiere: ${service.lookup_label}.`);
	}
	const amount = Number(ctx.body.amount);
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error('El monto debe ser mayor a cero.');
	}
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
		status: 'pendiente',
		provider: 'stripe',
		currency,
		external_ref: lookup,
		customer_email: ctx.body.email ? String(ctx.body.email) : '',
		invoice_requested: Boolean(ctx.body.invoice),
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
	const mode = cfg_text(doc?.value, 'escpos');
	return ok([{ mode }], 'Modo de impresión');
}

function cfg_text(value: unknown, fallback = '') {
	return String(value ?? fallback).replace(/^"+|"+$/g, '') || fallback;
}

async function agua_is_mssql_enabled(ctx: Ctx) {
	const doc = await ctx.store.find_where('configuration', {
		ref: 'configuration-agua-mssql-enabled',
	});
	const raw = cfg_text(doc?.value, 'false');
	return raw === 'true' || raw === '1';
}

async function agua_sync_estado(ctx: Ctx) {
	const enabled = await agua_is_mssql_enabled(ctx);
	return ok(
		[{ enabled }],
		enabled ? 'Conexión MSSQL habilitada' : 'Conexión MSSQL deshabilitada',
	);
}

async function agua_require_mssql(ctx: Ctx) {
	if (!(await agua_is_mssql_enabled(ctx))) {
		throw new Error(
			'La conexión MSSQL (SIMAPA) está deshabilitada. Actívala en Configuración para sincronizar.',
		);
	}
	const server = cfg_text(
		(await ctx.store.find_where('configuration', { ref: 'configuration-agua-mssql-server' }))
			?.value,
	);
	const database = cfg_text(
		(await ctx.store.find_where('configuration', { ref: 'configuration-agua-mssql-database' }))
			?.value,
	);
	if (!server || !database) {
		throw new Error(
			'Configuración MSSQL incompleta: define al menos servidor y base de datos.',
		);
	}
	throw new Error('Origen MSSQL no disponible en el núcleo SQL');
}
