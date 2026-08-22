/**
 * Almacén de documentos Imperium sobre los schemas SQL de los súbditos.
 * Un recurso canónico (products, pedidos) aunque el menú lo repita.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pg_schema_name } from '@opus-perpetuus/imperium-core-kit';
import {
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

const PREFER_OWNER: Record<string, string> = {
	products: 'almacen',
	pedidos: 'ventas',
};

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

	constructor(
		private readonly sql: Bun.SQL,
		catalog_path: string,
	) {
		const catalog = JSON.parse(readFileSync(catalog_path, 'utf8')) as {
			subjects: Array<{
				slug: string;
				technical_id: string;
				modules?: Array<{
					resource: string;
					table: string;
					collection: string;
					name: string;
					columns?: ExtraCol[];
				}>;
			}>;
		};
		for (const s of catalog.subjects) {
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
		const host =
			this.all_locs.find((l) => l.slug === 'configuracion') ?? this.all_locs[0];
		if (host) {
			const orphans = [
				'messages',
				'notifications',
				'user-settings',
				'custom-user-themes',
				'documentation-page',
				'document-change-history',
				'interactive-manual',
				'cobranza-payment',
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

	async ensure_orphan_tables(): Promise<void> {
		for (const resource of [
			'messages',
			'notifications',
			'user-settings',
			'custom-user-themes',
			'documentation-page',
			'document-change-history',
			'interactive-manual',
			'cobranza-payment',
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

	flatten(row: Record<string, unknown> | null): ImperiumDoc | null {
		if (!row) return null;
		const parsed = { ...row };
		for (const k of Object.keys(parsed)) {
			if ((k === 'payload' || k === 'custom_data' || typeof parsed[k] === 'string') &&
				(k === 'payload' || k === 'custom_data')) {
				parsed[k] = as_object(parsed[k]);
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
		} = {},
	): Promise<{ rows: ImperiumDoc[]; total: number }> {
		const loc = this.loc(resource);
		const qt = this.qt(resource);
		const cols = this.column_names(resource);
		const params: unknown[] = [];
		const clauses: string[] = [];
		if (!opts.include_inactive) clauses.push(`is_active IS DISTINCT FROM false`);
		if (opts.ids?.length) {
			params.push(opts.ids);
			clauses.push(`id = ANY($${params.length})`);
		}
		if (opts.where) {
			for (const [raw_key, v] of Object.entries(opts.where)) {
				if (v === undefined) continue;
				const k = raw_key === '_ref' ? 'ref' : raw_key;
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
			const campo = (m?.[1] ?? '').replace(/^_/, '');
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
		return {
			rows: rows.map((r) => this.flatten(r as Record<string, unknown>)!),
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
		return this.flatten((rows[0] as Record<string, unknown>) ?? null);
	}

	async find_where(
		resource: string,
		where: Record<string, unknown>,
	): Promise<ImperiumDoc | null> {
		const { rows } = await this.find_many(resource, {
			where,
			take: 1,
			include_inactive: true,
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
		return this.flatten(inserted[0] as Record<string, unknown>)!;
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
		return this.flatten((updated[0] as Record<string, unknown>) ?? null);
	}

	async remove(resource: string, id: string): Promise<ImperiumDoc | null> {
		return this.update(resource, id, { is_active: false });
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

	async stats(resource: string): Promise<Record<string, unknown>> {
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
