/**
 * Entrada de menú de Escritorio (instaladores, puente CONTPAQi, impresoras).
 *
 * La ruta Angular `/escritorio` ya está registrada; sin fila de menú no aparece
 * en el lanzador. Idempotente por `_ref`. `model` vacío: no es un CRUD.
 */

export const ESCRITORIO_MENU_REF = 'escritorio-menu-management-0';
export const ESCRITORIO_MENU_PATH = '/escritorio';

export type MenuRow = {
	_id?: unknown;
	_ref?: unknown;
	parent_id?: unknown;
	[key: string]: unknown;
};

export type EscritorioMenuPlan =
	| { insert: false }
	| { insert: true; row: Record<string, unknown> };

/**
 * Qué falta para que Escritorio sea alcanzable desde el menú.
 */
export function plan_escritorio_menu(existing: MenuRow[]): EscritorioMenuPlan {
	if (existing.some((row) => String(row._ref ?? '') === ESCRITORIO_MENU_REF)) {
		return { insert: false };
	}
	return {
		insert: true,
		row: {
			_ref: ESCRITORIO_MENU_REF,
			name: 'Escritorio',
			description:
				'Instaladores, puente CONTPAQi e impresoras de este equipo.',
			path: ESCRITORIO_MENU_PATH,
			icon: 'fa-desktop',
			order: 40,
			is_active: true,
			model: '',
		},
	};
}
