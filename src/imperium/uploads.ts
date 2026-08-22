/**
 * Persistencia de adjuntos: mismo contrato que multer + AttachmentManagementService.
 * El front manda multipart (`File` + `imperium-sic__data__`); sin esto el SQL
 * serializa el File a `{}` y GET /media no tiene bytes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
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
const IMAGEN_ANCHO_MAXIMO = 4000;
const IMAGEN_ALTO_MAXIMO = 4000;
const IMAGEN_TIMEOUT_MS = 30_000;
const EXTS_OPTIMIZABLES = new Set([
	'jpg',
	'jpeg',
	'jpe',
	'jif',
	'jfif',
	'jfi',
	'pjpeg',
	'pjp',
	'png',
	'gif',
	'webp',
	'bmp',
	'tiff',
	'tif',
]);

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
	opts: { method?: string; record_id?: string; previous?: ImperiumDoc | null } = {},
): Promise<ImperiumDoc> {
	const out: ImperiumDoc = { ...doc };
	delete out['imperium-sic__data__'];
	const actor_id = String(actor?._id ?? actor?.id ?? '').trim();
	const record_id = String(opts.record_id ?? out._id ?? out.id ?? '').trim();
	const replacing = ['PUT', 'PATCH'].includes(String(opts.method ?? '').toUpperCase());

	if (resource === 'attachment-management') {
		const file = take_upload(out, 'file') ?? first_upload(out);
		if (file) {
			const saved = await persist_blob(file, {
				related_model: String(out.related_model ?? 'AttachmentManagement'),
				field: String(out.field ?? 'file'),
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
			if (replacing) {
				await delete_attachments_of(store, opts.previous?.[key]);
			}
			const att = await persist_upload_as_attachment(store, value, {
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
		if (replacing && is_cleared_attachment(value)) {
			await delete_attachments_of(store, opts.previous?.[key]);
			out[key] = Array.isArray(value) ? [] : '';
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
			if (replacing) {
				const prev_list = as_list(opts.previous?.[key]);
				await delete_attachments_of(store, prev_list[i]);
			}
			const att = await persist_upload_as_attachment(store, item, {
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

export async function link_attachments_to_record(
	store: ImperiumStore,
	resource: string,
	doc: ImperiumDoc,
): Promise<void> {
	if (!store.has('attachment-management')) return;
	const record_id = String(doc._id ?? doc.id ?? '').trim();
	if (!record_id) return;
	for (const value of Object.values(doc)) {
		for (const id of attachment_ids_of(value)) {
			const att = await store.find_id('attachment-management', id);
			if (!att) continue;
			if (String(att.related_record_id ?? '').trim()) continue;
			const model = String(att.related_model ?? '');
			if (model && model !== resource) continue;
			await store.update('attachment-management', id, {
				related_record_id: record_id,
				related_model: resource,
			});
		}
	}
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

export async function persist_upload_as_attachment(
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
	const saved = await persist_blob(file, {
		related_model: meta.related_model,
		field: meta.field,
	});
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
	opts: { related_model: string; field?: string },
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
	const path = join(folder, filename);
	writeFileSync(path, bytes);
	const optimized = await maybe_optimize_image(path, ext, mime, opts.field ?? '');
	if (optimized) {
		return {
			filename,
			bytes: optimized.bytes,
			mime: 'image/webp',
			ext: 'webp',
		};
	}
	return { filename, bytes, mime: file.type || mime, ext };
}

async function maybe_optimize_image(
	path: string,
	ext: string,
	mime: string,
	field: string,
): Promise<{ bytes: Buffer } | null> {
	const is_image = mime.startsWith('image/') || EXTS_OPTIMIZABLES.has(ext);
	if (!is_image || ext === 'svg' || !EXTS_OPTIMIZABLES.has(ext)) return null;
	try {
		const metadata = await sharp(path).metadata();
		if (metadata.width && metadata.width > IMAGEN_ANCHO_MAXIMO) {
			throw new Error(`Ancho de imagen excede el límite máximo: ${IMAGEN_ANCHO_MAXIMO}px`);
		}
		if (metadata.height && metadata.height > IMAGEN_ALTO_MAXIMO) {
			throw new Error(`Alto de imagen excede el límite máximo: ${IMAGEN_ALTO_MAXIMO}px`);
		}
		const withoutEnlargement = Boolean(
			metadata.width &&
				metadata.height &&
				metadata.width < IMAGEN_ANCHO_MAXIMO &&
				metadata.height < IMAGEN_ALTO_MAXIMO,
		);
		const pipeline = sharp(path).resize({
			width: IMAGEN_ANCHO_MAXIMO,
			height: IMAGEN_ALTO_MAXIMO,
			fit: 'inside',
			withoutEnlargement,
		});
		const lossless = field.toLowerCase().includes('signature');
		const result_path = `${path}.result`;
		const work = lossless
			? pipeline.webp({ lossless: true, quality: 100 }).toFile(result_path)
			: pipeline.webp({ quality: 70 }).toFile(result_path);
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error('Timeout en procesamiento de imagen')), IMAGEN_TIMEOUT_MS);
		});
		await Promise.race([work, timeout]);
		unlinkSync(path);
		renameSync(result_path, path);
		return { bytes: readFileSync(path) };
	} catch (error) {
		throw new Error(`No se ha podido procesar el fichero: ${error}`);
	}
}

function is_cleared_attachment(value: unknown): boolean {
	if (value === '') return true;
	if (Array.isArray(value) && value.length === 0) return true;
	return false;
}

function as_list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function attachment_ids_of(value: unknown): string[] {
	if (typeof value === 'string' && /^[a-f0-9]{16,}$/i.test(value.trim())) {
		return [value.trim()];
	}
	if (Array.isArray(value)) return value.flatMap(attachment_ids_of);
	if (value && typeof value === 'object') {
		const id = String((value as { _id?: unknown })._id ?? '');
		return attachment_ids_of(id);
	}
	return [];
}

async function delete_attachments_of(store: ImperiumStore, value: unknown): Promise<void> {
	if (!store.has('attachment-management')) return;
	for (const id of attachment_ids_of(value)) {
		const att = await store.find_id('attachment-management', id);
		if (!att) continue;
		const stored = String(att.name_stored ?? '').trim();
		if (stored) {
			for (const folder of resolve_upload_folders()) {
				const full = join(folder, stored);
				if (existsSync(full)) unlinkSync(full);
			}
		}
		await store.remove('attachment-management', id);
	}
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
