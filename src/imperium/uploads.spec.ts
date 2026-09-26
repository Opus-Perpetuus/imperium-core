import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { from_imperium, to_imperium, type ImperiumDoc } from './envelope.ts';
import type { ImperiumStore } from './store.ts';
import {
	apply_uploads,
	bind_deferred_image_optimize,
	FILE_READINESS_PROCESSING,
	FILE_READINESS_USABLE,
	persist_upload_as_attachment,
	recover_orphan_processing_uploads,
	when_deferred_image_optimize_idle,
} from './uploads.ts';

const PNG_1X1 = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

let folder = '';
let previous_upload_folder: string | undefined;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), 'imperium-upload-'));
	previous_upload_folder = process.env.MULTER_UPLOAD_FOLDER;
	process.env.MULTER_UPLOAD_FOLDER = folder;
});

afterEach(async () => {
	await when_deferred_image_optimize_idle();
	if (previous_upload_folder === undefined) delete process.env.MULTER_UPLOAD_FOLDER;
	else process.env.MULTER_UPLOAD_FOLDER = previous_upload_folder;
});

function memory_store(): { store: ImperiumStore; docs: Map<string, ImperiumDoc> } {
	const docs = new Map<string, ImperiumDoc>();
	const store = {
		has: (name: string) => name === 'attachment-management',
		insert: async (_resource: string, doc: ImperiumDoc) => {
			const id = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
			const saved: ImperiumDoc = { ...doc, _id: id, id };
			docs.set(id, saved);
			return saved;
		},
		update: async (_resource: string, id: string, patch: ImperiumDoc) => {
			const existing = docs.get(id);
			if (!existing) return null;
			const saved: ImperiumDoc = { ...existing, ...patch, _id: id, id };
			docs.set(id, saved);
			return saved;
		},
		find_id: async (_resource: string, id: string) => docs.get(id) ?? null,
		find_many: async (
			_resource: string,
			opts: { where?: Record<string, unknown> } = {},
		) => {
			const where = opts.where ?? {};
			const rows = [...docs.values()].filter((doc) =>
				Object.entries(where).every(([key, value]) => doc[key] === value),
			);
			return { rows, total: rows.length };
		},
	};
	return { store: store as unknown as ImperiumStore, docs };
}

async function rejected_upload(
	store: ImperiumStore,
	file: File,
): Promise<Error & { status?: number }> {
	try {
		await persist_upload_as_attachment(store, file, {
			actor_id: 'user',
			related_model: 'products',
			related_record_id: '',
			field: 'image',
			index_if_is_array: 0,
			inside_array: false,
		});
	} catch (error) {
		return error as Error & { status?: number };
	}
	throw new Error('la subida debió rechazarse');
}

function on_disk(name: string): Buffer {
	return readFileSync(join(folder, name));
}

function is_webp(bytes: Buffer): boolean {
	return (
		bytes.length > 12 &&
		bytes.subarray(0, 4).toString() === 'RIFF' &&
		bytes.subarray(8, 12).toString() === 'WEBP'
	);
}

describe('uploads diferidos', () => {
	test('un PDF queda usable sin pasar por sharp', async () => {
		const { store, docs } = memory_store();
		const file = new File([Buffer.from('pdf')], 'acta.pdf', { type: 'application/pdf' });
		const saved = await persist_upload_as_attachment(store, file, {
			actor_id: 'user',
			related_model: 'notes',
			related_record_id: '',
			field: 'file',
			index_if_is_array: 0,
			inside_array: false,
		});
		expect(saved.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(saved.mimetype).toBe('application/pdf');
		expect(saved.file_ext).toBe('pdf');
		expect(on_disk(String(saved.name_stored)).equals(Buffer.from('pdf'))).toBe(true);
		expect(docs.get(String(saved._id))?.file_readiness).toBe(FILE_READINESS_USABLE);
	});

	test('la imagen se guarda original y el WebP queda en cola', async () => {
		const { store, docs } = memory_store();
		const file = new File([PNG_1X1], 'foto.png', { type: 'image/png' });
		const saved = await persist_upload_as_attachment(store, file, {
			actor_id: 'user',
			related_model: 'products',
			related_record_id: 'rec',
			field: 'image',
			index_if_is_array: 0,
			inside_array: false,
		});
		expect(saved.file_readiness).toBe(FILE_READINESS_PROCESSING);
		expect(saved.mimetype).toBe('image/png');
		expect(saved.file_ext).toBe('png');
		expect(on_disk(String(saved.name_stored)).equals(PNG_1X1)).toBe(true);

		await when_deferred_image_optimize_idle();
		const done = docs.get(String(saved._id));
		expect(done?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(done?.mimetype).toBe('image/webp');
		expect(done?.file_ext).toBe('webp');
		expect(is_webp(on_disk(String(saved.name_stored)))).toBe(true);
	});

	test('attachment-management responde con el original y enlaza la cola al insertar', async () => {
		const { store, docs } = memory_store();
		const file = new File([PNG_1X1], 'foto.png', { type: 'image/png' });
		const draft = await apply_uploads(
			store,
			'attachment-management',
			{ file, name: 'foto' },
			null,
		);
		expect(draft.file_readiness).toBe(FILE_READINESS_PROCESSING);
		expect(draft.mimetype).toBe('image/png');
		expect(on_disk(String(draft.name_stored)).equals(PNG_1X1)).toBe(true);

		const created = await store.insert('attachment-management', draft);
		bind_deferred_image_optimize(store, created);
		await when_deferred_image_optimize_idle();
		const done = docs.get(String(created._id));
		expect(done?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(done?.mimetype).toBe('image/webp');
		expect(is_webp(on_disk(String(created.name_stored)))).toBe(true);
	});

	test('una firma también termina en WebP usable', async () => {
		const { store, docs } = memory_store();
		const file = new File([PNG_1X1], 'firma.png', { type: 'image/png' });
		const saved = await persist_upload_as_attachment(store, file, {
			actor_id: 'user',
			related_model: 'delivery-package',
			related_record_id: 'pkg',
			field: 'delivery_signature',
			index_if_is_array: 0,
			inside_array: false,
		});
		expect(saved.mimetype).toBe('image/png');
		expect(on_disk(String(saved.name_stored)).equals(PNG_1X1)).toBe(true);
		await when_deferred_image_optimize_idle();
		const done = docs.get(String(saved._id));
		expect(done?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(done?.mimetype).toBe('image/webp');
		expect(is_webp(on_disk(String(saved.name_stored)))).toBe(true);
	});

	test('una imagen mayor al límite se reduce al tope y queda usable', async () => {
		const oversized = await sharp({
			create: {
				width: 4001,
				height: 4100,
				channels: 3,
				background: { r: 255, g: 0, b: 0 },
			},
		})
			.png()
			.toBuffer();
		const { store, docs } = memory_store();
		const file = new File([oversized], 'ancha.png', { type: 'image/png' });
		const saved = await persist_upload_as_attachment(store, file, {
			actor_id: 'user',
			related_model: 'products',
			related_record_id: '',
			field: 'image',
			index_if_is_array: 0,
			inside_array: false,
		});
		expect(saved.file_readiness).toBe(FILE_READINESS_PROCESSING);
		expect(on_disk(String(saved.name_stored)).equals(oversized)).toBe(true);
		await when_deferred_image_optimize_idle();
		const done = docs.get(String(saved._id));
		expect(done?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(done?.mimetype).toBe('image/webp');
		expect(done?.file_ext).toBe('webp');
		const stored = on_disk(String(saved.name_stored));
		expect(stored.equals(oversized)).toBe(false);
		expect(is_webp(stored)).toBe(true);
		const meta = await sharp(stored).metadata();
		expect(meta.width).toBeLessThanOrEqual(4000);
		expect(meta.height).toBeLessThanOrEqual(4000);
		expect(meta.width).toBeGreaterThan(0);
		expect(meta.height).toBeGreaterThan(0);
	});

	test('rechaza un archivo que no es imagen aunque la extensión lo parezca', async () => {
		const raw = Buffer.from('no-es-png');
		const { store, docs } = memory_store();
		const file = new File([raw], 'roto.png', { type: 'image/png' });
		const error = await rejected_upload(store, file);
		expect(error.message).toBe('El archivo no es una imagen válida');
		expect(error.status).toBe(400);
		expect(docs.size).toBe(0);
		expect(readdirSync(folder)).toEqual([]);
	});

	test('si el insert del adjunto falla, relanza ese error y no deja archivo ni trabajo de optimizar', async () => {
		const failure = new Error('insert del adjunto falló');
		const { store } = memory_store();
		let updates = 0;
		const mutable = store as unknown as {
			insert: () => Promise<never>;
			update: () => Promise<null>;
		};
		mutable.insert = async () => {
			throw failure;
		};
		mutable.update = async () => {
			updates += 1;
			return null;
		};
		const file = new File([PNG_1X1], 'foto.png', { type: 'image/png' });
		let caught: unknown;
		try {
			await persist_upload_as_attachment(store, file, {
				actor_id: 'user',
				related_model: 'products',
				related_record_id: 'rec',
				field: 'image',
				index_if_is_array: 0,
				inside_array: false,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
		expect(readdirSync(folder)).toEqual([]);
		await when_deferred_image_optimize_idle();
		expect(updates).toBe(0);
	});

	test('al arrancar, los huérfanos en processing quedan usable y el resto no cambia', async () => {
		const { store, docs } = memory_store();
		docs.set('orphan', {
			_id: 'orphan',
			id: 'orphan',
			name: 'foto',
			mimetype: 'image/png',
			file_ext: 'png',
			file_readiness: FILE_READINESS_PROCESSING,
		});
		docs.set('ok', {
			_id: 'ok',
			id: 'ok',
			name: 'lista',
			mimetype: 'image/webp',
			file_ext: 'webp',
			file_readiness: FILE_READINESS_USABLE,
		});
		const recovered = await recover_orphan_processing_uploads(store);
		expect(recovered).toBe(1);
		expect(docs.get('orphan')?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(docs.get('orphan')?.mimetype).toBe('image/png');
		expect(docs.get('orphan')?.file_ext).toBe('png');
		expect(docs.get('ok')?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(docs.get('ok')?.mimetype).toBe('image/webp');
		expect(docs.get('ok')?.name).toBe('lista');
	});

	test('el arranque del núcleo llama la recuperación de processing', () => {
		const src = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
		const boot = src.indexOf('const boot = () => {');
		const call = src.indexOf('recover_orphan_processing_uploads(store)');
		const ready = src.indexOf('arranque listo');
		expect(boot).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(boot);
		expect(ready).toBeGreaterThan(call);
	});

	test('file_readiness se guarda en payload y vuelve al leer', () => {
		const row = from_imperium(
			{
				name: 'foto',
				mimetype: 'image/png',
				file_readiness: FILE_READINESS_PROCESSING,
			},
			new Set(['name', 'mimetype', 'payload', 'id', 'is_active']),
		);
		const payload = row.payload as Record<string, unknown>;
		expect(payload.file_readiness).toBe(FILE_READINESS_PROCESSING);
		expect(row.file_readiness).toBeUndefined();
		const back = to_imperium({
			id: 'abc',
			mimetype: 'image/png',
			payload,
		});
		expect(back?.file_readiness).toBe(FILE_READINESS_PROCESSING);
		expect(back?.mimetype).toBe('image/png');
	});
});
