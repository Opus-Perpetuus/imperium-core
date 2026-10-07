import { describe, expect, test } from 'bun:test';
import { query_list, read_imperium_body } from './body.ts';

function list_take(search: string) {
	return query_list(new URL(`https://imperium.local/list${search}`)).take;
}

describe('query_list', () => {
	test('limite mayor a 200 se recorta a 200', () => {
		expect(list_take('?limite=201')).toBe(200);
		expect(list_take('?limite=10000')).toBe(200);
		expect(list_take('?take=500')).toBe(200);
	});

	test('un limite válido se respeta', () => {
		expect(list_take('?limite=1')).toBe(1);
		expect(list_take('?limite=50')).toBe(50);
		expect(list_take('?limite=199')).toBe(199);
		expect(list_take('?limite=200')).toBe(200);
		expect(list_take('?take=25')).toBe(25);
		expect(list_take('')).toBe(100);
	});
});

describe('read_imperium_body', () => {
	function post(form: FormData): Request {
		return new Request('http://imperium.test/api/messages/chat', { method: 'POST', body: form });
	}

	test('varios archivos con la misma clave llegan todos y en orden; uno solo sigue siendo un Blob', async () => {
		const form = new FormData();
		form.append('message', 'hola');
		form.append('attachments', new File(['uno'], 'uno.txt', { type: 'text/plain' }));
		form.append('attachments', new File(['dos'], 'dos.txt', { type: 'text/plain' }));
		form.append('attachments', new File(['tres'], 'tres.txt', { type: 'text/plain' }));
		form.append('foto', new File(['f'], 'f.png', { type: 'image/png' }));
		const body = await read_imperium_body(post(form));
		expect((body.attachments as File[]).map((file) => file.name)).toEqual(['uno.txt', 'dos.txt', 'tres.txt']);
		expect(body.foto).toBeInstanceOf(Blob);
		expect(body.message).toBe('hola');
	});

	test('también con el cuerpo empaquetado en imperium-sic__data__', async () => {
		const form = new FormData();
		form.append('imperium-sic__data__', JSON.stringify({ recipient_user_id: 'u1' }));
		form.append('attachments', new File(['uno'], 'uno.txt'));
		form.append('attachments', new File(['dos'], 'dos.txt'));
		const body = await read_imperium_body(post(form));
		expect((body.attachments as File[]).map((file) => file.name)).toEqual(['uno.txt', 'dos.txt']);
		expect(body.recipient_user_id).toBe('u1');
	});
});
