/**
 * Persistencia de adjuntos: mismo contrato que multer + AttachmentManagementService.
 * El front manda multipart (`File` + `imperium-sic__data__`); sin esto el SQL
 * serializa el File a `{}` y GET /media no tiene bytes.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';

const MIME_PERMITIDOS = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/bmp',
	'image/tiff',
	'image/svg+xml',
	'application/pdf',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'text/plain',
	'text/csv',
	'application/zip',
	'application/x-rar-compressed',
]);

const EXT_PERMITIDAS = new Set([
	'jpg',
	'jpeg',
	'png',
	'gif',
	'webp',
	'bmp',
	'tiff',
	'tif',
	'svg',
	'pdf',
	'doc',
	'docx',
	'xls',
	'xlsx',
	'txt',
	'csv',
	'zip',
	'rar',
]);

const LIMITE_IMAGEN = 10 * 1024 * 1024;
const LIMITE_OTROS = 50 * 1024 * 1024;

export function resolve_upload_folders(): string[] {
	return [
		process.env.MULTER_UPLOAD_FOLDER,
		writable_upload_folder(),
		'/home/uploads',
	].filter((p, i, all): p is string => Boolean(p) && all.indexOf(p) === i);
}

export function writable_upload_folder(): string {
	const env = process.env.MULTER_UPLOAD_FOLDER?.trim();
	if (env) return env;
	return join(import.meta.dir, '../../../../backend/uploads');
}

export function is_upload(value: unknown): value is Blob {
	if (value == null || typeof value !== 'object') return false;
	if (typeof File !== 'undefined' && value instanceof File) return true;
	if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
	return false;
}

export async function apply_uploads(
	store: ImperiumStore,
	resource: string,
	doc: ImperiumDoc,
	actor: ImperiumDoc | null,
	opts: { method?: string; record_id?: string } = {},
): Promise<ImperiumDoc> {
	const out: ImperiumDoc = { ...doc };
	delete out['imperium-sic__data__'];
	const actor_id = String(actor?._id ?? actor?.id ?? '').trim();
	const record_id = String(opts.record_id ?? out._id ?? out.id ?? '').trim();

	if (resource === 'attachment-management') {
		const file = take_upload(out, 'file') ?? first_upload(out);
		if (file) {
			const saved = await persist_blob(file, {
				related_model: String(out.related_model ?? 'AttachmentManagement'),
			});
			const name = filename_without_extension(file_name(file));
			const fallback = String(out.name ?? '').trim() || name || 'archivo';
			out.name = name.length >= 4 ? name : fallback;
			if (String(out.name).length < 4) out.name = `file-${out.name}`;
			out.name_stored = saved.filename;
			out.mimetype = saved.mime;
			out.file_ext = saved.ext;
			out.size_in_kb = saved.bytes.length / 1024;
			out.created_by_id = out.created_by_id ?? actor_id;
			out.related_model =
				out.related_model || 'AttachmentManagement';
			out.field = out.field || 'file';
			out.is_active = out.is_active !== false;
		} else if (!String(out.name_stored ?? out.base64 ?? '').trim()) {
			throw new Error('No se ha subido un archivo');
		}
		strip_uploads(out);
		return out;
	}

	for (const [key, value] of Object.entries(out)) {
		if (is_upload(value)) {
			const att = await persist_and_insert(store, value, {
				actor_id,
				related_model: resource,
				related_record_id: record_id,
				field: key,
				index_if_is_array: 0,
				inside_array: false,
			});
			out[key] = String(att._id);
			continue;
		}
		if (!Array.isArray(value)) continue;
		const next: unknown[] = [];
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (!is_upload(item)) {
				next.push(item);
				continue;
			}
			const att = await persist_and_insert(store, item, {
				actor_id,
				related_model: resource,
				related_record_id: record_id,
				field: `${key}[${i}]`,
				index_if_is_array: i,
				inside_array: true,
			});
			next.push(String(att._id));
		}
		out[key] = next;
	}
	return out;
}

function take_upload(doc: ImperiumDoc, key: string): Blob | null {
	const value = doc[key];
	if (!is_upload(value)) return null;
	delete doc[key];
	return value;
}

function first_upload(doc: ImperiumDoc): Blob | null {
	for (const [key, value] of Object.entries(doc)) {
		if (!is_upload(value)) continue;
		delete doc[key];
		return value;
	}
	return null;
}

function strip_uploads(doc: ImperiumDoc) {
	for (const [key, value] of Object.entries(doc)) {
		if (is_upload(value)) delete doc[key];
	}
}

async function persist_and_insert(
	store: ImperiumStore,
	file: Blob,
	meta: {
		actor_id: string;
		related_model: string;
		related_record_id: string;
		field: string;
		index_if_is_array: number;
		inside_array: boolean;
	},
): Promise<ImperiumDoc> {
	if (!store.has('attachment-management')) {
		throw new Error('Sin adjuntos');
	}
	const saved = await persist_blob(file, { related_model: meta.related_model });
	const name = filename_without_extension(file_name(file));
	return store.insert('attachment-management', {
		name: name.length >= 4 ? name : `file-${name ? name : 'adjunto'}`,
		name_stored: saved.filename,
		mimetype: saved.mime,
		file_ext: saved.ext,
		size_in_kb: saved.bytes.length / 1024,
		created_by_id: meta.actor_id,
		related_model: meta.related_model,
		related_record_id: meta.related_record_id,
		field: meta.field,
		index_if_is_array: meta.index_if_is_array,
		inside_array: meta.inside_array,
		is_active: true,
	});
}

async function persist_blob(
	file: Blob,
	opts: { related_model: string },
): Promise<{ filename: string; bytes: Buffer; mime: string; ext: string }> {
	const name = file_name(file);
	const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
	const mime = (file.type || 'application/octet-stream').toLowerCase();
	validate_upload(ext, mime, file.size, opts.related_model);
	const bytes = Buffer.from(await file.arrayBuffer());
	if (!bytes.length) throw new Error('No se ha subido un archivo');
	const filename = crypto.randomUUID();
	const folder = writable_upload_folder();
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, filename), bytes);
	return { filename, bytes, mime: file.type || mime, ext };
}

function validate_upload(
	ext: string,
	mime: string,
	size: number,
	related_model: string,
) {
	const arbitrary =
		related_model === 'Message' || related_model === 'messages';
	if (!arbitrary) {
		const image = mime.startsWith('image/') || EXT_PERMITIDAS.has(ext);
		if (!image) {
			if (ext && !EXT_PERMITIDAS.has(ext)) {
				throw new Error(`Extensión de archivo no permitida: ${ext}`);
			}
			if (!MIME_PERMITIDOS.has(mime)) {
				throw new Error(`Tipo MIME no permitido: ${mime}`);
			}
		}
	}
	const limit = mime.startsWith('image/') ? LIMITE_IMAGEN : LIMITE_OTROS;
	if (size > limit) {
		throw new Error(`Archivo demasiado grande. Límite: ${limit / (1024 * 1024)}MB`);
	}
}

function file_name(file: Blob): string {
	if (typeof File !== 'undefined' && file instanceof File && file.name) {
		return file.name;
	}
	return 'archivo';
}

function filename_without_extension(name: string): string {
	const i = name.lastIndexOf('.');
	return i > 0 ? name.slice(0, i) : name;
}
