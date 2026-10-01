/**
 * Catálogo de apps del tenant: las que se le ofrecen para instalar.
 *
 * El `catalog.json` es la lista de apps que ESTE núcleo sabe correr (su
 * definición y su versión); no es lo que el tenant ve. Módulos muestra las
 * base, las instaladas y las que están en esta tabla: las que autorizó Odoo
 * (`source = 'odoo'`, las reescribe cada «Aplicar súbditos») y las que el
 * superadministrador dio de alta a mano (`source = 'manual'`), p. ej. una app
 * externa. Una app externa se lista, pero este núcleo no la corre mientras su
 * definición no esté en el catálogo del servidor.
 */
import type { SubjectInfo } from './store.ts';
import {
	is_base_subject_slug,
	normalize_subject_slug,
} from './subject-runtime.ts';

export type CatalogSource = 'odoo' | 'manual';

export type CatalogEntry = {
	technical_id: string;
	slug: string;
	name: string;
	image: string | null;
	repo: string | null;
	source: CatalogSource;
	created_at: string;
	updated_at: string;
};

export class SubjectCatalogError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
	}
}

const MAX_NAME = 120;
const MAX_TEXT = 300;

export async function ensure_catalog_table(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.subject_catalog (
      technical_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      image TEXT,
      repo TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function list_catalog_entries(sql: Bun.SQL): Promise<CatalogEntry[]> {
	await ensure_catalog_table(sql);
	const rows = (await sql.unsafe(
		`SELECT technical_id, slug, name, image, repo, source, created_at, updated_at
       FROM public.subject_catalog
      ORDER BY name`,
	)) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		technical_id: String(row.technical_id),
		slug: String(row.slug),
		name: String(row.name),
		image: row.image ? String(row.image) : null,
		repo: row.repo ? String(row.repo) : null,
		source: row.source === 'odoo' ? 'odoo' : 'manual',
		created_at: String(row.created_at),
		updated_at: String(row.updated_at),
	}));
}

/**
 * Lo que ve Módulos. Nadie ve el catálogo entero, ni el superadministrador:
 * base, instaladas, autorizadas, y las que están a mitad de un trabajo o
 * fallaron en uno (una dependencia que no se pudo instalar no debe
 * desaparecer con su error).
 */
export function catalog_visible(input: {
	slug: string;
	installed: boolean;
	busy: boolean;
	status: string;
	authorized: boolean;
}): boolean {
	return (
		is_base_subject_slug(input.slug) ||
		input.installed ||
		input.busy ||
		input.status === 'error' ||
		input.authorized
	);
}

async function upsert_entry(
	sql: Bun.SQL,
	entry: Omit<CatalogEntry, 'created_at' | 'updated_at'>,
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO public.subject_catalog (technical_id, slug, name, image, repo, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (technical_id) DO UPDATE
        SET name = EXCLUDED.name,
            image = EXCLUDED.image,
            repo = COALESCE(EXCLUDED.repo, public.subject_catalog.repo),
            source = EXCLUDED.source,
            updated_at = now()`,
		[
			entry.technical_id,
			entry.slug,
			entry.name,
			entry.image,
			entry.repo,
			entry.source,
		],
	);
}

/**
 * Deja autorizadas desde Odoo exactamente `slugs`: agrega las nuevas y quita
 * las que Odoo ya no autoriza. Las dadas de alta a mano no se tocan. Las base
 * no se guardan (siempre se ven) y las que este núcleo no conoce se informan
 * sin guardarse: su definición llega con una versión nueva del producto.
 */
export async function set_odoo_authorized(
	subjects: readonly SubjectInfo[],
	sql: Bun.SQL,
	raw_slugs: unknown,
): Promise<{ authorized: string[]; unknown: string[]; revoked: string[] }> {
	if (!Array.isArray(raw_slugs)) {
		throw new SubjectCatalogError(
			'Se esperaba { "slugs": [...] }',
			400,
			'invalid_payload',
		);
	}
	await ensure_catalog_table(sql);
	const authorized: string[] = [];
	const unknown: string[] = [];
	for (const raw of raw_slugs) {
		const slug = normalize_subject_slug(String(raw ?? ''));
		if (!slug) {
			throw new SubjectCatalogError(
				`Slug de app inválido: ${String(raw)}`,
				400,
				'invalid_slug',
			);
		}
		if (is_base_subject_slug(slug) || authorized.includes(slug)) continue;
		const sub = subjects.find((item) => item.slug === slug);
		if (!sub) {
			unknown.push(slug);
			continue;
		}
		await upsert_entry(sql, {
			technical_id: sub.technical_id,
			slug,
			name: sub.name,
			image: sub.image || null,
			repo: null,
			source: 'odoo',
		});
		authorized.push(slug);
	}
	// `jsonb` y no `text[]`: Bun.SQL no codifica un arreglo JS como arreglo de
	// Postgres («malformed array literal»); como jsonb sí (y no hay que
	// pasarlo ya serializado: lo volvería a codificar como texto).
	const revoked = (await sql.unsafe(
		`DELETE FROM public.subject_catalog
      WHERE source = 'odoo'
        AND slug NOT IN (SELECT jsonb_array_elements_text($1::jsonb))
      RETURNING slug`,
		[authorized],
	)) as Array<{ slug: string }>;
	return { authorized, unknown, revoked: revoked.map((row) => row.slug) };
}

function optional_text(value: unknown, label: string): string | null {
	const text = String(value ?? '').trim();
	if (!text) return null;
	if (text.length > MAX_TEXT) {
		throw new SubjectCatalogError(`${label} es demasiado largo`, 400, 'invalid_field');
	}
	return text;
}

/** Alta manual: para apps que no vienen de Codice Progressio. */
export async function add_manual_entry(
	subjects: readonly SubjectInfo[],
	sql: Bun.SQL,
	body: Record<string, unknown>,
): Promise<CatalogEntry> {
	const slug = normalize_subject_slug(String(body.slug ?? '').toLowerCase());
	if (!slug) {
		throw new SubjectCatalogError(
			'El identificador solo admite minúsculas, números y guiones (p. ej. «mi-app»)',
			400,
			'invalid_slug',
		);
	}
	if (is_base_subject_slug(slug)) {
		throw new SubjectCatalogError(
			'Las apps base ya están siempre en el catálogo',
			409,
			'catalog_base_subject',
		);
	}
	const known = subjects.find((item) => item.slug === slug);
	const name = String(body.name ?? '').trim() || known?.name || '';
	if (!name || name.length > MAX_NAME) {
		throw new SubjectCatalogError('Falta el nombre de la app', 400, 'invalid_name');
	}
	await ensure_catalog_table(sql);
	const technical_id = `subject-${slug}`;
	const existing = (await sql.unsafe(
		`SELECT source FROM public.subject_catalog WHERE technical_id = $1`,
		[technical_id],
	)) as Array<{ source: string }>;
	if (existing[0]?.source === 'odoo') {
		throw new SubjectCatalogError(
			'Esa app ya está en el catálogo: la autorizó Odoo',
			409,
			'already_authorized',
		);
	}
	await upsert_entry(sql, {
		technical_id,
		slug,
		name,
		image: optional_text(body.image, 'La imagen') ?? known?.image ?? null,
		repo: optional_text(body.repo, 'El repositorio'),
		source: 'manual',
	});
	const [entry] = (await list_catalog_entries(sql)).filter(
		(item) => item.technical_id === technical_id,
	);
	return entry!;
}

/** Solo las de alta manual: las de Odoo se revocan desde Odoo. */
export async function remove_manual_entry(
	sql: Bun.SQL,
	technical_id: string,
): Promise<boolean> {
	await ensure_catalog_table(sql);
	const rows = (await sql.unsafe(
		`SELECT source FROM public.subject_catalog WHERE technical_id = $1`,
		[technical_id],
	)) as Array<{ source: string }>;
	if (!rows.length) return false;
	if (rows[0]!.source === 'odoo') {
		throw new SubjectCatalogError(
			'La autorizó Odoo: se retira desde la ficha del servidor en Odoo',
			409,
			'authorized_by_odoo',
		);
	}
	await sql.unsafe(`DELETE FROM public.subject_catalog WHERE technical_id = $1`, [
		technical_id,
	]);
	return true;
}

export async function is_catalog_authorized(
	sql: Bun.SQL,
	technical_id: string,
): Promise<boolean> {
	await ensure_catalog_table(sql);
	const rows = await sql.unsafe(
		`SELECT 1 FROM public.subject_catalog WHERE technical_id = $1`,
		[technical_id],
	);
	return rows.length > 0;
}
