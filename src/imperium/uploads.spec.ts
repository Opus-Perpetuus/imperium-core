import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
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
	};
	return { store: store as unknown as ImperiumStore, docs };
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

	test('una imagen más ancha que el límite se queda usable como original', async () => {
		const wide = await sharp({
			create: {
				width: 4001,
				height: 1,
				channels: 3,
				background: { r: 255, g: 0, b: 0 },
			},
		})
			.png()
			.toBuffer();
		const { store, docs } = memory_store();
		const file = new File([wide], 'ancha.png', { type: 'image/png' });
		const saved = await persist_upload_as_attachment(store, file, {
			actor_id: 'user',
			related_model: 'products',
			related_record_id: '',
			field: 'image',
			index_if_is_array: 0,
			inside_array: false,
		});
		expect(saved.file_readiness).toBe(FILE_READINESS_PROCESSING);
		expect(on_disk(String(saved.name_stored)).equals(wide)).toBe(true);
		await when_deferred_image_optimize_idle();
		const done = docs.get(String(saved._id));
		expect(done?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(done?.mimetype).toBe('image/png');
		expect(done?.file_ext).toBe('png');
		expect(on_disk(String(saved.name_stored)).equals(wide)).toBe(true);
	});

	test('si sharp no puede leer el archivo se conserva el original usable', async () => {
		const raw = Buffer.from('no-es-png');
		const { store, docs } = memory_store();
		const file = new File([raw], 'roto.png', { type: 'image/png' });
		const saved = await persist_upload_as_attachment(store, file, {
			actor_id: 'user',
			related_model: 'products',
			related_record_id: '',
			field: 'image',
			index_if_is_array: 0,
			inside_array: false,
		});
		await when_deferred_image_optimize_idle();
		const done = docs.get(String(saved._id));
		expect(done?.file_readiness).toBe(FILE_READINESS_USABLE);
		expect(done?.mimetype).toBe('image/png');
		expect(on_disk(String(saved.name_stored)).equals(raw)).toBe(true);
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
