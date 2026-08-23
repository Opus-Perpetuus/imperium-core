/**
 * CRUD Imperium: mismas rutas que `crud_routes()` del backend Express.
 */
import { as_array, as_object, fail, ok, type ImperiumDoc } from './envelope.ts';
import { query_list, read_imperium_body } from './body.ts';
import type { ImperiumStore } from './store.ts';
import { assert_pos_pin, maybe_create_pos_session_pin } from './user-pin.ts';
import { register_document_mentions } from './notifications.ts';
import { apply_uploads, link_attachments_to_record } from './uploads.ts';
import {
	after_pedido_mutate,
	decorate_pedido,
	enrich_pedidos_list,
	is_pedido_resource,
	prepare_pedido_create,
	prepare_pedido_update,
} from './pedidos-flow.ts';
import {
	after_delivery_package_mutate,
	prepare_delivery_package_create,
	prepare_delivery_package_update,
} from './delivery-package-flow.ts';
import {
	prepare_delivery_return_create,
	prepare_delivery_return_update,
} from './delivery-return-flow.ts';
import {
	decorate_delivery_routes,
	is_delivery_route_resource,
	prepare_delivery_route_write,
} from './delivery-route-flow.ts';
import { list_instance_type, project_list_docs } from './list-projection.ts';
import {
	prepare_purchase_order_create,
	prepare_purchase_order_update,
} from './purchase-order-flow.ts';
import { sync_inbound_supplier_invoice } from './cfdi-from-purchase.ts';
import {
	decorate_inventory_reception_list,
	ensure_pending_reception_from_purchase_order,
} from './inventory-reception-flow.ts';
import {
	notify_ticketing_rooms,
	prepare_ticketing_turn_create,
} from './ticketing-turn-flow.ts';
import {
	prepare_pos_session_create,
	prepare_pos_session_update,
	prepare_pos_ticket_create,
} from './pos-session-flow.ts';
import { decorate_product, prepare_product_write } from './products-flow.ts';
import { decorate_vehicle, prepare_vehicle_write } from './vehicle-flow.ts';
import { is_location_resource, prepare_location_write } from './location-flow.ts';
import { import_location_tree_from_body } from './actions.ts';
import {
	decorate_physical_count,
	is_physical_count_resource,
	prepare_physical_count_create,
	prepare_physical_count_update,
} from './inventory-physical-count-flow.ts';
import { apply_cobranza_payment } from './cobranza-payment-flow.ts';
import { is_citizen_report_resource, prepare_citizen_report_write } from './citizen-report-flow.ts';
import { apply_report_list_where, assert_report_template_write } from './reports-flow.ts';
import { is_asociacion_resource, prepare_asociacion_write } from './asociaciones-flow.ts';
import {
	apply_incidencia_list_where,
	is_incidencia_resource,
	prepare_incidencia_write,
} from './registro-incidencias-flow.ts';
import {
	apply_lista_asistencia_list_where,
	apply_registro_asistencia_list_where,
	is_lista_asistencia_resource,
	is_registro_asistencia_resource,
	prepare_lista_asistencia_write,
	prepare_registro_asistencia_write,
	snapshot_attendance_entries,
} from './lista-asistencia-flow.ts';
import {
	dashboard_access,
	dashboard_can_manage,
	dashboard_is_visible,
	is_dashboard_resource,
	is_view_preset_resource,
	prepare_dashboard_write,
	prepare_view_preset_create,
} from './dashboard-flow.ts';
import {
	after_project_write,
	apply_root_parent_filter,
	assert_personal_task_owner,
	hydrate_project,
	is_personal_task_resource,
	is_project_resource,
	is_project_task_resource,
	prepare_personal_task_write,
	prepare_project_task_write,
	prepare_project_write,
	strip_root_parent_where,
} from './planeacion-flow.ts';
import {
	is_print_template_resource,
	prepare_print_template_write,
} from './print-template-flow.ts';
import { build_access } from './auth.ts';
import { is_seed_admin } from './group-access.ts';
import {
	assert_record_in_scope,
	operation_flag,
	record_rule_lookup_keys,
	record_rule_scope_from_access,
	type RecordRuleMatchResult,
} from './record-rules.ts';

async function record_rule_scope(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	resource: string,
	method: string,
): Promise<RecordRuleMatchResult> {
	if (!actor || is_seed_admin(actor)) return { match: null, applicable_rules: [] };
	const access = await build_access(store, actor);
	return record_rule_scope_from_access(
		access,
		actor,
		record_rule_lookup_keys(resource),
		operation_flag(method),
	);
}

const INVENTORY_LEDGER_WRITE_ERRORS: Record<
	string,
	{ create: string; update: string; delete: string; batch: string }
> = {
	'inventory-movement': {
		create: 'Los movimientos de inventario se generan automáticamente desde compras y logística',
		update: 'Los movimientos de inventario no se pueden editar manualmente',
		delete: 'Los movimientos de inventario no se pueden eliminar manualmente',
		batch: 'Los movimientos de inventario no soportan operaciones batch',
	},
	'inventory-stock-quant': {
		create: 'Las existencias por ubicación se generan automáticamente desde los movimientos de inventario',
		update: 'Las existencias por ubicación no se pueden editar manualmente',
		delete: 'Las existencias por ubicación no se pueden eliminar manualmente',
		batch: 'Las existencias por ubicación no soportan operaciones batch',
	},
	'inventory-cost-entry': {
		create: 'Las entradas de inventario se generan automáticamente al confirmar compras',
		update: 'Las entradas de inventario no se pueden editar manualmente',
		delete: 'Las entradas de inventario no se pueden eliminar manualmente',
		batch: 'Las entradas de inventario no soportan operaciones batch',
	},
};

function assert_inventory_ledger_write(
	resource: string,
	op: 'create' | 'update' | 'delete' | 'batch',
) {
	const message = INVENTORY_LEDGER_WRITE_ERRORS[resource]?.[op];
	if (message) throw new Error(message);
}

async function assert_id_in_scope(
	store: ImperiumStore,
	resource: string,
	id: string,
	scope: RecordRuleMatchResult,
	method: string,
) {
	await assert_record_in_scope(store, resource, id, scope, method);
}

export async function handle_crud(
	store: ImperiumStore,
	req: Request,
	url: URL,
	resource: string,
	rest: string,
	actor: ImperiumDoc | null = null,
): Promise<Response | null> {
	const method = req.method.toUpperCase();
	const segs = rest.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	const body = async () => read_imperium_body(req);

	if (resource === 'cobranza-payment') {
		if (method === 'POST' && segs.length === 0) {
			return json(
				resource,
				await apply_cobranza_payment({
					store,
					actor,
					body: await body(),
					params: {},
				}),
				201,
			);
		}
		if (method === 'PUT' || method === 'PATCH') {
			if (segs[0] === 'batch') throw new Error('Método no implementado.');
			throw new Error('Los pagos no se editan; usa cancelar para revertir un abono.');
		}
		if (method === 'DELETE') throw new Error('Método no implementado.');
	}

	if (method === 'GET' && segs[0] === 'statistics' && segs.length === 1) {
		if (is_project_task_resource(resource) && !url.searchParams.get('project_id')) {
			throw new Error('Debes indicar el proyecto a consultar');
		}
		const scope = await record_rule_scope(store, actor, resource, method);
		const stats = await store.stats(resource, url, scope.match);
		const message =
			resource === 'ticketing-system-turn'
				? 'Estadísticas obtenidas con información completa'
				: resource === 'citizen-report'
					? 'Estadísticas de reportes ciudadanos obtenidas correctamente'
					: 'Estadísticas obtenidas correctamente';
		return json(resource, ok([stats], message));
	}
	if (method === 'GET' && segs[0] === 'field-values' && segs[1]) {
		const { q } = query_list(url);
		const values = await store.distinct(resource, decodeURIComponent(segs[1]), q);
		return json(
			resource,
			ok(
				values.map((v) => ({ value: v, label: String(v) })),
				'Valores de campo',
			),
		);
	}
	if (method === 'GET' && segs[0] === 'export.csv' && segs.length === 1) {
		const { q, include_inactive, where, ids } = query_list(url);
		const scope = await record_rule_scope(store, actor, resource, method);
		const { rows } = await store.find_many(resource, {
			q,
			take: 5000,
			include_inactive,
			where: Object.keys(where).length ? where : undefined,
			ids,
			mongo_match: scope.match,
		});
		const decorated = await finalize_rows(store, resource, rows, 'list');
		const keys = new Set<string>();
		for (const r of decorated) for (const k of Object.keys(r)) keys.add(k);
		const cols = [...keys]
			.filter((k) => k !== 'payload' && !USER_SECRET_KEYS.has(k))
			.slice(0, 40);
		const lines = [
			cols.join(','),
			...decorated.map((r) =>
				cols
					.map((c) => csv(r[c]))
					.join(','),
			),
		];
		return new Response(lines.join('\n'), {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="${resource}.csv"`,
			},
		});
	}
	if (method === 'POST' && segs[0] === 'mass-query' && segs.length === 1) {
		const b = await body();
		const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
		const { rows, total } = await store.find_many(resource, {
			ids,
			take: Number(b.limite ?? 10000),
			skip: Number(b.desde ?? 0),
			include_inactive: true,
		});
		return json(
			resource,
			ok(await finalize_rows(store, resource, rows, 'list'), 'Consulta masiva', total),
		);
	}
	if (method === 'PUT' && segs[0] === 'batch' && segs.length === 1) {
		if (is_print_template_resource(resource)) {
			throw new Error('Method not implemented.');
		}
		if (is_physical_count_resource(resource)) {
			throw new Error('Los conteos físicos no soportan operaciones batch');
		}
		assert_inventory_ledger_write(resource, 'batch');
		if (resource === 'delivery-return') {
			throw new Error('Las devoluciones no soportan operaciones batch');
		}
		if (is_location_resource(resource)) {
			const raw = await body();
			const payload = Array.isArray(raw)
				? { lineas: raw }
				: (as_object(raw) as Record<string, unknown>);
			return json(resource, await import_location_tree_from_body(store, payload));
		}
		const b = await body();
		const items = Array.isArray(b) ? b : Array.isArray(b.rows) ? b.rows : [];
		const match = String(url.searchParams.get('batch_match_field') ?? '_id');
		const out: ImperiumDoc[] = [];
		for (const raw of items) {
			const doc = raw as ImperiumDoc;
			const key = String(doc[match] ?? doc._id ?? doc.id ?? '');
			if (key) {
				const existing = await store.find_id(resource, key);
				if (existing) {
					const updated = await store.update(
						resource,
						String(existing._id),
						await prepare_user_write(resource, doc, false),
					);
					if (updated) out.push(updated);
					continue;
				}
			}
			out.push(await store.insert(resource, await prepare_user_write(resource, doc, true)));
		}
		return json(resource, ok(out, 'Lote aplicado', out.length));
	}
	if (method === 'GET' && segs.length === 3 && segs[1] === 'array') {
		const doc = await store.find_id(resource, segs[0]!);
		if (!doc) return json(resource, fail('No encontrado', 404).body, 404);
		const field = decodeURIComponent(segs[2]!);
		const arr = Array.isArray(doc[field]) ? doc[field] : [];
		return json(resource, ok(arr as ImperiumDoc[], 'Campo arreglo'));
	}
	if (method === 'DELETE' && segs[0] === 'id' && segs[1] && segs.length === 2) {
		if (is_print_template_resource(resource)) {
			throw new Error('Method not implemented.');
		}
		if (resource === 'delivery-package') {
			throw new Error('No se eliminan bultos. Usa «Anular bulto» para liberar el empaque.');
		}
		if (is_dashboard_resource(resource)) {
			const existing = await store.find_id(resource, segs[1]!);
			const access = await dashboard_access(store, actor);
			if (!dashboard_can_manage(existing, access)) {
				throw new Error('Solo el dueño del tablero puede eliminarlo');
			}
		}
		if (resource === 'delivery-return') {
			throw new Error('Las devoluciones no se pueden eliminar manualmente');
		}
		if (is_physical_count_resource(resource)) {
			throw new Error('Los conteos físicos no se pueden eliminar manualmente');
		}
		if (is_location_resource(resource)) {
			throw new Error('Las ubicaciones no soportan borrado manual');
		}
		assert_inventory_ledger_write(resource, 'delete');
		const scope = await record_rule_scope(store, actor, resource, method);
		await assert_id_in_scope(store, resource, segs[1], scope, method);
		const deleted = await store.remove(resource, segs[1]);
		if (!deleted) return json(resource, fail('No encontrado', 404).body, 404);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'delete', deleted);
		return json(
			resource,
			ok([deleted], resource === 'pedidos' ? 'Pedido eliminado' : 'Eliminado correctamente'),
		);
	}
	if (method === 'GET' && segs.length === 0) {
		const q = query_list(url);
		if (is_project_task_resource(resource) && !q.where.project_id) {
			return json(resource, {
				...ok([], 'Sin proyecto especificado', 0),
				tipo_de_instancia: instance_type(store, resource, []),
				module_info: { name: resource, model: resource, model_id: resource },
			});
		}
		if (is_personal_task_resource(resource)) {
			const uid = String(actor?._id ?? '');
			if (!uid) throw new Error('No se pudo resolver el usuario actual');
			q.where.owner_user = uid;
		}
		if (is_incidencia_resource(resource)) {
			q.where = apply_incidencia_list_where(q.where);
		}
		if (is_registro_asistencia_resource(resource)) {
			q.where = apply_registro_asistencia_list_where(q.where);
		}
		if (is_lista_asistencia_resource(resource)) {
			q.where = apply_lista_asistencia_list_where(q.where);
		}
		if (resource === 'reports') {
			q.where = apply_report_list_where(store, q.where);
		}
		const where = strip_root_parent_where(q.where);
		const scope = await record_rule_scope(store, actor, resource, method);
		const found = await store.find_many(resource, {
			...q,
			where: Object.keys(where).length ? where : undefined,
			mongo_match: scope.match,
			take: q.where.parent_task === '__root__' || q.where.parent_task_id === '__root__' ? 2000 : q.take,
		});
		let filtered = apply_root_parent_filter(resource, q.where, found.rows);
		if (is_lista_asistencia_resource(resource) && !url.searchParams.get('campoSort')) {
			filtered = [...filtered].sort((a, b) => {
				const by_number = Number(a.numero_lista ?? 0) - Number(b.numero_lista ?? 0);
				if (by_number) return by_number;
				return String(a.alumno_nombre_snapshot ?? a.name ?? '').localeCompare(
					String(b.alumno_nombre_snapshot ?? b.name ?? ''),
					'es',
				);
			});
		}
		const { rows, total } = {
			rows: filtered,
			total:
				filtered.length === found.rows.length
					? found.total
					: filtered.length,
		};
		let decorated = await finalize_rows(store, resource, rows, 'list');
		let visible_total = total;
		if (is_dashboard_resource(resource)) {
			const access = await dashboard_access(store, actor);
			if (!access.full) {
				decorated = decorated.filter((doc) => dashboard_is_visible(doc, access));
				visible_total = decorated.length;
			}
		}
		return json(resource, {
			...ok(decorated, 'Ruta encontrada', visible_total),
			tipo_de_instancia: instance_type(store, resource, decorated),
			module_info: { name: resource, model: resource, model_id: resource },
		});
	}
	if (method === 'GET' && segs.length === 1) {
		if (resource === 'pos-session') {
			await assert_pos_pin(
				store,
				req,
				segs[0]!,
				{ method: 'GET', path: '/pos-session/:id', label: 'Restaurar sesion POS' },
				actor,
			);
		}
		const doc = await store.find_id(resource, segs[0]!);
		if (!doc) return json(resource, fail('No encontrado', 404).body, 404);
		if (is_dashboard_resource(resource)) {
			const access = await dashboard_access(store, actor);
			if (!dashboard_is_visible(doc, access)) {
				return json(resource, fail('Tablero no encontrado', 404).body, 404);
			}
		}
		const scope = await record_rule_scope(store, actor, resource, method);
		await assert_id_in_scope(store, resource, segs[0]!, scope, method);
		const [populated] = await finalize_rows(
			store,
			resource,
			await store.populate_docs(resource, [doc]),
			'detail',
		);
		const detail = is_project_resource(resource)
			? await hydrate_project(store, populated)
			: populated;
		return json(
			resource,
			ok(
				[detail],
				resource === 'delivery-package'
					? 'Bulto encontrado'
					: resource === 'delivery-return'
						? 'Devolución encontrada'
						: resource === 'vehicle'
							? 'Vehículo encontrado'
							: is_location_resource(resource)
								? 'Ubicación encontrada'
								: is_physical_count_resource(resource)
								? 'Conteo encontrado'
								: 'Ruta encontrada',
			),
		);
	}
	if (method === 'POST' && segs.length === 0) {
		assert_inventory_ledger_write(resource, 'create');
		let incoming = await prepare_user_write(
			resource,
			await apply_uploads(store, resource, await body(), actor, {
				method: 'POST',
			}),
			true,
		);
		if (resource === 'pedidos') {
			incoming = await prepare_pedido_create(store, incoming, actor);
		}
		if (resource === 'delivery-package') {
			incoming = await prepare_delivery_package_create(store, incoming);
		}
		if (resource === 'delivery-return') {
			incoming = await prepare_delivery_return_create(incoming);
		}
		if (is_delivery_route_resource(resource)) {
			incoming = await prepare_delivery_route_write(store, incoming);
		}
		if (resource === 'purchase-order') {
			incoming = await prepare_purchase_order_create(store, incoming);
		}
		if (resource === 'ticketing-system-turn') {
			incoming = await prepare_ticketing_turn_create(store, incoming);
		}
		if (resource === 'pos-session') {
			incoming = await prepare_pos_session_create(store, incoming, actor);
		}
		if (resource === 'pos-tickets') {
			incoming = await prepare_pos_ticket_create(store, incoming, actor);
			await assert_pos_pin(
				store,
				req,
				String(incoming.pos_session ?? ''),
				{ method: 'POST', path: '/pos-tickets', label: 'Crear ticket POS' },
				actor,
			);
		}
		if (resource === 'products') {
			incoming = await prepare_product_write(store, incoming);
		}
		if (resource === 'vehicle') {
			incoming = await prepare_vehicle_write(store, incoming);
		}
		if (is_location_resource(resource)) {
			incoming = await prepare_location_write(store, incoming);
		}
		if (is_physical_count_resource(resource)) {
			incoming = await prepare_physical_count_create(store, incoming);
		}
		const project_seed = incoming;
		if (is_project_resource(resource)) {
			incoming = prepare_project_write(incoming, actor);
		}
		if (is_project_task_resource(resource)) {
			incoming = prepare_project_task_write(incoming, actor);
		}
		if (is_personal_task_resource(resource)) {
			incoming = prepare_personal_task_write(incoming, actor);
		}
		if (is_citizen_report_resource(resource)) {
			incoming = await prepare_citizen_report_write(store, incoming, true);
		}
		if (is_dashboard_resource(resource)) {
			incoming = prepare_dashboard_write(
				incoming,
				actor,
				await dashboard_access(store, actor),
				true,
			);
		}
		if (is_view_preset_resource(resource)) {
			incoming = prepare_view_preset_create(incoming, actor);
		}
		if (is_asociacion_resource(resource)) {
			incoming = prepare_asociacion_write(incoming, null, true);
		}
		if (is_incidencia_resource(resource)) {
			incoming = prepare_incidencia_write(incoming, true);
		}
		if (is_registro_asistencia_resource(resource)) {
			incoming = prepare_registro_asistencia_write(incoming, actor, true);
		}
		if (is_lista_asistencia_resource(resource)) {
			incoming = await prepare_lista_asistencia_write(store, incoming);
		}
		if (resource === 'reports') {
			await assert_report_template_write(store, incoming);
		}
		if (is_print_template_resource(resource)) {
			incoming = await prepare_print_template_write(store, incoming);
		}
		const doc = await before_create(store, resource, incoming, actor);
		const created = await store.insert(resource, doc);
		await link_attachments_to_record(store, resource, created);
		await maybe_register_mentions(store, actor, resource, created);
		const notice = await after_create(store, resource, created, actor);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'create', created);
		if (resource === 'ticketing-system-turn') await notify_ticketing_rooms(store);
		if (resource === 'purchase-order') {
			await sync_inbound_supplier_invoice(store, created);
			await ensure_pending_reception_from_purchase_order(store, created);
		}
		if (is_project_resource(resource)) {
			await after_project_write(store, created, project_seed, actor);
		}
		let result = created;
		if (resource === 'delivery-package') {
			await after_delivery_package_mutate(store, String(created.pedido ?? ''));
			result = (await store.find_id(resource, String(created._id))) ?? created;
		}
		if (is_project_resource(resource)) {
			result = (await store.find_id(resource, String(created._id))) ?? created;
			result = await hydrate_project(store, result);
		}
		if (is_registro_asistencia_resource(resource)) {
			result = await snapshot_attendance_entries(store, created);
		}
		const [populated] = await finalize_rows(
			store,
			resource,
			await store.populate_docs(resource, [result]),
			'detail',
		);
		const message =
			resource === 'pos-session'
				? 'Sesión creada'
				: resource === 'pos-tickets'
				? 'Ticket creado'
				: resource === 'pedidos'
					? 'Pedido creado'
					: resource === 'delivery-package'
						? 'Bulto creado correctamente'
						: resource === 'delivery-return'
							? 'Devolución creada correctamente'
							: resource === 'purchase-order'
								? 'Orden de compra creada correctamente'
								: resource === 'vehicle'
									? 'Vehículo creado correctamente'
									: is_location_resource(resource)
										? 'Ubicación creada correctamente'
									: is_physical_count_resource(resource)
										? 'Conteo creado correctamente'
										: is_project_resource(resource)
										? 'Proyecto creado'
										: is_project_task_resource(resource)
											? 'Tarea de proyecto creada'
											: is_personal_task_resource(resource)
												? 'Tarea personal creada'
												: is_citizen_report_resource(resource)
													? 'Reporte ciudadano creado'
													: is_dashboard_resource(resource)
														? 'Tablero creado'
														: is_view_preset_resource(resource)
															? 'Configuración creada'
															: is_asociacion_resource(resource)
																? 'Asociación registrada correctamente'
																: is_incidencia_resource(resource)
																	? 'Incidencia registrada'
																	: is_registro_asistencia_resource(resource)
																		? 'Registro de asistencia creado'
																		: is_lista_asistencia_resource(resource)
																			? 'Fila de asistencia creada'
																			: 'Ruta creada';
		return json(
			resource,
			notice ? { ...ok([populated], message), user_pin_notice: notice } : ok([populated], message),
			201,
		);
	}
	if (method === 'PUT' && segs.length === 0) {
		assert_inventory_ledger_write(resource, 'update');
		const raw = await body();
		const id = String(raw._id ?? raw.id ?? '');
		if (!id) return json(resource, fail('Se necesita un id para actualizar').body, 400);
		if (resource === 'pos-session') {
			await assert_pos_pin(
				store,
				req,
				id,
				{ method: 'PUT', path: '/pos-session', label: 'Actualizar sesion POS' },
				actor,
			);
		}
		const previous = await store.find_id(resource, id);
		const scope = await record_rule_scope(store, actor, resource, method);
		await assert_id_in_scope(store, resource, id, scope, method);
		let b = await prepare_user_write(
			resource,
			await apply_uploads(store, resource, raw, actor, {
				method: 'PUT',
				record_id: id,
				previous,
			}),
			false,
		);
		if (resource === 'pedidos') {
			b = await prepare_pedido_update(store, b, actor, previous);
		}
		if (resource === 'delivery-package') {
			b = await prepare_delivery_package_update(store, b, previous);
		}
		if (resource === 'delivery-return') {
			b = await prepare_delivery_return_update(b, previous);
		}
		if (is_delivery_route_resource(resource)) {
			b = await prepare_delivery_route_write(store, b, previous);
		}
		if (resource === 'purchase-order') {
			b = await prepare_purchase_order_update(b, previous);
		}
		if (resource === 'pos-session') {
			b = await prepare_pos_session_update(store, b, previous, actor);
		}
		if (resource === 'products') {
			b = await prepare_product_write(store, b);
		}
		if (resource === 'vehicle') {
			b = await prepare_vehicle_write(store, b, previous);
		}
		if (is_location_resource(resource)) {
			b = await prepare_location_write(store, b, previous);
		}
		if (is_physical_count_resource(resource)) {
			b = await prepare_physical_count_update(store, b, previous);
		}
		const project_seed = b;
		if (is_project_resource(resource)) {
			b = prepare_project_write(b, actor, previous);
		}
		if (is_project_task_resource(resource)) {
			b = prepare_project_task_write({ ...previous, ...b }, actor);
		}
		if (is_personal_task_resource(resource)) {
			assert_personal_task_owner(previous, actor);
			b = prepare_personal_task_write(b, actor);
		}
		if (is_citizen_report_resource(resource)) {
			b = await prepare_citizen_report_write(store, b, false);
		}
		if (is_dashboard_resource(resource)) {
			const access = await dashboard_access(store, actor);
			if (!dashboard_can_manage(previous, access)) {
				throw new Error('Solo el dueño del tablero puede modificarlo');
			}
			b = prepare_dashboard_write(b, actor, access, false);
		}
		if (is_asociacion_resource(resource)) {
			b = prepare_asociacion_write(b, previous, false);
		}
		if (is_incidencia_resource(resource)) {
			b = prepare_incidencia_write(b, false);
		}
		if (is_registro_asistencia_resource(resource)) {
			if (!previous) throw new Error('No se encontró el registro de asistencia a actualizar');
			b = prepare_registro_asistencia_write({ ...previous, ...b }, actor, false);
		}
		if (is_lista_asistencia_resource(resource)) {
			if (!previous) throw new Error('No se encontró la fila de asistencia a actualizar');
			b = await prepare_lista_asistencia_write(store, { ...previous, ...b });
		}
		if (resource === 'reports') {
			await assert_report_template_write(store, { ...previous, ...b });
		}
		if (is_print_template_resource(resource)) {
			b = await prepare_print_template_write(store, { ...previous, ...b });
		}
		const updated = await store.update(resource, id, b);
		if (updated) await link_attachments_to_record(store, resource, updated);
		if (!updated) return json(resource, fail('No encontrado', 404).body, 404);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'update', updated, previous);
		if (resource === 'purchase-order') {
			await sync_inbound_supplier_invoice(store, updated);
			await ensure_pending_reception_from_purchase_order(store, updated);
		}
		if (is_project_resource(resource)) {
			await after_project_write(store, updated, project_seed, actor, previous);
		}
		if (resource === 'delivery-package') {
			await after_delivery_package_mutate(
				store,
				String(previous?.pedido ?? ''),
				String(updated.pedido ?? ''),
			);
		}
		await maybe_register_mentions(store, actor, resource, updated, previous);
		let shown = updated;
		if (is_project_resource(resource)) {
			shown = await hydrate_project(store, updated);
		}
		const [populated] = await finalize_rows(
			store,
			resource,
			await store.populate_docs(resource, [shown]),
			'detail',
		);
		return json(
			resource,
			ok(
				[populated],
				resource === 'pedidos'
					? 'Pedido actualizado'
					: resource === 'delivery-package'
						? 'Bulto actualizado correctamente'
						: resource === 'delivery-return'
							? 'Devolución actualizada correctamente'
							: resource === 'purchase-order'
								? 'Orden de compra actualizada correctamente'
								: resource === 'vehicle'
									? 'Vehículo actualizado correctamente'
									: is_location_resource(resource)
										? 'Ubicación actualizada correctamente'
									: is_physical_count_resource(resource)
										? 'Conteo actualizado correctamente'
										: is_project_resource(resource)
										? 'Proyecto actualizado correctamente'
										: is_project_task_resource(resource)
											? 'Tarea de proyecto actualizada correctamente'
											: is_personal_task_resource(resource)
												? 'Tarea personal actualizada correctamente'
												: is_incidencia_resource(resource)
													? 'Incidencia actualizada correctamente'
													: is_registro_asistencia_resource(resource)
														? 'Actualizado correctamente'
														: is_lista_asistencia_resource(resource)
															? 'Fila de asistencia actualizada correctamente'
															: 'Actualizado correctamente',
			),
		);
	}
	if (method === 'PATCH' && segs.length === 1) {
		assert_inventory_ledger_write(resource, 'update');
		const previous = await store.find_id(resource, segs[0]!);
		const scope = await record_rule_scope(store, actor, resource, method);
		await assert_id_in_scope(store, resource, segs[0]!, scope, method);
		let patched = await prepare_user_write(
			resource,
			await apply_uploads(store, resource, await body(), actor, {
				method: 'PATCH',
				record_id: segs[0],
				previous,
			}),
			false,
		);
		if (resource === 'pedidos') {
			patched = await prepare_pedido_update(store, patched, actor, previous);
		}
		if (resource === 'delivery-package') {
			patched = await prepare_delivery_package_update(store, patched, previous);
		}
		if (resource === 'delivery-return') {
			patched = await prepare_delivery_return_update(patched, previous);
		}
		if (is_delivery_route_resource(resource)) {
			patched = await prepare_delivery_route_write(store, patched, previous);
		}
		if (resource === 'purchase-order') {
			patched = await prepare_purchase_order_update(patched, previous);
		}
		if (resource === 'products') {
			patched = await prepare_product_write(store, patched);
		}
		if (resource === 'vehicle') {
			patched = await prepare_vehicle_write(store, patched, previous);
		}
		if (is_location_resource(resource)) {
			patched = await prepare_location_write(store, patched, previous);
		}
		if (is_physical_count_resource(resource)) {
			patched = await prepare_physical_count_update(store, patched, previous);
		}
		const project_seed = patched;
		if (is_project_resource(resource)) {
			patched = prepare_project_write({ ...previous, ...patched }, actor, previous);
		}
		if (is_project_task_resource(resource)) {
			patched = prepare_project_task_write({ ...previous, ...patched }, actor);
		}
		if (is_personal_task_resource(resource)) {
			assert_personal_task_owner(previous, actor);
			patched = prepare_personal_task_write(patched, actor);
		}
		if (is_citizen_report_resource(resource)) {
			patched = await prepare_citizen_report_write(store, patched, false);
		}
		if (is_dashboard_resource(resource)) {
			const access = await dashboard_access(store, actor);
			if (!dashboard_can_manage(previous, access)) {
				throw new Error('Solo el dueño del tablero puede modificarlo');
			}
			patched = prepare_dashboard_write(patched, actor, access, false);
		}
		if (is_asociacion_resource(resource)) {
			patched = prepare_asociacion_write(patched, previous, false);
		}
		if (is_incidencia_resource(resource)) {
			patched = prepare_incidencia_write(patched, false);
		}
		if (is_registro_asistencia_resource(resource)) {
			if (!previous) throw new Error('No se encontró el registro de asistencia a actualizar');
			patched = prepare_registro_asistencia_write({ ...previous, ...patched }, actor, false);
		}
		if (is_lista_asistencia_resource(resource)) {
			if (!previous) throw new Error('No se encontró la fila de asistencia a actualizar');
			patched = await prepare_lista_asistencia_write(store, { ...previous, ...patched });
		}
		if (resource === 'reports') {
			await assert_report_template_write(store, { ...previous, ...patched });
		}
		if (is_print_template_resource(resource)) {
			patched = await prepare_print_template_write(store, { ...previous, ...patched });
		}
		const updated = await store.update(resource, segs[0]!, patched);
		if (updated) await link_attachments_to_record(store, resource, updated);
		if (!updated) return json(resource, fail('No encontrado', 404).body, 404);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'update', updated, previous);
		if (resource === 'purchase-order') {
			await sync_inbound_supplier_invoice(store, updated);
			await ensure_pending_reception_from_purchase_order(store, updated);
		}
		if (is_project_resource(resource)) {
			await after_project_write(store, updated, project_seed, actor, previous);
		}
		if (resource === 'delivery-package') {
			await after_delivery_package_mutate(
				store,
				String(previous?.pedido ?? ''),
				String(updated.pedido ?? ''),
			);
		}
		await maybe_register_mentions(store, actor, resource, updated, previous);
		let shown = updated;
		if (is_project_resource(resource)) {
			shown = await hydrate_project(store, updated);
		}
		const [decorated] = await finalize_rows(
			store,
			resource,
			await store.populate_docs(resource, [shown]),
			'detail',
		);
		return json(
			resource,
			ok(
				[decorated],
				resource === 'pedidos'
					? 'Pedido actualizado'
					: resource === 'delivery-package'
						? 'Bulto actualizado correctamente'
						: resource === 'delivery-return'
							? 'Devolución actualizada correctamente'
							: resource === 'purchase-order'
								? 'Orden de compra actualizada correctamente'
								: resource === 'vehicle'
									? 'Vehículo actualizado correctamente'
									: is_location_resource(resource)
										? 'Ubicación actualizada correctamente'
									: is_physical_count_resource(resource)
										? 'Conteo actualizado correctamente'
										: is_project_resource(resource)
										? 'Proyecto actualizado correctamente'
										: is_project_task_resource(resource)
											? 'Tarea de proyecto actualizada correctamente'
											: is_personal_task_resource(resource)
												? 'Tarea personal actualizada correctamente'
												: is_incidencia_resource(resource)
													? 'Incidencia actualizada correctamente'
													: is_registro_asistencia_resource(resource)
														? 'Actualizado correctamente'
														: is_lista_asistencia_resource(resource)
															? 'Fila de asistencia actualizada correctamente'
															: 'Actualizado correctamente',
			),
		);
	}
	return null;
}

async function finalize_rows(
	store: ImperiumStore,
	resource: string,
	rows: ImperiumDoc[],
	mode: 'list' | 'detail',
): Promise<ImperiumDoc[]> {
	if (is_pedido_resource(resource) && mode === 'list') {
		return project_list_docs(
			resource,
			store.flatten_list_docs(resource, await enrich_pedidos_list(store, rows)),
		);
	}
	if (is_delivery_route_resource(resource)) {
		const decorated = await decorate_delivery_routes(store, rows, mode);
		const flat = store.flatten_list_docs(resource, decorated);
		return mode === 'list' ? project_list_docs(resource, flat) : flat;
	}
	if (resource === 'inventory-reception' && mode === 'list') {
		return project_list_docs(
			resource,
			store.flatten_list_docs(resource, decorate_inventory_reception_list(rows)),
		);
	}
	const decorated = decorate_rows(resource, rows);
	if (mode !== 'list') return decorated;
	return project_list_docs(resource, store.flatten_list_docs(resource, decorated));
}

function decorate_rows(resource: string, rows: ImperiumDoc[]): ImperiumDoc[] {
	if (is_pedido_resource(resource)) return rows.map((row) => decorate_pedido(row, 'detail'));
	if (resource === 'products') return rows.map(decorate_product);
	if (resource === 'vehicle') return rows.map(decorate_vehicle);
	if (resource === 'pos-tickets') return rows.map(decorate_pos_ticket);
	if (is_physical_count_resource(resource)) return rows.map(decorate_physical_count);
	return rows;
}

function decorate_pos_ticket(doc: ImperiumDoc): ImperiumDoc {
	const items = as_array(doc.items).map((raw) => {
		const item = as_object(raw);
		const product = as_object(item.item_id);
		const item_id = String(product._id ?? item.item_id ?? '');
		const item_name = String(item.item_name ?? product.name ?? '').trim();
		return { ...item, item_id, ...(item_name ? { item_name } : {}) };
	});
	return { ...doc, items };
}

function instance_type(
	store: ImperiumStore,
	resource: string,
	_rows: ImperiumDoc[],
): Record<string, { nombre_encabezado: string; tipo: string }> {
	const projected = list_instance_type(resource);
	if (projected) return projected;
	const keys = ['_id', 'name', 'description', 'is_active', '_ref'];
	for (const col of store.loc(resource).columns) {
		if (!keys.includes(col.name)) keys.push(col.name);
	}
	const out: Record<string, { nombre_encabezado: string; tipo: string }> = {};
	for (const k of keys) {
		out[k] = { nombre_encabezado: k.replace(/_/g, ' '), tipo: 'string' };
	}
	return out;
}

const USER_SECRET_KEYS = new Set([
	'password',
	'reset_password_token_hash',
	'reset_password_expires',
	'reset_password_kind',
]);
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1024;
const PASSWORD_TOO_SHORT_MESSAGE = `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`;
const PASSWORD_TOO_LONG_MESSAGE = `La contraseña no puede superar ${PASSWORD_MAX_LENGTH} caracteres`;

function is_user_resource(resource: string) {
	return resource === 'user' || resource === 'usuario';
}

function strip_user_secrets(doc: ImperiumDoc): ImperiumDoc {
	const out = { ...doc };
	for (const key of USER_SECRET_KEYS) delete out[key];
	return out;
}

function sanitize_payload(resource: string, body: unknown): unknown {
	if (!is_user_resource(resource) || !body || typeof body !== 'object') return body;
	const payload = body as Record<string, unknown>;
	if (!Array.isArray(payload.data)) return payload;
	return {
		...payload,
		data: payload.data.map((item) =>
			item && typeof item === 'object' ? strip_user_secrets(item as ImperiumDoc) : item,
		),
	};
}

async function prepare_user_write(
	resource: string,
	doc: ImperiumDoc,
	require_password: boolean,
): Promise<ImperiumDoc> {
	if (!is_user_resource(resource)) return doc;
	const out: ImperiumDoc = { ...doc };
	if (typeof out.email === 'string') out.email = out.email.trim().toLowerCase();
	if (out.password === undefined) {
		if (require_password) throw new Error(PASSWORD_TOO_SHORT_MESSAGE);
		return out;
	}
	const value = typeof out.password === 'string' ? out.password : '';
	if (!require_password && value.trim() === '') {
		delete out.password;
		return out;
	}
	if (value.length < PASSWORD_MIN_LENGTH) throw new Error(PASSWORD_TOO_SHORT_MESSAGE);
	if (value.length > PASSWORD_MAX_LENGTH) throw new Error(PASSWORD_TOO_LONG_MESSAGE);
	const argon2 = await import('argon2');
	out.password = await argon2.hash(value, {
		type: argon2.argon2id,
		memoryCost: 2 ** 16,
		timeCost: 3,
		parallelism: 1,
	});
	return out;
}

function json(resource: string, body: unknown, status = 200): Response {
	return Response.json(sanitize_payload(resource, body), { status });
}

function csv(v: unknown): string {
	if (v == null) return '';
	const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
	if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

async function maybe_register_mentions(
	store: ImperiumStore,
	actor: ImperiumDoc | null,
	resource: string,
	current: ImperiumDoc,
	previous?: ImperiumDoc | null,
) {
	if (resource === 'notifications' || resource === 'mentions') return;
	await register_document_mentions(store, actor, {
		current_document: current,
		previous_document: previous ?? undefined,
		resource,
		document_id: String(current._id ?? ''),
	});
}

async function before_create(
	store: ImperiumStore,
	resource: string,
	doc: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<ImperiumDoc> {
	return doc;
}

async function after_create(
	store: ImperiumStore,
	resource: string,
	created: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<unknown> {
	if (resource === 'pos-session') {
		return maybe_create_pos_session_pin(store, created, actor);
	}
	if (resource !== 'pos-tickets') return null;
	if (String(created.ticket_type ?? 'VENTA').toUpperCase() !== 'VENTA') return;
	const items = as_array(created.items).map(as_object);
	for (const item of items) {
		const pid = String(item.item_id ?? item.producto ?? item.product_id ?? '');
		const qty = Number(item.quantity ?? item.cantidad ?? 0);
		if (!pid || !qty || !store.has('products')) continue;
		const product = await store.find_id('products', pid);
		if (!product) continue;
		const next = Number(product.existencia ?? 0) - qty;
		await store.update('products', pid, { existencia: next < 0 ? 0 : next });
	}
}

