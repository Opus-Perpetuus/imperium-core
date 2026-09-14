/**
 * Sirve adjuntos desde SQL + disco (mismo contrato que GET /media/:id).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { resolve_upload_folders } from './uploads.ts';

const ATTACHMENT_NOT_FOUND = 'No se encontró el archivo.';
const ATTACHMENT_BYTES_MISSING =
	'El archivo está registrado pero no hay contenido para mostrar.';
const IMAGE_NAME = /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i;
const MISSING_IMAGE_PATH = join(import.meta.dir, 'assets', 'no-img.jpg');

function media_missing(message: string, code: string): Response {
	return Response.json({ error: message, message, code }, { status: 404 });
}

export function is_image_attachment(doc: ImperiumDoc): boolean {
	const mime = String(doc.mimetype ?? doc.mime ?? '').toLowerCase();
	if (mime.startsWith('image/')) return true;
	const names = [doc.name_stored, doc.filename, doc.name, doc.file_ext]
		.map((value) => String(value ?? '').trim())
		.filter(Boolean);
	return names.some((name) => IMAGE_NAME.test(name.includes('.') ? name : `.${name}`));
}

function missing_image_placeholder(): Response | null {
	if (!existsSync(MISSING_IMAGE_PATH)) return null;
	return new Response(readFileSync(MISSING_IMAGE_PATH), {
		headers: { 'content-type': 'image/jpeg' },
	});
}

export async function serve_media(
	store: ImperiumStore,
	id: string,
): Promise<Response> {
	if (!id || !store.has('attachment-management')) {
		return media_missing(ATTACHMENT_NOT_FOUND, 'attachment_not_found');
	}
	const doc = await store.find_id('attachment-management', id);
	if (!doc) return media_missing(ATTACHMENT_NOT_FOUND, 'attachment_not_found');
	const served = await serve_attachment_bytes(doc);
	if (!served) {
		if (is_image_attachment(doc)) {
			const placeholder = missing_image_placeholder();
			if (placeholder) return placeholder;
		}
		return media_missing(ATTACHMENT_BYTES_MISSING, 'attachment_bytes_missing');
	}
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
		for (const folder of resolve_upload_folders()) {
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
