/**
 * `nox.files` de las apps sobre los adjuntos del núcleo: los bytes van a la
 * carpeta de uploads y la fila a `attachment-management`, así que se sirven
 * por `/api/media/:id` como cualquier otro adjunto de Imperium.
 */
import sharp from 'sharp';
import type { ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import { delete_attachments_of, persist_upload_as_attachment } from './uploads.ts';

const MINIATURA_LADO = 200;

export type SubjectFileSave = {
	resource?: string;
	record_id?: string;
	filename?: string;
	content_type?: string;
	data_base64?: string;
};

export type SubjectFileRef = {
	id: string;
	resource: string;
	record_id: string;
	original_name: string;
	content_type: string;
	size_bytes: number;
	url: string;
	created_at: string;
	/**
	 * JPEG chico en data URL. Las pantallas de una app (listas, opciones de un
	 * datalist, impresos) lo pintan en línea: la cookie de sesión es
	 * SameSite=Lax y la APK corre en `https://localhost`, así que un `<img>` a
	 * `/api/media` sale sin ella; y la app no decodifica imágenes.
	 */
	thumbnail?: string;
};

export type SubjectFiles = {
	save(tid: string, input: SubjectFileSave): Promise<SubjectFileRef>;
	list(tid: string, query: { resource: string; record_id?: string }): Promise<SubjectFileRef[]>;
	remove(tid: string, id: string): Promise<boolean>;
};

/** El dueño va en el modelo: una app no lista ni borra los archivos de otra. */
function modelo(tid: string, resource: string): string {
	return `${tid}:${resource}`;
}

function como_ref(tid: string, doc: ImperiumDoc): SubjectFileRef {
	const id = String(doc._id ?? doc.id ?? '');
	return {
		id,
		resource: String(doc.related_model ?? '').slice(tid.length + 1),
		record_id: String(doc.related_record_id ?? ''),
		original_name: String(doc.name ?? ''),
		content_type: String(doc.mimetype ?? 'application/octet-stream'),
		size_bytes: Math.round(Number(doc.size_in_kb ?? 0) * 1024),
		url: `/api/media/${encodeURIComponent(id)}`,
		created_at: String(doc.createdAt ?? doc.created_at ?? ''),
	};
}

async function miniatura(bytes: Buffer, content_type: string): Promise<string | undefined> {
	if (!content_type.startsWith('image/')) return undefined;
	try {
		const jpeg = await sharp(bytes)
			.rotate()
			.resize({
				width: MINIATURA_LADO,
				height: MINIATURA_LADO,
				fit: 'inside',
				withoutEnlargement: true,
			})
			.flatten({ background: '#ffffff' })
			.jpeg({ quality: 72 })
			.toBuffer();
		return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
	} catch {
		return undefined;
	}
}

export function subject_files(store: ImperiumStore): SubjectFiles {
	return {
		async save(tid, input) {
			const resource = String(input.resource ?? '').trim();
			if (!resource) throw new Error('Falta el recurso del archivo');
			const bytes = Buffer.from(String(input.data_base64 ?? ''), 'base64');
			const content_type = String(input.content_type || 'application/octet-stream').toLowerCase();
			const file = new File([bytes], String(input.filename || 'archivo'), { type: content_type });
			const doc = await persist_upload_as_attachment(store, file, {
				actor_id: '',
				related_model: modelo(tid, resource),
				related_record_id: String(input.record_id ?? ''),
				field: 'file',
				index_if_is_array: 0,
				inside_array: false,
			});
			return { ...como_ref(tid, doc), thumbnail: await miniatura(bytes, content_type) };
		},

		async list(tid, query) {
			if (!store.has('attachment-management')) return [];
			const where: Record<string, unknown> = { related_model: modelo(tid, query.resource) };
			if (query.record_id) where.related_record_id = query.record_id;
			const { rows } = await store.find_many('attachment-management', {
				where,
				take: 500,
				populate: false,
				skip_total: true,
			});
			return rows.map((doc) => como_ref(tid, doc));
		},

		async remove(tid, id) {
			if (!store.has('attachment-management')) return false;
			const doc = await store.find_id('attachment-management', id);
			if (!doc || !String(doc.related_model ?? '').startsWith(`${tid}:`)) return false;
			await delete_attachments_of(store, id);
			return true;
		},
	};
}
