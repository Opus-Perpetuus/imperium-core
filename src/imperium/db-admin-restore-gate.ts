/**
 * Candado de mantenimiento mientras se restaura un respaldo.
 *
 * Dos niveles, porque cada fase pide cosas distintas:
 *
 * - `escrituras_bloqueadas`: desde el respaldo de seguridad hasta que la base
 *   temporal está lista. Leer no estorba; escribir sí, porque lo que se
 *   capturara aquí no está en el respaldo de seguridad y desaparece con el
 *   swap sin que nadie lo note.
 * - `intercambio`: mientras se renombran las bases y se mueven los adjuntos.
 *   Cualquier consulta reabre una conexión a la base que se está renombrando
 *   y hace fallar el `ALTER DATABASE … RENAME`, así que solo pasan la sonda y
 *   el seguimiento de la propia restauración.
 *
 * Vive en memoria del proceso del núcleo, que es el único que escribe en la
 * base. Si el núcleo se cae a media restauración el candado se va con él, y
 * eso es lo correcto: al volver, la base es la vieja (swap no hecho) o la
 * nueva (swap hecho), nunca una mitad.
 */

export type GatePhase = 'libre' | 'escrituras_bloqueadas' | 'intercambio';

type GateState = {
	phase: GatePhase;
	restore_id: string | null;
	since: string | null;
	message: string;
};

const state: GateState = {
	phase: 'libre',
	restore_id: null,
	since: null,
	message: '',
};

export function set_restore_gate(
	phase: GatePhase,
	restore_id: string | null = null,
	message = '',
): void {
	state.phase = phase;
	state.restore_id = phase === 'libre' ? null : restore_id;
	state.since = phase === 'libre' ? null : new Date().toISOString();
	state.message = phase === 'libre' ? '' : message;
}

export function restore_gate_state(): Readonly<GateState> {
	return { ...state };
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalize(path: string): string {
	const trimmed = path.replace(/\/+$/, '') || '/';
	return trimmed.startsWith('/api/') || trimmed === '/api'
		? trimmed.slice(4) || '/'
		: trimmed;
}

/**
 * ¿Esta petición puede pasar con el candado actual? `null` = sí; si no, la
 * respuesta 503 que hay que devolver.
 */
export function restore_gate(method: string, raw_path: string): Response | null {
	if (state.phase === 'libre') return null;
	const verb = method.toUpperCase();
	const path = normalize(raw_path);
	if (path === '/health') return null;
	const following_restore =
		READ_METHODS.has(verb) && (path === '/db-admin/restores' || path.startsWith('/db-admin/restores/'));
	if (following_restore) return null;

	if (state.phase === 'escrituras_bloqueadas') {
		if (READ_METHODS.has(verb)) return null;
		if (path === '/auth' || path.startsWith('/auth/')) return null;
		if (path === '/db-admin' || path.startsWith('/db-admin/')) return null;
	}
	return blocked_response();
}

function blocked_response(): Response {
	const message =
		state.phase === 'intercambio'
			? 'Imperium está cambiando a la base restaurada. Vuelve a intentar en un minuto.'
			: 'Imperium está restaurando un respaldo: por ahora solo se puede consultar. ' +
				'Lo que guardes ahora se perdería, así que espera a que termine.';
	return Response.json(
		{
			message,
			error: message,
			code: 'restauracion_en_curso',
			phase: state.phase,
			restore_id: state.restore_id,
			since: state.since,
		},
		{ status: 503, headers: { 'retry-after': '30' } },
	);
}
