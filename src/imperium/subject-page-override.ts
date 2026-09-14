/**
 * Personalización de las páginas públicas de una app.
 *
 * Una app sirve sus páginas ya armadas y **vivas**: la rejilla del catálogo
 * lleva los productos de este momento, el carrito las líneas de quien mira. Por
 * eso una personalización no puede ser «guarda este descriptor y sírvelo»: eso
 * congelaría el catálogo en lo que hubiera el día que se publicó.
 *
 * Lo que se guarda es el **marco**: lo que va antes y después del contenido de
 * la app. El marco es un descriptor normal —lo valida y lo edita lo mismo que
 * la portada del sitio— con un hueco marcado donde se inyecta, en cada
 * petición, el árbol que acaba de construir la app. Si alguien borra el hueco,
 * el contenido de la app se añade al final: nunca se pierde.
 *
 * La app no se entera de nada de esto: sigue sirviendo su página igual, y el
 * núcleo es quien mezcla.
 */

/** Marca del hueco donde entra el contenido vivo de la app. */
export const APP_CONTENT_BLOCK = 'contenido-de-la-app';

/** Clave de almacenamiento: una personalización por página y por app. */
export function subject_override_slug(
	technical_id: string,
	page_id: string,
): string {
	return `app:${technical_id}:${page_id}`;
}

function is_node(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function is_slot(node: Record<string, unknown>): boolean {
	const props = node['props'];
	return is_node(props) && props['block'] === APP_CONTENT_BLOCK;
}

/**
 * Copia el marco rellenando el hueco con el contenido de la app.
 * Devuelve si llegó a encontrarlo, para saber si hace falta el respaldo.
 */
function fill_slot(
	node: unknown,
	content: unknown,
): { node: unknown; filled: boolean } {
	if (!is_node(node)) return { node, filled: false };
	if (is_slot(node)) {
		return { node: { ...node, children: [content] }, filled: true };
	}
	const children = node['children'];
	if (!Array.isArray(children)) return { node, filled: false };
	let filled = false;
	const next = children.map((child) => {
		const result = fill_slot(child, content);
		if (result.filled) filled = true;
		return result.node;
	});
	return filled ? { node: { ...node, children: next }, filled } : { node, filled };
}

/**
 * Página de la app + personalización publicada.
 *
 * Sin personalización utilizable devuelve la página de la app tal cual: el
 * escaparate funciona por defecto, con o sin nadie que lo haya configurado.
 */
export function merge_subject_page(
	app_doc: unknown,
	override: unknown,
): unknown {
	if (!is_node(app_doc)) return app_doc;
	if (!is_node(override)) return app_doc;
	const frame = override['page'];
	if (!is_node(frame)) return app_doc;

	const content = app_doc['page'];
	const filled = fill_slot(frame, content);
	// Sin hueco, el contenido de la app va al final del marco. Perder la página
	// de la app porque alguien borró un bloque en el editor no es aceptable.
	const page = filled.filled
		? filled.node
		: {
				...frame,
				children: [
					...(Array.isArray(frame['children']) ? frame['children'] : []),
					content,
				],
			};

	// El título es de la app, no del marco: el descriptor guardado necesita uno
	// para pasar la validación, así que el suyo es solo el nombre con el que se
	// reconoce la personalización en el administrador. Tomarlo aquí renombraría
	// cada página con el que trajera el editor por defecto.
	return { ...app_doc, page };
}

/**
 * Personalización de arranque: el hueco de la app y nada más.
 *
 * Así, al abrir el editor por primera vez, lo que se ve publicado es
 * exactamente lo que la app ya servía, y a partir de ahí se le añade. El
 * título solo nombra la fila en el administrador; la página conserva el suyo.
 */
export function default_subject_override(
	title: string,
): Record<string, unknown> {
	return {
		title,
		page: {
			component: 'nox.stack',
			props: { gap: 'md' },
			children: [{ component: 'nox.stack', props: { block: APP_CONTENT_BLOCK } }],
		},
	};
}
