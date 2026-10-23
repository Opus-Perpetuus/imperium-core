/**
 * Catálogo geográfico (ticket #150).
 *
 * 1. Estados, Municipios y Delegaciones pasaron de Control municipal a
 *    Configuración. Sus tablas vivían en `subject_control_municipal`; al arrancar
 *    se mudan a `subject_configuracion` (mismos ids, mismos índices). Si las dos
 *    existen —p. ej. la app vieja volvió a crear la suya— se copian las filas que
 *    falten por `id` y la vieja no se toca.
 * 2. Municipios de todo el país y colonias del SAT (CFDI 4.0), desde
 *    `data/geo-mx.json.gz` (lo genera `modular/scripts/build-geo-catalog.py`).
 *    Se cargan en segundo plano, por lotes e idempotente por `ref`. Los
 *    municipios que ya existían (refs `municipality_jal_<n>`) no se duplican: se
 *    casan por nombre dentro de su estado y solo se les llena la clave SAT.
 *
 * `IMPERIUM_GEO_CATALOG=off` apaga la carga (la mudanza de tablas sí corre).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const GEO_LEGACY_SCHEMA = 'subject_control_municipal';
export const GEO_TARGET_SCHEMA = 'subject_configuracion';
export const GEO_MOVED_TABLES = ['states', 'municipality', 'boroughs'] as const;

type Row = Record<string, unknown>;
export type GeoSql = { unsafe(query: string, params?: unknown[]): Promise<Row[]> | PromiseLike<Row[]> };

export type GeoData = {
	states: [string, string][];
	municipios: [string, string, string][];
	colonias: [string, string, string][];
	codigos: Record<string, [string, string]>;
};

export type GeoStore = {
	sql: GeoSql;
	has(resource: string): boolean;
	qt(resource: string): string;
};

const ident = (name: string) => {
	if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`bad ident ${name}`);
	return `"${name}"`;
};

async function table_exists(sql: GeoSql, schema: string, table: string): Promise<boolean> {
	const rows = await sql.unsafe(
		`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
		[schema, table],
	);
	return rows.length > 0;
}

async function table_columns(sql: GeoSql, schema: string, table: string): Promise<string[]> {
	const rows = await sql.unsafe(
		`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
		[schema, table],
	);
	return rows.map((r) => String(r.column_name));
}

export type RelocateResult = { table: string; action: 'moved' | 'merged' | 'none'; rows?: number };

/** Muda las tablas de Control municipal a Configuración. Idempotente. */
export async function relocate_geo_tables(
	sql: GeoSql,
	opts: { from?: string; to?: string; tables?: readonly string[] } = {},
): Promise<RelocateResult[]> {
	const from = opts.from ?? GEO_LEGACY_SCHEMA;
	const to = opts.to ?? GEO_TARGET_SCHEMA;
	const out: RelocateResult[] = [];
	for (const table of opts.tables ?? GEO_MOVED_TABLES) {
		const old_exists = await table_exists(sql, from, table);
		if (!old_exists) {
			out.push({ table, action: 'none' });
			continue;
		}
		const new_exists = await table_exists(sql, to, table);
		const src = `${ident(from)}.${ident(table)}`;
		const dst = `${ident(to)}.${ident(table)}`;
		if (!new_exists) {
			await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${ident(to)}`);
			await sql.unsafe(`ALTER TABLE ${src} SET SCHEMA ${ident(to)}`);
			out.push({ table, action: 'moved' });
			continue;
		}
		const dst_cols = new Set(await table_columns(sql, to, table));
		const cols = (await table_columns(sql, from, table)).filter((c) => dst_cols.has(c));
		if (!cols.includes('id')) {
			out.push({ table, action: 'none' });
			continue;
		}
		const list = cols.map(ident).join(', ');
		const rows = await sql.unsafe(
			`INSERT INTO ${dst} (${list})
			 SELECT ${cols.map((c) => `f.${ident(c)}`).join(', ')} FROM ${src} f
			  WHERE NOT EXISTS (SELECT 1 FROM ${dst} t WHERE t.id = f.id)
			 ON CONFLICT DO NOTHING
			 RETURNING id`,
		);
		out.push({ table, action: rows.length ? 'merged' : 'none', rows: rows.length });
	}
	return out;
}

let cached: GeoData | null = null;

export function load_geo_data(file = join(import.meta.dir, 'data', 'geo-mx.json.gz')): GeoData {
	if (!cached) cached = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as GeoData;
	return cached;
}

/** Minúsculas, sin acentos ni signos: para casar nombres y para `search_field`. */
export function geo_norm(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9ñ]+/g, ' ')
		.trim();
}

const new_id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 24);

export function geo_enabled(env: Record<string, string | undefined> = process.env): boolean {
	const v = String(env.IMPERIUM_GEO_CATALOG ?? '').trim().toLowerCase();
	return !['off', '0', 'false', 'no'].includes(v);
}

async function insert_batch(sql: GeoSql, qt: string, cols: string[], rows: Row[]): Promise<number> {
	if (!rows.length) return 0;
	const def = cols.map((c) => `${ident(c)} ${c === 'is_active' ? 'boolean' : 'text'}`).join(', ');
	const list = cols.map(ident).join(', ');
	const inserted = await sql.unsafe(
		`INSERT INTO ${qt} (${list})
		 SELECT ${cols.map((c) => `v.${ident(c)}`).join(', ')}
		   FROM jsonb_to_recordset(($1::text)::jsonb) AS v(${def})
		  WHERE NOT EXISTS (SELECT 1 FROM ${qt} t WHERE t.ref = v.ref)
		 ON CONFLICT DO NOTHING
		 RETURNING id`,
		[JSON.stringify(rows)],
	);
	return inserted.length;
}

export type GeoSeedResult = {
	skipped?: string;
	states: number;
	municipalities: number;
	municipalities_matched: number;
	colonias: number;
};

/** Siembra municipios y colonias del SAT. Idempotente; seguro de repetir. */
export async function seed_geo_catalog(
	store: GeoStore,
	opts: { data?: GeoData; batch?: number; env?: Record<string, string | undefined> } = {},
): Promise<GeoSeedResult> {
	const out: GeoSeedResult = { states: 0, municipalities: 0, municipalities_matched: 0, colonias: 0 };
	if (!geo_enabled(opts.env)) return { ...out, skipped: 'IMPERIUM_GEO_CATALOG=off' };
	if (!store.has('municipality') || !store.has('colonias') || !store.has('states'))
		return { ...out, skipped: 'catálogo sin municipality/colonias/states' };
	const data = opts.data ?? load_geo_data();
	const batch = opts.batch ?? 2000;
	const sql = store.sql;
	const ts = new Date().toISOString();
	const state_name = new Map(data.states.map(([k, n]) => [k, n]));
	const mun_name = new Map(data.municipios.map(([e, m, n]) => [`${e}|${m}`, n]));

	// Ya está todo: no se vuelve a leer nada pesado.
	const qt_s = store.qt('states');
	const qt_m = store.qt('municipality');
	const qt_c = store.qt('colonias');
	const [{ n: have_m }] = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${qt_m} WHERE coalesce(catalog_key,'') <> ''`,
	)) as { n: number }[];
	const [{ n: have_c }] = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${qt_c} WHERE coalesce(catalog_key,'') <> ''`,
	)) as { n: number }[];
	const [{ n: have_s }] = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${qt_s} WHERE coalesce(cfdi_c_estado,'') <> ''`,
	)) as { n: number }[];
	if (have_m >= data.municipios.length && have_c >= data.colonias.length && have_s >= data.states.length)
		return { ...out, skipped: 'completo' };

	// Estados: solo los que falten por clave SAT y por nombre. La semilla vieja
	// trae Ciudad de México con «DIF» y el SAT la da como «CMX»: por clave sola
	// salía duplicada (PROFESA, #150).
	const existing_states = await sql.unsafe(`SELECT upper(coalesce(cfdi_c_estado,'')) AS k, name FROM ${qt_s}`);
	const known_states = new Set(existing_states.map((r) => String(r.k)).filter(Boolean));
	const known_state_names = new Set(existing_states.map((r) => geo_norm(String(r.name ?? ''))).filter(Boolean));
	const state_rows = data.states
		.filter(([k, n]) => !known_states.has(k) && !known_state_names.has(geo_norm(n)))
		.map(([k, n]) => ({
			id: new_id(),
			name: n,
			ref: `states_sat_${k.toLowerCase()}`,
			search_field: geo_norm(n),
			is_active: true,
			cfdi_c_estado: k,
			cfdi_c_pais: 'MEX',
			created_at: ts,
			updated_at: ts,
		}));
	out.states = await insert_batch(sql, qt_s, Object.keys(state_rows[0] ?? { id: 1 }), state_rows);

	// Municipios que ya existían sin clave: se casan por nombre dentro del estado.
	const by_state_name = new Map<string, [string, string][]>();
	for (const [e, m, n] of data.municipios) {
		const key = geo_norm(n);
		by_state_name.set(`${e}|${key}`, [...(by_state_name.get(`${e}|${key}`) ?? []), [e, m]]);
		by_state_name.set(`*|${key}`, [...(by_state_name.get(`*|${key}`) ?? []), [e, m]]);
	}
	const legacy = await sql.unsafe(
		`SELECT id, name, ref FROM ${qt_m} WHERE coalesce(catalog_key,'') = ''`,
	);
	const taken = new Set(
		(await sql.unsafe(
			`SELECT state_key || '|' || catalog_key AS k FROM ${qt_m} WHERE coalesce(catalog_key,'') <> ''`,
		)).map((r) => String(r.k)),
	);
	const matches: Row[] = [];
	for (const row of legacy) {
		const key = geo_norm(String(row.name ?? ''));
		if (!key) continue;
		const edo = /^municipality_([a-z]{3})_/i.exec(String(row.ref ?? ''))?.[1]?.toUpperCase();
		const hits = (by_state_name.get(`${edo ?? '*'}|${key}`) ?? []).filter(([e, m]) => !taken.has(`${e}|${m}`));
		if (hits.length !== 1) continue;
		const [e, m] = hits[0];
		taken.add(`${e}|${m}`);
		matches.push({ id: row.id, catalog_key: m, state_key: e });
	}
	for (let i = 0; i < matches.length; i += batch) {
		const part = matches.slice(i, i + batch);
		const done = await sql.unsafe(
			`UPDATE ${qt_m} t SET catalog_key = v.catalog_key, state_key = v.state_key
			   FROM jsonb_to_recordset(($1::text)::jsonb) AS v(id text, catalog_key text, state_key text)
			  WHERE t.id = v.id
			 RETURNING t.id`,
			[JSON.stringify(part)],
		);
		out.municipalities_matched += done.length;
	}

	const mun_cols = ['id', 'name', 'description', 'ref', 'search_field', 'is_active', 'catalog_key', 'state_key', 'created_at', 'updated_at'];
	const mun_rows = data.municipios
		.filter(([e, m]) => !taken.has(`${e}|${m}`))
		.map(([e, m, n]) => ({
			id: new_id(),
			name: n,
			description: state_name.get(e) ?? e,
			ref: `municipality_sat_${e.toLowerCase()}_${m}`,
			search_field: geo_norm(`${n} ${state_name.get(e) ?? e}`),
			is_active: true,
			catalog_key: m,
			state_key: e,
			created_at: ts,
			updated_at: ts,
		}));
	for (let i = 0; i < mun_rows.length; i += batch)
		out.municipalities += await insert_batch(sql, qt_m, mun_cols, mun_rows.slice(i, i + batch));

	if (have_c < data.colonias.length) {
		const col_cols = ['id', 'name', 'description', 'ref', 'search_field', 'is_active', 'catalog_key', 'postal_code', 'state_key', 'municipality_key', 'created_at', 'updated_at'];
		for (let i = 0; i < data.colonias.length; i += batch) {
			const rows = data.colonias.slice(i, i + batch).map(([cp, c, n]) => {
				const [e, m] = data.codigos[cp] ?? ['', ''];
				const where = [mun_name.get(`${e}|${m}`), state_name.get(e)].filter(Boolean).join(', ');
				return {
					id: new_id(),
					name: n,
					description: where ? `CP ${cp} · ${where}` : `CP ${cp}`,
					ref: `colonias_${cp}_${c}`,
					search_field: geo_norm(`${n} ${cp} ${where}`),
					is_active: true,
					catalog_key: c,
					postal_code: cp,
					state_key: e,
					municipality_key: m,
					created_at: ts,
					updated_at: ts,
				};
			});
			out.colonias += await insert_batch(sql, qt_c, col_cols, rows);
		}
	}
	return out;
}
