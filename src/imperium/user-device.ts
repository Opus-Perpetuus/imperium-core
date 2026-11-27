import { FEATURE_MAP_TEST_COLUMN_DDL } from './feature-map-test.ts';

export type UserDeviceStatus = 'activo' | 'revocado';

export type UserDeviceInput = {
	id: string;
	user_id: string;
	name: string;
	model?: string | null;
	public_key: string;
	fcm_token?: string | null;
	registered_at?: string | null;
	last_used_at?: string | null;
	status: UserDeviceStatus;
	attestation?: string | null;
};

export async function ensure_user_device_table(sql: Bun.SQL): Promise<void> {
	await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.user_device (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      model TEXT,
      public_key TEXT NOT NULL,
      fcm_token TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      status TEXT NOT NULL CHECK (status IN ('activo', 'revocado')),
      attestation TEXT,
      ${FEATURE_MAP_TEST_COLUMN_DDL}
    )
  `);
	await sql.unsafe(
		`CREATE INDEX IF NOT EXISTS user_device_user_active_idx ON public.user_device (user_id) WHERE status = 'activo'`,
	);
}

export async function insert_user_device(sql: Bun.SQL, row: UserDeviceInput): Promise<void> {
	await sql.unsafe(
		`INSERT INTO public.user_device
       (id, user_id, name, model, public_key, fcm_token, registered_at, last_used_at, status, attestation)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8::timestamptz, $9, $10)`,
		[
			row.id,
			row.user_id,
			row.name,
			row.model ?? null,
			row.public_key,
			row.fcm_token ?? null,
			row.registered_at ?? null,
			row.last_used_at ?? null,
			row.status,
			row.attestation ?? null,
		],
	);
}
