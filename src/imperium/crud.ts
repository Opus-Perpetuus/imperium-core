/**
 * CRUD Imperium: mismas rutas que `crud_routes()` del backend Express.
 */
import { fail, ok, type ImperiumDoc } from './envelope.ts';
import { query_list, read_imperium_body } from './body.ts';
import type { ImperiumStore } from './store.ts';

export async function handle_crud(
	store: ImperiumStore,
	req: Request,
	url: URL,
	resource: string,
	rest: string,
): Promise<Response | null> {
	const method = req.method.toUpperCase();
	const segs = rest.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	const body = async () => read_imperium_body(req);

	if (method === 'GET' && segs[0] === 'statistics' && segs.length === 1) {
		return json(ok([await store.stats(resource)], 'Estadísticas obtenidas correctamente'));
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
		return json(ok([doc], 'Ruta encontrada'));
	}
	if (method === 'POST' && segs.length === 0) {
		const created = await store.insert(resource, await body());
		return json(ok([created], 'Ruta creada'), 201);
	}
	if (method === 'PUT' && segs.length === 0) {
		const b = await body();
		const id = String(b._id ?? b.id ?? '');
		if (!id) return json(fail('Se necesita un id para actualizar').body, 400);
		const updated = await store.update(resource, id, b);
		if (!updated) return json(fail('No encontrado', 404).body, 404);
		return json({
			data: null,
			total_elementos: 1,
			message: 'Actualizado correctamente',
		});
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
	rows: ImperiumDoc[],
): Record<string, { nombre_encabezado: string; tipo: string }> {
	const keys = new Set<string>(['_id', 'name', 'description', 'is_active', '_ref']);
	for (const col of store.loc(resource).columns) keys.add(col.name);
	for (const row of rows.slice(0, 5)) {
		for (const k of Object.keys(row)) {
			if (k === 'payload' || k === 'custom_data' || k === 'id') continue;
			keys.add(k);
		}
	}
	const out: Record<string, { nombre_encabezado: string; tipo: string }> = {};
	for (const k of keys) {
		out[k] = { nombre_encabezado: k.replace(/_/g, ' '), tipo: 'String' };
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
