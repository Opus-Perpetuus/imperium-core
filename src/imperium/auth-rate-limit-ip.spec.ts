import { afterEach, describe, expect, test } from 'bun:test';
import { remember_socket_ip, request_ip, request_ip_names_client } from './auth-rate-limit.ts';

const ORIGINAL = process.env.TRUST_PROXY_HEADERS;

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.TRUST_PROXY_HEADERS;
	else process.env.TRUST_PROXY_HEADERS = ORIGINAL;
});

function peticion(headers: Record<string, string> = {}): Request {
	return new Request('http://t/api/auth/public/register', {
		method: 'POST',
		headers,
	});
}

describe('IP para el limitador', () => {
	test('sin proxy declarado manda el socket, no la cabecera del cliente', () => {
		// Fiarse de `x-forwarded-for` deja el cubo por IP esquivable: rotando la
		// cabecera se estrena cubo en cada intento y el límite no limita nada.
		delete process.env.TRUST_PROXY_HEADERS;
		const req = peticion({ 'x-forwarded-for': '1.2.3.4' });
		remember_socket_ip(req, '10.0.0.9');
		expect(request_ip(req)).toBe('10.0.0.9');
	});

	test('tampoco se puede envenenar el cubo de otra persona', () => {
		// Mandando la IP de una víctima se le consumía su cubo y se le dejaba
		// fuera; ahora esa cabecera no decide nada.
		delete process.env.TRUST_PROXY_HEADERS;
		const victima = peticion({
			'x-forwarded-for': '203.0.113.7',
			'x-real-ip': '203.0.113.7',
		});
		remember_socket_ip(victima, '10.0.0.9');
		expect(request_ip(victima)).not.toBe('203.0.113.7');
	});

	test('con proxy declarado sí se cree la cabecera, que es para lo que está', () => {
		process.env.TRUST_PROXY_HEADERS = '1';
		const req = peticion({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });
		remember_socket_ip(req, '10.0.0.9');
		expect(request_ip(req)).toBe('1.2.3.4');
	});

	test('sin socket ni proxy declarado no revienta', () => {
		delete process.env.TRUST_PROXY_HEADERS;
		expect(request_ip(peticion())).toBe('unknown');
	});

	test('cada petición lleva su propia IP', () => {
		delete process.env.TRUST_PROXY_HEADERS;
		const a = peticion();
		const b = peticion();
		remember_socket_ip(a, '10.0.0.1');
		remember_socket_ip(b, '10.0.0.2');
		expect(request_ip(a)).toBe('10.0.0.1');
		expect(request_ip(b)).toBe('10.0.0.2');
	});
});

describe('¿la IP nombra al cliente?', () => {
	test('una dirección privada sin proxy declarado es la del proxy o la red interna, no la de un cliente', () => {
		delete process.env.TRUST_PROXY_HEADERS;
		for (const ip of [
			'10.0.0.9',
			'172.18.0.5',
			'192.168.1.20',
			'127.0.0.1',
			'169.254.1.1',
			'100.64.0.1',
			'::1',
			'::ffff:172.18.0.5',
			'fd12:3456::1',
			'fe80::1',
		]) {
			const req = peticion();
			remember_socket_ip(req, ip);
			expect(`${ip} ${request_ip_names_client(req)}`).toBe(`${ip} false`);
		}
		expect(request_ip_names_client(peticion())).toBe(false);
	});

	test('una pública directa sí, y la que reenvía un proxy declarado también', () => {
		delete process.env.TRUST_PROXY_HEADERS;
		for (const ip of ['203.0.113.9', '172.32.0.1', '::ffff:198.51.100.7', '2001:db8::5']) {
			const req = peticion();
			remember_socket_ip(req, ip);
			expect(`${ip} ${request_ip_names_client(req)}`).toBe(`${ip} true`);
		}
		process.env.TRUST_PROXY_HEADERS = '1';
		const forwarded = peticion({ 'x-forwarded-for': '198.51.100.7' });
		remember_socket_ip(forwarded, '172.18.0.5');
		expect(request_ip_names_client(forwarded)).toBe(true);
		const without_header = peticion();
		remember_socket_ip(without_header, '172.18.0.5');
		expect(request_ip_names_client(without_header)).toBe(false);
	});
});
