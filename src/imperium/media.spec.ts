import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle_action } from './actions.ts';
import { persist_request_log } from './debug-request-log.ts';
import type { ImperiumDoc } from './envelope.ts';
import { handle_mcp_agent } from './mcp-agent.ts';
import { serve_attachment_bytes, serve_media } from './media.ts';
import { clone_for_request_log } from './router.ts';
import type { ImperiumStore, ModuleLoc } from './store.ts';

function fake_store(
	docs: Record<string, ImperiumDoc | null>,
	has_collection = true,
): ImperiumStore {
	return {
		has: (name: string) => has_collection && name === 'attachment-management',
		find_id: async (_resource: string, id: string) => docs[id] ?? null,
	} as unknown as ImperiumStore;
}

async function read_json(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe('serve_media', () => {
	test('404 JSON si no hay colección o documento', async () => {
		const missing_collection = await serve_media(fake_store({}, false), 'abc');
		expect(missing_collection.status).toBe(404);
		const missing_collection_body = await read_json(missing_collection);
		expect(missing_collection_body.code).toBe('attachment_not_found');

		const missing_doc = await serve_media(fake_store({}), 'abc');
		expect(missing_doc.status).toBe(404);
		const missing_doc_body = await read_json(missing_doc);
		expect(missing_doc_body.code).toBe('attachment_not_found');
		expect(missing_doc_body.message).toBe('No se encontró el archivo.');
	});

	test('imagen sin bytes sirve no-img.jpg', async () => {
		const res = await serve_media(
			fake_store({
				migrated: {
					_id: 'migrated',
					name: 'foto.jpg',
					name_stored: 'no-such-file.jpg',
					mimetype: 'image/jpeg',
				},
			}),
			'migrated',
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/jpeg');
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(bytes[0]).toBe(0xff);
		expect(bytes[1]).toBe(0xd8);
		expect(bytes.length).toBeGreaterThan(1000);
	});

	test('404 JSON si el registro no es imagen y no hay bytes', async () => {
		const res = await serve_media(
			fake_store({
				pdf: {
					_id: 'pdf',
					name: 'acta.pdf',
					name_stored: 'no-such-file.pdf',
					mimetype: 'application/pdf',
				},
			}),
			'pdf',
		);
		expect(res.status).toBe(404);
		const body = await read_json(res);
		expect(body.code).toBe('attachment_bytes_missing');
		expect(String(body.message)).toContain('no hay contenido');
	});

	test('sirve el archivo cuando está en disco', async () => {
		const folder = mkdtempSync(join(tmpdir(), 'imperium-media-'));
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, 'ok.png'), 'PNG');
		const previous = process.env.MULTER_UPLOAD_FOLDER;
		process.env.MULTER_UPLOAD_FOLDER = folder;
		try {
			const res = await serve_media(
				fake_store({
					ok: {
						_id: 'ok',
						name_stored: 'ok.png',
						mimetype: 'image/png',
					},
				}),
				'ok',
			);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toBe('image/png');
			expect(await res.text()).toBe('PNG');
		} finally {
			if (previous === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
			else process.env.MULTER_UPLOAD_FOLDER = previous;
		}
	});

	test('name_stored no alcanza archivos fuera de la carpeta de subidas', async () => {
		const root = mkdtempSync(join(tmpdir(), 'imperium-media-'));
		const folder = join(root, 'subidas');
		mkdirSync(folder);
		const outside = join(root, 'fuera.env');
		writeFileSync(outside, 'SECRETO=1');
		const previous = process.env.MULTER_UPLOAD_FOLDER;
		process.env.MULTER_UPLOAD_FOLDER = folder;
		try {
			for (const name_stored of ['../fuera.env', 'otra/../../fuera.env', outside]) {
				const doc: ImperiumDoc = { _id: 'fuera', name_stored, mimetype: 'text/plain' };
				const res = await serve_media(fake_store({ fuera: doc }), 'fuera');
				expect(res.status).toBe(404);
				expect((await read_json(res)).code).toBe('attachment_bytes_missing');
				expect(await serve_attachment_bytes(doc)).toBeNull();
			}
		} finally {
			if (previous === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
			else process.env.MULTER_UPLOAD_FOLDER = previous;
		}
	});
});

/** Escribe `body` en una carpeta de subidas temporal mientras corre `fn`. */
async function with_upload(
	name: string,
	body: string,
	fn: () => Promise<void>,
): Promise<void> {
	const folder = mkdtempSync(join(tmpdir(), 'imperium-media-'));
	writeFileSync(join(folder, name), body);
	const previous = process.env.MULTER_UPLOAD_FOLDER;
	process.env.MULTER_UPLOAD_FOLDER = folder;
	try {
		await fn();
	} finally {
		if (previous === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
		else process.env.MULTER_UPLOAD_FOLDER = previous;
	}
}

function get(headers: Record<string, string> = {}): Request {
	return new Request('http://imperium.test/api/media/clip', { headers });
}

const CLIP: ImperiumDoc = {
	_id: 'clip',
	name: 'clip',
	file_ext: 'mp4',
	name_stored: 'clip.mp4',
	mimetype: 'video/mp4',
};

describe('serve_media por rangos', () => {
	test('un rango pide solo esos bytes: 206 con Content-Range', async () => {
		await with_upload('clip.mp4', '0123456789', async () => {
			const store = fake_store({ clip: CLIP });
			const middle = await serve_media(store, 'clip', { req: get({ range: 'bytes=2-5' }) });
			expect(middle.status).toBe(206);
			expect(middle.headers.get('content-range')).toBe('bytes 2-5/10');
			expect(middle.headers.get('content-length')).toBe('4');
			expect(middle.headers.get('accept-ranges')).toBe('bytes');
			expect(middle.headers.get('content-type')).toBe('video/mp4');
			expect(await middle.text()).toBe('2345');

			const tail = await serve_media(store, 'clip', { req: get({ range: 'bytes=-3' }) });
			expect(tail.headers.get('content-range')).toBe('bytes 7-9/10');
			expect(await tail.text()).toBe('789');

			const open = await serve_media(store, 'clip', { req: get({ range: 'bytes=6-' }) });
			expect(open.headers.get('content-range')).toBe('bytes 6-9/10');
			expect(await open.text()).toBe('6789');

			const past_end = await serve_media(store, 'clip', { req: get({ range: 'bytes=8-99' }) });
			expect(past_end.headers.get('content-range')).toBe('bytes 8-9/10');
			expect(await past_end.text()).toBe('89');

			const full = await serve_media(store, 'clip', { req: get() });
			expect(full.status).toBe(200);
			expect(full.headers.get('content-length')).toBe('10');
			expect(await full.text()).toBe('0123456789');
		});
	});

	test('reenvuelta como lo hace add_cors, sigue entregando solo el rango', async () => {
		await with_upload('clip.mp4', '0123456789', async () => {
			const res = await serve_media(fake_store({ clip: CLIP }), 'clip', { req: get({ range: 'bytes=2-5' }) });
			const rewrapped = new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
			expect(rewrapped.status).toBe(206);
			expect(await rewrapped.text()).toBe('2345');
		});
	});

	test('un rango fuera del archivo responde 416; uno mal formado o múltiple entrega todo', async () => {
		await with_upload('clip.mp4', '0123456789', async () => {
			const store = fake_store({ clip: CLIP });
			for (const range of ['bytes=10-', 'bytes=10-12', 'bytes=-0']) {
				const res = await serve_media(store, 'clip', { req: get({ range }) });
				expect(res.status).toBe(416);
				expect(res.headers.get('content-range')).toBe('bytes */10');
				expect(res.headers.get('x-content-type-options')).toBe('nosniff');
				expect(await res.text()).toBe('');
			}
			for (const range of ['bytes=5-2', 'bytes=0-1,4-5', 'items=0-3', 'bytes=x-']) {
				const res = await serve_media(store, 'clip', { req: get({ range }) });
				expect(res.status).toBe(200);
				expect(await res.text()).toBe('0123456789');
			}
		});
	});

	test('ETag débil; If-None-Match responde 304 sin cuerpo', async () => {
		await with_upload('clip.mp4', '0123456789', async () => {
			const store = fake_store({ clip: CLIP });
			const first = await serve_media(store, 'clip', { req: get() });
			const etag = String(first.headers.get('etag'));
			expect(etag).toMatch(/^W\/"clip-10-\d+"$/);
			expect(first.headers.get('cache-control')).toBe('private');

			const again = await serve_media(store, 'clip', { req: get({ 'if-none-match': `"otra", ${etag}` }) });
			expect(again.status).toBe(304);
			expect(again.headers.get('etag')).toBe(etag);
			expect(again.headers.get('cache-control')).toBe('private');
			expect(await again.text()).toBe('');

			const changed = await serve_media(store, 'clip', { req: get({ 'if-none-match': 'W/"clip-9-1"' }) });
			expect(changed.status).toBe(200);
		});
	});

	test('If-Range con otra etiqueta entrega el archivo completo', async () => {
		await with_upload('clip.mp4', '0123456789', async () => {
			const store = fake_store({ clip: CLIP });
			const etag = String((await serve_media(store, 'clip', { req: get() })).headers.get('etag'));
			const same = await serve_media(store, 'clip', { req: get({ range: 'bytes=0-1', 'if-range': etag }) });
			expect(same.status).toBe(206);
			expect(await same.text()).toBe('01');
			const stale = await serve_media(store, 'clip', {
				req: get({ range: 'bytes=0-1', 'if-range': 'W/"clip-10-1"' }),
			});
			expect(stale.status).toBe(200);
			expect(await stale.text()).toBe('0123456789');
		});
	});
});

describe('serve_media sin interpretar el contenido', () => {
	async function headers_for(mimetype: string, name: string, file_ext: string) {
		let headers = new Headers();
		await with_upload('archivo.bin', 'contenido', async () => {
			const res = await serve_media(
				fake_store({ doc: { _id: 'doc', name, file_ext, name_stored: 'archivo.bin', mimetype } }),
				'doc',
				{ req: get() },
			);
			expect(res.status).toBe(200);
			headers = res.headers;
		});
		return headers;
	}

	test('imagen, audio, video y PDF van inline; nosniff siempre', async () => {
		for (const [mimetype, ext] of [
			['image/png', 'png'],
			['audio/ogg', 'ogg'],
			['video/webm', 'webm'],
			['application/pdf', 'pdf'],
		] as const) {
			const headers = await headers_for(mimetype, 'evidencia', ext);
			expect(headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''evidencia.${ext}`);
			expect(headers.get('content-security-policy')).toBeNull();
			expect(headers.get('x-content-type-options')).toBe('nosniff');
		}
	});

	test('SVG, HTML y lo demás van como attachment con sandbox', async () => {
		for (const [mimetype, ext] of [
			['image/svg+xml', 'svg'],
			['IMAGE/SVG+XML; charset=utf-8', 'svg'],
			['text/html', 'html'],
			['application/octet-stream', 'exe'],
		] as const) {
			const headers = await headers_for(mimetype, 'pagina', ext);
			expect(headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''pagina.${ext}`);
			expect(headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
			expect(headers.get('x-content-type-options')).toBe('nosniff');
		}
	});

	test('filename* codifica según RFC 5987', async () => {
		const headers = await headers_for('text/plain', "Acta (final) ñ 'v2'*", 'txt');
		expect(headers.get('content-disposition')).toBe(
			"attachment; filename*=UTF-8''Acta%20%28final%29%20%C3%B1%20%27v2%27%2A.txt",
		);
	});

	test('el placeholder de imagen también lleva nosniff', async () => {
		const res = await serve_media(
			fake_store({ gone: { _id: 'gone', name_stored: 'no-such-file.jpg', mimetype: 'image/jpeg' } }),
			'gone',
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});
});

describe('serve_media de adjuntos del chat', () => {
	const messages: Record<string, ImperiumDoc> = {
		vivo: { _id: 'vivo', participantUserIds: ['ana', 'beto'] },
		borrado: { _id: 'borrado', participantUserIds: ['ana', 'beto'], is_active: false },
	};
	function chat_store(related_record_id: string): ImperiumStore {
		const attachment: ImperiumDoc = {
			_id: 'foto',
			related_model: 'Message',
			related_record_id,
			mimetype: 'image/png',
			base64: Buffer.from('foto privada').toString('base64'),
		};
		return {
			has: () => true,
			find_id: async (resource: string, id: string) =>
				resource === 'attachment-management' ? attachment : (messages[id] ?? null),
		} as unknown as ImperiumStore;
	}

	test('solo lo ven sus participantes; sin actor tampoco', async () => {
		const ok = await serve_media(chat_store('vivo'), 'foto', { req: get(), actor: { _id: 'ana' } });
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe('foto privada');
		for (const actor of [{ _id: 'carla' }, null, undefined]) {
			const denied = await serve_media(chat_store('vivo'), 'foto', { req: get(), actor });
			expect(denied.status).toBe(403);
			expect(await read_json(denied)).toEqual({
				message: 'No tienes acceso a este archivo.',
				error: 'No tienes acceso a este archivo.',
				code: 'attachment_forbidden',
			});
		}
		expect((await serve_media(chat_store('vivo'), 'foto')).status).toBe(403);
	});

	test('de un mensaje borrado responde 410', async () => {
		const gone = await serve_media(chat_store('borrado'), 'foto', { req: get(), actor: { _id: 'ana' } });
		expect(gone.status).toBe(410);
		expect((await read_json(gone)).code).toBe('message_gone');
	});
});

describe('bitácora de peticiones', () => {
	test('no lee ni guarda el contenido de un archivo servido', async () => {
		await with_upload('nota.txt', 'secreto del chat', async () => {
			const res = await serve_media(
				fake_store({ nota: { _id: 'nota', name: 'nota', file_ext: 'txt', name_stored: 'nota.txt', mimetype: 'text/plain' } }),
				'nota',
				{ req: get() },
			);
			const logged: ImperiumDoc[] = [];
			const store = {
				has: () => true,
				insert: async (_resource: string, doc: ImperiumDoc) => {
					logged.push(doc);
					return doc;
				},
			} as unknown as ImperiumStore;
			await persist_request_log(store, get(), clone_for_request_log(res), null, Date.now());
			expect(logged.length).toBe(1);
			expect(JSON.stringify(logged)).not.toContain('secreto');
			expect(await res.text()).toBe('secreto del chat');
		});
	});
});

describe('archivo de un adjunto: solo nombres que pone el servidor', () => {
	const AJENO = 'guardado-de-otra-fila';

	test('una fila sin name_stored no sirve el archivo que cita su nombre', async () => {
		await with_upload(AJENO, 'bytes ajenos', async () => {
			const doc: ImperiumDoc = { _id: 'propia', name: AJENO, mimetype: 'text/plain' };
			const res = await serve_media(fake_store({ propia: doc }), 'propia');
			expect(res.status).toBe(404);
			expect((await read_json(res)).code).toBe('attachment_bytes_missing');
			expect(await serve_attachment_bytes(doc)).toBeNull();
		});
	});

	test('la firma de una entrega no guarda el nombre que trae el archivo del cliente', async () => {
		const inserted: ImperiumDoc[] = [];
		const store = {
			has: () => true,
			find_id: async (resource: string, id: string) =>
				resource === 'delivery-package' ? { _id: id, estado: 'cargado' } : null,
			insert: async (_resource: string, doc: ImperiumDoc) => {
				inserted.push(doc);
				return { ...doc, _id: 'firma' };
			},
			update: async () => {
				throw new Error('fin de la prueba');
			},
		} as unknown as ImperiumStore;
		const form = new FormData();
		form.set('event_type', 'delivery');
		form.set('delivery_ticket_reference', 'T-1');
		form.set('signature', new File(['firma del cliente'], AJENO, { type: 'image/png' }));
		const url = new URL('http://imperium.test/api/delivery-package/p1/logistics-event');
		const req = new Request(url, { method: 'POST', body: form });
		await expect(
			handle_action(store, {} as Bun.SQL, req, url, 'delivery-package', 'apply_logistics_event', { id: 'p1' }, {
				_id: 'chofer',
			}),
		).rejects.toThrow('fin de la prueba');
		expect(inserted.length).toBe(1);
		expect(String(inserted[0]?.name_stored ?? '')).toMatch(/^[0-9a-f-]{36}$/);
		await with_upload(AJENO, 'bytes ajenos', async () => {
			const res = await serve_media(fake_store({ firma: { ...inserted[0], _id: 'firma' } }), 'firma');
			expect(await res.text()).toBe('firma del cliente');
		});
	});

	test('MCP no decide qué archivo sirve una fila', async () => {
		const token = 'isic_prueba-archivo';
		const id = 'a'.repeat(24);
		const writes: ImperiumDoc[] = [];
		const loc: ModuleLoc = {
			slug: 'configuracion',
			technical_id: 'subject-configuracion',
			resource: 'attachment-management',
			table: 'attachment_management',
			collection: 'attachment-management',
			name: 'attachment-management',
			columns: [],
		};
		const existing: ImperiumDoc = { _id: id, name: 'acta', name_stored: 'propio', mimetype: 'text/plain' };
		const store = {
			available_mongoose_models: () => [],
			is_model_installed: () => true,
			is_resource_installed: () => true,
			all_locs: [loc],
			loc: () => loc,
			has: (resource: string) => resource === 'mcp-user-token' || resource === 'attachment-management',
			find_where: async () => ({
				_id: 'token-1',
				user_id: 'admin',
				token_hash: createHash('sha256').update(token).digest('hex'),
				last_used_at: new Date().toISOString(),
			}),
			find_id: async (resource: string) =>
				resource === 'user' ? { _id: 'admin', _ref: 'user-menu-management-0' } : existing,
			find_many: async () => ({ rows: [existing], total: 1 }),
			populate_docs: async (_resource: string, docs: ImperiumDoc[]) => docs,
			insert: async (_resource: string, doc: ImperiumDoc) => {
				writes.push(doc);
				return { ...doc, _id: 'b'.repeat(24) };
			},
			update: async (_resource: string, _id: string, doc: ImperiumDoc) => {
				writes.push(doc);
				return { ...existing, ...doc };
			},
		} as unknown as ImperiumStore;
		const ajenos = { name_stored: AJENO, filename: AJENO, base64: 'eA==', data: 'eA==' };
		const send = (method: 'POST' | 'PATCH', path: string) => {
			const url = new URL(`http://imperium.test${path}`);
			const req = new Request(url, {
				method,
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ values: { name: 'acta firmada', ...ajenos } }),
			});
			return handle_mcp_agent(store, {} as Bun.SQL, req, url);
		};
		// El MCP pasa por el CRUD: un adjunto sin archivo subido no nace.
		const created = await send('POST', '/api/mcp-agent/v1/records/attachment-management');
		expect(created.status).toBe(400);
		expect(writes.length).toBe(0);
		const patched = await send('PATCH', `/api/mcp-agent/v1/records/attachment-management/${id}`);
		expect(patched.status).toBe(200);
		expect(writes[0]).toEqual({ name: 'acta firmada' });
		for (const doc of writes) {
			for (const key of Object.keys(ajenos)) expect(doc[key]).toBeUndefined();
		}
	});
});
