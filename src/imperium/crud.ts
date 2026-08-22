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
		const { rows } = await store.find_many(resource, {
			q,
			take: 5000,
			include_inactive,
			where: Object.keys(where).length ? where : undefined,
			ids,
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
		const { rows, total } = await store.find_many(resource, {
			...q,
			where: Object.keys(q.where).length ? q.where : undefined,
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
		const [populated] = await store.populate_docs(resource, [doc]);
		return json(resource, ok([populated], 'Ruta encontrada'));
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
		if (resource === 'pos-tickets') {
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
		const [populated] = await store.populate_docs(resource, [created]);
		const message =
			resource === 'pos-tickets'
				? 'Ticket creado'
				: resource === 'pedidos'
					? 'Pedido creado'
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
		const updated = await store.update(resource, id, b);
		if (updated) await link_attachments_to_record(store, resource, updated);
		if (!updated) return json(resource, fail('No encontrado', 404).body, 404);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'update', updated, previous);
		await maybe_register_mentions(store, actor, resource, updated, previous);
		const [populated] = await store.populate_docs(resource, [updated]);
		return json(
			resource,
			ok([populated], resource === 'pedidos' ? 'Pedido actualizado' : 'Actualizado correctamente'),
		);
	}
	if (method === 'PATCH' && segs.length === 1) {
		const previous = await store.find_id(resource, segs[0]!);
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
		const updated = await store.update(resource, segs[0]!, patched);
		if (updated) await link_attachments_to_record(store, resource, updated);
		if (!updated) return json(resource, fail('No encontrado', 404).body, 404);
		if (resource === 'pedidos') await after_pedido_mutate(store, 'update', updated, previous);
		await maybe_register_mentions(store, actor, resource, updated, previous);
		return json(
			resource,
			ok([updated], resource === 'pedidos' ? 'Pedido actualizado' : 'Actualizado correctamente'),
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

function actor_id(actor: ImperiumDoc | null): string {
	return String(actor?._id ?? actor?.id ?? '').trim();
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
	if (resource === 'pos-session') {
		const uid = actor_id(actor);
		const opening = doc.opening_date ?? new Date().toISOString();
		const history = as_array(doc.usage_history);
		if (uid && !history.some((h) => !as_object(h).ended_at)) {
			history.push({
				started_at: opening,
				used_by_user: uid,
				cashier: doc.cashier ?? null,
				cashier_name: doc.cashier_name ?? '',
			});
		}
		return {
			...doc,
			status: doc.status ?? 'abierta',
			state: doc.state ?? 'abierta',
			on_use: doc.on_use !== false,
			opening_date: opening,
			created_by: doc.created_by ?? uid,
			usage_history: history,
			name: doc.name || `Sesión ${new Date().toISOString().slice(0, 16)}`,
		};
	}
	if (resource === 'pos-tickets') {
		await assert_pos_session_for_ticket(store, doc, actor);
		const ticket_type = String(doc.ticket_type ?? 'VENTA').trim().toUpperCase() || 'VENTA';
		return {
			...doc,
			ticket_type,
			state: doc.state ?? 'CONFIRMADO',
			name: doc.name || `Ticket ${doc.ticket_sequence ?? ''}`.trim(),
		};
	}
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

async function assert_pos_session_for_ticket(
	store: ImperiumStore,
	doc: ImperiumDoc,
	actor: ImperiumDoc | null,
): Promise<void> {
	const session_id = String(doc.pos_session ?? '').trim();
	if (!session_id) {
		throw new Error('Se requiere el id de la sesión POS para generar el ticket');
	}
	const current_user_id = actor_id(actor);
	if (!current_user_id) {
		throw new Error('No se pudo validar el usuario que intenta generar el ticket');
	}
	const session = await store.find_id('pos-session', session_id);
	if (!session) throw new Error('La sesión POS especificada no existe');
	if (session.is_active === false) {
		throw new Error('No se puede generar el ticket porque la sesión POS está inactiva');
	}
	const status = String(session.status ?? session.state ?? '').toLowerCase();
	if (status && !['abierta', 'open', 'abierta'].includes(status)) {
		throw new Error('No se puede generar el ticket porque la sesión POS no está abierta');
	}
	if (session.on_use === false) {
		throw new Error('No se puede generar el ticket porque la sesión POS no está en uso');
	}
	const history = as_array(session.usage_history).map(as_object);
	const active = [...history].reverse().find((e) => !e.ended_at);
	const usage_user = String(active?.used_by_user ?? '').trim();
	const created_by = String(session.created_by ?? '').trim();
	if (created_by && created_by !== current_user_id && usage_user && usage_user !== current_user_id) {
		throw new Error(
			'No se puede generar el ticket porque la sesión POS no pertenece al usuario actual',
		);
	}
}
