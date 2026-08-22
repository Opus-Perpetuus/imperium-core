/**
 * CRUD Imperium: mismas rutas que `crud_routes()` del backend Express.
 */
import { as_array, as_object, fail, ok, type ImperiumDoc } from './envelope.ts';
import { query_list, read_imperium_body } from './body.ts';
import type { ImperiumStore } from './store.ts';

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
		const stats = await store.stats(resource);
		return json(
			ok([stats], resource === 'ticketing-system-turn'
				? 'Estadísticas obtenidas con información completa'
				: 'Estadísticas obtenidas correctamente'),
		);
	}
	if (method === 'GET' && segs[0] === 'field-values' && segs[1]) {
		const { q } = query_list(url);
		const values = await store.distinct(resource, decodeURIComponent(segs[1]), q);
		return json(
			ok(
				values.map((v) => ({ value: v, label: String(v) })),
				'Valores de campo',
			),
		);
	}
	if (method === 'GET' && segs[0] === 'export.csv' && segs.length === 1) {
		const { q, include_inactive } = query_list(url);
		const { rows } = await store.find_many(resource, {
			q,
			take: 5000,
			include_inactive,
		});
		const keys = new Set<string>();
		for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
		const cols = [...keys].filter((k) => k !== 'payload').slice(0, 40);
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
		return json(ok(rows, 'Consulta masiva', total));
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
					const updated = await store.update(resource, String(existing._id), doc);
					if (updated) out.push(updated);
					continue;
				}
			}
			out.push(await store.insert(resource, doc));
		}
		return json(ok(out, 'Lote aplicado', out.length));
	}
	if (method === 'GET' && segs.length === 3 && segs[1] === 'array') {
		const doc = await store.find_id(resource, segs[0]!);
		if (!doc) return json(fail('No encontrado', 404).body, 404);
		const field = decodeURIComponent(segs[2]!);
		const arr = Array.isArray(doc[field]) ? doc[field] : [];
		return json(ok(arr as ImperiumDoc[], 'Campo arreglo'));
	}
	if (method === 'DELETE' && segs[0] === 'id' && segs[1] && segs.length === 2) {
		const deleted = await store.remove(resource, segs[1]);
		if (!deleted) return json(fail('No encontrado', 404).body, 404);
		return json(ok([deleted], 'Eliminado correctamente'));
	}
	if (method === 'GET' && segs.length === 0) {
		const q = query_list(url);
		const { rows, total } = await store.find_many(resource, q);
		return json({
			...ok(rows, 'Ruta encontrada', total),
			tipo_de_instancia: instance_type(store, resource, rows),
			module_info: { name: resource, model: resource, model_id: resource },
		});
	}
	if (method === 'GET' && segs.length === 1) {
		const doc = await store.find_id(resource, segs[0]!);
		if (!doc) return json(fail('No encontrado', 404).body, 404);
		const [populated] = await store.populate_docs(resource, [doc]);
		return json(ok([populated], 'Ruta encontrada'));
	}
	if (method === 'POST' && segs.length === 0) {
		const doc = await before_create(store, resource, await body(), actor);
		const created = await store.insert(resource, doc);
		await after_create(store, resource, created);
		const [populated] = await store.populate_docs(resource, [created]);
		const message = resource === 'pos-tickets' ? 'Ticket creado' : 'Ruta creada';
		return json(ok([populated], message), 201);
	}
	if (method === 'PUT' && segs.length === 0) {
		const b = await body();
		const id = String(b._id ?? b.id ?? '');
		if (!id) return json(fail('Se necesita un id para actualizar').body, 400);
		const updated = await store.update(resource, id, b);
		if (!updated) return json(fail('No encontrado', 404).body, 404);
		const [populated] = await store.populate_docs(resource, [updated]);
		return json(ok([populated], 'Actualizado correctamente'));
	}
	if (method === 'PATCH' && segs.length === 1) {
		const updated = await store.update(resource, segs[0]!, await body());
		if (!updated) return json(fail('No encontrado', 404).body, 404);
		return json(ok([updated], 'Actualizado correctamente'));
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

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
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
): Promise<void> {
	if (resource !== 'pos-tickets') return;
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
