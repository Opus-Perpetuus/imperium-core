/**
 * Datos del alta de un cliente del sitio público.
 *
 * Solo validaba que hubiera un `@` y una contraseña: `a@b` creaba una cuenta a
 * la que ningún correo podía llegar, y un nombre vacío hacía que el cliente se
 * llamara como su correo en los pedidos y en la lista del personal. Lo que sale
 * de aquí es la lista blanca completa del alta; la longitud de la contraseña la
 * sigue decidiendo `prepare_user_write`, el mismo camino que el alta interna.
 */

export const PUBLIC_NAME_MAX_LENGTH = 120;
const EMAIL_MAX_LENGTH = 254;

/** `usuario@dominio.tld`, sin espacios; lo demás lo decide el buzón. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export type PublicRegistration = { name: string; email: string; password: string };

export type PublicRegistrationRead =
	| { ok: true; value: PublicRegistration }
	| { ok: false; field: 'name' | 'email' | 'password'; message: string };

export function read_public_registration(
	body: Record<string, unknown>,
): PublicRegistrationRead {
	const name = String(body.name ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	const email = String(body.email ?? '')
		.trim()
		.toLowerCase();
	const password = String(body.password ?? '');

	if (name.length < 2) {
		return { ok: false, field: 'name', message: 'Escribe tu nombre.' };
	}
	if (name.length > PUBLIC_NAME_MAX_LENGTH) {
		return {
			ok: false,
			field: 'name',
			message: `El nombre admite hasta ${PUBLIC_NAME_MAX_LENGTH} caracteres.`,
		};
	}
	if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
		return {
			ok: false,
			field: 'email',
			message: 'Escribe un correo válido, como nombre@correo.com.',
		};
	}
	if (!password) {
		return { ok: false, field: 'password', message: 'Escribe una contraseña.' };
	}
	return { ok: true, value: { name, email, password } };
}
