import { describe, expect, test } from 'bun:test';
import {
	PUBLIC_NAME_MAX_LENGTH,
	read_public_registration,
} from './public-registration.ts';

const valid = {
	name: 'Ana López',
	email: 'ana@correo.mx',
	password: 'una frase larga y fácil',
};

describe('datos del alta pública', () => {
	test('acepta un alta completa y normaliza correo y nombre', () => {
		const read = read_public_registration({
			...valid,
			email: '  Ana@Correo.MX ',
			name: '  Ana   López ',
		});
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.value).toEqual({
			name: 'Ana López',
			email: 'ana@correo.mx',
			password: valid.password,
		});
	});

	test('rechaza correos que no son una dirección', () => {
		// `includes('@')` dejaba pasar `a@b` y `@x.mx`: la cuenta se creaba y
		// ningún correo de pedido o de recuperación podía llegarle nunca.
		for (const email of ['a@b', '@correo.mx', 'ana@', 'ana correo@x.mx', 'ana@x.', 'ana']) {
			const read = read_public_registration({ ...valid, email });
			expect(read.ok).toBe(false);
			if (read.ok) continue;
			expect(read.field).toBe('email');
		}
	});

	test('el nombre es obligatorio y no puede ser solo espacios', () => {
		// Sin nombre la cuenta se llamaba como el correo y así salía en los
		// pedidos y en la lista de usuarios del personal.
		for (const name of ['', '   ', 'A']) {
			const read = read_public_registration({ ...valid, name });
			expect(read.ok).toBe(false);
			if (read.ok) continue;
			expect(read.field).toBe('name');
		}
	});

	test('el nombre tiene tope', () => {
		const read = read_public_registration({
			...valid,
			name: 'x'.repeat(PUBLIC_NAME_MAX_LENGTH + 1),
		});
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.field).toBe('name');
	});

	test('sin contraseña no se llega a crear nada', () => {
		const read = read_public_registration({ ...valid, password: '' });
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.field).toBe('password');
	});

	test('la contraseña no se recorta: los espacios cuentan', () => {
		// La longitud mínima la aplica `prepare_user_write`, el mismo camino
		// que el alta interna; aquí solo se exige que exista.
		const read = read_public_registration({ ...valid, password: '  frase con espacios  ' });
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.value.password).toBe('  frase con espacios  ');
	});

	test('no se cuela nada fuera de la lista blanca', () => {
		const read = read_public_registration({
			...valid,
			_ref: 'seed-admin',
			groups: ['admin'],
			is_admin: true,
			type: 'internal',
		});
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(Object.keys(read.value).sort()).toEqual(['email', 'name', 'password']);
	});
});
