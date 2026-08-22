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
	prepare_purchase_order_create,
	prepare_purchase_order_update,
} from './purchase-order-flow.ts';
import { sync_inbound_supplier_invoice } from './cfdi-from-purchase.ts';
import {
	notify_ticketing_rooms,
	prepare_ticketing_turn_create,
} from './ticketing-turn-flow.ts';
import {
	prepare_pos_session_create,
	prepare_pos_session_update,
	prepare_pos_ticket_create,
} from './pos-session-flow.ts';
import { build_access } from './auth.ts';
import { is_seed_admin } from './group-access.ts';
import {
	RecordRuleDeniedError,
	build_record_denied_message,
	build_record_rule_match,
	context_from_actor,
	operation_flag,
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
	if (access.has_full_access) return { match: null, applicable_rules: [] };
	const rules =
		access.record_rules_by_model?.[resource] ??
		access.record_rules_by_model?.[
			resource
				.split('-')
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join('')
		];
	const group_ids = [
		...((access.user_group_ids as string[]) ?? []),
		...((access.user_group_refs as string[]) ?? []),
	];
	return build_record_rule_match(rules, operation_flag(method), context_from_actor(actor, group_ids));
}

async function assert_id_in_scope(
	store: ImperiumStore,
	resource: string,
	id: string,
	scope: RecordRuleMatchResult,
	method: string,
) {
	if (!scope.match) return;
	const { total } = await store.find_many(resource, {
		ids: [id],
		take: 1,
		include_inactive: true,
		populate: false,
		mongo_match: scope.match,
	});
	if (!total) {
		throw new RecordRuleDeniedError(build_record_denied_message(method, resource, scope.applicable_rules));
	}
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

	if (method === 'GET' && segs[0] === 'statistics' && segs.length === 1) {
		const stats = await store.stats(resource, url);
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
		const keys = new Set<string>();
		for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
		const cols = [...keys]
			.filter((k) => k !== 'payload' && !USER_SECRET_KEYS.has(k))
			.slice(0, 40);
		const lines = [
			cols.join(','),
			...rows.map((r) =>
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
		return json(resource, ok(rows, 'Consulta masiva', total));
	}
	if (method === 'PUT' && segs[0] === 'batch' && segs.length === 1) {
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
		if (resource === 'delivery-package') {
			throw new Error('No se eliminan bultos. Usa «Anular bulto» para liberar el empaque.');
		}
		if (resource === 'delivery-return') {
			throw new Error('Las devoluciones no se pueden eliminar manualmente');
		}
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
		const scope = await record_rule_scope(store, actor, resource, method);
		const { rows, total } = await store.find_many(resource, {
			...q,
			where: Object.keys(q.where).length ? q.where : undefined,
			mongo_match: scope.match,
		});
		return json(resource, {
			...ok(rows, 'Ruta encontrada', total),
			tipo_de_instancia: instance_type(store, resource, rows),
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
		const scope = await record_rule_scope(store, actor, resource, method);
		await assert_id_in_scope(store, resource, segs[0]!, scope, method);
		const [populated] = await store.populate_docs(resource, [doc]);
		return json(
			resource,
			ok(
				[populated],
				resource === 'delivery-package'
					? 'Bulto encontrado'
					: resource === 'delivery-return'
						? 'Devolución encontrada'
						: 'Ruta encontrada',
			),
		);
	}
	if (method === 'POST' && segs.length === 0) {
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
		const doc = await before_create(store, resource, incoming, actor);
		const created = await store.insert(resource, doc);
		await link_attachments_to_record(store, resource, created);
		await maybe_register_mentions(store, actor, resource, created);
		const notice = await after_create(store, resource, created, actor);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'create', created);
		if (resource === 'ticketing-system-turn') await notify_ticketing_rooms(store);
		if (resource === 'purchase-order') await sync_inbound_supplier_invoice(store, created);
		let result = created;
		if (resource === 'delivery-package') {
			await after_delivery_package_mutate(store, String(created.pedido ?? ''));
			result = (await store.find_id(resource, String(created._id))) ?? created;
		}
		const [populated] = await store.populate_docs(resource, [result]);
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
								: 'Ruta creada';
		return json(
			resource,
			notice ? { ...ok([populated], message), user_pin_notice: notice } : ok([populated], message),
			201,
		);
	}
	if (method === 'PUT' && segs.length === 0) {
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
		if (resource === 'purchase-order') {
			b = await prepare_purchase_order_update(b, previous);
		}
		if (resource === 'pos-session') {
			b = await prepare_pos_session_update(store, b, previous, actor);
		}
		const updated = await store.update(resource, id, b);
		if (updated) await link_attachments_to_record(store, resource, updated);
		if (!updated) return json(resource, fail('No encontrado', 404).body, 404);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'update', updated, previous);
		if (resource === 'purchase-order') await sync_inbound_supplier_invoice(store, updated);
		if (resource === 'delivery-package') {
			await after_delivery_package_mutate(
				store,
				String(previous?.pedido ?? ''),
				String(updated.pedido ?? ''),
			);
		}
		await maybe_register_mentions(store, actor, resource, updated, previous);
		const [populated] = await store.populate_docs(resource, [updated]);
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
								: 'Actualizado correctamente',
			),
		);
	}
	if (method === 'PATCH' && segs.length === 1) {
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
		if (resource === 'purchase-order') {
			patched = await prepare_purchase_order_update(patched, previous);
		}
		const updated = await store.update(resource, segs[0]!, patched);
		if (updated) await link_attachments_to_record(store, resource, updated);
		if (!updated) return json(resource, fail('No encontrado', 404).body, 404);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'update', updated, previous);
		if (resource === 'purchase-order') await sync_inbound_supplier_invoice(store, updated);
		if (resource === 'delivery-package') {
			await after_delivery_package_mutate(
				store,
				String(previous?.pedido ?? ''),
				String(updated.pedido ?? ''),
			);
		}
		await maybe_register_mentions(store, actor, resource, updated, previous);
		return json(
			resource,
			ok(
				[updated],
				resource === 'pedidos'
					? 'Pedido actualizado'
					: resource === 'delivery-package'
						? 'Bulto actualizado correctamente'
						: resource === 'delivery-return'
							? 'Devolución actualizada correctamente'
							: resource === 'purchase-order'
								? 'Orden de compra actualizada correctamente'
								: 'Actualizado correctamente',
			),
		);
	}
	return null;
}

function instance_type(
	store: ImperiumStore,
	resource: string,
	_rows: ImperiumDoc[],
): Record<string, { nombre_encabezado: string; tipo: string }> {
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

