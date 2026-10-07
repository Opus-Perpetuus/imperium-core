const BASE = 'https://imperium.invalid';
/** El navegador lee `\` como `/` y descarta tabuladores y saltos: `/\host` o `/<TAB>/host` saltan a otro sitio. */
const UNSAFE = /[\\\u0000-\u001f\u007f]/;

/** Una pantalla interna de esta misma app (`/internal/…`), o null si la ruta sale de ella. */
export function internal_route(value: unknown, max = 2000): string | null {
	const route = String(value ?? '').trim();
	if (!route.startsWith('/internal/') || route.length > max || UNSAFE.test(route)) return null;
	const url = new URL(route, BASE);
	return url.origin === BASE && url.pathname.startsWith('/internal/') ? route : null;
}
