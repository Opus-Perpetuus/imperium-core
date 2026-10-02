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
		(r) => r.headers.get('x-core-subject-gateway-secret') === SECRET,
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

describe('files guarda de verdad o falla', () => {
	test('sin almacén responde error: la app no recibe una URL inventada', async () => {
		const req = svc_request('/files', { resource: 'herr-registros', data_base64: 'aG9sYQ==' });
		const res = await handle_service_plane(
			sql,
			() => true,
			req,
			'subject-tienda',
			'/files',
			new URL(req.url),
		);
		expect(res.status).toBe(501);
		expect(((await res.json()) as { data?: unknown }).data).toBeUndefined();
	});

	test('con almacén entrega lo que guardó, a nombre de la app que llama', async () => {
		const saved: Array<{ tid: string; resource: unknown }> = [];
		const out = await call(
			'/files',
			{ resource: 'product-images', record_id: 'p1', data_base64: 'aG9sYQ==' },
			{
				files: {
					save: async (tid, input) => {
						saved.push({ tid, resource: input.resource });
						return {
							id: 'a1',
							resource: String(input.resource),
							record_id: String(input.record_id),
							original_name: 'x',
							content_type: 'image/png',
							size_bytes: 4,
							url: '/api/media/a1',
							created_at: '',
						};
					},
					list: async () => [],
					remove: async () => false,
				},
			},
		);
		expect(saved).toEqual([{ tid: 'subject-tienda', resource: 'product-images' }]);
		expect(out.data?.url).toBe('/api/media/a1');
	});

	test('un archivo rechazado vuelve como error con su motivo', async () => {
		const req = svc_request('/files', { resource: 'r', data_base64: '' });
		const res = await handle_service_plane(
			sql,
			() => true,
			req,
			'subject-tienda',
			'/files',
			new URL(req.url),
			{
				files: {
					save: async () => {
						throw Object.assign(new Error('El archivo no es una imagen válida'), { status: 400 });
					},
					list: async () => [],
					remove: async () => false,
				},
			},
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error?: string }).error).toBe('El archivo no es una imagen válida');
	});
});

describe('verificador del secreto', () => {
	test('si el verificador rechaza, 403 sin tocar la base', async () => {
		let touched = false;
		const spy = {
			unsafe: async () => {
				touched = true;
				return [];
			},
		} as unknown as Bun.SQL;
		const req = svc_request('/html/to-text', { html: 'hola' });
		const seen: string[] = [];
		const res = await handle_service_plane(
			spy,
			(_r, tid) => {
				seen.push(tid);
				return false;
			},
			req,
			'subject-tienda',
			'/html/to-text',
			new URL(req.url),
		);
		expect(res.status).toBe(403);
		expect(seen).toEqual(['subject-tienda']);
		expect(touched).toBe(false);
	});
});
