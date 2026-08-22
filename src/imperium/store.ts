/**
 * Almacén de documentos Imperium sobre los schemas SQL de los súbditos.
 * Un recurso canónico (products, pedidos) aunque el menú lo repita.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pg_schema_name } from '@opus-perpetuus/imperium-core-kit';
import {
	as_array,
	as_object,
	from_imperium,
	to_imperium,
	type ImperiumDoc,
} from './envelope.ts';

export type ExtraCol = { name: string; mongo?: string; pg?: string };

export type ModuleLoc = {
	slug: string;
	technical_id: string;
	resource: string;
	table: string;
	collection: string;
	name: string;
	columns: ExtraCol[];
};

export type SubjectInfo = {
	slug: string;
	name: string;
	path: string;
	menu_ref: string;
	modules: Array<{ resource: string; path: string; menu_ref: string; name: string }>;
};

export const PREFER_OWNER: Record<string, string> = {
	products: 'almacen',
	pedidos: 'ventas',
};

/** Bases Angular (`super('proyectos')`) vs resource del catálogo modular. */
export const RESOURCE_ALIASES: Record<string, string> = {
	proyectos: 'planeacion-proyectos',
	'mis-tareas': 'planeacion-mis-tareas',
	'proyectos-task': 'planeacion-proyectos-task',
};

type RefBook = {
	fields: Record<string, Record<string, string>>;
	models: Record<string, string>;
};

const REFS: RefBook = JSON.parse(
	readFileSync(join(import.meta.dir, 'refs.json'), 'utf8'),
) as RefBook;

const GENERAL = new Set([
	'id',
	'name',
	'description',
	'is_active',
	'state',
	'ref',
	'search_field',
	'created_by',
	'custom_data',
	'payload',
	'created_at',
	'updated_at',
]);

export function qident(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad ident ${name}`);
	return `"${name.replace(/"/g, '""')}"`;
}

export class ImperiumStore {
	readonly locs = new Map<string, ModuleLoc>();
	readonly all_locs: ModuleLoc[] = [];
	readonly subjects: SubjectInfo[] = [];

	constructor(
		private readonly sql: Bun.SQL,
		catalog_path: string,
	) {
		const catalog = JSON.parse(readFileSync(catalog_path, 'utf8')) as {
			subjects: Array<{
				slug: string;
				name?: string;
				path?: string;
				menu_ref?: string;
				technical_id: string;
				modules?: Array<{
					resource: string;
					table: string;
					collection: string;
					name: string;
					path?: string;
					menu_ref?: string;
					columns?: ExtraCol[];
				}>;
			}>;
		};
		for (const s of catalog.subjects) {
			this.subjects.push({
				slug: s.slug,
				name: s.name ?? s.slug,
				path: s.path ?? '',
				menu_ref: s.menu_ref ?? `${s.slug}-menu-root`,
				modules: (s.modules ?? []).map((m) => ({
					resource: m.resource,
					path: m.path ?? `/${m.resource}`,
					menu_ref: m.menu_ref ?? '',
					name: m.name,
				})),
			});
			for (const m of s.modules ?? []) {
				const loc: ModuleLoc = {
					slug: s.slug,
					technical_id: s.technical_id,
					resource: m.resource,
					table: m.table,
					collection: m.collection,
					name: m.name,
					columns: m.columns ?? [],
				};
				this.all_locs.push(loc);
				const prefer = PREFER_OWNER[m.resource];
				if (prefer && prefer !== s.slug && this.locs.has(m.resource)) continue;
				if (!this.locs.has(m.resource) || prefer === s.slug) {
					this.locs.set(m.resource, loc);
				}
			}
		}
		for (const [alias, resource] of Object.entries(RESOURCE_ALIASES)) {
			const loc = this.locs.get(resource);
			if (loc && !this.locs.has(alias)) this.locs.set(alias, loc);
		}
		const host =
			this.all_locs.find((l) => l.slug === 'configuracion') ?? this.all_locs[0];
		if (host) {
			const orphans = [
				'messages',
				'notifications',
				'mentions',
				'user-settings',
				'custom-user-themes',
				'documentation-page',
				'document-change-history',
				'interactive-manual',
				'cobranza-payment',
				'module-management-reference',
			];
			for (const resource of orphans) {
				if (this.locs.has(resource)) continue;
				const loc: ModuleLoc = {
					slug: host.slug,
					technical_id: host.technical_id,
					resource,
					table: resource.replace(/-/g, '_'),
					collection: resource,
					name: resource,
					columns: [],
				};
				this.all_locs.push(loc);
				this.locs.set(resource, loc);
			}
		}
	}

	async ensure_defaults(): Promise<void> {
		await this.ensure_orphan_tables();
		if (this.has('branchoffice')) {
			const { total } = await this.find_many('branchoffice', { take: 1, include_inactive: true });
			if (!total) {
				await this.insert('branchoffice', {
					name: 'Matriz',
					_ref: 'branchoffice-matriz-0',
					description: 'Sucursal predeterminada',
				});
			}
		}
		if (this.has('employee')) {
			const { total } = await this.find_many('employee', { take: 1, include_inactive: true });
			if (!total) {
				const employee = await this.insert('employee', {
					name: 'Administrador',
					_ref: 'employee-admin-0',
					description: 'Empleado predeterminado',
					is_active: true,
				});
				if (this.has('user') && employee?._id) {
					const admin =
						(await this.find_where('user', { _ref: 'user-menu-management-0' })) ??
						(await this.find_where('user', { email: 'admin@admin.com' }));
					if (admin?._id && !admin.employee) {
						await this.update('user', String(admin._id), {
							employee: employee._id,
						});
					}
				}
			}
		}
	}

	async ensure_orphan_tables(): Promise<void> {
		for (const resource of [
			'messages',
			'notifications',
			'mentions',
			'user-settings',
			'custom-user-themes',
			'documentation-page',
			'document-change-history',
			'interactive-manual',
			'cobranza-payment',
			'module-management-reference',
		]) {
			if (!this.locs.has(resource)) continue;
			const qt = this.qt(resource);
			await this.sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${qt} (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          is_active BOOLEAN DEFAULT true,
          state TEXT,
          ref TEXT,
          search_field TEXT,
          created_by TEXT,
          custom_data JSONB DEFAULT '{}'::jsonb,
          payload JSONB DEFAULT '{}'::jsonb,
          created_at TEXT,
          updated_at TEXT
        )
      `);
		}
	}

	has(resource: string): boolean {
		return this.locs.has(resource);
	}

	loc(resource: string): ModuleLoc {
		const hit = this.locs.get(resource);
		if (!hit) throw new Error(`Recurso desconocido: ${resource}`);
		return hit;
	}

	column_names(resource: string): Set<string> {
		const loc = this.loc(resource);
		return new Set([...GENERAL, ...loc.columns.map((c) => c.name)]);
	}

	json_cols(resource: string): Set<string> {
		const loc = this.loc(resource);
		const out = new Set(['custom_data', 'payload']);
		for (const c of loc.columns) if (c.pg === 'json') out.add(c.name);
		return out;
	}

	qt(resource: string): string {
		const loc = this.loc(resource);
		return `${qident(pg_schema_name(loc.technical_id))}.${qident(loc.table)}`;
	}

	flatten(row: Record<string, unknown> | null, resource?: string): ImperiumDoc | null {
		if (!row) return null;
		const parsed = { ...row };
		const jsons = resource
			? this.json_cols(resource)
			: new Set(['payload', 'custom_data']);
		for (const k of jsons) {
			if (!(k in parsed)) continue;
			parsed[k] = parse_json_cell(parsed[k]);
		}
		/* Columnas extra mal tipadas como text (p. ej. lista-de-precios.product)
		 * llegan como JSON serializado; el original las devolvía como arreglo. */
		if (resource) {
			for (const col of this.loc(resource).columns) {
				if (jsons.has(col.name)) continue;
				parsed[col.name] = parse_json_cell(parsed[col.name]);
			}
		}
		return to_imperium(parsed);
	}

		async find_many(
		resource: string,
		opts: {
			q?: string;
			skip?: number;
			take?: number;
			sort?: string;
			include_inactive?: boolean;
			where?: Record<string, unknown>;
			ids?: string[];
			populate?: boolean;
		} = {},
	): Promise<{ rows: ImperiumDoc[]; total: number }> {
		const loc = this.loc(resource);
		const qt = this.qt(resource);
		const cols = this.column_names(resource);
		const params: unknown[] = [];
		const clauses: string[] = [];
		if (!opts.include_inactive) clauses.push(`is_active IS DISTINCT FROM false`);
		if (opts.ids?.length) {
			const start = params.length + 1;
			params.push(...opts.ids);
			const marks = opts.ids.map((_, i) => `$${start + i}`).join(', ');
			clauses.push(`id IN (${marks})`);
		}
		if (opts.where) {
			for (const [raw_key, v] of Object.entries(opts.where)) {
				if (v === undefined) continue;
				const k = raw_key === '_ref' ? 'ref' : raw_key;
				if (v && typeof v === 'object' && !Array.isArray(v) && 'in' in v && Array.isArray((v as { in: unknown[] }).in)) {
					const values = (v as { in: unknown[] }).in.map(String);
					if (!values.length) continue;
					const marks = values.map((item) => {
						params.push(item);
						return `$${params.length}`;
					});
					if (cols.has(k)) clauses.push(`${qident(k)} IN (${marks.join(', ')})`);
					else clauses.push(`payload ->> ${literal(k)} IN (${marks.join(', ')})`);
					continue;
				}
				params.push(v);
				if (cols.has(k)) clauses.push(`${qident(k)} = $${params.length}`);
				else clauses.push(`payload ->> ${literal(k)} = $${params.length}::text`);
			}
		}
		if (opts.q) {
			const like = `%${opts.q}%`;
			const search_cols = ['name', 'description', 'ref', 'search_field'].filter((c) =>
				cols.has(c),
			);
			const parts = search_cols.map((c) => {
				params.push(like);
				return `${qident(c)} ILIKE $${params.length}`;
			});
			params.push(like);
			parts.push(`payload::text ILIKE $${params.length}`);
			clauses.push(`(${parts.join(' OR ')})`);
		}
		const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
		const count_rows = await this.sql.unsafe(
			`SELECT count(*)::int AS n FROM ${qt}${where}`,
			params,
		);
		const total = Number(count_rows[0]?.n ?? 0);
		let order = ' ORDER BY name ASC NULLS LAST, id ASC';
		if (opts.sort) {
			const m = opts.sort.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(?::(asc|desc))?$/i);
			const raw_campo = (m?.[1] ?? '').replace(/^_/, '');
			const aliases: Record<string, string> = {
				updatedAt: 'updated_at',
				createdAt: 'created_at',
				_id: 'id',
			};
			const campo = aliases[raw_campo] ?? raw_campo;
			const dir = (m?.[2] ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
			if (campo && cols.has(campo === 'ref' ? 'ref' : campo)) {
				const col = campo === '_ref' ? 'ref' : campo;
				order = ` ORDER BY ${qident(col)} ${dir} NULLS LAST`;
			}
		}
		const take = opts.take ?? 100;
		const skip = opts.skip ?? 0;
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${qt}${where}${order} LIMIT ${take} OFFSET ${skip}`,
			params,
		);
		const flattened = rows.map((r) => this.flatten(r as Record<string, unknown>, resource)!);
		const populated =
			opts.populate === false ? flattened : await this.populate_docs(resource, flattened);
		return {
			rows: populated,
			total,
		};
	}

	async find_id(resource: string, id: string): Promise<ImperiumDoc | null> {
		if (id.startsWith('ref----')) {
			return this.find_where(resource, { ref: id.slice(7) });
		}
		const rows = await this.sql.unsafe(
			`SELECT * FROM ${this.qt(resource)} WHERE id = $1 LIMIT 1`,
			[id],
		);
		return this.flatten((rows[0] as Record<string, unknown>) ?? null, resource);
	}

	async find_where(
		resource: string,
		where: Record<string, unknown>,
	): Promise<ImperiumDoc | null> {
		const { rows } = await this.find_many(resource, {
			where,
			take: 1,
			include_inactive: true,
			populate: false,
		});
		return rows[0] ?? null;
	}

	async insert(resource: string, doc: ImperiumDoc): Promise<ImperiumDoc> {
		const cols = this.column_names(resource);
		const jsons = this.json_cols(resource);
		const row = from_imperium(doc, cols);
		if (!row.id) row.id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
		const ts = new Date().toISOString();
		row.created_at ??= ts;
		row.updated_at ??= ts;
		if (row.is_active === undefined) row.is_active = true;
		const keys = Object.keys(row).filter((k) => cols.has(k));
		const values = keys.map((k) => cell(row[k], jsons.has(k)));
		const qt = this.qt(resource);
		const inserted = await this.sql.unsafe(
			`INSERT INTO ${qt} (${keys.map(qident).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
			values,
		);
		return this.flatten(inserted[0] as Record<string, unknown>, resource)!;
	}

	async update(
		resource: string,
		id: string,
		patch: ImperiumDoc,
	): Promise<ImperiumDoc | null> {
		const existing = await this.find_id(resource, id);
		if (!existing) return null;
		const cols = this.column_names(resource);
		const jsons = this.json_cols(resource);
		const merged: ImperiumDoc = {
			...existing,
			...patch,
			_id: id,
			payload: { ...as_object(existing), ...as_object(patch) },
		};
		const row = from_imperium(merged, cols);
		row.id = id;
		row.updated_at = new Date().toISOString();
		const keys = Object.keys(row).filter((k) => cols.has(k) && k !== 'id');
		const values = keys.map((k) => cell(row[k], jsons.has(k)));
		values.push(id);
		const set = keys.map((k, i) => `${qident(k)} = $${i + 1}`).join(', ');
		const updated = await this.sql.unsafe(
			`UPDATE ${this.qt(resource)} SET ${set} WHERE id = $${keys.length + 1} RETURNING *`,
			values,
		);
		return this.flatten((updated[0] as Record<string, unknown>) ?? null, resource);
	}

	async remove(resource: string, id: string): Promise<ImperiumDoc | null> {
		return this.update(resource, id, { is_active: false });
	}

	async populate_docs(resource: string, docs: ImperiumDoc[]): Promise<ImperiumDoc[]> {
		const field_map = REFS.fields[resource];
		if (!field_map || !docs.length) return docs;
		const needed = new Map<string, Set<string>>();
		for (const [field, model] of Object.entries(field_map)) {
			const target = this.resource_for_model(model);
			if (!target) continue;
			for (const doc of docs) {
				const id = ref_id(doc[field]);
				if (!id) continue;
				if (!needed.has(target)) needed.set(target, new Set());
				needed.get(target)!.add(id);
			}
		}
		const loaded = new Map<string, Map<string, ImperiumDoc>>();
		for (const [target, ids] of needed) {
			const { rows } = await this.find_many(target, {
				ids: [...ids],
				take: ids.size,
				include_inactive: true,
				populate: false,
			});
			loaded.set(target, new Map(rows.map((r) => [String(r._id), r])));
		}
		return docs.map((doc) => {
			const out = { ...doc };
			for (const [field, model] of Object.entries(field_map)) {
				const target = this.resource_for_model(model);
				const id = ref_id(doc[field]);
				if (!id) continue;
				const hit = target ? loaded.get(target)?.get(id) : undefined;
				out[field] = hit
					? { _id: hit._id, name: hit.name ?? '', description: hit.description ?? '' }
					: { _id: id, name: '' };
			}
			return out;
		});
	}

	resource_for_model(model: string): string | null {
		const direct = REFS.models[model] ?? REFS.models[model.toLowerCase()];
		if (direct && this.has(direct)) return direct;
		const kebab = model.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
		if (this.has(kebab)) return kebab;
		if (this.has(`${kebab}s`)) return `${kebab}s`;
		if (this.has(model.toLowerCase())) return model.toLowerCase();
		if (model === 'Employee' && this.has('employee')) return 'employee';
		return null;
	}

	async distinct(resource: string, field: string, q = ''): Promise<unknown[]> {
		const cols = this.column_names(resource);
		const qt = this.qt(resource);
		if (cols.has(field)) {
			const params: unknown[] = [];
			let extra = '';
			if (q) {
				params.push(`%${q}%`);
				extra = ` WHERE ${qident(field)}::text ILIKE $1`;
			}
			const rows = await this.sql.unsafe(
				`SELECT DISTINCT ${qident(field)} AS v FROM ${qt}${extra} LIMIT 200`,
				params,
			);
			return rows.map((r) => (r as { v: unknown }).v).filter((v) => v != null);
		}
		const params: unknown[] = [];
		let extra = '';
		if (q) {
			params.push(`%${q}%`);
			extra = ` WHERE payload ->> ${literal(field)} ILIKE $1`;
		}
		const rows = await this.sql.unsafe(
			`SELECT DISTINCT payload ->> ${literal(field)} AS v FROM ${qt}${extra} LIMIT 200`,
			params,
		);
		return rows.map((r) => (r as { v: unknown }).v).filter((v) => v != null && v !== '');
	}

	async stats(resource: string, url?: URL): Promise<Record<string, unknown>> {
		if (resource === 'ticketing-system-turn') return this.turn_stats();
		if (resource === 'citizen-report') return this.citizen_report_stats(url);
		const qt = this.qt(resource);
		const rows = await this.sql.unsafe(
			`SELECT
        count(*)::int AS total_records,
        count(*) FILTER (WHERE is_active IS DISTINCT FROM false)::int AS active_records,
        count(*) FILTER (WHERE is_active = false)::int AS inactive_records
      FROM ${qt}`,
		);
		const r = (rows[0] ?? {}) as Record<string, number>;
		return {
			total_records: r.total_records ?? 0,
			active_records: r.active_records ?? 0,
			inactive_records: r.inactive_records ?? 0,
			last_updated: new Date(),
			kpis: {
				total_records: { label: 'Total', value: r.total_records ?? 0 },
				active_records: { label: 'Activos', value: r.active_records ?? 0 },
				inactive_records: { label: 'Inactivos', value: r.inactive_records ?? 0 },
			},
		};
	}

	async turn_stats(): Promise<Record<string, unknown>> {
		const { rows } = await this.find_many('ticketing-system-turn', {
			take: 5000,
			include_inactive: true,
		});
		const completed = rows.filter(
			(r) => String(r.status ?? r.state ?? '') === 'completado',
		);
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const by_day = new Map<string, ImperiumDoc[]>();
		for (const r of completed) {
			const k = day_of(r);
			if (!k) continue;
			const list = by_day.get(k) ?? [];
			list.push(r);
			by_day.set(k, list);
		}
		const today_key = new Date().toISOString().slice(0, 10);
		let ref_key = today_key;
		if (!(by_day.get(today_key)?.length)) {
			let best = '';
			let n = 0;
			for (const [k, list] of by_day) {
				if (list.length > n) {
					n = list.length;
					best = k;
				}
			}
			if (best) ref_key = best;
		}
		const today_rows = by_day.get(ref_key) ?? [];
		const box_label = (r: ImperiumDoc) => {
			const b = as_object(r.assigned_box);
			return String(b.name ?? 'Sin nombre');
		};
		const box_ref = (r: ImperiumDoc) => {
			const b = as_object(r.assigned_box);
			return b._id ? b : { _id: ref_id(r.assigned_box), name: box_label(r) };
		};
		const daily_map = new Map<
			string,
			{ box_id: unknown; box_name: string; turns_attended: number }
		>();
		for (const r of today_rows) {
			const id = ref_id(r.assigned_box) || 'none';
			const cur = daily_map.get(id) ?? {
				box_id: box_ref(r),
				box_name: box_label(r),
				turns_attended: 0,
			};
			cur.turns_attended += 1;
			daily_map.set(id, cur);
		}
		const daily_stats = [...daily_map.values()];
		const ref_date = new Date(`${ref_key}T00:00:00.000Z`);
		const seven_keys: string[] = [];
		for (let i = 6; i >= 0; i--) {
			const d = new Date(ref_date);
			d.setUTCDate(d.getUTCDate() - i);
			seven_keys.push(d.toISOString().slice(0, 10));
		}
		const box_ids = new Set<string>();
		for (const k of seven_keys) {
			for (const r of by_day.get(k) ?? []) box_ids.add(ref_id(r.assigned_box) || 'none');
		}
		const seven_days_stats = [...box_ids].map((id) => {
			const sample =
				seven_keys.flatMap((k) => by_day.get(k) ?? []).find(
					(r) => (ref_id(r.assigned_box) || 'none') === id,
				) ?? today_rows[0];
			const daily = seven_keys.map((k) => {
				const day_rows = (by_day.get(k) ?? []).filter(
					(r) => (ref_id(r.assigned_box) || 'none') === id,
				);
				const mins = day_rows.map(turn_duration_minutes).filter((n) => n > 0);
				return {
					day: k,
					total_turns: day_rows.length,
					avg_time_minutes: mins.length
						? Number((mins.reduce((a, b) => a + b, 0) / mins.length).toFixed(2))
						: 0,
				};
			});
			return {
				box_id: sample ? box_ref(sample) : { _id: id, name: 'Sin nombre' },
				box_name: sample ? box_label(sample) : 'Sin nombre',
				daily_stats: daily,
			};
		});
		const average_times = seven_days_stats.map((box) => {
			const mins = box.daily_stats
				.map((d) => Number(d.avg_time_minutes))
				.filter((n) => n > 0);
			return {
				box_id: box.box_id,
				box_name: box.box_name,
				average_time_minutes: mins.length
					? Number((mins.reduce((a, b) => a + b, 0) / mins.length).toFixed(2))
					: 0,
			};
		});
		const service_map = new Map<
			string,
			{ service_type_name: string; turn_count: number; minutes: number[] }
		>();
		for (const r of today_rows) {
			const services = as_array(r.services);
			const name = String(
				as_object(services[0]).name ?? r.service_type ?? 'Sin servicio',
			);
			const cur = service_map.get(name) ?? {
				service_type_name: name,
				turn_count: 0,
				minutes: [],
			};
			cur.turn_count += 1;
			const m = turn_duration_minutes(r);
			if (m > 0) cur.minutes.push(m);
			service_map.set(name, cur);
		}
		const services_stats = [...service_map.values()].map((s) => ({
			service_type_name: s.service_type_name,
			turn_count: s.turn_count,
			average_time_minutes: s.minutes.length
				? Number((s.minutes.reduce((a, b) => a + b, 0) / s.minutes.length).toFixed(2))
				: 0,
		}));
		const ctype_map = new Map<
			string,
			{ customer_type_name: string; customer_type_id: unknown; turn_count: number; minutes: number[] }
		>();
		for (const r of today_rows) {
			const c = as_object(r.customer_type);
			const name = String(c.name ?? 'Sin tipo');
			const cur = ctype_map.get(name) ?? {
				customer_type_name: name,
				customer_type_id: c._id ? c : { _id: ref_id(r.customer_type), name },
				turn_count: 0,
				minutes: [],
			};
			cur.turn_count += 1;
			const m = turn_duration_minutes(r);
			if (m > 0) cur.minutes.push(m);
			ctype_map.set(name, cur);
		}
		const customer_types_stats = [...ctype_map.values()].map((s) => ({
			customer_type_name: s.customer_type_name,
			customer_type_id: s.customer_type_id,
			turn_count: s.turn_count,
			average_time_minutes: s.minutes.length
				? Number((s.minutes.reduce((a, b) => a + b, 0) / s.minutes.length).toFixed(2))
				: 0,
		}));
		return {
			daily_stats,
			average_times,
			raw_turns_today: today_rows,
			total_turns_today: today_rows.length,
			seven_days_stats,
			services_stats,
			customer_types_stats,
			__export_data: {},
		};
	}

	async citizen_report_stats(url?: URL): Promise<Record<string, unknown>> {
		const { rows } = await this.find_many('citizen-report', {
			take: 5000,
			include_inactive: false,
		});
		const date_from = url?.searchParams.get('date_from');
		const date_to = url?.searchParams.get('date_to');
		const priorities = [
			...(url?.searchParams.getAll('priorities[]') ?? []),
			...(url?.searchParams.getAll('priorities') ?? []),
		].filter(Boolean);
		const statuses = [
			...(url?.searchParams.getAll('statuses[]') ?? []),
			...(url?.searchParams.getAll('statuses') ?? []),
		].filter(Boolean);
		const from_ms = date_from ? new Date(date_from).getTime() : NaN;
		const to_ms = date_to ? new Date(date_to).getTime() : Date.now();
		const filtered = rows.filter((r) => {
			if (Number.isFinite(from_ms)) {
				const created = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
				if (!Number.isFinite(created) || created < from_ms || created > to_ms) {
					return false;
				}
			}
			if (priorities.length && !priorities.includes(String(r.priority ?? ''))) {
				return false;
			}
			if (statuses.length && !statuses.includes(String(r.status ?? ''))) {
				return false;
			}
			return true;
		});
		const status_of = (r: ImperiumDoc) => String(r.status ?? '').toLowerCase();
		const priority_of = (r: ImperiumDoc) => String(r.priority ?? '').toUpperCase();
		const pending = filtered.filter((r) => {
			const st = status_of(r);
			if (st === 'pendiente' || st === 'en_proceso') return true;
			if (!st && ['MEDIA', 'ALTA', 'URGENTE', 'CRITICA'].includes(priority_of(r))) {
				return true;
			}
			return false;
		});
		const urgent = filtered.filter((r) =>
			['URGENTE', 'CRITICA'].includes(priority_of(r)),
		);
		const resolved = filtered.filter((r) => {
			const st = status_of(r);
			if (st === 'terminado') return true;
			if (!st && priority_of(r) === 'BAJA') return true;
			return false;
		});
		const group = (key: (r: ImperiumDoc) => string) => {
			const map = new Map<string, number>();
			for (const r of filtered) {
				const name = key(r) || 'Sin valor';
				map.set(name, (map.get(name) ?? 0) + 1);
			}
			return [...map.entries()]
				.map(([name, value]) => ({ name, value }))
				.sort((a, b) => b.value - a.value);
		};
		const ref_name = (v: unknown, fallback: string) => {
			const o = as_object(v);
			return String(o.name ?? (typeof v === 'string' && v ? v : fallback));
		};
		const day_of = (r: ImperiumDoc) => {
			const d = new Date(String(r.createdAt ?? r.created_at ?? ''));
			return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
		};
		const month_of = (r: ImperiumDoc) => day_of(r).slice(0, 7);
		const recent_cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const recent = filtered.filter((r) => {
			const t = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
			return Number.isFinite(t) && t >= recent_cut;
		});
		const closed = filtered.filter((r) => status_of(r) === 'terminado');
		const resolution = new Map<string, { sum: number; n: number }>();
		for (const r of closed) {
			const a = new Date(String(r.createdAt ?? r.created_at ?? '')).getTime();
			const b = new Date(String(r.updatedAt ?? r.updated_at ?? '')).getTime();
			if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
			const days = (b - a) / (1000 * 60 * 60 * 24);
			const p = priority_of(r) || 'SIN_PRIORIDAD';
			const cur = resolution.get(p) ?? { sum: 0, n: 0 };
			cur.sum += days;
			cur.n += 1;
			resolution.set(p, cur);
		}
		const avg_resolution_time = [...resolution.entries()]
			.map(([name, v]) => ({ name, value: Number((v.sum / v.n).toFixed(1)) }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const phones = new Map<string, number>();
		for (const r of filtered) {
			const phone = String(r.citizen_phone ?? '').trim();
			if (!phone) continue;
			phones.set(phone, (phones.get(phone) ?? 0) + 1);
		}
		const citizen_recurrence = [...phones.entries()]
			.filter(([, n]) => n > 1)
			.map(([name, value]) => ({ name, value }))
			.sort((a, b) => b.value - a.value)
			.slice(0, 10);
		const coord = (r: ImperiumDoc) => {
			const c = as_object(r.report_coordinates);
			const lat = Number(c.latitude ?? c.lat);
			const lon = Number(c.longitude ?? c.lng ?? c.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
			return `${lat.toFixed(2)},${lon.toFixed(2)}`;
		};
		const export_sheet = (title: string, chart_type: string) => ({
			records: filtered,
			metadata: {
				title,
				unit: 'Quejas',
				total_records: filtered.length,
				chart_type,
			},
			lookups: {},
		});
		return {
			kpis: {
				total_complaints: filtered.length,
				pending_complaints: pending.length,
				urgent_complaints: urgent.length,
				resolved_complaints: resolved.length,
			},
			charts: {
				priority_distribution: { data: group((r) => String(r.priority ?? 'SIN_PRIORIDAD')) },
				status_distribution: { data: group((r) => String(r.status ?? 'SIN_ESTATUS')) },
				employee_workload: {
					data: group((r) => ref_name(r.employee_taken_the_report, 'Sin asignar')),
				},
				department_distribution: {
					data: group((r) => ref_name(r.department, 'Sin departamento')),
				},
				recent_activity: { data: group(day_of).filter((x) => x.name && recent.some((r) => day_of(r) === x.name)) },
				reporting_medium_distribution: {
					data: group((r) => ref_name(r.reporting_medium, 'Sin medio')),
				},
				problem_distribution: {
					data: group((r) => ref_name(r.citizen_report_problem, 'Sin problema')),
				},
				monthly_trend: { data: group(month_of).filter((x) => x.name) },
				geographic_distribution: {
					data: group((r) => ref_name(r.borough, coord(r) || 'Sin ubicación')),
				},
				avg_resolution_time: { data: avg_resolution_time },
				citizen_recurrence: { data: citizen_recurrence },
			},
			__export_data: {
				priority_distribution: export_sheet('Distribución por Prioridad', 'pie'),
				status_distribution: export_sheet('Distribución por Estatus', 'pie'),
				employee_workload: export_sheet('Carga de Trabajo por Empleado', 'bar'),
				department_distribution: export_sheet('Distribución por Departamento', 'pie'),
				recent_activity: export_sheet('Actividad Reciente (7 días)', 'line'),
			},
		};
	}
}

function parse_json_cell(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function turn_duration_minutes(row: ImperiumDoc): number {
	let raw: unknown = row.time_box;
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return 0;
		}
	}
	if (!Array.isArray(raw) || raw.length < 2) return 0;
	const a = new Date(String(raw[0])).getTime();
	const b = new Date(String(raw[1])).getTime();
	if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
	return (b - a) / 60000;
}

function ref_id(value: unknown): string {
	if (value == null || value === '') return '';
	if (typeof value === 'string') {
		const s = value.trim();
		if (s.startsWith('{') || (s.startsWith('"') && s.endsWith('"'))) {
			try {
				return ref_id(JSON.parse(s));
			} catch {
				return s.replace(/^"+|"+$/g, '');
			}
		}
		return s;
	}
	if (typeof value === 'object' && !Array.isArray(value)) {
		const o = value as Record<string, unknown>;
		const id = o._id ?? o.id;
		if (id == null || id === '') return '';
		return String(id).trim();
	}
	return String(value).trim();
}

function cell(v: unknown, json: boolean): unknown {
	if (v == null) return null;
	if (json) return typeof v === 'string' ? v : JSON.stringify(v);
	if (Array.isArray(v) || (typeof v === 'object' && !(v instanceof Date))) {
		return JSON.stringify(v);
	}
	return v;
}

function literal(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

export function load_catalog_path(): string {
	return (
		process.env.CATALOG_PATH ??
		join(import.meta.dir, '../../catalog.json')
	);
}
