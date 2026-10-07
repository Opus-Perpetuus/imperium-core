/**
 * Sirve adjuntos desde SQL + disco (mismo contrato que GET /media/:id).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert_attachment_access, ChatError } from './chat-access.ts';
import { fail, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { resolve_upload_folders, upload_file_path } from './uploads.ts';

const ATTACHMENT_NOT_FOUND = 'No se encontró el archivo.';
const ATTACHMENT_BYTES_MISSING =
	'El archivo está registrado pero no hay contenido para mostrar.';
const IMAGE_NAME = /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i;
const MISSING_IMAGE_PATH = join(import.meta.dir, 'assets', 'no-img.jpg');
const NOSNIFF = { 'x-content-type-options': 'nosniff' };

function media_missing(message: string, code: string): Response {
	return Response.json({ error: message, message, code }, { status: 404, headers: NOSNIFF });
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
		headers: { ...NOSNIFF, 'content-type': 'image/jpeg' },
	});
}

/** Sin `actor`, un adjunto del chat se niega: solo los demás se sirven a cualquier sesión. */
export async function serve_media(
	store: ImperiumStore,
	id: string,
	opts: { req?: Request; actor?: ImperiumDoc | null; token_user_id?: string } = {},
): Promise<Response> {
	if (!id || !store.has('attachment-management')) {
		return media_missing(ATTACHMENT_NOT_FOUND, 'attachment_not_found');
	}
	const doc = await store.find_id('attachment-management', id);
	if (!doc) return media_missing(ATTACHMENT_NOT_FOUND, 'attachment_not_found');
	try {
		await assert_attachment_access(store, opts.actor ?? null, doc, { token_user_id: opts.token_user_id });
	} catch (err) {
		if (!(err instanceof ChatError)) throw err;
		return Response.json(fail(err.message, err.status, { code: err.code }).body, {
			status: err.status,
			headers: NOSNIFF,
		});
	}
	const source = await media_source(doc);
	if (!source) {
		if (is_image_attachment(doc)) {
			const placeholder = missing_image_placeholder();
			if (placeholder) return placeholder;
		}
		return media_missing(ATTACHMENT_BYTES_MISSING, 'attachment_bytes_missing');
	}
	return serve_source(doc, source, opts.req);
}

type MediaSource = { blob: Blob; mtime_ms: number };

/** El archivo en disco se sirve por rebanadas, sin leerlo completo. */
async function media_source(doc: ImperiumDoc): Promise<MediaSource | null> {
	const full = stored_file_path(doc);
	if (full) {
		const file = Bun.file(full);
		return { blob: file, mtime_ms: file.lastModified };
	}
	const inline = await serve_attachment_bytes(doc);
	if (!inline) return null;
	const updated = Date.parse(String(doc.updated_at ?? doc.updatedAt ?? ''));
	return { blob: new Blob([inline.body]), mtime_ms: Number.isFinite(updated) ? updated : 0 };
}

function serve_source(doc: ImperiumDoc, source: MediaSource, req?: Request): Response {
	const mime = String(doc.mimetype ?? doc.mime ?? 'application/octet-stream');
	const size = source.blob.size;
	const etag = `W/"${String(doc._id ?? '')}-${size}-${Math.trunc(source.mtime_ms)}"`;
	const cache = { ...NOSNIFF, etag, 'cache-control': 'private' };
	if (etag_listed(req?.headers.get('if-none-match'), etag)) {
		return new Response(null, { status: 304, headers: cache });
	}
	const inline = is_inline_type(mime);
	const headers: Record<string, string> = {
		...cache,
		'content-type': mime,
		'accept-ranges': 'bytes',
		'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${rfc5987(download_name(doc))}`,
	};
	// Lo que no se muestra inline no debe ejecutar nada si alguien lo abre en el navegador.
	if (!inline) headers['content-security-policy'] = "sandbox; default-src 'none'";
	const range = req ? requested_range(req, etag, size) : null;
	if (range === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { ...NOSNIFF, 'content-range': `bytes */${size}` },
		});
	}
	if (range) {
		headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
		headers['content-length'] = String(range.end - range.start + 1);
		// Por stream: Bun 1.3, al reenvolver la respuesta (add_cors), ignora el
		// fin de un Blob rebanado y manda hasta el final del archivo.
		const part = source.blob.slice(range.start, range.end + 1).stream();
		return new Response(part, { status: 206, headers });
	}
	headers['content-length'] = String(size);
	return new Response(source.blob, { headers });
}

function is_inline_type(mime: string): boolean {
	const essence = mime.split(';')[0]!.trim().toLowerCase();
	if (essence === 'image/svg+xml') return false;
	return (
		essence.startsWith('image/') ||
		essence.startsWith('audio/') ||
		essence.startsWith('video/') ||
		essence === 'application/pdf'
	);
}

function download_name(doc: ImperiumDoc): string {
	const base = String(doc.name ?? '').trim() || 'adjunto';
	const ext = String(doc.file_ext ?? '').trim();
	if (!ext || base.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return base;
	return `${base}.${ext}`;
}

function rfc5987(value: string): string {
	return encodeURIComponent(value).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function etag_listed(header: string | null | undefined, etag: string): boolean {
	if (!header) return false;
	const opaque = etag.replace(/^W\//, '');
	return header
		.split(',')
		.map((tag) => tag.trim())
		.some((tag) => tag === '*' || tag.replace(/^W\//, '') === opaque);
}

/**
 * Un solo rango `bytes=`; otra forma se ignora y va el archivo completo.
 * If-Range compara la etiqueta tal cual aunque sea débil: sale del id, el
 * tamaño y la fecha del archivo, así que cambia con cualquier byte.
 */
function requested_range(
	req: Request,
	etag: string,
	size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
	const header = req.headers.get('range');
	if (!header) return null;
	const if_range = req.headers.get('if-range');
	if (if_range !== null && if_range.trim() !== etag) return null;
	const match = header.trim().match(/^bytes=(\d*)-(\d*)$/);
	if (!match || (!match[1] && !match[2])) return null;
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!suffix || !size) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	if (match[2] && Number(match[2]) < start) return null;
	if (start >= size) return 'unsatisfiable';
	return { start, end: match[2] ? Math.min(Number(match[2]), size - 1) : size - 1 };
}

function stored_file_path(doc: ImperiumDoc): string | null {
	const stored = String(doc.name_stored ?? doc.filename ?? '').trim();
	if (!stored) return null;
	for (const folder of resolve_upload_folders()) {
		const full = upload_file_path(folder, stored);
		if (full && existsSync(full)) return full;
	}
	return null;
}

export async function serve_attachment_bytes(
	doc: ImperiumDoc,
): Promise<{ body: Uint8Array; mime: string } | null> {
	const mime = String(doc.mimetype ?? doc.mime ?? 'application/octet-stream');
	const full = stored_file_path(doc);
	if (full) return { body: readFileSync(full), mime };
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
