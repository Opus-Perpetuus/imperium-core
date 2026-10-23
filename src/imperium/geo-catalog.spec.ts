/**
 * #150: mudanza de Estados/Municipios/Delegaciones a Configuración y carga del
 * catálogo SAT. Las pruebas con base corren solo si hay `DATABASE_URL`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	geo_enabled,
	geo_norm,
	load_geo_data,
	relocate_geo_tables,
	seed_geo_catalog,
	type GeoData,
} from './geo-catalog.ts';

describe('catálogo geográfico (sin base)', () => {
	test('el paquete trae los 32 estados, los municipios y las colonias del SAT', () => {
		const data = load_geo_data();
		expect(data.states.length).toBe(32);
		expect(data.municipios.length).toBeGreaterThan(2400);
		expect(data.colonias.length).toBeGreaterThan(140_000);
		expect(data.municipios.filter(([e]) => e === 'JAL').length).toBe(125);
		for (const [cp] of data.colonias.slice(0, 500)) expect(data.codigos[cp]).toBeDefined();
	});

	test('normaliza nombres para casarlos', () => {
		expect(geo_norm('  Acatlán de Juárez ')).toBe('acatlan de juarez');
		expect(geo_norm('Tlaquepaque, San Pedro')).toBe('tlaquepaque san pedro');
	});

	test('IMPERIUM_GEO_CATALOG=off apaga la carga', () => {
		expect(geo_enabled({})).toBe(true);
		expect(geo_enabled({ IMPERIUM_GEO_CATALOG: 'off' })).toBe(false);
		expect(geo_enabled({ IMPERIUM_GEO_CATALOG: '0' })).toBe(false);
	});

	test('el catálogo pone Estados, Municipios, Delegaciones y Colonias en Configuración', () => {
		for (const file of ['../../catalog.json', '../../../catalog.json']) {
			const catalog = JSON.parse(readFileSync(join(import.meta.dir, file), 'utf8')) as {
				subjects: { slug: string; modules: { resource: string }[] }[];
			};
			const of = (slug: string) =>
				catalog.subjects.find((s) => s.slug === slug)!.modules.map((m) => m.resource);
			for (const r of ['states', 'municipality', 'boroughs', 'colonias']) {
				expect(of('configuracion')).toContain(r);
				expect(of('control-municipal')).not.toContain(r);
			}
		}
	});
});

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL ? new Bun.SQL(DATABASE_URL) : null;
const LEGACY = 'geo_spec_cm';
const TARGET = 'geo_spec_cfg';

const generic = (extra = '') => `(
	id TEXT PRIMARY KEY, name TEXT, description TEXT, is_active BOOLEAN DEFAULT true, state TEXT,
	ref TEXT UNIQUE, search_field TEXT, created_by TEXT, custom_data JSONB DEFAULT '{}'::jsonb,
	payload JSONB DEFAULT '{}'::jsonb, created_at TEXT, updated_at TEXT${extra})`;

const fake: GeoData = {
	states: [
		['JAL', 'Jalisco'],
		['COL', 'Colima'],
		['CMX', 'Ciudad de México'],
	],
	municipios: [
		['JAL', '001', 'Acatic'],
		['JAL', '002', 'Acatlán de Juárez'],
		['JAL', '124', 'Zapotlanejo'],
		['COL', '001', 'Armería'],
	],
	colonias: [
		['45430', '0001', 'Centro'],
		['45430', '0002', 'La Laja'],
		['28300', '0001', 'Centro'],
	],
	codigos: { '45430': ['JAL', '124'], '28300': ['COL', '001'] },
};

describe.skipIf(!sql)('catálogo geográfico (Postgres)', () => {
	const db = sql!;
	const store = {
		sql: db,
		has: () => true,
		qt: (r: string) => `"${TARGET}"."${r}"`,
	};

	beforeAll(async () => {
		await db.unsafe(`DROP SCHEMA IF EXISTS ${LEGACY} CASCADE; DROP SCHEMA IF EXISTS ${TARGET} CASCADE`);
		await db.unsafe(`CREATE SCHEMA ${LEGACY}`);
		await db.unsafe(`CREATE TABLE ${LEGACY}.states ${generic(', catalog_key TEXT, cfdi_c_estado TEXT, cfdi_c_pais TEXT')}`);
		await db.unsafe(`CREATE TABLE ${LEGACY}.municipality ${generic()}`);
		await db.unsafe(`CREATE TABLE ${LEGACY}.boroughs ${generic()}`);
		await db.unsafe(
			`INSERT INTO ${LEGACY}.states (id, name, ref, cfdi_c_estado) VALUES ('s1', 'Jalisco', 'jalisco', 'JAL'), ('s2', 'Ciudad de México', 'ciudad_de_mexico', 'DIF')`,
		);
		await db.unsafe(`INSERT INTO ${LEGACY}.municipality (id, name, ref) VALUES
			('m1', 'Acatic', 'municipality_jal_1'), ('m2', 'Acatlan de Juarez', 'municipality_jal_2')`);
		await db.unsafe(`INSERT INTO ${LEGACY}.boroughs (id, name, ref) VALUES ('b1', 'La Laja', 'boroughs_la_laja')`);
	});

	afterAll(async () => {
		await db.unsafe(`DROP SCHEMA IF EXISTS ${LEGACY} CASCADE; DROP SCHEMA IF EXISTS ${TARGET} CASCADE`);
		await db.close();
	});

	test('muda las tablas con sus ids y es idempotente', async () => {
		const first = await relocate_geo_tables(db, { from: LEGACY, to: TARGET });
		expect(first.map((r) => r.action)).toEqual(['moved', 'moved', 'moved']);
		const [{ n }] = await db.unsafe(`SELECT count(*)::int AS n FROM ${TARGET}.municipality`);
		expect(n).toBe(2);
		const again = await relocate_geo_tables(db, { from: LEGACY, to: TARGET });
		expect(again.map((r) => r.action)).toEqual(['none', 'none', 'none']);
	});

	test('si la tabla vieja reaparece, copia lo que falte sin duplicar', async () => {
		await db.unsafe(`CREATE TABLE ${LEGACY}.boroughs ${generic()}`);
		await db.unsafe(`INSERT INTO ${LEGACY}.boroughs (id, name, ref) VALUES
			('b1', 'La Laja', 'boroughs_la_laja'), ('b2', 'Santa Fe', 'boroughs_santa_fe')`);
		const out = await relocate_geo_tables(db, { from: LEGACY, to: TARGET, tables: ['boroughs'] });
		expect(out).toEqual([{ table: 'boroughs', action: 'merged', rows: 1 }]);
		const rows = await db.unsafe(`SELECT id FROM ${TARGET}.boroughs ORDER BY id`);
		expect(rows.map((r: { id: string }) => r.id)).toEqual(['b1', 'b2']);
	});

	test('siembra estados, municipios y colonias; casa los municipios viejos', async () => {
		await db.unsafe(`ALTER TABLE ${TARGET}.municipality ADD COLUMN catalog_key TEXT, ADD COLUMN state_key TEXT`);
		await db.unsafe(
			`CREATE TABLE ${TARGET}.colonias ${generic(', catalog_key TEXT, postal_code TEXT, state_key TEXT, municipality_key TEXT')}`,
		);
		const out = await seed_geo_catalog(store, { data: fake, batch: 2, env: {} });
		expect(out).toEqual({ states: 1, municipalities: 2, municipalities_matched: 2, colonias: 3 });

		const muns = await db.unsafe(
			`SELECT id, name, catalog_key, state_key FROM ${TARGET}.municipality ORDER BY state_key, catalog_key`,
		);
		expect(muns.length).toBe(4);
		expect(muns.find((r: { id: string }) => r.id === 'm2')).toMatchObject({ catalog_key: '002', state_key: 'JAL' });
		const laja = (await db.unsafe(`SELECT * FROM ${TARGET}.colonias WHERE ref = 'colonias_45430_0002'`))[0];
		expect(laja).toMatchObject({
			name: 'La Laja',
			postal_code: '45430',
			state_key: 'JAL',
			municipality_key: '124',
			description: 'CP 45430 · Zapotlanejo, Jalisco',
		});

		// CDMX ya estaba con «DIF»: no se duplica con la «CMX» del SAT.
		const cdmx = await db.unsafe(`SELECT id FROM ${TARGET}.states WHERE name = 'Ciudad de México'`);
		expect(cdmx.map((r: { id: string }) => r.id)).toEqual(['s2']);

		const again = await seed_geo_catalog(store, { data: fake, batch: 2, env: {} });
		expect(again.skipped).toBe('completo');
		const [{ n }] = await db.unsafe(`SELECT count(*)::int AS n FROM ${TARGET}.colonias`);
		expect(n).toBe(3);
	});

	test('apagado por variable no toca nada', async () => {
		const out = await seed_geo_catalog(store, { data: fake, env: { IMPERIUM_GEO_CATALOG: 'off' } });
		expect(out.skipped).toBe('IMPERIUM_GEO_CATALOG=off');
	});
});
