/**
 * Entrada de menú del editor de la landing pública.
 *
 * El portal ya tenía API de borrador y publicación, y la propia landing por
 * defecto dice «configura esta landing desde el administrador» — pero no había
 * pantalla ni forma de llegar a ella. Sin fila de menú, una pantalla nueva del
 * núcleo es inalcanzable: los menús viven en la base del tenant, no en el
 * catálogo.
 *
 * Se siembra con la misma idea que los parámetros de configuración: idempotente
 * por `_ref`, sin tocar nada de lo que ya exista.
 */

export const PORTAL_LANDING_MENU_REF = 'portal-landing-menu-management-0';
export const PORTAL_LANDING_PATH = '/portal-landing';

export const PUBLIC_APP_PAGES_MENU_REF = 'public-app-pages-menu-management-0';
export const PUBLIC_APP_PAGES_PATH = '/paginas-publicas';

/** Raíz «Configuración» del lanzador, donde cuelga el editor. */
const SETTINGS_ROOT_REF = 'module-management-menu-root-settings';

export type MenuRow = {
	_id?: unknown;
	_ref?: unknown;
	parent_id?: unknown;
	[key: string]: unknown;
};

/**
 * Pantallas del portal que necesitan fila de menú.
 *
 * La personalización de las páginas públicas de las apps llega por la misma
 * puerta que el editor de la portada: es el mismo trabajo —componer lo que ve
 * quien no ha entrado— sobre una página distinta.
 */
const PORTAL_MENUS: Array<{
	ref: string;
	name: string;
	description: string;
	path: string;
	icon: string;
	order: number;
}> = [
	{
		ref: PORTAL_LANDING_MENU_REF,
		name: 'Página de inicio pública',
		description:
			'Edita y publica la landing que ven los visitantes sin sesión.',
		path: PORTAL_LANDING_PATH,
		icon: 'fa-window-maximize',
		order: 90,
	},
	{
		ref: PUBLIC_APP_PAGES_MENU_REF,
		name: 'Páginas públicas de las apps',
		description:
			'Personaliza el marco de las páginas que las apps abren al público.',
		path: PUBLIC_APP_PAGES_PATH,
		icon: 'fa-store',
		order: 91,
	},
];

/** Filas de menú que faltan por sembrar; vacío si no hay nada que hacer. */
export function plan_portal_menus(
	existing: MenuRow[],
): Array<Record<string, unknown>> {
	const root = existing.find(
		(row) => String(row._ref ?? '') === SETTINGS_ROOT_REF,
	);
	if (!root) return [];
	const present = new Set(existing.map((row) => String(row._ref ?? '')));
	return PORTAL_MENUS.filter((menu) => !present.has(menu.ref)).map((menu) => ({
		_ref: menu.ref,
		name: menu.name,
		description: menu.description,
		path: menu.path,
		icon: menu.icon,
		parent_id: root._id ?? root.id,
		order: menu.order,
		is_active: true,
		// Vacío a propósito: el filtro del ACL solo exige modelo cuando la
		// entrada representa un CRUD, y estas son pantallas del núcleo.
		model: '',
	}));
}
