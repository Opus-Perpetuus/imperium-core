/**
 * #323: todo estatus lleva ícono. Si la metadata (núcleo, status-option-control
 * o campo personalizado) no trae uno, se elige uno coherente por el valor y, si
 * no hay coincidencia, por el tipo (success/warning/...). Nunca hueco.
 * Copia en el front: frontend/src/app/utils/state-icon.utils.ts (mismas tablas).
 */
const BY_VALUE: ReadonlyArray<[RegExp, string]> = [
	[/^(borrador|draft|nuevo|new)$/, 'fas fa-file-pen'],
	[/cancel|anulad|rechaz|baja$|^inactiv|archiv|fallecid|falsa_alarma/, 'fas fa-ban'],
	[/^por_surtir$|^pendiente_surtir/, 'fas fa-box-open'],
	[/surtiendo|preparando|picking/, 'fas fa-dolly'],
	[/^surtid|empacad/, 'fas fa-boxes-stacked'],
	[/enviad|en_ruta|ruta|transito|despach|salida/, 'fas fa-truck'],
	[/entregad|recibid|recepcion/, 'fas fa-box-archive'],
	[/factur/, 'fas fa-file-invoice-dollar'],
	[/pagad|cobrad|conciliad/, 'fas fa-money-bill-wave'],
	[/parcial/, 'fas fa-circle-half-stroke'],
	[/confirm|aprobad|autoriz|aplicad|firmad|hecho|complet|termin|resuel|cerrad|ok$|listo/, 'fas fa-circle-check'],
	[/pendiente|espera|abiert|open|por_/, 'fas fa-clock'],
	[/proceso|progreso|in_progress|curso|revision|contad|cargad|asignad/, 'fas fa-gears'],
	[/bloque|incidencia|error|diferencia|caducad/, 'fas fa-triangle-exclamation'],
	[/convertid|derivad/, 'fas fa-share'],
];

const BY_TYPE: Record<string, string> = {
	success: 'fas fa-circle-check',
	warning: 'fas fa-clock',
	danger: 'fas fa-circle-xmark',
	info: 'fas fa-circle-info',
	primary: 'fas fa-circle-dot',
	notice: 'fas fa-bell',
	black: 'fas fa-circle-minus',
	secondary: 'fas fa-circle',
	neutral: 'fas fa-circle',
};

export const DEFAULT_STATE_ICON = 'fas fa-circle';

function slug(value: unknown): string {
	return String(value ?? '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '_');
}

/** Ícono por defecto de un estatus sin ícono configurado. */
export function default_state_icon(value: unknown, type?: unknown): string {
	const key = slug(value);
	if (key) {
		for (const [pattern, icon] of BY_VALUE) if (pattern.test(key)) return icon;
	}
	return BY_TYPE[slug(type)] ?? DEFAULT_STATE_ICON;
}

/** El ícono configurado si lo hay; si no, el de `default_state_icon`. */
export function state_icon_or_default(icon: unknown, value: unknown, type?: unknown): string {
	const configured = typeof icon === 'string' ? icon.trim() : '';
	return configured || default_state_icon(value, type);
}
