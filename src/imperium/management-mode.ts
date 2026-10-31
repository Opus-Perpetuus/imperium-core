/**
 * Quién administra este servidor. Un solo administrador a la vez:
 * - `odoo` (por defecto): Odoo fija las apps autorizadas y el autoescaneo de
 *   fuentes de apps con el secreto maestro («Aplicar súbditos»). Módulos solo
 *   lo muestra.
 * - `self`: autoadministrado, sin Odoo. Módulos (un administrador del núcleo)
 *   enciende el autoescaneo, edita las fuentes y escanea; el host ya no acepta
 *   que Odoo autorice apps ni cambie las fuentes.
 *
 * Lo fija el instalador (`install-server.sh --management=odoo|self`) en el
 * `.env` del stack, que el compose pasa al núcleo como
 * `IMPERIUM_MANAGEMENT_MODE`. Mismos alias que `subjects-sync`.
 */
export type ManagementMode = 'odoo' | 'self';

export function management_mode(env: Record<string, string | undefined> = process.env): ManagementMode {
	const raw = String(env.IMPERIUM_MANAGEMENT_MODE ?? '').trim().toLowerCase();
	return raw === 'self' || raw === 'self-managed' || raw === 'selfmanaged' || raw === 'auto' || raw === 'standalone'
		? 'self'
		: 'odoo';
}

export function is_self_managed(env?: Record<string, string | undefined>): boolean {
	return management_mode(env) === 'self';
}
