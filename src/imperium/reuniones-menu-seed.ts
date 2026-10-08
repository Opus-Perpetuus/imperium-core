/**
 * Entrada de menú de Reuniones (próximas, salas permanentes y pasadas).
 *
 * La pantalla vive en el núcleo (`/internal/reuniones`) y sin fila de menú no aparece en el
 * lanzador. Idempotente por `_ref`. `model` vacío: no es un CRUD.
 */
import type { MenuRow } from './escritorio-menu-seed.ts';

export const REUNIONES_MENU_REF = 'reuniones-menu-management-0';
/** El lanzador antepone `/internal`. */
export const REUNIONES_MENU_PATH = '/reuniones';

export type ReunionesMenuPlan = { insert: false } | { insert: true; row: Record<string, unknown> };

export function plan_reuniones_menu(existing: MenuRow[]): ReunionesMenuPlan {
	if (existing.some((row) => String(row._ref ?? '') === REUNIONES_MENU_REF)) return { insert: false };
	return {
		insert: true,
		row: {
			_ref: REUNIONES_MENU_REF,
			name: 'Reuniones',
			description: 'Reuniones programadas, salas permanentes y clases con enlace para invitar.',
			path: REUNIONES_MENU_PATH,
			icon: 'fa-video',
			order: 41,
			is_active: true,
			model: '',
		},
	};
}
