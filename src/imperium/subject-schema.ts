/**
 * Aplica el DDL que publica la app en GET /schema. No borra datos.
 */
import {
	SchemaDdlBuilder,
	pg_schema_name,
	type KirletSchemaBundle,
} from '@opus-perpetuus/imperium-core-kit';

const ddl = new SchemaDdlBuilder();

async function ensure_tracking(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.subject_schema_versions (
      technical_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tables JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
}

export async function apply_subject_schema_bundle(
	sql: Bun.SQL,
	bundle: KirletSchemaBundle,
): Promise<void> {
	await ensure_tracking(sql);
	const { statements } = ddl.build_with_warnings(bundle);
	for (const stmt of statements) {
		await sql.unsafe(stmt);
	}
	const names = bundle.tables.map((t) => t.name);
	await sql.unsafe(
		`INSERT INTO public.subject_schema_versions (technical_id, version, tables)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (technical_id) DO UPDATE SET
       version = GREATEST(public.subject_schema_versions.version, EXCLUDED.version),
       applied_at = NOW(),
       tables = EXCLUDED.tables`,
		[bundle.technicalId, bundle.version, JSON.stringify(names)],
	);
}

export async function apply_subject_schema_from_url(
	sql: Bun.SQL,
	technical_id: string,
	base_url: string,
): Promise<{ ok: boolean; error?: string; schema?: string }> {
	const base = base_url.replace(/\/$/, '');
	let last_error = 'unreachable';
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(`${base}/schema`, {
				signal: AbortSignal.timeout(2000),
			});
			if (!res.ok) {
				last_error = `http_${res.status}`;
			} else {
				const bundle = (await res.json()) as KirletSchemaBundle;
				await apply_subject_schema_bundle(sql, bundle);
				return { ok: true, schema: pg_schema_name(technical_id) };
			}
		} catch (err) {
			last_error = String(err);
		}
		await Bun.sleep(1000);
	}
	return { ok: false, error: last_error };
}
