// (o==================================================================o)
//   #region KIRLET RUNTIME CONFIG (env)
// (o-----------------------------------------------------------\/-----o)

export type KirletRuntimeConfig = {
  port: number;
  technical_id: string;
  data_dir: string;
  files_dir: string;
  /** `on` | `off` (and aliases). */
  kirlet_auth: string;
  auth_disabled: boolean;
  gateway_secret: string;
  nox_data_url: string | null;
  seed_demo: boolean;
  api_base: string;
  data_mode: "http" | "memory";
};

export type KirletRuntimeConfigOptions = {
  /** Default technical id when env unset (e.g. "kirlet-hr"). */
  default_technical_id?: string;
  /** Env object (defaults to process.env). */
  env?: Record<string, string | undefined>;
};

function env_bool(raw: string | undefined, default_on: boolean): boolean {
  if (raw === undefined || raw === "") return default_on;
  const v = raw.toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  return default_on;
}

/**
 * Resolve kirlet process config from environment.
 * Absorbs former per-kirlet config.ts + resolve_data_mode.
 */
export function resolve_kirlet_config(
  opts?: KirletRuntimeConfigOptions,
): KirletRuntimeConfig {
  const env = opts?.env ?? (typeof process !== "undefined" ? process.env : {});
  const default_tid = opts?.default_technical_id ?? "subject-demo";
  const technical_id =
    (env.SUBJECT_TECHNICAL_ID ?? env.KIRLET_TECHNICAL_ID ?? default_tid).trim() ||
    default_tid;
  const data_dir = env.DATA_DIR ?? "/data";
  const kirlet_auth = (env.SUBJECT_AUTH ?? env.KIRLET_AUTH ?? "on").toLowerCase();
  const auth_disabled =
    kirlet_auth === "off" || kirlet_auth === "false" || kirlet_auth === "0";
  const gateway_secret =
    env.CORE_SUBJECT_GATEWAY_SECRET ?? env.NOX_KIRLET_GATEWAY_SECRET ?? "";
  const nox_data_url =
    env.CORE_DATA_URL?.trim() || env.NOX_DATA_URL?.trim() || null;
  const data_mode: "http" | "memory" =
    nox_data_url && gateway_secret.trim() ? "http" : "memory";

  return {
    port: Number(env.PORT ?? 3000) || 3000,
    technical_id,
    data_dir,
    files_dir: `${data_dir}/files`,
    kirlet_auth,
    auth_disabled,
    gateway_secret,
    nox_data_url,
    seed_demo: env_bool(env.KIRLET_SEED_DEMO, true),
    api_base: `api://m/${technical_id}`,
    data_mode,
  };
}

/** Resolve data client mode from env (http vs memory). */
export function resolve_data_mode(
  env?: Record<string, string | undefined>,
): "http" | "memory" {
  return resolve_kirlet_config({ env }).data_mode;
}

// (o-----------------------------------------------------------/\-----o)
//   #endregion KIRLET RUNTIME CONFIG
// (o==================================================================o)
