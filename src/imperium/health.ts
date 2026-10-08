/**
 * /health que dice si el núcleo de verdad atiende: el 1-oct contestaba en 2 ms
 * mientras login colgaba, y la sonda de Odoo y `restart: always` solo veían un
 * proceso vivo.
 */
import pkg from '../../package.json' with { type: 'json' };

export type BootState = 'idle' | 'running' | 'ready' | 'failed';

export const CORE_VERSION: string = pkg.version;

const DB_PROBE_MS = 2000;

/** `SELECT 1` con plazo: un pool colgado cuenta como base caída. */
export async function probe_database(sql: Bun.SQL, timeout_ms = DB_PROBE_MS): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			sql`SELECT 1`.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeout_ms);
			}),
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export function health_status(boot: BootState, db_ok: boolean): number {
	return boot === 'ready' && db_ok ? 200 : 503;
}
