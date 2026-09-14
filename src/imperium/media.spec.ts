import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImperiumDoc } from './envelope.ts';
import { serve_media } from './media.ts';
import type { ImperiumStore } from './store.ts';

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
});
