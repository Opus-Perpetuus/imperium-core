/**
 * Sirve adjuntos desde SQL + disco (mismo contrato que GET /media/:id).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const UPLOAD_FOLDERS = [
	process.env.MULTER_UPLOAD_FOLDER,
	'/home/uploads',
	join(import.meta.dir, '../../../../backend/uploads'),
].filter((p): p is string => Boolean(p));

export async function serve_media(
	store: ImperiumStore,
	id: string,
): Promise<Response> {
	if (!id || !store.has('attachment-management')) {
		return new Response('Forbidden', { status: 403 });
	}
	const doc = await store.find_id('attachment-management', id);
	if (!doc) return new Response('Forbidden', { status: 403 });
	const served = await serve_attachment_bytes(doc);
	if (!served) return new Response('Forbidden', { status: 403 });
	return new Response(served.body, {
		headers: { 'content-type': served.mime },
	});
}

export async function serve_attachment_bytes(
	doc: ImperiumDoc,
): Promise<{ body: Uint8Array; mime: string } | null> {
	const mime = String(doc.mimetype ?? doc.mime ?? 'application/octet-stream');
	const stored = String(doc.name_stored ?? doc.filename ?? doc.name ?? '').trim();
	if (stored) {
		for (const folder of UPLOAD_FOLDERS) {
			const full = join(folder, stored);
			if (existsSync(full)) {
				return { body: readFileSync(full), mime };
			}
		}
	}
	const b64 = String(doc.base64 ?? doc.data ?? '').trim();
	if (b64) {
		try {
			return { body: Buffer.from(b64, 'base64'), mime };
		} catch {
			return null;
		}
	}
	return null;
}
