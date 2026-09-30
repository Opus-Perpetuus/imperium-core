import { describe, expect, test } from 'bun:test';
import {
	add_manual_entry,
	catalog_visible,
	list_catalog_entries,
	remove_manual_entry,
	set_odoo_authorized,
	SubjectCatalogError,
} from './subject-catalog.ts';
import type { SubjectInfo } from './store.ts';

type Row = {
	technical_id: string;
	slug: string;
	name: string;
	image: string | null;
	repo: string | null;
	source: string;
	created_at: string;
	updated_at: string;
};

/** Lo justo de `public.subject_catalog` para las consultas del módulo. */
function fake_sql() {
	const rows = new Map<string, Row>();
	const sql = {
		async unsafe(query: string, params: unknown[] = []) {
			if (query.includes('CREATE TABLE')) return [];
			if (query.includes('INSERT INTO public.subject_catalog')) {
				const [technical_id, slug, name, image, repo, source] = params as string[];
				const prev = rows.get(technical_id!);
				rows.set(technical_id!, {
					technical_id: technical_id!,
					slug: slug!,
					name: name!,
					image: image ?? null,
					repo: repo ?? prev?.repo ?? null,
					source: source!,
					created_at: prev?.created_at ?? 'hoy',
					updated_at: 'hoy',
				});
				return [];
			}
			if (query.includes('DELETE') && query.includes("source = 'odoo'")) {
				const keep = new Set(params[0] as string[]);
				const gone = [...rows.values()].filter(
					(row) => row.source === 'odoo' && !keep.has(row.slug),
				);
				for (const row of gone) rows.delete(row.technical_id);
				return gone.map((row) => ({ slug: row.slug }));
			}
			if (query.includes('DELETE')) {
				rows.delete(String(params[0]));
				return [];
			}
			if (query.includes('SELECT source')) {
				const row = rows.get(String(params[0]));
				return row ? [{ source: row.source }] : [];
			}
			if (query.includes('SELECT technical_id')) {
				return [...rows.values()].map((row) => ({ ...row }));
			}
			throw new Error(`consulta inesperada: ${query}`);
		},
	} as unknown as Bun.SQL;
	return { sql, rows };
}

const SUBJECTS = [
	{ slug: 'pos', name: 'POS', technical_id: 'subject-pos', image: 'ghcr.io/x/subject-pos:0.3.1' },
	{ slug: 'turnos', name: 'Turnos', technical_id: 'subject-turnos', image: 'ghcr.io/x/subject-turnos:0.2.2' },
	{ slug: 'configuracion', name: 'Configuración', technical_id: 'subject-configuracion', image: '' },
] as unknown as SubjectInfo[];

describe('catalog_visible', () => {
	const hidden = { installed: false, busy: false, status: 'not_installed', authorized: false };
	test('ni el superadministrador ve una app sin instalar ni autorizar', () => {
		expect(catalog_visible({ slug: 'pos', ...hidden })).toBe(false);
	});
	test('base, instalada, en curso o autorizada: se ve', () => {
		expect(catalog_visible({ slug: 'configuracion', ...hidden })).toBe(true);
		expect(catalog_visible({ slug: 'pos', ...hidden, installed: true })).toBe(true);
		expect(catalog_visible({ slug: 'pos', ...hidden, busy: true })).toBe(true);
		expect(catalog_visible({ slug: 'pos', ...hidden, authorized: true })).toBe(true);
		expect(catalog_visible({ slug: 'pos', ...hidden, status: 'error' })).toBe(true);
	});
});

describe('set_odoo_authorized', () => {
	test('inserta las autorizadas, omite las base e informa las que el núcleo no conoce', async () => {
		const db = fake_sql();
		const result = await set_odoo_authorized(SUBJECTS, db.sql, [
			'pos',
			'subject-turnos',
			'configuracion',
			'app-futura',
		]);
		expect(result).toEqual({ authorized: ['pos', 'turnos'], unknown: ['app-futura'], revoked: [] });
		expect(db.rows.get('subject-pos')).toMatchObject({ name: 'POS', source: 'odoo' });
		expect(db.rows.has('subject-configuracion')).toBe(false);
	});

	test('lo que Odoo deja de autorizar se quita; lo dado de alta a mano se queda', async () => {
		const db = fake_sql();
		await set_odoo_authorized(SUBJECTS, db.sql, ['pos', 'turnos']);
		await add_manual_entry(SUBJECTS, db.sql, { slug: 'mi-app', name: 'Mi app' });
		const result = await set_odoo_authorized(SUBJECTS, db.sql, ['turnos']);
		expect(result.revoked).toEqual(['pos']);
		expect([...db.rows.keys()].sort()).toEqual(['subject-mi-app', 'subject-turnos']);
	});

	test('rechaza un slug con caracteres raros', async () => {
		const db = fake_sql();
		await expect(set_odoo_authorized(SUBJECTS, db.sql, ['pos; rm -rf'])).rejects.toBeInstanceOf(
			SubjectCatalogError,
		);
		await expect(set_odoo_authorized(SUBJECTS, db.sql, 'pos')).rejects.toBeInstanceOf(
			SubjectCatalogError,
		);
	});
});

describe('alta manual', () => {
	test('una app externa queda en el catálogo con su nombre e imagen', async () => {
		const db = fake_sql();
		const entry = await add_manual_entry(SUBJECTS, db.sql, {
			slug: 'Mi-App ',
			name: 'Mi app',
			image: 'ghcr.io/otra-empresa/mi-app:1.0.0',
		});
		expect(entry).toMatchObject({
			technical_id: 'subject-mi-app',
			name: 'Mi app',
			image: 'ghcr.io/otra-empresa/mi-app:1.0.0',
			source: 'manual',
		});
		expect(await list_catalog_entries(db.sql)).toHaveLength(1);
	});

	test('una app de Codice conocida toma su nombre e imagen del núcleo', async () => {
		const db = fake_sql();
		const entry = await add_manual_entry(SUBJECTS, db.sql, { slug: 'turnos' });
		expect(entry).toMatchObject({ name: 'Turnos', image: 'ghcr.io/x/subject-turnos:0.2.2' });
	});

	test('no pisa lo que autorizó Odoo ni acepta las base', async () => {
		const db = fake_sql();
		await set_odoo_authorized(SUBJECTS, db.sql, ['pos']);
		await expect(add_manual_entry(SUBJECTS, db.sql, { slug: 'pos' })).rejects.toMatchObject({
			code: 'already_authorized',
		});
		await expect(
			add_manual_entry(SUBJECTS, db.sql, { slug: 'configuracion' }),
		).rejects.toMatchObject({ code: 'catalog_base_subject' });
		await expect(add_manual_entry(SUBJECTS, db.sql, { slug: 'x-y' })).rejects.toMatchObject({
			code: 'invalid_name',
		});
	});

	test('quitar: solo las de alta manual', async () => {
		const db = fake_sql();
		await set_odoo_authorized(SUBJECTS, db.sql, ['pos']);
		await add_manual_entry(SUBJECTS, db.sql, { slug: 'turnos' });
		expect(await remove_manual_entry(db.sql, 'subject-turnos')).toBe(true);
		expect(await remove_manual_entry(db.sql, 'subject-nada')).toBe(false);
		await expect(remove_manual_entry(db.sql, 'subject-pos')).rejects.toMatchObject({
			code: 'authorized_by_odoo',
		});
	});
});
