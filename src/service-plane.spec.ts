import { describe, expect, test } from 'bun:test';
import { handle_service_plane } from './service-plane.ts';

const SECRET = 'svc-test-secret';

/** El plano de servicios toca Postgres en cada llamada salvo notify/html. */
const sql = {
	unsafe: async () => [],
} as unknown as Bun.SQL;

function svc_request(path: string, body: unknown): Request {
	return new Request(`http://core/api/subjects/svc/subject-tienda${path}`, {
		method: 'POST',
		headers: {
			'x-core-subject-gateway-secret': SECRET,
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
}

async function call(
	path: string,
	body: unknown,
	deps?: Parameters<typeof handle_service_plane>[6],
) {
	const req = svc_request(path, body);
	const res = await handle_service_plane(
		sql,
		SECRET,
		req,
		'subject-tienda',
		path,
		new URL(req.url),
		deps,
	);
	return (await res.json()) as { data?: Record<string, unknown> };
}

describe('notify entrega por correo', () => {
	test('con transporte, el aviso sale y la app lo sabe', async () => {
		const sent: Array<{ to: string; title: string }> = [];
		const out = await call(
			'/notify',
			{ email: 'cliente@ejemplo.mx', title: 'Pedido pagado', body: 'Gracias' },
			{ send_email: async (input) => void sent.push(input) },
		);
		expect(out.data?.delivered).toBe(true);
		expect(sent).toEqual([
			{ to: 'cliente@ejemplo.mx', title: 'Pedido pagado', body: 'Gracias' },
		]);
	});

	test('sin destinatario no se inventa un envío', async () => {
		const out = await call(
			'/notify',
			{ title: 'Pedido pagado' },
			{ send_email: async () => void 0 },
		);
		expect(out.data?.delivered).toBe(false);
	});

	test('un SMTP caído no tumba la operación que disparó el aviso', async () => {
		const out = await call(
			'/notify',
			{ email: 'cliente@ejemplo.mx', title: 'Pedido pagado' },
			{
				send_email: async () => {
					throw new Error('conexión rechazada');
				},
			},
		);
		expect(out.data?.delivered).toBe(false);
		expect(String(out.data?.error)).toContain('conexión rechazada');
	});
});

describe('html/sanitize limpia de verdad', () => {
	test('usa el sanitizador del núcleo cuando está disponible', async () => {
		const out = await call(
			'/html/sanitize',
			{ html: '<p onclick="x()">hola</p>' },
			{ sanitize_html: (html) => html.replace(/ on\w+="[^"]*"/g, '') },
		);
		expect(out.data?.html).toBe('<p>hola</p>');
	});

	test('sin sanitizador se degrada a texto plano, no a pasamanos', async () => {
		const out = await call('/html/sanitize', {
			html: '<script>alert(1)</script>hola',
		});
		expect(String(out.data?.html)).not.toContain('<script');
		expect(String(out.data?.html)).toContain('hola');
	});
});
